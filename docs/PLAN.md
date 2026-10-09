# Tech Lead Cockpit — Development Plan

## Visi
Aplikasi desktop lokal untuk membantu Tech Lead melakukan code review, memahami task dari perubahan MR, membuat TAD, dan mengelola integrasi Jira/Confluence tanpa memindahkan source code ke server publik.

## Prinsip Utama
- Desktop-first: Tauri + Svelte/TypeScript.
- Local connector: Go sidecar untuk akses GitLab internal melalui VPN laptop.
- Source of truth review: GitLab MR dan diff.
- AI hanya memberi rekomendasi/draft; keputusan publish, approve, merge, dan transition tetap dikonfirmasi user.
- Token disimpan di OS Keychain, bukan localStorage atau repo.
- Diff/source tidak dipersist permanen secara default.
- Read-only sebagai default; write action opt-in dan diaudit.

## MVP — 3 Fitur Utama

### 1. GitLab MR Review + Jira Automation

#### Entry point utama: MR-first
1. User paste link MR atau memilih MR dari inbox.
2. Connector mengambil metadata, branch, commits, changed files, diff, pipeline, approval state.
3. Sistem mendeteksi Jira issue key dari branch, title, commit message, dan description.
4. Panel Jira menampilkan issue dan acceptance criteria sebagai konteks.
5. Sistem menganalisis perubahan dan menyusun task terdeteksi.
6. User mengonfirmasi/mengedit task.
7. User melakukan review diff dan membuat draft komentar.
8. User publish komentar setelah konfirmasi.
9. Saat MR merged, sistem memproses rule transition Jira setelah validasi dan audit.

#### Change-to-Task Detection
Output wajib:
- `task_title`
- `summary`
- `category`: feature, bugfix, refactor, security, API, database, UI, infra, docs, test
- `scope`
- `risk_level`
- `confidence`
- `evidence`: file paths, diff hunks, tests, API/migration changes
- detected Jira keys

AI tidak boleh memberikan kesimpulan tanpa evidence. Jika confidence rendah, tampilkan beberapa hipotesis dan minta konfirmasi.

#### Risk detection awal
Tandai MR jika menyentuh:
- auth/session/permission
- database/migration
- payment/financial data
- infrastructure/deployment
- API contract
- secret/config
- file count atau diff size besar
- tests tidak ikut berubah

#### Jira transition
- Extract key dari MR.
- Ambil transition yang tersedia, jangan mengasumsikan nama status.
- Validasi current status dan target transition.
- Gunakan `head_sha`/MR version agar tidak bekerja pada MR yang sudah berubah.
- Default mode: preview + confirmation.
- Audit issue key, status before/after, MR, actor, timestamp, result.
- Jika tidak ada key atau transition tidak tersedia: jangan mengubah Jira.

### 2. TAD Workspace + Confluence Publisher

#### Flow
1. Generate dari MR/task terkonfirmasi.
2. Pilih template TAD v1.
3. Edit Markdown.
4. Preview Markdown + Mermaid.
5. Validasi section wajib.
6. Compare dengan halaman Confluence jika update.
7. Publish setelah konfirmasi.
8. Gunakan version check untuk mencegah overwrite.

#### TAD v1 sections
1. Document Control
2. Executive Summary
3. Problem & Context
4. Goals / Non-goals
5. Requirements
6. Architecture Overview
7. Detailed Design
8. API / Data / Integration
9. Security & Privacy
10. Reliability & Operations
11. Key Decisions / Alternatives
12. Risks & Mitigations
13. Rollout / Rollback Plan
14. Open Questions
15. Appendix / References

#### Validator
- Section wajib ada.
- Placeholder kosong ditandai.
- Mermaid syntax divalidasi.
- API/database claims harus memiliki evidence dari MR atau ditandai assumption.
- Publish menggunakan `Cache-Control: no-store` untuk diff-sensitive view.

### 3. Tech Lead Dashboard

Tampilan ringkas:
- MR menunggu review.
- Pipeline gagal.
- MR stale/overdue.
- Jira blocker dan overdue.
- TAD draft/belum publish.
- Last sync dan VPN/GitLab connectivity.
- Local notifications.

Dashboard tidak menyimpan source code; metadata boleh dicache dengan TTL dan permission-aware refresh.

## Arsitektur

```text
Tauri Desktop App
├── Svelte UI
├── Tauri commands
├── Go local connector / sidecar
├── SQLite metadata cache (tanpa diff permanen)
└── OS Keychain
        │
        └── VPN laptop
             ├── GitLab internal
             ├── Jira
             └── Confluence
```

### Connector responsibilities
- OAuth GitLab/Jira/Confluence.
- API client dan retry/backoff.
- Webhook/reconcile bila memungkinkan.
- Permission check sebelum membaca diff atau melakukan write.
- Normalize provider data ke model internal:
  - `MergeRequest`
  - `CodeChange`
  - `WorkItem`
  - `Document`
  - `TaskHypothesis`
  - `AuditEvent`

## Security Plan

- OAuth Authorization Code + PKCE.
- Scope minimal: read-only dulu.
- GitLab write scope hanya saat user mengaktifkan write action.
- Token di macOS Keychain.
- No PAT pribadi hardcoded.
- No token/source di logs, analytics, crash reports, atau prompt history.
- Diff tidak disimpan permanen; memory/TTL pendek jika diperlukan.
- AI self-hosted/private enterprise untuk repo sensitif.
- Secret scan + redaction sebelum AI.
- Prompt injection dari kode/MR dianggap untrusted input.
- AI tidak memiliki kemampuan approve/merge/publish langsung.
- Semua komentar, Jira transition, dan Confluence publish diaudit.

## AI Review Policy

AI menerima:
- MR title/description.
- Hunk diff secukupnya.
- File paths.
- Test summary.
- Jira acceptance criteria bila diizinkan.

AI menghasilkan:
- task hypothesis
- risk summary
- review checklist
- potential issues
- TAD draft
- draft comment/release note

AI tidak:
- auto-merge
- auto-approve
- auto-comment tanpa konfirmasi
- mengakses token langsung
- menyimpan source/diff di cloud tanpa policy yang disetujui

## Tahapan Implementasi

### Phase 0 — Fondasi
- Buat repository `tech-lead-cockpit`.
- Tauri + Svelte shell.
- Go connector sidecar.
- Keychain abstraction.
- VPN/GitLab health check.
- Internal normalized models.
- Logging redaction dan audit skeleton.

### Phase 1 — MR Review Read-only
- GitLab OAuth PKCE.
- MR list/detail.
- Pipeline/approval status.
- Changed files dan diff viewer.
- Search/filter.
- Jira key extraction tanpa write.
- Change-to-task detection dengan evidence.
- Local cache metadata.

### Phase 2 — TAD Workspace
- TAD template v1.
- Markdown editor/preview.
- Mermaid preview.
- Validator.
- Generate dari MR/task.
- Save draft lokal.
- Export Markdown/PDF.

### Phase 3 — Confluence
- Confluence OAuth.
- Space/page search.
- Create page.
- Update page dengan version protection.
- Diff preview.
- Publish approval + audit.

### Phase 4 — Jira Automation
- Jira OAuth.
- Issue context/acceptance criteria.
- Transition discovery.
- Rule per project.
- MR merged trigger via webhook/reconcile.
- Preview/confirmation.
- Idempotency dan audit.

### Phase 5 — Dashboard & Background Agent
- Menu-bar app.
- Background sync.
- Notifications.
- Retry saat VPN putus.
- Stale data indicator.
- Daily briefing.

## Testing / Acceptance Criteria

### Unit
- MR link/project/issue key extraction.
- Task classification and evidence mapping.
- Risk rules.
- Jira transition validation.
- TAD required sections.
- Mermaid validation.
- Confluence version conflict.
- Token/keychain abstraction.

### Integration with fixtures
- GitLab MR fixture tanpa network.
- Jira issue/transition fixture.
- Confluence create/update fixture.
- AI fixture response; no real secrets.

### Security tests
- No token in logs.
- No diff persisted after TTL.
- Permission denial blocks diff/write.
- Stale `head_sha` blocks write.
- Unknown Jira key does not trigger transition.

### MVP acceptance
- VPN aktif → MR internal dapat dibaca dari laptop.
- Task dapat dideteksi dari MR dengan evidence dan confidence.
- TAD dapat diedit, divalidasi, dan dipreview.
- Confluence create/update meminta konfirmasi dan mencegah overwrite.
- MR merged dapat memicu preview Jira transition yang idempotent.
- Tidak ada source code yang dikirim ke server publik secara default.

## Keputusan yang Perlu Disetujui

1. GitLab internal diakses melalui VPN yang sama di laptop.
2. Tauri + Svelte + Go sidecar sebagai stack.
3. MVP read-only sebelum write action.
4. AI provider: local/private enterprise untuk repo sensitif.
5. Jira transition default preview-first.
6. Diff tidak dipersist permanen.
7. Confluence TAD memakai TAD v1 di atas.

## Risiko / Gap

- Struktur Jira issue key dan transition berbeda per project.
- GitLab VPN/API mungkin memiliki certificate atau DNS khusus.
- OAuth client perlu didaftarkan di GitLab/Jira/Confluence.
- AI review code memerlukan keputusan security/compliance.
- Confluence update rawan conflict sehingga version check wajib.
- Task detection adalah rekomendasi; user tetap pemilik keputusan.

## Langkah Berikutnya

1. Buat repository dan project skeleton Tauri.
2. Implement GitLab MR read-only melalui VPN.
3. Implement change-to-task detection berbasis fixture.
4. Buat TAD editor/validator.
5. Tambahkan Confluence OAuth dan create-page preview.
6. Baru implement Jira transition setelah flow read-only stabil.
