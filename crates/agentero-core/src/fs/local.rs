//! Local disk implementation of [`VaultFs`].

use super::{normalize_rel, path_escapes_root, FsCaps, FsDirEntry, FsFileMeta, VaultFs, WriteOpts};
use crate::error::AppError;
use async_trait::async_trait;
use std::path::{Path, PathBuf};
use std::time::SystemTime;
use tokio::fs;

pub struct LocalFs {
    root: PathBuf,
}

impl LocalFs {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    fn resolve(&self, rel: &str) -> Result<PathBuf, AppError> {
        if path_escapes_root(rel) {
            return Err(AppError::message("path escapes vault root"));
        }
        let norm = normalize_rel(rel);
        if norm.is_empty() {
            Ok(self.root.clone())
        } else {
            Ok(self.root.join(Path::new(&norm)))
        }
    }
}

fn mtime_secs(meta: &std::fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

#[async_trait]
impl VaultFs for LocalFs {
    fn caps(&self) -> FsCaps {
        FsCaps::LOCAL
    }

    async fn list(&self, rel: &str) -> Result<Vec<FsDirEntry>, AppError> {
        let dir = self.resolve(rel)?;
        let mut rd = fs::read_dir(&dir)
            .await
            .map_err(|e| AppError::message(format!("list {}: {e}", dir.display())))?;
        let base = normalize_rel(rel);
        let mut out = Vec::new();
        while let Some(entry) = rd
            .next_entry()
            .await
            .map_err(|e| AppError::message(format!("list entry: {e}")))?
        {
            let name = entry.file_name().to_string_lossy().into_owned();
            let ft = entry
                .file_type()
                .await
                .map_err(|e| AppError::message(format!("file_type: {e}")))?;
            let child_rel = if base.is_empty() {
                name.clone()
            } else {
                format!("{base}/{name}")
            };
            out.push(FsDirEntry {
                name,
                is_dir: ft.is_dir(),
                is_file: ft.is_file(),
                path: child_rel,
            });
        }
        out.sort_by(|a, b| match (a.is_dir, b.is_dir) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
        });
        Ok(out)
    }

    async fn stat(&self, rel: &str) -> Result<FsFileMeta, AppError> {
        let path = self.resolve(rel)?;
        let meta = fs::metadata(&path)
            .await
            .map_err(|e| std::io::Error::new(e.kind(), format!("stat {}: {e}", path.display())))?;
        Ok(FsFileMeta {
            size: meta.len(),
            mtime: mtime_secs(&meta),
            is_dir: meta.is_dir(),
            is_file: meta.is_file(),
        })
    }

    async fn read(&self, rel: &str) -> Result<Vec<u8>, AppError> {
        let path = self.resolve(rel)?;
        fs::read(&path)
            .await
            .map_err(|e| AppError::message(format!("read {}: {e}", path.display())))
    }

    async fn write(&self, rel: &str, data: &[u8], opts: WriteOpts) -> Result<(), AppError> {
        let path = self.resolve(rel)?;
        if opts.create_parents {
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent)
                    .await
                    .map_err(|e| AppError::message(format!("mkdir parent: {e}")))?;
            }
        }
        fs::write(&path, data)
            .await
            .map_err(|e| AppError::message(format!("write {}: {e}", path.display())))
    }

    async fn mkdir(&self, rel: &str) -> Result<(), AppError> {
        let path = self.resolve(rel)?;
        fs::create_dir_all(&path)
            .await
            .map_err(|e| AppError::message(format!("mkdir {}: {e}", path.display())))
    }

    async fn rename(&self, from: &str, to: &str) -> Result<(), AppError> {
        let src = self.resolve(from)?;
        let dst = self.resolve(to)?;
        if let Some(parent) = dst.parent() {
            fs::create_dir_all(parent)
                .await
                .map_err(|e| AppError::message(format!("mkdir parent: {e}")))?;
        }
        fs::rename(&src, &dst)
            .await
            .map_err(|e| AppError::message(format!("rename: {e}")))
    }

    async fn remove(&self, rel: &str, recursive: bool) -> Result<(), AppError> {
        let path = self.resolve(rel)?;
        let meta = fs::metadata(&path)
            .await
            .map_err(|e| AppError::message(format!("remove stat {}: {e}", path.display())))?;
        if meta.is_dir() {
            if recursive {
                fs::remove_dir_all(&path)
                    .await
                    .map_err(|e| AppError::message(format!("remove_dir_all: {e}")))?;
            } else {
                fs::remove_dir(&path)
                    .await
                    .map_err(|e| AppError::message(format!("remove_dir: {e}")))?;
            }
        } else {
            fs::remove_file(&path)
                .await
                .map_err(|e| AppError::message(format!("remove_file: {e}")))?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    /// Monotonic suffix so parallel tests never share a temp root.
    /// `SystemTime` resolution is coarse enough that two tests can get the same
    /// `as_nanos()` value and then race on `remove_dir_all` (ENOENT / EINVAL).
    static TMP_SEQ: AtomicU64 = AtomicU64::new(0);

    fn tmp_root() -> PathBuf {
        let seq = TMP_SEQ.fetch_add(1, Ordering::Relaxed);
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("agentero-localfs-{nanos}-{seq}"));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[tokio::test]
    async fn read_write_list_roundtrip() {
        let root = tmp_root();
        let fs = LocalFs::new(&root);
        fs.write(
            "notes/a.md",
            b"hello",
            WriteOpts {
                create_parents: true,
            },
        )
        .await
        .unwrap();
        assert_eq!(fs.read("notes/a.md").await.unwrap(), b"hello");
        let entries = fs.list("").await.unwrap();
        assert!(entries.iter().any(|e| e.name == "notes" && e.is_dir));
        let notes = fs.list("notes").await.unwrap();
        assert!(notes.iter().any(|e| e.name == "a.md" && e.is_file));
        let meta = fs.stat("notes/a.md").await.unwrap();
        assert_eq!(meta.size, 5);
        assert!(meta.is_file);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn exists_distinguishes_missing_paths_from_invalid_paths() {
        let root = tempfile::tempdir().unwrap();
        let fs = LocalFs::new(root.path());
        std::fs::write(root.path().join("note.md"), "note").unwrap();
        assert!(fs.exists("note.md").await.unwrap());
        assert!(!fs.exists("missing.md").await.unwrap());
        assert!(fs.exists("../outside.md").await.is_err());
    }

    #[tokio::test]
    async fn rejects_escape() {
        let root = tmp_root();
        let fs = LocalFs::new(&root);
        let err = fs.read("../secret").await.unwrap_err();
        assert!(err.to_string().contains("escapes"));
        let _ = std::fs::remove_dir_all(&root);
    }
}
