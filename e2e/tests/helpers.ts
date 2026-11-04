import { expect, type Page } from '@playwright/test';

/** What a finished purchase leaves behind: the id of the signed cart, which names the public proof page. */
export interface Purchase {
  readonly cartJti: string;
  readonly orderId: string;
}

/**
 * Buy the standing desk converter through the shopping agent, the way a person would: ask, sign the mandate, sign the
 * consent, pay on the PayPal simulator's page, come back. With `linkBuyerFirst` the sandbox PayPal buyer is linked to the
 * wallet beforehand, which is what lets the payer-binding check pass on this first purchase.
 */
export async function buyDeskConverter(page: Page, options: { linkBuyerFirst?: boolean } = {}): Promise<Purchase> {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Shop with an AI agent, safely' })).toBeVisible();

  if (options.linkBuyerFirst === true) {
    await page.getByRole('button', { name: 'Link the sandbox buyer now' }).click();
    await expect(page.getByText('linked', { exact: true })).toBeVisible();
  }

  await page.getByRole('button', { name: 'A standing desk converter under $120' }).click();
  await page.getByRole('button', { name: 'Sign this mandate' }).click();
  await expect(page.getByLabel('Wallet consent screen')).toBeVisible();
  await page.getByRole('button', { name: 'Approve and sign' }).click();

  await page.getByRole('link', { name: 'Continue to PayPal to pay' }).click();
  await expect(page.getByRole('heading', { name: /^Pay / })).toBeVisible();
  await page.getByRole('button', { name: 'Approve payment' }).click();

  await expect(page.getByText('Payment complete', { exact: true })).toBeVisible();
  const proof = page.getByRole('link', { name: 'See the public proof of what you authorised' });
  const href = await proof.getAttribute('href');
  expect(href).toMatch(/^\/v\/.+/);
  const receipt = (await page.locator('.note.good', { hasText: 'Payment complete' }).innerText()).match(/Order (\S+?)\./);
  expect(receipt).not.toBeNull();
  return { cartJti: (href ?? '').replace('/v/', ''), orderId: receipt?.[1] ?? '' };
}
