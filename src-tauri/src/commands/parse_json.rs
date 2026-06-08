use testdata_parser::parse_csv::CsvMapping;
use testdata_parser::parse_json::{json_headers_sync, parse_json_sync, JsonHeadersResult};
use testdata_parser::types::ParsedStdf;

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
