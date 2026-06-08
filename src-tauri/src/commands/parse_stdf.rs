use testdata_parser::parse_stdf::parse_stdf_sync;
pub use testdata_parser::types::ParsedStdf;

#[tauri::command]
pub async fn parse_stdf(path: String) -> Result<ParsedStdf, String> {
    tokio::task::spawn_blocking(move || parse_stdf_sync(path))
        .await
        .map_err(|e| e.to_string())?
}
