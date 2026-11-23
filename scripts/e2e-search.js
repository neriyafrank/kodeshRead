#!/usr/bin/env node
/**
 * End-to-end check of the Search screen in the web preview (Playwright).
 *
 *   npm run web                       # terminal 1 (Metro on :8081, sample DB)
 *   npm run e2e:search [-- --shots=DIR]   # terminal 2
 *
 * Covers Simple Search (literal, no expansion) and the dedicated Advanced Search screen
 * (fields, toggles, proximity, corpus chips, highlighted variants, back to Simple Search).
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

    // Quick open: abbreviation + daf/amud notation -> direct "פתח: ספר — מיקום" card.
    await tid('quick-jump-input').fill('ר"ה דף טז ע"ב');
    await tid('quick-jump-direct').waitFor({ timeout: 20000 });
    const direct = await tid('quick-jump-direct').innerText();
    assert.ok(direct.includes('פתח: ראש השנה') && direct.includes('טז:'), direct);
    await tid('quick-jump-input').fill("בר' יב א");
    await page.waitForFunction(() => (document.querySelector('[data-testid="quick-jump-direct"]') || {}).innerText?.includes('בראשית'), null, { timeout: 20000 });
    await shot('0-quick-open');
    await tid('quick-jump-input').fill('');
    step('quick open resolves abbreviations to a direct card');

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

    // Simple Search stays simple and literal: no mode switch, typed words only.
    assert.strictEqual(await tid('search-mode-smart').count(), 0, 'no expansion toggle on the simple screen');
    assert.strictEqual(await tid('open-advanced-search').innerText(), 'חיפוש מתקדם');
    // Results of the previous query stay on screen while a new one runs: wait for the new state.
    const hitTexts = () => page.evaluate(() => [...document.querySelectorAll('[data-testid="search-hit"]')].map((el) => el.textContent.replace(/[\u0591-\u05C7]/g, '').replace(/[^\u05D0-\u05EA]/g, '')));
    await tid('search-input').fill('שולחן');
    await tid('search-empty').waitFor({ timeout: 20000 }); // the sample spells it שלחן: no ktiv expansion
    await tid('search-input').fill('שבת');
    await page.waitForFunction(() => {
      const hits = [...document.querySelectorAll('[data-testid="search-hit"]')];
      return hits.length > 0 && hits.every((el) => el.textContent.replace(/[\u0591-\u05C7]/g, '').replace(/[^\u05D0-\u05EA]/g, '') === 'שבת');
    }, null, { timeout: 20000 });
    const countOf = async (id) => parseInt((await tid(id).innerText()).replace(/[^\d]/g, ' ').trim().split(' ')[0], 10);
    await tid('search-count').waitFor();
    await page.waitForFunction(() => /^\d+ תוצאות/.test((document.querySelector('[data-testid="search-count"]') || {}).textContent || ''), null, { timeout: 20000 });
    const simpleCount = await countOf('search-count');
    for (const t of await hitTexts()) assert.strictEqual(t, 'שבת', `literal hit: ${t}`);
    await shot('1b-simple-literal');
    step(`Simple Search is literal (שבת: ${simpleCount} exact hits, שולחן: none)`);

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
    // Every visible result belongs to the scope (waits out the previous query's results).
    const allResults = (src) =>
      page.waitForFunction(
        (re) => {
          const els = [...document.querySelectorAll('[data-testid="search-result"]')];
          return els.length > 0 && els.every((el) => new RegExp(re).test(el.innerText));
        },
        src,
        { timeout: 30000 },
      );
    await tid('scope-cat-1').click(); // תנך
    await allResults('^(בראשית|במדבר)');
    assert.ok((await tid('scope-button').innerText()).includes('תנך'));
    for (const t of await tid('search-result').allInnerTexts()) assert.ok(/^(בראשית|במדבר)/.test(t), t);
    step('folder scope');

    // Book scope through the sheet's filter.
    await tid('scope-button').click();
    await tid('scope-filter').fill('במדבר');
    await tid('scope-book-2').click();
    await allResults('^במדבר');
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
        .map((el) => el.textContent.replace(/[\u0591-\u05C7]/g, '').replace(/[^\u05D0-\u05EA]/g, '')),
    );
    assert.ok(marked.some((t) => t.includes('ויאמר')), `search hit marked in the reader: ${JSON.stringify(marked)}`);
    step('search hit is marked in the reader paragraph');

    // ---- Advanced Search ---------------------------------------------------------------
    const advTid = (id) => page.locator(`[data-testid="advanced-search"] [data-testid="${id}"]`);
    const advHitTexts = () =>
      page.evaluate(() => [...document.querySelectorAll('[data-testid="advanced-search"] [data-testid="search-hit"]')].map((el) => el.textContent.replace(/[\u0591-\u05C7]/g, '').replace(/[^\u05D0-\u05EA]/g, '')));
    await page.goto(BASE + '/search');
    await tid('search-input').waitFor({ timeout: 60000 });
    await tid('search-input').fill('שבת');
    await tid('open-advanced-search').click();
    await tid('advanced-search').waitFor({ timeout: 20000 });
    assert.ok(/\/advanced-search/.test(page.url()), page.url());
    const advBody = await page.locator('body').innerText();
    for (const label of ['חיפוש מתקדם', 'חזרה לחיפוש רגיל', 'מילות החיפוש / ביטוי', 'אחת מהמילים · או', 'ללא המילים · שלילה', 'אפשרויות לשוניות', 'קרבת מילים', 'סינון לפי מדור', 'חפש', 'נקה הכל']) assert.ok(advBody.includes(label), `advanced screen shows ${label}`);
    for (const id of ['adv-query', 'adv-any', 'adv-exclude', 'adv-submit', 'adv-reset', 'adv-back']) await tid(id).waitFor();
    assert.strictEqual(await tid('adv-query').inputValue(), 'שבת', 'the simple query is carried over');
    const checked = (id) => tid(id).getAttribute('aria-checked');
    const selected = (id) => tid(id).getAttribute('aria-selected');
    assert.deepStrictEqual(
      [await checked('adv-opt-prefixesAndSuffixes'), await checked('adv-opt-pleneDefective'), await checked('adv-opt-acronyms'), await checked('adv-opt-aramaicEquiv')],
      ['true', 'false', 'false', 'false'],
      'advanced defaults',
    );
    assert.strictEqual(await selected('adv-prox-paragraph'), 'true');
    assert.strictEqual(await tid('adv-ordered').count(), 0, 'order toggle only with קרבה');
    await tid('adv-prox-near').click();
    for (const d of [3, 5, 10]) await tid(`adv-dist-${d}`).waitFor();
    assert.strictEqual(await checked('adv-ordered'), 'false');
    await tid('adv-prox-paragraph').click();
    for (const id of ['all', 'book', 'tanach', 'mishna', 'bavli', 'rambam', 'shulchan-aruch', 'mefarshim']) await tid(`adv-corpus-${id}`).waitFor();
    assert.strictEqual(await checked('adv-corpus-all'), 'true');
    // RTL: labels and inputs are right-aligned.
    const align = await page.evaluate(() => getComputedStyle(document.querySelector('[data-testid="adv-query"]')).textAlign);
    assert.strictEqual(align, 'right');
    await shot('5-advanced-form');
    step('חיפוש מתקדם opens the dedicated screen with every field, toggle and default');

    // Prefixes & suffixes (default on): more hits than the literal search, exact hits first.
    await tid('adv-submit').click();
    await tid('adv-count').waitFor({ timeout: 30000 });
    await page.waitForFunction(() => /^\d+ תוצאות/.test((document.querySelector('[data-testid="adv-count"]') || {}).textContent || ''), null, { timeout: 30000 });
    const advCount = await countOf('adv-count');
    assert.ok(advCount > simpleCount, `advanced ${advCount} > simple ${simpleCount}`);
    // Exact matches first: every card before the divider contains the typed word itself.
    const cardHits = () =>
      page.evaluate(() =>
        [...document.querySelectorAll('[data-testid="advanced-search"] [data-testid="search-result"]')].map((card) => [...card.querySelectorAll('[data-testid="search-hit"]')].map((el) => el.textContent.replace(/[\u0591-\u05C7]/g, '').replace(/[^\u05D0-\u05EA]/g, ''))),
      );
    const firstCards = await cardHits();
    assert.ok(firstCards.length && firstCards.every((hits) => hits.includes('שבת')), `exact matches first: ${JSON.stringify(firstCards.slice(0, 5))}`);
    // Scroll to the expanded variants (ושבת, בשבת, שבתות ...).
    await page.mouse.move(200, 600);
    let varHits = [];
    for (let i = 0; i < 120 && !(await tid('adv-expanded-divider').count()); i++) {
      await page.mouse.wheel(0, 2500);
      await page.waitForTimeout(200);
    }
    assert.ok(await tid('adv-expanded-divider').count(), 'expanded variants follow the exact matches');
    for (let i = 0; i < 3; i++) await page.mouse.wheel(0, 600), await page.waitForTimeout(200);
    varHits = await advHitTexts();
    assert.ok(varHits.some((t) => /^[ובלכמשה]+שבת/.test(t) || /^שבת.+/.test(t)), `variants highlighted: ${varHits.slice(-8)}`);
    assert.ok(!varHits.some((t) => /^שבתאי/.test(t)), 'שבתאי is not a form of שבת');
    await shot('6-advanced-results');
    step(`prefixes & suffixes: ${advCount} hits (exact first, then highlighted variants)`);

    // Plene / defective spelling: שולחן finds the sample's שלחן.
    await tid('adv-edit').click();
    await tid('adv-query').fill('שולחן');
    await tid('adv-opt-pleneDefective').click();
    assert.strictEqual(await checked('adv-opt-pleneDefective'), 'true');
    await tid('adv-submit').click();
    await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="advanced-search"] [data-testid="search-hit"]')].some((el) => /שלחן/.test(el.textContent.replace(/[\u0591-\u05C7]/g, '').replace(/[^\u05D0-\u05EA]/g, ''))), null, { timeout: 30000 });
    step('כתיב מלא/חסר: שולחן -> שלחן');

    // Structured fields + corpus chip: אמר + (רבא) - חסדא, בבלי only.
    await tid('adv-edit').click();
    await tid('adv-reset').click();
    assert.strictEqual(await tid('adv-query').inputValue(), '');
    assert.strictEqual(await checked('adv-opt-pleneDefective'), 'false', 'נקה הכל restores the defaults');
    await tid('adv-query').fill('אמר');
    await tid('adv-any').fill('רבא');
    await tid('adv-exclude').fill('חסדא');
    await tid('adv-corpus-bavli').click();
    assert.strictEqual(await checked('adv-corpus-all'), 'false');
    await tid('adv-submit').click();
    await page.waitForFunction(
      () => {
        const els = [...document.querySelectorAll('[data-testid="advanced-search"] [data-testid="search-result"]')];
        return els.length > 0 && els.every((el) => /^(שבת|ראש השנה|תענית)/.test(el.innerText));
      },
      null,
      { timeout: 30000 },
    );
    for (const t of await advTid('search-result').allInnerTexts()) {
      assert.ok(/^(שבת|ראש השנה|תענית)/.test(t), `בבלי only: ${t.slice(0, 30)}`);
      assert.ok(!/חסדא/.test(t.replace(/[\u0591-\u05C7]/g, '')), 'excluded word');
    }
    assert.ok((await advHitTexts()).some((t) => /רבא/.test(t)), 'the "any of" word is highlighted');
    await shot('7-advanced-structured');
    step('structured fields (main + any of + exclude) + corpus chip');

    // Proximity: ordered NEAR never finds more than unordered NEAR.
    const runNear = async (ordered) => {
      await tid('adv-edit').click();
      await tid('adv-reset').click();
      await tid('adv-query').fill('רבא אמר');
      await tid('adv-prox-near').click();
      await tid('adv-dist-3').click();
      if (ordered) await tid('adv-ordered').click();
      assert.strictEqual(await checked('adv-ordered'), String(ordered));
      await tid('adv-submit').click();
      await page.waitForFunction(() => /^\d+ תוצאות/.test((document.querySelector('[data-testid="adv-count"]') || {}).textContent || ''), null, { timeout: 30000 });
      return countOf('adv-count');
    };
    const unordered = await runNear(false);
    const ordered = await runNear(true);
    assert.ok(ordered > 0 && ordered < unordered, `ordered ${ordered} < unordered ${unordered}`);
    step(`קרבה 3 מילים: unordered ${unordered}, ordered ${ordered}`);

    // A result opens the reader at its line with the hit marked.
    const advTarget = (await advTid('search-result').first().innerText()).split('\n')[0];
    await advTid('search-result').first().click();
    await page.waitForURL(/\/reader/);
    await page.waitForTimeout(800);
    assert.ok((await page.locator('body').innerText()).includes(advTarget.split('‹')[0].trim()));
    step('advanced result opens the reader');

    // Back to Simple Search.
    await page.goBack();
    await tid('advanced-search').waitFor({ timeout: 20000 });
    await tid('adv-back').click();
    await page.waitForURL(/\/search$/);
    await tid('search-input').waitFor();
    assert.strictEqual(await tid('search-input').inputValue(), 'שבת');
    assert.strictEqual(await tid('advanced-search').count(), 0);
    step('חזרה לחיפוש רגיל returns to the simple screen');

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
    assert.strictEqual(bg, 'rgb(42, 42, 42)', 'Dark charcoal surface (#2A2A2A)');
    await shot('4-dark');
    step('dark (charcoal) theme');

    const real = errors.filter((e) => !/Warning:|deprecated|DevTools/i.test(e));
    assert.deepStrictEqual(real, [], 'console errors');
    console.log('\ne2e search: all passed');
  } catch (e) {
    console.error('✗', e.message);
    if (SHOTS) await shot('fail').catch(() => undefined);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();
