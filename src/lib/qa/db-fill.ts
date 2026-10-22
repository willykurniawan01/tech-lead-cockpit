import { e2eRequirements, flowVariables, type VarNeed } from './requirements';
import type { QAEnvironment, QAFlow } from './types';

/**
 * "Every test case ready to execute": the variables that still have no real value (empty, or only
 * the AI's example) are filled from the services' databases by an agent, without manual input.
 * Credentials are the exception: they come from the Keychain, never from a database.
 */

const isTodo = (v: VarNeed) => v.status === 'missing' || v.status === 'example';

/** Per flow id: the variables it uses that have no real value yet, over the whole suite. */
export function notReady(flows: QAFlow[], env?: QAEnvironment): Map<string, string[]> {
  const todo = new Set(e2eRequirements(flows, env).variables.filter(isTodo).map((v) => v.name));
  const out = new Map<string, string[]>();
  for (const f of flows) {
    const missing = [...flowVariables(f)].filter((n) => todo.has(n)).sort();
    if (missing.length) out.set(f.id, missing);
  }
  return out;
}

export interface DbFillPlan {
  /** Filled from a database by the agent. */
  vars: VarNeed[];
  /** Credentials (PIN, password, token): set once in the environment's secret variables. */
  manual: VarNeed[];
  /** Flows that use a variable in `vars`. */
  flowIds: string[];
  instruction: string;
}

export function dbFillPlan(flows: QAFlow[], env?: QAEnvironment): DbFillPlan {
  const todo = e2eRequirements(flows, env).variables.filter(isTodo);
  const vars = todo.filter((v) => !v.sensitive);
  const manual = todo.filter((v) => v.sensitive);
  const names = new Set(vars.map((v) => v.name));
  const flowIds = flows.filter((f) => [...flowVariables(f)].some((n) => names.has(n))).map((f) => f.id);
  // Rules first: a long variable list must never push them out of the instruction.
  const instruction = [
    'Semua test case harus siap dijalankan tanpa nilai yang diisi manual.',
    'Untuk setiap test case di bawah yang memakai variabel dari daftar ini: tambahkan "dataQueries" yang mengambil nilainya dari database service terkait (skema di bagian Database), dengan kondisi yang cocok untuk skenario test case tersebut (status, tanggal berlaku, relasi, saldo), selalu LIMIT 1.',
    'Nilai di blok "variables" flow adalah CONTOH dari AI, bukan data nyata (mis. id "00000001", kode "PLN-20K"): untuk variabel di daftar ini tetap tambahkan "dataQueries" walau sudah ada contohnya; contohnya boleh dibiarkan sebagai cadangan.',
    'Jangan mengubah step, body, atau assertion lain, dan jangan mengganti variabel yang sudah dihasilkan "extract" step/flow sebelumnya.',
    'Jawab HANYA dengan satu objek JSON sesuai format, tanpa penjelasan di luar JSON (penjelasan masuk ke "notes").',
    'Variabel yang datanya memang tidak ada di database (atau harus dibuat lewat API lebih dulu): biarkan, dan sebut di "notes" beserta alasannya.',
    '',
    `Variabel yang belum punya nilai asli (kosong atau masih contoh AI), ${vars.length}:`,
    vars.map((v) => (vars.length <= 40 && v.example ? `{{${v.name}}} (contoh AI: ${v.example.slice(0, 60)})` : `{{${v.name}}}`)).join(', '),
  ].join('\n');
  return { vars, manual, flowIds, instruction };
}
