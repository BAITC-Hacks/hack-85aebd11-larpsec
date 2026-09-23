import type { Paragraph, WorkspaceDocument } from './types';

export type TextOccurrence = {
  fragmentId: string;
  text: string;
  locator: string;
  section?: string;
};

export type TextRepetition = {
  id: string;
  documentId: string;
  documentName: string;
  side: 'before' | 'after';
  text: string;
  occurrences: TextOccurrence[];
};

function normalized(text: string): string {
  return text.normalize('NFC').replace(/\s+/gu, ' ').trim().toLowerCase();
}

function paragraphBody(paragraph: Paragraph): string {
  const text = normalized(paragraph.text);
  const section = normalized(paragraph.section ?? '').replace(/[.)]$/u, '');
  if (!/^\d+(?:\.\d+)*$/u.test(section)) return text;

  // A section inherited by a continuation paragraph must not remove an
  // unrelated number. Remove only an actual, matching prefix in this text.
  const prefix = text.match(/^(\d+(?:\.\d+)*)(?:[.)])?(?:\s+|(?=\p{L})|$)/u);
  return prefix?.[1] === section ? text.slice(prefix[0].length).trim() : text;
}

/**
 * Find literal editorial repetitions within each ready server document.
 * These are repeated passages, not evidence of duplicated organizational duties.
 */
export function findTextRepetitions(documents: WorkspaceDocument[]): TextRepetition[] {
  const repetitions: TextRepetition[] = [];
  const seenDocuments = new Set<string>();

  for (const document of documents) {
    if (document.status !== 'ready' || !document.serverId || !document.result || seenDocuments.has(document.serverId)) continue;
    seenDocuments.add(document.serverId);
    const groups = new Map<string, TextOccurrence[]>();
    const seenFragments = new Set<string>();

    for (const [index, paragraph] of document.result.paragraphs.entries()) {
      if (!paragraph.id || seenFragments.has(paragraph.id)) continue;
      seenFragments.add(paragraph.id);
      if (normalized(paragraph.locator ?? '').startsWith('колонтитул')) continue;
      const body = paragraphBody(paragraph);
      if (body.length < 40 || (body.match(/\p{L}[\p{L}\p{M}]*/gu)?.length ?? 0) < 5) continue;

      const occurrence: TextOccurrence = {
        fragmentId: paragraph.id,
        text: paragraph.text,
        locator: paragraph.locator ?? (paragraph.section ? `Пункт ${paragraph.section}` : `Фрагмент ${index + 1}`),
        ...(paragraph.section ? { section: paragraph.section } : {}),
      };
      const group = groups.get(body);
      if (group) group.push(occurrence);
      else groups.set(body, [occurrence]);
    }

    for (const occurrences of groups.values()) {
      if (occurrences.length < 2) continue;
      repetitions.push({
        id: `${document.serverId}:${occurrences[0].fragmentId}`,
        documentId: document.serverId,
        documentName: document.name,
        side: document.phase,
        text: occurrences[0].text,
        occurrences,
      });
    }
  }

  // Stable sorting retains source order when groups have the same count.
  return repetitions.sort((left, right) => {
    if (left.side !== right.side) return left.side === 'after' ? -1 : 1;
    return right.occurrences.length - left.occurrences.length;
  });
}
