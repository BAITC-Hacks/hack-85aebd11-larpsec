import { readFile } from 'node:fs/promises';
import mammoth from 'mammoth';
import { describe, expect, it } from 'vitest';
import { MAX_FILE_SIZE, normalizeText, validateFile, validateDocxSignature } from '../../src/lib/documents';
import { parseServerDocument } from '../../src/lib/api';

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

describe('backend contract validation', () => {
  it('accepts queued jobs and builds text paragraphs if only text is returned', () => {
    expect(parseServerDocument({ id: 'one', status: 'queued' }).status).toBe('queued');
    const result = parseServerDocument({ id: 'one', status: 'ready', result: { text: '5.5.3. Подготовка отчётов' } });
    expect(result.result?.paragraphs[0].section).toBe('5.5.3');
  });
  it('preserves server fragment identifiers for future citations', () => {
    const result = parseServerDocument({ id: 'one', status: 'ready', result: { text: 'Отчёт', paragraphs: [{ id: 'source-45', text: 'Отчёт', section: '5.5.3' }] } });
    expect(result.result?.paragraphs[0].id).toBe('source-45');
  });
  it.each([
    { status: 'ready' },
    { id: 'one', status: 'something' },
    { id: 'one', status: 'ready', result: { text: 123 } },
    { id: 'one', status: 'ready', result: { text: 'text', paragraphs: [{ id: 'x', text: 'a' }, { id: 'x', text: 'b' }] } },
  ])('rejects a malformed server response %#', (input) => {
    expect(() => parseServerDocument(input)).toThrow();
  });
});
