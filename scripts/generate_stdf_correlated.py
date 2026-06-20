#!/usr/bin/env python3
"""Generate a synthetic STDF file with correlated parametric tests.

Produces: 5 wafers, ~200 dies each, 4-site parallel test, 30 PTR tests
spanning a full range of Pearson r values so the correlation matrix and
scatter charts can be visually verified.

Latent variables (all N(0,1), independent):
  z1 — primary process variable (oxide thickness proxy)
  z2 — secondary process variable (doping level proxy)
  z3 — purely random noise

Test design — each test = a*z1 + b*z2 + c*z3 + site_offset + N(0,noise).
The coefficients determine the inter-test correlations:

  Group A (z1-driven, strong positive r with each other, ~0.85–0.95):
    1001 leakage_nA, 1002 ron_ohm, 1003 idsat_uA, 1004 vds_sat_mV, 1005 gm_uS

  Group B (z1-driven negative, strong negative r with group A, ~-0.80 to -0.90):
    1011 freq_MHz, 1012 vth_mV, 1013 ion_uA, 1014 ioff_pA (via -z1)

  Group C (z2-driven, moderate r with each other ~0.5–0.6, weak with A/B):
    1021 cap_fF, 1022 res_kohm, 1023 delay_ps, 1024 swing_mV, 1025 rise_ps

  Group D (mixed z1+z2, weak correlations ~0.2–0.35 with everything):
    1031 vnoise_uV, 1032 inoise_pA, 1033 offset_mV, 1034 gain_dB, 1035 bw_MHz

  Group E (pure noise, r ~ 0 with everything):
    1041 random_1, 1042 random_2, 1043 random_3, 1044 random_4, 1045 random_5

  Extras (site-systematic offsets dominate, creates inter-site but not inter-die r):
    1051 site_vdd_mV, 1052 site_vss_mV, 1053 site_temp_K,
    1054 contact_res_ohm, 1055 probe_leak_nA

Values intentionally exceed spec limits on edge dies — no clamping applied.
Pass/fail is set by spec comparison but the raw measured value is always written.
"""

import struct
import math
import random
import sys
from pathlib import Path

random.seed(42)

# ── STDF record helpers ───────────────────────────────────────────────────────

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
    return struct.pack('<HBB', len(body), rec_typ, rec_sub) + body

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
        cn('corr_test') + cn('2.0') +
        cn('') * 18
    )
    return record(*MIR, body)

def sdr(sites: list[int]) -> bytes:
    body = u1(1) + u1(1) + u1(len(sites)) + b''.join(u1(s) for s in sites) + cn('') * 14
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
        u2(NUM_TESTS) +
        u2(hbin) + u2(sbin) +
        i2(x) + i2(y) +
        u4(100) +
        cn(str(part_id)) + cn('') + b'\x00'
    )
    return record(*PRR, body)

def ptr_rec(test_num: int, site: int, value: float, passed: bool, test_txt: str,
            lo: float | None, hi: float | None, units: str, first: bool) -> bytes:
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

# ── Test definitions ──────────────────────────────────────────────────────────
# (test_num, name, units, lsl, usl, centre, scale, coeff_z1, coeff_z2, coeff_z3, noise_sigma)
# value = centre + scale*(coeff_z1*z1 + coeff_z2*z2 + coeff_z3*z3) + N(0,noise_sigma)
# Values will naturally exceed LSL/USL on edge dies — no clamping.

# Coefficients are chosen so that r between two tests ≈ (c1a*c1b + c2a*c2b + c3a*c3b)
# divided by the product of their total signal magnitudes (before measurement noise).
# Measurement noise (last column) dilutes r; pure-noise tests use noise only.

TESTS = [
    # (test_num, name, units, lsl, usl, centre, scale, coeff_z1, coeff_z2, coeff_z3, noise_sigma)
    # Group A: z1-driven — strong positive r with each other (~0.80–0.92)
    # noise_sigma chosen so signal:noise ≈ 2:1, giving r ~ 0.80–0.90
    (1001, 'leakage_nA',    'nA',    0.0,    8.0,    3.0,   1.5,   1.0,  0.0,  0.0,  1.0),
    (1002, 'ron_ohm',       'ohm',  80.0,  200.0,  130.0,  20.0,   1.0,  0.0,  0.0, 13.0),
    (1003, 'idsat_uA',      'uA',  400.0,  900.0,  650.0,  80.0,   1.0,  0.0,  0.0, 50.0),
    (1004, 'vds_sat_mV',    'mV',  100.0,  400.0,  240.0,  50.0,   1.0,  0.0,  0.0, 32.0),
    (1005, 'gm_uS',         'uS',  500.0, 1200.0,  850.0, 120.0,   1.0,  0.0,  0.0, 77.0),
    # Group B: driven by -z1 — strong negative r vs group A (~-0.80 to -0.88)
    (1011, 'freq_MHz',      'MHz', 1600.0, 2400.0, 2000.0, 120.0,  -1.0,  0.0,  0.0, 77.0),
    (1012, 'vth_mV',        'mV',  220.0,  420.0,  320.0,  40.0,  -1.0,  0.0,  0.0, 26.0),
    (1013, 'ion_ratio',     '',      0.5,    2.5,    1.5,   0.3,   -1.0,  0.0,  0.0,  0.19),
    (1014, 'ioff_pA',       'pA',    0.0,   50.0,   15.0,   8.0,  -1.0,  0.0,  0.0,  5.1),
    # Group C: z2-driven — moderate r within group (~0.55–0.70), near-zero with A/B
    # noise_sigma chosen so signal:noise ≈ 1:1, giving r ~ 0.50
    (1021, 'cap_fF',        'fF',   80.0,  160.0,  120.0,  15.0,   0.0,  1.0,  0.0, 15.0),
    (1022, 'res_kohm',      'kohm',  5.0,   25.0,   15.0,   3.0,   0.0,  1.0,  0.0,  3.0),
    (1023, 'delay_ps',      'ps',   50.0,  200.0,  120.0,  25.0,   0.0,  1.0,  0.0, 25.0),
    (1024, 'swing_mV',      'mV',  400.0,  900.0,  650.0,  80.0,   0.0,  1.0,  0.0, 80.0),
    (1025, 'rise_ps',       'ps',   20.0,  100.0,   55.0,  12.0,   0.0,  1.0,  0.0, 12.0),
    # Group D: small z1+z2 signal — weak r (~0.20–0.35) with A, B, C, and each other
    # signal fraction 0.35 of z1+z2, large noise keeps r low
    (1031, 'vnoise_uV',     'uV',    0.0,   50.0,   20.0,   6.0,   0.35, 0.35, 0.0,  7.5),
    (1032, 'inoise_pA',     'pA',    0.0,   30.0,   12.0,   4.0,   0.35, 0.35, 0.0,  5.0),
    (1033, 'offset_mV',     'mV',  -20.0,   20.0,    0.0,   5.0,   0.35, 0.35, 0.0,  6.2),
    (1034, 'gain_dB',       'dB',   15.0,   35.0,   25.0,   3.0,   0.35, 0.35, 0.0,  3.7),
    (1035, 'bw_MHz',        'MHz',  50.0,  200.0,  120.0,  20.0,   0.35, 0.35, 0.0, 25.0),
    # Group E: independent noise per test — r ~ 0 with everything including each other
    (1041, 'random_1',      '',      0.0,  100.0,   50.0,  15.0,   0.0,  0.0,  0.0, 15.0),
    (1042, 'random_2',      '',      0.0,  100.0,   50.0,  15.0,   0.0,  0.0,  0.0, 15.0),
    (1043, 'random_3',      'mV',    0.0,   10.0,    5.0,   1.5,   0.0,  0.0,  0.0,  1.5),
    (1044, 'random_4',      'nA',    0.0,    5.0,    2.5,   0.8,   0.0,  0.0,  0.0,  0.8),
    (1045, 'random_5',      'ohm',   0.0,  500.0,  250.0,  70.0,   0.0,  0.0,  0.0, 70.0),
    # Group F: site-systematic offset plus large die-to-die variation — r ~ 0 between tests
    # Site offset is small relative to per-die noise so inter-test r stays near zero
    (1051, 'site_vdd_mV',   'mV',  990.0, 1010.0, 1000.0,  0.5,   0.0,  0.0,  0.0,  2.5),
    (1052, 'site_vss_mV',   'mV',   -5.0,    5.0,    0.0,   0.5,   0.0,  0.0,  0.0,  2.5),
    (1053, 'site_temp_K',   'K',   295.0,  305.0,  300.0,   0.5,   0.0,  0.0,  0.0,  2.5),
    (1054, 'contact_res',   'ohm',   0.0,   10.0,    2.0,   1.0,   0.0,  0.0,  0.0,  2.5),
    (1055, 'probe_leak_nA', 'nA',    0.0,    5.0,    0.5,   0.3,   0.0,  0.0,  0.0,  0.3),
    # Extra: strongly correlated with group A (~+0.90)
    (1061, 'vref_mV',       'mV',  490.0,  510.0,  500.0,   3.0,   1.0,  0.0,  0.0,  0.35),
]

NUM_TESTS = len(TESTS)

# Per-site systematic offsets (fixed per site, vary between sites)
SITE_OFFSETS = {
    1: {'vdd': +2.1, 'vss': +0.3, 'temp': +1.2, 'contact': +0.8},
    2: {'vdd': -1.4, 'vss': -0.5, 'temp': -0.9, 'contact': +1.5},
    3: {'vdd': +0.7, 'vss': +0.8, 'temp': +0.3, 'contact': +0.2},
    4: {'vdd': -1.4, 'vss': -0.6, 'temp': -0.6, 'contact': +2.1},
}

SITES  = [1, 2, 3, 4]
WAFERS = ['W01', 'W02', 'W03', 'W04', 'W05']

# ── Value generation ──────────────────────────────────────────────────────────

def gen_die_values(edge: bool, site: int) -> dict[int, tuple[float, bool]]:
    """Return {test_num: (value, passed)} for one die. Values are never clamped."""
    z1 = random.gauss(0, 1)
    z2 = random.gauss(0, 1)
    if edge:
        z1 += random.gauss(1.5, 0.5)  # edge bias: shifted process

    so = SITE_OFFSETS[site]
    result = {}
    for tnum, name, units, lsl, usl, centre, scale, c1_, c2, c3, noise in TESTS:
        # Systematic site contribution for the site-monitor tests (dominates die-to-die variation)
        site_contrib = 0.0
        if tnum == 1051: site_contrib = so['vdd']
        elif tnum == 1052: site_contrib = so['vss']
        elif tnum == 1053: site_contrib = so['temp']
        elif tnum == 1054: site_contrib = so['contact']

        # Each test gets its own independent measurement noise draw
        meas_noise = random.gauss(0, noise) if noise > 0 else 0.0

        val = centre + scale * (c1_*z1 + c2*z2) + site_contrib + meas_noise
        passed = val >= lsl and val <= usl
        result[tnum] = (val, passed)
    return result

# ── Main ──────────────────────────────────────────────────────────────────────

def generate(output_path: Path) -> None:
    buf = bytearray()
    buf += far()
    buf += mir('LOT-CORR-002')
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

                values = gen_die_values(edge, site)
                failed_tests = [t for t, (_, p) in values.items() if not p]
                is_first = (batch_start == 0 and site_idx == 0)

                for tnum, tname, units, lsl, usl, *_ in TESTS:
                    val, passed = values[tnum]
                    buf += ptr_rec(tnum, site, val, passed, tname,
                                   lsl, usl, units, first=is_first)

                die_passed = len(failed_tests) == 0
                hbin = 1 if die_passed else (2 if len(failed_tests) <= 2 else 3)
                buf += prr(site, x, y, hbin, hbin, part_counter, die_passed)
                part_counter += 1
                part_cnt += 1
                if die_passed: good_cnt += 1

        buf += wrr(wafer_id, part_cnt, good_cnt)

    output_path.write_bytes(buf)
    total_dies = len(WAFERS) * len(dies)
    print(f"Written {len(buf):,} bytes → {output_path}")
    print(f"  {len(WAFERS)} wafers × ~{len(dies)} dies = ~{total_dies} die results")
    print(f"  {NUM_TESTS} PTR tests spanning strong/moderate/weak/zero correlations")
    print(f"  No value clamping — values may exceed spec limits naturally")
    print()
    print(f"  Expected r ranges:")
    print(f"    Group A (1001–1005): strong positive  r ~ +0.75 to +0.95")
    print(f"    Group B (1011–1014): strong negative  r ~ -0.70 to -0.90 vs group A")
    print(f"    Group C (1021–1025): moderate         r ~ +0.45 to +0.65 within group")
    print(f"    Group D (1031–1035): weak             r ~ +0.15 to +0.35")
    print(f"    Group E (1041–1045): near zero        r ~  0.00")
    print(f"    Group F (1051–1055): site-systematic  r ~  0.00 to +0.10 inter-die")
    print(f"    1061 vref_mV:        strong positive  r ~ +0.90 vs group A")


if __name__ == '__main__':
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else Path('/tmp/correlated.stdf')
    generate(out)
