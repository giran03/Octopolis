//! Folder rules: preview what a rule would act on.

use std::path::PathBuf;

use octo_core::rules;
use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuleMatchDto {
    path: String,
    size: u64,
    modified_ms: i64,
}

/// The files a rule matches right now. Nothing is changed.
#[tauri::command]
pub async fn rule_matches(folder: PathBuf, patterns: String, older_than_days: u32, recursive: bool) -> Result<Vec<RuleMatchDto>, String> {
    crate::off_main(move || {
        if !folder.is_dir() {
            return Err(format!("{} isn't a folder", folder.display()));
        }
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64);
        Ok(rules::find(&folder, &patterns, older_than_days, recursive, now).into_iter().map(|m| RuleMatchDto { path: m.path.to_string_lossy().into_owned(), size: m.size, modified_ms: m.modified_ms }).collect())
    })
    .await
}
