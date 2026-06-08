use tsmap_parsers::parse_csv::CsvMapping;
use tsmap_parsers::parse_json::{json_headers_sync, parse_json_sync, JsonHeadersResult};
use tsmap_parsers::types::ParsedStdf;

#[tauri::command]
pub async fn json_headers(path: String) -> Result<JsonHeadersResult, String> {
    tokio::task::spawn_blocking(move || json_headers_sync(path))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn parse_json(path: String, mapping: CsvMapping) -> Result<ParsedStdf, String> {
    tokio::task::spawn_blocking(move || parse_json_sync(path, mapping))
        .await
        .map_err(|e| e.to_string())?
}
