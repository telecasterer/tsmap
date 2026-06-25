mod commands;
use commands::{atdf_test_names, cleanup_extract, csv_headers, extract_archive, get_last_dir, json_headers, parse_atdf, parse_atdf_filtered, parse_csv, parse_json, parse_stdf, parse_stdf_filtered, read_text_file, set_last_dir, stdf_test_names, write_temp_html};

/// Size the main window to 80% of its monitor and centre it on that monitor, then
/// reveal it. The window is created hidden (`"visible": false` in tauri.conf.json)
/// so the user never sees the fallback 1000×700 flash before this runs. If monitor
/// info is unavailable we just show the window at its configured fallback size.
///
/// We compute the centred position ourselves and call `set_position` rather than
/// relying on `center()`. `center()` reads the *current* window size, but a
/// preceding `set_size` is applied asynchronously by the compositor on every
/// platform — so `center()` races against the resize and lands off-centre (this is
/// what we saw). Doing the maths from the monitor geometry + the size we're about
/// to set is deterministic and works identically on Windows, macOS, and Linux. All
/// position maths is in physical pixels including the monitor's own origin offset,
/// so multi-monitor layouts (non-zero origins on Windows/macOS) centre correctly.
fn size_and_show_main_window(window: &tauri::WebviewWindow) {
    use tauri::{LogicalSize, PhysicalPosition, PhysicalSize};

    // current_monitor() is the monitor the window was placed on; fall back to the
    // primary monitor, then to just showing the configured size.
    let monitor = window
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| window.primary_monitor().ok().flatten());

    if let Some(monitor) = monitor {
        let PhysicalSize { width: mon_w, height: mon_h } = *monitor.size();
        let mon_pos: PhysicalPosition<i32> = *monitor.position();
        let scale = monitor.scale_factor();

        // 80% of the monitor, computed in logical px (consistent across HiDPI),
        // clamped up to the min size declared in tauri.conf.json (640×480).
        let logical_w = ((mon_w as f64 / scale) * 0.8).max(640.0);
        let logical_h = ((mon_h as f64 / scale) * 0.8).max(480.0);
        let _ = window.set_size(LogicalSize::new(logical_w, logical_h));

        // Centre by computing the position ourselves, in physical px, offset by the
        // monitor's origin so the correct monitor is targeted on multi-display setups.
        let win_w = (logical_w * scale).round() as i32;
        let win_h = (logical_h * scale).round() as i32;
        let x = mon_pos.x + ((mon_w as i32 - win_w) / 2).max(0);
        let y = mon_pos.y + ((mon_h as i32 - win_h) / 2).max(0);

        // Show BEFORE positioning. Some X11/XWayland window managers (the case for
        // an Ubuntu-Wayland desktop reached over XWayland/VNC) ignore a position set
        // on a not-yet-mapped window, which is what made the first attempt land
        // off-centre. Positioning the mapped window sticks; the reposition happens
        // immediately, so there's no visible jump. (A pure-Wayland compositor may
        // still override this — positioning is the compositor's prerogative there —
        // but sizing always applies and the window opens centred under XWayland.)
        let _ = window.show();
        let _ = window.set_position(PhysicalPosition::new(x, y));
        let _ = window.set_size(LogicalSize::new(logical_w, logical_h));
    } else {
        // No monitor info — at least centre at the configured fallback size.
        let _ = window.show();
        let _ = window.center();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
            use tauri::Manager;
            if let Some(window) = app.get_webview_window("main") {
                size_and_show_main_window(&window);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![atdf_test_names, cleanup_extract, csv_headers, extract_archive, get_last_dir, json_headers, parse_atdf, parse_atdf_filtered, parse_csv, parse_json, parse_stdf, parse_stdf_filtered, read_text_file, set_last_dir, stdf_test_names, write_temp_html])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
