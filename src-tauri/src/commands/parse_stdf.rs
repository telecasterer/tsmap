use rust_stdf::{stdf_file::StdfReader, CompressType, StdfRecord};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{BufReader, Cursor};
use super::read_file::read_bytes;

// ── Output types (serialised to JSON for the JS frontend) ────────────────────

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DieResult {
    pub x: i32,
    pub y: i32,
    pub hbin: u32,
    pub sbin: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub site_num: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub part_id: Option<u32>,
    #[serde(skip_serializing_if = "HashMap::is_empty")]
    pub test_values: HashMap<String, f64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestDef {
    pub name: String,
    pub test_type: String, // "P" = parametric, "F" = functional
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lo_limit: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hi_limit: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub units: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WaferData {
    pub wafer_id: String,
    pub results: Vec<DieResult>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub part_count: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub good_count: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fail_count: Option<u32>,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct LotMeta {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lot_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub part_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub job_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tester_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub node_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sublot_id: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SiteInfo {
    pub head_num: u32,
    pub site_num: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedStdf {
    pub meta: LotMeta,
    pub wafers: Vec<WaferData>,
    pub test_defs: HashMap<String, TestDef>,
    pub sites: Vec<SiteInfo>,
}

// ── Helpers ──────────────────────────────────────────────────────────────────

fn nonempty(s: String) -> Option<String> {
    if s.is_empty() { None } else { Some(s) }
}

// PTR test_flg bit 7 = test failed
fn ptr_failed(test_flg: [u8; 1]) -> bool {
    test_flg[0] & 0x80 != 0
}

// Sentinel values used by rust-stdf for "not present"
const SENTINEL_U4: u32 = 4_294_967_295;
const SENTINEL_I2: i16 = -32768;

// ── Command ──────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn parse_stdf(path: String) -> Result<ParsedStdf, String> {
    // read_bytes decompresses .gz transparently; wrap in Cursor for BufRead + Seek
    let bytes = read_bytes(&path)?;
    let mut reader = StdfReader::from(BufReader::new(Cursor::new(bytes)), &CompressType::Uncompressed)
        .map_err(|e| e.to_string())?;

    let mut meta = LotMeta::default();
    let mut sites: Vec<SiteInfo> = Vec::new();
    let mut test_defs: HashMap<String, TestDef> = HashMap::new();

    // Wafer accumulation
    let mut wafers: Vec<WaferData> = Vec::new();
    // Current in-progress wafer (between WIR and WRR)
    let mut current_wafer: Option<WaferData> = None;

    // Per-die accumulation: keyed by (head, site)
    let mut pending_site: HashMap<(u8, u8), u8> = HashMap::new();
    // test_values accumulating for the current die at (head, site)
    let mut pending_values: HashMap<(u8, u8), HashMap<String, f64>> = HashMap::new();
    // PRR seen for (head, site) this die — used to finalise
    // (We build the DieResult at PRR time, pulling values from pending_values)

    for rec in reader.get_record_iter() {
        let rec = rec.map_err(|e| e.to_string())?;
        match rec {
            // ── Lot metadata ────────────────────────────────────────────────
            StdfRecord::MIR(mir) => {
                meta.lot_id    = nonempty(mir.lot_id);
                meta.part_type = nonempty(mir.part_typ);
                meta.job_name  = nonempty(mir.job_nam);
                meta.tester_type = nonempty(mir.tstr_typ);
                meta.node_name = nonempty(mir.node_nam);
                meta.sublot_id = nonempty(mir.sblot_id);
            }

            // ── Site configuration ──────────────────────────────────────────
            StdfRecord::SDR(sdr) => {
                for &site in &sdr.site_num {
                    sites.push(SiteInfo {
                        head_num: sdr.head_num as u32,
                        site_num: site as u32,
                    });
                }
            }

            // ── Wafer open/close ────────────────────────────────────────────
            StdfRecord::WIR(wir) => {
                current_wafer = Some(WaferData {
                    wafer_id: if wir.wafer_id.is_empty() {
                        format!("W{}", wafers.len() + 1)
                    } else {
                        wir.wafer_id
                    },
                    results: Vec::new(),
                    part_count: None,
                    good_count: None,
                    fail_count: None,
                });
            }
            StdfRecord::WRR(wrr) => {
                if let Some(mut wafer) = current_wafer.take() {
                    // Update wafer ID from WRR if it has one and WIR didn't
                    if !wrr.wafer_id.is_empty() {
                        wafer.wafer_id = wrr.wafer_id;
                    }
                    wafer.part_count = if wrr.part_cnt != SENTINEL_U4 { Some(wrr.part_cnt) } else { None };
                    wafer.good_count = if wrr.good_cnt != SENTINEL_U4 { Some(wrr.good_cnt) } else { None };
                    wafer.fail_count = if wrr.good_cnt != SENTINEL_U4 && wrr.part_cnt != SENTINEL_U4 {
                        Some(wrr.part_cnt.saturating_sub(wrr.good_cnt))
                    } else {
                        None
                    };
                    wafers.push(wafer);
                }
            }

            // ── Die start ───────────────────────────────────────────────────
            StdfRecord::PIR(pir) => {
                let key = (pir.head_num, pir.site_num);
                pending_site.insert(key, pir.site_num);
                pending_values.insert(key, HashMap::new());
            }

            // ── Parametric test result ───────────────────────────────────────
            StdfRecord::PTR(ptr) => {
                let key_str = ptr.test_num.to_string();

                // Capture test def from first PTR with limits for this test number
                test_defs.entry(key_str.clone()).or_insert_with(|| TestDef {
                    name: ptr.test_txt.clone(),
                    test_type: "P".to_string(),
                    lo_limit: ptr.lo_limit.map(|v| v as f64),
                    hi_limit: ptr.hi_limit.map(|v| v as f64),
                    units: ptr.units.as_ref().and_then(|u| nonempty(u.clone())),
                });

                // Accumulate value for this die
                let key = (ptr.head_num, ptr.site_num);
                if let Some(values) = pending_values.get_mut(&key) {
                    // Use pass/fail synthetic value if test failed and result is NaN/0
                    let value = if ptr_failed(ptr.test_flg) && ptr.result == 0.0 {
                        f64::NAN
                    } else {
                        ptr.result as f64
                    };
                    if !value.is_nan() {
                        values.insert(key_str, value);
                    }
                }
            }

            // ── Functional test result ───────────────────────────────────────
            StdfRecord::FTR(ftr) => {
                let key_str = ftr.test_num.to_string();

                test_defs.entry(key_str.clone()).or_insert_with(|| TestDef {
                    name: ftr.test_txt.clone(),
                    test_type: "F".to_string(),
                    lo_limit: None,
                    hi_limit: None,
                    units: None,
                });

                let key = (ftr.head_num, ftr.site_num);
                if let Some(values) = pending_values.get_mut(&key) {
                    let passed = !ptr_failed(ftr.test_flg);
                    values.insert(key_str, if passed { 1.0 } else { 0.0 });
                }
            }

            // ── Die end ──────────────────────────────────────────────────────
            StdfRecord::PRR(prr) => {
                if prr.x_coord == SENTINEL_I2 || prr.y_coord == SENTINEL_I2 {
                    pending_site.remove(&(prr.head_num, prr.site_num));
                    pending_values.remove(&(prr.head_num, prr.site_num));
                    continue;
                }

                let key = (prr.head_num, prr.site_num);
                let site_num = pending_site.remove(&key).map(|s| s as u32);
                let test_values = pending_values.remove(&key).unwrap_or_default();
                let part_id = prr.part_id.parse::<u32>().ok();

                let die = DieResult {
                    x: prr.x_coord as i32,
                    y: prr.y_coord as i32,
                    hbin: prr.hard_bin as u32,
                    sbin: if prr.soft_bin == 65535 { prr.hard_bin as u32 } else { prr.soft_bin as u32 },
                    site_num,
                    part_id,
                    test_values,
                };

                // Append to current wafer if open, else create an implicit wafer
                if current_wafer.is_none() {
                    current_wafer = Some(WaferData {
                        wafer_id: format!("W{}", wafers.len() + 1),
                        results: Vec::new(),
                        part_count: None,
                        good_count: None,
                        fail_count: None,
                    });
                }
                if let Some(ref mut wafer) = current_wafer {
                    wafer.results.push(die);
                }
            }

            _ => {}
        }
    }

    // If file ends without a WRR (malformed but recoverable), flush current wafer
    if let Some(wafer) = current_wafer.take() {
        if !wafer.results.is_empty() {
            wafers.push(wafer);
        }
    }

    Ok(ParsedStdf { meta, wafers, test_defs, sites })
}

#[cfg(test)]
mod tests {
    use super::*;

    const MULTI_WAFER: &str =
        concat!(env!("CARGO_MANIFEST_DIR"), "/../sample_data/CLUST-LOT-03.stdf");
    const SINGLE_WAFER: &str =
        concat!(env!("CARGO_MANIFEST_DIR"), "/../sample_data/CLUST-LOT-03_W01.stdf");

    // ── Multi-wafer file ──────────────────────────────────────────────────────

    #[test]
    fn multi_wafer_lot_meta() {
        let result = parse_stdf(MULTI_WAFER.to_string()).unwrap();
        assert!(result.meta.lot_id.is_some(), "expected lot_id");
        assert!(result.meta.part_type.is_some(), "expected part_type");
    }

    #[test]
    fn multi_wafer_count() {
        let result = parse_stdf(MULTI_WAFER.to_string()).unwrap();
        assert!(result.wafers.len() > 1, "expected multiple wafers, got {}", result.wafers.len());
    }

    #[test]
    fn all_wafers_have_dies() {
        let result = parse_stdf(MULTI_WAFER.to_string()).unwrap();
        for w in &result.wafers {
            assert!(!w.results.is_empty(), "wafer {} has no dies", w.wafer_id);
        }
    }

    #[test]
    fn test_defs_populated() {
        let result = parse_stdf(MULTI_WAFER.to_string()).unwrap();
        assert!(!result.test_defs.is_empty(), "expected test defs");
        for (_, def) in &result.test_defs {
            assert!(def.test_type == "P" || def.test_type == "F",
                "unexpected test_type: {}", def.test_type);
        }
    }

    #[test]
    fn part_good_fail_counts_consistent() {
        let result = parse_stdf(MULTI_WAFER.to_string()).unwrap();
        for w in &result.wafers {
            if let (Some(p), Some(g), Some(f)) = (w.part_count, w.good_count, w.fail_count) {
                assert_eq!(p, g + f,
                    "wafer {}: part_count {} != good {} + fail {}", w.wafer_id, p, g, f);
            }
        }
    }

    #[test]
    fn die_coordinates_are_valid() {
        let result = parse_stdf(MULTI_WAFER.to_string()).unwrap();
        for w in &result.wafers {
            for d in &w.results {
                assert!(d.x != SENTINEL_I2 as i32 && d.y != SENTINEL_I2 as i32,
                    "sentinel coordinate leaked into results");
            }
        }
    }

    #[test]
    fn sites_populated() {
        let result = parse_stdf(MULTI_WAFER.to_string()).unwrap();
        assert!(!result.sites.is_empty(), "expected site info from SDR");
    }

    // ── Single-wafer file ─────────────────────────────────────────────────────

    #[test]
    fn single_wafer_parsed() {
        let result = parse_stdf(SINGLE_WAFER.to_string()).unwrap();
        assert_eq!(result.wafers.len(), 1);
    }

    #[test]
    fn single_wafer_has_test_values() {
        let result = parse_stdf(SINGLE_WAFER.to_string()).unwrap();
        let has_values = result.wafers[0].results.iter().any(|d| !d.test_values.is_empty());
        assert!(has_values, "expected at least some dies to have test values");
    }

    #[test]
    fn single_wafer_matches_multi_wafer_first_wafer_id() {
        let multi = parse_stdf(MULTI_WAFER.to_string()).unwrap();
        let single = parse_stdf(SINGLE_WAFER.to_string()).unwrap();
        assert_eq!(single.wafers[0].wafer_id, multi.wafers[0].wafer_id);
    }

    // ── Sentinel handling ─────────────────────────────────────────────────────

    #[test]
    fn soft_bin_sentinel_falls_back_to_hard_bin() {
        // If sbin == 65535 in PRR the parser uses hbin. We verify no die has sbin=65535.
        let result = parse_stdf(MULTI_WAFER.to_string()).unwrap();
        for w in &result.wafers {
            for d in &w.results {
                assert_ne!(d.sbin, 65535, "sbin sentinel leaked into die result");
            }
        }
    }

    // ── Error handling ────────────────────────────────────────────────────────

    #[test]
    fn nonexistent_file_returns_error() {
        let err = parse_stdf("/nonexistent/path/test.stdf".to_string());
        assert!(err.is_err());
    }

    // ── Gzip ─────────────────────────────────────────────────────────────────

    fn gz_of(src: &str) -> std::path::PathBuf {
        use std::io::Write;
        let bytes = std::fs::read(src).unwrap();
        let mut f = tempfile::Builder::new().suffix(".stdf.gz").tempfile().unwrap();
        let mut enc = flate2::write::GzEncoder::new(&mut f, flate2::Compression::default());
        enc.write_all(&bytes).unwrap();
        enc.finish().unwrap();
        f.into_temp_path().keep().unwrap()
    }

    #[test]
    fn gz_multi_wafer_parsed_same_as_plain() {
        let plain  = parse_stdf(MULTI_WAFER.to_string()).unwrap();
        let gz_path = gz_of(MULTI_WAFER);
        let gz     = parse_stdf(gz_path.to_str().unwrap().to_string()).unwrap();
        assert_eq!(gz.wafers.len(), plain.wafers.len());
        assert_eq!(gz.meta.lot_id, plain.meta.lot_id);
        let plain_dies: usize = plain.wafers.iter().map(|w| w.results.len()).sum();
        let gz_dies:    usize = gz.wafers.iter().map(|w| w.results.len()).sum();
        assert_eq!(gz_dies, plain_dies);
    }

    #[test]
    fn gz_single_wafer_parsed() {
        let gz_path = gz_of(SINGLE_WAFER);
        let result = parse_stdf(gz_path.to_str().unwrap().to_string()).unwrap();
        assert_eq!(result.wafers.len(), 1);
        assert!(!result.wafers[0].results.is_empty());
    }
}
