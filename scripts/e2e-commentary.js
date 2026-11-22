#!/usr/bin/env node
/**
 * End-to-end check of the commentary drawer in the web preview (Playwright).
 *
 *   npm run web                                 # terminal 1 (Metro on :8081, sample DB)
 *   npm run e2e:commentary [-- --shots=DIR]     # terminal 2
 *
 * Opens שבת ב. via Quick Jump, checks the link-count badges, opens the drawer from a
 * paragraph, verifies grouping (רש"י / תוספות), the theme, resizing, prev/next sync,
 * and opening a commentary at its line in a tab.
 */
'use strict';

const assert = require('assert');

const BASE = process.env.E2E_URL || 'http://localhost:8081';
const shotsArg = process.argv.find((a) => a.startsWith('--shots='));
const SHOTS = shotsArg ? shotsArg.slice('--shots='.length) : null;

let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  console.error('playwright is not installed: npm i -D playwright (or run where it is available)');
  process.exit(2);
}

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 400, height: 820 }, hasTouch: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  const tid = (id) => page.locator(`[data-testid="${id}"]`);
  const shot = (name) => (SHOTS ? page.screenshot({ path: `${SHOTS}/${name}.png` }) : null);
  const step = (name) => console.log(`✓ ${name}`);

  try {
    await page.goto(BASE + '/', { timeout: 180000 });
    await page.evaluate(() => localStorage.clear());
    await page.goto(BASE + '/', { timeout: 180000 });
    const jump = page.locator('[data-testid="quick-jump-input"]');
    await jump.waitFor({ timeout: 180000 });
    await jump.fill('שבת ב.');
    await tid('quick-jump-result').first().click();
    await tid('para-3').waitFor({ timeout: 20000 });

    // Badges: line 3 (מתני' יציאות השבת) has 2x רש"י + תוספות; line 4 has none.
    assert.strictEqual((await tid('links-badge-3').innerText()).trim(), '3');
    assert.strictEqual(await tid('links-badge-4').count(), 0);
    await shot('1-badges');
    step('link-count badges');

    // A paragraph without links does not open the drawer.
    await tid('para-4').click();
    await page.waitForTimeout(200);
    assert.strictEqual(await tid('commentary-pane').count(), 0);

    await tid('para-3').click();
    await tid('commentary-group').first().waitFor({ timeout: 10000 });
    const names = await tid('commentary-group-name').allInnerTexts();
    assert.deepStrictEqual(names, ['רש"י', 'תוספות']);
    assert.strictEqual(await tid('commentary-entry').count(), 3);
    await shot('2-drawer');
    step('drawer groups by commentator');

    // Switching paragraph while open re-syncs the drawer (line 4: no commentaries).
    await tid('para-4').click();
    await page.getByText('אין מפרשים לפסקה זו').waitFor();
    await tid('para-5').click();
    await tid('commentary-group').first().waitFor();
    assert.deepStrictEqual(await tid('commentary-group-name').allInnerTexts(), ['רש"י', 'תוספות']);
    step('drawer follows the tapped paragraph');

    // Next paragraph with commentaries (line 7: רש"י only); the text scrolls with it.
    await tid('commentary-next').click();
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="commentary-entry"]').length === 1);
    assert.deepStrictEqual(await tid('commentary-group-name').allInnerTexts(), ['רש"י']);
    await page.waitForTimeout(300);
    await shot('2b-next');
    const row = await tid('para-7').boundingBox();
    const pane = await tid('commentary-pane').boundingBox();
    assert.ok(row && row.y > 60 && row.y < pane.y, `line 7 visible above the drawer (row ${row && row.y}, pane ${pane.y})`);
    step('next linked paragraph (text scrolls to it)');

    // Resize by dragging the grabber up with touch events (as on a phone).
    const before = (await tid('commentary-pane').boundingBox()).height;
    const g = await tid('commentary-grabber').boundingBox();
    const cdp = await ctx.newCDPSession(page);
    const gx = g.x + g.width / 2;
    const gy = g.y + g.height / 2;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: gx, y: gy }] });
    for (let i = 1; i <= 8; i++) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: gx, y: gy - 20 * i }] });
      await page.waitForTimeout(30);
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.waitForTimeout(300);
    const after = (await tid('commentary-pane').boundingBox()).height;
    assert.ok(after > before + 100, `drawer ${before} -> ${after}`);
    const y7 = (await tid('para-7').boundingBox())?.y;
    assert.ok(y7 > 60 && y7 < (await tid('commentary-pane').boundingBox()).y, `resizing must not scroll the text (line 7 at ${y7})`);
    step(`resizable (${Math.round(before)} -> ${Math.round(after)} px)`);

    // Theme: switch to OLED dark in the Aa sheet; the drawer follows.
    await tid('aa-button').click();
    await tid('theme-dark').click();
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
    if (await tid('appearance-sheet').count()) await page.mouse.click(200, 60);
    await page.waitForTimeout(400);
    const bg = await tid('commentary-pane').evaluate((el) => getComputedStyle(el).backgroundColor);
    assert.ok(/rgb\(14, 14, 14\)/.test(bg), `drawer background ${bg}`);
    await shot('3-dark');
    step('drawer uses the active theme');

    // Follow mode: scrolling the text moves the drawer to the paragraph at the reading line.
    const firstEntry = async () => (await tid('commentary-entry').first().innerText()).slice(0, 60);
    const beforeFollow = await firstEntry();
    await tid('commentary-follow').click();
    const list = await tid('reader-list').boundingBox();
    await page.mouse.move(list.x + 200, list.y + 150);
    await page.mouse.wheel(0, 900);
    await page.waitForFunction(
      (prev) => (document.querySelector('[data-testid="commentary-entry"]')?.innerText || '').slice(0, 60) !== prev,
      beforeFollow,
      { timeout: 5000 },
    );
    step(`follow mode re-syncs on scroll ("${(await firstEntry()).split('\n').pop().slice(0, 20)}…")`);
    await tid('commentary-follow').click();

    // Open the commentary at its line in a tab.
    await tid('commentary-open').first().click();
    await page.waitForFunction(() => document.querySelector('[data-testid="reader-breadcrumb"]')?.innerText.includes('רש"י על שבת'));
    await tid('links-badge-7').waitFor();
    await shot('4-opened');
    const tabs = await page.evaluate(() => JSON.parse(localStorage.getItem('kodeshread.tabs')).state.tabs.map((t) => t.bookTitle));
    assert.deepStrictEqual(tabs, ['שבת', 'רש"י על שבת']);
    step('commentary opens at its line in a new tab');

    const real = errors.filter((e) => !/favicon|DevTools|Download the React DevTools/.test(e));
    assert.deepStrictEqual(real, [], 'console errors');
    console.log('\nall commentary e2e checks passed');
  } catch (e) {
    await shot('failure');
    console.error('✗', e.message);
    if (errors.length) console.error('console errors:', errors.slice(0, 5));
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();
