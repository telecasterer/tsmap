use std::io::Write;

#[tauri::command]
pub fn write_temp_html(html: String) -> Result<(), String> {
    // /tmp is inaccessible to snap-sandboxed browsers (e.g. Firefox snap on Ubuntu).
    // Write to $HOME instead, which snap apps can read.
    let path = std::env::var("HOME")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("tsmap-report.html");
    std::fs::File::create(&path)
        .and_then(|mut f| f.write_all(html.as_bytes()))
        .map_err(|e| e.to_string())?;

    // opener:allow-open-path is gated by the fs scope, which doesn't cover /tmp.
    // Shell out to the platform opener instead.
    #[cfg(target_os = "linux")]
    {
        let mut cmd = std::process::Command::new("xdg-open");
        cmd.arg(&path);
        for var in &["WAYLAND_DISPLAY", "XDG_RUNTIME_DIR", "DISPLAY", "DBUS_SESSION_BUS_ADDRESS"] {
            if let Ok(v) = std::env::var(var) { cmd.env(var, v); }
        }
        cmd.stderr(std::process::Stdio::null());
        cmd.spawn().map_err(|e| format!("xdg-open failed: {e}"))?;
    }
    #[cfg(target_os = "macos")]
    std::process::Command::new("open").arg(&path).spawn()
        .map_err(|e| format!("open failed: {e}"))?;
    #[cfg(target_os = "windows")]
    std::process::Command::new("cmd").args(["/C", "start", &path.to_string_lossy()]).spawn()
        .map_err(|e| format!("start failed: {e}"))?;

    Ok(())
}
