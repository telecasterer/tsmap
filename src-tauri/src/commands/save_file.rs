/// Show a native save dialog and write bytes to the chosen path.
/// Returns the path written, or None if cancelled.
#[tauri::command]
pub async fn save_file(
    app: tauri::AppHandle,
    bytes: Vec<u8>,
    default_name: String,
) -> Option<String> {
    let _ = &app; // used on non-Linux only
    #[cfg(target_os = "linux")]
    {
        save_file_zenity(bytes, default_name)
    }
    #[cfg(not(target_os = "linux"))]
    {
        save_file_rfd(app, bytes, default_name).await
    }
}

#[cfg(target_os = "linux")]
fn save_file_zenity(bytes: Vec<u8>, default_name: String) -> Option<String> {
    // Zenity on Wayland often ignores --filename unless given a full path.
    // Pre-seed with the user's home directory so the dialog opens there.
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
    let full_default = format!("{}/{}", home, default_name);

    let mut cmd = std::process::Command::new("zenity");
    cmd.args([
        "--file-selection",
        "--save",
        "--confirm-overwrite",
        &format!("--filename={}", full_default),
        "--title=Save PNG",
        "--file-filter=PNG images | *.png",
    ]);

    for var in &["WAYLAND_DISPLAY", "XDG_RUNTIME_DIR", "DISPLAY"] {
        if let Ok(v) = std::env::var(var) {
            cmd.env(var, v);
        }
    }

    let output = cmd.output().ok()?;
    if !output.status.success() {
        return None;
    }

    let mut path = String::from_utf8(output.stdout).ok()?.trim().to_string();
    if path.is_empty() {
        return None;
    }
    if !path.ends_with(".png") {
        path.push_str(".png");
    }

    std::fs::write(&path, bytes).ok()?;
    Some(path)
}

#[cfg(not(target_os = "linux"))]
async fn save_file_rfd(
    app: tauri::AppHandle,
    bytes: Vec<u8>,
    default_name: String,
) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = tokio::sync::oneshot::channel();

    app.dialog()
        .file()
        .set_file_name(&default_name)
        .add_filter("PNG image", &["png"])
        .save_file(move |path| {
            let _ = tx.send(path.map(|p| p.to_string()));
        });

    let path = rx.await.ok().flatten()?;
    std::fs::write(&path, bytes).ok()?;
    Some(path)
}
