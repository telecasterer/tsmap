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
pub fn json_headers(path: String) -> Result<JsonHeadersResult, String> {
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
pub fn parse_json(path: String, mapping: CsvMapping) -> Result<ParsedStdf, String> {
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
                test_defs.insert(n.to_string(), TestDef {
                    name: test_name.to_string(),
                    test_type: "P".to_string(),
                    lo_limit: None, hi_limit: None, units: None,
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

            let hbin: u32 = mapping.hbin.as_deref()
                .and_then(|c| row.get(c)).and_then(|v| v.parse().ok()).unwrap_or(1);
            let sbin: u32 = mapping.sbin.as_deref()
                .and_then(|c| row.get(c)).and_then(|v| v.parse().ok()).unwrap_or(hbin);

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

fn value_to_string(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        Value::Bool(b)   => b.to_string(),
        Value::Null      => String::new(),
        other            => other.to_string(),
    }
}
