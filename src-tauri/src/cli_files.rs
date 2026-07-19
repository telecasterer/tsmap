// Parses tsmap's command-line file arguments — positional data-file paths,
// `--list <file>` (one path per line), `--tests <file>` (test-selection CSV),
// `--splits <file>` (wafer-splits CSV) — into absolute paths. Used identically
// for the initial launch's own `std::env::args()` and for argv forwarded by
// `tauri_plugin_single_instance` on a relaunch, so there is exactly one place
// that understands this syntax regardless of which process saw it.
//
// Argument *syntax* is validated unconditionally, before any Tauri/GTK/
// single-instance machinery runs (see `strip_snap_gtk_env_vars`'s sibling
// checks at the top of `run()` in lib.rs) — an unrecognized flag or a missing
// flag value is a hard error printed to the invoking terminal, never silently
// swallowed or misread as a data-file path. Because this happens before a
// process ever decides whether it's the primary instance or a forwarded one,
// a second `tsmap --typo`'d launch reports its own error in its own terminal
// rather than being silently forwarded (or dropped) into a running instance.

use serde::{Deserialize, Serialize};
use std::io::{BufRead, IsTerminal};
use std::path::Path;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct CliArgs {
    pub files: Vec<String>,
    pub tests: Option<String>,
    pub splits: Option<String>,
}

impl CliArgs {
    pub fn is_empty(&self) -> bool {
        self.files.is_empty()
    }
}

pub const USAGE: &str = "\
tsmap [OPTIONS] [FILE...]

Open one or more wafer-map data files (STDF, ATDF, CSV, JSON, or a .zip/.gz
of one of those). If tsmap is already running, files are handed to that
window instead of opening a new one.

Arguments:
  FILE...              One or more data files to open.

Options:
  --list <FILE>         A text file of data-file paths, one per line
                         (blank lines and '#' comments skipped).
  --tests <FILE>        A test-selection list (same CSV the test selector's
                         \"Save list\" button produces) — pre-fills the
                         selector; it is still always shown for confirmation.
  --splits <FILE>       A wafer-splits CSV (same format the Splits… dialog
                         saves/loads) — applied automatically once loaded.
  --new-instance         Open a new, independent window even if tsmap is
                         already running.
  -h, --help             Show this help and exit.

With no FILE/--list given, tsmap reads a newline-delimited list of data-file
paths from stdin, but only if stdin is piped (never when run interactively).
";

/// True if `args` (raw, unfiltered) requests help — checked first, before any
/// other parsing, so `--help` always wins even alongside other/bad flags.
pub fn wants_help(args: &[String]) -> bool {
    args.iter().any(|a| a == "--help" || a == "-h")
}

fn resolve_path(raw: &str, cwd: &Path) -> String {
    let p = Path::new(raw);
    if p.is_absolute() { raw.to_string() } else { cwd.join(p).to_string_lossy().into_owned() }
}

fn is_content_line(line: &str) -> bool {
    !line.is_empty() && !line.starts_with('#')
}

fn read_list_lines(path: &str, cwd: &Path) -> Result<Vec<String>, String> {
    let list_path = resolve_path(path, cwd);
    let text = std::fs::read_to_string(&list_path)
        .map_err(|e| format!("Failed to read list file {list_path}: {e}"))?;
    Ok(text.lines().map(str::trim).filter(|l| is_content_line(l)).map(|l| resolve_path(l, cwd)).collect())
}

struct RawArgs {
    files: Vec<String>,
    list: Option<String>,
    tests: Option<String>,
    splits: Option<String>,
}

/// Recognized flags that take a value — `--list`/`--tests`/`--splits`.
const VALUE_FLAGS: &[&str] = &["--list", "--tests", "--splits"];
/// Recognized flags that take no value — handled elsewhere (`--new-instance`
/// before this point, `--help`/`-h` via `wants_help` before this point too)
/// but still accepted here so they're never misreported as unrecognized.
const BARE_FLAGS: &[&str] = &["--new-instance", "--help", "-h"];

/// Splits raw argv (already excluding argv[0]) into its parts. A token
/// starting with `-` that isn't one of the flags above is a hard error
/// (`unrecognized option`), never silently dropped or treated as a file path
/// — that includes single-dash typos of a double-dash flag. A value flag with
/// nothing after it, or with another flag immediately after it, is also an
/// error rather than one flag silently swallowing the next flag as its value.
fn parse_args(args: &[String]) -> Result<RawArgs, String> {
    let mut files = Vec::new();
    let mut list = None;
    let mut tests = None;
    let mut splits = None;
    let mut iter = args.iter().peekable();
    while let Some(arg) = iter.next() {
        if let Some(pos) = VALUE_FLAGS.iter().position(|&f| f == arg.as_str()) {
            let looks_like_flag = iter.peek().is_some_and(|v| v.starts_with('-') && v.len() > 1);
            let value = if looks_like_flag { None } else { iter.next() };
            let value = value.ok_or_else(|| format!("{arg} requires a file path argument"))?;
            match pos {
                0 => list = Some(value.clone()),
                1 => tests = Some(value.clone()),
                _ => splits = Some(value.clone()),
            }
        } else if BARE_FLAGS.contains(&arg.as_str()) {
            // No-op here — handled earlier (`--help`/`-h`) or by the caller
            // (`--new-instance`, stripped from `args` before this is called).
        } else if arg.starts_with('-') && arg.len() > 1 {
            return Err(format!(
                "unrecognized option '{arg}'\n\nRun 'tsmap --help' for usage."
            ));
        } else {
            files.push(arg.clone());
        }
    }
    Ok(RawArgs { files, list, tests, splits })
}

/// Parses and resolves `args` against `cwd`: `--list`'s lines are folded into
/// `files` alongside any positional paths, and `--tests`/`--splits` are
/// resolved to absolute paths. `cwd` is the *invoking* process's working
/// directory — `std::env::current_dir()` on the initial launch, or the `cwd`
/// the single-instance plugin forwards on a relaunch (never the already-running
/// process's own cwd, which would silently resolve paths wrong).
pub fn resolve(args: &[String], cwd: &Path) -> Result<CliArgs, String> {
    let raw = parse_args(args)?;
    let mut files: Vec<String> = raw.files.iter().map(|f| resolve_path(f, cwd)).collect();
    if let Some(list_path) = raw.list {
        files.extend(read_list_lines(&list_path, cwd)?);
    }
    Ok(CliArgs {
        files,
        tests: raw.tests.map(|t| resolve_path(&t, cwd)),
        splits: raw.splits.map(|s| resolve_path(&s, cwd)),
    })
}

/// True when stdin is piped/redirected rather than an interactive terminal —
/// gates whether `read_stdin_paths` should be attempted at all, so a bare
/// `tsmap` launched from a terminal never blocks waiting on stdin.
pub fn stdin_is_piped() -> bool {
    !std::io::stdin().is_terminal()
}

/// Reads newline-delimited file paths from stdin (blank/`#`-comment lines
/// skipped), resolved against `cwd`. Only ever called for the initial launch's
/// own stdin — a forwarded relaunch's stdin is never seen by the running
/// instance (the single-instance plugin only forwards argv and cwd).
pub fn read_stdin_paths(cwd: &Path) -> Vec<String> {
    std::io::stdin()
        .lock()
        .lines()
        .map_while(Result::ok)
        .map(|l| l.trim().to_string())
        .filter(|l| is_content_line(l))
        .map(|l| resolve_path(&l, cwd))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn empty_input_yields_empty_args() {
        let cwd = Path::new("/cwd");
        let resolved = resolve(&args(&[]), cwd).unwrap();
        assert_eq!(resolved, CliArgs::default());
        assert!(resolved.is_empty());
    }

    #[test]
    fn positional_files_resolved_against_cwd() {
        let cwd = Path::new("/cwd");
        let resolved = resolve(&args(&["a.stdf", "/abs/b.stdf"]), cwd).unwrap();
        assert_eq!(resolved.files, vec!["/cwd/a.stdf".to_string(), "/abs/b.stdf".to_string()]);
    }

    #[test]
    fn tests_and_splits_flags_resolved() {
        let cwd = Path::new("/cwd");
        let resolved = resolve(&args(&["--tests", "t.csv", "--splits", "/abs/s.csv"]), cwd).unwrap();
        assert_eq!(resolved.tests.as_deref(), Some("/cwd/t.csv"));
        assert_eq!(resolved.splits.as_deref(), Some("/abs/s.csv"));
        assert!(resolved.files.is_empty());
    }

    #[test]
    fn new_instance_flag_does_not_error() {
        let cwd = Path::new("/cwd");
        let resolved = resolve(&args(&["--new-instance", "a.stdf"]), cwd).unwrap();
        assert_eq!(resolved.files, vec!["/cwd/a.stdf".to_string()]);
    }

    #[test]
    fn unknown_double_dash_flag_is_an_error() {
        let cwd = Path::new("/cwd");
        let err = resolve(&args(&["--future-flag", "a.stdf"]), cwd).unwrap_err();
        assert!(err.contains("--future-flag"), "error was: {err}");
    }

    #[test]
    fn unknown_single_dash_flag_is_an_error_not_a_file() {
        // A typo'd `-tests` (single dash) must not silently become a "file"
        // named "-tests" — it should be rejected the same as an unknown `--` flag.
        let cwd = Path::new("/cwd");
        let err = resolve(&args(&["-tests", "t.csv"]), cwd).unwrap_err();
        assert!(err.contains("-tests"), "error was: {err}");
    }

    #[test]
    fn value_flag_with_no_value_is_an_error() {
        let cwd = Path::new("/cwd");
        let err = resolve(&args(&["--tests"]), cwd).unwrap_err();
        assert!(err.contains("--tests"), "error was: {err}");
    }

    #[test]
    fn value_flag_followed_by_another_flag_does_not_swallow_it() {
        let cwd = Path::new("/cwd");
        let err = resolve(&args(&["--tests", "--splits", "s.csv"]), cwd).unwrap_err();
        assert!(err.contains("--tests"), "error was: {err}");
    }

    #[test]
    fn wants_help_detects_long_and_short_form() {
        assert!(wants_help(&args(&["--help"])));
        assert!(wants_help(&args(&["-h"])));
        assert!(wants_help(&args(&["a.stdf", "--help"])));
        assert!(!wants_help(&args(&["a.stdf"])));
    }

    #[test]
    fn list_file_combines_with_positional_and_skips_blanks_and_comments() {
        let dir = tempfile::tempdir().unwrap();
        let list_path = dir.path().join("list.txt");
        std::fs::write(&list_path, "# a comment\n\nrel.stdf\n/abs/other.stdf\n").unwrap();

        let resolved = resolve(
            &args(&["first.stdf", "--list", list_path.to_str().unwrap()]),
            dir.path(),
        )
        .unwrap();

        assert_eq!(
            resolved.files,
            vec![
                dir.path().join("first.stdf").to_string_lossy().into_owned(),
                dir.path().join("rel.stdf").to_string_lossy().into_owned(),
                "/abs/other.stdf".to_string(),
            ]
        );
    }

    #[test]
    fn missing_list_file_is_an_error() {
        let cwd = Path::new("/cwd");
        let err = resolve(&args(&["--list", "/no/such/file.txt"]), cwd).unwrap_err();
        assert!(err.contains("/no/such/file.txt"));
    }
}
