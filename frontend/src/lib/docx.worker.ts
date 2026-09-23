import mammoth from 'mammoth';
import { normalizeText } from './documents';

self.onmessage = async ({ data }: MessageEvent<ArrayBuffer>) => {
  try {
    // Extract only plain text. Never inject converted document HTML into the UI.
    const result = await mammoth.extractRawText({ arrayBuffer: data });
    const warnings = result.messages.length ? ['Некоторые элементы Word могут не отображаться в текстовом просмотре. Сверяйтесь с оригиналом.'] : [];
    self.postMessage({ ok: true, result: normalizeText(result.value, warnings) });
  } catch (error) {
    const known = error instanceof Error && (error.message.startsWith('В документе') || error.message.startsWith('В документе слишком'));
    self.postMessage({ ok: false, error: known ? (error as Error).message : 'Не удалось прочитать DOCX. Файл может быть повреждён, защищён паролем или иметь другой формат.' });
  }
};
