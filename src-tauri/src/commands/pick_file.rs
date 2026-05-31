/// Show a native file picker and return the selected path.
///
/// On Linux + WebKitGTK, rfd (used by tauri-plugin-dialog) deadlocks because
/// both rfd and WebKitGTK drive the same GTK main loop. We shell out to zenity
/// instead, which runs in its own process and has no such conflict.
///
/// On macOS and Windows, rfd works correctly, so we use blocking_pick_file()
/// from tauri-plugin-dialog directly.
#[tauri::command]
pub async fn pick_file(app: tauri::AppHandle) -> Option<String> {
    let _ = &app; // used on non-Linux only
    #[cfg(target_os = "linux")]
    {
        pick_file_zenity()
    }

    #[cfg(not(target_os = "linux"))]
    {
        pick_file_rfd(app).await
    }
}

#[cfg(target_os = "linux")]
fn pick_file_zenity() -> Option<String> {
    let mut cmd = std::process::Command::new("zenity");
    cmd.args([
        "--file-selection",
        "--title=Open wafer map file",
        "--file-filter=Wafer map files | *.stdf *.std *.atdf *.atd *.csv *.json",
        "--file-filter=STDF | *.stdf *.std",
        "--file-filter=ATDF | *.atdf *.atd",
        "--file-filter=CSV / JSON | *.csv *.json",
        "--file-filter=All files | *",
    ]);

    // Propagate display env vars — the Tauri process has them, but the async
    // executor may spawn on a thread with a different env snapshot.
    for var in &["WAYLAND_DISPLAY", "XDG_RUNTIME_DIR", "DISPLAY"] {
        if let Ok(v) = std::env::var(var) {
            cmd.env(var, v);
        }
    }

    let output = cmd.output().ok()?;
    if !output.status.success() {
        return None; // user cancelled
    }
    let path = String::from_utf8(output.stdout).ok()?.trim().to_string();
    if path.is_empty() { None } else { Some(path) }
}

#[cfg(not(target_os = "linux"))]
async fn pick_file_rfd(app: tauri::AppHandle) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .add_filter("Wafer map files", &["stdf", "std", "atdf", "atd", "csv", "json"])
        .add_filter("STDF", &["stdf", "std"])
        .add_filter("ATDF", &["atdf", "atd"])
        .add_filter("CSV / JSON", &["csv", "json"])
        .pick_file(move |path| {
            let _ = tx.send(path.map(|p| p.to_string()));
        });
    rx.await.ok().flatten()
}
