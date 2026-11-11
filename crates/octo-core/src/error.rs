use std::io;
use std::path::PathBuf;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("not found: {0}")]
    NotFound(PathBuf),
    #[error("access denied: {0}")]
    AccessDenied(PathBuf),
    #[error("not a directory: {0}")]
    NotADirectory(PathBuf),
    #[error("already exists: {0}")]
    AlreadyExists(PathBuf),
    #[error("invalid name: {0}")]
    InvalidName(String),
    #[error("cannot place a folder inside itself: {0}")]
    IntoItself(PathBuf),
    #[error("operation cancelled")]
    Cancelled,
    #[error("{path}: {source}")]
    Io {
        path: PathBuf,
        #[source]
        source: io::Error,
    },
    #[error("recycle bin: {0}")]
    Trash(String),
}

impl Error {
    /// Wraps an I/O error with the path it happened on, mapping common kinds
    /// to the dedicated variants so the UI can show a clear message.
    pub fn io(path: impl Into<PathBuf>, source: io::Error) -> Self {
        let path = path.into();
        match source.kind() {
            io::ErrorKind::NotFound => Self::NotFound(path),
            io::ErrorKind::PermissionDenied => Self::AccessDenied(path),
            io::ErrorKind::AlreadyExists => Self::AlreadyExists(path),
            io::ErrorKind::NotADirectory => Self::NotADirectory(path),
            _ => Self::Io { path, source },
        }
    }
}

pub type Result<T> = std::result::Result<T, Error>;
