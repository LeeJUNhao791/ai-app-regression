import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';

function loadWebMap(path) {
  let map;
  try {
    map = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(path)));
  } catch {
    throw new Error(`Web map "${path}": expected a readable UTF-8 JSON file.`);
  }
  for (const key of ['input_selector', 'submit_selector', 'ticket_id_selector']) {
    if (typeof map?.[key] !== 'string' || !map[key].trim()) {
      throw new Error(`Web map "${path}", field ${key}: expected a non-empty CSS selector.`);
    }
  }
  return map;
}

export async function checkExternalWeb({ pageUrl, mapPath, client, text, outputDir }) {
  const url = new URL(pageUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('--web-url must be an HTTP(S) page URL without embedded credentials.');
  }
  const map = loadWebMap(mapPath);
  const evidence = ['web.png'];
  const screenshot = { path: join(outputDir, evidence[0]), fullPage: true, timeout: 5_000 };
  let browser;
  let page;
  let failure = 'Chromium could not start. Run npx playwright install chromium --only-shell.';
  try {
    browser = await chromium.launch();
    failure = 'The external Web page could not load.';
    page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    page.setDefaultTimeout(8_000);
    assert.ok((await page.goto(url.href, { waitUntil: 'domcontentloaded' }))?.ok());
    failure = 'The external Web input could not be filled. Check input_selector.';
    await page.locator(map.input_selector).fill(text);
    failure = 'The external Web form did not send a successful POST to the mapped create endpoint. Check submit_selector and create_path.';
    const [response] = await Promise.all([
      page.waitForResponse((candidate) => candidate.url() === client.createUrl &&
        candidate.request().method() === 'POST', { timeout: 40_000 }),
      page.locator(map.submit_selector).click(),
    ]);
    assert.ok([200, 201].includes(response.status()));
    failure = 'The external Web POST did not send the fixture text in the mapped request field.';
    assert.equal(response.request().postDataJSON()?.[client.requestTextField], text);
    failure = 'The external Web POST response did not match the backend field map.';
    const ticket = client.decodeTicket(await response.json());
    failure = 'The displayed work-order ID did not match the create response. Check ticket_id_selector.';
    await page.waitForFunction(({ selector, id }) => document.querySelector(selector)?.innerText?.trim() === id,
      { selector: map.ticket_id_selector, id: ticket.id }, { timeout: 8_000 });
    await page.locator(map.ticket_id_selector).waitFor({ state: 'visible' });
    assert.equal((await page.locator(map.ticket_id_selector).innerText()).trim(), ticket.id);
    failure = 'The external Web screenshot could not be saved.';
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
