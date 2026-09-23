import { MAX_TEXT_LENGTH } from './documents';
import type {
  AnalysisResult, Comparison, DocumentPhase, DocumentResult, Fragment, Health,
  ProcessOptions, ReviewRecord, ReviewStatus, ServerDocument,
} from './types';

const configuredBase = (import.meta.env.VITE_API_BASE_URL || '/api/v1').trim().replace(/\/+$/, '');
export const API_BASE_URL = configuredBase.endsWith('/api') ? `${configuredBase}/v1` : configuredBase || '/api/v1';
export const SERVER_MODE = true;
export const API_TOKEN_STORAGE_KEY = 'larpsec.apiToken';

export class ApiError extends Error {
  constructor(message: string, public status: number, public code?: string) { super(message); this.name = 'ApiError'; }
}

function authHeaders(): Record<string, string> {
  try {
    const token = sessionStorage.getItem(API_TOKEN_STORAGE_KEY)?.trim();
    return token ? { Authorization: `Bearer ${token}` } : {};
  } catch { return {}; }
}

function httpError(status: number, body?: unknown): ApiError {
  const error = body && typeof body === 'object' ? (body as { error?: unknown }).error : undefined;
  const problem = error && typeof error === 'object' ? error as { message?: unknown; code?: unknown } : undefined;
  let message = 'Сервер временно недоступен. Попробуйте ещё раз позже.';
  if (status === 401 || status === 403) message = 'Нет доступа к серверу. Укажите токен доступа в настройках подключения.';
  else if (typeof problem?.message === 'string') message = problem.message;
  else if (status === 413) message = 'Сервер отклонил размер файла. Уменьшите документ и попробуйте снова.';
  else if (status === 415 || status === 422) message = 'Проверьте формат файла и параметры запроса.';
  else if (status === 404) message = 'Сравнение или документ не найден на сервере.';
  else if (status === 409) message = 'Состояние сравнения изменилось. Обновите страницу.';
  else if (status === 429) message = 'Слишком много запросов. Подождите немного и повторите попытку.';
  return new ApiError(message, status, typeof problem?.code === 'string' ? problem.code : undefined);
}

async function request(path: string, init: RequestInit = {}, raw = false): Promise<unknown> {
  try {
    const timeout = AbortSignal.timeout(30_000);
    const response = await fetch(`${API_BASE_URL}${path}`, {
      ...init,
      signal: init.signal ? AbortSignal.any([init.signal, timeout]) : timeout,
      headers: { ...authHeaders(), ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...init.headers },
    });
    if (!response.ok) throw httpError(response.status, await response.json().catch(() => undefined));
    if (raw) return response;
    if (response.status === 204) return undefined;
    return await response.json();
  } catch (error) {
    if (error instanceof TypeError) throw new Error('Не удалось связаться с сервером. Проверьте подключение и повторите попытку.');
    if (error instanceof SyntaxError) throw new Error('Сервер вернул ответ, который не удалось прочитать.');
    if (error instanceof DOMException && error.name === 'TimeoutError') throw new Error('Сервер не ответил вовремя. Повторите попытку.');
    throw error;
  }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Сервер вернул некорректный ответ.');
  return value as Record<string, unknown>;
}
function strings(value: unknown): value is string[] { return Array.isArray(value) && value.every((item) => typeof item === 'string'); }

export function parseServerDocument(value: unknown): ServerDocument {
  const data = record(value);
  for (const key of ['id', 'comparison_id', 'filename', 'format', 'sha256', 'created_at']) {
    if (typeof data[key] !== 'string' || !data[key]) throw new Error('Ответ сервера не соответствует формату документа.');
  }
  for (const key of ['size_bytes', 'text_chars', 'fragment_count']) {
    if (!Number.isSafeInteger(data[key]) || Number(data[key]) < 0) throw new Error('Сервер вернул некорректный размер документа.');
  }
  if (!['before', 'after'].includes(String(data.side)) || !strings(data.warnings) || typeof data.extraction_complete !== 'boolean') {
    throw new Error('Ответ сервера не соответствует формату документа.');
  }
  return data as unknown as ServerDocument;
}

export function parseFragment(value: unknown): Fragment {
  const data = record(value);
  if (typeof data.id !== 'string' || !data.id || typeof data.document_id !== 'string' || !data.document_id
      || typeof data.text !== 'string' || typeof data.locator !== 'string'
      || !['clause', 'sheet', 'cell_range'].every((key) => data[key] === null || typeof data[key] === 'string')
      || !(data.page === null || Number.isSafeInteger(data.page))) throw new Error('Сервер вернул некорректный фрагмент документа.');
  return data as unknown as Fragment;
}

export function documentResult(document: ServerDocument, fragments: Fragment[]): DocumentResult {
  const ids = new Set<string>();
  let length = 0;
  for (const fragment of fragments) {
    if (fragment.document_id !== document.id || ids.has(fragment.id)) throw new Error('Источники документа не совпадают с ответом сервера.');
    ids.add(fragment.id);
    length += fragment.text.length;
    if (length > MAX_TEXT_LENGTH) throw new Error('Объём фрагментов документа превышает лимит просмотра.');
  }
  if (fragments.length !== document.fragment_count) throw new Error('Сервер вернул не все фрагменты документа. Повторите загрузку текста.');
  return {
    text: fragments.map((fragment) => fragment.text).join('\n\n'),
    paragraphs: fragments.map((fragment) => ({ id: fragment.id, text: fragment.text, section: fragment.clause || undefined, locator: fragment.locator })),
    warnings: document.warnings,
  };
}

function parseComparison(value: unknown): Comparison {
  const data = record(value);
  if (typeof data.id !== 'string' || !data.id || !['draft', 'queued', 'running', 'completed', 'failed'].includes(String(data.status))
      || !Array.isArray(data.documents) || typeof data.before_complete !== 'boolean' || typeof data.after_complete !== 'boolean') {
    throw new Error('Ответ сервера не соответствует формату сравнения.');
  }
  return { ...data, documents: data.documents.map(parseServerDocument) } as unknown as Comparison;
}
const comparisonPath = (id: string) => `/comparisons/${encodeURIComponent(id)}`;

export async function getHealth(signal?: AbortSignal): Promise<Health> {
  const base = API_BASE_URL.replace(/\/api\/v1$/, '');
  const response = await fetch(`${base}/health`, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000) });
  if (!response.ok) throw httpError(response.status);
  const data = record(await response.json());
  if (!['demo', 'llm'].includes(String(data.mode)) || typeof data.analysis_ready !== 'boolean') throw new Error('Не удалось определить режим сервера.');
  return data as unknown as Health;
}
export async function createComparison(signal?: AbortSignal): Promise<Comparison> {
  return parseComparison(await request('/comparisons', { method: 'POST', body: JSON.stringify({ title: 'Анализ реорганизации' }), signal }));
}
export async function getComparison(id: string, signal?: AbortSignal): Promise<Comparison> {
  return parseComparison(await request(comparisonPath(id), { signal }));
}
export async function setCoverage(id: string, before: boolean, after: boolean, signal?: AbortSignal): Promise<Comparison> {
  return parseComparison(await request(`${comparisonPath(id)}/coverage`, {
    method: 'PATCH', body: JSON.stringify({ before_complete: before, after_complete: after }), signal,
  }));
}
export async function startAnalysis(id: string, signal?: AbortSignal): Promise<Comparison> {
  return parseComparison(await request(`${comparisonPath(id)}/analyze`, { method: 'POST', signal }));
}
export async function getResult(id: string, signal?: AbortSignal): Promise<AnalysisResult> {
  const data = record(await request(`${comparisonPath(id)}/result`, { signal }));
  if (data.comparison_id !== id || !['units', 'functions', 'reporting', 'unit_changes', 'function_changes', 'findings', 'warnings', 'reviews'].every((key) => Array.isArray(data[key]))) {
    throw new Error('Сервер вернул некорректный результат анализа.');
  }
  return data as unknown as AnalysisResult;
}
export async function getSource(id: string, fragmentId: string, signal?: AbortSignal): Promise<Fragment> {
  return parseFragment(await request(`${comparisonPath(id)}/sources/${encodeURIComponent(fragmentId)}`, { signal }));
}
export async function getDocumentResult(document: ServerDocument, signal?: AbortSignal): Promise<DocumentResult> {
  const fragments: Fragment[] = [];
  for (let offset = 0; offset < document.fragment_count; offset += 1000) {
    const data = await request(`${comparisonPath(document.comparison_id)}/documents/${encodeURIComponent(document.id)}/fragments?limit=1000&offset=${offset}`, { signal });
    if (!Array.isArray(data)) throw new Error('Сервер не вернул фрагменты документа.');
    fragments.push(...data.map(parseFragment));
  }
  return documentResult(document, fragments);
}
export async function deleteDocument(comparisonId: string, documentId: string): Promise<void> {
  await request(`${comparisonPath(comparisonId)}/documents/${encodeURIComponent(documentId)}`, { method: 'DELETE' });
}

export function uploadDocument(comparisonId: string, file: File, side: DocumentPhase, options: ProcessOptions): Promise<ServerDocument> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const abort = () => xhr.abort();
    const cleanup = () => options.signal.removeEventListener('abort', abort);
    xhr.open('POST', `${API_BASE_URL}${comparisonPath(comparisonId)}/documents?side=${side}`);
    for (const [key, value] of Object.entries(authHeaders())) xhr.setRequestHeader(key, value);
    xhr.responseType = 'json';
    xhr.timeout = 120_000;
    xhr.upload.onprogress = (event) => { if (event.lengthComputable) options.onProgress(Math.round(event.loaded / event.total * 100)); };
    xhr.upload.onload = () => options.onProcessing();
    xhr.onload = () => {
      cleanup();
      if (xhr.status < 200 || xhr.status >= 300) { reject(httpError(xhr.status, xhr.response)); return; }
      try { resolve(parseServerDocument(xhr.response)); } catch (error) { reject(error); }
    };
    xhr.onerror = () => { cleanup(); reject(new Error('Не удалось связаться с сервером. Проверьте подключение и повторите попытку.')); };
    xhr.ontimeout = () => { cleanup(); reject(new Error('Загрузка заняла больше двух минут. Обновите страницу, чтобы проверить, сохранился ли документ.')); };
    xhr.onabort = () => { cleanup(); reject(new DOMException('Операция отменена', 'AbortError')); };
    options.signal.addEventListener('abort', abort, { once: true });
    if (options.signal.aborted) { cleanup(); reject(new DOMException('Операция отменена', 'AbortError')); return; }
    const body = new FormData();
    body.append('file', file);
    xhr.send(body);
  });
}

export async function reviewFinding(comparisonId: string, findingId: string, status: ReviewStatus, comment = ''): Promise<ReviewRecord> {
  return await request(`${comparisonPath(comparisonId)}/findings/${encodeURIComponent(findingId)}/review`, {
    method: 'PATCH', body: JSON.stringify({ status, comment }),
  }) as ReviewRecord;
}
export async function downloadReport(comparisonId: string, format: 'markdown' | 'json'): Promise<void> {
  const response = await request(`${comparisonPath(comparisonId)}/report?format=${format}`, {}, true) as Response;
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement('a');
  link.href = url;
  link.download = `larpsec-${comparisonId}.${format === 'markdown' ? 'md' : 'json'}`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
