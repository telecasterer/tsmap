use crate::cli_files::CliArgs;
use std::sync::Mutex;

static STARTUP_ARGS: Mutex<Option<CliArgs>> = Mutex::new(None);

/// Called once from `run()`, before the builder is constructed, with whatever
/// files/tests/splits were resolved from this process's own argv/stdin.
pub fn set_startup_args(args: CliArgs) {
    if !args.is_empty() {
        *STARTUP_ARGS.lock().unwrap() = Some(args);
    }
}

/// Consumed exactly once by the frontend at startup — `take()` so a later
/// call never re-delivers the same files.
#[tauri::command]
pub fn get_startup_files() -> Option<CliArgs> {
    STARTUP_ARGS.lock().unwrap().take()
}
