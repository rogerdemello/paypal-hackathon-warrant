import { expect, test } from '@playwright/test';
import { buyDeskConverter } from './helpers';

test.describe('a dispute, from the buyer to the merchant console', () => {
  test('a buyer who denies an authorised purchase is answered with the signed proof', async ({ page }) => {
    const { cartJti, orderId } = await buyDeskConverter(page, { linkBuyerFirst: true });

    // Play the buyer on the Lab page.
    await page.goto('/lab');
    await page.getByRole('tab', { name: 'Raise a dispute on an order' }).click();
    await page.getByLabel('Paid order').selectOption(orderId);
    await page.getByLabel('Reason').selectOption({ label: 'Unauthorised' });
    await page.getByRole('button', { name: 'Raise the dispute' }).click();
    await expect(page.getByText('The dispute agent has already read it.')).toBeVisible();

    // The merchant opens it in the console: the agent has already analysed it and proposes one action.
    await page.getByRole('link', { name: 'Open it in the console' }).click();
    await expect(page.getByText('3. What the agent proposes')).toBeVisible();
    await expect(page.getByText('Contest the dispute').first()).toBeVisible();
    await expect(page.getByText('Send evidence to PayPal')).toBeVisible();
    await expect(page.getByText('written from a template')).toBeVisible();

    // The public proof it relies on is the same page the shopper saw.
    await expect(page.getByRole('link', { name: 'Open the public proof' })).toHaveAttribute('href', `/v/${cartJti}`);

    // Nothing is sent until the merchant approves.
    await page.getByRole('button', { name: 'Approve and send evidence' }).click();
    await expect(page.getByText('Decided by')).toBeVisible();
  });

  test('a first purchase from an unlinked account is not contested on a guess', async ({ page }) => {
    const { orderId } = await buyDeskConverter(page);
    await page.goto('/lab');
    await page.getByRole('tab', { name: 'Raise a dispute on an order' }).click();
    await page.getByLabel('Paid order').selectOption(orderId);
    await page.getByRole('button', { name: 'Raise the dispute' }).click();
    await page.getByRole('link', { name: 'Open it in the console' }).click();
    await expect(page.getByText('3. What the agent proposes')).toBeVisible();
    // The queue lists every dispute; the decision card belongs to this one.
    const decision = page.locator('section.card', { has: page.getByRole('heading', { name: /^2\. The decision/ }) });
    await expect(decision.getByText('No proof of authorisation')).toBeVisible();
    await expect(decision.getByText('Contest the dispute')).toHaveCount(0);
    await expect(page.getByText('Paid by the bound PayPal account F7')).toBeVisible();
  });
});
