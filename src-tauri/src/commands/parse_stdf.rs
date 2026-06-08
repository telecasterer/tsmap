use tsmap_parsers::parse_stdf::parse_stdf_sync;
pub use tsmap_parsers::types::ParsedStdf;

#[tauri::command]
pub async fn parse_stdf(path: String) -> Result<ParsedStdf, String> {
    tokio::task::spawn_blocking(move || parse_stdf_sync(path))
        .await
        .map_err(|e| e.to_string())?
}
