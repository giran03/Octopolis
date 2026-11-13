//! Saving what is dropped on a folder from outside the app: a picture dragged out of a web page, or files from another
//! program. The page hands over bytes or a link; the file is written (or downloaded) here, never overwriting anything.

use std::fs;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

use octo_core::names::unique_path;
use octo_core::webdrop;
use tauri::ipc::{InvokeBody, Request};

/// Most that is saved from one drop (a web video can be big, but not unbounded).
const MAX_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const MAX_HOPS: u8 = 5;
const BROWSER_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

fn existing_dir(dir: &Path) -> Result<(), String> {
    if dir.is_dir() {
        Ok(())
    } else {
        Err("That folder doesn't exist any more".into())
    }
}

/// Writes the file's bytes (the request body) into a folder under a safe, unused name; returns the new path.
/// The folder and name travel in the `x-dir` and `x-name` headers, percent-encoded.
#[tauri::command]
pub async fn save_dropped_file(request: Request<'_>) -> Result<String, String> {
    let header = |k: &str| request.headers().get(k).and_then(|v| v.to_str().ok()).map(webdrop::percent_decode);
    let dir = PathBuf::from(header("x-dir").ok_or("No folder given")?);
    let name = webdrop::sanitize_name(&header("x-name").unwrap_or_default());
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("No file data received".into());
    };
    let bytes = bytes.clone();
    crate::off_main(move || {
        existing_dir(&dir)?;
        let name = if name.is_empty() { "dropped-file".to_string() } else { name };
        let dest = unique_path(&dir, &name, false);
        fs::write(&dest, &bytes).map_err(|e| e.to_string())?;
        Ok(dest.to_string_lossy().into_owned())
    })
    .await
}

fn agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_connect(Some(Duration::from_secs(10)))
        .timeout_recv_body(Some(Duration::from_secs(900)))
        .user_agent(BROWSER_UA)
        // Redirects are followed by hand below, so each hop can be checked.
        .max_redirects(0)
        .http_status_as_error(false)
        .build()
        .into()
}

/// The link a redirect points to, made absolute against the link that sent it.
fn resolve_location(from: &str, location: &str) -> Option<String> {
    if location.contains("://") {
        return Some(location.to_string());
    }
    let (scheme, rest) = from.split_once("://")?;
    let host = rest.split(['/', '?', '#']).next()?;
    if let Some(path) = location.strip_prefix('/') {
        return Some(format!("{scheme}://{host}/{path}"));
    }
    let base = rest.split(['?', '#']).next()?;
    let dir = base.rsplit_once('/').map_or(host, |(d, _)| d);
    Some(format!("{scheme}://{dir}/{location}"))
}

fn download(url: &str, dir: &Path) -> Result<PathBuf, String> {
    existing_dir(dir)?;
    let agent = agent();
    let mut current = url.trim().to_string();
    for _ in 0..=MAX_HOPS {
        let host = webdrop::http_host(&current).ok_or("Only http and https links can be downloaded")?;
        if webdrop::host_is_blocked(&host) {
            return Err("That link points at this PC or a private network".into());
        }
        let mut resp = agent.get(&current).call().map_err(|e| format!("Couldn't reach {host}: {e}"))?;
        let status = resp.status().as_u16();
        if (300..400).contains(&status) {
            let location = resp.headers().get("location").and_then(|v| v.to_str().ok()).ok_or("The link redirects nowhere")?;
            current = resolve_location(&current, location).ok_or("The link redirects somewhere unusable")?;
            continue;
        }
        if status >= 400 {
            return Err(format!("{host} answered {status}"));
        }
        let ctype = resp.headers().get("content-type").and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
        let disposition = resp.headers().get("content-disposition").and_then(|v| v.to_str().ok()).map(str::to_string);
        let mime = ctype.split(';').next().unwrap_or("").trim().to_ascii_lowercase();
        // A web page isn't a file, unless the server says to save it as one.
        let is_attachment = disposition.as_deref().is_some_and(|d| d.to_ascii_lowercase().contains("attachment"));
        if (mime == "text/html" || mime == "application/xhtml+xml") && !is_attachment {
            return Err("That link is a web page, not a file".into());
        }
        let name = webdrop::final_name(&current, disposition.as_deref(), Some(&ctype));
        let dest = unique_path(dir, &name, false);
        let part = dest.with_file_name(format!("{}.part", dest.file_name().map(|n| n.to_string_lossy()).unwrap_or_default()));
        let result = (|| -> Result<(), String> {
            let mut reader = resp.body_mut().with_config().limit(MAX_BYTES).reader();
            let mut file = fs::File::create(&part).map_err(|e| e.to_string())?;
            copy_all(&mut reader, &mut file).map_err(|e| format!("The download was interrupted: {e}"))?;
            file.flush().map_err(|e| e.to_string())
        })();
        if let Err(e) = result {
            let _ = fs::remove_file(&part);
            return Err(e);
        }
        // Another file may have taken the name while this downloaded; never overwrite it.
        let dest = if dest.exists() { unique_path(dir, &name, false) } else { dest };
        fs::rename(&part, &dest).map_err(|e| e.to_string())?;
        return Ok(dest);
    }
    Err("The link redirects too many times".into())
}

fn copy_all(from: &mut impl Read, to: &mut impl Write) -> io::Result<u64> {
    let mut buf = vec![0u8; 256 * 1024];
    let mut total = 0u64;
    loop {
        let n = from.read(&mut buf)?;
        if n == 0 {
            return Ok(total);
        }
        to.write_all(&buf[..n])?;
        total += n as u64;
    }
}

/// Downloads a file (a picture, video, document, archive...) from a link into a folder; returns the saved path.
#[tauri::command]
pub async fn download_dropped_url(url: String, dir: PathBuf) -> Result<String, String> {
    crate::off_main(move || download(&url, &dir).map(|p| p.to_string_lossy().into_owned())).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_redirect_locations() {
        assert_eq!(resolve_location("https://a.com/x/y.png?q=1", "https://b.com/z").as_deref(), Some("https://b.com/z"));
        assert_eq!(resolve_location("https://a.com/x/y.png", "/img/z.png").as_deref(), Some("https://a.com/img/z.png"));
        assert_eq!(resolve_location("https://a.com/x/y.png", "z.png").as_deref(), Some("https://a.com/x/z.png"));
        assert_eq!(resolve_location("https://a.com", "z.png").as_deref(), Some("https://a.com/z.png"));
    }

    #[test]
    fn refuses_private_and_non_http_links() {
        let dir = std::env::temp_dir();
        assert!(download("http://127.0.0.1/a.png", &dir).unwrap_err().contains("private"));
        assert!(download("https://localhost/a.png", &dir).unwrap_err().contains("private"));
        assert!(download("file:///C:/a.png", &dir).unwrap_err().contains("http"));
        assert!(download("ftp://x.com/a.png", &dir).unwrap_err().contains("http"));
    }

    /// Needs the network: `cargo test -p octopolis -- --ignored webdrop`.
    #[test]
    #[ignore]
    fn downloads_a_real_picture() {
        let dir = std::env::temp_dir().join("octo-webdrop-test");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let p = download("https://www.google.com/favicon.ico", &dir).unwrap_or_else(|e| panic!("{e}"));
        assert!(p.metadata().unwrap().len() > 100);
        assert!(download("https://www.example.com/", &dir).unwrap_err().contains("web page"));
        let _ = fs::remove_dir_all(&dir);
    }
}
