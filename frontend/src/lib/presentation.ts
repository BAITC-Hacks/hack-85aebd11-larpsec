import { plural } from './documents';
import type { AnalysisResult, Finding, ReviewStatus, WorkspaceDocument } from './types';

export const findingLabels: Record<Finding['kind'], string> = {
  potential_loss: 'Возможная потеря', duplication: 'Дублирование функций', conflict: 'Противоречие',
  coverage_gap: 'Недостаточно данных', reporting_change: 'Изменение подчинения',
};
export const SAMPLE_FILENAMES = { before: 'Положение — до изменений.docx', after: 'Положение — после изменений.docx' };
export const documentCount = (count: number) => `${count} ${plural(count, ['документ', 'документа', 'документов'])}`;
export function comparisonTitle(documents: Pick<WorkspaceDocument, 'name' | 'phase'>[]): string {
  const names = (['before', 'after'] as const).flatMap((side) => {
    const document = documents.find((item) => item.phase === side);
    return document ? [document.name] : [];
  });
  return names.length ? names.join(' → ').slice(0, 200) : 'Новое сравнение';
}
export function filterChanges<T extends { status: string }>(changes: T[], status: T['status'] | 'all'): T[] {
  return status === 'all' ? changes : changes.filter((item) => item.status === status);
}
export type FindingSort = 'original' | 'kind' | 'review';
export function filteredFindings(result: AnalysisResult, kind: Finding['kind'] | 'all', review: ReviewStatus | 'all', sort: FindingSort = 'original'): Finding[] {
  const reviews = new Map(result.reviews.map((item) => [item.finding_id, item.status]));
  const findings = result.findings.filter((finding) => (kind === 'all' || finding.kind === kind)
    && (review === 'all' || (reviews.get(finding.id) ?? 'unreviewed') === review));
  const kinds: Finding['kind'][] = ['conflict', 'potential_loss', 'duplication', 'reporting_change', 'coverage_gap'];
  const statuses: ReviewStatus[] = ['unreviewed', 'confirmed', 'dismissed'];
  // Array.sort is stable: equal priorities retain the server's source order.
  if (sort === 'kind') findings.sort((left, right) => kinds.indexOf(left.kind) - kinds.indexOf(right.kind));
  if (sort === 'review') findings.sort((left, right) => statuses.indexOf(reviews.get(left.id) ?? 'unreviewed') - statuses.indexOf(reviews.get(right.id) ?? 'unreviewed'));
  return findings;
}
export function previewStatus(doc: WorkspaceDocument) {
  const incomplete = doc.extractionComplete === false;
  const warnings = !!doc.result?.warnings.length;
  return {
    caution: incomplete || warnings,
    heading: incomplete ? 'Документ прочитан частично' : warnings ? 'Документ прочитан с предупреждениями' : 'Документ прочитан',
    badge: incomplete ? 'НЕПОЛНЫЙ ТЕКСТ' : warnings ? 'ПРОВЕРЬТЕ' : 'ГОТОВО',
    description: incomplete ? 'Часть содержимого не извлечена. Проверьте оригинал: отсутствие текста не означает отсутствие функции.'
      : warnings ? 'Проверьте предупреждения и исходный документ перед сравнением.' : 'Текст готов к просмотру.',
  };
}
export function pageSubtitle(view: 'documents' | 'comparison' | 'history', comparisonView: 'text' | 'analysis'): string {
  if (view === 'history') return 'Сохранённые комплекты, результаты и решения экспертов.';
  if (view === 'comparison') return comparisonView === 'text'
    ? 'Две версии рядом. Каждое изменение на своём месте.'
    : 'Изменения функций, подразделений и подчинения с подтверждениями из документов.';
  return 'Порядок в документах — первый шаг к ясной структуре.';
}
