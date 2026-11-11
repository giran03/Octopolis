use std::path::{Component, Path};

fn components_eq(a: Component<'_>, b: Component<'_>) -> bool {
    // NTFS is case-insensitive for the purposes the UI cares about here.
    a.as_os_str().to_string_lossy().to_lowercase() == b.as_os_str().to_string_lossy().to_lowercase()
}

/// True when `child` is `parent` itself or lies anywhere beneath it.
pub fn is_within(child: &Path, parent: &Path) -> bool {
    let mut c = child.components().filter(|x| !matches!(x, Component::CurDir));
    for p in parent.components().filter(|x| !matches!(x, Component::CurDir)) {
        match c.next() {
            Some(x) if components_eq(x, p) => {}
            _ => return false,
        }
    }
    true
}

/// True when both paths live on the same drive or share, so a move can be a
/// cheap rename instead of copy + delete.
pub fn same_volume(a: &Path, b: &Path) -> bool {
    match (a.components().next(), b.components().next()) {
        (Some(x), Some(y)) => components_eq(x, y),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn within_checks_ancestry_case_insensitively() {
        assert!(is_within(Path::new(r"C:\a\b\c"), Path::new(r"C:\a")));
        assert!(is_within(Path::new(r"C:\A\b"), Path::new(r"c:\a\B")));
        assert!(is_within(Path::new(r"C:\a"), Path::new(r"C:\a")));
        assert!(!is_within(Path::new(r"C:\ab"), Path::new(r"C:\a")));
        assert!(!is_within(Path::new(r"C:\a"), Path::new(r"C:\a\b")));
        assert!(!is_within(Path::new(r"D:\a\b"), Path::new(r"C:\a")));
    }

    #[cfg(windows)]
    #[test]
    fn same_volume_compares_drive_prefix() {
        assert!(same_volume(Path::new(r"C:\x"), Path::new(r"c:\y\z")));
        assert!(!same_volume(Path::new(r"C:\x"), Path::new(r"D:\x")));
        assert!(same_volume(Path::new(r"\\srv\share\a"), Path::new(r"\\srv\share\b")));
    }
}
