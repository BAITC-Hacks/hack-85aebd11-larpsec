import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ComparisonResults from '../../src/ComparisonResults';
import TextRepetitions from '../../src/TextRepetitions';
import { DOCUMENT_ACCEPT, DOCUMENT_FORMATS, downloadText, validateDocumentSignature, validateFile } from '../../src/lib/documents';
import { filterChanges } from '../../src/lib/presentation';
import { buildTextDiff, type TextDiffOptions } from '../../src/lib/textDiff';
import { findTextRepetitions } from '../../src/lib/textRepetitions';
import { xlsxComparisonText } from '../../src/lib/xlsxText';
import type { AnalysisResult, Comparison, Paragraph, WorkspaceDocument } from '../../src/lib/types';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

function spreadsheetDiff(before: string[], after: string[], beforeLocators: string[], afterLocators: string[]) {
  const options: TextDiffOptions = {
    beforeFormat: 'xlsx', afterFormat: 'xlsx', beforeFragments: before, afterFragments: after,
    beforeFragmentLocators: beforeLocators, afterFragmentLocators: afterLocators,
  };
  return buildTextDiff(before.join('\n\n'), after.join('\n\n'), options);
}

describe('GitHub XLSX fragments with QA matching and honest counts', () => {
  it('ignores shifted row and column addresses, retaining both exact sources', () => {
    const before = ['A2: Проводит аудит | B2: Ежегодно', 'A3: Готовит отчёт | B3: Ежемесячно'];
    const after = ['C5: Проводит аудит | D5: Ежегодно', 'C6: Готовит отчёт | D6: Ежемесячно'];
    const diff = spreadsheetDiff(before, after, ['Лист «Данные», A2:B2', 'Лист «Данные», A3:B3'], ['Лист «Данные», C5:D5', 'Лист «Данные», C6:D6']);
    expect(diff).toMatchObject({ modifiedLines: 0, removedLines: 0, addedLines: 0 });
    expect(diff.rows.map((row) => row.kind)).toEqual(['equal', 'equal']);
    expect(diff.rows.map((row) => row.before?.text)).toEqual(before);
    expect(diff.rows.map((row) => row.after?.text)).toEqual(after);
  });
  it('compares old address-tagged uploads with newly parsed value-only rows', () => {
    const diff = spreadsheetDiff(['A2: Проводит аудит | B2: Ежегодно'], ['Проводит аудит | Ежегодно'], ['Лист «Данные», A2:B2'], ['Лист «Данные», A9:B9']);
    expect(diff.rows[0].kind).toBe('equal');
    expect(diff.rows[0].before?.text).toBe('A2: Проводит аудит | B2: Ежегодно');
    expect(diff.rows[0].after?.text).toBe('Проводит аудит | Ежегодно');
  });
  it('pairs single-word case changes using values and never highlights ignored addresses', () => {
    const diff = spreadsheetDiff(['A2: Me'], ['A3: me'], ['Лист «Данные», A2:A2'], ['Лист «Данные», A3:A3']);
    expect(diff).toMatchObject({ modifiedLines: 1, removedLines: 0, addedLines: 0 });
    expect(diff.rows[0].before?.segments).toEqual([{ text: 'A2: ', changed: false }, { text: 'Me', changed: true }]);
    expect(diff.rows[0].after?.segments).toEqual([{ text: 'A3: ', changed: false }, { text: 'me', changed: true }]);
  });
  it('highlights changed values, keeps address tokens unchanged and reconstructs raw lines', () => {
    const before = 'A2: Готовит квартальный отчёт | B2: Ежегодно';
    const after = 'A9: Готовит годовой отчёт | B9: Ежегодно';
    const diff = spreadsheetDiff([before], [after], ['Лист «Данные», A2:B2'], ['Лист «Данные», A9:B9']);
    expect(diff).toMatchObject({ modifiedLines: 1, removedLines: 0, addedLines: 0 });
    for (const [line, original] of [[diff.rows[0].before!, before], [diff.rows[0].after!, after]] as const) {
      expect(line.segments.map((part) => part.text).join('')).toBe(original);
      expect(line.segments.filter((part) => part.changed).map((part) => part.text).join('')).not.toMatch(/[AB]\d+:/u);
    }
    expect(diff.rows[0].before?.segments.some((part) => part.changed && part.text.includes('квартальный'))).toBe(true);
  });
  it('keeps unrelated spreadsheet duties removed and added despite matching coordinates', () => {
    const diff = spreadsheetDiff(['A2: Проводит аудит', 'A3: Ведёт кадровый учёт'], ['A9: Организует корпоративы'], ['Лист «Данные», A2:A2', 'Лист «Данные», A3:A3'], ['Лист «Данные», A9:A9']);
    expect(diff.rows.map((row) => row.kind)).toEqual(['removed', 'removed', 'added']);
    expect(diff).toMatchObject({ modifiedLines: 0, removedLines: 2, addedLines: 1 });
  });
  it('does not treat an address inside a multiline value as another parser row', () => {
    const before = 'A2: Описание\nA2: пользовательское значение | B2: Ежегодно';
    const after = 'A3: Описание\nA3: пользовательское значение | B3: Ежегодно';
    const diff = spreadsheetDiff([before], [after], ['Лист «Данные», A2:B2'], ['Лист «Данные», A3:B3']);
    expect(diff.rows[0].kind).toBe('equal');
    expect(diff.rows[1].kind).toBe('modified');
    expect(diff.rows[1].before?.segments.filter((part) => part.changed).map((part) => part.text).join('')).toContain('A2');
    expect(diff.rows[1].after?.segments.filter((part) => part.changed).map((part) => part.text).join('')).toContain('A3');
  });
  it('does not strip ambiguous, split or unrelated cell-value addresses', () => {
    const ambiguous = 'A2: значение | B2: пользовательский пример | B2: следующий столбец';
    expect(xlsxComparisonText(ambiguous, 'Лист «Данные», A2:B2')).toBe(ambiguous);
    expect(xlsxComparisonText('A2: обрывок', 'Лист «Данные», A2:A2, часть 2')).toBe('A2: обрывок');
    expect(xlsxComparisonText('A2: пользовательское значение', 'Лист «Данные», C2:C2')).toBe('A2: пользовательское значение');
    expect(xlsxComparisonText('Описание | A2: пользовательское значение', 'Лист «Данные», A2:B2')).toBe('Описание | A2: пользовательское значение');
  });
  it('uses source boundaries only when they match the complete displayed text', () => {
    const diff = buildTextDiff('A2: x\n\nA3: y', 'A4: x\n\nA5: y', {
      beforeFormat: 'xlsx', afterFormat: 'xlsx', beforeFragments: ['stale'], afterFragments: ['stale'],
      beforeFragmentLocators: ['Лист «Данные», A2:A2'], afterFragmentLocators: ['Лист «Данные», A4:A4'],
    });
    expect(diff.rows[0].kind).toBe('equal');
    expect(diff.rows.some((row) => row.kind !== 'equal')).toBe(true);
  });
});

const repeated = 'Отдел контроля готовит ежеквартальные отчёты о выполнении плана проверок.';
function documentWith(paragraphs: Paragraph[], overrides: Partial<WorkspaceDocument> = {}): WorkspaceDocument {
  return { id: 'doc', serverId: 'server-doc', file: new File(['text'], 'Положение.txt'), name: 'Положение.txt', sizeBytes: 4, phase: 'after', source: 'server', status: 'ready', progress: 100, addedAt: 0, result: { text: paragraphs.map((paragraph) => paragraph.text).join('\n\n'), paragraphs, warnings: [] }, ...overrides };
}
const paragraphs: Paragraph[] = [
  { id: 'server-doc:1', text: `1.1. ${repeated}`, section: '1.1', locator: 'Строка 1' },
  { id: 'server-doc:2', text: `1.2. ${repeated}`, section: '1.2', locator: 'Строка 3' },
];

describe('GitHub text repetitions alongside organizational findings', () => {
  it('groups only repeated bodies within a ready server document with exact source evidence', () => {
    const doc = documentWith(paragraphs);
    const groups = findTextRepetitions([doc, doc]);
    expect(groups).toHaveLength(1);
    expect(groups[0].occurrences).toEqual(paragraphs.map((paragraph) => ({ fragmentId: paragraph.id, text: paragraph.text, locator: paragraph.locator, section: paragraph.section })));
    expect(findTextRepetitions([documentWith([paragraphs[0]]), documentWith([paragraphs[1]], { serverId: 'another' })])).toEqual([]);
    expect(findTextRepetitions([documentWith(paragraphs, { status: 'error' })])).toEqual([]);
    expect(findTextRepetitions([documentWith(paragraphs, { serverId: undefined, source: 'example' })])).toEqual([]);
  });
  it('ignores duplicated fragment IDs and all supported DOCX header/footer locators', () => {
    const headers = ['Колонтитул 1', 'Верхний колонтитул, абзац 1', 'Нижний колонтитул, абзац 2'].map((locator, index) => ({ id: `header:${index}`, text: repeated, locator }));
    expect(findTextRepetitions([documentWith([...headers, paragraphs[0], paragraphs[0]])])).toEqual([]);
  });
  it('does not remove an inherited clause number from a different numeric value', () => {
    const doc = documentWith([{ id: '1', text: `2025 ${repeated}`, section: '1.1' }, { id: '2', text: `2026 ${repeated}`, section: '1.1' }]);
    expect(findTextRepetitions([doc])).toEqual([]);
  });
  it('recognizes legacy XLSX repeated values despite shifting addresses', () => {
    const doc = documentWith([
      { id: 'sheet:1', text: `A2: ${repeated} | B2: Ежегодно`, locator: 'Лист «Данные», A2:B2' },
      { id: 'sheet:2', text: `A3: ${repeated} | B3: Ежегодно`, locator: 'Лист «Данные», A3:B3' },
    ], { name: 'Положение.xlsx' });
    const groups = findTextRepetitions([doc]);
    expect(groups).toHaveLength(1);
    expect(groups[0].occurrences[1].text).toContain('A3:');
  });
  it('shows incomplete source availability instead of claiming there are no repeats', () => {
    const html = renderToStaticMarkup(createElement(TextRepetitions, { groups: [], loading: false, unavailableSides: ['after'], onOpen: () => {}, onRetry: async () => {} }));
    expect(html).toContain('Недостаточно текста для проверки');
    expect(html).not.toContain('Повторов в загруженном тексте не найдено');
  });
});

describe('TXT upload contract', () => {
  it('advertises and accepts TXT without requiring a ZIP/PDF magic signature', async () => {
    expect(DOCUMENT_ACCEPT).toBe('.docx,.pdf,.xlsx,.txt');
    expect(DOCUMENT_FORMATS).toBe('DOCX, PDF, XLSX и TXT');
    expect(validateFile({ name: 'Положение.TXT', size: 20 })).toBeUndefined();
    await expect(validateDocumentSignature(new File([repeated], 'Положение.txt'))).resolves.toBeUndefined();
    expect(validateFile({ name: 'Положение.xls', size: 20 })).toContain('сохраните как');
    expect(validateFile({ name: 'Положение.rtf', size: 20 })).toContain(DOCUMENT_FORMATS);
  });
  it('does not duplicate the TXT extension in extracted text downloads', () => {
    vi.useFakeTimers();
    const link = { href: '', download: '', click: vi.fn() };
    vi.stubGlobal('document', { createElement: () => link });
    vi.stubGlobal('URL', { createObjectURL: () => 'blob:text', revokeObjectURL: vi.fn() });
    downloadText('Положение.TXT', repeated);
    expect(link.download).toBe('Положение.txt');
    expect(link.click).toHaveBeenCalledOnce();
    vi.runAllTimers();
  });
});

const comparison: Comparison = { id: 'merged', title: 'Сравнение', before_complete: true, after_complete: true, status: 'completed', stage: 'completed', progress: 100, mode: 'demo', error: null, created_at: 'now', updated_at: 'now', documents: [] };
const result: AnalysisResult = { comparison_id: 'merged', mode: 'demo', model: null, prompt_version: 'test', generated_at: '2026-09-23T00:00:00Z', units: [], functions: [], reporting: [], unit_changes: [{ before_ids: [], after_ids: [], status: 'renamed', explanation: 'Переименовано', evidence: [] }], function_changes: [{ before_id: null, after_ids: [], status: 'preserved', explanation: 'Сохранена', evidence: [] }], findings: [], warnings: [], coverage: { before: true, after: true }, summary: 'Сводка', reviews: [] };
const renderResult = () => renderToStaticMarkup(createElement(ComparisonResults, { comparison, result, documents: [documentWith(paragraphs)], onRefresh: async () => {} }));

describe('Merged result navigation and filters', () => {
  it('retains the repeats tab after reload without losing QA findings filters/sort', () => {
    expect(renderResult()).toContain('Порядок выводов');
    expect(renderResult()).toContain('Проверка экспертом');
    expect(renderResult()).toContain('Изменение подчинения');
    expect(renderResult()).toContain('Дублирование функций');
    vi.stubGlobal('localStorage', { getItem: (key: string) => key === 'larpsec.resultTab.merged' ? 'repetitions' : null });
    const html = renderResult();
    expect(html).toContain('Повторы формулировок');
    expect(html).toContain('2 раза в одном документе');
    expect(html).toContain('Открыть источник: Строка 3, пункт 1.2');
    expect(html).not.toContain('Тип замечания');
  });
  it('renders function and unit status filters, and filters them without mutating source order', () => {
    vi.stubGlobal('localStorage', { getItem: () => 'functions' });
    expect(renderResult()).toContain('Статус функции');
    vi.stubGlobal('localStorage', { getItem: () => 'units' });
    expect(renderResult()).toContain('Статус подразделения');
    const changes = [{ status: 'preserved', id: 1 }, { status: 'modified', id: 2 }, { status: 'preserved', id: 3 }];
    expect(filterChanges(changes, 'preserved').map((item) => item.id)).toEqual([1, 3]);
    expect(filterChanges(changes, 'all')).toBe(changes);
    expect(filterChanges(changes, 'absent')).toEqual([]);
    expect(changes.map((item) => item.id)).toEqual([1, 2, 3]);
  });
});
