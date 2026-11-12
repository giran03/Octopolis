//! Inspector previews, thumbnails, lock hunting, tags and folder sizes.

use std::collections::{BTreeMap, HashMap};
use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};

use octo_core::preview::{self, Kind};
use octo_core::{archive, lock, meta, thumbs};
use serde::Serialize;
use tauri::ipc::Response;

const TEXT_LIMIT: usize = 1024 * 1024;
const HEX_LIMIT: usize = 4096;
const MEDIA_LIMIT: u64 = 512 * 1024 * 1024;

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PreviewDto {
    kind: &'static str,
    lang: Option<&'static str>,
    size: u64,
    text: Option<String>,
    /// Highlighted HTML, one string per line.
    lines: Option<Vec<String>>,
    /// Rendered Markdown.
    html: Option<String>,
    hex: Option<String>,
    truncated: bool,
    /// Number of entries, for archives.
    entries: Option<usize>,
    tags: BTreeMap<String, String>,
    details: Vec<(String, String)>,
}

/// Reads the first `max` bytes of a real file or a file inside an archive.
fn read_head(path: &Path, max: usize) -> Result<(Vec<u8>, u64), String> {
    if let Some((file, inner)) = archive::split_path(path).filter(|(_, i)| !i.is_empty()) {
        let bytes = archive::read(&file, &inner, max).map_err(|e| e.to_string())?;
        let size = archive::entries(&file)
            .ok()
            .and_then(|all| all.iter().find(|e| e.path.eq_ignore_ascii_case(&inner)).map(|e| e.size))
            .unwrap_or(bytes.len() as u64);
        return Ok((bytes, size));
    }
    let f = File::open(path).map_err(|e| e.to_string())?;
    let size = f.metadata().map_err(|e| e.to_string())?.len();
    let mut buf = Vec::with_capacity((size as usize).min(max));
    f.take(max as u64).read_to_end(&mut buf).map_err(|e| e.to_string())?;
    Ok((buf, size))
}

/// Size of a real file or of a file inside an archive, without reading it.
fn file_size(path: &Path) -> Result<u64, String> {
    if let Some((file, inner)) = archive::split_path(path).filter(|(_, i)| !i.is_empty()) {
        let all = archive::entries(&file).map_err(|e| e.to_string())?;
        return all.iter().find(|e| e.path.eq_ignore_ascii_case(&inner)).map(|e| e.size).ok_or_else(|| "Not found in the archive".to_string());
    }
    std::fs::metadata(path).map(|m| m.len()).map_err(|e| e.to_string())
}

fn build_preview(path: &Path) -> Result<PreviewDto, String> {
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let kind = preview::classify(&name);
    let mut dto = PreviewDto { kind: kind.tag(), ..PreviewDto::default() };
    let in_archive = archive::split_path(path).is_some_and(|(_, i)| !i.is_empty());
    if !in_archive {
        dto.tags = meta::tags(path);
        if matches!(kind, Kind::Image | Kind::Svg | Kind::Video) {
            dto.details = meta::media_details(path);
        }
    }
    // Word, PowerPoint, Excel and OpenDocument files show their text.
    if !in_archive {
        let ext = name.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase()).unwrap_or_default();
        if let Some(label) = preview::office::document_label(&ext) {
            dto.size = std::fs::metadata(path).map_or(0, |m| m.len());
            dto.details.push(("Type".to_string(), label.to_string()));
            if let Ok(Some(text)) = preview::office::extract_text(path, &ext) {
                let truncated = text.len() > TEXT_LIMIT;
                let text: String = if truncated { text.chars().take(TEXT_LIMIT).collect() } else { text };
                dto.kind = Kind::Text.tag();
                dto.truncated = truncated;
                dto.text = Some(text);
                return Ok(dto);
            }
        }
    }
    match kind {
        Kind::Code(_) | Kind::Markdown | Kind::Text | Kind::Table => {
            let (bytes, size) = read_head(path, TEXT_LIMIT)?;
            dto.size = size;
            if preview::looks_binary(&bytes) {
                dto.kind = Kind::Binary.tag();
                dto.hex = Some(preview::hex_dump(&bytes[..bytes.len().min(HEX_LIMIT)]));
                dto.truncated = size as usize > HEX_LIMIT;
                return Ok(dto);
            }
            dto.truncated = size as usize > TEXT_LIMIT;
            let text = preview::decode_text(&bytes);
            dto.details = preview::text_details(&bytes, &text, dto.truncated);
            match kind {
                Kind::Code(lang) => {
                    dto.lang = Some(lang);
                    dto.lines = preview::highlight::to_html_lines(lang, &text);
                }
                Kind::Markdown => dto.html = Some(preview::markdown::to_html(&text)),
                _ => {}
            }
            dto.text = Some(text);
        }
        Kind::Binary => {
            let (bytes, size) = read_head(path, HEX_LIMIT)?;
            dto.size = size;
            dto.truncated = size as usize > HEX_LIMIT;
            dto.hex = Some(preview::hex_dump(&bytes));
        }
        Kind::Archive => {
            if !in_archive {
                dto.size = std::fs::metadata(path).map_or(0, |m| m.len());
                dto.entries = archive::entries(path).ok().map(|a| a.len());
            }
        }
        _ => {
            dto.size = if in_archive { read_head(path, 0)?.1 } else { std::fs::metadata(path).map_or(0, |m| m.len()) };
        }
    }
    Ok(dto)
}

#[tauri::command]
pub async fn preview_file(path: PathBuf) -> Result<PreviewDto, String> {
    crate::off_main(move || build_preview(&path)).await
}

/// Whole file as raw bytes, for images, audio, video, PDF and 3D models.
#[tauri::command]
pub async fn read_bytes(path: PathBuf) -> Result<Response, String> {
    crate::off_main(move || {
        if file_size(&path)? > MEDIA_LIMIT {
            return Err("This file is too large to preview".to_string());
        }
        Ok(Response::new(read_head(&path, MEDIA_LIMIT as usize)?.0))
    })
    .await
}

#[tauri::command]
pub async fn thumbnail(path: PathBuf, size: u32, icon_only: bool) -> Result<Response, String> {
    crate::off_main(move || thumbs::thumbnail_png(&path, size, icon_only).map(Response::new).map_err(|e| e.to_string())).await
}

#[derive(Serialize)]
pub struct LockerDto {
    pid: u32,
    name: String,
    kind: &'static str,
}

#[tauri::command]
pub async fn who_locks(paths: Vec<PathBuf>) -> Result<Vec<LockerDto>, String> {
    crate::off_main(move || {
        lock::who_locks(&paths)
            .map(|v| v.into_iter().map(|l| LockerDto { pid: l.pid, name: l.name, kind: l.kind }).collect())
            .map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub async fn kill_process(pid: u32, paths: Vec<PathBuf>) -> Result<(), String> {
    crate::off_main(move || {
        // Only a process that holds these files right now may be ended.
        let lockers = lock::who_locks(&paths).map_err(|e| e.to_string())?;
        if !lockers.iter().any(|l| l.pid == pid) {
            return Err("That program is no longer locking these files".to_string());
        }
        lock::kill(pid).map_err(|e| e.to_string())
    })
    .await
}

/// Template tags (`exif:date`, `id3:artist`, …) for each file.
#[tauri::command]
pub async fn file_tags(paths: Vec<PathBuf>) -> Result<Vec<BTreeMap<String, String>>, String> {
    crate::off_main(move || Ok(paths.iter().map(|p| meta::tags(p)).collect())).await
}

/// Copies a file out of an archive to a temp folder and opens it.
#[tauri::command]
pub async fn extract_and_open(path: PathBuf) -> Result<(), String> {
    crate::off_main(move || {
        let (file, inner) = archive::split_path(&path).ok_or("That file is not inside an archive")?;
        if file_size(&path)? > MEDIA_LIMIT {
            return Err("This file is too large to open from the archive. Extract it first.".to_string());
        }
        let bytes = archive::read(&file, &inner, MEDIA_LIMIT as usize).map_err(|e| e.to_string())?;
        let name = path.file_name().ok_or("That file has no name")?;
        let stamp = blake3::hash(path.to_string_lossy().as_bytes()).to_hex();
        let dir = std::env::temp_dir().join("octopolis").join(&stamp.as_str()[..16]);
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let out = dir.join(name);
        std::fs::write(&out, bytes).map_err(|e| e.to_string())?;
        octo_core::shell::open_path(&out).map_err(|e| e.to_string())
    })
    .await
}

#[derive(Serialize)]
pub struct GitDto {
    branch: Option<String>,
    /// Status letter per lower-case child name.
    children: HashMap<String, &'static str>,
}

/// Git status of a folder's children; null outside a repository.
#[tauri::command]
pub async fn git_status(dir: PathBuf) -> Result<Option<GitDto>, String> {
    crate::off_main(move || {
        Ok(octo_core::git::status(&dir).map(|s| GitDto {
            branch: s.branch,
            children: s.children.into_iter().map(|(k, v)| (k, v.letter())).collect(),
        }))
    })
    .await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitDto {
    time_ms: i64,
    author: String,
}

#[tauri::command]
pub async fn git_last_commits(dir: PathBuf) -> Result<HashMap<String, CommitDto>, String> {
    crate::off_main(move || {
        Ok(octo_core::git::last_commits(&dir)
            .unwrap_or_default()
            .into_iter()
            .map(|(k, c)| (k, CommitDto { time_ms: c.time_ms, author: c.author }))
            .collect())
    })
    .await
}

/// Shows the classic Windows menu. It runs on the UI thread because shell
/// menus need that thread's message loop.
#[tauri::command]
pub fn native_menu(window: tauri::WebviewWindow, paths: Vec<PathBuf>) -> Result<(), String> {
    let parent = |p: &PathBuf| p.parent().map(|d| d.to_string_lossy().to_lowercase());
    if paths.iter().any(|p| parent(p) != paths.first().and_then(parent)) {
        return Err("The Windows menu needs items from a single folder".to_string());
    }
    let hwnd = window.hwnd().map_err(|e| e.to_string())?.0 as isize;
    window
        .run_on_main_thread(move || {
            let _ = octo_core::shell::show_native_menu(hwnd, &paths);
        })
        .map_err(|e| e.to_string())
}

#[derive(Serialize, serde::Deserialize, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub struct AttributesDto {
    read_only: bool,
    hidden: bool,
    system: bool,
    archive: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PropertiesDto {
    is_dir: bool,
    size: u64,
    size_on_disk: Option<u64>,
    created_ms: i64,
    modified_ms: i64,
    accessed_ms: i64,
    attributes: AttributesDto,
    hard_links: u32,
    streams: Vec<(String, u64)>,
    link_target: Option<String>,
}

#[tauri::command]
pub async fn file_properties(path: PathBuf) -> Result<PropertiesDto, String> {
    crate::off_main(move || {
        let p = octo_core::props::read(&path).map_err(|e| e.to_string())?;
        let a = p.attributes;
        Ok(PropertiesDto {
            is_dir: p.is_dir,
            size: p.size,
            size_on_disk: p.size_on_disk,
            created_ms: p.created_ms,
            modified_ms: p.modified_ms,
            accessed_ms: p.accessed_ms,
            attributes: AttributesDto { read_only: a.read_only, hidden: a.hidden, system: a.system, archive: a.archive },
            hard_links: p.hard_links,
            streams: p.streams.into_iter().map(|s| (s.name, s.size)).collect(),
            link_target: p.link_target,
        })
    })
    .await
}

/// Sets read-only / hidden / system / archive on every path at once.
#[tauri::command]
pub async fn set_file_attributes(paths: Vec<PathBuf>, attributes: AttributesDto) -> Result<(), String> {
    let a = octo_core::props::Attributes { read_only: attributes.read_only, hidden: attributes.hidden, system: attributes.system, archive: attributes.archive };
    crate::off_main(move || octo_core::props::set_attributes(&paths, a).map_err(|e| e.to_string())).await
}

#[tauri::command]
pub async fn set_file_times(path: PathBuf, created_ms: Option<i64>, modified_ms: Option<i64>, accessed_ms: Option<i64>) -> Result<(), String> {
    crate::off_main(move || octo_core::props::set_times(&path, created_ms, modified_ms, accessed_ms).map_err(|e| e.to_string())).await
}

/// Lower-case hex checksum: kind is "blake3", "sha256" or "md5".
#[tauri::command]
pub async fn file_checksum(path: PathBuf, kind: String) -> Result<String, String> {
    use octo_core::props::HashKind;
    let kind = match kind.as_str() {
        "blake3" => HashKind::Blake3,
        "sha256" => HashKind::Sha256,
        "md5" => HashKind::Md5,
        other => return Err(format!("unknown checksum \"{other}\"")),
    };
    crate::off_main(move || octo_core::props::hash_file(&path, kind, &octo_core::ops::CancelToken::default(), |_, _| {}).map_err(|e| e.to_string())).await
}

/// "Always keep on this device" (keep) or "Free up space" for synced files.
#[tauri::command]
pub async fn set_cloud_pin(paths: Vec<PathBuf>, keep: bool) -> Result<(), String> {
    crate::off_main(move || octo_core::props::set_cloud_pin(&paths, keep).map_err(|e| e.to_string())).await
}

/// Lines of a file containing `text` (for showing why a `content:` search matched).
#[tauri::command]
pub async fn content_matches(path: PathBuf, text: String) -> Result<Vec<(usize, String)>, String> {
    crate::off_main(move || octo_core::search::content::matching_lines(&path, &text, 50).map_err(|e| e.to_string())).await
}

/// Cancel tokens for long folder scans (duplicates, cleanup), by caller-chosen id.
#[derive(Default)]
pub struct ScanState {
    running: std::sync::Mutex<HashMap<String, octo_core::ops::CancelToken>>,
}

pub(crate) fn begin_scan(state: &tauri::State<'_, ScanState>, id: &str) -> octo_core::ops::CancelToken {
    let token = octo_core::ops::CancelToken::default();
    let mut running = state.running.lock().unwrap_or_else(|e| e.into_inner());
    // A new scan with the same id replaces (and stops) the old one.
    if let Some(old) = running.insert(id.to_string(), token.clone()) {
        old.cancel();
    }
    token
}

#[tauri::command]
pub fn cancel_scan(state: tauri::State<'_, ScanState>, id: String) {
    if let Some(t) = state.running.lock().unwrap_or_else(|e| e.into_inner()).remove(&id) {
        t.cancel();
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DupeGroupDto {
    size: u64,
    /// [path, modified ms], newest first.
    files: Vec<(String, i64)>,
}

impl DupeGroupDto {
    pub(crate) fn new(size: u64, files: Vec<(String, i64)>) -> Self {
        Self { size, files }
    }
}

/// Finds duplicate files under `root`; progress is (bytes read, bytes to read).
#[tauri::command]
pub async fn find_duplicates(
    state: tauri::State<'_, ScanState>,
    id: String,
    root: PathBuf,
    min_size: u64,
    on_progress: tauri::ipc::Channel<(u64, u64)>,
) -> Result<Vec<DupeGroupDto>, String> {
    let cancel = begin_scan(&state, &id);
    crate::off_main(move || {
        let last = std::sync::Mutex::new(std::time::Instant::now());
        let progress = |done: u64, total: u64| {
            let mut t = last.lock().unwrap_or_else(|e| e.into_inner());
            if t.elapsed().as_millis() >= 100 {
                *t = std::time::Instant::now();
                let _ = on_progress.send((done, total));
            }
        };
        let groups = octo_core::dupes::find(&root, min_size, &cancel, &progress).map_err(|e| e.to_string())?;
        if cancel.is_cancelled() {
            return Err("cancelled".into());
        }
        Ok(groups
            .into_iter()
            .map(|g| DupeGroupDto { size: g.size, files: g.files.into_iter().map(|f| (f.path.to_string_lossy().into_owned(), f.modified_ms)).collect() })
            .collect())
    })
    .await
}

/// The tag index, loaded on first use from the app data folder.
#[derive(Default)]
pub struct TagsState {
    store: std::sync::Mutex<Option<octo_core::tags::TagStore>>,
}

const TAGS_FILE: &str = "tags.tsv";

fn tags_file(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager;
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join(TAGS_FILE))
}

/// Runs `f` on the tag index (loading it first if needed); saves when `f` returns true.
pub fn with_tags<T>(app: &tauri::AppHandle, f: impl FnOnce(&mut octo_core::tags::TagStore) -> (T, bool)) -> Result<T, String> {
    use tauri::Manager;
    let file = tags_file(app)?;
    let state = app.state::<TagsState>();
    let mut guard = state.store.lock().unwrap_or_else(|e| e.into_inner());
    let store = guard.get_or_insert_with(|| octo_core::tags::TagStore::load(&file));
    let (out, changed) = f(store);
    if changed {
        store.save(&file).map_err(|e| e.to_string())?;
    }
    Ok(out)
}

/// Keeps tags on items Octopolis moved or renamed.
pub fn tags_follow(app: &tauri::AppHandle, pairs: &[(PathBuf, PathBuf)]) {
    if !pairs.is_empty() {
        let _ = with_tags(app, |t| ((), t.moved(pairs)));
    }
}

/// Tags of the items in a folder: [lower-case name, tags].
#[tauri::command]
pub async fn tags_in_dir(app: tauri::AppHandle, dir: String) -> Result<Vec<(String, Vec<String>)>, String> {
    crate::off_main(move || with_tags(&app, |t| (t.in_dir(&dir), false))).await
}

#[tauri::command]
pub async fn set_tag(app: tauri::AppHandle, paths: Vec<String>, tag: String, on: bool) -> Result<(), String> {
    crate::off_main(move || with_tags(&app, |t| ((), t.set(&paths, &tag, on)))).await
}

/// Every tag with its item count.
#[tauri::command]
pub async fn all_tags(app: tauri::AppHandle) -> Result<Vec<(String, usize)>, String> {
    crate::off_main(move || with_tags(&app, |t| (t.all().into_iter().collect(), false))).await
}

/// Items with `tag`; items that no longer exist are forgotten first.
#[tauri::command]
pub async fn tagged_paths(app: tauri::AppHandle, tag: String) -> Result<Vec<String>, String> {
    crate::off_main(move || {
        with_tags(&app, |t| {
            let pruned = t.prune_missing() > 0;
            (t.with_tag(&tag), pruned)
        })
    })
    .await
}

/// Runs the installed `git` in `dir` with `args`, without a console window.
fn git_cli(dir: &Path, args: &[&std::ffi::OsStr]) -> Result<String, String> {
    let mut cmd = std::process::Command::new("git");
    cmd.arg("-C").arg(dir).args(args);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let out = cmd.output().map_err(|e| if e.kind() == std::io::ErrorKind::NotFound { "Git is not installed (or not on PATH)".to_string() } else { e.to_string() })?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(err.lines().find(|l| !l.trim().is_empty()).unwrap_or("git failed").trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Runs one git subcommand for every path, grouped by folder (git finds the repository).
fn git_on_paths(paths: &[PathBuf], sub: &[&str]) -> Result<(), String> {
    let mut by_dir: BTreeMap<PathBuf, Vec<PathBuf>> = BTreeMap::new();
    for p in paths {
        by_dir.entry(p.parent().unwrap_or(p).to_path_buf()).or_default().push(p.clone());
    }
    for (dir, items) in by_dir {
        let mut args: Vec<&std::ffi::OsStr> = sub.iter().map(std::ffi::OsStr::new).collect();
        args.push(std::ffi::OsStr::new("--"));
        args.extend(items.iter().map(|p| p.as_os_str()));
        git_cli(&dir, &args)?;
    }
    Ok(())
}

/// "stage", "unstage" or "discard" (throws away uncommitted changes to tracked files).
#[tauri::command]
pub async fn git_change(paths: Vec<PathBuf>, action: String) -> Result<(), String> {
    let sub: &[&str] = match action.as_str() {
        "stage" => &["add"],
        "unstage" => &["restore", "--staged"],
        "discard" => &["restore", "--worktree", "--staged", "--source=HEAD"],
        other => return Err(format!("unknown git action \"{other}\"")),
    };
    crate::off_main(move || git_on_paths(&paths, sub)).await
}

/// The file's changes against the last commit (staged and not), as a unified diff.
#[tauri::command]
pub async fn git_diff(path: PathBuf) -> Result<String, String> {
    crate::off_main(move || {
        let dir = path.parent().unwrap_or(&path).to_path_buf();
        git_cli(&dir, &[std::ffi::OsStr::new("diff"), std::ffi::OsStr::new("--no-color"), std::ffi::OsStr::new("HEAD"), std::ffi::OsStr::new("--"), path.as_os_str()])
    })
    .await
}

#[cfg(test)]
mod git_tests {
    use super::*;
    use std::ffi::OsStr;

    fn git(dir: &Path, args: &[&str]) -> Result<String, String> {
        let a: Vec<&OsStr> = args.iter().map(OsStr::new).collect();
        git_cli(dir, &a)
    }

    #[test]
    fn stage_unstage_diff_and_discard() {
        let tmp = std::env::temp_dir().join(format!("octo-git-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        if git(&tmp, &["init", "-q"]).is_err() {
            eprintln!("git not installed; skipping");
            return;
        }
        let file = tmp.join("a.txt");
        std::fs::write(&file, "one\n").unwrap();
        git(&tmp, &["add", "a.txt"]).unwrap();
        git(&tmp, &["-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qm", "first"]).unwrap();

        std::fs::write(&file, "one\ntwo\n").unwrap();
        git_on_paths(std::slice::from_ref(&file), &["add"]).unwrap();
        assert!(git(&tmp, &["diff", "--cached", "--name-only"]).unwrap().contains("a.txt"), "staged");
        git_on_paths(std::slice::from_ref(&file), &["restore", "--staged"]).unwrap();
        assert!(git(&tmp, &["diff", "--cached", "--name-only"]).unwrap().trim().is_empty(), "unstaged");

        let diff = git(&tmp, &["diff", "--no-color", "HEAD", "--", "a.txt"]).unwrap();
        assert!(diff.contains("+two"), "{diff}");
        git_on_paths(std::slice::from_ref(&file), &["restore", "--worktree", "--staged", "--source=HEAD"]).unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap().replace("\r\n", "\n"), "one\n", "discarded");
        let _ = std::fs::remove_dir_all(&tmp);
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupDto {
    total_bytes: u64,
    /// Each list: [path, size, modified ms].
    largest: Vec<(String, u64, i64)>,
    old_large: Vec<(String, u64, i64)>,
    empty_dirs: Vec<(String, u64, i64)>,
    junk_dirs: Vec<(String, u64, i64)>,
    temp_files: Vec<(String, u64, i64)>,
}

/// What's taking space under `root`, and what could go.
#[tauri::command]
pub async fn scan_cleanup(state: tauri::State<'_, ScanState>, id: String, root: PathBuf) -> Result<CleanupDto, String> {
    let cancel = begin_scan(&state, &id);
    crate::off_main(move || {
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64);
        let r = octo_core::cleanup::scan(&root, now, &cancel).map_err(|e| e.to_string())?;
        if cancel.is_cancelled() {
            return Err("cancelled".into());
        }
        let list = |v: Vec<octo_core::cleanup::Item>| v.into_iter().map(|i| (i.path.to_string_lossy().into_owned(), i.size, i.modified_ms)).collect();
        Ok(CleanupDto {
            total_bytes: r.total_bytes,
            largest: list(r.largest),
            old_large: list(r.old_large),
            empty_dirs: list(r.empty_dirs),
            junk_dirs: list(r.junk_dirs),
            temp_files: list(r.temp_files),
        })
    })
    .await
}
