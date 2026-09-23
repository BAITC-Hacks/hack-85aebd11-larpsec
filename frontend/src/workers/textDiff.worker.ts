import { buildTextDiff } from '../lib/textDiff';

type DiffRequest = { id: number; before: string; after: string };

self.onmessage = ({ data }: MessageEvent<DiffRequest>) => {
  try {
    if (typeof data.before !== 'string' || typeof data.after !== 'string') {
      throw new Error('Для сравнения нужен текст двух документов.');
    }
    self.postMessage({ id: data.id, result: buildTextDiff(data.before, data.after) });
  } catch {
    self.postMessage({ id: data.id, error: 'Не удалось сравнить тексты документов. Попробуйте ещё раз.' });
  }
};
