//! Git status and last-commit info for the file list, read with gitoxide.

use std::collections::HashMap;
use std::path::Path;

use gix::bstr::ByteSlice;

/// Commits inspected when looking for each file's last change.
const COMMIT_LIMIT: usize = 3000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FileStatus {
    Staged,
    Modified,
    Untracked,
    Deleted,
    Conflict,
    Ignored,
}

impl FileStatus {
    pub fn letter(self) -> &'static str {
        match self {
            FileStatus::Staged => "S",
            FileStatus::Modified => "M",
            FileStatus::Untracked => "U",
            FileStatus::Deleted => "D",
            FileStatus::Conflict => "C",
            FileStatus::Ignored => "I",
        }
    }

    /// Higher wins when a folder summarizes the files inside it.
    fn rank(self) -> u8 {
        match self {
            FileStatus::Ignored => 0,
            FileStatus::Untracked => 1,
            FileStatus::Staged => 2,
            FileStatus::Modified => 3,
            FileStatus::Deleted => 4,
            FileStatus::Conflict => 5,
        }
    }
}

#[derive(Debug, Default)]
pub struct RepoStatus {
    pub branch: Option<String>,
    /// Status per direct child of the folder (lower-case name).
    pub children: HashMap<String, FileStatus>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LastCommit {
    pub time_ms: i64,
    pub author: String,
}

/// `dir` relative to the work tree, with `/` separators ("" for the root).
fn prefix_of(repo: &gix::Repository, dir: &Path) -> Option<String> {
    let root = dunce_like(repo.workdir()?);
    let dir = dunce_like(dir);
    let rel = lower(&dir).strip_prefix(&lower(&root))?.trim_start_matches('\\').len();
    let start = dir.len() - rel;
    Some(dir[start..].replace('\\', "/"))
}

fn dunce_like(p: &Path) -> String {
    p.to_string_lossy().trim_start_matches(r"\\?\").replace('/', "\\").trim_end_matches('\\').to_string()
}

fn lower(s: &str) -> String {
    s.to_lowercase()
}

/// Reduces a repository-relative path to the name of the direct child of the
/// folder at `prefix`, or None if the path is outside that folder.
fn child_of(prefix: &str, path: &str) -> Option<(String, bool)> {
    let rest = if prefix.is_empty() {
        path
    } else {
        let (head, tail) = path.split_at_checked(prefix.len())?;
        if !head.eq_ignore_ascii_case(prefix) {
            return None;
        }
        tail.strip_prefix('/')?
    };
    let rest = rest.trim_end_matches('/');
    if rest.is_empty() {
        return None;
    }
    Some(match rest.split_once('/') {
        Some((first, _)) => (first.to_lowercase(), true),
        None => (rest.to_lowercase(), false),
    })
}

fn note(children: &mut HashMap<String, FileStatus>, prefix: &str, path: &str, status: FileStatus) {
    let Some((name, nested)) = child_of(prefix, path) else { return };
    // A folder is only "ignored" when it is itself ignored, not because of a file inside.
    if nested && status == FileStatus::Ignored {
        return;
    }
    let slot = children.entry(name).or_insert(status);
    if status.rank() > slot.rank() {
        *slot = status;
    }
}

/// Status of the folder's children, or None when it is not in a repository.
pub fn status(dir: &Path) -> Option<RepoStatus> {
    let repo = gix::discover(dir).ok()?;
    let prefix = prefix_of(&repo, dir)?;
    let mut out = RepoStatus { branch: branch_name(&repo), children: HashMap::new() };
    let platform = repo
        .status(gix::progress::Discard)
        .ok()?
        .untracked_files(gix::status::UntrackedFiles::Collapsed)
        .dirwalk_options(|o| o.emit_ignored(Some(gix::dir::walk::EmissionMode::CollapseDirectory)));
    for item in platform.into_iter(None).ok()?.flatten() {
        match item {
            gix::status::Item::TreeIndex(change) => note(&mut out.children, &prefix, &change.location().to_str_lossy(), FileStatus::Staged),
            gix::status::Item::IndexWorktree(i) => {
                use gix::status::index_worktree::iter::Summary as S;
                let path = i.rela_path().to_str_lossy().into_owned();
                if let gix::status::index_worktree::Item::DirectoryContents { entry, .. } = &i
                    && matches!(entry.status, gix::dir::entry::Status::Ignored(_))
                {
                    note(&mut out.children, &prefix, &path, FileStatus::Ignored);
                    continue;
                }
                let status = match i.summary() {
                    Some(S::Added | S::IntentToAdd) => FileStatus::Untracked,
                    Some(S::Removed) => FileStatus::Deleted,
                    Some(S::Conflict) => FileStatus::Conflict,
                    Some(S::Modified | S::TypeChange | S::Renamed | S::Copied) => FileStatus::Modified,
                    None => continue,
                };
                note(&mut out.children, &prefix, &path, status);
            }
        }
    }
    Some(out)
}

fn branch_name(repo: &gix::Repository) -> Option<String> {
    match repo.head_name().ok()? {
        Some(name) => Some(name.shorten().to_string()),
        None => repo.head_id().ok().map(|id| id.shorten_or_id().to_string()),
    }
}

type Entries = HashMap<String, gix::ObjectId>;

fn subtree_entries(commit: &gix::Commit<'_>, prefix: &str) -> Option<Entries> {
    let tree = commit.tree().ok()?;
    let tree = if prefix.is_empty() {
        tree
    } else {
        tree.lookup_entry_by_path(prefix).ok()??.object().ok()?.try_into_tree().ok()?
    };
    let mut out = HashMap::new();
    for e in tree.iter().flatten() {
        out.insert(e.filename().to_str_lossy().to_lowercase(), e.object_id());
    }
    Some(out)
}

/// The most recent commit that changed each direct child of `dir`, following
/// first parents. Keys are lower-case names.
pub fn last_commits(dir: &Path) -> Option<HashMap<String, LastCommit>> {
    let repo = gix::discover(dir).ok()?;
    let prefix = prefix_of(&repo, dir)?;
    let mut commit = repo.head_commit().ok()?;
    let mut current = subtree_entries(&commit, &prefix).unwrap_or_default();
    let mut out: HashMap<String, LastCommit> = HashMap::new();
    let total = current.len();
    for _ in 0..COMMIT_LIMIT {
        let parent = commit.parent_ids().next().and_then(|id| id.object().ok()).and_then(|o| o.try_into_commit().ok());
        let before = parent.as_ref().and_then(|p| subtree_entries(p, &prefix)).unwrap_or_default();
        let info = || {
            let time_ms = commit.time().map_or(0, |t| t.seconds * 1000);
            let author = commit.author().map(|a| a.name.to_string()).unwrap_or_default();
            LastCommit { time_ms, author }
        };
        for (name, id) in &current {
            if !out.contains_key(name) && before.get(name) != Some(id) {
                out.insert(name.clone(), info());
            }
        }
        match parent {
            Some(p) if out.len() < total => {
                commit = p;
                current = before;
            }
            _ => break,
        }
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    fn git(dir: &Path, args: &[&str]) {
        let ok = Command::new("git")
            .args(["-c", "user.name=Tester", "-c", "user.email=t@example.com"])
            .args(args)
            .current_dir(dir)
            .output()
            .expect("git is installed")
            .status
            .success();
        assert!(ok, "git {args:?}");
    }

    fn repo() -> tempfile::TempDir {
        let tmp = tempfile::tempdir().unwrap();
        let d = tmp.path();
        git(d, &["init", "-q", "-b", "main"]);
        std::fs::create_dir(d.join("src")).unwrap();
        std::fs::write(d.join("src/a.txt"), "1").unwrap();
        std::fs::write(d.join("keep.txt"), "k").unwrap();
        std::fs::write(d.join(".gitignore"), "build/\n").unwrap();
        git(d, &["add", "."]);
        git(d, &["commit", "-q", "-m", "first"]);
        tmp
    }

    #[test]
    fn reports_branch_and_per_child_status() {
        let tmp = repo();
        let d = tmp.path();
        std::fs::write(d.join("src/a.txt"), "changed").unwrap();
        std::fs::write(d.join("new.txt"), "n").unwrap();
        std::fs::create_dir(d.join("build")).unwrap();
        std::fs::write(d.join("build/out.o"), "o").unwrap();

        let s = status(d).unwrap();
        assert_eq!(s.branch.as_deref(), Some("main"));
        assert_eq!(s.children.get("src"), Some(&FileStatus::Modified), "{:?}", s.children);
        assert_eq!(s.children.get("new.txt"), Some(&FileStatus::Untracked));
        assert_eq!(s.children.get("build"), Some(&FileStatus::Ignored));
        assert_eq!(s.children.get("keep.txt"), None);

        let inner = status(&d.join("src")).unwrap();
        assert_eq!(inner.children.get("a.txt"), Some(&FileStatus::Modified));
    }

    #[test]
    fn staged_changes_are_reported() {
        let tmp = repo();
        let d = tmp.path();
        std::fs::write(d.join("keep.txt"), "changed").unwrap();
        git(d, &["add", "keep.txt"]);
        assert_eq!(status(d).unwrap().children.get("keep.txt"), Some(&FileStatus::Staged));
    }

    #[test]
    fn outside_a_repository_returns_none() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(status(tmp.path()).is_none());
    }

    #[test]
    fn finds_the_last_commit_touching_each_child() {
        let tmp = repo();
        let d = tmp.path();
        std::fs::write(d.join("keep.txt"), "2").unwrap();
        git(d, &["-c", "user.name=Other", "commit", "-q", "-am", "second"]);
        let c = last_commits(d).unwrap();
        assert_eq!(c["keep.txt"].author, "Other", "{c:?}");
        assert_eq!(c["src"].author, "Tester");
        assert!(c["src"].time_ms > 1_600_000_000_000);
        assert_eq!(last_commits(&d.join("src")).unwrap()["a.txt"].author, "Tester");
    }

    #[test]
    fn maps_paths_to_direct_children() {
        assert_eq!(child_of("", "a/b.txt"), Some(("a".into(), true)));
        assert_eq!(child_of("a", "a/b.txt"), Some(("b.txt".into(), false)));
        assert_eq!(child_of("a", "ab/c.txt"), None);
        assert_eq!(child_of("a/b", "A/B/c/d"), Some(("c".into(), true)));
        assert_eq!(child_of("", "dir/"), Some(("dir".into(), false)));
    }
}
