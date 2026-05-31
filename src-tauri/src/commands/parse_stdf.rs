use rust_stdf::{stdf_file::StdfReader, StdfRecord};
use serde::Serialize;
use std::collections::HashMap;

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
    let mut reader = StdfReader::new(&path).map_err(|e| e.to_string())?;

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
                    sbin: prr.soft_bin as u32,
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
