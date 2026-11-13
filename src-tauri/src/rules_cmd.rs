//! Folder rules: preview what a rule would act on.

use std::path::PathBuf;

use octo_core::rules::{self, Criteria};
use serde::{Deserialize, Serialize};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuleMatchDto {
    path: String,
    size: u64,
    modified_ms: i64,
}

/// What a rule looks for, as the page sends it.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuleQuery {
    patterns: String,
    older_than_days: u32,
    newer_than_days: Option<u32>,
    min_size_mb: f64,
    recursive: bool,
}

/// The files a rule matches right now. Nothing is changed.
#[tauri::command]
pub async fn rule_matches(folder: PathBuf, query: RuleQuery) -> Result<Vec<RuleMatchDto>, String> {
    let criteria = Criteria {
        patterns: query.patterns,
        older_than_days: query.older_than_days,
        newer_than_days: query.newer_than_days,
        min_size_bytes: (query.min_size_mb.max(0.0) * 1024.0 * 1024.0) as u64,
        recursive: query.recursive,
    };
    crate::off_main(move || {
        if !folder.is_dir() {
            return Err(format!("{} isn't a folder", folder.display()));
        }
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64);
        Ok(rules::find(&folder, &criteria, now).into_iter().map(|m| RuleMatchDto { path: m.path.to_string_lossy().into_owned(), size: m.size, modified_ms: m.modified_ms }).collect())
    })
    .await
}
