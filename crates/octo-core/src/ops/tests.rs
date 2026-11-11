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

#[cfg(windows)]
#[test]
fn junctions_are_copied_as_links_not_followed() {
    let tmp = tempfile::tempdir().unwrap();
    let real = tmp.path().join("real");
    fs::create_dir(&real).unwrap();
    fs::write(real.join("big.bin"), vec![1u8; 2048]).unwrap();
    let src = tmp.path().join("src");
    fs::create_dir(&src).unwrap();
    let link = create_link(LinkKind::Junction, &real, &src).unwrap();
    assert!(is_junction(&link));

    let dest = tmp.path().join("dest");
    fs::create_dir(&dest).unwrap();
    let (report, _) = run_op(Operation::Copy { sources: vec![src.clone()], dest: dest.clone() }, Conflict::KeepBoth);
    assert!(report.errors.is_empty(), "{:?}", report.errors);
    let copied = dest.join("src").join("real");
    assert!(is_junction(&copied), "the copy must be a junction, not a folder of copied files");
    assert_eq!(fs::read_link(&copied).unwrap(), fs::read_link(&link).unwrap());
}

/// Paths past Windows' classic 260-character limit must copy, move and delete like any other.
#[test]
fn long_paths_copy_move_and_delete() {
    let tmp = tempfile::tempdir().unwrap();
    let src = tmp.path().join("long");
    let mut deep = src.clone();
    for i in 0..12 {
        deep = deep.join(format!("a-rather-long-folder-name-{i:02}"));
    }
    fs::create_dir_all(&deep).unwrap();
    let file = deep.join("deep file with a long name.txt");
    fs::write(&file, b"far down").unwrap();
    assert!(file.as_os_str().len() > 300, "test path is only {} characters", file.as_os_str().len());

    let copy_dest = tmp.path().join("copy");
    fs::create_dir(&copy_dest).unwrap();
    let (report, _) = run_op(Operation::Copy { sources: vec![src.clone()], dest: copy_dest.clone() }, Conflict::KeepBoth);
    assert!(report.errors.is_empty(), "copy: {:?}", report.errors);
    let copied = copy_dest.join(file.strip_prefix(tmp.path()).unwrap());
    assert_eq!(fs::read(&copied).unwrap(), b"far down");

    let move_dest = tmp.path().join("moved");
    fs::create_dir(&move_dest).unwrap();
    let (report, _) = run_op(Operation::Move { sources: vec![copy_dest.join("long")], dest: move_dest.clone() }, Conflict::KeepBoth);
    assert!(report.errors.is_empty(), "move: {:?}", report.errors);
    assert!(move_dest.join(file.strip_prefix(tmp.path()).unwrap()).exists());

    let (report, _) = run_op(Operation::Delete { paths: vec![move_dest.join("long")], permanent: true }, Conflict::KeepBoth);
    assert!(report.errors.is_empty(), "delete: {:?}", report.errors);
    assert!(!move_dest.join("long").exists());
}

#[test]
fn link_kinds_refuse_the_wrong_target() {
    let tmp = tempfile::tempdir().unwrap();
    let file = tmp.path().join("f.txt");
    fs::write(&file, b"x").unwrap();
    assert!(create_link(LinkKind::Junction, &file, tmp.path()).is_err());
    assert!(create_link(LinkKind::Hard, tmp.path(), tmp.path()).is_err());
    let hard = create_link(LinkKind::Hard, &file, tmp.path()).unwrap();
    assert_eq!(hard.file_name().unwrap(), "f (2).txt");
    assert_eq!(fs::read(hard).unwrap(), b"x");
}

#[test]
fn find_conflicts_reports_taken_names_only() {
    let tmp = tempfile::tempdir().unwrap();
    let src = tmp.path().join("src");
    let dest = tmp.path().join("dest");
    fs::create_dir_all(src.join("folder")).unwrap();
    fs::create_dir_all(dest.join("folder")).unwrap();
    fs::write(src.join("same.txt"), b"new content").unwrap();
    fs::write(dest.join("same.txt"), b"old").unwrap();
    fs::write(src.join("free.txt"), b"x").unwrap();

    let sources = vec![src.join("same.txt"), src.join("free.txt"), src.join("folder")];
    let found = find_conflicts(&sources, &dest);
    assert_eq!(found.len(), 2, "{found:?}");
    let file = found.iter().find(|c| !c.source.is_dir).unwrap();
    assert_eq!((file.source.size, file.target.size), (11, 3));
    assert_eq!(file.target.path, dest.join("same.txt"));
    assert!(file.source.modified_ms > 0);
    assert!(found.iter().any(|c| c.source.is_dir && c.target.is_dir));

    // Pasting into the folder the items came from is not a conflict.
    assert!(find_conflicts(&sources, &src).is_empty());
}

#[test]
fn create_file_numbers_duplicates_and_copies_templates() {
    let tmp = tempfile::tempdir().unwrap();
    let a = create_file(tmp.path(), "New text document.txt", None).unwrap();
    assert_eq!(a, tmp.path().join("New text document.txt"));
    assert_eq!(fs::read(&a).unwrap(), b"");
    let b = create_file(tmp.path(), "New text document.txt", None).unwrap();
    assert_eq!(b, tmp.path().join("New text document (2).txt"));

    let tpl = tmp.path().join("template.md");
    fs::write(&tpl, b"# Title").unwrap();
    let c = create_file(tmp.path(), "Notes.md", Some(&tpl)).unwrap();
    assert_eq!(fs::read(c).unwrap(), b"# Title");

    assert!(matches!(create_file(tmp.path(), "bad|name", None), Err(crate::Error::InvalidName(_))));
    assert!(create_file(tmp.path(), "x.txt", Some(&tmp.path().join("missing"))).is_err());
    assert!(!tmp.path().join("x.txt").exists(), "a failed template read must not leave a file behind");
}

#[test]
fn verify_passes_for_a_good_copy_and_records_pairs() {
    let tmp = tempfile::tempdir().unwrap();
    let f = tmp.path().join("a.bin");
    fs::write(&f, vec![9u8; 4096]).unwrap();
    let dest = tmp.path().join("d");
    fs::create_dir(&dest).unwrap();
    let opts = Options { verify: true, ..Options::default() };
    let r = run_with(&Operation::Copy { sources: vec![f.clone()], dest: dest.clone() }, &opts, &CancelToken::default(), &mut |_| {});
    assert!(r.errors.is_empty(), "{:?}", r.errors);
    assert_eq!(r.pairs, vec![(f, dest.join("a.bin"))]);
}

#[test]
fn speed_limit_slows_the_transfer() {
    let tmp = tempfile::tempdir().unwrap();
    let f = tmp.path().join("a.bin");
    fs::write(&f, vec![1u8; 200 * 1024]).unwrap();
    let dest = tmp.path().join("d");
    fs::create_dir(&dest).unwrap();
    let opts = Options { limit_bps: Some(1024 * 1024), ..Options::default() }; // about 190 ms
    let t = std::time::Instant::now();
    let r = run_with(&Operation::Copy { sources: vec![f], dest: dest.clone() }, &opts, &CancelToken::default(), &mut |_| {});
    assert!(r.errors.is_empty(), "{:?}", r.errors);
    assert!(t.elapsed() >= std::time::Duration::from_millis(150), "{:?}", t.elapsed());
    assert_eq!(fs::metadata(dest.join("a.bin")).unwrap().len(), 200 * 1024);
}

#[test]
fn pause_holds_the_operation_until_resumed() {
    let tmp = tempfile::tempdir().unwrap();
    let f = tmp.path().join("a.txt");
    fs::write(&f, b"x").unwrap();
    let dest = tmp.path().join("d");
    fs::create_dir(&dest).unwrap();
    let token = CancelToken::default();
    token.set_paused(true);
    let resume = token.clone();
    let waker = std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(120));
        resume.set_paused(false);
    });
    let t = std::time::Instant::now();
    run(&Operation::Copy { sources: vec![f], dest: dest.clone() }, Conflict::KeepBoth, &token, &mut |_| {});
    waker.join().unwrap();
    assert!(t.elapsed() >= std::time::Duration::from_millis(100));
    assert!(dest.join("a.txt").exists());
}

#[test]
fn relocate_restores_exact_names_and_refuses_to_overwrite() {
    let tmp = tempfile::tempdir().unwrap();
    let a = tmp.path().join("report (2).pdf");
    let b = tmp.path().join("sub/report.pdf");
    fs::write(&a, b"1").unwrap();
    let (r, _) = run_op(Operation::Relocate { pairs: vec![(a.clone(), b.clone())] }, Conflict::KeepBoth);
    assert!(r.errors.is_empty(), "{:?}", r.errors);
    assert!(b.exists() && !a.exists());

    fs::write(&a, b"2").unwrap();
    let (r, _) = run_op(Operation::Relocate { pairs: vec![(a.clone(), b.clone())] }, Conflict::KeepBoth);
    assert_eq!(r.errors.len(), 1);
    assert_eq!(fs::read(&b).unwrap(), b"1", "the existing file is untouched");
}

#[test]
fn batch_rename_swaps_and_is_all_or_nothing() {
    let tmp = tempfile::tempdir().unwrap();
    let a = tmp.path().join("a.txt");
    let b = tmp.path().join("b.txt");
    fs::write(&a, b"A").unwrap();
    fs::write(&b, b"B").unwrap();
    let done = batch_rename(&[(a.clone(), "b.txt".into()), (b.clone(), "a.txt".into())]).unwrap();
    assert_eq!(done.len(), 2);
    assert_eq!(fs::read(&a).unwrap(), b"B");
    assert_eq!(fs::read(&b).unwrap(), b"A");

    let c = tmp.path().join("c.txt");
    fs::write(&c, b"C").unwrap();
    assert!(matches!(batch_rename(&[(a.clone(), "c.txt".into())]), Err(crate::Error::AlreadyExists(_))));
    assert!(matches!(batch_rename(&[(a.clone(), "x.txt".into()), (b.clone(), "X.TXT".into())]), Err(crate::Error::AlreadyExists(_))));
    assert!(matches!(batch_rename(&[(a.clone(), "bad:name".into())]), Err(crate::Error::InvalidName(_))));
    assert!(a.exists() && b.exists() && c.exists(), "nothing moved after a refused batch");
}

#[test]
fn remove_empty_dir_keeps_folders_with_content() {
    let tmp = tempfile::tempdir().unwrap();
    let d = tmp.path().join("d");
    fs::create_dir(&d).unwrap();
    fs::write(d.join("f"), b"").unwrap();
    assert!(remove_empty_dir(&d).is_err());
    fs::remove_file(d.join("f")).unwrap();
    remove_empty_dir(&d).unwrap();
    assert!(!d.exists());
}
