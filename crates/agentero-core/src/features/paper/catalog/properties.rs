//! Vault custom properties: `.agentero/properties.json` and `custom_properties` table.
//!
//! Authoritative store for custom metadata property definitions (`select` / `text`).
//! Each paper's custom property assignments are stored in `papers.custom_props_json`
//! and projected to `{paper}/metadata.json` sidecars.
//!
//! The value map is a plain `property_id -> String` regardless of type: a `select`
//! stores an `option_id`, a `text` stores the user's raw text. The property
//! definition's `type` decides how the value is validated and rendered, so adding
//! a type needs no schema migration.

use super::papers::{self, PaperRecord};
use super::schema::with_catalog;
use crate::error::AppError;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::path::Path;

pub const PROPERTIES_FILE: &str = "properties.json";

/// Property with a fixed option pool; paper value = `option_id`.
pub const PROPERTY_TYPE_SELECT: &str = "select";
/// Property with free text; paper value = the text itself.
pub const PROPERTY_TYPE_TEXT: &str = "text";

/// Upper bound for a text property value (characters), so one cell cannot
/// bloat `properties.json` / `metadata.json` sidecars without limit.
pub const TEXT_VALUE_MAX_CHARS: usize = 2000;

/// Normalize a user/IPC supplied type; unknown types are rejected so a typo
/// cannot create a column nothing knows how to render.
pub fn normalize_property_type(raw: &str) -> Result<String, AppError> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "" | PROPERTY_TYPE_SELECT => Ok(PROPERTY_TYPE_SELECT.to_string()),
        PROPERTY_TYPE_TEXT => Ok(PROPERTY_TYPE_TEXT.to_string()),
        other => Err(AppError::message(format!(
            "unsupported property type: {other}"
        ))),
    }
}

/// Apple system color–inspired tag color ids.
const TAG_COLOR_IDS: &[&str] = &[
    "red", "orange", "yellow", "green", "teal", "blue", "indigo", "purple",
];

pub fn normalize_color(color: Option<&str>) -> Option<String> {
    let c = color?.trim().to_ascii_lowercase();
    if c.is_empty() {
        return None;
    }
    TAG_COLOR_IDS
        .iter()
        .find(|id| **id == c.as_str())
        .map(|id| (*id).to_string())
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, specta::Type)]
pub struct PropertyOption {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CustomProperty {
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub property_type: String,
    pub order_index: i32,
    pub options: Vec<PropertyOption>,
    #[serde(alias = "created_at")]
    pub created_at: String,
    #[serde(alias = "updated_at")]
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PropertiesConfigFile {
    pub version: i32,
    pub properties: Vec<CustomProperty>,
}

pub fn properties_file_path(vault_root: &Path) -> std::path::PathBuf {
    vault_root.join(".agentero").join(PROPERTIES_FILE)
}

/// Read `.agentero/properties.json` if it exists.
pub fn read_properties_file(vault_root: &Path) -> Result<Option<PropertiesConfigFile>, AppError> {
    let path = properties_file_path(vault_root);
    if !path.is_file() {
        return Ok(None);
    }
    let raw = fs::read_to_string(&path)?;
    let parsed: PropertiesConfigFile = serde_json::from_str(&raw)
        .map_err(|e| AppError::message(format!("failed to parse properties.json: {e}")))?;
    Ok(Some(parsed))
}

/// Atomically write `.agentero/properties.json`.
pub fn write_properties_file(
    vault_root: &Path,
    properties: &[CustomProperty],
) -> Result<(), AppError> {
    let agentero_dir = vault_root.join(".agentero");
    fs::create_dir_all(&agentero_dir)?;
    let config = PropertiesConfigFile {
        version: 1,
        properties: properties.to_vec(),
    };
    let raw = serde_json::to_vec_pretty(&config)
        .map_err(|e| AppError::message(format!("failed to serialize properties.json: {e}")))?;
    crate::fs::atomic_write(&properties_file_path(vault_root), &raw)?;
    Ok(())
}

/// Read all custom properties, synchronizing SQLite and properties.json if needed.
pub fn list_properties(vault_root: &Path) -> Result<Vec<CustomProperty>, AppError> {
    with_catalog(vault_root, |conn| list_properties_conn(vault_root, conn))
}

pub fn list_properties_conn(
    vault_root: &Path,
    conn: &Connection,
) -> Result<Vec<CustomProperty>, AppError> {
    let mut stmt = conn
        .prepare(
            "SELECT id, name, type, options_json, order_index, created_at, updated_at              FROM custom_properties              ORDER BY order_index ASC, created_at ASC",
        )
        .map_err(AppError::from)?;

    let rows: Vec<CustomProperty> = stmt
        .query_map([], |row| {
            let options_json: String = row.get(3)?;
            let options: Vec<PropertyOption> =
                serde_json::from_str(&options_json).unwrap_or_default();
            Ok(CustomProperty {
                id: row.get(0)?,
                name: row.get(1)?,
                property_type: row.get(2)?,
                options,
                order_index: row.get(4)?,
                created_at: row.get(5)?,
                updated_at: row.get(6)?,
            })
        })
        .map_err(AppError::from)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(AppError::from)?;

    if rows.is_empty() {
        if let Some(file_cfg) = read_properties_file(vault_root)? {
            if !file_cfg.properties.is_empty() {
                save_properties_to_conn(conn, &file_cfg.properties)?;
                return Ok(file_cfg.properties);
            }
        }
    }

    Ok(rows)
}

pub fn save_properties_to_conn(
    conn: &Connection,
    props: &[CustomProperty],
) -> Result<(), AppError> {
    let tx = conn.unchecked_transaction().map_err(AppError::from)?;
    tx.execute("DELETE FROM custom_properties", [])
        .map_err(AppError::from)?;
    {
        let mut stmt = tx
            .prepare(
                "INSERT INTO custom_properties (id, name, type, options_json, order_index, created_at, updated_at)                  VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            )
            .map_err(AppError::from)?;
        for p in props {
            let options_json =
                serde_json::to_string(&p.options).map_err(|e| AppError::message(e.to_string()))?;
            stmt.execute(params![
                p.id,
                p.name,
                p.property_type,
                options_json,
                p.order_index,
                p.created_at,
                p.updated_at,
            ])
            .map_err(AppError::from)?;
        }
    }
    tx.commit().map_err(AppError::from)?;
    Ok(())
}

/// Create a new custom property (`select` or `text`).
///
/// `options` only applies to `select`; a `text` property always starts with an
/// empty option pool.
pub fn create_property(
    vault_root: &Path,
    name: &str,
    property_type: &str,
    options: Vec<PropertyOption>,
) -> Result<CustomProperty, AppError> {
    let name = name.trim();
    if name.is_empty() {
        return Err(AppError::message("property name cannot be empty"));
    }
    let property_type = normalize_property_type(property_type)?;
    let now = crate::time::now_rfc3339_millis();
    let prop_id = format!("prop_{}", uuid::Uuid::new_v4().simple());
    let mut props = list_properties(vault_root)?;
    let order_index = props.last().map_or(0, |p| p.order_index + 1);

    let clean_options: Vec<PropertyOption> = if property_type == PROPERTY_TYPE_TEXT {
        Vec::new()
    } else {
        options
            .into_iter()
            .map(|opt| {
                let opt_id = if opt.id.trim().is_empty() {
                    format!("opt_{}", uuid::Uuid::new_v4().simple())
                } else {
                    opt.id.trim().to_string()
                };
                PropertyOption {
                    id: opt_id,
                    name: opt.name.trim().to_string(),
                    color: normalize_color(opt.color.as_deref()),
                }
            })
            .filter(|opt| !opt.name.is_empty())
            .collect()
    };

    let new_prop = CustomProperty {
        id: prop_id,
        name: name.to_string(),
        property_type,
        order_index,
        options: clean_options,
        created_at: now.clone(),
        updated_at: now,
    };
    props.push(new_prop.clone());

    with_catalog(vault_root, |conn| save_properties_to_conn(conn, &props))?;
    write_properties_file(vault_root, &props)?;

    Ok(new_prop)
}

/// Update property name, order_index, or options.
/// If any options were removed, removes those options from all papers' custom_props.
pub fn update_property(
    vault_root: &Path,
    prop: &CustomProperty,
) -> Result<CustomProperty, AppError> {
    let name = prop.name.trim();
    if name.is_empty() {
        return Err(AppError::message("property name cannot be empty"));
    }
    let mut props = list_properties(vault_root)?;
    let existing_idx = props
        .iter()
        .position(|p| p.id == prop.id)
        .ok_or_else(|| AppError::message(format!("property not found: {}", prop.id)))?;

    let old_prop = &props[existing_idx];
    let new_option_ids: HashSet<String> = prop.options.iter().map(|o| o.id.clone()).collect();
    let removed_option_ids: Vec<String> = old_prop
        .options
        .iter()
        .filter(|o| !new_option_ids.contains(&o.id))
        .map(|o| o.id.clone())
        .collect();

    let now = crate::time::now_rfc3339_millis();
    // The type is immutable after creation: switching select <-> text would
    // invalidate every stored value (option ids vs raw text).
    let existing_type = props[existing_idx].property_type.clone();
    let mut updated = prop.clone();
    updated.name = name.to_string();
    updated.property_type = existing_type.clone();
    if existing_type == PROPERTY_TYPE_TEXT {
        updated.options = Vec::new();
    }
    updated.updated_at = now;
    props[existing_idx] = updated.clone();

    with_catalog(vault_root, |conn| save_properties_to_conn(conn, &props))?;
    write_properties_file(vault_root, &props)?;

    if !removed_option_ids.is_empty() {
        cleanup_paper_options(vault_root, &prop.id, &removed_option_ids)?;
    }

    Ok(updated)
}

/// Delete a custom property, and remove its assignment from all papers.
pub fn delete_property(vault_root: &Path, property_id: &str) -> Result<(), AppError> {
    let mut props = list_properties(vault_root)?;
    let initial_len = props.len();
    props.retain(|p| p.id != property_id);
    if props.len() == initial_len {
        return Ok(());
    }

    with_catalog(vault_root, |conn| save_properties_to_conn(conn, &props))?;
    write_properties_file(vault_root, &props)?;

    cleanup_paper_property(vault_root, property_id)?;
    Ok(())
}

/// Atomically create a new option and set it on a paper.
pub fn create_option_and_set(
    vault_root: &Path,
    paper_path: &str,
    property_id: &str,
    option_name: &str,
    option_color: Option<&str>,
) -> Result<(CustomProperty, PaperRecord), AppError> {
    let option_name = option_name.trim();
    if option_name.is_empty() {
        return Err(AppError::message("option name cannot be empty"));
    }
    let mut props = list_properties(vault_root)?;
    let prop_idx = props
        .iter()
        .position(|p| p.id == property_id)
        .ok_or_else(|| AppError::message(format!("property not found: {property_id}")))?;
    if props[prop_idx].property_type == PROPERTY_TYPE_TEXT {
        return Err(AppError::message(
            "text properties have no options; set the text value instead",
        ));
    }

    let opt_id = if let Some(existing) = props[prop_idx]
        .options
        .iter()
        .find(|o| o.name.eq_ignore_ascii_case(option_name))
    {
        existing.id.clone()
    } else {
        let new_id = format!("opt_{}", uuid::Uuid::new_v4().simple());
        let opt = PropertyOption {
            id: new_id.clone(),
            name: option_name.to_string(),
            color: normalize_color(option_color),
        };
        props[prop_idx].options.push(opt);
        props[prop_idx].updated_at = crate::time::now_rfc3339_millis();
        with_catalog(vault_root, |conn| save_properties_to_conn(conn, &props))?;
        write_properties_file(vault_root, &props)?;
        new_id
    };

    let updated_prop = props[prop_idx].clone();
    let updated_paper = set_paper_property(vault_root, paper_path, property_id, Some(&opt_id))?;
    Ok((updated_prop, updated_paper))
}

/// Delete an option from a property and clean up papers referencing it.
pub fn delete_property_option(
    vault_root: &Path,
    property_id: &str,
    option_id: &str,
) -> Result<CustomProperty, AppError> {
    let mut props = list_properties(vault_root)?;
    let prop_idx = props
        .iter()
        .position(|p| p.id == property_id)
        .ok_or_else(|| AppError::message(format!("property not found: {property_id}")))?;

    props[prop_idx].options.retain(|o| o.id != option_id);
    props[prop_idx].updated_at = crate::time::now_rfc3339_millis();
    let updated = props[prop_idx].clone();

    with_catalog(vault_root, |conn| save_properties_to_conn(conn, &props))?;
    write_properties_file(vault_root, &props)?;

    cleanup_paper_options(vault_root, property_id, &[option_id.to_string()])?;
    Ok(updated)
}

/// Set or clear a paper's property value.
///
/// `value` is an `option_id` for `select` properties and the raw text for
/// `text` properties; `None` or a blank value clears the assignment.
pub fn set_paper_property(
    vault_root: &Path,
    paper_path: &str,
    property_id: &str,
    value: Option<&str>,
) -> Result<PaperRecord, AppError> {
    let props = list_properties(vault_root)?;
    let prop = props
        .iter()
        .find(|p| p.id == property_id)
        .ok_or_else(|| AppError::message(format!("property not found: {property_id}")))?;

    let next_value = match value.map(str::trim).filter(|v| !v.is_empty()) {
        None => None,
        Some(raw) if prop.property_type == PROPERTY_TYPE_TEXT => {
            if raw.chars().count() > TEXT_VALUE_MAX_CHARS {
                return Err(AppError::message(format!(
                    "text value is longer than {TEXT_VALUE_MAX_CHARS} characters"
                )));
            }
            Some(raw.to_string())
        }
        Some(opt_id) => {
            if !prop.options.iter().any(|o| o.id == opt_id) {
                return Err(AppError::message(format!(
                    "option {} does not exist in property {}",
                    opt_id, property_id
                )));
            }
            Some(opt_id.to_string())
        }
    };

    papers::mutate_paper_custom_props(vault_root, paper_path, |map| match next_value {
        Some(value) => {
            map.insert(property_id.to_string(), value);
        }
        None => {
            map.remove(property_id);
        }
    })
}

fn cleanup_paper_property(vault_root: &Path, property_id: &str) -> Result<(), AppError> {
    let all_papers = papers::list_all(vault_root)?;
    for mut paper in all_papers {
        if paper.custom_props.remove(property_id).is_some() {
            papers::direct_update_paper_custom_props(vault_root, &paper.path, &paper.custom_props)?;
        }
    }
    Ok(())
}

fn cleanup_paper_options(
    vault_root: &Path,
    property_id: &str,
    removed_option_ids: &[String],
) -> Result<(), AppError> {
    let all_papers = papers::list_all(vault_root)?;
    for mut paper in all_papers {
        if let Some(val) = paper.custom_props.get(property_id) {
            if removed_option_ids.contains(val) {
                paper.custom_props.remove(property_id);
                papers::direct_update_paper_custom_props(
                    vault_root,
                    &paper.path,
                    &paper.custom_props,
                )?;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn test_custom_properties_lifecycle() {
        let dir = tempdir().unwrap();
        let vault = dir.path();
        crate::features::paper::catalog::schema::ensure_catalog(vault).unwrap();

        // 1. Create property
        let prop = create_property(
            vault,
            "Status",
            "select",
            vec![
                PropertyOption {
                    id: "opt_reading".into(),
                    name: "Reading".into(),
                    color: Some("yellow".into()),
                },
                PropertyOption {
                    id: "opt_done".into(),
                    name: "Done".into(),
                    color: Some("green".into()),
                },
            ],
        )
        .unwrap();

        assert_eq!(prop.name, "Status");
        assert_eq!(prop.options.len(), 2);

        // 2. List properties
        let listed = list_properties(vault).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, prop.id);

        // 3. Create paper and set property
        let paper = PaperRecord {
            path: "papers/test".into(),
            id: "test".into(),
            paper_type: papers::PaperKind::Other,
            title: "Test".into(),
            authors: vec![],
            creators: None,
            year: None,
            date: None,
            abstract_text: None,
            tags: vec![],
            arxiv_id: None,
            doi: None,
            isbn: None,
            issn: None,
            pmid: None,
            publication: None,
            volume: None,
            issue: None,
            pages: None,
            publisher: None,
            place: None,
            series: None,
            language: None,
            pdf_url: None,
            html_url: None,
            source_url: None,
            code_repo: None,
            openreview_url: None,
            body_source: None,
            body_quality: None,
            bibtex_key: None,
            citation_count: None,
            zotero_item_type: None,
            meta_source: None,
            extra: None,
            summary: None,
            status: "completed".into(),
            is_read: false,
            zotero_item_id: None,
            zotero_last_synced: None,
            custom_props: Default::default(),
            added_at: "t".into(),
            updated_at: "t".into(),
        };
        std::fs::create_dir_all(vault.join("papers/test")).unwrap();
        papers::upsert_paper(vault, &paper).unwrap();

        let updated_paper =
            set_paper_property(vault, "papers/test", &prop.id, Some("opt_reading")).unwrap();
        assert_eq!(
            updated_paper.custom_props.get(&prop.id),
            Some(&"opt_reading".to_string())
        );

        // 4. Create option and set
        let (updated_prop, updated_paper2) =
            create_option_and_set(vault, "papers/test", &prop.id, "To Read", Some("blue")).unwrap();
        assert_eq!(updated_prop.options.len(), 3);
        let new_opt_id = updated_paper2.custom_props.get(&prop.id).unwrap();
        assert!(updated_prop
            .options
            .iter()
            .any(|o| &o.id == new_opt_id && o.name == "To Read"));

        // 5. Delete option cleans up paper
        let updated_prop2 = delete_property_option(vault, &prop.id, new_opt_id).unwrap();
        assert_eq!(updated_prop2.options.len(), 2);
        let p = papers::get_by_path(vault, "papers/test").unwrap().unwrap();
        assert_eq!(p.custom_props.get(&prop.id), None);

        // 6. Delete property cleans up
        delete_property(vault, &prop.id).unwrap();
        assert!(list_properties(vault).unwrap().is_empty());
    }

    fn insert_test_paper(vault: &Path, path: &str) {
        let paper = PaperRecord {
            path: path.into(),
            id: "test".into(),
            paper_type: papers::PaperKind::Other,
            title: "Test".into(),
            authors: vec![],
            creators: None,
            year: None,
            date: None,
            abstract_text: None,
            tags: vec![],
            arxiv_id: None,
            doi: None,
            isbn: None,
            issn: None,
            pmid: None,
            publication: None,
            volume: None,
            issue: None,
            pages: None,
            publisher: None,
            place: None,
            series: None,
            language: None,
            pdf_url: None,
            html_url: None,
            source_url: None,
            code_repo: None,
            openreview_url: None,
            body_source: None,
            body_quality: None,
            bibtex_key: None,
            citation_count: None,
            zotero_item_type: None,
            meta_source: None,
            extra: None,
            summary: None,
            status: "completed".into(),
            is_read: false,
            zotero_item_id: None,
            zotero_last_synced: None,
            custom_props: Default::default(),
            added_at: "t".into(),
            updated_at: "t".into(),
        };
        std::fs::create_dir_all(vault.join(path)).unwrap();
        papers::upsert_paper(vault, &paper).unwrap();
    }

    #[test]
    fn test_text_property_lifecycle() {
        let dir = tempdir().unwrap();
        let vault = dir.path();
        crate::features::paper::catalog::schema::ensure_catalog(vault).unwrap();

        // A text property never carries an option pool, even if one is passed.
        let prop = create_property(
            vault,
            "Lab Note",
            "text",
            vec![PropertyOption {
                id: "opt_ignored".into(),
                name: "Ignored".into(),
                color: None,
            }],
        )
        .unwrap();
        assert_eq!(prop.property_type, PROPERTY_TYPE_TEXT);
        assert!(prop.options.is_empty());

        insert_test_paper(vault, "papers/text-prop");

        // Free text is stored verbatim (trimmed) and cleared by blank input.
        let updated =
            set_paper_property(vault, "papers/text-prop", &prop.id, Some("  see  §3  ")).unwrap();
        assert_eq!(
            updated.custom_props.get(&prop.id),
            Some(&"see  §3".to_string())
        );
        let cleared = set_paper_property(vault, "papers/text-prop", &prop.id, Some("   ")).unwrap();
        assert_eq!(cleared.custom_props.get(&prop.id), None);

        // Length guard rejects oversized values instead of silently truncating.
        let too_long = "x".repeat(TEXT_VALUE_MAX_CHARS + 1);
        assert!(set_paper_property(vault, "papers/text-prop", &prop.id, Some(&too_long)).is_err());

        // Text properties have no options to create.
        assert!(create_option_and_set(vault, "papers/text-prop", &prop.id, "nope", None).is_err());

        // Type is immutable across rename.
        let renamed = update_property(
            vault,
            &CustomProperty {
                property_type: "select".into(),
                name: "Lab Note 2".into(),
                ..prop.clone()
            },
        )
        .unwrap();
        assert_eq!(renamed.name, "Lab Note 2");
        assert_eq!(renamed.property_type, PROPERTY_TYPE_TEXT);

        // Unknown types are rejected up front.
        assert!(create_property(vault, "Bad", "number", vec![]).is_err());

        // Deleting the property clears the value from papers and the file.
        delete_property(vault, &prop.id).unwrap();
        assert!(list_properties(vault).unwrap().is_empty());
        let p = papers::get_by_path(vault, "papers/text-prop")
            .unwrap()
            .unwrap();
        assert!(p.custom_props.is_empty());
    }
}
