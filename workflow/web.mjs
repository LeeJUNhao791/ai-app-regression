import assert from 'node:assert/strict';
import { join } from 'node:path';
import { chromium } from 'playwright';

export async function checkWeb({ baseUrl, text, outputDir }) {
  const evidence = ['web.png'];
  const screenshot = { path: join(outputDir, evidence[0]), fullPage: true, timeout: 5_000 };
  let browser;
  let page;
  let failure = 'The work order URL is invalid.';

  try {
    const ticketsUrl = new URL('/api/tickets', baseUrl).href;
    failure = 'Chromium could not start. Run npx playwright install chromium --only-shell. ' +
      'On Linux, add --with-deps to install system dependencies.';
    browser = await chromium.launch();
    failure = 'The work order form could not load.';
    page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    page.setDefaultTimeout(8_000);
    const document = await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    assert.equal(document?.status(), 200);
    await page.getByRole('textbox', { name: 'Issue description' }).fill(text);

    failure = 'The form did not create and look up the submitted ticket.';
    const responseTimeout = { timeout: 40_000 };
    const [createdResponse, detailResponse] = await Promise.all([
      page.waitForResponse((response) => response.request().method() === 'POST' && response.url() === ticketsUrl, responseTimeout),
      page.waitForResponse((response) => response.request().method() === 'GET' && response.url().startsWith(`${ticketsUrl}/`), responseTimeout),
      page.getByRole('button', { name: 'Submit work order' }).click(),
    ]);
    assert.equal(createdResponse.status(), 201);
    assert.deepEqual(createdResponse.request().postDataJSON(), { text: text.trim() });
    const created = await createdResponse.json();
    assert.equal(detailResponse.status(), 200);
    assert.equal(detailResponse.url(), `${ticketsUrl}/${encodeURIComponent(created.id)}`);
    const ticket = await detailResponse.json();
    assert.deepEqual(ticket, created);

    failure = 'The ticket shown in the browser did not match the API response.';
    const result = page.getByRole('region', { name: 'Ticket result' });
    const fields = {
      'ticket-id': ticket.id,
      'ticket-device': ticket.result.device ?? 'Not identified',
      'ticket-category': ticket.result.category,
      'ticket-status': ticket.status,
    };
    for (const [name, value] of Object.entries(fields)) {
      const field = result.locator(`#${name}`);
      await field.waitFor({ state: 'visible' });
      assert.equal((await field.innerText()).trim(), value);
    }

    failure = 'The browser screenshot could not be saved.';
    await page.screenshot(screenshot);
    return { ticket, evidence };
  } catch {
    const error = new Error(failure);
    if (page && await page.screenshot(screenshot).catch(() => null)) error.evidence = evidence;
    throw error;
  } finally {
    await browser?.close().catch(() => {});
  }
}
