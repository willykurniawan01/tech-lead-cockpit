# Harness: Development Guide & Coding Standards

Dokumen ini adalah panduan teknis bagi developer dan AI Agent untuk mengembangkan, menambahkan fitur, memelihara kode, menjalankan testing, dan mematuhi standar kualitas serta keamanan di repositori **Tech Lead Cockpit**.

---

## 🚀 Perintah Development & Build

Seluruh script eksekusi didefinisikan dalam [`package.json`](file:///Users/ridwan/mine/tech-lead-cockpit/package.json) dan dapat dijalankan menggunakan **npm**, **bun**, atau **pnpm**:

```bash
# 1. Menjalankan Frontend + Connector dalam mode dev (Browser di http://127.0.0.1:5173)
npm run dev

# 2. Menjalankan Profile Uji Bersih (data isolasi di ~/.tech-lead-cockpit-test/)
npm run dev:fresh

# 3. Menjalankan Type Checker Svelte & TypeScript
npm run check

# 4. Menjalankan Seluruh Unit Test (Vitest + JSDOM)
npm test

# 5. Build Desktop App (Tauri v2 + Rust)
npm run build:desktop

# 6. Menjalankan Desktop App dalam Mode Dev (Tauri dev window)
npm run dev:desktop

# 7. Membundle Local Connector Standalone (output: dist-connector/server.mjs)
npm run build:connector

# 8. Menjalankan Connector Standalone secara terpisah
npm run connector

# 9. Membundle VPS Scheduled Reporter (output: dist-reporter/tad-progress.mjs)
npm run build:reporter

# 10. Pengaturan Kredensial Keychain Cepat
npm run token:confluence
npm run token:jira
npm run token:gitlab
npm run token:inferhub
npm run token:9router
```

---

## 🎨 Standar Kode Frontend (Svelte 5 Runes)

Proyek ini dibangun di atas **Svelte 5** (`svelte: ^5.57.1`). Semua komponen dan store WAJIB menggunakan sintaks **Runes**:

### 1. State Reaktif (`$state`)
- ❌ Dilarang: Menggunakan sintaks lama `let count = 0;` untuk variabel yang berubah di UI.
- ✅ Wajib: Gunakan `$state()`:
  ```svelte
  <script lang="ts">
    let query = $state('');
    let selectedDraft = $state<string | null>(null);
  </script>
  ```

### 2. Nilai Turunan (`$derived` & `$derived.by`)
- ❌ Dilarang: Menggunakan deklarasi reaktif lama `$: uppercase = query.toUpperCase();`
- ✅ Wajib:
  ```svelte
  <script lang="ts">
    const filteredItems = $derived(items.filter(i => i.title.includes(query)));
    
    const complexComputation = $derived.by(() => {
      // Logika kalkulasi multi-baris
      return result;
    });
  </script>
  ```

### 3. Efek Samping (`$effect`)
- ❌ Dilarang: Menaruh *side effect* (seperti `localStorage.setItem` atau `fetch`) di dalam deklarasi `$:`
- ✅ Wajib:
  ```svelte
  <script lang="ts">
    $effect(() => {
      localStorage.setItem('my_key', query);
    });
  </script>
  ```

### 4. Ekstensi File Store Reaktif
- Semua modul TypeScript yang menggunakan runes Svelte 5 di luar komponen `.svelte` WAJIB menggunakan ekstensi `*.svelte.ts` (misal: [`src/lib/settings/store.svelte.ts`](file:///Users/ridwan/mine/tech-lead-cockpit/src/lib/settings/store.svelte.ts), [`src/lib/auth/security.svelte.ts`](file:///Users/ridwan/mine/tech-lead-cockpit/src/lib/auth/security.svelte.ts)).

---

## 🔌 Standar Backend Connector (Node 22 ESM)

### 1. Pola Pembuatan Endpoint Baru di `connector/dev-connector.ts`
Setiap route baru harus mematuhi konvensi berikut:
```typescript
if (route === 'POST /my-feature/action') {
  // 1. Validasi input JSON dengan batasan ukuran payload
  const body = await readJson<{ id: string }>(req, 512 * 1024);
  if (!body.id?.trim()) {
    throw new ConfluenceError('ID tidak boleh kosong.', 400, 'bad-request');
  }

  // 2. Eksekusi logika bisnis via modul terpisah
  const result = await myFeatureManager.doAction(body.id);

  // 3. Catat audit jika aksi bersifat mengubah data (mutasi)
  await deps.appendAudit({
    action: 'my_feature_action',
    target: body.id,
    timestamp: new Date().toISOString(),
  });

  // 4. Kirim respons
  return send(res, 200, { ok: true, data: result });
}
```

### 2. Seam Injection untuk Unit Test
Semua modul backend utama harus menerima dependensi melalui antarmuka `deps` (misal: `readToken`, `appendAudit`, `runAi`) agar dapat diuji secara terisolasi tanpa memerlukan akses internet atau Keychain nyata:
```typescript
export interface MyFeatureDeps {
  readToken: () => Promise<string | null>;
  fetchData?: typeof fetch;
}
```

---

## 🔒 Protokol Keamanan & Anti-Leak

> [!CRITICAL]
> ### ATURAN MUTLAK PENJAGAAN KREDENSIAL (.ENV PROTECTION)
> 1. Asisten AI dilarang keras menggunakan tool apa pun untuk membaca, memproses, atau menampilkan file `.env`, `.env.*`, `*.pem`, `*.key`, atau `id_rsa*`.
> 2. Kredensial otentikasi hanya boleh dibaca dari macOS Keychain melalui `connector/keychain.ts`.
> 3. Semua perintah eksekusi kode eksternal (AI subprocess) harus memiliki batasan direktori kerja (sandbox) dan larangan menjalankan perintah terminal berbahaya.

---

## 📋 Harness Synchronization Protocol (MANDATORY)

Setiap pengembang atau AI Agent yang melakukan perubahan pada codebase **Tech Lead Cockpit** WAJIB mengikuti checklist ini sebelum menandai pekerjaan sebagai selesai:

```markdown
### [ ] Harness Synchronization Checklist
1. [ ] Apakah ada file baru atau rute API baru yang ditambahkan?
       -> Jika ya: Catat di tabel file modul harness terkait di bawah `docs/harness/`.
2. [ ] Apakah ada perubahan alur kerja atau aturan validasi logika bisnis?
       -> Jika ya: Perbarui diagram Mermaid dan deskripsi alur di `docs/harness/<modul>/index.md`.
3. [ ] Apakah ada perubahan pada arsitektur inti atau variabel lingkungan?
       -> Jika ya: Perbarui `docs/harness/architecture/index.md` dan `docs/harness/integrations/index.md`.
4. [ ] Apakah `AGENTS.md` masih mencerminkan referensi modul terbaru?
       -> Jika ya: Pastikan link referensi di `AGENTS.md` tetap valid dan akurat.
5. [ ] Apakah seluruh test dan type check lulus?
       -> Jalankan `npm test` dan `npm run check`.
```
