use rust_stdf::{stdf_file::StdfReader, CompressType, StdfRecord};
use std::collections::HashMap;
use std::io::{BufReader, Cursor};
use crate::types::*;

fn nonempty(s: String) -> Option<String> {
    if s.is_empty() { None } else { Some(s) }
}

const SENTINEL_U4: u32 = 4_294_967_295;
const SENTINEL_I2: i16 = -32768;

// ── Metadata extraction (generic, all non-empty fields) ────────────────────────
// We emit every non-empty MIR/WIR/WRR field as a raw key/value pair. tsmap owns
// friendly labels and which fields to surface, so adding or relabelling a facet
// never requires republishing this crate. Keys are camelCase STDF field names.

/// All non-empty lot-level fields from the MIR record.
fn mir_fields(mir: &rust_stdf::MIR) -> Vec<MetaField> {
    let mut f = Vec::new();
    // Timestamps → ISO 8601 (host truncates to date where it groups by date).
    push_field(&mut f, "setupT", epoch_to_iso(mir.setup_t));
    push_field(&mut f, "startT", epoch_to_iso(mir.start_t));
    // Character fields (Cn → String). Single-char code fields (C1) are skipped as
    // low-value; tsmap can ignore any it doesn't want regardless.
    push_field(&mut f, "lotId",    nonempty(mir.lot_id.clone()));
    push_field(&mut f, "partType", nonempty(mir.part_typ.clone()));
    push_field(&mut f, "nodeName", nonempty(mir.node_nam.clone()));
    push_field(&mut f, "testerType", nonempty(mir.tstr_typ.clone()));
    push_field(&mut f, "jobName",  nonempty(mir.job_nam.clone()));
    push_field(&mut f, "jobRev",   nonempty(mir.job_rev.clone()));
    push_field(&mut f, "sublotId", nonempty(mir.sblot_id.clone()));
    push_field(&mut f, "operName", nonempty(mir.oper_nam.clone()));
    push_field(&mut f, "execType", nonempty(mir.exec_typ.clone()));
    push_field(&mut f, "execVer",  nonempty(mir.exec_ver.clone()));
    push_field(&mut f, "testCode", nonempty(mir.test_cod.clone()));
    push_field(&mut f, "testTemp", nonempty(mir.tst_temp.clone()));
    push_field(&mut f, "userText", nonempty(mir.user_txt.clone()));
    push_field(&mut f, "auxFile",  nonempty(mir.aux_file.clone()));
    push_field(&mut f, "packageType", nonempty(mir.pkg_typ.clone()));
    push_field(&mut f, "familyId", nonempty(mir.famly_id.clone()));
    push_field(&mut f, "dateCode", nonempty(mir.date_cod.clone()));
    push_field(&mut f, "facilityId", nonempty(mir.facil_id.clone()));
    push_field(&mut f, "floorId",  nonempty(mir.floor_id.clone()));
    push_field(&mut f, "processId", nonempty(mir.proc_id.clone()));
    push_field(&mut f, "operFreq", nonempty(mir.oper_frq.clone()));
    push_field(&mut f, "specName", nonempty(mir.spec_nam.clone()));
    push_field(&mut f, "specVer",  nonempty(mir.spec_ver.clone()));
    push_field(&mut f, "flowId",   nonempty(mir.flow_id.clone()));
    push_field(&mut f, "setupId",  nonempty(mir.setup_id.clone()));
    push_field(&mut f, "designRev", nonempty(mir.dsgn_rev.clone()));
    push_field(&mut f, "engId",    nonempty(mir.eng_id.clone()));
    push_field(&mut f, "romCode",  nonempty(mir.rom_cod.clone()));
    push_field(&mut f, "serialNum", nonempty(mir.serl_num.clone()));
    push_field(&mut f, "supervisorName", nonempty(mir.supr_nam.clone()));
    f
}

/// All non-empty wafer-level string fields from a WIR record.
fn wir_fields(wir: &rust_stdf::WIR) -> Vec<MetaField> {
    let mut f = Vec::new();
    push_field(&mut f, "waferStartT", epoch_to_iso(wir.start_t));
    f
}

/// All non-empty wafer-level string fields from a WRR record (appended to the
/// wafer's existing fields). Numeric counts are surfaced via partCount etc.
fn wrr_fields(wrr: &rust_stdf::WRR) -> Vec<MetaField> {
    let mut f = Vec::new();
    push_field(&mut f, "waferFinishT", epoch_to_iso(wrr.finish_t));
    push_field(&mut f, "fabWaferId", nonempty(wrr.fabwf_id.clone()));
    push_field(&mut f, "frameId", nonempty(wrr.frame_id.clone()));
    push_field(&mut f, "maskId",  nonempty(wrr.mask_id.clone()));
    push_field(&mut f, "waferDescUser", nonempty(wrr.usr_desc.clone()));
    push_field(&mut f, "waferDescExec", nonempty(wrr.exc_desc.clone()));
    f
}

// ── Warnings ───────────────────────────────────────────────────────────────────

/// Build the soft-bin advisory shown to the host when a PRR's soft bin was the
/// sentinel 65535 ("no soft bin") and we mirrored the hard bin instead. Returns
/// an empty vec when no fabrication happened (field omitted from serialisation).
fn soft_bin_warning(fabricated: usize) -> Vec<String> {
    if fabricated == 0 {
        vec![]
    } else {
        vec![format!(
            "{fabricated} die(s) had no soft bin (sentinel 65535) — mirrored the hard bin"
        )]
    }
}

// ── Raw byte helpers ──────────────────────────────────────────────────────────

// All readers are bounds-checked and return None on a short slice, so a
// truncated record can never panic (in WASM a panic aborts the whole module).
#[inline(always)]
fn read_u4_le(b: &[u8], pos: usize) -> Option<u32> {
    Some(u32::from_le_bytes(b.get(pos..pos + 4)?.try_into().ok()?))
}

#[inline(always)]
fn read_u2_le(b: &[u8], pos: usize) -> Option<u16> {
    Some(u16::from_le_bytes(b.get(pos..pos + 2)?.try_into().ok()?))
}

#[inline(always)]
fn read_i2_le(b: &[u8], pos: usize) -> Option<i16> {
    Some(i16::from_le_bytes(b.get(pos..pos + 2)?.try_into().ok()?))
}

#[inline(always)]
fn read_f32_le(b: &[u8], pos: usize) -> Option<f32> {
    Some(f32::from_le_bytes(b.get(pos..pos + 4)?.try_into().ok()?))
}

// Read a Cn (1-byte length + ASCII) and return (string, new_pos).
// Returns empty string if pos is at or past end.
fn read_cn_str(b: &[u8], pos: usize) -> (String, usize) {
    if pos >= b.len() {
        return (String::new(), pos);
    }
    let len = b[pos] as usize;
    let start = pos + 1;
    let end = (start + len).min(b.len());
    let s = std::str::from_utf8(&b[start..end]).unwrap_or("").to_string();
    (s, end)
}

// ── PIR/PRR direct parse ──────────────────────────────────────────────────────

#[inline(always)]
fn pir_head_site(b: &[u8]) -> Option<(u8, u8)> {
    if b.len() >= 2 { Some((b[0], b[1])) } else { None }
}

struct PrrFields {
    head: u8,
    site: u8,
    hard_bin: u16,
    soft_bin: u16,
    x: i16,
    y: i16,
    part_id: Option<u32>,
}

fn parse_prr(b: &[u8]) -> Option<PrrFields> {
    if b.len() < 14 { return None; }
    let head     = b[0];
    let site     = b[1];
    // b[2] = part_flg, b[3..5] = num_test
    let hard_bin = read_u2_le(b, 5)?;
    let soft_bin = read_u2_le(b, 7).unwrap_or(hard_bin);
    let x        = read_i2_le(b, 9).unwrap_or(SENTINEL_I2);
    let y        = read_i2_le(b, 11).unwrap_or(SENTINEL_I2);
    // test_t is 4 bytes at 13..17, then part_id as Cn at 17
    let part_id  = if b.len() > 17 {
        let (s, _) = read_cn_str(b, 17);
        s.parse::<u32>().ok()
    } else {
        None
    };
    Some(PrrFields { head, site, hard_bin, soft_bin, x, y, part_id })
}

// ── PTR/FTR fast path ─────────────────────────────────────────────────────────

// PTR layout: [0..4] test_num, [4] head, [5] site, [6] test_flg, [7] parm_flg,
//             [8..12] result (f32), [12..] test_txt (Cn), alarm_id (Cn),
//             optional fields (opt_flag, res_scal, llm_scal, hlm_scal, lo_limit, hi_limit, units, ...)
struct PtrFast {
    test_num: u32,
    head: u8,
    site: u8,
    failed: bool,
    result: f32,
}

#[inline(always)]
fn parse_ptr_fast(b: &[u8]) -> Option<PtrFast> {
    if b.len() < 12 { return None; }
    Some(PtrFast {
        test_num: read_u4_le(b, 0)?,
        head:     b[4],
        site:     b[5],
        failed:   b[6] & 0x80 != 0,
        result:   read_f32_le(b, 8)?,
    })
}

// Extract test_txt and optional lo/hi limits from a PTR raw record.
// Called only on the first occurrence of each test_num.
fn ptr_defs_from_raw(b: &[u8]) -> (String, Option<f64>, Option<f64>, Option<String>) {
    if b.len() < 12 {
        return (String::new(), None, None, None);
    }
    let (test_txt, pos) = read_cn_str(b, 12);
    let (_, pos) = read_cn_str(b, pos); // alarm_id
    if pos >= b.len() {
        return (test_txt, None, None, None);
    }
    let opt_flag = b[pos];
    let pos = pos + 1;
    if pos + 3 > b.len() {
        return (test_txt, None, None, None);
    }
    let pos = pos + 3; // skip res_scal, llm_scal, hlm_scal (1 byte each)
    let lo = if opt_flag & 0x40 == 0 {
        read_f32_le(b, pos).map(|v| v as f64)
    } else {
        None
    };
    let pos = pos + 4;
    let hi = if opt_flag & 0x80 == 0 {
        read_f32_le(b, pos).map(|v| v as f64)
    } else {
        None
    };
    let pos = pos + 4;
    let units = if pos < b.len() {
        let (u, _) = read_cn_str(b, pos);
        if u.is_empty() { None } else { Some(u) }
    } else {
        None
    };
    (test_txt, lo, hi, units)
}

// Returns true if opt_flag is present in this PTR and explicitly marks both limits absent.
// opt_flag bit 6 = no lo_limit, bit 7 = no hi_limit.
fn ptr_limits_explicitly_absent(b: &[u8]) -> bool {
    if b.len() < 12 { return false; }
    let (_, pos) = read_cn_str(b, 12); // skip test_txt
    let (_, pos) = read_cn_str(b, pos); // skip alarm_id
    if pos >= b.len() { return false; }
    let opt_flag = b[pos];
    // Both absent bits set → no limits will ever appear for this test
    opt_flag & 0xC0 == 0xC0
}

// FTR layout: [0..4] test_num, [4] head, [5] site, [6] test_flg
#[inline(always)]
fn parse_ftr_fast(b: &[u8]) -> Option<(u32, u8, u8, bool)> {
    if b.len() < 7 { return None; }
    let test_num = read_u4_le(b, 0)?;
    let head = b[4];
    let site = b[5];
    let failed = b[6] & 0x80 != 0;
    Some((test_num, head, site, failed))
}

// FTR test_txt is deep in the record after many fixed + variable fields.
// Only needed on first occurrence; fall back to struct parse via rust-stdf.
fn ftr_test_txt_from_struct(b: &[u8], order: &rust_stdf::ByteOrder) -> String {
    let mut ftr = rust_stdf::FTR::new();
    ftr.read_from_bytes(b, order);
    ftr.test_txt
}

// ── Per-site accumulator ──────────────────────────────────────────────────────

// Maps test_num → (slot_index, is_ftr). Built incrementally as new tests appear.
// slot_index is an index into pending_values[site].values.
struct TestIndex {
    map: HashMap<u32, usize>, // test_num → slot index
    order: Vec<u32>,          // slot index → test_num (for building DieResult)
}

impl TestIndex {
    fn new() -> Self {
        TestIndex { map: HashMap::new(), order: Vec::new() }
    }
    fn get_or_insert(&mut self, test_num: u32) -> usize {
        if let Some(&idx) = self.map.get(&test_num) {
            return idx;
        }
        let idx = self.order.len();
        self.map.insert(test_num, idx);
        self.order.push(test_num);
        idx
    }
    fn len(&self) -> usize { self.order.len() }
}

struct SiteAccum {
    values: Vec<f32>,   // NaN = not present / failed with result==0
}

impl SiteAccum {
    fn new(capacity: usize) -> Self {
        SiteAccum { values: vec![f32::NAN; capacity] }
    }
    fn ensure_slot(&mut self, idx: usize) {
        if idx >= self.values.len() {
            self.values.resize(idx + 1, f32::NAN);
        }
    }
    fn set(&mut self, idx: usize, v: f32) {
        self.ensure_slot(idx);
        self.values[idx] = v;
    }
    fn reset(&mut self) {
        self.values.iter_mut().for_each(|v| *v = f32::NAN);
    }
    fn to_test_values(&self, index: &TestIndex, test_defs_keys: &[String]) -> HashMap<String, f64> {
        // Count non-NaN entries first so we can pre-size the HashMap and avoid rehashing.
        let cap = self.values.iter().take(index.order.len()).filter(|v| !v.is_nan()).count();
        let mut out = HashMap::with_capacity(cap);
        for (i, _) in index.order.iter().enumerate() {
            let v = if i < self.values.len() { self.values[i] } else { f32::NAN };
            if !v.is_nan() {
                if let Some(key) = test_defs_keys.get(i) {
                    out.insert(key.clone(), v as f64);
                }
            }
        }
        out
    }
}

// ── Main parser ───────────────────────────────────────────────────────────────

pub fn parse_stdf_from_bytes(bytes: &[u8]) -> Result<ParsedStdf, String> {
    // We still use StdfReader for endianness detection and header validation,
    // but iterate via RawDataIter to avoid per-PTR struct allocation.
    let mut reader = StdfReader::from(
        BufReader::new(Cursor::new(bytes)),
        &CompressType::Uncompressed,
    )
    .map_err(|e| e.to_string())?;

    let mut meta = LotMeta::default();
    let mut sites: Vec<SiteInfo> = Vec::new();
    let mut test_defs: HashMap<String, TestDef> = HashMap::new();
    // test_num → string key (cached to avoid re-formatting on every PTR)
    let mut test_num_to_key: HashMap<u32, String> = HashMap::new();
    // test_nums whose limits are fully resolved (both lo+hi found, or opt_flag confirms absent)
    let mut limits_resolved: std::collections::HashSet<u32> = std::collections::HashSet::new();
    let mut wafers: Vec<WaferData> = Vec::new();
    let mut soft_bin_fabricated: usize = 0;
    let mut current_wafer: Option<WaferData> = None;

    // Shared test index and per-site accumulators.
    // Key = (head_num, site_num).
    let mut test_index = TestIndex::new();
    let mut site_accums: HashMap<(u8, u8), SiteAccum> = HashMap::new();
    // test_num → ordered key string (parallel to test_index.order)
    let mut index_keys: Vec<String> = Vec::new();

    for raw in reader.get_rawdata_iter() {
        let raw = raw.map_err(|e| e.to_string())?;
        let (typ, sub) = (raw.header.typ, raw.header.sub);
        let b = &raw.raw_data;

        match (typ, sub) {
            // ── PTR ──────────────────────────────────────────────────────────
            (15, 10) => {
                let Some(ptr) = parse_ptr_fast(b) else { continue };
                let key = (ptr.head, ptr.site);

                // Register test def on first occurrence; update limits until resolved
                if !test_num_to_key.contains_key(&ptr.test_num) {
                    let key_str = ptr.test_num.to_string();
                    let (test_txt, lo, hi, units) = ptr_defs_from_raw(b);
                    let resolved = lo.is_some() || hi.is_some()
                        || ptr_limits_explicitly_absent(b);
                    if resolved { limits_resolved.insert(ptr.test_num); }
                    test_defs.insert(key_str.clone(), TestDef {
                        name: test_txt,
                        test_type: "P".to_string(),
                        lo_limit: lo,
                        hi_limit: hi,
                        units,
                    });
                    let idx = test_index.get_or_insert(ptr.test_num);
                    while index_keys.len() <= idx {
                        index_keys.push(String::new());
                    }
                    index_keys[idx] = key_str.clone();
                    test_num_to_key.insert(ptr.test_num, key_str);
                } else if !limits_resolved.contains(&ptr.test_num) {
                    // Limits not yet found — check this record
                    let (_, lo, hi, units) = ptr_defs_from_raw(b);
                    if lo.is_some() || hi.is_some() || ptr_limits_explicitly_absent(b) {
                        limits_resolved.insert(ptr.test_num);
                        if let Some(key_str) = test_num_to_key.get(&ptr.test_num) {
                            if let Some(def) = test_defs.get_mut(key_str) {
                                if lo.is_some() { def.lo_limit = lo; }
                                if hi.is_some() { def.hi_limit = hi; }
                                if units.is_some() && def.units.is_none() { def.units = units; }
                            }
                        }
                    }
                }

                if let Some(accum) = site_accums.get_mut(&key) {
                    let idx = test_index.get_or_insert(ptr.test_num);
                    let value = if ptr.failed && ptr.result == 0.0 {
                        f32::NAN
                    } else {
                        ptr.result
                    };
                    accum.set(idx, value);
                }
            }

            // ── FTR ──────────────────────────────────────────────────────────
            (15, 20) => {
                let Some((test_num, head, site, failed)) = parse_ftr_fast(b) else { continue };
                let key = (head, site);

                if !test_num_to_key.contains_key(&test_num) {
                    let key_str = test_num.to_string();
                    let test_txt = ftr_test_txt_from_struct(b, &raw.byte_order);
                    test_defs.insert(key_str.clone(), TestDef {
                        name: test_txt,
                        test_type: "F".to_string(),
                        lo_limit: None,
                        hi_limit: None,
                        units: None,
                    });
                    let idx = test_index.get_or_insert(test_num);
                    while index_keys.len() <= idx {
                        index_keys.push(String::new());
                    }
                    index_keys[idx] = key_str.clone();
                    test_num_to_key.insert(test_num, key_str);
                }

                if let Some(accum) = site_accums.get_mut(&key) {
                    let idx = test_index.get_or_insert(test_num);
                    accum.set(idx, if failed { 0.0 } else { 1.0 });
                }
            }

            // ── PIR ──────────────────────────────────────────────────────────
            (5, 10) => {
                let Some((head, site)) = pir_head_site(b) else { continue };
                let key = (head, site);
                let cap = test_index.len().max(64);
                site_accums.entry(key).or_insert_with(|| SiteAccum::new(cap)).reset();
            }

            // ── PRR ──────────────────────────────────────────────────────────
            (5, 20) => {
                let Some(prr) = parse_prr(b) else { continue };
                if prr.x == SENTINEL_I2 || prr.y == SENTINEL_I2 {
                    site_accums.remove(&(prr.head, prr.site));
                    continue;
                }
                let key = (prr.head, prr.site);
                let test_values = if let Some(accum) = site_accums.get(&key) {
                    accum.to_test_values(&test_index, &index_keys)
                } else {
                    HashMap::new()
                };
                if prr.soft_bin == 65535 { soft_bin_fabricated += 1; }
                let die = DieResult {
                    x: prr.x as i32,
                    y: prr.y as i32,
                    hbin: Some(prr.hard_bin as u32),
                    sbin: Some(if prr.soft_bin == 65535 {
                        prr.hard_bin as u32
                    } else {
                        prr.soft_bin as u32
                    }),
                    site_num: Some(prr.site as u32),
                    part_id: prr.part_id,
                    test_values,
                };
                if current_wafer.is_none() {
                    current_wafer = Some(WaferData {
                        wafer_id: format!("W{}", wafers.len() + 1),
                        results: Vec::new(),
                        part_count: None,
                        good_count: None,
                        fail_count: None,
                        fields: Vec::new(),
                    });
                }
                if let Some(ref mut wafer) = current_wafer {
                    wafer.results.push(die);
                }
            }

            // ── Rare structural records — parse via rust-stdf ─────────────
            _ => {
                let mut rec = StdfRecord::new_from_header(raw.header);
                rec.read_from_bytes(b, &raw.byte_order);
                match rec {
                    StdfRecord::MIR(mir) => {
                        meta.fields = mir_fields(&mir);
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
                        let fields = wir_fields(&wir);
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
                            fields,
                        });
                    }
                    StdfRecord::WRR(wrr) => {
                        if let Some(mut wafer) = current_wafer.take() {
                            wafer.fields.extend(wrr_fields(&wrr));
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
                    _ => {}
                }
            }
        }
    }

    if let Some(wafer) = current_wafer.take() {
        if !wafer.results.is_empty() {
            wafers.push(wafer);
        }
    }

    let warnings = soft_bin_warning(soft_bin_fabricated);
    Ok(ParsedStdf { meta, wafers, test_defs, sites, warnings })
}

#[cfg(feature = "native")]
pub fn parse_stdf_sync(path: String) -> Result<ParsedStdf, String> {
    let bytes = crate::read_file::read_bytes(&path)?;
    parse_stdf_from_bytes(&bytes)
}

// ── First-pass test name scan ─────────────────────────────────────────────────

/// Scans the file for PTR/FTR records only, collecting test names and limits.
/// Does not accumulate die results. Used to populate the test selector overlay
/// before the full parse. Returns a flat map of test_num string → TestDef.
pub fn parse_stdf_test_names(bytes: &[u8]) -> Result<crate::types::ScanResult, String> {
    let mut reader = StdfReader::from(
        BufReader::new(Cursor::new(bytes)),
        &CompressType::Uncompressed,
    )
    .map_err(|e| e.to_string())?;

    let mut test_defs: HashMap<String, TestDef> = HashMap::new();
    let mut test_num_to_key: HashMap<u32, String> = HashMap::new();
    let mut limits_resolved: std::collections::HashSet<u32> = std::collections::HashSet::new();
    let mut pir_count: u32 = 0;

    for raw in reader.get_rawdata_iter() {
        let raw = raw.map_err(|e| e.to_string())?;
        let b = &raw.raw_data;
        match (raw.header.typ, raw.header.sub) {
            (5, 10) => { pir_count += 1; }
            (15, 10) => {
                let Some(test_num) = read_u4_le(b, 0) else { continue; };
                if !test_num_to_key.contains_key(&test_num) {
                    let key_str = test_num.to_string();
                    let (test_txt, lo, hi, units) = ptr_defs_from_raw(b);
                    let resolved = lo.is_some() || hi.is_some() || ptr_limits_explicitly_absent(b);
                    if resolved { limits_resolved.insert(test_num); }
                    test_defs.insert(key_str.clone(), TestDef {
                        name: test_txt,
                        test_type: "P".to_string(),
                        lo_limit: lo,
                        hi_limit: hi,
                        units,
                    });
                    test_num_to_key.insert(test_num, key_str);
                } else if !limits_resolved.contains(&test_num) {
                    let (_, lo, hi, units) = ptr_defs_from_raw(b);
                    if lo.is_some() || hi.is_some() || ptr_limits_explicitly_absent(b) {
                        limits_resolved.insert(test_num);
                        if let Some(key_str) = test_num_to_key.get(&test_num) {
                            if let Some(def) = test_defs.get_mut(key_str) {
                                if lo.is_some() { def.lo_limit = lo; }
                                if hi.is_some() { def.hi_limit = hi; }
                                if units.is_some() && def.units.is_none() { def.units = units; }
                            }
                        }
                    }
                }
            }
            (15, 20) => {
                let Some(test_num) = read_u4_le(b, 0) else { continue; };
                if !test_num_to_key.contains_key(&test_num) {
                    let key_str = test_num.to_string();
                    let test_txt = ftr_test_txt_from_struct(b, &raw.byte_order);
                    test_defs.insert(key_str.clone(), TestDef {
                        name: test_txt,
                        test_type: "F".to_string(),
                        lo_limit: None,
                        hi_limit: None,
                        units: None,
                    });
                    test_num_to_key.insert(test_num, key_str);
                }
            }
            _ => {}
        }
    }

    Ok(crate::types::ScanResult { test_defs, die_count: pir_count })
}

// ── Filtered parse ────────────────────────────────────────────────────────────

/// Like `parse_stdf_from_bytes` but skips die accumulation for test numbers not
/// in `selected`. Test defs are still registered for all tests so the result's
/// `test_defs` map remains complete; only `test_values` per die is filtered.
pub fn parse_stdf_from_bytes_filtered(
    bytes: &[u8],
    selected: &std::collections::HashSet<u32>,
) -> Result<ParsedStdf, String> {
    let mut reader = StdfReader::from(
        BufReader::new(Cursor::new(bytes)),
        &CompressType::Uncompressed,
    )
    .map_err(|e| e.to_string())?;

    let mut meta = LotMeta::default();
    let mut sites: Vec<SiteInfo> = Vec::new();
    let mut test_defs: HashMap<String, TestDef> = HashMap::new();
    let mut test_num_to_key: HashMap<u32, String> = HashMap::new();
    let mut limits_resolved: std::collections::HashSet<u32> = std::collections::HashSet::new();
    let mut wafers: Vec<WaferData> = Vec::new();
    let mut soft_bin_fabricated: usize = 0;
    let mut current_wafer: Option<WaferData> = None;
    let mut test_index = TestIndex::new();
    let mut site_accums: HashMap<(u8, u8), SiteAccum> = HashMap::new();
    let mut index_keys: Vec<String> = Vec::new();

    for raw in reader.get_rawdata_iter() {
        let raw = raw.map_err(|e| e.to_string())?;
        let (typ, sub) = (raw.header.typ, raw.header.sub);
        let b = &raw.raw_data;

        match (typ, sub) {
            (15, 10) => {
                let Some(ptr) = parse_ptr_fast(b) else { continue };
                let key = (ptr.head, ptr.site);

                // Always register/update test def regardless of selection
                if !test_num_to_key.contains_key(&ptr.test_num) {
                    let key_str = ptr.test_num.to_string();
                    let (test_txt, lo, hi, units) = ptr_defs_from_raw(b);
                    let resolved = lo.is_some() || hi.is_some() || ptr_limits_explicitly_absent(b);
                    if resolved { limits_resolved.insert(ptr.test_num); }
                    test_defs.insert(key_str.clone(), TestDef {
                        name: test_txt,
                        test_type: "P".to_string(),
                        lo_limit: lo,
                        hi_limit: hi,
                        units,
                    });
                    test_num_to_key.insert(ptr.test_num, key_str.clone());
                    // Only add to the accumulation index if this test is selected
                    if selected.contains(&ptr.test_num) {
                        let idx = test_index.get_or_insert(ptr.test_num);
                        while index_keys.len() <= idx { index_keys.push(String::new()); }
                        index_keys[idx] = key_str;
                    }
                } else if !limits_resolved.contains(&ptr.test_num) {
                    let (_, lo, hi, units) = ptr_defs_from_raw(b);
                    if lo.is_some() || hi.is_some() || ptr_limits_explicitly_absent(b) {
                        limits_resolved.insert(ptr.test_num);
                        if let Some(key_str) = test_num_to_key.get(&ptr.test_num) {
                            if let Some(def) = test_defs.get_mut(key_str) {
                                if lo.is_some() { def.lo_limit = lo; }
                                if hi.is_some() { def.hi_limit = hi; }
                                if units.is_some() && def.units.is_none() { def.units = units; }
                            }
                        }
                    }
                }

                // Skip accumulation for unselected tests
                if !selected.contains(&ptr.test_num) { continue; }

                if let Some(accum) = site_accums.get_mut(&key) {
                    let idx = test_index.get_or_insert(ptr.test_num);
                    let value = if ptr.failed && ptr.result == 0.0 { f32::NAN } else { ptr.result };
                    accum.set(idx, value);
                }
            }

            (15, 20) => {
                let Some((test_num, head, site, failed)) = parse_ftr_fast(b) else { continue };
                let key = (head, site);

                if !test_num_to_key.contains_key(&test_num) {
                    let key_str = test_num.to_string();
                    let test_txt = ftr_test_txt_from_struct(b, &raw.byte_order);
                    test_defs.insert(key_str.clone(), TestDef {
                        name: test_txt,
                        test_type: "F".to_string(),
                        lo_limit: None,
                        hi_limit: None,
                        units: None,
                    });
                    test_num_to_key.insert(test_num, key_str.clone());
                    // Only add to the accumulation index if this test is selected
                    if selected.contains(&test_num) {
                        let idx = test_index.get_or_insert(test_num);
                        while index_keys.len() <= idx { index_keys.push(String::new()); }
                        index_keys[idx] = key_str;
                    }
                }

                // Skip accumulation for unselected tests
                if !selected.contains(&test_num) { continue; }

                if let Some(accum) = site_accums.get_mut(&key) {
                    let idx = test_index.get_or_insert(test_num);
                    accum.set(idx, if failed { 0.0 } else { 1.0 });
                }
            }

            (5, 10) => {
                let Some((head, site)) = pir_head_site(b) else { continue };
                let key = (head, site);
                let cap = test_index.len().max(64);
                site_accums.entry(key).or_insert_with(|| SiteAccum::new(cap)).reset();
            }

            (5, 20) => {
                let Some(prr) = parse_prr(b) else { continue };
                if prr.x == SENTINEL_I2 || prr.y == SENTINEL_I2 {
                    site_accums.remove(&(prr.head, prr.site));
                    continue;
                }
                let key = (prr.head, prr.site);
                let test_values = if let Some(accum) = site_accums.get(&key) {
                    accum.to_test_values(&test_index, &index_keys)
                } else {
                    HashMap::new()
                };
                if prr.soft_bin == 65535 { soft_bin_fabricated += 1; }
                let die = DieResult {
                    x: prr.x as i32,
                    y: prr.y as i32,
                    hbin: Some(prr.hard_bin as u32),
                    sbin: Some(if prr.soft_bin == 65535 {
                        prr.hard_bin as u32
                    } else {
                        prr.soft_bin as u32
                    }),
                    site_num: Some(prr.site as u32),
                    part_id: prr.part_id,
                    test_values,
                };
                if current_wafer.is_none() {
                    current_wafer = Some(WaferData {
                        wafer_id: format!("W{}", wafers.len() + 1),
                        results: Vec::new(),
                        part_count: None,
                        good_count: None,
                        fail_count: None,
                        fields: Vec::new(),
                    });
                }
                if let Some(ref mut wafer) = current_wafer { wafer.results.push(die); }
            }

            _ => {
                let mut rec = StdfRecord::new_from_header(raw.header);
                rec.read_from_bytes(b, &raw.byte_order);
                match rec {
                    StdfRecord::MIR(mir) => {
                        meta.fields = mir_fields(&mir);
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
                        let fields = wir_fields(&wir);
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
                            fields,
                        });
                    }
                    StdfRecord::WRR(wrr) => {
                        if let Some(mut wafer) = current_wafer.take() {
                            if !wrr.wafer_id.is_empty() { wafer.wafer_id = wrr.wafer_id; }
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
                    _ => {}
                }
            }
        }
    }

    if let Some(wafer) = current_wafer.take() {
        if !wafer.results.is_empty() { wafers.push(wafer); }
    }

    let warnings = soft_bin_warning(soft_bin_fabricated);
    Ok(ParsedStdf { meta, wafers, test_defs, sites, warnings })
}

// ── Phased timing (bench feature only) ───────────────────────────────────────

#[cfg(feature = "bench")]
pub struct ParseTiming {
    /// Time spent in the RawDataIter loop excluding to_test_values calls (ms)
    pub p1_iter_ms: u128,
    /// Time spent in to_test_values HashMap construction across all PRR records (ms)
    pub p2_hashmap_ms: u128,
    pub die_count: usize,
    pub test_count: usize,
}

/// Identical to `parse_stdf_from_bytes` but instruments P1 (record iteration)
/// and P2 (per-die HashMap construction) separately.
/// Only available with `--features bench`; the normal hot path is untouched.
#[cfg(feature = "bench")]
pub fn parse_stdf_from_bytes_timed(bytes: &[u8]) -> Result<(ParsedStdf, ParseTiming), String> {
    use std::time::Instant;

    let mut reader = StdfReader::from(
        BufReader::new(Cursor::new(bytes)),
        &CompressType::Uncompressed,
    )
    .map_err(|e| e.to_string())?;

    let mut meta = LotMeta::default();
    let mut sites: Vec<SiteInfo> = Vec::new();
    let mut test_defs: HashMap<String, TestDef> = HashMap::new();
    let mut test_num_to_key: HashMap<u32, String> = HashMap::new();
    let mut limits_resolved: std::collections::HashSet<u32> = std::collections::HashSet::new();
    let mut wafers: Vec<WaferData> = Vec::new();
    let mut soft_bin_fabricated: usize = 0;
    let mut current_wafer: Option<WaferData> = None;
    let mut test_index = TestIndex::new();
    let mut site_accums: HashMap<(u8, u8), SiteAccum> = HashMap::new();
    let mut index_keys: Vec<String> = Vec::new();

    let mut p2_hashmap_ns: u128 = 0;
    let mut die_count: usize = 0;

    let loop_start = Instant::now();

    for raw in reader.get_rawdata_iter() {
        let raw = raw.map_err(|e| e.to_string())?;
        let (typ, sub) = (raw.header.typ, raw.header.sub);
        let b = &raw.raw_data;

        match (typ, sub) {
            (15, 10) => {
                let Some(ptr) = parse_ptr_fast(b) else { continue };
                let key = (ptr.head, ptr.site);
                if !test_num_to_key.contains_key(&ptr.test_num) {
                    let key_str = ptr.test_num.to_string();
                    let (test_txt, lo, hi, units) = ptr_defs_from_raw(b);
                    let resolved = lo.is_some() || hi.is_some() || ptr_limits_explicitly_absent(b);
                    if resolved { limits_resolved.insert(ptr.test_num); }
                    test_defs.insert(key_str.clone(), TestDef {
                        name: test_txt, test_type: "P".to_string(),
                        lo_limit: lo, hi_limit: hi, units,
                    });
                    let idx = test_index.get_or_insert(ptr.test_num);
                    while index_keys.len() <= idx { index_keys.push(String::new()); }
                    index_keys[idx] = key_str.clone();
                    test_num_to_key.insert(ptr.test_num, key_str);
                } else if !limits_resolved.contains(&ptr.test_num) {
                    let (_, lo, hi, units) = ptr_defs_from_raw(b);
                    if lo.is_some() || hi.is_some() || ptr_limits_explicitly_absent(b) {
                        limits_resolved.insert(ptr.test_num);
                        if let Some(key_str) = test_num_to_key.get(&ptr.test_num) {
                            if let Some(def) = test_defs.get_mut(key_str) {
                                if lo.is_some() { def.lo_limit = lo; }
                                if hi.is_some() { def.hi_limit = hi; }
                                if units.is_some() && def.units.is_none() { def.units = units; }
                            }
                        }
                    }
                }
                if let Some(accum) = site_accums.get_mut(&key) {
                    let idx = test_index.get_or_insert(ptr.test_num);
                    let value = if ptr.failed && ptr.result == 0.0 { f32::NAN } else { ptr.result };
                    accum.set(idx, value);
                }
            }
            (15, 20) => {
                let Some((test_num, head, site, failed)) = parse_ftr_fast(b) else { continue };
                let key = (head, site);
                if !test_num_to_key.contains_key(&test_num) {
                    let key_str = test_num.to_string();
                    let test_txt = ftr_test_txt_from_struct(b, &raw.byte_order);
                    test_defs.insert(key_str.clone(), TestDef {
                        name: test_txt, test_type: "F".to_string(),
                        lo_limit: None, hi_limit: None, units: None,
                    });
                    let idx = test_index.get_or_insert(test_num);
                    while index_keys.len() <= idx { index_keys.push(String::new()); }
                    index_keys[idx] = key_str.clone();
                    test_num_to_key.insert(test_num, key_str);
                }
                if let Some(accum) = site_accums.get_mut(&key) {
                    let idx = test_index.get_or_insert(test_num);
                    accum.set(idx, if failed { 0.0 } else { 1.0 });
                }
            }
            (5, 10) => {
                let Some((head, site)) = pir_head_site(b) else { continue };
                let key = (head, site);
                let cap = test_index.len().max(64);
                site_accums.entry(key).or_insert_with(|| SiteAccum::new(cap)).reset();
            }
            (5, 20) => {
                let Some(prr) = parse_prr(b) else { continue };
                if prr.x == SENTINEL_I2 || prr.y == SENTINEL_I2 {
                    site_accums.remove(&(prr.head, prr.site));
                    continue;
                }
                let key = (prr.head, prr.site);
                let t_hmap = Instant::now();
                let test_values = if let Some(accum) = site_accums.get(&key) {
                    accum.to_test_values(&test_index, &index_keys)
                } else {
                    HashMap::new()
                };
                p2_hashmap_ns += t_hmap.elapsed().as_nanos();
                die_count += 1;
                if prr.soft_bin == 65535 { soft_bin_fabricated += 1; }
                let die = DieResult {
                    x: prr.x as i32, y: prr.y as i32,
                    hbin: Some(prr.hard_bin as u32),
                    sbin: Some(if prr.soft_bin == 65535 { prr.hard_bin as u32 } else { prr.soft_bin as u32 }),
                    site_num: Some(prr.site as u32),
                    part_id: prr.part_id,
                    test_values,
                };
                if current_wafer.is_none() {
                    current_wafer = Some(WaferData {
                        wafer_id: format!("W{}", wafers.len() + 1),
                        results: Vec::new(), part_count: None, good_count: None, fail_count: None,
                    });
                }
                if let Some(ref mut wafer) = current_wafer { wafer.results.push(die); }
            }
            _ => {
                let mut rec = StdfRecord::new_from_header(raw.header);
                rec.read_from_bytes(b, &raw.byte_order);
                match rec {
                    StdfRecord::MIR(mir) => {
                        meta.fields = mir_fields(&mir);
                    }
                    StdfRecord::SDR(sdr) => {
                        for &site in &sdr.site_num {
                            sites.push(SiteInfo { head_num: sdr.head_num as u32, site_num: site as u32 });
                        }
                    }
                    StdfRecord::WIR(wir) => {
                        current_wafer = Some(WaferData {
                            wafer_id: if wir.wafer_id.is_empty() {
                                format!("W{}", wafers.len() + 1)
                            } else { wir.wafer_id },
                            results: Vec::new(), part_count: None, good_count: None, fail_count: None,
                        });
                    }
                    StdfRecord::WRR(wrr) => {
                        if let Some(mut wafer) = current_wafer.take() {
                            if !wrr.wafer_id.is_empty() { wafer.wafer_id = wrr.wafer_id; }
                            wafer.part_count = if wrr.part_cnt != SENTINEL_U4 { Some(wrr.part_cnt) } else { None };
                            wafer.good_count = if wrr.good_cnt != SENTINEL_U4 { Some(wrr.good_cnt) } else { None };
                            wafer.fail_count = if wrr.good_cnt != SENTINEL_U4 && wrr.part_cnt != SENTINEL_U4 {
                                Some(wrr.part_cnt.saturating_sub(wrr.good_cnt))
                            } else { None };
                            wafers.push(wafer);
                        }
                    }
                    _ => {}
                }
            }
        }
    }

    let loop_total_ms = loop_start.elapsed().as_millis();
    let p2_ms = p2_hashmap_ns / 1_000_000;

    if let Some(wafer) = current_wafer.take() {
        if !wafer.results.is_empty() { wafers.push(wafer); }
    }

    let timing = ParseTiming {
        p1_iter_ms: loop_total_ms.saturating_sub(p2_ms),
        p2_hashmap_ms: p2_ms,
        die_count,
        test_count: test_index.len(),
    };

    let warnings = soft_bin_warning(soft_bin_fabricated);
    Ok((ParsedStdf { meta, wafers, test_defs, sites, warnings }, timing))
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
        assert!(result.meta.get("lotId").is_some(), "expected lot_id");
        assert!(result.meta.get("partType").is_some(), "expected part_type");
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
        assert_eq!(gz.meta.get("lotId"), plain.meta.get("lotId"));
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

    // ── Panic-safety on truncated / malformed input ──────────────────────────
    // A corrupt or partial file must return Err, never panic. In WASM a panic
    // aborts the whole module, so these guard against a dead page.

    #[test]
    fn truncated_at_every_length_never_panics() {
        let full = std::fs::read(SINGLE_WAFER).unwrap();
        // Step through prefixes of the real file; every cut point exercises a
        // partially-read header or record body.
        let mut len = 0;
        while len <= full.len() {
            // Returns Ok or Err — both fine; the assertion is "did not panic".
            let _ = parse_stdf_from_bytes(&full[..len]);
            len += if len < 512 { 1 } else { 257 }; // dense early, sparse later
        }
    }

    #[test]
    fn empty_and_tiny_inputs_return_err() {
        assert!(parse_stdf_from_bytes(&[]).is_err());
        assert!(parse_stdf_from_bytes(&[0]).is_err());
        assert!(parse_stdf_from_bytes(&[0, 0, 0, 0]).is_err());
    }

    #[test]
    fn truncated_record_bodies_never_panic() {
        let full = std::fs::read(MULTI_WAFER).unwrap();
        // Lop off the trailing bytes of an otherwise-valid file so the final
        // record's body is shorter than its declared length.
        for cut in [1usize, 2, 3, 5, 7, 9, 11, 13] {
            if cut >= full.len() { continue; }
            let _ = parse_stdf_from_bytes(&full[..full.len() - cut]);
        }
    }

    #[test]
    fn test_names_scan_truncated_never_panics() {
        let full = std::fs::read(SINGLE_WAFER).unwrap();
        let mut len = 0;
        while len <= full.len() {
            let _ = parse_stdf_test_names(&full[..len]);
            len += if len < 256 { 1 } else { 251 };
        }
    }

    // Run with: cargo test --manifest-path packages/parsers/Cargo.toml --features bench -- --nocapture bench_parse_large
    #[cfg(feature = "bench")]
    #[test]
    fn bench_parse_large() {
        let path = "/tmp/large.stdf";
        let bytes = match std::fs::read(path) {
            Ok(b) => b,
            Err(_) => {
                eprintln!("SKIP: {path} not found — run scripts/generate_stdf_large.py first");
                return;
            }
        };
        let file_mb = bytes.len() as f64 / 1_048_576.0;

        // Warm run (populates OS page cache)
        let _ = parse_stdf_from_bytes_timed(&bytes).unwrap();

        // Measured run
        let (result, timing) = parse_stdf_from_bytes_timed(&bytes).unwrap();
        let total_ms = timing.p1_iter_ms + timing.p2_hashmap_ms;

        println!(
            "\n=== bench_parse_large ({file_mb:.0} MB) ===\n\
             wafers:         {wafers}\n\
             dies:           {dies}\n\
             tests:          {tests}\n\
             p1 iter:        {p1} ms\n\
             p2 hashmap:     {p2} ms  ({p2_pct:.0}% of total)\n\
             total:          {total} ms\n\
             throughput:     {tp:.0} MB/s",
            wafers   = result.wafers.len(),
            dies     = timing.die_count,
            tests    = timing.test_count,
            p1       = timing.p1_iter_ms,
            p2       = timing.p2_hashmap_ms,
            p2_pct   = timing.p2_hashmap_ms as f64 / total_ms.max(1) as f64 * 100.0,
            total    = total_ms,
            tp       = file_mb / (total_ms as f64 / 1000.0),
        );
    }
}
