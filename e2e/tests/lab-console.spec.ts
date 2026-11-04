import { expect, test } from '@playwright/test';

test.describe('the Dispute Lab', () => {
  test('a labelled scenario runs through the real services and does what the rules say', async ({ page }) => {
    await page.goto('/lab');
    await expect(page.getByRole('heading', { name: 'Dispute Lab' })).toBeVisible();

    const card = page.locator('section.card', { hasText: 'Buyer denies an authorised, delivered purchase' }).first();
    await card.getByRole('button', { name: 'Run' }).click();
    await expect(card.getByText('As the rules say.')).toBeVisible();
    await expect(card.getByText('Contest the dispute').first()).toBeVisible();
    await expect(card.getByRole('link', { name: 'Open the public proof' })).toBeVisible();
  });

  test('a whole family runs and reports how many did what the rules say', async ({ page }) => {
    await page.goto('/lab');
    await page.getByLabel('Scenario family').selectOption('forgery');
    await page.getByRole('button', { name: /^Run \d+ shown$/ }).click();
    await expect(page.getByText(/^8 of 8 scenarios run did what the rules say they should\.$/)).toBeVisible({ timeout: 50_000 });
  });
});

test.describe('the merchant console', () => {
  test('every section opens', async ({ page }) => {
    await page.goto('/console');
    await expect(page.getByRole('heading', { name: 'Merchant console' })).toBeVisible();
    for (const section of ['Orders', 'Disputes', 'Checkouts', 'Catalog', 'Registry']) {
      await page.getByRole('navigation', { name: 'Console sections' }).getByRole('link', { name: new RegExp(`^${section}`) }).click();
      await expect(page.getByRole('navigation', { name: 'Console sections' }).getByRole('link', { name: new RegExp(`^${section}`) })).toHaveClass(/active/);
      await expect(page.locator('.note.bad')).toHaveCount(0);
    }
  });

  test('the registry can sign a checkpoint and audit its own log', async ({ page }) => {
    await page.goto('/console/registry');
    await page.getByRole('button', { name: 'Sign a checkpoint and audit the log' }).click();
    await expect(page.getByText(/The log is intact: \d+ entries, head \d+\./)).toBeVisible();
  });

  test('analytics opens in AG Studio without errors', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('/console/studio');
    await expect(page.getByRole('navigation', { name: 'Console sections' }).getByRole('link', { name: 'Analytics' })).toHaveClass(/active/);
    await expect(page.getByText('Loading analytics')).toHaveCount(0, { timeout: 30_000 });
    await page.waitForTimeout(1500);
    expect(errors).toEqual([]);
  });
});
