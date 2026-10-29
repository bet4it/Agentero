//! Skill import: discover GitHub-backed Skill packages, let the user pick
//! candidates, and install them into `.agents/skills`.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use base64::Engine;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use walkdir::WalkDir;

use super::AppHandle;
use crate::error::AppError;
pub use crate::features::scholar_api::identifiers::SkillSource;
use crate::frontmatter::{frontmatter_block, scalar_field};

const MAX_ARCHIVE_BYTES: usize = 64 * 1024 * 1024;
const MAX_EXTRACTED_FILES: usize = 2_000;
const MAX_SKILL_NAME_LEN: usize = 64;
const MAX_DESCRIPTION_LEN: usize = 1024;
const SPARSE_DISCOVERY_MARKER: &str = "sparse.json";
const SPARSE_CANDIDATES_FILE: &str = "candidates.json";

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SkillImportResult {
    pub name: String,
    pub description: String,
    pub path: String,
    pub source: String,
    pub skipped: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SkillCandidate {
    pub name: String,
    pub description: String,
    pub source: String,
    pub relative_path: String,
    pub already_installed: bool,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SkillDiscovery {
    pub discovery_id: String,
    pub source: String,
    pub candidates: Vec<SkillCandidate>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SparseSkillCandidate {
    path: String,
    name: String,
    description: String,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum GithubContentsResponse {
    Entry(GithubContentEntry),
    Entries(Vec<GithubContentEntry>),
}

#[derive(Debug, Deserialize)]
struct GithubContentEntry {
    path: String,
    sha: Option<String>,
    #[serde(rename = "type")]
    kind: String,
    size: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct GithubBlob {
    content: String,
    encoding: String,
    size: u64,
}

#[derive(Debug, Deserialize)]
struct GithubTree {
    tree: Vec<GithubTreeEntry>,
    truncated: bool,
}

#[derive(Debug, Deserialize)]
struct GithubTreeEntry {
    path: String,
    sha: Option<String>,
    #[serde(rename = "type")]
    kind: String,
}

pub async fn discover_skill_source(
    vault: &Path,
    source: &SkillSource,
    app: Option<&AppHandle>,
    task_id: Option<&str>,
) -> Result<SkillDiscovery, AppError> {
    let reference = match &source.reference {
        Some(reference) => reference.clone(),
        None => default_branch(&source.owner, &source.repo).await?,
    };
    if source.subpath.is_some() {
        return discover_skill_subpath(vault, source, &reference, app, task_id).await;
    }
    discover_skill_sparse(vault, source, &reference, app, task_id).await
}

async fn discover_skill_subpath(
    vault: &Path,
    source: &SkillSource,
    reference: &str,
    app: Option<&AppHandle>,
    task_id: Option<&str>,
) -> Result<SkillDiscovery, AppError> {
    discover_skill_sparse(vault, source, reference, app, task_id).await
}

async fn discover_skill_sparse(
    vault: &Path,
    source: &SkillSource,
    reference: &str,
    app: Option<&AppHandle>,
    task_id: Option<&str>,
) -> Result<SkillDiscovery, AppError> {
    let discovery_id = uuid::Uuid::new_v4().to_string();
    let temp = discovery_dir(&discovery_id)?;
    fs::create_dir_all(&temp)?;
    fs::write(
        temp.join("source.json"),
        serde_json::to_vec(&serde_json::json!({
            "source": source,
            "reference": reference,
        }))?,
    )?;
    fs::write(temp.join(SPARSE_DISCOVERY_MARKER), b"{}")?;

    let candidates = discover_sparse_candidates(source, reference, app, task_id).await?;
    if candidates.is_empty() {
        let _ = fs::remove_dir_all(&temp);
        return Err(AppError::message(
            "no importable SKILL.md was found in this source",
        ));
    }
    fs::write(
        temp.join(SPARSE_CANDIDATES_FILE),
        serde_json::to_vec(&candidates)?,
    )?;
    let candidates = sparse_skill_candidates(vault, source, candidates);
    Ok(SkillDiscovery {
        discovery_id,
        source: source.source.clone(),
        candidates,
    })
}

async fn default_branch(owner: &str, repo: &str) -> Result<String, AppError> {
    let canonical = format!("https://api.github.com/repos/{owner}/{repo}");
    if let Some(body) =
        fetch_github_api_json_via_gh::<serde_json::Value>(&canonical, "invalid GitHub response")
            .await?
    {
        return default_branch_from_body(body);
    }
    default_branch_once(&canonical).await
}

async fn default_branch_once(url: &str) -> Result<String, AppError> {
    let client = crate::http::client_builder()
        .timeout(Duration::from_secs(20))
        .user_agent("Agentero/skill-import")
        .build()
        .map_err(|e| AppError::message(format!("http client: {e}")))?;
    let request = client
        .get(url)
        .header("Accept", "application/vnd.github+json");
    let response = crate::http::with_github_api_auth(request, url)
        .send()
        .await
        .map_err(|e| AppError::message(format!("skill metadata request: {e}")))?;
    if !response.status().is_success() {
        return Err(AppError::message(format!(
            "GitHub repository lookup failed: {}",
            response.status()
        )));
    }
    let body: serde_json::Value = response
        .json()
        .await
        .map_err(|e| AppError::message(format!("invalid GitHub response: {e}")))?;
    default_branch_from_body(body)
}

fn default_branch_from_body(body: serde_json::Value) -> Result<String, AppError> {
    body.get("default_branch")
        .and_then(|value| value.as_str())
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .ok_or_else(|| AppError::message("GitHub response did not include a default branch"))
}

fn github_api_endpoint(canonical: &str) -> Option<String> {
    let url = url::Url::parse(canonical).ok()?;
    if url.host_str() != Some("api.github.com") {
        return None;
    }
    let mut endpoint = url.path().to_string();
    if let Some(query) = url.query() {
        endpoint.push('?');
        endpoint.push_str(query);
    }
    Some(endpoint)
}

async fn fetch_github_api_json_via_gh<T>(
    canonical: &str,
    invalid_context: &str,
) -> Result<Option<T>, AppError>
where
    T: DeserializeOwned,
{
    let Some(endpoint) = github_api_endpoint(canonical) else {
        return Ok(None);
    };
    let Some(gh) = crate::process::resolve_command("gh") else {
        return Ok(None);
    };

    let mut command = tokio::process::Command::new(gh);
    command.args(["api", "--hostname", "github.com", &endpoint]);
    crate::process::hide_console_window_tokio(&mut command);
    let output = match tokio::time::timeout(
        Duration::from_secs(20),
        crate::process::command_output(&mut command),
    )
    .await
    {
        Ok(Ok(output)) => output,
        Ok(Err(error)) => {
            log::debug!(target: "agentero::skill", "gh api failed to start: {error}");
            return Ok(None);
        }
        Err(_) => {
            log::warn!(target: "agentero::skill", "gh api timed out for {endpoint}");
            return Ok(None);
        }
    };
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let snippet = crate::http::http_err_snippet(stderr.trim());
        log::debug!(
            target: "agentero::skill",
            "gh api failed for {endpoint}: {}",
            snippet
        );
        return Ok(None);
    }

    serde_json::from_slice(&output.stdout)
        .map(Some)
        .map_err(|e| AppError::message(format!("{invalid_context}: {e}")))
}

async fn fetch_github_subpath_to_root(
    source: &SkillSource,
    reference: &str,
    subpath: &str,
    root: &Path,
) -> Result<(), AppError> {
    let mut pending = vec![subpath.to_string()];
    let mut files = 0_usize;
    let mut total_bytes = 0_usize;

    while let Some(path) = pending.pop() {
        let entries = github_contents(source, reference, &path).await?;
        for entry in entries {
            match entry.kind.as_str() {
                "dir" => pending.push(entry.path),
                "file" => {
                    files += 1;
                    if files > MAX_EXTRACTED_FILES {
                        return Err(AppError::message("skill source contains too many files"));
                    }
                    if let Some(size) = entry.size {
                        if total_bytes.saturating_add(size as usize) > MAX_ARCHIVE_BYTES {
                            return Err(AppError::message("skill source is too large"));
                        }
                    }
                    let sha = entry
                        .sha
                        .as_deref()
                        .ok_or_else(|| AppError::message("GitHub file is missing a blob SHA"))?;
                    let bytes = github_blob_bytes(source, sha).await?;
                    total_bytes = total_bytes.saturating_add(bytes.len());
                    if total_bytes > MAX_ARCHIVE_BYTES {
                        return Err(AppError::message("skill source is too large"));
                    }
                    write_staged_github_file(root, &entry.path, &bytes)?;
                }
                _ => {}
            }
        }
    }
    Ok(())
}

async fn discover_sparse_candidates(
    source: &SkillSource,
    reference: &str,
    _app: Option<&AppHandle>,
    _task_id: Option<&str>,
) -> Result<Vec<SparseSkillCandidate>, AppError> {
    if source.subpath.is_none() {
        return discover_sparse_candidates_from_tree(source, reference).await;
    }

    let mut pending = vec![source.subpath.as_deref().unwrap_or_default().to_string()];
    let mut files = 0_usize;
    let mut candidates = Vec::new();

    while let Some(path) = pending.pop() {
        let entries = github_contents(source, reference, &path).await?;
        for entry in entries {
            match entry.kind.as_str() {
                "dir" => pending.push(entry.path),
                "file" => {
                    files += 1;
                    if files > MAX_EXTRACTED_FILES {
                        return Err(AppError::message("skill source contains too many files"));
                    }
                    if !entry.path.ends_with("/SKILL.md") && entry.path != "SKILL.md" {
                        continue;
                    }
                    let sha = entry
                        .sha
                        .as_deref()
                        .ok_or_else(|| AppError::message("GitHub file is missing a blob SHA"))?;
                    let bytes = github_blob_bytes(source, sha).await?;
                    let Ok(content) = String::from_utf8(bytes) else {
                        continue;
                    };
                    let Ok((name, description)) = parse_skill_metadata(&content) else {
                        continue;
                    };
                    if !source.skill_names.is_empty()
                        && !source
                            .skill_names
                            .iter()
                            .any(|requested| requested == "*" || requested == &name)
                    {
                        continue;
                    }
                    candidates.push(SparseSkillCandidate {
                        path: skill_dir_from_skill_md_path(&entry.path)?,
                        name,
                        description,
                    });
                }
                _ => {}
            }
        }
    }
    Ok(candidates)
}

async fn discover_sparse_candidates_from_tree(
    source: &SkillSource,
    reference: &str,
) -> Result<Vec<SparseSkillCandidate>, AppError> {
    let tree = github_tree(source, reference).await?;
    if tree.truncated {
        return Err(AppError::message(
            "GitHub tree is too large to list Skills before download",
        ));
    }

    let mut candidates = Vec::new();
    for entry in tree.tree {
        if entry.kind != "blob" {
            continue;
        }
        if !entry.path.ends_with("/SKILL.md") && entry.path != "SKILL.md" {
            continue;
        }
        let sha = entry
            .sha
            .as_deref()
            .ok_or_else(|| AppError::message("GitHub file is missing a blob SHA"))?;
        let bytes = github_blob_bytes(source, sha).await?;
        let Ok(content) = String::from_utf8(bytes) else {
            continue;
        };
        let Ok((name, description)) = parse_skill_metadata(&content) else {
            continue;
        };
        if !source.skill_names.is_empty()
            && !source
                .skill_names
                .iter()
                .any(|requested| requested == "*" || requested == &name)
        {
            continue;
        }
        candidates.push(SparseSkillCandidate {
            path: skill_dir_from_skill_md_path(&entry.path)?,
            name,
            description,
        });
    }
    Ok(candidates)
}

fn sparse_skill_candidates(
    vault: &Path,
    source: &SkillSource,
    candidates: Vec<SparseSkillCandidate>,
) -> Vec<SkillCandidate> {
    candidates
        .into_iter()
        .map(|candidate| {
            let already_installed = vault.join(".agents/skills").join(&candidate.name).is_dir();
            SkillCandidate {
                name: candidate.name,
                description: candidate.description,
                source: source.source.clone(),
                relative_path: candidate.path,
                already_installed,
            }
        })
        .collect()
}

fn skill_dir_from_skill_md_path(path: &str) -> Result<String, AppError> {
    let path = path.trim_end_matches('/');
    let Some(dir) = path.strip_suffix("/SKILL.md") else {
        if path == "SKILL.md" {
            return Ok(String::new());
        }
        return Err(AppError::message("GitHub Skill path is invalid"));
    };
    Ok(dir.to_string())
}

async fn github_blob_bytes(source: &SkillSource, sha: &str) -> Result<Vec<u8>, AppError> {
    let canonical = format!(
        "https://api.github.com/repos/{}/{}/git/blobs/{}",
        source.owner,
        source.repo,
        urlencoding::encode(sha)
    );
    let blob = fetch_github_blob(&canonical).await?;
    if blob.encoding != "base64" {
        return Err(AppError::message(format!(
            "unsupported GitHub blob encoding: {}",
            blob.encoding
        )));
    }
    if blob.size as usize > MAX_ARCHIVE_BYTES {
        return Err(AppError::message("skill source is too large"));
    }
    let encoded: String = blob
        .content
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect();
    base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|e| AppError::message(format!("invalid GitHub blob base64: {e}")))
}

async fn github_contents(
    source: &SkillSource,
    reference: &str,
    path: &str,
) -> Result<Vec<GithubContentEntry>, AppError> {
    let canonical = if path.trim_matches('/').is_empty() {
        format!(
            "https://api.github.com/repos/{}/{}/contents?ref={}",
            source.owner,
            source.repo,
            urlencoding::encode(reference)
        )
    } else {
        format!(
            "https://api.github.com/repos/{}/{}/contents/{}?ref={}",
            source.owner,
            source.repo,
            encode_github_path(path),
            urlencoding::encode(reference)
        )
    };
    let response = fetch_github_contents(&canonical).await?;
    match response {
        GithubContentsResponse::Entry(entry) => Ok(vec![entry]),
        GithubContentsResponse::Entries(entries) => Ok(entries),
    }
}

async fn github_tree(source: &SkillSource, reference: &str) -> Result<GithubTree, AppError> {
    let canonical = format!(
        "https://api.github.com/repos/{}/{}/git/trees/{}?recursive=1",
        source.owner,
        source.repo,
        urlencoding::encode(reference)
    );
    fetch_github_tree(&canonical).await
}

async fn fetch_github_tree(canonical: &str) -> Result<GithubTree, AppError> {
    if let Some(tree) =
        fetch_github_api_json_via_gh::<GithubTree>(canonical, "invalid GitHub tree response")
            .await?
    {
        return Ok(tree);
    }
    fetch_github_tree_once(canonical).await
}

async fn fetch_github_tree_once(url: &str) -> Result<GithubTree, AppError> {
    let client = crate::http::client_builder()
        .timeout(Duration::from_secs(20))
        .user_agent("Agentero/skill-import")
        .build()
        .map_err(|e| AppError::message(format!("http client: {e}")))?;
    let request = client
        .get(url)
        .header("Accept", "application/vnd.github+json");
    let response = crate::http::with_github_api_auth(request, url)
        .send()
        .await
        .map_err(|e| AppError::message(format!("skill tree request: {e}")))?;
    if !response.status().is_success() {
        return Err(AppError::message(format!(
            "GitHub tree request failed: {}",
            response.status()
        )));
    }
    response
        .json()
        .await
        .map_err(|e| AppError::message(format!("invalid GitHub tree response: {e}")))
}

async fn fetch_github_blob(canonical: &str) -> Result<GithubBlob, AppError> {
    if let Some(blob) =
        fetch_github_api_json_via_gh::<GithubBlob>(canonical, "invalid GitHub blob response")
            .await?
    {
        return Ok(blob);
    }
    fetch_github_blob_once(canonical).await
}

async fn fetch_github_blob_once(url: &str) -> Result<GithubBlob, AppError> {
    let client = crate::http::client_builder()
        .timeout(Duration::from_secs(20))
        .user_agent("Agentero/skill-import")
        .build()
        .map_err(|e| AppError::message(format!("http client: {e}")))?;
    let request = client
        .get(url)
        .header("Accept", "application/vnd.github+json");
    let response = crate::http::with_github_api_auth(request, url)
        .send()
        .await
        .map_err(|e| AppError::message(format!("skill blob request: {e}")))?;
    if !response.status().is_success() {
        return Err(AppError::message(format!(
            "GitHub blob request failed: {}",
            response.status()
        )));
    }
    response
        .json()
        .await
        .map_err(|e| AppError::message(format!("invalid GitHub blob response: {e}")))
}

async fn fetch_github_contents(canonical: &str) -> Result<GithubContentsResponse, AppError> {
    if let Some(response) = fetch_github_api_json_via_gh::<GithubContentsResponse>(
        canonical,
        "invalid GitHub contents response",
    )
    .await?
    {
        return Ok(response);
    }
    fetch_github_json_once(canonical).await
}

async fn fetch_github_json_once(url: &str) -> Result<GithubContentsResponse, AppError> {
    let client = crate::http::client_builder()
        .timeout(Duration::from_secs(20))
        .user_agent("Agentero/skill-import")
        .build()
        .map_err(|e| AppError::message(format!("http client: {e}")))?;
    let request = client
        .get(url)
        .header("Accept", "application/vnd.github+json");
    let response = crate::http::with_github_api_auth(request, url)
        .send()
        .await
        .map_err(|e| AppError::message(format!("skill contents request: {e}")))?;
    if !response.status().is_success() {
        return Err(AppError::message(format!(
            "GitHub contents request failed: {}",
            response.status()
        )));
    }
    response
        .json()
        .await
        .map_err(|e| AppError::message(format!("invalid GitHub contents response: {e}")))
}

fn encode_github_path(path: &str) -> String {
    path.split('/')
        .filter(|part| !part.is_empty())
        .map(urlencoding::encode)
        .collect::<Vec<_>>()
        .join("/")
}

fn write_staged_github_file(root: &Path, path: &str, bytes: &[u8]) -> Result<(), AppError> {
    let relative = sanitize_github_path(path)?;
    let target = root.join(relative);
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(target, bytes)?;
    Ok(())
}

fn sanitize_github_path(path: &str) -> Result<PathBuf, AppError> {
    let mut out = PathBuf::new();
    for part in path.split('/') {
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".." || part.contains('\\') {
            return Err(AppError::message("GitHub path traversal rejected"));
        }
        out.push(part);
    }
    if out.as_os_str().is_empty() {
        return Err(AppError::message("GitHub path is empty"));
    }
    Ok(out)
}

pub async fn install_discovered_skills(
    vault: &Path,
    discovery_id: &str,
    selected_names: &[String],
) -> Result<Vec<SkillImportResult>, AppError> {
    crate::fs::ensure_vault_dir(vault)?;
    let temp = discovery_dir(discovery_id)?;
    let metadata: serde_json::Value = serde_json::from_slice(&fs::read(temp.join("source.json"))?)?;
    let source: SkillSource = serde_json::from_value(
        metadata
            .get("source")
            .cloned()
            .ok_or_else(|| AppError::message("skill discovery metadata is invalid"))?,
    )?;
    let reference = metadata
        .get("reference")
        .and_then(|value| value.as_str())
        .ok_or_else(|| AppError::message("skill discovery reference is missing"))?;
    let result =
        install_from_sparse_discovery(&temp, vault, &source, reference, selected_names).await;
    let _ = fs::remove_dir_all(&temp);
    result
}

pub fn discard_skill_discovery(discovery_id: &str) -> Result<(), AppError> {
    let temp = discovery_dir(discovery_id)?;
    if temp.exists() {
        fs::remove_dir_all(temp)?;
    }
    Ok(())
}

async fn install_from_sparse_discovery(
    temp: &Path,
    vault: &Path,
    source: &SkillSource,
    reference: &str,
    selected_names: &[String],
) -> Result<Vec<SkillImportResult>, AppError> {
    let candidates: Vec<SparseSkillCandidate> =
        serde_json::from_slice(&fs::read(temp.join(SPARSE_CANDIDATES_FILE))?)?;
    let candidates: Vec<_> = candidates
        .into_iter()
        .filter(|candidate| {
            selected_names.is_empty()
                || selected_names
                    .iter()
                    .any(|name| name == "*" || name == &candidate.name)
        })
        .collect();
    if candidates.is_empty() {
        return Err(AppError::message("no selected Skill remains to install"));
    }

    let skills_root = vault.join(".agents/skills");
    fs::create_dir_all(&skills_root)?;
    let payload_root = temp.join("payload");
    let mut results = Vec::with_capacity(candidates.len());
    for candidate in candidates {
        let target = skills_root.join(&candidate.name);
        let relative_path = format!(".agents/skills/{}", candidate.name);
        if target.exists() {
            results.push(SkillImportResult {
                name: candidate.name,
                description: candidate.description,
                path: relative_path,
                source: source.source.clone(),
                skipped: true,
            });
            continue;
        }

        fetch_github_subpath_to_root(source, reference, &candidate.path, &payload_root).await?;
        let staged_dir = if candidate.path.is_empty() {
            payload_root.clone()
        } else {
            payload_root.join(sanitize_github_path(&candidate.path)?)
        };
        copy_dir(&staged_dir, &target)?;
        let provenance = serde_json::json!({
            "source": source.source,
            "owner": source.owner,
            "repo": source.repo,
            "reference": reference,
            "installedAt": crate::time::now_rfc3339_millis(),
        });
        fs::write(
            target.join("agentero-skill.json"),
            serde_json::to_vec_pretty(&provenance)?,
        )?;
        results.push(SkillImportResult {
            name: candidate.name,
            description: candidate.description,
            path: relative_path,
            source: source.source.clone(),
            skipped: false,
        });
    }
    Ok(results)
}

fn discovery_dir(discovery_id: &str) -> Result<PathBuf, AppError> {
    let id = uuid::Uuid::parse_str(discovery_id)
        .map_err(|_| AppError::message("invalid skill discovery id"))?;
    Ok(std::env::temp_dir().join(format!("agentero-skill-discovery-{id}")))
}

fn parse_skill_metadata(content: &str) -> Result<(String, String), AppError> {
    let frontmatter = frontmatter_block(content)
        .ok_or_else(|| AppError::message("SKILL.md is missing YAML frontmatter"))?;
    let name = scalar_field(frontmatter, "name")
        .filter(|name| valid_skill_name(name))
        .ok_or_else(|| {
            AppError::message(
                "SKILL.md has an invalid name; use lowercase letters, numbers, and hyphens",
            )
        })?;
    let description = scalar_field(frontmatter, "description").unwrap_or_default();
    Ok((name, truncate_chars(&description, MAX_DESCRIPTION_LEN)))
}

fn truncate_chars(value: &str, max: usize) -> String {
    match value.char_indices().nth(max) {
        Some((index, _)) => format!("{}…", value[..index].trim_end()),
        None => value.to_string(),
    }
}

fn valid_skill_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_SKILL_NAME_LEN
        && value
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        && !value.starts_with('-')
        && !value.ends_with('-')
}

fn copy_dir(source: &Path, target: &Path) -> Result<(), AppError> {
    for entry in WalkDir::new(source).into_iter().filter_map(Result::ok) {
        let relative = entry
            .path()
            .strip_prefix(source)
            .map_err(|e| AppError::message(format!("skill path: {e}")))?;
        let destination = target.join(relative);
        if entry.file_type().is_dir() {
            fs::create_dir_all(&destination)?;
        } else if entry.file_type().is_file() {
            if let Some(parent) = destination.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::copy(entry.path(), destination)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_skill_names() {
        assert!(valid_skill_name("frontend-design"));
        assert!(!valid_skill_name("Frontend Design"));
        assert!(!valid_skill_name("../escape"));
    }

    #[test]
    fn parses_frontmatter() {
        let (name, description) = parse_skill_metadata(
            "---\nname: example-skill\ndescription: Useful instructions\n---\n# Body",
        )
        .unwrap();
        assert_eq!(name, "example-skill");
        assert_eq!(description, "Useful instructions");
    }

    #[test]
    fn derives_gh_api_endpoint_only_for_direct_github_api_urls() {
        assert_eq!(
            github_api_endpoint("https://api.github.com/repos/o/r/contents/skills/pptx?ref=main")
                .as_deref(),
            Some("/repos/o/r/contents/skills/pptx?ref=main")
        );
        assert_eq!(
            github_api_endpoint("https://codeload.github.com/o/r/tar.gz/main").as_deref(),
            None
        );
    }

    #[test]
    fn reads_folded_description() {
        let (_, description) = parse_skill_metadata(
            "---\nname: paper-reader\nversion: 2\ndescription: >-\n  Read and explain a\n  research paper.\n---\n# Body",
        )
        .unwrap();
        assert_eq!(description, "Read and explain a research paper.");
    }

    #[test]
    fn truncates_long_description_instead_of_failing() {
        let long = "研究".repeat(MAX_DESCRIPTION_LEN);
        let content = format!("---\nname: deep-research\ndescription: \"{long}\"\n---\n# Body");
        let (name, description) = parse_skill_metadata(&content).unwrap();
        assert_eq!(name, "deep-research");
        assert_eq!(description.chars().count(), MAX_DESCRIPTION_LEN + 1);
        assert!(description.ends_with('…'));
    }

    #[test]
    fn maps_sparse_tree_candidates_without_downloading_payload() {
        let tag = format!("agentero-skill-sparse-{}", std::process::id());
        let vault = std::env::temp_dir().join(&tag);
        let _ = fs::remove_dir_all(&vault);
        fs::create_dir_all(vault.join(".agents/skills/nature-paper2ppt")).unwrap();

        let source = SkillSource {
            owner: "Yuan1z0825".into(),
            repo: "nature-skills".into(),
            reference: Some("main".into()),
            subpath: Some("skills/nature-paper2ppt".into()),
            skill_names: Vec::new(),
            source: "https://github.com/Yuan1z0825/nature-skills/tree/main/skills/nature-paper2ppt"
                .into(),
        };
        let candidates = sparse_skill_candidates(
            &vault,
            &source,
            vec![SparseSkillCandidate {
                path: "skills/nature-paper2ppt".into(),
                name: "nature-paper2ppt".into(),
                description: "Paper to PPT".into(),
            }],
        );
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].name, "nature-paper2ppt");
        assert_eq!(candidates[0].relative_path, "skills/nature-paper2ppt");
        assert!(candidates[0].already_installed);

        let _ = fs::remove_dir_all(&vault);
    }
}
