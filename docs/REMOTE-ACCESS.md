# Remote Cockpit (akses dari HP lewat Tailscale)

Remote Cockpit membuat Cockpit di laptop bisa dipantau dan sedikit dikendalikan dari HP, selama laptop menyala. Fitur ini opt-in, berdurasi, dan hanya lewat tailnet Tailscale milik Anda. Tidak ada port yang dibuka ke LAN atau internet.

## Model keamanan

| Aspek | Perilaku |
|---|---|
| Default | **Mati.** Hanya ada listener `127.0.0.1` (Vite 5173 / connector 5174). |
| Mengaktifkan | Hanya dari UI desktop (topbar → **Remote**), dengan PIN atau Touch ID, dan wajib memilih durasi: 2 jam, 8 jam, atau sampai jam tertentu (maksimal 24 jam). Tidak ada pilihan "selamanya". |
| Listener | Saat aktif, connector membuka listener kedua yang bind **hanya** ke alamat Tailscale Mac (100.64.0.0/10, dideteksi lewat `tailscale ip -4`, dengan cadangan interface `utun`). Default port `5175` (`TLC_REMOTE_PORT`). Bila Tailscale tidak ada atau tidak tersambung, aktivasi ditolak dengan pesan yang jelas. |
| HTTPS | `tailscale cert` untuk nama MagicDNS `*.ts.net` (sertifikat di `~/.tech-lead-cockpit/remote/tls`). Bila gagal, listener tetap HTTP di IP Tailscale dan UI menampilkan alasannya; PWA hanya bisa di-install lewat HTTPS. |
| Mati otomatis | Saat durasi habis (timer, dan dicek lagi di setiap request), saat dimatikan dari desktop atau HP, saat connector/Cockpit ditutup atau restart (status aktif tidak pernah disimpan), dan setelah 10 percobaan autentikasi gagal. Saat mati, listener ditutup (`close` dan `closeAllConnections`) dan semua token sesi, kode pairing, serta draft laporan dibuang. |
| Pairing | Desktop membuat kode sekali pakai `XXXX-XXXX` (QR + ketik), berlaku 2 menit, hanya saat Remote aktif. Kode baru membatalkan kode lama; 5 kode salah menghapus kode yang sedang berlaku. HP menukar kode dengan *device secret* (32 byte) yang disimpan di HP; laptop hanya menyimpan SHA-256-nya (`~/.tech-lead-cockpit/remote/devices.json`, 0600). Maksimal 5 perangkat. |
| Sesi | HP menukar device secret dengan token sesi = HMAC(kunci aktivasi acak, device id, nonce, secret). Token berlaku 15 menit dan tidak pernah melewati akhir aktivasi. Kunci aktivasi dibuat ulang setiap kali Remote diaktifkan, jadi token lama tidak berlaku lagi setelah Remote dimatikan. |
| Pencabutan | Desktop → Remote → Perangkat → **Cabut**: perangkat dihapus dan sesinya langsung berhenti. |
| Whitelist | Listener remote memakai tabel rute tertutup (`connector/remote/server.ts`): aset PWA `/m/*` dan API `/m/api/*`. Rute connector desktop (push coder, publish Confluence, transisi Jira, simpan token, chat AI, kirim WA bebas, kontrol Remote) tidak bisa dijangkau dari sana. Ini diuji di `connector/remote/remote.test.ts`. |
| Header | Host harus nama/IP Tailscale Mac (menahan DNS rebinding), Origin harus sama, CSP ketat tanpa inline script, `no-store` untuk API. |
| Notifikasi & audit | Banner macOS dan toast di desktop setiap kali perangkat tersambung. Audit (`~/.tech-lead-cockpit/audit.jsonl`): `remote.enable`, `remote.disable`, `remote.pair`, `remote.revoke`, `remote.connect`, dan `remote.action` untuk setiap aksi dari HP (lihat maupun kirim). |

Batasan: PIN/Touch ID diverifikasi di UI (hash PIN ada di storage webview). Endpoint kontrol `/api/connector/remote/*` hanya ada di listener lokal dan dilindungi cek origin aplikasi dan header `X-TLC-Client`, sama seperti endpoint connector lain. Proses lokal yang jahat di Mac yang sama sudah berada di dalam batas kepercayaan itu.

## API mobile

| Rute | Isi |
|---|---|
| `POST /m/api/pair` | `{code, name}` → `{deviceId, secret}` |
| `POST /m/api/session` | `{deviceId, secret}` → token sesi |
| `GET /m/api/projects` | Proyek: dev % (aturan Progress Report + peak anti-turun), stage, task yang perlu perhatian, target selesai dari estimasi |
| `GET /m/api/agent-tasks` | Jumlah per status dan 30 task terbaru |
| `GET /m/api/mrs` | MR terbuka (reviewer, assigned, dibuat oleh saya) |
| `GET /m/api/e2e` | Run E2E terakhir per proyek |
| `POST /m/api/report/draft` | Draft Progress Report untuk satu proyek (disimpan di connector selama 10 menit) |
| `POST /m/api/report/send` | `{draftId, confirm: true}`: mengirim teks draft itu ke grup WhatsApp yang diatur di laptop. HP tidak bisa mengganti teks maupun tujuannya. |
| `POST /m/api/remote/disable` | `{confirm: true}`: mematikan Remote |

Grup tujuan laporan diatur per proyek di desktop: Remote → Tujuan Progress Report (hanya grup `@g.us`).

## Setup (sekali)

1. **Mac:** pasang Tailscale versi standalone dari tailscale.com/download (versi App Store kadang tidak bisa menulis sertifikat untuk `tailscale cert`), lalu login.
2. **Admin console Tailscale** (login.tailscale.com → DNS): aktifkan **MagicDNS** dan **HTTPS Certificates**.
3. **iPhone:** pasang app Tailscale, login dengan akun yang sama, dan pastikan statusnya Connected.
4. Uji dari Mac: `tailscale ip -4` harus menampilkan alamat `100.x.y.z`.

## Pemakaian

1. Di Cockpit desktop: topbar → **Remote** → pilih durasi → masukkan PIN (atau Touch ID) → **Aktifkan**. Pastikan alamatnya `https://<mac>.<tailnet>.ts.net:5175/m/`. Bila yang muncul peringatan HTTPS, cek langkah setup 2.
2. **Buat kode pairing**, lalu pindai QR dengan kamera iPhone; Safari membuka halaman dengan kode terisi. Ketuk **Pasangkan**.
3. Safari → Share → **Add to Home Screen**. Aplikasi Home Screen di iOS memakai storage terpisah dari Safari; bila aplikasinya meminta pairing lagi, buat kode baru di laptop dan ketik di aplikasi itu.
4. Saat Remote mati, aplikasi tetap terbuka (dari cache service worker) dan menampilkan "Remote Cockpit sedang nonaktif".

## Uji lokal tanpa Tailscale

`TLC_REMOTE_LOOPBACK=1` membuat listener remote bind ke `127.0.0.1` (HTTP saja). Ini hanya untuk pengembangan dan tidak memperluas akses:

```bash
npm run build:connector && TLC_REMOTE_LOOPBACK=1 CONNECTOR_PORT=5184 TLC_REMOTE_PORT=5185 TLC_NO_WA_RESUME=1 node dist-connector/server.mjs
```

## Follow-up

- Web Push (agent selesai/gagal, E2E gagal) ke PWA. Butuh VAPID key di Keychain, subscription per perangkat, dan pengiriman dari connector; di iOS hanya untuk PWA yang sudah di-install (iOS 16.4+).
- Aplikasi iOS native lewat Tauri 2 mobile di atas API `/m/api` yang sama (device secret disimpan di Keychain iOS).
- Peak % anti-turun di HP disimpan di connector (`remote/peaks.json`), terpisah dari peak di localStorage desktop. Bisa disatukan bila peak desktop dipindah ke connector.
