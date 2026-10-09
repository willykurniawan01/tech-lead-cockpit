export interface TeamsUser {
  id: string;
  displayName: string;
  email: string;
  jobTitle?: string;
}

export interface TeamsDeviceCodeAuth {
  userCode: string;
  verificationUri: string;
  message: string;
  expiresAt: number;
}

export interface TeamsStatus {
  connected: boolean;
  user?: TeamsUser;
  tenantId: string;
  clientId: string;
  deviceCodeAuth?: TeamsDeviceCodeAuth;
  error?: string;
}

export interface TeamsChat {
  id: string;
  title: string;
  chatType: 'oneOnOne' | 'group' | 'meeting' | 'channel' | 'notes' | string;
  lastUpdatedDateTime: string;
  lastMessage?: {
    preview: string;
    sender: string;
    timestamp: string;
  };
  detectedMRs?: string[];
}

export interface TeamsMessageAttachment {
  name: string;
  contentType?: string;
  contentUrl?: string;
  thumbnailUrl?: string;
}

export interface TeamsMessage {
  id: string;
  sender: string;
  senderId?: string;
  isMe: boolean;
  timestamp: string;
  content: string;
  detectedMRs?: string[];
  attachments?: TeamsMessageAttachment[];
}

export type TeamsTone = 'casual' | 'professional' | 'formal' | 'mentoring' | 'concise';

export interface TeamsToneOption {
  id: TeamsTone;
  label: string;
  hint: string;
  description: string;
}

export const TEAMS_TONES: TeamsToneOption[] = [
  {
    id: 'casual',
    label: 'Santai & Ramah',
    hint: 'Akrab & santai untuk rekan dev (boleh aku/kamu, mas/mba)',
    description: 'Gaya santai, ramah, dan bersahabat untuk sesama rekan developer (boleh sapaan mas/mba atau aku/kamu). Hangat, suportif, tanpa bahasa birokratis.',
  },
  {
    id: 'professional',
    label: 'Profesional',
    hint: 'Lugas, to the point, fokus ke solusi teknis',
    description: 'Gaya komunikasi profesional, lugas, to the point, dan solutif sebagai Tech Lead. Langsung fokus ke hal teknis dan langkah berikutnya.',
  },
  {
    id: 'formal',
    label: 'Formal & Sopan',
    hint: 'Santun & terstruktur untuk manajemen / stakeholder',
    description: 'Gaya formal dan santun menggunakan bahasa baku kantor (Bapak/Ibu/Rekan-rekan). Terstruktur mengenai progres, dampak, estimasi, dan keputusan.',
  },
  {
    id: 'mentoring',
    label: 'Mentoring',
    hint: 'Membimbing, edukatif, sertakan alasan & best practice',
    description: 'Gaya membimbing (mentoring), empatik, dan edukatif. Jelaskan alasan teknis atau best practice secara ramah agar developer memahami konteks keputusannya.',
  },
  {
    id: 'concise',
    label: 'Singkat (ACK)',
    hint: 'Sangat padat, 1-2 kalimat konfirmasi cepat',
    description: 'Sangat singkat, padat, dan efisien (maksimal 1-2 kalimat). Langsung ke intinya atau konfirmasi cepat (ACK).',
  },
];

export interface TeamsAttachmentInput {
  filename: string;
  mimetype: string;
  data: string; // base64
  size?: number;
}

export interface TeamsSendRequest {
  chatId: string;
  content: string;
  attachment?: TeamsAttachmentInput;
}

export interface TeamsDraftRequest {
  chatId: string;
  instructions?: string;
  tone?: TeamsTone;
  provider?: string;
  model?: string;
}

export interface TeamsDraftResponse {
  draft: string;
  provider: string;
  model?: string;
}
