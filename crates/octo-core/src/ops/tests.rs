use std::fs;
use std::path::{Path, PathBuf};

use super::*;

fn run_op(op: Operation, conflict: Conflict) -> (Report, Vec<Progress>) {
    let mut seen = Vec::new();
    let report = run(&op, conflict, &CancelToken::default(), &mut |p| seen.push(p.clone()));
    (report, seen)
}

fn tree(root: &Path) -> PathBuf {
    let src = root.join("src");
    fs::create_dir_all(src.join("nested/deeper")).unwrap();
    fs::write(src.join("a.txt"), b"alpha").unwrap();
    fs::write(src.join("nested/b.bin"), vec![7u8; 1000]).unwrap();
    fs::write(src.join("nested/deeper/c.md"), b"# c").unwrap();
    src
}

#[test]
fn copy_duplicates_a_tree_and_reports_totals() {
    let tmp = tempfile::tempdir().unwrap();
    let src = tree(tmp.path());
    let dest = tmp.path().join("dest");
    fs::create_dir(&dest).unwrap();

    let (report, progress) = run_op(Operation::Copy { sources: vec![src.clone()], dest: dest.clone() }, Conflict::KeepBoth);

    assert!(report.errors.is_empty(), "{:?}", report.errors);
    assert_eq!(report.created, vec![dest.join("src")]);
    assert_eq!(fs::read(dest.join("src/nested/b.bin")).unwrap().len(), 1000);
    assert_eq!(fs::read_to_string(dest.join("src/nested/deeper/c.md")).unwrap(), "# c");
    assert!(src.join("a.txt").exists(), "copy keeps the source");

    let last = progress.last().unwrap();
    assert_eq!(last.total_bytes, 5 + 1000 + 3);
    assert_eq!(last.done_bytes, last.total_bytes);
    assert_eq!(last.done_items, last.total_items);
}

#[test]
fn copy_into_same_folder_keeps_both() {
    let tmp = tempfile::tempdir().unwrap();
    let file = tmp.path().join("doc.txt");
    fs::write(&file, b"1").unwrap();

    let (report, _) = run_op(Operation::Copy { sources: vec![file.clone()], dest: tmp.path().into() }, Conflict::Overwrite);

    assert_eq!(report.created, vec![tmp.path().join("doc (2).txt")]);
    assert!(file.exists());
}

#[test]
fn copy_conflict_policies() {
    let tmp = tempfile::tempdir().unwrap();
    let a = tmp.path().join("a");
    let b = tmp.path().join("b");
    fs::create_dir_all(&a).unwrap();
    fs::create_dir_all(&b).unwrap();
    fs::write(a.join("f.txt"), b"new").unwrap();
    fs::write(b.join("f.txt"), b"old").unwrap();
    let src = vec![a.join("f.txt")];

    let (skip, _) = run_op(Operation::Copy { sources: src.clone(), dest: b.clone() }, Conflict::Skip);
    assert_eq!(skip.skipped, src);
    assert_eq!(fs::read_to_string(b.join("f.txt")).unwrap(), "old");

    let (keep, _) = run_op(Operation::Copy { sources: src.clone(), dest: b.clone() }, Conflict::KeepBoth);
    assert_eq!(keep.created, vec![b.join("f (2).txt")]);

    let (over, _) = run_op(Operation::Copy { sources: src, dest: b.clone() }, Conflict::Overwrite);
    assert!(over.errors.is_empty());
    assert_eq!(fs::read_to_string(b.join("f.txt")).unwrap(), "new");
}

#[test]
fn refuses_to_copy_or_move_a_folder_into_itself() {
    let tmp = tempfile::tempdir().unwrap();
    let src = tree(tmp.path());
    let inner = src.join("nested");

    for op in [
        Operation::Copy { sources: vec![src.clone()], dest: inner.clone() },
        Operation::Move { sources: vec![src.clone()], dest: inner.clone() },
    ] {
        let (report, _) = run_op(op, Conflict::KeepBoth);
        assert_eq!(report.errors.len(), 1);
        assert!(report.errors[0].message.contains("inside itself"));
    }
    assert!(src.join("a.txt").exists());
}

#[test]
fn move_within_volume_renames() {
    let tmp = tempfile::tempdir().unwrap();
    let src = tree(tmp.path());
    let dest = tmp.path().join("dest");
    fs::create_dir(&dest).unwrap();

    let (report, _) = run_op(Operation::Move { sources: vec![src.clone()], dest: dest.clone() }, Conflict::KeepBoth);

    assert!(report.errors.is_empty(), "{:?}", report.errors);
    assert!(!src.exists());
    assert!(dest.join("src/nested/deeper/c.md").exists());
}

#[test]
fn move_into_current_parent_is_skipped() {
    let tmp = tempfile::tempdir().unwrap();
    let file = tmp.path().join("x.txt");
    fs::write(&file, b"").unwrap();
    let (report, _) = run_op(Operation::Move { sources: vec![file.clone()], dest: tmp.path().into() }, Conflict::KeepBoth);
    assert_eq!(report.skipped, vec![file.clone()]);
    assert!(file.exists());
}

#[test]
fn move_onto_existing_folder_merges_when_overwriting() {
    let tmp = tempfile::tempdir().unwrap();
    let src = tree(tmp.path());
    let dest = tmp.path().join("dest");
    fs::create_dir_all(dest.join("src")).unwrap();
    fs::write(dest.join("src/keep.txt"), b"k").unwrap();

    let (report, _) = run_op(Operation::Move { sources: vec![src.clone()], dest: dest.clone() }, Conflict::Overwrite);

    assert!(report.errors.is_empty(), "{:?}", report.errors);
    assert!(!src.exists());
    assert!(dest.join("src/keep.txt").exists());
    assert!(dest.join("src/a.txt").exists());
}

#[test]
fn permanent_delete_removes_trees_and_readonly_files() {
    let tmp = tempfile::tempdir().unwrap();
    let src = tree(tmp.path());
    let ro = tmp.path().join("ro.txt");
    fs::write(&ro, b"").unwrap();
    let mut perms = fs::metadata(&ro).unwrap().permissions();
    perms.set_readonly(true);
    fs::set_permissions(&ro, perms).unwrap();

    let (report, _) = run_op(Operation::Delete { paths: vec![src.clone(), ro.clone()], permanent: true }, Conflict::KeepBoth);

    assert!(report.errors.is_empty(), "{:?}", report.errors);
    assert!(!src.exists() && !ro.exists());
}

#[test]
fn delete_reports_missing_items() {
    let tmp = tempfile::tempdir().unwrap();
    let ghost = tmp.path().join("ghost");
    let (report, _) = run_op(Operation::Delete { paths: vec![ghost.clone()], permanent: true }, Conflict::KeepBoth);
    assert_eq!(report.errors.len(), 1);
    assert_eq!(report.errors[0].path, ghost);
}

#[test]
fn cancelled_copy_stops_and_leaves_no_partial_file() {
    let tmp = tempfile::tempdir().unwrap();
    let big = tmp.path().join("big.bin");
    fs::write(&big, vec![1u8; 9 * 1024 * 1024]).unwrap(); // above the chunked threshold
    let dest = tmp.path().join("out");
    fs::create_dir(&dest).unwrap();

    let cancel = CancelToken::default();
    let trigger = cancel.clone();
    let op = Operation::Copy { sources: vec![big], dest: dest.clone() };
    let report = run(&op, Conflict::KeepBoth, &cancel, &mut |p| {
        if p.done_bytes > 0 {
            trigger.cancel();
        }
    });

    assert!(report.cancelled);
    assert!(!dest.join("big.bin").exists());
}

#[test]
fn cancelled_overwrite_keeps_the_existing_file() {
    let tmp = tempfile::tempdir().unwrap();
    let a = tmp.path().join("a");
    let b = tmp.path().join("b");
    fs::create_dir_all(&a).unwrap();
    fs::create_dir_all(&b).unwrap();
    fs::write(a.join("big.bin"), vec![1u8; 9 * 1024 * 1024]).unwrap();
    fs::write(b.join("big.bin"), b"precious").unwrap();

    let cancel = CancelToken::default();
    let trigger = cancel.clone();
    let op = Operation::Copy { sources: vec![a.join("big.bin")], dest: b.clone() };
    let report = run(&op, Conflict::Overwrite, &cancel, &mut |p| {
        if p.done_bytes > 0 {
            trigger.cancel();
        }
    });

    assert!(report.cancelled);
    assert_eq!(fs::read(b.join("big.bin")).unwrap(), b"precious");
    assert_eq!(fs::read_dir(&b).unwrap().count(), 1, "no partial temp file left behind");
}

#[test]
fn overwrite_of_large_file_replaces_content() {
    let tmp = tempfile::tempdir().unwrap();
    let a = tmp.path().join("a");
    let b = tmp.path().join("b");
    fs::create_dir_all(&a).unwrap();
    fs::create_dir_all(&b).unwrap();
    fs::write(a.join("big.bin"), vec![2u8; 9 * 1024 * 1024]).unwrap();
    fs::write(b.join("big.bin"), b"old").unwrap();

    let (report, _) = run_op(Operation::Copy { sources: vec![a.join("big.bin")], dest: b.clone() }, Conflict::Overwrite);

    assert!(report.errors.is_empty(), "{:?}", report.errors);
    assert_eq!(fs::metadata(b.join("big.bin")).unwrap().len(), 9 * 1024 * 1024);
    assert_eq!(fs::read_dir(&b).unwrap().count(), 1);
}

#[test]
fn overwrite_move_replaces_file_atomically() {
    let tmp = tempfile::tempdir().unwrap();
    let a = tmp.path().join("a");
    let b = tmp.path().join("b");
    fs::create_dir_all(&a).unwrap();
    fs::create_dir_all(&b).unwrap();
    fs::write(a.join("x.txt"), b"new").unwrap();
    fs::write(b.join("x.txt"), b"old").unwrap();

    let (report, _) = run_op(Operation::Move { sources: vec![a.join("x.txt")], dest: b.clone() }, Conflict::Overwrite);

    assert!(report.errors.is_empty(), "{:?}", report.errors);
    assert!(!a.join("x.txt").exists());
    assert_eq!(fs::read_to_string(b.join("x.txt")).unwrap(), "new");
}

#[cfg(windows)]
#[test]
fn delete_keeps_going_past_a_locked_file_and_keeps_its_readonly_flag() {
    use std::os::windows::fs::OpenOptionsExt;
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().join("tree");
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("free.txt"), b"").unwrap();
    let locked = dir.join("locked.txt");
    fs::write(&locked, b"").unwrap();
    let ro = dir.join("ro-sibling.txt");
    fs::write(&ro, b"").unwrap();
    let mut perms = fs::metadata(&ro).unwrap().permissions();
    perms.set_readonly(true);
    fs::set_permissions(&ro, perms).unwrap();
    // Hold the file open without FILE_SHARE_DELETE so it can't be removed.
    let _guard = fs::OpenOptions::new().read(true).share_mode(0).open(&locked).unwrap();

    let (report, _) = run_op(Operation::Delete { paths: vec![dir.clone()], permanent: true }, Conflict::KeepBoth);

    assert_eq!(report.errors.len(), 1, "{:?}", report.errors);
    assert_eq!(report.errors[0].path, locked);
    assert!(!dir.join("free.txt").exists(), "siblings are still deleted");
    assert!(!ro.exists(), "a read-only sibling is deleted via its own retry");
    assert!(locked.exists());
}

#[test]
fn rename_validates_and_allows_case_change() {
    let tmp = tempfile::tempdir().unwrap();
    let f = tmp.path().join("readme");
    fs::write(&f, b"").unwrap();
    fs::write(tmp.path().join("other"), b"").unwrap();

    assert!(matches!(rename(&f, "bad:name"), Err(crate::Error::InvalidName(_))));
    assert!(matches!(rename(&f, "other"), Err(crate::Error::AlreadyExists(_))));
    let up = rename(&f, "README").unwrap();
    assert_eq!(up.file_name().unwrap(), "README");
}

#[test]
fn create_folder_numbers_duplicates() {
    let tmp = tempfile::tempdir().unwrap();
    assert_eq!(create_folder(tmp.path(), "New folder").unwrap(), tmp.path().join("New folder"));
    assert_eq!(create_folder(tmp.path(), "New folder").unwrap(), tmp.path().join("New folder (2)"));
}
