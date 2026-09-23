export type DocumentPhase = 'before' | 'after';
export type DocumentStatus = 'selected' | 'uploading' | 'processing' | 'ready' | 'error';
export type DocumentSource = 'local' | 'server' | 'example';

export interface Paragraph {
  id: string;
  text: string;
  section?: string;
}

export interface DocumentResult {
  text: string;
  paragraphs: Paragraph[];
  warnings: string[];
}

export interface WorkspaceDocument {
  id: string;
  file: File;
  name: string;
  phase: DocumentPhase;
  source: DocumentSource;
  status: DocumentStatus;
  progress: number;
  addedAt: number;
  result?: DocumentResult;
  error?: string;
}

export interface ProcessOptions {
  signal: AbortSignal;
  onProgress: (progress: number) => void;
  onProcessing: () => void;
}
