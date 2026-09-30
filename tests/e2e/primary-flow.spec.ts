import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
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

async function captureIfRequested(page: Page, name: string): Promise<void> {
  const directory = process.env.MAESTRO_SCREENSHOT_DIR;
  if (!directory) return;
  await mkdir(directory, { recursive: true });
  const scrollPosition = await page.evaluate(() => ({ x: window.scrollX, y: window.scrollY }));
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: join(directory, name), fullPage: true });
  await page.evaluate(({ x, y }) => window.scrollTo(x, y), scrollPosition);
}

async function captureViewportIfRequested(page: Page, name: string): Promise<void> {
  const directory = process.env.MAESTRO_SCREENSHOT_DIR;
  if (!directory) return;
  await mkdir(directory, { recursive: true });
  await page.screenshot({ path: join(directory, name), fullPage: false });
}

function observeRuntime(page: Page): () => void {
  const runtimeFailures: string[] = [];
  const unexpectedEgress: string[] = [];
  page.on('pageerror', (error) => runtimeFailures.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') runtimeFailures.push(`console: ${message.text()}`);
  });
  page.on('response', (response) => {
    if (response.status() >= 500) {
      runtimeFailures.push(`response: ${response.status()} ${response.url()}`);
    }
  });
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (
      ['http:', 'https:'].includes(url.protocol) &&
      !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    ) {
      unexpectedEgress.push(request.url());
    }
  });
  return () => {
    expect(runtimeFailures).toEqual([]);
    expect(unexpectedEgress).toEqual([]);
  };
}

function syntheticGraphFixture(totalNodes: number, totalEdges: number) {
  const groupCount = 10;
  const providerCount = totalNodes - groupCount;
  const groups = Array.from({ length: groupCount }, (_, index) => ({
    id: `synthetic-group-${index}`,
    type: 'capability_group' as const,
    label: `Capability group ${index + 1}`,
    group: `Capability group ${index + 1}`,
    displayState: 'group',
  }));
  const providers = Array.from({ length: providerCount }, (_, index) => ({
    id: `synthetic-provider-${index}`,
    resultItemId: `synthetic-item-${index}`,
    providerId: `synthetic-provider-${index}`,
    type: 'provider' as const,
    label: `Synthetic option ${String(index + 1).padStart(3, '0')}`,
    kind: 'synthetic_fixture',
    group: groups[index % groupCount]!.group,
    signalDisplay: 35 + (index % 40),
    displayState: index % 4 === 0 ? 'provisional' : 'available',
  }));
  const membershipEdges = providers.map((provider, index) => ({
    id: `synthetic-provides-${index}`,
    source: provider.id,
    target: groups[index % groupCount]!.id,
    type: 'provides',
    scope: 'synthetic graph performance fixture',
    status: index % 4 === 0 ? 'provisional' : 'source_supported',
  }));
  const relationEdges = Array.from(
    { length: Math.max(0, totalEdges - membershipEdges.length) },
    (_, index) => ({
      id: `synthetic-related-${index}`,
      source: providers[index % providerCount]!.id,
      target: providers[(index * 7 + 13) % providerCount]!.id,
      type: 'related',
      scope: 'synthetic graph performance fixture',
      status: 'provisional',
    }),
  );
  return {
    resultSetId: `synthetic-${totalNodes}-${totalEdges}`,
    resultSetRevision: 1,
    filteredCount: providerCount,
    visibleCount: providerCount,
    hiddenCount: 0,
    nodes: [...groups, ...providers],
    edges: [...membershipEdges, ...relationEdges],
    accessibleItems: providers.map((provider) => ({
      id: provider.resultItemId,
      name: provider.label,
      kind: provider.kind,
      group: provider.group,
      explanation: 'Synthetic performance fixture; not catalog knowledge.',
      relation: {
        type: 'provides',
        scope: 'synthetic graph performance fixture',
        status: provider.displayState === 'provisional' ? 'provisional' : 'source_supported',
      },
    })),
  };
}

test('primary evidence-to-decision path is inspectable and replayable', async ({ page }) => {
  const assertRuntime = observeRuntime(page);
  const needTitle = `E2E context decision ${crypto.randomUUID()}`;
  await page.goto('/decide');
  await expect(
    page.getByRole('heading', { level: 1, name: 'What are you deciding?' }),
  ).toBeVisible();
  await expect(
    page.getByText('No model key required').or(page.getByText('Local-first')),
  ).toBeVisible();
  await expectNoSeriousAccessibilityViolations(page);

  await page.getByRole('button', { name: 'New decision' }).click();
  await page.getByLabel('Project').selectOption({ label: 'Local AI-assisted development' });
  await page.getByLabel('Decision title').fill(needTitle);
  await page.getByLabel('Desired outcome').fill('Compare context-reduction options safely.');
  await page.getByLabel(/Success criteria/).fill('A reversible bounded trial');
  await page.getByLabel(/Hard constraints/).fill('Source code stays within the declared boundary');
  await page.getByRole('button', { name: 'Create need and compare' }).click();
  await expect(page.getByRole('heading', { level: 1, name: needTitle })).toBeVisible();

  for (const candidate of ['Context Mode', 'GitHub Agentic Workflows']) {
    await page.getByRole('button', { name: 'Add candidate' }).click();
    await page.getByLabel('Candidate option kind').selectOption('provider');
    const candidateSelect = page.locator('select[name="providerId"]');
    const option = candidateSelect.locator('option', { hasText: candidate });
    await candidateSelect.selectOption((await option.getAttribute('value')) ?? '');
    await page.getByRole('button', { name: 'Add and assess' }).click();
    await expect(page.getByRole('button', { name: 'Add candidate' })).toBeVisible();
  }
  await page.getByRole('button', { name: 'Add candidate' }).click();
  await page.getByLabel('Candidate option kind').selectOption('status_quo');
  await page.getByRole('button', { name: 'Add and assess' }).click();

  await page.getByRole('button', { name: 'Add candidate' }).click();
  await page.getByLabel('Candidate option kind').selectOption('build');
  await page.getByLabel('Option label').fill('Build a repository-native adapter');
  await page.getByRole('button', { name: 'Add and assess' }).click();
  await expect(page.getByText('Build a repository-native adapter', { exact: true })).toBeVisible();

  await expect(
    page.getByRole('heading', { level: 2, name: 'Gates first, preference fit second' }),
  ).toBeVisible();
  await expect(page.getByText('Unknown Blocked').first()).toBeVisible();
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
  assertRuntime();
});

test('query-first explorer keeps list, map, detail, comparison, and save on one snapshot', async ({
  page,
}) => {
  const assertRuntime = observeRuntime(page);
  const privateQuery = 'ai context reduction github';
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await expect(
    page.getByRole('heading', { level: 1, name: 'Find existing tools for what you need' }),
  ).toBeVisible();
  await captureIfRequested(page, 'explorer-1440-start.png');
  await page.getByLabel('Capability question').fill(privateQuery);
  await page.getByRole('button', { name: 'Search' }).click();
  const queryDetails = page.getByText('Search interpretation and query details');
  await expect(queryDetails).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Results', exact: true })).toBeVisible();
  expect(page.url()).toContain('resultSet=');
  expect(page.url()).not.toContain('context');
  await expect(page.locator('.result-row').first().locator('.query-signal')).toBeInViewport();
  await captureViewportIfRequested(page, 'explorer-1440-first-result-viewport.png');
  await page.setViewportSize({ width: 390, height: 844 });
  const topResultGlance = page.getByRole('button', { name: /Top result.*Signal/i });
  await expect(topResultGlance).toBeInViewport();
  await captureViewportIfRequested(page, 'explorer-390-first-result-viewport.png');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await queryDetails.click();
  await expect(page.getByText('intrinsic-signal-v3')).toBeVisible();
  await expect(page.getByText('Context Mode', { exact: true }).first()).toBeVisible();
  await expectNoSeriousAccessibilityViolations(page);
  await captureIfRequested(page, 'explorer-1440-list.png');

  const firstInspect = page.getByRole('button', { name: 'Inspect' }).first();
  await firstInspect.click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Close detail' })).toBeFocused();
  await expect(page.getByRole('heading', { name: 'Signal calculation' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Sources and evidence' })).toBeVisible();
  await captureIfRequested(page, 'explorer-1440-detail.png');
  await page.keyboard.press('Escape');
  await expect(firstInspect).toBeFocused();

  const compare = page.getByRole('checkbox', { name: 'Compare' });
  await compare.nth(0).check();
  await compare.nth(1).check();
  await page.getByRole('button', { name: 'Compare 2–5' }).click();
  await expect(page.getByRole('heading', { name: 'Compare results' })).toBeVisible();
  await expect(page.getByText(/grants no install or execution authority/i)).toBeVisible();

  const shortlistProject = page
    .getByLabel('Shortlist project')
    .locator('option', { hasText: 'Local AI-assisted development' });
  await page
    .getByLabel('Shortlist project')
    .selectOption((await shortlistProject.getAttribute('value')) ?? '');
  await page.getByLabel('Shortlist name').fill('E2E explorer shortlist');
  await page.getByRole('button', { name: 'Save to project' }).click();
  await expect(page.getByText(/Saved 2 items to the project shortlist/)).toBeVisible();

  await page.getByRole('button', { name: 'Map' }).click();
  await expect(page.getByRole('heading', { name: 'Equivalent map navigation' })).toBeVisible();
  await expect(page.locator('.explorer-map-shell')).toHaveAttribute('data-render-state', 'ready');
  await expect(page.getByText(/hidden by the bounded neighborhood/)).toBeVisible();
  const browseMapItems = page.getByRole('button', { name: /Browse \d+ items/ });
  await expect(browseMapItems).toBeVisible();
  await browseMapItems.click();
  await expect(page.getByText(/query-result capability grouping/).first()).toBeVisible();
  await page.getByRole('button', { name: 'Hide item list' }).click();
  await captureIfRequested(page, 'explorer-1440-map.png');

  await page.setViewportSize({ width: 1024, height: 900 });
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
    .toBe(true);
  await captureIfRequested(page, 'explorer-1024-map.png');
  await page.getByRole('button', { name: 'Close' }).click();
  await page.getByRole('button', { name: 'List' }).click();
  await compare.nth(0).uncheck();
  await compare.nth(1).uncheck();

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('heading', { name: 'Results', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.body.scrollWidth <= window.innerWidth)).toBe(true);
  await captureIfRequested(page, 'explorer-390-list.png');

  await page.setViewportSize({ width: 320, height: 700 });
  await page.evaluate(() => {
    document.documentElement.style.zoom = '2';
  });
  await expect(page.getByLabel('Capability question')).toBeVisible();
  expect(
    await page.evaluate(() => document.body.scrollWidth <= document.documentElement.clientWidth),
  ).toBe(true);
  await captureIfRequested(page, 'explorer-320-zoom-200.png');
  await page.evaluate(() => {
    document.documentElement.style.zoom = '1';
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  const resultSetBeforeRefresh = new URL(page.url()).searchParams.get('resultSet');
  await page.getByRole('button', { name: 'Refresh local results' }).click();
  await expect(page.getByText(/local index is unchanged/i)).toBeVisible();
  expect(new URL(page.url()).searchParams.get('resultSet')).toBe(resultSetBeforeRefresh);
  await page.getByRole('button', { name: 'Load 10 more' }).click();
  await expect(page.getByText(/Showing 20 of \d+ filtered results/)).toBeVisible();
  assertRuntime();
});

test('G6 map stays bounded and interactive at declared synthetic sizes', async ({ page }) => {
  const assertRuntime = observeRuntime(page);
  let fixture = syntheticGraphFixture(150, 420);
  await page.route('**/api/v1/explorer/result-sets/*/graph?*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(fixture),
    });
  });
  const measurements: Array<{
    fixture: string;
    nodes: number;
    edges: number;
    readyMs: number;
    maxInteractionLongTaskMs: number;
    interactionLongTasksOver200Ms: number;
    usedJsHeapBytes: number | null;
  }> = [];

  for (const shape of [
    { nodes: 150, edges: 420 },
    { nodes: 500, edges: 1_500 },
  ]) {
    fixture = syntheticGraphFixture(shape.nodes, shape.edges);
    await page.goto('/');
    await page.getByLabel('Capability question').fill('ai context reduction');
    await page.getByRole('button', { name: 'Search' }).click();
    await page.evaluate(() => {
      const measuredWindow = window as typeof window & { __maestroLongTasks?: number[] };
      measuredWindow.__maestroLongTasks = [];
      if ('PerformanceObserver' in window) {
        const observer = new PerformanceObserver((list) => {
          measuredWindow.__maestroLongTasks!.push(
            ...list.getEntries().map((entry) => entry.duration),
          );
        });
        observer.observe({ entryTypes: ['longtask'] });
      }
    });
    const startedAt = Date.now();
    await page.getByRole('button', { name: 'Map' }).click();
    const shell = page.locator('.explorer-map-shell');
    await expect(shell).toHaveAttribute('data-render-state', 'ready', { timeout: 8_000 });
    const readyMs = Date.now() - startedAt;
    await page.evaluate(() => {
      const measuredWindow = window as typeof window & { __maestroLongTasks?: number[] };
      measuredWindow.__maestroLongTasks = [];
    });
    await page.getByRole('button', { name: 'Zoom map in' }).click();
    await page.getByRole('button', { name: 'Zoom map out' }).click();
    await page.getByRole('button', { name: 'Fit' }).click();
    const canvas = page.locator('.map-canvas canvas').first();
    const bounds = await canvas.boundingBox();
    if (bounds) {
      await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
      await page.mouse.down();
      await page.mouse.move(bounds.x + bounds.width / 2 + 40, bounds.y + bounds.height / 2 + 30);
      await page.mouse.up();
    }
    await page.waitForTimeout(800);
    const runtime = await page.evaluate(() => {
      const measuredWindow = window as typeof window & {
        __maestroLongTasks?: number[];
        performance: Performance & { memory?: { usedJSHeapSize: number } };
      };
      const tasks = measuredWindow.__maestroLongTasks ?? [];
      return {
        maxInteractionLongTaskMs: tasks.length ? Math.max(...tasks) : 0,
        interactionLongTasksOver200Ms: tasks.filter((duration) => duration > 200).length,
        usedJsHeapBytes: measuredWindow.performance.memory?.usedJSHeapSize ?? null,
      };
    });
    measurements.push({
      fixture: shape.nodes === 500 ? 'synthetic-stress' : 'synthetic-medium',
      nodes: fixture.nodes.length,
      edges: fixture.edges.length,
      readyMs,
      ...runtime,
    });
    await captureIfRequested(page, `graph-synthetic-${shape.nodes}.png`);
    expect(readyMs).toBeLessThanOrEqual(2_000);
    expect(runtime.interactionLongTasksOver200Ms).toBe(0);
  }

  const reportPath = process.env.MAESTRO_GRAPH_REPORT_PATH;
  if (reportPath) {
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(
      reportPath,
      `${JSON.stringify(
        {
          benchmarkId: 'phase06-g6-bounded-map-v1',
          executedAt: new Date().toISOString(),
          browser: 'Playwright Chromium',
          statement: 'Synthetic fixtures measure renderer mechanics, not knowledge quality.',
          measurements,
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
  }
  assertRuntime();
});

test('corpus separates saved leads from indexed knowledge and scores an explicit search', async ({
  page,
}) => {
  const assertRuntime = observeRuntime(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/corpus');
  await expect(
    page.getByRole('heading', { name: 'Browse saved technology research' }),
  ).toBeVisible();
  await expect(page.getByText(/saved lead is not reviewed knowledge/i)).toBeVisible();
  await page.getByLabel('Search the corpus').fill('context reduction for coding agents');
  await page.getByRole('button', { name: 'Search corpus' }).click();
  expect(page.url()).not.toContain('context');
  await expect(page.getByText('Query-scored records')).toBeVisible();
  await expect(page.getByText(/^Signal \d+$/).first()).toBeVisible();
  await expect(page.getByText(/Every displayed match has a numeric estimate/i)).toBeVisible();
  await expectNoSeriousAccessibilityViolations(page);
  await captureIfRequested(page, 'corpus-1440-search.png');

  await page.getByLabel('Layer').selectOption('indexed_knowledge');
  await expect(
    page.locator('.corpus-row').first().getByText('Implementation', { exact: true }),
  ).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.body.scrollWidth <= window.innerWidth)).toBe(true);
  await captureIfRequested(page, 'corpus-390-search.png');
  assertRuntime();
});

test('generic browser authoring creates an attributed Corpus record without execution authority', async ({
  page,
}) => {
  const assertRuntime = observeRuntime(page);
  const suffix = crypto.randomUUID();
  const name = `Browser-authored option ${suffix}`;
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/workspace');
  await page.getByRole('button', { name: 'Add knowledge' }).click();
  await page.getByLabel('Name', { exact: true }).fill(name);
  await page.getByLabel('Kind').selectOption('oss_project');
  await page
    .getByLabel('Public canonical URL')
    .fill(`https://github.com/maestro-e2e/browser-authored-${suffix}`);
  await page
    .getByLabel('Description')
    .fill('A bounded browser-authored fixture with source attribution and no execution authority.');
  await page.getByLabel('Source title').fill('Browser authoring fixture repository');
  await page.getByLabel('Source owner').fill('Maestro E2E fixture');
  await page.getByLabel('Capability key').fill(`browser-authoring-${suffix}`);
  await page.getByLabel('Capability name').fill('Browser knowledge authoring');
  await page.getByLabel('Search terms').fill('browser authoring\nattributed source');
  await page
    .getByLabel('Limitations')
    .fill('Fixture metadata is not independent evidence of usefulness.');
  await page.getByRole('button', { name: 'Add source-backed option' }).click();
  await expect(page.getByText(`${name} was added as Proposed public knowledge.`)).toBeVisible();
  await expectNoSeriousAccessibilityViolations(page);

  await page.getByRole('link', { name: 'Corpus', exact: true }).click();
  await page.getByLabel('Search the corpus').fill(name);
  await page.getByRole('button', { name: 'Search corpus' }).click();
  const row = page.locator('.corpus-row').filter({ hasText: name }).first();
  await expect(row).toBeVisible();
  await expect(row.getByText('Proposed', { exact: true })).toBeVisible();
  await expect(row.getByText(/Human Supplied Documentation/)).toBeVisible();
  await expect(page.getByText(/saved lead is not reviewed knowledge/i)).toBeVisible();
  assertRuntime();
});

test('connected source results remain visibly preliminary and source-linked', async ({ page }) => {
  const assertRuntime = observeRuntime(page);
  const operationId = '11111111-1111-4111-8111-111111111111';
  await page.route('**/api/v1/integrations', async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { items: Array<Record<string, unknown>> };
    body.items = body.items.map((item) =>
      item.adapterKey === 'github' ? { ...item, enabled: true } : item,
    );
    await route.fulfill({ response, json: body });
  });
  await page.route('**/api/v1/explorer/sessions', async (route) => {
    if (route.request().method() !== 'POST') {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    const body = (await response.json()) as Record<string, unknown>;
    await route.fulfill({
      response,
      json: {
        ...body,
        externalDiscovery: { attempted: true, state: 'queued' },
        discoveryOperations: [{ id: operationId, adapterKey: 'github', state: 'queued' }],
      },
    });
  });
  await page.route(/\/api\/v1\/explorer\/result-sets\/[^/?]+\?/, async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as Record<string, unknown>;
    await route.fulfill({
      response,
      json: {
        ...body,
        discoveryOperations: [{ id: operationId, adapterKey: 'github', state: 'queued' }],
      },
    });
  });
  await page.route('**/api/v1/discovery/operations/*', async (route) => {
    const requestedOperationId = new URL(route.request().url()).pathname.split('/').at(-1)!;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        id: requestedOperationId,
        adapterKey: 'github',
        state: 'complete',
        safeDetail: 'Controlled browser fixture; no external source was called.',
        candidates: [
          {
            id: '22222222-2222-4222-8222-222222222222',
            adapterKey: 'github',
            canonicalUri: 'https://github.com/example/context-tool',
            title: 'example/context-tool',
            summary: 'A controlled source-result fixture for the visible search path.',
            kindHint: 'oss_project',
            reviewState: 'lead',
            matchedTerms: ['context', 'tool'],
            relevanceOrdinal: 'direct',
            signalDisplay: 34,
            evidenceCoverage: 0.15,
            displayState: 'provisional',
            signalExplanation: 'Controlled fixture estimate.',
          },
        ],
      }),
    });
  });

  await page.goto('/');
  await page.getByLabel('Capability question').fill('context tool');
  await page.getByRole('button', { name: 'Search' }).click();
  const sourceResults = page.locator('details.source-results');
  await expect(sourceResults.getByText('Source plan and live leads')).toBeVisible();
  await sourceResults.locator('summary').click();
  await expect(page.getByText('example/context-tool')).toBeVisible();
  await expect(page.getByText('Signal 34', { exact: true })).toBeVisible();
  await expect(page.getByText('Preliminary', { exact: true }).last()).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open source' })).toHaveAttribute(
    'href',
    'https://github.com/example/context-tool',
  );
  await expectNoSeriousAccessibilityViolations(page);
  await captureIfRequested(page, 'explorer-1440-controlled-source.png');
  assertRuntime();
});

test('source search is explicit and local semantic assistance stays separate', async ({ page }) => {
  const assertRuntime = observeRuntime(page);
  await page.goto('/workspace#integrations');
  await expect(page.getByRole('heading', { name: 'Sources and local assistance' })).toBeVisible();
  const semanticCard = page.locator('.integration-card').filter({ hasText: 'Local Semantic' });
  await expect(semanticCard.getByText('Disabled', { exact: true })).toBeVisible();
  await semanticCard.getByLabel('Loopback endpoint').fill('http://127.0.0.1:11434/v1');
  await semanticCard.getByLabel('Model identifier').fill('e2e-fixture-model');
  await semanticCard.getByRole('button', { name: 'Save and enable' }).click();
  await expect(
    page.getByText(
      'Integration configuration saved. Enabled source adapters run with the next search.',
    ),
  ).toBeVisible();
  await expect(semanticCard.getByText('Enabled', { exact: true })).toBeVisible();
  await expectNoSeriousAccessibilityViolations(page);
  await captureIfRequested(page, 'workspace-1440-integrations.png');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.body.scrollWidth <= window.innerWidth)).toBe(true);
  await captureIfRequested(page, 'workspace-390-integrations.png');
  await page.setViewportSize({ width: 1440, height: 1000 });

  await page.getByRole('link', { name: 'Search', exact: true }).click();
  await page.getByLabel('Capability question').fill('context compression');
  await page.getByRole('button', { name: 'Search' }).click();
  await expect(page.getByRole('heading', { name: 'Results', exact: true })).toBeVisible();
  await expect(page.getByText(/no connected source request was queued/i)).toBeVisible();
  await captureIfRequested(page, 'explorer-1440-optional-integrations.png');

  await page.getByRole('link', { name: 'Workspace', exact: true }).click();
  await semanticCard.getByRole('button', { name: 'Disable' }).click();
  await expect(semanticCard.getByText('Disabled', { exact: true })).toBeVisible();
  assertRuntime();
});

test('Consider URL shows new, duplicate, manual-review, and safe-invalid states', async ({
  page,
}) => {
  const assertRuntime = observeRuntime(page);
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
  assertRuntime();
});

test('primary navigation and skip link are keyboard reachable', async ({ page }) => {
  const assertRuntime = observeRuntime(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/decide');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#main-content')).toBeFocused();
  await page.getByRole('link', { name: 'Search', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/explore$/);
  expect(
    await page.evaluate(() => getComputedStyle(document.documentElement).scrollBehavior),
  ).not.toBe('smooth');
  assertRuntime();
});
