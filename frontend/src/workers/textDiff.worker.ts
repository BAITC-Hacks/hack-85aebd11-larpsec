import { buildTextDiff, type TextDiffOptions } from '../lib/textDiff';

type DiffRequest = { id: number; before: string; after: string; options?: TextDiffOptions };

self.onmessage = ({ data }: MessageEvent<DiffRequest>) => {
  try {
    if (typeof data.before !== 'string' || typeof data.after !== 'string') {
      throw new Error('Для сравнения нужен текст двух документов.');
    }
    self.postMessage({ id: data.id, result: buildTextDiff(data.before, data.after, data.options) });
  } catch {
    self.postMessage({ id: data.id, error: 'Не удалось сравнить тексты документов. Попробуйте ещё раз.' });
  }
};
