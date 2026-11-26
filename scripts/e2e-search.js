#!/usr/bin/env node
/**
 * End-to-end check of the Search screen in the web preview (Playwright).
 *
 *   npm run web                       # terminal 1 (Metro on :8081, sample DB)
 *   npm run e2e:search [-- --shots=DIR]   # terminal 2
 *
 * Covers Simple Search (literal, no expansion), the sleek compact "חיפוש מתקדם" button, the
 * multi-select Scope Picker (canonical catalog: ספרי בסיס / פרשנים לפי ספר, books + commentaries,
 * בחר הכל, כל הפרשנים על …, removable chips) and the dedicated Advanced Search screen
 * (fields, toggles, proximity, corpus chips, picked books, highlighted variants, back to Simple Search).
 * Progressive results (first batch at once, the rest streamed behind a subtle indicator, stable layout) and the
 * results jump / filter bar (broad categories with live counts, filter, הכל, reset on a new search), in Simple and
 * Advanced Search.
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
    {
      // Sleek, slim ghost button: small tune icon, compact text, the search input keeps its width.
      const btn = await tid('open-advanced-search').boundingBox();
      const input = await tid('search-input').boundingBox();
      const css = await tid('open-advanced-search').evaluate((el) => {
        const t = getComputedStyle(el);
        const label = getComputedStyle([...el.querySelectorAll('div')].find((d) => d.innerText === 'חיפוש מתקדם'));
        return { border: t.borderTopWidth, bg: t.backgroundColor, fontSize: label.fontSize, padX: parseFloat(t.paddingLeft) };
      });
      assert.ok(btn.width <= 112, `compact width (${btn.width}px)`);
      assert.ok(btn.height >= 44 && btn.height <= 56, `same height as the search bar (${btn.height}px)`);
      assert.deepStrictEqual([css.border, css.bg, css.fontSize], ['1px', 'rgba(0, 0, 0, 0)', '12px'], 'ghost outline, 12px text');
      assert.ok(css.padX <= 8, `tight padding (${css.padX}px)`);
      assert.ok(input.width >= 165, `input keeps generous width on a 400px phone (${input.width}px)`);
      assert.ok(input.x >= btn.x + btn.width - 1 && input.x + input.width <= 400, `the input never runs under the button (${input.x} vs ${btn.x + btn.width})`);
      await shot('1c-advanced-button');
    }
    step('חיפוש מתקדם is a sleek compact ghost button next to a wide search input');
    // Results of the previous query stay on screen while a new one runs: wait for the new state.
    const hitTexts = () => page.evaluate(() => [...document.querySelectorAll('[data-testid="search-hit"]')].map((el) => el.textContent.replace(/[\u0591-\u05C7]/g, '').replace(/[^\u05D0-\u05EA]/g, '')));
    await tid('search-input').fill('שולחן');
    await tid('search-empty').waitFor({ timeout: 20000 }); // the sample spells it שלחן: no ktiv expansion
    await tid('search-input').fill('שבת');
    await page.waitForFunction(() => {
      const hits = [...document.querySelectorAll('[data-testid="search-hit"]')];
      return hits.length > 0 && hits.every((el) => el.textContent.replace(/[\u0591-\u05C7]/g, '').replace(/[^\u05D0-\u05EA]/g, '') === 'שבת');
    }, null, { timeout: 20000 });
    const allResultsNow = (src) =>
      page.waitForFunction(
        (re) => {
          const els = [...document.querySelectorAll('[data-testid="search-result"]')].filter((el) => el.getBoundingClientRect().height > 0);
          return els.length > 0 && els.every((el) => new RegExp(re).test(el.innerText));
        },
        src,
        { timeout: 15000 },
      );
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

    // ---- Search progress UI (Simple Search) -------------------------------------------------
    // __KODESHREAD_SEARCH_DELAY_MS__ / __KODESHREAD_COUNT_DELAY_MS__ slow the run down deterministically.
    const setDelay = (search, count) =>
      page.evaluate(([a, b]) => {
        globalThis.__KODESHREAD_SEARCH_DELAY_MS__ = a;
        globalThis.__KODESHREAD_COUNT_DELAY_MS__ = b;
      }, [search, count]);
    const plain = (t) => t.replace(/[⁦⁩]/g, '');
    const searchingBarVisible = (id) => page.waitForFunction((x) => { const el = document.querySelector(`[data-testid="${x}"]`); return !!el && parseFloat(getComputedStyle(el).opacity) > 0.3; }, id, { timeout: 5000 });
    await setDelay(2500, 0);
    await tid('search-input').fill('מצוה');
    await tid('search-progress-track').waitFor({ timeout: 2000 });
    await searchingBarVisible('search-progress-bar'); // the sweep bar paints at once, long before the query starts
    assert.strictEqual(await tid('search-status').count(), 0, 'no banner flicker for the first 300 ms');
    await tid('search-status').waitFor({ timeout: 3000 });
    assert.strictEqual(await tid('search-stage').innerText(), 'מחפש בכל הספרייה…');
    const t1 = plain(await tid('search-elapsed').innerText());
    assert.ok(/^\d+\.\d שניות?$|^0\.\d שניות$|^1\.0 שנייה$/.test(t1), `elapsed: ${t1}`);
    await page.waitForTimeout(700);
    const t2 = plain(await tid('search-elapsed').innerText());
    assert.ok(parseFloat(t2) > parseFloat(t1), `live timer ${t1} -> ${t2}`);
    assert.ok((await tid('search-elapsed').innerText()).includes('⁦'), 'number isolated LTR');
    assert.strictEqual(await tid('search-empty').count(), 0, 'no empty message while searching');
    const bannerBox = await tid('search-status').boundingBox();
    assert.ok(bannerBox && bannerBox.x >= 0 && bannerBox.x + bannerBox.width <= 401, 'banner fits the phone width');
    assert.strictEqual(await tid('search-stage').evaluate((el) => getComputedStyle(el).textAlign), 'right', 'RTL: stage text flush right');
    await shot('5-progress-searching');
    await tid('search-cancel').click();
    await tid('search-cancelled').waitFor({ timeout: 2000 });
    assert.strictEqual(await tid('search-status').count(), 0, 'cancel leaves the loading state at once');
    assert.strictEqual(await tid('search-empty').count(), 0, 'cancelled is not "no results"');
    await page.waitForTimeout(2800); // the slow query would have finished by now: its results are ignored
    assert.strictEqual(await tid('search-result').count(), 0, 'stale results after cancel are discarded');
    assert.strictEqual(await tid('search-empty').count(), 0);
    await shot('5b-progress-cancelled');
    await setDelay(0, 0);
    await tid('search-retry').click();
    await tid('search-result').first().waitFor({ timeout: 20000 });
    assert.strictEqual(await tid('search-cancelled').count(), 0);
    step('Simple Search progress: instant bar, delayed banner, live RTL timer, cancel, retry');

    // A newer query supersedes a slow earlier one: only the newer results ever show.
    await setDelay(1800, 0);
    await tid('search-input').fill('ברא');
    await page.waitForTimeout(700);
    await tid('search-input').fill('אמר');
    await tid('search-status').waitFor({ timeout: 3000 });
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="search-status"]').length === 0, null, { timeout: 15000 });
    await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="search-hit"]')].length > 0 && [...document.querySelectorAll('[data-testid="search-hit"]')].every((el) => el.textContent.replace(/[^א-ת]/g, '') === 'אמר'), null, { timeout: 15000 });
    await page.waitForTimeout(1500);
    assert.ok(await page.evaluate(() => [...document.querySelectorAll('[data-testid="search-hit"]')].every((el) => el.textContent.replace(/[^א-ת]/g, '') === 'אמר')), 'late results of the superseded query never appear');
    step('newer query supersedes a slow one');

    // Progressive results: the first batch shows immediately, the rest streams in behind a subtle, non-blocking
    // indicator (dimmed sweep bar, "N+ … מחפש עוד…"), the jump / filter bar counts grow in place.
    await page.evaluate(() => {
      globalThis.__KODESHREAD_STREAM_DELAY_MS__ = 450;
      globalThis.__KODESHREAD_STREAM_BATCH__ = 60;
    });
    await tid('search-input').fill('ויאמר');
    await tid('search-streaming').waitFor({ state: 'attached', timeout: 15000 });
    const pillCount = (id) => tid(id).innerText().then((t) => t.trim());
    assert.ok(/^\d+\+ תוצאות.*מחפש עוד…/.test(await tid('search-count').innerText()), `streaming count: ${await tid('search-count').innerText()}`);
    const early = await pillCount('group-pill-all-count');
    assert.ok(/^\d+\+$/.test(early), `growing total: ${early}`);
    assert.strictEqual(await tid('search-status').count(), 0, 'no blocking banner while results stream in');
    const barY = (await tid('group-bar').boundingBox()).y;
    const firstCard = await firstLine();
    await page.waitForFunction(() => !document.querySelector('[data-testid="search-streaming"]'), null, { timeout: 30000 });
    assert.strictEqual(await pillCount('group-pill-all-count'), '454', 'final total');
    assert.ok(parseInt(early, 10) < 454, `${early} -> 454`);
    assert.strictEqual((await tid('group-bar').boundingBox()).y, barY, 'the bar never moves while counts grow');
    assert.strictEqual(await firstLine(), firstCard, 'rows already on screen stay in place');
    assert.ok(/^454 תוצאות/.test(await tid('search-count').innerText()));
    await page.evaluate(() => {
      globalThis.__KODESHREAD_STREAM_DELAY_MS__ = 0;
      globalThis.__KODESHREAD_STREAM_BATCH__ = undefined;
    });
    step(`progressive results: first batch at once, ${early} -> 454 streamed in behind a subtle indicator`);

    // Jump / filter bar (whole library = broad categories): one tap filters, הכל resets, a new search resets it.
    const pills = () => page.evaluate(() => [...document.querySelectorAll('[data-testid^="group-pill-"][data-testid$="-label"]')].map((el) => [el.dataset.testid.replace(/-label$/, ''), el.textContent]));
    const groupPills = await pills();
    assert.deepStrictEqual(groupPills.map((x) => x[1]), ['הכל', 'תנ"ך', 'ש"ס בבלי'], JSON.stringify(groupPills));
    assert.deepStrictEqual([await pillCount('group-pill-0-count'), await pillCount('group-pill-1-count')], ['410', '44']);
    assert.strictEqual(await tid('group-pill-all').getAttribute('aria-selected'), 'true');
    await shot('2a-group-bar');
    await tid('group-pill-1').click();
    await allResultsNow('^(שבת|ראש השנה|תענית|רש"י על שבת|תוספות על שבת)');
    assert.strictEqual(await tid('group-pill-1').getAttribute('aria-selected'), 'true');
    assert.strictEqual(await tid('group-pill-all').getAttribute('aria-selected'), 'false');
    {
      // The filtered list opens at its top: the first card sits fully below the bar.
      const bar = await tid('group-bar').boundingBox();
      const top = await page.evaluate(() => Math.min(...[...document.querySelectorAll('[data-testid="search-result"]')].map((e) => e.getBoundingClientRect()).filter((r) => r.height > 0).map((r) => r.top)));
      assert.ok(top >= bar.y + bar.height - 1, `first filtered card at the top (${top} vs bar bottom ${bar.y + bar.height})`);
    }
    await shot('2b-group-filtered');
    await tid('group-pill-0').click();
    await allResultsNow('^(בראשית|במדבר|.* על בראשית)');
    await tid('group-pill-all').click();
    await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="search-result"]')].some((el) => el.innerText.startsWith('בראשית')), null, { timeout: 10000 });
    assert.strictEqual(await tid('group-pill-all').getAttribute('aria-selected'), 'true');
    await tid('group-pill-1').click();
    await tid('search-input').fill('שבת');
    await page.waitForFunction(() => (document.querySelector('[data-testid="group-pill-all"]') || {}).getAttribute?.('aria-selected') === 'true' && !document.querySelector('[data-testid="search-streaming"]'), null, { timeout: 15000 });
    assert.ok((await pills()).length >= 2, 'the new search has its own groups');
    step(`jump / filter bar: ${groupPills.slice(1).map((x) => x[1]).join(' · ')} with live counts; a pill filters, הכל and a new search reset`);

    // "לא נמצאו תוצאות" never flashes while the search is still running.
    await setDelay(1500, 0);
    await tid('search-input').fill('קקקקקק');
    await page.waitForTimeout(900);
    assert.strictEqual(await tid('search-empty').count(), 0, 'no empty message before the search finishes');
    await tid('search-empty').waitFor({ timeout: 8000 });
    assert.ok((await tid('search-empty').innerText()).includes('לא נמצאו תוצאות'));
    assert.strictEqual(await tid('search-status').count(), 0);
    // A fast query (no delay) never shows the banner at all.
    await setDelay(0, 0);
    await tid('search-input').fill('שבת');
    await tid('search-result').first().waitFor({ timeout: 15000 });
    assert.strictEqual(await tid('search-status').count(), 0, 'instant queries show no banner');
    step('empty state never flashes during a search; fast queries show no banner');

    // ---- Scope picker: multi-select over the canonical catalog ------------------------------
    await tid('search-input').fill('ויאמר');
    await tid('search-result').first().waitFor();
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
    // ---- Preset corpora (Simple Search): same presets as Advanced Search, with matched book counts ------
    await setDelay(0, 0);
    await tid('search-input').fill('אמר');
    for (const id of ['all', 'tanach', 'mishna', 'bavli', 'yerushalmi', 'rambam', 'shulchan-aruch', 'mefarshim']) await tid(`corpus-chip-${id}`).waitFor();
    assert.strictEqual(await tid('corpus-chip-all').getAttribute('aria-checked'), 'true');
    // Counts resolve once the catalog is built: 2 Tanach books, the sample's משנה שבת, 3 Bavli tractates.
    const chipCount = (id) => page.waitForFunction((x) => !!document.querySelector(`[data-testid="corpus-chip-${x}-count"]`) && document.querySelector(`[data-testid="corpus-chip-${x}-count"]`).textContent !== '…', id, { timeout: 30000 });
    await chipCount('bavli');
    assert.deepStrictEqual(
      await Promise.all(['tanach', 'mishna', 'bavli', 'rambam', 'shulchan-aruch'].map((id) => tid(`corpus-chip-${id}-count`).innerText())),
      ['2', '1', '3', '0', '1'],
      'matched book counts of the presets (base books only: no Rashi / Tosafot / Ramban / Onkelos)',
    );
    assert.ok(Number(await tid('corpus-chip-mefarshim-count').innerText()) >= 8, 'the commentary preset counts the commentaries');
    // בבלי: only Bavli base tractates, never Rashi / Tosafot; the scope button names the preset + count.
    await tid('corpus-chip-bavli').click();
    await allResults('^(שבת|ראש השנה|תענית)');
    assert.strictEqual(await tid('corpus-chip-bavli').getAttribute('aria-checked'), 'true');
    assert.strictEqual(await tid('corpus-chip-all').getAttribute('aria-checked'), 'false');
    assert.ok((await tid('scope-button').innerText()).includes('בבלי (3 ספרים)'), await tid('scope-button').innerText());
    for (const t of await tid('search-result').allInnerTexts()) assert.ok(!/^(רש"י|תוספות)/.test(t), `no commentary: ${t.slice(0, 20)}`);
    await shot('1-simple-corpus');
    // An unmatched preset is an honest empty scope, never "all".
    await tid('corpus-chip-bavli').click();
    await tid('corpus-chip-rambam').click();
    await tid('search-empty').waitFor({ timeout: 30000 });
    assert.ok((await tid('search-empty').innerText()).includes('משנה תורה'), 'empty state names the scope');
    await tid('corpus-chip-rambam').click();
    await page.waitForFunction(() => document.querySelector('[data-testid="scope-button"]').innerText.includes('כל הספרייה'));
    assert.strictEqual(await tid('corpus-chip-all').getAttribute('aria-checked'), 'true');
    // The progress banner names the preset; switching presets mid-run supersedes the running search; cancel works.
    await setDelay(2200, 0);
    await tid('corpus-chip-tanach').click();
    await tid('search-status').waitFor({ timeout: 3000 });
    assert.strictEqual(await tid('search-stage').innerText(), 'מחפש בתנ"ך (2 ספרים)…');
    await tid('corpus-chip-bavli').click();
    await page.waitForFunction(() => (document.querySelector('[data-testid="search-stage"]') || {}).innerText === 'מחפש בתנ"ך · בבלי (5 ספרים)…', null, { timeout: 5000 });
    await tid('search-cancel').click();
    await tid('search-cancelled').waitFor({ timeout: 2000 });
    await page.waitForTimeout(2400);
    assert.strictEqual(await tid('search-result').count(), 0, 'results of the superseded / cancelled preset search are discarded');
    await setDelay(0, 0);
    await tid('search-retry').click();
    await allResults('^(בראשית|במדבר|שבת|ראש השנה|תענית)');
    // ✕ clears the preset back to the whole library.
    await tid('scope-reset').click();
    await page.waitForFunction(() => document.querySelector('[data-testid="scope-button"]').innerText.includes('כל הספרייה'));
    assert.strictEqual(await tid('corpus-chip-tanach').getAttribute('aria-checked'), 'false');
    assert.strictEqual(await tid('corpus-chip-all').getAttribute('aria-checked'), 'true');
    step('Simple Search preset corpora: counts, base books only, progress banner, switch / cancel / clear');

    const openSheet = async () => {
      await tid('scope-button').click();
      await tid('scope-sheet').waitFor();
      await tid('scope-tab-base').click(); // the sheet remembers its last tab
    };
    const summary = async () => (await tid('scope-summary').innerText()).trim();
    await openSheet();
    assert.strictEqual(await summary(), 'כל הספרייה', 'empty selection = the whole library');
    assert.strictEqual(await tid('scope-open-book').count(), 0, 'no open book -> no shortcuts');
    const secs = await page.locator('[data-testid^="scope-toggle-sec:"]').allInnerTexts();
    assert.ok(/תנ"ך/.test(secs[0]) && /משנה/.test(secs[1]) && /תלמוד בבלי/.test(secs[2]) && /הלכה/.test(secs[3]) && secs.length === 4, `canonical sections: ${JSON.stringify(secs)}`);
    const tabs = await page.locator('[data-testid="scope-sheet"]').innerText();
    assert.ok(tabs.includes('ספרי בסיס') && tabs.includes('פרשנים לפי ספר'), tabs);
    await shot('2-scope-sheet');
    // A whole section with "בחר הכל".
    await page.locator('[data-testid^="scope-all-sec:/תנ"]').first().click(); // תנ"ך (quote-free prefix selector)
    assert.strictEqual(await summary(), 'נבחרו 2 ספרים');
    await tid('scope-apply').click();
    await allResults('^(בראשית|במדבר)');
    assert.ok((await tid('scope-button').innerText()).includes('נבחרו 2 ספרים'));
    assert.strictEqual(await tid('scope-chips').locator('[data-testid^="scope-chip-"]').count() >= 2, true);
    step('בחר הכל on תנ"ך (folder-style multi scope)');

    // One base book, through the live filter ("clear" empties the draft).
    await openSheet();
    assert.strictEqual(await summary(), 'נבחרו 2 ספרים', 'the draft starts from the active scope');
    await tid('scope-clear').click();
    await tid('scope-filter').fill('במדבר');
    await tid('scope-book-2').click();
    await tid('scope-apply').click();
    await allResults('^במדבר');
    for (const t of await tid('search-result').allInnerTexts()) assert.ok(t.startsWith('במדבר'), t);
    assert.strictEqual(await tid('scope-chip-2').count(), 1, 'a removable chip for the picked book');
    step('book scope');

    // 2 base books + 1 commentary (the commentary tab groups commentaries under their base book).
    await tid('search-input').fill('עשה'); // במדבר 8 · שבת 36 · רש"י על שבת 2 whole-word hits
    await openSheet();
    await tid('scope-clear').click();
    await tid('scope-filter').fill('שבת');
    await tid('scope-book-12').click();
    await tid('scope-filter').fill('במדבר');
    await tid('scope-book-2').click();
    await tid('scope-tab-comm').click();
    await tid('scope-filter').fill('שבת');
    await tid('scope-expand-12').click();
    await tid('scope-allcomm-12').waitFor();
    const rankedNames = await page.locator('[data-testid^="scope-comm-"]').allInnerTexts();
    assert.ok(/^רש"י/.test(rankedNames[0]) && /^תוספות/.test(rankedNames[1]), `commentaries in canonical rank order: ${JSON.stringify(rankedNames)}`);
    await tid('scope-comm-15').click(); // רש"י על שבת
    assert.strictEqual(await summary(), 'נבחרו 3 ספרים');
    await shot('2b-scope-multi');
    await tid('scope-apply').click();
    const inScope = '^(שבת|במדבר|רש"י על שבת)';
    await allResults(inScope);
    // The list is virtualized: scroll until the second book's results show up.
    const seen = new Set();
    await page.mouse.move(200, 600);
    for (let i = 0; i < 25 && !(seen.has('במדבר') && seen.has('שבת')); i++) {
      for (const t of await tid('search-result').allInnerTexts()) seen.add(t.split(' ‹')[0].split('\n')[0].trim());
      await page.mouse.wheel(0, 700);
      await page.waitForTimeout(150);
    }
    assert.ok(seen.has('במדבר') && seen.has('שבת') && [...seen].every((t) => new RegExp(inScope).test(t)), `multi-scope results: ${[...seen]}`);
    for (const id of ['scope-chip-12', 'scope-chip-2', 'scope-chip-15']) assert.strictEqual(await tid(id).count(), 1, id);
    step('multi-select: 2 base books + 1 commentary');

    // Removing a chip narrows the scope.
    await tid('scope-chip-remove-15').click();
    await allResults('^(שבת|במדבר)');
    assert.strictEqual(await tid('scope-chip-15').count(), 0);
    assert.strictEqual(await tid('scope-chip-12').count(), 1);
    step('removable chips');

    // "כל הפרשנים על שבת".
    await openSheet();
    await tid('scope-clear').click();
    await tid('scope-tab-comm').click();
    await tid('scope-filter').fill('שבת');
    await tid('scope-book-12').waitFor();
    if (!(await tid('scope-allcomm-12').count())) await tid('scope-expand-12').click(); // expansion is remembered between openings
    await tid('scope-allcomm-12').click();
    assert.strictEqual(await summary(), 'נבחרו 2 ספרים');
    await tid('scope-apply').click();
    await allResults('^(רש"י על שבת|תוספות על שבת)');
    assert.strictEqual(await tid('scope-chips').locator('[data-testid^="scope-chip-"]').count() >= 2, true);
    step('כל הפרשנים על שבת');
    await tid('scope-reset').click();
    await page.waitForFunction(() => document.querySelector('[data-testid="scope-button"]').innerText.includes('כל הספרייה'));
    await tid('search-input').fill('ויאמר');
    await tid('scope-chips').waitFor({ state: 'detached' }).catch(() => undefined);

    // A book scope for the reader hand-off below.
    await openSheet();
    await tid('scope-filter').fill('במדבר');
    await tid('scope-book-2').click();
    await tid('scope-apply').click();
    await allResults('^במדבר');

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
    // The picked books carry over from Simple Search as removable chips.
    await advTid('scope-chip-2').waitFor();
    await advTid('scope-chip-remove-2').click();
    await page.waitForFunction(() => !document.querySelector('[data-testid="advanced-search"] [data-testid="scope-chip-2"]'));
    const advBody = await page.locator('body').innerText();
    for (const label of ['חיפוש מתקדם', 'מילות החיפוש / ביטוי', 'אפשרויות לשוניות', 'קרבת מילים', 'סינון לפי מדור', 'חפש', 'נקה הכל']) assert.ok(advBody.includes(label), `advanced screen shows ${label}`);
    for (const gone of ['חזרה לחיפוש רגיל', 'לא מקוון', 'אחת מהמילים · או', 'ללא המילים · שלילה', 'עברית ↔ ארמית', 'אופרטורים: א|ב']) assert.ok(!advBody.includes(gone), `advanced screen no longer shows "${gone}"`);
    for (const id of ['adv-query', 'adv-help', 'adv-submit', 'adv-reset', 'adv-back']) await tid(id).waitFor();
    for (const id of ['adv-any', 'adv-exclude', 'adv-opt-aramaicEquiv']) assert.strictEqual(await tid(id).count(), 0, `${id} is gone`);
    // Minimal single-row header: only ← and the title.
    assert.strictEqual((await tid('adv-back').innerText()).trim(), '←');
    assert.strictEqual((await tid('adv-title').innerText()).trim(), 'חיפוש מתקדם');
    const hdr = await page.evaluate(() => {
      const back = [...document.querySelectorAll('[data-testid="adv-back"]')].pop().getBoundingClientRect();
      const title = [...document.querySelectorAll('[data-testid="adv-title"]')].pop().getBoundingClientRect();
      return { sameRow: Math.abs(back.top + back.height / 2 - (title.top + title.height / 2)) < 6, bottom: Math.max(back.bottom, title.bottom) };
    });
    assert.ok(hdr.sameRow, 'back arrow and title share one row');
    // One input; a short placeholder; the operators guide hides behind "?".
    assert.strictEqual(await tid('adv-query').getAttribute('placeholder'), 'לדוגמה: שבת | יום טוב -מוקצה');
    assert.strictEqual(await tid('adv-help-box').count(), 0, 'no permanent operator hint');
    await tid('adv-help').click();
    await tid('adv-help-box').waitFor();
    const guide = (await tid('adv-help-box').innerText()).replace(/[\u2066-\u2069]/g, '');
    for (const line of ['א|ב', 'אחת מהמילים (או)', '-מילה', 'ללא המילה (שלילה)', 'מיל*', 'תחילת מילה', '"ביטוי מדויק"', 'חיפוש ביטוי רצוף']) assert.ok(guide.includes(line), `operators guide: ${line}`);
    assert.strictEqual(await tid('adv-help').getAttribute('aria-expanded'), 'true');
    await shot('7a-advanced-help');
    await tid('adv-help-box').click(); // tap the box to dismiss
    await page.waitForFunction(() => !document.querySelector('[data-testid="adv-help-box"]'));
    await tid('adv-help').click();
    await tid('adv-help-box').waitFor();
    await tid('adv-help').click(); // the ? toggles it off too
    await page.waitForFunction(() => !document.querySelector('[data-testid="adv-help-box"]'));
    assert.strictEqual(await tid('adv-help').getAttribute('aria-expanded'), 'false');
    step('advanced: one-row header (← + title), a single input, "?" shows / dismisses the operators guide');
    assert.strictEqual(await tid('adv-query').inputValue(), 'שבת', 'the simple query is carried over');
    const checked = (id) => tid(id).getAttribute('aria-checked');
    const selected = (id) => tid(id).getAttribute('aria-selected');
    assert.deepStrictEqual(
      [await checked('adv-opt-prefixesAndSuffixes'), await checked('adv-opt-pleneDefective'), await checked('adv-opt-acronyms')],
      ['true', 'false', 'false'],
      'advanced defaults',
    );
    assert.strictEqual(await selected('adv-prox-paragraph'), 'true');
    assert.strictEqual(await tid('adv-ordered').count(), 0, 'order toggle only with קרבה');
    await tid('adv-prox-near').click();
    for (const d of [3, 5, 10]) await tid(`adv-dist-${d}`).waitFor();
    assert.strictEqual(await checked('adv-ordered'), 'false');
    await tid('adv-prox-paragraph').click();
    for (const id of ['all', 'book', 'tanach', 'mishna', 'bavli', 'yerushalmi', 'rambam', 'shulchan-aruch', 'mefarshim']) await tid(`adv-corpus-${id}`).waitFor();
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
    // The same jump / filter bar over the advanced results; its total is the result count.
    await tid('adv-group-bar').waitFor({ timeout: 10000 });
    assert.strictEqual(Number((await tid('adv-group-pill-all-count').innerText()).replace(/\D/g, '')), Math.min(advCount, 1000));
    assert.ok(await tid('adv-group-pill-0').count(), 'advanced results are grouped');
    // Exact matches first: every card before the divider contains the typed word itself.
    const cardHits = () =>
      page.evaluate(() =>
        // Only the cards above the "התאמות נוספות" divider (a taller viewport renders more of the list).
        [...document.querySelectorAll('[data-testid="advanced-search"] [data-testid="search-result"]')].filter((card) => { const d = document.querySelector('[data-testid="adv-expanded-divider"]'); return !d || card.getBoundingClientRect().top < d.getBoundingClientRect().top; }).map((card) => [...card.querySelectorAll('[data-testid="search-hit"]')].map((el) => el.textContent.replace(/[\u0591-\u05C7]/g, '').replace(/[^\u05D0-\u05EA]/g, ''))),
      );
    const firstCards = await cardHits();
    // (A card's marked snippet can show only an inflected hit when the exact token sits further down the paragraph, so the
    // check covers the first ten cards: with a taller viewport more of the list renders.)
    assert.ok(firstCards.length && firstCards.slice(0, 10).every((hits) => hits.includes('שבת')), `exact matches first: ${JSON.stringify(firstCards)}`);
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

    // One field with inline operators + corpus chip: אמר רבא -חסדא, בבלי only.
    await tid('adv-edit').click();
    await tid('adv-reset').click();
    assert.strictEqual(await tid('adv-query').inputValue(), '');
    assert.strictEqual(await checked('adv-opt-pleneDefective'), 'false', 'נקה הכל restores the defaults');
    await tid('adv-query').fill('אמר רבא -חסדא');
    await tid('adv-corpus-bavli').click();
    assert.strictEqual(await checked('adv-corpus-all'), 'false');
    assert.strictEqual(await tid('adv-corpus-bavli-count').innerText(), '3', 'Advanced Search shows the same matched counts');
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
    assert.ok((await advHitTexts()).some((t) => /רבא/.test(t)), 'the inline word is highlighted');
    await shot('7-advanced-structured');
    step('inline operators in the single input (אמר רבא -חסדא) + corpus chip');

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

    // Books picked in the scope picker apply to Advanced Search too (removable chips).
    await tid('adv-edit').click();
    await tid('adv-reset').click();
    await tid('adv-query').fill('את');
    await tid('adv-scope-button').click();
    await tid('scope-sheet').waitFor();
    assert.strictEqual(await tid('scope-summary').innerText(), 'כל הספרייה');
    await tid('scope-filter').fill('בראשית');
    await tid('scope-book-1').click();
    await tid('scope-apply').click();
    await advTid('scope-chip-1').waitFor();
    await tid('adv-submit').click();
    await page.waitForFunction(
      () => {
        const els = [...document.querySelectorAll('[data-testid="advanced-search"] [data-testid="search-result"]')];
        return els.length > 0 && els.every((el) => /^בראשית/.test(el.innerText));
      },
      null,
      { timeout: 30000 },
    );
    await tid('adv-edit').click();
    await tid('adv-corpus-bavli').click();
    assert.strictEqual(await advTid('scope-chip-1').count(), 0, 'a corpus chip replaces the picked books');
    await tid('adv-submit').click();
    await advTid('search-result').first().waitFor({ timeout: 30000 });
    step('Advanced Search: multi-select scope picker + chips');

    // Advanced Search progress: same bar / banner / cancel.
    await tid('adv-edit').click();
    await setDelay(2200, 0);
    await tid('adv-query').fill('מצוה');
    await tid('adv-submit').click();
    await advTid('search-progress-track').waitFor({ timeout: 2000 });
    await advTid('adv-status').waitFor({ timeout: 3000 });
    assert.strictEqual(await advTid('adv-stage').innerText(), 'מחפש בבבלי (3 ספרים)…', 'the stage names the active corpus scope and its book count');
    assert.ok(/\d+\.\d שניות|שנייה/.test(plain(await advTid('adv-elapsed').innerText())));
    assert.strictEqual(await advTid('adv-empty').count(), 0);
    await advTid('adv-cancel').click();
    await advTid('adv-cancelled').waitFor({ timeout: 2000 });
    await page.waitForTimeout(2400);
    assert.strictEqual(await advTid('search-result').count(), 0, 'stale advanced results discarded after cancel');
    assert.strictEqual(await advTid('adv-empty').count(), 0);
    await setDelay(0, 0);
    await advTid('adv-retry').click();
    await advTid('search-result').first().waitFor({ timeout: 20000 });
    assert.strictEqual(await advTid('adv-cancelled').count(), 0);
    step('Advanced Search progress: bar, banner, cancel, retry');

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
    step('the ← back arrow returns to the simple screen');

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
    {
      await setDelay(1200, 0);
      await tid('search-input').fill('מצוה');
      await searchingBarVisible('search-progress-bar');
      const colors = await page.evaluate(() => [getComputedStyle(document.querySelector('[data-testid="search-progress-bar"]')).backgroundColor, getComputedStyle(document.querySelector('[data-testid="search-progress-track"]')).backgroundColor]);
      assert.deepStrictEqual(colors, ['rgb(210, 174, 109)', 'rgb(58, 52, 40)'], 'dark theme bar colors');
      await setDelay(0, 0);
    }
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
