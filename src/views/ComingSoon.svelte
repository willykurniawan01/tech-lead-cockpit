<script lang="ts">
  let { title, phase, points }: { title: string; phase: string; points: string[] } = $props();
</script>

<section class="page">
  <span class="chip chip-accent">{phase}</span>
  <h1>{title}</h1>
  <p class="muted">Belum dibangun. Rencana fitur:</p>
  <ul>
    {#each points as p (p)}<li>{p}</li>{/each}
  </ul>
  <a class="btn" href="#/tad">Kembali ke TAD Workspace</a>
</section>

<style>
  .page {
    max-width: 560px;
    margin: 12vh auto 0;
    padding: 0 24px;
  }
  h1 {
    margin: 12px 0 4px;
    font-size: 24px;
  }
  ul {
    margin: 12px 0 24px;
    padding-left: 20px;
    color: var(--text-2);
    line-height: 1.8;
  }
  a.btn {
    text-decoration: none;
  }
</style>
