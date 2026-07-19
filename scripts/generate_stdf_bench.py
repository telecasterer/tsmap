#!/usr/bin/env python3
"""Parametric STDF V4 generator for benchmark test matrix.

Usage:
    python3 scripts/generate_stdf_bench.py --tests 1000 --radius 40 --wafers 3 /tmp/t1000_d5000.stdf

Die count by radius (approximate):
    radius 13 → ~530 dies
    radius 18 → ~1000 dies
    radius 40 → ~5000 dies
    radius 56 → ~10500 dies
"""

import argparse
import math
import random
import struct
import sys
from pathlib import Path

random.seed(42)

# ── STDF record helpers (shared with generate_stdf.py) ───────────────────────

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

FAR = (0,  10)
MIR = (1,  10)
SDR = (1,  80)
WIR = (2,  10)
WRR = (2,  20)
PIR = (5,  10)
PRR = (5,  20)
PTR = (15, 10)
FTR = (15, 20)

def far() -> bytes:
    return record(*FAR, u1(2) + u1(4))

def mir(lot_id: str, part_typ: str, job_nam: str, tstr_typ: str, node_nam: str) -> bytes:
    body = (
        u4(0) + u4(0) + u1(1) + c1('P') + c1(' ') + c1(' ') + u2(0xFFFF) + c1(' ') +
        cn(lot_id) + cn(part_typ) + cn(node_nam) + cn(tstr_typ) + cn(job_nam) +
        cn('1.0') + cn('') * 22
    )
    return record(*MIR, body)

def sdr(head: int, site_grp: int, sites: list[int]) -> bytes:
    body = u1(head) + u1(site_grp) + u1(len(sites)) + b''.join(u1(s) for s in sites) + cn('') * 16
    return record(*SDR, body)

def wir(head: int, wafer_id: str) -> bytes:
    return record(*WIR, u1(head) + u1(255) + u4(0) + cn(wafer_id))

def wrr(head: int, wafer_id: str, part_cnt: int, good_cnt: int) -> bytes:
    body = (
        u1(head) + u1(255) + u4(0) + u4(part_cnt) +
        u4(0xFFFFFFFF) + u4(0xFFFFFFFF) + u4(good_cnt) + u4(0xFFFFFFFF) +
        cn(wafer_id) + cn('') * 5
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

def ptr_rec(test_num: int, head: int, site: int, value: float,
            passed: bool, test_txt: str,
            lo: float | None = None, hi: float | None = None,
            units: str = '', first: bool = False) -> bytes:
    test_flg = 0x00 if passed else 0x80
    if first and (lo is not None or hi is not None):
        has_lo, has_hi = lo is not None, hi is not None
        opt_flag = (0x00 | (0x40 if not has_lo else 0) | (0x80 if not has_hi else 0))
        optional = (
            b1(opt_flag) + b1(0) + b1(0) + b1(0) +
            r4(lo if has_lo else 0.0) + r4(hi if has_hi else 0.0) +
            cn(units) + cn('') + cn('') + cn('')
        )
    else:
        optional = b''
    body = u4(test_num) + u1(head) + u1(site) + b1(test_flg) + b1(0) + r4(value) + cn(test_txt) + cn('') + optional
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

def wafer_dies(radius: int) -> list[tuple[int, int]]:
    return [
        (x, y)
        for y in range(-radius, radius + 1)
        for x in range(-radius, radius + 1)
        if x * x + y * y <= radius * radius * 1.1
    ]

# ── Generator ─────────────────────────────────────────────────────────────────

def generate(output_path: Path, n_tests: int, radius: int, n_wafers: int) -> None:
    tests = [
        (1000 + i, f'test_{i:04d}', 'mV', 100.0 * i, 100.0 * i + 50.0)
        for i in range(1, n_tests + 1)
    ]
    ft_num, ft_name = 9001, 'scan_chain'
    sites = [1, 2, 3, 4]
    wafers = [f'W{i:02d}' for i in range(1, n_wafers + 1)]
    dies = wafer_dies(radius)
    edge_threshold = radius * 0.85

    buf = bytearray()
    buf += far()
    buf += mir('LOT-BENCH', 'CHIP-B', 'bench_program', 'BenchTester', 'node-01')
    buf += sdr(1, 1, sites)

    part_counter = 1
    for wafer_id in wafers:
        buf += wir(1, wafer_id)
        part_cnt = good_cnt = 0

        for batch_start in range(0, len(dies), len(sites)):
            batch = dies[batch_start: batch_start + len(sites)]
            for site_idx, (x, y) in enumerate(batch):
                buf += pir(1, sites[site_idx])

            for site_idx, (x, y) in enumerate(batch):
                site = sites[site_idx]
                edge = math.sqrt(x * x + y * y) > edge_threshold
                failed = []

                for i, (tnum, tname, units, lo, hi) in enumerate(tests):
                    centre = (lo + hi) / 2
                    spread = (hi - lo) * 0.15
                    value = random.gauss(centre, spread)
                    if edge and random.random() < 0.15:
                        value = hi * 1.1
                    passed = lo <= value <= hi
                    if not passed:
                        failed.append(tnum)
                    buf += ptr_rec(tnum, 1, site, value, passed, tname,
                                   lo, hi, units, first=(batch_start == 0 and site_idx == 0))

                ft_passed = not (edge and random.random() < 0.05)
                if not ft_passed:
                    failed.append(ft_num)
                buf += ftr_rec(ft_num, 1, site, ft_passed, ft_name)

                die_passed = len(failed) == 0
                hbin = 1 if die_passed else (2 if len(failed) == 1 else 3)
                buf += prr(1, site, x, y, hbin, hbin, part_counter, die_passed)
                part_counter += 1
                part_cnt += 1
                if die_passed:
                    good_cnt += 1

        buf += wrr(1, wafer_id, part_cnt, good_cnt)

    output_path.write_bytes(buf)
    mb = len(buf) / 1_048_576
    total_dies = n_wafers * len(dies)
    print(f"Written {len(buf):,} bytes ({mb:.1f} MB) → {output_path}")
    print(f"  {n_wafers} wafers × {len(dies)} dies × {n_tests} PTR + 1 FTR  ({total_dies:,} total dies)")

# ── CLI ───────────────────────────────────────────────────────────────────────

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Generate a parametric STDF benchmark file')
    parser.add_argument('output', nargs='?', default='/tmp/bench.stdf', help='Output path')
    parser.add_argument('--tests',  type=int, default=50,  help='Number of PTR tests per die')
    parser.add_argument('--radius', type=int, default=13,  help='Wafer radius (dies ≈ π·r²)')
    parser.add_argument('--wafers', type=int, default=3,   help='Number of wafers')
    args = parser.parse_args()
    generate(Path(args.output), args.tests, args.radius, args.wafers)
