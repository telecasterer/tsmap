#!/usr/bin/env python3
"""Generate sample STDF and ATDF files from the wmap demo CSV data.

Reads the four scenario CSVs from ../wmap/docs/examples/data/ and produces:
  - One multi-wafer STDF and ATDF per scenario (all wafers in one file)
  - One single-wafer STDF and ATDF per wafer (named <LOT>_<WAFER>.stdf/.atdf)

Output directory defaults to ./sample_data/ (created if needed).

Usage:
  python3 scripts/generate_sample_files.py [output_dir]
"""

import csv
import math
import struct
import sys
from collections import defaultdict
from pathlib import Path

# ── Test definitions (match CSV columns) ─────────────────────────────────────

TESTS = [
    (1001, 'leakage',   'nA',   0.5,  5.5,  'leakage'),
    (1002, 'voltage',   'V',    1.6,  2.0,  'voltage'),
    (1003, 'frequency', 'MHz',  1900, 2200, 'frequency'),
]
# hbin→(name, pass) mapping
HBIN_NAMES = {
    1:  ('Pass',              True),
    2:  ('Leakage Fail',      False),
    3:  ('Voltage Fail',      False),
    4:  ('Frequency Fail',    False),
    10: ('Pass',              True),   # sbin pass variant
    11: ('Near-limit',        True),
    21: ('Leakage High',      False),
    22: ('Voltage Low',       False),
    23: ('Cluster Fail',      False),
    31: ('Edge Fail',         False),
    32: ('Multi Fail',        False),
}

# ── CSV loading ───────────────────────────────────────────────────────────────

def load_csv(path: Path):
    """Returns {wafer_id: [row_dict, ...]} preserving order."""
    wafers = defaultdict(list)
    with open(path) as f:
        for row in csv.DictReader(f):
            wafers[row['wafer']].append(row)
    return dict(wafers)

# ── STDF helpers ──────────────────────────────────────────────────────────────

def cn(s: str) -> bytes:
    b = s.encode('ascii')
    return bytes([len(b)]) + b

def u1(v):  return struct.pack('B', int(v) & 0xFF)
def u2(v):  return struct.pack('<H', int(v) & 0xFFFF)
def u4(v):  return struct.pack('<I', int(v) & 0xFFFFFFFF)
def i2(v):  return struct.pack('<h', int(v))
def r4(v):  return struct.pack('<f', float(v))
def b1(v):  return bytes([int(v) & 0xFF])

def stdf_rec(typ, sub, body):
    return struct.pack('<HBB', len(body), typ, sub) + body

FAR = (0, 10); MIR = (1, 10); SDR = (1, 80)
WIR = (2, 10); WRR = (2, 20)
PIR = (5, 10); PRR = (5, 20)
PTR = (15, 10)

def stdf_far():
    return stdf_rec(*FAR, u1(2) + u1(4))

def stdf_mir(lot_id, part_typ, meta):
    # MIR body order: setup_t, start_t, stat_num, mode_cod, rtst_cod, prot_cod,
    # burn_tim, cmod_cod, lot_id, part_typ, node_nam, tstr_typ, job_nam, job_rev,
    # sblot_id, oper_nam, exec_typ, exec_ver, test_cod, tst_temp, ...
    start_t = meta.get('start_t', 0)
    body = (u4(0) + u4(start_t) + u1(1) + b'P' + b' ' + b' ' + u2(0xFFFF) + b' ' +
            cn(lot_id) + cn(part_typ) + cn(meta.get('node', 'node-01')) + cn(meta.get('tstr', 'Tester-1')) +
            cn(meta.get('program', 'test_program')) + cn('1.0') + cn('') + cn(meta.get('oper', '')) + cn('') + cn('') +
            cn('') + cn(meta.get('temp', '25C')) + cn('') + cn('') + cn('') + cn('') + cn('') +
            cn('') + cn('') + cn('') + cn('') + cn('') + cn('') + cn('') +
            cn('') + cn('') + cn(''))
    return stdf_rec(*MIR, body)

def stdf_sdr():
    body = u1(1) + u1(1) + u1(1) + u1(1) + cn('') * 14
    return stdf_rec(*SDR, body)

def stdf_wir(wafer_id):
    return stdf_rec(*WIR, u1(1) + u1(255) + u4(0) + cn(wafer_id))

def stdf_wrr(wafer_id, part_cnt, good_cnt):
    body = (u1(1) + u1(255) + u4(0) + u4(part_cnt) +
            u4(0xFFFFFFFF) + u4(0xFFFFFFFF) + u4(good_cnt) + u4(0xFFFFFFFF) +
            cn(wafer_id) + cn('') + cn('') + cn('') + cn('') + cn(''))
    return stdf_rec(*WRR, body)

def stdf_pir(site):
    return stdf_rec(*PIR, u1(1) + u1(site))

def stdf_prr(site, x, y, hbin, sbin, part_id):
    passed = HBIN_NAMES.get(hbin, ('', False))[1]
    part_flg = 0x00 if passed else 0x08
    body = (u1(1) + u1(site) + b1(part_flg) + u2(3) +
            u2(hbin) + u2(sbin) + i2(x) + i2(y) +
            u4(100) + cn(str(part_id)) + cn('') + b'\x00')
    return stdf_rec(*PRR, body)

def stdf_ptr(tnum, site, value, passed, tname, units, lo, hi, include_limits):
    test_flg = 0x00 if passed else 0x80
    if include_limits:
        optional = (b1(0x00) + b1(0) + b1(0) + b1(0) +
                    r4(lo) + r4(hi) + cn(units) + cn('') + cn('') + cn(''))
    else:
        optional = b''
    body = (u4(tnum) + u1(1) + u1(site) + b1(test_flg) + b1(0) +
            r4(value) + cn(tname) + cn('') + optional)
    return stdf_rec(*PTR, body)

def build_stdf(lot_id, part_typ, wafer_data: dict) -> bytes:
    """wafer_data: {wafer_id: [row, ...]}"""
    buf = bytearray()
    buf += stdf_far()
    buf += stdf_mir(lot_id, part_typ, LOT_META.get(lot_id, {}))
    buf += stdf_sdr()
    part_id = 1
    first_limits = True
    for wafer_id, rows in wafer_data.items():
        buf += stdf_wir(wafer_id)
        part_cnt = good_cnt = 0
        for row in rows:
            x, y = int(row['x']), int(row['y'])
            hbin, sbin = int(row['hbin']), int(row['sbin'])
            passed = HBIN_NAMES.get(hbin, ('', False))[1]
            buf += stdf_pir(1)
            for tnum, tname, units, lo, hi, col in TESTS:
                value = float(row[col])
                tpassed = lo <= value <= hi
                buf += stdf_ptr(tnum, 1, value, tpassed, tname, units, lo, hi, first_limits)
            first_limits = False
            buf += stdf_prr(1, x, y, hbin, sbin, part_id)
            part_id += 1
            part_cnt += 1
            if passed:
                good_cnt += 1
        buf += stdf_wrr(wafer_id, part_cnt, good_cnt)
    return bytes(buf)

# ── ATDF helpers ──────────────────────────────────────────────────────────────

D = '|'

def arec(name, *fields):
    return name + ':' + D.join(str(f) for f in fields)

def build_atdf(lot_id, part_typ, wafer_data: dict) -> str:
    lines = []
    lines.append(arec('FAR', 'A' + D + '4'))
    lines.append(arec('MIR', lot_id, part_typ, 'test_program', 'node-01', 'Tester-1'))
    lines.append(arec('SDR', '1', '1', '1'))
    part_id = 1
    first_limits = True
    for wafer_id, rows in wafer_data.items():
        lines.append(arec('WIR', '1', '0', '1', wafer_id))
        part_cnt = good_cnt = 0
        for row in rows:
            x, y = int(row['x']), int(row['y'])
            hbin, sbin = int(row['hbin']), int(row['sbin'])
            passed = HBIN_NAMES.get(hbin, ('', False))[1]
            lines.append(arec('PIR', '1', '1'))
            for tnum, tname, units, lo, hi, col in TESTS:
                value = float(row[col])
                tpassed = lo <= value <= hi
                pf = 'P' if tpassed else 'F'
                if first_limits:
                    lines.append(arec('PTR', tnum, '1', '1', f'{value:.4f}', pf, '', '', tname, '', '', units, lo, hi))
                else:
                    lines.append(arec('PTR', tnum, '1', '1', f'{value:.4f}', pf))
            first_limits = False
            pf = 'P' if passed else 'F'
            lines.append(arec('PRR', '1', '1', part_id, 3, pf, hbin, sbin, x, y))
            part_id += 1
            part_cnt += 1
            if passed:
                good_cnt += 1
        lines.append(arec('WRR', '1', '0', part_cnt, wafer_id, '1', '0', good_cnt))
    return '\n'.join(lines) + '\n'

# ── Scenarios ─────────────────────────────────────────────────────────────────

# Per-lot MIR metadata so the faceting demo has fields that actually VARY across
# lots: program, temperature, test date (epoch), operator, tester, node. Without
# this every lot shares one program/temp/date and only lot/part-type can be
# grouped on. Dates are days apart so "group by date" buckets distinctly.
DAY = 86_400
BASE_EPOCH = 1_750_000_000  # ~2025-06-15
LOT_META = {
    'EDGE-LOT-01':  dict(program='EDGE_v2',  temp='25C',  start_t=BASE_EPOCH,            oper='alice', tstr='Tester-1', node='node-01'),
    'HY-LOT-04':    dict(program='HY_v3',    temp='25C',  start_t=BASE_EPOCH + 1 * DAY,  oper='bob',   tstr='Tester-1', node='node-02'),
    'CLUST-LOT-03': dict(program='CLUST_v1', temp='-40C', start_t=BASE_EPOCH + 5 * DAY,  oper='alice', tstr='Tester-2', node='node-02'),
    'PARAM-LOT-02': dict(program='PARAM_v5', temp='85C',  start_t=BASE_EPOCH + 5 * DAY,  oper='carol', tstr='Tester-2', node='node-03'),
}

SCENARIOS = [
    ('edge-ring.csv',  'EDGE-LOT-01', 'CHIP-A'),
    ('high-yield.csv', 'HY-LOT-04',   'CHIP-A'),
    ('cluster.csv',    'CLUST-LOT-03', 'CHIP-B'),
    ('parametric.csv', 'PARAM-LOT-02', 'CHIP-B'),
]

# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    csv_dir = Path(__file__).parent.parent.parent / 'wmap' / 'docs' / 'examples' / 'data'
    out_dir = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).parent.parent / 'sample_data'
    out_dir.mkdir(parents=True, exist_ok=True)

    total_files = 0
    for csv_name, lot_id, part_typ in SCENARIOS:
        csv_path = csv_dir / csv_name
        if not csv_path.exists():
            print(f'WARNING: {csv_path} not found — skipping')
            continue

        wafer_data = load_csv(csv_path)
        wafer_ids = list(wafer_data.keys())
        print(f'\n{lot_id} ({len(wafer_ids)} wafers from {csv_name})')

        # Multi-wafer file
        for ext, builder, writer in [
            ('stdf', build_stdf, lambda p, d: p.write_bytes(d)),
            ('atdf', build_atdf, lambda p, d: p.write_text(d)),
        ]:
            path = out_dir / f'{lot_id}.{ext}'
            data = builder(lot_id, part_typ, wafer_data)
            writer(path, data)
            size = path.stat().st_size
            print(f'  {path.name}  ({size:,} bytes, {len(wafer_ids)} wafers)')
            total_files += 1

        # Per-wafer files
        for wafer_id in wafer_ids:
            single = {wafer_id: wafer_data[wafer_id]}
            for ext, builder, writer in [
                ('stdf', build_stdf, lambda p, d: p.write_bytes(d)),
                ('atdf', build_atdf, lambda p, d: p.write_text(d)),
            ]:
                path = out_dir / f'{lot_id}_{wafer_id}.{ext}'
                data = builder(lot_id, part_typ, single)
                writer(path, data)
                total_files += 1
            print(f'  {lot_id}_{wafer_id}.stdf/.atdf  ({len(single[wafer_id])} dies)')

    print(f'\nDone — {total_files} files written to {out_dir}/')

if __name__ == '__main__':
    main()
