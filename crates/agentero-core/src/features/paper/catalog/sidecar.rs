//! Per-paper metadata sidecar: `{paper}/metadata.json`.
//!
//! Catalog SQLite stays the fast query surface, but every authoritative field
//! (tags, is_read, urls, …) is projected into this file so a catalog row can
//! be rebuilt from disk alone. This keeps the vault self-contained (backup /
//! sync tools only need plain files) and honors local-first.

use super::papers::PaperRecord;
use std::fs;
use std::path::Path;

pub const SIDECAR_FILE: &str = "metadata.json";

/// Retry committed metadata projections before reading files for sync.
/// Missing directories are left pending: remote work mirrors are sparse, and
/// projection must never recreate a deleted paper directory.
pub fn flush_pending(vault_root: &Path) -> Result<(), crate::error::AppError> {
    super::schema::with_catalog(vault_root, |conn| {
        flush_pending_conn(vault_root, conn, None)
    })
}

pub(crate) fn retry_pending(vault_root: &Path, conn: &rusqlite::Connection, path: Option<&str>) {
    if let Err(error) = flush_pending_conn(vault_root, conn, path) {
        log::warn!(target: "agentero::catalog", "sidecar projection remains pending: {error}");
    }
}

pub(crate) fn flush_pending_conn(
    vault_root: &Path,
    conn: &rusqlite::Connection,
    path: Option<&str>,
) -> Result<(), crate::error::AppError> {
    // The write reservation covers re-reading the row through the atomic file
    // replacement. Another process cannot commit a newer row halfway through.
    let tx = rusqlite::Transaction::new_unchecked(conn, rusqlite::TransactionBehavior::Immediate)?;
    let paths = if let Some(path) = path {
        tx.prepare("SELECT path FROM pending_sidecars WHERE path = ?1")?
            .query_map([path], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?
    } else {
        tx.prepare("SELECT path FROM pending_sidecars ORDER BY path")?
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?
    };
    for path in paths {
        let Some(record) = super::papers::get_conn(&tx, &path)? else {
            continue;
        };
        let dir = vault_root.join(&path);
        match fs::metadata(&dir) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error.into()),
            Ok(_) => {}
        }
        // A file may have changed while the app was closed. Leave the conflict
        // for the existing rescan reconciliation rather than overwrite it.
        if read_sidecar(vault_root, &path).is_some_and(|sidecar| {
            chrono::DateTime::parse_from_rfc3339(&sidecar.updated_at).is_ok()
                && chrono::DateTime::parse_from_rfc3339(&record.updated_at).is_ok()
                && crate::time::rfc3339_after(&sidecar.updated_at, &record.updated_at)
        }) {
            return Err(crate::error::AppError::domain(
                "sidecar_conflict",
                format!("metadata changed on disk for {path}; rescan before syncing"),
            ));
        }
        crate::fs::atomic_write(
            &dir.join(SIDECAR_FILE),
            &serde_json::to_vec_pretty(&record)?,
        )?;
        tx.execute("DELETE FROM pending_sidecars WHERE path = ?1", [&path])?;
    }
    tx.commit()?;
    Ok(())
}

/// Read `{vault}/{rel_path}/metadata.json` as a catalog row.
/// `path` always comes from the on-disk location (sidecars move with their
/// folder, so any embedded path may be stale). Tolerates the older
/// Connector-era files (no `path`, bare-string tags).
pub fn read_sidecar(vault_root: &Path, rel_path: &str) -> Option<PaperRecord> {
    let raw = fs::read_to_string(vault_root.join(rel_path).join(SIDECAR_FILE)).ok()?;
    let mut record: PaperRecord = serde_json::from_str(&raw).ok()?;
    record.path = rel_path.to_string();
    Some(record)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::features::catalog::papers::PaperKind;
    use uuid::Uuid;

    fn minimal_record(path: &str) -> PaperRecord {
        serde_json::from_value(serde_json::json!({
            "path": path,
            "id": "x",
            "type": "article",
            "title": "T",
            "authors": [],
            "status": "completed",
            "added_at": "2024-01-01T00:00:00Z",
            "updated_at": "2024-01-02T00:00:00Z",
        }))
        .expect("minimal record")
    }

    fn pending(vault: &Path) -> Vec<String> {
        super::super::schema::with_catalog(vault, |conn| {
            Ok(conn
                .prepare("SELECT path FROM pending_sidecars ORDER BY path")?
                .query_map([], |row| row.get(0))?
                .collect::<Result<_, _>>()?)
        })
        .unwrap()
    }

    #[test]
    fn upgrade_backfills_existing_rows_for_projection() {
        use super::super::{ensure_catalog, evict_catalog_conn, papers};
        let vault = tempfile::tempdir().unwrap();
        fs::create_dir_all(vault.path().join("papers/x")).unwrap();
        papers::upsert_paper(vault.path(), &minimal_record("papers/x")).unwrap();
        fs::remove_file(vault.path().join("papers/x/metadata.json")).unwrap();
        evict_catalog_conn(vault.path());
        let conn = ensure_catalog(vault.path()).unwrap();
        conn.execute_batch(
            "DROP TRIGGER paper_sidecar_insert;
            DROP TRIGGER paper_sidecar_update; DROP TRIGGER paper_sidecar_delete;
            DROP TABLE pending_sidecars;
            UPDATE schema_meta SET value = '11' WHERE key = 'schema_version';",
        )
        .unwrap();
        drop(conn);
        ensure_catalog(vault.path()).unwrap();
        assert_eq!(read_sidecar(vault.path(), "papers/x").unwrap().title, "T");
        assert!(pending(vault.path()).is_empty());
    }

    #[test]
    fn failed_projection_survives_reopen_and_writes_latest_row() {
        use super::super::{ensure_catalog, evict_catalog_conn, papers};
        let vault = tempfile::tempdir().unwrap();
        let path = "papers/x";
        fs::create_dir_all(vault.path().join(path).join(SIDECAR_FILE)).unwrap();
        papers::upsert_paper(vault.path(), &minimal_record(path)).unwrap();
        papers::set_is_read(vault.path(), path, true).unwrap();
        assert_eq!(pending(vault.path()), [path]);
        assert!(flush_pending(vault.path()).is_err());
        evict_catalog_conn(vault.path());
        fs::remove_dir(vault.path().join(path).join(SIDECAR_FILE)).unwrap();
        ensure_catalog(vault.path()).unwrap();
        assert!(read_sidecar(vault.path(), path).unwrap().is_read);
        assert!(pending(vault.path()).is_empty());
        // A delayed retry has no captured stale row to overwrite newer values.
        flush_pending(vault.path()).unwrap();
        assert!(read_sidecar(vault.path(), path).unwrap().is_read);
    }

    #[test]
    fn pending_paths_follow_moves_and_deletes_without_creating_directories() {
        use super::super::papers;
        let vault = tempfile::tempdir().unwrap();
        papers::upsert_paper(vault.path(), &minimal_record("papers/x")).unwrap();
        assert!(!vault.path().join("papers/x").exists());
        papers::move_under_path(vault.path(), "papers/x", "papers/y").unwrap();
        assert_eq!(pending(vault.path()), ["papers/y"]);
        flush_pending(vault.path()).unwrap();
        assert!(!vault.path().join("papers/y").exists());
        papers::delete_under_path(vault.path(), "papers/y").unwrap();
        assert!(pending(vault.path()).is_empty());
    }

    #[test]
    fn reopen_preserves_newer_external_sidecar_until_rescan() {
        use super::super::{ensure_catalog, evict_catalog_conn, papers};
        let vault = tempfile::tempdir().unwrap();
        let path = "papers/x";
        let file = vault.path().join(path).join(SIDECAR_FILE);
        fs::create_dir_all(&file).unwrap();
        papers::upsert_paper(vault.path(), &minimal_record(path)).unwrap();
        fs::remove_dir(&file).unwrap();
        let mut external = minimal_record(path);
        external.title = "External edit".into();
        external.updated_at = "2099-01-01T00:00:00Z".into();
        let bytes = serde_json::to_vec(&external).unwrap();
        fs::write(&file, &bytes).unwrap();
        evict_catalog_conn(vault.path());
        ensure_catalog(vault.path()).unwrap();
        assert_eq!(fs::read(&file).unwrap(), bytes);
        assert!(flush_pending(vault.path()).is_err());
        papers::rebuild_from_disk(vault.path()).unwrap();
        flush_pending(vault.path()).unwrap();
        assert_eq!(
            read_sidecar(vault.path(), path).unwrap().title,
            "External edit"
        );
        assert!(pending(vault.path()).is_empty());
    }

    #[test]
    fn sidecar_roundtrip_overrides_stale_path() {
        let vault = std::env::temp_dir().join(format!("agentero-sidecar-{}", Uuid::new_v4()));
        fs::create_dir_all(vault.join("papers/x")).unwrap();
        let mut record = minimal_record("papers/x");
        record.is_read = true;
        super::super::papers::upsert_paper(&vault, &record).unwrap();

        // Simulate a folder move: read back from the new location.
        fs::create_dir_all(vault.join("papers/nlp")).unwrap();
        fs::rename(vault.join("papers/x"), vault.join("papers/nlp/x")).unwrap();
        let loaded = read_sidecar(&vault, "papers/nlp/x").expect("sidecar readable");
        assert_eq!(loaded.path, "papers/nlp/x");
        assert!(loaded.is_read);
        let _ = fs::remove_dir_all(&vault);
    }

    #[test]
    fn read_sidecar_tolerates_connector_paper_meta_shape() {
        let vault = std::env::temp_dir().join(format!("agentero-sidecar-meta-{}", Uuid::new_v4()));
        fs::create_dir_all(vault.join("papers/y")).unwrap();
        // Connector-era metadata.json: no `path`, tags as bare strings.
        fs::write(
            vault.join("papers/y/metadata.json"),
            r#"{"id":"y","type":"article","title":"Old","authors":["A"],"tags":["nlp"],
                "status":"completed","added_at":"t","updated_at":"t"}"#,
        )
        .unwrap();
        let loaded = read_sidecar(&vault, "papers/y").expect("legacy sidecar readable");
        assert_eq!(loaded.path, "papers/y");
        assert_eq!(loaded.paper_type, PaperKind::Doi);
        assert_eq!(loaded.openreview_url, None);
        assert_eq!(loaded.tags.len(), 1);
        assert_eq!(loaded.tags[0].name, "nlp");
        let _ = fs::remove_dir_all(&vault);
    }
}
