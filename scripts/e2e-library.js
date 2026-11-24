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
 * Cloud library (two editions: `library-latest` = full, `library-classic-latest` = classic): the browser has no file system, so the test
 * mocks both library-manifest.json files and two tiny zip chunks (page.route) and runs the real pipeline over
 * in-memory storage (globalThis.__KODESHREAD_E2E_CLOUD__): both edition cards with their live size / book
 * count, the installed-edition badge, update detection ("קיים עדכון בענן"), switching editions, the
 * low-storage warning, "חלק 2 מתוך 2 · … · 50%" progress while part 2 is in flight, and the install.
 *
 * Instant cloud starter: with no full library (core removed) a fresh user sees the starter catalog
 * (starter-catalog.json + starter-*.json.gz are mocked with page.route from REAL packs exported out of the
 * sample library), taps בראשית (inline "טוען את בראשית מהענן…", download -> verify -> one SQLite
 * transaction into the starter DB), reads it with רש"י / אונקלוס in the commentary drawer, opens the Bavli
 * שבת (רש"י שורה א + תוספות), searches the loaded books locally, re-opens a loaded book without any download,
 * sees the cached catalog when the network is gone, and still sees the upgrade banner.
 *
 * Also the Library screen's "לימוד יומי" bar ("today" pinned to 2026-05-25, the week after a
 * Shabbat Shavuot: ארץ ישראל reads בהעלותך, חו"ל still נשא): Hebrew date, the persisted ארץ
 * ישראל / חו"ל switch changing the parsha, missing books greyed, and a tap opening the aliyah.
 */
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const { zipSync } = require('fflate');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { exportStarterPacks } = require('./export-starter-packs');

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
  // timezoneId: the daily-study location is auto-detected from the device zone (a device in Israel -> ארץ ישראל).
  const page = await browser.newPage({ viewport: { width: 400, height: 820 }, deviceScaleFactor: SHOTS ? 2 : 1, timezoneId: 'Asia/Jerusalem' });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('dialog', (d) => d.accept());
  await page.addInitScript(() => {
    globalThis.__KODESHREAD_TODAY__ = '2026-05-25';
    globalThis.__KODESHREAD_E2E_CLOUD__ = true;
    const tz = sessionStorage.getItem('e2e.tz');
    if (tz) globalThis.__KODESHREAD_TZ__ = tz;
    const free = Number(sessionStorage.getItem('e2e.freeBytes'));
    if (free) globalThis.__KODESHREAD_FREE_BYTES__ = free;
  });

  // --- mocked multi-part cloud release (2 small chunks of a real zip of a fake SQLite file) ---
  const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
  const fakeDb = Buffer.concat([Buffer.from('SQLite format 3\0'), crypto.randomBytes(48 * 1024)]);
  const zip = Buffer.from(zipSync({ 'core_library.db': new Uint8Array(fakeDb) }, { level: 6 }));
  const half = Math.ceil(zip.length / 2);
  const chunks = [zip.subarray(0, half), zip.subarray(half)];
  const manifestOf = (edition, over) => ({
    sourceRepo: 'Sivan22/otzaria-library',
    scope: edition === 'classic' ? 'classical_full' : 'all',
    edition,
    version: edition === 'classic' ? 'cloud-e2e-classic-1' : 'cloud-e2e-1',
    builtAt: '2026-11-20T10:00:00.000Z',
    bookCount: edition === 'classic' ? 6100 : 7674,
    paragraphCount: 1234567,
    uncompressedDbBytes: fakeDb.length,
    totalZipBytes: zip.length,
    fullZipSha256: sha(zip),
    parts: chunks.map((c, i) => ({ name: `core_library.db.zip.part-0${i + 1}`, sizeBytes: c.length, sha256: sha(c) })),
    ...over,
  });
  const cloud = { classic: manifestOf('classic'), full: manifestOf('full') };
  const cloudManifest = cloud.full;
  const cloudRequests = { classic: [], full: [] };
  for (const [edition, tag] of [['classic', 'library-classic-latest'], ['full', 'library-latest']]) {
    await page.route(`**/releases/download/${tag}/**`, async (route) => {
      const name = decodeURIComponent(route.request().url().split('/').pop());
      const cors = { 'access-control-allow-origin': '*' };
      if (name === 'library-manifest.json') return route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify(cloud[edition]) });
      const i = cloud[edition].parts.findIndex((p) => p.name === name);
      if (i < 0) return route.fulfill({ status: 404, headers: cors, body: '' });
      cloudRequests[edition].push(name);
      if (i === 1) await new Promise((r) => setTimeout(r, 2500)); // part 2 is "in flight" while the test reads the progress
      return route.fulfill({ status: 200, contentType: 'application/octet-stream', headers: cors, body: chunks[i] });
    });
  }
  // --- mocked starter release (real packs exported from the sample library) --------------------------
  const starterDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-starter-'));
  const starter = await exportStarterPacks({ dbFile: path.join(__dirname, '..', 'assets', 'db', 'library.db'), outDir: starterDir });
  const starterRequests = [];
  const starterNet = { failCatalog: 1, offline: false };
  await page.route('**/releases/download/starter-latest/**', async (route) => {
    const name = decodeURIComponent(route.request().url().split('/').pop().split('?')[0]);
    const cors = { 'access-control-allow-origin': '*' };
    if (name === 'starter-catalog.json') {
      starterRequests.push(name);
      if (starterNet.offline || starterNet.failCatalog > 0) {
        starterNet.failCatalog = Math.max(0, starterNet.failCatalog - 1);
        return route.fulfill({ status: 503, headers: cors, body: 'unavailable' });
      }
      return route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify(starter.catalog) });
    }
    if (!starter.catalog.books.some((b) => b.packFile === name)) return route.fulfill({ status: 404, headers: cors, body: '' });
    starterRequests.push(name);
    if (name === 'starter-genesis.json.gz') await new Promise((r) => setTimeout(r, 1500)); // "טוען את בראשית מהענן…" stays visible
    return route.fulfill({ status: 200, contentType: 'application/gzip', headers: cors, body: fs.readFileSync(path.join(starterDir, name)) });
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

    // --- Cloud library card (multi-part release) -------------------------------------------------
    await tid('cloud-library-card').waitFor();
    await tid('cloud-info-classic').waitFor();
    await tid('cloud-info-full').waitFor();
    const clean = (t) => t.replace(/[\u2066-\u2069]/g, ''); // bidi isolates are invisible
    const classicInfo = clean(await tid('cloud-info-classic').innerText());
    const fullInfo = clean(await tid('cloud-info-full').innerText());
    assert.ok(/ספרים\s*6,100/.test(classicInfo) && /cloud-e2e-classic-1/.test(classicInfo) && /נבנתה/.test(classicInfo), classicInfo);
    assert.ok(/ספרים\s*7,674/.test(fullInfo) && /cloud-e2e-1/.test(fullInfo) && /נבנתה/.test(fullInfo), fullInfo);
    for (const ed of ['classic', 'full']) {
      assert.ok(/2 חלקים/.test(clean(await tid(`cloud-size-${ed}`).innerText())), await tid(`cloud-size-${ed}`).innerText());
      assert.notStrictEqual(await tid(`cloud-download-${ed}`).getAttribute('aria-disabled'), 'true', 'enabled in the e2e preview');
      assert.strictEqual(await tid(`cloud-storage-warning-${ed}`).count(), 0, 'no warning while the storage is unknown');
      assert.strictEqual(await tid(`cloud-installed-${ed}`).count(), 0, 'nothing installed from the cloud yet');
    }
    assert.ok((await tid('cloud-title-classic').innerText()).includes('ספרייה בסיסית (קלאסית)'));
    assert.ok((await tid('cloud-title-full').innerText()).includes('ספרייה מלאה (כולל אחרוני זמננו)'));
    const cardText = await tid('cloud-library-card').innerText();
    assert.ok(cardText.includes('ללא אחרוני זמננו') && cardText.includes('כל מאגר אוצריא המלא'), cardText);
    const cloudAlign = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="cloud-library-card"]');
      const card = el.getBoundingClientRect();
      return [...el.querySelectorAll('div')]
        .filter((e) => !e.children.length && /[א-ת]{3}/.test(e.innerText || '') && e.getBoundingClientRect().width > 120)
        .map((e) => {
          const r = document.createRange();
          r.selectNodeContents(e);
          return { text: e.innerText.trim().slice(0, 24), align: getComputedStyle(e).textAlign, gapRight: card.right - r.getBoundingClientRect().right, gapLeft: r.getBoundingClientRect().left - card.left };
        });
    });
    assert.ok(cloudAlign.length >= 3, `cloud card labels (${cloudAlign.length})`);
    for (const t of cloudAlign) assert.ok(t.align === 'right' && t.gapRight < t.gapLeft + 1, `"${t.text}" flush right (${t.align}, ${Math.round(t.gapRight)} / ${Math.round(t.gapLeft)})`);
    await shot('cloud-card');
    step('cloud card: both editions with their own size + book count from their release manifests, RTL right-aligned');

    // Download the classic edition: part 1 completes, part 2 is in flight (progress), then assembly, extraction, install.
    await tid('cloud-download-classic').click();
    await tid('job-status').waitFor();
    await page.waitForFunction(
      () => /חלק 2 מתוך 2 · \d+ (KB|MB) \/ \d+ (KB|MB) · \d+%/.test((document.querySelector('[data-testid="job-status"]')?.innerText || '').replace(/[⁦-⁩]/g, '')),
      null,
      { timeout: 15000 },
    );
    const progressText = await tid('job-status').innerText();
    assert.ok(/מוריד/.test(progressText), progressText);
    await shot('cloud-progress');
    assert.deepStrictEqual(cloudRequests.classic, ['core_library.db.zip.part-01', 'core_library.db.zip.part-02'], 'parts are fetched sequentially, from the classic release');
    assert.deepStrictEqual(cloudRequests.full, [], 'the full release is untouched');
    await tid('job-result').waitFor({ timeout: 30000 });
    const cloudDone = await tid('job-result').innerText();
    assert.ok(cloudDone.includes('הותקנה מהענן') && cloudDone.includes('ספרייה בסיסית') && cloudDone.includes('cloud-e2e-classic-1') && cloudDone.includes('6,100'), cloudDone);
    assert.strictEqual(await page.evaluate(() => globalThis.__kodeshreadCloudInstalled), 'cloud-e2e-classic-1', 'the staged library reached the install step');
    const recorded = await page.evaluate(() => JSON.parse(localStorage.getItem('kodeshread.librarySettings') || '{}').state?.installedCloud);
    assert.deepStrictEqual(recorded, { edition: 'classic', version: 'cloud-e2e-classic-1' }, 'the installed edition is recorded');
    await shot('cloud-installed');
    await page.evaluate(() => globalThis.__kodeshreadJobs.getState().clearResult());
    step('cloud download (classic): חלק 1 → חלק 2 מתוך 2 progress, assemble + extract, install, edition recorded');

    // The preview cannot swap the file, so pretend the classic library is the installed one: record the edition
    // with the version of the core library that is really open (the sample DB).
    const coreVersion = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'assets', 'db', 'db-version.json'), 'utf8')).version;
    assert.ok(coreVersion, 'db-version.json has a version');
    const installAs = (edition) =>
      page.evaluate(
        ([ed, v]) => {
          const k = 'kodeshread.librarySettings';
          const cur = JSON.parse(localStorage.getItem(k) || '{"state":{},"version":1}');
          cur.state.installedCloud = { edition: ed, version: v };
          localStorage.setItem(k, JSON.stringify(cur));
        },
        [edition, coreVersion],
      );
    const reopenManager = async () => {
      await page.goto(BASE + '/', { timeout: 180000 });
      await tid('open-library-manager').last().waitFor({ timeout: 180000 });
      await tid('open-library-manager').last().click();
      await tid('cloud-info-classic').waitFor({ timeout: 60000 });
      await tid('cloud-info-full').waitFor({ timeout: 60000 });
    };
    // 1. classic installed, the cloud has a newer classic version -> badge + "קיים עדכון בענן" on the classic card only.
    await installAs('classic');
    await reopenManager();
    await tid('cloud-installed-classic').waitFor();
    assert.ok((await tid('cloud-installed-classic').innerText()).includes('מותקן כעת'));
    assert.strictEqual(await tid('cloud-installed-full').count(), 0, 'only the installed edition is badged');
    assert.ok((await tid('cloud-update-classic').innerText()).includes('קיים עדכון בענן'));
    assert.strictEqual(await tid('cloud-update-full').count(), 0, 'the other edition is not an update');
    assert.ok((await tid('cloud-download-classic').innerText()).includes('עדכן'));
    assert.ok((await tid('cloud-download-full').innerText()).includes('עבור ל'), await tid('cloud-download-full').innerText());
    assert.strictEqual(await tid('cloud-switch-hint-full').count(), 1);
    await shot('cloud-installed-classic');
    step('installed edition badge "מותקן כעת" + update check of the installed edition only (library-classic-latest)');

    // 2. the cloud classic version equals the installed one -> up to date, no update line.
    cloud.classic = manifestOf('classic', { version: coreVersion });
    await reopenManager();
    assert.ok((await tid('cloud-library-card').innerText()).includes('הגרסה המותקנת זהה לגרסה בענן'));
    assert.strictEqual(await tid('cloud-update-classic').count(), 0);
    cloud.classic = manifestOf('classic');

    // 3. switch classic -> full: confirm, then the full release is downloaded (classic untouched).
    cloudRequests.classic.length = 0;
    await reopenManager();
    await tid('cloud-download-full').click();
    await tid('job-status').waitFor();
    await tid('job-result').waitFor({ timeout: 30000 });
    const switched = await tid('job-result').innerText();
    assert.ok(switched.includes('ספרייה מלאה') && switched.includes('cloud-e2e-1') && switched.includes('7,674'), switched);
    assert.deepStrictEqual(cloudRequests.full, ['core_library.db.zip.part-01', 'core_library.db.zip.part-02'], 'the full release is fetched');
    assert.deepStrictEqual(cloudRequests.classic, [], 'switching never touches the classic release');
    assert.deepStrictEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('kodeshread.librarySettings')).state.installedCloud), { edition: 'full', version: 'cloud-e2e-1' });
    await page.evaluate(() => globalThis.__kodeshreadJobs.getState().clearResult());
    // ... and back: with the full edition installed the badge moves and classic becomes the switch target.
    await installAs('full');
    await reopenManager();
    await tid('cloud-installed-full').waitFor();
    assert.strictEqual(await tid('cloud-installed-classic').count(), 0);
    assert.ok((await tid('cloud-download-classic').innerText()).includes('עבור ל'));
    assert.strictEqual(await tid('cloud-update-classic').count(), 0);
    assert.ok((await tid('cloud-update-full').innerText()).includes('קיים עדכון בענן'), 'full edition update detected against library-latest');
    await shot('cloud-installed-full');
    // The edition record is dropped again so the later steps see a plain library.
    await page.evaluate(() => {
      const k = 'kodeshread.librarySettings';
      const cur = JSON.parse(localStorage.getItem(k));
      cur.state.installedCloud = null;
      localStorage.setItem(k, JSON.stringify(cur));
    });
    step('edition switch classic -> full (confirmed) uses the full release; installed badge follows; no cross-edition updates');

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


    // --- Instant cloud starter: no full library -> the starter catalog, not a download wall -----------
    const bidi = (t) => t.replace(/[⁦-⁩]/g, ''); // bidi isolates are invisible
    await tid('starter-upgrade-banner').waitFor();
    await tid('starter-catalog-error').waitFor();
    assert.ok((await tid('starter-catalog-error').innerText()).includes('503'), 'a clear error state while the catalog is unreachable');
    await shot('starter-error');
    await tid('starter-retry').click();
    await tid('starter-book-genesis').waitFor();
    assert.deepStrictEqual(starterRequests.slice(0, 2), ['starter-catalog.json', 'starter-catalog.json']);
    const slugs = await page.locator('[data-testid^="starter-book-"]').evaluateAll((els) => els.map((e) => e.dataset.testid.replace('starter-book-', '')));
    assert.deepStrictEqual(slugs, ['genesis', 'numbers', 'bavli-shabbat'], 'canonical catalog order (the books missing from the sample are skipped)');
    const sections = (await page.locator('[data-testid^="starter-section-"]').evaluateAll((els) => els.map((e) => e.innerText.split('\n')[0])));
    assert.deepStrictEqual(sections, ['תנ"ך', 'תלמוד בבלי']);
    const bannerText = (await tid('starter-upgrade-banner').innerText()).replace(/\s+/g, ' ');
    assert.ok(bannerText.includes('ספריית התחלה מהענן · להורדת ספרייה לאופליין וחיפוש מלא: בסיסית (ללא אחרוני זמננו) או מלאה'), bannerText);
    assert.ok(bannerText.includes('הורד ספרייה מלאה'));
    for (const b of starter.catalog.books) {
      const badge = bidi(await tid(`starter-badge-${b.slug}`).innerText());
      assert.strictEqual(badge, `☁ · ${Math.max(1, Math.round(b.sizeBytes / 1024))} KB`, 'cloud badge with the pack size');
    }
    const genesisRow = await tid('starter-book-genesis').innerText();
    assert.ok(genesisRow.includes('בראשית') && genesisRow.includes('עם רש"י, אונקלוס'), genesisRow);
    assert.ok((await tid('starter-book-bavli-shabbat').innerText()).includes('עם רש"י, תוספות'));
    const starterAlign = await page.evaluate(() => {
      const box = document.querySelector('[data-testid="starter-books"]').getBoundingClientRect();
      return [...document.querySelectorAll('[data-testid^="starter-book-"]')].map((row) => {
        const t = [...row.querySelectorAll('div')].find((e) => !e.children.length && /[א-ת]/.test(e.innerText));
        const rr = document.createRange();
        rr.selectNodeContents(t);
        return { text: t.innerText.trim(), align: getComputedStyle(t).textAlign, gapRight: box.right - rr.getBoundingClientRect().right, gapLeft: rr.getBoundingClientRect().left - box.left };
      });
    });
    for (const t of starterAlign) assert.ok(t.align === 'right' && t.gapRight < t.gapLeft, `starter title "${t.text}" flush right (${t.align}, ${Math.round(t.gapRight)} / ${Math.round(t.gapLeft)})`);
    await shot('starter-catalog');
    step('fresh user: starter catalog in canonical order with ☁ · size badges, upgrade banner, error -> retry (no download wall)');

    // --- Home screen: the Daily Study bar stays above the starter books; the starter section collapses (persisted) -----
    await tid('library-daily').waitFor();
    assert.ok(await tid('library-daily').isVisible(), 'the לימוד יומי bar is visible next to the starter books');
    const dailyBox = await tid('library-daily').boundingBox();
    const starterBox = await tid('starter-books').boundingBox();
    assert.ok(dailyBox.y + dailyBox.height <= starterBox.y + 2, `the daily bar is above the starter section (${dailyBox.y + dailyBox.height} <= ${starterBox.y})`);
    assert.ok(dailyBox.y < 400, 'visible on launch without scrolling past the starter cards');
    // a study item whose book is not on the device: a clear prompt to download (not a silent no-op)
    if ((await tid('library-daily-toggle').getAttribute('aria-expanded')) !== 'true') await tid('library-daily-toggle').click();
    await tid('daily-item-dafYomi').waitFor();
    assert.ok((await tid('daily-item-dafYomi').innerText()).includes('לא נמצא בספרייה'), 'greyed: not installed');
    let prompt = '';
    page.once('dialog', (d) => (prompt = d.message())); // (the page-wide handler accepts it)
    await tid('daily-item-dafYomi').click();
    await tid('library-manager').waitFor();
    assert.ok(/עדיין לא נמצא במכשיר/.test(prompt) && /ספרייה מוכנה מהענן/.test(prompt), prompt);
    await page.goBack();
    await tid('starter-toggle').waitFor();
    if ((await tid('library-daily-toggle').getAttribute('aria-expanded')) === 'true') await tid('library-daily-toggle').click(); // back to its folded default
    step('Daily Study bar: always visible above the starter books; a missing book prompts for the library manager');
    // collapse / expand (persisted)
    assert.strictEqual(await tid('starter-toggle').getAttribute('aria-expanded'), 'true', 'expanded by default');
    assert.ok(/\(3\)/.test(await tid('starter-count').innerText()), 'count in the header');
    await tid('starter-toggle').click();
    await tid('starter-books-collapsed').waitFor();
    assert.strictEqual(await tid('starter-books').count(), 0, 'the list is folded away');
    assert.strictEqual(await tid('starter-book-genesis').count(), 0);
    assert.strictEqual(await tid('starter-toggle').getAttribute('aria-expanded'), 'false');
    assert.ok(await tid('library-daily').isVisible(), 'the daily bar stays when the starter section is collapsed');
    assert.strictEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('kodeshread.librarySettings')).state.starterOpen), false, 'collapsed state persisted');
    await shot('starter-collapsed');
    // survives leaving and coming back to the screen
    await tid('open-library-manager').click();
    await tid('library-manager').waitFor();
    await page.goBack();
    await tid('starter-toggle').waitFor();
    assert.strictEqual(await tid('starter-toggle').getAttribute('aria-expanded'), 'false', 'still collapsed after navigating away');
    await tid('starter-toggle').click();
    await tid('starter-book-genesis').waitFor();
    assert.strictEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('kodeshread.librarySettings')).state.starterOpen), true);
    step('ספרי התחלה: header toggle collapses / expands the section; the choice is persisted');

    // Tap-to-open: inline loading text, then the Reader with the book + Rashi / Onkelos.
    await tid('starter-book-genesis').click();
    await tid('starter-loading-genesis').waitFor({ timeout: 5000 });
    assert.strictEqual((await tid('starter-loading-genesis').innerText()).trim(), 'טוען את בראשית מהענן…');
    await shot('starter-loading');
    await tid('reader-breadcrumb').waitFor({ timeout: 30000 });
    await tid('para-3').waitFor({ timeout: 20000 });
    assert.ok(starterRequests.includes('starter-genesis.json.gz'));
    assert.ok((await tid('para-3').innerText()).length > 5, 'verse text rendered from the starter database');
    assert.strictEqual(await page.locator('[data-testid^="links-badge-"]').count(), 0, 'no count badge');
    await tid('para-3').click();
    await tid('commentary-group').first().waitFor({ timeout: 10000 });
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="commentary-group"]').length === 2);
    assert.deepStrictEqual((await tid('commentary-group-name').allInnerTexts()).sort(), ['אונקלוס', 'רש"י']);
    assert.ok((await tid('commentary-entry').first().innerText()).length > 3);
    await shot('starter-reader-rashi');
    step('tap בראשית: "טוען את בראשית מהענן…" -> Reader opens, Commentary Drawer has רש"י + אונקלוס (bundled ref_links)');

    // Bavli: Rashi on the exact paragraph (שורה N) + Tosafot.
    await page.goBack();
    await tid('starter-book-bavli-shabbat').waitFor();
    assert.strictEqual(bidi(await tid('starter-badge-genesis').innerText()), '✓ זמין לא מקוון', 'a loaded book is marked as available offline');
    assert.ok(/^☁/.test(bidi(await tid('starter-badge-bavli-shabbat').innerText())));
    await tid('starter-book-bavli-shabbat').click();
    await tid('para-3').waitFor({ timeout: 30000 });
    await tid('para-3').click();
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="commentary-group"]').length === 2);
    assert.deepStrictEqual(await tid('commentary-group-name').allInnerTexts(), ['רש"י', 'תוספות']);
    assert.ok((await tid('commentary-block').first().innerText()).includes('דף ב. · שורה א'), await tid('commentary-block').first().innerText());
    await shot('starter-reader-bavli');
    step('Bavli שבת from the cloud: Rashi on its שורה א block + Tosafot, like the full library');

    // Loaded books: no second download; the packs of books never opened were never requested.
    await page.goBack();
    await tid('starter-book-genesis').waitFor();
    const requestsBefore = starterRequests.length;
    await tid('starter-book-genesis').click();
    await tid('para-3').waitFor({ timeout: 10000 });
    assert.strictEqual(await tid('starter-loading-genesis').count(), 0);
    assert.strictEqual(starterRequests.length, requestsBefore, 'a loaded book opens without a download');
    assert.deepStrictEqual(starterRequests.filter((n) => n.endsWith('.json.gz')).sort(), ['starter-bavli-shabbat.json.gz', 'starter-genesis.json.gz']);
    await page.goBack();
    step('re-opening a loaded book is instant and downloads nothing (numbers was never fetched)');

    // Local search over the loaded starter books.
    await tid('open-search').click();
    await tid('search-input').fill('בראשית ברא');
    await tid('search-result').first().waitFor({ timeout: 20000 });
    assert.ok((await tid('search-result').count()) >= 1);
    await page.goBack();
    await tid('starter-book-genesis').waitFor();
    step('search runs locally over the loaded starter books');

    // Offline: the cached catalog keeps the list; a retry restores the fresh one.
    starterNet.offline = true;
    await page.evaluate(() => globalThis.__kodeshreadStarter.load());
    await tid('starter-stale').waitFor();
    assert.ok((await tid('starter-stale').innerText()).includes('מוצגת רשימה שמורה'));
    assert.ok((await tid('starter-book-numbers').count()) === 1, 'the list stays usable offline');
    starterNet.offline = false;
    await tid('starter-retry').click();
    await page.waitForFunction(() => !document.querySelector('[data-testid="starter-stale"]'));
    assert.strictEqual(await tid('starter-upgrade-banner').count(), 1, 'the upgrade banner stays while there is no full library');
    step('offline: cached catalog + retry state; the banner stays until the full library is installed');

    await tid('starter-upgrade-button').click();
    await tid('cloud-library-card').waitFor();
    await page.goBack();
    await tid('onboarding-card').waitFor();
    step('the banner button leads to the manager\'s "הורד ספרייה מוכנה מהענן" card');

    await tid('onboarding-download').click();
    await tid('cloud-library-card').waitFor();
    step('onboarding "הורד ספרייה מוכנה מהענן" opens the manager with the cloud card (no blind multi-GB download)');
    await page.goBack();
    await tid('onboarding-card').waitFor();

    await tid('onboarding-import').click();
    await tid('library-manager').waitFor();
    step('import choice opens the manager');

    // Collapse once more right before the reload below: the preference must survive it (the web preview restores
    // the sample library on reload, so the starter section itself is gone afterwards; the stored choice is not).
    await page.goBack();
    await tid('starter-toggle').waitFor();
    await tid('starter-toggle').click();
    await tid('starter-books-collapsed').waitFor();
    // The starter books read above left tabs / a search query behind; the catalog checks below start clean.
    await page.evaluate(() => ['kodeshread.tabs', 'kodeshread.search'].forEach((k) => localStorage.removeItem(k)));
    await page.goto(BASE + '/', { timeout: 180000 });
    const secRows = page.locator('[data-testid^="tree-sec-"]');
    await secRows.first().waitFor({ timeout: 180000 });
    assert.strictEqual(await tid('onboarding-card').count(), 0);
    step('web preview restores the sample library on reload');
    assert.strictEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('kodeshread.librarySettings')).state.starterOpen), false, 'the collapsed preference survives a reload');
    await page.evaluate(() => {
      const k = 'kodeshread.librarySettings';
      const v = JSON.parse(localStorage.getItem(k));
      v.state.starterOpen = true;
      localStorage.setItem(k, JSON.stringify(v));
    });
    assert.strictEqual(await tid('library-daily').count() >= 1, true, 'the daily bar is part of the full-library home screen too');

    // --- Canonical catalog, RTL cascading columns --------------------------------------------
    // (Runs after the manager flow: no saved column path yet.)
    const box = async (id) => tid(id).boundingBox();
    const sec = (name, scope = '') => page.locator(`${scope} [data-testid^="tree-sec-"]`, { hasText: name }).first();
    assert.strictEqual(await tid('library-mode-base').getAttribute('aria-selected'), 'true', 'ספרי בסיס is the default view');
    assert.strictEqual(await tid('library-mode-comm').getAttribute('aria-selected'), 'false');
    const modes = await page.locator('[data-testid="library-mode-base"], [data-testid="library-mode-comm"]').allInnerTexts();
    assert.deepStrictEqual(modes, ['ספרי בסיס', 'מפרשים לפי ספר']);
    const mb = await box('library-mode-base');
    const mc = await box('library-mode-comm');
    assert.ok(mb.x > mc.x, 'RTL segmented toggle: ספרי בסיס on the right');
    assert.strictEqual(await tid('library-column-1').count(), 0, 'only the root column at first');
    const root0 = await box('library-column-0');
    assert.ok(root0.x + root0.width > 380, 'root column hugs the right edge');
    const rootNames = (await secRows.allInnerTexts()).map((t) => t.split('\n').find((x) => /[א-ת]/.test(x)));
    assert.deepStrictEqual(rootNames, ['תנ"ך', 'משנה', 'תלמוד בבלי'], 'canonical section order; empty sections hidden');
    await sec('תנ"ך').click();
    await tid('library-column-1').waitFor();
    assert.strictEqual(await sec('תנ"ך').getAttribute('aria-selected'), 'true', 'active section highlighted');
    const sub = page.locator('[data-testid="library-column-1"] [data-testid^="tree-sec-"]').first();
    const subName = (await sub.innerText()).split('\n')[0];
    assert.strictEqual(subName, 'תורה');
    await sub.click();
    await tid('library-column-2').waitFor();
    await page.waitForTimeout(500); // auto-scroll to the new column
    const books2 = await page.locator('[data-testid="library-column-2"] [data-testid^="tree-book-"]').allInnerTexts();
    assert.deepStrictEqual(books2.map((t) => t.split('\n')[0]), ['בראשית', 'במדבר'], 'Torah order (alphabetical would put במדבר first); base books only');
    // Book rows: icon + full title only (no מפרשים (N) / ⇄ מקביל buttons).
    assert.strictEqual(await page.locator('[data-testid^="tree-comm-"], [data-testid^="tree-parallel-"]').count(), 0, 'no action pills in the book rows');
    assert.strictEqual((await tid('tree-book-1').innerText()).trim(), 'בראשית', 'title only, clearly visible');
    assert.ok(await tid('tree-book-1').isVisible());
    assert.ok((await box('tree-book-1')).width > 120, 'the title gets the full row width');
    const [c0, c1, c2] = [await box('library-column-0'), await box('library-column-1'), await box('library-column-2')];
    assert.ok(c2.x < c1.x && c1.x < c0.x, `columns flow right-to-left (${c0.x}, ${c1.x}, ${c2.x})`);
    assert.ok(c2.x >= -1 && c1.x + c1.width <= 401, 'new column revealed with its parent beside it');
    assert.ok(c1.width >= 400 * 0.42 && c1.width <= 400 * 0.52, `phone: ~2 columns (${c1.width}px)`);
    const crumbs = await tid('library-breadcrumb').innerText();
    assert.ok(crumbs.includes('תנ"ך') && crumbs.includes(subName), `breadcrumb: ${crumbs}`);
    // Column titles and section / book names: flush right (text-align + rendered text position).
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
    const filterAlign = await tid('library-filter').evaluate((el) => getComputedStyle(el).textAlign);
    assert.strictEqual(filterAlign, 'right', 'the live filter is right-aligned');
    await shot('columns');
    step(`columns open right-to-left in canonical order: תנ"ך ‹ ${subName} ‹ בראשית, במדבר (${Math.round(c1.width)}px each)`);

    // A sibling at the root is one tap away (no "back"); the deeper columns are replaced.
    await page.mouse.move(200, 400);
    await page.mouse.wheel(400, 0); // reveal the root column again (it scrolled off to the right)
    await sec('תלמוד בבלי', '[data-testid="library-column-0"]').click();
    await page.waitForFunction(() => !document.querySelector('[data-testid="library-column-2"]'));
    const shas = await page.locator('[data-testid="library-column-1"] [data-testid^="tree-book-"]').allInnerTexts();
    assert.deepStrictEqual(shas.map((t) => t.split('\n')[0]), ['שבת', 'ראש השנה', 'תענית'], 'Shas order (alphabetical would start with ראש השנה)');
    await tid('library-crumb-root').click();
    await page.waitForFunction(() => !document.querySelector('[data-testid="library-column-1"]'));
    step('Bavli in Shas order; switch siblings with one tap; breadcrumb jumps back');

    // --- Parallel works are standalone books in their own section ----------------------------------
    await sec('משנה', '[data-testid="library-column-0"]').click();
    await sec('סדר מועד', '[data-testid="library-column-1"]').click();
    await tid('library-column-2').waitFor();
    const mishna = await page.locator('[data-testid="library-column-2"] [data-testid^="tree-book-"]').allInnerTexts();
    assert.deepStrictEqual(mishna.map((t) => t.split('\n')[0]), ['משנה שבת']);
    assert.strictEqual(await page.locator('[data-testid^="tree-parallel-"], [data-testid^="tree-comm-"]').count(), 0, 'no pills; a standalone book row');
    await shot('parallel-standalone');
    await tid('library-crumb-root').click();
    await page.waitForFunction(() => !document.querySelector('[data-testid="library-column-1"]'));
    step('משנה שבת: a standalone parallel work under משנה ‹ סדר מועד, not a commentary of שבת');

    // --- Live filter -----------------------------------------------------------------------------
    await tid('library-filter').fill('שבת');
    await tid('library-results').waitFor();
    const hit = await page.locator('[data-testid="library-results"] [data-testid^="tree-book-"]').allInnerTexts();
    assert.deepStrictEqual(hit.map((t) => t.split('\n')[0]), ['משנה שבת', 'שבת'], 'canonical order: the Mishnah, then the Bavli');
    assert.ok(hit[1].includes('תלמוד בבלי'), 'result shows its section');
    await tid('library-filter').fill('zzzz');
    await tid('library-filter-empty').waitFor();
    await tid('library-filter-clear').click();
    await page.waitForFunction(() => !document.querySelector('[data-testid="library-results"]'));
    step('live filter');

    // --- מפרשים לפי ספר ------------------------------------------------------------------------------
    await tid('library-mode-comm').click();
    await page.waitForFunction(() => document.querySelector('[data-testid="library-mode-comm"]').getAttribute('aria-selected') === 'true');
    const commRoot = await secRows.allInnerTexts();
    assert.deepStrictEqual(commRoot.map((t) => t.split('\n').find((x) => /[א-ת]/.test(x))), ['תנ"ך', 'תלמוד בבלי']);
    await sec('תנ"ך').click();
    await sec('תורה', '[data-testid="library-column-1"]').click();
    await tid('tree-book-1').waitFor(); // בראשית: the only base book with commentaries
    assert.strictEqual(await tid('tree-book-2').count(), 0, 'במדבר has no commentaries: not listed');
    await tid('tree-book-1').click();
    await tid('tree-open-base-1').waitFor();
    const comms = (await page.locator('[data-testid^="tree-commentary-"]').allInnerTexts()).map((t) => t.split('\n')[0]);
    assert.strictEqual(comms.length, 8, `all commentaries together: ${comms}`);
    const at = (n) => comms.findIndex((c) => c.includes(n));
    assert.ok(at('אונקלוס') === 0, `אונקלוס (תרגום) first: ${comms}`);
    assert.ok(at('רש"י') < at('רמב"ן') && at('רמב"ן') < at('אבן עזרא') && at('אבן עזרא') < at('ספורנו') && at('ספורנו') < at('דעת זקנים') && at('דעת זקנים') < at('גור אריה'), `canonical rank order: ${comms}`);
    await shot('commentaries-by-book');
    await tid('tree-commentary-4').click(); // רש"י על בראשית opens in the reader
    await page.waitForURL(/\/reader/);
    await page.goBack();
    await tid('library-mode-comm').waitFor();
    // Bavli: Rashi first, Tosafot second.
    await sec('תלמוד בבלי', '[data-testid="library-column-0"]').click().catch(() => undefined);
    await tid('library-crumb-root').click();
    await sec('תלמוד בבלי').click();
    await tid('tree-book-12').click();
    await tid('tree-open-base-12').waitFor();
    const shabbat = (await page.locator('[data-testid^="tree-commentary-"]').allInnerTexts()).map((t) => t.split('\n')[0]);
    assert.ok(shabbat[0].includes('רש"י') && shabbat[1].includes('תוספות'), `Rashi #1 on the Bavli, then Tosafot: ${shabbat}`);
    assert.ok((await page.locator('[data-testid^="tree-commentary-"]').first().innerText()).includes('עיקריים'), 'tier badge');
    step('מפרשים לפי ספר: a base book lists all its commentaries together in rank order (Bavli: רש"י #1, תוספות #2)');

    // Commentary filter: a commentator name finds the books it comments on.
    await tid('library-crumb-root').click();
    await tid('library-filter').fill('רש"י');
    await tid('library-results').waitFor();
    const byRashi = (await page.locator('[data-testid="library-results"] [data-testid^="tree-book-"]').allInnerTexts()).map((t) => t.split('\n')[0]);
    assert.deepStrictEqual(byRashi, ['בראשית', 'שבת']);
    await tid('library-filter-clear').click();

    await tid('library-mode-base').click();

    // Themes: the segmented toggle follows the palette (accent fill), RTL stays.
    const accentOf = () => tid('library-mode-base').evaluate((el) => getComputedStyle(el).backgroundColor);
    assert.strictEqual(await accentOf(), 'rgb(138, 90, 18)', 'בהיר');
    for (const [theme, rgb] of [['sepia', 'rgb(139, 74, 28)'], ['dark', 'rgb(210, 174, 109)']]) {
      await page.evaluate((t) => {
        const k = 'kodeshread.appearance';
        const v = JSON.parse(localStorage.getItem(k) || '{"state":{},"version":1}');
        v.state.theme = t;
        localStorage.setItem(k, JSON.stringify(v));
      }, theme);
      await page.reload();
      await tid('library-mode-base').last().waitFor({ timeout: 60000 });
      await page.waitForFunction((c) => getComputedStyle([...document.querySelectorAll('[data-testid="library-mode-base"]')].pop()).backgroundColor === c, rgb, { timeout: 20000 });
      assert.strictEqual(await tid('library-filter').last().evaluate((el) => getComputedStyle(el).textAlign), 'right');
      await shot(`library-${theme}`);
    }
    await page.evaluate(() => {
      const k = 'kodeshread.appearance';
      const v = JSON.parse(localStorage.getItem(k));
      v.state.theme = 'light';
      localStorage.setItem(k, JSON.stringify(v));
    });
    await page.reload();
    await tid('library-mode-base').last().waitFor({ timeout: 60000 });
    step('בהיר / ספיה / כהה themes, RTL filter');

    // Persisted path + open a book from a column.
    await sec('תנ"ך').last().click();
    await page.locator('[data-testid="library-column-1"] [data-testid^="tree-sec-"]').last().first().click();
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

    // --- Cloud card: storage warning + themes (reloads: after the remove-core flow, see the web-preview quirk above) ---
    await page.goto(BASE + '/', { timeout: 180000 });
    await tid('open-library-manager').last().waitFor({ timeout: 180000 });
    await tid('open-library-manager').last().click();
    await tid('cloud-info-full').last().waitFor({ timeout: 60000 });
    // Low free storage: warn clearly (zip + extracted DB + 500 MB), still allow "continue anyway".
    const need = cloudManifest.totalZipBytes + cloudManifest.uncompressedDbBytes + 500 * 1024 * 1024;
    await page.evaluate((v) => sessionStorage.setItem('e2e.freeBytes', String(v)), need - 1024);
    await page.goto(BASE + '/', { timeout: 180000 });
    await tid('open-library-manager').last().click();
    await tid('cloud-storage-warning-full').waitFor();
    await tid('cloud-storage-warning-classic').waitFor();
    const warn = await tid('cloud-storage-warning-full').innerText();
    assert.ok(/אין מספיק מקום פנוי/.test(warn) && /500 MB/.test(warn.replace(/[\u2066-\u2069]/g, '')), warn);
    await shot('cloud-warning');
    step('cloud card warns when free space < zip + DB + 500 MB');
    await page.evaluate(() => sessionStorage.removeItem('e2e.freeBytes'));
    await page.goto(BASE + '/', { timeout: 180000 });
    await tid('open-library-manager').last().click();
    await tid('cloud-info-full').waitFor();
    assert.strictEqual(await tid('cloud-storage-warning-full').count(), 0);

    // Themes: the card follows the palette.
    const cardBg = () => tid('cloud-edition-full').last().evaluate((el) => getComputedStyle(el).backgroundColor);
    const lightBg = await cardBg();
    await page.evaluate(() => {
      const k = 'kodeshread.appearance';
      const v = JSON.parse(localStorage.getItem(k) || '{"state":{},"version":1}');
      v.state.theme = 'dark';
      localStorage.setItem(k, JSON.stringify(v));
    });
    await page.reload();
    await tid('cloud-info-full').last().waitFor({ timeout: 60000 });
    const darkBg = await cardBg();
    assert.notStrictEqual(darkBg, lightBg, `card background follows the theme (${lightBg} / ${darkBg})`);
    await shot('cloud-dark');
    await page.evaluate(() => {
      const k = 'kodeshread.appearance';
      const v = JSON.parse(localStorage.getItem(k));
      v.state.theme = 'sepia';
      localStorage.setItem(k, JSON.stringify(v));
    });
    await page.reload();
    await tid('cloud-info-full').last().waitFor({ timeout: 60000 });
    assert.notStrictEqual(await cardBg(), lightBg, 'sepia differs from light');
    await page.evaluate(() => {
      const k = 'kodeshread.appearance';
      const v = JSON.parse(localStorage.getItem(k));
      v.state.theme = 'light';
      localStorage.setItem(k, JSON.stringify(v));
    });
    await page.reload();
    await tid('cloud-info-full').last().waitFor({ timeout: 60000 });
    step('cloud card in בהיר / ספיה / כהה');

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
    // No ארץ ישראל / חו"ל switch any more: the device time zone decides (this run: Asia/Jerusalem -> ארץ ישראל).
    assert.strictEqual(await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone), 'Asia/Jerusalem');
    for (const id of ['daily-loc-il', 'daily-loc-diaspora']) assert.strictEqual(await tid(id).count(), 0, `${id} is gone`);
    assert.ok(!(await last('library-daily').innerText()).includes('חו"ל') && !(await last('library-daily').innerText()).includes('ארץ ישראל'), 'no location chips in the bar');
    assert.strictEqual((await last('daily-title-parasha').innerText()).trim(), 'בהעלותך · שני');
    assert.ok((await last('daily-item-parasha').innerText()).includes('במדבר ח\' ט"ו'), 'בהעלותך שני = במדבר ח טו');
    for (const key of ['dafYomi', 'mishna', 'rambam1', 'rambam3']) {
      assert.ok((await last(`daily-item-${key}`).innerText()).includes('לא נמצא בספרייה'), `${key} greyed (not in the sample)`);
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
    // A device outside Israel is the Diaspora (it read Shavuot on Shabbat, so this week is still נשא); an unknown zone falls back to Israel.
    const withZone = async (tz) => {
      await page.evaluate((z) => (z ? sessionStorage.setItem('e2e.tz', z) : sessionStorage.removeItem('e2e.tz')), tz);
      await page.reload();
      await last('daily-item-parasha').waitFor({ timeout: 60000 });
    };
    await withZone('America/New_York');
    await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="daily-title-parasha"]')].pop()?.innerText.trim() === 'נשא · שני');
    assert.ok((await last('daily-item-parasha').innerText()).includes('במדבר ד\' ל"ח'));
    assert.strictEqual(await page.evaluate(() => 'il' in (JSON.parse(localStorage.getItem('kodeshread.learning'))?.state ?? {})), false, 'no stored location preference');
    await withZone('Asia/Jerusalem');
    await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="daily-title-parasha"]')].pop()?.innerText.trim() === 'בהעלותך · שני');
    // (An unreadable zone falls back to Israel: covered in `npm test`.) The tap below runs on the Diaspora parsha.
    await withZone('America/New_York');
    await last('daily-item-parasha').click();
    await page.waitForFunction(() => /^במדבר/.test(document.querySelector('[data-testid="reader-breadcrumb"]')?.innerText || '') && document.querySelector('[data-testid="reader-breadcrumb"]').innerText.includes('פרק ד'), null, { timeout: 20000 });
    await page.waitForFunction(() => [...document.querySelectorAll('[data-testid^="aliyah-divider-"]')].some((e) => e.innerText.trim() === 'שני' && e.getBoundingClientRect().height > 0));
    await shot('daily-opened');
    await last('reader-back').click();
    await page.evaluate(() => sessionStorage.removeItem('e2e.tz'));
    await last('library-daily-toggle').click();
    step('לימוד יומי bar: no location switch; the device time zone picks the parsha (Asia/Jerusalem בהעלותך, elsewhere נשא; unknown -> Israel), missing books greyed, tap opens the aliyah');

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
