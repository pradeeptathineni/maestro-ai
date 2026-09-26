import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

async function expectNoSeriousAccessibilityViolations(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(
    results.violations.filter((violation) =>
      ['critical', 'serious'].includes(violation.impact ?? ''),
    ),
  ).toEqual([]);
}

test('primary evidence-to-decision path is inspectable and replayable', async ({ page }) => {
  const needTitle = `E2E context decision ${crypto.randomUUID()}`;
  await page.goto('/decide');
  await expect(
    page.getByRole('heading', { level: 1, name: 'What are you deciding?' }),
  ).toBeVisible();
  await expect(
    page.getByText('No model key required').or(page.getByText('Local workspace')),
  ).toBeVisible();
  await expectNoSeriousAccessibilityViolations(page);

  await page.getByRole('button', { name: 'New decision' }).click();
  await page.getByLabel('Project').selectOption({ label: 'Local AI-assisted development' });
  await page.getByLabel('Decision title').fill(needTitle);
  await page.getByRole('button', { name: 'Create need and compare' }).click();
  await expect(page.getByRole('heading', { level: 1, name: needTitle })).toBeVisible();

  for (const candidate of ['Context Mode', 'GitHub Agentic Workflows']) {
    await page.getByRole('button', { name: 'Add candidate' }).click();
    const candidateSelect = page.locator('select[name="candidate"]');
    const option = candidateSelect.locator('option', { hasText: candidate });
    await candidateSelect.selectOption((await option.getAttribute('value')) ?? '');
    await page.getByRole('button', { name: 'Add and assess' }).click();
    await expect(page.getByRole('button', { name: 'Add candidate' })).toBeVisible();
  }
  await page.getByRole('button', { name: 'Add candidate' }).click();
  await page.locator('select[name="candidate"]').selectOption('status_quo');
  await page.getByRole('button', { name: 'Add and assess' }).click();

  await expect(
    page.getByRole('heading', { level: 2, name: 'Gates first, preference fit second' }),
  ).toBeVisible();
  await expect(page.getByText('Unknown Blocked').first()).toBeVisible();
  await expect(page.getByText('Ineligible').first()).toBeVisible();
  await expect(page.getByText('Current workflow / no change').first()).toBeVisible();
  await expect(page.getByText('General consideration', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Project fit', { exact: true }).first()).toBeVisible();

  await page.getByRole('link', { name: 'Context Mode', exact: true }).click();
  await expect(
    page.getByRole('heading', { level: 2, name: 'Trace every material assertion' }),
  ).toBeVisible();
  await expect(page.getByText('Publisher Claim').first()).toBeVisible();
  await expect(page.getByText(/96/).first()).toBeVisible();
  await expect(page.getByText(/Publisher benchmark/).first()).toBeVisible();
  await expect(page.getByText(/cannot install or execute providers/i)).toBeVisible();
  await expectNoSeriousAccessibilityViolations(page);

  await page.goBack();
  await page.getByLabel('Outcome').selectOption('trial');
  const statusQuo = page
    .getByLabel(/Selected candidate/)
    .locator('option', { hasText: 'Current workflow' });
  await page
    .getByLabel(/Selected candidate/)
    .selectOption((await statusQuo.getAttribute('value')) ?? '');
  await page.getByRole('button', { name: 'Record decision receipt' }).click();
  await expect(page.getByRole('heading', { level: 2, name: 'Human decision' })).toBeVisible();
  await expect(page.getByText('Receipt verified by hash')).toBeVisible();
  const hash = await page
    .locator('code')
    .filter({ hasText: /^[a-f0-9]{64}$/ })
    .last()
    .textContent();
  expect(hash).toMatch(/^[a-f0-9]{64}$/);
  const receiptUrl = page.url();

  const replay = await page.request.post('/api/v1/score-runs/replay', {
    headers: { 'content-type': 'application/json', 'x-maestro-request': '1' },
    data: {},
  });
  expect(replay.ok()).toBe(true);
  expect(await replay.json()).toEqual({ checked: 12, mismatches: [] });
  await page.goto(receiptUrl);
  await expect(page.locator('code').filter({ hasText: hash! }).last()).toBeVisible();
  await expectNoSeriousAccessibilityViolations(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('.receipt')).toBeVisible();
  expect(
    await page.evaluate(() => ({
      bodyFits: document.body.scrollWidth <= window.innerWidth,
      receiptFits: (() => {
        const receipt = document.querySelector<HTMLElement>('.receipt');
        return Boolean(receipt && receipt.scrollWidth <= receipt.clientWidth);
      })(),
    })),
  ).toEqual({ bodyFits: true, receiptFits: true });
});

test('catalog browse explains ranking and provenance', async ({ page }) => {
  await page.goto('/explore');
  await expect(page.getByText('12 capabilities found')).toBeVisible();
  await page.getByLabel('Search names, aliases, capabilities').fill('Context Mode');
  await expect(page.getByText('1 capabilities found')).toBeVisible();
  await page.getByRole('link', { name: 'Context Mode' }).first().click();
  await expect(page.getByText('Conservative score decomposition')).toBeVisible();
  await expect(page.getByText(/Missing:/).first()).toBeVisible();
  await expect(page.getByText('Claims & evidence')).toBeVisible();
});

test('Consider URL shows new, duplicate, manual-review, and safe-invalid states', async ({
  page,
}) => {
  const suffix = crypto.randomUUID();
  await page.goto('/consider');
  await page.getByLabel('URL').fill(`https://github.com/maestro-e2e/${suffix}?utm_source=e2e`);
  await page.getByLabel('Optional note').fill('A bounded local test intake.');
  await page.getByRole('button', { name: 'Capture for review' }).click();
  await expect(page.getByText('New intake')).toBeVisible();
  await expect(
    page.getByRole('heading', { name: `https://github.com/maestro-e2e/${suffix}` }),
  ).toBeVisible();

  await page.getByLabel('URL').fill(`https://github.com/maestro-e2e/${suffix}`);
  await page.getByRole('button', { name: 'Capture for review' }).click();
  await expect(page.getByText(/Duplicate · Normalized Url/)).toBeVisible();

  await page.getByLabel('URL').fill(`https://example.com/${suffix}`);
  await page.getByRole('button', { name: 'Capture for review' }).click();
  await expect(page.getByText('Manual Review Required').first()).toBeVisible();
  await expect(page.getByText(/automatic retrieval is not allowed/i).first()).toBeVisible();
  const manualRow = page
    .getByRole('row')
    .filter({ hasText: `https://example.com/${suffix}` })
    .first();
  await manualRow.getByRole('combobox').selectOption({ label: 'Context Mode' });
  await manualRow.getByRole('button', { name: 'Attach' }).click();
  await expect(manualRow.getByText('Curated')).toBeVisible();
  await manualRow.getByRole('button', { name: 'View history' }).click();
  await expect(page.getByRole('heading', { name: 'Intake events' })).toBeVisible();
  await expect(page.getByText(/human attached the intake/i)).toBeVisible();

  await page.getByLabel('URL').fill('https://127.0.0.1/private');
  await page.getByRole('button', { name: 'Capture for review' }).click();
  await expect(page.getByText('Rejected Invalid').first()).toBeVisible();
  await expect(page.getByText(/failed local policy validation/i).first()).toBeVisible();
  await expectNoSeriousAccessibilityViolations(page);
});

test('primary navigation and skip link are keyboard reachable', async ({ page }) => {
  await page.goto('/decide');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#main-content')).toBeFocused();
  await page.getByRole('link', { name: 'Explore', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/explore$/);
});
