<script lang="ts">
  import WordEditor from './WordEditor.svelte';
  import type { TadHeading } from '../lib/tad/headings';

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

  let editor: WordEditor | undefined = $state();

  export function scrollToLine(line: number) {
    editor?.scrollToLine(line);
  }

  export function scrollToHeading(h: TadHeading) {
    editor?.scrollToHeading(h);
  }

  export function scrollToSectionId(sectionId: string) {
    editor?.scrollToSectionId(sectionId);
  }

  export function openFind() {
    editor?.openFind();
  }

  export function toggleOutline() {
    editor?.toggleOutline();
  }
</script>

<WordEditor bind:this={editor} {value} {readOnly} {onchange} {onsave} {onrequestedit} />
