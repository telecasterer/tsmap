use std::path::PathBuf;
use std::sync::Mutex;

static LAST_DIR: Mutex<Option<PathBuf>> = Mutex::new(None);

fn state_file() -> Option<PathBuf> {
    std::env::var("HOME").ok().map(|h| PathBuf::from(h).join(".local/share/tsmap/last_dir"))
}

#[tauri::command]
pub fn get_last_dir() -> Option<String> {
    {
        let guard = LAST_DIR.lock().ok()?;
        if let Some(ref p) = *guard {
            return Some(p.to_string_lossy().into_owned());
        }
    }
    let text = std::fs::read_to_string(state_file()?).ok()?;
    let pb = PathBuf::from(text.trim());
    if pb.is_dir() {
        *LAST_DIR.lock().ok()? = Some(pb.clone());
        Some(pb.to_string_lossy().into_owned())
    } else {
        None
    }
}

#[tauri::command]
pub fn set_last_dir(path: String) {
    let dir = PathBuf::from(&path);
    let dir = if dir.is_dir() { dir } else { dir.parent().map(|p| p.to_path_buf()).unwrap_or(dir) };
    if let Ok(mut guard) = LAST_DIR.lock() { *guard = Some(dir.clone()); }
    if let Some(f) = state_file() {
        if let Some(parent) = f.parent() { let _ = std::fs::create_dir_all(parent); }
        let _ = std::fs::write(f, dir.to_string_lossy().as_bytes());
    }
}
