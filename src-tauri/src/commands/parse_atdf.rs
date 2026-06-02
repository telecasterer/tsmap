use std::collections::HashMap;
use super::parse_stdf::{DieResult, LotMeta, ParsedStdf, TestDef, WaferData};
use super::read_file::read_text;

// Field positions for each record type (positional, pipe-delimited)
const MIR: &[&str] = &[
    "LOT_ID","PART_TYP","JOB_NAM","NODE_NAM","TSTR_TYP","TSTR_SN","SUPR_NAM",
    "JOB_REV","EXEC_TYP","EXEC_VER","TEST_COD","TST_TEMP","USER_TXT","AUX_FILE",
    "PKG_TYP","FAMLY_ID","DATE_COD","FACIL_ID","FLOOR_ID","PROC_ID","OPER_FRQ",
    "SPEC_NAM","SPEC_VER","FLOW_ID","SETUP_ID","DSGN_REV","ENG_ID","ROM_COD",
    "SERL_NUM","OPER_NAM","SBLOT_ID","SETUP_T","START_T","STAT_NUM","MODE_COD",
    "RTST_COD","PROT_COD","BURN_TIM",
];
const WIR: &[&str] = &["HEAD_NUM","START_T","SITE_GRP","WAFER_ID"];
const WRR: &[&str] = &[
    "HEAD_NUM","FINISH_T","PART_CNT","WAFER_ID","SITE_GRP","ABRT_CNT",
    "GOOD_CNT","FUNC_CNT","WAFER_ID2","FABWF_ID","FRAME_ID","MASK_ID",
    "USR_DESC","EXC_DESC",
];
const PIR: &[&str] = &["HEAD_NUM","SITE_NUM"];
const PRR: &[&str] = &[
    "HEAD_NUM","SITE_NUM","PART_ID","NUM_TEST","PASS_FAIL","HARD_BIN","SOFT_BIN",
    "X_COORD","Y_COORD","RETEST_CODE","ABORT_CODE","TEST_T","PART_TXT","PART_FIX",
];
const PTR: &[&str] = &[
    "TEST_NUM","HEAD_NUM","SITE_NUM","RESULT","PASS_FAIL","ALARM_FLAGS",
    "TEST_TXT","ALARM_ID","LIMIT_COMPARE","UNITS","LO_LIMIT","HI_LIMIT",
    "C_RESFMT","C_LLMFMT","C_HLMFMT","LO_SPEC","HI_SPEC","RES_SCAL",
    "LLM_SCAL","HLM_SCAL",
];
const FTR: &[&str] = &["TEST_NUM","HEAD_NUM","SITE_NUM","PASS_FAIL"];

fn field_map<'a>(names: &[&'static str], values: &'a [&'a str]) -> HashMap<&'static str, &'a str> {
    names.iter().enumerate()
        .map(|(i, &name)| (name, *values.get(i).unwrap_or(&"")))
        .collect()
}

fn get<'a>(m: &HashMap<&str, &'a str>, key: &str) -> &'a str {
    m.get(key).copied().unwrap_or("").trim()
}

fn nonempty(s: &str) -> Option<String> {
    let t = s.trim();
    if t.is_empty() { None } else { Some(t.to_string()) }
}

#[tauri::command]
pub fn parse_atdf(path: String) -> Result<ParsedStdf, String> {
    let raw = read_text(&path)
        .map_err(|e| format!("Failed to read {path}: {e}"))?;

    // Join continuation lines (lines starting with space)
    let mut records: Vec<String> = Vec::new();
    for line in raw.lines() {
        if line.starts_with(' ') {
            if let Some(last) = records.last_mut() {
                last.push_str(line.trim_start());
                continue;
            }
        }
        let trimmed = line.trim();
        if !trimmed.is_empty() {
            records.push(trimmed.to_string());
        }
    }

    // Detect delimiter from FAR record: FAR:A<delim>...
    let delim: char = records.iter()
        .find(|r| r.starts_with("FAR:"))
        .and_then(|r| r.chars().nth(5))
        .unwrap_or('|');

    let mut meta = LotMeta::default();
    let mut test_defs: HashMap<String, TestDef> = HashMap::new();
    let mut wafers: Vec<WaferData> = Vec::new();
    let mut current_wafer: Option<WaferData> = None;

    // Pending test values per (head,site) key — accumulated between PIR and PRR
    let mut pending_values: HashMap<String, HashMap<String, f64>> = HashMap::new();
    let mut pending_site: HashMap<String, u32> = HashMap::new();

    for rec in &records {
        let colon = match rec.find(':') {
            Some(i) => i,
            None => continue,
        };
        let name = &rec[..colon];
        let raw_fields: Vec<&str> = rec[colon + 1..].split(delim).collect();

        match name {
            "MIR" => {
                let f = field_map(MIR, &raw_fields);
                meta.lot_id      = nonempty(get(&f, "LOT_ID"));
                meta.part_type   = nonempty(get(&f, "PART_TYP"));
                meta.job_name    = nonempty(get(&f, "JOB_NAM"));
                meta.node_name   = nonempty(get(&f, "NODE_NAM"));
                meta.tester_type = nonempty(get(&f, "TSTR_TYP"));
                meta.sublot_id   = nonempty(get(&f, "SBLOT_ID"));
            }

            "WIR" => {
                let f = field_map(WIR, &raw_fields);
                let wafer_id = {
                    let id = get(&f, "WAFER_ID");
                    if id.is_empty() {
                        format!("W{}", wafers.len() + 1)
                    } else {
                        id.to_string()
                    }
                };
                current_wafer = Some(WaferData {
                    wafer_id,
                    results: Vec::new(),
                    part_count: None,
                    good_count: None,
                    fail_count: None,
                });
            }

            "WRR" => {
                let f = field_map(WRR, &raw_fields);
                if let Some(mut w) = current_wafer.take() {
                    let wid = get(&f, "WAFER_ID");
                    if !wid.is_empty() { w.wafer_id = wid.to_string(); }
                    w.part_count = get(&f, "PART_CNT").parse().ok();
                    w.good_count = get(&f, "GOOD_CNT").parse().ok();
                    w.fail_count = match (w.part_count, w.good_count) {
                        (Some(p), Some(g)) => Some(p.saturating_sub(g)),
                        _ => None,
                    };
                    wafers.push(w);
                }
            }

            "PIR" => {
                let f = field_map(PIR, &raw_fields);
                let key = format!("{},{}", get(&f, "HEAD_NUM"), get(&f, "SITE_NUM"));
                let site: u32 = get(&f, "SITE_NUM").parse().unwrap_or(1);
                pending_site.insert(key.clone(), site);
                pending_values.insert(key, HashMap::new());
            }

            "PTR" => {
                let f = field_map(PTR, &raw_fields);
                let test_num = get(&f, "TEST_NUM").to_string();
                let key = format!("{},{}", get(&f, "HEAD_NUM"), get(&f, "SITE_NUM"));

                // Capture test def on first PTR for this test number with limits
                test_defs.entry(test_num.clone()).or_insert_with(|| {
                    let lo = get(&f, "LO_LIMIT").parse::<f64>().ok();
                    let hi = get(&f, "HI_LIMIT").parse::<f64>().ok();
                    TestDef {
                        name: {
                            let t = get(&f, "TEST_TXT");
                            if t.is_empty() { test_num.clone() } else { t.to_string() }
                        },
                        test_type: "P".to_string(),
                        lo_limit: lo,
                        hi_limit: hi,
                        units: nonempty(get(&f, "UNITS")),
                    }
                });

                if let Ok(result) = get(&f, "RESULT").parse::<f64>() {
                    if let Some(vals) = pending_values.get_mut(&key) {
                        vals.insert(test_num, result);
                    }
                }
            }

            "FTR" => {
                let f = field_map(FTR, &raw_fields);
                let test_num = get(&f, "TEST_NUM").to_string();
                let key = format!("{},{}", get(&f, "HEAD_NUM"), get(&f, "SITE_NUM"));

                test_defs.entry(test_num.clone()).or_insert_with(|| TestDef {
                    name: test_num.clone(),
                    test_type: "F".to_string(),
                    lo_limit: None,
                    hi_limit: None,
                    units: None,
                });

                let passed = get(&f, "PASS_FAIL").eq_ignore_ascii_case("P");
                if let Some(vals) = pending_values.get_mut(&key) {
                    vals.insert(test_num, if passed { 1.0 } else { 0.0 });
                }
            }

            "PRR" => {
                let f = field_map(PRR, &raw_fields);
                let x: i32 = match get(&f, "X_COORD").parse() {
                    Ok(v) => v,
                    Err(_) => continue,
                };
                let y: i32 = match get(&f, "Y_COORD").parse() {
                    Ok(v) => v,
                    Err(_) => continue,
                };

                let key = format!("{},{}", get(&f, "HEAD_NUM"), get(&f, "SITE_NUM"));
                let site_num = pending_site.remove(&key);
                let test_values = pending_values.remove(&key).unwrap_or_default();

                let hbin: u32 = get(&f, "HARD_BIN").parse().unwrap_or(1);
                let sbin: u32 = get(&f, "SOFT_BIN").parse().unwrap_or(hbin);
                let part_id: Option<u32> = get(&f, "PART_ID").parse().ok();

                let die = DieResult { x, y, hbin, sbin, site_num, part_id, test_values };

                match current_wafer.as_mut() {
                    Some(w) => w.results.push(die),
                    None => {
                        // PRR without WIR — create implicit wafer
                        let mut w = WaferData {
                            wafer_id: format!("W{}", wafers.len() + 1),
                            results: Vec::new(),
                            part_count: None,
                            good_count: None,
                            fail_count: None,
                        };
                        w.results.push(die);
                        current_wafer = Some(w);
                    }
                }
            }

            _ => {}
        }
    }

    // Flush wafer if file ends without WRR
    if let Some(w) = current_wafer {
        if !w.results.is_empty() {
            wafers.push(w);
        }
    }

    Ok(ParsedStdf { meta, wafers, test_defs, sites: vec![] })
}
