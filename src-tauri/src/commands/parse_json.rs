use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;

use super::parse_stdf::{DieResult, LotMeta, ParsedStdf, TestDef, WaferData};
use super::parse_csv::CsvMapping;
use super::read_file::read_text;

// ── json_headers ──────────────────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JsonHeadersResult {
    pub headers: Vec<String>,
    pub sample: Vec<HashMap<String, String>>,
    pub row_count: usize,
}

#[tauri::command]
pub async fn json_headers(path: String) -> Result<JsonHeadersResult, String> {
    tokio::task::spawn_blocking(move || json_headers_sync(path))
        .await
        .map_err(|e| e.to_string())?
}

fn json_headers_sync(path: String) -> Result<JsonHeadersResult, String> {
    let text = read_text(&path).map_err(|e| e.to_string())?;
    let raw: Value = serde_json::from_str(text.trim_start_matches('\u{feff}'))
        .map_err(|e| format!("Invalid JSON: {}", e))?;

    let rows = flatten_to_rows(&raw).ok_or("Could not find an array of objects in this JSON file")?;

    if rows.is_empty() {
        return Err("JSON array is empty".to_string());
    }

    let mut header_set: indexmap::IndexSet<String> = indexmap::IndexSet::new();
    for row in rows.iter().take(20) {
        for k in row.keys() {
            header_set.insert(k.clone());
        }
    }
    let headers: Vec<String> = header_set.into_iter().collect();
    let sample = rows.into_iter().take(5).collect();

    Ok(JsonHeadersResult { headers, sample, row_count: rows_len(&raw) })
}

// ── parse_json ────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn parse_json(path: String, mapping: CsvMapping) -> Result<ParsedStdf, String> {
    tokio::task::spawn_blocking(move || parse_json_sync(path, mapping))
        .await
        .map_err(|e| e.to_string())?
}

fn parse_json_sync(path: String, mapping: CsvMapping) -> Result<ParsedStdf, String> {
    let text = read_text(&path).map_err(|e| e.to_string())?;
    let raw: Value = serde_json::from_str(text.trim_start_matches('\u{feff}'))
        .map_err(|e| format!("Invalid JSON: {}", e))?;

    let flat_rows = flatten_to_rows(&raw).ok_or("Could not find an array of objects in this JSON file")?;

    let is_long_format = mapping.testname_col.is_some() && mapping.testvalue_col.is_some();
    let pass_bin_set: std::collections::HashSet<u32> =
        mapping.pass_bins.iter().copied().collect();

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

    // ── Long-format pivot ────────────────────────────────────────────────────
    let active_rows: Vec<HashMap<String, String>>;
    let mut long_fmt_test_numbers: HashMap<String, u32> = HashMap::new();
    let mut next_test_num: u32 = 1001;

    if is_long_format {
        let name_col = mapping.testname_col.as_deref().unwrap();
        let val_col = mapping.testvalue_col.as_deref().unwrap();
        let mut die_map: indexmap::IndexMap<String, HashMap<String, String>> =
            indexmap::IndexMap::new();

        for row in &flat_rows {
            let x = row.get(&mapping.x).map(|s| s.as_str()).unwrap_or("");
            let y = row.get(&mapping.y).map(|s| s.as_str()).unwrap_or("");
            if x.is_empty() || y.is_empty() { continue; }
            let wafer = mapping.wafer.as_deref().and_then(|c| row.get(c)).map(|s| s.as_str()).unwrap_or("");
            let lot = mapping.lot.as_deref().and_then(|c| row.get(c)).map(|s| s.as_str()).unwrap_or("");
            let key = format!("{}\x00{}\x00{}\x00{}", wafer, lot, x, y);

            let wide = die_map.entry(key).or_insert_with(|| {
                let mut m = HashMap::new();
                m.insert(mapping.x.clone(), x.to_string());
                m.insert(mapping.y.clone(), y.to_string());
                if let Some(c) = &mapping.wafer { m.insert(c.clone(), wafer.to_string()); }
                if let Some(c) = &mapping.lot   { m.insert(c.clone(), lot.to_string()); }
                if let Some(c) = &mapping.hbin  { m.insert(c.clone(), row.get(c).cloned().unwrap_or_default()); }
                if let Some(c) = &mapping.sbin  { m.insert(c.clone(), row.get(c).cloned().unwrap_or_default()); }
                for c in &mapping.meta { m.insert(c.clone(), row.get(c).cloned().unwrap_or_default()); }
                m
            });

            let test_name = row.get(name_col).map(|s| s.as_str()).unwrap_or("");
            let test_val  = row.get(val_col).map(|s| s.as_str()).unwrap_or("");
            if test_name.is_empty() || test_val.is_empty() { continue; }

            let tnum = *long_fmt_test_numbers.entry(test_name.to_string()).or_insert_with(|| {
                let n = next_test_num;
                next_test_num += 1;
                let lo_limit = mapping.lo_limit_col.as_deref()
                    .and_then(|c| row.get(c)).filter(|s| !s.is_empty()).and_then(|s| s.parse::<f64>().ok());
                let hi_limit = mapping.hi_limit_col.as_deref()
                    .and_then(|c| row.get(c)).filter(|s| !s.is_empty()).and_then(|s| s.parse::<f64>().ok());
                let units = mapping.units_col.as_deref()
                    .and_then(|c| row.get(c)).filter(|s| !s.is_empty()).cloned();
                test_defs.insert(n.to_string(), TestDef {
                    name: test_name.to_string(),
                    test_type: "P".to_string(),
                    lo_limit, hi_limit, units,
                });
                n
            });
            wide.insert(format!("__test_{}", tnum), test_val.to_string());
        }
        active_rows = die_map.into_values().collect();
    } else {
        active_rows = flat_rows;
    }

    // ── Group by wafer + split_by ────────────────────────────────────────────
    let mut groups: indexmap::IndexMap<String, Vec<&HashMap<String, String>>> =
        indexmap::IndexMap::new();

    for row in &active_rows {
        let wid = mapping.wafer.as_deref()
            .and_then(|c| row.get(c))
            .filter(|v| !v.is_empty())
            .cloned()
            .unwrap_or_else(|| "W1".to_string());

        let split_parts: Vec<String> = mapping.split_by.iter()
            .filter_map(|col| {
                let v = row.get(col)?;
                if v.is_empty() { None } else { Some(format!("{}: {}", col, v)) }
            })
            .collect();

        let key = if split_parts.is_empty() { wid } else { format!("{} · {}", wid, split_parts.join(" · ")) };
        groups.entry(key).or_default().push(row);
    }

    // ── Build DieResult per wafer ────────────────────────────────────────────
    let mut wafers: Vec<WaferData> = Vec::new();

    for (wid, rows) in &groups {
        let mut dies: Vec<DieResult> = Vec::new();

        for row in rows {
            let x: i32 = match row.get(&mapping.x).and_then(|v| v.parse().ok()) {
                Some(v) => v, None => continue,
            };
            let y: i32 = match row.get(&mapping.y).and_then(|v| v.parse().ok()) {
                Some(v) => v, None => continue,
            };

            let hbin: Option<u32> = mapping.hbin.as_deref()
                .and_then(|c| row.get(c)).and_then(|v| v.parse().ok());
            let sbin: Option<u32> = mapping.sbin.as_deref()
                .and_then(|c| row.get(c)).and_then(|v| v.parse().ok());

            let mut test_values: HashMap<String, f64> = HashMap::new();
            if is_long_format {
                for tnum in long_fmt_test_numbers.values() {
                    if let Some(v) = row.get(&format!("__test_{}", tnum)).and_then(|s| s.parse().ok()) {
                        test_values.insert(tnum.to_string(), v);
                    }
                }
            } else {
                for t in &mapping.tests {
                    if let Some(v) = row.get(&t.col).and_then(|s| s.parse().ok()) {
                        test_values.insert(t.test_number.to_string(), v);
                    }
                }
            }

            dies.push(DieResult { x, y, hbin, sbin, site_num: None, part_id: None, test_values });
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
        });
    }

    let meta = active_rows.first().map(|row| LotMeta {
        lot_id: mapping.lot.as_deref().and_then(|c| row.get(c)).filter(|v| !v.is_empty()).cloned(),
        part_type: None, job_name: None, tester_type: None, node_name: None, sublot_id: None,
    }).unwrap_or_default();

    Ok(ParsedStdf { meta, wafers, test_defs, sites: vec![] })
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/// Convert JSON to a flat Vec of string-string maps in a single pass.
/// Handles:
/// - Flat array of die objects:          [{x,y,hbin}]
/// - Array of wafer objects with nested: [{sampleIndex, results:[{x,y}]}]
///   → wafer scalars are merged into each die row
/// - Envelope object:                    {wafers:[...]} → recursed
fn flatten_to_rows(val: &Value) -> Option<Vec<HashMap<String, String>>> {
    match val {
        Value::Array(arr) => {
            if arr.is_empty() { return None; }
            let die_keys = ["results","die_results","dies","data","measurements","records"];
            if let Some(obj) = arr[0].as_object() {
                let inner_key = die_keys.iter()
                    .find(|&&k| obj.get(k).map_or(false, |v| v.is_array()));
                if let Some(&inner_key) = inner_key {
                    // Nested format: merge wafer scalars directly into string maps
                    let mut out: Vec<HashMap<String, String>> = Vec::new();
                    for wafer in arr.iter() {
                        let wafer_obj = match wafer.as_object() { Some(o) => o, None => continue };
                        // Build wafer-level scalar strings once per wafer
                        let mut wafer_scalars: HashMap<String, String> = HashMap::new();
                        for (k, v) in wafer_obj.iter() {
                            if k.as_str() != inner_key && !v.is_array() && !v.is_object() {
                                wafer_scalars.insert(k.clone(), value_to_string(v));
                            }
                        }
                        if let Some(dies) = wafer.get(inner_key).and_then(|v| v.as_array()) {
                            out.reserve(dies.len());
                            for die in dies {
                                let mut row = wafer_scalars.clone();
                                flatten_value_into(die, "", &mut row);
                                out.push(row);
                            }
                        }
                    }
                    return Some(out);
                }
            }
            // Flat array
            Some(arr.iter().map(|v| {
                let mut row = HashMap::new();
                flatten_value_into(v, "", &mut row);
                row
            }).collect())
        }
        Value::Object(obj) => {
            let preferred = ["wafers","results","dies","die_results","data","measurements","records"];
            let key = preferred.iter()
                .find(|&&k| obj.get(k).map_or(false, |v| v.is_array()))
                .map(|&k| k.to_string())
                .or_else(|| obj.iter().find(|(_, v)| v.is_array()).map(|(k, _)| k.clone()));
            if let Some(k) = key {
                flatten_to_rows(obj.get(&k)?)
            } else {
                None
            }
        }
        _ => None,
    }
}

/// Flatten one JSON object level into a string map.
/// Nested objects produce "parent.child" keys; arrays are stringified.
fn flatten_value_into(val: &Value, prefix: &str, out: &mut HashMap<String, String>) {
    if let Some(obj) = val.as_object() {
        for (k, v) in obj {
            let key = if prefix.is_empty() { k.clone() } else { format!("{}.{}", prefix, k) };
            if let Some(inner) = v.as_object() {
                for (k2, v2) in inner {
                    out.insert(format!("{}.{}", key, k2), value_to_string(v2));
                }
            } else {
                out.insert(key, value_to_string(v));
            }
        }
    }
}

/// Count total die rows without allocating the full flat vec (used for json_headers row_count).
fn rows_len(val: &Value) -> usize {
    match val {
        Value::Array(arr) => {
            let die_keys = ["results","die_results","dies","data","measurements","records"];
            if let Some(obj) = arr.first().and_then(|v| v.as_object()) {
                if let Some(&k) = die_keys.iter().find(|&&k| obj.get(k).map_or(false, |v| v.is_array())) {
                    return arr.iter()
                        .filter_map(|w| w.get(k)?.as_array())
                        .map(|d| d.len())
                        .sum();
                }
            }
            arr.len()
        }
        Value::Object(obj) => {
            let preferred = ["wafers","results","dies","die_results","data","measurements","records"];
            let key = preferred.iter()
                .find(|&&k| obj.get(k).map_or(false, |v| v.is_array()))
                .map(|&k| k.to_string())
                .or_else(|| obj.iter().find(|(_, v)| v.is_array()).map(|(k, _)| k.clone()));
            key.and_then(|k| obj.get(&k)).map(rows_len).unwrap_or(0)
        }
        _ => 0,
    }
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
            x: x.to_string(), y: y.to_string(),
            hbin: None, sbin: None, wafer: None, lot: None,
            tests: vec![], meta: vec![], split_by: vec![],
            testname_col: None, testvalue_col: None,
            lo_limit_col: None, hi_limit_col: None, units_col: None,
            pass_bins: vec![],
        }
    }

    // ── json_headers ──────────────────────────────────────────────────────────

    #[test]
    fn headers_from_flat_array() {
        let json = r#"[{"x":1,"y":2,"hbin":1},{"x":3,"y":4,"hbin":2}]"#;
        let path = tmp(json);
        let result = json_headers_sync(path.to_str().unwrap().to_string()).unwrap();
        assert!(result.headers.contains(&"x".to_string()));
        assert!(result.headers.contains(&"y".to_string()));
        assert!(result.headers.contains(&"hbin".to_string()));
        assert!(result.sample.len() <= 5);
        assert_eq!(result.row_count, 2);
    }

    #[test]
    fn headers_from_envelope_object() {
        let json = r#"{"wafers":[{"x":0,"y":0}]}"#;
        let path = tmp(json);
        let result = json_headers_sync(path.to_str().unwrap().to_string()).unwrap();
        assert!(result.headers.contains(&"x".to_string()));
    }

    #[test]
    fn headers_from_nested_results_array() {
        let json = r#"[{"waferId":"W1","results":[{"x":0,"y":0},{"x":1,"y":1}]}]"#;
        let path = tmp(json);
        let result = json_headers_sync(path.to_str().unwrap().to_string()).unwrap();
        assert!(result.headers.contains(&"x".to_string()));
        assert_eq!(result.row_count, 2);
    }

    #[test]
    fn bom_stripped_before_parse() {
        let json = "\u{feff}[{\"x\":1,\"y\":2}]";
        let path = tmp(json);
        let result = json_headers_sync(path.to_str().unwrap().to_string()).unwrap();
        assert!(result.headers.contains(&"x".to_string()));
    }

    // ── parse_json — flat array ───────────────────────────────────────────────

    #[test]
    fn flat_array_basic_dies() {
        let json = r#"[{"x":3,"y":7},{"x":-1,"y":-2}]"#;
        let path = tmp(json);
        let result = parse_json_sync(path.to_str().unwrap().to_string(), basic_mapping("x", "y")).unwrap();
        assert_eq!(result.wafers.len(), 1);
        let dies = &result.wafers[0].results;
        assert_eq!(dies.len(), 2);
        assert!(dies.iter().any(|d| d.x == 3 && d.y == 7));
    }

    #[test]
    fn hbin_sbin_from_fields() {
        let json = r#"[{"x":0,"y":0,"hb":2,"sb":5}]"#;
        let path = tmp(json);
        let mut m = basic_mapping("x", "y");
        m.hbin = Some("hb".to_string());
        m.sbin = Some("sb".to_string());
        let result = parse_json_sync(path.to_str().unwrap().to_string(), m).unwrap();
        let die = &result.wafers[0].results[0];
        assert_eq!(die.hbin, Some(2));
        assert_eq!(die.sbin, Some(5));
    }

    #[test]
    fn rows_with_invalid_coords_skipped() {
        let json = r#"[{"x":"bad","y":1},{"x":2,"y":3}]"#;
        let path = tmp(json);
        let result = parse_json_sync(path.to_str().unwrap().to_string(), basic_mapping("x", "y")).unwrap();
        assert_eq!(result.wafers[0].results.len(), 1);
    }

    // ── Envelope and nested formats ───────────────────────────────────────────

    #[test]
    fn envelope_object_unwrapped() {
        let json = r#"{"wafers":[{"x":0,"y":0},{"x":1,"y":1}]}"#;
        let path = tmp(json);
        let result = parse_json_sync(path.to_str().unwrap().to_string(), basic_mapping("x", "y")).unwrap();
        assert_eq!(result.wafers[0].results.len(), 2);
    }

    #[test]
    fn nested_results_array_flattened_with_wafer_scalars() {
        // Wafer scalar (waferId) should be merged into each die row
        let json = r#"[{"waferId":"W01","results":[{"x":0,"y":0},{"x":1,"y":1}]},
                        {"waferId":"W02","results":[{"x":2,"y":2}]}]"#;
        let path = tmp(json);
        let mut m = basic_mapping("x", "y");
        m.wafer = Some("waferId".to_string());
        let result = parse_json_sync(path.to_str().unwrap().to_string(), m).unwrap();
        assert_eq!(result.wafers.len(), 2);
        let w1 = result.wafers.iter().find(|w| w.wafer_id == "W01").unwrap();
        assert_eq!(w1.results.len(), 2);
    }

    // ── Wafer grouping and counts ─────────────────────────────────────────────

    #[test]
    fn rows_without_wafer_col_go_to_w1() {
        let json = r#"[{"x":0,"y":0}]"#;
        let path = tmp(json);
        let result = parse_json_sync(path.to_str().unwrap().to_string(), basic_mapping("x", "y")).unwrap();
        assert_eq!(result.wafers[0].wafer_id, "W1");
    }

    #[test]
    fn part_count_and_good_count_computed() {
        let json = r#"[{"x":0,"y":0},{"x":1,"y":0},{"x":2,"y":0}]"#;
        let path = tmp(json);
        let result = parse_json_sync(path.to_str().unwrap().to_string(), basic_mapping("x", "y")).unwrap();
        let w = &result.wafers[0];
        assert_eq!(w.part_count, Some(3));
        assert_eq!(w.good_count, Some(3)); // pass_bins empty → all pass
    }

    #[test]
    fn pass_bins_filter_good_count() {
        let json = r#"[{"x":0,"y":0,"hb":1},{"x":1,"y":0,"hb":2},{"x":2,"y":0,"hb":1}]"#;
        let path = tmp(json);
        let mut m = basic_mapping("x", "y");
        m.hbin = Some("hb".to_string());
        m.pass_bins = vec![1];
        let result = parse_json_sync(path.to_str().unwrap().to_string(), m).unwrap();
        let w = &result.wafers[0];
        assert_eq!(w.good_count, Some(2));
        assert_eq!(w.fail_count, Some(1));
    }

    // ── Test values ───────────────────────────────────────────────────────────

    #[test]
    fn test_values_from_mapped_columns() {
        let json = r#"[{"x":0,"y":0,"t1":1.5,"t2":3.0}]"#;
        let path = tmp(json);
        let mut m = basic_mapping("x", "y");
        m.tests = vec![
            super::super::parse_csv::CsvTestCol { col: "t1".to_string(), test_number: 1, name: "T1".to_string() },
            super::super::parse_csv::CsvTestCol { col: "t2".to_string(), test_number: 2, name: "T2".to_string() },
        ];
        let result = parse_json_sync(path.to_str().unwrap().to_string(), m).unwrap();
        let die = &result.wafers[0].results[0];
        assert!((die.test_values["1"] - 1.5).abs() < 1e-9);
        assert!((die.test_values["2"] - 3.0).abs() < 1e-9);
    }

    // ── Long format ───────────────────────────────────────────────────────────

    #[test]
    fn long_format_pivot() {
        let json = r#"[
            {"x":0,"y":0,"test":"Vt","val":1.1},
            {"x":0,"y":0,"test":"Idsat","val":2.2},
            {"x":1,"y":0,"test":"Vt","val":1.3}
        ]"#;
        let path = tmp(json);
        let mut m = basic_mapping("x", "y");
        m.testname_col = Some("test".to_string());
        m.testvalue_col = Some("val".to_string());
        let result = parse_json_sync(path.to_str().unwrap().to_string(), m).unwrap();
        assert_eq!(result.wafers[0].results.len(), 2);
        assert_eq!(result.test_defs.len(), 2);
    }

    // ── Lot meta ──────────────────────────────────────────────────────────────

    #[test]
    fn lot_id_from_first_row() {
        let json = r#"[{"x":0,"y":0,"lot":"LOT-99"}]"#;
        let path = tmp(json);
        let mut m = basic_mapping("x", "y");
        m.lot = Some("lot".to_string());
        let result = parse_json_sync(path.to_str().unwrap().to_string(), m).unwrap();
        assert_eq!(result.meta.lot_id.as_deref(), Some("LOT-99"));
    }
}

fn value_to_string(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        Value::Bool(b)   => b.to_string(),
        Value::Null      => String::new(),
        other            => other.to_string(),
    }
}
