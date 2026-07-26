use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use keyring::v1::{Entry, Error as KeyringError};
use serde::{de::DeserializeOwned, Serialize};

use crate::{EdgeError, Result};

const KEYRING_SERVICE: &str = "dev.workbuddy.buddy.edge";

pub trait SecretStore: Clone + Send + Sync + 'static {
    fn get(&self, name: &str) -> Result<Option<Vec<u8>>>;
    fn set(&self, name: &str, secret: &[u8]) -> Result<()>;
    fn delete(&self, name: &str) -> Result<()>;
}

#[derive(Clone, Default)]
pub struct KeyringSecretStore;

impl SecretStore for KeyringSecretStore {
    fn get(&self, name: &str) -> Result<Option<Vec<u8>>> {
        match Entry::new(KEYRING_SERVICE, name)?.get_secret() {
            Ok(secret) => Ok(Some(secret)),
            Err(KeyringError::NoEntry) => Ok(None),
            Err(error) => Err(error.into()),
        }
    }

    fn set(&self, name: &str, secret: &[u8]) -> Result<()> {
        Entry::new(KEYRING_SERVICE, name)?.set_secret(secret)?;
        Ok(())
    }

    fn delete(&self, name: &str) -> Result<()> {
        match Entry::new(KEYRING_SERVICE, name)?.delete_credential() {
            Ok(()) | Err(KeyringError::NoEntry) => Ok(()),
            Err(error) => Err(error.into()),
        }
    }
}

#[derive(Clone, Debug)]
pub struct JsonFileStore {
    root: PathBuf,
}

impl JsonFileStore {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    pub fn read<T: DeserializeOwned>(&self, name: &str) -> Result<Option<T>> {
        let path = self.path(name)?;
        match fs::read(path) {
            Ok(bytes) => Ok(Some(serde_json::from_slice(&bytes)?)),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error.into()),
        }
    }

    pub fn write<T: Serialize>(&self, name: &str, value: &T) -> Result<()> {
        fs::create_dir_all(&self.root)?;
        restrict_directory(&self.root)?;
        let path = self.path(name)?;
        let temporary = path.with_extension("tmp");
        let bytes = serde_json::to_vec(value)?;
        fs::write(&temporary, bytes)?;
        restrict_file(&temporary)?;
        fs::rename(&temporary, &path)?;
        restrict_file(&path)?;
        Ok(())
    }

    pub fn delete(&self, name: &str) -> Result<()> {
        let path = self.path(name)?;
        match fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error.into()),
        }
    }

    fn path(&self, name: &str) -> Result<PathBuf> {
        if name.is_empty()
            || name.contains('/')
            || name.contains('\\')
            || name == "."
            || name == ".."
        {
            return Err(EdgeError::Storage("invalid storage name".to_owned()));
        }
        Ok(self.root.join(name))
    }
}

#[cfg(unix)]
fn restrict_file(path: &Path) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
}

#[cfg(not(unix))]
fn restrict_file(_path: &Path) -> io::Result<()> {
    Ok(())
}

#[cfg(unix)]
fn restrict_directory(path: &Path) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
}

#[cfg(not(unix))]
fn restrict_directory(_path: &Path) -> io::Result<()> {
    Ok(())
}
