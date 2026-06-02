use std::io::Read;
use std::path::Path;

/// Read a file to bytes, decompressing gzip transparently.
/// Plain files are read directly; .gz files are decompressed in-memory.
pub fn read_bytes(path: &str) -> Result<Vec<u8>, String> {
    let is_gz = Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.eq_ignore_ascii_case("gz"))
        .unwrap_or(false);

    let file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let mut buf = Vec::new();
    if is_gz {
        flate2::read::GzDecoder::new(file)
            .read_to_end(&mut buf)
            .map_err(|e| format!("gz decompress failed: {}", e))?;
    } else {
        std::io::BufReader::new(file)
            .read_to_end(&mut buf)
            .map_err(|e| e.to_string())?;
    }
    Ok(buf)
}

/// Read a file to a UTF-8 string, decompressing gzip transparently.
pub fn read_text(path: &str) -> Result<String, String> {
    let bytes = read_bytes(path)?;
    String::from_utf8(bytes).map_err(|e| format!("UTF-8 decode failed: {}", e))
}
