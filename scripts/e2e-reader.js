#!/usr/bin/env node
/**
 * End-to-end check of the reader's tab management, the collapsible reader tools bar, the
 * cascading-columns TOC (fit-to-content widths, right-aligned labels on phone and tablet),
 * commentary favorites (⭐) following a commentator across books and tabs, and the reading
 * typography: Taamey Frank CLM loaded via @font-face, vocalization-aware line height with no
 * mark collisions, margin verse numbers, the טעמי פרנק / מערכת font picker and the בהיר / ספיה /
 * כהה themes persisted across reloads and applied to reader, commentary drawer, TOC and library
 * (web preview). With --shots, tanach-light.png / tanach-dark.png show Genesis 1 with
 * cantillation and niqqud in both themes (device scale 2).
 * Torah study: inline parsha / aliyah dividers in a Chumash book (none elsewhere), the TOC's
 * פרקים | פרשות switch (parshiot column + aliyot column, synced to the reading position, exact
 * verse jumps, persisted mode), no "לימוד יומי" inside the TOC drawer (it lives on the Library
 * screen only), and the Quick Source Opener jumping to a parsha / aliyah ("פרשת וישלח שני",
 * "בלק 3", "בראשית מפטיר") at its exact verse.
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
  const page = await browser.newPage({ viewport: { width: 400, height: 820 }, deviceScaleFactor: SHOTS ? 2 : 1 });
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
          const box = el.closest('[data-testid^="toc-node-"], [data-testid^="toc-verse-"], [data-testid^="toc-result-"], [data-testid="toc-open-section"], [data-testid^="toc-parsha-"], [data-testid^="toc-aliyah-"]').getBoundingClientRect();
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
  /** The TOC drawer navigates the current book only: no "לימוד יומי" block in it. */
  const assertNoDailyInToc = async (where) => {
    const found = await page.evaluate(() => {
      const drawer = [...document.querySelectorAll('[data-testid="toc-drawer"]')].pop();
      if (!drawer) return 'no drawer';
      const ids = ['toc-daily', 'toc-daily-toggle', 'daily-list', 'daily-hebrew-date', 'daily-item-parasha'].filter((id) => drawer.querySelector(`[data-testid="${id}"]`));
      return ids.length ? ids.join(',') : drawer.innerText.includes('לימוד יומי') ? 'text "לימוד יומי"' : '';
    });
    assert.strictEqual(found, '', `${where}: daily learning must not render inside the TOC drawer`);
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
    // Right-aligned Hebrew: the filter input and every tab card / tab pill label.
    const aligns = await page.evaluate(() => {
      const top = (sel) => [...document.querySelectorAll(sel)].pop();
      const leafTexts = (root) => [...root.querySelectorAll('div, span')].filter((e) => !e.children.length && /[א-ת]/.test(e.innerText || '') && e.getBoundingClientRect().height > 0);
      const sheetCards = [...document.querySelectorAll('[data-testid^="tab-card-"]')].filter((e) => !/close/.test(e.dataset.testid));
      return {
        filter: getComputedStyle(top('[data-testid="tabs-filter"]')).textAlign,
        cards: sheetCards.flatMap(leafTexts).map((e) => getComputedStyle(e).textAlign),
        strip: leafTexts(top('[data-testid="tab-strip"]')).map((e) => getComputedStyle(e).textAlign),
      };
    });
    assert.strictEqual(aligns.filter, 'right', 'tabs filter input right-aligned');
    assert.ok(aligns.strip.length >= 5 && aligns.strip.every((a) => a === 'right'), `tab strip labels right-aligned (${aligns.strip})`);
    assert.ok(aligns.cards.length >= 5 && aligns.cards.filter((a) => a === 'right').length >= 5, `switcher card locations right-aligned (${aligns.cards})`);
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

    // --- Torah: פרקים | פרשות in the Chumash TOC, inline parsha / aliyah dividers --------------
    /** Text of the verse-number margin of the row a divider sits above. */
    const dividerInfo = (kind) =>
      page.evaluate((k) => {
        const els = [...document.querySelectorAll(`[data-testid^="${k}-divider-"]`)].filter((e) => e.getBoundingClientRect().height > 0);
        return els.map((e) => {
          const line = e.dataset.testid.split('-').pop();
          const num = document.querySelector(`[data-testid="verse-num-${line}"]`);
          const para = document.querySelector(`[data-testid="para-${line}"]`);
          const r = e.getBoundingClientRect();
          return { line: Number(line), text: e.innerText.trim(), verse: num ? num.innerText.trim() : null, above: para ? r.bottom <= para.getBoundingClientRect().top + 1 : false, top: r.top };
        });
      }, kind);
    await openTools();
    await tid('toc-button').click();
    await tid('toc-mode-chapters').waitFor();
    assert.strictEqual(await tid('toc-mode-chapters').getAttribute('aria-checked'), 'true', 'chapters mode by default');
    await assertNoDailyInToc('Chumash TOC');
    const [mc, mp] = [await tid('toc-mode-chapters').boundingBox(), await tid('toc-mode-parshiot').boundingBox()];
    assert.ok(mc.x > mp.x, 'RTL: פרקים on the right, פרשות on the left');
    await tid('toc-mode-parshiot').click();
    await tid('toc-pcol-1').waitFor();
    await page.waitForTimeout(450);
    const psel = async (col) => (await page.locator(`[data-testid="toc-pcol-${col}"] [aria-selected="true"] [data-testid="toc-label"]`).last().innerText()).trim();
    // במדבר כז טו: פרשת פינחס (כה י – ל א), aliyah רביעי (כז ו).
    assert.strictEqual(await psel(0), 'פינחס', 'current parsha pre-selected');
    assert.strictEqual(await psel(1), 'רביעי', 'current aliyah pre-selected');
    const parshaNames = (await page.locator('[data-testid="toc-pcol-0"] [data-testid="toc-label"]').allInnerTexts()).map((t) => t.trim());
    assert.deepStrictEqual(parshaNames, ['במדבר', 'נשא', 'בהעלותך', 'שלח', 'קרח', 'חקת', 'בלק', 'פינחס', 'מטות', 'מסעי']);
    const aliyot = (await page.locator('[data-testid="toc-pcol-1"] [data-testid="toc-label"]').allInnerTexts()).map((t) => t.trim());
    assert.deepStrictEqual(aliyot, ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שביעי', 'מפטיר']);
    const [p0, p1] = [await tid('toc-pcol-0').boundingBox(), await tid('toc-pcol-1').boundingBox()];
    assert.ok(p1.x < p0.x, 'aliyot open to the LEFT of the parshiot');
    const pw = await tocWidth();
    assert.ok(Math.abs(p0.width + p1.width - pw) <= 2 && pw <= 400 * 0.85, `drawer fits its two columns (${Math.round(p0.width)} + ${Math.round(p1.width)} = ${Math.round(pw)})`);
    const pn = await assertRightAligned('phone, פרשות');
    await shot('r5b-toc-parshiot');
    // Another parsha, then an aliyah: exact verse, with its divider right above it.
    await tid('toc-parsha-39').click();
    await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="toc-parsha-open"]')].some((e) => e.innerText.includes('פרשת בלק')));
    await tid('toc-aliyah-39-2').click();
    await page.waitForFunction(() => !document.querySelector('[data-testid="toc-pcol-0"]'));
    await page.waitForFunction(() => (document.querySelector('[data-testid="reader-breadcrumb"]')?.innerText || '').includes('פרק כב'));
    await page.waitForTimeout(500);
    let dv = (await dividerInfo('aliyah')).find((d) => d.text === 'שלישי');
    assert.ok(dv && dv.verse === 'כא' && dv.above, `"שלישי" divider above במדבר כב כא: ${JSON.stringify(await dividerInfo('aliyah'))}`);
    const crumbY = (await tid('reader-breadcrumb').boundingBox()).y + 40;
    assert.ok(dv.top >= crumbY - 4 && dv.top < crumbY + 120, `the jump lands the aliyah at the reading line (${Math.round(dv.top)} vs ${Math.round(crumbY)})`);
    await shot('r5c-aliyah-divider');
    // "לתחילת פרשת בלק": the parsha divider above כב ב (פרשות mode is remembered).
    await openTools();
    await tid('toc-button').click();
    await tid('toc-pcol-1').waitFor();
    assert.strictEqual(await psel(0), 'בלק');
    assert.strictEqual(await psel(1), 'שלישי');
    await tid('toc-parsha-open').click();
    await page.waitForFunction(() => !document.querySelector('[data-testid="toc-pcol-0"]'));
    await page.waitForTimeout(500);
    dv = (await dividerInfo('parsha')).find((d) => d.text === 'פרשת בלק');
    assert.ok(dv && dv.verse === 'ב' && dv.above, `"פרשת בלק" divider above במדבר כב ב: ${JSON.stringify(await dividerInfo('parsha'))}`);
    assert.ok((await crumb()).includes('פרק כב'));
    // Dividers are decoration: the verses around it keep their stored lines (כב א = L-1, כב ג = L+1).
    const around = await page.evaluate((l) => [l - 1, l + 1].map((n) => [...document.querySelectorAll(`[data-testid="verse-num-${n}"]`)].pop()?.innerText.trim() ?? null), dv.line);
    assert.deepStrictEqual(around, ['א', 'ג'], 'neighbouring verses keep their line indices');
    await shot('r5d-parsha-divider');
    assert.strictEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('kodeshread.learning')).state.tocMode), 'parshiot', 'TOC mode persisted');
    await openTools();
    await tid('toc-button').click();
    await tid('toc-mode-chapters').click();
    await tid('toc-col-0').waitFor();
    assert.ok((await sel(0)).startsWith('פרק'), 'back to chapters');
    await tid('toc-close').click();
    await page.waitForFunction(() => !document.querySelector('[data-testid="toc-col-0"]'));
    // Not a Chumash (שבת): no switch, no dividers.
    const shabbatId = await page.evaluate(() => JSON.parse(localStorage.getItem('kodeshread.tabs')).state.tabs.find((t) => t.bookTitle === 'שבת').bookId);
    await tid(`tab-${shabbatId}`).click();
    await page.waitForFunction(() => (document.querySelector('[data-testid="reader-breadcrumb"]')?.innerText || '').startsWith('שבת'));
    await openToc(0);
    assert.strictEqual(await all('toc-mode-parshiot').count(), 0, 'no פרשות switch outside the Chumash');
    await assertNoDailyInToc('שבת TOC');
    assert.strictEqual(await all('torah-divider-').count(), 0, 'no dividers outside the Chumash');
    await tid('toc-close').click();
    await page.waitForFunction(() => !document.querySelector('[data-testid="toc-col-0"]'));
    step(`Chumash TOC: פרקים | פרשות (פינחס › רביעי pre-selected, ${pn} labels flush right); בלק › שלישי and לתחילת פרשת בלק land on their verses under inline dividers; none in שבת`);

    // --- close all with confirmation ----------------------------------------------------------
    await tid('tabs-counter').click();
    await tid('tabs-close-all').click();
    assert.strictEqual(await all('tab-card-close-').count(), 2, 'first tap only asks for confirmation');
    await tid('tabs-close-all-confirm').click();
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('kodeshread.tabs')).state.tabs.length === 0);
    step('switcher: close all (with confirmation)');

    // --- Quick Source Opener: parsha / aliyah -------------------------------------------------
    await tid('reader-back').click();
    await tid('quick-jump-input').waitFor();
    const directText = () => tid('quick-jump-direct-text').innerText().then((t) => t.trim());
    const waitDirect = (text) => page.waitForFunction((t) => ([...document.querySelectorAll('[data-testid="quick-jump-direct-text"]')].pop()?.innerText || '').trim() === t, text, { timeout: 20000 });
    await tid('quick-jump-input').fill('פרשת וישלח שני');
    await waitDirect('פתח: פרשת וישלח · שני (בראשית ל״ב:י״ד)');
    assert.strictEqual((await tid('quick-jump-parsha-title').innerText()).replace(/\s+/g, ' ').trim(), 'פרשת וישלח · שני');
    assert.strictEqual((await tid('quick-jump-parsha-ref').innerText()).trim(), 'בראשית ל״ב:י״ד');
    const qjAlign = await page.evaluate(() =>
      ['quick-jump-parsha-title', 'quick-jump-parsha-ref', 'quick-jump-direct-text'].map((id) => {
        const el = [...document.querySelectorAll(`[data-testid="${id}"]`)].pop();
        const r = document.createRange();
        r.selectNodeContents(el);
        return { id, align: getComputedStyle(el).textAlign, dir: getComputedStyle(el).direction, gap: el.getBoundingClientRect().right - r.getBoundingClientRect().right };
      }),
    );
    assert.ok(qjAlign.every((a) => a.align === 'right' && a.dir === 'rtl' && a.gap <= 2), `parsha card right-aligned: ${JSON.stringify(qjAlign)}`);
    await shot('r5e-quick-jump-parsha');
    await tid('quick-jump-direct').click();
    await page.waitForFunction(() => /^בראשית/.test(document.querySelector('[data-testid="reader-breadcrumb"]')?.innerText || '') && document.querySelector('[data-testid="reader-breadcrumb"]').innerText.includes('פרק לב'), null, { timeout: 20000 });
    await page.waitForTimeout(500);
    dv = (await dividerInfo('aliyah')).find((d) => d.text === 'שני');
    assert.ok(dv && dv.verse === 'יד' && dv.above, `"פרשת וישלח שני" lands on בראשית לב יד under its divider: ${JSON.stringify(await dividerInfo('aliyah'))}`);
    const hl = await page.evaluate((l) => {
      const glow = [...document.querySelectorAll(`[data-testid="para-${l}"]`)].pop()?.querySelector('div[style*="opacity"]');
      return glow ? Number(getComputedStyle(glow).opacity) : 0;
    }, dv.line);
    assert.ok(hl > 0, 'the target verse is highlighted');
    await shot('r5f-quick-jump-landed');
    // Digits + another book: "בלק 3" -> במדבר כב כא (שלישי).
    await tid('reader-back').click();
    await tid('quick-jump-input').fill('בלק 3');
    await waitDirect('פתח: פרשת בלק · שלישי (במדבר כ״ב:כ״א)');
    await tid('quick-jump-direct').click();
    await page.waitForFunction(() => /^במדבר/.test(document.querySelector('[data-testid="reader-breadcrumb"]')?.innerText || '') && document.querySelector('[data-testid="reader-breadcrumb"]').innerText.includes('פרק כב'), null, { timeout: 20000 });
    await page.waitForTimeout(500);
    dv = (await dividerInfo('aliyah')).find((d) => d.text === 'שלישי');
    assert.ok(dv && dv.verse === 'כא' && dv.above, 'בלק 3 -> במדבר כב כא');
    // A book name stays a book lookup; with "מפטיר" it is the parsha.
    await tid('reader-back').click();
    await tid('quick-jump-input').fill('בראשית א');
    await page.waitForFunction(() => ([...document.querySelectorAll('[data-testid="quick-jump-direct-text"]')].pop()?.innerText || '').includes('פרק א'), null, { timeout: 20000 });
    assert.strictEqual(await all('quick-jump-parsha').count(), 0, '"בראשית א" is chapter א, no parsha card');
    await tid('quick-jump-input').fill('בראשית מפטיר');
    await waitDirect('פתח: פרשת בראשית · מפטיר (בראשית ו׳:ה׳)');
    assert.ok((await directText()).includes('מפטיר'));
    await tid('quick-jump-input').fill('');
    assert.deepStrictEqual(await tabsInStore(), ['בראשית', 'במדבר'], 'parsha jumps open / re-use the Chumash tabs');
    await tid('open-workspace').click();
    await tid('tabs-counter').click();
    await tid('tabs-close-all').click();
    await tid('tabs-close-all-confirm').click();
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('kodeshread.tabs')).state.tabs.length === 0);
    step('Quick Source Opener: "פרשת וישלח שני" / "בלק 3" land on their verses (right-aligned "פרשת וישלח · שני (בראשית ל״ב:י״ד)" card); "בראשית א" stays a chapter, "בראשית מפטיר" is the parsha');

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

    // --- typography: Taamey Frank CLM, leading, verse numbers, font picker, themes -------------
    const appearance = () => page.evaluate(() => JSON.parse(localStorage.getItem('kodeshread.appearance') || '{}'));
    /** Background actually painted under an element (first non-transparent ancestor). */
    const paintedBg = (id) =>
      page.evaluate((testId) => {
        // By id, or the element on top at a point ([x, y]).
        let el = Array.isArray(testId) ? document.elementFromPoint(testId[0], testId[1]) : [...document.querySelectorAll(`[data-testid="${testId}"]`)].pop();
        for (; el; el = el.parentElement) {
          const bg = getComputedStyle(el).backgroundColor;
          if (bg && bg !== 'transparent' && !/rgba\(.*, 0\)$/.test(bg)) return bg;
        }
        return null;
      }, id);
    const verseMetrics = () =>
      page.evaluate(() => {
        // The visible reader (expo-router web can keep a hidden copy of a screen underneath).
        const list = [...document.querySelectorAll('[data-testid="reader-list"]')].pop();
        const top = (sel) => list.querySelector(sel);
        const rows = [...list.querySelectorAll('[data-testid^="verse-text-"]')].filter((e) => e.getBoundingClientRect().height > 0);
        const first = rows[0];
        const cs = getComputedStyle(first);
        const fontSize = parseFloat(cs.fontSize);
        const lineHeight = parseFloat(cs.lineHeight);
        // Ink extent of every visible verse in this font (marks included) vs the line box.
        const ctx = document.createElement('canvas').getContext('2d');
        ctx.font = `${cs.fontSize} ${cs.fontFamily}`;
        let ink = 0;
        let worst = '';
        for (const r of rows) {
          for (const word of r.innerText.split(/\s+/)) {
            const m = ctx.measureText(word);
            const h = m.actualBoundingBoxAscent + m.actualBoundingBoxDescent;
            if (h > ink) [ink, worst] = [h, word];
          }
        }
        const num = top(`[data-testid="verse-num-${first.dataset.testid.slice('verse-text-'.length)}"]`);
        const nb = num.getBoundingClientRect();
        const tb = first.getBoundingClientRect();
        return {
          family: cs.fontFamily,
          fontSize,
          lineHeight,
          ink,
          worst,
          rows: rows.length,
          num: num.innerText.trim(),
          numColor: getComputedStyle(num).color,
          textColor: cs.color,
          numRightOfText: nb.left >= tb.right - 1,
          numSize: parseFloat(getComputedStyle(num).fontSize),
          // Verse number vertically centred on the first text line.
          numOffset: Math.abs(nb.top + nb.height / 2 - (tb.top + lineHeight / 2)),
          fontLoaded: document.fonts.check(`${cs.fontSize} "TaameyFrankCLM-Medium"`),
          faces: [...document.fonts].filter((f) => /TaameyFrank/.test(f.family)).map((f) => `${f.family}:${f.status}`),
        };
      });
    await page.locator('[data-testid^="tab-"][aria-selected]', { hasText: 'בראשית' }).last().click();
    await tid('reader-back').click();
    await tid('quick-jump-input').fill('בראשית א');
    await page.locator('[data-testid="quick-jump-result"]', { hasText: 'בראשית' }).first().click();
    await tid('verse-num-3').waitFor({ timeout: 20000 });
    await page.evaluate(() => document.fonts.ready);
    let vm = await verseMetrics();
    assert.ok(/TaameyFrankCLM-Medium/.test(vm.family), `reader font: ${vm.family}`);
    assert.ok(vm.fontLoaded && vm.faces.some((f) => f === 'TaameyFrankCLM-Medium:loaded'), `@font-face loaded (${vm.faces})`);
    assert.strictEqual(vm.lineHeight, Math.ceil(vm.fontSize * 1.85), `te'amim leading 1.85x (${vm.lineHeight}px at ${vm.fontSize}px)`);
    assert.ok(vm.ink < vm.lineHeight, `zero collisions: tallest word "${vm.worst}" inks ${vm.ink.toFixed(1)}px < ${vm.lineHeight}px line box`);
    assert.strictEqual(vm.num, 'א', 'verse number split off');
    assert.ok(vm.numRightOfText, 'verse number in the right margin');
    assert.ok(vm.numSize < vm.fontSize * 0.7 && vm.numColor !== vm.textColor, `verse number subtle (${vm.numSize}px, ${vm.numColor})`);
    assert.ok(vm.numOffset <= 3, `verse number centred on the first line (${vm.numOffset.toFixed(1)}px)`);
    assert.ok(!(await tid('verse-text-3').innerText()).includes('(א)'), 'the text no longer repeats "(א)"');
    if (await page.locator('[data-testid="commentary-pane"]').count()) await tid('commentary-close').click();
    await page.waitForTimeout(2300); // the jump-target glow fades out
    await shot('tanach-light');
    // Leading follows the visible marks.
    await openTools();
    await tid('toggle-cantillation').click();
    await page.waitForFunction((px) => parseFloat(getComputedStyle([...document.querySelectorAll('[data-testid="verse-text-3"]')].pop()).lineHeight) === px, Math.ceil(vm.fontSize * 1.75));
    await tid('toggle-nikkud').click();
    await page.waitForFunction((px) => parseFloat(getComputedStyle([...document.querySelectorAll('[data-testid="verse-text-3"]')].pop()).lineHeight) === px, Math.ceil(vm.fontSize * 1.55));
    await tid('toggle-cantillation').click(); // brings niqqud + te'amim back
    await page.waitForFunction((px) => parseFloat(getComputedStyle([...document.querySelectorAll('[data-testid="verse-text-3"]')].pop()).lineHeight) === px, Math.ceil(vm.fontSize * 1.85));
    step(`typography: Taamey Frank CLM via @font-face, ${vm.lineHeight}px leading at ${vm.fontSize}px (ink ${vm.ink.toFixed(1)}px), 1.85 / 1.75 / 1.55 with te'amim / niqqud / plain, margin verse numbers`);

    // Aa: font picker + 3-way theme switcher, persisted across a reload.
    await tid('aa-button').click();
    await tid('appearance-sheet').waitFor();
    for (const id of ['theme-light', 'theme-sepia', 'theme-dark', 'font-taameyFrank', 'font-system']) assert.ok(await visible(id), `${id} in the Aa panel`);
    assert.strictEqual(await tid('font-taameyFrank').getAttribute('aria-checked'), 'true', 'טעמי פרנק is the default');
    assert.ok((await tid('font-taameyFrank').innerText()).includes('טעמי פרנק') && (await tid('font-system').innerText()).includes('מערכת'));
    assert.ok((await tid('line-height-value').innerText()).startsWith('1.85'), await tid('line-height-value').innerText());
    await tid('font-system').click();
    await page.waitForFunction(() => !/TaameyFrank/.test(getComputedStyle([...document.querySelectorAll('[data-testid="verse-text-3"]')].pop()).fontFamily));
    await tid('theme-dark').click();
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('kodeshread.appearance')).state.theme === 'dark');
    await shot('r8-appearance-dark');
    assert.deepStrictEqual([(await appearance()).state.fontFamily, (await appearance()).state.theme], ['system', 'dark']);
    await page.reload({ timeout: 180000 });
    await tid('verse-num-3').waitFor({ timeout: 180000 });
    assert.deepStrictEqual([(await appearance()).state.fontFamily, (await appearance()).state.theme, (await appearance()).version], ['system', 'dark', 3], 'persisted');
    vm = await verseMetrics();
    assert.ok(!/TaameyFrank/.test(vm.family), `system font after reload (${vm.family})`);
    assert.strictEqual(await paintedBg('reader-list'), 'rgb(33, 33, 33)', 'dark charcoal reader');
    assert.strictEqual(vm.textColor, 'rgb(232, 230, 227)', 'warm off-white text');
    // Back to טעמי פרנק for the dark screenshot.
    await openTools();
    await tid('aa-button').click();
    await tid('font-taameyFrank').click();
    await page.waitForFunction(() => /TaameyFrank/.test(getComputedStyle([...document.querySelectorAll('[data-testid="verse-text-3"]')].pop()).fontFamily));
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('[data-testid="appearance-sheet"]'), null, { timeout: 5000 }).catch(() => undefined);
    if (await page.locator('[data-testid="appearance-sheet"]').count()) await page.mouse.click(200, 60);
    await page.waitForTimeout(300);
    await tid('reader-tools-toggle').click();
    await page.waitForFunction(() => !document.querySelector('[data-testid="reader-tools"]'));
    vm = await verseMetrics();
    assert.ok(vm.ink < vm.lineHeight, 'dark: no collisions');
    await shot('tanach-dark');
    // The theme reaches the commentary drawer (active verse in slate / indigo), the TOC and the library.
    await tid('para-3').click();
    await tid('commentary-pane').waitFor({ timeout: 10000 });
    const activeBg = await page.evaluate(() => getComputedStyle([...document.querySelectorAll('[data-testid="para-3"]')].pop()).backgroundColor);
    assert.strictEqual(activeBg, 'rgb(45, 51, 71)', `active verse highlight ${activeBg}`);
    const paneBg = await paintedBg('commentary-pane');
    assert.ok(['rgb(33, 33, 33)', 'rgb(42, 42, 42)', 'rgb(48, 48, 48)'].includes(paneBg), `commentary drawer ${paneBg}`);
    await shot('r9-dark-commentary');
    await tid('commentary-close').click();
    await openToc(0);
    const tocBg = await paintedBg('toc-col-0');
    assert.ok(['rgb(33, 33, 33)', 'rgb(42, 42, 42)', 'rgb(48, 48, 48)'].includes(tocBg), `TOC ${tocBg}`);
    await tid('toc-close').click();
    await tid('reader-back').click();
    await tid('quick-jump-input').waitFor();
    const libBg = await paintedBg([100, 600]);
    assert.ok(['rgb(33, 33, 33)', 'rgb(42, 42, 42)'].includes(libBg), `library ${libBg}`);
    const jumpBg = await paintedBg('quick-jump-input');
    assert.ok(['rgb(42, 42, 42)', 'rgb(33, 33, 33)'].includes(jumpBg), `quick jump bar ${jumpBg}`);
    await shot('r10-dark-library');
    // Back to the defaults for the rest of the run.
    await page.evaluate(() => {
      const a = JSON.parse(localStorage.getItem('kodeshread.appearance'));
      a.state.theme = 'light';
      localStorage.setItem('kodeshread.appearance', JSON.stringify(a));
    });
    step(`themes: font + theme persist across reload; Dark charcoal reaches reader (${activeBg} active verse), commentary drawer, TOC and library`);

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
    await assertNoDailyInToc('docked TOC');
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
