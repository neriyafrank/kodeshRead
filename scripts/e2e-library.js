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
 *
 * Also the Library screen's "לימוד יומי" bar ("today" pinned to 2026-05-25, the week after a
 * Shabbat Shavuot: ארץ ישראל reads בהעלותך, חו"ל still נשא): Hebrew date, the persisted ארץ
 * ישראל / חו"ל switch changing the parsha, missing books greyed, and a tap opening the aliyah.
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
  await page.addInitScript(() => {
    globalThis.__KODESHREAD_TODAY__ = '2026-05-25';
  });
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

    // Failure card: the exact sub-step + native error, and "copy error details".
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE }).catch(() => undefined);
    const diag = 'finalize:swap_file · rename failed: Device or resource busy [EBUSY]';
    await page.evaluate((d) => {
      const jobs = globalThis.__kodeshreadJobs.getState();
      jobs.start('buildCore', 'מסיים את הבנייה…', { resumable: true });
      globalThis.__kodeshreadJobs.getState().finish({ ok: false, message: 'הספרייה נבנתה במלואה, אבל שלב הסיום וההתקנה נכשל.', diagnostic: d, retryable: true });
    }, diag);
    await tid('job-error-details').waitFor();
    assert.strictEqual((await tid('job-error-details-text').innerText()).trim(), diag);
    assert.strictEqual((await tid('job-error-details-copy').innerText()).trim(), 'העתק פרטי שגיאה');
    await tid('job-error-details-copy').click();
    await page.waitForFunction(() => /הועתק|ההעתקה נכשלה/.test(document.querySelector('[data-testid="job-error-details-copy"]').innerText));
    const copied = (await tid('job-error-details-copy').innerText()).trim();
    if (copied.startsWith('הועתק')) {
      const clip = await page.evaluate(() => navigator.clipboard.readText()).catch(() => null);
      if (clip != null) assert.ok(clip.startsWith(`kodeshRead error: ${diag}\n`) && /context: job buildCore/.test(clip), clip);
    }
    await shot('failure-diagnostic');
    await page.evaluate(() => globalThis.__kodeshreadJobs.getState().clearResult());
    await page.waitForFunction(() => !document.querySelector('[data-testid="job-result"]'));
    step(`failure card shows the sub-step diagnostic + copy button (${copied})`);

    await tid('remove-core').click();
    await tid('job-result').waitFor();
    const removed = await tid('job-result').innerText();
    assert.ok(removed.includes('הוסרה'), removed);
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
    // Column titles and folder / book names: flush right (text-align + rendered text position).
    const colText = await page.evaluate(() =>
      [...document.querySelectorAll('[data-testid^="library-column-"]')].flatMap((col) => {
        const cb = col.getBoundingClientRect();
        return [...col.querySelectorAll('div, span')]
          .filter((e) => !e.children.length && /[א-ת]{2}/.test(e.innerText || '') && e.getBoundingClientRect().height > 0 && e.getBoundingClientRect().width > 60)
          .map((e) => {
            const r = document.createRange();
            r.selectNodeContents(e);
            const t = r.getBoundingClientRect();
            return { text: e.innerText.trim(), align: getComputedStyle(e).textAlign, gapRight: cb.right - t.right, gapLeft: t.left - cb.left };
          });
      }),
    );
    assert.ok(colText.length >= 3, `column labels found (${colText.length})`);
    for (const t of colText) assert.ok(t.align === 'right' && t.gapRight < t.gapLeft, `"${t.text}" flush right (${t.align}, ${Math.round(t.gapRight)} / ${Math.round(t.gapLeft)})`);
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
    // Verse א (its number sits in the margin column, the text no longer starts with "(א)").
    const para = page.locator('[data-testid^="para-"]', { has: page.locator('[data-testid^="verse-num-"]', { hasText: /^א$/ }) }).last();
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

    // --- "לימוד יומי" bar ------------------------------------------------------------------------
    const last = (id) => tid(id).last();
    // (Last: a reload before "remove core" trips a web-preview-only expo-sqlite quirk.)
    await page.goto(BASE + '/', { timeout: 180000 });
    await last('library-daily-toggle').waitFor();
    assert.strictEqual(await last('library-daily-toggle').getAttribute('aria-expanded'), 'false', 'folded by default');
    await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="library-daily-toggle"]')].pop().innerText.includes('בהעלותך · שני'));
    assert.ok((await last('library-daily-toggle').innerText()).includes('ט׳ בסיון תשפ״ו'.replace(/׳/g, "'").replace(/״/g, '"')), 'folded summary: Hebrew date + parsha');
    await last('library-daily-toggle').click();
    await last('daily-item-parasha').waitFor();
    await page.waitForTimeout(300);
    assert.strictEqual((await last('daily-hebrew-date').innerText()).trim(), 'ט\' בסיון תשפ"ו');
    assert.strictEqual(await last('daily-loc-il').getAttribute('aria-checked'), 'true', 'ארץ ישראל by default');
    assert.strictEqual((await last('daily-title-parasha').innerText()).trim(), 'בהעלותך · שני');
    assert.ok((await last('daily-item-parasha').innerText()).includes('במדבר ח\' ט"ו'), 'בהעלותך שני = במדבר ח טו');
    for (const key of ['dafYomi', 'mishna', 'rambam1', 'rambam3']) {
      assert.strictEqual(await last(`daily-item-${key}`).getAttribute('aria-disabled'), 'true', `${key} greyed (not in the sample)`);
    }
    const align = await page.evaluate(() =>
      ['daily-hebrew-date', 'daily-title-parasha', 'daily-title-dafYomi'].map((id) => {
        const el = [...document.querySelectorAll(`[data-testid="${id}"]`)].pop();
        const r = document.createRange();
        r.selectNodeContents(el);
        return { id, align: getComputedStyle(el).textAlign, gap: el.getBoundingClientRect().right - r.getBoundingClientRect().right };
      }),
    );
    assert.ok(align.every((a) => a.align === 'right' && a.gap <= 2), `right-aligned: ${JSON.stringify(align)}`);
    await shot('daily-library');
    // חו"ל: the Diaspora read Shavuot on Shabbat, so this week is still נשא.
    await last('daily-loc-diaspora').click();
    await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="daily-title-parasha"]')].pop().innerText.trim() === 'נשא · שני');
    assert.ok((await last('daily-item-parasha').innerText()).includes('במדבר ד\' ל"ח'));
    assert.strictEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('kodeshread.learning')).state.il), false, 'location persisted');
    await page.reload();
    await last('daily-item-parasha').waitFor({ timeout: 60000 });
    await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="daily-title-parasha"]')].pop()?.innerText.trim() === 'נשא · שני');
    assert.strictEqual(await last('daily-loc-diaspora').getAttribute('aria-checked'), 'true', 'חו"ל restored after reload (card stays open)');
    await last('daily-item-parasha').click();
    await page.waitForFunction(() => /^במדבר/.test(document.querySelector('[data-testid="reader-breadcrumb"]')?.innerText || '') && document.querySelector('[data-testid="reader-breadcrumb"]').innerText.includes('פרק ד'), null, { timeout: 20000 });
    await page.waitForFunction(() => [...document.querySelectorAll('[data-testid^="aliyah-divider-"]')].some((e) => e.innerText.trim() === 'שני' && e.getBoundingClientRect().height > 0));
    await shot('daily-opened');
    await last('reader-back').click();
    await last('daily-loc-il').click();
    await last('library-daily-toggle').click();
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('kodeshread.learning')).state.il === true);
    step('לימוד יומי bar: ט\' בסיון תשפ"ו, ארץ ישראל בהעלותך / חו"ל נשא (persisted), missing books greyed, tap opens the aliyah');

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
