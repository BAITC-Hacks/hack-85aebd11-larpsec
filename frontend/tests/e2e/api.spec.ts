import { test, expect } from '@playwright/test';

test('sends DOCX and version, polls the server and preserves source text', async ({ page }) => {
  let uploadBody = '';
  let polls = 0;
  await page.route('**/api/documents', async (route) => {
    uploadBody = route.request().postData() || '';
    await route.fulfill({ status: 202, json: { id: 'server-1', status: 'queued' } });
  });
  await page.route('**/api/documents/server-1', async (route) => {
    polls++;
    await route.fulfill({ json: polls === 1 ? { id: 'server-1', status: 'processing' } : {
      id: 'server-1', status: 'ready', result: { text: '5.5.3. Серверный текст отчёта', paragraphs: [{ id: 'source-42', section: '5.5.3', text: '5.5.3. Серверный текст отчёта' }] },
    } });
  });
  await page.goto('/');
  await expect(page.getByText('Серверный режим')).toBeVisible();
  await page.getByRole('button', { name: 'После изменений', exact: true }).click();
  await page.getByLabel('Выбрать DOCX-файл').setInputFiles('public/examples/audit-example.docx');
  await page.getByRole('button', { name: 'Обработать документ', exact: true }).click();
  await expect(page.getByText('Документ прочитан', { exact: true })).toBeVisible({ timeout: 10_000 });
  expect(uploadBody).toContain('name="file"');
  expect(uploadBody).toContain('name="phase"');
  expect(uploadBody).toContain('after');
  expect(polls).toBe(2);
  await expect(page.locator('#paragraph-source-42')).toContainText('Серверный текст отчёта');
  await expect(page.getByText('Обработано на сервере', { exact: true })).toBeVisible();
});

test('reports an HTTP error and allows retry without pretending local success', async ({ page }) => {
  let requests = 0;
  await page.route('**/api/documents', async (route) => {
    requests++;
    await route.fulfill(requests === 1 ? { status: 413 } : { json: { id: 'retried', status: 'ready', result: { text: 'Документ после повторной отправки' } } });
  });
  await page.goto('/');
  await page.getByLabel('Выбрать DOCX-файл').setInputFiles('public/examples/audit-example.docx');
  await page.getByRole('button', { name: 'Обработать документ', exact: true }).click();
  await expect(page.getByText('Сервер отклонил размер файла.', { exact: false })).toBeVisible();
  await expect(page.getByText('Документ прочитан', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Повторить попытку' }).click();
  await expect(page.getByText('Документ прочитан', { exact: true })).toBeVisible();
  expect(requests).toBe(2);
});

test('cancels queued processing and starts a fresh request on retry', async ({ page }) => {
  let uploads = 0;
  await page.route('**/api/documents', async (route) => {
    uploads++;
    await route.fulfill({ status: 202, json: { id: `job-${uploads}`, status: 'queued' } });
  });
  await page.route('**/api/documents/job-*', async (route) => {
    const id = route.request().url().split('/').pop();
    await route.fulfill({ json: id === 'job-1' ? { id, status: 'processing' } : { id, status: 'ready', result: { text: 'Новая обработка завершена' } } });
  });
  await page.goto('/');
  await page.getByLabel('Выбрать DOCX-файл').setInputFiles('public/examples/audit-example.docx');
  await page.getByRole('button', { name: 'Обработать документ', exact: true }).click();
  await expect(page.getByText('Читаем ваш документ')).toBeVisible();
  await page.getByRole('button', { name: 'Отменить', exact: true }).click();
  await expect(page.getByText('Документ готов к обработке')).toBeVisible();
  await page.getByRole('button', { name: 'Обработать документ', exact: true }).click();
  await expect(page.getByText('Документ прочитан', { exact: true })).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('.document-content')).toContainText('Новая обработка завершена');
  expect(uploads).toBe(2);
});
