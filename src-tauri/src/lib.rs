mod cli_files;
mod commands;
use commands::{atdf_test_names, cleanup_extract, csv_headers, extract_archive, get_last_dir, get_startup_files, json_headers, parse_atdf, parse_atdf_filtered, parse_csv, parse_json, parse_stdf, parse_stdf_filtered, read_text_file, respawn_new_instance, set_last_dir, stdf_test_names, write_temp_html};
use commands::get_startup_files::set_startup_args;
use tauri::{Emitter, Manager, WindowEvent};

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

/// Strips GTK/GDK/GIO/locale env vars that snap-packaged apps (VS Code's snap
/// build in particular) inject into every process launched from their
/// terminal — `GTK_PATH`/`GTK_EXE_PREFIX` point GTK's module loader at the
/// snap's bundled GTK 3 tree, and `GDK_PIXBUF_MODULE_FILE`/`GTK_IM_MODULE_FILE`
/// point at cached module manifests (`~/snap/code/common/.cache/*.cache`)
/// listing `.so` paths inside that same snap tree. When webkit2gtk initializes
/// GTK here, it dlopen()s a pixbuf-loader/immodule `.so` from *inside* the
/// snap (built against the snap's own core20 base), which pulls in that
/// base's `libpthread.so.0` — versioned against a different glibc than the
/// one already loaded into this process, so symbol resolution fails
/// (`undefined symbol: __libc_pthread_init, version GLIBC_PRIVATE`) before a
/// window ever appears. `npm run tauri`'s dev wrapper already works around
/// this with `env -u ...`, but that only covers `npm run tauri dev` — the
/// *installed* binary, launched directly from any terminal that inherited a
/// snap's environment, had no such protection. Stripping these here, before
/// GTK initializes, fixes it at the source regardless of how tsmap is invoked.
/// # Safety
/// Must run before any other thread that might read/write the environment is
/// spawned — true here since this is the first thing `run()` does, before the
/// Tauri/tokio runtime (or anything else) starts.
#[cfg(target_os = "linux")]
fn strip_snap_gtk_env_vars() {
    for var in [
        "GTK_PATH",
        "GTK_EXE_PREFIX",
        "GDK_PIXBUF_MODULE_FILE",
        "GDK_PIXBUF_MODULEDIR",
        "GIO_MODULE_DIR",
        "GTK_IM_MODULE_FILE",
        "LOCPATH",
    ] {
        unsafe { std::env::remove_var(var) };
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(target_os = "linux")]
    strip_snap_gtk_env_vars();

    // Parse this process's own argv/stdin before the builder exists, so the
    // resolved files are ready the instant the frontend asks for them via
    // `get_startup_files`. `--new-instance` (used internally when the user
    // declines a replace-prompt from a forwarded relaunch — see below, and as
    // a documented escape hatch for anyone who wants two tsmap windows on
    // purpose) skips single-instance registration entirely for this launch.
    //
    // `--help`/an invalid flag is handled here, unconditionally, before any
    // Tauri/GTK/single-instance machinery runs — so it always prints to *this*
    // process's own terminal and exits immediately, regardless of whether it
    // ends up being the primary instance or forwarded to one. A syntax error
    // here (unrecognized flag, missing value) is never silently dropped or
    // misread as a data-file path — see cli_files.rs's module doc.
    let raw_args: Vec<String> = std::env::args().skip(1).collect();
    if cli_files::wants_help(&raw_args) {
        print!("{}", cli_files::USAGE);
        std::process::exit(0);
    }
    let skip_singleton = raw_args.iter().any(|a| a == "--new-instance");
    let cwd = std::env::current_dir().unwrap_or_default();

    let mut initial_args = match cli_files::resolve(&raw_args, &cwd) {
        Ok(a) => a,
        Err(e) => {
            eprintln!("tsmap: {e}\n");
            eprint!("{}", cli_files::USAGE);
            std::process::exit(1);
        }
    };
    if initial_args.is_empty() && !skip_singleton && cli_files::stdin_is_piped() {
        initial_args.files = cli_files::read_stdin_paths(&cwd);
    }
    set_startup_args(initial_args);

    let mut builder = tauri::Builder::default();
    if !skip_singleton {
        // Must be the first plugin registered (per the plugin's own docs). The
        // duplicate process that triggered this callback has already been (or
        // is about to be) closed automatically by the plugin itself — there is
        // nothing further to do with it here. The accept/replace-vs-respawn
        // decision deliberately isn't made here: the frontend is the one that
        // knows whether there's unsaved in-progress state worth protecting.
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, cwd_str| {
            let args: Vec<String> = argv.into_iter().skip(1).collect();
            let cwd = std::path::PathBuf::from(cwd_str);
            let resolved = match cli_files::resolve(&args, &cwd) {
                Ok(r) if !r.is_empty() => r,
                Ok(_) => return,
                Err(e) => {
                    eprintln!("tsmap: {e}");
                    return;
                }
            };
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
            let _ = app.emit("cli-open-files", resolved);
        }));
    }

    builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                size_and_show_main_window(&window);

                #[cfg(target_os = "linux")]
                {
                    let window_clone = window.clone();
                    let window_for_focus = window_clone.clone();
                    window_clone.on_window_event(move |event| match event {
                        WindowEvent::Focused(true) => {
                            let _ = window_for_focus.set_resizable(false);
                            let _ = window_for_focus.set_resizable(true);
                        }
                        _ => {}
                    });
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![atdf_test_names, cleanup_extract, csv_headers, extract_archive, get_last_dir, get_startup_files, json_headers, parse_atdf, parse_atdf_filtered, parse_csv, parse_json, parse_stdf, parse_stdf_filtered, read_text_file, respawn_new_instance, set_last_dir, stdf_test_names, write_temp_html])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
