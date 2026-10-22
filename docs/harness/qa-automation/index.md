# Harness: QA Automation & E2E Test Engine

Modul ini mendokumentasikan fitur **QA Automation & E2E Testing**: generator skenario pengujian end-to-end berbasis spesifikasi TAD, manajemen environment (staging/dev), runner eksekusi otomatis, dan visualisasi hasil pengujian.

---

## 🎯 Ringkasan & Alur Kerja Fitur

QA Automation memudahkan verifikasi menyeluruh terhadap alur fitur lintas komponen:

```mermaid
sequenceDiagram
    autonumber
    actor TL as Tech Lead / QA
    participant UI as Svelte UI (E2EPanel)
    participant Conn as Connector (/api/connector/qa)
    participant Gen as QA Generator (generator.ts)
    participant Run as QA Runner (runner.ts)
    participant Env as Target Environment (Staging / Dev)

    TL->>UI: 1. Buat Suite / Generate Flow dari TAD
    UI->>Conn: POST /qa/generate (tadId, focusArea)
    Conn->>Gen: Analisis alur Detail Task TAD & susun skenario E2E
    Gen-->>Conn: Skenario terstruktur (step, payload, assertions)
    Conn-->>UI: Tampilkan Skenario Test Suite

    TL->>UI: 2. Konfigurasi Environment & Jalankan Test
    UI->>Conn: POST /qa/run (suiteId, environmentId)
    Conn->>Run: Eksekusi langkah pengujian berurutan
    loop Per Langkah Uji
        Run->>Env: Panggil API / Mock UI action
        Env-->>Run: Response & status code
        Run-->>UI: Stream status langkah (Passed / Failed / Retrying)
    end
    Run-->>Conn: Laporan akhir pengujian (pass rate, duration, failure traces)
    Conn-->>UI: Simpan run history & tampilkan rekap
```

---

## 📂 Peta File Source Code (QA Automation Module)

### Frontend (`src/projects/` & `src/lib/qa/`)
| File Path | Komponen | Deskripsi & Tanggung Jawab |
|---|---|---|
| [`src/projects/E2EPanel.svelte`](file:///Users/ridwan/mine/tech-lead-cockpit/src/projects/E2EPanel.svelte) | Panel Pengujian E2E | Antarmuka pembuatan test suite, daftar skenario uji, tombol run, dan ringkasan eksekusi test. Di tab E2E Test, seluruh kolom halaman Proyek ikut scroll (`.page-scroll` di `ProjectsView`). Header proyek ikut tergulung, baris judul E2E (environment, Generate, Jalankan) menempel di atas, dan tidak ada kotak scroll kecil di dalam panel. Tombol aksi kartu flow (`.flow-actions`) tetap di baris judul; judul dan badge membungkus di `.flow-meta`. |
| [`src/projects/E2EEnvironmentModal.svelte`](file:///Users/ridwan/mine/tech-lead-cockpit/src/projects/E2EEnvironmentModal.svelte) | Modal Manajemen Environment | Pengaturan URL base, auth token, dan mock variables untuk environment pengujian (Staging, Development, Local). Modal selebar 1080px. Base URL per service dan Variabel masing-masing selebar penuh, dan tinggi textarea mengikuti jumlah baris (`rowsFor`, 6–18 baris). |
| [`src/lib/qa/client.ts`](file:///Users/ridwan/mine/tech-lead-cockpit/src/lib/qa/client.ts) | QA API Client | Penghubung antarmuka UI dengan endpoint connector `/api/connector/qa/*`. |
| [`src/lib/qa/types.ts`](file:///Users/ridwan/mine/tech-lead-cockpit/src/lib/qa/types.ts) | Definisi Tipe Data QA | Schema untuk `QASuite` (termasuk `groups`), `QAScenario`, `QAStep`, `QAEnvironment`, dan `QARunResult`. |
| [`src/lib/qa/code-fix.ts`](../../../src/lib/qa/code-fix.ts) | Perbaiki Kode dari Test Gagal | `buildCodeFixSpec`: spesifikasi coder run bugfix dari flow yang gagal (step yang gagal, request/response tanpa header, assertion gagal, definisi test, Detail Task TAD, catatan); `failingService` untuk default repo; `e2eDraftId` = `e2e-<projectId>`. Test di [`code-fix.test.ts`](../../../src/lib/qa/code-fix.test.ts). |
| [`src/lib/qa/latest.ts`](../../../src/lib/qa/latest.ts) | Hasil Terakhir per Flow | `latestResults`: hasil final (lulus/gagal/error/diblokir) tiap flow dari run terbaru yang benar-benar menjalankannya di environment terpilih; `resultBucket`/`resultCounts` untuk filter dan hitungan. Test di [`latest.test.ts`](../../../src/lib/qa/latest.test.ts). |
| [`src/lib/qa/groups.ts`](../../../src/lib/qa/groups.ts) | Grup Test Case | Fungsi murni untuk grup di tab Skenario: urutan grup, tampilan per grup, status centang grup, tambah/ganti nama/hapus/urutkan grup, pindah flow antar grup dan di dalam grup. Dipakai UI dan connector. Test di [`groups.test.ts`](../../../src/lib/qa/groups.test.ts). |

### Backend Connector (`connector/qa/`)
| File Path | Komponen | Deskripsi & Tanggung Jawab |
|---|---|---|
| [`connector/qa/manager.ts`](file:///Users/ridwan/mine/tech-lead-cockpit/connector/qa/manager.ts) | QA Suite Manager | Mengelola persistensi test suite, riwayat hasil pengujian, dan manajemen konfigurasi kredensial environment. |
| [`connector/qa/generator.ts`](file:///Users/ridwan/mine/tech-lead-cockpit/connector/qa/generator.ts) | AI Skenario Generator | Menganalisis dokumen arsitektur teknis untuk menghasilkan skenario pengujian realistis dengan validasi boundary & edge cases. |
| [`connector/qa/runner.ts`](file:///Users/ridwan/mine/tech-lead-cockpit/connector/qa/runner.ts) | Test Execution Engine | Mesin eksekutor HTTP requests, penegasan kondisi (*assertions*), logging error, dan penanganan timeout. |

---

## 🧭 Kelengkapan Input Generator (wajib dijaga)

Test case hanya selengkap input-nya. Tiga aturan ini mencegah journey kehilangan tahap (mis. tidak ada skenario create promo):

- **Task tidak pernah dipotong.** `POST /qa/generate` dan `POST /qa/plan` menerima maksimal `MAX_QA_TASKS` (200, `connector/qa/generator.ts`); lebih dari itu ditolak dengan pesan, bukan dipotong diam-diam. Task TAD kedua (mis. TAD CMS) biasanya ada di urutan akhir, jadi potongan selalu membuang tahap setup.
- **Codebase tidak gagal diam-diam.** `E2EPanel` membaca folder Services secara reaktif dari Pengaturan (`$derived(loadServicesRoot())`). Connector juga memakai folder di Pengaturan bila folder yang dikirim halaman tidak ada. Bila codebase tetap tidak terbaca, `prepareContext` mengembalikan `warning` dan catatan suite/rencana diawali `PERINGATAN: Codebase tidak terbaca (…)`.
- **Setup lewat API.** Prompt planner dan writer mewajibkan tahap pertama membuat data master lewat API-nya (create → approval → aktivasi), dicari di Detail Task dan router codebase (group cms/admin/backoffice). Seed hanya dipakai bila API-nya tidak ada. `uncoveredTasks` (`connector/qa/plan.ts`) menulis peringatan di catatan rencana untuk task API/integrasi/scheduler yang tidak masuk tahap mana pun. Task model, tabel, dan boilerplate hanya konteks.

---

## 🔢 Tipe variabel di request

Runner ([`connector/qa/runner.ts`](../../../connector/qa/runner.ts)) menentukan tipe JSON nilai yang isinya tepat satu variabel (`"field": "{{x}}"`):

1. **Cast eksplisit** menang: `"{{x|string}}"`, `"{{x|number}}"`, `"{{x|boolean}}"`, `"{{x|json}}"`. Di dalam teks (`"kode {{x|string}}"`) cast diabaikan.
2. **Hasil `extract`** memakai tipe aslinya dari response (`"00123"` tetap string, `77` tetap number, objek tetap objek), juga saat dibawa ke flow berikutnya (`carried.types`).
3. **Tanpa keduanya**, hanya angka aman yang dikirim sebagai number: tanpa nol di depan dan maksimal 15 digit. Nomor HP `0812…` dan nomor rekening panjang tetap string. Dulu semua string berisi angka diubah jadi number, dan `0812…` membuat step crash.

Prompt penulis, perbaikan, dan repair meminta AI menulis cast sesuai tipe di struct request.

Assertion `equals`/`contains`/`gt`/… tanpa nilai harapan gagal dengan pesan "nilai yang diharapkan belum diisi", bukan "not equal" polos. Di editor flow, string kosong ditampilkan dan ditulis sebagai `""`; kotak yang dikosongkan berarti tanpa nilai. Dulu `""` hilang saat flow diedit lalu disimpan.

---

## 🗂️ Grup test case (tab Skenario)

Grup sebuah flow adalah `flow.stage`: tahap dari rencana journey, atau grup yang dibuat sendiri. Flow tanpa `stage` masuk **Tanpa grup**, yang selalu tampil paling bawah. `QASuite.groups` menyimpan urutan grup, termasuk grup yang masih kosong. Grup yang hanya ada di flow (belum tersimpan di `groups`) menyusul sesuai urutan kemunculannya (`groupOrder`).

- **Checklist per grup.** Tiap judul grup punya checkbox tiga keadaan: semua, sebagian (`indeterminate`), atau kosong (`groupCheck`). Di sebelahnya ada hitungan dicentang/total (mis. `3/5`). Mengklik checkbox grup mencentang atau mengosongkan semua flow di grup itu (`setGroupEnabled`). Hitungan selalu atas semua flow di grup, juga saat pencarian aktif. Tombol **Jalankan N flow** mengikuti centangan.
- **Grup manual.**
  - **Grup baru** (di toolbar, juga di tampilan kosong) membuat grup kosong. Grup kosong tetap tampil, kecuali saat pencarian aktif.
  - Tiap grup punya tombol + (flow manual di grup itu), ↑/↓ (urutan grup), ganti nama, dan hapus. Menghapus grup memindahkan flow-nya ke Tanpa grup; flow-nya tidak ikut terhapus.
  - Nama dirapikan (`cleanGroupName`, maks 120 karakter, satu baris). Nama tidak boleh kosong, kembar (tanpa beda huruf besar/kecil), atau "Tanpa grup".
- **Pindah flow.**
  - Dropdown grup di kartu flow memindahkan flow ke grup lain, ke Tanpa grup, atau ke **+ Grup baru…**. Flow yang dipindah masuk di akhir grup tujuan.
  - Di FlowEditor, isian **Grup** menawarkan grup yang ada (datalist); mengetik nama baru membuat grup baru.
  - ↑/↓ di kartu hanya memindah flow di dalam grupnya (`moveFlowInGroup`).
- **Urutan run = urutan tampil.** Setiap perubahan grup menata ulang `suite.flows` per grup (`withGroups`/`arrangeFlows`), lalu urutan di dalam grup tetap. Runner menjalankan flow sesuai urutan itu.
- **Connector.** `POST /qa/suite` membersihkan `groups` (`normalizeGroups`) dan menata ulang flow (`withGroups`) sebelum menyimpan. Saat agent penulis menggabungkan tahap (`writeFromPlan` → `merge`), urutan grup yang tersimpan dipakai. Tahap rencana yang belum ada di `groups` menyusul dalam urutan rencana, dan `groups` sendiri tidak ditimpa oleh merge, supaya tahap yang selesai duluan tidak mengunci urutan.
- **Kompatibilitas rencana.**
  - Agent penulis mengganti flow per **judul** tahap rencana. Grup manual dengan nama di luar rencana diperlakukan seperti flow manual: tidak pernah diganti.
  - Ganti nama grup yang judulnya tahap rencana dikonfirmasi dulu. Bila tahap itu ditulis ulang, test case-nya masuk lagi ke grup bernama lama, dan flow di grup yang sudah diganti namanya tidak ikut diganti.
  - Menghapus grup tahap rencana juga diberi peringatan yang sama.

## ✅ Status lulus di tab Skenario

Tab Skenario menampilkan hasil tiap flow tanpa perlu membuka Hasil Run.

- **Sumber data.** `latestResults(runs, env.id)` mengambil hasil dari run terbaru yang benar-benar menjalankan flow itu di environment terpilih. Run berisi satu flow juga dihitung. Hasil yang belum final (berjalan, menunggu, dilewati karena run dibatalkan) tidak menimpa hasil sebelumnya, dan hasil dari environment lain tidak dipakai.
- **Kartu flow.** Badge `Lulus · 22/10, 14.15` (atau Gagal/Error/Diblokir) muncul dengan tooltip waktu dan environment. Mengklik badge membuka run itu di tab Hasil Run. Flow yang belum pernah dijalankan diberi badge "Belum dijalankan". Saat run berjalan, badge "Berjalan"/"Menunggu" muncul di sampingnya.
- **Judul grup.** Ringkasan `✓ n lulus · ✗ n gagal · n belum` atas semua flow di grup.
- **Filter.** Chip Semua / Lulus / Gagal / Belum dijalankan beserta jumlahnya, digabung dengan pencarian dan kategori. Saat filter atau pencarian aktif, tombolnya menjadi **Centang yang tampil** / **Kosongkan yang tampil** dan hanya mengubah flow yang tampil. Ini memudahkan menjalankan ulang yang gagal saja.

## 🧑‍💻 Perbaiki kode dari test yang gagal (background, tanpa tiket)

Untuk test case yang gagal karena kode service (bukan test-nya), tombol **Perbaiki kode** (ikon kode di kartu flow yang hasil terakhirnya gagal, dan tombol di flow gagal pada Hasil Run) menjalankan coder agent di background.

- **Dialog.** Repo (default dari service step yang gagal, lewat `suggestRepo`), profil Backend/Frontend, base branch (kosong = default), catatan, dan pratinjau spesifikasi.
- **Spesifikasi.** Disusun di frontend oleh `buildCodeFixSpec`, lalu dikirim lewat `POST /coder/runs` biasa dengan `kind: 'bugfix'` dan `source: { kind: 'e2e', projectId, flowId, flowName, qaRunId }`. Header request tidak ikut, karena memuat auth environment. Agent diminta memastikan dulu kegagalannya di kode. Bila test-nya yang keliru, agent berhenti dengan `BUTUH KLARIFIKASI:`; test diperbaiki lewat **Perbaiki dengan AI**.
- **Tanpa tiket.** Tidak ada kasus Bug Tracing atau tiket Jira yang dibuat. Tanpa `jiraKey`, branch-nya `fix/agent-<slug>` dan tidak ada status Jira yang digeser.
- **Background.** Run masuk antrean coder biasa (clone terisolasi, batas konkurensi) dan tampil di Agent Tasks. Tombol di Agent Tasks membuka `#/projects/<id>?tab=e2e`.
- **Review.** Panel **Perbaikan kode dari test yang gagal** di tab E2E memakai `AgentRunsPanel` dengan draft semu `e2e-<projectId>` (diff, revisi, Push & MR Draft). Kartu flow menampilkan badge status perbaikan (agent bekerja, siap direview, …); badge diklik untuk ke panel. Status dipantau tiap 5 detik selama ada run aktif. Selama satu run masih aktif, tombol Perbaiki kode untuk flow itu nonaktif.

## 🛠️ Perbaiki dengan AI (instruksi)

Tombol **Perbaiki dengan AI** di daftar skenario (atau ikon ✨ per flow) membuka panel berisi instruksi bebas, preset (tipe data sesuai struct, test yang gagal di run terakhir, nama field/path sesuai kode), cakupan (yang dicentang, hasil pencarian, atau satu flow), dan pilihan AI. `QaManager.fixFlows` (`POST /qa/fix`) menjalankan agent peran `fix` per 5 flow (maksimal 80 flow), dengan concurrency pipeline. Prompt `buildFixPrompt` ([`connector/qa/plan.ts`](../../../connector/qa/plan.ts)) berisi instruksi, JSON flow, dan ringkasan hasil run terakhir tiap flow. Agent membaca struct/router/handler (hanya baca).

`parseFix` hanya menerima flow dengan id yang dikirim. Id step dan `stage` dipertahankan, dan flow yang kembali tanpa perubahan diabaikan. Id step selalu unik dalam satu flow. Bila AI (atau edit manual) menyalin step beserta id-nya, hanya step pertama yang memakai id itu (`normalizeEditedFlow`). Pemulihan id per posisi juga tidak memakai id yang sudah dipakai. Suite lama yang sudah punya id dobel dipulihkan sekali saat dimuat (`dedupeStepIds` di `QaManager.getSuite`, lalu disimpan). Di tab Hasil Run, step diberi key berdasarkan posisi, karena run lama bisa mengulang `stepId`. Tanpa ini Svelte melempar `each_key_duplicate`. Flow yang berubah diberi `repairNote` "Diperbaiki AI: …". Versi sebelumnya disimpan di `suite.undo` (satu tingkat). **Batalkan perbaikan** (`POST /qa/fix/undo`) mengembalikannya.

---

## 🧾 Membaca jawaban JSON dari AI

`extractJson` dan `repairJson` ada di [`connector/ai-json.ts`](../../../connector/ai-json.ts) (diekspor ulang oleh `connector/qa/generator.ts`) dan dipakai agent QA, bug tracing, dan estimasi. JSON yang valid dipakai apa adanya. Hanya JSON yang gagal di-parse yang diperbaiki, dan perbaikannya (variabel `{{x}}` tanpa kutip, koma di akhir) hanya menyentuh bagian **di luar string**. Dulu perbaikan berbasis regex juga mengenai teks seperti `({{a}}, {{b}}, {{c}})` di `notes`/`description`, sehingga JSON yang sebenarnya valid jadi rusak dan agent penulis gagal dengan "JSON dari AI tidak valid".

---

## 🔑 Panel "Yang perlu diatur" (variabel environment)

[`src/projects/E2ERequirements.svelte`](../../../src/projects/E2ERequirements.svelte) tampil di atas tab Skenario/Hasil Run. Panel ini menghitung, untuk flow yang dicentang dan environment terpilih, key yang masih harus diisi. Logikanya ada di fungsi murni `e2eRequirements` ([`src/lib/qa/requirements.ts`](../../../src/lib/qa/requirements.ts)) dan urutannya sama dengan runner:

| Status | Arti |
|---|---|
| `missing` | `{{nama}}` dipakai di path, header, query, body, assertion, atau `dataQueries`, tapi tidak punya nilai dari mana pun |
| `example` | Hanya ada nilai contoh AI di flow; tetap dipakai saat run, tapi jarang berupa data uji asli |
| `set` / `secret` | Ada di Variabel environment, atau di Variabel rahasia (Keychain) |
| `auto` | Di-extract dari response step/flow lain, diisi `dataQueries` (bila environment punya database), atau contohnya dibangun dari built-in (`E2E-{{$timestamp}}`) |

Built-in (`QA_BUILTIN_VARS`) tidak pernah dihitung. Panel juga menandai service tanpa base URL sendiri maupun default, dan token auth yang belum disimpan padahal ada step yang memakai auth environment. Nilai bisa diisi langsung, lalu disimpan lewat `qa.saveEnvironment`. Nama yang tampak seperti kredensial (password/pin/otp/token/secret/key) otomatis dicentang **Rahasia** sehingga masuk Keychain; variabel rahasia lama tetap dipertahankan karena dikirim sebagai nama dengan nilai kosong. **Salin daftar key** menyalin `nama = ` per baris untuk dibagikan ke QA.

---

## 🛠️ Panduan Development & Debugging

### Menjalankan Unit Test QA Engine
```bash
npm test connector/qa/qa.test.ts
```

> [!NOTE]
> Setelah melakukan perubahan pada modul QA Automation, pastikan Anda memperbarui dokumen ini jika terdapat modifikasi struktur schema skenario test atau runner API!
