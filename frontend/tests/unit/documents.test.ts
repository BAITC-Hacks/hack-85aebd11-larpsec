import { readFile } from 'node:fs/promises';
import mammoth from 'mammoth';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_FILE_SIZE, normalizeText, validateFile, validateDocxSignature, validateDocumentSignature } from '../../src/lib/documents';
import { documentResult, getDocumentResult, getSource, parseFragment, parseServerDocument, reviewFinding } from '../../src/lib/api';
import type { Fragment, ServerDocument } from '../../src/lib/types';

describe('DOCX validation and extraction', () => {
  it('accepts case-insensitive DOCX and the exact size limit', () => {
    expect(validateFile({ name: 'Положение.DOCX', size: MAX_FILE_SIZE })).toBeUndefined();
  });
  it.each([
    [{ name: 'Положение.doc', size: 12 }, 'DOCX'],
    [{ name: 'empty.docx', size: 0 }, 'пустой'],
    [{ name: 'big.docx', size: MAX_FILE_SIZE + 1 }, '20 МБ'],
  ])('rejects invalid input %#', (file, error) => {
    expect(validateFile(file)).toContain(error);
  });
  it('rejects a renamed PDF before parsing', async () => {
    await expect(validateDocxSignature(new File(['%PDF-1.4'], 'fake.docx'))).rejects.toThrow('не похож на DOCX');
  });
  it('reads the real educational DOCX and preserves the clarified clause 5.5.3', async () => {
    const buffer = await readFile('public/examples/audit-example.docx');
    await expect(validateDocxSignature(new File([buffer], 'example.docx'))).resolves.toBeUndefined();
    const extracted = await mammoth.extractRawText({ buffer });
    const result = normalizeText(extracted.value);
    expect(result.paragraphs).toHaveLength(12);
    expect(result.paragraphs.find((p) => p.section === '5.5.3')?.text).toContain('готовит отчеты об итогах выполнения плана работы БВА');
    expect(result.text).toContain('УЧЕБНЫЙ ПРИМЕР');
  });
  it('rejects empty extraction instead of reporting success', () => {
    expect(() => normalizeText('\n\n ')).toThrow('не найден текст');
  });
});

const document: ServerDocument = {
  id: 'document-one', comparison_id: 'comparison-one', side: 'before', filename: 'before.docx',
  format: 'docx', sha256: 'a'.repeat(64), size_bytes: 1024, text_chars: 26, fragment_count: 1,
  warnings: ['Проверьте полноту документа.'], extraction_complete: false, created_at: '2026-09-23T12:00:00Z',
};
const fragment: Fragment = {
  id: 'document-one:00001', document_id: 'document-one', text: '5.5.3. Подготовка отчётов',
  locator: 'Абзац 1', clause: '5.5.3', page: null, sheet: null, cell_range: null,
};

afterEach(() => { vi.unstubAllGlobals(); });

describe('server file formats', () => {
  it.each(['before.docx', 'statement.PDF', 'structure.xlsx'])('accepts %s', (name) => {
    expect(validateFile({ name, size: 20 })).toBeUndefined();
  });
  it('validates PDF and XLSX signatures', async () => {
    await expect(validateDocumentSignature(new File(['%PDF-1.4'], 'statement.pdf'))).resolves.toBeUndefined();
    await expect(validateDocumentSignature(new File([new Uint8Array([80, 75, 3, 4, 0])], 'structure.xlsx'))).resolves.toBeUndefined();
    await expect(validateDocumentSignature(new File(['invalid'], 'statement.pdf'))).rejects.toThrow('не похож на PDF');
    await expect(validateDocumentSignature(new File(['invalid'], 'structure.xlsx'))).rejects.toThrow('не похож на XLSX');
  });
});

describe('actual comparison API contract', () => {
  it('accepts server document metadata without inventing a document job', () => {
    expect(parseServerDocument(document)).toEqual(document);
  });
  it('preserves fragment IDs and clause citations in the preview', () => {
    expect(parseFragment(fragment)).toEqual(fragment);
    const result = documentResult(document, [fragment]);
    expect(result.paragraphs[0]).toEqual({ id: fragment.id, text: fragment.text, section: '5.5.3', locator: 'Абзац 1' });
    expect(result.warnings).toEqual(document.warnings);
  });
  it.each([
    { id: 'old-api', status: 'ready', result: { text: 'text' } },
    { ...document, side: 'unknown' },
    { ...document, fragment_count: -1 },
    { ...document, extraction_complete: 'true' },
    { ...document, warnings: [123] },
  ])('rejects malformed or obsolete document responses %#', (input) => {
    expect(() => parseServerDocument(input)).toThrow();
  });
  it('rejects duplicate, foreign, and missing source fragments', () => {
    expect(() => documentResult({ ...document, fragment_count: 2 }, [fragment, fragment])).toThrow('не совпадают');
    expect(() => documentResult(document, [{ ...fragment, document_id: 'another-document' }])).toThrow('не совпадают');
    expect(() => documentResult(document, [])).toThrow('не все фрагменты');
  });
  it('loads every page of source fragments through /api/v1/comparisons', async () => {
    const first = Array.from({ length: 1000 }, (_, index) => ({ ...fragment, id: `source-${index}` }));
    const last = [{ ...fragment, id: 'source-1000' }];
    const fetchMock = vi.fn().mockResolvedValueOnce(Response.json(first)).mockResolvedValueOnce(Response.json(last));
    vi.stubGlobal('fetch', fetchMock);
    const result = await getDocumentResult({ ...document, fragment_count: 1001 });
    expect(result.paragraphs).toHaveLength(1001);
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      '/api/v1/comparisons/comparison-one/documents/document-one/fragments?limit=1000&offset=0',
      '/api/v1/comparisons/comparison-one/documents/document-one/fragments?limit=1000&offset=1000',
    ]);
  });
  it('encodes source IDs and sends actual review fields', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(Response.json(fragment))
      .mockResolvedValueOnce(Response.json({ finding_id: 'finding-one', status: 'confirmed', comment: 'Проверено', updated_at: 'now' }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await getSource('comparison-one', fragment.id)).toEqual(fragment);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/comparisons/comparison-one/sources/document-one%3A00001');
    const review = await reviewFinding('comparison-one', 'finding-one', 'confirmed', 'Проверено');
    expect(review.status).toBe('confirmed');
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ status: 'confirmed', comment: 'Проверено' });
  });
  it('shows server errors rather than reporting successful extraction', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ error: { code: 'missing', message: 'Документ не найден.' } }, { status: 404 })));
    await expect(getSource('comparison-one', fragment.id)).rejects.toThrow('Документ не найден.');
  });
});
