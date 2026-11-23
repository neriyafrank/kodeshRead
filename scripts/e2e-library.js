#!/usr/bin/env node
/**
 * End-to-end check of the Library & Updates Manager and the first-launch onboarding card
 * in the web preview (Playwright).
 *
 *   npm run web                          # terminal 1 (Metro on :8081, sample DB as core)
 *   npm run e2e:library [-- --shots=DIR] # terminal 2
 *
 * The browser has no file system, so download / import buttons are disabled there; this
 * covers the screen, the core-library stats, removing the core library (-> onboarding
 * card, personal library untouched) and restoring it on reload. Downloading, verifying
 * and indexing are covered in Node by `npm test`.
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
  page.on('dialog', (d) => d.accept());
  const tid = (id) => page.locator(`[data-testid="${id}"]`);
  const shot = (name) => (SHOTS ? page.screenshot({ path: `${SHOTS}/${name}.png` }) : null);
  const step = (name) => console.log(`✓ ${name}`);

  try {
    await page.goto(BASE + '/', { timeout: 180000 });
    await tid('open-library-manager').waitFor({ timeout: 180000 });
    assert.strictEqual(await tid('onboarding-card').count(), 0, 'no onboarding while a core library exists');
    step('library screen has the manager button, no onboarding');


    await tid('open-library-manager').click();
    await tid('core-info').waitFor();
    const stats = await tid('core-info').innerText();
    const sampleBooks = require('fs')
      .readdirSync(require('path').join(__dirname, '..', 'raw_library', 'sample'), { recursive: true })
      .filter((f) => String(f).endsWith('.txt')).length;
    assert.ok(new RegExp(`ספרים\\s*${sampleBooks}\\b`).test(stats), `core stats (${sampleBooks} sample books): ${stats}`);
    assert.ok(/sample/.test(stats), 'source shown');
    const url = await tid('manifest-url').inputValue();
    assert.ok(/releases\/latest\/download\/manifest\.json$/.test(url), url);
    assert.strictEqual(await tid('download-core').getAttribute('aria-disabled'), 'true', 'download disabled on web');
    assert.strictEqual(await tid('import-files').getAttribute('aria-disabled'), 'true', 'import disabled on web');
    await shot('manager');
    step('manager shows installed core library + release URL');

    await tid('remove-core').click();
    await tid('job-result').waitFor();
    assert.ok((await tid('job-result').innerText()).includes('הוסרה'));
    assert.strictEqual(await tid('core-info').count(), 0);
    step('core library removed (personal library kept)');

    await page.goBack();
    await tid('onboarding-card').waitFor();
    assert.ok((await tid('onboarding-download').innerText()).includes('הורד ספרייה מוכנה מהענן'));
    assert.ok((await tid('onboarding-import').innerText()).includes('ייבא ספרים מהמכשיר'));
    await shot('onboarding');
    step('onboarding card offers download / import');

    await tid('onboarding-import').click();
    await tid('library-manager').waitFor();
    step('import choice opens the manager');

    await page.goto(BASE + '/', { timeout: 180000 });
    await tid('tree-cat-1').waitFor({ timeout: 180000 });
    assert.strictEqual(await tid('onboarding-card').count(), 0);
    step('web preview restores the sample library on reload');

    // --- RTL cascading columns -------------------------------------------------------------
    // (Runs after the manager flow: no saved column path yet.)
    await tid('tree-cat-1').waitFor({ timeout: 180000 });
    const box = async (id) => tid(id).boundingBox();
    assert.strictEqual(await tid('library-column-1').count(), 0, 'only the root column at first');
    const root0 = await box('library-column-0');
    assert.ok(root0.x + root0.width > 380, 'root column hugs the right edge');
    await tid('tree-cat-1').click(); // תנך
    await tid('library-column-1').waitFor();
    assert.strictEqual(await tid('tree-cat-1').getAttribute('aria-selected'), 'true', 'active folder highlighted');
    const sub = page.locator('[data-testid="library-column-1"] [data-testid^="tree-cat-"]').first();
    const subName = (await sub.innerText()).split('\n')[0];
    await sub.click();
    await tid('library-column-2').waitFor();
    await page.waitForTimeout(500); // auto-scroll to the new column
    const [c0, c1, c2] = [await box('library-column-0'), await box('library-column-1'), await box('library-column-2')];
    assert.ok(c2.x < c1.x && c1.x < c0.x, `columns flow right-to-left (${c0.x}, ${c1.x}, ${c2.x})`);
    assert.ok(c2.x >= -1 && c1.x + c1.width <= 401, 'new column revealed with its parent beside it');
    assert.ok(c1.width >= 400 * 0.42 && c1.width <= 400 * 0.52, `phone: ~2 columns (${c1.width}px)`);
    const crumbs = await tid('library-breadcrumb').innerText();
    assert.ok(crumbs.includes('תנך') && crumbs.includes(subName), `breadcrumb: ${crumbs}`);
    await shot('columns');
    step(`columns open right-to-left: תנך ‹ ${subName} (${Math.round(c1.width)}px each)`);

    // A sibling at the root is one tap away (no "back"); the deeper columns are replaced.
    await page.mouse.move(200, 400);
    await page.mouse.wheel(400, 0); // reveal the root column again (it scrolled off to the right)
    const root = page.locator('[data-testid="library-column-0"] [data-testid^="tree-cat-"]');
    await root.nth(1).click(); // תלמוד בבלי
    await page.waitForFunction(() => !document.querySelector('[data-testid="library-column-2"]'));
    assert.ok((await tid('library-column-1').innerText()).includes('תלמוד בבלי'));
    await tid('library-crumb-root').click();
    await page.waitForFunction(() => !document.querySelector('[data-testid="library-column-1"]'));
    step('switch siblings with one tap; breadcrumb jumps back');

    // Persisted path + open a book from a column.
    await tid('tree-cat-1').click();
    await page.locator('[data-testid="library-column-1"] [data-testid^="tree-cat-"]').first().click();
    await page.reload();
    // After a reload expo-router (web) may keep a hidden copy of the screen under the visible
    // one: always act on the top-most (last) instance.
    await tid('library-column-2').last().waitFor({ timeout: 180000 });
    await page.locator('[data-testid="library-column-2"] [data-testid^="tree-book-"]', { hasText: 'בראשית' }).last().click();
    await page.waitForURL(/\/reader/);
    step('column path persists; a book opens from its column');

    // --- טעמים / ניקוד toggles ---------------------------------------------------------------
    const para = page.locator('[data-testid^="para-"]', { hasText: /\(א\)/ }).last();
    await para.waitFor({ timeout: 20000 });
    const text = () => para.innerText();
    const TROPE = /[\u0591-\u05AF]/;
    const NIKKUD = /[\u05B0-\u05BC\u05C1\u05C2]/;
    assert.ok(TROPE.test(await text()) && NIKKUD.test(await text()), 'both shown by default');
    // The reader tools bar (טעמים / ניקוד / Aa ...) is folded away by default.
    const openReaderTools = async () => {
      if (!(await tid('toggle-cantillation').last().isVisible().catch(() => false))) await tid('reader-tools-toggle').last().click();
      await tid('toggle-cantillation').last().waitFor();
    };
    await openReaderTools();
    await tid('toggle-cantillation').last().click();
    await page.waitForTimeout(300);
    assert.ok(!TROPE.test(await text()) && NIKKUD.test(await text()), 'טעמים off: clean vocalized text');
    assert.strictEqual(await tid('toggle-cantillation').last().getAttribute('aria-checked'), 'false');
    await shot('no-trope');
    await tid('toggle-cantillation').last().click();
    await tid('toggle-nikkud').last().click();
    await page.waitForTimeout(300);
    assert.ok(!TROPE.test(await text()) && !NIKKUD.test(await text()), 'ניקוד off hides both');
    assert.strictEqual(await tid('toggle-cantillation').last().getAttribute('aria-checked'), 'false', 'טעמים shown off with ניקוד');
    assert.strictEqual(await tid('toggle-nikkud').last().getAttribute('aria-checked'), 'false');
    await page.reload();
    await para.waitFor({ timeout: 60000 });
    await page.waitForTimeout(500);
    assert.ok(!NIKKUD.test(await text()), 'persisted across sessions');
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('kodeshread.appearance')).state);
    assert.ok(saved.showNikkud === false && saved.showCantillation === true, JSON.stringify(saved));
    await openReaderTools();
    await tid('toggle-cantillation').last().click(); // brings both back
    await page.waitForTimeout(300);
    assert.ok(TROPE.test(await text()) && NIKKUD.test(await text()));
    step('טעמים / ניקוד toggles: independent, linked, persisted');

    assert.deepStrictEqual(errors, [], 'no page errors');
    console.log('\ne2e library manager: all passed');
  } catch (e) {
    console.error('✗', e.message);
    await shot('failure');
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();
