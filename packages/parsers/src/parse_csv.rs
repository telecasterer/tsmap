use csv::ReaderBuilder;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::io::Read;
use crate::types::*;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CsvHeadersResult {
    pub headers: Vec<String>,
    pub sample: Vec<HashMap<String, String>>,
    pub row_count: usize,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CsvTestCol {
    pub col: String,
    pub test_number: u32,
    pub name: String,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CsvMapping {
    pub x: String,
    pub y: String,
    pub hbin: Option<String>,
    pub sbin: Option<String>,
    pub wafer: Option<String>,
    pub lot: Option<String>,
    /// Optional column mapped to the per-die test site (STDF `site_num`). Parsed
    /// numerically; non-numeric values become no site for that die. `#[serde(default)]`
    /// so older mapping payloads without the field still deserialize.
    #[serde(default)]
    pub site: Option<String>,
    pub tests: Vec<CsvTestCol>,
    pub meta: Vec<String>,
    pub split_by: Vec<String>,
    pub testname_col: Option<String>,
    pub testvalue_col: Option<String>,
    pub lo_limit_col: Option<String>,
    pub hi_limit_col: Option<String>,
    pub units_col: Option<String>,
    pub pass_bins: Vec<u32>,
}

pub fn csv_headers_from_bytes(bytes: &[u8]) -> Result<CsvHeadersResult, String> {
    let bytes = crate::read_file::decompress_if_gzip(bytes.to_vec())?;
    let mut rdr = build_reader_from_bytes(&bytes);
    let headers: Vec<String> = rdr
        .headers()
        .map_err(|e| e.to_string())?
        .iter()
        .map(|s| s.trim().to_string())
        .collect();

    let mut sample: Vec<HashMap<String, String>> = Vec::new();
    for result in rdr.records() {
        let rec = result.map_err(|e| e.to_string())?;
        let row: HashMap<String, String> = headers
            .iter()
            .enumerate()
            .map(|(i, h)| (h.clone(), rec.get(i).unwrap_or("").trim().to_string()))
            .collect();
        sample.push(row);
        if sample.len() >= 5 { break; }
    }

    let row_count = bytes.iter().filter(|&&b| b == b'\n').count().saturating_sub(1);
    Ok(CsvHeadersResult { headers, sample, row_count })
}

pub fn parse_csv_from_bytes(bytes: &[u8], mapping: CsvMapping) -> Result<ParsedStdf, String> {
    let bytes = crate::read_file::decompress_if_gzip(bytes.to_vec())?;
    parse_csv_from_reader(build_reader_from_bytes(&bytes), mapping)
}

#[cfg(feature = "native")]
pub fn csv_headers_inner(path: String) -> Result<CsvHeadersResult, String> {
    let mut rdr = build_reader(&path)?;
    let headers: Vec<String> = rdr
        .headers()
        .map_err(|e| e.to_string())?
        .iter()
        .map(|s| s.trim().to_string())
        .collect();

    let mut sample: Vec<HashMap<String, String>> = Vec::new();
    for result in rdr.records() {
        let rec = result.map_err(|e| e.to_string())?;
        let row: HashMap<String, String> = headers
            .iter()
            .enumerate()
            .map(|(i, h)| (h.clone(), rec.get(i).unwrap_or("").trim().to_string()))
            .collect();
        sample.push(row);
        if sample.len() >= 5 { break; }
    }

    let row_count = std::fs::metadata(&path).ok().map(|m| {
        let file_bytes = m.len() as usize;
        if sample.is_empty() { return 0; }
        let sample_bytes: usize = sample.iter()
            .map(|row| row.values().map(|v| v.len() + 2).sum::<usize>())
            .sum();
        let avg = sample_bytes / sample.len();
        if avg == 0 { 0 } else { file_bytes / avg }
    }).unwrap_or(0);

    Ok(CsvHeadersResult { headers, sample, row_count })
}

#[cfg(feature = "native")]
pub fn parse_csv_inner(path: String, mapping: CsvMapping) -> Result<ParsedStdf, String> {
    let rdr = build_reader(&path)?;
    parse_csv_from_reader(rdr, mapping)
}

fn parse_csv_from_reader(mut rdr: csv::Reader<Box<dyn Read>>, mapping: CsvMapping) -> Result<ParsedStdf, String> {
    let headers: Vec<String> = rdr
        .headers()
        .map_err(|e| e.to_string())?
        .iter()
        .map(|s| s.trim().to_string())
        .collect();

    let col_idx: HashMap<&str, usize> = headers
        .iter()
        .enumerate()
        .map(|(i, h)| (h.as_str(), i))
        .collect();

    let get = |rec: &csv::StringRecord, col: &str| -> String {
        col_idx
            .get(col)
            .and_then(|&i| rec.get(i))
            .unwrap_or("")
            .trim()
            .to_string()
    };

    let is_long_format = mapping.testname_col.is_some() && mapping.testvalue_col.is_some();

    let mut test_defs: HashMap<String, TestDef> = mapping
        .tests
        .iter()
        .map(|t| {
            (
                t.test_number.to_string(),
                TestDef {
                    name: t.name.clone(),
                    test_type: "P".to_string(),
                    lo_limit: None,
                    hi_limit: None,
                    units: None,
                },
            )
        })
        .collect();

    let all_rows: Vec<csv::StringRecord> = rdr
        .records()
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;

    // ── Wide-format fast path ──────────────────────────────────────────────────
    // The common case (one column per test). Read each StringRecord by resolved
    // column index, parsing values straight to their target type — no per-cell
    // HashMap<String,String>, no string round-trips, no `format!` per test cell.
    if !is_long_format {
        return Ok(parse_csv_wide(&all_rows, &col_idx, &mapping, test_defs));
    }

    // ── Long-format path (pivot rows → dies) ───────────────────────────────────
    // Less common: one row per (die, test). We discover test numbers dynamically
    // and pivot into a wide per-die HashMap; the structure below is unchanged.
    let active_rows: Vec<HashMap<String, String>>;
    let mut long_fmt_test_numbers: HashMap<String, u32> = HashMap::new();
    let mut next_test_num: u32 = 1001;

    {
        let name_col = mapping.testname_col.as_deref().unwrap();
        let val_col = mapping.testvalue_col.as_deref().unwrap();
        let mut die_map: indexmap::IndexMap<String, HashMap<String, String>> =
            indexmap::IndexMap::new();

        for rec in &all_rows {
            let x = get(rec, &mapping.x);
            let y = get(rec, &mapping.y);
            if x.is_empty() || y.is_empty() { continue; }

            let wafer = mapping.wafer.as_deref().map(|c| get(rec, c)).unwrap_or_default();
            let lot = mapping.lot.as_deref().map(|c| get(rec, c)).unwrap_or_default();
            let key = format!("{}\x00{}\x00{}\x00{}", wafer, lot, x, y);

            let wide = die_map.entry(key).or_insert_with(|| {
                let mut m = HashMap::new();
                m.insert(mapping.x.clone(), x.clone());
                m.insert(mapping.y.clone(), y.clone());
                if let Some(c) = &mapping.wafer { m.insert(c.clone(), wafer.clone()); }
                if let Some(c) = &mapping.lot   { m.insert(c.clone(), lot.clone()); }
                if let Some(c) = &mapping.hbin  { m.insert(c.clone(), get(rec, c)); }
                if let Some(c) = &mapping.sbin  { m.insert(c.clone(), get(rec, c)); }
                if let Some(c) = &mapping.site  { m.insert(c.clone(), get(rec, c)); }
                for c in &mapping.meta { m.insert(c.clone(), get(rec, c)); }
                m
            });

            let test_name = get(rec, name_col);
            let test_val  = get(rec, val_col);
            if test_name.is_empty() || test_val.is_empty() { continue; }

            let tnum = *long_fmt_test_numbers.entry(test_name.clone()).or_insert_with(|| {
                let n = next_test_num;
                next_test_num += 1;
                let lo_limit = mapping.lo_limit_col.as_deref()
                    .map(|c| get(rec, c)).filter(|s| !s.is_empty()).and_then(|s| s.parse::<f64>().ok());
                let hi_limit = mapping.hi_limit_col.as_deref()
                    .map(|c| get(rec, c)).filter(|s| !s.is_empty()).and_then(|s| s.parse::<f64>().ok());
                let units = mapping.units_col.as_deref()
                    .map(|c| get(rec, c)).filter(|s| !s.is_empty());
                test_defs.insert(n.to_string(), TestDef {
                    name: test_name.clone(),
                    test_type: "P".to_string(),
                    lo_limit, hi_limit, units,
                });
                n
            });
            wide.insert(format!("__test_{}", tnum), test_val);

            if let Some(c) = &mapping.hbin {
                let v = wide.get(c).cloned().unwrap_or_default();
                if v.is_empty() { wide.insert(c.clone(), get(rec, c)); }
            }
        }
        active_rows = die_map.into_values().collect();
    }

    let mut groups: indexmap::IndexMap<String, Vec<&HashMap<String, String>>> =
        indexmap::IndexMap::new();

    for row in &active_rows {
        let wid = mapping
            .wafer
            .as_deref()
            .and_then(|c| row.get(c))
            .filter(|v| !v.is_empty())
            .cloned()
            .unwrap_or_else(|| "W1".to_string());

        let split_parts: Vec<String> = mapping
            .split_by
            .iter()
            .filter_map(|col| {
                let v = row.get(col)?;
                if v.is_empty() { None } else { Some(format!("{}: {}", col, v)) }
            })
            .collect();

        let key = if split_parts.is_empty() {
            wid
        } else {
            format!("{} · {}", wid, split_parts.join(" · "))
        };

        groups.entry(key).or_default().push(row);
    }

    let has_hbin = mapping.hbin.is_some();
    let has_sbin = mapping.sbin.is_some();
    let pass_bin_set: HashSet<u32> = mapping.pass_bins.iter().copied().collect();

    let mut wafers: Vec<WaferData> = Vec::new();

    for (wid, rows) in &groups {
        let mut dies: Vec<DieResult> = Vec::new();

        for row in rows {
            let x: i32 = match row.get(&mapping.x).and_then(|v| v.parse().ok()) {
                Some(v) => v,
                None => continue,
            };
            let y: i32 = match row.get(&mapping.y).and_then(|v| v.parse().ok()) {
                Some(v) => v,
                None => continue,
            };

            let hbin: Option<u32> = if has_hbin {
                mapping.hbin.as_deref().and_then(|c| row.get(c)).and_then(|v| v.parse().ok())
            } else { None };

            let sbin: Option<u32> = if has_sbin {
                mapping.sbin.as_deref().and_then(|c| row.get(c)).and_then(|v| v.parse().ok())
            } else { None };

            // Per-die test site (parity with STDF/ATDF). Numeric only — a
            // non-numeric site label yields no site for that die.
            let site_num: Option<u32> = mapping.site.as_deref()
                .and_then(|c| row.get(c)).and_then(|v| v.trim().parse().ok());

            // Long format only (wide returns early above): test values were pivoted
            // into `__test_{n}` keys keyed by discovered test number.
            let mut test_values: HashMap<String, f64> = HashMap::new();
            for tnum in long_fmt_test_numbers.values() {
                let k = format!("__test_{}", tnum);
                if let Some(v) = row.get(&k).and_then(|s| s.parse::<f64>().ok()) {
                    test_values.insert(tnum.to_string(), v);
                }
            }

            dies.push(DieResult {
                x, y, hbin, sbin,
                site_num,
                part_id: None,
                test_values,
                test_pass: HashMap::new(),
            });
        }

        let part_count = dies.len() as u32;
        let good_count = dies.iter()
            .filter(|d| pass_bin_set.is_empty()
                || d.hbin.map_or(false, |b| pass_bin_set.contains(&b))
                || d.sbin.map_or(false, |b| pass_bin_set.contains(&b)))
            .count() as u32;

        wafers.push(WaferData {
            wafer_id: wid.clone(),
            results: dies,
            part_count: Some(part_count),
            good_count: Some(good_count),
            fail_count: Some(part_count - good_count),
            fields: Vec::new(),
        });
    }

    // Lot metadata from the mapped `lot` column plus every user-mapped metadata
    // column, taken from the first active row. Keyed by the column name so tsmap
    // surfaces them under their own labels (falling back to the raw key).
    let mut meta = LotMeta::default();
    if let Some(first) = active_rows.first() {
        if let Some(lot_col) = mapping.lot.as_deref() {
            meta.push("lotId", first.get(lot_col).cloned());
        }
        for col in &mapping.meta {
            meta.push(col, first.get(col).cloned());
        }
    }

    Ok(ParsedStdf { meta, wafers, test_defs, sites: vec![], warnings: vec![] })
}

/// Allocation-light wide-format parse: resolve every mapped column to an index
/// once, then read each `StringRecord` by index and parse straight to the target
/// type. Avoids the per-cell `HashMap<String,String>` materialisation, the string
/// round-trips for x/y/bins, and the per-test `format!` of the original path.
/// Result shape (wafers grouped by wafer/split key, part/good/fail counts, lot
/// metadata from the first kept row) matches the long-format path exactly.
fn parse_csv_wide(
    all_rows: &[csv::StringRecord],
    col_idx: &HashMap<&str, usize>,
    mapping: &CsvMapping,
    test_defs: HashMap<String, TestDef>,
) -> ParsedStdf {
    // Resolve a mapped column name to its record index once.
    let idx = |name: &str| col_idx.get(name).copied();
    let opt_idx = |c: &Option<String>| c.as_deref().and_then(idx);

    let x_i = idx(&mapping.x);
    let y_i = idx(&mapping.y);
    let hbin_i = opt_idx(&mapping.hbin);
    let sbin_i = opt_idx(&mapping.sbin);
    let site_i = opt_idx(&mapping.site);
    let wafer_i = opt_idx(&mapping.wafer);
    let lot_i = opt_idx(&mapping.lot);
    let split_i: Vec<(String, usize)> = mapping.split_by.iter()
        .filter_map(|c| idx(c).map(|i| (c.clone(), i))).collect();
    // (test_number string key, column index) — resolved once, reused per row.
    let test_i: Vec<(String, usize)> = mapping.tests.iter()
        .filter_map(|t| idx(&t.col).map(|i| (t.test_number.to_string(), i))).collect();

    fn cell(rec: &csv::StringRecord, i: usize) -> &str { rec.get(i).unwrap_or("").trim() }
    fn cell_opt(rec: &csv::StringRecord, i: Option<usize>) -> &str {
        i.map(|i| cell(rec, i)).unwrap_or("")
    }

    let pass_bin_set: HashSet<u32> = mapping.pass_bins.iter().copied().collect();

    // Group dies by wafer/split key, preserving first-seen order.
    let mut groups: indexmap::IndexMap<String, WaferData> = indexmap::IndexMap::new();
    // Lot metadata is taken from the first kept row.
    let mut first_kept: Option<csv::StringRecord> = None;

    for rec in all_rows {
        // x/y are required and numeric — skip the row otherwise (matches old behaviour).
        let x: i32 = match x_i.and_then(|i| cell(rec, i).parse().ok()) { Some(v) => v, None => continue };
        let y: i32 = match y_i.and_then(|i| cell(rec, i).parse().ok()) { Some(v) => v, None => continue };

        let wid = {
            let w = cell_opt(rec, wafer_i);
            if w.is_empty() { "W1" } else { w }
        };
        let key = if split_i.is_empty() {
            wid.to_string()
        } else {
            let parts: Vec<String> = split_i.iter()
                .filter_map(|(name, i)| {
                    let v = cell(rec, *i);
                    if v.is_empty() { None } else { Some(format!("{}: {}", name, v)) }
                })
                .collect();
            if parts.is_empty() { wid.to_string() } else { format!("{} · {}", wid, parts.join(" · ")) }
        };

        let hbin = hbin_i.and_then(|i| cell(rec, i).parse::<u32>().ok());
        let sbin = sbin_i.and_then(|i| cell(rec, i).parse::<u32>().ok());
        let site_num = site_i.and_then(|i| cell(rec, i).parse::<u32>().ok());

        let mut test_values: HashMap<String, f64> = HashMap::with_capacity(test_i.len());
        for (tnum, i) in &test_i {
            let s = cell(rec, *i);
            if !s.is_empty() {
                if let Ok(v) = s.parse::<f64>() { test_values.insert(tnum.clone(), v); }
            }
        }

        if first_kept.is_none() { first_kept = Some(rec.clone()); }

        let wafer = groups.entry(key).or_insert_with(|| WaferData {
            wafer_id: wid.to_string(),
            results: Vec::new(),
            part_count: None, good_count: None, fail_count: None,
            fields: Vec::new(),
        });
        wafer.results.push(DieResult { x, y, hbin, sbin, site_num, part_id: None, test_values, test_pass: HashMap::new() });
    }

    // Finalise per-wafer counts.
    let wafers: Vec<WaferData> = groups.into_values().map(|mut w| {
        let part = w.results.len() as u32;
        let good = w.results.iter().filter(|d|
            pass_bin_set.is_empty()
            || d.hbin.map_or(false, |b| pass_bin_set.contains(&b))
            || d.sbin.map_or(false, |b| pass_bin_set.contains(&b))
        ).count() as u32;
        w.part_count = Some(part);
        w.good_count = Some(good);
        w.fail_count = Some(part - good);
        w
    }).collect();

    // Lot metadata from the first kept row, keyed by column name.
    let mut meta = LotMeta::default();
    if let Some(rec) = &first_kept {
        if let Some(i) = lot_i { meta.push("lotId", Some(cell(rec, i).to_string())); }
        for c in &mapping.meta {
            if let Some(i) = idx(c) { meta.push(c, Some(cell(rec, i).to_string())); }
        }
    }

    ParsedStdf { meta, wafers, test_defs, sites: vec![], warnings: vec![] }
}

fn detect_delimiter(bytes: &[u8]) -> u8 {
    // Scan the first line to detect whether the file is comma, tab, or semicolon delimited.
    let first_line_end = bytes.iter().position(|&b| b == b'\n').unwrap_or(bytes.len());
    let first_line = &bytes[..first_line_end];
    let commas = first_line.iter().filter(|&&b| b == b',').count();
    let tabs   = first_line.iter().filter(|&&b| b == b'\t').count();
    let semis  = first_line.iter().filter(|&&b| b == b';').count();
    if tabs >= commas && tabs >= semis { b'\t' } else if semis > commas { b';' } else { b',' }
}

fn build_reader_from_bytes(bytes: &[u8]) -> csv::Reader<Box<dyn Read>> {
    let delim = detect_delimiter(bytes);
    let reader: Box<dyn Read> = Box::new(std::io::Cursor::new(bytes.to_vec()));
    ReaderBuilder::new()
        .delimiter(delim)
        .trim(csv::Trim::All)
        .comment(Some(b'#'))
        .flexible(true)
        .from_reader(reader)
}

#[cfg(feature = "native")]
fn build_reader(path: &str) -> Result<csv::Reader<Box<dyn Read>>, String> {
    let is_gz = std::path::Path::new(path)
        .extension().and_then(|e| e.to_str())
        .map(|e| e.eq_ignore_ascii_case("gz")).unwrap_or(false);

    let file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let reader: Box<dyn Read> = if is_gz {
        Box::new(flate2::read::GzDecoder::new(file))
    } else {
        Box::new(std::io::BufReader::new(file))
    };

    Ok(ReaderBuilder::new()
        .trim(csv::Trim::All)
        .comment(Some(b'#'))
        .flexible(true)
        .from_reader(reader))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn tmp(content: &str) -> std::path::PathBuf {
        let mut f = tempfile::NamedTempFile::new().unwrap();
        f.write_all(content.as_bytes()).unwrap();
        f.into_temp_path().keep().unwrap()
    }

    fn basic_mapping(x: &str, y: &str) -> CsvMapping {
        CsvMapping {
            x: x.to_string(),
            y: y.to_string(),
            hbin: None,
            sbin: None,
            wafer: None,
            lot: None,
            site: None,
            tests: vec![],
            meta: vec![],
            split_by: vec![],
            testname_col: None,
            testvalue_col: None,
            lo_limit_col: None,
            hi_limit_col: None,
            units_col: None,
            pass_bins: vec![],
        }
    }

    #[test]
    fn headers_returns_column_names() {
        let csv = "x,y,hbin\n1,2,1\n3,4,2\n";
        let path = tmp(csv);
        let result = csv_headers_inner(path.to_str().unwrap().to_string()).unwrap();
        assert_eq!(result.headers, vec!["x", "y", "hbin"]);
    }

    #[test]
    fn headers_trims_whitespace() {
        let csv = " x , y , val \n1,2,3\n";
        let path = tmp(csv);
        let result = csv_headers_inner(path.to_str().unwrap().to_string()).unwrap();
        assert_eq!(result.headers, vec!["x", "y", "val"]);
    }

    #[test]
    fn sample_contains_up_to_5_rows() {
        let mut csv = "x,y\n".to_string();
        for i in 0..10 { csv += &format!("{i},{i}\n"); }
        let path = tmp(&csv);
        let result = csv_headers_inner(path.to_str().unwrap().to_string()).unwrap();
        assert!(result.sample.len() <= 5);
    }

    #[test]
    fn comments_skipped_in_headers() {
        let csv = "# comment\nx,y\n1,2\n";
        let path = tmp(csv);
        let result = csv_headers_inner(path.to_str().unwrap().to_string()).unwrap();
        assert_eq!(result.headers, vec!["x", "y"]);
    }

    #[test]
    fn basic_die_coordinates() {
        let csv = "x,y\n3,7\n-1,-2\n";
        let path = tmp(csv);
        let mapping = basic_mapping("x", "y");
        let result = parse_csv_inner(path.to_str().unwrap().to_string(), mapping).unwrap();
        assert_eq!(result.wafers.len(), 1);
        let dies = &result.wafers[0].results;
        assert_eq!(dies.len(), 2);
        assert!(dies.iter().any(|d| d.x == 3 && d.y == 7));
        assert!(dies.iter().any(|d| d.x == -1 && d.y == -2));
    }

    #[test]
    fn hbin_sbin_parsed() {
        let csv = "x,y,hb,sb\n0,0,2,5\n";
        let path = tmp(csv);
        let mut m = basic_mapping("x", "y");
        m.hbin = Some("hb".to_string());
        m.sbin = Some("sb".to_string());
        let result = parse_csv_inner(path.to_str().unwrap().to_string(), m).unwrap();
        let die = &result.wafers[0].results[0];
        assert_eq!(die.hbin, Some(2));
        assert_eq!(die.sbin, Some(5));
    }

    #[test]
    fn hbin_is_none_when_not_mapped() {
        let csv = "x,y\n0,0\n";
        let path = tmp(csv);
        let result = parse_csv_inner(path.to_str().unwrap().to_string(), basic_mapping("x", "y")).unwrap();
        assert_eq!(result.wafers[0].results[0].hbin, None);
        assert_eq!(result.wafers[0].results[0].sbin, None);
    }

    #[test]
    fn sbin_is_none_when_not_mapped() {
        let csv = "x,y,hb\n0,0,3\n";
        let path = tmp(csv);
        let mut m = basic_mapping("x", "y");
        m.hbin = Some("hb".to_string());
        let result = parse_csv_inner(path.to_str().unwrap().to_string(), m).unwrap();
        let die = &result.wafers[0].results[0];
        assert_eq!(die.hbin, Some(3));
        assert_eq!(die.sbin, None);
    }

    #[test]
    fn rows_with_invalid_coords_are_skipped() {
        let csv = "x,y\n1,2\nbad,3\n4,bad\n5,6\n";
        let path = tmp(csv);
        let result = parse_csv_inner(path.to_str().unwrap().to_string(), basic_mapping("x", "y")).unwrap();
        assert_eq!(result.wafers[0].results.len(), 2);
    }

    #[test]
    fn rows_without_wafer_col_go_to_w1() {
        let csv = "x,y\n0,0\n1,1\n";
        let path = tmp(csv);
        let result = parse_csv_inner(path.to_str().unwrap().to_string(), basic_mapping("x", "y")).unwrap();
        assert_eq!(result.wafers[0].wafer_id, "W1");
    }

    #[test]
    fn rows_grouped_by_wafer_column() {
        let csv = "wafer,x,y\nW01,0,0\nW01,1,0\nW02,0,0\n";
        let path = tmp(csv);
        let mut m = basic_mapping("x", "y");
        m.wafer = Some("wafer".to_string());
        let result = parse_csv_inner(path.to_str().unwrap().to_string(), m).unwrap();
        assert_eq!(result.wafers.len(), 2);
        let w1 = result.wafers.iter().find(|w| w.wafer_id == "W01").unwrap();
        assert_eq!(w1.results.len(), 2);
    }

    #[test]
    fn part_and_good_count_computed() {
        let csv = "x,y,hb\n0,0,1\n1,0,1\n2,0,2\n";
        let path = tmp(csv);
        let mut m = basic_mapping("x", "y");
        m.hbin = Some("hb".to_string());
        let result = parse_csv_inner(path.to_str().unwrap().to_string(), m).unwrap();
        let w = &result.wafers[0];
        assert_eq!(w.part_count, Some(3));
        assert_eq!(w.good_count, Some(3));
    }

    #[test]
    fn pass_bins_filter_good_count() {
        let csv = "x,y,hb\n0,0,1\n1,0,2\n2,0,1\n";
        let path = tmp(csv);
        let mut m = basic_mapping("x", "y");
        m.hbin = Some("hb".to_string());
        m.pass_bins = vec![1];
        let result = parse_csv_inner(path.to_str().unwrap().to_string(), m).unwrap();
        let w = &result.wafers[0];
        assert_eq!(w.part_count, Some(3));
        assert_eq!(w.good_count, Some(2));
        assert_eq!(w.fail_count, Some(1));
    }

    #[test]
    fn test_values_parsed_from_mapped_columns() {
        let csv = "x,y,t1,t2\n0,0,1.5,3.0\n";
        let path = tmp(csv);
        let mut m = basic_mapping("x", "y");
        m.tests = vec![
            CsvTestCol { col: "t1".to_string(), test_number: 1, name: "Test1".to_string() },
            CsvTestCol { col: "t2".to_string(), test_number: 2, name: "Test2".to_string() },
        ];
        let result = parse_csv_inner(path.to_str().unwrap().to_string(), m).unwrap();
        let die = &result.wafers[0].results[0];
        assert!((die.test_values["1"] - 1.5).abs() < 1e-9);
        assert!((die.test_values["2"] - 3.0).abs() < 1e-9);
        assert_eq!(result.test_defs["1"].name, "Test1");
    }

    #[test]
    fn non_numeric_test_values_skipped() {
        let csv = "x,y,t1\n0,0,n/a\n1,0,2.5\n";
        let path = tmp(csv);
        let mut m = basic_mapping("x", "y");
        m.tests = vec![CsvTestCol { col: "t1".to_string(), test_number: 1, name: "T1".to_string() }];
        let result = parse_csv_inner(path.to_str().unwrap().to_string(), m).unwrap();
        assert!(!result.wafers[0].results[0].test_values.contains_key("1"));
        assert!((result.wafers[0].results[1].test_values["1"] - 2.5).abs() < 1e-9);
    }

    #[test]
    fn long_format_pivot() {
        let csv = "x,y,test_name,test_val\n\
                   0,0,Vt,1.1\n\
                   0,0,Idsat,2.2\n\
                   1,0,Vt,1.3\n\
                   1,0,Idsat,2.4\n";
        let path = tmp(csv);
        let mut m = basic_mapping("x", "y");
        m.testname_col = Some("test_name".to_string());
        m.testvalue_col = Some("test_val".to_string());
        let result = parse_csv_inner(path.to_str().unwrap().to_string(), m).unwrap();
        assert_eq!(result.wafers[0].results.len(), 2);
        assert_eq!(result.test_defs.len(), 2);
        let names: Vec<_> = result.test_defs.values().map(|d| d.name.as_str()).collect();
        assert!(names.contains(&"Vt"));
        assert!(names.contains(&"Idsat"));
    }

    #[test]
    fn long_format_pivot_with_limits_and_units() {
        let csv = "x,y,test_name,test_val,lo_limit,hi_limit,units\n\
                   0,0,Vt,1.1,0.5,2.0,V\n\
                   0,0,Idsat,2.2,1.0,5.0,mA\n\
                   1,0,Vt,1.3,0.5,2.0,V\n\
                   1,0,Idsat,2.4,1.0,5.0,mA\n";
        let path = tmp(csv);
        let mut m = basic_mapping("x", "y");
        m.testname_col = Some("test_name".to_string());
        m.testvalue_col = Some("test_val".to_string());
        m.lo_limit_col = Some("lo_limit".to_string());
        m.hi_limit_col = Some("hi_limit".to_string());
        m.units_col = Some("units".to_string());
        let result = parse_csv_inner(path.to_str().unwrap().to_string(), m).unwrap();
        let vt = result.test_defs.values().find(|d| d.name == "Vt").unwrap();
        assert_eq!(vt.lo_limit, Some(0.5));
        assert_eq!(vt.hi_limit, Some(2.0));
        assert_eq!(vt.units.as_deref(), Some("V"));
        let idsat = result.test_defs.values().find(|d| d.name == "Idsat").unwrap();
        assert_eq!(idsat.lo_limit, Some(1.0));
        assert_eq!(idsat.hi_limit, Some(5.0));
        assert_eq!(idsat.units.as_deref(), Some("mA"));
    }

    #[test]
    fn lot_id_extracted_from_first_row() {
        let csv = "x,y,lot\n0,0,LOT-99\n1,0,LOT-99\n";
        let path = tmp(csv);
        let mut m = basic_mapping("x", "y");
        m.lot = Some("lot".to_string());
        let result = parse_csv_inner(path.to_str().unwrap().to_string(), m).unwrap();
        assert_eq!(result.meta.get("lotId"), Some("LOT-99"));
    }

    #[test]
    fn split_by_creates_multiple_wafers() {
        let csv = "x,y,site\n0,0,1\n1,0,1\n0,1,2\n1,1,2\n";
        let path = tmp(csv);
        let mut m = basic_mapping("x", "y");
        m.split_by = vec!["site".to_string()];
        let result = parse_csv_inner(path.to_str().unwrap().to_string(), m).unwrap();
        assert_eq!(result.wafers.len(), 2);
    }

    #[test]
    fn site_column_populates_per_die_site_num() {
        let csv = "x,y,site\n0,0,1\n1,0,2\n2,0,3\n";
        let path = tmp(csv);
        let mut m = basic_mapping("x", "y");
        m.site = Some("site".to_string());
        let r = parse_csv_inner(path.to_str().unwrap().to_string(), m).unwrap();
        let sites: Vec<_> = r.wafers[0].results.iter().map(|d| d.site_num).collect();
        assert_eq!(sites, vec![Some(1), Some(2), Some(3)]);
    }

    #[test]
    fn non_numeric_site_yields_none() {
        let csv = "x,y,site\n0,0,A1\n1,0,2\n";
        let path = tmp(csv);
        let mut m = basic_mapping("x", "y");
        m.site = Some("site".to_string());
        let r = parse_csv_inner(path.to_str().unwrap().to_string(), m).unwrap();
        let sites: Vec<_> = r.wafers[0].results.iter().map(|d| d.site_num).collect();
        assert_eq!(sites, vec![None, Some(2)]);
    }

    #[test]
    fn no_site_mapping_leaves_site_num_none() {
        let csv = "x,y,site\n0,0,1\n";
        let path = tmp(csv);
        let m = basic_mapping("x", "y"); // site not mapped
        let r = parse_csv_inner(path.to_str().unwrap().to_string(), m).unwrap();
        assert_eq!(r.wafers[0].results[0].site_num, None);
    }

    fn gz_csv(content: &str) -> std::path::PathBuf {
        use std::io::Write;
        let mut f = tempfile::Builder::new().suffix(".csv.gz").tempfile().unwrap();
        let mut enc = flate2::write::GzEncoder::new(&mut f, flate2::Compression::default());
        enc.write_all(content.as_bytes()).unwrap();
        enc.finish().unwrap();
        f.into_temp_path().keep().unwrap()
    }

    #[test]
    fn gz_csv_headers_readable() {
        let path = gz_csv("x,y,hbin\n0,0,1\n1,1,2\n");
        let result = csv_headers_inner(path.to_str().unwrap().to_string()).unwrap();
        assert_eq!(result.headers, vec!["x", "y", "hbin"]);
        assert_eq!(result.sample.len(), 2);
    }

    #[test]
    fn json_mapping_deserialises_tests() {
        // Exact JSON string produced by js_sys::JSON::stringify in the WASM path.
        let json = r#"{"x":"X_LOC","y":"Y_LOC","hbin":null,"sbin":"SBIN","wafer":"WAFER_ID","lot":"LOT_ID","tests":[{"col":"GAIN_DB","testNumber":1001,"name":"GAIN_DB"},{"col":"NF_DB","testNumber":1002,"name":"NF_DB"},{"col":"IP3_DBM","testNumber":1003,"name":"IP3_DBM"},{"col":"IDQ_MA","testNumber":1004,"name":"IDQ_MA"}],"meta":["TEMP","TESTDATE"],"splitBy":[],"testnameCol":null,"testvalueCol":null,"loLimitCol":null,"hiLimitCol":null,"unitsCol":null,"passBins":[1]}"#;
        let mapping: CsvMapping = serde_json::from_str(json).expect("mapping deserialisation failed");
        assert_eq!(mapping.tests.len(), 4, "expected 4 test cols, got {}", mapping.tests.len());
        assert_eq!(mapping.tests[0].col, "GAIN_DB");
        assert_eq!(mapping.tests[0].test_number, 1001);
    }

    #[test]
    fn parse_csv_from_bytes_with_test_cols() {
        let csv = "X_LOC,Y_LOC,SBIN,WAFER_ID,LOT_ID,TEMP,TESTDATE,GAIN_DB,NF_DB,IP3_DBM,IDQ_MA\n\
                   1,1,1,W1,LOT1,25,2024-01-01,10.5,2.1,15.3,100.0\n\
                   1,2,1,W1,LOT1,25,2024-01-01,11.0,2.3,14.9,98.0\n";
        let json = r#"{"x":"X_LOC","y":"Y_LOC","hbin":null,"sbin":"SBIN","wafer":"WAFER_ID","lot":"LOT_ID","tests":[{"col":"GAIN_DB","testNumber":1001,"name":"GAIN_DB"},{"col":"NF_DB","testNumber":1002,"name":"NF_DB"},{"col":"IP3_DBM","testNumber":1003,"name":"IP3_DBM"},{"col":"IDQ_MA","testNumber":1004,"name":"IDQ_MA"}],"meta":["TEMP","TESTDATE"],"splitBy":[],"testnameCol":null,"testvalueCol":null,"loLimitCol":null,"hiLimitCol":null,"unitsCol":null,"passBins":[1]}"#;
        let mapping: CsvMapping = serde_json::from_str(json).unwrap();
        let result = parse_csv_from_bytes(csv.as_bytes(), mapping).unwrap();
        assert_eq!(result.test_defs.len(), 4, "expected 4 test_defs, got {}: {:?}", result.test_defs.len(), result.test_defs.keys().collect::<Vec<_>>());
        assert!(result.wafers[0].results[0].test_values.contains_key("1001"), "expected testValues key 1001");
    }

    #[test]
    fn tab_delimited_csv_parses_test_cols() {
        let csv = "X_LOC\tY_LOC\tSBIN\tWAFER_ID\tGAIN_DB\n\
                   1\t1\t1\tW1\t10.5\n\
                   1\t2\t1\tW1\t11.0\n";
        let json = r#"{"x":"X_LOC","y":"Y_LOC","hbin":null,"sbin":"SBIN","wafer":"WAFER_ID","lot":null,"tests":[{"col":"GAIN_DB","testNumber":1001,"name":"GAIN_DB"}],"meta":[],"splitBy":[],"testnameCol":null,"testvalueCol":null,"loLimitCol":null,"hiLimitCol":null,"unitsCol":null,"passBins":[]}"#;
        let mapping: CsvMapping = serde_json::from_str(json).unwrap();
        let result = parse_csv_from_bytes(csv.as_bytes(), mapping).unwrap();
        assert_eq!(result.test_defs.len(), 1, "test_defs should have 1 entry for tab-delimited CSV");
        assert!(result.wafers[0].results[0].test_values.contains_key("1001"));
    }

    #[test]
    fn gz_csv_parsed_same_as_plain() {
        let csv = "x,y,hb\n0,0,1\n1,2,2\n3,4,1\n";
        let plain_path = tmp(csv);
        let gz_path    = gz_csv(csv);
        let mut m1 = basic_mapping("x", "y");
        m1.hbin = Some("hb".to_string());
        let mut m2 = basic_mapping("x", "y");
        m2.hbin = Some("hb".to_string());
        let plain = parse_csv_inner(plain_path.to_str().unwrap().to_string(), m1).unwrap();
        let gz    = parse_csv_inner(gz_path.to_str().unwrap().to_string(), m2).unwrap();
        assert_eq!(gz.wafers[0].results.len(), plain.wafers[0].results.len());
        assert_eq!(gz.wafers[0].part_count, plain.wafers[0].part_count);
    }

    /// Wide-format mapping matching scripts/generate_csv_json_bench.py.
    #[cfg(feature = "bench")]
    fn bench_mapping(n_tests: usize) -> CsvMapping {
        let mut m = basic_mapping("x", "y");
        m.hbin = Some("hbin".to_string());
        m.sbin = Some("sbin".to_string());
        m.site = Some("site".to_string());
        m.wafer = Some("wafer".to_string());
        m.lot = Some("lot".to_string());
        m.pass_bins = vec![1];
        m.tests = (0..n_tests)
            .map(|i| {
                let num = 1000 + i as u32;
                CsvTestCol { col: format!("t{num}"), name: format!("t{num}"), test_number: num }
            })
            .collect();
        m
    }

    // Run with: cargo test --manifest-path packages/parsers/Cargo.toml --features bench --release -- --nocapture bench_parse_csv
    #[cfg(feature = "bench")]
    #[test]
    fn bench_parse_csv() {
        let path = "/tmp/bench.csv";
        let bytes = match std::fs::read(path) {
            Ok(b) => b,
            Err(_) => { eprintln!("SKIP: {path} not found — run scripts/generate_csv_json_bench.py"); return; }
        };
        let file_mb = bytes.len() as f64 / 1_048_576.0;
        let mapping = bench_mapping(50);

        let _ = parse_csv_from_bytes(&bytes, mapping.clone()).unwrap(); // warm
        let t = std::time::Instant::now();
        let result = parse_csv_from_bytes(&bytes, mapping).unwrap();
        let ms = t.elapsed().as_millis();
        let dies: usize = result.wafers.iter().map(|w| w.results.len()).sum();
        println!(
            "\n=== bench_parse_csv ({file_mb:.1} MB) ===\n\
             wafers: {}\ndies:   {dies}\ntests:  {}\ntotal:  {ms} ms\nthroughput: {:.0} MB/s",
            result.wafers.len(), result.test_defs.len(),
            file_mb / (ms as f64 / 1000.0).max(0.001),
        );
    }
}
