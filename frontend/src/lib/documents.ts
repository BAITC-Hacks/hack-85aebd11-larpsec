import type { DocumentResult, Paragraph } from './types';

export const MAX_FILE_SIZE = 20 * 1024 * 1024;
export const MAX_TEXT_LENGTH = 2_000_000;
export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

export function validateFile(file: Pick<File, 'name' | 'size'>): string | undefined {
  if (!/\.docx$/i.test(file.name)) return 'Поддерживается только DOCX. Сохраните документ Word в формате .docx и попробуйте снова.';
  if (!file.size) return 'Файл пустой. Выберите документ с содержимым.';
  if (file.size > MAX_FILE_SIZE) return 'Файл больше 20 МБ. Уменьшите его размер и попробуйте снова.';
}

export async function validateDocxSignature(file: File) {
  const signature = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  if (signature.length < 4 || signature[0] !== 0x50 || signature[1] !== 0x4b || signature[2] !== 3 || signature[3] !== 4) {
    throw new Error('Файл не похож на DOCX или повреждён. Откройте его в Word и сохраните заново.');
  }
}

export function paragraphsFromText(text: string): Paragraph[] {
  return text.split(/\n\s*\n|\r\n\r\n/).map((part) => part.trim()).filter(Boolean).map((part, index) => {
    const match = part.match(/^(\d+(?:\.\d+)*)(?:[.)])?\s/);
    return { id: `p-${index + 1}`, text: part, ...(match ? { section: match[1] } : {}) };
  });
}

export function normalizeText(text: string, warnings: string[] = []): DocumentResult {
  const clean = text.replace(/\r\n/g, '\n').trim();
  if (!clean) throw new Error('В документе не найден текст. Возможно, он содержит только изображения. Распознавание сканов пока не поддерживается.');
  if (clean.length > MAX_TEXT_LENGTH) throw new Error('В документе слишком много текста для предварительного просмотра. Разделите его на несколько файлов.');
  return { text: clean, paragraphs: paragraphsFromText(clean), warnings };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} КБ`;
  return `${(bytes / 1024 / 1024).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} МБ`;
}

export function plural(count: number, forms: [string, string, string]): string {
  const n = Math.abs(count) % 100;
  const digit = n % 10;
  return n >= 11 && n <= 14 ? forms[2] : digit === 1 ? forms[0] : digit >= 2 && digit <= 4 ? forms[1] : forms[2];
}

export function downloadText(name: string, text: string) {
  const url = URL.createObjectURL(new Blob(['\ufeff', text], { type: 'text/plain;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name.replace(/\.docx$/i, '') + '.txt';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
