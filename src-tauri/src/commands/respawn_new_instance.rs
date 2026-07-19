use crate::cli_files::CliArgs;
use std::process::Command;

/// Launches a brand-new, independent tsmap process for `args` — used when the
/// already-running instance's user declines to replace their current view
/// with files forwarded from a second `tsmap <files>` invocation. `--new-instance`
/// tells the new process to skip registering the single-instance plugin, so it
/// opens its own window rather than itself being forwarded straight back here.
#[tauri::command]
pub fn respawn_new_instance(args: CliArgs) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| format!("Failed to resolve current executable: {e}"))?;
    let mut cmd = Command::new(exe);
    cmd.arg("--new-instance");
    if let Some(tests) = &args.tests {
        cmd.arg("--tests").arg(tests);
    }
    if let Some(splits) = &args.splits {
        cmd.arg("--splits").arg(splits);
    }
    cmd.args(&args.files);
    cmd.spawn().map(|_| ()).map_err(|e| format!("Failed to launch new tsmap instance: {e}"))
}
