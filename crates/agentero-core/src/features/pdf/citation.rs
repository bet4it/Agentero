//! Resolve agent inline citation fragments to PDF layout coordinates.
//!
//! Citation links from agents look like:
//!   `papers/<id>/PAPER.md#section=2.3`
//!   `papers/<id>/<id>.pdf#figure=1`
//!   `papers/<id>/<id>.pdf#region=figure-1`
//!   `papers/<id>/<id>.pdf#page=3`
//!
//! The resolver maps those fragments to a page index and normalized bbox so the
//! PDF viewer can jump directly to the cited location.

use crate::error::AppError;
use crate::features::pdf::layout_index::{
    self, Bbox, LayoutIndexItem, RawLayoutRegion as LayoutRegion,
};
use crate::fs::sanitize_vault_rel;
use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CitationTarget {
    /// Vault-relative paper folder path (`papers/<id>`).
    pub paper_path: String,
    /// Vault-relative path from the citation link.
    pub path: String,
    /// Raw fragment (e.g. `figure=1`).
    pub fragment: String,
    /// 0-based page index for the PDF viewer.
    pub page_index: u32,
    /// Normalized page bbox (0–1) to scroll to and highlight.
    pub bbox: Bbox,
    /// Human-readable title when available.
    pub title: Option<String>,
    /// Region id suitable for the PDF highlight registry.
    pub region_id: String,
}

/// Parse a citation source into `(path, fragment)`.
///
/// Accepts vault-relative paths with an optional leading `/` and an optional
/// `#key=value` fragment.
pub fn parse_citation_source(source: &str) -> Option<(String, String)> {
    let trimmed = source.trim();
    if trimmed.is_empty() {
        return None;
    }
    let without_prefix = trimmed.strip_prefix('/').unwrap_or(trimmed);
    let (path, fragment) = match without_prefix.find('#') {
        Some(idx) => (
            without_prefix[..idx].to_string(),
            without_prefix[idx + 1..].to_string(),
        ),
        None => (without_prefix.to_string(), String::new()),
    };
    if path.is_empty() {
        return None;
    }
    Some((path, fragment))
}

/// Resolve a citation source against the local vault.
pub fn resolve_citation(vault: &Path, source: &str) -> Result<CitationTarget, AppError> {
    let (path, fragment) = parse_citation_source(source)
        .ok_or_else(|| AppError::domain("citation_invalid_source", "empty citation source"))?;
    if fragment.is_empty() {
        return Err(AppError::domain(
            "citation_no_fragment",
            "citation has no fragment to resolve",
        ));
    }
    let paper_dir = resolve_paper_dir(vault, &path)?;
    let paper_rel = vault_relative(vault, &paper_dir)?;

    let decoded = urlencoding::decode(&fragment).map_err(|_| {
        AppError::domain("citation_malformed_fragment", "invalid fragment encoding")
    })?;
    let target = if !decoded.contains('=') && path.to_ascii_lowercase().ends_with(".pdf") {
        let requested_pdf = vault.join(sanitize_vault_rel(&path).map_err(AppError::message)?);
        if !requested_pdf.is_file() {
            return Err(AppError::domain(
                "citation_target_missing",
                format!("PDF target `{path}` not found"),
            ));
        }
        if crate::features::paper::capabilities::find_local_pdf(&paper_dir).as_ref()
            != Some(&requested_pdf)
        {
            return Err(AppError::domain(
                "citation_layout_missing",
                "paragraph anchors require the paper's primary PDF layout",
            ));
        }
        let item = layout_index::resolve_document_anchor(vault, &paper_rel, &decoded)?;
        (&item).into()
    } else {
        let (key, value) = decoded.split_once('=').ok_or_else(|| {
            AppError::domain(
                "citation_malformed_fragment",
                format!("fragment must be key=value, got `{fragment}`"),
            )
        })?;
        match key {
            "section" => resolve_section(vault, &paper_rel, value),
            "figure" | "table" | "algorithm" | "formula" => {
                resolve_layout_index_by_number(vault, &paper_rel, key, value)
            }
            "region" => resolve_region(vault, &paper_rel, value),
            "page" => resolve_page(value),
            other => Err(AppError::domain(
                "citation_unknown_fragment",
                format!("unsupported citation fragment `{other}`"),
            )),
        }?
    };

    Ok(CitationTarget {
        paper_path: paper_rel,
        path,
        fragment,
        page_index: target.page_index,
        bbox: target.bbox,
        title: target.title,
        region_id: target.region_id,
    })
}

#[derive(Debug)]
struct ResolvedFragment {
    page_index: u32,
    bbox: Bbox,
    title: Option<String>,
    region_id: String,
}

fn resolve_paper_dir(vault: &Path, path: &str) -> Result<PathBuf, AppError> {
    let rel = sanitize_vault_rel(path).map_err(AppError::message)?;
    let abs = vault.join(&rel);
    let mut current = abs.as_path();
    while let Some(parent) = current.parent() {
        if !parent.starts_with(vault) {
            break;
        }
        if is_paper_folder(parent) {
            return Ok(parent.to_path_buf());
        }
        current = parent;
    }
    Err(AppError::domain(
        "citation_paper_not_found",
        format!("cannot locate paper folder for `{path}`"),
    ))
}

fn is_paper_folder(dir: &Path) -> bool {
    dir.join("NOTES.md").is_file()
        || dir.join("metadata.json").is_file()
        || dir.join("PAPER.md").is_file()
}

fn vault_relative(vault: &Path, abs: &Path) -> Result<String, AppError> {
    abs.strip_prefix(vault)
        .map_err(|_| AppError::domain("citation_path", "resolved paper dir is outside vault"))?
        .to_str()
        .map(|s| s.replace('\\', "/"))
        .ok_or_else(|| AppError::domain("citation_path", "paper path is not valid UTF-8"))
}

fn resolve_section(
    vault: &Path,
    paper_path: &str,
    heading: &str,
) -> Result<ResolvedFragment, AppError> {
    let raw = layout_index::load_raw_layout(vault, paper_path)?;
    let headers: Vec<&LayoutRegion> = raw.regions.iter().filter(|r| r.kind == "header").collect();
    let needle = normalize_heading(heading);

    if heading
        .split('.')
        .all(|part| !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit()))
    {
        return layout_index::resolve_document_anchor(vault, paper_path, heading)
            .map(|i| (&i).into());
    }
    if let Some(n) = parse_section_number(&needle) {
        return layout_index::resolve_document_anchor(vault, paper_path, &n.to_string())
            .map(|i| (&i).into());
    }

    let mut candidates: Vec<(f64, &LayoutRegion)> = Vec::new();
    for region in headers {
        let text = region
            .title
            .as_deref()
            .or(region.text.as_deref())
            .unwrap_or("");
        let normalized = normalize_heading(text);
        if normalized == needle {
            return Ok(region.into());
        }
        let score = heading_similarity(&needle, &normalized);
        if score >= 0.35 {
            candidates.push((score, region));
        }
    }

    candidates.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    let best = candidates
        .into_iter()
        .map(|(_, r)| r)
        .next()
        .ok_or_else(|| {
            AppError::domain(
                "citation_section_not_found",
                format!("no header matching `{heading}` in {paper_path}/source/layout.json"),
            )
        })?;
    Ok(best.into())
}

fn resolve_layout_index_by_number(
    vault: &Path,
    paper_path: &str,
    section: &str,
    number: &str,
) -> Result<ResolvedFragment, AppError> {
    let n: usize = number.parse().map_err(|_| {
        AppError::domain(
            "citation_bad_number",
            format!("`{section}` citation expects a number, got `{number}`"),
        )
    })?;

    // Try the most likely sidebar id first (e.g. `figure-1`).
    let likely_id = format!("{section}-{n}");
    if let Ok(result) = layout_index::get_region(vault, paper_path, &likely_id) {
        return Ok((&result.item).into());
    }

    let listed = layout_index::list_regions(vault, paper_path, &[], None)?;
    let matches: Vec<&LayoutIndexItem> = listed
        .items
        .iter()
        .filter(|item| item_matches_numbered_citation(item, section, n))
        .collect();

    let item = matches.into_iter().next().ok_or_else(|| {
        AppError::domain(
            "citation_region_not_found",
            format!("no {section} {n} found in {paper_path}/source/layout-index.json"),
        )
    })?;
    Ok(item.into())
}

fn resolve_region(
    vault: &Path,
    paper_path: &str,
    region_id: &str,
) -> Result<ResolvedFragment, AppError> {
    let result = layout_index::get_region(vault, paper_path, region_id)?;
    Ok((&result.item).into())
}

fn resolve_page(value: &str) -> Result<ResolvedFragment, AppError> {
    let page: u32 = value.parse().map_err(|_| {
        AppError::domain(
            "citation_bad_page",
            format!("`page` citation expects a 1-based number, got `{value}`"),
        )
    })?;
    if page == 0 {
        return Err(AppError::domain(
            "citation_bad_page",
            "page number must be >= 1",
        ));
    }
    Ok(ResolvedFragment {
        page_index: page - 1,
        bbox: Bbox {
            x: 0.0,
            y: 0.0,
            w: 1.0,
            h: 1.0,
        },
        title: Some(format!("Page {page}")),
        region_id: format!("page-{page}"),
    })
}

fn item_matches_numbered_citation(item: &LayoutIndexItem, section: &str, n: usize) -> bool {
    if item.section != section {
        return false;
    }
    if item.id == format!("{section}-{n}") {
        return true;
    }
    let title = item.title.as_deref().unwrap_or("");
    let normalized = normalize_caption_title(title);
    caption_contains_numbered_label(&normalized, section, n)
}

/// True when a normalized caption contains a numbered label for `section`/`n`
/// (e.g. `model overview fig 3 is trained` matches figure 3).
fn caption_contains_numbered_label(normalized: &str, section: &str, n: usize) -> bool {
    // Token-boundary checks so `fig 1` does not match `fig 10`, and so OCR
    // titles that put the label mid-string still match.
    let tokens: Vec<&str> = normalized.split_whitespace().collect();
    match section {
        "figure" => numbered_label_in_tokens(&tokens, &["figure", "fig"], n),
        "table" => numbered_label_in_tokens(&tokens, &["table", "tab"], n),
        "algorithm" => numbered_label_in_tokens(&tokens, &["algorithm", "alg"], n),
        "formula" => {
            let n_str = n.to_string();
            let paren = format!("({n})");
            tokens.iter().any(|t| *t == n_str || *t == paren.as_str())
                || normalized.contains(&format!("( {n} )"))
                || normalized.contains(&paren)
        }
        _ => false,
    }
}

fn numbered_label_in_tokens(tokens: &[&str], labels: &[&str], n: usize) -> bool {
    let n_str = n.to_string();
    tokens
        .windows(2)
        .any(|w| labels.contains(&w[0]) && w[1] == n_str)
}

fn normalize_heading(text: &str) -> String {
    text.to_lowercase()
        .replace(['\u{00A0}', '\t'], " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn normalize_caption_title(text: &str) -> String {
    text.to_lowercase()
        .replace(['\u{00A0}', '\t', ':', '.'], " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn parse_section_number(needle: &str) -> Option<u32> {
    let trimmed = needle.trim().trim_end_matches('.');
    if let Ok(n) = trimmed.parse::<u32>() {
        return (1..=20).contains(&n).then_some(n);
    }
    from_roman(trimmed)
}

fn from_roman(text: &str) -> Option<u32> {
    let s = text.to_lowercase();
    if s.is_empty() || !s.chars().all(|c| matches!(c, 'i' | 'v' | 'x')) {
        return None;
    }
    let mut total = 0i32;
    let mut prev = 0i32;
    for c in s.chars().rev() {
        let v = match c {
            'i' => 1,
            'v' => 5,
            'x' => 10,
            _ => return None,
        };
        if v < prev {
            total -= v;
        } else {
            total += v;
            prev = v;
        }
    }
    (total > 0 && total <= 20).then_some(total as u32)
}

fn heading_similarity(needle: &str, text: &str) -> f64 {
    // Exact substring match is preferred, but reject bare digit needles that
    // merely appear inside longer OCR tokens / citations.
    if text == needle {
        return 1.0;
    }
    if text.contains(needle) {
        if needle.chars().all(|c| c.is_ascii_digit()) && needle.len() <= 2 {
            return 0.0;
        }
        return 1.0;
    }
    // Number-only needle ("2.3") also matches as a standalone token.
    if needle.contains('.')
        && needle
            .split_whitespace()
            .all(|part| text.split_whitespace().any(|token| token == part))
    {
        return 0.9;
    }
    // Token overlap for headings with extra words.
    let needle_tokens: std::collections::HashSet<&str> = needle.split_whitespace().collect();
    let text_tokens: std::collections::HashSet<&str> = text.split_whitespace().collect();
    if needle_tokens.is_empty() {
        return 0.0;
    }
    // Single short token needles are too ambiguous for overlap scoring.
    if needle_tokens.len() == 1 {
        let only = *needle_tokens.iter().next().unwrap();
        if only.len() <= 2 {
            return 0.0;
        }
    }
    let intersection: Vec<_> = needle_tokens.intersection(&text_tokens).collect();
    intersection.len() as f64 / needle_tokens.len() as f64
}

impl From<&LayoutRegion> for ResolvedFragment {
    fn from(region: &LayoutRegion) -> Self {
        Self {
            page_index: region.page_index,
            bbox: region.bbox.clone(),
            title: region.title.clone().or_else(|| region.text.clone()),
            region_id: region.id.clone(),
        }
    }
}

impl From<&LayoutIndexItem> for ResolvedFragment {
    fn from(item: &LayoutIndexItem) -> Self {
        Self {
            page_index: item.page_index,
            bbox: item.bbox.clone(),
            title: item.title.clone(),
            region_id: item.layout_region_id.clone(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    fn make_paper(vault: &Path, paper: &str) -> PathBuf {
        let dir = vault.join(paper);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("NOTES.md"), "# Notes").unwrap();
        fs::create_dir(dir.join("source")).unwrap();
        dir
    }

    fn write_raw_layout(paper: &Path, body: &str) {
        fs::write(paper.join("source").join("layout.json"), body).unwrap();
    }

    fn write_index(paper: &Path, body: &str) {
        fs::write(paper.join("source").join("layout-index.json"), body).unwrap();
    }

    #[test]
    fn resolves_section_header() {
        let dir = tempdir().unwrap();
        let vault = dir.path();
        let paper = make_paper(vault, "papers/p1");
        write_raw_layout(
            &paper,
            r#"{
                "schemaVersion": 3,
                "source": {"mode": "embedpdf-layout", "generatedAt": "t"},
                "regions": [
                  {"id":"h1","pageIndex":2,"kind":"header","label":"header","score":0.9,"readingOrder":1,"rect":{"x":0,"y":0,"w":1,"h":1},"bbox":{"x":0.1,"y":0.2,"w":0.8,"h":0.05},"title":"2.3 Method"}
                ]
            }"#,
        );
        let target = resolve_citation(vault, "papers/p1/PAPER.md#section=2.3").unwrap();
        assert_eq!(target.page_index, 2);
        assert_eq!(target.region_id, "h1");
        assert!((target.bbox.y - 0.2).abs() < 1e-9);
    }

    #[test]
    fn resolves_figure_by_number() {
        let dir = tempdir().unwrap();
        let vault = dir.path();
        let paper = make_paper(vault, "papers/p1");
        write_index(
            &paper,
            r#"{
                "schemaVersion": 1,
                "source": {"mode": "sidebar", "from": "layout.json", "generatedAt": "t", "minScore": 0.3},
                "items": [
                  {"id":"figure-1","stableKey":"a","kind":"image","section":"figure","page":2,"pageIndex":1,"bbox":{"x":0,"y":0,"w":1,"h":1},"score":0.9,"title":"Figure 1: overview","layoutRegionId":"r1"}
                ]
            }"#,
        );
        let target = resolve_citation(vault, "papers/p1/p1.pdf#figure=1").unwrap();
        assert_eq!(target.page_index, 1);
        assert_eq!(target.region_id, "r1");
    }

    #[test]
    fn resolves_page_fragment() {
        let dir = tempdir().unwrap();
        let vault = dir.path();
        let _paper = make_paper(vault, "papers/p1");
        let target = resolve_citation(vault, "papers/p1/p1.pdf#page=5").unwrap();
        assert_eq!(target.page_index, 4);
        assert_eq!(target.region_id, "page-5");
    }

    #[test]
    fn resolves_figure_when_label_is_mid_caption() {
        let dir = tempdir().unwrap();
        let vault = dir.path();
        let paper = make_paper(vault, "papers/p1");
        write_index(
            &paper,
            r#"{
                "schemaVersion": 1,
                "source": {"mode": "sidebar", "from": "layout.json", "generatedAt": "t", "minScore": 0.3},
                "items": [
                  {"id":"figure-p4-x","stableKey":"a","kind":"image","section":"figure","page":4,"pageIndex":3,"bbox":{"x":0,"y":0,"w":1,"h":1},"score":0.9,"title":"Model overview. Fig. 3: is trained in two stages.","layoutRegionId":"r3"},
                  {"id":"figure-10","stableKey":"b","kind":"image","section":"figure","page":10,"pageIndex":9,"bbox":{"x":0,"y":0,"w":1,"h":1},"score":0.9,"title":"Fig. 10: Training recipe ablations","layoutRegionId":"r10"}
                ]
            }"#,
        );
        let fig3 = resolve_citation(vault, "papers/p1/p1.pdf#figure=3").unwrap();
        assert_eq!(fig3.region_id, "r3");
        assert_eq!(fig3.page_index, 3);
        // Must not confuse figure 1 with figure 10.
        let fig10 = resolve_citation(vault, "papers/p1/p1.pdf#figure=10").unwrap();
        assert_eq!(fig10.region_id, "r10");
        assert!(resolve_citation(vault, "papers/p1/p1.pdf#figure=1").is_err());
    }

    #[test]
    fn resolves_section_arabic_to_ieee_roman() {
        let dir = tempdir().unwrap();
        let vault = dir.path();
        let paper = make_paper(vault, "papers/p1");
        write_raw_layout(
            &paper,
            r#"{
                "schemaVersion": 3,
                "source": {"mode": "embedpdf-layout", "generatedAt": "t"},
                "regions": [
                  {"id":"noise","pageIndex":0,"kind":"header","label":"header","score":0.9,"readingOrder":0,"rect":{"x":0,"y":0,"w":1,"h":1},"bbox":{"x":0.1,"y":0.1,"w":0.8,"h":0.05},"title":"arXiv:2504.16054v1 [cs.LG] 22 Apr 2025"},
                  {"id":"h3","pageIndex":3,"kind":"header","label":"header","score":0.9,"readingOrder":1,"rect":{"x":0,"y":0,"w":1,"h":1},"bbox":{"x":0.1,"y":0.2,"w":0.8,"h":0.05},"title":"III. P RELIMINARIES"},
                  {"id":"h1","pageIndex":1,"kind":"header","label":"header","score":0.9,"readingOrder":2,"rect":{"x":0,"y":0,"w":1,"h":1},"bbox":{"x":0.1,"y":0.3,"w":0.8,"h":0.05},"title":"I. I NTRODUCTION"}
                ]
            }"#,
        );
        let s3 = resolve_citation(vault, "papers/p1/PAPER.md#section=3").unwrap();
        assert_eq!(s3.region_id, "h3");
        assert_eq!(s3.page_index, 3);
        let s_roman = resolve_citation(vault, "papers/p1/PAPER.md#section=III").unwrap();
        assert_eq!(s_roman.region_id, "h3");
        let s1 = resolve_citation(vault, "papers/p1/PAPER.md#section=1").unwrap();
        assert_eq!(s1.region_id, "h1");
    }

    #[test]
    fn rejects_bare_digit_section_against_ocr_noise() {
        let dir = tempdir().unwrap();
        let vault = dir.path();
        let paper = make_paper(vault, "papers/p1");
        write_raw_layout(
            &paper,
            r#"{
                "schemaVersion": 3,
                "source": {"mode": "embedpdf-layout", "generatedAt": "t"},
                "regions": [
                  {"id":"noise","pageIndex":0,"kind":"header","label":"header","score":0.9,"readingOrder":0,"rect":{"x":0,"y":0,"w":1,"h":1},"bbox":{"x":0.1,"y":0.1,"w":0.8,"h":0.05},"title":"arXiv:2504.16054v1 [cs.LG] 22 Apr 2025"},
                  {"id":"intro","pageIndex":1,"kind":"header","label":"header","score":0.9,"readingOrder":1,"rect":{"x":0,"y":0,"w":1,"h":1},"bbox":{"x":0.1,"y":0.2,"w":0.8,"h":0.05},"title":"Introduction"}
                ]
            }"#,
        );
        assert!(resolve_citation(vault, "papers/p1/PAPER.md#section=3").is_err());
        // Bare roman `i` must not match the word "Introduction".
        assert!(resolve_citation(vault, "papers/p1/PAPER.md#section=1").is_err());
    }

    #[test]
    fn caption_label_helpers() {
        assert!(caption_contains_numbered_label(
            "model overview fig 3 is trained",
            "figure",
            3
        ));
        assert!(!caption_contains_numbered_label(
            "fig 10 training",
            "figure",
            1
        ));
        assert_eq!(parse_section_number("iii"), Some(3));
        assert_eq!(parse_section_number("3"), Some(3));
    }
    #[test]
    fn paragraph_citations_repair_interleaved_columns_in_existing_layouts() {
        let real: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../../test/fixtures/pdf-paragraph-anchors/easysteer-layout.json"
        ))
        .unwrap();
        let mut cases: Vec<serde_json::Value> = serde_json::from_str(include_str!(
            "../../../../../test/fixtures/pdf-paragraph-anchors/reading-order-cases.json"
        ))
        .unwrap();
        cases.push(real);
        for case in cases {
            let dir = tempdir().unwrap();
            let paper = make_paper(dir.path(), "papers/p1");
            fs::write(paper.join("p1.pdf"), b"%PDF fixture").unwrap();
            write_raw_layout(&paper, &case.to_string());
            let listed = layout_index::list_regions(
                dir.path(),
                "papers/p1",
                &["section".into(), "paragraph".into()],
                None,
            )
            .unwrap();
            let expected = case["expectedAnchors"].as_object().unwrap();
            assert_eq!(listed.items.len(), expected.len());
            for item in listed.items {
                let anchor = item.anchor.as_deref().unwrap();
                assert_eq!(anchor, expected[&item.id].as_str().unwrap(), "{}", item.id);
                let resolved =
                    resolve_citation(dir.path(), &format!("papers/p1/p1.pdf{anchor}")).unwrap();
                assert_eq!(resolved.region_id, item.id);
                assert_eq!(resolved.page_index, item.page_index);
                assert_eq!(
                    serde_json::to_value(resolved.bbox).unwrap(),
                    serde_json::to_value(item.bbox).unwrap()
                );
            }
        }
    }

    #[test]
    fn published_paragraph_queries_and_citations_resolve_identically() {
        let dir = tempdir().unwrap();
        let paper = make_paper(dir.path(), "papers/p1");
        fs::write(paper.join("p1.pdf"), b"%PDF fixture").unwrap();
        write_raw_layout(
            &paper,
            include_str!("../../../../../test/fixtures/pdf-paragraph-anchors/layout.json"),
        );
        let listed =
            layout_index::list_regions(dir.path(), "papers/p1", &["paragraph".into()], Some(0.5))
                .unwrap();
        assert_eq!(listed.items.len(), 3);
        for item in listed.items {
            let anchor = item.anchor.unwrap();
            let target =
                resolve_citation(dir.path(), &format!("papers/p1/p1.pdf{anchor}")).unwrap();
            assert_eq!(target.region_id, item.layout_region_id);
            assert_eq!(target.page_index, item.page_index);
            assert_eq!(
                serde_json::to_value(target.bbox).unwrap(),
                serde_json::to_value(item.bbox).unwrap()
            );
        }
        let target = resolve_citation(dir.path(), "papers/p1/p1.pdf#2%23p2").unwrap();
        assert_eq!(target.region_id, "body-2");
        fs::create_dir_all(paper.join("attachments")).unwrap();
        fs::write(paper.join("attachments/other.pdf"), b"%PDF other").unwrap();
        assert!(resolve_citation(dir.path(), "papers/p1/attachments/other.pdf#2#p1").is_err());
        let legacy = resolve_citation(dir.path(), "papers/p1/p1.pdf#section=2").unwrap();
        assert_eq!(legacy.region_id, "h2");
        for href in [
            "papers/p1/p1.pdf#2#p0",
            "papers/p1/p1.pdf#2#p3",
            "papers/p1/p1.pdf#2.10",
            "papers/p1/missing.pdf#2#p1",
            "papers/p1/NOTES.md#2#p1",
        ] {
            assert!(resolve_citation(dir.path(), href).is_err(), "{href}");
        }
    }
}
