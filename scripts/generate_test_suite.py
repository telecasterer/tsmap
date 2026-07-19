#!/usr/bin/env python3
"""Generate a test suite of STDF/ATDF/JSON/CSV files for performance and format testing.

Creates testdata/ (untracked by git) with:

  small.stdf/atdf/json/csv    3w  × ~500  dies × 20  tests   (~1 MB)
  medium.stdf/atdf/json/csv   10w × ~2k   dies × 100 tests   (~50 MB)
  many_tests.stdf/atdf        5w  × ~500  dies × 250 tests   (~20 MB, triggers test selector)
  correlated.stdf/atdf        5w  × ~2k   dies × 30  tests   (~10 MB, designed correlations)

Sizes are chosen to be loadable without memory pressure.
Die geometry uses wafer_dies(radius) exactly — no slicing — so every file has
a proper circular wafer shape.
"""

import struct
import math
import random
import json
import csv
import sys
from pathlib import Path

random.seed(42)

# ── STDF record helpers (copied from generate_stdf.py) ───────────────────────

def cn(s: str) -> bytes:
    b = s.encode('ascii')
    return bytes([len(b)]) + b

def u1(v: int) -> bytes: return struct.pack('B', v & 0xFF)
def u2(v: int) -> bytes: return struct.pack('<H', v & 0xFFFF)
def u4(v: int) -> bytes: return struct.pack('<I', v & 0xFFFFFFFF)
def i2(v: int) -> bytes: return struct.pack('<h', v)
def i4(v: int) -> bytes: return struct.pack('<i', v)
def r4(v: float) -> bytes: return struct.pack('<f', v)
def b1(v: int) -> bytes: return bytes([v & 0xFF])
def c1(c: str) -> bytes: return c.encode('ascii')[:1]

def record(rec_typ: int, rec_sub: int, body: bytes) -> bytes:
    return struct.pack('<HBB', len(body), rec_typ, rec_sub) + body

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
    return record(*FAR, u1(2) + u1(4))

def mir(lot_id: str, part_typ: str, job_nam: str, tstr_typ: str, node_nam: str) -> bytes:
    body = (
        u4(0) + u4(0) + u1(1) + c1('P') + c1(' ') + c1(' ') + u2(0xFFFF) + c1(' ') +
        cn(lot_id) + cn(part_typ) + cn(node_nam) + cn(tstr_typ) + cn(job_nam) +
        cn('1.0') + cn('') + cn('') + cn('') + cn('') + cn('') +
        cn('25C') + cn('') + cn('') + cn('') + cn('') + cn('') +
        cn('') + cn('') + cn('') + cn('') + cn('') + cn('') + cn('') +
        cn('') + cn('') + cn('')
    )
    return record(*MIR, body)

def sdr(head: int, site_grp: int, sites: list[int]) -> bytes:
    body = u1(head) + u1(site_grp) + u1(len(sites)) + b''.join(u1(s) for s in sites) + cn('') * 18
    return record(*SDR, body)

def wir(head: int, wafer_id: str) -> bytes:
    return record(*WIR, u1(head) + u1(255) + u4(0) + cn(wafer_id))

def wrr(head: int, wafer_id: str, part_cnt: int, good_cnt: int) -> bytes:
    body = (
        u1(head) + u1(255) + u4(0) + u4(part_cnt) +
        u4(0xFFFFFFFF) + u4(0xFFFFFFFF) + u4(good_cnt) + u4(0xFFFFFFFF) +
        cn(wafer_id) + cn('') + cn('') + cn('') + cn('') + cn('')
    )
    return record(*WRR, body)

def pir(head: int, site: int) -> bytes:
    return record(*PIR, u1(head) + u1(site))

def prr(head: int, site: int, x: int, y: int, hbin: int, sbin: int,
        part_id: int, passed: bool) -> bytes:
    part_flg = 0x00 if passed else 0x08
    body = (
        u1(head) + u1(site) + b1(part_flg) + u2(4) +
        u2(hbin) + u2(sbin) + i2(x) + i2(y) +
        u4(100) + cn(str(part_id)) + cn('') + b'\x00'
    )
    return record(*PRR, body)

def ptr_rec(test_num: int, head: int, site: int, value: float, passed: bool,
            test_txt: str, lo: float | None = None, hi: float | None = None,
            units: str = '', first: bool = False) -> bytes:
    test_flg = 0x00 if passed else 0x80
    if first and (lo is not None or hi is not None):
        has_lo, has_hi = lo is not None, hi is not None
        opt_flag = (0x40 if not has_lo else 0) | (0x80 if not has_hi else 0)
        optional = (
            b1(opt_flag) + b1(0) + b1(0) + b1(0) +
            r4(lo if has_lo else 0.0) + r4(hi if has_hi else 0.0) +
            cn(units) + cn('') + cn('') + cn('')
        )
    else:
        optional = b''
    body = (
        u4(test_num) + u1(head) + u1(site) + b1(test_flg) + b1(0) +
        r4(value) + cn(test_txt) + cn('') + optional
    )
    return record(*PTR, body)

def ftr_rec(test_num: int, head: int, site: int, passed: bool, test_txt: str) -> bytes:
    test_flg = 0x00 if passed else 0x80
    body = (
        u4(test_num) + u1(head) + u1(site) + b1(test_flg) + b1(0xFF) +
        u4(0) + u4(0) + u4(0) + u4(0) + i4(0) + i4(0) + i2(0) + u2(0) + u2(0) +
        u2(0) +                       # fail_pin (Dn: 0 bits); xfail/yfail above are I*4 per spec
        cn('') + cn('') + cn('') +    # vect_nam, time_set, op_code
        cn(test_txt) +                # test_txt — the spec's name slot
        cn('') + cn('') + cn('') +    # alarm_id, prog_txt, rslt_txt
        u1(0) + u2(0)                 # patg_num, spin_map (Dn: 0 bits)
    )
    return record(*FTR, body)

# ── ATDF helpers ──────────────────────────────────────────────────────────────

D = '|'

def atdf_far() -> str:
    return f'FAR:A{D}4'

def atdf_mir(lot_id: str, part_typ: str, job_nam: str, tstr_typ: str, node_nam: str) -> str:
    return f'MIR:{lot_id}{D}{part_typ}{D}{job_nam}{D}{node_nam}{D}{tstr_typ}'

def atdf_sdr() -> str:
    return f'SDR:1{D}1{D}1'

def atdf_wir(wafer_id: str) -> str:
    return f'WIR:1{D}0{D}1{D}{wafer_id}'

def atdf_wrr(wafer_id: str, part_cnt: int, good_cnt: int) -> str:
    return f'WRR:1{D}0{D}{part_cnt}{D}{wafer_id}{D}1{D}0{D}{good_cnt}'

def atdf_pir(site: int) -> str:
    return f'PIR:1{D}{site}'

def atdf_prr(site: int, part_id: int, hbin: int, sbin: int, x: int, y: int, passed: bool) -> str:
    pf = 'P' if passed else 'F'
    return f'PRR:1{D}{site}{D}{part_id}{D}4{D}{pf}{D}{hbin}{D}{sbin}{D}{x}{D}{y}'

def atdf_ptr(test_num: int, site: int, value: float, passed: bool, test_txt: str,
             units: str = '', lo: float | None = None, hi: float | None = None,
             first: bool = False) -> str:
    pf = 'P' if passed else 'F'
    if first and (lo is not None or hi is not None):
        lo_s = f'{lo:.4f}' if lo is not None else ''
        hi_s = f'{hi:.4f}' if hi is not None else ''
        return f'PTR:{test_num}{D}1{D}{site}{D}{value:.4f}{D}{pf}{D}{D}{D}{test_txt}{D}{D}{D}{units}{D}{lo_s}{D}{hi_s}'
    return f'PTR:{test_num}{D}1{D}{site}{D}{value:.4f}{D}{pf}'

# ── Wafer geometry ────────────────────────────────────────────────────────────

def wafer_dies(radius: int) -> list[tuple[int, int]]:
    """Return all (x,y) positions within the wafer circle. Full circle, no slicing."""
    return [
        (x, y)
        for y in range(-radius, radius + 1)
        for x in range(-radius, radius + 1)
        if x * x + y * y <= radius * radius * 1.1
    ]

# ── Test definitions ──────────────────────────────────────────────────────────

def make_tests(num_tests: int) -> list[tuple[int, str, str, float, float]]:
    """(test_number, name, units, lo_limit, hi_limit)"""
    return [
        (1000 + i, f'test_{i:03d}', 'mV', 40.0 + (i % 10) * 5.0, 60.0 + (i % 10) * 5.0)
        for i in range(num_tests)
    ]

# ── Correlation helpers ───────────────────────────────────────────────────────

# Groups of correlated tests: tests within a group share a latent variable
CORR_GROUPS = [
    [0, 1, 2],    # strong positive: r ≈ 0.9
    [3, 4, 5],    # moderate positive: r ≈ 0.6
    [6, 7],       # anti-correlated: r ≈ -0.7
    [8, 9],       # independent (no group)
]

def correlated_values(test_idx: int, tests: list, latents: list[float]) -> float:
    lo, hi = tests[test_idx][3], tests[test_idx][4]
    centre = (lo + hi) / 2
    spread = (hi - lo) * 0.15

    for group_idx, group in enumerate(CORR_GROUPS):
        if test_idx in group:
            pos = group.index(test_idx)
            if group_idx == 0:   # strong positive
                return centre + latents[0] * spread * 0.9 + random.gauss(0, spread * 0.1)
            elif group_idx == 1:  # moderate positive
                return centre + latents[1] * spread * 0.6 + random.gauss(0, spread * 0.6)
            elif group_idx == 2:  # anti-correlated
                sign = 1 if pos == 0 else -1
                return centre + sign * latents[2] * spread * 0.7 + random.gauss(0, spread * 0.3)

    return random.gauss(centre, spread)

# ── Core generator ────────────────────────────────────────────────────────────

def generate_stdf_atdf(
    lot_id: str, num_wafers: int, dies: list[tuple[int, int]],
    tests: list, use_correlations: bool,
    stdf_path: Path, atdf_path: Path,
) -> None:
    stdf_buf = bytearray()
    atdf_lines: list[str] = []

    stdf_buf += far()
    stdf_buf += mir(lot_id, 'CHIP-TEST', 'test_program', 'Tester', 'node-01')
    stdf_buf += sdr(1, 1, [1, 2, 3, 4])
    atdf_lines += [atdf_far(), atdf_mir(lot_id, 'CHIP-TEST', 'test_program', 'Tester', 'node-01'), atdf_sdr()]

    SITES = [1, 2, 3, 4]
    part_counter = 1
    wafer_ids = [f'W{i:02d}' for i in range(1, num_wafers + 1)]

    for wafer_id in wafer_ids:
        stdf_buf += wir(1, wafer_id)
        atdf_lines.append(atdf_wir(wafer_id))
        part_cnt = good_cnt = 0

        for batch_start in range(0, len(dies), len(SITES)):
            batch = dies[batch_start:batch_start + len(SITES)]
            # PIR for each site in batch
            for site_idx, _ in enumerate(batch):
                stdf_buf += pir(1, site_idx + 1)
                atdf_lines.append(atdf_pir(site_idx + 1))

            for site_idx, (x, y) in enumerate(batch):
                site = site_idx + 1
                edge = math.sqrt(x * x + y * y) > (max(abs(d[0]) for d in dies) * 0.85)

                # Latent variables for correlated tests
                latents = [random.gauss(0, 1) for _ in range(3)]

                failed = []
                is_first = batch_start == 0 and site_idx == 0

                for i, (tnum, tname, units, lo, hi) in enumerate(tests):
                    if use_correlations:
                        value = correlated_values(i, tests, latents)
                    else:
                        centre = (lo + hi) / 2
                        spread = (hi - lo) * 0.15
                        value = random.gauss(centre, spread)

                    if edge and random.random() < 0.15:
                        value = hi * 1.1

                    passed = lo <= value <= hi
                    if not passed:
                        failed.append(tnum)

                    stdf_buf += ptr_rec(tnum, 1, site, value, passed, tname, lo, hi, units, first=is_first)
                    atdf_lines.append(atdf_ptr(tnum, site, value, passed, tname, units, lo, hi, first=is_first))

                # One FTR per die
                ft_passed = not (edge and random.random() < 0.05)
                stdf_buf += ftr_rec(9000, 1, site, ft_passed, 'scan_chain')
                if not ft_passed:
                    failed.append(9000)

                die_passed = len(failed) == 0
                hbin = 1 if die_passed else (2 if len(failed) <= 2 else 3)
                stdf_buf += prr(1, site, x, y, hbin, hbin, part_counter, die_passed)
                atdf_lines.append(atdf_prr(site, part_counter, hbin, hbin, x, y, die_passed))
                part_counter += 1
                part_cnt += 1
                if die_passed:
                    good_cnt += 1

        stdf_buf += wrr(1, wafer_id, part_cnt, good_cnt)
        atdf_lines.append(atdf_wrr(wafer_id, part_cnt, good_cnt))

    stdf_path.write_bytes(stdf_buf)
    atdf_path.write_text('\n'.join(atdf_lines) + '\n')

def generate_json(
    lot_id: str, num_wafers: int, dies: list[tuple[int, int]],
    tests: list, use_correlations: bool, output_path: Path,
) -> None:
    wafer_ids = [f'W{i:02d}' for i in range(1, num_wafers + 1)]
    with open(output_path, 'w') as f:
        f.write('{"wafers":[\n')
        for w_idx, wafer_id in enumerate(wafer_ids):
            if w_idx > 0:
                f.write(',\n')
            f.write(f'  {{"waferId":"{wafer_id}","results":[\n')
            for d_idx, (x, y) in enumerate(dies):
                if d_idx > 0:
                    f.write(',\n')
                edge = math.sqrt(x * x + y * y) > (max(abs(d[0]) for d in dies) * 0.85)
                latents = [random.gauss(0, 1) for _ in range(3)]
                tv: dict[str, float] = {}
                for i, (tnum, _, _, lo, hi) in enumerate(tests):
                    if use_correlations:
                        v = correlated_values(i, tests, latents)
                    else:
                        v = random.gauss((lo + hi) / 2, (hi - lo) * 0.15)
                    if edge and random.random() < 0.15:
                        v = hi * 1.1
                    tv[str(tnum)] = round(v, 4)
                hbin = random.choices([1, 2, 3], weights=[80, 15, 5])[0]
                f.write(f'    {{"x":{x},"y":{y},"hbin":{hbin},"sbin":{hbin},"testValues":{json.dumps(tv)}}}')
            f.write('\n  ]}')
        f.write('\n]}\n')

def generate_csv(
    lot_id: str, num_wafers: int, dies: list[tuple[int, int]],
    tests: list, use_correlations: bool, output_path: Path,
) -> None:
    wafer_ids = [f'W{i:02d}' for i in range(1, num_wafers + 1)]
    headers = ['wafer_id', 'x', 'y', 'hbin', 'sbin'] + [t[1] for t in tests]
    with open(output_path, 'w', newline='') as f:
        writer = csv.writer(f)
        writer.writerow(headers)
        for wafer_id in wafer_ids:
            for x, y in dies:
                edge = math.sqrt(x * x + y * y) > (max(abs(d[0]) for d in dies) * 0.85)
                latents = [random.gauss(0, 1) for _ in range(3)]
                hbin = random.choices([1, 2, 3], weights=[80, 15, 5])[0]
                row = [wafer_id, x, y, hbin, hbin]
                for i, (_, _, _, lo, hi) in enumerate(tests):
                    if use_correlations:
                        v = correlated_values(i, tests, latents)
                    else:
                        v = random.gauss((lo + hi) / 2, (hi - lo) * 0.15)
                    if edge and random.random() < 0.15:
                        v = hi * 1.1
                    row.append(round(v, 4))
                writer.writerow(row)

def generate_csv_long(
    lot_id: str, num_wafers: int, dies: list[tuple[int, int]],
    tests: list, use_correlations: bool, output_path: Path,
) -> None:
    """Long format: one row per die per test, with test_name/test_val/lo_limit/hi_limit/units columns.
    The mapping UI will auto-detect lo_limit/hi_limit by column name, so limits appear in charts."""
    wafer_ids = [f'W{i:02d}' for i in range(1, num_wafers + 1)]
    headers = ['wafer_id', 'x', 'y', 'hbin', 'sbin', 'test_name', 'test_val', 'lo_limit', 'hi_limit', 'units']
    max_r = max(abs(d[0]) for d in dies)
    with open(output_path, 'w', newline='') as f:
        writer = csv.writer(f)
        writer.writerow(headers)
        for wafer_id in wafer_ids:
            for x, y in dies:
                edge = math.sqrt(x * x + y * y) > max_r * 0.85
                latents = [random.gauss(0, 1) for _ in range(3)]
                hbin = random.choices([1, 2, 3], weights=[80, 15, 5])[0]
                for i, (_, tname, units, lo, hi) in enumerate(tests):
                    if use_correlations:
                        v = correlated_values(i, tests, latents)
                    else:
                        v = random.gauss((lo + hi) / 2, (hi - lo) * 0.15)
                    if edge and random.random() < 0.15:
                        v = hi * 1.1
                    writer.writerow([wafer_id, x, y, hbin, hbin, tname, round(v, 4), lo, hi, units])

# ── Suite definitions ─────────────────────────────────────────────────────────
#
# Radius choices (from wafer_dies geometry):
#   r=12  →  497 dies   (≈500)
#   r=24  → 1973 dies   (≈2k)
#   r=40  → 5445 dies   (≈5k)
#
# No radius > 40 to keep files loadable without memory pressure.

SUITES = [
    # (name, num_wafers, radius, num_tests, correlated, formats)
    ('small',      3,  12, 20,  False, ['stdf', 'atdf', 'json', 'csv', 'csv_long']),
    ('medium',     10, 24, 100, False, ['stdf', 'atdf', 'json', 'csv']),
    ('many_tests', 5,  12, 250, False, ['stdf', 'atdf']),       # triggers test selector (>200)
    ('correlated', 5,  24, 30,  True,  ['stdf', 'atdf', 'json', 'csv', 'csv_long']),
]

def main() -> None:
    outdir = Path(__file__).parent.parent / 'testdata'
    outdir.mkdir(exist_ok=True)

    print(f'Generating test suite → {outdir}/\n')

    for name, num_wafers, radius, num_tests, correlated, formats in SUITES:
        dies = wafer_dies(radius)
        tests = make_tests(num_tests)
        lot_id = f'LOT-{name.upper()}'
        print(f'{name}:  {num_wafers}w × {len(dies)} dies × {num_tests} tests  (r={radius}{"  correlated" if correlated else ""})')

        stdf_p = outdir / f'{name}.stdf'
        atdf_p = outdir / f'{name}.atdf'
        json_p = outdir / f'{name}.json'
        csv_p  = outdir / f'{name}.csv'

        if 'stdf' in formats or 'atdf' in formats:
            generate_stdf_atdf(lot_id, num_wafers, dies, tests, correlated,
                               stdf_p if 'stdf' in formats else Path('/dev/null'),
                               atdf_p if 'atdf' in formats else Path('/dev/null'))
            for p in [stdf_p, atdf_p]:
                if p.exists() and str(p) != '/dev/null':
                    print(f'  {p.name}: {p.stat().st_size / 1_048_576:.1f} MB')

        if 'json' in formats:
            generate_json(lot_id, num_wafers, dies, tests, correlated, json_p)
            print(f'  {json_p.name}: {json_p.stat().st_size / 1_048_576:.1f} MB')

        if 'csv' in formats:
            generate_csv(lot_id, num_wafers, dies, tests, correlated, csv_p)
            print(f'  {csv_p.name}: {csv_p.stat().st_size / 1_048_576:.1f} MB')

        if 'csv_long' in formats:
            csv_long_p = outdir / f'{name}_long.csv'
            generate_csv_long(lot_id, num_wafers, dies, tests, correlated, csv_long_p)
            print(f'  {csv_long_p.name}: {csv_long_p.stat().st_size / 1_048_576:.1f} MB')

        print()

    print('Done.')
    print()
    print('Files to test with:')
    print('  small.*             — basic format/rendering smoke test')
    print('  medium.*            — charts, correlation matrix, scatter at reasonable scale')
    print('  many_tests.*        — test selector overlay (250 tests > 200 threshold)')
    print('  correlated.*        — correlation matrix with designed r values')
    print('  small_long.csv      — long-format CSV with lo_limit/hi_limit columns (scatter limit rectangle)')
    print('  correlated_long.csv — long-format CSV with limits + designed correlations')

if __name__ == '__main__':
    main()
