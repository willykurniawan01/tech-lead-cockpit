import { describe, expect, it } from 'vitest';
import type { ProgressTaskRow, TadProgressData } from '../tad/progress-report';
import { applyIssueRefresh, changeCounts, formatWib, isSnapshot, renderScheduledReport, snapshotJiraKeys, type ProgressSnapshot } from './snapshot';

/** Stage comes from the MR (code); the Jira status is only context. 'draft' = draft MR (coding). */
const row = (title: string, key: string, status: string, statusCategory: string, mrState?: 'opened' | 'merged' | 'draft'): ProgressTaskRow => ({
  task: { no: '1', service: 'core', title, jiraKeys: [key] },
  issues: [{ key, issue: { id: key, key, summary: title, status, statusCategory, issueType: 'Task', updated: '', url: '' } }],
  mrs: mrState ? [{ ref: `core!${key}`, iid: 7, state: mrState === 'draft' ? 'opened' : mrState, draft: mrState === 'draft' } as never] : [],
  flags: [],
});

const tad = (rows: ProgressTaskRow[]): TadProgressData => ({ tadId: 'tad-1', tadTitle: 'TAD Promo', summary: { tasks: rows.length, withMr: 0, merged: 0, done: 0, attention: 0 }, rows });

const snap = (rows: ProgressTaskRow[], generatedAt = '2026-10-08T08:30:00.000Z', peak = 0): ProgressSnapshot => ({
  version: 1,
  generatedAt,
  projects: [{ projectId: 'p1', name: 'Promo Engine', peakPercent: peak, tads: [tad(rows)] }],
});

const A = '[BACKEND][CORE][PROMO] - API Create Promo';
const B = '[BACKEND][CORE][PROMO] - Model Promo';
const now = new Date('2026-10-08T09:00:00.000Z'); // 16:00 WIB

describe('scheduled report', () => {
  it('renders a numbers-only summary without the task list', () => {
    const { text, peaks } = renderScheduledReport(snap([row(A, 'PRM-1', 'In Progress', 'indeterminate', 'draft'), row(B, 'PRM-2', 'Done', 'done', 'merged')]), { now });
    expect(text).toContain('📋 *Progress Report — Kamis, 8 Okt 2026*');
    expect(text).toContain('🕓 Data per Kam, 08 Okt 15:30 WIB');
    expect(text).toContain('🚀 *Promo Engine*');
    // (40 + 100) / 2
    expect(text).toContain('📊 *Development: 70%* (2 task)');
    expect(text).toContain('🟢 Selesai 1 · 🟡 Review/QA 0 · 🔵 Coding 1 · ⚪ To Do 0');
    expect(text).not.toContain(A);
    expect(text).not.toContain('PRM-1');
    expect(text).not.toContain('belum diperbarui');
    expect(text).toContain('_Detail task di Cockpit._');
    expect(peaks).toEqual({ p1: 70 });
  });

  it('flags stale data, keeps the higher peak and counts attention', () => {
    const blocked = { ...row(A, 'PRM-1', 'To Do', 'new'), flags: [{ tone: 'err' as const, text: 'x' }] };
    const { text, peaks } = renderScheduledReport(snap([blocked], '2026-10-06T08:00:00.000Z', 40), { now, peaks: { p1: 55 } });
    expect(text).toContain('*Data belum diperbarui 2 hari*');
    expect(text).toContain('Development: 55%');
    expect(text).toContain('⚠️ Perlu perhatian: 1 task');
    expect(peaks.p1).toBe(55);
  });

  it('refreshes Jira data without changing stages, and counts what moved since last time', () => {
    const before = snap([row(A, 'PRM-1', 'To Do', 'new'), row(B, 'PRM-2', 'In Review', 'indeterminate', 'opened')], '2026-10-07T08:00:00.000Z');
    const merged = snap([row(A, 'PRM-1', 'To Do', 'new', 'draft'), row(B, 'PRM-2', 'In Review', 'indeterminate', 'merged')]);
    const current = applyIssueRefresh(merged, { 'PRM-2': { status: 'Done', statusCategory: 'done', assignee: { displayName: 'Budi' } } });
    expect(current.projects[0].tads[0].rows[1].issues[0].issue).toMatchObject({ status: 'Done', statusCategory: 'done', assignee: { displayName: 'Budi' } });
    // A ticket moved past development in Jira counts, even without a detected MR.
    expect(changeCounts(applyIssueRefresh(before, { 'PRM-1': { status: 'READY TO TEST', statusCategory: 'indeterminate' } }), before)).toEqual({ merged: 1, review: 0, inProgress: 0, back: 0, added: 0 });
    expect(changeCounts(current, before)).toEqual({ merged: 1, review: 0, inProgress: 1, back: 0, added: 0 });

    const { text } = renderScheduledReport(current, { now, previous: before, jiraRefreshedAt: now.toISOString() });
    expect(text).toContain('🔁 Sejak 07 Okt 15:00 WIB: 🟢 +1 selesai · 🔵 +1 mulai coding');
    expect(text).toContain('_Status Jira diperbarui 08 Okt 16:00 WIB. Detail task di Cockpit._');
    expect(renderScheduledReport(before, { now, previous: before }).text).toContain('tidak ada perubahan status');
  });

  it('notes a failed Jira refresh, new and reopened tasks, and % per TAD', () => {
    const prev = snap([row(A, 'PRM-1', 'Done', 'done', 'merged')], '2026-10-07T08:00:00.000Z');
    const cur: ProgressSnapshot = {
      ...snap([row(A, 'PRM-1', 'To Do', 'new'), row(B, 'PRM-2', 'To Do', 'new')]),
    };
    cur.projects[0].tads.push({ ...tad([row('[BACKEND][X][Y] - C', 'PRM-3', 'Done', 'done', 'merged')]), tadId: 'tad-2', tadTitle: 'TAD FDS' });
    const { text } = renderScheduledReport(cur, { now, previous: prev, jiraError: 'Jira HTTP 401' });
    expect(text).toContain('refresh gagal: Jira HTTP 401');
    expect(text).toContain('⬇️ 1 mundur · 🆕 2 task baru');
    expect(text).toContain('• TAD Promo: 0%');
    expect(text).toContain('• TAD FDS: 100%');
  });

  it('is silent without projects and validates uploads', () => {
    expect(renderScheduledReport({ version: 1, generatedAt: now.toISOString(), projects: [] }, { now }).text).toBe('');
    expect(isSnapshot(snap([]))).toBe(true);
    expect(isSnapshot({ version: 2, generatedAt: 'x', projects: [] })).toBe(false);
    expect(isSnapshot({ version: 1, generatedAt: now.toISOString(), projects: [{ projectId: 1 }] })).toBe(false);
    expect(snapshotJiraKeys(snap([row(A, 'PRM-1', 'x', 'new'), row(B, 'PRM-1', 'x', 'new')]))).toEqual(['PRM-1']);
    expect(formatWib('2026-10-08T17:30:00.000Z')).toBe('Jum, 09 Okt 00:30 WIB');
  });
});
