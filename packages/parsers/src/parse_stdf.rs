use std::collections::HashMap;
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

// Read a sequence of Cn strings starting at `pos`, returning each in order. A
// truncated record yields empty strings for the missing trailing fields (Cn
// reader returns "" past end), so optional tail fields degrade gracefully.
struct CnSeq<'a> { b: &'a [u8], pos: usize }
impl<'a> CnSeq<'a> {
    fn new(b: &'a [u8], pos: usize) -> Self { Self { b, pos } }
    fn next(&mut self) -> String {
        let (s, p) = read_cn_str(self.b, self.pos);
        self.pos = p;
        s
    }
}

/// All non-empty lot-level fields from a MIR record body (STDF V4, 1·10).
/// Fixed prefix is 15 bytes: SETUP_T(U4) START_T(U4) STAT_NUM(U1) MODE_COD(C1)
/// RTST_COD(C1) PROT_COD(C1) BURN_TIM(U2) CMOD_COD(C1); then a run of Cn strings.
fn mir_fields(b: &[u8], o: ByteOrder) -> Vec<MetaField> {
    let mut f = Vec::new();
    // Timestamps → ISO 8601 (host truncates to date where it groups by date).
    push_field(&mut f, "setupT", read_u4(b, 0, o).and_then(epoch_to_iso));
    push_field(&mut f, "startT", read_u4(b, 4, o).and_then(epoch_to_iso));
    // Single-char code fields (STAT_NUM/MODE_COD/RTST_COD/PROT_COD/BURN_TIM/
    // CMOD_COD) are low-value and skipped; the Cn run begins at byte 15.
    let mut cn = CnSeq::new(b, 15);
    // Order matches the STDF V4 MIR Cn field sequence.
    push_field(&mut f, "lotId",      nonempty(cn.next())); // LOT_ID
    push_field(&mut f, "partType",   nonempty(cn.next())); // PART_TYP
    push_field(&mut f, "nodeName",   nonempty(cn.next())); // NODE_NAM
    push_field(&mut f, "testerType", nonempty(cn.next())); // TSTR_TYP
    push_field(&mut f, "jobName",    nonempty(cn.next())); // JOB_NAM
    push_field(&mut f, "jobRev",     nonempty(cn.next())); // JOB_REV
    push_field(&mut f, "sublotId",   nonempty(cn.next())); // SBLOT_ID
    push_field(&mut f, "operName",   nonempty(cn.next())); // OPER_NAM
    push_field(&mut f, "execType",   nonempty(cn.next())); // EXEC_TYP
    push_field(&mut f, "execVer",    nonempty(cn.next())); // EXEC_VER
    push_field(&mut f, "testCode",   nonempty(cn.next())); // TEST_COD
    push_field(&mut f, "testTemp",   nonempty(cn.next())); // TST_TEMP
    push_field(&mut f, "userText",   nonempty(cn.next())); // USER_TXT
    push_field(&mut f, "auxFile",    nonempty(cn.next())); // AUX_FILE
    push_field(&mut f, "packageType", nonempty(cn.next())); // PKG_TYP
    push_field(&mut f, "familyId",   nonempty(cn.next())); // FAMLY_ID
    push_field(&mut f, "dateCode",   nonempty(cn.next())); // DATE_COD
    push_field(&mut f, "facilityId", nonempty(cn.next())); // FACIL_ID
    push_field(&mut f, "floorId",    nonempty(cn.next())); // FLOOR_ID
    push_field(&mut f, "processId",  nonempty(cn.next())); // PROC_ID
    push_field(&mut f, "operFreq",   nonempty(cn.next())); // OPER_FRQ
    push_field(&mut f, "specName",   nonempty(cn.next())); // SPEC_NAM
    push_field(&mut f, "specVer",    nonempty(cn.next())); // SPEC_VER
    push_field(&mut f, "flowId",     nonempty(cn.next())); // FLOW_ID
    push_field(&mut f, "setupId",    nonempty(cn.next())); // SETUP_ID
    push_field(&mut f, "designRev",  nonempty(cn.next())); // DSGN_REV
    push_field(&mut f, "engId",      nonempty(cn.next())); // ENG_ID
    push_field(&mut f, "romCode",    nonempty(cn.next())); // ROM_COD
    push_field(&mut f, "serialNum",  nonempty(cn.next())); // SERL_NUM
    push_field(&mut f, "supervisorName", nonempty(cn.next())); // SUPR_NAM
    f
}

/// WIR record body (2·10): HEAD_NUM(U1) SITE_GRP(U1) START_T(U4) WAFER_ID(Cn).
struct WirData { wafer_id: String, fields: Vec<MetaField> }
fn decode_wir(b: &[u8], o: ByteOrder) -> WirData {
    let mut fields = Vec::new();
    push_field(&mut fields, "waferStartT", read_u4(b, 2, o).and_then(epoch_to_iso));
    let (wafer_id, _) = read_cn_str(b, 6);
    WirData { wafer_id, fields }
}

/// WRR record body (2·20): HEAD_NUM(U1) SITE_GRP(U1) FINISH_T(U4) PART_CNT(U4)
/// RTST_CNT(U4) ABRT_CNT(U4) GOOD_CNT(U4) FUNC_CNT(U4) WAFER_ID(Cn) FABWF_ID(Cn)
/// FRAME_ID(Cn) MASK_ID(Cn) USR_DESC(Cn) EXC_DESC(Cn).
struct WrrData { wafer_id: String, part_cnt: u32, good_cnt: u32, fields: Vec<MetaField> }
fn decode_wrr(b: &[u8], o: ByteOrder) -> WrrData {
    let part_cnt = read_u4(b, 6, o).unwrap_or(SENTINEL_U4);
    let good_cnt = read_u4(b, 18, o).unwrap_or(SENTINEL_U4);
    let mut cn = CnSeq::new(b, 26);
    let wafer_id = cn.next();           // WAFER_ID
    let fabwf_id = cn.next();           // FABWF_ID
    let frame_id = cn.next();           // FRAME_ID
    let mask_id  = cn.next();           // MASK_ID
    let usr_desc = cn.next();           // USR_DESC
    let exc_desc = cn.next();           // EXC_DESC
    let mut fields = Vec::new();
    push_field(&mut fields, "waferFinishT", read_u4(b, 2, o).and_then(epoch_to_iso));
    push_field(&mut fields, "fabWaferId", nonempty(fabwf_id));
    push_field(&mut fields, "frameId", nonempty(frame_id));
    push_field(&mut fields, "maskId",  nonempty(mask_id));
    push_field(&mut fields, "waferDescUser", nonempty(usr_desc));
    push_field(&mut fields, "waferDescExec", nonempty(exc_desc));
    WrrData { wafer_id, part_cnt, good_cnt, fields }
}

/// SDR record body (1·80): HEAD_NUM(U1) SITE_GRP(U1) SITE_CNT(U1) then
/// SITE_NUM array of SITE_CNT × U1, followed by descriptor Cn fields we ignore.
/// Returns (head_num, [site_num…]).
fn decode_sdr(b: &[u8]) -> (u32, Vec<u32>) {
    if b.len() < 3 { return (1, Vec::new()); }
    let head = b[0] as u32;
    let cnt = b[2] as usize;
    let mut sites = Vec::with_capacity(cnt);
    for i in 0..cnt {
        if let Some(&s) = b.get(3 + i) { sites.push(s as u32); }
    }
    (head, sites)
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

// ── Byte order ────────────────────────────────────────────────────────────────

/// STDF byte order, read from the FAR record's CPU_TYPE byte (1 = big-endian
/// legacy Sun/SPARC controllers; 2 = little-endian x86). Honoured per-file — a
/// Teradyne IG-XL floor can still emit either depending on its controller.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum ByteOrder {
    Little,
    Big,
}

// ── Raw byte helpers ──────────────────────────────────────────────────────────

// All readers are bounds-checked and return None on a short slice, so a
// truncated record can never panic (in WASM a panic aborts the whole module).
// Multi-byte integers/floats honour the file's byte order.
#[inline(always)]
fn read_u4(b: &[u8], pos: usize, o: ByteOrder) -> Option<u32> {
    let a: [u8; 4] = b.get(pos..pos + 4)?.try_into().ok()?;
    Some(match o { ByteOrder::Little => u32::from_le_bytes(a), ByteOrder::Big => u32::from_be_bytes(a) })
}

#[inline(always)]
fn read_u2(b: &[u8], pos: usize, o: ByteOrder) -> Option<u16> {
    let a: [u8; 2] = b.get(pos..pos + 2)?.try_into().ok()?;
    Some(match o { ByteOrder::Little => u16::from_le_bytes(a), ByteOrder::Big => u16::from_be_bytes(a) })
}

#[inline(always)]
fn read_i2(b: &[u8], pos: usize, o: ByteOrder) -> Option<i16> {
    let a: [u8; 2] = b.get(pos..pos + 2)?.try_into().ok()?;
    Some(match o { ByteOrder::Little => i16::from_le_bytes(a), ByteOrder::Big => i16::from_be_bytes(a) })
}

#[inline(always)]
fn read_f32(b: &[u8], pos: usize, o: ByteOrder) -> Option<f32> {
    let bits = read_u4(b, pos, o)?;
    Some(f32::from_bits(bits))
}

// ── Record framing ────────────────────────────────────────────────────────────

/// One STDF record: type/sub codes and a borrowed view of its body.
struct RawRecord<'a> {
    typ: u8,
    sub: u8,
    body: &'a [u8],
}

/// Borrowing iterator over STDF records in `bytes`. Header is
/// `[REC_LEN: U2][REC_TYP: U1][REC_SUB: U1]` followed by REC_LEN body bytes;
/// REC_LEN is read in the file's byte order. Stops at the first malformed/short
/// header (matching how a truncated file tails off). Pure borrow — no per-record
/// allocation, the body is a slice into the original buffer.
struct RecordIter<'a> {
    bytes: &'a [u8],
    pos: usize,
    order: ByteOrder,
}

impl<'a> RecordIter<'a> {
    fn next_record(&mut self) -> Option<RawRecord<'a>> {
        // Need at least a 4-byte header.
        if self.pos + 4 > self.bytes.len() { return None; }
        let len = read_u2(self.bytes, self.pos, self.order)? as usize;
        let typ = self.bytes[self.pos + 2];
        let sub = self.bytes[self.pos + 3];
        let body_start = self.pos + 4;
        let body_end = body_start + len;
        if body_end > self.bytes.len() { return None; } // truncated final record
        let body = &self.bytes[body_start..body_end];
        self.pos = body_end;
        Some(RawRecord { typ, sub, body })
    }
}

/// Read the FAR record to determine byte order and validate it's STDF V4. FAR is
/// always the first record: header `[REC_LEN][0][10]`, body `[CPU_TYPE][STDF_VER]`.
/// CPU_TYPE and the header type/sub are single bytes (byte-order-independent), so
/// we can read CPU_TYPE before knowing the order. CPU_TYPE: 1 = big-endian (legacy
/// Sun/SPARC), 2 = little-endian (x86). Other values are rejected.
fn detect_byte_order(bytes: &[u8]) -> Result<ByteOrder, String> {
    // FAR header is 4 bytes, body is CPU_TYPE(1) + STDF_VER(1).
    if bytes.len() < 6 {
        return Err("file too short to contain a FAR record".to_string());
    }
    if bytes[2] != 0 || bytes[3] != 10 {
        return Err("first record is not a FAR — not a valid STDF file".to_string());
    }
    let cpu_type = bytes[4];
    match cpu_type {
        1 => Ok(ByteOrder::Big),
        2 => Ok(ByteOrder::Little),
        other => Err(format!("unsupported STDF CPU_TYPE {other} (expected 1=big-endian or 2=little-endian)")),
    }
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

fn parse_prr(b: &[u8], o: ByteOrder) -> Option<PrrFields> {
    if b.len() < 14 { return None; }
    let head     = b[0];
    let site     = b[1];
    // b[2] = part_flg, b[3..5] = num_test
    let hard_bin = read_u2(b, 5, o)?;
    let soft_bin = read_u2(b, 7, o).unwrap_or(hard_bin);
    let x        = read_i2(b, 9, o).unwrap_or(SENTINEL_I2);
    let y        = read_i2(b, 11, o).unwrap_or(SENTINEL_I2);
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
fn parse_ptr_fast(b: &[u8], o: ByteOrder) -> Option<PtrFast> {
    if b.len() < 12 { return None; }
    Some(PtrFast {
        test_num: read_u4(b, 0, o)?,
        head:     b[4],
        site:     b[5],
        failed:   b[6] & 0x80 != 0,
        result:   read_f32(b, 8, o)?,
    })
}

// Extract test_txt and optional lo/hi limits from a PTR raw record.
// Called only on the first occurrence of each test_num.
fn ptr_defs_from_raw(b: &[u8], o: ByteOrder) -> (String, Option<f64>, Option<f64>, Option<String>) {
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
        read_f32(b, pos, o).map(|v| v as f64)
    } else {
        None
    };
    let pos = pos + 4;
    let hi = if opt_flag & 0x80 == 0 {
        read_f32(b, pos, o).map(|v| v as f64)
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
fn parse_ftr_fast(b: &[u8], o: ByteOrder) -> Option<(u32, u8, u8, bool)> {
    if b.len() < 7 { return None; }
    let test_num = read_u4(b, 0, o)?;
    let head = b[4];
    let site = b[5];
    let failed = b[6] & 0x80 != 0;
    Some((test_num, head, site, failed))
}

// FTR TEST_TXT is deep in the record after many fixed + variable-length fields.
// Layout (STDF V4 FTR, 1,20): TEST_NUM(U4) HEAD(U1) SITE(U1) TEST_FLG(B1)
// OPT_FLAG(B1), then five U4 counts (CYCL_CNT, REL_VADR, REPT_CNT, NUM_FAIL,
// XFAIL_AD i4, YFAIL_AD i4), VECT_OFF(i2), then four U2 array counts
// (RTN_ICNT, PGM_ICNT) which precede variable-length arrays… rather than decode
// all of that, we scan to TEST_TXT by walking the documented field sequence. In
// practice TEST_TXT only matters on the first occurrence of each test number, so
// this is cold. We bound-check every step and return "" if the record is short.
fn ftr_test_txt_from_raw(b: &[u8], o: ByteOrder) -> String {
    // Fixed head: TEST_NUM(4) HEAD(1) SITE(1) TEST_FLG(1) OPT_FLAG(1) = 8 bytes.
    if b.len() < 8 { return String::new(); }
    let opt_flag = b[7];
    let mut pos = 8usize;
    // Five U4 + two I4 conditional on OPT_FLAG, per the spec these are always
    // present as U4/I4 (15 bytes of fixed numerics): CYCL_CNT, REL_VADR,
    // REPT_CNT, NUM_FAIL, XFAIL_AD, YFAIL_AD, VECT_OFF.
    // CYCL_CNT U4, REL_VADR U4, REPT_CNT U4, NUM_FAIL U4 (4×4=16), XFAIL_AD I4,
    // YFAIL_AD I4 (2×4=8), VECT_OFF I2 (2) = 26 bytes.
    pos += 26;
    // RTN_ICNT (U2), PGM_ICNT (U2).
    let rtn_icnt = read_u2(b, pos, o).unwrap_or(0) as usize; pos += 2;
    let pgm_icnt = read_u2(b, pos, o).unwrap_or(0) as usize; pos += 2;
    // RTN_INDX: rtn_icnt × U2.
    pos += rtn_icnt * 2;
    // RTN_STAT: rtn_icnt nibbles → ceil(rtn_icnt/2) bytes.
    pos += rtn_icnt.div_ceil(2);
    // PGM_INDX: pgm_icnt × U2.
    pos += pgm_icnt * 2;
    // PGM_STAT: pgm_icnt nibbles → ceil(pgm_icnt/2) bytes.
    pos += pgm_icnt.div_ceil(2);
    // FAIL_PIN: Dn (bit-encoded) → U2 bit count + ceil(bits/8) bytes.
    if let Some(bits) = read_u2(b, pos, o) { pos += 2 + (bits as usize).div_ceil(8); } else { return String::new(); }
    // VECT_NAM(Cn), TIME_SET(Cn), OP_CODE(Cn): skip three Cn strings.
    let (_, p) = read_cn_str(b, pos); pos = p;
    let (_, p) = read_cn_str(b, pos); pos = p;
    let (_, p) = read_cn_str(b, pos); pos = p;
    // TEST_TXT(Cn).
    let _ = opt_flag; // opt_flag governs whether some counts are valid, not presence
    let (txt, _) = read_cn_str(b, pos);
    txt
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
    let order = detect_byte_order(bytes)?;
    let mut iter = RecordIter { bytes, pos: 0, order };

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

    while let Some(raw) = iter.next_record() {
        let (typ, sub) = (raw.typ, raw.sub);
        let b = raw.body;

        match (typ, sub) {
            // ── PTR ──────────────────────────────────────────────────────────
            (15, 10) => {
                let Some(ptr) = parse_ptr_fast(b, order) else { continue };
                let key = (ptr.head, ptr.site);

                // Register test def on first occurrence; update limits until resolved
                if !test_num_to_key.contains_key(&ptr.test_num) {
                    let key_str = ptr.test_num.to_string();
                    let (test_txt, lo, hi, units) = ptr_defs_from_raw(b, order);
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
                    let (_, lo, hi, units) = ptr_defs_from_raw(b, order);
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
                let Some((test_num, head, site, failed)) = parse_ftr_fast(b, order) else { continue };
                let key = (head, site);

                if !test_num_to_key.contains_key(&test_num) {
                    let key_str = test_num.to_string();
                    let test_txt = ftr_test_txt_from_raw(b, order);
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
                let Some(prr) = parse_prr(b, order) else { continue };
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

            // ── Structural records (cold: a handful per file) ─────────────
            (1, 10) => { // MIR
                meta.fields = mir_fields(b, order);
            }
            (1, 80) => { // SDR
                let (head, site_nums) = decode_sdr(b);
                for site in site_nums {
                    sites.push(SiteInfo { head_num: head, site_num: site });
                }
            }
            (2, 10) => { // WIR
                let wir = decode_wir(b, order);
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
                    fields: wir.fields,
                });
            }
            (2, 20) => { // WRR
                if let Some(mut wafer) = current_wafer.take() {
                    let wrr = decode_wrr(b, order);
                    wafer.fields.extend(wrr.fields);
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
    let order = detect_byte_order(bytes)?;
    let mut iter = RecordIter { bytes, pos: 0, order };

    let mut test_defs: HashMap<String, TestDef> = HashMap::new();
    let mut test_num_to_key: HashMap<u32, String> = HashMap::new();
    let mut limits_resolved: std::collections::HashSet<u32> = std::collections::HashSet::new();
    let mut pir_count: u32 = 0;

    while let Some(raw) = iter.next_record() {
        let b = raw.body;
        match (raw.typ, raw.sub) {
            (5, 10) => { pir_count += 1; }
            (15, 10) => {
                let Some(test_num) = read_u4(b, 0, order) else { continue; };
                if !test_num_to_key.contains_key(&test_num) {
                    let key_str = test_num.to_string();
                    let (test_txt, lo, hi, units) = ptr_defs_from_raw(b, order);
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
                    let (_, lo, hi, units) = ptr_defs_from_raw(b, order);
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
                let Some(test_num) = read_u4(b, 0, order) else { continue; };
                if !test_num_to_key.contains_key(&test_num) {
                    let key_str = test_num.to_string();
                    let test_txt = ftr_test_txt_from_raw(b, order);
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
    let order = detect_byte_order(bytes)?;
    let mut iter = RecordIter { bytes, pos: 0, order };

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

    while let Some(raw) = iter.next_record() {
        let (typ, sub) = (raw.typ, raw.sub);
        let b = raw.body;

        match (typ, sub) {
            (15, 10) => {
                let Some(ptr) = parse_ptr_fast(b, order) else { continue };
                let key = (ptr.head, ptr.site);

                // Always register/update test def regardless of selection
                if !test_num_to_key.contains_key(&ptr.test_num) {
                    let key_str = ptr.test_num.to_string();
                    let (test_txt, lo, hi, units) = ptr_defs_from_raw(b, order);
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
                    let (_, lo, hi, units) = ptr_defs_from_raw(b, order);
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
                let Some((test_num, head, site, failed)) = parse_ftr_fast(b, order) else { continue };
                let key = (head, site);

                if !test_num_to_key.contains_key(&test_num) {
                    let key_str = test_num.to_string();
                    let test_txt = ftr_test_txt_from_raw(b, order);
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
                let Some(prr) = parse_prr(b, order) else { continue };
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

            (1, 10) => { // MIR
                meta.fields = mir_fields(b, order);
            }
            (1, 80) => { // SDR
                let (head, site_nums) = decode_sdr(b);
                for site in site_nums {
                    sites.push(SiteInfo { head_num: head, site_num: site });
                }
            }
            (2, 10) => { // WIR
                let wir = decode_wir(b, order);
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
                    fields: wir.fields,
                });
            }
            (2, 20) => { // WRR
                if let Some(mut wafer) = current_wafer.take() {
                    let wrr = decode_wrr(b, order);
                    wafer.fields.extend(wrr.fields);
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

    let order = detect_byte_order(bytes)?;
    let mut iter = RecordIter { bytes, pos: 0, order };

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

    while let Some(raw) = iter.next_record() {
        let (typ, sub) = (raw.typ, raw.sub);
        let b = raw.body;

        match (typ, sub) {
            (15, 10) => {
                let Some(ptr) = parse_ptr_fast(b, order) else { continue };
                let key = (ptr.head, ptr.site);
                if !test_num_to_key.contains_key(&ptr.test_num) {
                    let key_str = ptr.test_num.to_string();
                    let (test_txt, lo, hi, units) = ptr_defs_from_raw(b, order);
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
                    let (_, lo, hi, units) = ptr_defs_from_raw(b, order);
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
                let Some((test_num, head, site, failed)) = parse_ftr_fast(b, order) else { continue };
                let key = (head, site);
                if !test_num_to_key.contains_key(&test_num) {
                    let key_str = test_num.to_string();
                    let test_txt = ftr_test_txt_from_raw(b, order);
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
                let Some(prr) = parse_prr(b, order) else { continue };
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
                        fields: Vec::new(),
                    });
                }
                if let Some(ref mut wafer) = current_wafer { wafer.results.push(die); }
            }
            (1, 10) => { meta.fields = mir_fields(b, order); }
            (1, 80) => {
                let (head, site_nums) = decode_sdr(b);
                for site in site_nums { sites.push(SiteInfo { head_num: head, site_num: site }); }
            }
            (2, 10) => {
                let wir = decode_wir(b, order);
                current_wafer = Some(WaferData {
                    wafer_id: if wir.wafer_id.is_empty() { format!("W{}", wafers.len() + 1) } else { wir.wafer_id },
                    results: Vec::new(), part_count: None, good_count: None, fail_count: None,
                    fields: Vec::new(),
                });
            }
            (2, 20) => {
                if let Some(mut wafer) = current_wafer.take() {
                    let wrr = decode_wrr(b, order);
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

    // ── Byte-order (big-endian) support ────────────────────────────────────────
    // Build a minimal STDF in-memory in a given byte order and assert LE and BE
    // produce identical parse output. A Teradyne/legacy big-endian file must read
    // the same as the little-endian equivalent.
    mod byte_order {
        use super::super::*;

        struct Builder { order: ByteOrder, buf: Vec<u8> }
        impl Builder {
            fn new(order: ByteOrder) -> Self { Self { order, buf: Vec::new() } }
            fn u4(&self, v: u32) -> [u8; 4] {
                match self.order { ByteOrder::Little => v.to_le_bytes(), ByteOrder::Big => v.to_be_bytes() }
            }
            fn u2(&self, v: u16) -> [u8; 2] {
                match self.order { ByteOrder::Little => v.to_le_bytes(), ByteOrder::Big => v.to_be_bytes() }
            }
            fn i2(&self, v: i16) -> [u8; 2] {
                match self.order { ByteOrder::Little => v.to_le_bytes(), ByteOrder::Big => v.to_be_bytes() }
            }
            fn f32(&self, v: f32) -> [u8; 4] { self.u4(v.to_bits()) }
            fn cn(&self, s: &str) -> Vec<u8> {
                let mut v = vec![s.len() as u8];
                v.extend_from_slice(s.as_bytes());
                v
            }
            // Append a record: header [REC_LEN u2][typ u1][sub u1] + body.
            fn rec(&mut self, typ: u8, sub: u8, body: &[u8]) {
                self.buf.extend_from_slice(&self.u2(body.len() as u16));
                self.buf.push(typ);
                self.buf.push(sub);
                self.buf.extend_from_slice(body);
            }
        }

        fn build(order: ByteOrder) -> Vec<u8> {
            let b = Builder::new(order);
            let cpu = match order { ByteOrder::Little => 2u8, ByteOrder::Big => 1u8 };
            let mut out = Builder::new(order);
            // FAR: CPU_TYPE, STDF_VER
            out.rec(0, 10, &[cpu, 4]);
            // MIR: 15-byte fixed prefix then Cn run. We only need LOT_ID populated.
            let mut mir = Vec::new();
            mir.extend_from_slice(&b.u4(0));   // SETUP_T
            mir.extend_from_slice(&b.u4(0));   // START_T
            mir.push(1);                        // STAT_NUM
            mir.extend_from_slice(b" \0\0");   // MODE/RTST/PROT C1
            mir.extend_from_slice(&b.u2(0));   // BURN_TIM
            mir.push(b' ');                     // CMOD_COD C1
            mir.extend_from_slice(&b.cn("LOT-BE"));   // LOT_ID
            mir.extend_from_slice(&b.cn("WIDGET"));   // PART_TYP
            out.rec(1, 10, &mir);
            // SDR: head=1, grp=1, cnt=2, sites [1,2]
            out.rec(1, 80, &[1, 1, 2, 1, 2]);
            // WIR: head, grp, START_T u4, WAFER_ID
            let mut wir = vec![1, 0];
            wir.extend_from_slice(&b.u4(0));
            wir.extend_from_slice(&b.cn("W01"));
            out.rec(2, 10, &wir);
            // PIR head=1 site=1
            out.rec(5, 10, &[1, 1]);
            // PTR: test_num u4, head, site, test_flg, parm_flg, result f32, then test_txt Cn
            let mut ptr = Vec::new();
            ptr.extend_from_slice(&b.u4(1000));
            ptr.extend_from_slice(&[1, 1, 0, 0]);
            ptr.extend_from_slice(&b.f32(1.25));
            ptr.extend_from_slice(&b.cn("VDD"));
            out.rec(15, 10, &ptr);
            // PRR: head, site, part_flg, num_test u2, hard_bin u2, soft_bin u2, x i2, y i2, test_t u4, part_id Cn
            let mut prr = vec![1, 1, 0];
            prr.extend_from_slice(&b.u2(1));   // num_test
            prr.extend_from_slice(&b.u2(1));   // hard_bin
            prr.extend_from_slice(&b.u2(1));   // soft_bin
            prr.extend_from_slice(&b.i2(3));   // x
            prr.extend_from_slice(&b.i2(7));   // y
            prr.extend_from_slice(&b.u4(0));   // test_t
            prr.extend_from_slice(&b.cn("1")); // part_id
            out.rec(5, 20, &prr);
            // WRR: head, grp, FINISH_T u4, PART_CNT u4, RTST u4, ABRT u4, GOOD_CNT u4, FUNC u4, WAFER_ID Cn
            let mut wrr = vec![1, 0];
            wrr.extend_from_slice(&b.u4(0));   // finish_t
            wrr.extend_from_slice(&b.u4(1));   // part_cnt
            wrr.extend_from_slice(&b.u4(0));   // rtst
            wrr.extend_from_slice(&b.u4(0));   // abrt
            wrr.extend_from_slice(&b.u4(1));   // good_cnt
            wrr.extend_from_slice(&b.u4(0));   // func
            wrr.extend_from_slice(&b.cn("W01"));
            out.rec(2, 20, &wrr);
            out.buf
        }

        #[test]
        fn le_and_be_parse_identically() {
            let le = parse_stdf_from_bytes(&build(ByteOrder::Little)).unwrap();
            let be = parse_stdf_from_bytes(&build(ByteOrder::Big)).unwrap();

            // Metadata
            assert_eq!(le.meta.get("lotId"), Some("LOT-BE"));
            assert_eq!(be.meta.get("lotId"), Some("LOT-BE"));
            assert_eq!(le.meta.get("partType"), be.meta.get("partType"));
            // Sites from SDR
            assert_eq!(le.sites.len(), 2);
            assert_eq!(be.sites.iter().map(|s| s.site_num).collect::<Vec<_>>(),
                       le.sites.iter().map(|s| s.site_num).collect::<Vec<_>>());
            // Wafer + die
            assert_eq!(le.wafers.len(), 1);
            assert_eq!(be.wafers.len(), 1);
            let ld = &le.wafers[0].results[0];
            let bd = &be.wafers[0].results[0];
            assert_eq!((ld.x, ld.y, ld.hbin, ld.sbin), (3, 7, Some(1), Some(1)));
            assert_eq!((bd.x, bd.y, bd.hbin, bd.sbin), (3, 7, Some(1), Some(1)));
            // Test value (the f32 result — the field most sensitive to byte order)
            assert_eq!(ld.test_values.get("1000"), Some(&1.25));
            assert_eq!(bd.test_values.get("1000"), Some(&1.25));
            assert_eq!(le.test_defs.get("1000").map(|d| d.name.as_str()), Some("VDD"));
            assert_eq!(be.test_defs.get("1000").map(|d| d.name.as_str()), Some("VDD"));
        }

        #[test]
        fn rejects_unknown_cpu_type() {
            // CPU_TYPE 9 is neither big- nor little-endian.
            let mut bytes = build(ByteOrder::Little);
            bytes[4] = 9;
            assert!(parse_stdf_from_bytes(&bytes).is_err());
        }

        #[test]
        fn rejects_non_far_first_record() {
            let mut bytes = build(ByteOrder::Little);
            bytes[2] = 1; // change first record type away from FAR (0)
            assert!(parse_stdf_from_bytes(&bytes).is_err());
        }
    }
}
