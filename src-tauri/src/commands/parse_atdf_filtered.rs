use std::collections::HashSet;
use testdata_parser::parse_atdf::parse_atdf_from_bytes_filtered;
use testdata_parser::types::ParsedStdf;

#[tauri::command]
pub async fn parse_atdf_filtered(path: String, selected: Vec<u32>) -> Result<ParsedStdf, String> {
    tokio::task::spawn_blocking(move || {
        let bytes = testdata_parser::read_file::read_bytes(&path)?;
        let set: HashSet<u32> = selected.into_iter().collect();
        parse_atdf_from_bytes_filtered(&bytes, &set)
    })
    .await
    .map_err(|e| e.to_string())?
}
