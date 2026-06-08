use rust_stdf::{stdf_file::StdfReader, CompressType, StdfRecord};
use std::collections::HashMap;
use std::io::{BufReader, Cursor};
use crate::types::*;

// PTR test_flg bit 7 = test failed
fn ptr_failed(test_flg: [u8; 1]) -> bool {
    test_flg[0] & 0x80 != 0
}

fn nonempty(s: String) -> Option<String> {
    if s.is_empty() { None } else { Some(s) }
}

// Sentinel values used by rust-stdf for "not present"
const SENTINEL_U4: u32 = 4_294_967_295;
const SENTINEL_I2: i16 = -32768;

pub fn parse_stdf_from_bytes(bytes: &[u8]) -> Result<ParsedStdf, String> {
    let mut reader = StdfReader::from(
        BufReader::new(Cursor::new(bytes)),
        &CompressType::Uncompressed,
    )
    .map_err(|e| e.to_string())?;

    let mut meta = LotMeta::default();
    let mut sites: Vec<SiteInfo> = Vec::new();
    let mut test_defs: HashMap<String, TestDef> = HashMap::new();
    let mut wafers: Vec<WaferData> = Vec::new();
    let mut current_wafer: Option<WaferData> = None;
    let mut pending_site: HashMap<(u8, u8), u8> = HashMap::new();
    let mut pending_values: HashMap<(u8, u8), HashMap<String, f64>> = HashMap::new();

    for rec in reader.get_record_iter() {
        let rec = rec.map_err(|e| e.to_string())?;
        match rec {
            StdfRecord::MIR(mir) => {
                meta.lot_id      = nonempty(mir.lot_id);
                meta.part_type   = nonempty(mir.part_typ);
                meta.job_name    = nonempty(mir.job_nam);
                meta.tester_type = nonempty(mir.tstr_typ);
                meta.node_name   = nonempty(mir.node_nam);
                meta.sublot_id   = nonempty(mir.sblot_id);
            }
            StdfRecord::SDR(sdr) => {
                for &site in &sdr.site_num {
                    sites.push(SiteInfo {
                        head_num: sdr.head_num as u32,
                        site_num: site as u32,
                    });
                }
            }
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
            StdfRecord::PIR(pir) => {
                let key = (pir.head_num, pir.site_num);
                pending_site.insert(key, pir.site_num);
                pending_values.insert(key, HashMap::new());
            }
            StdfRecord::PTR(ptr) => {
                let key_str = ptr.test_num.to_string();
                test_defs.entry(key_str.clone()).or_insert_with(|| TestDef {
                    name: ptr.test_txt.clone(),
                    test_type: "P".to_string(),
                    lo_limit: ptr.lo_limit.map(|v| v as f64),
                    hi_limit: ptr.hi_limit.map(|v| v as f64),
                    units: ptr.units.as_ref().and_then(|u| nonempty(u.clone())),
                });
                let key = (ptr.head_num, ptr.site_num);
                if let Some(values) = pending_values.get_mut(&key) {
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
                    hbin: Some(prr.hard_bin as u32),
                    sbin: Some(if prr.soft_bin == 65535 { prr.hard_bin as u32 } else { prr.soft_bin as u32 }),
                    site_num,
                    part_id,
                    test_values,
                };
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

    if let Some(wafer) = current_wafer.take() {
        if !wafer.results.is_empty() {
            wafers.push(wafer);
        }
    }

    Ok(ParsedStdf { meta, wafers, test_defs, sites })
}

#[cfg(feature = "native")]
pub fn parse_stdf_sync(path: String) -> Result<ParsedStdf, String> {
    let bytes = crate::read_file::read_bytes(&path)?;
    parse_stdf_from_bytes(&bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    const MULTI_WAFER: &str =
        concat!(env!("CARGO_MANIFEST_DIR"), "/../../sample_data/CLUST-LOT-03.stdf");
    const SINGLE_WAFER: &str =
        concat!(env!("CARGO_MANIFEST_DIR"), "/../../sample_data/CLUST-LOT-03_W01.stdf");

    #[test]
    fn multi_wafer_lot_meta() {
        let result = parse_stdf_sync(MULTI_WAFER.to_string()).unwrap();
        assert!(result.meta.lot_id.is_some(), "expected lot_id");
        assert!(result.meta.part_type.is_some(), "expected part_type");
    }

    #[test]
    fn multi_wafer_count() {
        let result = parse_stdf_sync(MULTI_WAFER.to_string()).unwrap();
        assert!(result.wafers.len() > 1, "expected multiple wafers, got {}", result.wafers.len());
    }

    #[test]
    fn all_wafers_have_dies() {
        let result = parse_stdf_sync(MULTI_WAFER.to_string()).unwrap();
        for w in &result.wafers {
            assert!(!w.results.is_empty(), "wafer {} has no dies", w.wafer_id);
        }
    }

    #[test]
    fn test_defs_populated() {
        let result = parse_stdf_sync(MULTI_WAFER.to_string()).unwrap();
        assert!(!result.test_defs.is_empty(), "expected test defs");
        for (_, def) in &result.test_defs {
            assert!(def.test_type == "P" || def.test_type == "F",
                "unexpected test_type: {}", def.test_type);
        }
    }

    #[test]
    fn part_good_fail_counts_consistent() {
        let result = parse_stdf_sync(MULTI_WAFER.to_string()).unwrap();
        for w in &result.wafers {
            if let (Some(p), Some(g), Some(f)) = (w.part_count, w.good_count, w.fail_count) {
                assert_eq!(p, g + f,
                    "wafer {}: part_count {} != good {} + fail {}", w.wafer_id, p, g, f);
            }
        }
    }

    #[test]
    fn die_coordinates_are_valid() {
        let result = parse_stdf_sync(MULTI_WAFER.to_string()).unwrap();
        for w in &result.wafers {
            for d in &w.results {
                assert!(d.x != SENTINEL_I2 as i32 && d.y != SENTINEL_I2 as i32,
                    "sentinel coordinate leaked into results");
            }
        }
    }

    #[test]
    fn sites_populated() {
        let result = parse_stdf_sync(MULTI_WAFER.to_string()).unwrap();
        assert!(!result.sites.is_empty(), "expected site info from SDR");
    }

    #[test]
    fn single_wafer_parsed() {
        let result = parse_stdf_sync(SINGLE_WAFER.to_string()).unwrap();
        assert_eq!(result.wafers.len(), 1);
    }

    #[test]
    fn single_wafer_has_test_values() {
        let result = parse_stdf_sync(SINGLE_WAFER.to_string()).unwrap();
        let has_values = result.wafers[0].results.iter().any(|d| !d.test_values.is_empty());
        assert!(has_values, "expected at least some dies to have test values");
    }

    #[test]
    fn single_wafer_matches_multi_wafer_first_wafer_id() {
        let multi = parse_stdf_sync(MULTI_WAFER.to_string()).unwrap();
        let single = parse_stdf_sync(SINGLE_WAFER.to_string()).unwrap();
        assert_eq!(single.wafers[0].wafer_id, multi.wafers[0].wafer_id);
    }

    #[test]
    fn soft_bin_sentinel_falls_back_to_hard_bin() {
        let result = parse_stdf_sync(MULTI_WAFER.to_string()).unwrap();
        for w in &result.wafers {
            for d in &w.results {
                assert_ne!(d.sbin, Some(65535), "sbin sentinel leaked into die result");
            }
        }
    }

    #[test]
    fn nonexistent_file_returns_error() {
        let err = parse_stdf_sync("/nonexistent/path/test.stdf".to_string());
        assert!(err.is_err());
    }

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
        let plain   = parse_stdf_sync(MULTI_WAFER.to_string()).unwrap();
        let gz_path = gz_of(MULTI_WAFER);
        let gz      = parse_stdf_sync(gz_path.to_str().unwrap().to_string()).unwrap();
        assert_eq!(gz.wafers.len(), plain.wafers.len());
        assert_eq!(gz.meta.lot_id, plain.meta.lot_id);
        let plain_dies: usize = plain.wafers.iter().map(|w| w.results.len()).sum();
        let gz_dies:    usize = gz.wafers.iter().map(|w| w.results.len()).sum();
        assert_eq!(gz_dies, plain_dies);
    }

    #[test]
    fn gz_single_wafer_parsed() {
        let gz_path = gz_of(SINGLE_WAFER);
        let result = parse_stdf_sync(gz_path.to_str().unwrap().to_string()).unwrap();
        assert_eq!(result.wafers.len(), 1);
        assert!(!result.wafers[0].results.is_empty());
    }
}
