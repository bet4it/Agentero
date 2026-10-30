//! Explicit in-app feedback. Not product analytics.
//!
//! A submission sends even when telemetry is off and in debug builds. It
//! still does nothing when the project API key was not compiled in.
//! The body is only what the user typed, plus version / OS / arch / locale.
//! Vault paths, file names, and document content are never attached.

use std::sync::{Arc, OnceLock};

use serde::Serialize;
use serde_json::{Map, Value};

use super::device::install_id;

const MESSAGE_MAX: usize = 4_000;
const CONTACT_MAX: usize = 200;
const APP_VERSION: &str = env!("CARGO_PKG_VERSION");

const Q_KIND: &str = "Kind";
const Q_MESSAGE: &str = "Message";
const Q_CONTACT: &str = "Contact";

#[derive(Debug)]
pub(crate) struct FeedbackInput {
    pub category: String,
    pub message: String,
    pub contact: Option<String>,
    pub locale: String,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum FeedbackError {
    Invalid,
    Unavailable,
    Failed,
}

#[derive(Debug, PartialEq, Eq)]
struct Draft {
    category: &'static str,
    message: String,
    contact: Option<String>,
    locale: String,
}

struct SurveyIds {
    survey: &'static str,
    kind: &'static str,
    message: &'static str,
    contact: &'static str,
}

struct Facts<'a> {
    app_version: &'a str,
    os_name: &'a str,
    os_version: &'a str,
    arch: &'a str,
    locale: &'a str,
}

/// Validate and trim a submission. The returned category is the stable
/// PostHog choice (`bug` or `idea`), not the localized label.
fn normalize(input: FeedbackInput) -> Result<Draft, FeedbackError> {
    let category = match input.category.as_str() {
        "bug" => "bug",
        "idea" => "idea",
        _ => return Err(FeedbackError::Invalid),
    };
    let message = input.message.trim();
    if message.is_empty() || message.chars().count() > MESSAGE_MAX {
        return Err(FeedbackError::Invalid);
    }
    let contact = match input.contact.as_deref().map(str::trim) {
        None | Some("") => None,
        Some(value) => {
            if value.chars().count() > CONTACT_MAX || value.chars().any(|c| c == '\n' || c == '\r')
            {
                return Err(FeedbackError::Invalid);
            }
            Some(value.to_string())
        }
    };
    Ok(Draft {
        category,
        message: message.to_string(),
        contact,
        locale: normalize_locale(&input.locale),
    })
}

fn normalize_locale(raw: &str) -> String {
    let value = raw.trim();
    let mut parts = value.split('-');
    let Some(lang) = parts.next() else {
        return "und".to_string();
    };
    if !(2..=3).contains(&lang.len()) || !lang.chars().all(|c| c.is_ascii_alphabetic()) {
        return "und".to_string();
    }
    for part in parts {
        if part.is_empty() || part.len() > 8 || !part.chars().all(|c| c.is_ascii_alphanumeric()) {
            return "und".to_string();
        }
    }
    if value.len() > 35 {
        return "und".to_string();
    }
    value.to_string()
}

fn nonempty(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|s| !s.is_empty())
}

fn configured_survey() -> Option<SurveyIds> {
    Some(SurveyIds {
        survey: nonempty(option_env!("AGENTERO_POSTHOG_SURVEY_ID"))?,
        kind: nonempty(option_env!("AGENTERO_POSTHOG_SURVEY_KIND_ID"))?,
        message: nonempty(option_env!("AGENTERO_POSTHOG_SURVEY_MESSAGE_ID"))?,
        contact: nonempty(option_env!("AGENTERO_POSTHOG_SURVEY_CONTACT_ID"))?,
    })
}

fn payload(
    draft: &Draft,
    facts: &Facts<'_>,
    survey: Option<&SurveyIds>,
) -> (&'static str, Map<String, Value>) {
    let mut props = Map::new();
    props.insert("category".into(), Value::String(draft.category.to_string()));
    props.insert("message".into(), Value::String(draft.message.clone()));
    if let Some(contact) = &draft.contact {
        props.insert("contact".into(), Value::String(contact.clone()));
    }
    props.insert("app_version".into(), facts.app_version.into());
    props.insert("os_name".into(), facts.os_name.into());
    props.insert("os_version".into(), facts.os_version.into());
    props.insert("arch".into(), facts.arch.into());
    props.insert("locale".into(), facts.locale.into());

    let Some(survey) = survey else {
        return ("feedback submitted", props);
    };

    props.insert("$survey_id".into(), survey.survey.into());
    props.insert(
        "$survey_submission_id".into(),
        Value::String(uuid::Uuid::new_v4().to_string()),
    );
    props.insert("$survey_completed".into(), Value::Bool(true));
    props.insert(
        "$survey_questions".into(),
        serde_json::to_value([
            question(survey.kind, Q_KIND),
            question(survey.message, Q_MESSAGE),
            question(survey.contact, Q_CONTACT),
        ])
        .expect("survey question list"),
    );
    props.insert(
        format!("$survey_response_{}", survey.kind),
        Value::String(draft.category.to_string()),
    );
    props.insert(
        format!("$survey_response_{}", survey.message),
        Value::String(draft.message.clone()),
    );
    if let Some(contact) = &draft.contact {
        props.insert(
            format!("$survey_response_{}", survey.contact),
            Value::String(contact.clone()),
        );
    }
    ("survey sent", props)
}

#[derive(Serialize)]
struct QuestionRef<'a> {
    id: &'a str,
    question: &'a str,
}

fn question<'a>(id: &'a str, question: &'a str) -> QuestionRef<'a> {
    QuestionRef { id, question }
}

fn feedback_client() -> Option<Arc<posthog_rs::Client>> {
    static CLIENT: OnceLock<Option<Arc<posthog_rs::Client>>> = OnceLock::new();
    CLIENT
        .get_or_init(|| super::posthog_key().map(|key| Arc::new(posthog_rs::client(key))))
        .clone()
}

pub(crate) fn submit(input: FeedbackInput) -> Result<(), FeedbackError> {
    let draft = normalize(input)?;
    let Some(client) = feedback_client() else {
        log::info!(target: "agentero::op", "feedback skipped: no project key");
        return Err(FeedbackError::Unavailable);
    };
    let info = os_info::get();
    let os_name = info.os_type().to_string();
    let os_version = info.version().to_string();
    let survey = configured_survey();
    if survey.is_none() {
        log::info!(
            target: "agentero::op",
            "feedback survey ids unset; sending feedback submitted"
        );
    }
    let facts = Facts {
        app_version: APP_VERSION,
        os_name: &os_name,
        os_version: &os_version,
        arch: std::env::consts::ARCH,
        locale: &draft.locale,
    };
    let (name, props) = payload(&draft, &facts, survey.as_ref());
    let distinct_id = install_id();
    let mut event = posthog_rs::Event::new(name, distinct_id.as_str());
    for (key, value) in props {
        if event.insert_prop(key, value).is_err() {
            return Err(FeedbackError::Failed);
        }
    }
    match client.capture_immediate(event) {
        Ok(summary) if summary.submitted() == 1 => {
            log::info!(target: "agentero::op", "feedback sent category={}", draft.category);
            Ok(())
        }
        Ok(_) => {
            log::warn!(target: "agentero::op", "feedback delivery dropped");
            Err(FeedbackError::Failed)
        }
        Err(_) => {
            log::warn!(target: "agentero::op", "feedback delivery failed");
            Err(FeedbackError::Failed)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(category: &str, message: &str, contact: Option<&str>, locale: &str) -> FeedbackInput {
        FeedbackInput {
            category: category.to_string(),
            message: message.to_string(),
            contact: contact.map(str::to_string),
            locale: locale.to_string(),
        }
    }

    fn facts<'a>(locale: &'a str) -> Facts<'a> {
        Facts {
            app_version: "1.2.3",
            os_name: "Mac OS",
            os_version: "15.0",
            arch: "aarch64",
            locale,
        }
    }

    #[test]
    fn rejects_empty_unknown_and_overlong() {
        assert_eq!(
            normalize(input("bug", "  ", None, "en")),
            Err(FeedbackError::Invalid)
        );
        assert_eq!(
            normalize(input("Bug", "broken", None, "en")),
            Err(FeedbackError::Invalid)
        );
        let huge = "字".repeat(MESSAGE_MAX + 1);
        assert_eq!(
            normalize(input("idea", &huge, None, "zh-CN")),
            Err(FeedbackError::Invalid)
        );
        assert_eq!(
            normalize(input("bug", "ok", Some("a\nb"), "en")),
            Err(FeedbackError::Invalid)
        );
    }

    #[test]
    fn keeps_stable_category_and_drops_blank_contact() {
        let draft = normalize(input("idea", "  please add this  ", Some("  "), "zh-CN")).unwrap();
        assert_eq!(draft.category, "idea");
        assert_eq!(draft.message, "please add this");
        assert_eq!(draft.contact, None);
        assert_eq!(draft.locale, "zh-CN");
        assert_eq!(
            normalize(input("bug", "x", None, "not a locale"))
                .unwrap()
                .locale,
            "und"
        );
    }

    #[test]
    fn payload_is_only_the_note_and_device_facts() {
        let draft = normalize(input("bug", "save failed", Some("a@b.c"), "en")).unwrap();
        let (name, props) = payload(&draft, &facts("en"), None);
        assert_eq!(name, "feedback submitted");
        let keys: Vec<_> = props.keys().cloned().collect();
        for key in keys {
            assert!(
                matches!(
                    key.as_str(),
                    "category"
                        | "message"
                        | "contact"
                        | "app_version"
                        | "os_name"
                        | "os_version"
                        | "arch"
                        | "locale"
                ),
                "unexpected property {key}"
            );
        }
        assert_eq!(props["message"], "save failed");
        assert_eq!(props["category"], "bug");
        assert_eq!(props["contact"], "a@b.c");
        assert_eq!(props["app_version"], "1.2.3");
        assert!(props.get("path").is_none());
    }

    #[test]
    fn survey_properties_use_question_ids() {
        let draft = normalize(input("idea", "darker pdf", None, "en")).unwrap();
        let survey = SurveyIds {
            survey: "survey-1",
            kind: "q-kind",
            message: "q-message",
            contact: "q-contact",
        };
        let (name, props) = payload(&draft, &facts("en"), Some(&survey));
        assert_eq!(name, "survey sent");
        assert_eq!(props["$survey_id"], "survey-1");
        assert_eq!(props["$survey_completed"], true);
        assert_eq!(props["$survey_response_q-kind"], "idea");
        assert_eq!(props["$survey_response_q-message"], "darker pdf");
        assert!(props.get("$survey_response_q-contact").is_none());
        assert!(props["$survey_submission_id"]
            .as_str()
            .is_some_and(|id| !id.is_empty()));
    }
}
