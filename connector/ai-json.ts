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
    const at = Number((e as Error).message.match(/position (\d+)/)?.[1]);
    const near = Number.isFinite(at) ? ` Di sekitar: …${json.slice(Math.max(0, at - 60), at + 40).replace(/\s+/g, ' ')}…` : '';
    throw new Error(`JSON dari AI tidak valid: ${(e as Error).message}.${near}`);
  }
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
