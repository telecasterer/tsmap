#!/usr/bin/env python3
"""Generate a synthetic ATDF file for testing the tsmap parser.
3 wafers, ~200 dies, 4-site parallel test, 3 PTR + 1 FTR tests.
"""
import math, random, sys
from pathlib import Path

random.seed(42)

DELIM = '|'
TESTS = [
    (1001, 'leakage_nA',  'nA',  0.0,   5.0),
    (1002, 'vth_mV',      'mV',  180.0, 380.0),
    (1003, 'freq_MHz',    'MHz', 1800.0, 2200.0),
]
FT_NUM, FT_NAME = 2001, 'scan_chain'
SITES  = [1, 2, 3, 4]
WAFERS = ['W01', 'W02', 'W03']

def rec(name: str, *fields) -> str:
    return f"{name}:{DELIM.join(str(f) for f in fields)}"

def wafer_dies(radius=8):
    return [(x, y) for y in range(-radius, radius+1)
                   for x in range(-radius, radius+1)
                   if x*x + y*y <= radius*radius * 1.1]

def generate(out: Path):
    lines = []
    lines.append(rec('FAR', 'A' + DELIM + '4'))  # FAR:A|4  (delim=|, ver=4)
    lines.append(rec('MIR', 'LOT-001','CHIP-X','test_program','node-01','UltraTester-9000'))
    lines.append(rec('SDR', '1','1', f'1{DELIM}2{DELIM}3{DELIM}4'))  # head, grp, sites

    dies = wafer_dies(8)
    part_id = 1

    for wafer_id in WAFERS:
        lines.append(rec('WIR', '1', '0', '1', wafer_id))
        part_cnt = good_cnt = 0

        for batch_start in range(0, len(dies), len(SITES)):
            batch = dies[batch_start:batch_start+len(SITES)]
            for si, (x, y) in enumerate(batch):
                site = SITES[si]
                lines.append(rec('PIR', '1', site))

            for si, (x, y) in enumerate(batch):
                site = SITES[si]
                edge = math.sqrt(x*x + y*y) > 6.5
                failed = []

                for tnum, tname, units, lo, hi in TESTS:
                    centre = (lo+hi)/2
                    value  = random.gauss(centre, (hi-lo)*0.15)
                    if edge and random.random() < 0.15:
                        value = hi * 1.1
                    passed = lo <= value <= hi
                    if not passed: failed.append(tnum)
                    pf = 'P' if passed else 'F'
                    # PTR: TEST_NUM|HEAD|SITE|RESULT|Pass/Fail|AlarmFlags|TEST_TXT|ALARM_ID|LimitCompare|UNITS|LO_LIMIT|HI_LIMIT
                    if batch_start == 0 and si == 0:
                        lines.append(rec('PTR', tnum,'1',site,f'{value:.4f}',pf,'','',tname,'','',units,lo,hi))
                    else:
                        lines.append(rec('PTR', tnum,'1',site,f'{value:.4f}',pf))

                ft_pass = not (edge and random.random() < 0.05)
                if not ft_pass: failed.append(FT_NUM)
                lines.append(rec('FTR', FT_NUM,'1',site,'P' if ft_pass else 'F'))

                die_pass = len(failed) == 0
                hbin = 1 if die_pass else (2 if len(failed)==1 else 3)
                sbin = hbin
                pf = 'P' if die_pass else 'F'
                # PRR: HEAD|SITE|PART_ID|NUM_TEST|Pass/Fail|HARD_BIN|SOFT_BIN|X|Y
                lines.append(rec('PRR', '1',site,part_id,4,pf,hbin,sbin,x,y))
                part_id += 1
                part_cnt += 1
                if die_pass: good_cnt += 1

        lines.append(rec('WRR', '1','0',part_cnt,wafer_id,'1','0',good_cnt))

    out.write_text('\n'.join(lines) + '\n')
    print(f"Written {out} — {len(WAFERS)} wafers × ~{len(dies)} dies")

if __name__ == '__main__':
    generate(Path(sys.argv[1]) if len(sys.argv) > 1 else Path('/tmp/test.atdf'))
