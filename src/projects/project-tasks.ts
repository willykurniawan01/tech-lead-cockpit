import { detailTaskSpec, parseScopeTasks } from '../lib/tad/task-links';
import { taskId, type EstimateProject } from '../lib/estimate/types';
import { draftTitle, type Draft } from '../tad/drafts.svelte';

/** A Development Scope task of one of the project's TADs. */
export interface ProjectTask {
  /** `${draftId}::${title}`, unique within the project. */
  id: string;
  draftId: string;
  tadTitle: string;
  title: string;
  service: string;
  jiraKeys: string[];
  /** Detail Task as plain text ('' when the TAD has none for this task). */
  spec: string;
}

/** The project's TADs that still exist, in the project's order. */
export function projectDrafts(project: Pick<EstimateProject, 'draftIds'>, all: Draft[]): Draft[] {
  return project.draftIds.map((id) => all.find((d) => d.id === id)).filter((d): d is Draft => Boolean(d));
}

export function projectTasks(project: Pick<EstimateProject, 'draftIds'>, all: Draft[]): ProjectTask[] {
  return projectDrafts(project, all).flatMap((d) => {
    const tadTitle = draftTitle(d);
    return parseScopeTasks(d.markdown, d.scopePlan).map((t) => ({
      id: taskId(d.id, t.title),
      draftId: d.id,
      tadTitle,
      title: t.title,
      service: t.service,
      jiraKeys: t.jiraKeys,
      spec: detailTaskSpec(d.markdown, t.title)?.text ?? '',
    }));
  });
}

/** Development Analysis of every TAD, for the AI's architecture context. */
export function analysisContext(drafts: Draft[]): string {
  return drafts
    .map((d) => {
      const section = d.markdown.match(/^#\s+(?:\d+\.?\s*)?Development Analysis[^\n]*\n([\s\S]*?)(?=^#\s|(?![\s\S]))/im)?.[1]?.trim();
      return section ? `### TAD: ${draftTitle(d)}\n${section}` : '';
    })
    .filter(Boolean)
    .join('\n\n');
}

/** PRDs of the project's TADs, labelled per TAD. */
export function prdContext(drafts: Draft[]): string | undefined {
  const parts = drafts.filter((d) => d.prdMarkdown?.trim()).map((d) => `### PRD untuk ${draftTitle(d)}\n${d.prdMarkdown}`);
  return parts.length ? parts.join('\n\n') : undefined;
}
