use std::fs;
use std::path::Path;
use std::sync::Arc;

use super::import_bridge::{unique_remote_paper_path, upload_tree};
use super::session::RemoteSession;
use crate::core::error::AppError;
use crate::features::paper::catalog::papers;
use crate::features::paper::import::{
    ensure_paper_assets, write_paper_shell, AssetDownloadResult, NoteShellMode,
};

pub(crate) enum RemoteAssetsPolicy<'a> {
    SyncDownload,
    CopyPdf { src: &'a Path },
}

pub(crate) struct RemotePaperCommitOptions<'a> {
    pub parent_rel: &'a str,
    pub task_id: Option<&'a str>,
    pub assets: RemoteAssetsPolicy<'a>,
    pub push_catalog: bool,
    /// NOTES.md shell generation mode (settings `paperNoteMode`), resolved by
    /// the constructing bridge from the local settings store.
    pub note_mode: NoteShellMode,
}

pub(crate) struct RemotePaperCommitResult {
    pub path: String,
    pub id: String,
    pub title: String,
    pub pdf: bool,
    pub tex: bool,
    pub paper_md: bool,
    pub asset_messages: Vec<String>,
}

pub(crate) async fn remote_paper_commit(
    session: Arc<RemoteSession>,
    mut meta: papers::PaperRecord,
    opts: RemotePaperCommitOptions<'_>,
) -> Result<RemotePaperCommitResult, AppError> {
    if meta.id.is_empty() {
        return Err(AppError::message("resolved metadata has empty id"));
    }

    let (id, path_rel) =
        unique_remote_paper_path(session.fs.as_ref(), opts.parent_rel, &meta.id).await?;
    meta.id = id.clone();
    let staging = session.work_root.join(&path_rel);
    if staging.exists() {
        let _ = fs::remove_dir_all(&staging);
    }
    fs::create_dir_all(&staging)?;

    if let RemoteAssetsPolicy::CopyPdf { src } = &opts.assets {
        fs::copy(src, staging.join(format!("{id}.pdf")))
            .map_err(|e| AppError::message(format!("copy PDF failed: {e}")))?;
    }

    write_paper_shell(&staging, &session.work_root, &meta, opts.note_mode).await?;

    let arxiv_request = agentero_core::features::paper::source::arxiv_request(&meta);
    let mut assets = match opts.assets {
        RemoteAssetsPolicy::SyncDownload => ensure_paper_assets(
            &staging,
            &id,
            arxiv_request.as_deref(),
            meta.pdf_url.as_deref(),
            meta.doi.as_deref(),
        )
        .await
        .unwrap_or_else(|e| {
            let mut r = AssetDownloadResult::default();
            r.messages.push(format!("asset download error: {e}"));
            r
        }),
        RemoteAssetsPolicy::CopyPdf { .. } => {
            let mut result = AssetDownloadResult {
                pdf: true,
                ..Default::default()
            };
            if let Some(id) = arxiv_request.as_deref() {
                if let Err(error) = crate::features::paper::import::download::prepare_arxiv_source(
                    &staging,
                    id,
                    opts.task_id,
                )
                .await
                {
                    result
                        .messages
                        .push(format!("source download error: {error}"));
                }
            }
            result
        }
    };
    let caps = crate::features::paper::catalog::probe_paper_caps(&staging);
    assets.pdf = caps.has_pdf();
    assets.tex = caps.has_tex;
    assets.paper_md = caps.has_paper_md;
    crate::features::paper::import::check_task_not_cancelled(opts.task_id)?;

    upload_tree(session.fs.as_ref(), &staging, &path_rel).await?;

    if agentero_core::features::paper::source::read_tex(&staging).is_some() {
        meta.body_source = Some("latex".into());
        meta.body_quality = Some("high".into());
    }
    let record = meta.clone().at_path(&path_rel);
    {
        let mut catalog = session.catalog.lock().await;
        let persisted = papers::upsert_paper(&session.work_root, &record)?;
        catalog.queue_sidecar(persisted.path);
        if opts.push_catalog {
            catalog.push(session.fs.clone()).await?;
        }
    }

    Ok(RemotePaperCommitResult {
        path: path_rel,
        id: meta.id,
        title: meta.title,
        pdf: assets.pdf,
        tex: assets.tex,
        paper_md: assets.paper_md,
        asset_messages: assets.messages,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::integration::remote::{RemoteRegistry, LOCAL_SIM_HOST};
    use agentero_core::features::paper::source::{self, SourceStatus};

    #[tokio::test]
    async fn failed_sidecar_publish_keeps_session_for_retry() {
        let root = tempfile::tempdir().unwrap();
        let pdf = root.path().join("fixture.pdf");
        fs::write(&pdf, b"fixture PDF").unwrap();
        let registry = RemoteRegistry::new();
        let info = registry
            .connect(LOCAL_SIM_HOST, None, &root.path().to_string_lossy())
            .await
            .unwrap();
        let session = registry.get(&info.session_id).await.unwrap();
        let result = remote_paper_commit(
            session.clone(),
            papers::PaperRecord::local_pdf("retry".into(), "Retry".into()),
            RemotePaperCommitOptions {
                parent_rel: "papers",
                task_id: None,
                assets: RemoteAssetsPolicy::CopyPdf { src: &pdf },
                push_catalog: false,
                note_mode: NoteShellMode::Standard,
            },
        )
        .await
        .unwrap();
        let sidecar = root.path().join(&result.path).join("metadata.json");
        fs::create_dir(&sidecar).unwrap();
        let before = fs::read(root.path().join(".agentero/catalog.sqlite")).unwrap();
        assert!(registry.disconnect(&info.session_id).await.is_err());
        assert!(registry.get(&info.session_id).await.is_ok());
        assert!(session.work_root.join(&result.path).is_dir());
        assert_eq!(
            fs::read(root.path().join(".agentero/catalog.sqlite")).unwrap(),
            before
        );
        fs::remove_dir(&sidecar).unwrap();
        let catalog_tmp = root.path().join(".agentero/catalog.sqlite.tmp");
        fs::create_dir(&catalog_tmp).unwrap();
        assert!(registry.disconnect(&info.session_id).await.is_err());
        assert!(sidecar.is_file());
        assert!(registry.get(&info.session_id).await.is_ok());
        // A retry projects the current row, not the snapshot from the first attempt.
        papers::set_is_read(&session.work_root, &result.path, true).unwrap();
        fs::remove_dir(&catalog_tmp).unwrap();
        registry.disconnect(&info.session_id).await.unwrap();
        assert!(registry.get(&info.session_id).await.is_err());
        assert!(!session.work_root.exists());
        let projected: serde_json::Value =
            serde_json::from_slice(&fs::read(sidecar).unwrap()).unwrap();
        let row = papers::get_by_path(root.path(), &result.path)
            .unwrap()
            .unwrap();
        assert_eq!(projected, serde_json::to_value(row).unwrap());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn upload_failure_does_not_commit_catalog_row() {
        let root = tempfile::tempdir().unwrap();
        let pdf = root.path().join("fixture.pdf");
        fs::write(&pdf, b"fixture PDF").unwrap();
        // A dangling parent resolves as missing at allocation, but mkdir cannot
        // replace the symlink when uploading the staged directory.
        std::os::unix::fs::symlink(root.path().join("missing"), root.path().join("papers"))
            .unwrap();
        let registry = RemoteRegistry::new();
        let info = registry
            .connect(LOCAL_SIM_HOST, None, &root.path().to_string_lossy())
            .await
            .unwrap();
        let session = registry.get(&info.session_id).await.unwrap();
        let result = remote_paper_commit(
            session.clone(),
            papers::PaperRecord::local_pdf("failed".into(), "Failed".into()),
            RemotePaperCommitOptions {
                parent_rel: "papers",
                task_id: None,
                assets: RemoteAssetsPolicy::CopyPdf { src: &pdf },
                push_catalog: true,
                note_mode: NoteShellMode::Standard,
            },
        )
        .await;
        assert!(result.is_err());
        assert!(session.work_root.join("papers/failed/failed.pdf").is_file());
        assert!(papers::get_by_path(&session.work_root, "papers/failed")
            .unwrap()
            .is_none());
        registry.disconnect(&info.session_id).await.unwrap();
    }

    #[tokio::test]
    async fn publishes_canonical_sidecar_with_catalog() {
        let root = tempfile::tempdir().unwrap();
        let pdf = root.path().join("fixture.pdf");
        fs::write(&pdf, b"fixture PDF").unwrap();
        let registry = RemoteRegistry::new();
        let info = registry
            .connect(LOCAL_SIM_HOST, None, &root.path().to_string_lossy())
            .await
            .unwrap();
        let session = registry.get(&info.session_id).await.unwrap();
        let mut meta = papers::PaperRecord::local_pdf("sidecar".into(), "Sidecar".into());
        meta.added_at = "2024-01-01T00:00:00Z".into();
        let result = remote_paper_commit(
            session,
            meta,
            RemotePaperCommitOptions {
                parent_rel: "papers",
                task_id: None,
                assets: RemoteAssetsPolicy::CopyPdf { src: &pdf },
                push_catalog: true,
                note_mode: NoteShellMode::Standard,
            },
        )
        .await
        .unwrap();
        let sidecar: serde_json::Value = serde_json::from_slice(
            &fs::read(root.path().join(&result.path).join("metadata.json")).unwrap(),
        )
        .unwrap();
        let record = papers::get_by_path(root.path(), &result.path)
            .unwrap()
            .unwrap();
        assert_eq!(sidecar, serde_json::to_value(record).unwrap());
        registry.disconnect(&info.session_id).await.unwrap();
    }

    #[tokio::test]
    async fn copy_pdf_preserves_file_and_retry_state_when_source_download_fails() {
        // A real unversioned id now downloads the latest e-print. This id cannot
        // resolve, so a failed download must still keep the copied PDF and a
        // later retry error.
        let id = "9999.99999";
        let root = tempfile::tempdir().unwrap();
        let pdf = root.path().join("fixture.pdf");
        let bytes = include_bytes!("../../../../test/fixtures/rotate90.pdf");
        fs::write(&pdf, bytes).unwrap();
        let registry = RemoteRegistry::new();
        let info = registry
            .connect(LOCAL_SIM_HOST, None, &root.path().to_string_lossy())
            .await
            .unwrap();
        let session = registry.get(&info.session_id).await.unwrap();
        let mut meta = papers::PaperRecord::local_pdf(id.into(), "Keep PDF".into());
        meta.arxiv_id = Some(id.into());
        let result = remote_paper_commit(
            session.clone(),
            meta,
            RemotePaperCommitOptions {
                parent_rel: "papers",
                task_id: None,
                assets: RemoteAssetsPolicy::CopyPdf { src: &pdf },
                push_catalog: true,
                note_mode: NoteShellMode::Standard,
            },
        )
        .await
        .unwrap();
        let paper = root.path().join(&result.path);
        assert!(result.pdf);
        assert!(!result.tex);
        assert!(!result.paper_md);
        assert!(!result.asset_messages.is_empty());
        assert_eq!(fs::read(paper.join(format!("{id}.pdf"))).unwrap(), bytes);
        assert_eq!(
            source::state(&paper).unwrap().status,
            SourceStatus::RetryableError
        );
        assert!(source::needs_source(&paper, Some(id)));
        let record = papers::get_by_path(root.path(), &result.path)
            .unwrap()
            .unwrap();
        assert!(record.body_source.is_none());
        assert!(!paper.join("PAPER.md").exists());
        source::record_state(
            &session.work_root.join(&result.path),
            id,
            SourceStatus::RetryableError,
            Some("HTTP 429: retry source".into()),
        )
        .unwrap();
        assert!(
            super::super::import_bridge::prepare_body_remote(session, &result.path)
                .await
                .is_err()
        );
        assert_eq!(
            source::state(&paper).unwrap().error.as_deref(),
            Some("HTTP 429: retry source")
        );
        assert!(!paper.join("PAPER.md").exists());
        registry.disconnect(&info.session_id).await.unwrap();
    }
}
