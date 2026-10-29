//! Opt-in, session-only provider for the unmodified Zotero Word template.
mod citation;
mod driver;
#[cfg(windows)]
mod windows;

use crate::integration::connector::ConnectorController;
use citation::{Citation, Item, Metadata};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use tauri::{AppHandle, Emitter, Manager, State};

#[derive(Default)]
pub struct WordController {
    enabled: AtomicBool,
    busy: AtomicBool,
    pending: Mutex<Option<Pending>>,
    error: Mutex<Option<String>>,
}

struct Pending {
    view: WordRequest,
    snapshot: driver::Snapshot,
    vault: String,
    citations: Vec<(usize, Citation)>,
    edit: Option<usize>,
    created: std::time::Instant,
}

#[derive(Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct WordPaper {
    pub id: String,
    pub title: String,
    pub authors: Vec<String>,
    pub year: Option<i32>,
}

#[derive(Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct WordRequest {
    pub id: String,
    pub command: String,
    pub document: String,
    pub papers: Vec<WordPaper>,
    pub selected: Vec<String>,
    pub locator: String,
    pub style: String,
}

#[derive(Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct WordStatus {
    pub supported: bool,
    pub enabled: bool,
    pub busy: bool,
    pub pending: Option<WordRequest>,
    pub error: Option<String>,
}

impl WordController {
    fn status(&self) -> WordStatus {
        WordStatus {
            supported: cfg!(any(target_os = "macos", target_os = "windows")),
            enabled: self.enabled.load(Ordering::SeqCst),
            busy: self.busy.load(Ordering::SeqCst),
            pending: self
                .pending
                .lock()
                .unwrap()
                .as_ref()
                .map(|p| p.view.clone()),
            error: self.error.lock().unwrap().clone(),
        }
    }
    fn changed(&self, app: &AppHandle) {
        let _ = app.emit("word:changed", ());
    }
    fn fail(&self, app: &AppHandle, error: String) {
        *self.error.lock().unwrap() = Some(error);
        self.busy.store(false, Ordering::SeqCst);
        self.changed(app);
    }
}

fn local_vault(ctrl: &ConnectorController) -> Result<String, String> {
    let status = ctrl.status();
    if !status.listening {
        return Err("word.connectorRequired".into());
    }
    status
        .vault_path
        .filter(|p| !p.starts_with("remote:"))
        .ok_or("word.localVaultRequired".into())
}

async fn check_zotero() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let status = tokio::process::Command::new("/usr/bin/pgrep")
            .args(["-i", "-x", "zotero"])
            .stdout(std::process::Stdio::null())
            .status()
            .await
            .map_err(|e| e.to_string())?;
        if status.success() {
            return Err("word.zoteroRunning".into());
        }
    }
    #[cfg(windows)]
    {
        let mut command = std::process::Command::new("tasklist");
        command.args(["/NH", "/FI", "IMAGENAME eq zotero.exe"]);
        crate::core::process::hide_console_window(&mut command);
        let output = command.output().map_err(|e| e.to_string())?;
        if String::from_utf8_lossy(&output.stdout)
            .to_ascii_lowercase()
            .contains("zotero.exe")
        {
            return Err("word.zoteroRunning".into());
        }
    }
    Ok(())
}

/// Surface a command the window procedure cannot answer with HTTP status.
/// A busy rejection must not clear the in-flight request.
#[cfg(windows)]
pub(super) fn note_rejection(app: &AppHandle, error: String) {
    if error == "word.busy" {
        return;
    }
    let ctrl = app.state::<WordController>();
    *ctrl.error.lock().unwrap() = Some(error);
    ctrl.changed(app);
}

#[tauri::command]
#[specta::specta]
pub fn word_get_status(ctrl: State<'_, WordController>) -> WordStatus {
    ctrl.status()
}

#[tauri::command]
#[specta::specta]
pub async fn word_set_enabled(
    app: AppHandle,
    ctrl: State<'_, WordController>,
    connector: State<'_, Arc<ConnectorController>>,
    enabled: bool,
) -> Result<WordStatus, String> {
    if ctrl.busy.load(Ordering::SeqCst) {
        return Err("word.busy".into());
    }
    if enabled {
        if !(cfg!(target_os = "macos") || cfg!(target_os = "windows")) {
            return Err("word.platformUnsupported".into());
        }
        local_vault(&connector)?;
        check_zotero().await?;
        #[cfg(windows)]
        windows::start(&app)?;
    } else {
        #[cfg(windows)]
        windows::stop();
    }
    ctrl.enabled.store(enabled, Ordering::SeqCst);
    *ctrl.error.lock().unwrap() = None;
    ctrl.changed(&app);
    Ok(ctrl.status())
}

#[tauri::command]
#[specta::specta]
pub fn word_cancel(
    app: AppHandle,
    ctrl: State<'_, WordController>,
    request_id: String,
) -> Result<(), String> {
    let mut pending = ctrl.pending.lock().unwrap();
    if pending.as_ref().is_none_or(|p| p.view.id != request_id) {
        return Err("word.expired".into());
    }
    pending.take();
    ctrl.busy.store(false, Ordering::SeqCst);
    drop(pending);
    ctrl.changed(&app);
    Ok(())
}

/// Reserve synchronously, then respond to the macro before any automation/UI.
pub fn accept(app: AppHandle, command: String) -> Result<(), String> {
    let ctrl = app.state::<WordController>();
    if !ctrl.enabled.load(Ordering::SeqCst) {
        return Err("word.disabled".into());
    }
    if !matches!(
        command.as_str(),
        "addEditCitation" | "addEditBibliography" | "refresh" | "setDocPrefs"
    ) {
        return Err("word.commandUnsupported".into());
    }
    if ctrl
        .busy
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Err("word.busy".into());
    }
    *ctrl.error.lock().unwrap() = None;
    tauri::async_runtime::spawn(async move {
        if let Err(error) = prepare(&app, command).await {
            app.state::<WordController>().fail(&app, error);
        }
    });
    Ok(())
}

async fn prepare(app: &AppHandle, command: String) -> Result<(), String> {
    check_zotero().await?;
    let vault = local_vault(&app.state::<Arc<ConnectorController>>())?;
    let snapshot = driver::read().await?;
    // Body-only insertion and collapsed cursor. Never replace selected prose.
    if command == "addEditCitation" || command == "addEditBibliography" {
        if snapshot.start != snapshot.end {
            return Err("word.collapseSelection".into());
        }
        if !snapshot.story.to_lowercase().contains("main") {
            return Err("word.notesUnsupported".into());
        }
    }
    let mut citations = Vec::new();
    for field in &snapshot.fields {
        if field.code.contains("ZOTERO_") && field.text.is_empty() {
            return Err("word.damagedField".into());
        }
        if let Some(c) = citation::decode(&field.code)? {
            citations.push((field.index, c));
        }
    }
    let edit = citations.iter().position(|(i, _)| {
        let field = &snapshot.fields[*i];
        snapshot.start >= field.start - 1 && snapshot.start <= field.end
    });
    if (command == "addEditBibliography" && edit.is_some())
        || ((command == "addEditCitation" || command == "addEditBibliography")
            && snapshot.fields.iter().any(|f| {
                f.code.trim().starts_with(citation::BIB_PREFIX)
                    && snapshot.start >= f.start - 1
                    && snapshot.start <= f.end
            }))
    {
        return Err("word.cursorInCitation".into());
    }
    let rows = agentero_core::features::catalog::papers::list_all(std::path::Path::new(&vault))
        .map_err(|e| e.to_string())?;
    let selected = edit
        .map(|i| {
            citations[i]
                .1
                .citation_items
                .iter()
                .map(|x| x.id.clone())
                .collect()
        })
        .unwrap_or_default();
    let locator = edit
        .and_then(|i| citations[i].1.citation_items.first())
        .map(|x| x.locator.clone())
        .unwrap_or_default();
    if matches!(command.as_str(), "refresh" | "setDocPrefs") && citations.is_empty() {
        return Err("word.noCitations".into());
    }
    let style = citations
        .first()
        .map(|(_, c)| c.agentero.style.clone())
        .unwrap_or("apa".into());
    citation::style(&style)?;
    let view = WordRequest {
        id: uuid::Uuid::new_v4().to_string(),
        command,
        document: snapshot.name.clone(),
        papers: rows
            .iter()
            .map(|p| WordPaper {
                id: format!("agentero:{}", p.id),
                title: p.title.clone(),
                authors: p.authors.clone(),
                year: p.year,
            })
            .collect(),
        selected,
        locator,
        style,
    };
    let expiry_id = view.id.clone();
    let ctrl = app.state::<WordController>();
    *ctrl.pending.lock().unwrap() = Some(Pending {
        view,
        snapshot,
        vault,
        citations,
        edit,
        created: std::time::Instant::now(),
    });
    ctrl.changed(app);
    let expiry_app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(600)).await;
        let ctrl = expiry_app.state::<WordController>();
        let expired = {
            let mut slot = ctrl.pending.lock().unwrap();
            if slot.as_ref().is_some_and(|p| p.view.id == expiry_id) {
                slot.take();
                true
            } else {
                false
            }
        };
        if expired {
            ctrl.fail(&expiry_app, "word.expired".into());
        }
    });
    if let Some(window) = app.get_webview_window("main") {
        #[cfg(not(any(target_os = "android", target_os = "ios")))]
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
    Ok(())
}

#[derive(Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct WordSubmit {
    pub request_id: String,
    pub selected: Vec<String>,
    pub locator: String,
    pub style: String,
}

#[tauri::command]
#[specta::specta]
pub async fn word_submit(
    app: AppHandle,
    ctrl: State<'_, WordController>,
    args: WordSubmit,
) -> Result<(), String> {
    let pending = {
        let mut slot = ctrl.pending.lock().unwrap();
        if slot.as_ref().is_none_or(|p| p.view.id != args.request_id) {
            return Err("word.expired".into());
        }
        slot.take().unwrap()
    };
    let result = apply(&app, pending, args).await;
    ctrl.busy.store(false, Ordering::SeqCst);
    if let Err(error) = &result {
        *ctrl.error.lock().unwrap() = Some(error.clone());
    }
    ctrl.changed(&app);
    result
}

async fn apply(app: &AppHandle, mut pending: Pending, args: WordSubmit) -> Result<(), String> {
    if pending.created.elapsed().as_secs() > 600 {
        return Err("word.expired".into());
    }
    if local_vault(&app.state::<Arc<ConnectorController>>())? != pending.vault {
        return Err("word.vaultChanged".into());
    }
    check_zotero().await?;
    citation::style(&args.style)?;
    if args.locator.len() > 100 || args.selected.len() > 50 {
        return Err("word.invalidSelection".into());
    }
    let rows =
        agentero_core::features::catalog::papers::list_all(std::path::Path::new(&pending.vault))
            .map_err(|e| e.to_string())?;
    let catalog: std::collections::HashMap<_, _> = rows
        .iter()
        .map(|p| (format!("agentero:{}", p.id), citation::csl(p)))
        .collect();
    // Refresh current metadata where linked; orphaned snapshots remain usable.
    for (_, c) in &mut pending.citations {
        c.agentero.style.clone_from(&args.style);
        for item in &mut c.citation_items {
            if let Some(data) = catalog.get(&item.id) {
                item.item_data = data.clone();
            }
        }
    }
    let mut insertion = None;
    if pending.view.command == "addEditCitation" {
        if args.selected.is_empty() {
            return Err("word.invalidSelection".into());
        }
        let mut seen = std::collections::HashSet::new();
        let items = args
            .selected
            .iter()
            .filter(|id| seen.insert(*id))
            .map(|id| {
                let data = catalog
                    .get(id)
                    .cloned()
                    .or_else(|| {
                        pending
                            .citations
                            .iter()
                            .flat_map(|(_, c)| &c.citation_items)
                            .find(|x| &x.id == id)
                            .map(|x| x.item_data.clone())
                    })
                    .ok_or("word.invalidSelection")?;
                Ok(Item {
                    id: id.clone(),
                    item_data: data,
                    locator: args.locator.clone(),
                    label: "page".into(),
                })
            })
            .collect::<Result<Vec<_>, String>>()?;
        if let Some(edit) = pending.edit {
            pending.citations[edit].1.citation_items = items;
        } else {
            let pos = pending
                .citations
                .iter()
                .position(|(index, _)| {
                    pending.snapshot.fields[*index].start > pending.snapshot.start
                })
                .unwrap_or(pending.citations.len());
            pending.citations.insert(
                pos,
                (
                    usize::MAX,
                    Citation {
                        citation_id: uuid::Uuid::new_v4().to_string(),
                        citation_items: items,
                        properties: json!({"noteIndex":0}),
                        agentero: Metadata {
                            version: 1,
                            style: args.style.clone(),
                        },
                    },
                ),
            );
        }
    }
    let citations: Vec<_> = pending.citations.iter().map(|(_, c)| c.clone()).collect();
    let (texts, bibliography) = citation::render(&citations, &args.style)?;
    let mut changes = Vec::new();
    for ((index, citation), text) in pending.citations.iter().zip(texts) {
        let code = citation::encode(citation)?;
        if *index == usize::MAX {
            insertion = Some(json!({"code":code,"text":text}));
        } else {
            changes.push(json!({"index":index,"code":code,"text":text}));
        }
    }
    let bib_code = format!(
        " {}{} ",
        citation::BIB_PREFIX,
        json!({"agentero":{"version":1,"style":args.style}})
    );
    let mut has_bib = false;
    for field in &pending.snapshot.fields {
        if field.code.trim().starts_with(citation::BIB_PREFIX) {
            has_bib = true;
            changes.push(json!({"index":field.index,"code":bib_code,"text":bibliography}));
        }
    }
    if pending.view.command == "addEditBibliography" && !has_bib {
        if citations.is_empty() {
            return Err("word.noCitations".into());
        }
        insertion = Some(json!({"code":bib_code,"text":bibliography}));
    }
    driver::execute(
        json!({"action":"apply","snapshot":pending.snapshot,"changes":changes,"insert":insertion}),
    )
    .await?;
    Ok(())
}
