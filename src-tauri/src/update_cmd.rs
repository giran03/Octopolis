//! In-app updater: GitHub Releases lookup, SHA-256-verified download of the
//! NSIS installer, then a silent install. All network access lives here
//! because the webview CSP blocks external requests.

use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::AppHandle;

const USER_AGENT: &str = "octopolis-updater";
const UPDATES_DIR: &str = "updates";
const INSTALLER_PREFIX: &str = "Octopolis_";
const INSTALLER_SUFFIX: &str = "_x64-setup.exe";
const SUMS_NAMES: [&str; 2] = ["SHA256SUMS", "SHA256SUMS.txt"];
const MAX_TEXT_BYTES: u64 = 4 * 1024 * 1024;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const DOWNLOAD_STALL_TIMEOUT: Duration = Duration::from_secs(60);

#[cfg(windows)]
const DETACHED_PROCESS: u32 = 0x0000_0008;
#[cfg(windows)]
const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;

/// Set while an installer is launching, so a double click cannot start two.
static INSTALLING: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LatestRelease {
    pub version: String,
    pub tag: String,
    pub notes: String,
    pub html_url: String,
    pub installer_name: String,
    pub installer_url: String,
    pub sums_url: String,
    pub sha256: Option<String>,
}

#[derive(Deserialize)]
struct GhRelease {
    tag_name: String,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    html_url: String,
    #[serde(default)]
    assets: Vec<GhAsset>,
}

#[derive(Debug, Deserialize)]
struct GhAsset {
    name: String,
    browser_download_url: String,
}

// ---- pure helpers (unit tested) ------------------------------------------

/// "v1.2.3" and "V1.2.3" become "1.2.3".
fn strip_tag(tag: &str) -> String {
    let t = tag.trim();
    t.strip_prefix(['v', 'V']).unwrap_or(t).to_string()
}

/// `owner/name`, GitHub's allowed characters only.
fn valid_repo(repo: &str) -> bool {
    let ok = |s: &str| !s.is_empty() && s != "." && s != ".." && s.len() <= 100 && s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'));
    match repo.split_once('/') {
        Some((owner, name)) => ok(owner) && ok(name) && !name.contains('/'),
        None => false,
    }
}

/// Picks the installer and checksum assets for a release.
fn select_assets<'a>(assets: &'a [GhAsset], version: &str) -> Result<(&'a GhAsset, &'a GhAsset), String> {
    let exact = format!("{INSTALLER_PREFIX}{version}{INSTALLER_SUFFIX}");
    let installer = assets
        .iter()
        .find(|a| a.name.eq_ignore_ascii_case(&exact))
        .ok_or_else(|| format!("The latest release has no installer named {exact}"))?;
    let sums = SUMS_NAMES
        .iter()
        .find_map(|n| assets.iter().find(|a| a.name.eq_ignore_ascii_case(n)))
        .ok_or("The latest release has no SHA256SUMS file, so the download cannot be verified")?;
    Ok((installer, sums))
}

/// Finds the hash for `name` in a `sha256sum`-style file (`<hex>  <name>`,
/// optionally `<hex> *<name>`). Returned lowercase.
fn parse_sums(text: &str, name: &str) -> Option<String> {
    text.lines().find_map(|line| {
        let (hash, file) = line.trim().split_once(char::is_whitespace)?;
        let file = file.trim().trim_start_matches('*');
        let valid = hash.len() == 64 && hash.chars().all(|c| c.is_ascii_hexdigit());
        (valid && file.eq_ignore_ascii_case(name)).then(|| hash.to_ascii_lowercase())
    })
}

fn verify_hash(actual: &str, expected: &str) -> Result<(), String> {
    if actual.eq_ignore_ascii_case(expected.trim()) {
        Ok(())
    } else {
        Err("The download is corrupt: its SHA-256 does not match the published checksum".into())
    }
}

fn build_release(release: GhRelease, sums_text: Option<&str>) -> Result<LatestRelease, String> {
    let version = strip_tag(&release.tag_name);
    let (installer, sums) = select_assets(&release.assets, &version)?;
    let sha256 = sums_text.and_then(|t| parse_sums(t, &installer.name));
    Ok(LatestRelease {
        version,
        tag: release.tag_name.clone(),
        notes: release.body.clone().unwrap_or_default(),
        html_url: release.html_url.clone(),
        installer_name: installer.name.clone(),
        installer_url: installer.browser_download_url.clone(),
        sums_url: sums.browser_download_url.clone(),
        sha256,
    })
}

/// A bare file name: no separators, no traversal.
fn safe_file_name(name: &str) -> bool {
    !name.is_empty() && name != "." && name != ".." && !name.contains(['/', '\\', ':']) && name.len() < 200
}

fn valid_sha256(s: &str) -> bool {
    s.len() == 64 && s.chars().all(|c| c.is_ascii_hexdigit())
}

// ---- IO ------------------------------------------------------------------

fn agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_connect(Some(CONNECT_TIMEOUT))
        .timeout_recv_body(Some(DOWNLOAD_STALL_TIMEOUT))
        .user_agent(USER_AGENT)
        .build()
        .into()
}

fn http_error(e: ureq::Error) -> String {
    match e {
        ureq::Error::StatusCode(404) => "Not found (404). Check the repository name and that a release is published".into(),
        ureq::Error::StatusCode(403 | 429) => "GitHub refused the request (rate limit). Try again later".into(),
        ureq::Error::StatusCode(code) => format!("GitHub returned HTTP {code}"),
        other => format!("Could not reach GitHub: {other}"),
    }
}

fn get_text(agent: &ureq::Agent, url: &str, accept: &str) -> Result<String, String> {
    let mut resp = agent.get(url).header("Accept", accept).call().map_err(http_error)?;
    resp.body_mut().with_config().limit(MAX_TEXT_BYTES).read_to_string().map_err(|e| e.to_string())
}

fn updates_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = crate::cache_cmd::resolve_cache_dir(app)?.join(UPDATES_DIR);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn hash_file(path: &Path) -> Result<String, String> {
    let mut file = File::open(path).map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = file.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hex(&hasher.finalize()))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn fetch_latest(repo: &str) -> Result<LatestRelease, String> {
    let repo = repo.trim();
    if !valid_repo(repo) {
        return Err("Updates are not configured: the GitHub repository must look like owner/name".into());
    }
    let agent = agent();
    let url = format!("https://api.github.com/repos/{repo}/releases/latest");
    let body = get_text(&agent, &url, "application/vnd.github+json")?;
    let release: GhRelease = serde_json::from_str(&body).map_err(|e| format!("Unexpected response from GitHub: {e}"))?;
    let version = strip_tag(&release.tag_name);
    let (_, sums) = select_assets(&release.assets, &version)?;
    let sums_text = get_text(&agent, &sums.browser_download_url, "application/octet-stream")?;
    build_release(release, Some(&sums_text))
}

fn download_to(url: &str, part: &Path) -> Result<String, String> {
    let agent = agent();
    let resp = agent.get(url).call().map_err(http_error)?;
    let mut reader = resp.into_body().into_reader();
    let mut file = File::create(part).map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = reader.read(&mut buf).map_err(|e| format!("Download interrupted: {e}"))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        file.write_all(&buf[..n]).map_err(|e| e.to_string())?;
    }
    file.flush().map_err(|e| e.to_string())?;
    Ok(hex(&hasher.finalize()))
}

fn download(dir: &Path, url: &str, name: &str, sha256: &str) -> Result<PathBuf, String> {
    if !url.starts_with("https://") {
        return Err("Refusing a non-HTTPS download".into());
    }
    if !safe_file_name(name) {
        return Err("Invalid installer file name".into());
    }
    if !valid_sha256(sha256) {
        return Err("No valid SHA-256 checksum for this release, refusing to download".into());
    }
    let part = dir.join(format!("{name}.part"));
    let target = dir.join(name);
    let result = download_to(url, &part).and_then(|actual| verify_hash(&actual, sha256)).and_then(|()| {
        let _ = fs::remove_file(&target);
        fs::rename(&part, &target).map_err(|e| e.to_string())
    });
    if let Err(e) = result {
        let _ = fs::remove_file(&part);
        return Err(e);
    }
    Ok(target)
}

/// Canonicalises `path` and requires it to be a file inside `dir`.
fn inside_updates(dir: &Path, path: &Path) -> Result<PathBuf, String> {
    let dir = dir.canonicalize().map_err(|e| e.to_string())?;
    let file = path.canonicalize().map_err(|_| "The installer file is missing".to_string())?;
    if file.parent() == Some(dir.as_path()) && file.is_file() {
        Ok(file)
    } else {
        Err("Refusing to run an installer outside the updates folder".into())
    }
}

fn spawn_installer(path: &Path) -> Result<(), String> {
    let mut cmd = std::process::Command::new(path);
    cmd.arg("/S");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
    }
    cmd.spawn().map(|_| ()).map_err(|e| format!("Could not start the installer: {e}"))
}

// ---- commands ------------------------------------------------------------

#[tauri::command]
pub async fn update_check(repo: String) -> Result<LatestRelease, String> {
    crate::off_main(move || fetch_latest(&repo)).await
}

#[tauri::command]
pub async fn update_download(app: AppHandle, url: String, name: String, sha256: String) -> Result<String, String> {
    crate::off_main(move || {
        let dir = updates_dir(&app)?;
        download(&dir, &url, &name, &sha256).map(|p| p.to_string_lossy().into_owned())
    })
    .await
}

#[tauri::command]
pub async fn update_install(app: AppHandle, path: String, sha256: String) -> Result<(), String> {
    if INSTALLING.swap(true, Ordering::SeqCst) {
        return Err("An update is already being installed".into());
    }
    let launched = {
        let app = app.clone();
        crate::off_main(move || {
            let file = inside_updates(&updates_dir(&app)?, Path::new(&path))?;
            verify_hash(&hash_file(&file)?, &sha256)?;
            spawn_installer(&file)
        })
        .await
    };
    match launched {
        Ok(()) => {
            app.exit(0);
            Ok(())
        }
        Err(e) => {
            INSTALLING.store(false, Ordering::SeqCst);
            Err(e)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const HASH_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const HASH_B: &str = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

    fn asset(name: &str) -> GhAsset {
        GhAsset { name: name.into(), browser_download_url: format!("https://example.test/{name}") }
    }

    #[test]
    fn strips_leading_v() {
        assert_eq!(strip_tag("v1.2.3"), "1.2.3");
        assert_eq!(strip_tag("V0.4.0"), "0.4.0");
        assert_eq!(strip_tag("1.0.0"), "1.0.0");
        assert_eq!(strip_tag(" v2.0.0-beta.1 "), "2.0.0-beta.1");
    }

    #[test]
    fn parses_sums_file() {
        let text = format!("{HASH_A}  Octopolis_1.0.0_x64-setup.exe\r\n{HASH_B} *other.zip\n");
        assert_eq!(parse_sums(&text, "Octopolis_1.0.0_x64-setup.exe").as_deref(), Some(HASH_A));
        assert_eq!(parse_sums(&text, "other.zip"), Some(HASH_B.to_ascii_lowercase()));
        assert_eq!(parse_sums(&text, "missing.exe"), None);
        assert_eq!(parse_sums("nothex  Octopolis_1.0.0_x64-setup.exe", "Octopolis_1.0.0_x64-setup.exe"), None);
        assert_eq!(parse_sums("", "x"), None);
    }

    #[test]
    fn selects_installer_and_sums() {
        let assets = vec![asset("Octopolis_1.0.0_x64-setup.exe"), asset("Octopolis_0.9.0_x64-setup.exe"), asset("SHA256SUMS.txt")];
        let (i, s) = select_assets(&assets, "1.0.0").unwrap();
        assert_eq!(i.name, "Octopolis_1.0.0_x64-setup.exe");
        assert_eq!(s.name, "SHA256SUMS.txt");
    }

    #[test]
    fn rejects_missing_assets() {
        let no_sums = vec![asset("Octopolis_1.0.0_x64-setup.exe")];
        assert!(select_assets(&no_sums, "1.0.0").unwrap_err().contains("SHA256SUMS"));
        let wrong_version = vec![asset("Octopolis_0.9.0_x64-setup.exe"), asset("SHA256SUMS")];
        assert!(select_assets(&wrong_version, "1.0.0").is_err());
    }

    #[test]
    fn builds_release_with_sha() {
        let release = GhRelease {
            tag_name: "v1.0.0".into(),
            body: None,
            html_url: "https://github.com/o/r/releases/tag/v1.0.0".into(),
            assets: vec![asset("Octopolis_1.0.0_x64-setup.exe"), asset("SHA256SUMS")],
        };
        let out = build_release(release, Some(&format!("{HASH_A}  Octopolis_1.0.0_x64-setup.exe"))).unwrap();
        assert_eq!(out.version, "1.0.0");
        assert_eq!(out.tag, "v1.0.0");
        assert_eq!(out.sha256.as_deref(), Some(HASH_A));
        assert_eq!(out.notes, "");
    }

    #[test]
    fn rejects_checksum_mismatch() {
        assert!(verify_hash(HASH_A, HASH_A).is_ok());
        assert!(verify_hash(&HASH_A.to_ascii_uppercase(), HASH_A).is_ok());
        assert!(verify_hash(HASH_A, HASH_B).unwrap_err().contains("does not match"));
    }

    #[test]
    fn validates_repo_and_names() {
        assert!(valid_repo("owner/name"));
        assert!(valid_repo("a-b/c_d.e"));
        for bad in ["", "owner", "/name", "owner/", "a/b/c", "a b/c", "../x"] {
            assert!(!valid_repo(bad), "{bad}");
        }
        assert!(safe_file_name("Octopolis_1.0.0_x64-setup.exe"));
        assert!(!safe_file_name("..\\evil.exe"));
        assert!(!safe_file_name("a/b.exe"));
    }

    #[test]
    fn hash_file_matches_known_digest_and_download_rejects_bad_input() {
        let dir = std::env::temp_dir().join(format!("octo-update-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("abc.bin");
        fs::write(&file, b"abc").unwrap();
        assert_eq!(hash_file(&file).unwrap(), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
        assert!(inside_updates(&dir, &file).is_ok());
        assert!(inside_updates(&dir, &std::env::temp_dir().join("nope")).is_err());
        assert!(download(&dir, "http://x/y", "a.exe", HASH_A).is_err());
        assert!(download(&dir, "https://x/y", "..\\a.exe", HASH_A).is_err());
        assert!(download(&dir, "https://x/y", "a.exe", "short").is_err());
        let _ = fs::remove_dir_all(&dir);
    }
}
