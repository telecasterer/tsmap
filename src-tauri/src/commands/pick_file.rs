use std::path::PathBuf;
use std::sync::Mutex;

static LAST_DIR: Mutex<Option<PathBuf>> = Mutex::new(None);

fn last_dir_file() -> Option<PathBuf> {
    std::env::var("HOME").ok().map(|h| PathBuf::from(h).join(".local/share/tsmap/last_dir"))
}

fn load_last_dir() -> Option<PathBuf> {
    {
        let guard = LAST_DIR.lock().ok()?;
        if guard.is_some() { return guard.clone(); }
    }
    let path = std::fs::read_to_string(last_dir_file()?).ok()?;
    let pb = PathBuf::from(path.trim());
    if pb.is_dir() {
        *LAST_DIR.lock().ok()? = Some(pb.clone());
        Some(pb)
    } else {
        None
    }
}

fn save_last_dir(picked: &str) {
    let dir = PathBuf::from(picked).parent().map(|p| p.to_path_buf());
    if let Some(dir) = dir {
        if let Ok(mut guard) = LAST_DIR.lock() { *guard = Some(dir.clone()); }
        if let Some(f) = last_dir_file() {
            if let Some(parent) = f.parent() { let _ = std::fs::create_dir_all(parent); }
            let _ = std::fs::write(f, dir.to_string_lossy().as_bytes());
        }
    }
}

/// Show a native file picker and return the selected path.
/// On Linux, shells out to zenity to avoid the WebKitGTK/rfd GTK deadlock.
#[tauri::command]
pub async fn pick_file(app: tauri::AppHandle) -> Option<String> {
    let _ = &app;
    #[cfg(target_os = "linux")]
    { zenity_single() }
    #[cfg(not(target_os = "linux"))]
    { rfd_single(app).await }
}

/// Show a native file picker that allows multiple selection.
/// Returns a list of selected paths, or empty vec if cancelled.
#[tauri::command]
pub async fn pick_files(app: tauri::AppHandle) -> Vec<String> {
    let _ = &app;
    #[cfg(target_os = "linux")]
    { zenity_multiple() }
    #[cfg(not(target_os = "linux"))]
    { rfd_multiple(app).await }
}

// ── Linux (zenity) ────────────────────────────────────────────────────────────

#[cfg(target_os = "linux")]
fn zenity_args() -> Vec<&'static str> {
    vec![
        "--file-selection",
        "--title=Open wafer map files",
        "--file-filter=Wafer map files | *.stdf *.std *.atdf *.atd *.csv *.json",
        "--file-filter=STDF | *.stdf *.std",
        "--file-filter=ATDF | *.atdf *.atd",
        "--file-filter=CSV / JSON | *.csv *.json",
        "--file-filter=All files | *",
    ]
}

#[cfg(target_os = "linux")]
fn zenity_run(extra_args: &[&str]) -> Option<String> {
    let mut cmd = std::process::Command::new("zenity");
    cmd.args(zenity_args());
    cmd.args(extra_args);
    if let Some(dir) = load_last_dir() {
        let mut s = dir.to_string_lossy().into_owned();
        if !s.ends_with('/') { s.push('/'); }
        cmd.arg(format!("--filename={}", s));
    }
    for var in &["WAYLAND_DISPLAY", "XDG_RUNTIME_DIR", "DISPLAY"] {
        if let Ok(v) = std::env::var(var) { cmd.env(var, v); }
    }
    cmd.stderr(std::process::Stdio::null());
    let output = cmd.output().ok()?;
    if !output.status.success() { return None; }
    let s = String::from_utf8(output.stdout).ok()?.trim().to_string();
    if s.is_empty() { None } else { Some(s) }
}

#[cfg(target_os = "linux")]
fn zenity_single() -> Option<String> {
    let result = zenity_run(&[])?;
    save_last_dir(&result);
    Some(result)
}

#[cfg(target_os = "linux")]
fn zenity_multiple() -> Vec<String> {
    // zenity --multiple separates paths with | by default
    let raw = zenity_run(&["--multiple", "--separator=|"]);
    match raw {
        None => vec![],
        Some(s) => {
            let paths: Vec<String> = s.split('|').map(|p| p.trim().to_string()).filter(|p| !p.is_empty()).collect();
            if let Some(first) = paths.first() { save_last_dir(first); }
            paths
        }
    }
}

// ── macOS / Windows (rfd via tauri-plugin-dialog) ─────────────────────────────

#[cfg(not(target_os = "linux"))]
async fn rfd_single(app: tauri::AppHandle) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = tokio::sync::oneshot::channel();
    let mut dialog = app.dialog()
        .file()
        .add_filter("Wafer map files", &["stdf", "std", "atdf", "atd", "csv", "json"])
        .add_filter("STDF", &["stdf", "std"])
        .add_filter("ATDF", &["atdf", "atd"])
        .add_filter("CSV / JSON", &["csv", "json"]);
    if let Some(dir) = load_last_dir() { dialog = dialog.set_directory(dir); }
    dialog.pick_file(move |path| { let _ = tx.send(path.map(|p| p.to_string())); });
    let result = rx.await.ok().flatten();
    if let Some(ref p) = result { save_last_dir(p); }
    result
}

#[cfg(not(target_os = "linux"))]
async fn rfd_multiple(app: tauri::AppHandle) -> Vec<String> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = tokio::sync::oneshot::channel();
    let mut dialog = app.dialog()
        .file()
        .add_filter("Wafer map files", &["stdf", "std", "atdf", "atd", "csv", "json"])
        .add_filter("STDF", &["stdf", "std"])
        .add_filter("ATDF", &["atdf", "atd"])
        .add_filter("CSV / JSON", &["csv", "json"]);
    if let Some(dir) = load_last_dir() { dialog = dialog.set_directory(dir); }
    dialog.pick_files(move |paths| {
        let _ = tx.send(paths.map(|ps| ps.into_iter().map(|p| p.to_string()).collect::<Vec<_>>()).unwrap_or_default());
    });
    let paths = rx.await.ok().unwrap_or_default();
    if let Some(first) = paths.first() { save_last_dir(first); }
    paths
}
