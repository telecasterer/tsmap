#!/usr/bin/env python3
"""Generate a synthetic STDF file with correlated parametric tests.

Produces: 5 wafers, ~200 dies each, 4-site parallel test, 6 PTR tests with
known inter-test correlations so the correlation matrix and scatter charts
can be visually verified:

  leakage_nA   — primary process variable (higher = more leaky device)
  ron_ohm      — positively correlated with leakage  (r ~ +0.85)
  freq_MHz     — negatively correlated with leakage  (r ~ -0.80)
  idd_uA       — negatively correlated with ron_ohm  (r ~ -0.75)
  vth_mV       — weakly correlated with leakage      (r ~ +0.30)
  noise_mV     — uncorrelated random noise           (r ~ 0)

Each test has realistic spec limits so some edge-ring dies fail,
creating a mix of hbin 1 (pass) and hbin 2/3 (fail) points in the scatter.
"""

import struct
import math
import random
import sys
from pathlib import Path

random.seed(99)

# ── STDF record helpers (same as generate_stdf.py) ───────────────────────────

def cn(s: str) -> bytes:
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
    return struct.pack('<HBB', length, rec_typ, rec_sub) + body

FAR = (0,  10)
MIR = (1,  10)
SDR = (1,  80)
WIR = (2,  10)
WRR = (2,  20)
PIR = (5,  10)
PRR = (5,  20)
PTR = (15, 10)

def far() -> bytes:
    return record(*FAR, u1(2) + u1(4))

def mir(lot_id: str) -> bytes:
    body = (
        u4(0) + u4(0) + u1(1) + c1('P') + c1(' ') + c1(' ') +
        u2(0xFFFF) + c1(' ') +
        cn(lot_id) + cn('CHIP-CORR') + cn('node-01') + cn('UltraTester-9000') +
        cn('corr_test') + cn('1.0') +
        cn('') * 18  # remaining optional Cn fields
    )
    return record(*MIR, body)

def sdr(sites: list[int]) -> bytes:
    body = (
        u1(1) + u1(1) + u1(len(sites)) +
        b''.join(u1(s) for s in sites) +
        cn('') * 14
    )
    return record(*SDR, body)

def wir(wafer_id: str) -> bytes:
    return record(*WIR, u1(1) + u1(255) + u4(0) + cn(wafer_id))

def wrr(wafer_id: str, part_cnt: int, good_cnt: int) -> bytes:
    body = (
        u1(1) + u1(255) + u4(0) +
        u4(part_cnt) + u4(0xFFFFFFFF) + u4(0xFFFFFFFF) +
        u4(good_cnt) + u4(0xFFFFFFFF) +
        cn(wafer_id) + cn('') * 5
    )
    return record(*WRR, body)

def pir(site: int) -> bytes:
    return record(*PIR, u1(1) + u1(site))

def prr(site: int, x: int, y: int, hbin: int, sbin: int, part_id: int, passed: bool) -> bytes:
    body = (
        u1(1) + u1(site) +
        b1(0x00 if passed else 0x08) +
        u2(6) +  # num_test
        u2(hbin) + u2(sbin) +
        i2(x) + i2(y) +
        u4(100) +
        cn(str(part_id)) + cn('') + b'\x00'
    )
    return record(*PRR, body)

def ptr_rec(test_num: int, site: int, value: float, passed: bool, test_txt: str,
            lo: float | None = None, hi: float | None = None,
            units: str = '', first: bool = False) -> bytes:
    test_flg = 0x00 if passed else 0x80
    if first and (lo is not None or hi is not None):
        has_lo = lo is not None
        has_hi = hi is not None
        opt_flag = 0x00
        if not has_lo: opt_flag |= 0x40
        if not has_hi: opt_flag |= 0x80
        optional = (
            b1(opt_flag) + b1(0) + b1(0) + b1(0) +
            r4(lo if has_lo else 0.0) +
            r4(hi if has_hi else 0.0) +
            cn(units) + cn('') + cn('') + cn('')
        )
    else:
        optional = b''
    body = (
        u4(test_num) + u1(1) + u1(site) +
        b1(test_flg) + b1(0x00) +
        r4(value) +
        cn(test_txt) + cn('') +
        optional
    )
    return record(*PTR, body)

# ── Wafer geometry ────────────────────────────────────────────────────────────

def wafer_dies(radius: int = 8) -> list[tuple[int, int]]:
    return [
        (x, y)
        for y in range(-radius, radius + 1)
        for x in range(-radius, radius + 1)
        if x*x + y*y <= radius * radius * 1.1
    ]

# ── Correlated test value generation ─────────────────────────────────────────
#
# All values derived from a single latent "process" variable z ~ N(0,1).
# Each test is a linear combination of z + independent noise, giving
# controlled Pearson r between any pair.

def gen_test_values(edge: bool) -> dict[int, tuple[float, bool]]:
    """Return {test_num: (value, passed)} for one die."""

    # Latent process variable: 0 = nominal, ±1 = ±1σ process shift
    z = random.gauss(0, 1)
    n = lambda s: random.gauss(0, s)  # independent noise

    # leakage_nA: centre 2.5, range 0-8; z drives +direction
    leakage = 2.5 + z * 1.2 + n(0.4)
    if edge: leakage += random.gauss(2.5, 0.8)  # edge ring = leakier

    # ron_ohm: positively correlated with leakage (r~+0.85)
    ron = 120 + (leakage - 2.5) * 18 + n(8)

    # freq_MHz: negatively correlated with leakage (r~-0.80)
    freq = 2000 - (leakage - 2.5) * 55 + n(25)

    # idd_uA: negatively correlated with ron (r~-0.75); also has leakage component
    idd = 850 - (ron - 120) * 2.0 - (leakage - 2.5) * 15 + n(30)

    # vth_mV: weakly correlated with leakage (r~+0.30)
    vth = 280 + (leakage - 2.5) * 8 + n(25)

    # noise_mV: purely random, uncorrelated with everything
    noise = random.gauss(50.0, 15.0)

    SPECS = {
        1001: (leakage, 0.0,   7.0),   # leakage_nA  LSL=0 USL=7
        1002: (ron,     80.0,  200.0), # ron_ohm     LSL=80 USL=200
        1003: (freq,    1700.0, 2300.0), # freq_MHz   LSL=1700 USL=2300
        1004: (idd,     600.0, 1100.0), # idd_uA     LSL=600 USL=1100
        1005: (vth,     220.0, 360.0),  # vth_mV     LSL=220 USL=360
        1006: (noise,   10.0,  90.0),   # noise_mV   LSL=10 USL=90
    }
    return {
        tnum: (val, lo <= val <= hi)
        for tnum, (val, lo, hi) in SPECS.items()
    }

# ── Test metadata ─────────────────────────────────────────────────────────────

TESTS = [
    # (test_num, name, units, lo, hi)
    (1001, 'leakage_nA',  'nA',   0.0,    7.0),
    (1002, 'ron_ohm',     'ohm',  80.0,   200.0),
    (1003, 'freq_MHz',    'MHz',  1700.0, 2300.0),
    (1004, 'idd_uA',      'uA',   600.0,  1100.0),
    (1005, 'vth_mV',      'mV',   220.0,  360.0),
    (1006, 'noise_mV',    'mV',   10.0,   90.0),
]

SITES  = [1, 2, 3, 4]
WAFERS = ['W01', 'W02', 'W03', 'W04', 'W05']

# ── Main ──────────────────────────────────────────────────────────────────────

def generate(output_path: Path) -> None:
    buf = bytearray()
    buf += far()
    buf += mir('LOT-CORR-001')
    buf += sdr(SITES)

    dies = wafer_dies(8)
    part_counter = 1

    for wafer_id in WAFERS:
        buf += wir(wafer_id)
        part_cnt = 0
        good_cnt = 0

        for batch_start in range(0, len(dies), len(SITES)):
            batch = dies[batch_start: batch_start + len(SITES)]

            for site_idx, _ in enumerate(batch):
                buf += pir(SITES[site_idx])

            for site_idx, (x, y) in enumerate(batch):
                site = SITES[site_idx]
                edge = math.sqrt(x * x + y * y) > 6.5

                values = gen_test_values(edge)
                failed_tests = [t for t, (_, p) in values.items() if not p]

                is_first = (batch_start == 0 and site_idx == 0)
                for tnum, tname, units, lo, hi in TESTS:
                    val, passed = values[tnum]
                    buf += ptr_rec(tnum, site, val, passed, tname,
                                   lo, hi, units, first=is_first)

                die_passed = len(failed_tests) == 0
                hbin = 1 if die_passed else (2 if len(failed_tests) == 1 else 3)
                buf += prr(site, x, y, hbin, hbin, part_counter, die_passed)
                part_counter += 1
                part_cnt += 1
                if die_passed:
                    good_cnt += 1

        buf += wrr(wafer_id, part_cnt, good_cnt)

    output_path.write_bytes(buf)
    total_dies = len(WAFERS) * len(dies)
    print(f"Written {len(buf):,} bytes → {output_path}")
    print(f"  {len(WAFERS)} wafers × ~{len(dies)} dies = ~{total_dies} die results")
    print(f"  {len(TESTS)} PTR tests with designed correlations:")
    print(f"    leakage_nA ↔ ron_ohm    r ~ +0.85")
    print(f"    leakage_nA ↔ freq_MHz   r ~ -0.80")
    print(f"    ron_ohm    ↔ idd_uA     r ~ -0.75")
    print(f"    leakage_nA ↔ vth_mV     r ~ +0.30")
    print(f"    noise_mV   ↔ *          r ~  0.00")


if __name__ == '__main__':
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else Path('/tmp/correlated.stdf')
    generate(out)
