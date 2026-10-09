export interface PrdMetadata {
  title: string;
  tribe: string;
  targetRelease: string;
  epic: string;
  documentStatus: string;
  documentOwner: string;
  designer: string;
  techLead: string;
  qa: string;
  codeName: string;
}

export interface PrdRequirement {
  id: string;
  userStory: string;
  keyword: string;
  requirement: string;
  interfaces: string[];
}

export interface PrdMetric {
  goal: string;
  metric: string;
}

export interface PrdFigmaLink {
  title?: string;
  url: string;
}

export interface PrdData {
  metadata: PrdMetadata;
  objective: string;
  successMetrics: PrdMetric[];
  requirements: PrdRequirement[];
  figmaLinks: PrdFigmaLink[];
  rawMarkdown: string;
}
