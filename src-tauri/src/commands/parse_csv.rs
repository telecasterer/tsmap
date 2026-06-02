use csv::ReaderBuilder;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::io::Read;

// ── Types shared between the two commands ────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CsvHeadersResult {
    pub headers: Vec<String>,
    pub sample: Vec<HashMap<String, String>>, // first 5 rows
    pub row_count: usize,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CsvTestCol {
    pub col: String,
    pub test_number: u32,
    pub name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CsvMapping {
    pub x: String,
    pub y: String,
    pub hbin: Option<String>,
    pub sbin: Option<String>,
    pub wafer: Option<String>,
    pub lot: Option<String>,
    pub tests: Vec<CsvTestCol>,
    pub meta: Vec<String>,
    pub split_by: Vec<String>,
    pub testname_col: Option<String>, // long format: column that holds test name
    pub testvalue_col: Option<String>, // long format: column that holds test value
    pub pass_bins: Vec<u32>,
}

// Reuse the output types already defined for STDF
use super::parse_stdf::{DieResult, LotMeta, ParsedStdf, TestDef, WaferData};

// ── csv_headers ───────────────────────────────────────────────────────────────

#[tauri::command]
pub fn csv_headers(path: String) -> Result<CsvHeadersResult, String> {
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

    // Estimate row count from file size ÷ average of sampled row byte lengths.
    // Fast (no full scan) and accurate enough for the UI label.
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

// ── parse_csv ─────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn parse_csv(path: String, mapping: CsvMapping) -> Result<ParsedStdf, String> {
    let mut rdr = build_reader(&path)?;
    let headers: Vec<String> = rdr
        .headers()
        .map_err(|e| e.to_string())?
        .iter()
        .map(|s| s.trim().to_string())
        .collect();

    // Index columns by name for fast lookup
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

    // Build testDefs from mapping
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

    // Wide-format parse → group rows by (wafer, split_by) key
    // Long-format: pivot first, then same grouping
    let all_rows: Vec<csv::StringRecord> = rdr
        .records()
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;

    // ── Long-format pivot ────────────────────────────────────────────────────
    // Key: (wafer, lot, x, y) → wide HashMap
    let active_rows: Vec<HashMap<String, String>>;
    let mut long_fmt_test_numbers: HashMap<String, u32> = HashMap::new();
    let mut next_test_num: u32 = 1001;

    if is_long_format {
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
                for c in &mapping.meta { m.insert(c.clone(), get(rec, c)); }
                m
            });

            let test_name = get(rec, name_col);
            let test_val  = get(rec, val_col);
            if test_name.is_empty() || test_val.is_empty() { continue; }

            let tnum = *long_fmt_test_numbers.entry(test_name.clone()).or_insert_with(|| {
                let n = next_test_num;
                next_test_num += 1;
                test_defs.insert(n.to_string(), TestDef {
                    name: test_name.clone(),
                    test_type: "P".to_string(),
                    lo_limit: None, hi_limit: None, units: None,
                });
                n
            });
            wide.insert(format!("__test_{}", tnum), test_val);

            // Fill hbin/sbin per-row if not set yet
            if let Some(c) = &mapping.hbin {
                let v = wide.get(c).cloned().unwrap_or_default();
                if v.is_empty() { wide.insert(c.clone(), get(rec, c)); }
            }
        }
        active_rows = die_map.into_values().collect();
    } else {
        active_rows = all_rows
            .iter()
            .map(|rec| {
                headers
                    .iter()
                    .enumerate()
                    .map(|(i, h)| (h.clone(), rec.get(i).unwrap_or("").trim().to_string()))
                    .collect()
            })
            .collect();
    }

    // ── Group by wafer + split_by ────────────────────────────────────────────
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

    // ── Build DieResult per wafer ────────────────────────────────────────────
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

            let hbin: u32 = if has_hbin {
                mapping.hbin.as_deref()
                    .and_then(|c| row.get(c))
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(1)
            } else { 1 };

            let sbin: u32 = if has_sbin {
                mapping.sbin.as_deref()
                    .and_then(|c| row.get(c))
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(hbin)
            } else { hbin };

            let mut test_values: HashMap<String, f64> = HashMap::new();

            if is_long_format {
                for tnum in long_fmt_test_numbers.values() {
                    let k = format!("__test_{}", tnum);
                    if let Some(v) = row.get(&k).and_then(|s| s.parse::<f64>().ok()) {
                        test_values.insert(tnum.to_string(), v);
                    }
                }
            } else {
                for t in &mapping.tests {
                    if let Some(v) = row.get(&t.col).and_then(|s| s.parse::<f64>().ok()) {
                        test_values.insert(t.test_number.to_string(), v);
                    }
                }
            }

            dies.push(DieResult {
                x, y, hbin, sbin,
                site_num: None,
                part_id: None,
                test_values,
            });
        }

        let part_count = dies.len() as u32;
        let good_count = dies.iter()
            .filter(|d| pass_bin_set.is_empty() || pass_bin_set.contains(&d.hbin))
            .count() as u32;

        wafers.push(WaferData {
            wafer_id: wid.clone(),
            results: dies,
            part_count: Some(part_count),
            good_count: Some(good_count),
            fail_count: Some(part_count - good_count),
        });
    }

    // Extract lot/meta from first row
    let meta = if let Some(first) = active_rows.first() {
        LotMeta {
            lot_id: mapping.lot.as_deref().and_then(|c| first.get(c)).filter(|v| !v.is_empty()).cloned(),
            part_type: None,
            job_name: None,
            tester_type: None,
            node_name: None,
            sublot_id: None,
        }
    } else {
        LotMeta::default()
    };

    Ok(ParsedStdf { meta, wafers, test_defs, sites: vec![] })
}

// ── Helpers ───────────────────────────────────────────────────────────────────

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
