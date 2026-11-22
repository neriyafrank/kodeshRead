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
    assert.ok(/ספרים\s*9/.test(stats), `core stats: ${stats}`);
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
