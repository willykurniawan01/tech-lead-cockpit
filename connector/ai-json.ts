/**
 * Reading the JSON object out of an AI reply (prose or a markdown fence around it), shared by the
 * QA, bug and estimate agents. Valid JSON is taken as is; only invalid JSON is repaired.
 */

/** The first JSON object in the reply, tolerating a markdown fence or prose around it. */
export function extractJson(reply: string): unknown {
  const fenced = reply.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const text = (fenced ?? reply).trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('Jawaban AI tidak berisi JSON.');
  const raw = text.slice(start, end + 1);
  // Valid JSON is taken as is: a repair can only make it worse.
  try {
    return JSON.parse(raw);
  } catch {
    // Repaired below.
  }
  const json = repairJson(raw);
  try {
    return JSON.parse(json);
  } catch (e) {
    // Prose before the JSON can hold braces of its own ("{{promoId}} belum punya nilai"): look for
    // a complete object further on; the largest one that parses is the answer.
    const found = balancedObjects(text)
      .sort((a, b) => b.length - a.length)
      .map(tryParse)
      .find((v) => v !== undefined);
    if (found !== undefined) return found;
    const at = Number((e as Error).message.match(/position (\d+)/)?.[1]);
    const near = Number.isFinite(at) ? ` Di sekitar: …${json.slice(Math.max(0, at - 60), at + 40).replace(/\s+/g, ' ')}…` : '';
    throw new Error(`JSON dari AI tidak valid: ${(e as Error).message}.${near}`);
  }
}

function tryParse(raw: string): unknown {
  for (const candidate of [raw, repairJson(raw)]) {
    try {
      const v = JSON.parse(candidate);
      if (v && typeof v === 'object') return v;
    } catch {
      /* next */
    }
  }
  return undefined;
}

/** Every `{ … }` with balanced braces outside strings; `{{name}}` placeholders don't start one. */
function balancedObjects(text: string): string[] {
  const out: string[] = [];
  for (let start = text.indexOf('{'); start >= 0; start = text.indexOf('{', start + 1)) {
    if (text[start + 1] === '{' || text[start - 1] === '{') continue;
    let depth = 0;
    let inString = false;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (inString) {
        if (c === '\\') i++;
        else if (c === '"') inString = false;
        continue;
      }
      if (c === '"') inString = true;
      else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) {
        out.push(text.slice(start, i + 1));
        break;
      }
    }
  }
  return out;
}

/**
 * Fixes what models commonly get wrong: a bare {{variable}} as a JSON value (the runner turns a
 * quoted lone variable back into a number when it holds one) and trailing commas. Only outside
 * strings: a note listing "({{a}}, {{b}}, {{c}})" is text and stays as written.
 */
export function repairJson(text: string): string {
  const bareVar = /\{\{\s*[$\w.-]+\s*(?:\|\s*\w+\s*)?\}\}/y;
  const trailingComma = /,\s*[}\]]/y;
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      out += c;
      if (c === '\\') out += text[++i] ?? '';
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '{' && text[i + 1] === '{') {
      bareVar.lastIndex = i;
      const m = bareVar.exec(text);
      if (m) {
        out += `"${m[0]}"`;
        i += m[0].length - 1;
        continue;
      }
    } else if (c === ',') {
      trailingComma.lastIndex = i;
      if (trailingComma.test(text)) continue;
    }
    out += c;
  }
  return out;
}
