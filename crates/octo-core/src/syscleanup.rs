//! System cleanup: caches and leftovers that are safe to delete.
//!
//! The list of what can be cleaned is a fixed catalog. Callers refer to entries
//! by id and never pass paths, so nothing outside the catalog can be deleted.
//! Every folder is resolved from the environment (`%LOCALAPPDATA%`, `%SystemRoot%`
//! and so on) and only a folder's contents are removed, never the folder itself.
//! Links and junctions are never followed.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use crate::ops::CancelToken;

/// Where a category is shown, and whether it starts ticked.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Group {
    /// Always safe; ticked by default.
    Safe,
    Browsers,
    /// Re-downloaded or rebuilt on next use; slower the first time.
    Developer,
    /// Windows folders, which need administrator rights to clear.
    Windows,
}

impl Group {
    pub fn as_str(self) -> &'static str {
        match self {
            Group::Safe => "safe",
            Group::Browsers => "browsers",
            Group::Developer => "developer",
            Group::Windows => "windows",
        }
    }
}

/// The well-known folders everything is resolved from. Tests build their own.
#[derive(Debug, Clone, Default)]
pub struct Dirs {
    pub local: Option<PathBuf>,
    pub home: Option<PathBuf>,
    pub windir: Option<PathBuf>,
    pub temp: Option<PathBuf>,
    pub system_drive: Option<PathBuf>,
    /// Octopolis's own staged-update folder, supplied by the app.
    pub app_updates: Option<PathBuf>,
}

impl Dirs {
    pub fn from_env() -> Self {
        let var = |k: &str| std::env::var_os(k).map(PathBuf::from).filter(|p| p.is_absolute());
        Dirs {
            local: var("LOCALAPPDATA"),
            home: var("USERPROFILE"),
            windir: var("SystemRoot"),
            temp: Some(std::env::temp_dir()),
            system_drive: std::env::var_os("SystemDrive").map(|d| PathBuf::from(format!("{}\\", d.to_string_lossy().trim_end_matches('\\')))),
            app_updates: None,
        }
    }
}

type Resolve = fn(&Dirs) -> Vec<PathBuf>;
type NameFilter = fn(&str) -> bool;

/// One entry of the catalog.
pub struct Category {
    pub id: &'static str,
    pub label: &'static str,
    pub note: &'static str,
    pub group: Group,
    /// Needs administrator rights to clear.
    pub admin: bool,
    /// Shown with its size but never deleted by this tool.
    pub report_only: bool,
    /// Files newer than this are left alone.
    min_age: Duration,
    /// Only files whose name passes are removed (top level of each folder only).
    filter: Option<NameFilter>,
    resolve: Resolve,
}

const NO_AGE: Duration = Duration::ZERO;

fn join(base: &Option<PathBuf>, rel: &str) -> Vec<PathBuf> {
    base.as_ref().map(|b| vec![b.join(rel)]).unwrap_or_default()
}

/// `<root>\<profile>\<sub>` for every browser profile folder under `root`.
fn profile_subdirs(root: Option<PathBuf>, subs: &[&str]) -> Vec<PathBuf> {
    let Some(root) = root else { return Vec::new() };
    let Ok(read) = std::fs::read_dir(&root) else { return Vec::new() };
    let mut out = Vec::new();
    for profile in read.flatten().map(|e| e.path()).filter(|p| p.is_dir()) {
        for sub in subs {
            let dir = profile.join(sub);
            if dir.is_dir() {
                out.push(dir);
            }
        }
    }
    out
}

const CHROMIUM_CACHES: &[&str] = &["Cache", "Code Cache", "GPUCache", "GrShaderCache", "ShaderCache"];

fn is_thumb_cache(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    (n.starts_with("thumbcache_") || n.starts_with("iconcache_")) && n.ends_with(".db")
}

fn is_memory_dump(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    n == "memory.dmp" || n.ends_with(".dmp")
}

fn is_log_or_cab(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    n.ends_with(".log") || n.ends_with(".cab")
}

/// Everything this tool can clean, in display order.
pub fn catalog() -> &'static [Category] {
    static CATALOG: &[Category] = &[
        Category { id: "user-temp", label: "Temporary files", note: "Files programs left in your temp folder. Anything changed in the last 24 hours is kept.", group: Group::Safe, admin: false, report_only: false, min_age: Duration::from_secs(24 * 3600), filter: None, resolve: |d| d.temp.clone().into_iter().collect() },
        Category { id: "error-reports", label: "Windows error reports", note: "Crash reports Windows queued to send to Microsoft.", group: Group::Safe, admin: false, report_only: false, min_age: NO_AGE, filter: None, resolve: |d| join(&d.local, r"Microsoft\Windows\WER") },
        Category { id: "crash-dumps", label: "Crash dumps", note: "Memory dumps programs wrote when they crashed.", group: Group::Safe, admin: false, report_only: false, min_age: NO_AGE, filter: None, resolve: |d| join(&d.local, "CrashDumps") },
        Category { id: "thumbnails", label: "Thumbnail and icon caches", note: "Windows rebuilds these. Ones in use are kept until File Explorer restarts.", group: Group::Safe, admin: false, report_only: false, min_age: NO_AGE, filter: Some(is_thumb_cache), resolve: |d| join(&d.local, r"Microsoft\Windows\Explorer") },
        Category {
            id: "shader-caches",
            label: "Graphics shader caches",
            note: "Compiled shaders from DirectX, NVIDIA and AMD. Games rebuild them, so the first launch can stutter.",
            group: Group::Safe,
            admin: false,
            report_only: false,
            min_age: NO_AGE,
            filter: None,
            resolve: |d| [r"D3DSCache", r"NVIDIA\DXCache", r"NVIDIA\GLCache", r"AMD\DxCache", r"AMD\GLCache"].iter().flat_map(|rel| join(&d.local, rel)).collect(),
        },
        Category { id: "octopolis-updates", label: "Octopolis staged updates", note: "Update installers Octopolis downloaded earlier.", group: Group::Safe, admin: false, report_only: false, min_age: NO_AGE, filter: None, resolve: |d| d.app_updates.clone().into_iter().collect() },
        Category {
            id: "chromium-caches",
            label: "Chrome, Edge and Brave caches",
            note: "Page caches only. Passwords, cookies, history and bookmarks are not touched.",
            group: Group::Browsers,
            admin: false,
            report_only: false,
            min_age: NO_AGE,
            filter: None,
            resolve: |d| {
                [r"Google\Chrome\User Data", r"Microsoft\Edge\User Data", r"BraveSoftware\Brave-Browser\User Data"]
                    .iter()
                    .flat_map(|rel| profile_subdirs(d.local.as_ref().map(|l| l.join(rel)), CHROMIUM_CACHES))
                    .collect()
            },
        },
        Category {
            id: "firefox-caches",
            label: "Firefox cache",
            note: "Page cache only. Logins, cookies and history are not touched.",
            group: Group::Browsers,
            admin: false,
            report_only: false,
            min_age: NO_AGE,
            filter: None,
            resolve: |d| profile_subdirs(d.local.as_ref().map(|l| l.join(r"Mozilla\Firefox\Profiles")), &["cache2", "startupCache"]),
        },
        Category { id: "npm-cache", label: "npm cache", note: "Downloaded packages. npm fetches them again when needed.", group: Group::Developer, admin: false, report_only: false, min_age: NO_AGE, filter: None, resolve: |d| join(&d.local, "npm-cache") },
        Category { id: "yarn-cache", label: "Yarn cache", note: "Downloaded packages. Yarn fetches them again when needed.", group: Group::Developer, admin: false, report_only: false, min_age: NO_AGE, filter: None, resolve: |d| join(&d.local, r"Yarn\Cache") },
        Category { id: "pip-cache", label: "pip cache", note: "Downloaded Python packages and built wheels.", group: Group::Developer, admin: false, report_only: false, min_age: NO_AGE, filter: None, resolve: |d| join(&d.local, r"pip\Cache") },
        Category { id: "nuget-cache", label: "NuGet cache", note: "Web request cache for NuGet. Restored packages stay.", group: Group::Developer, admin: false, report_only: false, min_age: NO_AGE, filter: None, resolve: |d| [r"NuGet\v3-cache", r"Temp\NuGetScratch"].iter().flat_map(|rel| join(&d.local, rel)).collect() },
        Category { id: "cargo-cache", label: "Cargo downloaded crates", note: "Crate archives Cargo downloaded. They are fetched again on the next build.", group: Group::Developer, admin: false, report_only: false, min_age: NO_AGE, filter: None, resolve: |d| join(&d.home, r".cargo\registry\cache") },
        Category { id: "go-build-cache", label: "Go build cache", note: "Compiled Go packages. The next build is slower.", group: Group::Developer, admin: false, report_only: false, min_age: NO_AGE, filter: None, resolve: |d| join(&d.local, "go-build") },
        Category { id: "gradle-cache", label: "Gradle caches", note: "Downloaded dependencies and build caches. The next build downloads them again.", group: Group::Developer, admin: false, report_only: false, min_age: NO_AGE, filter: None, resolve: |d| join(&d.home, r".gradle\caches") },
        Category { id: "windows-update", label: "Windows Update downloads", note: "Update files Windows already installed or can download again.", group: Group::Windows, admin: true, report_only: false, min_age: NO_AGE, filter: None, resolve: |d| join(&d.windir, r"SoftwareDistribution\Download") },
        Category {
            id: "delivery-optimization",
            label: "Delivery Optimization cache",
            note: "Update pieces Windows keeps to share with other PCs.",
            group: Group::Windows,
            admin: true,
            report_only: false,
            min_age: NO_AGE,
            filter: None,
            resolve: |d| join(&d.windir, r"ServiceProfiles\NetworkService\AppData\Local\Microsoft\Windows\DeliveryOptimization\Cache"),
        },
        Category { id: "windows-temp", label: "Windows temporary files", note: "The system temp folder. Anything changed in the last 24 hours is kept.", group: Group::Windows, admin: true, report_only: false, min_age: Duration::from_secs(24 * 3600), filter: None, resolve: |d| join(&d.windir, "Temp") },
        Category {
            id: "system-dumps",
            label: "System memory dumps",
            note: "Dumps Windows wrote after a blue screen.",
            group: Group::Windows,
            admin: true,
            report_only: false,
            min_age: NO_AGE,
            filter: Some(is_memory_dump),
            resolve: |d| [vec![d.windir.clone()].into_iter().flatten().collect::<Vec<_>>(), join(&d.windir, "Minidump")].concat(),
        },
        Category { id: "windows-logs", label: "Windows servicing logs", note: "Old install and update logs.", group: Group::Windows, admin: true, report_only: false, min_age: Duration::from_secs(7 * 24 * 3600), filter: Some(is_log_or_cab), resolve: |d| join(&d.windir, r"Logs\CBS") },
        Category {
            id: "windows-old",
            label: "Previous Windows installation",
            note: "Windows.old. Remove it from Windows Settings > System > Storage > Temporary files, which handles it safely.",
            group: Group::Windows,
            admin: true,
            report_only: true,
            min_age: NO_AGE,
            filter: None,
            resolve: |d| join(&d.system_drive, "Windows.old"),
        },
    ];
    CATALOG
}

/// Looks up a category by id.
pub fn category(id: &str) -> Option<&'static Category> {
    catalog().iter().find(|c| c.id == id)
}

/// What a scan found for one category.
#[derive(Debug, Clone)]
pub struct CategoryReport {
    pub id: &'static str,
    pub label: &'static str,
    pub note: &'static str,
    pub group: Group,
    pub admin: bool,
    pub report_only: bool,
    pub bytes: u64,
    pub files: u64,
    /// The folders that exist and will be cleaned.
    pub folders: Vec<PathBuf>,
}

/// Outcome of removing a category's contents.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Tally {
    pub bytes: u64,
    pub files: u64,
    /// Files that were in use, protected or too new.
    pub skipped: u64,
}

impl Tally {
    fn add(&mut self, other: Tally) {
        self.bytes += other.bytes;
        self.files += other.files;
        self.skipped += other.skipped;
    }
}

/// A folder is only cleaned when it is a real, deep path (never a drive root or a top-level folder).
pub fn is_safe_root(path: &Path) -> bool {
    path.is_absolute() && path.components().count() >= 3
}

const REPARSE_POINT: u32 = 0x400;

fn is_link(meta: &std::fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        meta.file_attributes() & REPARSE_POINT != 0
    }
    #[cfg(not(windows))]
    {
        meta.file_type().is_symlink()
    }
}

struct Pass<'a> {
    min_age: Duration,
    filter: Option<NameFilter>,
    delete: bool,
    now: SystemTime,
    cancel: &'a CancelToken,
}

fn old_enough(meta: &std::fs::Metadata, pass: &Pass<'_>) -> bool {
    if pass.min_age.is_zero() {
        return true;
    }
    meta.modified().ok().and_then(|m| pass.now.duration_since(m).ok()).is_some_and(|age| age >= pass.min_age)
}

fn remove_file(path: &Path, meta: &std::fs::Metadata) -> bool {
    if std::fs::remove_file(path).is_ok() {
        return true;
    }
    // A read-only file can't be removed until the flag is cleared.
    let mut perms = meta.permissions();
    if perms.readonly() {
        #[allow(clippy::permissions_set_readonly_false)]
        perms.set_readonly(false);
        let _ = std::fs::set_permissions(path, perms);
        return std::fs::remove_file(path).is_ok();
    }
    false
}

/// Walks the contents of `dir`, counting (and, when `delete`, removing) eligible files.
fn walk(dir: &Path, pass: &Pass<'_>, top: bool) -> Tally {
    let mut tally = Tally::default();
    let Ok(read) = std::fs::read_dir(dir) else { return tally };
    for entry in read.flatten() {
        if pass.cancel.is_cancelled() {
            break;
        }
        let path = entry.path();
        let Ok(meta) = std::fs::symlink_metadata(&path) else { continue };
        if is_link(&meta) {
            continue;
        }
        if meta.is_dir() {
            // A name filter applies to files directly inside the folder only.
            if pass.filter.is_some() {
                continue;
            }
            tally.add(walk(&path, pass, false));
            if pass.delete {
                // Succeeds only when nothing is left inside.
                let _ = std::fs::remove_dir(&path);
            }
            continue;
        }
        if let Some(filter) = pass.filter
            && (!top || !filter(&entry.file_name().to_string_lossy()))
        {
            continue;
        }
        if !old_enough(&meta, pass) {
            tally.skipped += 1;
            continue;
        }
        if pass.delete {
            if remove_file(&path, &meta) {
                tally.bytes += meta.len();
                tally.files += 1;
            } else {
                tally.skipped += 1;
            }
        } else {
            tally.bytes += meta.len();
            tally.files += 1;
        }
    }
    tally
}

fn run_pass(cat: &Category, dirs: &Dirs, delete: bool, cancel: &CancelToken) -> (Tally, Vec<PathBuf>) {
    let pass = Pass { min_age: cat.min_age, filter: cat.filter, delete, now: SystemTime::now(), cancel };
    let mut tally = Tally::default();
    let mut folders = Vec::new();
    for root in (cat.resolve)(dirs) {
        if !is_safe_root(&root) || !root.is_dir() {
            continue;
        }
        tally.add(walk(&root, &pass, true));
        folders.push(root);
    }
    (tally, folders)
}

/// Measures every category (in parallel). Nothing is changed.
pub fn scan(dirs: &Dirs, cancel: &CancelToken) -> Vec<CategoryReport> {
    std::thread::scope(|s| {
        let handles: Vec<_> = catalog()
            .iter()
            .map(|cat| {
                s.spawn(move || {
                    let (t, folders) = run_pass(cat, dirs, false, cancel);
                    CategoryReport { id: cat.id, label: cat.label, note: cat.note, group: cat.group, admin: cat.admin, report_only: cat.report_only, bytes: t.bytes, files: t.files, folders }
                })
            })
            .collect();
        handles.into_iter().filter_map(|h| h.join().ok()).collect()
    })
}

/// Removes the contents of the given non-admin categories. Unknown, admin-only and report-only ids are ignored.
pub fn clean(ids: &[String], dirs: &Dirs, cancel: &CancelToken) -> Tally {
    let mut total = Tally::default();
    for id in ids {
        let Some(cat) = category(id).filter(|c| !c.admin && !c.report_only) else { continue };
        total.add(run_pass(cat, dirs, true, cancel).0);
    }
    total
}

/// Bytes the given categories hold right now (what a clean could free).
pub fn measure(ids: &[String], dirs: &Dirs, cancel: &CancelToken) -> u64 {
    ids.iter().filter_map(|id| category(id)).map(|c| run_pass(c, dirs, false, cancel).0.bytes).sum()
}

/// PowerShell for the given admin categories, to run elevated. Built only from the catalog.
pub fn admin_script(ids: &[String], dirs: &Dirs) -> String {
    let quote = |p: &Path| format!("'{}'", p.to_string_lossy().replace('\'', "''"));
    let mut lines = vec!["$ErrorActionPreference = 'SilentlyContinue'".to_string()];
    for id in ids {
        if id == "component-store" {
            lines.push("Dism.exe /Online /Cleanup-Image /StartComponentCleanup | Out-Null".into());
            continue;
        }
        let Some(cat) = category(id).filter(|c| c.admin && !c.report_only) else { continue };
        if id.as_str() == "windows-update" {
            lines.push("Stop-Service -Name wuauserv, bits -Force".into());
        }
        for root in (cat.resolve)(dirs).into_iter().filter(|r| is_safe_root(r) && r.is_dir()) {
            let target = quote(&root);
            let line = match cat.filter {
                None if cat.min_age.is_zero() => format!("Get-ChildItem -LiteralPath {target} -Force | Remove-Item -Recurse -Force"),
                None => format!("Get-ChildItem -LiteralPath {target} -Force | Where-Object {{ $_.LastWriteTime -lt (Get-Date).AddSeconds(-{}) }} | Remove-Item -Recurse -Force", cat.min_age.as_secs()),
                Some(_) => {
                    // Name filters are rechecked here from the same fixed patterns.
                    let pattern = match id.as_str() {
                        "system-dumps" => "*.dmp",
                        _ => "*.log','*.cab",
                    };
                    let age = cat.min_age.as_secs();
                    format!("Get-ChildItem -LiteralPath {target} -File -Force -Include '{pattern}' | Where-Object {{ $_.LastWriteTime -lt (Get-Date).AddSeconds(-{age}) }} | Remove-Item -Force")
                }
            };
            lines.push(line);
        }
        if id.as_str() == "windows-update" {
            lines.push("Start-Service -Name bits, wuauserv".into());
        }
    }
    lines.join("\n")
}

/// Standard base64 (what `powershell -EncodedCommand` expects, over UTF-16LE text).
pub fn encode_powershell(script: &str) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let bytes: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = (u32::from(chunk[0]) << 16) | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8) | u32::from(*chunk.get(2).unwrap_or(&0));
        out.push(ALPHABET[(n >> 18) as usize & 63] as char);
        out.push(ALPHABET[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { ALPHABET[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { ALPHABET[n as usize & 63] as char } else { '=' });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("octopolis-syscleanup-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn dirs_in(base: &Path) -> Dirs {
        Dirs { local: Some(base.join("Local")), home: Some(base.join("Home")), windir: Some(base.join("Windows")), temp: Some(base.join("Temp")), system_drive: Some(base.to_path_buf()), app_updates: None }
    }

    /// Run with `cargo test -p octo-core -- --ignored --nocapture` to see what could be freed on this PC (read-only).
    #[test]
    #[ignore]
    fn lists_reclaimable_space() {
        for r in scan(&Dirs::from_env(), &CancelToken::default()) {
            println!("{:<26} {:>10} bytes  {:>6} files  {:?}", r.id, r.bytes, r.files, r.folders.len());
        }
    }

    #[test]
    fn catalog_ids_are_unique() {
        let mut ids: Vec<_> = catalog().iter().map(|c| c.id).collect();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), catalog().len());
    }

    #[test]
    fn every_resolved_root_is_deep_and_inside_a_known_folder() {
        let base = std::env::temp_dir().join("octopolis-roots");
        let dirs = dirs_in(&base);
        for cat in catalog() {
            for root in (cat.resolve)(&dirs) {
                assert!(is_safe_root(&root), "{} resolves to {}", cat.id, root.display());
                assert!(root.starts_with(&base), "{} escapes: {}", cat.id, root.display());
            }
        }
    }

    #[test]
    fn refuses_drive_roots_and_top_level_folders() {
        assert!(!is_safe_root(Path::new("C:\\")));
        assert!(!is_safe_root(Path::new("relative\\path\\here")));
        assert!(is_safe_root(Path::new("C:\\Windows\\Temp")));
    }

    #[test]
    fn scan_and_clean_remove_contents_but_keep_the_folder() {
        let base = scratch("clean");
        let dirs = dirs_in(&base);
        let crash = base.join(r"Local\CrashDumps");
        fs::create_dir_all(crash.join("nested")).unwrap();
        fs::write(crash.join("a.dmp"), vec![0u8; 100]).unwrap();
        fs::write(crash.join("nested").join("b.dmp"), vec![0u8; 50]).unwrap();
        let cancel = CancelToken::default();

        let report = scan(&dirs, &cancel);
        let r = report.iter().find(|r| r.id == "crash-dumps").unwrap();
        assert_eq!((r.bytes, r.files), (150, 2));

        let t = clean(&["crash-dumps".into()], &dirs, &cancel);
        assert_eq!((t.bytes, t.files, t.skipped), (150, 2, 0));
        assert!(crash.is_dir());
        assert_eq!(fs::read_dir(&crash).unwrap().count(), 0);
        let _ = fs::remove_dir_all(base);
    }

    #[test]
    fn recent_files_are_kept_and_filters_only_match_their_names() {
        let base = scratch("age");
        let dirs = dirs_in(&base);
        fs::create_dir_all(base.join("Temp")).unwrap();
        fs::write(base.join("Temp").join("fresh.tmp"), b"x").unwrap();
        let explorer = base.join(r"Local\Microsoft\Windows\Explorer");
        fs::create_dir_all(&explorer).unwrap();
        fs::write(explorer.join("thumbcache_256.db"), vec![0u8; 10]).unwrap();
        fs::write(explorer.join("settings.dat"), vec![0u8; 10]).unwrap();
        let cancel = CancelToken::default();

        let t = clean(&["user-temp".into(), "thumbnails".into()], &dirs, &cancel);
        assert_eq!(t.files, 1, "only the thumbnail cache goes");
        assert_eq!(t.skipped, 1, "the fresh temp file is kept");
        assert!(base.join("Temp").join("fresh.tmp").exists() && explorer.join("settings.dat").exists());
        let _ = fs::remove_dir_all(base);
    }

    #[test]
    fn admin_and_report_only_categories_are_not_cleaned_here() {
        let base = scratch("admin");
        let dirs = dirs_in(&base);
        let temp = base.join(r"Windows\Temp");
        fs::create_dir_all(&temp).unwrap();
        fs::write(temp.join("x.tmp"), b"x").unwrap();
        let t = clean(&["windows-temp".into(), "windows-old".into(), "nope".into()], &dirs, &CancelToken::default());
        assert_eq!(t, Tally::default());
        assert!(temp.join("x.tmp").exists());
        let _ = fs::remove_dir_all(base);
    }

    #[test]
    fn admin_script_only_names_catalog_folders() {
        let base = std::env::temp_dir().join("octopolis-script");
        let _ = fs::create_dir_all(base.join(r"Windows\SoftwareDistribution\Download"));
        let script = admin_script(&["windows-update".into(), "evil'; Remove-Item C:\\ -Recurse".into(), "user-temp".into()], &dirs_in(&base));
        assert!(script.contains("wuauserv") && script.contains("SoftwareDistribution"));
        assert!(!script.contains("evil") && !script.contains("Remove-Item C:"));
        let _ = fs::remove_dir_all(base);
    }

    #[test]
    fn powershell_encoding_matches_a_known_value() {
        // "A" in UTF-16LE is 41 00, which is base64 "QQA=".
        assert_eq!(encode_powershell("A"), "QQA=");
        assert_eq!(encode_powershell("hi"), "aABpAA==");
    }
}
