use std::io::Read;

pub fn decompress_if_gzip(bytes: Vec<u8>) -> Result<Vec<u8>, String> {
    // Detect gzip by magic bytes (1f 8b)
    if bytes.len() >= 2 && bytes[0] == 0x1f && bytes[1] == 0x8b {
        let mut buf = Vec::new();
        flate2::read::GzDecoder::new(bytes.as_slice())
            .read_to_end(&mut buf)
            .map_err(|e| format!("gz decompress failed: {}", e))?;
        Ok(buf)
    } else {
        Ok(bytes)
    }
}

#[cfg(feature = "native")]
pub fn read_bytes(path: &str) -> Result<Vec<u8>, String> {
    use std::path::Path;
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

#[cfg(feature = "native")]
pub fn read_text(path: &str) -> Result<String, String> {
    let bytes = read_bytes(path)?;
    String::from_utf8(bytes).map_err(|e| format!("UTF-8 decode failed: {}", e))
}
