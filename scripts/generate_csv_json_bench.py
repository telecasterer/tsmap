#!/usr/bin/env python3
"""Generate wide-format CSV + JSON bench fixtures for the tsmap parsers.

Mirrors the STDF bench scale so the four parsers can be compared on equivalent
logical data: WAFERS × DIES_PER_WAFER dies, each with X/Y/hbin/sbin/site/lot/wafer
plus N_TESTS parametric test-value columns.

Writes:
    /tmp/bench.csv
    /tmp/bench.json   (array of flat row objects — the shape json_headers expects)

Usage:
    python3 scripts/generate_csv_json_bench.py [wafers] [dies_per_wafer] [tests]
    (defaults: 10 wafers × 5000 dies × 50 tests = 50k dies)
"""

import json
import random
import sys

random.seed(42)

WAFERS = int(sys.argv[1]) if len(sys.argv) > 1 else 10
DIES_PER_WAFER = int(sys.argv[2]) if len(sys.argv) > 2 else 5000
N_TESTS = int(sys.argv[3]) if len(sys.argv) > 3 else 50

TEST_NUMS = [1000 + i for i in range(N_TESTS)]
TEST_COLS = [f"t{n}" for n in TEST_NUMS]
GRID = 1  # dies laid out on a square-ish grid per wafer
side = max(1, int(DIES_PER_WAFER ** 0.5))


def rows():
    """Yield one dict per die (flat row), across all wafers."""
    for w in range(1, WAFERS + 1):
        wid = f"W{w:02d}"
        for i in range(DIES_PER_WAFER):
            x = i % side
            y = i // side
            hbin = 1 if random.random() < 0.92 else random.choice([2, 3, 4, 5])
            sbin = hbin
            site = i % 4
            row = {
                "wafer": wid,
                "lot": "LOT-BENCH-01",
                "x": x,
                "y": y,
                "hbin": hbin,
                "sbin": sbin,
                "site": site,
            }
            for n, col in zip(TEST_NUMS, TEST_COLS):
                # Realistic-ish parametric values: mostly tight, occasional outlier.
                row[col] = round(random.gauss(1.0 + (n - 1000) * 0.01, 0.05), 4)
            yield row


def write_csv(path):
    cols = ["wafer", "lot", "x", "y", "hbin", "sbin", "site"] + TEST_COLS
    n = 0
    with open(path, "w") as f:
        f.write(",".join(cols) + "\n")
        for row in rows():
            f.write(",".join(str(row[c]) for c in cols) + "\n")
            n += 1
    return n, path


def write_json(path):
    data = list(rows())
    with open(path, "w") as f:
        json.dump(data, f)
    return len(data), path


if __name__ == "__main__":
    import os

    n_csv, p_csv = write_csv("/tmp/bench.csv")
    n_json, p_json = write_json("/tmp/bench.json")
    for n, p in ((n_csv, p_csv), (n_json, p_json)):
        mb = os.path.getsize(p) / 1_048_576
        print(f"{p}: {n:,} dies, {N_TESTS} tests, {mb:.1f} MB")
    print(f"({WAFERS} wafers × {DIES_PER_WAFER} dies × {N_TESTS} tests)")
