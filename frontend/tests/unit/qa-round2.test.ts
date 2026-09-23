import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ResultView } from '../../src/App';
import { HistoryDocuments } from '../../src/ComparisonHistory';
import ComparisonResults from '../../src/ComparisonResults';
import { createComparison } from '../../src/lib/api';
import { comparisonTitle, findingLabels } from '../../src/lib/presentation';
import { buildTextDiff } from '../../src/lib/textDiff';
import type { AnalysisResult, Comparison, ServerDocument, WorkspaceDocument } from '../../src/lib/types';

afterEach(() => vi.unstubAllGlobals());
const comparison: Comparison = {
  id: 'test', title: 'Кадры.docx', before_complete: true, after_complete: true, status: 'completed', stage: 'completed', progress: 100, mode: 'demo', error: null,
  created_at: '2026-09-23T00:00:00Z', updated_at: '2026-09-23T00:00:00Z', documents: [],
};
const result: AnalysisResult = {
  comparison_id: 'test', mode: 'demo', model: null, prompt_version: 'test', generated_at: comparison.created_at,
  units: [], functions: [], reporting: [], unit_changes: [], function_changes: [], findings: [], warnings: [], reviews: [], coverage: { before: true, after: true }, summary: 'Сводка',
};

describe('QA round 2: Н9', () => {
  it('uses the selected filenames as comparison title and sends it to the server', async () => {
    const title = comparisonTitle([{ name: 'Кадры до.docx', phase: 'before' }, { name: 'Кадры после.docx', phase: 'after' }]);
    expect(title).toBe('Кадры до.docx → Кадры после.docx');
    expect(comparisonTitle([{ name: 'Бухгалтерия.pdf', phase: 'before' }])).toBe('Бухгалтерия.pdf');
    expect(comparisonTitle([{ name: 'а'.repeat(220), phase: 'before' }])).toHaveLength(200);
    const fetch = vi.fn().mockResolvedValue(Response.json({ ...comparison, title }));
    vi.stubGlobal('fetch', fetch);
    expect((await createComparison(undefined, title)).title).toBe(title);
    expect(JSON.parse(fetch.mock.calls[0][1].body).title).toBe(title);
  });
  it('collapses history after four files and retains every filename in expandable details', () => {
    const documents = Array.from({ length: 20 }, (_, index) => ({ id: String(index), filename: `file-${index}.docx`, side: 'before' })) as ServerDocument[];
    const html = renderToStaticMarkup(createElement(HistoryDocuments, { documents }));
    const [visible, collapsed] = html.split('<details>');
    expect(visible).toContain('file-3.docx');
    expect(visible).not.toContain('file-4.docx');
    expect(collapsed).toContain('<summary>И ещё 16</summary>');
    expect(collapsed).toContain('file-19.docx');
    expect(html).not.toContain('<details open');
  });
  it('uses the backend reporting label and separates text repeats from finding statistics', () => {
    expect(findingLabels.reporting_change).toBe('Изменение подчинения');
    const html = renderToStaticMarkup(createElement(ComparisonResults, { comparison, result, onRefresh: async () => {} }));
    const stats = html.split('aria-label="Сводка замечаний"')[1].split('class="analysis-text-tools"')[0];
    expect(stats).not.toContain('stat-repetitions');
    expect(html).toContain('aria-label="Дополнительная проверка текста"');
    expect(html).toContain('stat-repetitions');
  });
  it.each([false, true])('warns in the document side card for incomplete extraction or warnings (%s)', (complete) => {
    const doc = { id: 'doc', file: new File(['x'], 'partial.docx'), name: 'partial.docx', sizeBytes: 1, phase: 'before', source: 'server', status: 'ready', progress: 100, addedAt: 0, extractionComplete: complete, result: { text: 'Текст', paragraphs: [{ id: 'p', text: 'Текст' }], warnings: complete ? ['Проверьте оригинал.'] : [] } } as WorkspaceDocument;
    const html = renderToStaticMarkup(createElement(ResultView, { doc, onBack: () => {}, onCompare: () => {} }));
    expect(html).toContain('Требуется проверка оригинала');
    expect(html).not.toContain('Всё на своём месте');
  });
  it.each([['Ёлка', 'Елка'], ['Ведёт учёт', 'Ведет учет'], ['1. Ведёт кадровый учёт.', '1. Ведет кадровый учет.']])('aligns ё/е as modified while preserving source characters: %s', (before, after) => {
    const diff = buildTextDiff(before, after);
    expect(diff).toMatchObject({ modifiedLines: 1, removedLines: 0, addedLines: 0 });
    expect(diff.rows[0].before?.text).toBe(before);
    expect(diff.rows[0].after?.text).toBe(after);
    expect(diff.rows[0].before?.segments.filter((part) => part.changed).map((part) => part.text).join('').toLocaleLowerCase('ru')).toContain('ё');
  });
});
