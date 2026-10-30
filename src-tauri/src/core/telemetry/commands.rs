//! Desktop command for the About → Feedback form.
//!
//! Async plus [`run_blocking`]: delivery waits on PostHog and must not run
//! on the UI thread (Windows message pump).

use crate::core::blocking::run_blocking;
use crate::core::error::{ApiResult, AppError};
use serde::Deserialize;
use serde_json::json;

use super::feedback::{self, FeedbackError, FeedbackInput};

#[derive(Debug, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct FeedbackSubmitArgs {
    pub category: String,
    pub message: String,
    #[serde(default)]
    pub contact: Option<String>,
    pub locale: String,
}

#[tauri::command]
#[specta::specta]
pub async fn feedback_submit(args: FeedbackSubmitArgs) -> ApiResult<()> {
    let input = FeedbackInput {
        category: args.category,
        message: args.message,
        contact: args.contact,
        locale: args.locale,
    };
    run_blocking(move || match feedback::submit(input) {
        Ok(()) => ApiResult::ok(()),
        Err(err) => fail(err),
    })
    .await
}

fn fail(err: FeedbackError) -> ApiResult<()> {
    let reason = match err {
        FeedbackError::Invalid => "invalid",
        FeedbackError::Unavailable => "unavailable",
        FeedbackError::Failed => "failed",
    };
    ApiResult::err_with_details(
        AppError::domain(reason, reason),
        json!({ "reason": reason }),
    )
}
