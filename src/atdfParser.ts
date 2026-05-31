import type { DieResult } from '@paulrobins/wafermap';
import type { ParsedFile, WaferData, TestDef, LotMeta } from './types';

// ── ATDF record field positions ───────────────────────────────────────────────
// Fields are positional, pipe-delimited after the record name + colon.
// Optional trailing fields may be absent — always index with ?. ?? ''.

const MIR_FIELDS  = ['LOT_ID','PART_TYP','JOB_NAM','NODE_NAM','TSTR_TYP','TSTR_SN','SUPR_NAM','JOB_REV','EXEC_TYP','EXEC_VER','TEST_COD','TST_TEMP','USER_TXT','AUX_FILE','PKG_TYP','FAMLY_ID','DATE_COD','FACIL_ID','FLOOR_ID','PROC_ID','OPER_FRQ','SPEC_NAM','SPEC_VER','FLOW_ID','SETUP_ID','DSGN_REV','ENG_ID','ROM_COD','SERL_NUM','OPER_NAM','SBLOT_ID','SETUP_T','START_T','STAT_NUM','MODE_COD','RTST_COD','PROT_COD','BURN_TIM'];
const WIR_FIELDS  = ['HEAD_NUM','START_T','SITE_GRP','WAFER_ID'];
const WRR_FIELDS  = ['HEAD_NUM','FINISH_T','PART_CNT','WAFER_ID','SITE_GRP','ABRT_CNT','GOOD_CNT','FUNC_CNT','WAFER_ID2','FABWF_ID','FRAME_ID','MASK_ID','USR_DESC','EXC_DESC'];
const PIR_FIELDS  = ['HEAD_NUM','SITE_NUM'];
const PRR_FIELDS  = ['HEAD_NUM','SITE_NUM','PART_ID','NUM_TEST','Pass/Fail','HARD_BIN','SOFT_BIN','X_COORD','Y_COORD','RetestCode','AbortCode','TEST_T','PART_TXT','PART_FIX'];
const PTR_FIELDS  = ['TEST_NUM','HEAD_NUM','SITE_NUM','RESULT','Pass/Fail','AlarmFlags','TEST_TXT','ALARM_ID','LimitCompare','UNITS','LO_LIMIT','HI_LIMIT','C_RESFMT','C_LLMFMT','C_HLMFMT','LO_SPEC','HI_SPEC','RES_SCAL','LLM_SCAL','HLM_SCAL'];
const FTR_FIELDS  = ['TEST_NUM','HEAD_NUM','SITE_NUM','Pass/Fail'];

function fieldMap(names: string[], values: string[]): Record<string, string> {
  const m: Record<string, string> = {};
  names.forEach((n, i) => { m[n] = values[i] ?? ''; });
  return m;
}

function str(v: string | undefined): string { return (v ?? '').trim(); }
function int(v: string | undefined): number { return parseInt(str(v), 10); }
function flt(v: string | undefined): number { return parseFloat(str(v)); }
function nonempty(v: string): string | undefined { return v.trim() || undefined; }

// ── Main parser ───────────────────────────────────────────────────────────────

export function parseAtdf(text: string, fileName: string): ParsedFile {
  // Join continuation lines (lines starting with space belong to the previous record)
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const records: string[] = [];
  for (const line of lines) {
    if (line.startsWith(' ') && records.length > 0) {
      records[records.length - 1] += line.trimStart();
    } else if (line.trim()) {
      records.push(line);
    }
  }

  // Detect delimiter from FAR record: FAR:A<delim>...
  let delim = '|';
  const far = records.find(r => r.startsWith('FAR:'));
  if (far && far.length > 5) delim = far[5];

  const meta: LotMeta = {};
  const testDefs: Record<string, TestDef> = {};
  const wafers: WaferData[] = [];

  let currentWafer: WaferData | null = null;
  // pending test values per (head, site) — accumulated between PIR and PRR
  const pendingValues = new Map<string, Record<string, number>>();
  const pendingSite = new Map<string, number>();

  for (const rec of records) {
    const colon = rec.indexOf(':');
    if (colon < 0) continue;
    const name = rec.slice(0, colon);
    const fields = rec.slice(colon + 1).split(delim);

    switch (name) {
      case 'MIR': {
        const f = fieldMap(MIR_FIELDS, fields);
        meta.lotId      = nonempty(str(f['LOT_ID']));
        meta.partType   = nonempty(str(f['PART_TYP']));
        meta.jobName    = nonempty(str(f['JOB_NAM']));
        meta.nodeName   = nonempty(str(f['NODE_NAM']));
        meta.testerType = nonempty(str(f['TSTR_TYP']));
        meta.sublotId   = nonempty(str(f['SBLOT_ID']));
        break;
      }

      case 'WIR': {
        const f = fieldMap(WIR_FIELDS, fields);
        const waferId = str(f['WAFER_ID']) || `W${wafers.length + 1}`;
        currentWafer = { waferId, results: [] };
        break;
      }

      case 'WRR': {
        const f = fieldMap(WRR_FIELDS, fields);
        if (currentWafer) {
          const waferId = str(f['WAFER_ID']) || currentWafer.waferId;
          const partCnt = int(f['PART_CNT']);
          const goodCnt = int(f['GOOD_CNT']);
          wafers.push({
            ...currentWafer,
            waferId,
            partCount: isNaN(partCnt) ? undefined : partCnt,
            goodCount: isNaN(goodCnt) ? undefined : goodCnt,
            failCount: (!isNaN(partCnt) && !isNaN(goodCnt)) ? partCnt - goodCnt : undefined,
          });
          currentWafer = null;
        }
        break;
      }

      case 'PIR': {
        const f = fieldMap(PIR_FIELDS, fields);
        const key = `${f['HEAD_NUM']},${f['SITE_NUM']}`;
        pendingSite.set(key, int(f['SITE_NUM']));
        pendingValues.set(key, {});
        break;
      }

      case 'PTR': {
        const f = fieldMap(PTR_FIELDS, fields);
        const testNum = str(f['TEST_NUM']);
        const key = `${f['HEAD_NUM']},${f['SITE_NUM']}`;

        // Capture test def from first PTR for this test number that has limits
        if (!testDefs[testNum]) {
          const lo = flt(f['LO_LIMIT']);
          const hi = flt(f['HI_LIMIT']);
          testDefs[testNum] = {
            name: str(f['TEST_TXT']) || testNum,
            testType: 'P',
            loLimit:  isNaN(lo) ? undefined : lo,
            hiLimit:  isNaN(hi) ? undefined : hi,
            units:    nonempty(str(f['UNITS'])),
          };
        }

        const result = flt(f['RESULT']);
        if (!isNaN(result)) {
          const vals = pendingValues.get(key);
          if (vals && testNum) vals[testNum] = result;
        }
        break;
      }

      case 'FTR': {
        const f = fieldMap(FTR_FIELDS, fields);
        const testNum = str(f['TEST_NUM']);
        const key = `${f['HEAD_NUM']},${f['SITE_NUM']}`;

        if (!testDefs[testNum]) {
          testDefs[testNum] = { name: testNum, testType: 'F' };
        }

        // Pass/Fail field: 'P' = pass, anything else = fail
        const passed = str(f['Pass/Fail']).toUpperCase() === 'P';
        const vals = pendingValues.get(key);
        if (vals && testNum) vals[testNum] = passed ? 1 : 0;
        break;
      }

      case 'PRR': {
        const f = fieldMap(PRR_FIELDS, fields);
        const x = int(f['X_COORD']);
        const y = int(f['Y_COORD']);
        if (isNaN(x) || isNaN(y)) break;

        const key = `${f['HEAD_NUM']},${f['SITE_NUM']}`;
        const siteNum = pendingSite.get(key);
        const testValues = pendingValues.get(key) ?? {};
        pendingSite.delete(key);
        pendingValues.delete(key);

        const hbin = int(f['HARD_BIN']);
        const sbin = int(f['SOFT_BIN']);
        const partId = parseInt(str(f['PART_ID']), 10);

        const die: DieResult = {
          x, y,
          hbin: isNaN(hbin) ? 1 : hbin,
          ...(isNaN(sbin) ? {} : { sbin }),
          ...(siteNum != null ? { siteNum } : {}),
          ...(!isNaN(partId) ? { partId } : {}),
          ...(Object.keys(testValues).length ? { testValues } : {}),
        };

        if (!currentWafer) {
          currentWafer = { waferId: `W${wafers.length + 1}`, results: [] };
        }
        currentWafer.results.push(die);
        break;
      }
    }
  }

  // Flush wafer if file ends without WRR
  if (currentWafer?.results.length) {
    wafers.push(currentWafer);
  }

  return { fileName, meta, wafers, testDefs };
}
