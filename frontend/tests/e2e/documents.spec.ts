import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

test('workspace fits the viewport and provides preview screenshots', async ({ page }, testInfo) => {
  await page.goto('/');
  await page.evaluate(() => document.fonts.ready);
  await expect(page.getByRole('heading', { name: 'Загрузите документ' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('workspace.png'), fullPage: true });
  await page.getByRole('button', { name: 'Сначала посмотреть пример', exact: false }).click();
  await expect(page.getByText('Документ прочитан', { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('result.png'), fullPage: true });
});

test('uploads a real DOCX, searches the clarified clause and downloads extracted text', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByLabel('Выбрать документ')).toBeEnabled();
  await page.getByLabel('Выбрать документ').setInputFiles('public/examples/audit-example.docx');
  await expect(page.getByText('Документ готов к обработке')).toBeVisible();
  await page.getByRole('button', { name: 'Обработать документ', exact: true }).click();
  await expect(page.getByText('Документ прочитан', { exact: true })).toBeVisible();
  await page.getByLabel('Найти в документе').fill('5.5.3');
  await expect(page.locator('.document-paragraph')).toHaveCount(1);
  await expect(page.locator('.document-paragraph')).toContainText('готовит отчеты об итогах выполнения плана работы БВА');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Скачать текст' }).click();
  expect((await download).suggestedFilename()).toBe('audit-example.txt');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('rejects other formats and renamed files with a recoverable error', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByLabel('Выбрать документ')).toBeEnabled();
  await page.getByLabel('Выбрать документ').setInputFiles({ name: 'report.rtf', mimeType: 'application/rtf', buffer: Buffer.from('text') });
  await expect(page.getByRole('alert')).toContainText('Поддерживаются DOCX, PDF, XLSX и TXT');
  await expect(page.getByLabel('Выбрать документ')).toBeEnabled();
  await page.getByLabel('Выбрать документ').setInputFiles({ name: 'report.docx', mimeType: 'application/octet-stream', buffer: Buffer.from('not a docx') });
  await expect(page.getByRole('alert')).toContainText('не похож на');
  await expect(page.getByLabel('Выбрать документ')).toBeEnabled();
  await page.getByLabel('Выбрать документ').setInputFiles('public/examples/audit-example.docx');
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByText('Документ готов к обработке')).toBeVisible();
});

test('uploads a real TXT to the server, previews clauses and downloads extracted text', async ({ page }) => {
  const content = Buffer.from('\ufeffПодразделение: Аудит\r\n\r\n1.1. Проверяет годовую отчётность.\r\n1.2. Готовит заключение по результатам проверки.\r\n', 'utf8');
  await page.goto('/');
  await expect(page.getByLabel('Выбрать документ')).toBeEnabled();
  await page.getByLabel('Выбрать документ').setInputFiles({ name: 'Положение.txt', mimeType: 'text/plain', buffer: content });
  await expect(page.getByText('Документ готов к обработке')).toBeVisible();
  const uploaded = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname.endsWith('/documents'));
  await page.getByRole('button', { name: 'Обработать документ', exact: true }).click();
  const metadata = await (await uploaded).json();
  expect(metadata).toMatchObject({ filename: 'Положение.txt', format: 'txt', side: 'before' });
  await expect(page.getByText('Документ прочитан', { exact: true })).toBeVisible();
  await expect(page.locator('.reader-format')).toHaveText('TXT');
  await page.getByLabel('Найти в документе').fill('1.2');
  await expect(page.locator('.document-paragraph')).toHaveCount(1);
  await expect(page.locator('.document-paragraph')).toContainText('Готовит заключение по результатам проверки.');
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Скачать текст', exact: true }).click();
  const download = await downloaded;
  expect(download.suggestedFilename()).toBe('Положение.txt');
  expect(await readFile((await download.path())!, 'utf8')).toContain('1.1. Проверяет годовую отчётность.');
  const original = await page.request.get(`/api/v1/comparisons/${metadata.comparison_id}/documents/${metadata.id}/download`);
  expect(await original.body()).toEqual(content);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('handles corrupt DOCX, retry and removal', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByLabel('Выбрать документ')).toBeEnabled();
  await page.getByLabel('Выбрать документ').setInputFiles({ name: 'broken.docx', mimeType: 'application/octet-stream', buffer: Buffer.from([0x50, 0x4b, 3, 4, 0]) });
  await page.getByRole('button', { name: 'Обработать документ', exact: true }).click();
  await expect(page.getByText('Не удалось прочитать документ', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Повторить попытку' }).click();
  await expect(page.getByText('Не удалось прочитать документ', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Убрать выбранный файл' }).click();
  await expect(page.getByText('Здесь пока чистый лист')).toBeVisible();
});

test('opens an explicitly marked example and the keyboard-accessible guide', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Как это работает' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: 'Сначала посмотреть пример', exact: false }).click();
  await expect(page.getByText('Документ прочитан', { exact: true })).toBeVisible();
  await expect(page.locator('.example-notice')).toContainText('учебный документ');
});
