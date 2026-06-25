#!/usr/bin/env python3
"""Generate a bench-scale ATDF file for parser benchmarking.

Mirrors the CSV/JSON bench fixtures (scripts/generate_csv_json_bench.py) so the
four parsers compare on equivalent logical data: WAFERS × DIES_PER_WAFER dies,
each with N_TESTS parametric (PTR) results, plus PIR/PRR per die and WIR/WRR.

Writes /tmp/bench.atdf.

Usage:
    python3 scripts/generate_atdf_bench.py [wafers] [dies_per_wafer] [tests]
    (defaults: 10 wafers × 5000 dies × 50 tests = 50k dies)
"""

import random
import sys
from pathlib import Path

random.seed(42)

DELIM = '|'
WAFERS = int(sys.argv[1]) if len(sys.argv) > 1 else 10
DIES_PER_WAFER = int(sys.argv[2]) if len(sys.argv) > 2 else 5000
N_TESTS = int(sys.argv[3]) if len(sys.argv) > 3 else 50

TEST_NUMS = [1000 + i for i in range(N_TESTS)]
SITES = [0, 1, 2, 3]
side = max(1, int(DIES_PER_WAFER ** 0.5))


def rec(name, *fields):
    return f"{name}:{DELIM.join(str(f) for f in fields)}"


def generate(out: Path):
    lines = [
        rec('FAR', 'A', '4'),
        rec('MIR', 'LOT-BENCH-01', 'CHIP-X', 'test_program', 'node-01', 'UltraTester-9000'),
        rec('SDR', '1', '1', f'1{DELIM}2{DELIM}3{DELIM}4'),
    ]
    part_id = 1
    for w in range(1, WAFERS + 1):
        wid = f"W{w:02d}"
        lines.append(rec('WIR', '1', '0', '1', wid))
        part_cnt = good_cnt = 0
        for i in range(DIES_PER_WAFER):
            x = i % side
            y = i // side
            site = SITES[i % len(SITES)]
            lines.append(rec('PIR', '1', site))
            failed = 0
            for n in TEST_NUMS:
                value = random.gauss(1.0 + (n - 1000) * 0.01, 0.05)
                passed = 0.5 <= value <= 1.8
                if not passed:
                    failed += 1
                pf = 'P' if passed else 'F'
                # First die of wafer emits full PTR (with limits/units); rest are short.
                if i == 0:
                    lines.append(rec('PTR', n, '1', site, f'{value:.4f}', pf, '', '',
                                     f't{n}', '', '', 'V', 0.5, 1.8))
                else:
                    lines.append(rec('PTR', n, '1', site, f'{value:.4f}', pf))
            die_pass = failed == 0
            hbin = 1 if die_pass else 2
            sbin = hbin
            pf = 'P' if die_pass else 'F'
            lines.append(rec('PRR', '1', site, part_id, N_TESTS, pf, hbin, sbin, x, y))
            part_id += 1
            part_cnt += 1
            if die_pass:
                good_cnt += 1
        lines.append(rec('WRR', '1', '0', part_cnt, wid, '1', '0', good_cnt))

    out.write_text('\n'.join(lines) + '\n')
    mb = out.stat().st_size / 1_048_576
    print(f"{out}: {WAFERS * DIES_PER_WAFER:,} dies, {N_TESTS} tests, {mb:.1f} MB "
          f"({WAFERS} wafers × {DIES_PER_WAFER} dies)")


if __name__ == "__main__":
    generate(Path(sys.argv[4]) if len(sys.argv) > 4 else Path('/tmp/bench.atdf'))
