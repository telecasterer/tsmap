use std::io::Read;
use std::path::{Path, PathBuf};

const SUPPORTED_EXTS: &[&str] = &["stdf", "std", "atdf", "atd", "csv", "txt", "dat", "json", "gz"];

fn is_supported(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| SUPPORTED_EXTS.contains(&e.to_lowercase().as_str()))
        .unwrap_or(false)
}

fn temp_dir() -> PathBuf {
    std::env::temp_dir().join("tsmap_extract")
}

/// Extract a .zip archive and return the paths of the extracted files.
/// .gz files are handled in-process by the parsers and do not need extraction.
/// Caller is responsible for cleanup via `cleanup_extract`.
#[tauri::command]
pub fn extract_archive(path: String) -> Result<Vec<String>, String> {
    let src = PathBuf::from(&path);
    let ext = src.extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    let out_dir = temp_dir();
    std::fs::create_dir_all(&out_dir).map_err(|e| e.to_string())?;

    match ext.as_str() {
        "zip" => extract_zip(&src, &out_dir),
        _ => Err(format!("Unsupported archive format: {}", ext)),
    }
}

/// Delete all files previously extracted to the temp dir.
#[tauri::command]
pub fn cleanup_extract() {
    let _ = std::fs::remove_dir_all(temp_dir());
}

fn extract_zip(src: &Path, out_dir: &Path) -> Result<Vec<String>, String> {
    let in_file = std::fs::File::open(src).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(in_file).map_err(|e| e.to_string())?;

    let mut extracted: Vec<String> = Vec::new();

    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
        if entry.is_dir() { continue; }

        // Use only the filename, ignoring any directory structure in the zip
        let name = entry.name().to_string();
        let file_name = Path::new(&name)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or(&name)
            .to_string();

        if !is_supported(Path::new(&file_name)) { continue; }

        // Avoid collisions from duplicate filenames in different zip dirs
        let out_path = unique_path(out_dir, &file_name);

        let mut buf = Vec::with_capacity(entry.size() as usize);
        entry.read_to_end(&mut buf).map_err(|e| e.to_string())?;
        std::fs::write(&out_path, &buf).map_err(|e| e.to_string())?;

        extracted.push(out_path.to_string_lossy().into_owned());
    }

    if extracted.is_empty() {
        return Err("No supported files found in zip archive".to_string());
    }

    Ok(extracted)
}

/// Returns `dir/name`, or `dir/name_2`, `dir/name_3` etc. if the path already exists.
fn unique_path(dir: &Path, file_name: &str) -> PathBuf {
    let base = Path::new(file_name);
    let stem = base.file_stem().and_then(|s| s.to_str()).unwrap_or(file_name);
    let ext  = base.extension().and_then(|e| e.to_str());

    let mut candidate = dir.join(file_name);
    let mut n = 2u32;
    while candidate.exists() {
        let name = match ext {
            Some(e) => format!("{}_{}.{}", stem, n, e),
            None    => format!("{}_{}", stem, n),
        };
        candidate = dir.join(name);
        n += 1;
    }
    candidate
}
