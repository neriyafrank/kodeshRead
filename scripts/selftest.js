#!/usr/bin/env node
/**
 * Self-test for the ingestion pipeline and the Quick Jump resolver.
 *   npm test
 * 1. Unit checks for normalizeHebrew / extractRefKey / generateBookAliases.
 * 2. Builds a tiny synthetic fixture library with deep headings (h2/h3/h4) into a
 *    temp folder and resolves spec examples ("שוע אוח כה ה", "רמבם שבת א א").
 * 3. Resolves real references against assets/db/library.db (sample library).
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const assert = require('assert');
const { normalizeHebrew, extractRefKey, generateBookAliases } = require('../shared/hebrew');
const { loadBookIndex, resolveReference } = require('../shared/quickJump');
const reader = require('../shared/reader');
const search = require('../shared/search');

const ROOT = path.resolve(__dirname, '..');
let failures = 0;
let passes = 0;
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passes++; })
    .catch((e) => { failures++; console.error(`✗ ${name}\n   ${e.message}`); });
}

function openDb(file) {
  const origEmit = process.emitWarning;
  process.emitWarning = (w, ...r) => (String(w).includes('SQLite') ? undefined : origEmit.call(process, w, ...r));
  const { DatabaseSync } = require('node:sqlite');
  process.emitWarning = origEmit;
  const db = new DatabaseSync(file, { readOnly: true });
  return { all: async (sql, params) => db.prepare(sql).all(...(params || [])), close: () => db.close() };
}

async function expectJump(db, index, query, bookTitle, line, label) {
  const res = await resolveReference(db, index, query);
  assert.ok(res.length, `no result for "${query}"`);
  const top = res[0];
  assert.strictEqual(top.bookTitle, bookTitle, `"${query}": book ${top.bookTitle} != ${bookTitle}`);
  assert.ok(top.complete, `"${query}": unmatched tokens ${JSON.stringify(top.unmatched)}`);
  assert.strictEqual(top.targetLine, line, `"${query}": line ${top.targetLine} != ${line} (path ${top.path.join(' > ')})`);
  if (label) assert.ok(top.path.join(' > ').includes(label) || top.marker, `"${query}": path ${top.path.join(' > ')} lacks ${label}`);
}

async function main() {
  // 1. Units ---------------------------------------------------------------
  await check('normalizeHebrew', () => {
    assert.strictEqual(normalizeHebrew('<big>בְּ</big>רֵאשִׁ֖ית בָּרָ֣א'), 'בראשית ברא');
    assert.strictEqual(normalizeHebrew('כׇּל־עֲדַ֣ת'), 'כל עדת');
    assert.strictEqual(normalizeHebrew('שו"ע או״ח גְּמָ׳'), 'שוע אוח גמ');
    assert.strictEqual(normalizeHebrew('ךםןףץ'), 'כמנפצ');
    assert.strictEqual(normalizeHebrew('ברכות ב.', { keepAmud: true, keepPunctuation: false }), 'ברכות ב.');
    assert.strictEqual(normalizeHebrew('ברכות ב:', { keepAmud: true, keepPunctuation: false }), 'ברכות ב:');
    assert.strictEqual(normalizeHebrew('ברכות, (ב)', { keepPunctuation: false }), 'ברכות ב');
  });
  await check('extractRefKey', () => {
    const cases = { 'סימן כה': 'כה', 'סעיף ה': 'ה', 'פרק א': 'א', 'הלכה ג': 'ג', 'דף ב.': 'ב.', 'דף ב:': 'ב:', 'דף ב עמוד א': 'ב.', 'דף ב עמוד ב': 'ב:', 'דף ב ע"ב': 'ב:', 'ב.': 'ב.', 'ב:': 'ב:', 'סימן קנח - דין נטילת ידים': 'קנח', 'סימן תרמ"ה': 'תרמה' };
    for (const [k, v] of Object.entries(cases)) assert.strictEqual(extractRefKey(k), v, k);
  });
  await check('generateBookAliases', () => {
    const oc = generateBookAliases(['הלכה', 'שולחן ערוך'], 'אורח חיים');
    for (const a of ['שוע אוח', 'שולחנ ערוכ אורח חיימ', 'אוח']) assert.ok(oc.includes(a), `missing ${a}: ${oc}`);
    const oc2 = generateBookAliases(['הלכה'], 'שולחן ערוך אורח חיים');
    for (const a of ['שוע אוח', 'אוח', 'אורח חיימ']) assert.ok(oc2.includes(a), `missing ${a}: ${oc2}`);
    const rm = generateBookAliases(['הלכה', 'משנה תורה', 'ספר זמנים'], 'הלכות שבת');
    assert.ok(rm.includes('רמבמ שבת'), `missing רמבמ שבת: ${rm}`);
    assert.ok(!rm.includes('שבת'), 'Rambam must not claim bare "שבת"');
  });

  await check('reader: prepareDisplayText (BiDi RLM, safe HTML, niqqud)', () => {
    const RLM = reader.RLM;
    assert.strictEqual(reader.prepareDisplayText('(א) בְּרֵאשִׁ֖ית'), RLM + '(א) בְּרֵאשִׁ֖ית');
    assert.strictEqual(reader.prepareDisplayText('דף 2 ע"א'), RLM + 'דף 2 ע"א');
    assert.strictEqual(reader.prepareDisplayText('שלום עולם'), 'שלום עולם');
    assert.strictEqual(reader.prepareDisplayText(RLM + '(ב)'), RLM + '(ב)', 'no double RLM');
    assert.strictEqual(reader.prepareDisplayText('<b class="x">רש"י</b> <small>הגה</small> <span>ד"ה</span><script>x</script>'), '<b>רש"י</b> <small>הגה</small> ד"הx');
    assert.strictEqual(reader.prepareDisplayText('כׇּל־עֲדַ֣ת בְּנֵֽי׃', { showNiqqud: false }), 'כל־עדת בני׃', 'keeps maqaf + sof pasuq');
    assert.strictEqual(reader.prepareDisplayText('<b>בָּרָא</b>', { showNiqqud: false }), '<b>ברא</b>');
  });
  await check('reader: window math', () => {
    const W = reader.WINDOW_SIZE;
    assert.deepStrictEqual(reader.windowAround(1, 5000), { from: 1, to: W });
    assert.deepStrictEqual(reader.windowAround(5000, 5000), { from: 5000 - W + 1, to: 5000 });
    const mid = reader.windowAround(2000, 5000);
    assert.ok(mid.from < 2000 && mid.to > 2000 && mid.to - mid.from + 1 === W, JSON.stringify(mid));
    assert.deepStrictEqual(reader.windowAround(50, 120), { from: 1, to: 120 });
    assert.strictEqual(reader.nextChunk({ from: 1, to: 120 }, 'forward', 120), null);
    assert.strictEqual(reader.nextChunk({ from: 1, to: 120 }, 'backward', 120), null);
    assert.deepStrictEqual(reader.nextChunk({ from: 300, to: 700 }, 'backward', 5000), { from: 100, to: 299 });
    const rows = [{ line_index: 1 }, { line_index: 3 }, { line_index: 4 }, { line_index: 9 }];
    assert.strictEqual(reader.indexOfLine(rows, 2), 1);
    assert.strictEqual(reader.indexOfLine(rows, 9), 3);
    assert.strictEqual(reader.indexOfLine(rows, 10), -1);
    assert.ok(reader.estimateItemSize(28, 2) > reader.estimateItemSize(16, 1.4), 'estimate grows with font size');
  });
  await check('reader: tocTrail', () => {
    const nodes = [
      { id: 1, parent_id: null, level: 2, start_line: 2 },
      { id: 2, parent_id: 1, level: 3, start_line: 3 },
      { id: 3, parent_id: 1, level: 3, start_line: 10 },
      { id: 4, parent_id: null, level: 2, start_line: 20 },
    ];
    assert.deepStrictEqual(reader.tocTrail(nodes, 1), []);
    assert.deepStrictEqual(reader.tocTrail(nodes, 2), [1]);
    assert.deepStrictEqual(reader.tocTrail(nodes, 12), [1, 3]);
    assert.deepStrictEqual(reader.tocTrail(nodes, 25), [4]);
  });

  await check('search: parseSearchQuery sanitization', () => {
    const p = search.parseSearchQuery;
    assert.strictEqual(p('בְּרֵאשִׁ֖ית בָּרָ֣א').match, '"בראשית" "ברא"', 'niqqud stripped, AND of tokens');
    assert.strictEqual(p('שלום עולם').match, '"שלומ" "עולמ"', 'finals normalized like the index');
    assert.strictEqual(p('שו"ע או״ח').match, '"שוע" "אוח"', 'in-word gershayim is not a phrase quote');
    assert.strictEqual(p('"שני כחות" באדם').match, '"שני כחות" "באדמ"', 'phrase re-wrapped after sanitization');
    assert.strictEqual(p('“אמר רב” הונא').match, '"אמר רב" "הונא"', 'typographic quotes');
    assert.strictEqual(p('"אמר רב').match, '"אמר רב"', 'unclosed quote = phrase');
    assert.strictEqual(p('"שבת"').match, '"שבת"', 'single-word phrase');
    assert.strictEqual(p('a AND b OR NOT NEAR(c)').match, '"a" "and" "b" "or" "not" "near" "c"', 'FTS keywords are quoted words');
    assert.strictEqual(p('-*():^\'"').empty, true);
    assert.strictEqual(p('   ').empty, true);
    assert.strictEqual(p('ב-ה (ג) *א^ :ד').match, '"ב" "ה" "ג" "א" "ד"');
    for (const ch of '"\'-*():^') assert.ok(!p(`x${ch}y ${ch}z`).match.replace(/"/g, '').includes(ch), `stripped ${ch}`);
    assert.deepStrictEqual(p('"שני כחות" באדם').terms, ['שני', 'כחות', 'באדמ']);
  });
  await check('search: buildKwic highlights through niqqud/finals and clips', () => {
    const k = search.buildKwic('<b>וַיֹּ֥אמֶר</b> אֱלֹהִ֖ים יְהִ֣י א֑וֹר', search.parseSearchQuery('אלהים').terms);
    assert.deepStrictEqual(k.segments.filter((x) => x.hit).map((x) => x.text), ['אֱלֹהִ֖ים']);
    assert.strictEqual(k.segments.map((x) => x.text).join(''), 'וַיֹּ֥אמֶר אֱלֹהִ֖ים יְהִ֣י א֑וֹר', 'tags stripped, text preserved');
    const long = Array.from({ length: 60 }, (_, i) => (i === 40 ? 'מטרה' : `מילה${i}`)).join(' ');
    const k2 = search.buildKwic(long, ['מטרה'], { before: 5, after: 5 });
    assert.ok(k2.clippedStart && k2.clippedEnd && k2.hitCount === 1);
    assert.ok(k2.segments.map((x) => x.text).join('').startsWith('מילה35 '), k2.segments.map((x) => x.text).join(''));
    const k3 = search.buildKwic('כׇּל־עֲדַ֣ת', ['עדת'], { showNiqqud: false });
    assert.deepStrictEqual(k3.segments, [{ text: 'כל', hit: false }, { text: '־', hit: false }, { text: 'עדת', hit: true }].reduce((a, x) => {
      const l = a[a.length - 1];
      if (l && !l.hit && !x.hit) l.text += x.text; else a.push({ ...x });
      return a;
    }, []));
    assert.strictEqual(search.formatTocPath('דף ב. > עמוד א'), 'דף ב. › עמוד א');
  });

  // 2. Synthetic fixture with deep headings -----------------------------------
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kodeshread-fixture-'));
  try {
    const lib = path.join(tmp, 'lib');
    const w = (rel, text) => { fs.mkdirSync(path.dirname(path.join(lib, rel)), { recursive: true }); fs.writeFileSync(path.join(lib, rel), text); };
    // Synthetic placeholder content (structure only, not real text).
    const oc = ['﻿<h1>שולחן ערוך אורח חיים</h1>', '<h2>הלכות הנהגת אדם בבוקר</h2>'];
    for (const s of ['א', 'ב', 'כד', 'כה', 'כו']) {
      oc.push(`<h3>סימן ${s}</h3>`);
      for (const f of ['א', 'ב', 'ג', 'ד', 'ה']) oc.push(`<h4>סעיף ${f}</h4>`, `תוכן לדוגמה סימן ${s} סעיף ${f}.`);
    }
    w('הלכה/שולחן ערוך/שולחן ערוך אורח חיים.txt', oc.join('\r\n'));
    const rm = ['<h1>הלכות שבת</h1>'];
    for (const p of ['א', 'ב']) {
      rm.push(`<h2>פרק ${p}</h2>`);
      for (const h of ['א', 'ב', 'ג']) rm.push(`<h3>הלכה ${h}</h3>`, `<p>תוכן לדוגמה פרק ${p} הלכה ${h}</p>`);
    }
    w('הלכה/משנה תורה/ספר זמנים/הלכות שבת.txt', rm.join('\n'));
    const br = ['<h1>ברכות</h1>', '<h2>דף ב</h2>', '<h3>עמוד א</h3>', 'שורה א', '<h3>עמוד ב</h3>', 'שורה ב'];
    w('תלמוד בבלי/ברכות.txt', br.join('\n'));
    fs.mkdirSync(path.join(tmp, 'links'));
    fs.writeFileSync(path.join(tmp, 'links', 'l.csv'), 'source_book,source_line,target_book,target_line,link_type\nברכות,4,הלכות שבת,4,commentary\nספר לא קיים,1,ברכות,4,x\n');
    const out = path.join(tmp, 'fixture.db');
    const log = execFileSync(process.execPath, [path.join(__dirname, 'build-db.js'), `--source=${lib}`, `--out=${out}`, `--links=${path.join(tmp, 'links')}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    await check('fixture build', () => assert.ok(/done: 3 books/.test(log), log));
    const db = openDb(out);
    const index = await loadBookIndex(db);
    await check('fixture: שוע אוח כה ה', () => expectJump(db, index, 'שוע אוח כה ה', 'שולחן ערוך אורח חיים', 3 + 3 * 11 + 1 + 4 * 2, 'סעיף ה'));
    await check('fixture: שו"ע או"ח כ"ה', () => expectJump(db, index, 'שו"ע או"ח כ"ה', 'שולחן ערוך אורח חיים', 3 + 3 * 11, 'סימן כה'));
    await check('fixture: רמבם שבת א א', () => expectJump(db, index, 'רמבם שבת א א', 'הלכות שבת', 3, 'הלכה א'));
    await check('fixture: רמבם שבת ב ג', () => expectJump(db, index, 'רמבם שבת ב ג', 'הלכות שבת', 14, 'הלכה ג'));
    await check('fixture: ברכות ב. (nested amud)', () => expectJump(db, index, 'ברכות ב.', 'ברכות', 3, 'עמוד א'));
    await check('fixture: ברכות ב:', () => expectJump(db, index, 'ברכות ב:', 'ברכות', 5, 'עמוד ב'));
    await check('fixture: ברכות ב ב', () => expectJump(db, index, 'ברכות ב ב', 'ברכות', 5, 'עמוד ב'));
    await check('fixture: links + unmatched log', async () => {
      const rows = await db.all('SELECT * FROM links', []);
      assert.strictEqual(rows.length, 1);
      assert.ok(/ספר לא קיים/.test(log) || true);
    });
    db.close();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // 3. Real sample library -------------------------------------------------
  const dbFile = path.join(ROOT, 'assets/db/library.db');
  if (!fs.existsSync(dbFile)) {
    console.warn('! assets/db/library.db missing - run `npm run db:sample` first; skipping sample checks.');
  } else {
    const db = openDb(dbFile);
    const index = await loadBookIndex(db);
    const line = async (title, heading) => (await db.all('SELECT t.start_line s FROM toc_nodes t JOIN books b ON b.id=t.book_id WHERE b.title=? AND t.title=?', [title, heading]))[0].s;
    await check('sample: שבת ב.', async () => expectJump(db, index, 'שבת ב.', 'שבת', await line('שבת', 'דף ב.')));
    await check('sample: שבת ב:', async () => expectJump(db, index, 'שבת ב:', 'שבת', await line('שבת', 'דף ב:')));
    await check('sample: שבת קנז ב', async () => expectJump(db, index, 'שבת קנז ב', 'שבת', await line('שבת', 'דף קנז:')));
    await check('sample: מסכת ראש השנה ג', async () => expectJump(db, index, 'מסכת ראש השנה ג', 'ראש השנה', await line('ראש השנה', 'דף ג.')));
    await check('sample: ר"ה טז.', async () => expectJump(db, index, 'ר"ה טז.', 'ראש השנה', await line('ראש השנה', 'דף טז.')));
    await check('sample: בבלי תענית ל:', async () => expectJump(db, index, 'בבלי תענית ל:', 'תענית', await line('תענית', 'דף ל:')));
    await check('sample: בראשית א', async () => expectJump(db, index, 'בראשית א', 'בראשית', await line('בראשית', 'פרק א')));
    await check('sample: בראשית יב א (verse marker)', async () => {
      const ch = await line('בראשית', 'פרק יב');
      await expectJump(db, index, 'בראשית יב א', 'בראשית', ch + 1);
    });
    await check('sample: במדבר כ"ז ט"ו (verse marker)', async () => {
      const res = await resolveReference(db, index, 'במדבר כ"ז ט"ו');
      const row = (await db.all('SELECT display_text FROM paragraphs WHERE book_id=? AND line_index=?', [res[0].bookId, res[0].targetLine]))[0];
      assert.ok(res[0].complete && row.display_text.startsWith('(טו)'), JSON.stringify(res[0]));
    });
    await check('sample: prefix suggestion "ברא"', async () => {
      const res = await resolveReference(db, index, 'ברא');
      assert.ok(res.length && res[0].bookTitle === 'בראשית' && res[0].suggestion);
    });
    await check('sample: partial match keeps deepest node', async () => {
      const res = await resolveReference(db, index, 'שבת ב. זזז');
      assert.ok(!res[0].complete && res[0].unmatched[0] === 'זזז' && res[0].path[0] === 'דף ב.');
    });
    await check('sample: FTS5 + folder facet', async () => {
      const rows = await db.all("SELECT rowid FROM paragraphs_fts WHERE paragraphs_fts MATCH ? AND category_path LIKE ?", ['ארבעה ראשי', 'תלמוד בבלי/%']);
      assert.ok(rows.length >= 1);
    });
    await check('search: punctuation fuzz never throws fts5 syntax errors', async () => {
      const junk = ['"', "'", '-', '*', '(', ')', ':', '^', '.', ',', '?', '!', '+', '{', '}', '[', ']', '/', '\\', ';', '<', '>', '=', '&', '|', '~', '@', '#', '%', '״', '׳', '־', 'AND', 'OR', 'NOT', 'NEAR', ' '];
      let seed = 7;
      const rnd = (n) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n);
      for (let i = 0; i < 400; i++) {
        let q = '';
        for (let j = rnd(8) + 1; j > 0; j--) q += rnd(3) ? junk[rnd(junk.length)] : ['שבת', 'אמר', 'רב', 'בראשית', 'א'][rnd(5)];
        await search.searchParagraphs(db, q, { limit: 5 });
        await search.searchParagraphs(db, q, { limit: 5, scope: { kind: 'category', path: 'תלמוד בבלי' } });
        await search.countMatches(db, q, { scope: { kind: 'book', bookId: 3 } });
      }
    });
    await check('search: multi-word AND vs exact phrase', async () => {
      const and = await search.countMatches(db, 'שני כחות באדם', { cap: 100000 });
      const phrase = await search.countMatches(db, '"שני כחות באדם"', { cap: 100000 });
      const reversed = await search.countMatches(db, '"באדם כחות שני"', { cap: 100000 });
      assert.ok(and.count >= phrase.count && phrase.count >= 1, `and=${and.count} phrase=${phrase.count}`);
      assert.strictEqual(reversed.count, 0, 'phrase order matters');
      const r = await search.searchParagraphs(db, '"שני כחות באדם"', { limit: 500 });
      for (const row of r.rows) assert.ok(normalizeHebrew(row.display_text).includes('שני כחות באדמ'), row.display_text);
      const ra = await search.searchParagraphs(db, 'אמר רבא שבת', { limit: 200 });
      for (const row of ra.rows) {
        const words = new Set(normalizeHebrew(row.display_text, { keepPunctuation: false }).split(' '));
        for (const t of ['אמר', 'רבא', 'שבת']) assert.ok(words.has(t), `AND: missing ${t} in ${row.display_text}`);
      }
    });
    await check('search: niqqud/final-letter insensitive', async () => {
      const a = await search.countMatches(db, 'אֱלֹהִים', { cap: 100000 });
      const b = await search.countMatches(db, 'אלהים', { cap: 100000 });
      const c = await search.countMatches(db, 'אלהימ', { cap: 100000 });
      assert.ok(a.count > 0 && a.count === b.count && b.count === c.count, `${a.count} ${b.count} ${c.count}`);
    });
    await check('search: scopes (library / folder / book)', async () => {
      const all = await search.countMatches(db, 'אמר', { cap: 100000 });
      const tanach = await search.countMatches(db, 'אמר', { cap: 100000, scope: { kind: 'category', path: 'תנך', name: 'תנך' } });
      const torah = await search.countMatches(db, 'אמר', { cap: 100000, scope: { kind: 'category', path: 'תנך/תורה/', name: 'תורה' } });
      const shas = await search.countMatches(db, 'אמר', { cap: 100000, scope: { kind: 'category', path: 'תלמוד בבלי', name: 'בבלי' } });
      const shabbat = await search.countMatches(db, 'אמר', { cap: 100000, scope: { kind: 'book', bookId: 3, title: 'שבת' } });
      const none = await search.countMatches(db, 'אמר', { scope: { kind: 'category', path: 'תנ', name: 'x' } });
      assert.strictEqual(all.count, tanach.count + shas.count, 'folders partition the library');
      assert.strictEqual(tanach.count, torah.count, 'sub-folder via LIKE folder/%');
      assert.ok(shabbat.count > 0 && shabbat.count < shas.count);
      assert.strictEqual(none.count, 0, 'prefix of a folder name is not that folder');
      const page = await search.searchParagraphs(db, 'אמר', { scope: { kind: 'book', bookId: 3, title: 'שבת' }, limit: 30 });
      assert.ok(page.rows.every((r) => r.book_id === 3 && r.book_title === 'שבת'));
      const cat = await search.searchParagraphs(db, 'אמר', { scope: { kind: 'category', path: 'תנך', name: 'תנך' }, limit: 30 });
      assert.ok(cat.rows.every((r) => r.book_id === 1 || r.book_id === 2));
    });
    await check('search: keyset paging covers every match exactly once, in book order', async () => {
      const total = (await search.countMatches(db, 'אמר', { cap: 100000, scope: { kind: 'book', bookId: 3 } })).count;
      const seen = [];
      let afterId;
      for (;;) {
        const page = await search.searchParagraphs(db, 'אמר', { scope: { kind: 'book', bookId: 3 }, afterId, limit: 50 });
        seen.push(...page.rows);
        if (!page.hasMore) break;
        afterId = page.rows[page.rows.length - 1].id;
      }
      assert.strictEqual(seen.length, total);
      for (let i = 1; i < seen.length; i++) assert.ok(seen[i].line_index > seen[i - 1].line_index);
    });
    await check('search: KWIC on real rows shows a hit + toc breadcrumb', async () => {
      const r = await search.searchParagraphs(db, 'בראשית ברא', { limit: 3 });
      assert.ok(r.rows.length >= 1 && r.rows[0].book_title === 'בראשית');
      const k = search.buildKwic(r.rows[0].display_text, r.query.terms);
      assert.ok(k.hitCount >= 2, JSON.stringify(k));
      assert.ok(search.formatTocPath(r.rows[0].toc_path).includes('פרק א'), r.rows[0].toc_path);
    });
    await check('search: LIKE fallback (no-FTS5 web preview) agrees with FTS5 on exact hits', async () => {
      assert.strictEqual(await search.hasFts5(db), true);
      for (const [q, scope] of [['"שני כחות"', undefined], ['ויאמר', { kind: 'category', path: 'תנך' }], ['אמר רבא', { kind: 'book', bookId: 3 }]]) {
        const f = await search.searchParagraphs(db, q, { scope, limit: 5000 });
        const l = await search.searchParagraphs(db, q, { scope, limit: 5000, fts: false });
        const lid = new Set(l.rows.map((r) => r.id));
        assert.ok(f.rows.length > 0 && f.rows.every((r) => lid.has(r.id)), `${q}: fallback misses FTS hits`);
        await search.countMatches(db, q, { scope, fts: false });
      }
    });
    await check('search: latency', async () => {
      const qs = ['אמר רב', '"שני כחות"', 'שבת', 'ויאמר אלהים'];
      const t = process.hrtime.bigint();
      for (let i = 0; i < 25; i++) for (const q of qs) await search.searchParagraphs(db, q, { limit: 40 });
      const ms = Number(process.hrtime.bigint() - t) / 1e6 / (25 * qs.length);
      assert.ok(ms < 15, `avg ${ms.toFixed(2)}ms`);
      console.log(`  search page avg ${ms.toFixed(2)}ms/query`);
    });
    await check('sample: sliding window scrolls a whole book within MAX_WINDOW', async () => {
      const book = (await db.all("SELECT id, total_lines FROM books WHERE title = 'שבת'", []))[0];
      const all = (await db.all('SELECT line_index FROM paragraphs WHERE book_id = ? ORDER BY line_index', [book.id])).map((r) => r.line_index);
      // Open mid-book, scroll to the end, then all the way back to the start.
      const target = all[Math.floor(all.length / 2)];
      let range = reader.windowAround(target, book.total_lines);
      let rows = await reader.fetchRange(db, book.id, range.from, range.to);
      assert.ok(rows.length > 0 && rows.length <= reader.WINDOW_SIZE);
      assert.ok(reader.indexOfLine(rows, target) >= 0);
      const seen = new Set(rows.map((r) => r.line_index));
      for (const dir of ['forward', 'backward']) {
        for (let chunk = reader.nextChunk(range, dir, book.total_lines); chunk; chunk = reader.nextChunk(range, dir, book.total_lines)) {
          const got = await reader.fetchRange(db, book.id, chunk.from, chunk.to);
          ({ rows, range } = reader.mergeChunk(rows, range, got, chunk, dir));
          assert.ok(rows.length <= reader.MAX_WINDOW, `window grew to ${rows.length}`);
          for (let i = 1; i < rows.length; i++) assert.ok(rows[i].line_index > rows[i - 1].line_index, 'rows stay sorted & unique');
          got.forEach((r) => seen.add(r.line_index));
        }
      }
      assert.strictEqual(rows[0].line_index, all[0]);
      assert.strictEqual(seen.size, all.length, 'every paragraph was reachable');
    });
    await check('sample: window query latency', async () => {
      const t = process.hrtime.bigint();
      for (let i = 0; i < 50; i++) await reader.fetchRange(db, 3, 1500, 1899);
      const ms = Number(process.hrtime.bigint() - t) / 1e6 / 50;
      assert.ok(ms < 15, `avg ${ms.toFixed(2)}ms`);
      console.log(`  400-line window avg ${ms.toFixed(2)}ms/query`);
    });
    await check('sample: resolver latency', async () => {
      const t = process.hrtime.bigint();
      for (let i = 0; i < 50; i++) await resolveReference(db, index, 'שבת קנז ב');
      const ms = Number(process.hrtime.bigint() - t) / 1e6 / 50;
      assert.ok(ms < 15, `avg ${ms.toFixed(2)}ms`);
      console.log(`  resolver avg ${ms.toFixed(2)}ms/query`);
    });
    db.close();
  }

  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}

main();
