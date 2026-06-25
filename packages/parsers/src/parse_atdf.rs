use std::collections::HashMap;
use crate::types::*;

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
// SDR: site description. HEAD_NUM, SITE_GRP, SITE_CNT, then SITE_NUM (a
// sub-delimited list), followed by per-site descriptor fields we don't surface.
const SDR: &[&str] = &["HEAD_NUM","SITE_GRP","SITE_CNT","SITE_NUM"];
// PTR is used by the first-pass scan; the full parse reads PIR/PRR/FTR positionally
// (see the *_idx constants), so no field-name arrays are needed for those.
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

/// Positional field access for the hot record types (PTR/FTR/PIR/PRR), which make
/// up ~99% of records. Avoids building a `HashMap<&str,&str>` per record (and the
/// per-field hashmap lookups) — the field order is fixed by the spec, so we read
/// by index directly. Cold records (MIR/WIR/WRR, a handful per file) keep
/// `field_map`. Index constants below mirror the PTR/PRR/PIR/FTR name arrays.
#[inline]
fn at<'a>(fields: &[&'a str], i: usize) -> &'a str {
    fields.get(i).copied().unwrap_or("").trim()
}

// PTR field indices (see `PTR` array).
const PTR_TEST_NUM: usize = 0;
const PTR_HEAD_NUM: usize = 1;
const PTR_SITE_NUM: usize = 2;
const PTR_RESULT: usize = 3;
const PTR_TEST_TXT: usize = 6;
const PTR_UNITS: usize = 9;
const PTR_LO_LIMIT: usize = 10;
const PTR_HI_LIMIT: usize = 11;
// FTR field indices (see `FTR` array).
const FTR_TEST_NUM: usize = 0;
const FTR_HEAD_NUM: usize = 1;
const FTR_SITE_NUM: usize = 2;
const FTR_PASS_FAIL: usize = 3;
// PIR field indices (see `PIR` array).
const PIR_HEAD_NUM: usize = 0;
const PIR_SITE_NUM: usize = 1;
// PRR field indices (see `PRR` array).
const PRR_HEAD_NUM: usize = 0;
const PRR_SITE_NUM: usize = 1;
const PRR_PART_ID: usize = 2;
const PRR_HARD_BIN: usize = 5;
const PRR_SOFT_BIN: usize = 6;
const PRR_X_COORD: usize = 7;
const PRR_Y_COORD: usize = 8;

/// Pack (head, site) into a single u32 key — replaces the `format!("{},{}")`
/// string key (one heap alloc per record) for the pending PIR→PRR maps.
#[inline]
fn site_key(head: &str, site: &str) -> u32 {
    let h: u32 = head.parse().unwrap_or(1);
    let s: u32 = site.parse().unwrap_or(1);
    (h << 16) | (s & 0xFFFF)
}

fn nonempty(s: &str) -> Option<String> {
    let t = s.trim();
    if t.is_empty() { None } else { Some(t.to_string()) }
}

// ── Metadata extraction (generic, all non-empty fields) ────────────────────────
// Emit every non-empty MIR/WIR/WRR field as a key/value pair, keyed with the
// SAME camelCase keys the STDF parser uses so faceting is format-agnostic. ATDF
// timestamps are already human-readable strings, so they pass through verbatim.
// (ATDF→STDF-key map; left = ATDF field name, right = emitted key.)
const MIR_KEYS: &[(&str, &str)] = &[
    ("SETUP_T","setupT"), ("START_T","startT"), ("LOT_ID","lotId"),
    ("PART_TYP","partType"), ("NODE_NAM","nodeName"), ("TSTR_TYP","testerType"),
    ("JOB_NAM","jobName"), ("JOB_REV","jobRev"), ("SBLOT_ID","sublotId"),
    ("OPER_NAM","operName"), ("EXEC_TYP","execType"), ("EXEC_VER","execVer"),
    ("TEST_COD","testCode"), ("TST_TEMP","testTemp"), ("USER_TXT","userText"),
    ("AUX_FILE","auxFile"), ("PKG_TYP","packageType"), ("FAMLY_ID","familyId"),
    ("DATE_COD","dateCode"), ("FACIL_ID","facilityId"), ("FLOOR_ID","floorId"),
    ("PROC_ID","processId"), ("OPER_FRQ","operFreq"), ("SPEC_NAM","specName"),
    ("SPEC_VER","specVer"), ("FLOW_ID","flowId"), ("SETUP_ID","setupId"),
    ("DSGN_REV","designRev"), ("ENG_ID","engId"), ("ROM_COD","romCode"),
    ("SERL_NUM","serialNum"), ("SUPR_NAM","supervisorName"),
];
const WRR_KEYS: &[(&str, &str)] = &[
    ("FINISH_T","waferFinishT"), ("FABWF_ID","fabWaferId"), ("FRAME_ID","frameId"),
    ("MASK_ID","maskId"), ("USR_DESC","waferDescUser"), ("EXC_DESC","waferDescExec"),
];

fn fields_from(m: &HashMap<&str, &str>, keys: &[(&str, &str)]) -> Vec<MetaField> {
    let mut f = Vec::new();
    for (atdf, key) in keys {
        push_field(&mut f, key, nonempty(get(m, atdf)));
    }
    f
}

/// Build the soft-bin advisory shown to the host when SOFT_BIN was the sentinel
/// 65535 ("no soft bin") and we mirrored the hard bin instead. Returns an empty
/// vec when no fabrication happened, so the field is omitted from serialisation.
fn soft_bin_warning(fabricated: usize) -> Vec<String> {
    if fabricated == 0 {
        vec![]
    } else {
        vec![format!(
            "{fabricated} die(s) had no soft bin (sentinel 65535) — mirrored the hard bin"
        )]
    }
}

pub fn parse_atdf_from_bytes(bytes: &[u8]) -> Result<ParsedStdf, String> {
    let raw = std::str::from_utf8(bytes)
        .map_err(|e| format!("UTF-8 decode failed: {}", e))?;
    parse_atdf_str(raw, None)
}

/// Parse ATDF text. `selected: Some(set)` accumulates only those test numbers
/// (filtered second pass); `None` accumulates all. Hot records (PTR/FTR/PIR/PRR,
/// ~99% of lines) read fields positionally and key the pending PIR→PRR maps by a
/// packed (head,site) u32 — no per-record `HashMap<&str,&str>` and no per-record
/// `format!` string key. Cold records (MIR/WIR/WRR) keep `field_map`.
fn parse_atdf_str(raw: &str, selected: Option<&std::collections::HashSet<u32>>) -> Result<ParsedStdf, String> {
    // Accumulate a test value iff there's no filter, or the filter contains it.
    let want = |test_num: &str| -> bool {
        match selected {
            None => true,
            Some(set) => test_num.parse::<u32>().map_or(false, |n| set.contains(&n)),
        }
    };
    // Detect delimiter from the FAR record. FAR must be the first non-empty record
    // per the ATDF spec, so we can read it during the single join pass without
    // collecting all records first.
    let mut delim: Option<char> = None;
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
            if delim.is_none() && trimmed.starts_with("FAR:") {
                delim = trimmed.chars().nth(5);
            }
            records.push(trimmed.to_string());
        }
    }
    let delim = delim.unwrap_or('|');

    let mut meta = LotMeta::default();
    let mut test_defs: HashMap<String, TestDef> = HashMap::new();
    let mut wafers: Vec<WaferData> = Vec::new();
    let mut current_wafer: Option<WaferData> = None;
    let mut sites: Vec<SiteInfo> = Vec::new();
    // Keyed by packed (head,site) u32 (see `site_key`) — avoids a `format!` string
    // key per PIR/PTR/FTR/PRR. Inner map keyed by test-number string (tsmap identity).
    let mut pending_values: HashMap<u32, HashMap<String, f64>> = HashMap::new();
    let mut pending_site: HashMap<u32, u32> = HashMap::new();
    let mut soft_bin_fabricated: usize = 0;

    for rec in &records {
        let colon = match rec.find(':') {
            Some(i) => i,
            None => continue,
        };
        let name = &rec[..colon];
        let raw_fields: Vec<&str> = rec[colon + 1..].split(delim).collect();

        match name {
            // ── Cold records (a handful per file): keep `field_map` so metadata
            //    extraction stays identical — no field can be dropped. ──
            "MIR" => {
                let f = field_map(MIR, &raw_fields);
                meta.fields = fields_from(&f, MIR_KEYS);
            }
            "SDR" => {
                // Site description → ParsedStdf.sites, matching the STDF parser
                // (which fills sites from SDR). HEAD_NUM at [0]; every numeric field
                // from the SITE_CNT position (index 2) onward is a site number — our
                // generators emit the site list with the primary delimiter.
                let f = field_map(SDR, &raw_fields);
                let head: u32 = get(&f, "HEAD_NUM").parse().unwrap_or(1);
                for raw in raw_fields.iter().skip(2) {
                    if let Ok(site) = raw.trim().parse::<u32>() {
                        sites.push(SiteInfo { head_num: head, site_num: site });
                    }
                }
            }
            "WIR" => {
                let f = field_map(WIR, &raw_fields);
                let wafer_id = {
                    let id = get(&f, "WAFER_ID");
                    if id.is_empty() { format!("W{}", wafers.len() + 1) } else { id.to_string() }
                };
                let mut fields = Vec::new();
                push_field(&mut fields, "waferStartT", nonempty(get(&f, "START_T")));
                current_wafer = Some(WaferData {
                    wafer_id,
                    results: Vec::new(),
                    part_count: None,
                    good_count: None,
                    fail_count: None,
                    fields,
                });
            }
            "WRR" => {
                let f = field_map(WRR, &raw_fields);
                if let Some(mut w) = current_wafer.take() {
                    w.fields.extend(fields_from(&f, WRR_KEYS));
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
            // ── Hot records (~99% of lines): positional field access, packed
            //    (head,site) u32 keys, and the `want` filter gate. No per-record
            //    HashMap, no per-record `format!` key. ──
            "PIR" => {
                let key = site_key(at(&raw_fields, PIR_HEAD_NUM), at(&raw_fields, PIR_SITE_NUM));
                let site: u32 = at(&raw_fields, PIR_SITE_NUM).parse().unwrap_or(1);
                pending_site.insert(key, site);
                pending_values.insert(key, HashMap::new());
            }
            "PTR" => {
                let test_num = at(&raw_fields, PTR_TEST_NUM);
                let key = site_key(at(&raw_fields, PTR_HEAD_NUM), at(&raw_fields, PTR_SITE_NUM));
                if !test_defs.contains_key(test_num) {
                    let lo = at(&raw_fields, PTR_LO_LIMIT).parse::<f64>().ok();
                    let hi = at(&raw_fields, PTR_HI_LIMIT).parse::<f64>().ok();
                    let txt = at(&raw_fields, PTR_TEST_TXT);
                    test_defs.insert(test_num.to_string(), TestDef {
                        name: if txt.is_empty() { test_num.to_string() } else { txt.to_string() },
                        test_type: "P".to_string(),
                        lo_limit: lo,
                        hi_limit: hi,
                        units: nonempty(at(&raw_fields, PTR_UNITS)),
                    });
                }
                if want(test_num) {
                    if let Ok(result) = at(&raw_fields, PTR_RESULT).parse::<f64>() {
                        if let Some(vals) = pending_values.get_mut(&key) {
                            vals.insert(test_num.to_string(), result);
                        }
                    }
                }
            }
            "FTR" => {
                let test_num = at(&raw_fields, FTR_TEST_NUM);
                let key = site_key(at(&raw_fields, FTR_HEAD_NUM), at(&raw_fields, FTR_SITE_NUM));
                if !test_defs.contains_key(test_num) {
                    test_defs.insert(test_num.to_string(), TestDef {
                        name: test_num.to_string(),
                        test_type: "F".to_string(),
                        lo_limit: None,
                        hi_limit: None,
                        units: None,
                    });
                }
                if want(test_num) {
                    let passed = at(&raw_fields, FTR_PASS_FAIL).eq_ignore_ascii_case("P");
                    if let Some(vals) = pending_values.get_mut(&key) {
                        vals.insert(test_num.to_string(), if passed { 1.0 } else { 0.0 });
                    }
                }
            }
            "PRR" => {
                let x: i32 = match at(&raw_fields, PRR_X_COORD).parse() {
                    Ok(v) => v,
                    Err(_) => continue,
                };
                let y: i32 = match at(&raw_fields, PRR_Y_COORD).parse() {
                    Ok(v) => v,
                    Err(_) => continue,
                };
                let key = site_key(at(&raw_fields, PRR_HEAD_NUM), at(&raw_fields, PRR_SITE_NUM));
                let site_num = pending_site.remove(&key);
                let test_values = pending_values.remove(&key).unwrap_or_default();
                let hbin: Option<u32> = at(&raw_fields, PRR_HARD_BIN).parse().ok();
                let raw_sbin: Option<u32> = at(&raw_fields, PRR_SOFT_BIN).parse().ok();
                if raw_sbin == Some(65535) { soft_bin_fabricated += 1; }
                let sbin: Option<u32> = raw_sbin
                    .map(|v: u32| if v == 65535 { hbin.unwrap_or(1) } else { v })
                    .or(hbin);
                let part_id: Option<u32> = at(&raw_fields, PRR_PART_ID).parse().ok();
                let die = DieResult { x, y, hbin, sbin, site_num, part_id, test_values };
                match current_wafer.as_mut() {
                    Some(w) => w.results.push(die),
                    None => {
                        let mut w = WaferData {
                            wafer_id: format!("W{}", wafers.len() + 1),
                            results: Vec::new(),
                            part_count: None,
                            good_count: None,
                            fail_count: None,
                            fields: Vec::new(),
                        };
                        w.results.push(die);
                        current_wafer = Some(w);
                    }
                }
            }
            _ => {}
        }
    }

    if let Some(w) = current_wafer {
        if !w.results.is_empty() {
            wafers.push(w);
        }
    }

    let warnings = soft_bin_warning(soft_bin_fabricated);
    Ok(ParsedStdf { meta, wafers, test_defs, sites, warnings })
}

#[cfg(feature = "native")]
pub fn parse_atdf_sync(path: String) -> Result<ParsedStdf, String> {
    let text = crate::read_file::read_text(&path)
        .map_err(|e| format!("Failed to read {path}: {e}"))?;
    parse_atdf_str(&text, None)
}

// ── First-pass test name scan ─────────────────────────────────────────────────

/// Scans the file for PTR/FTR records only, collecting test names and limits.
/// Does not accumulate die results. Returns a flat map of test_num string → TestDef.
pub fn parse_atdf_test_names(bytes: &[u8]) -> Result<crate::types::ScanResult, String> {
    let raw = std::str::from_utf8(bytes)
        .map_err(|e| format!("UTF-8 decode failed: {}", e))?;
    parse_atdf_test_names_str(raw)
}

fn parse_atdf_test_names_str(raw: &str) -> Result<crate::types::ScanResult, String> {
    let mut delim: Option<char> = None;
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
            if delim.is_none() && trimmed.starts_with("FAR:") {
                delim = trimmed.chars().nth(5);
            }
            records.push(trimmed.to_string());
        }
    }
    let delim = delim.unwrap_or('|');

    let mut test_defs: HashMap<String, TestDef> = HashMap::new();
    let mut pir_count: u32 = 0;

    for rec in &records {
        let colon = match rec.find(':') {
            Some(i) => i,
            None => continue,
        };
        let name = &rec[..colon];
        let raw_fields: Vec<&str> = rec[colon + 1..].split(delim).collect();

        match name {
            "PIR" => { pir_count += 1; }
            "PTR" => {
                let f = field_map(PTR, &raw_fields);
                let test_num = get(&f, "TEST_NUM").to_string();
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
            }
            "FTR" => {
                let f = field_map(FTR, &raw_fields);
                let test_num = get(&f, "TEST_NUM").to_string();
                test_defs.entry(test_num.clone()).or_insert_with(|| TestDef {
                    name: test_num.clone(),
                    test_type: "F".to_string(),
                    lo_limit: None,
                    hi_limit: None,
                    units: None,
                });
            }
            _ => {}
        }
    }

    Ok(crate::types::ScanResult { test_defs, die_count: pir_count })
}

// ── Filtered parse ────────────────────────────────────────────────────────────

/// Like `parse_atdf_from_bytes` but skips die accumulation for test numbers not
/// in `selected`. Test defs are still registered for all tests.
pub fn parse_atdf_from_bytes_filtered(
    bytes: &[u8],
    selected: &std::collections::HashSet<u32>,
) -> Result<ParsedStdf, String> {
    let raw = std::str::from_utf8(bytes)
        .map_err(|e| format!("UTF-8 decode failed: {}", e))?;
    parse_atdf_str(raw, Some(selected))
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

    fn far() -> &'static str { "FAR:A|4\n" }

    fn mir_full() -> String {
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
        format!("PTR:{tnum}|{head}|{site}|{result}|P||{txt}||L|{units}|{lo}|{hi}\n")
    }
    fn ftr_rec(tnum: &str, head: u8, site: u8, pass: bool) -> String {
        format!("FTR:{tnum}|{head}|{site}|{}\n", if pass { "P" } else { "F" })
    }
    fn one_wafer(id: &str, inner: &str) -> String {
        format!("{}{}{}{}{}", far(), mir_full(), wir(id), inner, wrr(id, 4, 3))
    }

    #[test]
    fn meta_extracted_from_mir() {
        let text = one_wafer("W1", &(pir(1,1) + &prr(1,1,0,0,1,1)));
        let path = tmp(&text);
        let result = parse_atdf_sync(path.to_str().unwrap().to_string()).unwrap();
        assert_eq!(result.meta.get("lotId"), Some("LOT-01"));
        assert_eq!(result.meta.get("partType"), Some("WIDGET"));
        assert_eq!(result.meta.get("jobName"), Some("JOB1"));
        assert_eq!(result.meta.get("nodeName"), Some("NODE1"));
        assert_eq!(result.meta.get("testerType"), Some("TSTR-A"));
        assert_eq!(result.meta.get("sublotId"), Some("SUBLOT-1"));
    }

    #[test]
    fn empty_mir_yields_none_meta() {
        let text = format!("{}MIR:\n", far());
        let path = tmp(&text);
        let result = parse_atdf_sync(path.to_str().unwrap().to_string()).unwrap();
        assert!(result.meta.get("lotId").is_none());
        assert!(result.meta.get("partType").is_none());
    }

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
    fn sdr_populates_sites() {
        // Parity with the STDF parser, which fills ParsedStdf.sites from SDR.
        let inner = pir(1,1) + &prr(1,1,0,0,1,1);
        let text = format!("{}{}SDR:1|1|1|2|3|4\n{}{}{}", far(), mir_full(), wir("W01"), inner, wrr("W01", 1, 1));
        let path = tmp(&text);
        let result = parse_atdf_sync(path.to_str().unwrap().to_string()).unwrap();
        let site_nums: Vec<u32> = result.sites.iter().map(|s| s.site_num).collect();
        assert_eq!(site_nums, vec![1, 2, 3, 4]);
        assert!(result.sites.iter().all(|s| s.head_num == 1));
    }

    #[test]
    fn hot_path_values_bins_and_site_preserved() {
        // Guards the positional/packed-key fast path: test values, bins and per-die
        // site_num must survive across multiple sites in one batch.
        let inner = pir(1,2) + &pir(1,3)
            + &ptr_rec("1000", 1, 2, 1.5, 0.0, 5.0, "leak", "nA")
            + &ptr_rec("1000", 1, 3, 2.5, 0.0, 5.0, "leak", "nA")
            + &ftr_rec("2000", 1, 2, true)
            + &prr(1, 2, 0, 0, 1, 1)
            + &prr(1, 3, 1, 0, 2, 2);
        let text = one_wafer("W01", &inner);
        let path = tmp(&text);
        let r = parse_atdf_sync(path.to_str().unwrap().to_string()).unwrap();
        let dies = &r.wafers[0].results;
        assert_eq!(dies.len(), 2);
        let d2 = dies.iter().find(|d| d.site_num == Some(2)).expect("site 2 die");
        let d3 = dies.iter().find(|d| d.site_num == Some(3)).expect("site 3 die");
        // Each site's value landed on the right die (packed key disambiguates sites).
        assert_eq!(d2.test_values.get("1000"), Some(&1.5));
        assert_eq!(d2.test_values.get("2000"), Some(&1.0)); // FTR pass → 1.0
        assert_eq!(d3.test_values.get("1000"), Some(&2.5));
        assert_eq!(d2.hbin, Some(1));
        assert_eq!(d3.hbin, Some(2));
        // Test defs registered with limits/units from the full PTR.
        let td = r.test_defs.get("1000").expect("test 1000 def");
        assert_eq!(td.name, "leak");
        assert_eq!(td.units.as_deref(), Some("nA"));
        assert_eq!(td.lo_limit, Some(0.0));
        assert_eq!(td.hi_limit, Some(5.0));
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

    #[test]
    fn crlf_line_endings() {
        let text = one_wafer("W1", &(pir(1,1) + &prr(1,1,1,2,1,1)))
            .replace('\n', "\r\n");
        let path = tmp(&text);
        let result = parse_atdf_sync(path.to_str().unwrap().to_string()).unwrap();
        assert_eq!(result.wafers[0].results[0].x, 1);
        assert_eq!(result.wafers[0].results[0].y, 2);
    }

    #[test]
    fn sample_file_multi_wafer() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../sample_data/CLUST-LOT-03.atdf");
        let result = parse_atdf_sync(path.to_string()).unwrap();
        assert!(result.wafers.len() > 1, "expected multiple wafers");
        assert!(result.meta.get("lotId").is_some(), "expected lot ID");
        for w in &result.wafers {
            assert!(!w.results.is_empty(), "wafer {} has no dies", w.wafer_id);
        }
    }

    #[test]
    fn sample_file_single_wafer() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../sample_data/CLUST-LOT-03_W01.atdf");
        let result = parse_atdf_sync(path.to_string()).unwrap();
        assert_eq!(result.wafers.len(), 1);
        assert!(!result.test_defs.is_empty(), "expected test defs");
    }

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
        let plain_path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../sample_data/CLUST-LOT-03.atdf");
        let plain   = parse_atdf_sync(plain_path.to_string()).unwrap();
        let gz_path = gz_of(plain_path);
        let gz      = parse_atdf_sync(gz_path.to_str().unwrap().to_string()).unwrap();
        assert_eq!(gz.wafers.len(), plain.wafers.len());
        assert_eq!(gz.meta.get("lotId"), plain.meta.get("lotId"));
        let plain_dies: usize = plain.wafers.iter().map(|w| w.results.len()).sum();
        let gz_dies:    usize = gz.wafers.iter().map(|w| w.results.len()).sum();
        assert_eq!(gz_dies, plain_dies);
    }

    // Run with: cargo test --manifest-path packages/parsers/Cargo.toml --features bench --release -- --nocapture bench_parse_atdf
    #[cfg(feature = "bench")]
    #[test]
    fn bench_parse_atdf() {
        let path = "/tmp/bench.atdf";
        let bytes = match std::fs::read(path) {
            Ok(b) => b,
            Err(_) => { eprintln!("SKIP: {path} not found — run scripts/generate_atdf_bench.py"); return; }
        };
        let file_mb = bytes.len() as f64 / 1_048_576.0;

        let _ = parse_atdf_from_bytes(&bytes).unwrap(); // warm
        let t = std::time::Instant::now();
        let result = parse_atdf_from_bytes(&bytes).unwrap();
        let ms = t.elapsed().as_millis();
        let dies: usize = result.wafers.iter().map(|w| w.results.len()).sum();
        println!(
            "\n=== bench_parse_atdf ({file_mb:.1} MB) ===\n\
             wafers: {}\ndies:   {dies}\ntests:  {}\ntotal:  {ms} ms\nthroughput: {:.0} MB/s",
            result.wafers.len(), result.test_defs.len(),
            file_mb / (ms as f64 / 1000.0).max(0.001),
        );
    }
}
