import { expect, test } from '@playwright/test';
import { buyDeskConverter } from './helpers';

test.describe('shopping with an agent', () => {
  test('a purchase goes from request to public proof', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('note').first()).toContainText('Demo mode');

    const { cartJti } = await buyDeskConverter(page, { linkBuyerFirst: true });

    await page.getByRole('link', { name: 'See the public proof of what you authorised' }).click();
    await expect(page).toHaveURL(new RegExp(`/v/${cartJti}$`));
    await expect(page.getByRole('heading', { name: 'Warrant verification' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Verified: the human authorised exactly this purchase' })).toBeVisible();
  });

  test('a first purchase with an unlinked PayPal account is signed but not fully established', async ({ page }) => {
    // A fresh browser profile is a fresh wallet, and its PayPal account is not linked yet.
    const { cartJti } = await buyDeskConverter(page);
    await page.goto(`/v/${cartJti}`);
    await expect(page.getByRole('heading', { name: 'Signed, with open questions' })).toBeVisible();
  });

  test('declining the consent screen buys nothing', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'A standing desk converter under $120' }).click();
    await page.getByRole('button', { name: 'Sign this mandate' }).click();
    await expect(page.getByLabel('Wallet consent screen')).toBeVisible();
    await page.getByRole('button', { name: 'Decline' }).click();
    await expect(page.getByRole('link', { name: 'Continue to PayPal to pay' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Approve and sign' })).toHaveCount(0);
  });

  test('a link to a cart that was never signed says so', async ({ page }) => {
    await page.goto('/v/not-a-real-cart');
    await expect(page.getByRole('heading', { name: 'No such warrant' })).toBeVisible();
  });
});
