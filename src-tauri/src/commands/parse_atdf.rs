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
pub async fn parse_atdf(path: String) -> Result<ParsedStdf, String> {
    tokio::task::spawn_blocking(move || parse_atdf_sync(path))
        .await
        .map_err(|e| e.to_string())?
}

fn parse_atdf_sync(path: String) -> Result<ParsedStdf, String> {
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

                let hbin: Option<u32> = get(&f, "HARD_BIN").parse().ok();
                let sbin: Option<u32> = get(&f, "SOFT_BIN").parse().ok()
                    .map(|v: u32| if v == 65535 { hbin.unwrap_or(1) } else { v })
                    .or(hbin);
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    // Write text to a temp file and return its path.
    fn tmp(content: &str) -> std::path::PathBuf {
        let mut f = tempfile::NamedTempFile::new().unwrap();
        f.write_all(content.as_bytes()).unwrap();
        f.into_temp_path().keep().unwrap()
    }

    // ── Fixture helpers ───────────────────────────────────────────────────────

    fn far() -> &'static str { "FAR:A|4\n" }

    fn mir_full() -> String {
        // Fields 0-4: LOT_ID, PART_TYP, JOB_NAM, NODE_NAM, TSTR_TYP
        // Fields 5-29: empty (25 fields = 25 separators after field 4)
        // Field 30: SBLOT_ID
        let mut fields = vec![""; 31];
        fields[0]  = "LOT-01";
        fields[1]  = "WIDGET";
        fields[2]  = "JOB1";
        fields[3]  = "NODE1";
        fields[4]  = "TSTR-A";
        fields[30] = "SUBLOT-1";
        format!("MIR:{}\n", fields.join("|"))
    }

    fn wir(id: &str) -> String { format!("WIR:1||1|{id}\n") }
    fn wrr(id: &str, part: u32, good: u32) -> String {
        format!("WRR:1||{part}|{id}||0|{good}\n")
    }
    fn pir(head: u8, site: u8) -> String { format!("PIR:{head}|{site}\n") }
    fn prr(head: u8, site: u8, x: i32, y: i32, hbin: u32, sbin: u32) -> String {
        format!("PRR:{head}|{site}|1|4|P|{hbin}|{sbin}|{x}|{y}\n")
    }
    fn ptr_rec(tnum: &str, head: u8, site: u8, result: f64, lo: f64, hi: f64, txt: &str, units: &str) -> String {
        // PTR fields: TEST_NUM|HEAD|SITE|RESULT|PF|ALARMFLAGS|TEST_TXT|ALARM_ID|LIMITCOMPARE|UNITS|LO|HI
        format!("PTR:{tnum}|{head}|{site}|{result}|P||{txt}||L|{units}|{lo}|{hi}\n")
    }
    fn ftr_rec(tnum: &str, head: u8, site: u8, pass: bool) -> String {
        format!("FTR:{tnum}|{head}|{site}|{}\n", if pass { "P" } else { "F" })
    }

    fn one_wafer(id: &str, inner: &str) -> String {
        format!("{}{}{}{}{}", far(), mir_full(), wir(id), inner, wrr(id, 4, 3))
    }

    // ── Meta ──────────────────────────────────────────────────────────────────

    #[test]
    fn meta_extracted_from_mir() {
        let text = one_wafer("W1", &(pir(1,1) + &prr(1,1,0,0,1,1)));
        let path = tmp(&text);
        let result = parse_atdf_sync(path.to_str().unwrap().to_string()).unwrap();
        assert_eq!(result.meta.lot_id.as_deref(), Some("LOT-01"));
        assert_eq!(result.meta.part_type.as_deref(), Some("WIDGET"));
        assert_eq!(result.meta.job_name.as_deref(), Some("JOB1"));
        assert_eq!(result.meta.node_name.as_deref(), Some("NODE1"));
        assert_eq!(result.meta.tester_type.as_deref(), Some("TSTR-A"));
        assert_eq!(result.meta.sublot_id.as_deref(), Some("SUBLOT-1"));
    }

    #[test]
    fn empty_mir_yields_none_meta() {
        let text = format!("{}MIR:\n", far());
        let path = tmp(&text);
        let result = parse_atdf_sync(path.to_str().unwrap().to_string()).unwrap();
        assert!(result.meta.lot_id.is_none());
        assert!(result.meta.part_type.is_none());
    }

    // ── Wafers ────────────────────────────────────────────────────────────────

    #[test]
    fn single_wafer_parsed() {
        let inner = pir(1,1) + &prr(1,1,0,0,1,1);
        let text = one_wafer("W01", &inner);
        let path = tmp(&text);
        let result = parse_atdf_sync(path.to_str().unwrap().to_string()).unwrap();
        assert_eq!(result.wafers.len(), 1);
        assert_eq!(result.wafers[0].wafer_id, "W01");
    }

    #[test]
    fn wrr_wafer_id_overrides_wir() {
        let inner = pir(1,1) + &prr(1,1,0,0,1,1);
        let text = format!("{}{}{}{}{}", far(), mir_full(), wir("WIR-ID"), inner, wrr("WRR-ID", 1, 1));
        let path = tmp(&text);
        let result = parse_atdf_sync(path.to_str().unwrap().to_string()).unwrap();
        assert_eq!(result.wafers[0].wafer_id, "WRR-ID");
    }

    #[test]
    fn fallback_wafer_id_when_wir_empty() {
        let inner = pir(1,1) + &prr(1,1,0,0,1,1);
        let text = format!("{}{}WIR:1||1|\n{}{}", far(), mir_full(), inner, wrr("", 1, 1));
        let path = tmp(&text);
        let result = parse_atdf_sync(path.to_str().unwrap().to_string()).unwrap();
        assert_eq!(result.wafers[0].wafer_id, "W1");
    }

    #[test]
    fn multiple_wafers() {
        let w1 = wir("W01") + &pir(1,1) + &prr(1,1,0,0,1,1) + &wrr("W01", 1, 1);
        let w2 = wir("W02") + &pir(1,1) + &prr(1,1,1,1,1,1) + &wrr("W02", 1, 1);
        let text = format!("{}{}{}{}", far(), mir_full(), w1, w2);
        let path = tmp(&text);
        let result = parse_atdf_sync(path.to_str().unwrap().to_string()).unwrap();
        assert_eq!(result.wafers.len(), 2);
        assert_eq!(result.wafers[0].wafer_id, "W01");
        assert_eq!(result.wafers[1].wafer_id, "W02");
    }

    #[test]
    fn part_good_fail_counts_from_wrr() {
        let inner = pir(1,1) + &prr(1,1,0,0,1,1);
        let text = format!("{}{}{}{}", far(), mir_full(), wir("W1"), inner) + &wrr("W1", 10, 7);
        let path = tmp(&text);
        let result = parse_atdf_sync(path.to_str().unwrap().to_string()).unwrap();
        assert_eq!(result.wafers[0].part_count, Some(10));
        assert_eq!(result.wafers[0].good_count, Some(7));
        assert_eq!(result.wafers[0].fail_count, Some(3));
    }

    #[test]
    fn wafer_flushed_without_wrr() {
        let text = format!("{}{}{}{}",
            far(), mir_full(), wir("W1"), pir(1,1)) + &prr(1,1,0,0,1,1);
        let path = tmp(&text);
        let result = parse_atdf_sync(path.to_str().unwrap().to_string()).unwrap();
        assert_eq!(result.wafers.len(), 1);
        assert_eq!(result.wafers[0].results.len(), 1);
    }

    #[test]
    fn no_wafers_for_empty_file() {
        let text = format!("{}{}", far(), mir_full());
        let path = tmp(&text);
        let result = parse_atdf_sync(path.to_str().unwrap().to_string()).unwrap();
        assert!(result.wafers.is_empty());
    }

    // ── Die coordinates and bins ──────────────────────────────────────────────

    #[test]
    fn die_coordinates_and_bins() {
        let inner = pir(1,1) + &prr(1,1,3,7,2,5);
        let path = tmp(&one_wafer("W1", &inner));
        let die = &parse_atdf_sync(path.to_str().unwrap().to_string()).unwrap().wafers[0].results[0];
        assert_eq!(die.x, 3);
        assert_eq!(die.y, 7);
        assert_eq!(die.hbin, Some(2));
        assert_eq!(die.sbin, Some(5));
    }

    #[test]
    fn negative_coordinates() {
        let inner = pir(1,1) + &prr(1,1,-4,-9,1,1);
        let path = tmp(&one_wafer("W1", &inner));
        let die = &parse_atdf_sync(path.to_str().unwrap().to_string()).unwrap().wafers[0].results[0];
        assert_eq!(die.x, -4);
        assert_eq!(die.y, -9);
    }

    #[test]
    fn die_with_missing_coords_is_skipped() {
        // PRR with empty x/y — parse fails, die not added
        let inner = pir(1,1) + "PRR:1|1|1|4|P|1|1||\n";
        let text = format!("{}{}{}{}{}", far(), mir_full(), wir("W1"), inner, wrr("W1", 0, 0));
        let path = tmp(&text);
        let result = parse_atdf_sync(path.to_str().unwrap().to_string()).unwrap();
        assert_eq!(result.wafers[0].results.len(), 0);
    }

    #[test]
    fn multiple_dies_on_one_wafer() {
        let inner: String = (0..4).map(|i| pir(1,1) + &prr(1,1,i,i,1,1)).collect();
        let path = tmp(&one_wafer("W1", &inner));
        let result = parse_atdf_sync(path.to_str().unwrap().to_string()).unwrap();
        assert_eq!(result.wafers[0].results.len(), 4);
    }

    // ── PTR ───────────────────────────────────────────────────────────────────

    #[test]
    fn ptr_test_value_and_def() {
        let inner = pir(1,1)
            + &ptr_rec("100", 1, 1, 1.23, 0.0, 2.0, "Vt", "mV")
            + &prr(1,1,0,0,1,1);
        let path = tmp(&one_wafer("W1", &inner));
        let result = parse_atdf_sync(path.to_str().unwrap().to_string()).unwrap();
        let die = &result.wafers[0].results[0];
        let v = *die.test_values.get("100").unwrap();
        assert!((v - 1.23).abs() < 1e-9);
        let def = result.test_defs.get("100").unwrap();
        assert_eq!(def.name, "Vt");
        assert_eq!(def.test_type, "P");
        assert_eq!(def.lo_limit, Some(0.0));
        assert_eq!(def.hi_limit, Some(2.0));
        assert_eq!(def.units.as_deref(), Some("mV"));
    }

    #[test]
    fn ptr_test_def_captured_once() {
        // Second die same test num — def must not change
        let inner = pir(1,1) + &ptr_rec("1", 1, 1, 1.0, 0.0, 2.0, "First", "V") + &prr(1,1,0,0,1,1)
            + &pir(1,1) + &ptr_rec("1", 1, 1, 1.5, 10.0, 20.0, "Second", "V") + &prr(1,1,1,0,1,1);
        let path = tmp(&one_wafer("W1", &inner));
        let result = parse_atdf_sync(path.to_str().unwrap().to_string()).unwrap();
        let def = result.test_defs.get("1").unwrap();
        assert_eq!(def.name, "First");
        assert_eq!(def.lo_limit, Some(0.0));
    }

    #[test]
    fn multiple_ptr_values_per_die() {
        let inner = pir(1,1)
            + &ptr_rec("1", 1, 1, 1.0, 0.0, 2.0, "A", "V")
            + &ptr_rec("2", 1, 1, 3.5, 0.0, 5.0, "B", "V")
            + &prr(1,1,0,0,1,1);
        let path = tmp(&one_wafer("W1", &inner));
        let die = &parse_atdf_sync(path.to_str().unwrap().to_string()).unwrap().wafers[0].results[0];
        assert!((die.test_values["1"] - 1.0).abs() < 1e-9);
        assert!((die.test_values["2"] - 3.5).abs() < 1e-9);
    }

    // ── FTR ───────────────────────────────────────────────────────────────────

    #[test]
    fn ftr_pass_is_1_fail_is_0() {
        let inner = pir(1,1) + &ftr_rec("200", 1, 1, true)  + &prr(1,1,0,0,1,1)
            + &pir(1,1) + &ftr_rec("200", 1, 1, false) + &prr(1,1,1,0,2,2);
        let path = tmp(&one_wafer("W1", &inner));
        let result = parse_atdf_sync(path.to_str().unwrap().to_string()).unwrap();
        assert_eq!(result.wafers[0].results[0].test_values["200"], 1.0);
        assert_eq!(result.wafers[0].results[1].test_values["200"], 0.0);
        assert_eq!(result.test_defs["200"].test_type, "F");
    }

    // ── Multi-site ────────────────────────────────────────────────────────────

    #[test]
    fn multi_site_values_separated() {
        let inner = pir(1,1) + &pir(1,2)
            + &ptr_rec("1", 1, 1, 1.1, 0.0, 2.0, "T", "V")
            + &ptr_rec("1", 1, 2, 2.2, 0.0, 2.0, "T", "V")
            + &prr(1,1,0,0,1,1)
            + &prr(1,2,1,0,1,1);
        let path = tmp(&one_wafer("W1", &inner));
        let result = parse_atdf_sync(path.to_str().unwrap().to_string()).unwrap();
        let dies = &result.wafers[0].results;
        assert_eq!(dies.len(), 2);
        let d0 = dies.iter().find(|d| d.x == 0).unwrap();
        let d1 = dies.iter().find(|d| d.x == 1).unwrap();
        assert!((d0.test_values["1"] - 1.1).abs() < 1e-9);
        assert!((d1.test_values["1"] - 2.2).abs() < 1e-9);
    }

    // ── Delimiter detection ───────────────────────────────────────────────────

    #[test]
    fn comma_delimiter_from_far() {
        let pipe_to_comma = |s: &str| s.replace('|', ",");
        let text = "FAR:A,4\n".to_string()
            + &pipe_to_comma(&mir_full())
            + &pipe_to_comma(&wir("W1"))
            + &pipe_to_comma(&pir(1,1))
            + &pipe_to_comma(&prr(1,1,9,3,1,1))
            + &pipe_to_comma(&wrr("W1", 1, 1));
        let path = tmp(&text);
        let result = parse_atdf_sync(path.to_str().unwrap().to_string()).unwrap();
        let die = &result.wafers[0].results[0];
        assert_eq!(die.x, 9);
        assert_eq!(die.y, 3);
    }

    #[test]
    fn default_pipe_delimiter_without_far() {
        let text = mir_full()
            + &wir("W1") + &pir(1,1) + &prr(1,1,5,6,1,1) + &wrr("W1", 1, 1);
        let path = tmp(&text);
        let result = parse_atdf_sync(path.to_str().unwrap().to_string()).unwrap();
        assert_eq!(result.wafers[0].results[0].x, 5);
    }

    // ── CRLF ──────────────────────────────────────────────────────────────────

    #[test]
    fn crlf_line_endings() {
        let text = one_wafer("W1", &(pir(1,1) + &prr(1,1,1,2,1,1)))
            .replace('\n', "\r\n");
        let path = tmp(&text);
        let result = parse_atdf_sync(path.to_str().unwrap().to_string()).unwrap();
        assert_eq!(result.wafers[0].results[0].x, 1);
        assert_eq!(result.wafers[0].results[0].y, 2);
    }

    // ── Sample file ───────────────────────────────────────────────────────────

    #[test]
    fn sample_file_multi_wafer() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../sample_data/CLUST-LOT-03.atdf");
        let result = parse_atdf_sync(path.to_string()).unwrap();
        assert!(result.wafers.len() > 1, "expected multiple wafers");
        assert!(result.meta.lot_id.is_some(), "expected lot ID");
        for w in &result.wafers {
            assert!(!w.results.is_empty(), "wafer {} has no dies", w.wafer_id);
        }
    }

    #[test]
    fn sample_file_single_wafer() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../sample_data/CLUST-LOT-03_W01.atdf");
        let result = parse_atdf_sync(path.to_string()).unwrap();
        assert_eq!(result.wafers.len(), 1);
        assert!(!result.test_defs.is_empty(), "expected test defs");
    }

    // ── Gzip ─────────────────────────────────────────────────────────────────

    fn gz_of(src: &str) -> std::path::PathBuf {
        use std::io::Write;
        let bytes = std::fs::read(src).unwrap();
        let mut f = tempfile::Builder::new().suffix(".atdf.gz").tempfile().unwrap();
        let mut enc = flate2::write::GzEncoder::new(&mut f, flate2::Compression::default());
        enc.write_all(&bytes).unwrap();
        enc.finish().unwrap();
        f.into_temp_path().keep().unwrap()
    }

    #[test]
    fn gz_parsed_same_as_plain() {
        let plain_path = concat!(env!("CARGO_MANIFEST_DIR"), "/../sample_data/CLUST-LOT-03.atdf");
        let plain  = parse_atdf_sync(plain_path.to_string()).unwrap();
        let gz_path = gz_of(plain_path);
        let gz     = parse_atdf_sync(gz_path.to_str().unwrap().to_string()).unwrap();
        assert_eq!(gz.wafers.len(), plain.wafers.len());
        assert_eq!(gz.meta.lot_id, plain.meta.lot_id);
        let plain_dies: usize = plain.wafers.iter().map(|w| w.results.len()).sum();
        let gz_dies:    usize = gz.wafers.iter().map(|w| w.results.len()).sum();
        assert_eq!(gz_dies, plain_dies);
    }
}
