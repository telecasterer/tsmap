import type { DieResult } from '@paulrobins/wafermap';

export interface TestDef {
  name: string;
  testType: 'P' | 'F';
  loLimit?: number;
  hiLimit?: number;
  units?: string;
}

export interface WaferData {
  waferId: string;
  results: DieResult[];
  partCount?: number;
  goodCount?: number;
  failCount?: number;
}

export interface LotMeta {
  lotId?: string;
  partType?: string;
  jobName?: string;
  testerType?: string;
  nodeName?: string;
  sublotId?: string;
}

export interface ParsedFile {
  fileName: string;
  meta: LotMeta;
  wafers: WaferData[];
  testDefs: Record<string, TestDef>;
}
