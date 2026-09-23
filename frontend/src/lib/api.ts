import { MAX_TEXT_LENGTH, normalizeText } from './documents';
import type { DocumentPhase, DocumentResult, ProcessOptions } from './types';

export const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || '').trim().replace(/\/$/, '');
export const SERVER_MODE = Boolean(API_BASE_URL);
const TOTAL_TIMEOUT = 120_000;

type ServerDocument = { id: string; status: 'queued' | 'processing' | 'ready' | 'failed'; result?: DocumentResult; error?: { message?: string } };

export function parseServerDocument(value: unknown): ServerDocument {
  if (!value || typeof value !== 'object') throw new Error('Сервер вернул некорректный ответ. Попробуйте позже.');
  const data = value as Record<string, unknown>;
  if (typeof data.id !== 'string' || !data.id || !['queued', 'processing', 'ready', 'failed'].includes(String(data.status))) {
    throw new Error('Ответ сервера не соответствует формату документа.');
  }
  if (data.status === 'ready') {
    const result = data.result as Record<string, unknown> | undefined;
    if (!result || typeof result.text !== 'string' || result.text.length > MAX_TEXT_LENGTH) throw new Error('Сервер не вернул текст документа или превысил допустимый объём.');
    const normalized = normalizeText(result.text, Array.isArray(result.warnings) ? result.warnings.filter((v): v is string => typeof v === 'string') : []);
    if (Array.isArray(result.paragraphs) && result.paragraphs.length) {
      const ids = new Set<string>();
      let totalLength = 0;
      normalized.paragraphs = result.paragraphs.map((paragraph: unknown) => {
        if (!paragraph || typeof paragraph !== 'object') throw new Error('Сервер вернул некорректные фрагменты документа.');
        const p = paragraph as Record<string, unknown>;
        if (typeof p.id !== 'string' || !p.id || ids.has(p.id) || typeof p.text !== 'string' || (p.section !== undefined && typeof p.section !== 'string')) throw new Error('Сервер вернул некорректные фрагменты документа.');
        ids.add(p.id);
        totalLength += p.text.length;
        if (totalLength > MAX_TEXT_LENGTH) throw new Error('Объём фрагментов документа превышает лимит просмотра.');
        return { id: p.id, text: p.text, section: p.section as string | undefined };
      });
    }
    return { id: data.id, status: 'ready', result: normalized };
  }
  return { id: data.id, status: data.status as ServerDocument['status'], error: typeof data.error === 'object' && data.error !== null ? data.error as ServerDocument['error'] : undefined };
}

function httpError(status: number) {
  if (status === 413) return new Error('Сервер отклонил размер файла. Уменьшите документ и попробуйте снова.');
  if (status === 415 || status === 422) return new Error('Сервер не смог прочитать этот DOCX. Проверьте формат и содержимое документа.');
  if (status === 401 || status === 403) return new Error('Нет доступа к обработке документов. Проверьте доступ к серверу.');
  if (status === 429) return new Error('Слишком много запросов. Подождите немного и повторите попытку.');
  return new Error('Сервер временно недоступен. Попробуйте ещё раз позже.');
}

function upload(file: File, phase: DocumentPhase, options: ProcessOptions, signal: AbortSignal): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const abort = () => xhr.abort();
    const cleanup = () => signal.removeEventListener('abort', abort);
    xhr.open('POST', `${API_BASE_URL}/documents`);
    xhr.responseType = 'json';
    xhr.timeout = 60_000;
    xhr.upload.onprogress = (event) => { if (event.lengthComputable) options.onProgress(Math.round(event.loaded / event.total * 100)); };
    xhr.onload = () => { cleanup(); xhr.status >= 200 && xhr.status < 300 ? resolve(xhr.response) : reject(httpError(xhr.status)); };
    xhr.onerror = () => { cleanup(); reject(new Error('Не удалось связаться с сервером. Проверьте подключение и повторите попытку.')); };
    xhr.ontimeout = () => { cleanup(); reject(new Error('Сервер не ответил вовремя. Повторите попытку.')); };
    xhr.onabort = () => { cleanup(); reject(new DOMException('Операция отменена', 'AbortError')); };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) { cleanup(); reject(new DOMException('Операция отменена', 'AbortError')); return; }
    const body = new FormData();
    body.append('file', file);
    body.append('phase', phase);
    xhr.send(body);
  });
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(new DOMException('Операция отменена', 'AbortError')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}

export async function processOnServer(file: File, phase: DocumentPhase, options: ProcessOptions): Promise<DocumentResult> {
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort();
  options.signal.addEventListener('abort', abort, { once: true });
  if (options.signal.aborted) controller.abort();
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, TOTAL_TIMEOUT);
  try {
    let result = parseServerDocument(await upload(file, phase, options, controller.signal));
    options.onProcessing();
    while (result.status === 'queued' || result.status === 'processing') {
      await wait(1500, controller.signal);
      const response = await fetch(`${API_BASE_URL}/documents/${encodeURIComponent(result.id)}`, { signal: controller.signal });
      if (!response.ok) throw httpError(response.status);
      result = parseServerDocument(await response.json());
    }
    if (result.status === 'failed') throw new Error(typeof result.error?.message === 'string' ? result.error.message : 'Сервер не смог обработать документ. Попробуйте другой файл.');
    return result.result!;
  } catch (error) {
    if (timedOut) throw new Error('Обработка заняла больше двух минут. Повторите попытку позже; сервер мог продолжить обработку.');
    if (error instanceof TypeError) throw new Error('Соединение с сервером прервалось. Повторите попытку.');
    if (error instanceof SyntaxError) throw new Error('Сервер вернул ответ, который не удалось прочитать. Повторите попытку позже.');
    throw error;
  } finally {
    clearTimeout(timer);
    options.signal.removeEventListener('abort', abort);
  }
}
