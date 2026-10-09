<script lang="ts">
  import Icon from '../components/Icon.svelte';
  import Modal from '../components/Modal.svelte';
  import { confirmDialog } from '../components/confirm.svelte';
  import { toasts } from '../components/toast.svelte';
  import { estimate } from '../lib/estimate/client';
  import { isWeekend } from '../lib/estimate/schedule';
  import type { Holiday, HolidayKind } from '../lib/estimate/types';

  let {
    open = $bindable(false),
    holidays = $bindable([]),
    custom = $bindable(false),
  }: { open: boolean; holidays: Holiday[]; custom: boolean } = $props();

  let year = $state(new Date().getFullYear());
  let newDate = $state('');
  let newName = $state('');
  let newKind = $state<HolidayKind>('libur');
  let saving = $state(false);

  const years = $derived([...new Set([...holidays.map((h) => Number(h.date.slice(0, 4))), new Date().getFullYear()])].sort());
  const shown = $derived(holidays.filter((h) => h.date.startsWith(String(year))));
  const weekdayOff = $derived(shown.filter((h) => !isWeekend(h.date)).length);
  const DAY = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];
  const fmt = (date: string) => {
    const d = new Date(`${date}T00:00:00Z`);
    return `${DAY[d.getUTCDay()]}, ${d.toLocaleDateString('id-ID', { day: 'numeric', month: 'long', timeZone: 'UTC' })}`;
  };

  async function save(next: Holiday[]) {
    saving = true;
    try {
      ({ holidays, custom } = await estimate.saveHolidays(next));
    } catch (e) {
      toasts.show((e as Error).message, 'err');
    } finally {
      saving = false;
    }
  }

  function add(e: SubmitEvent) {
    e.preventDefault();
    if (!newDate) return;
    if (holidays.some((h) => h.date === newDate)) return toasts.show('Tanggal itu sudah ada di daftar.', 'err');
    void save([...holidays, { date: newDate, name: newName.trim() || 'Libur', kind: newKind }]);
    year = Number(newDate.slice(0, 4));
    newDate = '';
    newName = '';
  }

  async function reset() {
    const ok = await confirmDialog({ title: 'Kembalikan ke daftar SKB?', message: 'Perubahan kalender libur akan dibuang dan diganti daftar bawaan (SKB 3 Menteri 2026–2027).', confirmText: 'Kembalikan' });
    if (ok) ({ holidays, custom } = await estimate.resetHolidays());
  }
</script>

<Modal bind:open title="Kalender Libur" subtitle="Libur nasional & cuti bersama yang tidak dihitung sebagai hari kerja" width={640}>
  <div class="top">
    <div class="years" role="tablist">
      {#each years as y (y)}
        <button class:active={y === year} onclick={() => (year = y)} role="tab" aria-selected={y === year}>{y}</button>
      {/each}
    </div>
    <span class="muted small">{shown.length} tanggal · {weekdayOff} jatuh di hari kerja</span>
  </div>
  <p class="muted small src">{custom ? 'Daftar sudah kamu ubah.' : 'Bawaan: SKB 3 Menteri tentang Hari Libur Nasional dan Cuti Bersama 2026 dan 2027.'} Libur kantor tambahan bisa ditambahkan di bawah.</p>

  <form class="add" onsubmit={add}>
    <input class="input" type="date" bind:value={newDate} required aria-label="Tanggal" />
    <input class="input" bind:value={newName} placeholder="Keterangan, mis. Libur kantor" aria-label="Keterangan" />
    <select class="input" bind:value={newKind} aria-label="Jenis">
      <option value="libur">Libur</option>
      <option value="cuti-bersama">Cuti bersama</option>
    </select>
    <button class="btn btn-primary btn-sm" type="submit" disabled={saving}><Icon name="plus" size={13} /> Tambah</button>
  </form>

  <ul class="list">
    {#each shown as h (h.date)}
      <li class:weekend={isWeekend(h.date)}>
        <span class="date">{fmt(h.date)}</span>
        <span class="name">{h.name}</span>
        <span class="chip {h.kind === 'cuti-bersama' ? 'chip-warn' : ''}">{h.kind === 'cuti-bersama' ? 'Cuti bersama' : 'Libur'}</span>
        {#if isWeekend(h.date)}<span class="muted small" title="Jatuh di akhir pekan, tidak mengurangi hari kerja">akhir pekan</span>{/if}
        <button class="btn btn-ghost btn-sm" onclick={() => save(holidays.filter((x) => x.date !== h.date))} aria-label="Hapus {h.name}" disabled={saving}><Icon name="trash" size={13} /></button>
      </li>
    {:else}
      <li class="muted">Belum ada data libur untuk {year}. Tambahkan setelah SKB {year} terbit, kalau tidak hanya Sabtu–Minggu yang dilewati.</li>
    {/each}
  </ul>

  {#snippet footer()}
    <div class="foot">
      {#if custom}<button class="btn btn-sm" onclick={reset}>Kembalikan ke daftar SKB</button>{/if}
      <span class="grow"></span>
      <button class="btn btn-sm" onclick={() => (open = false)}>Selesai</button>
    </div>
  {/snippet}
</Modal>

<style>
  .top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }
  .years {
    display: flex;
    gap: 4px;
  }
  .years button {
    border: 1px solid var(--border);
    background: var(--surface);
    color: var(--text);
    border-radius: 999px;
    padding: 3px 12px;
    font: inherit;
    font-size: 12.5px;
    cursor: pointer;
  }
  .years button.active {
    background: var(--accent-soft);
    border-color: var(--accent);
    color: var(--accent);
    font-weight: 600;
  }
  .small {
    font-size: 12px;
  }
  .src {
    margin: 8px 0 12px;
  }
  .add {
    display: grid;
    grid-template-columns: 150px 1fr 140px auto;
    gap: 8px;
    margin-bottom: 12px;
  }
  .list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .list li {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 10px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    font-size: 13px;
  }
  .list li.weekend {
    opacity: 0.6;
  }
  .date {
    width: 170px;
    flex-shrink: 0;
    font-weight: 500;
  }
  .name {
    flex: 1;
    min-width: 0;
  }
  .foot {
    display: flex;
    gap: 8px;
    width: 100%;
  }
  .grow {
    flex: 1;
  }
  @media (max-width: 640px) {
    .add {
      grid-template-columns: 1fr 1fr;
    }
  }
</style>
