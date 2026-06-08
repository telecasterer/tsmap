#!/usr/bin/env python3
"""Generate a synthetic STDF V4 file for testing the tsmap parser.

Produces: 3 wafers, ~200 dies each, 4-site parallel test,
3 parametric tests (PTR) + 1 functional test (FTR).
"""

import struct
import math
import random
import sys
from pathlib import Path

random.seed(42)

# ── STDF record helpers ───────────────────────────────────────────────────────

def cn(s: str) -> bytes:
    """STDF Cn: 1-byte length prefix + ASCII."""
    b = s.encode('ascii')
    return bytes([len(b)]) + b

def u1(v: int) -> bytes: return struct.pack('B', v & 0xFF)
def u2(v: int) -> bytes: return struct.pack('<H', v & 0xFFFF)
def u4(v: int) -> bytes: return struct.pack('<I', v & 0xFFFFFFFF)
def i2(v: int) -> bytes: return struct.pack('<h', v)
def r4(v: float) -> bytes: return struct.pack('<f', v)
def b1(v: int) -> bytes: return bytes([v & 0xFF])
def c1(c: str) -> bytes: return c.encode('ascii')[:1]

def record(rec_typ: int, rec_sub: int, body: bytes) -> bytes:
    length = len(body)
    header = struct.pack('<HBB', length, rec_typ, rec_sub)
    return header + body

# Record type/sub codes (STDF V4)
FAR  = (0,  10)
MIR  = (1,  10)
SDR  = (1,  80)
WIR  = (2,  10)
WRR  = (2,  20)
PIR  = (5,  10)
PRR  = (5,  20)
PTR  = (15, 10)
FTR  = (15, 20)

def far() -> bytes:
    body = u1(2) + u1(4)   # CPU_TYPE=2 (little-endian), STDF_VER=4
    return record(*FAR, body)

def mir(lot_id: str, part_typ: str, job_nam: str, tstr_typ: str, node_nam: str) -> bytes:
    body = (
        u4(0) + u4(0) +      # setup_t, start_t
        u1(1) +              # stat_num
        c1('P') +            # mode_cod
        c1(' ') +            # rtst_cod
        c1(' ') +            # prot_cod
        u2(0xFFFF) +         # burn_tim
        c1(' ') +            # cmod_cod
        cn(lot_id) +
        cn(part_typ) +
        cn(node_nam) +
        cn(tstr_typ) +
        cn(job_nam) +
        cn('1.0') +          # job_rev
        cn('') +             # sblot_id
        cn('') +             # oper_nam
        cn('') +             # exec_typ
        cn('') +             # exec_ver
        cn('') +             # test_cod
        cn('25C') +          # tst_temp
        cn('') +             # user_txt
        cn('') +             # aux_file
        cn('') +             # pkg_typ
        cn('') +             # famly_id
        cn('') +             # date_cod
        cn('') +             # facil_id
        cn('') +             # floor_id
        cn('') +             # proc_id
        cn('') +             # oper_frq
        cn('') +             # spec_nam
        cn('') +             # spec_ver
        cn('') +             # flow_id
        cn('') +             # setup_id
        cn('') +             # dsgn_rev
        cn('') +             # eng_id
        cn('') +             # rom_cod
        cn('') +             # serl_num
        cn('')               # supr_nam
    )
    return record(*MIR, body)

def sdr(head: int, site_grp: int, sites: list[int]) -> bytes:
    body = (
        u1(head) +
        u1(site_grp) +
        u1(len(sites)) +
        b''.join(u1(s) for s in sites) +
        cn('') +   # hand_typ
        cn('') +   # hand_id
        cn('') +   # card_typ
        cn('') +   # card_id
        cn('') +   # load_typ
        cn('') +   # load_id
        cn('') +   # dib_typ
        cn('') +   # dib_id
        cn('') +   # cabl_typ
        cn('') +   # cabl_id
        cn('') +   # cont_typ
        cn('') +   # cont_id
        cn('') +   # lasr_typ
        cn('') +   # lasr_id
        cn('') +   # extr_typ
        cn('')     # extr_id
    )
    return record(*SDR, body)

def wir(head: int, wafer_id: str) -> bytes:
    body = u1(head) + u1(255) + u4(0) + cn(wafer_id)
    return record(*WIR, body)

def wrr(head: int, wafer_id: str, part_cnt: int, good_cnt: int) -> bytes:
    body = (
        u1(head) +
        u1(255) +
        u4(0) +           # finish_t
        u4(part_cnt) +
        u4(0xFFFFFFFF) +  # rtst_cnt
        u4(0xFFFFFFFF) +  # abrt_cnt
        u4(good_cnt) +
        u4(0xFFFFFFFF) +  # func_cnt
        cn(wafer_id) +
        cn('') +   # fabwf_id
        cn('') +   # frame_id
        cn('') +   # mask_id
        cn('') +   # usr_desc
        cn('')     # exc_desc
    )
    return record(*WRR, body)

def pir(head: int, site: int) -> bytes:
    return record(*PIR, u1(head) + u1(site))

def prr(head: int, site: int, x: int, y: int, hbin: int, sbin: int,
        part_id: int, passed: bool) -> bytes:
    part_flg = 0x00 if passed else 0x08   # bit 3 = PART_FLG fail
    body = (
        u1(head) + u1(site) +
        b1(part_flg) +
        u2(4) +            # num_test
        u2(hbin) +
        u2(sbin) +
        i2(x) + i2(y) +
        u4(100) +          # test_t (ms)
        cn(str(part_id)) + # part_id as string
        cn('') +           # part_txt
        b'\x00'            # part_fix length=0
    )
    return record(*PRR, body)

def ptr_rec(test_num: int, head: int, site: int, value: float,
            passed: bool, test_txt: str,
            lo: float | None = None, hi: float | None = None,
            units: str = '', first: bool = False) -> bytes:
    test_flg = 0x00 if passed else 0x80   # bit 7 = test failed
    parm_flg = 0x00

    if first and (lo is not None or hi is not None):
        # opt_flag, res_scal, llm_scal, hlm_scal, lo_limit, hi_limit, units
        has_lo = lo is not None
        has_hi = hi is not None
        opt_flag = 0x00
        if not has_lo: opt_flag |= 0x40   # no lo limit
        if not has_hi: opt_flag |= 0x80   # no hi limit
        optional = (
            b1(opt_flag) +
            b1(0) +           # res_scal
            b1(0) +           # llm_scal
            b1(0) +           # hlm_scal
            r4(lo if has_lo else 0.0) +
            r4(hi if has_hi else 0.0) +
            cn(units) +
            cn('') +  # c_resfmt
            cn('') +  # c_llmfmt
            cn('')    # c_hlmfmt
        )
    else:
        optional = b''

    body = (
        u4(test_num) +
        u1(head) + u1(site) +
        b1(test_flg) +
        b1(parm_flg) +
        r4(value) +
        cn(test_txt) +
        cn('') +    # alarm_id
        optional
    )
    return record(*PTR, body)

def ftr_rec(test_num: int, head: int, site: int, passed: bool, test_txt: str) -> bytes:
    test_flg = 0x00 if passed else 0x80
    # Minimal FTR — many optional fields omitted via opt_flag
    body = (
        u4(test_num) +
        u1(head) + u1(site) +
        b1(test_flg) +
        b1(0xFF) +   # opt_flag: all optional fields absent
        u4(0) +      # cycl_cnt
        u4(0) +      # rel_vadr
        u4(0) +      # rept_cnt
        u4(0) +      # num_fail
        i2(0) +      # xfail_ad
        i2(0) +      # yfail_ad
        i2(0) +      # vect_off
        u2(0) +      # rtn_icnt
        u2(0) +      # pgm_icnt
        cn(test_txt) +
        cn('') +     # vect_nam
        cn('') +     # time_set
        cn('') +     # op_code
        cn('') +     # test_txt (label)
        cn('') +     # alarm_id
        cn('') +     # prog_txt
        cn('') +     # rslt_txt
        u1(0) +      # patg_num
        b'\x00'      # spin_map length=0
    )
    return record(*FTR, body)

# ── Wafer geometry ─────────────────────────────────────────────────────────────

def wafer_dies(radius: int = 8) -> list[tuple[int, int]]:
    return [
        (x, y)
        for y in range(-radius, radius + 1)
        for x in range(-radius, radius + 1)
        if x*x + y*y <= radius*radius * 1.1
    ]

# ── Main ───────────────────────────────────────────────────────────────────────

TESTS = [
    (1000 + i, f'test_{i:02d}',  'mV',  100.0 * i,  100.0 * i + 50.0)
    for i in range(1, 51)
]
FT_NUM  = 2001
FT_NAME = 'scan_chain'

SITES = [1, 2, 3, 4]
WAFERS = [f'W{i:02d}' for i in range(1, 26)]

def generate(output_path: Path) -> None:
    buf = bytearray()
    buf += far()
    buf += mir('LOT-LARGE', 'CHIP-Y', 'test_program_large', 'UltraTester-9000', 'node-01')
    buf += sdr(1, 1, SITES)

    dies = wafer_dies(56)
    part_counter = 1

    for wafer_id in WAFERS:
        buf += wir(1, wafer_id)
        part_cnt = 0
        good_cnt = 0

        # Process in groups of SITES dies (parallel test)
        for batch_start in range(0, len(dies), len(SITES)):
            batch = dies[batch_start: batch_start + len(SITES)]
            for site_idx, (x, y) in enumerate(batch):
                site = SITES[site_idx]
                buf += pir(1, site)

            for site_idx, (x, y) in enumerate(batch):
                site = SITES[site_idx]
                # Slight edge-ring yield loss
                edge = math.sqrt(x*x + y*y) > 48.0
                failed_tests = []

                for i, (tnum, tname, units, lo, hi) in enumerate(TESTS):
                    centre = (lo + hi) / 2
                    spread = (hi - lo) * 0.15
                    value = random.gauss(centre, spread)
                    if edge and random.random() < 0.15:
                        value = hi * 1.1   # push out of spec
                    passed = lo <= value <= hi
                    if not passed:
                        failed_tests.append(tnum)
                    buf += ptr_rec(tnum, 1, site, value, passed, tname,
                                   lo, hi, units, first=(batch_start == 0 and site_idx == 0))

                # FTR — occasional functional failure
                ft_passed = not (edge and random.random() < 0.05)
                if not ft_passed:
                    failed_tests.append(FT_NUM)
                buf += ftr_rec(FT_NUM, 1, site, ft_passed, FT_NAME)

                die_passed = len(failed_tests) == 0
                hbin = 1 if die_passed else (2 if len(failed_tests) == 1 else 3)
                sbin = hbin
                buf += prr(1, site, x, y, hbin, sbin, part_counter, die_passed)
                part_counter += 1
                part_cnt += 1
                if die_passed:
                    good_cnt += 1

        buf += wrr(1, wafer_id, part_cnt, good_cnt)

    output_path.write_bytes(buf)
    mb = len(buf) / 1_048_576
    print(f"Written {len(buf):,} bytes ({mb:.1f} MB) → {output_path}")
    print(f"  {len(WAFERS)} wafers × {len(dies)} dies × {len(TESTS)} PTR + 1 FTR tests")

if __name__ == '__main__':
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else Path('/tmp/test-large.stdf')
    generate(out)
