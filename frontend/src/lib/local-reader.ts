import type { DocumentResult } from './types';

export async function readDocx(file: File, signal: AbortSignal): Promise<DocumentResult> {
  const buffer = await file.arrayBuffer();
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./docx.worker.ts', import.meta.url), { type: 'module' });
    const cleanup = () => {
      worker.terminate();
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
    };
    const abort = () => { cleanup(); reject(new DOMException('Операция отменена', 'AbortError')); };
    const timer = setTimeout(() => { cleanup(); reject(new Error('Чтение заняло слишком много времени. Попробуйте документ меньшего размера.')); }, 25_000);
    signal.addEventListener('abort', abort, { once: true });
    worker.onmessage = ({ data }: MessageEvent<{ ok: boolean; result: DocumentResult; error: string }>) => {
      cleanup();
      if (data.ok) resolve(data.result);
      else reject(new Error(data.error));
    };
    worker.onerror = () => { cleanup(); reject(new Error('Не удалось запустить чтение документа. Повторите попытку.')); };
    worker.postMessage(buffer, [buffer]);
  });
}
