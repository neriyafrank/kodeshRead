#!/usr/bin/env node
/**
 * End-to-end check of the Search screen in the web preview (Playwright).
 *
 *   npm run web                       # terminal 1 (Metro on :8081, sample DB)
 *   npm run e2e:search [-- --shots=DIR]   # terminal 2
 *
 * Requires the `playwright` package with a Chromium build (not a project
 * dependency). The web preview's SQLite has no FTS5, so it exercises the
 * LIKE fallback; FTS5 itself is covered against the sample DB by `npm test`.
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
  const page = await browser.newPage({ viewport: { width: 400, height: 820 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  const tid = (id) => page.locator(`[data-testid="${id}"]`);
  const shot = (name) => (SHOTS ? page.screenshot({ path: `${SHOTS}/${name}.png` }) : null);
  const firstLine = async () => (await tid('search-result').first().innerText()).split('\n')[0];
  const step = (name) => console.log(`✓ ${name}`);

  try {
    await page.goto(BASE + '/', { timeout: 180000 });
    await page.evaluate(() => localStorage.clear());
    await page.goto(BASE + '/', { timeout: 180000 });
    await tid('open-search').waitFor({ timeout: 180000 });
    await tid('open-search').click();
    await tid('search-input').waitFor();
    assert.strictEqual(await page.evaluate(() => document.documentElement.dir), 'rtl');

    // Exact phrase (quotes in the UI) + KWIC highlight.
    await tid('search-input').fill('"שני כחות" באדם');
    await tid('search-result').first().waitFor({ timeout: 20000 });
    assert.ok((await firstLine()).startsWith('שבת'), await firstLine());
    const hits = await tid('search-result').first().locator('[data-testid="search-hit"]').count();
    assert.ok(hits >= 3, `expected highlighted words, got ${hits}`);
    await shot('1-phrase');
    step('phrase search + KWIC highlight');

    // Punctuation never breaks the query.
    await tid('search-input').fill('(*)-:^ "\'');
    await page.waitForTimeout(600);
    assert.strictEqual(await tid('search-result').count(), 0);
    await tid('search-input').fill('אמר: (רב) -חסדא*');
    await tid('search-result').first().waitFor({ timeout: 20000 });
    step('FTS syntax characters are sanitized');

    // Folder scope.
    await tid('search-input').fill('ויאמר');
    await tid('search-result').first().waitFor();
    await tid('scope-button').click();
    await tid('scope-sheet').waitFor();
    await tid('scope-all').waitFor();
    await shot('2-scope-sheet');
    await tid('scope-cat-1').click(); // תנך
    await page.waitForTimeout(900);
    assert.ok((await tid('scope-button').innerText()).includes('תנך'));
    for (const t of await tid('search-result').allInnerTexts()) assert.ok(/^(בראשית|במדבר)/.test(t), t);
    step('folder scope');

    // Book scope through the sheet's filter.
    await tid('scope-button').click();
    await tid('scope-filter').fill('במדבר');
    await tid('scope-book-2').click();
    await page.waitForTimeout(900);
    for (const t of await tid('search-result').allInnerTexts()) assert.ok(t.startsWith('במדבר'), t);
    step('book scope');

    // Tap -> reader tab at that line, highlighted.
    const target = await firstLine();
    await tid('search-result').first().click();
    await page.waitForURL(/\/reader/);
    await page.waitForTimeout(800);
    const crumb = target.split('‹')[1].trim();
    const body = await page.locator('body').innerText();
    assert.ok(body.includes('במדבר') && body.includes(crumb), `reader should show במדבר › ${crumb}`);
    await shot('3-reader');
    step('result opens the book at the line');

    // The matched word is marked inside the target paragraph while it is highlighted.
    const marked = await page.evaluate(() =>
      [...document.querySelectorAll('[data-testid^="para-"] span, [data-testid^="para-"] div')]
        .filter((el) => el.children.length === 0 && getComputedStyle(el).backgroundColor.startsWith('rgba') && !getComputedStyle(el).backgroundColor.endsWith(', 0)'))
        .map((el) => el.textContent.replace(/[\u0591-\u05C7]/g, '')),
    );
    assert.ok(marked.some((t) => t.includes('ויאמר')), `search hit marked in the reader: ${JSON.stringify(marked)}`);
    step('search hit is marked in the reader paragraph');

    // Dark theme is applied to the search screen.
    await page.evaluate(() => {
      const k = 'kodeshread.appearance';
      const v = JSON.parse(localStorage.getItem(k) || '{"state":{},"version":1}');
      v.state.theme = 'dark';
      localStorage.setItem(k, JSON.stringify(v));
    });
    await page.goto(BASE + '/search');
    await tid('search-result').first().waitFor({ timeout: 60000 });
    const bg = await page.evaluate(() => getComputedStyle(document.querySelector('[data-testid="search-result"]')).backgroundColor);
    assert.strictEqual(bg, 'rgb(14, 14, 14)');
    await shot('4-dark');
    step('OLED dark theme');

    const real = errors.filter((e) => !/Warning:|deprecated|DevTools/i.test(e));
    assert.deepStrictEqual(real, [], 'console errors');
    console.log('\ne2e search: all passed');
  } catch (e) {
    console.error('✗', e.message);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();
