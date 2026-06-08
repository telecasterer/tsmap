pub use tsmap_parsers::parse_csv::{CsvHeadersResult, CsvMapping};
use tsmap_parsers::parse_csv::{csv_headers_inner, parse_csv_inner};
use tsmap_parsers::types::ParsedStdf;

#[tauri::command]
pub async fn csv_headers(path: String) -> Result<CsvHeadersResult, String> {
    tokio::task::spawn_blocking(move || csv_headers_inner(path))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn parse_csv(path: String, mapping: CsvMapping) -> Result<ParsedStdf, String> {
    tokio::task::spawn_blocking(move || parse_csv_inner(path, mapping))
        .await
        .map_err(|e| e.to_string())?
}
