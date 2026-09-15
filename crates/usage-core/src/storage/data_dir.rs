//! The desktop-only data directory.
//!
//! The Rust runtime keeps its state in a **separate** directory from the legacy
//! Node dashboard:
//!
//! ```text
//! ~/Library/Application Support/agents-usage/desktop/
//!   usage-desktop.sqlite3   normalized snapshots, health, settings, balance samples
//!   service.json            private discovery information (loopback address, protocol
//!                           version, instance id, session token)
//! ```
//!
//! The legacy `~/Library/Application Support/agents-usage/usage.sqlite3` is never
//! opened, migrated or written by this runtime. `DataDirectory::assert_isolated`
//! is the guard that keeps a mistyped path from breaking that promise.
//!
//! `service.json` doubles as the exclusivity lock: the owning service holds an
//! advisory lock on the file for its whole lifetime, so a second launch can tell
//! an owned data directory from a leftover file without guessing from a PID or a
//! port number alone.

use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};

use fs2::FileExt;
use serde::{Deserialize, Serialize};

use crate::contracts::IsoTimestamp;

/// Wire protocol version of the discovery handshake.
///
/// A service whose version differs is not reused: the desktop reports a
/// recoverable error instead of talking to an unknown protocol.
pub const PROTOCOL_VERSION: u32 = 1;

/// Directory name inside the application support folder.
pub const DESKTOP_SUBDIRECTORY: &str = "desktop";
/// Database file name of the desktop runtime.
pub const DESKTOP_DATABASE_FILE: &str = "usage-desktop.sqlite3";
/// Discovery file name.
pub const DISCOVERY_FILE: &str = "service.json";
/// Database file name owned by the legacy Node dashboard.
pub const LEGACY_DATABASE_FILE: &str = "usage.sqlite3";

#[derive(Debug, thiserror::Error)]
pub enum StorageError {
    #[error("cannot create the data directory {path}: {source}")]
    Directory {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("cannot access {path}: {source}")]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error(
        "refusing to use {path}: the legacy database must not be opened by the desktop runtime"
    )]
    LegacyDatabase { path: PathBuf },
    #[error("another service instance already owns {path}")]
    AlreadyOwned { path: PathBuf },
    #[error("the discovery file {path} is unreadable: {source}")]
    Discovery {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("the discovery file {path} is not valid JSON: {source}")]
    DiscoveryFormat {
        path: PathBuf,
        #[source]
        source: serde_json::Error,
    },
    #[error("database error: {0}")]
    Database(#[from] rusqlite::Error),
    #[error("stored record is malformed: {0}")]
    Record(String),
}

/// Private discovery information written by the owning service.
///
/// The session token and instance id are high-entropy values used by the
/// loopback API; they never appear in a web page URL, a log line or a persisted
/// snapshot.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceDiscovery {
    pub protocol_version: u32,
    pub instance_id: String,
    pub session_token: String,
    pub host: String,
    pub port: u16,
    pub pid: u32,
    pub started_at: IsoTimestamp,
    /// True when the desktop host owns this service and must stop it on exit.
    pub owned_by_desktop: bool,
}

impl ServiceDiscovery {
    /// The loopback origin the desktop and the companion web page talk to.
    pub fn origin(&self) -> String {
        let host = if self.host.contains(':') {
            format!("[{}]", self.host)
        } else {
            self.host.clone()
        };
        format!("http://{host}:{}", self.port)
    }

    /// True when this discovery entry describes the service this process runs.
    pub fn is_owned_by(&self, instance_id: &str) -> bool {
        self.instance_id == instance_id
    }

    /// Whether the recorded process is still alive.
    ///
    /// Used only to describe a stale file to the user; identity is always the
    /// instance id plus the advisory lock, never the PID alone.
    pub fn process_is_alive(&self) -> bool {
        if self.pid == 0 {
            return false;
        }
        // SAFETY: `kill` with signal 0 only performs an existence/permission
        // check and cannot deliver a signal.
        let result = unsafe { libc::kill(self.pid as libc::pid_t, 0) };
        result == 0
    }
}

/// Handle holding the data directory's exclusivity lock.
#[derive(Debug)]
pub struct DataDirectory {
    root: PathBuf,
    database: PathBuf,
    lock_path: PathBuf,
    lock_file: Option<File>,
}

impl DataDirectory {
    /// Default location: `~/Library/Application Support/agents-usage/desktop`.
    pub fn default_root() -> PathBuf {
        let home = std::env::var_os("HOME").map_or_else(|| PathBuf::from("."), PathBuf::from);
        home.join("Library")
            .join("Application Support")
            .join("agents-usage")
            .join(DESKTOP_SUBDIRECTORY)
    }

    /// Create (or reopen) a data directory at `root` and make it private.
    pub fn open(root: impl Into<PathBuf>) -> Result<Self, StorageError> {
        let root = root.into();
        create_private_dir(&root)?;
        let database = root.join(DESKTOP_DATABASE_FILE);
        if database.file_name().and_then(|name| name.to_str()) == Some(LEGACY_DATABASE_FILE) {
            return Err(StorageError::LegacyDatabase { path: database });
        }
        let lock_path = root.join(DISCOVERY_FILE);
        Ok(Self {
            root,
            database,
            lock_path,
            lock_file: None,
        })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn database_path(&self) -> &Path {
        &self.database
    }

    pub fn discovery_path(&self) -> &Path {
        &self.lock_path
    }

    /// Refuse any path that would touch the legacy dashboard database.
    pub fn assert_isolated(&self) -> Result<(), StorageError> {
        let database_name = self.database.file_name().and_then(|name| name.to_str());
        if database_name == Some(LEGACY_DATABASE_FILE) {
            return Err(StorageError::LegacyDatabase {
                path: self.database.clone(),
            });
        }
        if self
            .database
            .components()
            .any(|component| component.as_os_str() == LEGACY_DATABASE_FILE)
        {
            return Err(StorageError::LegacyDatabase {
                path: self.database.clone(),
            });
        }
        Ok(())
    }

    /// Take the exclusivity lock.
    ///
    /// Returns `Ok(true)` when this process now owns the directory. `Ok(false)`
    /// means another live owner exists and the caller must connect to it (or
    /// report a recoverable error) instead of opening the database.
    pub fn try_acquire(&mut self) -> Result<bool, StorageError> {
        self.assert_isolated()?;
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .open(&self.lock_path)
            .map_err(|source| StorageError::Io {
                path: self.lock_path.clone(),
                source,
            })?;
        set_private_permissions(&self.lock_path)?;
        match file.try_lock_exclusive() {
            Ok(()) => {
                self.lock_file = Some(file);
                Ok(true)
            }
            Err(_) => Ok(false),
        }
    }

    /// True while this process holds the lock.
    pub fn is_owner(&self) -> bool {
        self.lock_file.is_some()
    }

    /// Publish this instance's discovery information into the locked file.
    pub fn write_discovery(&mut self, discovery: &ServiceDiscovery) -> Result<(), StorageError> {
        let file = self.lock_file.as_mut().ok_or(StorageError::AlreadyOwned {
            path: self.lock_path.clone(),
        })?;
        let payload = serde_json::to_vec_pretty(discovery).map_err(|source| {
            StorageError::Record(format!("cannot encode discovery information: {source}"))
        })?;
        file.set_len(0).map_err(|source| StorageError::Io {
            path: self.lock_path.clone(),
            source,
        })?;
        file.seek(SeekFrom::Start(0))
            .map_err(|source| StorageError::Io {
                path: self.lock_path.clone(),
                source,
            })?;
        file.write_all(&payload)
            .map_err(|source| StorageError::Io {
                path: self.lock_path.clone(),
                source,
            })?;
        file.write_all(b"\n").map_err(|source| StorageError::Io {
            path: self.lock_path.clone(),
            source,
        })?;
        file.flush().map_err(|source| StorageError::Io {
            path: self.lock_path.clone(),
            source,
        })?;
        file.sync_all().map_err(|source| StorageError::Io {
            path: self.lock_path.clone(),
            source,
        })?;
        Ok(())
    }

    /// Read a discovery file without taking ownership.
    ///
    /// Returns `Ok(None)` when the file does not exist yet.
    pub fn read_discovery(&self) -> Result<Option<ServiceDiscovery>, StorageError> {
        let mut file = match File::open(&self.lock_path) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(source) => {
                return Err(StorageError::Discovery {
                    path: self.lock_path.clone(),
                    source,
                })
            }
        };
        let mut contents = String::new();
        file.read_to_string(&mut contents)
            .map_err(|source| StorageError::Discovery {
                path: self.lock_path.clone(),
                source,
            })?;
        if contents.trim().is_empty() {
            return Ok(None);
        }
        let discovery =
            serde_json::from_str(&contents).map_err(|source| StorageError::DiscoveryFormat {
                path: self.lock_path.clone(),
                source,
            })?;
        Ok(Some(discovery))
    }

    /// Release the lock on shutdown.
    ///
    /// A crash leaves the file behind, which is why every consumer also checks
    /// the instance id and protocol version instead of trusting the file alone.
    pub fn release(&mut self) {
        if let Some(file) = self.lock_file.take() {
            let _ = FileExt::unlock(&file);
        }
    }
}

impl Drop for DataDirectory {
    fn drop(&mut self) {
        self.release();
    }
}

fn create_private_dir(path: &Path) -> Result<(), StorageError> {
    fs::create_dir_all(path).map_err(|source| StorageError::Directory {
        path: path.to_path_buf(),
        source,
    })?;
    set_private_permissions(path)
}

fn set_private_permissions(path: &Path) -> Result<(), StorageError> {
    let metadata = fs::metadata(path).map_err(|source| StorageError::Io {
        path: path.to_path_buf(),
        source,
    })?;
    let desired = if metadata.is_dir() { 0o700 } else { 0o600 };
    if metadata.permissions().mode() & 0o777 != desired {
        fs::set_permissions(path, fs::Permissions::from_mode(desired)).map_err(|source| {
            StorageError::Io {
                path: path.to_path_buf(),
                source,
            }
        })?;
    }
    Ok(())
}

/// Generate a high-entropy identifier for instances and session tokens.
pub fn random_token(bytes: usize) -> String {
    use base64::Engine;
    use rand::RngCore;

    let mut buffer = vec![0_u8; bytes];
    rand::rng().fill_bytes(&mut buffer);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(buffer)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temporary_root(label: &str) -> PathBuf {
        let unique = random_token(6);
        std::env::temp_dir().join(format!("agents-usage-test-{label}-{unique}"))
    }

    fn discovery(instance: &str) -> ServiceDiscovery {
        ServiceDiscovery {
            protocol_version: PROTOCOL_VERSION,
            instance_id: instance.to_string(),
            session_token: random_token(32),
            host: "127.0.0.1".to_string(),
            port: 47_160,
            pid: std::process::id(),
            started_at: IsoTimestamp::now(),
            owned_by_desktop: true,
        }
    }

    #[test]
    fn creates_a_private_directory_and_database_path() {
        let root = temporary_root("private");
        let directory = DataDirectory::open(&root).expect("directory must open");

        let metadata = fs::metadata(directory.root()).expect("metadata");
        assert_eq!(metadata.permissions().mode() & 0o777, 0o700);
        assert_eq!(
            directory
                .database_path()
                .file_name()
                .and_then(|name| name.to_str()),
            Some(DESKTOP_DATABASE_FILE)
        );
        assert!(directory.assert_isolated().is_ok());
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn refuses_the_legacy_database_name() {
        let root = temporary_root("legacy");
        let mut directory = DataDirectory::open(&root).expect("directory must open");
        directory.database = root.join(LEGACY_DATABASE_FILE);
        assert!(matches!(
            directory.assert_isolated(),
            Err(StorageError::LegacyDatabase { .. })
        ));
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn only_one_owner_at_a_time_and_the_lock_is_released_on_drop() {
        let root = temporary_root("lock");
        let mut first = DataDirectory::open(&root).expect("directory must open");
        assert!(first.try_acquire().expect("first lock"));
        assert!(first.is_owner());
        first
            .write_discovery(&discovery("instance-a"))
            .expect("write");

        let mut second = DataDirectory::open(&root).expect("directory must open");
        assert!(!second.try_acquire().expect("second lock attempt"));
        let published = second
            .read_discovery()
            .expect("read")
            .expect("discovery must exist");
        assert_eq!(published.instance_id, "instance-a");
        assert_eq!(published.origin(), "http://127.0.0.1:47160");
        assert!(published.process_is_alive());
        assert!(published.is_owned_by("instance-a"));
        assert!(!published.is_owned_by("instance-b"));

        drop(first);
        let mut third = DataDirectory::open(&root).expect("directory must open");
        assert!(third.try_acquire().expect("lock after release"));
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn discovery_file_is_private_and_parses_back() {
        let root = temporary_root("discovery");
        let mut directory = DataDirectory::open(&root).expect("directory must open");
        assert!(directory.try_acquire().expect("lock"));
        let expected = discovery("instance-c");
        directory.write_discovery(&expected).expect("write");

        let mode = fs::metadata(directory.discovery_path())
            .expect("metadata")
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o600);
        let read = directory.read_discovery().expect("read").expect("present");
        assert_eq!(read, expected);

        // A truncated or foreign file is reported, never treated as a service.
        fs::write(directory.discovery_path(), b"{ not json").expect("write garbage");
        assert!(matches!(
            directory.read_discovery(),
            Err(StorageError::DiscoveryFormat { .. })
        ));
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn missing_discovery_file_is_not_an_error() {
        let root = temporary_root("missing");
        let directory = DataDirectory::open(&root).expect("directory must open");
        assert!(directory.read_discovery().expect("read").is_none());
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn random_tokens_are_unique_and_url_safe() {
        let first = random_token(16);
        let second = random_token(16);
        assert_ne!(first, second);
        assert!(first
            .chars()
            .all(|character| character.is_ascii_alphanumeric()
                || character == '-'
                || character == '_'));
    }
}
