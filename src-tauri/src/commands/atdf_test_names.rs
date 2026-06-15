use testdata_parser::parse_atdf::parse_atdf_test_names;
use testdata_parser::types::ScanResult;

#[tauri::command]
pub async fn atdf_test_names(path: String) -> Result<ScanResult, String> {
    tokio::task::spawn_blocking(move || {
        let bytes = testdata_parser::read_file::read_bytes(&path)?;
        parse_atdf_test_names(&bytes)
    })
    .await
    .map_err(|e| e.to_string())?
}
