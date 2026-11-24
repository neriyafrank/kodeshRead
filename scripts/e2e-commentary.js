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
 *
 * (Talmud Bavli: רש"י is card #1, ahead of תוספות, and both are עיקריים.)
 *
 * Then בראשית א (8 commentators in the sample: core, ראשונים, אחרונים): priority order and
 * tier badges, smart default expansion (top 3), expanding / collapsing cards, open-all /
 * collapse-all, the commentator pill strip (1-tap jump), the name filter with abbreviations
 * (אב"ע / מלבים / רש / תוס), view chips, and pinning a favorite (persisted across reloads).
 * The tools header (filter / chips / open-all / pills) starts folded: it is opened with the
 * "סינון" toggle in the drawer's title bar, which shows a dot while a filter is active.
 *
 * Parallel works (shared/parallelWorks.js): on שבת ב. the sample's משנה שבת is a standalone
 * parallel work, never a commentator: its own "⇄ מקבילים · שבת פרק א'" section after רש"י /
 * תוספות, a dashed ⇄ chip, מפרשים / מקבילים kind pills; tapping the chip shows the opening of the
 * Mishnah perek with a filled "פתח בספר ↗", which opens it; from the Mishnah the drawer shows the
 * Bavli's perek (cut at "הדרן עלך") and opens it back.
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
  // Chip bar texts, right to left (הכל is the right-most chip).
  const chipTexts = async () =>
    (await page.locator('[data-testid="commentary-chip"], [data-testid="commentary-chip-all"]').evaluateAll((els) => els.map((e) => ({ t: e.innerText.trim(), x: e.getBoundingClientRect().x })))).sort((a, b) => b.x - a.x).map((p) => p.t);

  try {
    await page.goto(BASE + '/', { timeout: 180000 });
    await page.evaluate(() => localStorage.clear());
    await page.goto(BASE + '/', { timeout: 180000 });
    const jump = page.locator('[data-testid="quick-jump-input"]');
    await jump.waitFor({ timeout: 180000 });
    await jump.fill('שבת ב.');
    await tid('quick-jump-result').first().click();
    await tid('para-3').waitFor({ timeout: 20000 });

    // Badges: line 3 (paragraph 1, מתני' יציאות השבת) has 2x רש"י + תוספות line links + the רש"י
    // "שורה א" unit; line 4 has none; the amud heading (line 2) carries only תוספות' amud-level unit
    // (the sample רש"י is aligned per paragraph: "שורה N" = the N-th paragraph of the amud).
    assert.strictEqual((await tid('links-badge-3').innerText()).trim(), '4');
    assert.strictEqual(await tid('links-badge-4').count(), 0);
    assert.strictEqual((await tid('links-badge-2').innerText()).trim(), '1');
    await shot('1-badges');
    step('link-count badges');

    // A paragraph without a link badge: the Bavli is a parallel work (משנה / ירושלמי / תוספתא ...), so the
    // drawer opens anyway - with תוספות' amud block (it covers the whole amud) and the parallel Mishnah perek.
    await tid('para-4').click();
    await tid('parallel-group').waitFor({ timeout: 10000 });
    assert.deepStrictEqual(await tid('commentary-group-name').allInnerTexts(), ['תוספות']);
    assert.deepStrictEqual(await tid('parallel-group-name').allInnerTexts(), ['משנה']);

    await tid('para-3').click();
    // (The drawer is already open on paragraph 2: wait for paragraph 1's two commentators.)
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="commentary-group-name"]').length === 2, null, { timeout: 10000 });
    const names = await tid('commentary-group-name').allInnerTexts();
    assert.deepStrictEqual(names, ['רש"י', 'תוספות']);
    // Talmud Bavli: Rashi is #1 (ahead of Tosafot), both under the primary commentators (עיקריים).
    assert.deepStrictEqual(await tid('commentary-tier').allInnerTexts(), ['עיקריים', 'עיקריים']);
    assert.ok((await tid('commentary-group').first().innerText()).includes('רש"י'), 'Rashi is the first card');
    // רש"י: only the entries of שורה א (2); תוספות has no שורה headings: its whole amud block (2).
    // The 3 explicitly linked dibburim are marked.
    const entries = page.locator('[data-testid^="commentary-entry"]');
    assert.strictEqual(await entries.count(), 4);
    assert.strictEqual(await tid('commentary-entry-direct').count(), 3);
    assert.strictEqual(await tid('commentary-open-block').count(), 2);
    // The block bar names the unit with the commentary's own heading ("דף ב."), not the normalized key.
    assert.ok((await tid('commentary-block').first().innerText()).includes('דף ב. · שורה א'), await tid('commentary-block').first().innerText());
    // The "שורה א" sub-heading is the block's label, not a standalone row in the drawer body.
    assert.ok(!(await tid('commentary-group').first().innerText()).replace('שורה א', '').includes('שורה'), 'no שורה heading rows');
    // Two commentators: no tools header and no toggle for it.
    assert.strictEqual(await tid('commentary-tools-toggle').count(), 0);
    assert.strictEqual(await tid('commentary-tools').count(), 0);
    // The chip bar is just הכל + the commentators (no mode buttons).
    assert.deepStrictEqual(await chipTexts(), ['הכל', 'רש"י', 'תוספות']);
    await shot('2-drawer');
    step('drawer shows each commentator\'s full block for the amud');

    // Switching paragraph while open re-syncs the drawer (line 4 = paragraph 2: no רש"י entry at all,
    // only תוספות' amud block, no direct links).
    await tid('para-4').click();
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="commentary-entry-direct"]').length === 0);
    assert.deepStrictEqual(await tid('commentary-group-name').allInnerTexts(), ['תוספות']);
    assert.strictEqual(await page.locator('[data-testid^="commentary-entry"]').count(), 2);
    await tid('para-5').click();
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="commentary-group-name"]').length === 2);
    assert.deepStrictEqual(await tid('commentary-group-name').allInnerTexts(), ['רש"י', 'תוספות']);
    step('drawer follows the tapped paragraph');

    // Paragraph-specific Rashi on a Bavli amud: paragraph 3 (line 5) shows only רש"י שורה ג ("העני עומד
    // בחוץ" + "חייב"), paragraph 5 (line 7) only שורה ה ("שניהם פטורין"), paragraph 7 (line 9) only שורה ז.
    const rashiOnly = async (line, header, ...needles) => {
      await tid(`para-${line}`).click();
      await page.waitForFunction((h) => document.querySelector('[data-testid="commentary-block"]')?.innerText.includes(h), header).catch(async (e) => {
        throw new Error(`line ${line}: no "${header}" block; drawer shows ${JSON.stringify(await tid('commentary-block').allInnerTexts())} / ${e.message}`);
      });
      const g = tid('commentary-group').first();
      const text = await g.innerText();
      assert.ok(text.includes('רש"י'), 'Rashi is the first card');
      const rashiEntries = await g.locator('[data-testid^="commentary-entry"]').count();
      assert.strictEqual(rashiEntries, needles.length, `line ${line}: ${text}`);
      for (const n of needles) assert.ok(text.includes(n), `line ${line} shows "${n}"`);
      for (const other of ['יציאות השבת.', 'ידיעות הטומאה', 'תנן התם', 'העני עומד בחוץ', 'שניהם פטורין'].filter((o) => !needles.includes(o))) {
        assert.ok(!text.includes(other), `line ${line} does not show "${other}"`);
      }
    };
    await rashiOnly(7, 'שורה ה', 'שניהם פטורין');
    await rashiOnly(9, 'שורה ז', 'תנן התם');
    await rashiOnly(5, 'שורה ג', 'העני עומד בחוץ', 'חייב'); // (tapping the selected paragraph again would close the drawer)
    await shot('2a-paragraph-rashi');
    step('paragraph-specific רש"י on a Bavli amud (שורה N = N-th paragraph)');

    // Next paragraph with commentaries (line 7: one רש"י line link); the text scrolls with it.
    await tid('commentary-next').click();
    await page.waitForFunction(() => {
      const d = [...document.querySelectorAll('[data-testid="commentary-entry-direct"]')];
      return d.length === 1;
    });
    assert.deepStrictEqual(await tid('commentary-group-name').allInnerTexts(), ['רש"י', 'תוספות']);
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

    // Theme: switch to Dark (charcoal) in the Aa sheet (in the folded reader tools bar); the drawer follows.
    assert.strictEqual(await tid('aa-button').count(), 0, 'reader tools collapsed by default');
    await tid('reader-tools-toggle').click();
    await tid('aa-button').click();
    await tid('theme-dark').click();
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
    if (await tid('appearance-sheet').count()) await page.mouse.click(200, 60);
    await page.waitForTimeout(400);
    const bg = await tid('commentary-pane').evaluate((el) => getComputedStyle(el).backgroundColor);
    assert.strictEqual(bg, 'rgb(42, 42, 42)', `drawer background ${bg} (Dark surface #2A2A2A)`);
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

    // Single-commentator focus (רש"י only) stays on while the drawer opens another book's paragraph.
    await tid('commentary-chip').filter({ hasText: 'רש"י' }).click();
    await tid('commentary-focus-row').waitFor();
    assert.strictEqual(await tid('commentary-focus-row').getAttribute('aria-label'), 'רש"י');
    // Focus mode: no card header / name repeated under the chip bar; favorite + open-in-book stay.
    assert.strictEqual(await tid('commentary-group-header').count(), 0, 'no accordion header in focus mode');
    assert.strictEqual(await tid('commentary-group-name').count(), 0, 'commentator name not repeated');
    assert.strictEqual(await tid('commentary-pin').count(), 1, 'favorite toggle in the slim row');
    assert.strictEqual(await tid('commentary-open-block').count(), 1, 'פתח בספר in the slim row');
    const focusH = (await tid('commentary-focus-row').boundingBox()).height;
    assert.ok(focusH <= 30, `slim utility row (${focusH}px)`);
    assert.ok(/דף ב.? · שורה/.test(await tid('commentary-block').innerText()), 'concise location label');
    assert.ok(!(await tid('commentary-block').innerText()).includes('רש"י'), 'book name not repeated in the label');
    // Compact chrome: drawer title row and chip strip.
    const titleH = (await tid('commentary-title').evaluate((e) => e.parentElement.getBoundingClientRect().height));
    assert.ok(titleH <= 40, `single-line title bar (${titleH}px)`);
    const chipH = (await tid('commentary-chip').first().boundingBox()).height;
    assert.ok(chipH <= 30, `slim chips (${chipH}px)`);
    await shot('3z-focus');
    await tid('commentary-chip-all').click();
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="commentary-group"]').length === 2);
    await tid('commentary-chip').filter({ hasText: 'רש"י' }).click();

    // Open the commentary at its line in a tab.
    await tid('commentary-open').first().click();
    await page.waitForFunction(() => document.querySelector('[data-testid="reader-breadcrumb"]')?.innerText.includes('רש"י על שבת'));
    await tid('links-badge-7').waitFor();
    await shot('4-opened');
    const tabs = await page.evaluate(() => JSON.parse(localStorage.getItem('kodeshread.tabs')).state.tabs.map((t) => t.bookTitle));
    assert.deepStrictEqual(tabs, ['שבת', 'רש"י על שבת']);
    step('commentary opens at its line in a new tab');

    // Bidirectional: from a רש"י paragraph the drawer shows the base amud; "פתח בספר" opens the
    // base book at the unit and highlights the whole block.
    await tid('para-7').click();
    // The sticky רש"י selection matches nothing here (the drawer holds only the base text שבת):
    // clean RTL empty state with a 1-tap way back to everything.
    await tid('commentary-empty').waitFor({ timeout: 10000 });
    assert.strictEqual((await tid('commentary-empty').innerText()).trim(), 'אין פירוש של המפרשים שנבחרו לקטע זה');
    assert.strictEqual(await page.evaluate(() => getComputedStyle(document.querySelector('[data-testid="commentary-empty"]')).direction), 'rtl');
    assert.strictEqual((await tid('commentary-filter-reset').innerText()).trim(), 'הצג את כל המפרשים');
    await shot('4b-empty-state');
    await tid('commentary-filter-reset').click();
    step('empty state for a verse without the chosen commentators + "הצג את כל המפרשים"');
    await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="commentary-group-name"], [data-testid="commentary-focus-row"]')].some((e) => (e.dataset.testid === 'commentary-focus-row' ? e.getAttribute('aria-label') : e.innerText) === 'שבת'));
    await tid('commentary-open-block').first().click();
    await page.waitForFunction(() => /^שבת/.test(document.querySelector('[data-testid="reader-breadcrumb"]')?.innerText || ''));
    // Rows whose highlight glow (an absolutely positioned, coloured layer) is visible; the
    // existing שבת tab shows its breadcrumb before the jump lands, so poll.
    const litRows = () =>
      [...document.querySelectorAll('[data-testid^="para-"]')].filter((p) =>
        [...p.querySelectorAll('div')].some((ch) => {
          const cs = getComputedStyle(ch);
          return cs.position === 'absolute' && parseFloat(cs.opacity) > 0.5 && !/rgba\(0, 0, 0, 0\)|transparent/.test(cs.backgroundColor) && ch.getBoundingClientRect().height > 20;
        }),
      ).length;
    await page.waitForFunction(`(${litRows.toString()})() >= 1`, null, { timeout: 5000 }).catch(() => undefined);
    const lit = await page.evaluate(`(${litRows.toString()})()`);
    // The Rashi paragraph is under שורה N: its base block is that one Gemara paragraph (not the whole amud).
    assert.strictEqual(lit, 1, `the linked Gemara paragraph is highlighted (${lit} rows)`);
    await shot('5-block-open');
    step(`"פתח בספר" opens the base unit and highlights the block (${lit} rows)`);

    // --- many commentators: priority, accordion, pills, filter, favorites (בראשית א) ----------
    const openBereshit = async () => {
      await page.goto(BASE + '/', { timeout: 180000 });
      await tid('quick-jump-input').last().waitFor({ timeout: 180000 });
      await tid('quick-jump-input').last().fill('בראשית א');
      await page.locator('[data-testid="quick-jump-result"]', { hasText: 'בראשית' }).last().click();
      await tid('para-3').last().waitFor({ timeout: 20000 });
      await tid('para-3').last().click();
      await page.waitForFunction(() => document.querySelectorAll('[data-testid="commentary-group"]').length >= 8, null, { timeout: 10000 });
    };
    // Stacked cards expose their name; a focused (single-commentator) view has no card header,
    // its slim row carries the commentator as aria-label.
    const groupNames = () =>
      page.evaluate(() => [...document.querySelectorAll('[data-testid="commentary-group-name"], [data-testid="commentary-focus-row"]')].map((e) => (e.dataset.testid === 'commentary-focus-row' ? e.getAttribute('aria-label') : e.innerText)));
    const expandedFlags = () => tid('commentary-group-header').evaluateAll((els) => els.map((e) => e.getAttribute('aria-expanded') === 'true'));
    const card = (name) => page.locator('[data-testid="commentary-group"]', { has: page.locator(`[data-testid="commentary-group-name"]:text-is('${name}')`) });
    const PRIORITY = ['אונקלוס', 'רש"י', 'רמב"ן', 'אבן עזרא', 'ספורנו', 'מלבי"ם', 'דעת זקנים', 'גור אריה'];
    const toolsToggle = tid('commentary-tools-toggle');
    const setTools = async (open) => {
      if ((await toolsToggle.getAttribute('aria-expanded')) !== String(open)) await toolsToggle.click();
      if (open) await tid('commentary-filter').waitFor();
      else await page.waitForFunction(() => !document.querySelector('[data-testid="commentary-tools"]'));
    };

    await page.evaluate(() => localStorage.removeItem('kodeshread.commentary'));
    await openBereshit();
    assert.deepStrictEqual(await groupNames(), PRIORITY, 'Tanach core list first, then ראשונים before אחרונים');
    // אונקלוס keeps its place at the top of the Tanach list, but is badged as a translation (תרגום).
    assert.deepStrictEqual(await tid('commentary-tier').allInnerTexts(), ['תרגומים', 'עיקריים', 'עיקריים', 'עיקריים', 'עיקריים', 'עיקריים', 'ראשונים', 'אחרונים']);
    // Otzaria titles without gershayim are shown in their canonical spelling ("מלבים" -> מלבי"ם).
    step('priority order + tier badges (8 commentators)');

    // The tools header starts folded: the first card sits right under the title bar.
    assert.strictEqual(await toolsToggle.getAttribute('aria-expanded'), 'false', 'commentary tools start collapsed');
    for (const id of ['commentary-tools', 'commentary-filter', 'commentary-toggle-all']) assert.strictEqual(await tid(id).count(), 0, `${id} hidden`);
    assert.strictEqual(await tid('commentary-tools-badge').count(), 0, 'no filter badge without a filter');
    const headerBottom = async () => {
      const h = await tid('commentary-chipbar').boundingBox(); // the chip bar sits right under the title bar
      return h.y + h.height;
    };
    const firstCardGap = async () => (await tid('commentary-group').first().boundingBox()).y - (await headerBottom());
    const collapsedGap = await firstCardGap();
    assert.ok(collapsedGap < 24, `commentaries start right under the title bar (${collapsedGap}px)`);
    await setTools(true);
    assert.strictEqual(await toolsToggle.getAttribute('aria-expanded'), 'true');
    for (const id of ['commentary-filter', 'commentary-toggle-all', 'commentary-chipbar']) assert.ok(await tid(id).isVisible(), `${id} shown`);
    await page.waitForTimeout(250);
    const openGap = await firstCardGap();
    assert.ok(openGap > collapsedGap + 30, `the tools take room only when open (${collapsedGap} -> ${openGap}px)`);
    await shot('6a-tools-open');
    await setTools(false);
    assert.strictEqual(await tid('commentary-filter').count(), 0);
    step(`commentary tools header: collapsed by default, toggles open / closed (${Math.round(openGap - collapsedGap)}px saved)`);

    // Smart default: only the top 3 open; the rest are one-line headers without text.
    assert.deepStrictEqual(await expandedFlags(), [true, true, true, false, false, false, false, false]);
    assert.strictEqual(await card('גור אריה').locator('[data-testid^="commentary-entry"]').count(), 0);
    assert.ok((await card('רש"י').locator('[data-testid^="commentary-entry"]').count()) >= 5);
    const collapsedH = (await card('גור אריה').boundingBox()).height;
    assert.ok(collapsedH < 60, `collapsed card is a single line (${collapsedH}px)`);
    await shot('6-many-collapsed');
    step('smart default expansion: top 3 open, others collapsed to one line');

    // Expand / collapse a card.
    await card('גור אריה').locator('[data-testid="commentary-group-header"]').click();
    await card('גור אריה').locator('[data-testid="commentary-entry"]').first().waitFor();
    assert.ok((await card('גור אריה').innerText()).includes('לא היה צריך להתחיל את התורה'));
    await card('גור אריה').locator('[data-testid="commentary-group-header"]').click();
    await page.waitForFunction(() => {
      const c = [...document.querySelectorAll('[data-testid="commentary-group"]')].find((e) => e.innerText.includes('גור אריה'));
      return c && !c.querySelector('[data-testid^="commentary-entry"]');
    });
    // The choice sticks when the drawer moves to another verse of the chapter.
    await card('ספורנו').locator('[data-testid="commentary-group-header"]').click();
    await tid('para-4').last().click();
    await page.waitForTimeout(400);
    assert.deepStrictEqual(await expandedFlags(), [true, true, true, false, true, false, false, false], 'user-opened ספורנו stays open on the next verse');
    step('cards expand / collapse; user choices persist across verses');

    // Open all / collapse all (in the tools header).
    await setTools(true);
    assert.strictEqual((await tid('commentary-toggle-all').innerText()).trim(), 'פתח הכל');
    await tid('commentary-toggle-all').click();
    await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="commentary-group-header"]')].every((e) => e.getAttribute('aria-expanded') === 'true'));
    assert.strictEqual((await tid('commentary-toggle-all').innerText()).trim(), 'כווץ הכל');
    await tid('commentary-toggle-all').click();
    await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="commentary-group-header"]')].every((e) => e.getAttribute('aria-expanded') === 'false'));
    assert.strictEqual(await tid('commentary-entry').count(), 0);
    step('פתח הכל / כווץ הכל');

    // Chip bar: הכל at the right edge, then the commentators in priority order; no extra buttons.
    await setTools(false);
    assert.deepStrictEqual(await chipTexts(), ['הכל', ...PRIORITY], 'chip bar: הכל + commentators right-to-left in priority order');
    // + the kind pills (אונקלוס is a translation): מפרשים 7 · תרגומים 1, right after הכל (right-to-left).
    const kinds = await page.locator('[data-testid^="commentary-kind-"]').evaluateAll((els) => els.map((e) => ({ t: e.innerText.trim(), x: e.getBoundingClientRect().x })));
    assert.deepStrictEqual(kinds.sort((a, b) => b.x - a.x).map((k) => k.t), ['מפרשים 7', 'תרגומים 1']);
    assert.strictEqual(await tid('commentary-chipbar').locator('[data-testid^="commentary-"]').count(), 11, 'הכל + 2 kind pills + 8 commentators, no mode buttons');
    const allBox = await tid('commentary-chip-all').boundingBox();
    assert.ok(allBox.x + allBox.width <= 401 && allBox.x > 200, `הכל visible at the right edge (${allBox.x})`);
    const chip = (name) => page.locator('[data-testid="commentary-chip"]', { hasText: name });
    const longPress = async (name) => {
      await chip(name).scrollIntoViewIfNeeded();
      const b = await chip(name).boundingBox();
      await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
      await page.mouse.down();
      await page.waitForTimeout(800);
      await page.mouse.up();
      await page.waitForTimeout(150);
    };
    const showing = async (names) => {
      try {
        await page.waitForFunction((n) => JSON.stringify([...document.querySelectorAll('[data-testid="commentary-group-name"], [data-testid="commentary-focus-row"]')].map((e) => (e.dataset.testid === 'commentary-focus-row' ? e.getAttribute('aria-label') : e.innerText))) === JSON.stringify(n), names, { timeout: 5000 });
      } catch {
        assert.deepStrictEqual(await groupNames(), names, 'commentators shown');
      }
    };
    const openCount = async () => (await tid('commentary-group-header').evaluateAll((els) => els.filter((e) => e.getAttribute('aria-expanded') === 'true').length)) + (await tid('commentary-focus-row').count());
    assert.strictEqual(await tid('commentary-chip-all').getAttribute('aria-pressed'), 'true');

    // 1-tap focus: only רש"י, expanded immediately.
    await chip('רש"י').click();
    await showing(['רש"י']);
    assert.strictEqual(await openCount(), 1);
    await page.waitForFunction(() => document.querySelectorAll('[data-testid^="commentary-entry"]').length >= 5, null, { timeout: 5000 });
    assert.strictEqual(await tid('commentary-chip-all').getAttribute('aria-pressed'), 'false');
    assert.strictEqual(await chip('רש"י').getAttribute('aria-pressed'), 'true');
    await shot('7a-single');
    // Tap it again -> הכל.
    await chip('רש"י').click();
    await showing(PRIORITY);
    assert.strictEqual(await tid('commentary-chip-all').getAttribute('aria-pressed'), 'true');
    // Tap another then הכל.
    await chip('אבן עזרא').click();
    await showing(['אבן עזרא']);
    await tid('commentary-chip-all').click();
    await showing(PRIORITY);
    step('1-tap on a commentator isolates it (expanded); tap again or הכל returns to הכל');

    // Long-press: רש"י, then long-press רמב"ן -> both, stacked in canonical order.
    await chip('רמב"ן').click();
    await longPress('רש"י');
    await showing(['רש"י', 'רמב"ן']);
    assert.strictEqual(await openCount(), 2);
    const gs = await tid('commentary-group').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().y));
    assert.ok(gs[0] < gs[1], 'sequential: רש"י above רמב"ן');
    assert.strictEqual(await tid('commentary-chip-all').getAttribute('aria-pressed'), 'false');
    await shot('7b-multi');
    // With 2+ selected, a plain tap toggles a third in; a long-press toggles one out.
    await chip('גור אריה').click();
    await showing(['רש"י', 'רמב"ן', 'גור אריה']);
    await longPress('רמב"ן');
    await showing(['רש"י', 'גור אריה']);
    await chip('גור אריה').click();
    await showing(['רש"י']);
    step('long-press builds a multi-selection (canonical order, tap / long-press toggle) with no mode button');

    // Sticky across verses; empty state when the verse lacks the chosen commentators.
    await chip('גור אריה').click(); // רש"י + גור אריה? (one selected -> tap switches focus)
    await showing(['גור אריה']);
    await longPress('רש"י');
    await showing(['רש"י', 'גור אריה']);
    await tid('para-5').last().click();
    await page.waitForTimeout(500);
    const afterVerse = await groupNames();
    const emptyText = (await tid('commentary-empty').count()) ? (await tid('commentary-empty').innerText()).trim() : '';
    await shot('7c-next-verse');
    if (afterVerse.length) {
      assert.ok(afterVerse.every((n) => ['רש"י', 'גור אריה'].includes(n)), `selection sticks on the next verse (${afterVerse})`);
    } else {
      assert.strictEqual(emptyText, 'אין פירוש של המפרשים שנבחרו לקטע זה');
      assert.strictEqual((await tid('commentary-filter-reset').innerText()).trim(), 'הצג את כל המפרשים');
      await tid('commentary-filter-reset').click();
      await page.waitForFunction(() => document.querySelectorAll('[data-testid="commentary-group"]').length > 0);
      assert.strictEqual(await tid('commentary-chip-all').getAttribute('aria-pressed'), 'true');
    }
    await tid('commentary-chip-all').click();
    step('selection stays while moving between verses');

        await setTools(true);
    // Name filter: Hebrew + Torah abbreviations.
    const filterTo = async (q, expected) => {
      await tid('commentary-filter').fill(q);
      await page.waitForFunction(
        (n) => document.querySelectorAll('[data-testid="commentary-group"]').length === n || (n === 0 && !!document.querySelector('[data-testid="commentary-filter-reset"]')),
        expected.length,
      );
      assert.deepStrictEqual(await groupNames(), expected, `filter "${q}"`);
    };
    const commentaryAligns = await page.evaluate(() => ({
      filter: getComputedStyle(document.querySelector('[data-testid="commentary-filter"]')).textAlign,
      block: [...document.querySelectorAll('[data-testid="commentary-block"]')].map((e) => getComputedStyle(e).textAlign),
    }));
    assert.strictEqual(commentaryAligns.filter, 'right', 'commentator filter input right-aligned');
    assert.ok(commentaryAligns.block.length && commentaryAligns.block.every((a) => a === 'right'), `block breadcrumbs right-aligned (${commentaryAligns.block})`);
    await filterTo('אב"ע', ['אבן עזרא']);
    // A narrow filter opens what it found.
    await card('אבן עזרא').locator('[data-testid="commentary-entry"]').first().waitFor();
    await shot('8-filter');
    await filterTo('מלבים', ['מלבי"ם']);
    await filterTo('רש', ['רש"י']);
    // Folding the tools keeps the filter, and the toggle shows a dot while it is active.
    await setTools(false);
    await tid('commentary-tools-badge').waitFor();
    assert.deepStrictEqual(await groupNames(), ['רש"י'], 'filter stays applied while the tools are folded');
    assert.ok((await toolsToggle.getAttribute('aria-label')).includes('סינון פעיל'));
    await shot('8b-filter-badge');
    await setTools(true);
    assert.strictEqual(await tid('commentary-tools-badge').count(), 0, 'no dot while the tools are open');
    assert.strictEqual(await tid('commentary-filter').inputValue(), 'רש');
    await filterTo('רמ', ['רמב"ן']);
    await filterTo('תוס', []);
    await tid('commentary-filter-reset').click();
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="commentary-group"]').length === 8);
    assert.strictEqual(await tid('commentary-filter').inputValue(), '');
    await setTools(false);
    assert.strictEqual(await tid('commentary-tools-badge').count(), 0, 'no dot once the filter is cleared');
    await setTools(true);
    step('filter by name / abbreviation (אב"ע, מלבים, רש, רמ; none for תוס); active-filter dot on the folded toggle');

    // Pin a favorite: it jumps to the very top (over the core list).
    await card('גור אריה').locator('[data-testid="commentary-pin"]').click();
    await page.waitForFunction(() => document.querySelector('[data-testid="commentary-group-name"]')?.innerText === 'גור אריה');
    assert.deepStrictEqual(await groupNames(), ['גור אריה', ...PRIORITY.slice(0, 7)]);
    assert.strictEqual(await card('גור אריה').locator('[data-testid="commentary-pin"]').getAttribute('aria-pressed'), 'true');
    assert.strictEqual((await chipTexts())[1], '★ גור אריה', 'the favorite is the first commentator chip');
    assert.deepStrictEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('kodeshread.commentary')).state.pinned), ['גור אריה']);
    await shot('9-pinned');

    // Persisted: after a reload the favorite is still first, and open by default with the top 3.
    await openBereshit();
    assert.strictEqual(await toolsToggle.getAttribute('aria-expanded'), 'false', 'tools folded again after a reload');
    assert.deepStrictEqual(await groupNames(), ['גור אריה', ...PRIORITY.slice(0, 7)]);
    assert.deepStrictEqual(await expandedFlags(), [true, true, true, true, false, false, false, false], 'favorite + top 3 open by default');
    // Unpin: back to its era place.
    await card('גור אריה').locator('[data-testid="commentary-pin"]').click();
    await page.waitForFunction(() => document.querySelector('[data-testid="commentary-group-name"]')?.innerText === 'אונקלוס');
    assert.deepStrictEqual(await groupNames(), PRIORITY);
    step('pin ⭐ a favorite: pinned to the top, persisted across reloads, unpin restores');

    // Scope picker shortcuts for the open book: "הספר הפתוח כעת" / "הספר הפתוח + מפרשיו".
    await page.goto(BASE + '/search');
    await tid('search-input').waitFor({ timeout: 60000 });
    await tid('search-input').fill('ויאמר');
    await tid('scope-button').click();
    await tid('scope-sheet').waitFor();
    await tid('scope-open-book').waitFor();
    await tid('scope-open-book-comm').waitFor();
    assert.ok((await tid('scope-sheet').innerText()).includes('הספר הפתוח + מפרשיו'));
    assert.strictEqual((await tid('scope-summary').innerText()).trim(), 'כל הספרייה');
    await tid('scope-open-book').click();
    assert.strictEqual((await tid('scope-summary').innerText()).trim(), 'נבחרו 1 ספרים');
    await tid('scope-open-book-comm').click();
    assert.strictEqual((await tid('scope-summary').innerText()).trim(), 'נבחרו 9 ספרים', 'בראשית + its 8 commentaries');
    await tid('scope-tab-comm').click();
    await tid('scope-filter').fill('בראשית');
    await tid('scope-book-1').waitFor();
    if (!(await tid('scope-allcomm-1').count())) await tid('scope-expand-1').click();
    await tid('scope-allcomm-1').waitFor();
    assert.strictEqual(await tid('scope-allcomm-1').getAttribute('aria-checked'), 'true', '"כל הפרשנים על בראשית" is fully checked');
    await shot('10-scope-open-book');
    await tid('scope-apply').click();
    await tid('scope-badge').waitFor();
    assert.strictEqual((await tid('scope-badge').innerText()).trim(), 'נבחרו 9 ספרים', 'more than four picks collapse into a badge');
    await page.waitForFunction(
      () => {
        const els = [...document.querySelectorAll('[data-testid="search-result"]')];
        return els.length > 0 && els.every((el) => /^(בראשית|.+ על בראשית)( |$)/.test(el.innerText.split('\n')[0].split('‹')[0].trim()));
      },
      null,
      { timeout: 30000 },
    );
    await tid('scope-chips-clear').click();
    await page.waitForFunction(() => document.querySelector('[data-testid="scope-button"]').innerText.includes('כל הספרייה'));
    step('scope picker: הספר הפתוח + מפרשיו (9 books) -> badge "נבחרו 9 ספרים" + נקה');

    // --- Parallel works (מקבילים): Bavli שבת פרק א <-> משנה שבת פרק א, both directions ------------
    await page.evaluate(() => localStorage.removeItem('kodeshread.commentary'));
    await page.goto(BASE + '/', { timeout: 180000 });
    await jump.waitFor({ timeout: 180000 });
    await jump.fill('שבת ב.');
    await tid('quick-jump-result').first().click();
    await tid('para-3').waitFor({ timeout: 20000 });
    await tid('para-3').click();
    await tid('parallel-group').waitFor({ timeout: 10000 });
    // Commentaries first; the parallel work in its own labelled section, folded, with its unit.
    assert.deepStrictEqual(await tid('commentary-group-name').allInnerTexts(), ['רש"י', 'תוספות']);
    assert.deepStrictEqual(await tid('parallel-group-name').allInnerTexts(), ['משנה']);
    assert.deepStrictEqual(await tid('parallel-tier').allInnerTexts(), ['⇄ מקביל']);
    assert.ok((await tid('parallel-section').innerText()).includes("מקבילים · שבת פרק א'"), await tid('parallel-section').innerText());
    assert.ok((await tid('parallel-block').innerText()).includes("שבת פרק א'"));
    assert.strictEqual(await tid('parallel-group-header').getAttribute('aria-expanded'), 'false', 'parallels start folded');
    assert.strictEqual(await tid('parallel-entry').count(), 0);
    assert.ok((await tid('commentary-title').innerText()).includes('מקבילים (1)'), await tid('commentary-title').innerText());
    // Compact layout kept: 36px title bar, 28px chips (the parallel chip too), kind pills.
    assert.ok(Math.abs((await tid('commentary-title').evaluate((e) => e.parentElement.getBoundingClientRect().height)) - 36) <= 1);
    assert.strictEqual(Math.round((await tid('commentary-chip-parallel').boundingBox()).height), 28);
    assert.strictEqual((await tid('commentary-chip-parallel').innerText()).trim(), '⇄ משנה');
    assert.strictEqual((await tid('commentary-kind-commentary').innerText()).trim(), 'מפרשים 2');
    assert.strictEqual((await tid('commentary-kind-parallel').innerText()).trim(), 'מקבילים 1');
    // A kind pill isolates the parallel works, and back.
    await tid('commentary-kind-parallel').click();
    await page.waitForFunction(() => !document.querySelector('[data-testid="commentary-group"]'));
    assert.strictEqual(await tid('parallel-group').count(), 1);
    await tid('commentary-kind-parallel').click();
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="commentary-group"]').length === 2);
    await shot('11-parallel-section');
    step('parallel works: מקבילים section + ⇄ chip + kind pills next to רש"י / תוספות (compact 36px / 28px layout)');

    // Tapping the parallel chip shows the opening of משנה שבת פרק א with a prominent "פתח בספר ↗".
    await tid('commentary-chip-parallel').click();
    await tid('parallel-focus-row').waitFor();
    assert.ok((await tid('parallel-focus-row').innerText()).includes("⇄ משנה · שבת פרק א'"), await tid('parallel-focus-row').innerText());
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="parallel-entry"]').length > 0);
    const plain = (t) => t.replace(/[\u0591-\u05C7]/g, '');
    assert.ok(plain(await tid('parallel-entry').first().innerText()).includes('יציאות השבת'), `the overview opens on Mishnah 1:1: ${await tid('parallel-entry').first().innerText()}`);
    const openBg = await tid('parallel-open').evaluate((e) => getComputedStyle(e).backgroundColor);
    assert.ok(openBg !== 'rgba(0, 0, 0, 0)' && openBg !== 'transparent', 'prominent filled action');
    await shot('12-parallel-focus');
    await tid('commentary-chip-all').click();
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="commentary-group"]').length === 2);
    await tid('parallel-open').click();
    await page.waitForFunction(() => document.querySelector('[data-testid="reader-breadcrumb"]')?.innerText.includes('משנה שבת'), null, { timeout: 15000 });
    await tid('para-6').waitFor({ timeout: 15000 });
    step('parallel chip -> overview of משנה שבת פרק א; "פתח בספר ↗" opens the Mishnah at the perek');

    // From the Mishnah (no commentaries at all in the sample) the drawer shows the Bavli's perek.
    await page.waitForTimeout(400);
    await tid('para-6').click();
    await tid('parallel-group').waitFor({ timeout: 10000 });
    assert.strictEqual(await tid('commentary-group').count(), 0);
    assert.deepStrictEqual(await tid('parallel-group-name').allInnerTexts(), ['בבלי']);
    assert.strictEqual(await tid('parallel-group-header').getAttribute('aria-expanded'), 'true', 'only parallels: they open');
    assert.ok(/^מקבילים \(1\)/.test((await tid('commentary-title').innerText()).trim()), await tid('commentary-title').innerText());
    assert.ok(plain(await tid('parallel-entry').first().innerText()).includes('יציאות השבת'), `the Bavli perek opens on its Mishnah: ${await tid('parallel-entry').first().innerText()}`);
    await shot('13-mishna-to-bavli');
    await tid('parallel-open').click();
    await page.waitForFunction(() => /^\s*שבת/.test(document.querySelector('[data-testid="reader-breadcrumb"]')?.innerText || ''), null, { timeout: 15000 });
    await tid('para-3').waitFor({ timeout: 15000 });
    step('reverse direction: משנה שבת פרק א -> בבלי שבת פרק א (perek cut at "הדרן עלך"), opened in the reader');

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
