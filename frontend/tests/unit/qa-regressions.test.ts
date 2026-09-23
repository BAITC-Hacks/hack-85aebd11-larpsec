import { readFile } from 'node:fs/promises';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ComparisonResults from '../../src/ComparisonResults';
import { ResultView } from '../../src/App';
import { deleteComparison, documentResult, listComparisons } from '../../src/lib/api';
import { saveChoice, storedChoice } from '../../src/lib/preferences';
import { documentCount, filteredFindings, findingLabels, pageSubtitle, previewStatus, SAMPLE_FILENAMES } from '../../src/lib/presentation';
import { buildTextDiff, lineSimilarity, spreadsheetValues } from '../../src/lib/textDiff';
import type { AnalysisResult, Comparison, Finding, FunctionRecord, ServerDocument, WorkspaceDocument } from '../../src/lib/types';

afterEach(() => { vi.unstubAllGlobals(); });

describe('QA #11–13: honest text alignment and counts', () => {
  it('keeps unrelated removals and additions separate', () => {
    const diff = buildTextDiff('А. Проводит аудит\nБ. Ведёт кадровый учёт', 'В. Организует корпоративы');
    expect(diff.rows.map((row) => row.kind)).toEqual(['removed', 'removed', 'added']);
    expect(diff).toMatchObject({ removedLines: 2, addedLines: 1, modifiedLines: 0 });
  });
  it('requires at least half of meaningful tokens and more than one common token', () => {
    expect(lineSimilarity('1. Проводит аудит', '1. Проводит корпоративы')).toBe(0);
    expect(lineSimilarity('1. Готовит квартальный отчёт', '2. Готовит годовой отчёт')).toBeGreaterThanOrEqual(0.5);
    expect(lineSimilarity('А. И на предприятии', 'Б. И на мероприятии')).toBe(0);
  });
  it('counts changed lines separately instead of double-counting removed/added', () => {
    const diff = buildTextDiff('Готовит квартальный отчёт', 'Готовит годовой отчёт');
    expect(diff).toMatchObject({ modifiedLines: 1, removedLines: 0, addedLines: 0, changeBlocks: 1 });
    expect(diff.rows[0].before?.segments.some((segment) => segment.changed && segment.text.includes('квартальный'))).toBe(true);
  });
  it('pairs an identical meaningful word changed only in case or punctuation', () => {
    expect(buildTextDiff('Me', 'me.')).toMatchObject({ modifiedLines: 1, removedLines: 0, addedLines: 0 });
    expect(buildTextDiff('1.', '2.').modifiedLines).toBe(0);
  });
  it('does not pair positional neighbors when a later line is the meaningful match', () => {
    const diff = buildTextDiff('Проводит аудит\nГотовит квартальный отчёт', 'Организует корпоративы\nГотовит годовой отчёт');
    expect(diff.rows.map((row) => row.kind)).toEqual(['removed', 'added', 'modified']);
    expect(diff.rows.flatMap((row) => row.before ? [row.before.text] : [])).toEqual(['Проводит аудит', 'Готовит квартальный отчёт']);
    expect(diff.rows.flatMap((row) => row.after ? [row.after.text] : [])).toEqual(['Организует корпоративы', 'Готовит годовой отчёт']);
  });
  it('ignores shifted legacy XLSX cell coordinates while retaining cell values', () => {
    const before = spreadsheetValues('A2: Проводит аудит | B2: Ежегодно');
    const after = spreadsheetValues('A3: Проводит аудит | B3: Ежегодно');
    expect(before).toBe('Проводит аудит | Ежегодно');
    expect(buildTextDiff(before, after)).toMatchObject({ modifiedLines: 0, removedLines: 0, addedLines: 0 });
    expect(spreadsheetValues('Проводит аудит | A2: пользовательское значение')).toBe('Проводит аудит | A2: пользовательское значение');
    expect(buildTextDiff(before, spreadsheetValues('A3: Проводит аудит | B3: Ежемесячно')).modifiedLines).toBe(1);
  });
  it('preserves spreadsheet addresses in source locators', () => {
    const result = documentResult({ id: 'doc', fragment_count: 1, warnings: [] } as unknown as ServerDocument, [{ id: 'doc:1', document_id: 'doc', text: 'A2: Аудит | B2: Ежегодно', locator: 'Лист: A2:B2', clause: null, page: null, sheet: 'Лист', cell_range: 'A2:B2' }]);
    expect(result.paragraphs[0].locator).toBe('Лист: A2:B2');
    expect(spreadsheetValues(result.text)).toBe('Аудит | Ежегодно');
  });
});

const functions: FunctionRecord[] = [
  { id: 'f1', unit_id: 'u1', side: 'before', owner: 'Отдел контроля', action: 'Проводить финансовые операции', object: '', scope: '', kind: 'prohibition', evidence: [] },
  { id: 'f2', unit_id: 'u2', side: 'after', owner: 'Департамент контроля', action: 'Проводить финансовые операции', object: '', scope: '', kind: 'prohibition', evidence: [] },
];
const findings: Finding[] = [
  { id: 'one', kind: 'conflict', title: 'Противоречащие полномочия', explanation: 'Нужна проверка.', recommendation: 'Уточните полномочия.', function_ids: ['f1', 'f2'], evidence: [], review_required: true },
  { id: 'two', kind: 'duplication', title: 'Дублирование', explanation: '', recommendation: '', function_ids: [], evidence: [], review_required: true },
  { id: 'three', kind: 'reporting_change', title: 'Изменение подчинения', explanation: 'Изменён руководитель.', recommendation: '', function_ids: [], evidence: [], review_required: true },
];
const result: AnalysisResult = {
  comparison_id: 'comparison-one', mode: 'demo', model: null, prompt_version: 'test', generated_at: '2026-09-23T00:00:00Z',
  units: [], functions, reporting: [], unit_changes: [], function_changes: [{ before_id: 'f1', after_ids: ['f2'], status: 'preserved', explanation: 'Переименовано подразделение.', evidence: [] }],
  findings, warnings: [], coverage: { before: true, after: true }, summary: 'Сводка',
  reviews: [{ finding_id: 'one', status: 'confirmed', comment: '', updated_at: 'now' }, { finding_id: 'two', status: 'dismissed', comment: '', updated_at: 'now' }],
};
const comparison: Comparison = {
  id: 'comparison-one', title: 'Сравнение', before_complete: true, after_complete: true, status: 'completed', stage: 'completed', progress: 100, mode: 'demo', error: null,
  created_at: '2026-09-23T00:00:00Z', updated_at: '2026-09-23T00:00:00Z', documents: [],
};
const renderResult = () => renderToStaticMarkup(createElement(ComparisonResults, { comparison, result, onRefresh: async () => {} }));

describe('QA #6, #15, #29, #31: findings and function semantics', () => {
  it('renders associated owners, actions and prohibition labels directly on finding cards', () => {
    const html = renderResult();
    expect(html).toContain('Функции, связанные с выводом');
    expect(html).toContain('Отдел контроля');
    expect(html).toContain('Департамент контроля');
    expect(html).toContain('Проводить финансовые операции');
    expect(html).toContain('Запрет');
  });
  it('renders reporting changes without inventing function associations', () => {
    expect(findingLabels.reporting_change).toBe('Изменение подчинения');
    expect(renderResult()).toContain('finding-reporting_change');
  });
  it('renders a completed empty-structure result with its coverage finding', () => {
    const empty = { ...result, functions: [], units: [], function_changes: [], findings: [{ ...findings[2], kind: 'coverage_gap' as const, title: 'Структура не распознана' }] };
    const html = renderToStaticMarkup(createElement(ComparisonResults, { comparison, result: empty, onRefresh: async () => {} }));
    expect(html).toContain('Структура не распознана');
    expect(html).toContain('finding-coverage_gap');
    expect(html).not.toContain('Анализ функций ещё не запущен');
  });
  it('filters by type and expert review status, including unreviewed by default', () => {
    expect(filteredFindings(result, 'conflict', 'confirmed').map((item) => item.id)).toEqual(['one']);
    expect(filteredFindings(result, 'all', 'dismissed').map((item) => item.id)).toEqual(['two']);
    expect(filteredFindings(result, 'all', 'unreviewed').map((item) => item.id)).toEqual(['three']);
    expect(filteredFindings(result, 'duplication', 'confirmed')).toEqual([]);
    expect(renderResult()).toContain('Тип замечания');
    expect(renderResult()).toMatch(/<button[^>]+stat-conflict/);
  });
  it('sorts by type or expert review with stable ties and preserves server input', () => {
    const reversed = { ...result, findings: [...findings].reverse() };
    expect(filteredFindings(reversed, 'all', 'all', 'kind').map((item) => item.id)).toEqual(['one', 'two', 'three']);
    expect(filteredFindings(result, 'all', 'all', 'review').map((item) => item.id)).toEqual(['three', 'one', 'two']);
    expect(filteredFindings(reversed, 'all', 'all', 'original').map((item) => item.id)).toEqual(['three', 'two', 'one']);
    const ties = { ...result, findings: [{ ...findings[0], id: 'a' }, { ...findings[0], id: 'b' }], reviews: [] };
    expect(filteredFindings(ties, 'all', 'all', 'review').map((item) => item.id)).toEqual(['a', 'b']);
    expect(result.findings.map((item) => item.id)).toEqual(['one', 'two', 'three']);
  });
  it('shows preserved functions after a pure department rename as the backend reports', () => {
    vi.stubGlobal('localStorage', { getItem: (key: string) => key === 'larpsec.resultTab.comparison-one' ? 'functions' : null });
    const html = renderResult();
    expect(html).toContain('tag-preserved');
    expect(html).toContain('Сохранена');
    expect(html).not.toContain('tag-moved');
  });
});

describe('QA #16: comparison history API', () => {
  it('lists server history with pagination and deletes the selected comparison', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(Response.json([comparison])).mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await listComparisons(20, 40)).toEqual([comparison]);
    await deleteComparison('comparison-one');
    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/comparisons?limit=20&offset=40');
    expect(fetchMock.mock.calls[1][0]).toBe('/api/v1/comparisons/comparison-one');
    expect(fetchMock.mock.calls[1][1].method).toBe('DELETE');
  });
  it('surfaces rejection if analysis started before deletion', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ error: { code: 'comparison_busy', message: 'Дождитесь завершения анализа.' } }, { status: 409 })));
    await expect(deleteComparison('comparison-one')).rejects.toThrow('Дождитесь завершения анализа.');
  });
});

describe('QA #20–25: clear wording and persistent navigation', () => {
  it.each([[1, '1 документ'], [2, '2 документа'], [5, '5 документов'], [11, '11 документов'], [21, '21 документ']])('declines document count %s', (count, text) => {
    expect(documentCount(Number(count))).toBe(text);
  });
  it('restores chosen page and tab, rejects obsolete values and tolerates disabled storage', () => {
    const values = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) });
    saveChoice('larpsec.workspaceView', 'comparison'); saveChoice('larpsec.comparisonView', 'analysis');
    expect(storedChoice('larpsec.workspaceView', ['documents', 'comparison'])).toBe('comparison');
    expect(storedChoice('larpsec.comparisonView', ['text', 'analysis'])).toBe('analysis');
    saveChoice('larpsec.workspaceView', 'documents');
    expect(storedChoice('larpsec.workspaceView', ['documents', 'comparison'])).toBe('documents');
    saveChoice('larpsec.workspaceView', 'obsolete');
    expect(storedChoice('larpsec.workspaceView', ['documents', 'comparison'])).toBeNull();
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } });
    expect(() => saveChoice('view', 'documents')).not.toThrow();
    expect(storedChoice('view', ['documents'])).toBeNull();
  });
  it('keeps the sidebar viewport height and extends its rail to the document bottom', async () => {
    const css = await readFile('src/styles.css', 'utf8');
    expect(css).toContain('height: 100dvh');
    expect(css).toContain('background: linear-gradient(to right, #fff 0, #fff var(--sidebar-width)');
  });
  it('shows partial extraction and warnings instead of an unconditional success banner', () => {
    const doc = { id: 'doc', file: new File(['x'], 'partial.docx'), name: 'partial.docx', sizeBytes: 1, phase: 'before', source: 'server', status: 'ready', progress: 100, addedAt: 0, extractionComplete: false, result: { text: 'Текст', paragraphs: [{ id: 'p', text: 'Текст' }], warnings: [] } } as WorkspaceDocument;
    expect(previewStatus(doc)).toMatchObject({ caution: true, heading: 'Документ прочитан частично' });
    const html = renderToStaticMarkup(createElement(ResultView, { doc, onBack: () => {}, onCompare: () => {} }));
    expect(html).toContain('НЕПОЛНЫЙ ТЕКСТ');
    expect(html).not.toContain('ГОТОВО');
    expect(previewStatus({ ...doc, extractionComplete: true, result: { ...doc.result!, warnings: ['Проверьте оригинал.'] } }).heading).toBe('Документ прочитан с предупреждениями');
  });
  it('uses Russian sample filenames and analysis-specific page descriptions', () => {
    expect(SAMPLE_FILENAMES.before).toBe('Положение — до изменений.docx');
    expect(SAMPLE_FILENAMES.after).toBe('Положение — после изменений.docx');
    expect(pageSubtitle('comparison', 'analysis')).toContain('подчинения');
    expect(pageSubtitle('comparison', 'analysis')).not.toEqual(pageSubtitle('documents', 'analysis'));
  });
});
