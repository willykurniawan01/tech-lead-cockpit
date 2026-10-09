import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { WaAudience, WaTemplate } from '../../src/lib/whatsapp/types.ts';
import { DATA_DIR } from '../paths.ts';

export const TEMPLATES_FILE = join(DATA_DIR, 'wa-templates.json');

const AUDIENCE_IDS: WaAudience[] = ['team', 'pm', 'client', 'friend'];
const MAX_TEMPLATES = 200;

export const DEFAULT_TEMPLATES: WaTemplate[] = [
  {
    id: 'team-progress',
    name: 'Minta update progres task',
    audience: 'team',
    body: 'Halo {{nama}}, boleh minta update progres untuk {{task}}? Kalau ada blocker langsung kabari ya, biar bisa dibantu 🙏',
  },
  {
    id: 'team-review-done',
    name: 'Review MR selesai',
    audience: 'team',
    body: 'Hi {{nama}}, MR {{mr}} sudah aku review. Ada beberapa catatan di komentar, tolong dicek ya. Kalau sudah di-fix, mention aku lagi untuk re-review.',
  },
  {
    id: 'team-blocker',
    name: 'Tanggapi blocker',
    audience: 'team',
    body: 'Noted {{nama}}, terima kasih infonya. Untuk blocker {{blocker}}, aku bantu cek ke {{pic}} dulu. Sementara itu lanjutkan bagian yang tidak terdampak ya.',
  },
  {
    id: 'team-deploy',
    name: 'Info deploy',
    audience: 'team',
    body: 'Info tim: {{service}} akan di-deploy ke *{{env}}* jam {{jam}}. Mohon tidak merge ke branch {{branch}} sampai deploy selesai. Terima kasih 🙏',
  },
  {
    id: 'pm-status',
    name: 'Update progres fitur',
    audience: 'pm',
    body: 'Halo {{nama}}, update untuk *{{fitur}}*:\n• Progres: {{progres}}\n• Risiko/blocker: {{blocker}}\n• Estimasi selesai: {{estimasi}}\n\nKalau ada prioritas yang berubah, kabari ya.',
  },
  {
    id: 'pm-estimate',
    name: 'Estimasi pekerjaan',
    audience: 'pm',
    body: 'Halo {{nama}}, untuk {{fitur}} estimasi kami {{estimasi}}, dengan asumsi {{asumsi}}. Detail breakdown task ada di TAD {{link}}.',
  },
  {
    id: 'pm-clarify',
    name: 'Klarifikasi requirement',
    audience: 'pm',
    body: 'Halo {{nama}}, mau konfirmasi requirement {{fitur}}: {{pertanyaan}}. Jawaban ini mempengaruhi desain API/data, jadi kami tahan bagian tersebut sampai ada konfirmasi.',
  },
  {
    id: 'client-ack',
    name: 'Konfirmasi pesan diterima',
    audience: 'client',
    body: 'Terima kasih {{nama}}, pesan Bapak/Ibu sudah kami terima. Kami cek terlebih dahulu dan akan kami kabari paling lambat {{waktu}}.',
  },
  {
    id: 'client-followup',
    name: 'Follow-up',
    audience: 'client',
    body: 'Selamat {{waktu_hari}} {{nama}}, kami ingin menindaklanjuti {{topik}}. Apakah ada informasi tambahan yang bisa kami bantu?',
  },
  {
    id: 'client-fixed',
    name: 'Perbaikan selesai',
    audience: 'client',
    body: 'Halo {{nama}}, kendala {{masalah}} sudah kami perbaiki dan sudah aktif sejak {{waktu}}. Mohon dicoba kembali, dan kabari kami jika masih ada kendala. Terima kasih atas kesabarannya 🙏',
  },
  {
    id: 'friend-meetup',
    name: 'Ajak ketemuan',
    audience: 'friend',
    body: 'Eh {{nama}}, {{hari}} ada waktu nggak? Ngopi bareng yuk di {{tempat}} sekitar jam {{jam}} 😄',
  },
  {
    id: 'friend-thanks',
    name: 'Terima kasih',
    audience: 'friend',
    body: 'Makasih banyak ya {{nama}}, {{hal}} ngebantu banget 🙏',
  },
  {
    id: 'friend-later',
    name: 'Balas nanti',
    audience: 'friend',
    body: 'Sori {{nama}}, lagi {{kegiatan}} nih. Nanti aku kabarin lagi ya 👍',
  },
];

function isTemplate(t: unknown): t is WaTemplate {
  const x = t as WaTemplate;
  return (
    typeof x?.id === 'string' && /^[\w-]{1,64}$/.test(x.id) &&
    typeof x.name === 'string' && x.name.trim().length > 0 && x.name.length <= 120 &&
    AUDIENCE_IDS.includes(x.audience) &&
    typeof x.body === 'string' && x.body.trim().length > 0 && x.body.length <= 4096
  );
}

export function validateTemplates(input: unknown): WaTemplate[] {
  if (!Array.isArray(input) || input.length > MAX_TEMPLATES || !input.every(isTemplate)) {
    throw new Error('Format template tidak valid.');
  }
  const ids = new Set(input.map((t) => t.id));
  if (ids.size !== input.length) throw new Error('ID template duplikat.');
  return input.map(({ id, name, audience, body }) => ({ id, name: name.trim(), audience, body }));
}

export async function readTemplates(file = TEMPLATES_FILE): Promise<WaTemplate[]> {
  try {
    return validateTemplates(JSON.parse(await readFile(file, 'utf8')));
  } catch {
    return DEFAULT_TEMPLATES;
  }
}

export async function writeTemplates(templates: WaTemplate[], file = TEMPLATES_FILE): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, JSON.stringify(validateTemplates(templates), null, 2), { mode: 0o600 });
}
