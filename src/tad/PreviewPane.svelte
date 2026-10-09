<script lang="ts">
  import { untrack } from 'svelte';
  import { renderPreview } from '../lib/markdown/preview';
  import { renderMermaid } from '../lib/markdown/mermaid';

  let {
    markdown = '',
    html,
    embedded = false,
  }: {
    markdown?: string;
    /** Already rendered HTML (e.g. a track-changes diff) shown with the same page styles. */
    html?: string;
    /** No scroller or page frame: for showing a fragment inside another layout. */
    embedded?: boolean;
  } = $props();

  let container: HTMLElement | undefined = $state();
  let scroller: HTMLElement | undefined = $state();
  let source = $state(untrack(() => markdown));
  const preview = $derived(html !== undefined ? { html, diagrams: [] as string[] } : renderPreview(source));

  // Rendering on every keystroke is wasteful; follow the editor with a short delay.
  $effect(() => {
    const md = markdown;
    const t = setTimeout(() => (source = md), 150);
    return () => clearTimeout(t);
  });

  const svgCache = new Map<string, Promise<string>>();

  function diagramSvg(code: string): Promise<string> {
    let p = svgCache.get(code);
    if (!p) {
      p = renderMermaid(code);
      svgCache.set(code, p);
      if (svgCache.size > 50) svgCache.delete(svgCache.keys().next().value!);
    }
    return p;
  }

  $effect(() => {
    const { diagrams } = preview;
    if (!container) return;
    let cancelled = false;
    for (const el of container.querySelectorAll<HTMLElement>('[data-mermaid]')) {
      const code = diagrams[Number(el.dataset.mermaid)];
      if (code === undefined) continue;
      diagramSvg(code).then(
        (svg) => {
          if (cancelled) return;
          el.innerHTML = svg;
          el.classList.add('rendered');
        },
        (err: unknown) => {
          if (cancelled) return;
          svgCache.delete(code);
          const msg = document.createElement('div');
          msg.className = 'mermaid-error';
          msg.textContent = `Diagram tidak valid: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`;
          el.prepend(msg);
        },
      );
    }
    return () => {
      cancelled = true;
    };
  });

  export function scrollToSection(sectionId: string) {
    const el = container?.querySelector<HTMLElement>(`#sec-${CSS.escape(sectionId)}`);
    if (!el || !scroller) return;
    const top = el.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop - 16;
    scroller.scrollTo({ top, behavior: 'smooth' });
  }
</script>

<div class="scroller" class:embedded bind:this={scroller}>
  <article class="page confluence-page" class:embedded bind:this={container}>
    {@html preview.html}
  </article>
</div>

<style>
  .scroller {
    height: 100%;
    overflow: auto;
    background: var(--surface-2);
    padding: 0;
  }
  .page {
    position: relative;
    max-width: 860px;
    margin: 24px auto;
    padding: 40px 56px 64px;
    background: var(--page-bg);
    color: var(--page-text);
    font-family: var(--page-font);
    border: 1px solid var(--page-border);
    border-radius: 4px;
    box-shadow: var(--shadow);
    font-size: 14px;
    line-height: 1.714;
    overflow-wrap: break-word;
    color-scheme: light;
  }
  .scroller {
    container-type: inline-size;
  }
  .scroller.embedded {
    height: auto;
    overflow: visible;
    background: none;
  }
  .page.embedded {
    max-width: none;
    margin: 0;
    padding: 14px 18px;
    border: 0;
    border-radius: 0;
    box-shadow: none;
  }
  .page.embedded > :global(:first-child) {
    margin-top: 0;
  }

  /* Track changes (review of AI proposals), Word style. */
  .page :global(ins.tc-add) {
    color: #006644;
    background: #e3fcef;
    text-decoration: underline;
    text-decoration-color: #36b37e;
    text-underline-offset: 2px;
  }
  .page :global(del.tc-del) {
    color: #bf2600;
    background: #ffebe6;
    text-decoration: line-through;
    text-decoration-color: #de350b;
  }
  .page :global(tr.tc-row-del td) {
    background: #fff4f2;
  }
  .page :global(pre ins.tc-add),
  .page :global(pre del.tc-del) {
    text-decoration-thickness: 1px;
  }
  @container (max-width: 640px) {
    .page {
      margin: 12px;
      padding: 24px 22px 40px;
    }
  }
  @container (max-width: 420px) {
    .page {
      margin: 6px;
      padding: 16px 14px 32px;
    }
  }

  /* Confluence-like typography so the preview matches the published page. */
  .page :global(h1) {
    font-size: 28px;
    line-height: 1.2;
    font-weight: 500;
    margin: 0 0 20px;
    color: #172b4d;
  }
  .page :global(h2) {
    font-size: 20px;
    font-weight: 500;
    margin: 32px 0 8px;
    padding-bottom: 4px;
    border-bottom: 1px solid #ebecf0;
    color: #172b4d;
  }
  .page :global(h3) {
    font-size: 16px;
    font-weight: 600;
    margin: 20px 0 6px;
  }
  .page :global(h4) {
    font-size: 14px;
    font-weight: 600;
    margin: 16px 0 4px;
  }
  .page :global(p) {
    margin: 0 0 10px;
  }
  .page :global(ul),
  .page :global(ol) {
    margin: 0 0 10px;
    padding-left: 24px;
  }
  .page :global(li > p) {
    margin: 0;
  }
  .page :global(a) {
    color: #0052cc;
  }
  .page :global(code) {
    font-family: var(--font-mono);
    font-size: 12px;
    background: #f4f5f7;
    padding: 1px 4px;
    border-radius: 3px;
    color: #172b4d;
  }
  .page :global(.code-block) {
    position: relative;
    margin: 0 0 12px;
  }
  .page :global(.code-block pre) {
    margin: 0;
    padding: 12px 14px;
    background: #f4f5f7;
    border: 1px solid #dfe1e6;
    border-radius: 3px;
    overflow-x: auto;
  }
  .page :global(.code-block pre code) {
    padding: 0;
    background: none;
  }
  .page :global(.code-lang) {
    position: absolute;
    top: 4px;
    right: 8px;
    font-size: 11px;
    color: #6b778c;
  }
  .page :global(table) {
    border-collapse: collapse;
    margin: 0 0 14px;
    width: 100%;
  }
  .page :global(th),
  .page :global(td) {
    border: 1px solid #c1c7d0;
    padding: 7px 10px;
    text-align: left;
    vertical-align: top;
  }
  .page :global(th) {
    background: #f4f5f7;
    font-weight: 600;
  }

  /* Imported Confluence tables: Confluence scales wide tables to the page, keeping column ratios;
     fixed px widths from the storage would overflow here. */
  .page :global(table[data-table-width]) {
    table-layout: fixed;
  }
  .page :global(table[data-table-width] col) {
    width: auto !important;
  }
  .page :global(table[data-table-width] > tbody > tr > th:first-child:not(:only-child)) {
    width: 17%;
  }
  .page :global(td > *:last-child),
  .page :global(th > *:last-child) {
    margin-bottom: 0;
  }
  .page :global(th h3),
  .page :global(th h4) {
    margin: 0;
    font-size: 14px;
  }
  /* Code macros inside table cells (embedded HTML). */
  .page :global(pre[data-tlc-code]) {
    margin: 6px 0 10px;
    padding: 10px 12px;
    background: #f4f5f7;
    border: 1px solid #dfe1e6;
    border-radius: 3px;
    overflow-x: auto;
    font-size: 12px;
    line-height: 1.5;
  }
  .page :global(pre[data-tlc-params*='wrap=true']) {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .page :global(pre[data-tlc-code] code) {
    padding: 0;
    background: none;
  }
  /* A list item holding only a sub-list is an indent in Confluence, not an empty bullet. */
  .page :global(li:has(> ul:first-child)),
  .page :global(li:has(> ol:first-child)) {
    list-style: none;
  }
  .page :global(span[data-tlc-user]),
  .page :global(.confluence-user-mention) {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    background: #f4f5f7;
    color: #0052cc;
    border: 1px solid #dfe1e6;
    padding: 1px 7px;
    border-radius: 12px;
    font-weight: 500;
    font-size: 0.9em;
    line-height: 1.4;
    user-select: all;
    vertical-align: baseline;
    white-space: nowrap;
  }
  .page :global(span[data-tlc-jira]) {
    color: #0052cc;
  }
  .page :global(blockquote) {
    margin: 0 0 12px;
    padding: 2px 0 2px 16px;
    border-left: 2px solid #c1c7d0;
    color: #42526e;
  }
  .page :global(hr) {
    border: 0;
    border-top: 1px solid #dfe1e6;
    margin: 20px 0;
  }

  .page :global(.toc-placeholder) {
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
  .page :global(.toc-icon) {
    font-size: 15px;
  }
  .page :global(.toc-sub) {
    color: #6b778c;
    font-size: 12px;
  }

  .page :global(.callout) {
    margin: 0 0 14px;
    padding: 10px 14px 4px 14px;
    border-radius: 3px;
  }
  .page :global(.callout-title) {
    font-weight: 600;
    font-size: 12.5px;
    margin-bottom: 2px;
  }
  .page :global(.callout-info) {
    background: #deebff;
  }
  .page :global(.callout-tip) {
    background: #e3fcef;
  }
  .page :global(.callout-note) {
    background: #fffae6;
  }
  .page :global(.callout-warning) {
    background: #ffebe6;
  }

  .page :global(.lozenge) {
    display: inline-block;
    padding: 0 4px;
    border-radius: 3px;
    font-size: 11px;
    font-weight: 700;
    line-height: 16px;
    letter-spacing: 0.02em;
  }
  .page :global(.lozenge-red) {
    background: #ffebe6;
    color: #bf2600;
  }
  .page :global(.lozenge-yellow) {
    background: #fff0b3;
    color: #172b4d;
  }
  .page :global(.lozenge-green) {
    background: #e3fcef;
    color: #006644;
  }
  .page :global(.lozenge-blue) {
    background: #deebff;
    color: #0747a6;
  }
  .page :global(.lozenge-grey) {
    background: #dfe1e6;
    color: #42526e;
  }

  .page :global(.mermaid-block) {
    margin: 0 0 14px;
    text-align: center;
  }
  .page :global(.mermaid-block pre) {
    text-align: left;
    padding: 12px;
    background: #f4f5f7;
    border-radius: 3px;
    color: #6b778c;
    font-size: 12px;
  }
  .page :global(.mermaid-block.rendered svg) {
    max-width: 100%;
    height: auto;
  }
  .page :global(.mermaid-error) {
    margin-bottom: 6px;
    padding: 6px 10px;
    background: #ffebe6;
    color: #bf2600;
    border-radius: 3px;
    font-size: 12.5px;
    text-align: left;
  }
</style>
