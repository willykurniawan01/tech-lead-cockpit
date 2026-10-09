<script lang="ts">
  import { untrack } from 'svelte';
  import Icon from '../components/Icon.svelte';
  import { toasts } from '../components/toast.svelte';
  import { htmlToMarkdown } from '../lib/markdown/html-to-markdown';
  import { renderPreview } from '../lib/markdown/preview';
  import { extractTadHeadings, type TadHeading } from '../lib/tad/headings';

  let {
    value,
    readOnly = false,
    onchange,
    onsave,
    onrequestedit,
  }: {
    value: string;
    readOnly?: boolean;
    onchange: (value: string) => void;
    onsave?: () => void;
    onrequestedit?: () => void;
  } = $props();

  type EditorMode = 'word' | 'markdown';
  const MODE_STORAGE_KEY = 'tlc.tad.editorViewMode';

  function initialMode(): EditorMode {
    try {
      const saved = localStorage.getItem(MODE_STORAGE_KEY);
      return saved === 'markdown' ? 'markdown' : 'word';
    } catch {
      return 'word';
    }
  }

  let mode = $state<EditorMode>(initialMode());
  let pageEl: HTMLDivElement | undefined = $state();
  let ta: HTMLTextAreaElement | undefined = $state();

  let isTyping = false;
  let typingTimer: any = null;
  let lastEmittedMarkdown = untrack(() => value);

  // Table context state: true if cursor is currently inside a table
  let inTable = $state(false);
  let activeBlock = $state('p');

  // ---- Outline & Heading Navigation State ----
  let outlineOpen = $state(false);
  let headingQuery = $state('');
  let activeHeadingId = $state<string | null>(null);
  const headings = $derived(extractTadHeadings(value));
  const filteredHeadings = $derived.by(() => {
    const q = headingQuery.trim().toLowerCase();
    if (!q) return headings;
    return headings.filter(
      (h) => h.text.toLowerCase().includes(q) || (h.taskType && h.taskType.toLowerCase().includes(q))
    );
  });

  // ---- Find / Search Word State ----
  let findOpen = $state(false);
  let findQuery = $state('');
  let findMatchCase = $state(false);
  let currentMatchIndex = $state(0);
  let totalMatches = $state(0);
  let findInputEl: HTMLInputElement | undefined = $state();
  let findDebounceTimer: any = null;
  let hasNavigated = $state(false);

  interface WordMatch {
    node: Text;
    start: number;
    end: number;
  }
  let currentWordMatches: WordMatch[] = [];
  let currentMdIndices: number[] = [];

  function setMode(m: EditorMode) {
    if (m === mode) return;
    if (mode === 'word' && pageEl && !readOnly) {
      // Sync from Word to markdown before switching
      const md = htmlToMarkdown(pageEl);
      lastEmittedMarkdown = md;
      onchange(md);
    }
    mode = m;
    try {
      localStorage.setItem(MODE_STORAGE_KEY, m);
    } catch {
      /* ignore */
    }
    if (m === 'word') {
      // Give DOM time to mount pageEl then render
      requestAnimationFrame(() => {
        if (pageEl) {
          pageEl.innerHTML = renderPreview(value).html;
          if (findOpen && findQuery) performFind('current', false);
        }
      });
    } else {
      if (findOpen && findQuery) {
        requestAnimationFrame(() => performFind('current', false));
      }
    }
  }

  // Update paper HTML when external value changes and user is not actively typing
  $effect(() => {
    const md = value;
    if (mode === 'word' && pageEl && !isTyping) {
      if (md !== lastEmittedMarkdown) {
        lastEmittedMarkdown = md;
        pageEl.innerHTML = renderPreview(md).html;
      }
    }
  });

  // Mount initial content on pageEl
  $effect(() => {
    if (pageEl && mode === 'word' && !pageEl.innerHTML) {
      pageEl.innerHTML = renderPreview(value).html;
    }
  });

  function handleWordInput() {
    if (readOnly) return;
    isTyping = true;
    clearTimeout(typingTimer);
    updateSelectionContext();

    typingTimer = setTimeout(() => {
      isTyping = false;
      if (pageEl) {
        const md = htmlToMarkdown(pageEl);
        lastEmittedMarkdown = md;
        onchange(md);
        if (findOpen && findQuery) performFind('current', false);
      }
    }, 250);
  }

  function handleWordBlur() {
    if (readOnly) return;
    clearTimeout(typingTimer);
    isTyping = false;
    if (pageEl) {
      const md = htmlToMarkdown(pageEl);
      if (md !== lastEmittedMarkdown) {
        lastEmittedMarkdown = md;
        onchange(md);
      }
    }
  }

  // ---- Selection & Context Detection ----

  function updateSelectionContext() {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) {
      inTable = false;
      return;
    }
    let node: Node | null = sel.getRangeAt(0).startContainer;
    let foundTable = false;
    let foundBlock = 'p';

    while (node && node !== pageEl && node !== document.body) {
      if (node.nodeName === 'TD' || node.nodeName === 'TH' || node.nodeName === 'TABLE') {
        foundTable = true;
      }
      if (/^H[1-6]$/.test(node.nodeName)) {
        foundBlock = node.nodeName.toLowerCase();
      } else if (node.nodeName === 'PRE') {
        foundBlock = 'pre';
      }
      node = node.parentNode;
    }
    inTable = foundTable;
    activeBlock = foundBlock;
  }

  // ---- Formatting Actions ----

  function exec(command: string, arg?: string) {
    if (readOnly) return;
    pageEl?.focus();
    document.execCommand(command, false, arg);
    handleWordInput();
  }

  function setBlockFormat(e: Event) {
    if (readOnly) return;
    const tag = (e.target as HTMLSelectElement).value;
    if (tag === 'p') {
      exec('formatBlock', '<p>');
    } else if (tag.startsWith('h')) {
      exec('formatBlock', `<${tag}>`);
    } else if (tag === 'pre') {
      exec('formatBlock', '<pre>');
    }
  }

  function toggleCode() {
    if (readOnly) return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return;
    const range = sel.getRangeAt(0);
    const parent = range.commonAncestorContainer.parentElement;
    if (parent && parent.tagName === 'CODE') {
      const text = document.createTextNode(parent.textContent || '');
      parent.replaceWith(text);
    } else {
      const code = document.createElement('code');
      code.textContent = sel.toString();
      range.deleteContents();
      range.insertNode(code);
    }
    handleWordInput();
  }

  // ---- Table Manipulation ----

  function getTableContext(): { table: HTMLTableElement; row: HTMLTableRowElement; cell: HTMLTableCellElement } | null {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return null;
    let node: Node | null = sel.getRangeAt(0).startContainer;
    let cell: HTMLTableCellElement | null = null;
    let row: HTMLTableRowElement | null = null;
    let table: HTMLTableElement | null = null;

    while (node && node !== pageEl && node !== document.body) {
      if (!cell && (node.nodeName === 'TD' || node.nodeName === 'TH')) {
        cell = node as HTMLTableCellElement;
      }
      if (!row && node.nodeName === 'TR') {
        row = node as HTMLTableRowElement;
      }
      if (!table && node.nodeName === 'TABLE') {
        table = node as HTMLTableElement;
        break;
      }
      node = node.parentNode;
    }
    return table && row && cell ? { table, row, cell } : null;
  }

  function insertTable(cols = 3, rows = 3) {
    if (readOnly) return;
    pageEl?.focus();
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return;

    const table = document.createElement('table');
    const thead = document.createElement('thead');
    const trHead = document.createElement('tr');
    for (let c = 1; c <= cols; c++) {
      const th = document.createElement('th');
      th.textContent = `Kolom ${c}`;
      trHead.appendChild(th);
    }
    thead.appendChild(trHead);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    for (let r = 1; r < rows; r++) {
      const tr = document.createElement('tr');
      for (let c = 1; c <= cols; c++) {
        const td = document.createElement('td');
        td.innerHTML = '<p><br></p>';
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);

    const range = sel.getRangeAt(0);
    range.deleteContents();
    range.insertNode(table);

    // Place cursor in first header cell
    const firstTh = trHead.firstElementChild as HTMLElement;
    if (firstTh) {
      sel.selectAllChildren(firstTh);
      sel.collapseToEnd();
    }
    handleWordInput();
  }

  function addTableRow() {
    if (readOnly) return;
    const ctx = getTableContext();
    if (!ctx) return;
    const { row } = ctx;
    const cols = row.children.length;
    const newTr = document.createElement('tr');
    for (let i = 0; i < cols; i++) {
      const td = document.createElement('td');
      td.innerHTML = '<p><br></p>';
      newTr.appendChild(td);
    }
    row.after(newTr);

    const firstTd = newTr.firstElementChild as HTMLElement;
    if (firstTd) {
      const sel = window.getSelection();
      sel?.selectAllChildren(firstTd);
      sel?.collapseToStart();
    }
    handleWordInput();
  }

  function deleteTableRow() {
    if (readOnly) return;
    const ctx = getTableContext();
    if (!ctx) return;
    const { table, row } = ctx;
    row.remove();
    if (!table.querySelectorAll('tr').length) {
      table.remove();
    }
    handleWordInput();
  }

  function addTableColumn() {
    if (readOnly) return;
    const ctx = getTableContext();
    if (!ctx) return;
    const { table, cell } = ctx;
    const colIndex = Array.from(cell.parentElement?.children || []).indexOf(cell);
    if (colIndex < 0) return;

    for (const tr of table.querySelectorAll('tr')) {
      const isHeader = tr.parentElement?.tagName === 'THEAD' || tr.querySelector('th') !== null;
      const newCell = document.createElement(isHeader ? 'th' : 'td');
      newCell.innerHTML = isHeader ? 'Kolom Baru' : '<p><br></p>';
      const targetCell = tr.children[colIndex];
      if (targetCell) {
        targetCell.after(newCell);
      } else {
        tr.appendChild(newCell);
      }
    }
    handleWordInput();
  }

  function deleteTableColumn() {
    if (readOnly) return;
    const ctx = getTableContext();
    if (!ctx) return;
    const { table, cell } = ctx;
    const colIndex = Array.from(cell.parentElement?.children || []).indexOf(cell);
    if (colIndex < 0) return;

    for (const tr of table.querySelectorAll('tr')) {
      if (tr.children[colIndex]) {
        tr.children[colIndex].remove();
      }
    }
    const remaining = table.querySelector('tr')?.children.length ?? 0;
    if (remaining === 0) {
      table.remove();
    }
    handleWordInput();
  }

  function deleteTable() {
    if (readOnly) return;
    const ctx = getTableContext();
    if (!ctx) return;
    ctx.table.remove();
    handleWordInput();
  }

  // ---- Callout & Special Inserts ----

  function insertCallout(kind: 'info' | 'tip' | 'note' | 'warning') {
    if (readOnly) return;
    pageEl?.focus();
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return;

    const labels: Record<string, string> = {
      info: 'INFO',
      tip: 'TIP',
      note: 'CATATAN',
      warning: 'PERINGATAN',
    };

    const callout = document.createElement('div');
    callout.className = `callout callout-${kind}`;
    callout.innerHTML = `
      <div class="callout-title" contenteditable="false">${labels[kind]}</div>
      <p>Tulis catatan di sini...</p>
    `;

    const range = sel.getRangeAt(0);
    range.deleteContents();
    range.insertNode(callout);

    const p = callout.querySelector('p');
    if (p) {
      sel.selectAllChildren(p);
      sel.collapseToEnd();
    }
    handleWordInput();
  }

  function insertLink() {
    if (readOnly) return;
    const url = prompt('Masukkan URL tautan:');
    if (!url) return;
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) {
      exec('createLink', url);
    } else {
      const a = document.createElement('a');
      a.href = url;
      a.textContent = url;
      sel?.getRangeAt(0).insertNode(a);
      handleWordInput();
    }
  }

  function insertDivider() {
    if (readOnly) return;
    exec('insertHorizontalRule');
  }

  // ---- Keyboard Handling ----

  function handleCommonShortcuts(e: KeyboardEvent): boolean {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      openFind();
      return true;
    }
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'o') {
      e.preventDefault();
      toggleOutline();
      return true;
    }
    if (e.key === 'Escape') {
      if (findOpen) {
        e.preventDefault();
        closeFind();
        return true;
      }
    }
    return false;
  }

  function onWordKeyDown(e: KeyboardEvent) {
    if (handleCommonShortcuts(e)) return;

    if (readOnly) {
      if (
        e.key === 'Enter' ||
        e.key === 'Backspace' ||
        e.key === 'Delete' ||
        (e.key.length === 1 && !e.metaKey && !e.ctrlKey)
      ) {
        e.preventDefault();
        toasts.show('Dokumen dalam mode View Only. Klik "Edit TAD" untuk mengubah isi.', 'info', 2500);
      }
      return;
    }

    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      onsave?.();
      return;
    }

    if (e.key === 'Tab') {
      const ctx = getTableContext();
      if (ctx) {
        e.preventDefault();
        const { table, cell, row } = ctx;
        const allCells = Array.from(table.querySelectorAll('th, td'));
        const currentIndex = allCells.indexOf(cell);

        if (e.shiftKey) {
          // Move to previous cell
          if (currentIndex > 0) {
            const prev = allCells[currentIndex - 1] as HTMLElement;
            window.getSelection()?.selectAllChildren(prev);
          }
        } else {
          // Move to next cell
          if (currentIndex < allCells.length - 1) {
            const next = allCells[currentIndex + 1] as HTMLElement;
            window.getSelection()?.selectAllChildren(next);
          } else {
            // Last cell of table: add a new row automatically (like Word!)
            addTableRow();
          }
        }
        return;
      }
    }
  }

  // ---- Heading & Section Navigation ----

  export function toggleOutline() {
    outlineOpen = !outlineOpen;
  }

  export function scrollToHeading(h: TadHeading) {
    activeHeadingId = h.id;
    if (mode === 'word' && pageEl) {
      const domHeadings = Array.from(pageEl.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6'));
      const targetText = h.text.trim().toLowerCase();

      // 1. Try matching by sectionId if element has id
      let targetEl: HTMLElement | undefined;
      if (h.sectionId) {
        targetEl = domHeadings.find((el) => {
          const id = el.id?.toLowerCase() || '';
          return id === `sec-${h.sectionId}` || id === h.sectionId;
        });
      }

      // 2. Try matching by heading text content
      if (!targetEl) {
        targetEl = domHeadings.find((el) => {
          const text = (el.textContent || '').trim().toLowerCase();
          return text === targetText || text.includes(targetText) || targetText.includes(text);
        });
      }

      // 3. Fallback to index position
      if (!targetEl && domHeadings.length) {
        const index = headings.findIndex((item) => item.id === h.id);
        if (index >= 0 && index < domHeadings.length) {
          targetEl = domHeadings[index];
        }
      }

      if (targetEl) {
        targetEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
        targetEl.classList.remove('heading-jump-highlight');
        void targetEl.offsetWidth; // trigger reflow
        targetEl.classList.add('heading-jump-highlight');
        setTimeout(() => targetEl?.classList.remove('heading-jump-highlight'), 2200);

        try {
          const sel = window.getSelection();
          if (sel) {
            sel.selectAllChildren(targetEl);
            sel.collapseToEnd();
          }
        } catch {
          /* ignore */
        }
      }
    } else if (mode === 'markdown' && ta) {
      scrollToLine(h.line);
    }
  }

  export function scrollToSectionId(sectionId: string) {
    const cleanId = sectionId.toLowerCase().replace(/^sec-/, '');
    const found = headings.find(
      (h) => h.sectionId === cleanId || h.id === cleanId || h.text.toLowerCase().includes(cleanId)
    );
    if (found) {
      scrollToHeading(found);
    }
  }

  // ---- Markdown Mode Handling ----

  const MIRROR_PROPS = ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'tabSize', 'paddingLeft', 'paddingRight', 'paddingTop'] as const;

  export function scrollToLine(line: number) {
    if (mode === 'markdown' && ta) {
      const lines = value.split('\n');
      const target = Math.min(Math.max(line, 1), lines.length);
      const start = lines.slice(0, target - 1).reduce((n, l) => n + l.length + 1, 0);
      const end = start + (lines[target - 1]?.length ?? 0);

      const cs = getComputedStyle(ta);
      const mirror = document.createElement('div');
      for (const p of MIRROR_PROPS) mirror.style[p] = cs[p];
      Object.assign(mirror.style, {
        position: 'absolute',
        visibility: 'hidden',
        whiteSpace: 'pre-wrap',
        overflowWrap: 'break-word',
        boxSizing: 'content-box',
        width: `${ta.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)}px`,
      });
      mirror.textContent = value.slice(0, start) + '​';
      document.body.appendChild(mirror);
      const top = mirror.offsetHeight - parseFloat(cs.lineHeight || '20');
      mirror.remove();

      ta.focus({ preventScroll: true });
      ta.setSelectionRange(start, end);
      ta.scrollTop = Math.max(0, top - ta.clientHeight / 3);
    } else if (mode === 'word' && pageEl) {
      // Find heading in headings closest to line
      const closestHeading =
        headings
          .filter((h) => h.line <= line)
          .sort((a, b) => b.line - a.line)[0] || headings[0];
      if (closestHeading) {
        scrollToHeading(closestHeading);
      } else {
        const domHeadings = Array.from(pageEl.querySelectorAll<HTMLElement>('h1, h2, h3, h4'));
        const el = domHeadings[0];
        el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }
  }

  function onMarkdownKeyDown(e: KeyboardEvent) {
    if (handleCommonShortcuts(e)) return;

    if (readOnly) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
      }
      return;
    }

    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      onsave?.();
      return;
    }
    if (e.key === 'Tab' && !e.metaKey && !e.ctrlKey && !e.altKey && ta) {
      e.preventDefault();
      const { selectionStart: s, selectionEnd: end } = ta;
      if (!document.execCommand('insertText', false, '  ')) {
        ta.setRangeText('  ', s, end, 'end');
        onchange(ta.value);
      }
    }
  }

  // ---- Find / Search Word Implementation ----

  export function openFind() {
    findOpen = true;
    hasNavigated = false;
    requestAnimationFrame(() => {
      const sel = window.getSelection()?.toString().trim();
      if (sel && sel.length < 50 && !sel.includes('\n')) {
        findQuery = sel;
      }
      findInputEl?.focus();
      findInputEl?.select();
      if (findQuery) performFind('current', false);
    });
  }

  export function closeFind() {
    findOpen = false;
    hasNavigated = false;
    clearFindHighlights();
    if (mode === 'word') pageEl?.focus();
    else ta?.focus();
  }

  export function toggleFind() {
    if (findOpen) closeFind();
    else openFind();
  }

  function clearFindHighlights() {
    if (typeof CSS !== 'undefined' && 'highlights' in CSS && (CSS as any).highlights) {
      (CSS as any).highlights.delete('search-results');
      (CSS as any).highlights.delete('search-active');
    }
  }

  function applyWordMatch(match: WordMatch, shouldScroll = true) {
    if (!match) return;

    if (typeof CSS !== 'undefined' && 'highlights' in CSS && (CSS as any).highlights) {
      try {
        const allRanges = currentWordMatches.map((m) => {
          const r = document.createRange();
          r.setStart(m.node, m.start);
          r.setEnd(m.node, m.end);
          return r;
        });
        const activeRange = document.createRange();
        activeRange.setStart(match.node, match.start);
        activeRange.setEnd(match.node, match.end);

        (CSS as any).highlights.set('search-results', new (window as any).Highlight(...allRanges));
        (CSS as any).highlights.set('search-active', new (window as any).Highlight(activeRange));
      } catch {
        /* fallback */
      }
    }

    if (!shouldScroll) return;

    try {
      const isFindInputFocused = document.activeElement === findInputEl;
      const supportsCSSHighlights = typeof CSS !== 'undefined' && 'highlights' in CSS && (CSS as any).highlights;

      if (!isFindInputFocused || !supportsCSSHighlights) {
        const range = document.createRange();
        range.setStart(match.node, match.start);
        range.setEnd(match.node, match.end);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
      }

      const parentEl = match.node.parentElement;
      if (parentEl) {
        parentEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }

      if (isFindInputFocused && document.activeElement !== findInputEl) {
        findInputEl?.focus({ preventScroll: true });
      }
    } catch {
      /* ignore */
    }
  }

  function applyMarkdownMatch(startIndex: number, length: number, shouldScroll = true) {
    if (!ta) return;

    if (!shouldScroll) return;

    const isFindInputFocused = document.activeElement === findInputEl;
    if (!isFindInputFocused) {
      ta.focus({ preventScroll: true });
    }
    ta.setSelectionRange(startIndex, startIndex + length);

    const lines = ta.value.slice(0, startIndex).split('\n');
    const lineIndex = lines.length - 1;
    const lineHeight = parseFloat(getComputedStyle(ta).lineHeight || '20');
    const targetTop = lineIndex * lineHeight;
    ta.scrollTop = Math.max(0, targetTop - ta.clientHeight / 2);

    if (isFindInputFocused && document.activeElement !== findInputEl) {
      findInputEl?.focus({ preventScroll: true });
    }
  }

  function performFind(direction: 'next' | 'prev' | 'current' = 'current', shouldScroll = true) {
    const q = findQuery.trim();
    if (!q) {
      totalMatches = 0;
      currentMatchIndex = 0;
      currentWordMatches = [];
      currentMdIndices = [];
      clearFindHighlights();
      return;
    }

    if (mode === 'word' && pageEl) {
      const walker = document.createTreeWalker(pageEl, NodeFilter.SHOW_TEXT, null);
      const matches: WordMatch[] = [];
      let textNode: Text | null;
      while ((textNode = walker.nextNode() as Text | null)) {
        const text = findMatchCase ? (textNode.nodeValue || '') : (textNode.nodeValue || '').toLowerCase();
        const searchFor = findMatchCase ? q : q.toLowerCase();
        let idx = 0;
        while ((idx = text.indexOf(searchFor, idx)) !== -1) {
          matches.push({ node: textNode, start: idx, end: idx + searchFor.length });
          idx += searchFor.length;
        }
      }
      currentWordMatches = matches;
      totalMatches = matches.length;

      if (totalMatches === 0) {
        currentMatchIndex = 0;
        clearFindHighlights();
        return;
      }

      if (direction === 'next') {
        currentMatchIndex = (currentMatchIndex + 1) % totalMatches;
      } else if (direction === 'prev') {
        currentMatchIndex = (currentMatchIndex - 1 + totalMatches) % totalMatches;
      } else {
        if (currentMatchIndex >= totalMatches) currentMatchIndex = 0;
      }

      applyWordMatch(matches[currentMatchIndex], shouldScroll);
    } else if (mode === 'markdown' && ta) {
      clearFindHighlights();
      const text = findMatchCase ? ta.value : ta.value.toLowerCase();
      const searchFor = findMatchCase ? q : q.toLowerCase();
      const indices: number[] = [];
      let idx = 0;
      while ((idx = text.indexOf(searchFor, idx)) !== -1) {
        indices.push(idx);
        idx += searchFor.length;
      }
      currentMdIndices = indices;
      totalMatches = indices.length;

      if (totalMatches === 0) {
        currentMatchIndex = 0;
        return;
      }

      if (direction === 'next') {
        currentMatchIndex = (currentMatchIndex + 1) % totalMatches;
      } else if (direction === 'prev') {
        currentMatchIndex = (currentMatchIndex - 1 + totalMatches) % totalMatches;
      } else {
        if (currentMatchIndex >= totalMatches) currentMatchIndex = 0;
      }

      applyMarkdownMatch(indices[currentMatchIndex], q.length, shouldScroll);
    }
  }

  function findNext() {
    hasNavigated = true;
    performFind('next', true);
  }

  function findPrev() {
    hasNavigated = true;
    performFind('prev', true);
  }

  function toggleMatchCase() {
    findMatchCase = !findMatchCase;
    performFind('current', false);
  }

  function handleFindInput() {
    currentMatchIndex = 0;
    hasNavigated = false;
    performFind('current', false);
  }

  function onFindKeyDown(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (totalMatches === 0) return;
      if (e.shiftKey) {
        findPrev();
      } else {
        if (!hasNavigated) {
          hasNavigated = true;
          performFind('current', true);
        } else {
          findNext();
        }
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeFind();
    }
  }

  const wordCount = $derived(value.trim() ? value.trim().split(/\s+/).length : 0);
  const charCount = $derived(value.length);
</script>

<div class="word-editor-container">
  <!-- Word-style Ribbon Toolbar -->
  <header class="ribbon-bar" role="toolbar" aria-label="Alat Format Word">
    {#if readOnly}
      <div class="ribbon-readonly-badge" title="Mode View Only aktif — Dokumen terlindungi dari ketikan tidak sengaja">
        <Icon name="lock" size={12} />
        <span>View Only</span>
      </div>
      {#if onrequestedit}
        <button
          type="button"
          class="ribbon-btn ribbon-btn-edit-action"
          onclick={onrequestedit}
          title="Buka mode edit untuk mengubah isi TAD (Cmd+E)"
        >
          <Icon name="edit" size={13} />
          <span class="btn-text">Edit Dokumen</span>
        </button>
      {/if}
      <div class="ribbon-separator"></div>
    {/if}

    <div class="ribbon-group history-group">
      <button class="ribbon-btn" onclick={() => exec('undo')} title="Undo (Cmd+Z)" aria-label="Undo" disabled={readOnly}>
        <Icon name="undo" size={14} />
      </button>
      <button class="ribbon-btn" onclick={() => exec('redo')} title="Redo (Cmd+Shift+Z)" aria-label="Redo" disabled={readOnly}>
        <Icon name="redo" size={14} />
      </button>
    </div>

    <div class="ribbon-separator"></div>

    <!-- Style / Heading Dropdown -->
    <div class="ribbon-group">
      <select
        class="style-select"
        value={activeBlock}
        onchange={setBlockFormat}
        title="Format Paragraf & Judul"
        disabled={readOnly || mode === 'markdown'}
      >
        <option value="p">Normal (Paragraf)</option>
        <option value="h1">Heading 1 (Judul)</option>
        <option value="h2">Heading 2 (Section TAD)</option>
        <option value="h3">Heading 3 (Nama Task)</option>
        <option value="h4">Heading 4 (Field Task)</option>
        <option value="pre">Format Kode</option>
      </select>
    </div>

    <div class="ribbon-separator"></div>

    <!-- Font Formatting -->
    <div class="ribbon-group">
      <button
        class="ribbon-btn font-bold-btn"
        onclick={() => exec('bold')}
        title="Tebal (Cmd+B)"
        disabled={readOnly || mode === 'markdown'}
      >
        <Icon name="bold" size={14} />
      </button>
      <button
        class="ribbon-btn font-italic-btn"
        onclick={() => exec('italic')}
        title="Miring (Cmd+I)"
        disabled={readOnly || mode === 'markdown'}
      >
        <Icon name="italic" size={14} />
      </button>
      <button
        class="ribbon-btn"
        onclick={() => exec('underline')}
        title="Garis Bawah (Cmd+U)"
        disabled={readOnly || mode === 'markdown'}
      >
        <Icon name="underline" size={14} />
      </button>
      <button
        class="ribbon-btn"
        onclick={() => exec('strikeThrough')}
        title="Coret"
        disabled={readOnly || mode === 'markdown'}
      >
        <Icon name="strikethrough" size={14} />
      </button>
      <button
        class="ribbon-btn"
        onclick={toggleCode}
        title="Kode Inline"
        disabled={readOnly || mode === 'markdown'}
      >
        <Icon name="code" size={14} />
      </button>
    </div>

    <div class="ribbon-separator"></div>

    <!-- Lists -->
    <div class="ribbon-group">
      <button
        class="ribbon-btn"
        onclick={() => exec('insertUnorderedList')}
        title="Daftar Poin (Bullet List)"
        disabled={readOnly || mode === 'markdown'}
      >
        <Icon name="list" size={14} />
      </button>
      <button
        class="ribbon-btn"
        onclick={() => exec('insertOrderedList')}
        title="Daftar Nomor (Numbered List)"
        disabled={readOnly || mode === 'markdown'}
      >
        <span class="num-list-icon">1.</span>
      </button>
    </div>

    <div class="ribbon-separator"></div>

    <!-- Table Tools -->
    <div class="ribbon-group table-group">
      <button
        class="ribbon-btn {inTable ? 'active' : ''}"
        onclick={() => insertTable(3, 3)}
        title="Sisipkan Tabel Baru"
        disabled={readOnly || mode === 'markdown'}
      >
        <Icon name="table" size={14} />
        <span class="btn-text">Tabel</span>
      </button>

      {#if inTable && mode === 'word' && !readOnly}
        <div class="table-actions-inline">
          <button class="ribbon-btn btn-xs" onclick={addTableRow} title="Tambah Baris di Bawah">
            <Icon name="plus" size={12} /> Baris
          </button>
          <button class="ribbon-btn btn-xs" onclick={deleteTableRow} title="Hapus Baris Ini">
            <Icon name="x" size={12} /> Baris
          </button>
          <button class="ribbon-btn btn-xs" onclick={addTableColumn} title="Tambah Kolom di Kanan">
            <Icon name="plus" size={12} /> Kolom
          </button>
          <button class="ribbon-btn btn-xs" onclick={deleteTableColumn} title="Hapus Kolom Ini">
            <Icon name="x" size={12} /> Kolom
          </button>
          <button class="ribbon-btn btn-xs text-danger" onclick={deleteTable} title="Hapus Seluruh Tabel">
            <Icon name="trash" size={12} />
          </button>
        </div>
      {/if}
    </div>

    <div class="ribbon-separator"></div>

    <!-- Callouts & Inserts -->
    <div class="ribbon-group">
      <div class="dropdown-wrapper">
        <button
          class="ribbon-btn"
          title="Kotak Catatan (Callout)"
          disabled={readOnly || mode === 'markdown'}
        >
          <span class="callout-pill-icon">💡</span>
          <span class="btn-text">Catatan</span>
          <Icon name="chevron" size={10} />
        </button>
        <div class="dropdown-menu">
          <button onclick={() => insertCallout('info')} class="menu-item">
            <span class="dot dot-info"></span> Info (Biru)
          </button>
          <button onclick={() => insertCallout('tip')} class="menu-item">
            <span class="dot dot-tip"></span> Tip (Hijau)
          </button>
          <button onclick={() => insertCallout('note')} class="menu-item">
            <span class="dot dot-note"></span> Catatan (Kuning)
          </button>
          <button onclick={() => insertCallout('warning')} class="menu-item">
            <span class="dot dot-warning"></span> Peringatan (Merah)
          </button>
        </div>
      </div>

      <button class="ribbon-btn" onclick={insertLink} title="Sisipkan Link" disabled={readOnly || mode === 'markdown'}>
        <Icon name="link" size={14} />
      </button>
      <button class="ribbon-btn" onclick={insertDivider} title="Garis Pemisah" disabled={readOnly || mode === 'markdown'}>
        <span class="divider-icon">—</span>
      </button>
    </div>

    <div class="ribbon-separator"></div>

    <!-- Search & Heading Navigation Tools -->
    <div class="ribbon-group">
      <button
        class="ribbon-btn"
        class:active={outlineOpen}
        onclick={toggleOutline}
        title="Daftar Heading & Auto Scroll (Cmd+Shift+O)"
      >
        <Icon name="list" size={14} />
        <span class="btn-text">Heading</span>
        <span class="heading-counter-chip">{headings.length}</span>
      </button>

      <button
        class="ribbon-btn"
        class:active={findOpen}
        onclick={toggleFind}
        title="Cari Kata di Dokumen (Cmd+F)"
      >
        <Icon name="search" size={14} />
        <span class="btn-text">Cari</span>
      </button>
    </div>

    <!-- Spacer -->
    <div class="ribbon-spacer"></div>

    <!-- Mode View Switcher (Word vs Markdown) -->
    <div class="mode-switcher" role="group" aria-label="Mode Editor">
      <button
        class="mode-btn {mode === 'word' ? 'active' : ''}"
        onclick={() => setMode('word')}
        title="Tampilan Visual Dokumen seperti Microsoft Word"
      >
        <Icon name="doc" size={13} />
        <span>Dokumen (Word)</span>
      </button>
      <button
        class="mode-btn {mode === 'markdown' ? 'active' : ''}"
        onclick={() => setMode('markdown')}
        title="Tampilan Kode Markdown Asli"
      >
        <Icon name="code" size={13} />
        <span>Markdown</span>
      </button>
    </div>
  </header>

  <!-- Editor Canvas Area -->
  <div class="editor-canvas">
    {#if findOpen}
      <div class="find-widget" role="search" aria-label="Cari di editor">
        <div class="find-input-wrap">
          <Icon name="search" size={13} />
          <input
            bind:this={findInputEl}
            type="text"
            class="find-input"
            placeholder="Cari kata di dokumen..."
            bind:value={findQuery}
            oninput={handleFindInput}
            onkeydown={onFindKeyDown}
          />
          {#if findQuery}
            <button class="find-btn-icon" onclick={() => { findQuery = ''; handleFindInput(); }} title="Bersihkan">
              <Icon name="x" size={11} />
            </button>
          {/if}
        </div>

        <div class="find-count" class:no-match={Boolean(findQuery && totalMatches === 0)}>
          {#if findQuery}
            {totalMatches > 0 ? `${currentMatchIndex + 1} / ${totalMatches}` : 'Tidak ada'}
          {:else}
            <span class="muted">Ketik kata</span>
          {/if}
        </div>

        <div class="find-actions">
          <button
            class="find-btn-icon"
            onclick={findPrev}
            disabled={totalMatches === 0}
            title="Sebelumnya (Shift+Enter)"
            aria-label="Sebelumnya"
          >
            <span class="rotate-180"><Icon name="chevron" size={13} /></span>
          </button>
          <button
            class="find-btn-icon"
            onclick={findNext}
            disabled={totalMatches === 0}
            title="Berikutnya (Enter)"
            aria-label="Berikutnya"
          >
            <Icon name="chevron" size={13} />
          </button>
          <button
            class="find-btn-icon match-case-btn"
            class:active={findMatchCase}
            onclick={toggleMatchCase}
            title="Cocokkan Besar/Kecil Huruf (Case Sensitive)"
          >
            Aa
          </button>
          <button
            class="find-btn-icon close-btn"
            onclick={closeFind}
            title="Tutup (Esc)"
            aria-label="Tutup pencarian"
          >
            <Icon name="x" size={13} />
          </button>
        </div>
      </div>
    {/if}

    <div class="canvas-layout">
      {#if outlineOpen}
        <aside class="outline-drawer" aria-label="Navigasi Heading Dokumen">
          <div class="outline-header">
            <div class="outline-title">
              <Icon name="list" size={14} />
              <strong>Navigasi Section</strong>
            </div>
            <span class="outline-count" title="Jumlah heading terdeteksi">{filteredHeadings.length}</span>
            <button class="find-btn-icon outline-close" onclick={toggleOutline} title="Tutup outline">
              <Icon name="x" size={12} />
            </button>
          </div>

          <div class="outline-search-box">
            <Icon name="search" size={12} />
            <input
              type="text"
              placeholder="Filter section / heading..."
              bind:value={headingQuery}
              aria-label="Filter heading"
            />
            {#if headingQuery}
              <button class="filter-clear" onclick={() => (headingQuery = '')} title="Reset filter">
                <Icon name="x" size={10} />
              </button>
            {/if}
          </div>

          <div class="outline-items">
            {#each filteredHeadings as h (h.id)}
              <button
                class="outline-item depth-{h.depth}"
                class:active={activeHeadingId === h.id}
                onclick={() => scrollToHeading(h)}
                title={`${h.text} (Baris ${h.line}) — Klik untuk auto scroll`}
              >
                <span class="heading-tag depth-tag-{h.depth}">H{h.depth}</span>
                {#if h.taskType}
                  <span class="task-type-badge">{h.taskType}</span>
                {/if}
                <span class="heading-text">{h.text}</span>
                <span class="heading-line mono">Ln {h.line}</span>
              </button>
            {:else}
              <div class="outline-empty muted small">
                {headingQuery ? 'Tidak ada heading yang cocok' : 'Belum ada heading di dokumen'}
              </div>
            {/each}
          </div>
        </aside>
      {/if}

      <div class="editor-main-area">
        {#if readOnly}
          <div class="readonly-banner">
            <div class="readonly-banner-info">
              <Icon name="lock" size={14} />
              <span><strong>Mode View Only</strong> — Dokumen terlindungi dari ketikan tidak sengaja. Klik tombol edit untuk mengubah isi.</span>
            </div>
            {#if onrequestedit}
              <button type="button" class="btn btn-sm btn-edit-banner" onclick={onrequestedit} title="Buka mode edit (Cmd+E)">
                <Icon name="edit" size={13} />
                <span>Mulai Edit</span>
              </button>
            {/if}
          </div>
        {/if}

        {#if mode === 'word'}
          <!-- Word Document Page Layout -->
          <div class="word-page-scroller">
            <div
              bind:this={pageEl}
              class="word-paper confluence-page"
              class:readonly-paper={readOnly}
              contenteditable={readOnly ? 'false' : 'true'}
              oninput={handleWordInput}
              onblur={handleWordBlur}
              onkeydown={onWordKeyDown}
              onkeyup={updateSelectionContext}
              onclick={updateSelectionContext}
              spellcheck={!readOnly}
              role="textbox"
              tabindex={0}
              aria-multiline="true"
              aria-readonly={readOnly}
              aria-label="Dokumen TAD"
            ></div>
          </div>
        {:else}
          <!-- Raw Markdown Textarea -->
          <textarea
            bind:this={ta}
            class="markdown-textarea"
            class:readonly-textarea={readOnly}
            readonly={readOnly}
            {value}
            oninput={(e) => { if (!readOnly) onchange(e.currentTarget.value); }}
            onkeydown={onMarkdownKeyDown}
            spellcheck="false"
            aria-readonly={readOnly}
            aria-label="Editor Markdown TAD"
          ></textarea>
        {/if}
      </div>
    </div>
  </div>

  <!-- Bottom Status Bar -->
  <footer class="editor-footer">
    <div class="footer-left">
      <span class="footer-badge" class:badge-viewonly={readOnly}>
        {#if readOnly}
          🔒 Mode View Only (Hanya Baca)
        {:else if mode === 'word'}
          📄 Mode Dokumen Visual (Word)
        {:else}
          🧑‍💻 Mode Kode Markdown
        {/if}
      </span>
      <span class="footer-hint">
        {#if readOnly}
          Klik "Edit TAD" atau tekan Cmd+E untuk mulai mengedit dokumen
        {:else if mode === 'word'}
          Tab di tabel untuk pindah cell / buat baris baru · Cmd+B Tebal · Cmd+I Miring · Cmd+E selesai edit
        {:else}
          Tab untuk spasi · Cmd+S untuk simpan · Cmd+E selesai edit
        {/if}
      </span>
    </div>
    <div class="footer-right">
      <span>{wordCount} kata</span>
      <span>•</span>
      <span>{charCount} karakter</span>
      <span>•</span>
      <span class="save-status">
        {#if readOnly}
          <Icon name="lock" size={12} /> Terkunci
        {:else}
          <Icon name="check" size={12} /> Mode Edit Aktif
        {/if}
      </span>
    </div>
  </footer>
</div>

<style>
  .word-editor-container {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    background: var(--surface-2);
    position: relative;
  }

  /* Ribbon Read-Only Elements */
  .ribbon-readonly-badge {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    height: 24px;
    padding: 0 8px;
    border-radius: 12px;
    background: #091e420f;
    color: var(--text-2);
    font-size: 11.5px;
    font-weight: 600;
  }

  .ribbon-btn-edit-action {
    background: var(--accent-soft);
    color: var(--accent);
    border: 1px solid var(--accent);
    font-weight: 500;
  }

  .ribbon-btn-edit-action:hover {
    background: var(--accent);
    color: #fff;
  }

  /* Read-Only Top Banner */
  .readonly-banner {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 7px 16px;
    background: #ebf2fa;
    border-bottom: 1px solid #d0e2ff;
    color: #172b4d;
    font-size: 12.5px;
    flex-shrink: 0;
  }

  .readonly-banner-info {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .btn-edit-banner {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 3px 10px;
    font-size: 12px;
    font-weight: 500;
    border-radius: var(--radius-sm);
    background: #fff;
    color: var(--accent);
    border: 1px solid var(--accent);
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .btn-edit-banner:hover {
    background: var(--accent);
    color: #fff;
  }

  .readonly-paper {
    cursor: default;
    user-select: text;
  }

  .readonly-textarea {
    background: var(--surface-2);
    color: var(--text);
    cursor: default;
  }

  .badge-viewonly {
    background: #091e420f !important;
    color: var(--text-2) !important;
  }

  /* Ribbon Toolbar */
  .ribbon-bar {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 6px 12px;
    background: var(--surface);
    border-bottom: 1px solid var(--border);
    flex-wrap: wrap;
    z-index: 10;
  }

  .ribbon-group {
    display: flex;
    align-items: center;
    gap: 2px;
  }

  .ribbon-separator {
    width: 1px;
    height: 18px;
    background: var(--border);
    margin: 0 4px;
  }

  .ribbon-spacer {
    flex: 1;
    min-width: 12px;
  }

  .ribbon-btn {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    height: 28px;
    padding: 0 6px;
    background: transparent;
    border: 1px solid transparent;
    border-radius: 4px;
    color: var(--text);
    font-size: 12px;
    font-family: inherit;
    cursor: pointer;
    user-select: none;
    transition: background 0.1s, border-color 0.1s;
  }

  .ribbon-btn:hover:not(:disabled) {
    background: var(--surface-2);
    border-color: var(--border);
  }

  .ribbon-btn:disabled {
    opacity: 0.35;
    cursor: not-allowed;
  }

  .ribbon-btn.active {
    background: var(--accent-soft);
    color: var(--accent);
    border-color: var(--accent);
  }

  .btn-xs {
    height: 24px;
    padding: 0 5px;
    font-size: 11px;
  }

  .btn-text {
    font-weight: 500;
  }

  .text-danger {
    color: var(--danger, #bf2600);
  }

  .text-danger:hover {
    background: #ffebe6 !important;
  }

  .num-list-icon {
    font-weight: 700;
    font-size: 12px;
  }

  .divider-icon {
    font-weight: 700;
    font-size: 14px;
  }

  .callout-pill-icon {
    font-size: 13px;
  }

  .style-select {
    height: 28px;
    padding: 0 8px;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: 4px;
    color: var(--text);
    font-size: 12px;
    font-family: inherit;
    outline: none;
    cursor: pointer;
  }

  .style-select:focus {
    border-color: var(--accent);
  }

  /* Dropdown Menu */
  .dropdown-wrapper {
    position: relative;
    display: inline-block;
  }

  .dropdown-wrapper:hover .dropdown-menu {
    display: flex;
  }

  .dropdown-menu {
    display: none;
    position: absolute;
    top: 100%;
    left: 0;
    flex-direction: column;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 6px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.15);
    padding: 4px;
    min-width: 140px;
    z-index: 100;
  }

  .menu-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 10px;
    background: transparent;
    border: 0;
    border-radius: 4px;
    color: var(--text);
    font-size: 12px;
    cursor: pointer;
    text-align: left;
    width: 100%;
  }

  .menu-item:hover {
    background: var(--surface-2);
  }

  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
  }
  .dot-info { background: #0052cc; }
  .dot-tip { background: #00875a; }
  .dot-note { background: #ff991f; }
  .dot-warning { background: #de350b; }

  .table-actions-inline {
    display: flex;
    align-items: center;
    gap: 2px;
    padding-left: 4px;
    margin-left: 4px;
    border-left: 1px dashed var(--border);
  }

  /* Mode Switcher */
  .mode-switcher {
    display: flex;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 2px;
    gap: 2px;
  }

  .mode-btn {
    display: flex;
    align-items: center;
    gap: 5px;
    height: 24px;
    padding: 0 8px;
    background: transparent;
    border: 0;
    border-radius: 4px;
    color: var(--text-muted);
    font-size: 11.5px;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.1s ease;
  }

  .mode-btn.active {
    background: var(--surface);
    color: var(--text);
    font-weight: 600;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
  }

  /* Canvas & Paper */
  .editor-canvas {
    flex: 1;
    min-height: 0;
    overflow: hidden;
    position: relative;
  }

  .word-page-scroller {
    height: 100%;
    overflow-y: auto;
    overflow-x: hidden;
    padding: 20px 16px;
  }

  .word-paper {
    max-width: 860px;
    min-height: 1000px;
    margin: 0 auto;
    padding: 48px 56px 40vh;
    background: #ffffff;
    color: #172b4d;
    border: 1px solid #dfe1e6;
    border-radius: 4px;
    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.07);
    font-size: 14px;
    line-height: 1.714;
    outline: none;
    overflow-wrap: break-word;
    color-scheme: light;
  }

  /* Word Document Typography */
  .word-paper :global(h1) {
    font-size: 28px;
    line-height: 1.2;
    font-weight: 600;
    margin: 0 0 20px;
    color: #172b4d;
  }

  .word-paper :global(h2) {
    font-size: 20px;
    font-weight: 600;
    margin: 32px 0 10px;
    padding-bottom: 4px;
    border-bottom: 1px solid #ebecf0;
    color: #172b4d;
  }

  .word-paper :global(h3) {
    font-size: 16px;
    font-weight: 600;
    margin: 22px 0 8px;
    color: #172b4d;
  }

  .word-paper :global(h4) {
    font-size: 14px;
    font-weight: 600;
    margin: 18px 0 6px;
    color: #172b4d;
  }

  .word-paper :global(p) {
    margin: 0 0 12px;
  }

  .word-paper :global(ul),
  .word-paper :global(ol) {
    margin: 0 0 12px;
    padding-left: 24px;
  }

  .word-paper :global(li > p) {
    margin: 0;
  }

  .word-paper :global(a) {
    color: #0052cc;
    text-decoration: underline;
  }

  .word-paper :global(code) {
    font-family: var(--font-mono);
    font-size: 12px;
    background: #f4f5f7;
    padding: 1px 4px;
    border-radius: 3px;
    color: #172b4d;
  }

  .word-paper :global(.code-block) {
    position: relative;
    margin: 0 0 14px;
  }

  .word-paper :global(.code-block pre) {
    margin: 0;
    padding: 12px 14px;
    background: #f4f5f7;
    border: 1px solid #dfe1e6;
    border-radius: 4px;
    overflow-x: auto;
  }

  .word-paper :global(.code-block pre code) {
    padding: 0;
    background: none;
  }

  .word-paper :global(.code-lang) {
    position: absolute;
    top: 4px;
    right: 8px;
    font-size: 11px;
    color: #6b778c;
    user-select: none;
  }

  .word-paper :global(table) {
    border-collapse: collapse;
    margin: 0 0 16px;
    width: 100%;
  }

  .word-paper :global(th),
  .word-paper :global(td) {
    border: 1px solid #c1c7d0;
    padding: 8px 12px;
    text-align: left;
    vertical-align: top;
    min-width: 60px;
  }

  .word-paper :global(th) {
    background: #f4f5f7;
    font-weight: 600;
  }

  /* Imported Confluence tables: Confluence scales wide tables to the page, keeping column ratios;
     fixed px widths from the storage would overflow here. */
  .word-paper :global(table[data-table-width]) {
    table-layout: fixed;
  }
  .word-paper :global(table[data-table-width] col) {
    width: auto !important;
  }
  .word-paper :global(table[data-table-width] > tbody > tr > th:first-child:not(:only-child)) {
    width: 17%;
  }
  .word-paper :global(td > *:last-child),
  .word-paper :global(th > *:last-child) {
    margin-bottom: 0;
  }
  .word-paper :global(th h3),
  .word-paper :global(th h4) {
    margin: 0;
    font-size: 14px;
  }
  /* Code macros inside table cells (embedded HTML). */
  .word-paper :global(pre[data-tlc-code]) {
    margin: 6px 0 10px;
    padding: 10px 12px;
    background: #f4f5f7;
    border: 1px solid #dfe1e6;
    border-radius: 3px;
    overflow-x: auto;
    font-size: 12px;
    line-height: 1.5;
  }
  .word-paper :global(pre[data-tlc-params*='wrap=true']) {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .word-paper :global(pre[data-tlc-code] code) {
    padding: 0;
    background: none;
  }
  /* A list item holding only a sub-list is an indent in Confluence, not an empty bullet. */
  .word-paper :global(li:has(> ul:first-child)),
  .word-paper :global(li:has(> ol:first-child)) {
    list-style: none;
  }
  .word-paper :global(span[data-tlc-user]),
  .word-paper :global(span[data-tlc-jira]) {
    color: #0052cc;
  }

  .word-paper :global(td:focus-within),
  .word-paper :global(th:focus-within) {
    outline: 2px solid #4c9aff;
    background: #fafbfc;
  }

  .word-paper :global(blockquote) {
    margin: 0 0 14px;
    padding: 2px 0 2px 16px;
    border-left: 3px solid #c1c7d0;
    color: #42526e;
  }

  .word-paper :global(hr) {
    border: 0;
    border-top: 1px solid #dfe1e6;
    margin: 24px 0;
  }

  .word-paper :global(.callout) {
    margin: 0 0 16px;
    padding: 12px 16px 6px;
    border-radius: 4px;
  }

  .word-paper :global(.callout-title) {
    font-weight: 600;
    font-size: 12.5px;
    margin-bottom: 4px;
    user-select: none;
  }

  .word-paper :global(.callout-info) { background: #deebff; border-left: 4px solid #0052cc; }
  .word-paper :global(.callout-tip) { background: #e3fcef; border-left: 4px solid #00875a; }
  .word-paper :global(.callout-note) { background: #fffae6; border-left: 4px solid #ff991f; }
  .word-paper :global(.callout-warning) { background: #ffebe6; border-left: 4px solid #de350b; }

  .word-paper :global(.toc-placeholder) {
    margin: 16px 0;
    padding: 10px 14px;
    background: #f4f5f7;
    border: 1px dashed #b3bac5;
    border-radius: 4px;
    font-size: 13px;
    color: #42526e;
    display: flex;
    align-items: center;
    gap: 8px;
    user-select: none;
  }

  .word-paper :global(.lozenge) {
    display: inline-block;
    padding: 0 5px;
    border-radius: 3px;
    font-size: 11px;
    font-weight: 700;
    line-height: 18px;
  }
  .word-paper :global(.lozenge-red) { background: #ffebe6; color: #bf2600; }
  .word-paper :global(.lozenge-yellow) { background: #fff0b3; color: #172b4d; }
  .word-paper :global(.lozenge-green) { background: #e3fcef; color: #006644; }
  .word-paper :global(.lozenge-blue) { background: #deebff; color: #0747a6; }
  .word-paper :global(.lozenge-grey) { background: #dfe1e6; color: #42526e; }

  .word-paper :global(.mermaid-block) {
    margin: 0 0 16px;
    padding: 12px;
    background: #f4f5f7;
    border: 1px solid #dfe1e6;
    border-radius: 4px;
  }

  .word-paper :global(.mermaid-block pre) {
    margin: 0;
    font-family: var(--font-mono);
    font-size: 12px;
    color: #172b4d;
  }

  /* Raw Markdown Textarea */
  .markdown-textarea {
    display: block;
    width: 100%;
    height: 100%;
    margin: 0;
    padding: 20px 24px 40vh;
    border: 0;
    outline: none;
    resize: none;
    background: var(--surface);
    color: var(--text);
    font-family: var(--font-mono);
    font-size: 13px;
    line-height: 1.65;
    tab-size: 2;
    white-space: pre-wrap;
    overflow-wrap: break-word;
  }

  /* Footer Status Bar */
  .editor-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 4px 14px;
    background: var(--surface);
    border-top: 1px solid var(--border);
    font-size: 11px;
    color: var(--text-muted);
    user-select: none;
  }

  .footer-left {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .footer-badge {
    font-weight: 500;
    color: var(--text);
  }

  .footer-hint {
    color: var(--text-muted);
  }

  .footer-right {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .save-status {
    display: flex;
    align-items: center;
    gap: 4px;
    color: var(--ok, #00875a);
  }

  /* Quick Jump & Counter Chip */
  .heading-counter-chip {
    font-size: 10px;
    padding: 1px 5px;
    border-radius: 999px;
    background: var(--surface-2);
    color: var(--text-2);
    font-weight: 600;
  }
  .quick-jump-group {
    max-width: 190px;
  }
  .heading-jump-select {
    height: 28px;
    max-width: 180px;
    padding: 0 8px;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: 4px;
    color: var(--text);
    font-size: 11.5px;
    font-family: inherit;
    outline: none;
    cursor: pointer;
    text-overflow: ellipsis;
  }
  .heading-jump-select:focus {
    border-color: var(--accent);
  }

  /* Canvas Layout */
  .canvas-layout {
    display: flex;
    flex: 1;
    min-height: 0;
    min-width: 0;
    height: 100%;
    position: relative;
    overflow: hidden;
  }
  .editor-main-area {
    flex: 1;
    min-height: 0;
    min-width: 0;
    height: 100%;
    display: flex;
    flex-direction: column;
    position: relative;
    overflow: hidden;
  }

  /* Outline Navigation Drawer */
  .outline-drawer {
    width: 270px;
    flex-shrink: 0;
    height: 100%;
    background: var(--surface);
    border-right: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    z-index: 15;
  }
  .outline-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 12px;
    border-bottom: 1px solid var(--border);
    gap: 8px;
  }
  .outline-title {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12.5px;
    color: var(--text);
  }
  .outline-count {
    font-size: 11px;
    font-weight: 600;
    padding: 1px 6px;
    border-radius: 999px;
    background: var(--surface-2);
    color: var(--text-2);
  }
  .outline-search-box {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 10px;
    background: var(--surface-2);
    border-bottom: 1px solid var(--border);
    color: var(--text-3);
  }
  .outline-search-box input {
    flex: 1;
    min-width: 0;
    border: 0;
    outline: none;
    background: transparent;
    font-size: 12px;
    color: var(--text);
    font-family: inherit;
  }
  .filter-clear {
    border: 0;
    background: transparent;
    color: var(--text-3);
    cursor: pointer;
    padding: 2px;
    display: flex;
  }
  .outline-items {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 6px 4px;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .outline-item {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    padding: 5px 8px;
    border: 0;
    border-radius: 4px;
    background: transparent;
    color: var(--text);
    font-size: 12px;
    font-family: inherit;
    text-align: left;
    cursor: pointer;
    transition: background 0.1s ease;
  }
  .outline-item:hover {
    background: var(--surface-2);
  }
  .outline-item.active {
    background: var(--accent-soft);
    color: var(--accent);
    font-weight: 500;
  }
  .outline-item.depth-1 {
    font-weight: 600;
  }
  .outline-item.depth-2 {
    padding-left: 12px;
  }
  .outline-item.depth-3 {
    padding-left: 22px;
    font-size: 11.5px;
  }
  .outline-item.depth-4 {
    padding-left: 30px;
    font-size: 11px;
    color: var(--text-2);
  }
  .heading-tag {
    font-size: 9.5px;
    font-weight: 700;
    padding: 1px 4px;
    border-radius: 3px;
    background: var(--surface-2);
    color: var(--text-3);
    font-family: var(--font-mono);
    flex-shrink: 0;
  }
  .depth-tag-1 { background: #e0e7ff; color: #3730a3; }
  .depth-tag-2 { background: #e0f2fe; color: #0369a1; }
  .depth-tag-3 { background: #fef3c7; color: #92400e; }
  .task-type-badge {
    font-size: 9.5px;
    font-weight: 600;
    padding: 1px 4px;
    border-radius: 3px;
    background: var(--accent-soft);
    color: var(--accent);
    flex-shrink: 0;
  }
  .heading-text {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .heading-line {
    font-size: 10px;
    color: var(--text-3);
    flex-shrink: 0;
  }
  .outline-empty {
    padding: 24px 12px;
    text-align: center;
  }

  /* Heading Auto Scroll Flash Highlight */
  :global(.heading-jump-highlight) {
    animation: heading-flash 2.2s cubic-bezier(0.16, 1, 0.3, 1) forwards !important;
  }
  @keyframes heading-flash {
    0% {
      background-color: rgba(99, 102, 241, 0.35) !important;
      outline: 2px solid var(--accent, #6366f1) !important;
      outline-offset: 4px !important;
      border-radius: 4px;
    }
    60% {
      background-color: rgba(99, 102, 241, 0.18) !important;
      outline: 2px solid var(--accent, #6366f1) !important;
      outline-offset: 4px !important;
      border-radius: 4px;
    }
    100% {
      background-color: transparent !important;
      outline: 2px solid transparent !important;
      outline-offset: 4px !important;
    }
  }

  /* Find Widget Floating Box */
  .find-widget {
    position: absolute;
    top: 10px;
    right: 20px;
    z-index: 50;
    display: flex;
    align-items: center;
    gap: 5px;
    padding: 5px 8px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.16);
    animation: find-pop 0.15s ease-out;
  }
  @keyframes find-pop {
    from { opacity: 0; transform: translateY(-6px); }
    to { opacity: 1; transform: translateY(0); }
  }
  .find-input-wrap {
    display: flex;
    align-items: center;
    gap: 6px;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: 5px;
    padding: 0 6px;
    height: 28px;
    color: var(--text-3);
  }
  .find-input-wrap:focus-within {
    border-color: var(--accent);
    box-shadow: 0 0 0 2px var(--accent-soft);
  }
  .find-input {
    border: 0;
    outline: none;
    background: transparent;
    font-size: 12.5px;
    color: var(--text);
    width: 180px;
    font-family: inherit;
  }
  .find-count {
    font-size: 11.5px;
    font-weight: 500;
    color: var(--text-2);
    min-width: 50px;
    text-align: center;
    padding: 0 4px;
    user-select: none;
  }
  .find-count.no-match {
    color: var(--err, #f87171);
    font-weight: 600;
  }
  .find-actions {
    display: flex;
    align-items: center;
    gap: 2px;
  }
  .find-btn-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 26px;
    height: 26px;
    border: 0;
    border-radius: 4px;
    background: transparent;
    color: var(--text);
    cursor: pointer;
    transition: background 0.1s ease;
  }
  .find-btn-icon:hover:not(:disabled) {
    background: var(--surface-2);
  }
  .find-btn-icon:disabled {
    opacity: 0.35;
    cursor: not-allowed;
  }
  .match-case-btn {
    font-size: 11px;
    font-weight: 700;
    border: 1px solid transparent;
  }
  .match-case-btn.active {
    background: var(--accent-soft);
    color: var(--accent);
    border-color: var(--accent);
  }
  .rotate-180 {
    display: inline-flex;
    transform: rotate(180deg);
  }

  /* Native CSS Highlight API Styles */
  ::highlight(search-results) {
    background-color: rgba(250, 204, 21, 0.45);
    color: inherit;
  }
  ::highlight(search-active) {
    background-color: #f59e0b;
    color: #000;
  }
</style>
