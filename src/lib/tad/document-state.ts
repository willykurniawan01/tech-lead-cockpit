export interface DocumentStateDef {
  id: string;
  name: string;
  label: string;
  colour: 'Grey' | 'Blue' | 'Green' | 'Yellow' | 'Red';
  description: string;
  step: number;
}

export const TAD_DOCUMENT_STATES: DocumentStateDef[] = [
  {
    id: 'initiate-document',
    name: 'Initiate Document',
    label: 'Inisiasi Dokumen',
    colour: 'Grey',
    description: 'Draft awal TAD sedang disusun oleh Tech Lead',
    step: 1,
  },
  {
    id: 'in-review',
    name: 'In Review',
    label: 'Sedang Direview',
    colour: 'Blue',
    description: 'TAD sedang direview oleh Reviewer & Stakeholder',
    step: 2,
  },
  {
    id: 'approved',
    name: 'Approved',
    label: 'Disetujui',
    colour: 'Green',
    description: 'TAD telah disetujui, siap masuk tahap development',
    step: 3,
  },
  {
    id: 'in-development',
    name: 'In Development',
    label: 'Sedang Dikerjakan',
    colour: 'Yellow',
    description: 'Implementasi task & kode sedang berjalan oleh tim/agent',
    step: 4,
  },
  {
    id: 'testing',
    name: 'Testing',
    label: 'Testing & QA',
    colour: 'Yellow',
    description: 'Development selesai, dalam pengujian QA / UAT',
    step: 5,
  },
  {
    id: 'completed',
    name: 'Completed',
    label: 'Selesai',
    colour: 'Green',
    description: 'Fitur telah selesai, diverifikasi & siap/sudah live',
    step: 6,
  },
];

const ALIASES: Record<string, string> = {
  draft: 'Initiate Document',
  'initiate doc': 'Initiate Document',
  'in-review': 'In Review',
  review: 'In Review',
  approve: 'Approved',
  'in-development': 'In Development',
  'in progress': 'In Development',
  development: 'In Development',
  'in testing': 'Testing',
  qa: 'Testing',
  done: 'Completed',
  complete: 'Completed',
  finish: 'Completed',
};

export function findDocumentStateDef(stateName: string): DocumentStateDef | undefined {
  const norm = (stateName || '').trim().toLowerCase();
  if (!norm) return undefined;
  const canonical = ALIASES[norm] ? ALIASES[norm].toLowerCase() : norm;
  return TAD_DOCUMENT_STATES.find(
    (s) => s.name.toLowerCase() === canonical || s.id.toLowerCase() === canonical || s.label.toLowerCase() === canonical
  );
}

export interface ExtractedDocumentState {
  state: string;
  def?: DocumentStateDef;
  rawText: string;
  isStandard: boolean;
}

/**
 * Extracts Confluence document state from TAD markdown Document Information table.
 */
export function extractDocumentState(markdown: string): ExtractedDocumentState {
  if (!markdown) {
    return {
      state: 'Initiate Document',
      def: TAD_DOCUMENT_STATES[0],
      rawText: '',
      isStandard: true,
    };
  }

  // 1. Prioritize Document Information block to avoid false matches in other sections
  const docInfoMatch = markdown.match(/\|[^\n]*Document Information[^\n]*\|[\s\S]*?(?=\n\s*\n|#|$)/i);
  const searchTarget = docInfoMatch ? docInfoMatch[0] : markdown;

  const stateRowMatch = searchTarget.match(
    /\|\s*(?:\*{0,2}(?:State|Document State|Document Status)\*{0,2})\s*\|\s*([^|\r\n]+)\s*\|/i
  );

  if (stateRowMatch) {
    const rawText = stateRowMatch[1].trim();
    const def = findDocumentStateDef(rawText);
    return {
      state: def ? def.name : rawText,
      def,
      rawText,
      isStandard: Boolean(def),
    };
  }

  return {
    state: 'Initiate Document',
    def: TAD_DOCUMENT_STATES[0],
    rawText: '',
    isStandard: true,
  };
}

/**
 * Updates or inserts the State line in Document Information table.
 * Also updates 'Last Update' date if present and updateDate is true.
 */
export function updateDocumentState(markdown: string, newState: string, updateDate = true): string {
  const todayStr = new Date().toISOString().split('T')[0];
  let md = markdown;

  // Update Last Update date if requested
  if (updateDate) {
    md = md.replace(
      /(\|\s*(?:\*{0,2}Last Update\*{0,2})\s*\|)[^|\r\n]*(\|)/i,
      `$1 ${todayStr} $2`
    );
  }

  const stateRowRegex = /(\|\s*(?:\*{0,2}(?:State|Document State|Document Status)\*{0,2})\s*\|)[^|\r\n]*(\|)/i;

  if (stateRowRegex.test(md)) {
    return md.replace(stateRowRegex, `$1 ${newState} $2`);
  }

  // If no State row found, attempt to insert it inside the Document Information table
  const docInfoTableRegex = /(\|[^\n]*Document Information[^\n]*\|[^\n]*\n\|[-|\s]+\|\n)([\s\S]*?)(\n\s*\n|#|$)/i;
  const match = md.match(docInfoTableRegex);
  if (match) {
    const tableHeader = match[1];
    let body = match[2];
    const tail = match[3];

    // Try to insert after Last Update or Author
    if (/\|\s*(?:\*{0,2}Last Update\*{0,2})\s*\|/i.test(body)) {
      body = body.replace(
        /(\|\s*(?:\*{0,2}Last Update\*{0,2})\s*\|[^\n]+\n)/i,
        `$1| State | ${newState} |\n`
      );
    } else {
      // Append to the table body
      body = body.trimEnd() + `\n| State | ${newState} |`;
    }

    return md.replace(docInfoTableRegex, `${tableHeader}${body}${tail}`);
  }

  // Fallback: if no Document Information table exists at all, prepend one
  return `| **Document Information** |   |\n|---|---|\n| State | ${newState} |\n| Last Update | ${todayStr} |\n\n${md}`;
}

export function getNextDocumentState(currentState: string): DocumentStateDef | undefined {
  const def = findDocumentStateDef(currentState);
  if (!def) return TAD_DOCUMENT_STATES[1]; // default next from unknown/step 1 is In Review
  return TAD_DOCUMENT_STATES.find((s) => s.step === def.step + 1);
}

export function getPrevDocumentState(currentState: string): DocumentStateDef | undefined {
  const def = findDocumentStateDef(currentState);
  if (!def) return undefined;
  return TAD_DOCUMENT_STATES.find((s) => s.step === def.step - 1);
}
