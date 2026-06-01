mod commands;
use commands::{csv_headers, json_headers, parse_csv, parse_json, parse_stdf, pick_file, pick_files, read_text_file, save_file, write_temp_html};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![csv_headers, json_headers, parse_csv, parse_json, parse_stdf, pick_file, pick_files, read_text_file, save_file, write_temp_html])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
