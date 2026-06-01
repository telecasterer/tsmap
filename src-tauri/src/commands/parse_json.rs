use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;

use super::parse_stdf::{DieResult, LotMeta, ParsedStdf, TestDef, WaferData};
// Reuse the mapping types from parse_csv
use super::parse_csv::CsvMapping;

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
    let text = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let raw: Value = serde_json::from_str(text.trim_start_matches('\u{feff}'))
        .map_err(|e| format!("Invalid JSON: {}", e))?;

    // Find the die-level array — the innermost array of objects
    let rows = find_die_rows(&raw).ok_or("Could not find an array of objects in this JSON file")?;

    if rows.is_empty() {
        return Err("JSON array is empty".to_string());
    }

    // Flatten all rows to collect the full header set (union across first 20 rows)
    let mut header_set: indexmap::IndexSet<String> = indexmap::IndexSet::new();
    for row in rows.iter().take(20) {
        for k in flatten_object(row).keys() {
            header_set.insert(k.clone());
        }
    }
    let headers: Vec<String> = header_set.into_iter().collect();

    let sample: Vec<HashMap<String, String>> = rows
        .iter()
        .take(5)
        .map(|row| {
            flatten_object(row)
                .into_iter()
                .map(|(k, v)| (k, value_to_string(&v)))
                .collect()
        })
        .collect();

    Ok(JsonHeadersResult {
        headers,
        sample,
        row_count: rows.len(),
    })
}

// ── parse_json ────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn parse_json(path: String, mapping: CsvMapping) -> Result<ParsedStdf, String> {
    let text = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let raw: Value = serde_json::from_str(text.trim_start_matches('\u{feff}'))
        .map_err(|e| format!("Invalid JSON: {}", e))?;

    let rows = find_die_rows(&raw).ok_or("Could not find an array of objects in this JSON file")?;

    // Flatten every row
    let flat_rows: Vec<HashMap<String, String>> = rows
        .iter()
        .map(|row| {
            flatten_object(row)
                .into_iter()
                .map(|(k, v)| (k, value_to_string(&v)))
                .collect()
        })
        .collect();

    // Delegate to the same mapping logic as parse_csv by re-using its row processing
    // We reproduce it here to avoid coupling — it's short
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
            if x.is_empty() || y.is_empty() {
                continue;
            }
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

/// Find the innermost array of objects — handles:
/// - Top-level array: [{ die fields }]  or  [{ wafer fields, results: [{die}] }]
/// - Envelope object: { wafers: [{...}], batch_id: "...", ... }
/// Always returns the die-level rows (innermost objects with scalar values).
fn find_die_rows(val: &Value) -> Option<Vec<&Value>> {
    match val {
        Value::Array(arr) => {
            if arr.is_empty() { return None; }
            // Check if array elements contain a nested die array
            let die_keys = ["results","die_results","dies","data","measurements","records"];
            if let Some(obj) = arr[0].as_object() {
                let inner_key = die_keys.iter()
                    .find(|&&k| obj.get(k).map_or(false, |v| v.is_array()));
                if let Some(&inner_key) = inner_key {
                    return Some(arr.iter()
                        .filter_map(|w| w.get(inner_key)?.as_array())
                        .flatten()
                        .collect());
                }
            }
            Some(arr.iter().collect())
        }
        Value::Object(obj) => {
            // Prefer known wrapper keys, then fall back to any array property
            let preferred = ["wafers","results","dies","die_results","data","measurements","records"];
            let key = preferred.iter()
                .find(|&&k| obj.get(k).map_or(false, |v| v.is_array()))
                .map(|&k| k.to_string())
                .or_else(|| obj.iter()
                    .find(|(_, v)| v.is_array())
                    .map(|(k, _)| k.clone()));

            if let Some(k) = key {
                find_die_rows(obj.get(&k)?)
            } else {
                None
            }
        }
        _ => None,
    }
}

/// Flatten one level of nesting: { location: { x: 0, y: 0 } } → { "location.x": "0", "location.y": "0" }
/// Arrays within objects are stringified as-is (not recursed into).
fn flatten_object(val: &Value) -> indexmap::IndexMap<String, Value> {
    let mut out = indexmap::IndexMap::new();
    if let Some(obj) = val.as_object() {
        for (k, v) in obj {
            if let Some(inner) = v.as_object() {
                for (k2, v2) in inner {
                    out.insert(format!("{}.{}", k, k2), v2.clone());
                }
            } else {
                out.insert(k.clone(), v.clone());
            }
        }
    }
    out
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
