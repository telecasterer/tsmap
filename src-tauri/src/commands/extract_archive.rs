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

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    // Build a zip archive in a tempfile containing the given (name, content) entries.
    fn make_zip(entries: &[(&str, &[u8])]) -> std::path::PathBuf {
        let mut f = tempfile::Builder::new().suffix(".zip").tempfile().unwrap();
        let mut zip = zip::ZipWriter::new(&mut f);
        let opts = zip::write::SimpleFileOptions::default();
        for (name, data) in entries {
            zip.start_file(*name, opts).unwrap();
            zip.write_all(data).unwrap();
        }
        zip.finish().unwrap();
        f.into_temp_path().keep().unwrap()
    }

    fn path_has_stem(p: &str, stem: &str) -> bool {
        std::path::Path::new(p)
            .file_name()
            .and_then(|n| n.to_str())
            .map(|n| n.starts_with(stem))
            .unwrap_or(false)
    }

    #[test]
    fn extracts_supported_files() {
        let path = make_zip(&[("ex_sup_a.atdf", b"FAR:A|4\n"), ("ex_sup_b.stdf", b"\x00\x0a")]);
        let result = extract_archive(path.to_str().unwrap().to_string()).unwrap();
        assert_eq!(result.len(), 2);
        assert!(result.iter().any(|p| path_has_stem(p, "ex_sup_a")));
        assert!(result.iter().any(|p| path_has_stem(p, "ex_sup_b")));
    }

    #[test]
    fn skips_unsupported_file_extensions() {
        let path = make_zip(&[
            ("ex_skip_a.atdf", b"FAR:A|4\n"),
            ("ex_skip_b.md",   b"# readme"),
            ("ex_skip_c.png",  b"\x89PNG"),
        ]);
        let result = extract_archive(path.to_str().unwrap().to_string()).unwrap();
        assert_eq!(result.len(), 1);
        assert!(path_has_stem(&result[0], "ex_skip_a"));
    }

    #[test]
    fn error_when_no_supported_files() {
        let path = make_zip(&[("ex_nosup.md", b"hello"), ("ex_nosup2.png", b"\x89PNG")]);
        let err = extract_archive(path.to_str().unwrap().to_string());
        assert!(err.is_err());
    }

    #[test]
    fn strips_directory_prefix_from_entry_names() {
        let path = make_zip(&[("subdir/ex_nodir.csv", b"x,y\n0,0\n")]);
        let result = extract_archive(path.to_str().unwrap().to_string()).unwrap();
        assert_eq!(result.len(), 1);
        assert!(path_has_stem(&result[0], "ex_nodir"), "got: {}", result[0]);
        assert!(!result[0].contains("subdir"));
    }

    #[test]
    fn deduplicates_colliding_filenames() {
        let path = make_zip(&[
            ("dir1/ex_dedup.csv", b"x,y\n0,0\n"),
            ("dir2/ex_dedup.csv", b"x,y\n1,1\n"),
        ]);
        let result = extract_archive(path.to_str().unwrap().to_string()).unwrap();
        assert_eq!(result.len(), 2);
        assert_ne!(result[0], result[1]);
    }

    #[test]
    fn skips_directory_entries() {
        let path = make_zip(&[("mydir/", b""), ("mydir/ex_skipdir.csv", b"x,y\n0,0\n")]);
        let result = extract_archive(path.to_str().unwrap().to_string()).unwrap();
        assert_eq!(result.len(), 1);
    }

    #[test]
    fn gz_entries_in_zip_are_extracted() {
        let path = make_zip(&[("ex_gz.stdf.gz", b"\x1f\x8b\x00")]);
        let result = extract_archive(path.to_str().unwrap().to_string()).unwrap();
        assert_eq!(result.len(), 1);
        assert!(path_has_stem(&result[0], "ex_gz"));
    }

    #[test]
    fn unsupported_archive_format_returns_error() {
        let mut f = tempfile::Builder::new().suffix(".tar").tempfile().unwrap();
        f.write_all(b"fake tar data").unwrap();
        let path = f.into_temp_path().keep().unwrap();
        let err = extract_archive(path.to_str().unwrap().to_string());
        assert!(err.is_err());
        assert!(err.unwrap_err().contains("Unsupported"));
    }

    #[test]
    fn extracted_files_are_readable() {
        let csv = b"x,y\n0,0\n1,1\n";
        let path = make_zip(&[("ex_readable.csv", csv)]);
        let result = extract_archive(path.to_str().unwrap().to_string()).unwrap();
        let content = std::fs::read(&result[0]).unwrap();
        assert_eq!(content, csv);
    }
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
