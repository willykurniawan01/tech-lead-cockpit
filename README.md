# Tech Lead Cockpit

Aplikasi desktop lokal untuk membantu Tech Lead menyusun Technical Architecture Document (TAD) dari PRD dan Figma, memecah fitur menjadi task (Backend, Mobile FE, Web/CMS FE), menjalankan AI generator berbasis Claude CLI dengan riwayat revisi dan rollback, serta mempublikasikan dokumen rapi ke Confluence dengan format **tadgen**.

Rencana lengkap: [docs/PLAN.md](docs/PLAN.md).

## Status

| Area | Status |
| --- | --- |
| Import PRD (.md) & deteksi requirements/Figma | ✅ Parser metadata, objective, requirements table, figma links |
| Generator Berbasis Chat (Claude CLI) | ✅ Berjalan di folder kerja TAD (`PRD.md` + `TAD.md`), riwayat revisi + diff + rollback |
| Template & Validator Format TAD | ✅ Validasi Scope ↔ Detail Task, coverage PRD, tipe task (BACKEND, MOBILE-FE, WEB-FE) |
| Confluence Converter (Gaya tadgen) | ✅ Tabel Document Info (1800px), tabel 2-kolom Detail Task (1688px), Jira macro, wide code macro |
| Publish ke Confluence (create/update + version check + audit) | ✅ via connector lokal (token di Keychain, conflict protection 409) |
| Balas WhatsApp (AI + template) | ✅ Tautkan via QR (linked device), draft AI lewat Claude CLI, template per audiens, kirim manual dengan konfirmasi |
| MR Review, Jira Automation, Dashboard | Tahap lanjutan (Phase 1, 4, 5) |

## Menjalankan

```bash
npm install
npm run dev        # http://127.0.0.1:5173
npm test           # unit + integration test
npm run check      # type check
```

## Alur Kerja TAD

1. **Import PRD**: tempel/upload PRD (.md), periksa link Figma yang terdeteksi (bisa tambah manual), dan upload dokumen pendukung (dokumentasi API partner, ekspor layar Figma PNG/PDF, catatan). Tidak ada input service manual.
2. **Kerangka TAD**: aplikasi hanya mengisi bagian yang pasti dari PRD (Document Information, Change History, Objective, Documentation, Development Schema). Bagian lain ditandai `TODO: diisi AI`.
3. **Analisa AI**: AI membaca PRD, link Figma, dokumen di `docs/`, dan codebase di folder Services (default `~/Documents/MTN & FM/Services`) untuk menentukan service yang berubah, lalu menyusun Development Analysis, Development Scope, dan Detail Task. Codebase hanya dibaca: Claude mendapat `--add-dir` dengan larangan tulis, Antigravity butuh izin `read_file` yang diberikan lewat tombol di dialog, dan `git status` setiap repo dibandingkan sebelum/sesudah job.
4. **Riwayat Revisi & Rollback**: Setiap perubahan AI atau import dicatat sebagai revisi. Buka menu **Revisi** untuk melihat perbandingan line diff dan tombol rollback kapan saja.
5. **Validasi**: Validator otomatis memeriksa:
   - Setiap task di tabel *Development Scope* wajib memiliki *Detail Task* yang bersesuaian.
   - Setiap requirement dari PRD wajib tercakup oleh minimal satu task.
   - Format nama task mengikuti `[TYPE][SERVICE][CODENAME] - Nama Task`, dengan tipe: `BACKEND`, `MOBILE-FE`, atau `WEB-FE`.
6. **Publish ke Confluence**: Dikonversi ke Confluence storage format gaya *tadgen*:
   - Tabel Document Information lebar 1800px dengan header highlight.
   - Tabel Change History 3 kolom.
   - Tabel 2 kolom (kv_table) untuk setiap Detail Task.
   - Code macro lebar (`breakoutMode="wide"`).
   - Jira structured macro untuk issue keys.
   - Diagram Mermaid sebagai attachment PNG dan expand macro.

## AI: Claude CLI, Antigravity CLI & InferHub

Generator TAD dan drafter WhatsApp mendukung **Claude CLI**, **Antigravity CLI**, dan **InferHub** (API relay model frontier), dengan model yang dapat dipilih langsung dari aplikasi:

| Provider | Siapkan | Model |
| --- | --- | --- |
| Claude CLI | `brew upgrade --cask claude-code` (minimal 2.1), lalu jalankan `claude` sekali untuk login dan menyetujui ketentuan | Default, Opus, Sonnet, Haiku |
| Antigravity CLI | `curl -fsSL https://antigravity.google/cli/install.sh \| bash`, lalu jalankan `agy` sekali untuk login | Daftar dari `agy models` (Gemini Flash/Pro) |
| InferHub | Dapatkan API key di [inferhub.dev/dashboard](https://inferhub.dev/dashboard), simpan via `npm run token:inferhub` atau `INFERHUB_API_KEY` di `.env.local` | `ag/claude-sonnet-4-6`, `cb/gpt-5.4`, `ag/claude-opus-4-6-thinking`, `ali/qwen3.8-max`, `ag/gemini-3.8-flash-high`, atau custom slug |

- Generator berjalan sebagai job di background dengan progres langsung (file yang dibaca/diedit) dan tombol **Batalkan**. Job tetap berjalan bila halaman di-reload.
- Tidak ada izin bebas: Claude hanya boleh Read/Edit/Write di folder kerja draft. Untuk Antigravity & InferHub, akses file di luar draft dibatasi hanya untuk membaca codebase, dan perintah terminal diblokir.
- Kalau CLI tidak merespons dalam 60 detik (biasanya karena belum login, ada ketentuan baru, atau versi terlalu lama), job dihentikan dengan penjelasan.

## Balas WhatsApp

1. Buka menu **Balas WhatsApp** → **Tampilkan QR** → di HP: *Perangkat tertaut → Tautkan perangkat* → scan.
2. Pilih chat, tentukan lawan bicara (**Tim dev/QA**, **PM/Stakeholder**, **Klien/eksternal**), pilih template (opsional) dan isi variabelnya, tambahkan instruksi, lalu **Buat balasan dengan AI**.
3. Edit draft bila perlu, lalu **Kirim** → **Ya, kirim**. Tidak ada pengiriman otomatis.

Catatan:

- Koneksi memakai protokol WhatsApp Web (library Baileys), **tidak resmi**: WhatsApp bisa membatasi nomor yang terlihat seperti bot. Pengiriman dibatasi minimal 3 detik antar pesan dan 15 pesan/menit, hanya ke chat yang sudah ada.
- Sesi tertaut: `~/.tech-lead-cockpit/whatsapp-auth/` (izin 0700). Template: `~/.tech-lead-cockpit/wa-templates.json`. Isi chat hanya di memori; audit log mencatat pengiriman tanpa isi pesan.
- Draft AI mengirim maksimal 25 pesan terakhir chat terpilih ke Claude CLI tanpa tools; isi chat diperlakukan sebagai data, bukan instruksi.
- Membuka chat tidak mengirim tanda "dibaca". **Putuskan** menghapus perangkat tertaut dan sesi lokal.

## Menghubungkan Confluence

1. `cp .env.example .env.local`, isi `CONFLUENCE_BASE_URL` dan `CONFLUENCE_AUTH`
   - Data Center: Personal Access Token → `CONFLUENCE_AUTH=bearer`
   - Cloud: API token + `CONFLUENCE_EMAIL` → `CONFLUENCE_AUTH=basic` (base URL diakhiri `/wiki`)
2. `npm run token:confluence` — token disimpan di macOS Keychain (service `tech-lead-cockpit.confluence`)
3. Aktifkan VPN, restart `npm run dev`, cek di menu **Koneksi**
4. Sertifikat internal ditolak? `NODE_EXTRA_CA_CERTS=/path/ca.pem npm run dev`
