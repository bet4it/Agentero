//! The paper's own GitHub repository, taken from the first PDF page.
//!
//! Author footnotes and abstract links live on page 1. Later pages are left
//! alone so a bibliography full of other papers' repositories is not stored
//! as this paper's `code_repo`.

use std::path::PathBuf;

/// Site sections that share `github.com/{name}` with user accounts.
const RESERVED_OWNERS: &[&str] = &[
    "about",
    "account",
    "apps",
    "codespaces",
    "collections",
    "copilot",
    "customer-stories",
    "education",
    "enterprise",
    "events",
    "explore",
    "features",
    "github",
    "issues",
    "join",
    "login",
    "logout",
    "marketplace",
    "new",
    "nonprofit",
    "notifications",
    "open-source",
    "organizations",
    "orgs",
    "pricing",
    "pulls",
    "readme",
    "search",
    "security",
    "sessions",
    "settings",
    "signup",
    "site",
    "solutions",
    "sponsors",
    "team",
    "topics",
    "trending",
    "watching",
];

/// First `https://github.com/{owner}/{repo}` among link annotations, then
/// among printed text. Annotation order is the page's link order; printed
/// URLs are scanned after whitespace (including line breaks) is removed.
pub fn first_github_repo<'a>(
    link_uris: impl IntoIterator<Item = &'a str>,
    page_text: &str,
) -> Option<String> {
    for uri in link_uris {
        if let Some(repo) = first_in_text(uri) {
            return Some(repo);
        }
    }
    first_in_text(page_text)
}

/// Repository link on page 1, or `None` when the file has none or cannot be read.
pub fn extract_first_page_github_repo(pdf: &[u8]) -> Option<String> {
    ensure_pdfium_search_path();
    let lib = liteparse_pdfium::Library::try_init().ok()?;
    let doc = lib.load_document_from_bytes(pdf, None).ok()?;
    if doc.page_count() < 1 {
        return None;
    }
    let page = doc.page(0).ok()?;
    let links = match page.view_box() {
        Some(view_box) => page
            .links(&view_box)
            .into_iter()
            .map(|link| link.uri)
            .collect::<Vec<_>>(),
        None => Vec::new(),
    };
    let text = page
        .text()
        .ok()
        .map(|text_page| {
            let count = text_page.char_count().max(0);
            if count == 0 {
                String::new()
            } else {
                text_page.get_text(0, count)
            }
        })
        .unwrap_or_default();
    first_github_repo(links.iter().map(String::as_str), &text)
}

fn first_in_text(text: &str) -> Option<String> {
    // Drop a line break inside a URL (`github.com/foo/\nbar`) without gluing
    // the previous word onto `https://`.
    let compact = compact_url_line_breaks(text);
    let lower = compact.to_ascii_lowercase();
    let needle = "github.com/";
    let mut from = 0;
    while let Some(rel) = lower[from..].find(needle) {
        let at = from + rel;
        if let Some(repo) = repo_at(&compact, at) {
            return Some(repo);
        }
        from = at + needle.len();
    }
    None
}

fn compact_url_line_breaks(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    while i < chars.len() {
        if chars[i].is_whitespace() {
            let prev = out.chars().next_back();
            let mut j = i;
            while j < chars.len() && chars[j].is_whitespace() {
                j += 1;
            }
            let next = chars.get(j).copied();
            if !(prev.is_some_and(is_url_punct) || next.is_some_and(is_url_punct)) && prev.is_some()
            {
                out.push(' ');
            }
            i = j;
        } else {
            out.push(chars[i]);
            i += 1;
        }
    }
    out
}

fn is_url_punct(c: char) -> bool {
    matches!(c, '/' | '-' | '.' | '_' | ':' | '?' | '#' | '%' | '=' | '~')
}

fn repo_at(text: &str, at: usize) -> Option<String> {
    if !host_boundary(text, at) {
        return None;
    }
    let after = text.get(at + "github.com/".len()..)?;
    let owner_end = after.find(['/', '?', '#']).unwrap_or(after.len());
    let owner = &after[..owner_end];
    let rest = &after[owner_end..];
    if !rest.starts_with('/') {
        return None;
    }
    let repo_src = &rest[1..];
    let repo_end = repo_src.find(['/', '?', '#']).unwrap_or(repo_src.len());
    let mut repo = trim_trailing_punct(&repo_src[..repo_end]).to_string();
    if let Some(stripped) = strip_dot_git(&repo) {
        repo = trim_trailing_punct(stripped).to_string();
    }
    if !valid_owner(owner) || !valid_repo(&repo) {
        return None;
    }
    Some(format!("https://github.com/{owner}/{repo}"))
}

fn host_boundary(text: &str, at: usize) -> bool {
    let before = text[..at].to_ascii_lowercase();
    let before_host = before.strip_suffix("www.").unwrap_or(&before);
    if before_host.ends_with("https://") || before_host.ends_with("http://") {
        return true;
    }
    // `gist.github.com` / `api.github.com`, not a repository URL.
    if before.ends_with('.') {
        return false;
    }
    match before.chars().next_back() {
        None => true,
        Some(c) => !c.is_ascii_alphanumeric() && c != '@',
    }
}

fn strip_dot_git(repo: &str) -> Option<&str> {
    let bytes = repo.as_bytes();
    let start = repo.len().checked_sub(4)?;
    if repo.is_char_boundary(start) && bytes[start..].eq_ignore_ascii_case(b".git") {
        Some(&repo[..start])
    } else {
        None
    }
}

fn trim_trailing_punct(value: &str) -> &str {
    value.trim_end_matches(|c: char| {
        matches!(
            c,
            '.' | ',' | ';' | ':' | ')' | ']' | '>' | '\'' | '"' | '!'
        )
    })
}

fn valid_owner(owner: &str) -> bool {
    let len = owner.len();
    if !(1..=39).contains(&len) {
        return false;
    }
    let bytes = owner.as_bytes();
    if bytes[0] == b'-' || bytes[len - 1] == b'-' {
        return false;
    }
    if !owner.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return false;
    }
    let lower = owner.to_ascii_lowercase();
    RESERVED_OWNERS.binary_search(&lower.as_str()).is_err()
}

fn valid_repo(repo: &str) -> bool {
    if repo.is_empty() || repo == "." || repo == ".." || repo.len() > 100 {
        return false;
    }
    repo.chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

/// Point in-process PDFium at the library shipped beside the app. The worker
/// already does this; `load_default` otherwise only sees the build machine's
/// cache path. Mirrors `paper::analyze::parse` candidate dirs.
fn ensure_pdfium_search_path() {
    if std::env::var_os("PDFIUM_LIB_PATH").is_some() {
        return;
    }
    if let Some(dir) = bundled_pdfium_dir() {
        std::env::set_var("PDFIUM_LIB_PATH", dir);
    }
}

fn bundled_pdfium_dir() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let exe_dir = exe.parent()?;
    let name = if cfg!(target_os = "macos") {
        "libpdfium.dylib"
    } else if cfg!(target_os = "windows") {
        "pdfium.dll"
    } else {
        "libpdfium.so"
    };
    let mut candidates = Vec::new();
    if cfg!(target_os = "macos") {
        candidates.push(exe_dir.join("../Frameworks"));
    }
    candidates.push(exe_dir.join("pdfium"));
    candidates.push(exe_dir.join("../lib/agentero/pdfium"));
    candidates.push(exe_dir.join("../lib/Agentero/pdfium"));
    candidates.push(exe_dir.to_path_buf());
    candidates.into_iter().find(|dir| dir.join(name).is_file())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reserved_owners_stay_sorted() {
        let mut sorted = RESERVED_OWNERS.to_vec();
        sorted.sort_unstable();
        assert_eq!(sorted, RESERVED_OWNERS);
    }

    #[test]
    fn normalizes_the_first_repository_url() {
        assert_eq!(
            first_github_repo(
                ["https://github.com/topics/rust"],
                "see https://github.com/Foo/Bar.git/tree/main."
            ),
            Some("https://github.com/Foo/Bar".into())
        );
        assert_eq!(
            first_github_repo(
                ["https://www.github.com/acme/widget/blob/main/README.md"],
                "https://github.com/other/repo"
            ),
            Some("https://github.com/acme/widget".into())
        );
    }

    #[test]
    fn joins_a_url_broken_across_lines() {
        assert_eq!(
            first_github_repo(
                std::iter::empty::<&str>(),
                "https://github.com/foo/\nbar-repo"
            ),
            Some("https://github.com/foo/bar-repo".into())
        );
    }

    #[test]
    fn skips_other_hosts_and_bare_user_pages() {
        assert_eq!(
            first_github_repo(
                [
                    "https://gist.github.com/foo/bar",
                    "https://notgithub.com/foo/bar",
                    "https://github.com/foo",
                ],
                "contact user@github.com/inbox"
            ),
            None
        );
    }

    #[test]
    fn reads_a_link_whose_visible_text_is_not_the_url() {
        let pdf = pdf_with_objects(&[
            "<< /Type /Catalog /Pages 2 0 R >>",
            "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R \
              /Resources << /Font << /F1 5 0 R >> >> /Annots [6 0 R] >>",
            "<< /Length 35 >>\nstream\nBT /F1 12 Tf 20 60 Td (code) Tj ET\nendstream",
            "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
            "<< /Type /Annot /Subtype /Link /Rect [10 50 100 70] /Border [0 0 0] \
              /A << /S /URI /URI (https://github.com/acme/widget) >> >>",
        ]);
        assert_eq!(
            extract_first_page_github_repo(&pdf).as_deref(),
            Some("https://github.com/acme/widget")
        );
    }

    #[test]
    fn ignores_a_repository_that_appears_only_after_page_one() {
        let pdf = pdf_with_objects(&[
            "<< /Type /Catalog /Pages 2 0 R >>",
            "<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >>",
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Contents 4 0 R \
              /Resources << /Font << /F1 5 0 R >> >> >>",
            "<< /Length 43 >>\nstream\nBT /F1 12 Tf 20 60 Td (Introduction) Tj ET\nendstream",
            "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 100] /Contents 7 0 R \
              /Resources << /Font << /F1 5 0 R >> >> >>",
            "<< /Length 61 >>\nstream\nBT /F1 12 Tf 20 60 Td (https://github.com/other/paper) Tj ET\nendstream",
        ]);
        assert_eq!(extract_first_page_github_repo(&pdf), None);
    }

    fn pdf_with_objects(objects: &[&str]) -> Vec<u8> {
        let mut pdf = b"%PDF-1.4\n".to_vec();
        let mut offsets = Vec::with_capacity(objects.len());
        for (index, object) in objects.iter().enumerate() {
            offsets.push(pdf.len());
            pdf.extend_from_slice(format!("{} 0 obj\n{object}\nendobj\n", index + 1).as_bytes());
        }
        let xref = pdf.len();
        pdf.extend_from_slice(format!("xref\n0 {}\n", objects.len() + 1).as_bytes());
        pdf.extend_from_slice(b"0000000000 65535 f \n");
        for offset in offsets {
            pdf.extend_from_slice(format!("{offset:010} 00000 n \n").as_bytes());
        }
        pdf.extend_from_slice(
            format!(
                "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n",
                objects.len() + 1
            )
            .as_bytes(),
        );
        pdf
    }
}
