# Rancangan: Aksi dari Chat (Teams / WhatsApp)

Status: draft rancangan · Belum diimplementasi

## 1. Tujuan

Pesan di Teams/WhatsApp sering berisi permintaan yang ujungnya kerja operasional:

| Contoh pesan | Yang biasanya dilakukan Tech Lead |
|---|---|
| "Mas, top-up QRIS di staging gagal terus, error 500" | Cari service terkait → lihat log → cek deploy terakhir → balas temuan / buat tiket bug |
| "Tolong restart core-fds di staging ya, nyangkut" | Cek status container → restart → pastikan sehat → balas |
| "Bisa cek log transaksi TRX123 jam 10-an?" | Cari ID di log service terkait → rangkum → balas |

Cockpit membaca pesan itu, **mengusulkan rencana aksi**, menjalankan langkah yang disetujui, lalu menyiapkan draft balasan. Keputusan tetap di Tech Lead.

## 2. Prinsip keamanan (wajib, tidak bisa ditawar)

1. **Isi chat adalah data, bukan perintah.** Siapa pun di grup bisa menulis "restart prod". AI hanya mengklasifikasikan dan mengusulkan. Tidak ada aksi yang jalan otomatis dari isi pesan.
2. **Katalog aksi tertutup.** AI memilih dari daftar aksi yang sudah didefinisikan, dengan parameter tervalidasi (nama container dari mapping, rentang waktu terbatas). Tidak ada shell bebas, dan teks chat tidak pernah disisipkan ke command.
3. **Dua tingkat aksi:**
   - **Baca** (log, status, health, deploy terakhir): sekali klik.
   - **Tulis** (restart, redeploy, buat tiket): dialog konfirmasi yang menampilkan target dan command persis, plus **Touch ID/PIN**.
4. **Staging saja.** Produksi tidak ada di katalog. Pesan yang menyebut prod/production ditandai dan tidak menghasilkan aksi tulis.
5. **Rem pengaman:** cooldown per container (mis. 1 restart / 10 menit, maks 5 / hari), timeout per langkah, dan tolak target yang tidak ada di mapping.
6. **Kredensial tidak disimpan app.** SSH memakai `~/.ssh/config` dan ssh-agent milik user; token GitLab/Jira tetap di Keychain.
7. **Log disensor sebelum dikirim ke AI:** token, password, Authorization header, nomor kartu/PAN, NIK, nomor HP dimasking. Ukuran dibatasi.
8. **Audit:** setiap eksekusi dicatat di `audit.jsonl` (siapa minta, pesan sumber, aksi, target, hasil). Isi log lengkap tidak dipersist permanen, mengikuti prinsip PLAN.md.

## 3. Kondisi infrastruktur saat ini (dari repo Services)

- Staging berjalan sebagai **Docker Compose di VM**, di-deploy GitLab CI lewat SSH:
  `cd /opt/app/<project> && git pull && make docker-start-staging` (`docker compose -f docker-compose-staging.yml up -d --build --force-recreate`).
- Ada beberapa host staging (variabel CI): `STG_IP`, `STG_LIVE_IP`, `STG_SB_IP`, `STG_FM_CORE_IP`, `STG_VM_IP`.
- `container_name` di `docker-compose-staging.yml` = nama project (mis. `core-fds-ultimate`).
- **Tidak ditemukan logging terpusat** (Sentry/ELK/Loki/Grafana) di repo. Sumber log = `docker logs` di VM.

Karena itu adapter v1 = **SSH + docker** ke VM staging, dengan opsi menambah adapter lain (Grafana/Kibana) kalau ternyata ada.

## 4. Alur

```
Pesan masuk ──► Triage AI ──► Rencana Aksi ──► Eksekusi ──► Ringkasan + Draft Balasan
(Teams/WA)      (intent,       (langkah dari    (baca: 1 klik;  (user kirim sendiri,
                 entitas)       katalog, bisa    tulis: konfirm   opsi buat tiket Jira)
                                diedit user)     + Touch ID)
```

### 4.1 Triage

Dipicu tombol **⚡ Analisa** di sebuah pesan atau thread. Fase lanjut: pemindaian pesan baru di background yang hanya memberi badge, tanpa eksekusi.

AI mengembalikan JSON terstruktur, divalidasi dengan skema:

```json
{
  "intent": "bug_report | restart_request | log_request | deploy_request | question | other",
  "service": "core-fds-ultimate",
  "serviceConfidence": 0.8,
  "environment": "staging",
  "timeWindow": { "from": "2026-10-04T10:00:00+07:00", "to": "2026-10-04T10:30:00+07:00" },
  "identifiers": ["TRX123", "HTTP 500"],
  "symptom": "top-up QRIS gagal 500",
  "urgency": "normal | high"
}
```

Pemetaan ke service:

1. tabel alias (mis. "fds" → `core-fds-ultimate`);
2. kalau ambigu, analisa read-only ke folder Services (sama seperti generator TAD): cari endpoint/fitur yang disebut;
3. kalau tetap ambigu, user memilih dari dropdown.

### 4.2 Rencana aksi

Panel di sebelah thread berisi intent, entitas (bisa diedit), dan langkah usulan dengan centang. Contoh untuk *bug report*:

1. ☑ `container.status` core-fds-ultimate @ staging *(baca)*
2. ☑ `logs.search` "TRX123", "500" · 10:00–10:30 *(baca)*
3. ☑ `deploys.recent` core-fds-ultimate · 3 terakhir *(baca)*
4. ☐ `jira.create_bug` dengan bukti log *(tulis)*

### 4.3 Eksekusi dan analisa

- Output langkah baca di-stream ke panel.
- Log yang ditemukan disensor lalu dianalisa AI: kemungkinan penyebab, baris relevan, korelasi dengan deploy/MR terakhir, dan lokasi kode terkait (read-only ke repo Services).
- Hasil akhir: **draft balasan** sesuai audiens (tim/PM/klien, sama seperti fitur balas WA), dan opsi **buat tiket Jira** berisi ringkasan + potongan log tersensor.

## 5. Katalog aksi v1

| Aksi | Tingkat | Implementasi |
|---|---|---|
| `container.status` | baca | `docker ps -a --filter name=^<c>$` + `docker inspect` (status, restart count, started at) + `docker stats --no-stream` |
| `logs.tail` | baca | `docker logs --since <dur> --tail <n> <c>` (maks 30 menit / 5.000 baris) |
| `logs.search` | baca | `docker logs --since … <c> 2>&1 \| grep -F -e <id>…` (identifier di-escape, maks 5) |
| `service.health` | baca | `curl -s -m 5 localhost:<port>/<health>` dari host |
| `deploys.recent` | baca | GitLab API: pipeline terakhir branch `staging` + commit/MR terkait |
| `container.restart` | **tulis** | `docker restart <c>` → tunggu → `container.status` + `service.health` |
| `staging.redeploy` | **tulis** | GitLab API: retry/trigger pipeline `deploy-staging` (bukan SSH langsung) |
| `jira.create_bug` | **tulis** | Jira connector yang sudah ada |

Command dibentuk dari template di connector. Parameter divalidasi: container harus ada di mapping (`^[a-z0-9-]+$`), durasi dan jumlah baris diberi batas atas.

## 6. Konfigurasi infra

File `~/.tech-lead-cockpit/infra.json` (bukan di repo), bisa di-generate otomatis dari `docker-compose-staging.yml` + `.gitlab-ci.yml` lalu dikoreksi manual:

```json
{
  "hosts": {
    "stg-main": { "ssh": "stg-main", "label": "Staging utama (STG_IP)" },
    "stg-sandbox": { "ssh": "stg-sb", "label": "Sandbox (STG_SB_IP)" }
  },
  "services": {
    "core-fds-ultimate": { "host": "stg-main", "container": "core-fds-ultimate", "health": "http://localhost:8081/health", "aliases": ["fds"] }
  },
  "restartRequesters": ["Agus Supriyatna", "Ridwan Alimuddin"],
  "limits": { "restartCooldownMin": 10, "maxRestartsPerDay": 5 }
}
```

`ssh` merujuk alias di `~/.ssh/config`, jadi IP, user, dan key tetap dikelola user.

**Lapisan pengaman di server (disarankan):** user SSH khusus Cockpit dengan `command="/usr/local/bin/tlc-ops"` di `authorized_keys`. Script itu hanya menerima `status|logs|restart <container>`, jadi kalaupun laptop disusupi, akses lewat key ini tetap terbatas.

## 7. Model data

```ts
interface ActionRequest {
  id: string;
  source: { channel: 'teams' | 'whatsapp'; chatId: string; messageId: string; sender: string; text: string };
  triage: Triage;                  // hasil 4.1, sudah dikoreksi user
  steps: ActionStep[];
  status: 'draft' | 'running' | 'done' | 'cancelled';
  createdAt: string;
}
interface ActionStep {
  action: 'container.status' | 'logs.tail' | 'logs.search' | 'service.health' | 'deploys.recent' | 'container.restart' | 'staging.redeploy' | 'jira.create_bug';
  params: Record<string, string | number>;
  tier: 'read' | 'write';
  status: 'pending' | 'awaiting-confirm' | 'running' | 'ok' | 'failed' | 'skipped';
  output?: string;                 // dipotong + disensor, hanya disimpan di memori/sesi
  startedAt?: string;
  finishedAt?: string;
}
```

Disimpan di `~/.tech-lead-cockpit/ops/requests.jsonl` (metadata). Output log hanya di memori.

## 8. UI

- **Thread Teams/WA:** tombol ⚡ di setiap pesan (hover) dan di header ("Analisa thread").
- **Panel Rencana Aksi** (drawer kanan): intent dan entitas yang bisa diedit, daftar langkah dengan badge *baca/tulis*, tombol "Jalankan langkah baca", output per langkah, analisa AI, draft balasan, dan buat tiket.
- **Dialog konfirmasi aksi tulis:** target host + container, command persis, pengirim permintaan (dengan peringatan bila bukan `restartRequesters`), sisa kuota restart hari ini, lalu Touch ID.
- **Dashboard:** kartu "Permintaan Ops" berisi daftar request terbuka.

## 9. Tahapan

| Fase | Isi | Hasil |
|---|---|---|
| F1 · Baca | `infra.json` + generator mapping, adapter SSH, `container.status`/`logs.*`/`service.health`, triage AI, analisa log + sensor, draft balasan | Bug report → temuan log dalam 1–2 menit, tanpa risiko mengubah apa pun |
| F2 · Tulis | `container.restart` dengan konfirmasi + Touch ID + cooldown + audit, `jira.create_bug` | Permintaan restart ditangani dari Cockpit dengan aman |
| F3 · Otomasi ringan | Pemindaian pesan baru (badge saja), `deploys.recent`/`staging.redeploy` via GitLab API, wrapper `tlc-ops` di server | Inbox ops dan jejak deploy |

## 10. Pertanyaan terbuka

1. Apakah laptop bisa SSH langsung ke VM staging (lewat VPN)? Sudah ada entri di `~/.ssh/config`?
2. Apakah ada log terpusat (Grafana/Kibana/Graylog/Sentry) yang tidak terlihat dari repo?
3. "Restart" yang diharapkan: `docker restart` (cepat, tanpa build) atau `make docker-start-staging` (rebuild, lebih lama)?
4. Siapa saja yang boleh meminta restart?
5. Produksi tetap di luar cakupan? Rekomendasi: ya.
6. Perlu token GitLab (read API) untuk `deploys.recent`?

---

# Bagian B: Pemantauan Grup Production Support

## B1. Tujuan

Grup production support (Teams atau WhatsApp) terus menerima laporan issue. Yang dibutuhkan:

1. **Tidak ada laporan yang terlewat.** Laporan terdeteksi otomatis, muncul sebagai notifikasi, dan masuk ke daftar issue.
2. **Satu klik untuk mulai menelusuri.** Service terkait, deploy terakhir, tiket serupa, lokasi kode, dan log (bila diizinkan) dikumpulkan jadi satu ringkasan.
3. **Respons cepat ke pelapor**, dalam bentuk draft balasan yang tetap dikirim oleh user sendiri.

## B2. Alur

```
Pesan baru di grup yang dipantau
   │
   ▼
Penyaring cepat (aturan) ──tidak──► abaikan
   │ mungkin issue
   ▼
Klasifikasi AI (model hemat, mis. Gemini Flash)
   │ issue? severity? service? ID transaksi?
   ▼
Gabung dengan issue yang sama (thread / ID / rentang waktu)
   │
   ├──► Notifikasi macOS (sesuai ambang severity)
   └──► Daftar Issue (status, umur, SLA)
             │ klik "Telusuri"
             ▼
        Investigasi read-only ──► Ringkasan + bukti ──► Draft balasan / Tiket Jira / Draft DM ke dev
```

## B3. Grup yang dipantau

- Di halaman Teams/WhatsApp, tombol **"Pantau sebagai Production Support"** pada chat atau grup.
- Disimpan di `~/.tech-lead-cockpit/watch.json`: id chat, kanal, label, ambang notifikasi, jam tenang.
- **WhatsApp:** Baileys sudah menerima pesan real-time (`messages.upsert`), jadi pesan grup yang dipantau langsung masuk ke detektor.
- **Teams:** connector sekarang mengambil pesan lewat Graph saat chat dibuka. Untuk grup yang dipantau, ambil 20 pesan terakhir setiap 30–60 detik sejak pesan terakhir yang sudah dilihat, dengan backoff bila kena rate limit Graph.

## B4. Deteksi issue

**Tahap 1, aturan (gratis dan instan):** mengandung kata seperti *error, gagal, tidak bisa, down, timeout, 500, pending, double, komplain, urgent*, pola ID transaksi atau nominal, atau screenshot; dan pengirimnya bukan diri sendiri.

**Tahap 2, AI** (hanya untuk kandidat tahap 1) mengembalikan JSON:

```json
{
  "isIssue": true,
  "severity": "P1 | P2 | P3 | P4",
  "title": "Top-up QRIS gagal untuk beberapa merchant",
  "feature": "Top-up QRIS",
  "serviceGuess": ["core-payment-ultimate"],
  "identifiers": ["TRX123", "MID 4455"],
  "impact": "beberapa merchant, sejak ±10:05",
  "reporter": "CS - Dewi",
  "needsInfo": ["screenshot error", "jam kejadian"]
}
```

Panduan severity (bisa diubah):

| Severity | Kriteria |
|---|---|
| P1 | Transaksi/fitur utama mati untuk banyak user |
| P2 | Fitur penting terganggu sebagian |
| P3 | Kasus satu user atau ada workaround |
| P4 | Pertanyaan atau permintaan data |

**Menggabungkan laporan:** pesan lanjutan di thread yang sama, identifier yang sama, atau fitur yang sama dalam 30 menit masuk ke issue yang sudah ada. Satu insiden tidak jadi sepuluh notifikasi.

## B5. Notifikasi

- **Aplikasi Mac:** notifikasi native lewat `tauri-plugin-notification`. **Browser:** Web Notification API.
  Isinya `P2 · Top-up QRIS gagal (CS - Dewi)`; klik membuka issue-nya.
- Ambang per grup (mis. hanya P1–P2 yang berbunyi; P3–P4 masuk daftar tanpa suara) dan jam tenang (kecuali P1).
- Badge jumlah issue terbuka di nav dan kartu "Production Support" di dashboard.
- **Ke HP (opsional, opt-in):** notifikasi grup aslinya sudah sampai ke HP lewat aplikasi Teams/WA. Yang ditambahkan Cockpit adalah ringkasan triase, yang bisa dikirim ke chat pribadi sendiri (WA "Message yourself" atau Teams "Catatan Pribadi"). Ini satu-satunya pengiriman otomatis, dan hanya ke diri sendiri.
- **Tetap memantau saat jendela ditutup:** connector bisa dijalankan sebagai LaunchAgent macOS, sehingga hidup selama laptop menyala. Selama aplikasi tertutup, notifikasi tetap muncul dari connector.

## B6. Daftar Issue (view baru "Production Support")

| Kolom | Isi |
|---|---|
| Severity | P1–P4 (bisa dikoreksi) |
| Issue | judul ringkas + fitur |
| Pelapor / grup | siapa dan dari grup mana |
| Umur | sejak laporan pertama; merah bila lewat batas respons pertama (mis. P1 15 menit, P2 1 jam) |
| Status | Baru → Ditelusuri → Menunggu info → Diteruskan ke dev → Selesai |
| Tiket | link Jira bila sudah dibuat |

Detail issue berisi pesan-pesan asli, hasil triase, langkah investigasi, dan riwayat tindakan.

## B7. "Telusuri": investigasi read-only

Langkah otomatis setelah diklik. Semuanya hanya membaca:

1. **Draft balasan cepat ke grup:** "Baik, sedang kami cek. Mohon info jam kejadian dan ID transaksinya." Isinya menyesuaikan `needsInfo` dan baru terkirim setelah user menekan Kirim.
2. **Service terkait:** alias, lalu pencarian di repo Services (endpoint, pesan error, kode error) dengan akses read-only seperti generator TAD.
3. **Perubahan terakhir:** pipeline `deploy-production` dan MR yang ter-merge dalam 3 hari terakhir untuk service itu (GitLab API). Insiden sering muncul tepat setelah deploy.
4. **Tiket serupa:** pencarian Jira (JQL teks) untuk bug terbuka atau yang baru ditutup dengan gejala mirip.
5. **Log:**
   - staging lewat adapter Bagian A;
   - **produksi hanya bila disetujui**: akses read-only terpisah, sensor PII lebih ketat (data nasabah), dan rentang waktu kecil.
6. **Ringkasan AI:** dugaan penyebab dengan tingkat keyakinan, bukti (baris log, commit/MR, potongan kode), dampak, dan saran langkah berikutnya. Termasuk siapa yang paling relevan untuk ditugaskan, dilihat dari committer terakhir atau `CODEOWNERS`.

Aksi setelah ringkasan. Semuanya butuh klik, dan yang menulis butuh konfirmasi:

- **Buat tiket Jira** (Bug/Incident) berisi ringkasan, bukti tersensor, severity, dan link pesan.
- **Draft DM ke developer** yang disarankan, berisi konteks lengkap.
- **Draft update status ke grup** dengan bahasa non-teknis (audiens PM/klien). Kalau issue P1 belum ada update 30 menit, Cockpit mengingatkan.
- **Tandai selesai**, dengan draft pesan penutupan.

**Batas tegas:** tidak ada aksi tulis ke produksi (restart, deploy, ubah data) dari Cockpit. Kalau perlu restart produksi, Cockpit hanya menyiapkan langkah dan draft eskalasi ke pemegang akses produksi.

## B8. Data dan privasi

- Issue disimpan di `~/.tech-lead-cockpit/support/issues.jsonl`: metadata, ringkasan, dan tindakan.
- Isi pesan asli disimpan seperlunya (teks laporan). Lampiran dan screenshot tidak disalin.
- Sebelum dikirim ke AI, nomor kartu, NIK, nomor HP, email, dan nama nasabah dimasking.
- Semua tindakan tulis (kirim balasan, buat tiket, DM) tercatat di `audit.jsonl`.

## B9. Tahapan

| Fase | Isi |
|---|---|
| S1 | Pemilihan grup yang dipantau, polling Teams + event WA, detektor (aturan + AI), daftar issue, notifikasi native, draft balasan cepat, buat tiket Jira |
| S2 | Investigasi read-only: service terkait, pencarian kode, deploy/MR terakhir (GitLab), tiket serupa (Jira), log staging, ringkasan AI, saran assignee |
| S3 | Connector sebagai LaunchAgent (selalu memantau), ringkasan ke chat pribadi, pengingat update P1, laporan mingguan (jumlah issue, waktu respons, waktu selesai) untuk report PM |
| S4 (opsional) | Log produksi read-only, bila akses dan kebijakan mengizinkan |

## B10. Pertanyaan terbuka

1. Grup production support ada di Teams, WhatsApp, atau keduanya? Satu grup atau beberapa?
2. Apakah sudah ada definisi severity/SLA internal yang harus diikuti?
3. Tiket insiden dibuat di project Jira mana, dan dengan tipe apa (Bug / Incident / Support)?
4. Apakah kamu punya (atau boleh punya) akses baca log produksi? Jika tidak, investigasi berhenti di kode, deploy, Jira, dan log staging.
5. Notifikasi perlu juga ke HP lewat ringkasan ke chat pribadi, atau cukup di laptop?
