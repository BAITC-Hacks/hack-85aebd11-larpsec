export type DocumentPhase = 'before' | 'after';
export type DocumentStatus = 'selected' | 'uploading' | 'processing' | 'ready' | 'error';
export type DocumentSource = 'local' | 'server' | 'example';
export type AnalysisMode = 'demo' | 'llm';
export type ReviewStatus = 'unreviewed' | 'confirmed' | 'dismissed';

export interface Paragraph { id: string; text: string; section?: string; locator?: string }
export interface DocumentResult { text: string; paragraphs: Paragraph[]; warnings: string[] }
export interface WorkspaceDocument {
  id: string;
  file: File;
  name: string;
  sizeBytes: number;
  phase: DocumentPhase;
  source: DocumentSource;
  status: DocumentStatus;
  progress: number;
  addedAt: number;
  serverId?: string;
  uploadAttempted?: boolean;
  extractionComplete?: boolean;
  result?: DocumentResult;
  error?: string;
}
export interface ProcessOptions {
  signal: AbortSignal;
  onProgress: (progress: number) => void;
  onProcessing: () => void;
}
export interface ServerDocument {
  id: string;
  comparison_id: string;
  side: DocumentPhase;
  filename: string;
  format: string;
  sha256: string;
  size_bytes: number;
  text_chars: number;
  fragment_count: number;
  warnings: string[];
  extraction_complete: boolean;
  created_at: string;
}
export interface Fragment {
  id: string;
  document_id: string;
  text: string;
  locator: string;
  clause: string | null;
  page: number | null;
  sheet: string | null;
  cell_range: string | null;
}
export interface Comparison {
  id: string;
  title: string;
  before_complete: boolean;
  after_complete: boolean;
  status: 'draft' | 'queued' | 'running' | 'completed' | 'failed';
  stage: string;
  progress: number;
  mode: AnalysisMode | null;
  error: { code: string; message: string } | null;
  created_at: string;
  updated_at: string;
  documents: ServerDocument[];
}
export interface Evidence { fragment_id: string; quote: string }
export interface Unit {
  id: string; side: DocumentPhase; name: string;
  kind: 'department' | 'role' | 'group'; aliases: string[]; evidence: Evidence[];
}
export interface FunctionRecord {
  id: string; unit_id: string; side: DocumentPhase; owner: string; action: string;
  object: string; scope: string; kind: 'duty' | 'permission' | 'prohibition'; evidence: Evidence[];
}
export interface Reporting {
  subject: string; supervisor: string; kind: 'functional' | 'administrative' | 'unspecified';
  side: DocumentPhase; evidence: Evidence[];
}
export interface UnitChange {
  before_ids: string[]; after_ids: string[];
  status: 'preserved' | 'renamed' | 'merged' | 'split' | 'reorganized' | 'created' | 'unmatched';
  explanation: string; evidence: Evidence[];
}
export interface FunctionChange {
  before_id: string | null; after_ids: string[];
  status: 'preserved' | 'moved' | 'modified' | 'potential_loss' | 'unmatched' | 'added';
  explanation: string; evidence: Evidence[];
}
export interface Finding {
  id: string; kind: 'potential_loss' | 'duplication' | 'conflict' | 'coverage_gap';
  title: string; explanation: string; recommendation: string; function_ids: string[];
  evidence: Evidence[]; review_required: boolean;
}
export interface ReviewRecord { finding_id: string; status: ReviewStatus; comment: string; updated_at: string }
export interface AnalysisResult {
  comparison_id: string; mode: AnalysisMode; model: string | null; prompt_version: string; generated_at: string;
  units: Unit[]; functions: FunctionRecord[]; reporting: Reporting[]; unit_changes: UnitChange[];
  function_changes: FunctionChange[]; findings: Finding[]; warnings: string[];
  coverage: { before: boolean; after: boolean }; summary: string; reviews: ReviewRecord[];
}
export interface Health { status: string; mode: AnalysisMode; analysis_ready: boolean; version: string }
