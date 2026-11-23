#!/usr/bin/env node
/**
 * End-to-end check of the reader's tab management, the collapsible reader tools bar, the
 * cascading-columns TOC (fit-to-content widths, right-aligned labels on phone and tablet), and
 * commentary favorites (⭐) following a commentator across books and tabs (web preview).
 *
 *   npm run web                          # terminal 1 (Metro on :8081, sample DB)
 *   npm run e2e:reader [-- --shots=DIR]  # terminal 2
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
  // The top-most instance (expo-router web can keep a hidden copy of a screen underneath).
  const tid = (id) => page.locator(`[data-testid="${id}"]`).last();
  const all = (prefix) => page.locator(`[data-testid^="${prefix}"]`);
  const shot = (name) => (SHOTS ? page.screenshot({ path: `${SHOTS}/${name}.png` }) : null);
  const step = (name) => console.log(`✓ ${name}`);
  const tabsInStore = () => page.evaluate(() => JSON.parse(localStorage.getItem('kodeshread.tabs')).state.tabs.map((t) => t.bookTitle));
  const crumb = () => tid('reader-breadcrumb').innerText();
  const visible = (id) => tid(id).isVisible().catch(() => false);
  /** The tools bar (TOC / search / טעמים / ניקוד / Aa) is folded away by default. */
  const openTools = async () => {
    if (!(await visible('toc-button'))) await tid('reader-tools-toggle').click();
    await tid('toc-button').waitFor();
  };
  const openToc = async (col = 0) => {
    await openTools();
    await tid('toc-button').click();
    await tid(`toc-col-${col}`).waitFor();
    await page.waitForTimeout(450); // slide-in + width animation
  };
  const tocWidth = async () => (await tid('toc-drawer').boundingBox()).width;
  const colWidths = () => page.evaluate(() => [...[...document.querySelectorAll('[data-testid="toc-drawer"]')].pop().querySelectorAll('[data-testid^="toc-col-"]')].filter((e) => /^toc-col-\d+$/.test(e.dataset.testid)).map((e) => e.getBoundingClientRect().width));
  /** Every TOC label / column header: computed alignment and where its text sits in its column. */
  const tocAlignment = () =>
    page.evaluate(() => {
      const drawer = [...document.querySelectorAll('[data-testid="toc-drawer"]')].pop();
      return [...drawer.querySelectorAll('[data-testid="toc-label"], [data-testid="toc-col-head"]')]
        .filter((el) => el.getBoundingClientRect().height > 0 && el.innerText.trim())
        .map((el) => {
          const cs = getComputedStyle(el);
          const r = document.createRange();
          r.selectNodeContents(el);
          const t = r.getBoundingClientRect();
          const box = el.closest('[data-testid^="toc-node-"], [data-testid^="toc-verse-"], [data-testid^="toc-result-"], [data-testid="toc-open-section"]').getBoundingClientRect();
          const chev = el.parentElement.querySelector('[data-testid="toc-chevron"]');
          return { text: el.innerText.trim(), align: cs.textAlign, dir: cs.direction, right: box.right - t.right, left: t.left - box.left, chevronLeft: chev ? chev.getBoundingClientRect().right <= t.left + 1 : true };
        });
    });
  const assertRightAligned = async (where) => {
    const rows = await tocAlignment();
    assert.ok(rows.length > 5, `${where}: labels found (${rows.length})`);
    for (const r of rows) {
      assert.strictEqual(r.align, 'right', `${where}: "${r.text}" text-align`);
      assert.strictEqual(r.dir, 'rtl', `${where}: "${r.text}" direction`);
      assert.ok(r.right <= 16 && r.right < r.left, `${where}: "${r.text}" flush right (gap right ${r.right.toFixed(1)}, left ${r.left.toFixed(1)})`);
      assert.ok(r.chevronLeft, `${where}: "${r.text}" sub-level arrow at the left edge`);
    }
    return rows.length;
  };
  const longPress = async (loc) => {
    const b = await loc.boundingBox();
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(700);
    await page.mouse.up();
  };

  try {
    await page.goto(BASE + '/', { timeout: 180000 });
    await tid('quick-jump-input').waitFor({ timeout: 180000 });

    // --- open several tabs ------------------------------------------------------------------
    const refs = [['שבת ב.', 'שבת'], ['ר"ה טז:', 'ראש השנה'], ['תענית ב.', 'תענית'], ['במדבר כז טו', 'במדבר'], ["בר' יב ה", 'בראשית']];
    for (const [q, title] of refs) {
      await tid('quick-jump-input').fill(q);
      await page.waitForFunction((t) => [...document.querySelectorAll('[data-testid="quick-jump-result"]')].some((e) => e.innerText.startsWith(t)), title, { timeout: 20000 });
      await page.locator('[data-testid="quick-jump-result"]', { hasText: title }).first().click();
      await page.waitForFunction((t) => (document.querySelector('[data-testid="reader-breadcrumb"]')?.innerText || '').startsWith(t), title, { timeout: 20000 });
      if (title !== 'בראשית') {
        await tid('reader-back').click();
        await tid('quick-jump-input').waitFor();
      }
    }
    assert.deepStrictEqual(await tabsInStore(), refs.map((r) => r[1]));
    assert.strictEqual((await tid('tabs-counter').innerText()).trim(), '5');
    // The active (newest) tab is scrolled into view and highlighted.
    const active = await tid('tab-' + (await page.evaluate(() => JSON.parse(localStorage.getItem('kodeshread.tabs')).state.tabs.at(-1).bookId)));
    assert.strictEqual(await active.getAttribute('aria-selected'), 'true');
    const ab = await active.boundingBox();
    const strip = await tid('tab-strip').boundingBox();
    assert.ok(ab.x >= strip.x - 1 && ab.x + ab.width <= strip.x + strip.width + 1, 'active tab visible in the strip');
    // The subtitle follows the saved reading position (written shortly after the jump settles).
    await page.waitForFunction(
      (id) => {
        const el = [...document.querySelectorAll(`[data-testid="tab-${id}"]`)].pop();
        return !!el && el.innerText.includes('בראשית') && el.innerText.includes('פרק יב');
      },
      await page.evaluate(() => JSON.parse(localStorage.getItem('kodeshread.tabs')).state.tabs.at(-1).bookId),
      { timeout: 10000 },
    );
    await shot('r1-tabs');
    step('tab bar: 5 tabs, counter, active tab in view with its section');

    // --- collapsible tools bar ------------------------------------------------------------------
    const toggle = tid('reader-tools-toggle');
    assert.strictEqual(await toggle.getAttribute('aria-expanded'), 'false', 'tools start collapsed');
    for (const id of ['toc-button', 'reader-search', 'toggle-cantillation', 'toggle-nikkud', 'aa-button']) assert.ok(!(await visible(id)), `${id} hidden while collapsed`);
    const textTop = async () => (await tid('reader-breadcrumb').boundingBox()).y;
    const collapsedTop = await textTop();
    await toggle.click();
    await tid('reader-tools').waitFor();
    for (const id of ['toc-button', 'reader-search', 'toggle-cantillation', 'toggle-nikkud', 'aa-button']) assert.ok(await visible(id), `${id} shown once expanded`);
    assert.strictEqual(await toggle.getAttribute('aria-expanded'), 'true');
    await page.waitForTimeout(250);
    const openTop = await textTop();
    assert.ok(openTop > collapsedTop + 25, `the text area gives the bar room (${collapsedTop} -> ${openTop})`);
    await shot('r1b-tools-open');
    await toggle.click();
    await page.waitForFunction(() => !document.querySelector('[data-testid="reader-tools"]'));
    assert.strictEqual(await toggle.getAttribute('aria-expanded'), 'false');
    assert.ok(!(await visible('toc-button')));
    await page.waitForTimeout(100);
    assert.ok(Math.abs((await textTop()) - collapsedTop) < 2, 'text back at full height');
    step(`reader tools bar: collapsed by default, toggles open / closed (text starts ${Math.round(openTop - collapsedTop)}px higher collapsed)`);

    // --- long-press actions ------------------------------------------------------------------
    const shabbatTab = page.locator('[data-testid^="tab-"][aria-selected]', { hasText: 'ראש השנה' }).last();
    await shabbatTab.scrollIntoViewIfNeeded();
    await longPress(shabbatTab);
    await tid('tab-menu').waitFor();
    await shot('r2-tab-menu');
    await tid('tab-action-close-left').click();
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('kodeshread.tabs')).state.tabs.length === 2);
    assert.deepStrictEqual(await tabsInStore(), ['שבת', 'ראש השנה'], 'tabs left of ראש השנה (after it, RTL) closed');
    assert.strictEqual((await tid('tabs-counter').innerText()).trim(), '2');
    step('long-press → close tabs to the left');

    // Re-open a few for the switcher.
    for (const [q, title] of [['במדבר כז טו', 'במדבר'], ['בראשית א', 'בראשית'], ['תענית ב.', 'תענית']]) {
      await tid('reader-back').click();
      await tid('quick-jump-input').fill(q);
      await page.waitForFunction((t) => [...document.querySelectorAll('[data-testid="quick-jump-result"]')].some((e) => e.innerText.startsWith(t)), title, { timeout: 20000 });
      await page.locator('[data-testid="quick-jump-result"]', { hasText: title }).first().click();
      await page.waitForFunction((t) => (document.querySelector('[data-testid="reader-breadcrumb"]')?.innerText || '').startsWith(t), title, { timeout: 20000 });
    }

    // --- switcher -----------------------------------------------------------------------------
    await tid('tabs-counter').click();
    await tid('tabs-filter').waitFor();
    const cards = async () => (await all('tab-card-').allInnerTexts()).filter((t) => t.trim() !== '×').map((t) => t.split('\n')[0]);
    assert.strictEqual((await cards())[0], 'תענית', 'most recent first');
    assert.strictEqual((await cards()).length, 5);
    await tid('tabs-filter').fill('ר"ה');
    await page.waitForFunction(() => document.querySelectorAll('[data-testid^="tab-card-close-"]').length === 1);
    assert.deepStrictEqual(await cards(), ['ראש השנה'], 'abbreviation filter');
    await tid('tabs-filter').fill('במד');
    await page.waitForFunction(() => document.querySelectorAll('[data-testid^="tab-card-close-"]').length === 1);
    assert.deepStrictEqual(await cards(), ['במדבר']);
    await shot('r3-switcher');
    await tid('tabs-filter').fill('');
    await page.locator('[data-testid^="tab-card-"]', { hasText: 'שבת' }).first().click();
    await page.waitForFunction(() => (document.querySelector('[data-testid="reader-breadcrumb"]')?.innerText || '').startsWith('שבת'));
    step('switcher: recent first, abbreviation filter, tap to switch');

    await tid('tabs-counter').click();
    await tid('tabs-close-others').click();
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('kodeshread.tabs')).state.tabs.length === 1);
    assert.deepStrictEqual(await tabsInStore(), ['שבת']);
    step('switcher: close other tabs');

    // --- TOC cascading columns ----------------------------------------------------------------
    await page.keyboard.press('Escape');
    await page.mouse.click(200, 120);
    await page.waitForTimeout(300);

    // A single-level book (שבת: one column of דפים, no inline verses): one slim column.
    await openToc(0);
    assert.strictEqual(await all('toc-col-1').count(), 0, 'no second column');
    const w1 = await tocWidth();
    assert.ok(w1 >= 180 && w1 <= 230, `1-level TOC fits its single column (${w1}px of 400)`);
    assert.ok(Math.abs((await colWidths())[0] - w1) <= 2, 'the column fills the drawer');
    const toc1 = await tid('toc-drawer').boundingBox();
    assert.ok(toc1.x + toc1.width >= 399, 'drawer slides over from the right edge');
    await assertRightAligned('phone, שבת');
    await shot('r3b-toc-1-level');
    await tid('toc-close').click();
    await page.waitForFunction(() => !document.querySelector('[data-testid="toc-col-0"]'));
    step(`TOC 1 level: ${Math.round(w1)}px drawer, labels flush right`);

    await tid('reader-back').click();
    await tid('quick-jump-input').fill('במדבר כז טו');
    await page.locator('[data-testid="quick-jump-result"]', { hasText: 'במדבר' }).first().click();
    await page.waitForFunction(() => (document.querySelector('[data-testid="reader-breadcrumb"]')?.innerText || '').includes('פרק כז'));
    await page.waitForTimeout(600);
    await openToc(1);
    const sel = async (col) => (await page.locator(`[data-testid="toc-col-${col}"] [aria-selected="true"]`).last().innerText()).trim();
    assert.strictEqual(await sel(0), 'פרק כז', 'current chapter pre-selected');
    assert.strictEqual(await sel(1), 'פסוק טו', 'current verse pre-selected');
    const [c0, c1] = [await tid('toc-col-0').boundingBox(), await tid('toc-col-1').boundingBox()];
    assert.ok(c1.x < c0.x, 'verses open to the LEFT of the chapters');
    // Fit to content: two slim columns (פרק / פסוק), wider than the 1-level drawer, far from full width.
    const w2 = await tocWidth();
    const cw = await colWidths();
    assert.strictEqual(cw.length, 2);
    assert.ok(cw.every((w) => w >= 100 && w <= 160), `short labels keep slim columns (${cw.map(Math.round)})`);
    assert.ok(Math.abs(cw[0] + cw[1] - w2) <= 2, `drawer = sum of its columns (${cw.map(Math.round)} vs ${w2})`);
    assert.ok(w2 > w1 + 15 && w2 <= 400 * 0.85, `2 columns widen the drawer (${w1} -> ${w2}, cap 340)`);
    const n = await assertRightAligned('phone, במדבר');
    await shot('r4-toc');
    step(`TOC fit-to-content: 2 columns ${cw.map(Math.round).join(' + ')} = ${Math.round(w2)}px (1 level: ${Math.round(w1)}px); ${n} labels flush right`);
    // Another chapter: one tap in the right column, which never moved.
    const ch3 = page.locator('[data-testid="toc-col-0"] [data-testid^="toc-node-"]', { hasText: /^פרק ג$/ }).last();
    await ch3.scrollIntoViewIfNeeded();
    await ch3.click();
    await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="toc-open-section"]')].some((e) => e.innerText.includes('פרק ג')));
    assert.ok((await all('toc-verse-').count()) > 5, 'chapter ג verses listed');
    await page.locator('[data-testid^="toc-verse-"]', { hasText: /^פסוק ד$/ }).last().click();
    await page.waitForFunction(() => !document.querySelector('[data-testid="toc-col-0"]'));
    await page.waitForFunction(() => (document.querySelector('[data-testid="reader-breadcrumb"]')?.innerText || '').includes('פרק ג'));
    step('TOC columns: synced to פרק כז › פסוק טו, verses open to the left, verse tap jumps and closes');

    // Quick filter: gematria / digits / chapter + verse.
    await openTools();
    await tid('toc-button').click();
    await tid('toc-filter').fill('כ"ה');
    await page.waitForFunction(() => [...document.querySelectorAll('[data-testid^="toc-result-"]')].some((e) => e.innerText.trim() === 'פרק כה'));
    await tid('toc-filter').fill('25');
    await page.waitForFunction(() => [...document.querySelectorAll('[data-testid^="toc-result-"]')].some((e) => e.innerText.trim() === 'פרק כה'));
    await tid('toc-filter').fill('כז טו');
    await tid('toc-filter-direct').waitFor({ timeout: 10000 });
    assert.ok((await tid('toc-filter-direct').innerText()).includes('פרק כז › פסוק טו'));
    await shot('r5-toc-filter');
    await tid('toc-filter-direct').click();
    await page.waitForFunction(() => (document.querySelector('[data-testid="reader-breadcrumb"]')?.innerText || '').includes('פרק כז'));
    step('TOC filter: כ"ה / 25 / "כז טו" (chapter + verse)');

    // --- close all with confirmation ----------------------------------------------------------
    await tid('tabs-counter').click();
    await tid('tabs-close-all').click();
    assert.strictEqual(await all('tab-card-close-').count(), 2, 'first tap only asks for confirmation');
    await tid('tabs-close-all-confirm').click();
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('kodeshread.tabs')).state.tabs.length === 0);
    step('switcher: close all (with confirmation)');

    // --- commentary favorites follow the commentator across books / tabs ---------------------
    const drawerNames = () => page.locator('[data-testid="commentary-group-name"]').allInnerTexts();
    const openDrawer = async (minGroups) => {
      await tid('para-3').waitFor({ timeout: 20000 });
      if (!(await page.locator('[data-testid="commentary-pane"]').count())) await tid('para-3').click();
      await page.waitForFunction((n) => document.querySelectorAll('[data-testid="commentary-group"]').length >= n, minGroups, { timeout: 10000 });
    };
    const pinOf = (name) =>
      page.locator('[data-testid="commentary-group"]', { has: page.locator(`[data-testid="commentary-group-name"]:text-is('${name}')`) }).locator('[data-testid="commentary-pin"]');
    await page.evaluate(() => localStorage.removeItem('kodeshread.commentary'));
    await page.goto(BASE + '/', { timeout: 180000 });
    await tid('quick-jump-input').waitFor({ timeout: 180000 });
    await tid('quick-jump-input').fill('בראשית א');
    await page.locator('[data-testid="quick-jump-result"]', { hasText: 'בראשית' }).first().click();
    await openDrawer(8);
    assert.strictEqual((await drawerNames())[0], 'אונקלוס', 'Tanach: Onkelos heads the core list');
    await pinOf('רמב"ן').click();
    await page.waitForFunction(() => document.querySelector('[data-testid="commentary-group-name"]')?.innerText === 'רמב"ן');
    // Another book (Bavli, its own Otzaria title "רש"י על שבת"): the ⭐ on רש"י follows the commentator.
    await pinOf('רש"י').click();
    await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="commentary-group-name"]')].map((e) => e.innerText).slice(0, 2).join('|') === 'רמב"ן|רש"י');
    await tid('reader-back').click();
    await tid('quick-jump-input').fill('שבת ב.');
    await page.locator('[data-testid="quick-jump-result"]', { hasText: 'שבת' }).first().click();
    await page.waitForFunction(() => (document.querySelector('[data-testid="reader-breadcrumb"]')?.innerText || '').startsWith('שבת'));
    await openDrawer(2);
    assert.deepStrictEqual(await drawerNames(), ['רש"י', 'תוספות']);
    assert.strictEqual(await pinOf('רש"י').getAttribute('aria-pressed'), 'true', 'רש"י is a favorite in שבת too');
    assert.strictEqual(await pinOf('תוספות').getAttribute('aria-pressed'), 'false');
    // Pin תוספות here too: favorites keep their pin order (רש"י was pinned first)...
    await pinOf('תוספות').click();
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="commentary-pin"][aria-pressed="true"]').length === 2);
    assert.deepStrictEqual(await drawerNames(), ['רש"י', 'תוספות']);
    await shot('r7-commentary-pins');
    // ...and back in the בראשית tab the favorites still lead, in pin order.
    await page.locator('[data-testid^="tab-"][aria-selected]', { hasText: 'בראשית' }).last().click();
    await page.waitForFunction(() => (document.querySelector('[data-testid="reader-breadcrumb"]')?.innerText || '').startsWith('בראשית'));
    await openDrawer(8);
    assert.deepStrictEqual((await drawerNames()).slice(0, 3), ['רמב"ן', 'רש"י', 'אונקלוס']);
    assert.deepStrictEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('kodeshread.commentary')).state.pinned), ['רמבנ', 'רשי', 'תוספות']);
    await tid('commentary-close').click();
    step('commentary ⭐ favorites persist and follow the commentator across books and tabs');

    // --- tablet: docked TOC stays open after a jump -------------------------------------------
    await page.setViewportSize({ width: 1180, height: 820 });
    await page.goto(BASE + '/reader', { timeout: 180000 }).catch(() => undefined);
    await page.goto(BASE + '/', { timeout: 180000 });
    await tid('quick-jump-input').waitFor({ timeout: 180000 });
    await tid('quick-jump-input').fill('בראשית א');
    await page.locator('[data-testid="quick-jump-result"]', { hasText: 'בראשית' }).first().click();
    assert.strictEqual(await tid('reader-tools-toggle').getAttribute('aria-expanded'), 'false', 'tools collapsed on tablet too');
    await openToc(1);
    const reader = await tid('reader-list').boundingBox();
    const toc = await tid('toc-drawer').boundingBox();
    assert.ok(toc.x > reader.x, 'docked at the right (start) side, beside the text');
    const tcw = await colWidths();
    assert.ok(Math.abs(tcw[0] + tcw[1] - toc.width) <= 3 && toc.width <= 1180 * 0.42, `docked panel fits its columns (${tcw.map(Math.round)} vs ${toc.width})`);
    assert.ok(reader.width > 1180 - 300, `the text keeps the room (${reader.width}px)`);
    await assertRightAligned('tablet, בראשית');
    await page.locator('[data-testid^="toc-verse-"]', { hasText: /^פסוק ג$/ }).last().click();
    await page.waitForTimeout(500);
    assert.ok(await tid('toc-col-1').isVisible(), 'docked TOC stays open after a jump');
    await shot('r6-tablet');
    step(`tablet: TOC docked beside the text (${Math.round(toc.width)}px, fit to its columns), stays open, labels flush right`);

    const real = errors.filter((e) => !/favicon|DevTools|Download the React DevTools|FTS5/.test(e));
    assert.deepStrictEqual(real, [], 'console errors');
    console.log('\ne2e reader: all passed');
  } catch (e) {
    await shot('failure');
    console.error('✗', e.message);
    if (errors.length) console.error('console errors:', errors.slice(0, 5));
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();
