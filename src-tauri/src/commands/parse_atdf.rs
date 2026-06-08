use testdata_parser::parse_atdf::parse_atdf_sync;
use testdata_parser::types::ParsedStdf;

#[tauri::command]
pub async fn parse_atdf(path: String) -> Result<ParsedStdf, String> {
    tokio::task::spawn_blocking(move || parse_atdf_sync(path))
        .await
        .map_err(|e| e.to_string())?
}
