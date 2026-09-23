import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

test('upload errors allow retry against the real server without local fallback', async ({ page }) => {
  let requests = 0;
  await page.route('**/api/v1/comparisons/*/documents?side=*', async (route) => {
    requests++;
    if (requests === 1) await route.fulfill({ status: 413, json: { error: { code: 'upload_too_large', message: 'Сервер отклонил размер файла.' } } });
    else await route.continue();
  });
  await page.goto('/');
  await expect(page.getByLabel('Выбрать документ')).toBeEnabled();
  await page.getByLabel('Выбрать документ').setInputFiles('public/examples/before.docx');
  await page.getByRole('button', { name: 'Обработать документ', exact: true }).click();
  await expect(page.getByText('Не удалось прочитать документ', { exact: true })).toBeVisible();
  await expect(page.getByText('Документ прочитан', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Повторить попытку', exact: true }).click();
  await expect(page.getByText('Документ прочитан', { exact: true })).toBeVisible();
  expect(requests).toBe(2);
  await expect(page.getByText('Обработано на сервере', { exact: true })).toBeVisible();
});

test('polling recovers from a transient server failure and restores real results', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Загрузить пример «до/после»' }).click();
  await expect(page.getByRole('button', { name: 'Запустить сравнение' })).toBeEnabled();
  let failed = false;
  await page.route(/\/api\/v1\/comparisons\/[^/]+$/, async (route) => {
    if (route.request().method() === 'GET' && !failed) {
      failed = true;
      await route.fulfill({ status: 503, json: { error: { code: 'temporarily_unavailable', message: 'Временный сбой связи.' } } });
    } else await route.continue();
  });
  await page.getByRole('button', { name: 'Запустить сравнение' }).click();
  await expect(page.getByRole('region', { name: 'Результат сравнения', exact: true })).toBeVisible({ timeout: 20_000 });
  expect(failed).toBe(true);
  await expect(page.locator('.analysis-finding')).toHaveCount(3);
});

test('initial health failure can be retried without reloading the page', async ({ page }) => {
  let available = false;
  await page.route('**/health', async (route) => {
    if (!available) await route.fulfill({ status: 503 });
    else await route.continue();
  });
  await page.goto('/');
  await expect(page.getByRole('alert')).toBeVisible();
  available = true;
  await page.getByRole('button', { name: 'Повторить подключение' }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByText('Демонстрационный анализ', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Загрузить пример «до/после»' }).click();
  await expect(page.getByRole('button', { name: 'Запустить сравнение' })).toBeEnabled();
});

test('cancelling an acknowledged upload removes the saved server file and permits retry', async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let savedId = '';
  let intercepted = false;
  await page.route('**/api/v1/comparisons/*/documents?side=*', async (route) => {
    if (intercepted) return route.continue();
    intercepted = true;
    // Playwright's intercepted multipart postData does not preserve file bytes.
    // Persist the same real file, then delay its acknowledgement to the browser.
    const response = await page.request.post(route.request().url(), {
      multipart: { file: { name: 'before.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: await readFile('public/examples/before.docx') } },
    });
    expect(response.status()).toBe(201);
    savedId = (await response.json()).comparison_id;
    await gate;
    await route.fulfill({ response });
  });
  await page.goto('/');
  await expect(page.getByLabel('Выбрать документ')).toBeEnabled();
  await page.getByLabel('Выбрать документ').setInputFiles('public/examples/before.docx');
  await page.getByRole('button', { name: 'Обработать документ', exact: true }).click();
  await expect.poll(() => typeof savedId === 'string' && savedId.length > 0).toBe(true);
  await page.getByRole('button', { name: 'Отменить', exact: true }).click();
  release();
  await expect(page.getByText('Документ готов к обработке', { exact: true })).toBeVisible();
  const stored = await page.request.get(`/api/v1/comparisons/${savedId}`);
  expect((await stored.json()).documents).toHaveLength(0);
  await page.getByRole('button', { name: 'Обработать документ', exact: true }).click();
  await expect(page.getByText('Документ прочитан', { exact: true })).toBeVisible();
  const retried = await page.request.get(`/api/v1/comparisons/${savedId}`);
  expect((await retried.json()).documents).toHaveLength(1);
});

test('completed comparison can retry a source preview after an interrupted reload', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Загрузить пример «до/после»' }).click();
  await page.getByRole('button', { name: 'Запустить сравнение' }).click();
  await expect(page.getByRole('region', { name: 'Результат сравнения', exact: true })).toBeVisible({ timeout: 20_000 });
  await page.route('**/fragments?*', (route) => route.fulfill({ status: 503 }));
  await page.reload();
  await page.locator('.document-name').filter({ hasText: 'before.docx' }).click();
  await expect(page.getByRole('heading', { name: 'Не удалось загрузить текст' })).toBeVisible();
  await page.unroute('**/fragments?*');
  await page.getByRole('button', { name: 'Повторить загрузку текста' }).click();
  await expect(page.getByText('Документ прочитан', { exact: true })).toBeVisible();
});
