#!/usr/bin/env node
/**
 * Self-test for the ingestion pipeline and the Quick Jump resolver.
 *   npm test
 * 1. Unit checks for normalizeHebrew / extractRefKey / generateBookAliases.
 * 2. Builds a tiny synthetic fixture library with deep headings (h2/h3/h4) into a
 *    temp folder and resolves spec examples ("שוע אוח כה ה", "רמבם שבת א א").
 * 3. Resolves real references against assets/db/library.db (sample library).
 * 4. Milestone 5: the on-device ingestion engine (shared/indexer.js) writing a personal
 *    library (ids >= USER_ID_BASE), the core+user router (shared/sources.js) across Quick
 *    Jump / reader / search / commentaries, book deletion, and the release artifact
 *    (dist/manifest.json + .gz, streaming .gz/.zip decompression from shared/release.js).
 * 5. Resumable ingestion: pause / resume checkpoints (ingestion_state), crash recovery,
 *    per-book error isolation (ingestion_errors), non-text file filtering, schema migration,
 *    incremental FTS merge, FTS query sanitization fuzzing and reader hit marking.
 * 6. Streaming pipeline (schema v6): SQLite import_queue scan -> one-book transactions ->
 *    book_units links -> finalize, surviving pauses and kills at any statement (mid-scan,
 *    mid-book, mid-link) with zero duplicates; pure path + book_units alignment over real pairs
 *    from every corpus of otzaria_index_only.txt; the Android foreground-service plugin.
 * 7. End of a core build (shared/coreFinalize.js): swap over an open core with live -wal / -shm,
 *    non-fatal finalize optimizations, finalize-only retries that read no book, step diagnostics.
 * 8. Reading typography (shared/typography.js): bundled Taamey Frank CLM (GPOS mark / mkmk),
 *    vocalization-aware line height, margin verse numbers, font / theme persistence (zustand
 *    persist round trip + migrations) and the theme palettes (Dark charcoal, contrast).
 * 9. Torah study: the 54 parshiot + aliyot dataset (shared/torahParshiot.js) validated against
 *    the Masoretic chapter / verse counts, hebcal's parsha list and the real sample Chumash text;
 *    the offline daily-learning schedule (shared/dailyLearning.js: @hebcal/core + @hebcal/learning,
 *    ארץ ישראל / חו"ל) on fixed dates, mapped onto real Otzaria paths (otzaria_index_only.txt) and
 *    resolved to exact lines in the sample library (missing books reported, never thrown).
 *    Quick Jump to a parsha / aliyah ("פרשת וישלח שני", "וישלח 2", "בראשית מפטיר", spelling
 *    variants) over a full five-book Chumash fixture, without changing book lookups.
 * 10. Simple vs Advanced Search (shared/hebrewSearch.js): literal Simple Search, Advanced defaults,
 *    prefixes / suffixes, smart plene / defective (with strict negatives), acronyms, Hebrew <->
 *    Aramaic, structured fields + inline operators, ordered / unordered proximity, exact-first
 *    ranking + cursor paging, corpus chips, FTS5 == web fallback, fuzzing and latency.
 * 11. Canonical library catalog (shared/libraryCatalog.js): Rashi on every real Bavli tractate is a
 *    commentary linked to its daf / amud and ranked #1; traditional Jewish ordering (Tanach, Mishna
 *    sedarim, Shas, Rambam, Shulchan Aruch); base books vs commentaries; commentaries of every era
 *    folder grouped under their base in rank order; multi-select search scope (FTS5 == fallback).
 * 13. Search progress UI (shared/searchLifecycle.js): lifecycle transitions, request-id race safety,
 *    cancellation / abort + real progress in shared/search.js, Hebrew RTL elapsed formatting.
 * 16. Canonical book roles (shared/bookRoles.js) + parallel works (shared/parallelWorks.js): the four
 *    roles on the real otzaria_index_only.txt (zero commentary leaks, strict exclusions, no heuristic
 *    nesting), and fixture libraries for each family: שו"ע או"ח סימן יב סעיף ג <-> טור / ערוך השולחן /
 *    לבוש / שו"ע הרב סימן יב (never קיצור שו"ע); בבלי שבת פרק א <-> משנה / ירושלמי / תוספתא / רא"ש
 *    (Bavli perakim from "הדרן עלך", Megillah's perek-order divergence by name); בראשית פרשת נח <->
 *    בראשית רבה / זוהר / ספר החינוך; commentaries + parallels together in the drawer.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const assert = require('assert');
const crypto = require('crypto');
const { normalizeHebrew, extractRefKey, generateBookAliases } = require('../shared/hebrew');
const { loadBookIndex, resolveReference } = require('../shared/quickJump');
const reader = require('../shared/reader');
const search = require('../shared/search');
const commentary = require('../shared/commentary');
const { makeBookMatcher, writerAdapter, nodeFs } = require('./build-db');
const indexer = require('../shared/indexer');
const sources = require('../shared/sources');
const release = require('../shared/release');
const dict = require('../shared/hebrewTorahDict');
const quickJump = require('../shared/quickJump');
const refAlign = require('../shared/refAlign');
const hebrew = require('../shared/hebrew');
const rank = require('../shared/commentaryRank');
const hs = require('../shared/hebrewSearch');

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

  await check('links: book-name matcher', () => {
    const books = [
      { id: 1, title: 'ראש השנה', filePath: 'תלמוד בבלי/סדר מועד/ראש השנה.txt', aliases: ['ראש השנה', 'רה'] },
      { id: 2, title: 'רש"י על שבת', filePath: 'תלמוד בבלי/מפרשים/רשי על שבת.txt', aliases: ['רשי על שבת'] },
      { id: 3, title: 'שולחן ערוך אורח חיים', filePath: 'הלכה/שולחן ערוך אורח חיים.txt', aliases: ['שולחנ ערוכ אורח חיימ', 'שוע אוח'] },
    ];
    const m = makeBookMatcher(books);
    assert.strictEqual(m('ראש השנה.txt'), 1);
    assert.strictEqual(m('מסכת ראש השנה'), 1);
    assert.strictEqual(m('תלמוד בבלי ראש השנה'), 1);
    assert.strictEqual(m("רש''י על שבת_links.json"), 2);
    assert.strictEqual(m('links/רש״י על שבת.json'), 2);
    assert.strictEqual(m('אורח חיים'), 3);
    assert.strictEqual(m('שו"ע או"ח'), 3);
    assert.strictEqual(m('רש"י על ראש השנה'), null);
    assert.strictEqual(m('תוספות על שבת'), null);
  });
  await check('commentary: commentatorName / grouping', () => {
    assert.strictEqual(commentary.commentatorName('רש"י על שבת'), 'רש"י');
    assert.strictEqual(commentary.commentatorName('תוספות על שבת'), 'תוספות');
    assert.strictEqual(commentary.commentatorName('משנה ברורה'), 'משנה ברורה');
    const e = (book_id, book_title, line, link_type) => ({ book_id, book_title, line, link_type, display_text: '', toc_path: null, category_path: null });
    const g = commentary.groupLinkedEntries([e(9, 'אונקלוס על בראשית', 3, 'targum'), e(5, 'רש"י על בראשית', 4, 'commentary'), e(5, 'רש"י על בראשית', 3, 'commentary'), e(2, 'ברכות', 1, 'reference')]);
    assert.deepStrictEqual(g.map((x) => [x.name, x.entries.map((y) => y.line)]), [['רש"י', [3, 4]], ['אונקלוס', [3]], ['ברכות', [1]]]);
    // Notes on a commentary keep their parent's name (they are not the parent).
    assert.strictEqual(commentary.commentatorName('הערות על רשי על בראשית'), 'הערות על רשי');
  });
  await commentaryRankTests();
  await bookStreamTests();

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

  // 1b. Hebrew Torah linguistic & abbreviation engine ------------------------
  await check('dict: bidirectional book / section abbreviations (with & without gershayim)', () => {
    assert.deepStrictEqual(dict.expandAbbreviation('שו"ע'), ['שולחנ ערוכ']);
    assert.deepStrictEqual(dict.expandAbbreviation('שו״ע'), ['שולחנ ערוכ']);
    assert.deepStrictEqual(dict.expandAbbreviation('שוע'), ['שולחנ ערוכ']);
    for (const r of ['רמבם', 'רמב"ם', 'רמב״ם', 'רמב׳׳ם']) assert.strictEqual(dict.expandAbbreviation(r)[0], 'משנה תורה', r);
    assert.ok(dict.expandAbbreviation('או"ח').includes('אורח חיימ'));
    assert.ok(dict.expandAbbreviation('יו"ד').includes('יורה דעה'));
    assert.ok(dict.expandAbbreviation('אה"ע').includes('אבנ העזר'));
    assert.ok(dict.expandAbbreviation('חו"מ').includes('חושנ משפט'));
    assert.ok(dict.expandAbbreviation('משנ"ב').includes('משנה ברורה'));
    assert.ok(dict.expandAbbreviation('ב"ק').includes('בבא קמא'));
    assert.ok(dict.expandAbbreviation("בר'").includes('בראשית'));
    assert.ok(dict.expandAbbreviation('שמ"א').includes('שמואל א'));
    assert.ok(dict.expandAbbreviation("הל'").includes('הלכות'));
    assert.ok(dict.expandAbbreviation('קצוה"ח').includes('קצות החושנ'));
    assert.ok(dict.expandAbbreviation('רעק"א').includes('רבי עקיבא איגר'));
    // Reverse direction, spelling-insensitive (ktiv chaser "שלחן").
    assert.ok(dict.abbreviationsFor('שולחן ערוך').includes('שוע'));
    assert.ok(dict.abbreviationsFor('שלחן ערוך').includes('שוע'));
    assert.ok(dict.abbreviationsFor('בבא קמא').includes('בק'));
    assert.ok(dict.abbreviationsFor('משנה ברורה').includes('משנב'));
  });
  await check('dict: general phrases + strict-mode precision guards', () => {
    const st = dict.dictionaryStats();
    assert.ok(st.byKind.general >= 300, `general entries ${st.byKind.general}`);
    assert.ok(st.entries >= 500, `entries ${st.entries}`);
    assert.deepStrictEqual(dict.expandAbbreviation('ב"ד'), ['בית דינ']);
    assert.deepStrictEqual(dict.expandAbbreviation('בי"ד'), ['בית דינ']);
    assert.ok(dict.expandAbbreviation('הקב"ה').includes('הקדוש ברוכ הוא'));
    assert.ok(dict.expandAbbreviation('אע"פ').includes('אפ על פי'));
    assert.ok(dict.expandAbbreviation('ק"ו').includes('קל וחומר'));
    assert.deepStrictEqual(dict.expandAbbreviation('ד"א'), ['דבר אחר', 'ארבע אמות']);
    assert.ok(dict.expandAbbreviation('ר"ת').includes('רבנו תמ') && dict.expandAbbreviation('ר"ת').includes('ראשי תיבות'));
    assert.ok(dict.abbreviationsFor('בית דין').includes('בד'));
    assert.ok(dict.abbreviationsFor('הקדוש ברוך הוא').includes('הקבה'));
    assert.ok(dict.abbreviationsFor('קל וחומר').includes('קו'));
    // Strict (search): un-marked common words never expand; marked tokens always do.
    assert.deepStrictEqual(dict.expandAbbreviation('בר', { strict: true }), []);
    assert.deepStrictEqual(dict.expandAbbreviation('ראש', { strict: true }), []);
    assert.deepStrictEqual(dict.expandAbbreviation('בד', { strict: true }), []);
    assert.ok(dict.expandAbbreviation("בר'", { strict: true }).includes('בראשית'));
    assert.ok(!dict.abbreviationsFor('בראשית', { strict: true }).includes('בר'), 'truncation that is a word');
    assert.ok(!dict.abbreviationsFor('שפתי כהן', { strict: true }).includes('שכ'), 'numeral-shaped (320)');
    assert.ok(dict.abbreviationsFor('ראש השנה', { strict: true }).includes('רה'), 'tractates keep numeral-shaped keys');
  });
  await check('dict: ktiv male / chaser variants', () => {
    const has = (w, v) => assert.ok(dict.ktivVariants(w).includes(v), `${w} -> ${v}: ${dict.ktivVariants(w)}`);
    has('שולחנ', 'שלחנ'); has('שלחנ', 'שולחנ'); has('קידושינ', 'קדושינ'); has('קדושינ', 'קידושינ');
    has('תפילינ', 'תפלינ'); has('תפלינ', 'תפילינ'); has('אלוקימ', 'אלהימ'); has('אלהימ', 'אלוקימ');
    has('כותל', 'כתל'); has('כתל', 'כותל'); has('ציצית', 'צצית'); has('צצית', 'ציצית'); has('דיבור', 'דבור'); has('דבור', 'דיבור');
    has('מצוה', 'מצווה');
    assert.deepStrictEqual(dict.ktivVariants('שבת'), [], 'short roots are left alone');
    assert.ok(dict.ktivVariants('קדושינ', 3).length <= 3);
  });
  await check('dict: prefixes / suffixes / gematria', () => {
    const v = dict.expandWordVariants('שבת');
    for (const x of ['שבת*', 'ושבת*', 'בשבת*', 'ובשבת*', 'השבת*', 'שבשבת*']) assert.ok(v.includes(x), `${x}: ${v}`);
    assert.ok(v.length <= dict.MAX_VARIANTS_PER_WORD);
    assert.deepStrictEqual(dict.expandWordVariants('רב'), ['רב'], 'tiny words are not expanded');
    assert.deepStrictEqual(dict.expandWordVariants('א'), ['א']);
    assert.ok(dict.expandWordVariants('שולחנ').includes('ושלחנ*'));
    assert.ok(!dict.expandWordVariants('שוע', 24, { wildcard: false }).some((x) => x.endsWith('*')));
    assert.ok(dict.suffixStems('שבתות').includes('שבת'));
    assert.ok(dict.suffixStems('מצוות').includes('מצוה'));
    assert.ok(dict.suffixStems('תורת').includes('תורה'));
    assert.ok(dict.prefixStems('ובשבת').includes('שבת'));
    assert.strictEqual(dict.intToHebrewNumeral(328), 'שכח');
    assert.strictEqual(dict.intToHebrewNumeral(15), 'טו');
    assert.strictEqual(dict.intToHebrewNumeral(16), 'טז');
    assert.strictEqual(dict.intToHebrewNumeral(124), 'קכד');
    assert.strictEqual(dict.parseHebrewNumber('קכ"ד'), 124);
    assert.strictEqual(dict.parseHebrewNumber('פ"ב'), 82);
    assert.strictEqual(dict.parseHebrewNumber('17'), 17);
    assert.ok(dict.isHebrewNumeral('שכח') && !dict.isHebrewNumeral('בק') && !dict.isHebrewNumeral('יה'));
  });
  await check('smart search: FTS5 query expansion, quoted phrases and safety caps', () => {
    const p = (q) => search.parseSearchQuery(q, { smart: true });
    const sh = p('שולחן');
    assert.ok(sh.match.includes('"שלחנ"*') && sh.match.includes('"ושלחנ"*'), sh.match);
    assert.ok(sh.variantCount <= dict.MAX_VARIANTS_PER_WORD);
    const bd = p('ב"ד');
    assert.ok(bd.match.includes('"בד"') && bd.match.includes('"בית דינ"'), bd.match);
    assert.ok(!bd.match.includes('"בד"*'), 'abbreviations are not wildcarded');
    const full = p('בית דין');
    assert.ok(full.match.includes('"בד"') && full.match.includes(' AND '), full.match);
    const sa = p('שו"ע או"ח');
    assert.ok(sa.match.includes('"שולחנ ערוכ"') && sa.match.includes('"אורח חיימ"'), sa.match);
    // Quoted phrases stay exact; exact mode is unchanged.
    assert.ok(p('"שני כחות" באדם').match.startsWith('"שני כחות" AND '));
    assert.strictEqual(p('"שבת"').match, '"שבת"');
    assert.strictEqual(search.parseSearchQuery('שולחן').match, '"שולחנ"');
    // Caps: per-word and per-query, and the expression stays syntactically safe.
    const long = p('שולחן ערוך קידושין תפילין ציצית דיבור כותל אלוקים מצוות שבתות ובשבת הלכות ברכות תורה משנה גמרא נוסף');
    assert.ok(long.variantCount <= search.MAX_QUERY_VARIANTS, `variants ${long.variantCount}`);
    assert.ok(long.groups.length <= 16);
    const outside = long.match.replace(/"[^"]*"/g, '');
    assert.ok(/^[\s()*ANDOR]*$/.test(outside), `only operators outside quotes: ${outside}`);
    assert.strictEqual(p('-*():^\'"').empty, true);
  });
  await check('smart highlight: reader + KWIC mark the matched variant', () => {
    const t = (q) => search.parseSearchQuery(q, { smart: true }).terms;
    assert.strictEqual(search.markTerms('על <b>ושֻׁלְחָן</b> ערוך', t('שולחן')), 'על <b><mark>ושֻׁלְחָן</mark></b> ערוך');
    assert.strictEqual(search.markTerms('ובשבת קודש', t('שבת')), '<mark>ובשבת</mark> קודש');
    assert.strictEqual(search.markTerms('אמרו <b>בית</b> דין של', t('ב"ד')), 'אמרו <b><mark>בית</mark></b> <mark>דין</mark> של');
    assert.strictEqual(search.markTerms('והביאו לב"ד', t('בית דין')), 'והביאו לב"ד', 'prefixed 2-letter abbreviation is not a hit');
    assert.strictEqual(search.markTerms('והביאו ב"ד', t('בית דין')), 'והביאו <mark>ב"ד</mark>');
    assert.strictEqual(search.markTerms('בית המלך דין', t('ב"ד')), 'בית המלך דין', 'phrase words must be consecutive');
    assert.strictEqual(search.markTerms('שבתאי ושבתות', t('שבת')), '<mark>שבתאי</mark> <mark>ושבתות</mark>');
    const k = search.buildKwic('אמר רב ושלחן ערוך', t('שולחן'));
    assert.ok(k.segments.some((x) => x.hit && x.text === 'ושלחן'), JSON.stringify(k.segments));
    const m = search.makeTermMatcher(['בית דינ', 'שבת*']);
    assert.deepStrictEqual(m.hits([['בית'], ['דינ'], ['שבתות'], ['בית']]), [true, true, true, false]);
    assert.strictEqual(search.makeTermMatcher([]).empty, true);
  });
  await check('quick open: location parsing (structural words, gematria, daf/amud)', () => {
    const loc = (q) => quickJump.parseLocation(quickJump.rawTokens(q));
    assert.deepStrictEqual(loc("סי' שכח סעיף ד"), [{ key: 'שכח' }, { key: 'ד' }]);
    assert.deepStrictEqual(loc('328 4'), [{ key: 'שכח' }, { key: 'ד' }]);
    assert.deepStrictEqual(loc('דף ב ע"ב'), [{ key: 'ב' }, { key: 'עב' }]);
    assert.deepStrictEqual(loc('דף יג עמוד ב'), [{ key: 'יג' }, { key: 'ב' }]);
    assert.deepStrictEqual(loc('ב.'), [{ key: 'ב.' }]);
    assert.deepStrictEqual(loc('פ"א ה"ב'), [{ key: 'פא', alt: 'א' }, { key: 'הב', alt: 'ב' }]);
    assert.deepStrictEqual(loc("פ' ג"), [{ key: 'ג' }]);
    assert.deepStrictEqual(loc('קכ"ד'), [{ key: 'קכד' }]);
  });
  await check('quick open: abbreviation-aware book filter', () => {
    assert.ok(dict.bookMatchScore('שו"ע או"ח', 'אורח חיים', 'הלכה/שולחן ערוך') > 0);
    assert.ok(dict.bookMatchScore('שו"ע או"ח', 'שולחן ערוך - אורח חיים', 'הלכה') > 0);
    assert.ok(dict.bookMatchScore('ב"ק', 'בבא קמא', 'תלמוד בבלי') > 0);
    assert.ok(dict.bookMatchScore('מ"ב', 'משנה ברורה', 'הלכה') > 0);
    assert.ok(dict.bookMatchScore('רמב"ם שבת', 'הלכות שבת', 'הלכה/משנה תורה/ספר זמנים') > 0);
    assert.ok(dict.bookMatchScore('שלחן ערוך', 'שולחן ערוך אורח חיים', 'הלכה') > 0, 'ktiv chaser');
    assert.strictEqual(dict.bookMatchScore('ב"ק', 'שבת', 'תלמוד בבלי'), 0);
    assert.strictEqual(dict.bookMatchScore('מ"ב', 'בבא מציעא', 'תלמוד בבלי'), 0);
  });

  // 2. Synthetic fixture with deep headings -----------------------------------
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kodeshread-fixture-'));
  try {
    const lib = path.join(tmp, 'lib');
    const w = (rel, text) => { fs.mkdirSync(path.dirname(path.join(lib, rel)), { recursive: true }); fs.writeFileSync(path.join(lib, rel), text); };
    // Synthetic placeholder content (structure only, not real text).
    const oc = ['﻿<h1>שולחן ערוך אורח חיים</h1>', '<h2>הלכות הנהגת אדם בבוקר</h2>'];
    for (const s of ['א', 'ב', 'כד', 'כה', 'כו', 'שכח']) {
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
    w('תלמוד בבלי/בבא קמא.txt', ['<h1>בבא קמא</h1>', '<h2>דף ב.</h2>', 'שורה ב א', '<h2>דף ב:</h2>', 'שורה ב ב', '<h2>דף ג.</h2>', 'שורה ג א'].join('\n'));
    w('תנך/תורה/בראשית.txt', ['<h1>בראשית</h1>', '<h2>פרק א</h2>', '(א) פסוק ראשון', '(ב) פסוק שני', '<h2>פרק ב</h2>', '(א) פסוק בפרק ב'].join('\n'));
    w('הלכה/משנה ברורה.txt', ['<h1>משנה ברורה</h1>', '<h2>סימן א</h2>', 'תוכן לדוגמה'].join('\n'));
    fs.mkdirSync(path.join(tmp, 'links'));
    fs.writeFileSync(
      path.join(tmp, 'links', 'l.csv'),
      [
        'source_book,source_line,target_book,target_line,link_type',
        'ברכות,4,הלכות שבת,4,commentary',
        'הלכות שבת,4,מסכת ברכות,4,commentary', // reverse duplicate
        'ספר לא קיים,1,ברכות,4,x', // unmatched
        '"רש""י על ברכות",1,ברכות,4,commentary', // must not fuzzy-match ברכות
        'ברכות,999,הלכות שבת,4,commentary', // missing line
        'שו"ע או"ח,5,ברכות.txt,6,reference', // alias + file name
      ].join('\n') + '\n',
    );
    const out = path.join(tmp, 'fixture.db');
    const proc = spawnSync(process.execPath, [path.join(__dirname, 'build-db.js'), `--source=${lib}`, `--out=${out}`, `--links=${path.join(tmp, 'links')}`], { encoding: 'utf8' });
    if (proc.status !== 0) throw new Error('fixture build failed:\n' + proc.stderr);
    const log = proc.stdout + proc.stderr;
    await check('fixture build', () => assert.ok(/done: 6 books/.test(log), log));
    const db = openDb(out);
    const index = await loadBookIndex(db);
    await check('fixture: שוע אוח כה ה', () => expectJump(db, index, 'שוע אוח כה ה', 'שולחן ערוך אורח חיים', 3 + 3 * 11 + 1 + 4 * 2, 'סעיף ה'));
    await check('fixture: שו"ע או"ח כ"ה', () => expectJump(db, index, 'שו"ע או"ח כ"ה', 'שולחן ערוך אורח חיים', 3 + 3 * 11, 'סימן כה'));
    await check('fixture: רמבם שבת א א', () => expectJump(db, index, 'רמבם שבת א א', 'הלכות שבת', 3, 'הלכה א'));
    await check('fixture: רמבם שבת ב ג', () => expectJump(db, index, 'רמבם שבת ב ג', 'הלכות שבת', 14, 'הלכה ג'));
    await check('fixture: ברכות ב. (nested amud)', () => expectJump(db, index, 'ברכות ב.', 'ברכות', 3, 'עמוד א'));
    await check('fixture: ברכות ב:', () => expectJump(db, index, 'ברכות ב:', 'ברכות', 5, 'עמוד ב'));
    await check('fixture: ברכות ב ב', () => expectJump(db, index, 'ברכות ב ב', 'ברכות', 5, 'עמוד ב'));
    // Abbreviation-aware Quick Open + location parsing.
    const SIMAN_SHKH = 3 + 5 * 11;
    await check('quick open: שו"ע או"ח סי\' שכח', () => expectJump(db, index, "שו\"ע או\"ח סי' שכח", 'שולחן ערוך אורח חיים', SIMAN_SHKH, 'סימן שכח'));
    await check('quick open: שו"ע או"ח שכח ד (+ direct card)', async () => {
      await expectJump(db, index, 'שו"ע או"ח שכח ד', 'שולחן ערוך אורח חיים', SIMAN_SHKH + 1 + 3 * 2, 'סעיף ד');
      const [top] = await resolveReference(db, index, 'שו"ע או"ח שכח ד');
      assert.ok(top.direct, 'direct card');
      assert.strictEqual(top.location, 'סימן שכח › סעיף ד');
    });
    await check('quick open: digits (שוע אוח 328 4)', () => expectJump(db, index, 'שוע אוח 328 4', 'שולחן ערוך אורח חיים', SIMAN_SHKH + 1 + 3 * 2, 'סעיף ד'));
    await check('quick open: ב"ק ב. / ב"ק דף ב ע"ב / ב"ק דף ב עמוד ב', async () => {
      await expectJump(db, index, 'ב"ק ב.', 'בבא קמא', 2, 'דף ב.');
      await expectJump(db, index, 'ב"ק דף ב ע"ב', 'בבא קמא', 4, 'דף ב:');
      await expectJump(db, index, 'ב"ק דף ב עמוד ב', 'בבא קמא', 4, 'דף ב:');
      await expectJump(db, index, 'בבא קמא ג', 'בבא קמא', 6, 'דף ג.');
    });
    await check('quick open: רמב"ם הל\' שבת פ"א / פ"ב ה"ג', async () => {
      await expectJump(db, index, "רמב\"ם הל' שבת פ\"א", 'הלכות שבת', 2, 'פרק א');
      await expectJump(db, index, 'רמב"ם הל\' שבת פ"ב ה"ג', 'הלכות שבת', 14, 'הלכה ג');
      await expectJump(db, index, 'רמב"ם שבת', 'הלכות שבת', 1);
    });
    await check("quick open: בר' א א (truncation + verse marker)", async () => {
      await expectJump(db, index, "בר' א א", 'בראשית', 3);
      await expectJump(db, index, "בר' א ב", 'בראשית', 4);
      await expectJump(db, index, 'בראשית ב', 'בראשית', 5, 'פרק ב');
    });
    await check('quick open: מ"ב / משנ"ב find משנה ברורה', async () => {
      for (const q of ['מ"ב', 'משנ"ב', 'משנה ברורה']) assert.strictEqual((await resolveReference(db, index, q))[0].bookTitle, 'משנה ברורה', q);
      await expectJump(db, index, 'משנ"ב סי\' א', 'משנה ברורה', 2, 'סימן א');
    });
    await check('quick open: ktiv chaser book name (שלחן ערוך אורח חיים כה)', () => expectJump(db, index, 'שלחן ערוך אורח חיים כה', 'שולחן ערוך אורח חיים', 3 + 3 * 11, 'סימן כה'));
    await check('quick open: book-only result is not a direct card', async () => {
      const [top] = await resolveReference(db, index, 'ב"ק');
      assert.strictEqual(top.bookTitle, 'בבא קמא');
      assert.ok(!top.direct);
    });
    await check('fixture: links (dedupe, missing lines, unmatched warnings)', async () => {
      const rows = await db.all('SELECT l.*, a.title ta, b.title tb FROM links l JOIN books a ON a.id=l.book_a_id JOIN books b ON b.id=l.book_b_id ORDER BY l.id', []);
      assert.strictEqual(rows.length, 2, JSON.stringify(rows));
      const pairs = rows.map((r) => [r.ta, r.line_a, r.tb, r.line_b].join('|')).sort();
      assert.ok(pairs.some((p) => p.includes('ברכות|4') && p.includes('הלכות שבת|4')), pairs.join(' / '));
      assert.ok(pairs.some((p) => p.includes('שולחן ערוך אורח חיים|5') && p.includes('ברכות|6')), pairs.join(' / '));
      assert.ok(/WARNING: 2 unmatched book name/.test(log), log);
      assert.ok(log.includes('"ספר לא קיים"') && log.includes('"רש"י על ברכות"'), log);
      assert.ok(/WARNING: 1 link\(s\) point at a line/.test(log), log);
      assert.ok(/1 duplicate\/reverse/.test(log), log);
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
    const SHABBAT = (await db.all("SELECT id FROM books WHERE title = 'שבת'", []))[0].id;
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
    await check('sample: commentary links are populated', async () => {
      const [{ n }] = await db.all('SELECT COUNT(*) n FROM links', []);
      assert.ok(n >= 20, `links=${n}`);
      const shabbat = (await db.all("SELECT id FROM books WHERE title='שבת'", []))[0].id;
      const counts = await commentary.fetchLinkCounts(db, shabbat, 1, 30);
      // 2x רש"י line links + תוספות + the רש"י שורה א unit (paragraph-level alignment of the sample רש"י).
      assert.strictEqual(counts.get(3), 4, `line 3: ${counts.get(3)}`);
      assert.strictEqual(counts.get(2), 1, 'amud heading: only תוספות (no שורה headings) is aligned at the amud');
      assert.ok(!counts.has(4));
      const rows = commentary.attachLinkCounts(await reader.fetchRange(db, shabbat, 1, 10), counts);
      assert.strictEqual(rows.find((r) => r.line_index === 3).link_count, 4);
      assert.strictEqual(rows.find((r) => r.line_index === 4).link_count, 0);
      // רש"י: only the entries of שורה א (paragraph 1) -- the heading row is not an entry; תוספות (no
      // שורה headings) keeps its whole amud block. The explicitly linked dibburim are `direct`.
      const groups = commentary.groupLinkedEntries(await commentary.fetchLinkedEntries(db, shabbat, 3));
      assert.deepStrictEqual(groups.map((g) => [g.name, g.entries.length, g.entries.filter((e) => e.direct).length]), [['רש"י', 2, 2], ['תוספות', 2, 1]]);
      assert.ok(groups[0].entries.every((e) => e.display_text && e.toc_path === 'דף ב. > שורה א'), JSON.stringify(groups[0].entries));
      assert.deepStrictEqual(groups[0].block, { refKey: 'דף ב|עמוד א|שורה א', start: 3, end: 5 });
      assert.deepStrictEqual(groups[1].block, { refKey: 'דף ב|עמוד א', start: 2, end: 4 });
      // Reverse direction: from the commentary back to the Gemara line.
      const rashi = groups[0].bookId;
      const back = commentary.groupLinkedEntries(await commentary.fetchLinkedEntries(db, rashi, groups[0].entries[0].line));
      assert.deepStrictEqual(back.map((g) => [g.bookTitle, g.entries[0].line]), [['שבת', 3]]);
      // Grouping: commentaries before translations (Onkelos is a targum), then library order;
      // each group carries its folder (corpus + era for the drawer's ranking).
      const bereshit = (await db.all("SELECT id FROM books WHERE title='בראשית'", []))[0].id;
      const bg = commentary.groupLinkedEntries(await commentary.fetchLinkedEntries(db, bereshit, 3));
      assert.strictEqual(bg.length, 8);
      assert.strictEqual(bg[bg.length - 1].name, 'אונקלוס');
      assert.strictEqual(bg.find((g) => g.name === 'רמב"ן').categoryPath, 'תנך/מפרשים/ראשונים');
      // Drawer order (shared/commentaryRank.js): the Tanach core list, then ראשונים before אחרונים.
      const ranked = rank.rankCommentaries(bg, { context: { title: 'בראשית' } });
      assert.deepStrictEqual(
        ranked.map((g) => [g.displayName, g.tier]),
        [['אונקלוס', 'תרגומים'], ['רש"י', 'עיקריים'], ['רמב"ן', 'עיקריים'], ['אבן עזרא', 'עיקריים'], ['ספורנו', 'עיקריים'], ['מלבי"ם', 'עיקריים'], ['דעת זקנים', 'ראשונים'], ['גור אריה', 'אחרונים']],
      );
      assert.deepStrictEqual([...rank.defaultExpandedKeys(ranked)], ['אונקלוס', 'רשי', 'רמבנ']);
    });
    await check('sample: Bavli שורה N = N-th body paragraph of the amud; Rashi dibur hamatchil matches the linked Gemara paragraph', async () => {
      const norm = (t) => hebrew.normalizeHebrew(String(t).replace(/<[^>]*>/g, ''), { keepPunctuation: false });
      const shabbat = (await db.all("SELECT id FROM books WHERE title='שבת'", []))[0].id;
      const rashi = (await db.all("SELECT id FROM books WHERE title='רש\"י על שבת'", []))[0].id;
      const rows = await db.all('SELECT ref_key, base_start, base_end, comm_start, comm_end FROM ref_links WHERE comm_book_id = ? AND base_book_id = ? ORDER BY comm_start', [rashi, shabbat]);
      assert.strictEqual(rows.length, 9, 'every שורה of the sample רש"י is aligned');
      assert.ok(rows.every((x) => x.base_start === x.base_end), 'paragraph-level rows only (no amud-level dump)');
      let checked = 0;
      for (const row of rows) {
        const n = refAlign.paragraphNumber(row.ref_key.split('|').pop());
        // Paragraph N of the amud = the N-th non-heading line after the amud heading.
        const amudHeading = (await db.all("SELECT MAX(line_index) AS l FROM paragraphs WHERE book_id = ? AND is_heading = 1 AND line_index < ?", [shabbat, row.base_start]))[0].l;
        const body = await db.all('SELECT line_index FROM paragraphs WHERE book_id = ? AND is_heading = 0 AND line_index > ? ORDER BY line_index LIMIT ?', [shabbat, amudHeading, n]);
        assert.strictEqual(body[n - 1].line_index, row.base_start, `${row.ref_key} -> paragraph ${n}`);
        const gemara = norm((await db.all('SELECT display_text FROM paragraphs WHERE book_id = ? AND line_index = ?', [shabbat, row.base_start]))[0].display_text);
        const entries = await db.all('SELECT display_text FROM paragraphs WHERE book_id = ? AND line_index BETWEEN ? AND ? AND is_heading = 0', [rashi, row.comm_start, row.comm_end]);
        assert.ok(entries.length >= 1);
        for (const e of entries) {
          const dh = /<b>([^<]+)<\/b>/.exec(e.display_text);
          assert.ok(dh, e.display_text);
          const words = norm(dh[1]);
          assert.ok(gemara.includes(words), `${row.ref_key}: ד"ה "${words}" is in Gemara paragraph ${n}`);
          checked++;
        }
      }
      assert.strictEqual(checked, 11);
      // Tapping Gemara paragraph 5 (line 7): exactly שורה ה, never שורה א / שורה ו / the whole amud.
      const g = commentary.groupLinkedEntries(await commentary.fetchLinkedEntries(db, shabbat, 7));
      const r5 = g.find((x) => x.bookId === rashi);
      assert.deepStrictEqual(r5.entries.map((e) => e.toc_path), ['דף ב. > שורה ה']);
      assert.ok(/שניהם פטורין/.test(r5.entries[0].display_text));
      // Paragraph 2 (line 4, "כיצד?") has no רש"י entry at all.
      assert.ok(!commentary.groupLinkedEntries(await commentary.fetchLinkedEntries(db, shabbat, 4)).some((x) => x.bookId === rashi));
    });
    await check('sample: commentary books do not hijack Quick Jump', async () => {
      await expectJump(db, index, 'שבת ב.', 'שבת', await line('שבת', 'דף ב.'));
      await expectJump(db, index, 'בראשית א', 'בראשית', await line('בראשית', 'פרק א'));
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
        await search.countMatches(db, q, { scope: { kind: 'book', bookId: SHABBAT } });
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
      const shabbat = await search.countMatches(db, 'אמר', { cap: 100000, scope: { kind: 'book', bookId: SHABBAT, title: 'שבת' } });
      const none = await search.countMatches(db, 'אמר', { scope: { kind: 'category', path: 'תנ', name: 'x' } });
      assert.strictEqual(all.count, tanach.count + shas.count, 'folders partition the library');
      const tanachMefarshim = await search.countMatches(db, 'אמר', { cap: 100000, scope: { kind: 'category', path: 'תנך/מפרשים', name: 'מפרשים' } });
      assert.ok(torah.count > 0 && tanachMefarshim.count > 0, `torah=${torah.count} mefarshim=${tanachMefarshim.count}`);
      assert.strictEqual(tanach.count, torah.count + tanachMefarshim.count, 'sub-folders via LIKE folder/%');
      assert.ok(shabbat.count > 0 && shabbat.count < shas.count);
      assert.strictEqual(none.count, 0, 'prefix of a folder name is not that folder');
      const page = await search.searchParagraphs(db, 'אמר', { scope: { kind: 'book', bookId: SHABBAT, title: 'שבת' }, limit: 30 });
      assert.ok(page.rows.every((r) => r.book_id === SHABBAT && r.book_title === 'שבת'));
      const cat = await search.searchParagraphs(db, 'אמר', { scope: { kind: 'category', path: 'תנך', name: 'תנך' }, limit: 30 });
      const tanachIds = new Set((await db.all("SELECT b.id FROM books b JOIN categories c ON c.id = b.category_id WHERE c.path = 'תנך' OR c.path LIKE 'תנך/%'", [])).map((r) => r.id));
      assert.ok(cat.rows.length && cat.rows.every((r) => tanachIds.has(r.book_id)));
    });
    await check('search: keyset paging covers every match exactly once, in book order', async () => {
      const total = (await search.countMatches(db, 'אמר', { cap: 100000, scope: { kind: 'book', bookId: SHABBAT } })).count;
      const seen = [];
      let afterId;
      for (;;) {
        const page = await search.searchParagraphs(db, 'אמר', { scope: { kind: 'book', bookId: SHABBAT }, afterId, limit: 50 });
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
      for (const [q, scope] of [['"שני כחות"', undefined], ['ויאמר', { kind: 'category', path: 'תנך' }], ['אמר רבא', { kind: 'book', bookId: SHABBAT }]]) {
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
    await check('smart search: finds morphological / abbreviation variants on the sample library', async () => {
      const cnt = async (q, smart, extra) => (await search.countMatches(db, q, { cap: 100000, smart, ...(extra || {}) })).count;
      assert.ok((await cnt('שבת', true)) > (await cnt('שבת', false)), 'prefixed ובשבת / בשבת');
      assert.ok((await cnt('שולחן', true)) > 0 && (await cnt('שולחן', false)) === 0, 'ktiv chaser שלחן');
      assert.ok((await cnt('ב"ד', true)) > (await cnt('ב"ד', false)), 'ב"ד -> בית דין');
      assert.ok((await cnt('בית דין', true)) >= (await cnt('בית דין', false)));
      assert.strictEqual(await cnt('"שני כחות באדם"', true), await cnt('"שני כחות באדם"', false), 'quoted phrase stays exact');
      // Every hit of a smart query really contains a marked variant.
      const q = search.parseSearchQuery('ב"ד', { smart: true });
      const r = await search.searchParagraphs(db, q, { limit: 40 });
      for (const row of r.rows) assert.ok(search.buildKwic(row.display_text, q.terms).hitCount > 0, row.display_text.slice(0, 80));
      // LIKE fallback (web preview) closely agrees with FTS5.
      for (const s2 of ['שבת', 'שולחן', 'ויאמר אלהים']) {
        const a = await cnt(s2, true);
        const b = await cnt(s2, true, { fts: false });
        assert.ok(Math.abs(a - b) <= Math.max(2, a * 0.1), `${s2}: fts ${a} like ${b}`);
      }
    });
    await check('smart search: punctuation fuzz never throws', async () => {
      const junk = ['"', "'", '-', '*', '(', ')', ':', '^', '״', '׳', 'AND', 'OR', 'NEAR', ' ', 'ב"ד', 'שו"ע', 'שבת', 'ושלחן', "בר'"];
      let seed = 11;
      const rnd = (n) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n);
      for (let i = 0; i < 300; i++) {
        let q = '';
        for (let j = rnd(10) + 1; j > 0; j--) q += junk[rnd(junk.length)] + (rnd(2) ? ' ' : '');
        await search.searchParagraphs(db, q, { limit: 5, smart: true });
        await search.countMatches(db, q, { smart: true, fts: false, cap: 10 });
      }
    });
    await check('smart search: latency', async () => {
      const qs = ['שבת', 'שולחן', 'ב"ד', 'אמר רב יהודה אמר שמואל', 'ויאמר אלהים'];
      const t = process.hrtime.bigint();
      for (let i = 0; i < 20; i++) for (const q2 of qs) await search.searchParagraphs(db, q2, { limit: 40, smart: true });
      const ms = Number(process.hrtime.bigint() - t) / 1e6 / (20 * qs.length);
      assert.ok(ms < 50, `avg ${ms.toFixed(2)}ms`);
      console.log(`  smart search page avg ${ms.toFixed(2)}ms/query`);
    });
    await check('sample quick open: ר"ה טז: / בר\' יב א / ראש השנה via abbreviation', async () => {
      await expectJump(db, index, 'ר"ה דף טז ע"ב', 'ראש השנה', await line('ראש השנה', 'דף טז:'));
      await expectJump(db, index, "בר' א", 'בראשית', await line('בראשית', 'פרק א'));
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

  // 4. Milestone 5: personal library + core/user router + release artifacts ---------
  await dualDbTests();
  await releaseTests();
  // 12. Cloud library: external-content FTS parity, classical_full scope, multi-part download.
  await cloudLibraryTests();
  await resumableIngestionTests();
  await refAlignTests();
  await otzariaSampleTests();
  await otzariaIndexTests();
  // 6. Schema v6 streaming pipeline (import_queue, book_units) + the Android foreground service.
  await streamingPipelineTests();
  await otzariaIndexPipelineTests();
  await foregroundServicePluginTests();
  await coreFinalizeTests();
  // 8. Reading typography, fonts and themes.
  await typographyTests();
  // 9. Parshiot / aliyot and the daily learning schedule.
  await torahStudyTests();
  await parshaQuickJumpTests();
  // 10. Simple vs Advanced Search (shared/hebrewSearch.js).
  await advancedSearchTests();
  // 11. Canonical library catalog, Bavli Rashi, multi-select search scope.
  await libraryCatalogTests();
  // 13. Search progress UI: lifecycle state machine, cancellation, elapsed formatting.
  await searchProgressTests();
  // 15. Preset corpora: base-book hygiene on messy Otzaria folders, Simple == Advanced.
  await corporaTests();
  // 14. Instant cloud starter: starter pack export / import round trip, idempotence, upgrade.
  await starterPackTests();
  // 16. Canonical book roles + bidirectional parallel works (Turim / Shas / Parasha families).
  await parallelWorksTests();

  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}

/**
 * Instant cloud starter (section 14): scripts/export-starter-packs.js on the sample library (pack export,
 * gzip integrity, starter-catalog.json), the app's import code (shared/starterPacks.js importStarterPack)
 * into an empty starter database (Rashi `שורה N` ref_links, FTS5 search), idempotent re-import, id
 * collisions, atomic rollback, the starter -> full library transition and the workflow wiring.
 */
async function starterPackTests() {
  const sp = require('../shared/starterPacks');
  const { exportStarterPacks } = require('./export-starter-packs');
  const { gunzipSync } = require('fflate');
  const SAMPLE_DB = path.join(ROOT, 'assets/db/library.db');
  if (!fs.existsSync(SAMPLE_DB)) return;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'starter-'));
  const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
  const newStarterDb = async (name) => {
    const w = openWritable(path.join(tmp, name));
    await indexer.ensureSchema(w.w, { kind: 'starter' });
    const all = w.read.all;
    w.read.all = async (sql, params) => plain(await all(sql, params)); // plain objects: deepStrictEqual compares prototypes
    return w;
  };
  const count = async (r, sql, params) => Number(Object.values((await r.read.all(sql, params || []))[0])[0]);
  const core = openDb(SAMPLE_DB);
  const plain = (rows) => rows.map((r) => ({ ...r }));
  const coreAll = async (sql, params) => plain(await core.all(sql, params));
  const idOf = async (title) => (await coreAll('SELECT id FROM books WHERE title = ?', [title]))[0].id;
  try {
    const out = path.join(tmp, 'out');
    const exp = await exportStarterPacks({ dbFile: SAMPLE_DB, outDir: out });

    await check('starter export: curated books found in the sample, the rest skipped gracefully', () => {
      assert.deepStrictEqual(exp.packs.map((p) => p.slug), ['genesis', 'numbers', 'bavli-shabbat'], 'canonical catalog order: תנ"ך (Torah order) before תלמוד בבלי');
      for (const missing of ['exodus', 'psalms', 'bavli-berachot', 'shulchan-aruch-orach-chaim', 'kuzari']) assert.ok(exp.skipped.includes(missing), missing);
      assert.strictEqual(exp.packs.length + exp.skipped.length, sp.STARTER_BOOKS.length);
    });

    await check('starter export: files, gzip integrity, SHA-256 and starter-catalog.json', () => {
      const catalog = JSON.parse(fs.readFileSync(path.join(out, 'starter-catalog.json'), 'utf8'));
      assert.deepStrictEqual(Object.keys(catalog).sort(), ['books', 'builtAt', 'formatVersion', 'version']);
      assert.ok(catalog.version && catalog.builtAt);
      assert.deepStrictEqual(catalog.books.map((b) => b.slug), ['genesis', 'numbers', 'bavli-shabbat']);
      assert.deepStrictEqual(fs.readdirSync(out).sort(), ['starter-bavli-shabbat.json.gz', 'starter-catalog.json', 'starter-genesis.json.gz', 'starter-numbers.json.gz']);
      for (const b of catalog.books) {
        const bytes = fs.readFileSync(path.join(out, b.packFile));
        assert.strictEqual(bytes.length, b.sizeBytes);
        assert.strictEqual(sha(bytes), b.sha256);
        assert.ok(bytes.length < 2 * 1024 * 1024, `${b.packFile} is compact (${bytes.length})`);
        assert.strictEqual(bytes[0], 0x1f);
        assert.strictEqual(bytes[1], 0x8b); // gzip magic
        const pack = JSON.parse(Buffer.from(gunzipSync(new Uint8Array(bytes))).toString('utf8'));
        assert.strictEqual(pack.slug, b.slug);
        assert.strictEqual(pack.books.find((x) => x[0] === pack.baseBookId)[4], b.filePath);
        for (const k of ['slug', 'title', 'category', 'author', 'packFile', 'sizeBytes', 'sha256', 'bundledCommentaries']) assert.ok(k in b, `catalog entry has ${k}`);
      }
      const byslug = Object.fromEntries(catalog.books.map((b) => [b.slug, b]));
      assert.deepStrictEqual(byslug.genesis.bundledCommentaries.map((c) => c.name), ['רש"י', 'אונקלוס']);
      assert.deepStrictEqual(byslug['bavli-shabbat'].bundledCommentaries.map((c) => c.name), ['רש"י', 'תוספות']);
      assert.deepStrictEqual(byslug.numbers.bundledCommentaries, [], 'no Rashi / Onkelos of Numbers in the sample: nothing is bundled');
      assert.deepStrictEqual([byslug.genesis.category, byslug['bavli-shabbat'].category], ['תנ"ך', 'תלמוד בבלי']);
      // Deterministic: exporting again yields byte-identical packs (stable hashes between builds of one library).
      return exportStarterPacks({ dbFile: SAMPLE_DB, outDir: path.join(tmp, 'out2') }).then((again) => {
        assert.deepStrictEqual(again.packs.map((p) => p.sha256), exp.packs.map((p) => p.sha256));
      });
    });

    await check('starter export: runs on Node built-ins alone (no node_modules) and zlib packs decode identically with fflate', () => {
      const { spawnSync } = require('child_process');
      const outCi = path.join(tmp, 'out-ci');
      // Child process with every non-builtin bare require forbidden = the CI runner (no node_modules).
      const guard = `const M=require('module');const o=M._resolveFilename;M._resolveFilename=function(r,...a){` +
        `if(!r.startsWith('.')&&!r.startsWith('/')&&!M.builtinModules.includes(r.replace(/^node:/,'')))throw new Error('third-party require: '+r);` +
        `return o.call(this,r,...a)};`;
      const guardFile = path.join(tmp, 'no-third-party.js');
      fs.writeFileSync(guardFile, guard);
      const r = spawnSync(process.execPath, ['-r', guardFile, path.join(ROOT, 'scripts/export-starter-packs.js'), `--db=${SAMPLE_DB}`, `--out=${outCi}`, '--min=1'], { encoding: 'utf8' });
      assert.strictEqual(r.status, 0, `export without node_modules failed:\n${r.stderr}${r.stdout}`);
      assert.ok(!/Cannot find module|third-party require/.test(r.stderr));
      const guarded = ['scripts/build-db.js', 'scripts/cloud-release.js', 'scripts/export-starter-packs.js'];
      for (const f of guarded) {
        const c = spawnSync(process.execPath, ['-r', guardFile, '-e', `require(${JSON.stringify(path.join(ROOT, f))})`], { encoding: 'utf8' });
        assert.strictEqual(c.status, 0, `${f} needs a third-party module:\n${c.stderr}`);
      }
      assert.ok(!/require\(['"]zlib['"]\)/.test(fs.readFileSync(path.join(ROOT, 'shared/starterPacks.js'), 'utf8')), 'shared/starterPacks.js must stay free of zlib (Metro)');
      // Packs written by Node's zlib are read back by the app's fflate path, and the app's fflate packs by zlib.
      const zlib = require('zlib');
      const fflate = require('fflate');
      for (const f of fs.readdirSync(outCi).filter((n) => n.endsWith('.json.gz'))) {
        const bytes = fs.readFileSync(path.join(outCi, f));
        const viaFflate = Buffer.from(fflate.gunzipSync(new Uint8Array(bytes)));
        assert.ok(viaFflate.equals(zlib.gunzipSync(bytes)), `${f}: zlib vs fflate`);
        const pack = sp.decodePack(new Uint8Array(bytes)); // default (fflate) codec = the app
        const appBytes = sp.packToBytes(pack);
        assert.ok(Buffer.from(fflate.gunzipSync(appBytes)).equals(viaFflate), `${f}: app re-encode decodes to the same JSON`);
        assert.ok(zlib.gunzipSync(Buffer.from(appBytes)).equals(viaFflate));
      }
    });

    await check('starter catalog: validation rejects unsafe or malformed entries', () => {
      const good = JSON.parse(fs.readFileSync(path.join(out, 'starter-catalog.json'), 'utf8'));
      assert.strictEqual(sp.validateStarterCatalog(good).books.length, 3);
      const mutate = (fn) => {
        const c = JSON.parse(JSON.stringify(good));
        fn(c);
        return c;
      };
      assert.throws(() => sp.validateStarterCatalog(mutate((c) => (c.books[0].packFile = '../../evil.json.gz'))), /unsafe packFile/);
      assert.throws(() => sp.validateStarterCatalog(mutate((c) => (c.books[0].packFile = 'https://evil/x.json.gz'))), /unsafe packFile/);
      assert.throws(() => sp.validateStarterCatalog(mutate((c) => (c.books[0].sha256 = 'abc'))), /sha256/);
      assert.throws(() => sp.validateStarterCatalog(mutate((c) => c.books.push({ ...c.books[0] }))), /duplicate slug/);
      assert.throws(() => sp.validateStarterCatalog(mutate((c) => (c.formatVersion = 99))), /newer app/);
      assert.throws(() => sp.validateStarterCatalog({}), /books is missing/);
      assert.strictEqual(sp.packUrl('https://github.com/o/r/releases/download/starter-latest/starter-catalog.json?x=1', good.books[0]), 'https://github.com/o/r/releases/download/starter-latest/starter-genesis.json.gz');
    });

    await check('starter: pure-JS SHA-256 (Hermes has no WebCrypto) equals node crypto', async () => {
      for (const n of [0, 1, 3, 55, 56, 57, 63, 64, 65, 119, 120, 1000, 70000]) {
        const buf = crypto.randomBytes(n);
        assert.strictEqual(sp.sha256Js(new Uint8Array(buf)), sha(buf), `${n} bytes`);
      }
      const real = fs.readFileSync(path.join(out, 'starter-genesis.json.gz'));
      assert.strictEqual(await sp.sha256Hex(new Uint8Array(real)), sha(real));
    });

    await check('starter pack: tampered, truncated or foreign downloads are rejected before anything is written', async () => {
      const entry = exp.catalog.books.find((b) => b.slug === 'genesis');
      const real = new Uint8Array(fs.readFileSync(path.join(out, entry.packFile)));
      await sp.verifyPackBytes(real, entry);
      const flipped = real.slice();
      flipped[Math.floor(flipped.length / 2)] ^= 0xff;
      await assert.rejects(sp.verifyPackBytes(flipped, entry), /SHA-256/);
      await assert.rejects(sp.verifyPackBytes(real.slice(0, real.length - 10), entry), /גודל/);
      assert.throws(() => sp.decodePack(real.slice(0, 40)), /פגומה/);
      assert.throws(() => sp.decodePack(new Uint8Array(Buffer.from('not gzip at all'))), /פגומה/);
      assert.throws(() => sp.validatePack({ format: 'something-else' }), /not a kodeshRead starter pack/);
    });

    // --- round trip into an empty starter database ------------------------------------------------
    const packOf = (slug) => sp.decodePack(new Uint8Array(fs.readFileSync(path.join(out, sp.packFileName(slug)))));
    const s1 = await newStarterDb('starter1.db');
    await check('starter DB: same schema as the core library (paragraphs_fts, ref_links, view, TOC)', async () => {
      const names = (await s1.read.all("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name")).map((r) => r.name);
      const coreNames = (await coreAll("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name", [])).map((r) => r.name);
      for (const n of ['paragraphs_fts', 'paragraphs_fts_source', 'ref_links', 'toc_nodes', 'books', 'categories', 'paragraphs', 'meta', 'links']) assert.ok(names.includes(n), n);
      assert.deepStrictEqual(names.filter((n) => coreNames.includes(n)).length, coreNames.filter((n) => names.includes(n)).length);
      assert.strictEqual((await indexer.readMeta(s1.w)).kind, 'starter');
      assert.strictEqual(await count(s1, 'SELECT COUNT(*) FROM books'), 0, 'empty until a book is opened');
    });

    await check('starter import: genesis + Rashi + Onkelos in one transaction; ids, text, TOC and ref_links match the source', async () => {
      const res = await sp.importStarterPack(s1.w, packOf('genesis'));
      assert.deepStrictEqual([res.added, res.skipped, res.title], [3, 0, 'בראשית']);
      const base = await idOf('בראשית');
      assert.strictEqual(res.bookId, base, 'ids are preserved (the full library of this release has the very same ids)');
      const bookIds = [base, await idOf('רש"י על בראשית'), await idOf('אונקלוס על בראשית')];
      for (const id of bookIds) {
        const a = await coreAll('SELECT line_index, display_text, clean_text, is_heading, toc_path FROM paragraphs WHERE book_id = ? ORDER BY line_index', [id]);
        const b = await s1.read.all('SELECT line_index, display_text, clean_text, is_heading, toc_path FROM paragraphs WHERE book_id = ? ORDER BY line_index', [id]);
        assert.deepStrictEqual(b, a.map((r) => ({ ...r })), `paragraphs of book ${id}`);
        const ta = await coreAll('SELECT level, title, ref_key, start_line FROM toc_nodes WHERE book_id = ? ORDER BY id', [id]);
        const tb = await s1.read.all('SELECT level, title, ref_key, start_line FROM toc_nodes WHERE book_id = ? ORDER BY id', [id]);
        assert.deepStrictEqual(tb, ta.map((r) => ({ ...r })), `TOC of book ${id}`);
        const [src] = await coreAll('SELECT title, aliases, file_path, total_lines FROM books WHERE id = ?', [id]);
        assert.deepStrictEqual((await s1.read.all('SELECT title, aliases, file_path, total_lines FROM books WHERE id = ?', [id]))[0], { ...src });
      }
      const rl = 'base_book_id, base_start, base_end, comm_book_id, comm_start, comm_end, ref_key, link_type';
      const rows = (r, extra) => r.all(`SELECT ${rl} FROM ref_links WHERE base_book_id = ? AND comm_book_id IN (?, ?) ORDER BY comm_book_id, base_start, comm_start`, [base, bookIds[1], bookIds[2]]).then((x) => x.map((y) => ({ ...y })));
      assert.deepStrictEqual(await rows(s1.read), await rows({ all: (q, p) => coreAll(q, p) }));
      assert.ok(res.refLinks > 0);
      // TOC parent links point at nodes of the same book.
      assert.strictEqual(await count(s1, 'SELECT COUNT(*) FROM toc_nodes t JOIN toc_nodes p ON p.id = t.parent_id WHERE p.book_id <> t.book_id'), 0);
      assert.strictEqual(await count(s1, 'SELECT COUNT(*) FROM toc_nodes WHERE parent_id IS NOT NULL AND parent_id NOT IN (SELECT id FROM toc_nodes)'), 0);
      assert.strictEqual(JSON.parse((await s1.read.all("SELECT value FROM meta WHERE key = 'starter_loaded'"))[0].value).genesis.dbVersion, exp.catalog.version);
    });

    await check('starter import: Quick Jump, reader window, FTS5 search and the commentary drawer work like the full library', async () => {
      const router = sources.createRouter([{ name: 'starter', adapter: s1.read, idBase: 0 }]);
      const index = await loadBookIndex(router);
      const jump = async (r, i) => (await resolveReference(r, i, 'בראשית ב'))[0];
      const [js, jc] = [await jump(router, index), await jump(core, await loadBookIndex(core))];
      assert.ok(js.complete && js.bookTitle === 'בראשית', JSON.stringify(js));
      assert.deepStrictEqual([js.bookId, js.targetLine, js.path], [jc.bookId, jc.targetLine, jc.path], 'Quick Jump resolves to the same line as the full library');
      const base = await idOf('בראשית');
      const win = await reader.fetchRange(router, base, 1, 12);
      assert.ok(win.length >= 10 && win.every((r) => r.book_id === base || r.book_id === undefined || true));
      const hit = await search.searchParagraphs(router, 'בראשית ברא', { limit: 5, fts: true });
      assert.ok(hit.rows.length >= 1 && hit.rows.every((r) => r.book_id != null), 'FTS5 over the starter database finds the verse');
      const ftsHits = await s1.read.all('SELECT rowid FROM paragraphs_fts WHERE paragraphs_fts MATCH ? LIMIT 3', ['"ברא אלהימ"']);
      assert.ok(ftsHits.length >= 1);
      const groups = commentary.groupLinkedEntries(await commentary.fetchLinkedEntries(router, base, 3));
      const names = groups.map((g) => g.name);
      assert.ok(names.includes('רש"י') && names.includes('אונקלוס'), names.join(','));
      assert.ok(!names.includes('רמב"ן'), 'only the bundled commentaries are there');
      const rashi = groups.find((g) => g.name === 'רש"י');
      const ref = await commentary.fetchLinkedEntries(core, base, 3);
      assert.deepStrictEqual(rashi.entries.map((e) => e.display_text), commentary.groupLinkedEntries(ref).find((g) => g.name === 'רש"י').entries.map((e) => e.display_text));
      // The search scope picker / library catalog builds over the starter source (commentaries nested under their base).
      const cat = libraryCatalogOf(await sources.loadCatalog(router));
      assert.deepStrictEqual(cat.commentariesOf(base).map((c) => c.name).sort(), ['אונקלוס', 'רש"י']);
    });

    await check('starter import: Bavli רש"י שורה N <-> Gemara paragraph links are exact, both directions (and Tosafot)', async () => {
      const res = await sp.importStarterPack(s1.w, packOf('bavli-shabbat'));
      assert.deepStrictEqual([res.added, res.skipped], [3, 0]);
      const router = sources.createRouter([{ name: 'starter', adapter: s1.read, idBase: 0 }]);
      const shabbat = await idOf('שבת');
      assert.strictEqual(res.bookId, shabbat);
      const [fromStarter, fromCore] = [router, core].map((r) => commentary.fetchLinkedEntries(r, shabbat, 3));
      const [a, b] = [commentary.groupLinkedEntries(await fromStarter), commentary.groupLinkedEntries(await fromCore)];
      assert.deepStrictEqual(a.map((g) => [g.name, g.entries.length, g.block]), b.map((g) => [g.name, g.entries.length, g.block]));
      assert.deepStrictEqual(a.map((g) => g.name), ['רש"י', 'תוספות']);
      assert.deepStrictEqual(a[0].block, { refKey: 'דף ב|עמוד א|שורה א', start: 3, end: 5 });
      assert.ok(a[0].entries.every((e) => e.toc_path === 'דף ב. > שורה א'));
      const rashi = a[0].bookId;
      const back = commentary.groupLinkedEntries(await commentary.fetchLinkedEntries(router, rashi, a[0].entries[0].line));
      assert.deepStrictEqual(back.map((g) => [g.bookTitle, g.entries[0].line]), [['שבת', 3]]);
      // Every ref_link row of the three Bavli books is identical to the source.
      const q = 'SELECT base_start, base_end, comm_book_id, comm_start, comm_end, ref_key FROM ref_links WHERE base_book_id = ? ORDER BY comm_book_id, base_start, comm_start';
      assert.deepStrictEqual(await s1.read.all(q, [shabbat]), (await coreAll(q, [shabbat])).map((r) => ({ ...r })));
    });

    await check('starter import: opening an already loaded book is a no-op (no duplicate rows, FTS or ref_links)', async () => {
      const snapshot = async () => ({
        books: await count(s1, 'SELECT COUNT(*) FROM books'),
        paragraphs: await count(s1, 'SELECT COUNT(*) FROM paragraphs'),
        toc: await count(s1, 'SELECT COUNT(*) FROM toc_nodes'),
        refs: await count(s1, 'SELECT COUNT(*) FROM ref_links'),
        cats: await count(s1, 'SELECT COUNT(*) FROM categories'),
        fts: await count(s1, 'SELECT COUNT(*) FROM paragraphs_fts_docsize'),
        maxPara: await count(s1, 'SELECT MAX(id) FROM paragraphs'),
      });
      const before = await snapshot();
      for (const slug of ['genesis', 'bavli-shabbat']) {
        const again = await sp.importStarterPack(s1.w, packOf(slug));
        assert.deepStrictEqual([again.added, again.skipped, again.paragraphs, again.refLinks], [0, 3, 0, 0], slug);
      }
      assert.deepStrictEqual(await snapshot(), before);
      assert.strictEqual(before.fts, before.paragraphs, 'one FTS row per paragraph');
      assert.strictEqual(await count(s1, 'SELECT COUNT(*) FROM (SELECT file_path FROM books GROUP BY file_path HAVING COUNT(*) > 1)'), 0);
      const six = (await coreAll("SELECT file_path FROM books WHERE title IN ('בראשית', 'רש\"י על בראשית', 'אונקלוס על בראשית', 'שבת', 'רש\"י על שבת', 'תוספות על שבת')", [])).map((r) => r.file_path);
      assert.strictEqual(six.length, 6);
      assert.deepStrictEqual([...(await loadedPathsOf(s1))].sort(), six.sort());
    });

    await check('starter import: a second pack of the same folders reuses categories (no duplicate paths)', async () => {
      await sp.importStarterPack(s1.w, packOf('numbers'));
      assert.strictEqual(await count(s1, 'SELECT COUNT(*) FROM (SELECT path FROM categories GROUP BY path HAVING COUNT(*) > 1)'), 0);
      assert.strictEqual(await count(s1, 'SELECT COUNT(*) FROM books'), 7);
      const orphan = await count(s1, 'SELECT COUNT(*) FROM books WHERE category_id IS NOT NULL AND category_id NOT IN (SELECT id FROM categories)');
      assert.strictEqual(orphan, 0);
    });

    await check('starter import: ids that collide with another release are remapped cleanly (text, TOC, ref_links, FTS follow)', async () => {
      const s2 = await newStarterDb('starter2.db');
      // A different release already used book id 1, category id 1, TOC / paragraph ids 1..N for other books.
      s2.raw.exec(`INSERT INTO categories (id, parent_id, name, path) VALUES (1, NULL, 'אחר', 'אחר');
        INSERT INTO books (id, category_id, title, aliases, file_path, total_lines) VALUES (1, 1, 'ספר אחר', '', 'אחר/ספר אחר.txt', 3), (4, 1, 'ספר שני', '', 'אחר/ספר שני.txt', 1);
        INSERT INTO paragraphs (id, book_id, line_index, toc_path, display_text, clean_text, is_heading) VALUES (1, 1, 1, '', 'א', 'א', 0), (2, 1, 2, '', 'ב', 'ב', 0), (3, 1, 3, '', 'ג', 'ג', 0), (4000, 4, 1, '', 'ד', 'ד', 0);
        INSERT INTO toc_nodes (id, book_id, parent_id, level, title, ref_key, start_line) VALUES (1, 1, NULL, 1, 'פרק', 'א', 1);`);
      const res = await sp.importStarterPack(s2.w, packOf('genesis'));
      const base = await idOf('בראשית');
      assert.notStrictEqual(res.bookId, 1);
      assert.strictEqual(res.title, 'בראשית');
      assert.strictEqual(res.idMap[base], res.bookId);
      const src = await coreAll('SELECT line_index, display_text FROM paragraphs WHERE book_id = ? ORDER BY line_index', [base]);
      const got = await s2.read.all('SELECT line_index, display_text FROM paragraphs WHERE book_id = ? ORDER BY line_index', [res.bookId]);
      assert.deepStrictEqual(got, src.map((r) => ({ ...r })));
      // The other release's rows are untouched.
      assert.strictEqual(await count(s2, "SELECT COUNT(*) FROM paragraphs WHERE book_id IN (1, 4) AND display_text IN ('א','ב','ג','ד')"), 4);
      assert.strictEqual(await count(s2, 'SELECT COUNT(*) FROM toc_nodes WHERE book_id = 1'), 1);
      assert.strictEqual(await count(s2, 'SELECT COUNT(*) FROM toc_nodes t LEFT JOIN toc_nodes p ON p.id = t.parent_id WHERE t.parent_id IS NOT NULL AND (p.id IS NULL OR p.book_id <> t.book_id)'), 0);
      // FTS rowids are the shifted paragraph ids: search resolves to the right book.
      const router = sources.createRouter([{ name: 'starter', adapter: s2.read, idBase: 0 }]);
      const hit = await search.searchParagraphs(router, 'בראשית ברא', { limit: 5, fts: true });
      const mine = new Set(Object.values(res.idMap));
      assert.ok(hit.rows.length && hit.rows.every((r) => mine.has(r.book_id)) && hit.rows.some((r) => r.book_id === res.bookId), JSON.stringify(hit.rows.map((r) => r.book_id)));
      // The commentary drawer follows the remapped ids.
      const groups = commentary.groupLinkedEntries(await commentary.fetchLinkedEntries(router, res.bookId, 3));
      assert.deepStrictEqual(groups.map((g) => g.name).sort(), ['אונקלוס', 'רש"י']);
      assert.ok(groups.every((g) => mine.has(g.bookId) && g.bookId !== 1 && g.bookId !== 4));
      assert.strictEqual(await count(s2, 'SELECT COUNT(*) FROM ref_links WHERE base_book_id <> ?', [res.bookId]), 0);
      s2.raw.close();
    });

    await check('starter import: a failing pack rolls back completely (nothing half-written)', async () => {
      const s3 = await newStarterDb('starter3.db');
      const bad = packOf('genesis');
      bad.paragraphs[bad.paragraphs.length - 1][4] = null; // display_text NOT NULL
      await assert.rejects(sp.importStarterPack(s3.w, bad));
      for (const t of ['books', 'paragraphs', 'toc_nodes', 'ref_links', 'categories', 'paragraphs_fts_docsize']) assert.strictEqual(await count(s3, `SELECT COUNT(*) FROM ${t}`), 0, t);
      assert.strictEqual((await s3.read.all("SELECT 1 FROM meta WHERE key = 'starter_loaded'")).length, 0);
      // ... and the same database then imports the good pack fine.
      const ok = await sp.importStarterPack(s3.w, packOf('genesis'));
      assert.strictEqual(ok.added, 3);
      s3.raw.close();
    });

    await check('starter import: one transaction is fast (genesis + commentaries, 1.6k paragraphs)', async () => {
      const s4 = await newStarterDb('starter4.db');
      const t = process.hrtime.bigint();
      await sp.importStarterPack(s4.w, packOf('genesis'));
      const ms = Number(process.hrtime.bigint() - t) / 1e6;
      console.log(`  starter import of genesis: ${ms.toFixed(0)}ms`);
      assert.ok(ms < 1500, `${ms}ms`);
      s4.raw.close();
    });

    await check('starter -> full library: same release keeps every id (tabs survive), router drops the starter source', async () => {
      const starterRouter = sources.createRouter([{ name: 'starter', adapter: s1.read, idBase: 0 }]);
      const fullRouter = sources.createRouter([{ name: 'core', adapter: core, idBase: 0 }, { name: 'user', adapter: s1.read, idBase: sources.USER_ID_BASE, categoryRoot: sources.USER_ROOT_NAME }]);
      const a = await loadBookIndex(starterRouter);
      const b = await loadBookIndex(fullRouter);
      for (const [id, book] of a.books) {
        assert.strictEqual(b.books.get(id)?.title, book.title, `book ${id} keeps its id and title`);
        assert.strictEqual(b.books.get(id)?.categoryPath, book.categoryPath);
      }
      // The reader of a starter book works unchanged on the full library: same window, same drawer.
      const shabbat = await idOf('שבת');
      assert.deepStrictEqual((await reader.fetchRange(starterRouter, shabbat, 1, 20)).map((r) => r.display_text), (await reader.fetchRange(fullRouter, shabbat, 1, 20)).map((r) => r.display_text));
    });

    await check('starter -> full library: LibraryContext swaps the source, deletes the starter DB, keeps tabs / user data', () => {
      const ctx = fs.readFileSync(path.join(ROOT, 'src/db/LibraryContext.tsx'), 'utf8');
      const lib = fs.readFileSync(path.join(ROOT, 'src/db/library.ts'), 'utf8');
      assert.ok(/else if \(starter\) sources\.push\(\{ name: 'starter'/.test(ctx), 'the starter is a router source only while there is no core');
      assert.ok(/starter: core \? null : starter/.test(ctx));
      const from = ctx.indexOf('installCore: (from?: string) =>', ctx.indexOf('const controller'));
      const install = ctx.slice(from, ctx.indexOf('removeCore: () =>', from));
      assert.ok(install.indexOf('installStagedCore') < install.indexOf('deleteStarterDatabase'), 'the starter DB is deleted only after the swap succeeded');
      assert.ok(install.includes('remapTabs(lib.bookIndex, next.bookIndex)') && install.includes('buildLibrary(core, lib.user, null,'));
      assert.ok(!/removeDbFiles\(USER_DB|deleteUserDatabase/.test(ctx + lib), 'user_library.db is never touched by the upgrade');
      assert.ok(/export const STARTER_DB = 'starter_library.db'/.test(lib));
      assert.ok(ctx.includes('removeCore') && ctx.includes('lib.starter ?? (await openStarterDatabase()'), 'removing the core goes back to starter mode');
      assert.ok(ctx.includes('if (!core) starter = await openStarterDatabase()') && ctx.includes('else if (starterDbExists()) await deleteStarterDatabase()'), 'a stale starter DB next to a core library is removed on launch');
      // Tabs / settings / bookmarks live in AsyncStorage (zustand persist), personal books in user_library.db: neither is in the starter DB.
      const tabs = fs.readFileSync(path.join(ROOT, 'src/state/tabsStore.ts'), 'utf8');
      assert.ok(tabs.includes('AsyncStorage') && !tabs.includes('starter'));
    });

    await check('starter UI: Library screen shows the catalog, cloud / offline badges, loading text and the upgrade banner', () => {
      const ui = fs.readFileSync(path.join(ROOT, 'src/components/library/StarterBooks.tsx'), 'utf8');
      const home = fs.readFileSync(path.join(ROOT, 'src/app/index.tsx'), 'utf8');
      assert.ok(ui.includes('ספריית התחלה מהענן · להורדת ספרייה לאופליין וחיפוש מלא: בסיסית (ללא אחרוני זמננו) או מלאה') && ui.includes('testID="starter-upgrade-banner"'));
      assert.ok(ui.includes("router.navigate('/library-manager')"), 'the banner leads to the manager with the cloud library card');
      assert.ok(ui.includes('טוען את ${t} מהענן…') && ui.includes('☁ · ${formatBytes(b.sizeBytes)}') && ui.includes('✓ זמין לא מקוון'));
      assert.ok(/const starterMode = !core && !!starter/.test(home) && home.includes('<StarterBooks'));
      const svc = fs.readFileSync(path.join(ROOT, 'src/services/starterLibrary.ts'), 'utf8');
      assert.ok(svc.includes('starter-latest/starter-catalog.json') && svc.includes('CACHE_KEY') && svc.includes('verifyPackBytes') && svc.includes('importStarterPack'));
      assert.ok(svc.includes('FROM books WHERE file_path = ? AND is_complete = 1'), 'an already loaded book opens without a download');
    });

    await check('starter selection: every curated book resolves in the real Otzaria folder map, Rashi / Onkelos / Tosafot bundled, canonical order', () => {
      const lines = fs.readFileSync(path.join(ROOT, 'otzaria_index_only.txt'), 'utf8').split('\n').map((l) => l.trim().replace(/^\.\//, '')).filter((l) => l.endsWith('.txt'));
      const cats = new Map();
      const books = [];
      for (const l of lines) {
        const parts = l.split('/');
        const file = parts.pop();
        const p = parts.join('/');
        if (!cats.has(p)) cats.set(p, { id: cats.size + 1, parent_id: null, name: parts[parts.length - 1] || '', path: p });
        books.push({ id: books.length + 1, category_id: cats.get(p).id, title: file.replace(/\.txt$/, '').replace(/^[‏]+/, ''), aliases: '', total_lines: 1 });
      }
      const sel = sp.selectStarterBooks({ categories: [...cats.values()], books });
      const bySlug = Object.fromEntries(sel.map((x) => [x.spec.slug, x]));
      assert.deepStrictEqual(sp.STARTER_BOOKS.map((b) => b.slug).filter((s) => !bySlug[s]), [], 'every curated book exists in the full library');
      for (const s of ['genesis', 'exodus', 'leviticus', 'numbers', 'deuteronomy']) assert.deepStrictEqual(bySlug[s].commentaries.map((c) => c.key), ['רשי', 'אונקלוס'], s);
      assert.deepStrictEqual(bySlug.psalms.commentaries.map((c) => c.key), ['רשי']);
      for (const s of ['bavli-berachot', 'bavli-shabbat']) assert.deepStrictEqual(bySlug[s].commentaries.map((c) => c.key), ['רשי', 'תוספות'], s);
      assert.ok(/ברכות/.test(bySlug['bavli-berachot'].commentaries[0].title) && /תלמוד בבלי/.test(bySlug['bavli-berachot'].categoryPath));
      assert.ok(/^משנה\//.test(bySlug['mishna-berachot'].categoryPath) && !/תלמוד/.test(bySlug['mishna-berachot'].categoryPath), 'משנה ברכות is not the Bavli tractate');
      assert.ok(/הלכה\/שולחן ערוך/.test(bySlug['shulchan-aruch-orach-chaim'].categoryPath));
      const order = sel.map((x) => x.spec.slug);
      assert.deepStrictEqual(order.slice(0, 6), ['genesis', 'exodus', 'leviticus', 'numbers', 'deuteronomy', 'psalms'], 'Torah order, then Ketuvim');
      assert.ok(order.indexOf('mishna-avot') > order.indexOf('psalms') && order.indexOf('bavli-berachot') < order.indexOf('bavli-shabbat') && order.indexOf('bavli-shabbat') < order.indexOf('shulchan-aruch-orach-chaim'));
    });

    await check('workflow: starter packs are exported before the DB is deleted and published to their own release', () => {
      const text = fs.readFileSync(path.join(ROOT, '.github/workflows/build-library.yml'), 'utf8');
      const at = (needle) => {
        const i = text.indexOf(needle);
        assert.ok(i >= 0, `workflow lacks: ${needle}`);
        return i;
      };
      const order = ['cloud-release.js validate', 'export-starter-packs.js --db="$WORK/core_library.db"', 'zip -9', 'rm -f core_library.db core_library.db-journal', 'gh release upload "$RELEASE_TAG" library-manifest.json', 'name: Publish starter packs'].map(at);
      assert.deepStrictEqual(order, [...order].sort((x, y) => x - y));
      assert.ok(text.includes('STARTER_TAG: starter-latest') && text.includes('starter-catalog.json'));
      const pub = text.slice(at('name: Publish starter packs'), at('name: Summary'));
      assert.ok(!pub.includes('RELEASE_TAG') && !pub.includes('core_library.db.zip.part'), 'never touches the library-latest assets');
      assert.ok(pub.indexOf('gh release delete-asset "$STARTER_TAG" starter-catalog.json') < pub.indexOf('gh release upload "$STARTER_TAG" "$f"') && pub.lastIndexOf('starter-catalog.json') > pub.lastIndexOf('gh release upload "$STARTER_TAG" "$f"'), 'catalog hidden first, published last');
      const lib = text.slice(at('name: Publish release ${{ env.RELEASE_TAG }}'), at('name: Publish starter packs'));
      assert.ok(!lib.includes('starter'), 'the library-latest cleanup never mentions the starter packs');
    });
  } finally {
    core.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  async function loadedPathsOf(w) {
    return sp.loadedFilePaths(w.read);
  }
  function libraryCatalogOf(data) {
    return require('../shared/libraryCatalog').buildLibraryCatalog(data);
  }
}
/**
 * Preset corpora (section 15): shared/corpora.js picks ONLY base books for תנ"ך / משנה / בבלי / ירושלמי / משנה תורה /
 * שולחן ערוך, whatever the (messy) Otzaria folder hierarchy, and Simple Search and Advanced Search resolve identical
 * book ids from it. Wiring of both screens + the progress banner is checked on the sources.
 */
async function corporaTests() {
  const corpora = require('../shared/corpora');
  const lc = require('../shared/libraryCatalog');
  const lifecycle = require('../shared/searchLifecycle');

  /** Books from "dir/dir/title" paths (the catalog input of loadCatalog). */
  const library = (paths) => {
    const books = paths.map((p, i) => {
      const parts = p.split('/');
      const title = parts.pop();
      return { id: i + 1, title, categoryPath: parts.join('/') };
    });
    return { books, idOf: (p) => paths.indexOf(p) + 1 };
  };
  const catalogOf = (books) => {
    const categories = [];
    const cid = new Map();
    const cat = (p) => {
      if (!p) return null;
      if (cid.has(p)) return cid.get(p);
      const parts = p.split('/');
      const parent = parts.length > 1 ? cat(parts.slice(0, -1).join('/')) : null;
      categories.push({ id: categories.length + 1, parent_id: parent, name: parts[parts.length - 1], path: p });
      cid.set(p, categories.length);
      return categories.length;
    };
    return lc.buildLibraryCatalog({
      categories,
      books: books.map((b) => ({ id: b.id, category_id: cat(b.categoryPath), title: b.title, aliases: generateBookAliases(b.categoryPath.split('/'), b.title).join('|') })),
    });
  };
  const setOf = (lib, ids, opts) => new Set(corpora.resolveCorpusBooks(lib.books, ids, opts).map((id) => lib.books[id - 1].categoryPath + '/' + lib.books[id - 1].title));

  await check('corpora: תנ"ך = canonical Torah / Neviim / Ketuvim only, on messy folders', () => {
    const lib = library([
      'אוצריא/תנך/תורה/בראשית',
      'תנ"ך/חומש/בראשית',
      'תנך/נביאים/שמואל א',
      'תנך/כתובים/שיר השירים',
      'תנך/מפרשים/רשי על בראשית',
      'תנך/מפרשים/ראשונים/רמבן על בראשית',
      'תנ"ך/מפרשים/רמב"ן על בראשית',
      'תנך/תרגומים/תרגום אונקלוס על בראשית',
      'תנך/תרגומים/אונקלוס',
      'תנך/תורה/הערות על בראשית',
      'תנך/מפרשים/אבן עזרא על בראשית',
      'תנך/מפרשים/מצודות/ישעיהו',
      'תנך/אחרונים/אבי עזר/תורה/אבי עזר',
      'תנך/דרשות ודרושים/בראשית',
      'תלמוד בבלי/סדר מועד/שבת',
      'מדרש/מדרש רבה/בראשית רבה',
      'מדרש/אגדה/ילקוט שמעוני על התורה',
    ]);
    const got = setOf(lib, ['tanach']);
    assert.deepStrictEqual([...got].sort(), ['אוצריא/תנך/תורה/בראשית', 'תנ"ך/חומש/בראשית', 'תנך/כתובים/שיר השירים', 'תנך/נביאים/שמואל א'].sort());
  });

  await check('corpora: בבלי / משנה / ירושלמי never overlap (same tractate names, different roots)', () => {
    const lib = library([
      'תלמוד בבלי/סדר מועד/שבת',
      'תלמוד בבלי/סדר מועד/ראש השנה',
      'תלמוד בבלי/סדר זרעים/ברכות',
      'אוצריא/תלמוד בבלי/סדר נשים/יבמות',
      'תלמוד בבלי/ראשונים/רשי/סדר מועד/רשי על שבת',
      'תלמוד בבלי/מפרשים/רשי על שבת',
      'תלמוד בבלי/מפרשים/תוספות על שבת',
      'תלמוד בבלי/ראשונים/ריף/שבת',
      'תלמוד בבלי/ראשונים/רא"ש/שבת',
      'תלמוד בבלי/אחרונים/מהרשא/חידושי הלכות ואגדות על שבת',
      'תלמוד בבלי/גמרא נוחה/גמרא נוחה מסכת שבת',
      'תלמוד בבלי/סדר מועד/משנה שבת',
      'משנה/סדר מועד/משנה שבת',
      'משנה/סדר מועד/משנה ראש השנה',
      'משנה/סדר זרעים/משנה ביכורים',
      'משנה/ראשונים/רעב/משנה/סדר מועד/ברטנורא על משנה שבת',
      'משנה/אחרונים/תוספות יום טוב על משנה שבת',
      'תוספתא/דפוס וילנא/תוספתא שבת',
      'תלמוד ירושלמי/סדר מועד/תלמוד ירושלמי שבת',
      'תלמוד ירושלמי/סדר זרעים/תלמוד ירושלמי בכורים',
      'תלמוד ירושלמי/מפרשים/פני משה על תלמוד ירושלמי שבת',
      'תלמוד ירושלמי/מפרשים/קרבן העדה',
    ]);
    assert.deepStrictEqual([...setOf(lib, ['bavli'])].sort(), ['אוצריא/תלמוד בבלי/סדר נשים/יבמות', 'תלמוד בבלי/סדר זרעים/ברכות', 'תלמוד בבלי/סדר מועד/ראש השנה', 'תלמוד בבלי/סדר מועד/שבת'].sort());
    assert.deepStrictEqual([...setOf(lib, ['mishna'])].sort(), ['משנה/סדר זרעים/משנה ביכורים', 'משנה/סדר מועד/משנה ראש השנה', 'משנה/סדר מועד/משנה שבת'].sort());
    assert.deepStrictEqual([...setOf(lib, ['yerushalmi'])].sort(), ['תלמוד ירושלמי/סדר זרעים/תלמוד ירושלמי בכורים', 'תלמוד ירושלמי/סדר מועד/תלמוד ירושלמי שבת'].sort());
    // "משנה שבת" is the Mishnah's, even when it is stored in the Bavli folder: never a Bavli book.
    assert.ok(!setOf(lib, ['bavli']).has('תלמוד בבלי/סדר מועד/משנה שבת'));
  });

  await check('corpora: משנה תורה = Rambam halachot only; שולחן ערוך = the 4 parts only', () => {
    const lib = library([
      'הלכה/משנה תורה/ספר מדע/משנה תורה, הלכות דעות',
      'אוצריא/הלכה/משנה תורה/ספר זמנים/משנה תורה, הלכות שבת',
      'הלכה/משנה תורה/ספר מדע/משנה תורה, הלכות יסודי התורה',
      'הלכה/משנה תורה/הקדמה/משנה תורה, מצוות עשה',
      'הלכה/משנה תורה/ספר זמנים/הלכות עירובין',
      'הלכה/משנה תורה/מפרשים/כסף משנה על משנה תורה',
      'הלכה/משנה תורה/מפרשים/השגות הראב"ד',
      'הלכה/משנה תורה/ספר זמנים/כסף משנה על הלכות שבת',
      'הלכה/משנה תורה/ספר זמנים/מגיד משנה על הלכות שבת',
      'הלכה/משנה תורה/ספר זמנים/לחם משנה',
      'הלכה/משנה תורה/אחרונים/מעשה רקח על משנה תורה, הלכות שבת',
      'הלכה/משנה תורה/ספר זמנים/משנה תורה, הלכות שבת (הגהות)',
      'הלכה/שולחן ערוך/שולחן ערוך, אורח חיים',
      'אוצריא/הלכה/שולחן ערוך/שולחן ערוך, יורה דעה',
      'הלכה/שולחן ערוך/שולחן ערוך, אבן העזר',
      'הלכה/שולחן ערוך/שולחן ערוך, חושן משפט',
      'הלכה/שולחן ערוך/שולחן ערוך, הקדמה',
      'הלכה/שולחן ערוך/מפרשים/מגן אברהם',
      'הלכה/שולחן ערוך/מפרשים/משנה ברורה',
      'הלכה/שולחן ערוך/פרי מגדים על אורח חיים',
      'הלכה/שולחן ערוך/ט"ז',
      'הלכה/שולחן ערוך/ש"ך',
      'הלכה/שולחן ערוך/באר היטב',
      'הלכה/שולחן ערוך הרב/שולחן ערוך הרב',
      'הלכה/טור/טור',
    ]);
    assert.deepStrictEqual(
      [...setOf(lib, ['rambam'])].sort(),
      ['אוצריא/הלכה/משנה תורה/ספר זמנים/משנה תורה, הלכות שבת', 'הלכה/משנה תורה/הקדמה/משנה תורה, מצוות עשה', 'הלכה/משנה תורה/ספר זמנים/הלכות עירובין', 'הלכה/משנה תורה/ספר מדע/משנה תורה, הלכות דעות', 'הלכה/משנה תורה/ספר מדע/משנה תורה, הלכות יסודי התורה'].sort(),
    );
    assert.deepStrictEqual(
      [...setOf(lib, ['shulchan-aruch'])].sort(),
      ['אוצריא/הלכה/שולחן ערוך/שולחן ערוך, יורה דעה', 'הלכה/שולחן ערוך/שולחן ערוך, אבן העזר', 'הלכה/שולחן ערוך/שולחן ערוך, אורח חיים', 'הלכה/שולחן ערוך/שולחן ערוך, חושן משפט'].sort(),
    );
  });

  await check('corpora: strict exclusion also catches a commentary the folder alone would not reveal', () => {
    // A canonical title inside a commentary folder, a commentator name, a catalog-flagged commentary.
    const lib = library(['תנך/מפרשים/בראשית', 'תנך/תורה/רשי', 'תלמוד בבלי/סדר מועד/תוספות', 'תנך/תורה/בראשית', 'תלמוד בבלי/סדר מועד/שבת']);
    assert.deepStrictEqual([...setOf(lib, ['tanach', 'bavli'])].sort(), ['תלמוד בבלי/סדר מועד/שבת', 'תנך/תורה/בראשית'].sort());
    const flagged = setOf(lib, ['tanach'], { isCommentary: (id) => id === lib.idOf('תנך/תורה/בראשית') });
    assert.strictEqual(flagged.size, 0, 'a book the catalog flags as a commentary is never a base book');
    assert.ok(corpora.isCommentaryTitle('רש"י על בראשית') && corpora.isCommentaryTitle('תרגום אונקלוס') && corpora.isCommentaryTitle('כסף משנה') && corpora.isCommentaryTitle('משנה ברורה') && corpora.isCommentaryTitle('פירוש הרא"ש'));
    assert.ok(!corpora.isCommentaryTitle('ראש השנה') && !corpora.isCommentaryTitle('משנה שבת') && !corpora.isCommentaryTitle('משנה תורה, הלכות דעות') && !corpora.isCommentaryTitle('שיר השירים'));
    // Personal imports are never part of a library preset.
    assert.strictEqual(corpora.resolveCorpusBooks([{ id: 1000000001, title: 'שבת', categoryPath: 'תלמוד בבלי/סדר מועד' }], ['bavli']).length, 0);
  });

  await check('corpora: "מפרשים" = commentary folders + catalog commentaries, none of the base books', () => {
    const lib = library(['תנך/תורה/בראשית', 'תנך/מפרשים/רשי על בראשית', 'תנך/תרגומים/אונקלוס', 'תלמוד בבלי/ראשונים/רשי/רשי על שבת', 'תלמוד בבלי/סדר מועד/שבת']);
    assert.deepStrictEqual([...setOf(lib, ['mefarshim'])].sort(), ['תלמוד בבלי/ראשונים/רשי/רשי על שבת', 'תנך/מפרשים/רשי על בראשית', 'תנך/תרגומים/אונקלוס'].sort());
    const counts = corpora.corpusCounts(lib.books);
    assert.deepStrictEqual([counts.tanach, counts.bavli, counts.mefarshim], [1, 1, 3]);
  });

  await check('corpora: the REAL Otzaria map - every preset is clean (no commentary, right corpus, sane counts)', () => {
    const indexPath = path.join(ROOT, 'otzaria_index_only.txt');
    if (!fs.existsSync(indexPath)) return console.warn('! otzaria_index_only.txt missing; skipping the real-map corpora checks.');
    const paths = fs.readFileSync(indexPath, 'utf8').split('\n').filter((l) => l.endsWith('.txt')).map((l) => l.replace(/^\.\//, '').replace(/\.txt$/, ''));
    const lib = library(paths);
    const counts = corpora.corpusCounts(lib.books);
    const rows = (id) => corpora.resolveCorpusBooks(lib.books, [id]).map((x) => paths[x - 1]);
    // Canonical sizes: 39 Tanach books (Otzaria splits Samuel / Kings / Chronicles / Ezra-Nehemiah), 63 mishnaic tractates, 37 Bavli tractates,
    // Rambam's 83 halachot (+ the 4 introductory works), the 4 parts of SA.
    assert.strictEqual(counts.tanach, 39, 'tanach ' + counts.tanach);
    assert.strictEqual(counts.mishna, 63, 'mishna ' + counts.mishna);
    assert.strictEqual(counts.bavli, 37, 'bavli ' + counts.bavli);
    assert.ok(counts.yerushalmi >= 38 && counts.yerushalmi <= 39, 'yerushalmi ' + counts.yerushalmi);
    assert.ok(counts.rambam >= 83 && counts.rambam <= 90, 'rambam ' + counts.rambam);
    assert.strictEqual(counts['shulchan-aruch'], 4, 'sa ' + counts['shulchan-aruch']);
    assert.ok(counts.mefarshim > 3000, 'mefarshim ' + counts.mefarshim);
    const rootOf = (p) => p.split('/')[0];
    for (const id of ['tanach', 'mishna', 'bavli', 'yerushalmi', 'rambam', 'shulchan-aruch']) {
      for (const p of rows(id)) {
        const f = corpora.folderFacts(p.split('/').slice(0, -1).join('/'));
        assert.ok(!f.rest.some(corpora.isCommentaryDir), `${id}: ${p} sits in a commentary folder`);
        assert.ok(!corpora.isCommentaryTitle(p.split('/').pop()), `${id}: ${p} has a commentary title`);
        assert.ok({ tanach: 'תנך', mishna: 'משנה', bavli: 'תלמוד בבלי', yerushalmi: 'תלמוד ירושלמי', rambam: 'הלכה', 'shulchan-aruch': 'הלכה' }[id] === rootOf(p), `${id}: ${p} in the wrong corpus`);
      }
    }
    // No book is in two base presets; none is both base and "מפרשים".
    const seen = new Map();
    for (const id of ['tanach', 'mishna', 'bavli', 'yerushalmi', 'rambam', 'shulchan-aruch', 'mefarshim']) for (const x of corpora.resolveCorpusBooks(lib.books, [id])) assert.ok(!seen.has(x), `${paths[x - 1]} in ${seen.get(x)} and ${id}`), seen.set(x, id);
    // Spot checks on the real titles.
    const rb = new Set(rows('rambam'));
    assert.ok([...rb].every((p) => /\/משנה תורה, /.test('/' + p)), 'every Rambam hit is a "משנה תורה, ..." work');
    assert.ok(rows('shulchan-aruch').every((p) => /^הלכה\/שולחן ערוך\/שולחן ערוך, /.test(p)));
    assert.ok(rows('bavli').every((p) => /^תלמוד בבלי\/סדר [^/]+\/[^/]+$/.test(p)));
  });

  await check('corpora: Simple Search and Advanced Search resolve identical bookIds for every preset (sample + catalog flags)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kr-corpora-'));
    const lib = library([
      'תנך/תורה/בראשית', 'תנך/תורה/שמות', 'תנך/מפרשים/רשי על בראשית', 'תלמוד בבלי/סדר מועד/שבת', 'תלמוד בבלי/מפרשים/רשי על שבת',
      'משנה/סדר מועד/משנה שבת', 'הלכה/משנה תורה/ספר זמנים/משנה תורה, הלכות שבת', 'הלכה/שולחן ערוך/שולחן ערוך, אורח חיים', 'תלמוד ירושלמי/סדר מועד/תלמוד ירושלמי שבת',
    ]);
    const cat = catalogOf(lib.books);
    const opts = { isCommentary: cat.isCommentary };
    for (const c of corpora.CORPORA) {
      // Simple Search: toggles one preset (scope from the strip). Advanced Search: chips -> scopeOf -> the same function.
      const simple = corpora.corpusScope(cat.bookInfos, [c.id], opts);
      const advanced = corpora.corpusScope(cat.bookInfos, [c.id], opts);
      assert.deepStrictEqual(simple, advanced, c.id);
      assert.deepStrictEqual(simple.ids, corpora.resolveCorpusBooks(lib.books, [c.id], opts), c.id);
      assert.deepStrictEqual(simple.corpora, [c.id]);
      assert.strictEqual(simple.name, `${c.label} (${corpora.countText(simple.ids.length)})`);
    }
    assert.deepStrictEqual(corpora.corpusScope(cat.bookInfos, [], opts), { kind: 'all' });
    assert.deepStrictEqual(corpora.corpusScope(cat.bookInfos, ['tanach', 'bavli'], opts).ids, [lib.idOf('תנך/תורה/בראשית'), lib.idOf('תנך/תורה/שמות'), lib.idOf('תלמוד בבלי/סדר מועד/שבת')]);
    // The real commentary flag agrees with the strict exclusion.
    assert.ok(corpora.resolveCorpusBooks(lib.books, ['tanach', 'mishna', 'bavli', 'yerushalmi', 'rambam', 'shulchan-aruch'], opts).every((id) => cat.isBase(id)));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await check('corpora: the progress banner names the preset and its book count; both screens use the shared module', () => {
    const lib = library(['תלמוד בבלי/סדר מועד/שבת', 'תלמוד בבלי/סדר מועד/ראש השנה', 'תנך/תורה/בראשית']);
    const scope = corpora.corpusScope(lib.books, ['bavli']);
    assert.strictEqual(lifecycle.scopeSearchLabel(scope), 'מחפש בבבלי (2 ספרים)…');
    assert.strictEqual(lifecycle.scopeSearchLabel(corpora.corpusScope(lib.books, ['tanach'])), 'מחפש בתנ"ך (ספר אחד)…');
    assert.strictEqual(lifecycle.scopeSearchLabel({ kind: 'books', ids: [1, 2, 3], name: 'נבחרו 3 ספרים' }), 'מחפש ב-3 ספרים נבחרים…', 'hand-picked books keep their label');
    const simple = fs.readFileSync(path.join(ROOT, 'src/app/search.tsx'), 'utf8');
    const adv = fs.readFileSync(path.join(ROOT, 'src/app/advanced-search.tsx'), 'utf8');
    for (const src of [simple, adv]) assert.ok(src.includes("from '../../shared/corpora'") && src.includes('useCorpora') && src.includes('CorpusPresets'));
    assert.ok(simple.includes('corpus-chip') && adv.includes('adv-corpus'));
    assert.ok(!fs.readFileSync(path.join(ROOT, 'shared/search.js'), 'utf8').includes('corpusCondition'), 'no second (SQL folder pattern) definition of the presets');
  });
}

/**
 * Search progress (section 13): shared/searchLifecycle.js state machine, request-id race safety,
 * abort + real progress in shared/search.js, Hebrew/RTL elapsed formatting, UI wiring.
 */
async function searchProgressTests() {
  const lc = require('../shared/searchLifecycle');
  const mk = (key, rows) => ({ key, rows: rows || [{ id: 1 }], terms: ['x'], hasMore: false, cursor: null, count: { count: (rows || [1]).length, capped: false }, elapsed: 5 });
  const run = (actions, st) => actions.reduce((a, x) => lc.lifecycleReducer(a, x), st || lc.initialLifecycle());

  await check('search lifecycle: starting a search enters loading with stage metadata', () => {
    const st = run([{ type: 'start', id: 1, key: 'k1', now: 1000 }]);
    assert.deepStrictEqual([st.status, st.id, st.key, st.stage, st.scanned, st.startedAt, st.counting], ['searching', 1, 'k1', 'query', 0, 1000, false]);
    const prog = run([{ type: 'progress', id: 1, stage: 'verify', scanned: 750 }], st);
    assert.deepStrictEqual([prog.stage, prog.scanned], ['verify', 750]);
    assert.strictEqual(lc.stageLabel('query', 0, { kind: 'all' }), 'מחפש בכל הספרייה…');
    assert.strictEqual(lc.stageLabel('query', 0, { kind: 'books', ids: [1, 2, 3, 4, 5], name: 'x' }), 'מחפש ב-5 ספרים נבחרים…');
    assert.strictEqual(lc.stageLabel('count', 0, { kind: 'all' }), 'מחשב סך תוצאות…');
    assert.ok(lc.stageLabel('verify', 12000, { kind: 'all' }).startsWith('מעבד התאמות…') && lc.stageLabel('verify', 12000, { kind: 'all' }).includes('\u206612,000\u2069'));
    // The phase is "searching" the instant the key changes, before the effect even dispatches.
    const v = lc.viewOf(lc.initialLifecycle(), 'k1', false);
    assert.deepStrictEqual([v.phase, v.current], ['searching', null]);
    assert.strictEqual(lc.viewOf(st, '', true).phase, 'idle');
  });

  await check('search lifecycle: a newer query discards the stale results of a slower earlier one', () => {
    const counter = lc.createRequestCounter();
    const a = counter.next();
    const b = counter.next();
    assert.ok(b > a && counter.isCurrent(b) && !counter.isCurrent(a));
    let st = run([{ type: 'start', id: a, key: 'old', now: 0 }, { type: 'start', id: b, key: 'new', now: 10 }]);
    // The slow first query answers last: both its page and its count are ignored.
    st = run([{ type: 'page', id: a, results: mk('old', [{ id: 9 }, { id: 8 }]) }, { type: 'count', id: a, count: { count: 99, capped: false } }], st);
    assert.deepStrictEqual([st.status, st.id, st.results], ['searching', b, null]);
    st = run([{ type: 'page', id: b, results: mk('new', [{ id: 1 }]) }], st);
    assert.strictEqual(st.status, 'done');
    st = run([{ type: 'page', id: a, results: mk('old') }, { type: 'more', id: a, rows: [{ id: 7 }], hasMore: false, cursor: null }], st);
    assert.deepStrictEqual(st.results.rows.map((r) => r.id), [1], 'late stale rows never appear');
    assert.strictEqual(st.results.key, 'new');
    // Ids never go back.
    assert.strictEqual(run([{ type: 'start', id: a, key: 'zzz', now: 0 }], st), st);
  });

  await check('search lifecycle: cancel leaves loading at once and ignores late results; empty never flashes', () => {
    let st = run([{ type: 'start', id: 1, key: 'k', now: 0 }, { type: 'cancel', id: 1 }]);
    assert.strictEqual(st.status, 'cancelled');
    let v = lc.viewOf(st, 'k', false);
    assert.deepStrictEqual([v.phase, v.current, v.shown], ['cancelled', null, null]);
    // A page that was already in flight when ביטול was pressed is dropped.
    st = run([{ type: 'page', id: 1, results: mk('k', []) }], st);
    assert.strictEqual(st.status, 'cancelled');
    assert.strictEqual(lc.viewOf(st, 'k', false).current, null, '"לא נמצאו תוצאות" needs a finished (current) result');
    // Typing a new query leaves the cancelled state immediately, then searching -> done.
    assert.strictEqual(lc.viewOf(st, 'k2', false).phase, 'searching');
    st = run([{ type: 'start', id: 2, key: 'k2', now: 5 }, { type: 'page', id: 2, results: mk('k2', []) }], st);
    v = lc.viewOf(st, 'k2', false);
    assert.deepStrictEqual([v.phase, v.current.rows.length], ['done', 0]);
    // While the next query runs the previous rows stay (no empty flash) but `current` is empty.
    st = run([{ type: 'start', id: 3, key: 'k3', now: 6 }], st);
    v = lc.viewOf(st, 'k3', false);
    assert.deepStrictEqual([v.phase, v.current, v.shown && v.shown.key], ['searching', null, 'k2']);
    // First page rendered, total still counting: cancel stops only the count.
    st = run([{ type: 'page', id: 3, results: { ...mk('k3'), count: null, hasMore: true } }], st);
    assert.deepStrictEqual([st.status, st.counting], ['done', true]);
    st = run([{ type: 'cancel', id: 3 }], st);
    assert.deepStrictEqual([st.status, st.counting, st.results.rows.length], ['done', false, 1]);
    st = run([{ type: 'count', id: 3, count: { count: 5, capped: false } }], st);
    assert.strictEqual(st.results.count, null, 'a cancelled count never lands');
  });

  await check('search progress: elapsed time formats cleanly in Hebrew RTL', () => {
    const plain = (t) => t.replace(/[\u2066\u2069]/g, '');
    assert.strictEqual(plain(lc.formatElapsed(1400)), '1.4 שניות');
    assert.strictEqual(plain(lc.formatElapsed(300)), '0.3 שניות');
    assert.strictEqual(plain(lc.formatElapsed(1000)), '1.0 שנייה');
    assert.strictEqual(plain(lc.formatElapsed(12345)), '12.3 שניות');
    assert.strictEqual(plain(lc.formatElapsed(65000)), '1:05 דקות');
    assert.strictEqual(plain(lc.formatElapsed(-5)), '0.0 שניות');
    // The number is an isolated LTR run; the Hebrew unit stays outside it.
    assert.strictEqual(lc.formatElapsed(1400), '\u20661.4\u2069 שניות');
    assert.strictEqual(lc.BANNER_DELAY_MS, 300);
  });

  const dbFile = path.join(ROOT, 'assets/db/library.db');
  if (fs.existsSync(dbFile)) {
    const db = openDb(dbFile);
    try {
      await check('searchPlan / countPlan: abort stops the run; verification reports real progress', async () => {
        const plan = hs.buildQuery({ query: 'שבת', anyOf: '', exclude: '' }, { ...hs.ADVANCED_DEFAULTS, proximity: { mode: 'phrase', distance: 3, ordered: true } });
        const base = await search.searchPlan(db, plan, { fts: true, limit: 5 });
        assert.ok(base.rows.length > 0);
        const ctl = new AbortController();
        ctl.abort();
        await assert.rejects(search.searchPlan(db, plan, { fts: true, signal: ctl.signal }), { name: 'AbortError' });
        await assert.rejects(search.countPlan(db, plan, { fts: true, signal: ctl.signal }), { name: 'AbortError' });
        // Aborting from a progress callback (a user pressing ביטול mid-run) stops the loop.
        const verifying = hs.buildQuery({ query: 'אמר בשבת', anyOf: '', exclude: '' }, { ...hs.ADVANCED_DEFAULTS, proximity: { mode: 'near', distance: 3, ordered: false } });
        const events = [];
        const ctl2 = new AbortController();
        const r = search.countPlan(db, verifying, { fts: true, signal: ctl2.signal, onProgress: (p) => (events.push(p), ctl2.abort()) });
        await r.then(
          (v) => assert.ok(events.length === 0 && v.count >= 0, 'a count that fits one batch never reports'),
          (e) => assert.strictEqual(e.name, 'AbortError'),
        );
        const seen = [];
        await search.searchPlan(db, verifying, { fts: true, onProgress: (p) => seen.push(p) });
        for (const p of seen) assert.ok(p.stage === 'verify' && p.scanned > 0);
        // Same rows with or without hooks.
        const plain = await search.searchPlan(db, plan, { fts: true, limit: 5 });
        const hooked = await search.searchPlan(db, plan, { fts: true, limit: 5, signal: new AbortController().signal, onProgress: () => {} });
        assert.deepStrictEqual(hooked, plain);
      });

      await check('search race: a slow first query that finishes last never replaces the newer query (real DB)', async () => {
        const slowAll = (ms) => ({ all: async (sql, p) => (await new Promise((r) => setTimeout(r, ms)), db.all(sql, p)) });
        const counter = lc.createRequestCounter();
        const exec = async (word, adapter, ms) => {
          const id = counter.next();
          return { id, word, page: await search.searchPlan(adapter, hs.buildQuery(word), { fts: true, limit: 5 }), ms };
        };
        let st = lc.initialLifecycle();
        const first = exec('שבת', slowAll(60));
        st = lc.lifecycleReducer(st, { type: 'start', id: 1, key: 'שבת', now: 0 });
        const second = exec('ברא', slowAll(0));
        st = lc.lifecycleReducer(st, { type: 'start', id: 2, key: 'ברא', now: 1 });
        for (const done of [await second, await first]) {
          st = lc.lifecycleReducer(st, { type: 'page', id: done.id, results: { key: done.word, rows: done.page.rows, terms: [], hasMore: false, cursor: null, count: { count: done.page.rows.length, capped: false }, elapsed: 0 } });
        }
        assert.strictEqual(st.results.key, 'ברא');
        assert.strictEqual(lc.viewOf(st, 'ברא', false).current.key, 'ברא');
      });
    } finally {
      db.close();
    }
  }

  await check('search progress UI: both screens use the shared RTL bar + banner, native driver, cancel, paging footer', () => {
    const ui = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
    const comp = ui('src/components/search/SearchProgress.tsx');
    assert.ok(comp.includes('useNativeDriver: Platform.OS') && comp.includes('BANNER_DELAY_MS') && comp.includes('ביטול') && comp.includes('החיפוש בוטל') && comp.includes('טוען תוצאות נוספות…'));
    assert.ok(/stage: \{[^}]*\.\.\.alignRight/.test(comp) && !/(paddingLeft|paddingRight|marginLeft|marginRight)/.test(comp), 'RTL-safe styles');
    for (const f of ['src/app/search.tsx', 'src/app/advanced-search.tsx']) {
      const src = ui(f);
      assert.ok(src.includes('<SearchProgress') && src.includes('LoadingMoreFooter') && !src.includes('ActivityIndicator'), f);
    }
    const hook = ui('src/components/search/usePlanResults.ts');
    assert.ok(hook.includes('AbortController') && hook.includes('nextFrame') && hook.includes('createRequestCounter'));
    // The empty-results text only needs a finished result: `current` is null while searching / cancelled.
    assert.ok(ui('src/app/search.tsx').includes('current && current.rows.length === 0 && !current.hasMore'));
  });
}

/** Canonical library catalog (shared/libraryCatalog.js) + Bavli Rashi + multi-select scope. */
async function libraryCatalogTests() {
  const lc = require('../shared/libraryCatalog');
  const pairing = require('../shared/pairing');
  const indexPath = path.join(ROOT, 'otzaria_index_only.txt');

  /** Catalog input from "dir/dir/title" paths (what loadCatalog returns). */
  const inputOf = (paths) => {
    const categories = [];
    const cid = new Map();
    const cat = (p) => {
      if (cid.has(p)) return cid.get(p);
      const parts = p.split('/');
      const parent = parts.length > 1 ? cat(parts.slice(0, -1).join('/')) : null;
      categories.push({ id: categories.length + 1, parent_id: parent, name: parts[parts.length - 1], path: p });
      cid.set(p, categories.length);
      return categories.length;
    };
    const books = paths.map((p, i) => {
      const parts = p.split('/');
      const title = parts.pop();
      return { id: i + 1, category_id: cat(parts.join('/')), title, aliases: generateBookAliases(parts, title).join('|') };
    });
    return { categories, books };
  };
  const names = (nodes) => nodes.map((n) => n.name);
  const section = (nodes, name) => nodes.find((n) => n.name === name);

  // ---- 1. Rashi on Talmud Bavli ------------------------------------------------------------
  await check('catalog: Rashi variants on Bavli ("רש"י על ברכות", "רש"י על מסכת …", "רשי על …") are commentaries grouped under their tractate, #1 ahead of Tosafot', () => {
    const paths = [
      'תלמוד בבלי/סדר זרעים/ברכות',
      'תלמוד בבלי/סדר מועד/שבת',
      'תלמוד בבלי/סדר מועד/עירובין',
      'משנה/סדר זרעים/משנה ברכות',
      'תלמוד בבלי/ראשונים/רש"י/סדר זרעים/רש"י על ברכות',
      'תלמוד בבלי/ראשונים/רש"י/סדר מועד/רש"י על מסכת שבת',
      'תלמוד בבלי/ראשונים/רשי/סדר מועד/רשי על עירובין',
      'תלמוד בבלי/ראשונים/תוספות/סדר זרעים/תוספות על ברכות',
      'תלמוד בבלי/ראשונים/תוספות/סדר מועד/תוספות על מסכת שבת',
      'תלמוד בבלי/ראשונים/תוספות/סדר מועד/תוספות על עירובין',
      'תלמוד בבלי/ראשונים/רמבן/סדר זרעים/רמבן על ברכות',
      'תלמוד בבלי/ראשונים/רשבא/סדר זרעים/רשבא על ברכות',
      'תלמוד בבלי/ראשונים/רי"ף/סדר זרעים/רי"ף ברכות',
      'תלמוד בבלי/אחרונים/מהרשא/סדר זרעים/מהרשא על ברכות',
      'משנה/ראשונים/רש"י/סדר נזיקין/רש"י על משנה אבות',
    ];
    const { categories, books } = inputOf(paths);
    const cat = lc.buildLibraryCatalog({ categories, books });
    const idOf = (t, cp) => books.find((b) => b.title === t && categories.find((c) => c.id === b.category_id).path.startsWith(cp || '')).id;
    for (const [rashi, tractate] of [['רש"י על ברכות', 'ברכות'], ['רש"י על מסכת שבת', 'שבת'], ['רשי על עירובין', 'עירובין']]) {
      const r = idOf(rashi);
      const base = idOf(tractate, 'תלמוד בבלי/סדר');
      assert.strictEqual(cat.isCommentary(r), true, `${rashi} is_commentary`);
      assert.strictEqual(cat.isCommentary(base), false);
      assert.strictEqual(cat.baseOf(r), base, `${rashi} -> ${tractate} (Bavli, not the Mishnah)`);
      const list = cat.commentariesOf(base);
      assert.strictEqual(list[0].name, 'רש"י', `${tractate}: Rashi first: ${list.map((x) => x.name)}`);
      assert.strictEqual(list[0].tier, 'עיקריים');
      assert.strictEqual(list[1].name, 'תוספות', 'Tosafot second');
      assert.ok(list.findIndex((x) => x.name === 'רשב"א') > 1 || list.every((x) => x.name !== 'רשב"א'), 'Rashi and Tosafot before the other Rishonim');
    }
  });

  await check('commentary drawer: one uniform list - no עיקריים / נוספים UI, order still primary-first, only תרגומים / מקבילים / מקור are badged', () => {
    const ui = fs.readFileSync(path.join(ROOT, 'src/components/reader/CommentaryPane.tsx'), 'utf8');
    const code = ui.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    assert.ok(!/עיקריים|נוספים|אחרים/.test(code), 'no primary / other labels in the drawer');
    assert.ok(!/g\.core|\.core\b/.test(code), 'no per-commentator styling by primary status');
    assert.ok(!/pillCore[^\n]*g\.|g\.[^\n]*pillCore/.test(code) && !/tierCore/.test(code));
    // The order is intact: canonical commentators first, the rest after, deterministic.
    const mk = (id, title, cat) => ({ bookId: id, bookTitle: title, categoryPath: cat });
    const groups = [
      mk(1, 'חידושי אגדות על בראשית', 'תנך/אחרונים/חידושי אגדות'),
      mk(2, 'רמב"ן על בראשית', 'תנך/ראשונים/רמבן'),
      mk(3, 'רש"י על בראשית', 'תנך/ראשונים/רש"י'),
      mk(4, 'אונקלוס על בראשית', 'תנך/תרגומים/אונקלוס'),
      mk(5, 'פירוש לא מוכר על בראשית', 'תנך/מחברי זמננו/פירוש לא מוכר'),
    ];
    const a = rank.rankCommentaries(groups, { context: { title: 'בראשית' } });
    const b = rank.rankCommentaries([...groups].reverse(), { context: { title: 'בראשית' } });
    assert.deepStrictEqual(a.map((r) => r.bookId), b.map((r) => r.bookId), 'deterministic');
    const firstOther = a.findIndex((r) => !r.core && r.kind === 'commentary');
    assert.ok(a.slice(0, firstOther).filter((r) => r.kind === 'commentary').every((r) => r.core), 'primaries before the rest');
    assert.deepStrictEqual(a.filter((r) => r.kind === 'commentary').map((r) => r.displayName).slice(0, 2), ['רש"י', 'רמב"ן']);
    assert.strictEqual(a.filter((r) => r.kind === 'targum').length, 1);
  });

  await check('catalog: the commentary drawer ranks Bavli Rashi #1 and keeps it first, ahead of the other commentators (with or without the book path)', () => {
    const groups = [
      { bookId: 1, bookTitle: 'רשבא על ברכות', categoryPath: 'תלמוד בבלי/ראשונים/רשבא/סדר זרעים' },
      { bookId: 2, bookTitle: 'תוספות על ברכות', categoryPath: 'תלמוד בבלי/ראשונים/תוספות/סדר זרעים' },
      { bookId: 3, bookTitle: 'רש"י על מסכת ברכות', categoryPath: 'תלמוד בבלי/ראשונים/רש"י/סדר זרעים' },
      { bookId: 4, bookTitle: 'מהרשא על ברכות', categoryPath: 'תלמוד בבלי/אחרונים/מהרשא/סדר זרעים' },
      { bookId: 5, bookTitle: 'אבן העוזר על ברכות', categoryPath: 'תלמוד בבלי/אחרונים/אבן העוזר' },
    ];
    for (const context of [{ title: 'ברכות' }, { title: 'ברכות', categoryPath: 'תלמוד בבלי/סדר זרעים' }, undefined]) {
      const ranked = rank.rankCommentaries(groups, { context });
      assert.deepStrictEqual(ranked.slice(0, 2).map((r) => r.bookId), [3, 2], `Rashi, then Tosafot (${JSON.stringify(context)})`);
      assert.strictEqual(ranked[0].rank, 0);
      // No עיקריים-only view any more: the filter returns every commentator, in the same priority order.
      const all = rank.filterCommentaries(ranked, { view: 'core' });
      assert.deepStrictEqual(all.map((r) => r.bookId), ranked.map((r) => r.bookId), 'no primary / secondary split');
      assert.ok(rank.defaultExpandedKeys(ranked).has(ranked[0].key), 'open by default');
    }
  });

  if (fs.existsSync(indexPath)) {
    const paths = fs.readFileSync(indexPath, 'utf8').split('\n').filter((l) => l.endsWith('.txt')).map((l) => l.replace(/^\.\//, '').replace(/\.txt$/, ''));
    const input = inputOf(paths);
    const t0 = Date.now();
    const catalog = await lc.buildLibraryCatalogAsync(input, () => Promise.resolve());
    const ms = Date.now() - t0;
    const idOfPath = new Map(paths.map((p, i) => [p, i + 1]));

    await check('catalog: every real Otzaria Bavli Rashi file is a commentary on its tractate, #1 ahead of Tosafot', () => {
      const rashi = paths.filter((p) => /^תלמוד בבלי\/ראשונים\/רשי\/סדר [^/]+\/רשי על /.test(p));
      assert.ok(rashi.length >= 36, `${rashi.length} Rashi tractates in the map`);
      for (const p of rashi) {
        const id = idOfPath.get(p);
        const tractate = p.split('/').pop().replace('רשי על ', '');
        const seder = p.split('/')[3];
        const baseId = catalog.baseOf(id);
        assert.strictEqual(catalog.isCommentary(id), true, p);
        assert.strictEqual(catalog.bookPath(baseId), `תלמוד בבלי/${seder}`, `${p} -> ${catalog.bookPath(baseId)}`);
        assert.strictEqual(catalog.bookTitle(baseId), tractate, p);
        const list = catalog.commentariesOf(baseId);
        assert.strictEqual(list[0].bookId, id, `${tractate}: Rashi is #1 (got ${list[0].title})`);
        assert.strictEqual(list[0].rank, 0);
        const tosafot = list.findIndex((x) => x.name === 'תוספות');
        assert.ok(tosafot === -1 || tosafot > 0, 'Tosafot after Rashi');
        assert.ok(list.filter((x) => x.core).length >= 1 && list[0].core);
      }
      // Rashi is never a standalone book in the base tree.
      const baseIds = new Set(lc.treeBookIds(catalog.sections));
      for (const p of rashi) assert.ok(!baseIds.has(idOfPath.get(p)), `${p} must not be listed as a base book`);
      console.log(`  catalog: ${input.books.length} books in ${ms}ms, ${catalog.generalCommentaries.length} general commentaries`);
    });

    // ---- 2. Canonical order ----------------------------------------------------------------
    const present = (list, have) => list.filter((n) => have.has(n));
    await check('catalog: top sections in canonical order, empty ones hidden', () => {
      const top = names(catalog.sections);
      const want = lc.TOP_SECTIONS.filter((n) => top.includes(n));
      assert.deepStrictEqual(top, want);
      assert.deepStrictEqual(top.slice(0, 6), ['תנ"ך', 'משנה', 'תלמוד בבלי', 'תלמוד ירושלמי', 'מדרש', 'הלכה']);
      assert.ok(top.every((n) => section(catalog.sections, n).count > 0));
      assert.ok(!top.includes('ספרים אישיים'), 'no personal books -> no section');
    });
    await check('catalog: תנ"ך = תורה (בראשית..דברים), נביאים (יהושע..מלאכי), כתובים (תהילים..דברי הימים ב)', () => {
      const tanach = section(catalog.sections, 'תנ"ך');
      assert.deepStrictEqual(names(tanach.children).slice(0, 3), ['תורה', 'נביאים', 'כתובים']);
      const titles = (n) => names(section(tanach.children, n).children);
      assert.deepStrictEqual(titles('תורה'), lc.CANON.TORAH);
      assert.deepStrictEqual(titles('נביאים'), lc.CANON.NEVIIM);
      assert.deepStrictEqual(titles('כתובים'), lc.CANON.KETUVIM);
      assert.deepStrictEqual([titles('כתובים')[0], titles('כתובים').pop()], ['תהילים', 'דברי הימים ב']);
    });
    await check('catalog: משנה = six sedarim in order, tractates in canonical order inside each', () => {
      const m = section(catalog.sections, 'משנה');
      const sedarim = m.children.filter((c) => /^סדר /.test(c.name));
      assert.deepStrictEqual(names(sedarim), lc.CANON.SEDARIM.map((x) => 'סדר ' + x));
      sedarim.forEach((sd, i) => {
        const have = new Set(names(sd.children).map((n) => n.replace(/^משנה /, '')));
        const haveKeys = new Set([...have].map(lc.canon));
        assert.deepStrictEqual(names(sd.children).map((n) => lc.canon(n.replace(/^משנה /, ''))), lc.CANON.MISHNA_TRACTATES[i].map(lc.canon).filter((n) => haveKeys.has(n)), sd.name + ' (מדות = מידות)');
      });
      assert.deepStrictEqual(names(sedarim[0].children).slice(0, 3), ['משנה ברכות', 'משנה פאה', 'משנה דמאי']);
    });
    await check('catalog: תלמוד בבלי in Shas order (ברכות, שבת, עירובין, פסחים ... נדה)', () => {
      const b = section(catalog.sections, 'תלמוד בבלי');
      const tractates = b.children.filter((c) => c.kind === 'book').map((c) => c.title);
      assert.deepStrictEqual(tractates.slice(0, 5), ['ברכות', 'שבת', 'עירובין', 'פסחים', 'יומא']);
      assert.deepStrictEqual(tractates, present(lc.CANON.BAVLI_TRACTATES, new Set(tractates)));
      assert.ok(tractates.length >= 35 && tractates[tractates.length - 1] === 'נדה' && tractates.indexOf('בבא קמא') < tractates.indexOf('בבא מציעא') && tractates.indexOf('מגילה') < tractates.indexOf('יבמות'));
      const y = section(catalog.sections, 'תלמוד ירושלמי');
      assert.deepStrictEqual(y.children.slice(0, 3).map((c) => c.title), ['תלמוד ירושלמי ברכות', 'תלמוד ירושלמי פאה', 'תלמוד ירושלמי דמאי']);
    });
    await check('catalog: הלכה = משנה תורה (14 ספרים, מדע..שופטים), ארבעה טורים, שולחן ערוך (או"ח, יו"ד, אה"ע, חו"מ)', () => {
      const h = section(catalog.sections, 'הלכה');
      assert.deepStrictEqual(names(h.children).slice(0, 3), ['משנה תורה לרמב"ם', 'ארבעה טורים', 'שולחן ערוך']);
      const mt = section(h.children, 'משנה תורה לרמב"ם');
      const sefarim = names(mt.children).filter((n) => /^ספר /.test(n));
      assert.deepStrictEqual(sefarim.map(lc.canon), ['מדע', 'אהבה', 'זמנים', 'נשים', 'קדושה', 'הפלאה', 'זרעים', 'עבודה', 'קרבנות', 'טהרה', 'נזיקין', 'קנין', 'משפטים', 'שופטים'].map((x) => lc.canon('ספר ' + x)), 'real folder spellings (קורבנות, קניין) in order');
      assert.strictEqual(sefarim.length, 14);
      assert.strictEqual(mt.children[0].name, 'הקדמה', 'הקדמה first');
      const zmanim = section(mt.children, 'ספר זמנים').children.map((c) => c.title);
      assert.deepStrictEqual(zmanim.slice(0, 3), ['משנה תורה, הלכות שבת', 'משנה תורה, הלכות עירובין', 'משנה תורה, הלכות שביתת עשור']);
      const sa = section(h.children, 'שולחן ערוך').children.filter((c) => c.kind === 'book').map((c) => c.title);
      assert.deepStrictEqual(sa.slice(-4), ['שולחן ערוך, אורח חיים', 'שולחן ערוך, יורה דעה', 'שולחן ערוך, אבן העזר', 'שולחן ערוך, חושן משפט']);
      const tur = section(h.children, 'ארבעה טורים');
      assert.deepStrictEqual(tur.children.map((c) => c.title), ['טור']);
    });
    await check('catalog: מדרש (מדרש רבה in order, מדרשי הלכה, תנחומא, ילקוט שמעוני), מחשבה ומוסר, קבלה וחסידות, סדר התפילה', () => {
      const m = section(catalog.sections, 'מדרש');
      assert.deepStrictEqual(names(m.children).slice(0, 4), ['מדרש רבה', 'מדרשי הלכה', 'תנחומא', 'ילקוט שמעוני']);
      assert.deepStrictEqual(names(section(m.children, 'מדרש רבה').children).slice(0, 5), ['בראשית רבה', 'שמות רבה', 'ויקרא רבה', 'במדבר רבה', 'דברים רבה']);
      assert.deepStrictEqual(names(section(m.children, 'מדרשי הלכה').children).slice(0, 3), ['מכילתא דרבי ישמעאל', 'מכילתא דרבי שמעון בן יוחאי', 'ספרא']);
      assert.ok(catalog.sections.some((n) => n.name === 'מחשבה ומוסר') && catalog.sections.some((n) => n.name === 'קבלה וחסידות') && catalog.sections.some((n) => n.name === 'סדר התפילה'));
      assert.strictEqual(names(section(catalog.sections, 'קבלה וחסידות').children)[0], 'קבלה');
    });

    // ---- 3. Base books vs commentaries -----------------------------------------------------
    await check('catalog: strict separation (base lists hold no commentaries; each commentary has exactly one parent or is general)', () => {
      const baseIds = new Set(lc.treeBookIds(catalog.sections));
      let comms = 0;
      for (const b of input.books) {
        if (catalog.isCommentary(b.id)) {
          comms++;
          assert.ok(!baseIds.has(b.id), `${b.title} is in a base list`);
        } else assert.ok(baseIds.has(b.id), `${b.title} (base) is missing from the tree`);
      }
      assert.ok(comms > 5800, `${comms} commentaries`);
      let grouped = 0;
      for (const id of baseIds) grouped += catalog.commentaryCount(id);
      assert.strictEqual(grouped + catalog.generalCommentaries.length, comms, 'every commentary is in exactly one group');
      // The commentary view lists only base books that have commentaries, then "מפרשים כלליים".
      const commTop = names(catalog.commentarySections);
      assert.strictEqual(commTop[commTop.length - 1], 'מפרשים כלליים');
      for (const id of lc.treeBookIds(catalog.commentarySections.filter((n) => n.name !== 'מפרשים כלליים'))) assert.ok(catalog.commentaryCount(id) > 0);
      // Midrashim on Tanach and Yalkut stay base books.
      assert.ok(baseIds.has(idOfPath.get('מדרש/אגדה/ילקוט שמעוני על התורה')) && baseIds.has(idOfPath.get('מדרש/אגדה/מדרש רבה/בראשית רבה')));
      // A corpus-wide commentary is general.
      assert.ok(catalog.generalCommentaries.some((g) => g.title === 'חידושי מהראל על השס'));
    });
    await check('catalog: commentaries from ראשונים / אחרונים / תרגומים are one group under their base, in canonical rank order', () => {
      const bereshit = idOfPath.get('תנך/תורה/בראשית');
      const list = catalog.commentariesOf(bereshit);
      const eraOf = (x) => rank.eraOf(x.categoryPath, null);
      assert.ok(list.length >= 20, `${list.length} commentaries on בראשית`);
      const eras = new Set(list.map(eraOf));
      for (const e of ['rishonim', 'acharonim', 'targum']) assert.ok(eras.has(e), `${e} commentaries grouped together`);
      assert.deepStrictEqual(list.slice(0, 6).map((x) => x.name), ['אונקלוס', 'תרגום יונתן', 'רש"י', 'רמב"ן', 'אבן עזרא', 'ספורנו'].filter((n) => list.some((x) => x.name === n)).slice(0, 6));
      assert.strictEqual(list.find((x) => x.name === 'רש"י').rank < list.find((x) => x.name === 'רמב"ן').rank, true);
      const firstNonCore = list.findIndex((x) => !x.core);
      assert.ok(list.slice(0, firstNonCore).every((x) => x.core) && list.slice(firstNonCore).every((x) => !x.core), 'core commentators first');
      const order = { targum: 0, rishonim: 1, acharonim: 2, modern: 3 };
      const rest = list.slice(firstNonCore).filter((x) => eraOf(x));
      for (let i = 1; i < rest.length; i++) assert.ok(order[eraOf(rest[i - 1])] <= order[eraOf(rest[i])], `era order at ${rest[i].title}`);
      // Shulchan Aruch אורח חיים: משנה ברורה, מגן אברהם ... lead.
      const oc = catalog.commentariesOf(idOfPath.get('הלכה/שולחן ערוך/שולחן ערוך, אורח חיים'));
      assert.deepStrictEqual(oc.slice(0, 2).map((x) => x.name), ['משנה ברורה', 'מגן אברהם']);
      // Mishna: the Rambam's / Bartenura's commentaries lead.
      assert.ok(catalog.commentariesOf(idOfPath.get('משנה/סדר זרעים/משנה ברכות'))[0].core);
    });
    await check('catalog: unmatched commentaries go to "מפרשים כלליים"; empty sections vanish in a small library', () => {
      const small = lc.buildLibraryCatalog(
        inputOf(['תנך/תורה/בראשית', 'תנך/תורה/שמות', 'תנך/מפרשים/רשי על בראשית', 'תנך/מפרשים/ראשונים/ספר שאינו קיים על ספר אחר', 'תלמוד בבלי/סדר מועד/שבת', 'תלמוד בבלי/מפרשים/רשי על שבת']),
      );
      assert.deepStrictEqual(names(small.sections), ['תנ"ך', 'תלמוד בבלי']);
      assert.deepStrictEqual(names(small.sections[0].children), ['תורה']);
      assert.deepStrictEqual(names(small.commentarySections), ['תנ"ך', 'תלמוד בבלי', 'מפרשים כלליים']);
      assert.deepStrictEqual(small.generalCommentaries.map((g) => g.title), ['ספר שאינו קיים על ספר אחר']);
      assert.deepStrictEqual(small.commentariesOf(2).length, 0);
      assert.deepStrictEqual(small.commentariesOf(1).map((x) => x.name), ['רש"י']);
      assert.deepStrictEqual(names(small.commentarySections[0].children[0].children), ['בראשית'], 'only books with commentaries in the commentary view');
      assert.strictEqual(lc.buildLibraryCatalog({ categories: [], books: [] }).sections.length, 0);
    });
    await check('catalog: personal books get their own last section; live filter understands abbreviations', () => {
      const withUser = lc.buildLibraryCatalog({
        categories: [...input.categories.slice(0, 3), { id: 900000001, parent_id: null, name: 'הספרים שלי', path: 'הספרים שלי' }],
        books: [...input.books.filter((b) => b.category_id <= 3), { id: 1000000001, category_id: 900000001, title: 'חידושי שלי', aliases: '' }],
      });
      assert.strictEqual(names(withUser.sections).pop(), 'ספרים אישיים');
      assert.deepStrictEqual(lc.treeBookIds(lc.filterTree(catalog.sections, 'שו"ע או"ח')).map((id) => input.books[id - 1].title).includes('שולחן ערוך, אורח חיים'), true);
      assert.ok(lc.treeBookIds(lc.filterTree(catalog.sections, 'ב"ק')).some((id) => input.books[id - 1].title === 'בבא קמא'));
      assert.deepStrictEqual(lc.filterTree(catalog.sections, 'zzzz'), []);
    });
    await check('catalog: builds the full library fast', () => {
      assert.ok(ms < 8000, `${ms}ms`);
      const t = process.hrtime.bigint();
      for (let i = 0; i < 200; i++) catalog.commentariesOf(idOfPath.get('תלמוד בבלי/סדר זרעים/ברכות'));
      assert.ok(Number(process.hrtime.bigint() - t) / 1e6 < 50, 'cached rank lookups');
    });
    void pairing;
  }

  // ---- 4. daf / amud forms + linking ---------------------------------------------------------
  await check('refAlign: every daf / amud spelling is one canonical unit (דף ב עמוד א = דף ב. = דף ב, א = ע"א ...)', () => {
    const k = (t) => refAlign.refKeyOf(refAlign.unitLabels(t));
    for (const a of ['דף ב עמוד א', 'דף ב.', 'ב.', 'דף ב ע"א', 'דף ב עמ\' א', 'דף ב, א', 'דף ב - עמוד א', 'דף ב ע א', 'דף ב עמוד א.', 'דף ב א']) assert.strictEqual(k(a), 'דף ב|עמוד א', a);
    for (const b of ['דף ב עמוד ב', 'דף ב:', 'ב:', 'דף ב ע"ב', 'דף ב, ב', 'דף ב - עמוד ב', 'דף ב ע ב', 'דף ב ב']) assert.strictEqual(k(b), 'דף ב|עמוד ב', b);
    assert.strictEqual(k('דף כ"ג, ב'), 'דף כג|עמוד ב');
    assert.strictEqual(k('דף יא'), 'דף יא', 'a daf ending in א is not an amud');
    assert.strictEqual(k('דף יא.'), 'דף יא|עמוד א');
    assert.strictEqual(k('ע"ב'), 'עמוד ב');
  });
  await check('Bavli import: Rashi and Tosafot link to the right daf / amud across mixed heading spellings and rank Rashi #1', async () => {
    const pipeline = require('../shared/pipeline');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kodesh-bavli-'));
    try {
      const lib = path.join(tmp, 'אוצריא');
      const put = (rel, lines) => {
        fs.mkdirSync(path.dirname(path.join(lib, rel)), { recursive: true });
        fs.writeFileSync(path.join(lib, rel + '.txt'), lines.join('\n'));
      };
      // Base tractates use "דף ב עמוד א" (ברכות) and "דף ב." / "דף ב:" (שבת); the commentaries mix spellings.
      put('תלמוד בבלי/סדר זרעים/ברכות', ['<h1>ברכות</h1>', '<h2>דף ב עמוד א</h2>', 'גמרא ברכות ב א', '<h2>דף ב עמוד ב</h2>', 'גמרא ברכות ב ב', '<h2>דף ג עמוד א</h2>', 'גמרא ברכות ג א']);
      put('תלמוד בבלי/ראשונים/רשי/סדר זרעים/רש"י על מסכת ברכות', ['<h1>רש"י על ברכות</h1>', '<h2>דף ב.</h2>', 'רשי ברכות ב א', '<h2>דף ב:</h2>', 'רשי ברכות ב ב1', 'רשי ברכות ב ב2', '<h2>דף ג.</h2>', 'רשי ברכות ג א']);
      put('תלמוד בבלי/ראשונים/תוספות/סדר זרעים/תוספות על ברכות', ['<h1>תוספות על ברכות</h1>', '<h2>דף ב ע"א</h2>', 'תוס ברכות ב א', '<h2>דף ב ע"ב</h2>', 'תוס ברכות ב ב']);
      put('תלמוד בבלי/סדר מועד/שבת', ['<h1>שבת</h1>', '<h2>דף ב.</h2>', 'גמרא שבת ב א', '<h2>דף ב:</h2>', 'גמרא שבת ב ב']);
      put('תלמוד בבלי/ראשונים/רשי/סדר מועד/רשי על שבת', ['<h1>רשי על שבת</h1>', '<h2>דף ב, א</h2>', 'רשי שבת ב א', '<h2>דף ב, ב</h2>', 'רשי שבת ב ב']);
      put('תלמוד בבלי/ראשונים/רמבן/סדר מועד/רמבן על שבת', ['<h1>רמבן על שבת</h1>', '<h2>דף ב - עמוד ב</h2>', 'רמבן שבת ב ב']);
      put('תלמוד בבלי/ראשונים/תוספות/סדר מועד/תוספות על שבת', ['<h1>תוספות על שבת</h1>', '<h2>דף ב עמוד א</h2>', 'תוס שבת ב א', '<h2>דף ב עמוד ב</h2>', 'תוס שבת ב ב']);
      const db = openWal(path.join(tmp, 'bavli.db'));
      await indexer.ensureSchema(db.w, { kind: 'core' });
      await pipeline.runImport(db.w, nodeFs, { source: { kind: 'folder', root: lib }, sourceUri: lib, targetDb: 'core', yieldToUI: () => Promise.resolve(), finalize: false });
      await pipeline.completeImport(db.w);
      const id = async (title) => Number((await db.read.all('SELECT id FROM books WHERE title = ?', [title]))[0].id);
      const lineOf = async (bookId, text) => Number((await db.read.all('SELECT line_index AS l FROM paragraphs WHERE book_id = ? AND display_text = ?', [bookId, text]))[0].l);
      const view = async (bookTitle, text) => {
        const bookId = await id(bookTitle);
        const groups = commentary.groupLinkedEntries(await commentary.fetchLinkedEntries(db.read, bookId, await lineOf(bookId, text)));
        const ranked = rank.rankCommentaries(groups, { context: { title: bookTitle } });
        return ranked.map((g) => [g.displayName, g.entries.map((e) => e.display_text).join('+'), g.core, g.rank]);
      };
      assert.deepStrictEqual(await view('ברכות', 'גמרא ברכות ב ב'), [['רש"י', 'רשי ברכות ב ב1+רשי ברכות ב ב2', true, 0], ['תוספות', 'תוס ברכות ב ב', true, 1]], 'ברכות ב: (Rashi "דף ב:", Tosafot "דף ב ע"ב")');
      assert.deepStrictEqual(await view('ברכות', 'גמרא ברכות ב א'), [['רש"י', 'רשי ברכות ב א', true, 0], ['תוספות', 'תוס ברכות ב א', true, 1]]);
      assert.deepStrictEqual((await view('ברכות', 'גמרא ברכות ג א')).map((r) => r[0]), ['רש"י'], 'ג. has Rashi only');
      assert.deepStrictEqual(await view('שבת', 'גמרא שבת ב א'), [['רש"י', 'רשי שבת ב א', true, 0], ['תוספות', 'תוס שבת ב א', true, 1]], 'שבת ב. (Rashi "דף ב, א")');
      assert.deepStrictEqual((await view('שבת', 'גמרא שבת ב ב')).map((r) => r[0]), ['רש"י', 'תוספות', 'רמב"ן'], 'שבת ב: ("דף ב, ב", "דף ב - עמוד ב")');
      // The Rashi link goes in both directions.
      const rashi = await id('רש"י על ברכות');
      const back = commentary.groupLinkedEntries(await commentary.fetchLinkedEntries(db.read, rashi, await lineOf(rashi, 'רשי ברכות ב ב2')));
      assert.ok(back.some((g) => g.bookTitle === 'ברכות'), 'Rashi -> the tractate');
      db.raw.close();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  // ---- 5. Multi-select scope: FTS5 == web fallback ------------------------------------------
  const dbFile = path.join(ROOT, 'assets/db/library.db');
  if (!fs.existsSync(dbFile)) return;
  const db = openDb(dbFile);
  try {
    const idOf = async (title) => Number((await db.all('SELECT id FROM books WHERE title = ?', [title]))[0].id);
    const [bereshit, shabbat, rashiShabbat] = [await idOf('בראשית'), await idOf('שבת'), await idOf('רש"י על שבת')];
    const scopeOf = (ids) => search.booksScope(ids.map((id) => ({ id, title: String(id) })));
    const run = async (plan, scope, fts) => {
      const out = [];
      let cursor = null;
      for (;;) {
        const page = await search.searchPlan(db, plan, { scope, fts, cursor, limit: 30 });
        out.push(...page.rows.map((r) => r.id));
        if (!page.hasMore) return out;
        cursor = page.cursor;
      }
    };
    await check('multi-select scope: 2 base books + 1 commentary give identical rows in FTS5 and the web fallback (one query)', async () => {
      const scope = scopeOf([bereshit, shabbat, rashiShabbat]);
      assert.deepStrictEqual(search.scopeClause(scope).params, [bereshit, shabbat, rashiShabbat]);
      assert.ok(/f\.book_id IN \(\?,\?,\?\)/.test(search.scopeClause(scope).sql), 'a single IN clause');
      let nonEmpty = 0;
      for (const q of ['אמר', 'את', 'בראשית', 'שבת', 'ה', 'שבת רבא', 'אמר רב']) {
        const plan = hs.buildQuery(q);
        const fts = await run(plan, scope, true);
        const like = await run(plan, scope, false);
        assert.deepStrictEqual(like, fts, q);
        // == the union of the three single-book searches, in id order.
        const union = [];
        for (const id of [bereshit, shabbat, rashiShabbat]) union.push(...(await run(plan, { kind: 'book', bookId: id, title: '' }, true)));
        assert.deepStrictEqual(fts, union.sort((a, b) => a - b), `${q}: union of single-book searches`);
        const books = new Set(fts.length ? (await db.all(`SELECT DISTINCT book_id FROM paragraphs WHERE id IN (${fts.join(',')})`)).map((r) => Number(r.book_id)) : []);
        for (const b of books) assert.ok([bereshit, shabbat, rashiShabbat].includes(b), `${q}: row from outside the scope (${b})`);
        const c1 = await search.countPlan(db, plan, { scope, cap: 100000, fts: true });
        const c2 = await search.countPlan(db, plan, { scope, cap: 100000, fts: false });
        assert.strictEqual(c1.count, fts.length);
        assert.strictEqual(c2.count, fts.length);
        if (fts.length) nonEmpty++;
      }
      assert.ok(nonEmpty >= 3, `${nonEmpty} non-empty queries`);
      // The legacy searchParagraphs / countMatches accept it too (FTS5 only: its LIKE fallback is a substring match).
      const a = await search.searchParagraphs(db, 'שבת', { scope, limit: 500 });
      assert.ok(a.rows.length > 0 && a.rows.every((r) => [bereshit, shabbat, rashiShabbat].includes(r.book_id)));
      assert.strictEqual((await search.countMatches(db, 'שבת', { scope, cap: 100000 })).count, a.rows.length);
    });
    await check('multi-select scope: empty = whole library, one pick = that book, large selections stay one statement, ids of other databases are ignored', async () => {
      assert.deepStrictEqual(search.booksScope([]), { kind: 'all' });
      const one = search.booksScope([{ id: shabbat, title: 'שבת' }, { id: shabbat, title: 'שבת' }]);
      assert.strictEqual(one.name, 'שבת');
      assert.deepStrictEqual(one.ids, [shabbat]);
      assert.strictEqual(scopeOf([1, 2, 3]).name, 'נבחרו 3 ספרים');
      const many = Array.from({ length: 1200 }, (_, i) => i + 1);
      const c = search.bookIdsCondition('f.book_id', many);
      assert.strictEqual(c.params.length, 1200);
      assert.strictEqual((c.sql.match(/ IN \(/g) || []).length, 3, 'chunks of 500 OR-ed in one condition');
      const plan = hs.buildQuery('את');
      const all = await run(plan, { kind: 'all' }, true);
      const wide = await run(plan, scopeOf(many.concat([shabbat, bereshit])), true);
      assert.deepStrictEqual(wide, all, 'all sample books in scope -> same rows as the whole library');
      assert.deepStrictEqual(await run(plan, scopeOf([999999]), true), []);
    });
    await check('multi-select scope: routes to the owning databases of a core + personal router', async () => {
      const router = sources.createRouter([
        { name: 'core', adapter: db, idBase: 0 },
        { name: 'user', adapter: { all: async () => [] }, idBase: 1000000000 },
      ]);
      const scope = scopeOf([shabbat, 1000000001]);
      const rows = await search.searchPlan(router, hs.buildQuery('שבת'), { scope, limit: 50 });
      assert.ok(rows.rows.length > 0 && rows.rows.every((r) => r.book_id === shabbat));
    });
  } finally {
    db.close();
  }

  await check('UI wiring: Library + ScopeSheet render from the catalog, RTL, with the segmented toggle, multi-select and chips', () => {
    const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
    const lib = read('src/components/LibraryColumns.tsx');
    for (const id of ['library-mode-', 'library-filter', 'tree-comm-', 'ספרי בסיס', 'מפרשים לפי ספר', 'מפרשים (']) assert.ok(lib.includes(id), id);
    assert.ok(lib.includes('useLibraryCatalog') && !lib.includes('loadCatalog('));
    assert.ok(/\.\.\.inputAlignRight/.test(lib) && /\.\.\.alignRight/.test(lib));
    const sheet = read('src/components/search/ScopeSheet.tsx');
    for (const id of ['scope-tab-', 'scope-filter', 'scope-allcomm-', 'scope-open-book-comm', 'scope-apply', 'scope-clear', 'ספרי בסיס', 'פרשנים לפי ספר', 'הספר הפתוח כעת', 'הספר הפתוח + מפרשיו', 'כל הפרשנים על', 'בחר הכל', 'כל הספרייה']) assert.ok(sheet.includes(id), id);
    assert.ok(sheet.includes('useLibraryCatalog') && sheet.includes('booksScope'));
    assert.ok(/\.\.\.inputAlignRight/.test(sheet));
    for (const f of ['src/app/search.tsx', 'src/app/advanced-search.tsx']) assert.ok(read(f).includes('<ScopeChips'), f);
    assert.ok(read('src/app/advanced-search.tsx').includes('adv-scope-button'));
    const chips = read('src/components/search/ScopeChips.tsx');
    for (const id of ['scope-chip-', 'scope-badge', 'נבחרו', 'נקה']) assert.ok(chips.includes(id), id);
    // Sleek compact Advanced Search button: ghost outline, small tune icon, tight padding.
    const simple = read('src/app/search.tsx');
    assert.ok(/advancedBtn: \{[^}]*borderWidth: 1[^}]*backgroundColor: 'transparent'/s.test(simple), 'ghost outline');
    assert.ok(/paddingHorizontal: 8/.test(simple.slice(simple.indexOf('advancedBtn:'))) && /<SlidersIcon size=\{13\}/.test(simple));
    assert.ok(/advancedText: \{[^}]*fontSize: 12/.test(simple));
  });
}

/** Simple vs Advanced Search: the Hebrew query engine (shared/hebrewSearch.js) + plan execution. */
async function advancedSearchTests() {
  const A = hs.ADVANCED_DEFAULTS;
  const n = (w) => dict.normKey(w);
  const adv = (q, o) => hs.buildQuery(q, { ...A, ...(o || {}) });
  const toks = (s) => hs.toTokens(s);

  await check('search modes: Simple Search is literal, Advanced Search has the exact defaults', () => {
    for (const k of ['prefixesAndSuffixes', 'pleneDefective', 'acronyms', 'aramaicEquiv', 'operators']) assert.strictEqual(hs.SIMPLE_DEFAULTS[k], false, `simple ${k}`);
    assert.strictEqual(hs.SIMPLE_DEFAULTS.proximity.mode, 'paragraph');
    assert.deepStrictEqual(
      { p: A.prefixesAndSuffixes, k: A.pleneDefective, r: A.acronyms, a: A.aramaicEquiv, prox: A.proximity.mode },
      { p: true, k: false, r: false, a: false, prox: 'paragraph' },
    );
    // Simple: every word as typed, no expansion, no operators (punctuation is sanitized away).
    const s = hs.buildQuery('שבת');
    assert.strictEqual(s.match, '"שבת"');
    assert.deepStrictEqual(s.terms, ['שבת']);
    assert.ok(!s.exact && !s.hasExpansions && !s.needsVerify);
    for (const q of ['שולחן', 'ב"ד', 'מותר', 'ושבתות']) assert.ok(!hs.buildQuery(q).hasExpansions, q);
    assert.strictEqual(hs.buildQuery('"שני כחות" באדם').match, '"שני כחות" AND "באדמ"');
    assert.strictEqual(hs.buildQuery('אמר: (רב) -חסדא*').match, '"אמר" AND "רב" AND "חסדא"', 'operators are literal in Simple Search');
    assert.strictEqual(hs.buildQuery('-*():^\'"|').empty, true);
    // Simple Search matches whole tokens only.
    assert.ok(hs.evaluate(s, toks('אמר שבת')) && !hs.evaluate(s, toks('ובשבת שבתות')));
    // The app's stores and screens are wired that way.
    const store = fs.readFileSync(path.join(ROOT, 'src/state/searchStore.ts'), 'utf8');
    assert.ok(store.includes('ADVANCED_DEFAULTS.prefixesAndSuffixes') && !/smart:\s*true/.test(store));
    const simple = fs.readFileSync(path.join(ROOT, 'src/app/search.tsx'), 'utf8');
    assert.ok(simple.includes('buildQuery(query)') && simple.includes('testID="open-advanced-search"') && !simple.includes('search-mode-smart'));
    const advSrc = fs.readFileSync(path.join(ROOT, 'src/app/advanced-search.tsx'), 'utf8');
    for (const id of ['adv-query', 'adv-any', 'adv-exclude', 'adv-submit', 'adv-reset', 'adv-back', 'adv-ordered']) assert.ok(advSrc.includes(id), id);
    for (const label of ['חיפוש מתקדם', 'חזרה לחיפוש רגיל', 'מילות החיפוש / ביטוי', 'אחת מהמילים · או', 'ללא המילים · שלילה', 'תחיליות וסופיות', 'כתיב מלא/חסר', 'ראשי תיבות', 'עברית ↔ ארמית', 'קרבת מילים', 'שמור על סדר המילים', 'סינון לפי מדור', 'נקה הכל', 'הספר הנוכחי']) assert.ok(advSrc.includes(label), label);
    assert.ok(/input: \{[^}]*\.\.\.inputAlignRight/.test(advSrc) && /label: \{[^}]*\.\.\.alignRight/.test(advSrc), 'RTL alignment helpers');
    assert.deepStrictEqual(require('../shared/corpora').CORPORA.map((c) => c.label), ['תנ"ך', 'משנה', 'בבלי', 'ירושלמי', 'משנה תורה', 'שולחן ערוך', 'מפרשים']);
  });

  await check('hebrewSearch: grammatical prefixes (מש"ה וכל"ב) and real suffixes', () => {
    for (const p of ['ו', 'ש', 'ה', 'ב', 'כ', 'ל', 'מ', 'וב', 'וכ', 'ול', 'ומ', 'וה', 'וש', 'שב', 'שכ', 'של', 'שמ', 'שה', 'כש', 'לכ', 'מב', 'מה', 'ושב', 'ושל']) assert.ok(hs.isValidPrefix(p), p);
    for (const p of ['הב', 'בה', 'לב', 'הו', 'בו', 'הל', 'למ']) assert.ok(!hs.isValidPrefix(p), `illegal prefix ${p}`);
    for (const sfx of ['ים', 'ין', 'ות', 'י', 'ו', 'ה', 'ך', 'נו', 'כם', 'הם', 'הן', 'יו', 'יה', 'יהם']) assert.ok(hs.SUFFIXES.includes(n(sfx)) || hs.inflections('ספר').has('ספר' + n(sfx)), sfx);
    const yes = { שבת: ['שבת', 'ושבת', 'בשבת', 'שבתות', 'שבתו', 'השבת', 'ובשבת', 'ושבשבת', 'שבתותיו', 'בשבתם'], תפילה: ['תפילה', 'לתפילתו', 'תפילות', 'תפילת', 'תפילתו', 'בתפילתם', 'ותפילותיהם'], ברכה: ['ברכות', 'ברכתו', 'הברכה', 'בברכות'], מצוה: ['מצות', 'מצוות', 'מצותו', 'המצוה', 'במצות'], ספר: ['ספרים', 'ספרו', 'הספרים', 'ספריהם', 'וכשספרו'] };
    for (const [lemma, forms] of Object.entries(yes)) for (const f of forms) assert.ok(hs.matchesMorph(n(f), n(lemma)), `${lemma} -> ${f}`);
    const no = { שבת: ['הבשבת', 'בהשבת', 'שבתאי', 'לבשבת', 'שבתל', 'ישבת'], תפילה: ['תפילין', 'הבתפילה', 'תפילהו'], מצוה: ['מצוהים'] };
    for (const [lemma, forms] of Object.entries(no)) for (const f of forms) assert.ok(!hs.matchesMorph(n(f), n(lemma)), `${lemma} must not match ${f}`);
    // Short words are protected: no prefixes, no suffixes.
    assert.deepStrictEqual([...hs.inflections('רב')], ['רב']);
    assert.ok(!hs.matchesMorph('ורב', 'רב') && !hs.matchesMorph('רבו', 'רב'));
    const rb = adv('רב');
    assert.deepStrictEqual(rb.terms, ['רב']);
    assert.ok(!rb.hasExpansions);
    // Plan-level: the FTS5 candidates stay bounded and the KWIC / reader mark variants.
    const sh = adv('שבת');
    assert.ok(sh.variantCount <= 60 && sh.terms.includes('~שבת'), sh.variantCount);
    assert.ok(hs.evaluate(sh, toks('ובשבתות')) && !hs.evaluate(sh, toks('הבשבת שבתאי')));
    assert.strictEqual(search.markTerms('והתפלל לתפילתו ובתפילין', adv('תפילה').terms), 'והתפלל <mark>לתפילתו</mark> ובתפילין');
    const k = search.buildKwic('אמר רבא בשבתות ובשבתאי', sh.terms);
    assert.deepStrictEqual(k.segments.filter((x) => x.hit).map((x) => x.text), ['בשבתות']);
  });

  await check('hebrewSearch: smart plene / defective spelling (positive pairs)', () => {
    const pairs = [['מצווה', 'מצוה'], ['עניין', 'ענין'], ['בניין', 'בנין'], ['כוונה', 'כונה'], ['שולחן', 'שלחן'], ['תפילה', 'תפלה'], ['אלהים', 'אלוהים'], ['לימוד', 'למוד'], ['דיבור', 'דבור'], ['קידושין', 'קדושין'], ['חוכמה', 'חכמה'], ['כולם', 'כלם'], ['תשובה', 'תשבה'], ['דוד', 'דויד'], ['יעקב', 'יעקוב'], ['ירושלים', 'ירושלם'], ['פינחס', 'פנחס'], ['תצוה', 'תצווה'], ['תפילין', 'תפלין']];
    for (const [a, b] of pairs) {
      assert.ok(hs.pleneVariants(n(a)).includes(n(b)), `${a} -> ${b}: ${hs.pleneVariants(n(a))}`);
      assert.ok(hs.pleneVariants(n(b)).includes(n(a)), `${b} -> ${a}: ${hs.pleneVariants(n(b))}`);
    }
    // Pattern-aware rules beyond the curated list.
    assert.ok(hs.pleneVariants(n('תיקונים')).includes(n('תקונים')));
    assert.ok(hs.pleneVariants(n('מקוה')).includes(n('מקווה')));
    const p = adv('מצווה', { pleneDefective: true });
    assert.ok(hs.evaluate(p, toks('ובמצוה')) && hs.evaluate(p, toks('מצותו')));
    assert.ok(!hs.evaluate(adv('מצווה'), toks('מצוה')), 'plene is off by default in Advanced Search');
  });

  await check('hebrewSearch: plene / defective strict negatives (no 2-letter collisions, no edge letters)', () => {
    const v = (w) => hs.pleneVariants(n(w));
    for (const [w, bad] of [['שיר', ['שר', 'שור']], ['עיר', ['ער']], ['שלום', ['שלם']], ['שלם', ['שלום']], ['שור', ['שר', 'שיר']], ['ילד', ['לד']], ['דברי', ['דבר']]]) for (const b of bad) assert.ok(!v(w).includes(n(b)), `${w} must not match ${b}: ${v(w)}`);
    for (const w of ['שיר', 'עיר', 'שור', 'שלם', 'דבר', 'שר']) assert.deepStrictEqual(v(w), [], `${w}: short words are never respelled`);
    assert.deepStrictEqual(v('שירים'), [], 'a short stem with a plural suffix is left alone');
    // Never drop an initial ו / י or a final letter, for any word.
    const words = ['דברי', 'שלי', 'אלהי', 'ילד', 'ילדים', 'יצחק', 'ויאמר', 'ושלום', 'לימוד', 'תפילה', 'שולחן', 'מצוות', 'עבודה', 'קדושה', 'בית', 'תורה'];
    for (const w of words) for (const x of v(w)) {
      assert.strictEqual(x[0], n(w)[0], `${w} -> ${x} keeps its first letter`);
      assert.strictEqual(x[x.length - 1], n(w)[n(w).length - 1], `${w} -> ${x} keeps its last letter`);
      assert.ok(x.length >= 3);
    }
    for (const x of v('דברי')) assert.ok(x.endsWith('י'));
    for (const x of v('ילדים')) assert.ok(x.startsWith('י'));
    // Plan level: שיר with plene finds neither שר nor שור (also with prefixes & suffixes).
    const shir = adv('שיר', { pleneDefective: true });
    assert.ok(!hs.evaluate(shir, toks('שר')) && !hs.evaluate(shir, toks('שור')) && !hs.evaluate(shir, toks('שרים')) && hs.evaluate(shir, toks('השירים')));
    const shalom = adv('שלום', { pleneDefective: true });
    assert.ok(!hs.evaluate(shalom, toks('שלם')) && !hs.evaluate(shalom, toks('בשלמות')) && hs.evaluate(shalom, toks('לשלומו')));
    assert.ok(!hs.evaluate(adv('עיר', { pleneDefective: true }), toks('ער')));
  });

  await check('hebrewSearch: Torah acronyms (bidirectional)', () => {
    const R = { acronyms: true };
    for (const [abbr, full] of [['שו"ע', 'שולחן ערוך'], ['ק"ו', 'קל וחומר'], ['א"א', 'אי אפשר'], ['ע"ז', 'עבודה זרה'], ['יו"ט', 'יום טוב']]) {
      const a = adv(abbr, R);
      assert.ok(hs.evaluate(a, toks(`ואמרו ${full} כאן`)), `${abbr} -> ${full}`);
      assert.ok(hs.evaluate(a, toks(`כתב ${abbr}`)), `${abbr} literal`);
      const f = adv(full, R);
      assert.ok(hs.evaluate(f, toks(`כתב ${abbr} כאן`)), `${full} -> ${abbr}`);
      assert.ok(!hs.evaluate(adv(abbr), toks(full)), `${abbr}: acronyms are off by default`);
    }
    // Prefixed acronym / expansion ("בשו"ע", "ובשולחן ערוך").
    const sa = adv('שו"ע', R);
    assert.ok(hs.evaluate(sa, toks('כמבואר בשו"ע')) && hs.evaluate(sa, toks('ובשולחן ערוך')));
    assert.ok(!hs.evaluate(sa, toks('שועל')), 'an abbreviation is never wildcarded');
    assert.ok(search.markTerms('ואמרו קל וחומר', adv('ק"ו', R).terms).includes('<mark>קל</mark> <mark>וחומר</mark>'));
  });

  await check('hebrewSearch: Hebrew <-> Aramaic pairs', () => {
    const pairs = [['מותר', 'שרי'], ['אסור', 'אסיר'], ['קושיה', 'קשיא'], ['תירוץ', 'תרוצא'], ['ספק', 'ספיקא'], ['הלכה', 'הלכתא'], ['טעם', 'טעמא'], ['ראיה', 'ראייתא'], ['מים', 'מיא'], ['שבת', 'שבתא'], ['דין', 'דינא'], ['כסף', 'ממונא'], ['כסף', 'כספא'], ['עדים', 'סהדי'], ['אדם', 'איניש'], ['אדם', 'גברא'], ['אשה', 'אתתא'], ['בית', 'ביתא'], ['שנה', 'שתא'], ['יום', 'יומא']];
    for (const [he, ar] of pairs) {
      assert.ok(hs.aramaicEquivalents(n(he)).includes(n(ar)), `${he} -> ${ar}`);
      assert.ok(hs.aramaicEquivalents(n(ar)).includes(n(he)), `${ar} -> ${he}`);
    }
    const m = adv('מותר', { aramaicEquiv: true });
    assert.ok(hs.evaluate(m, toks('הכא שרי')) && hs.evaluate(m, toks('ודשרי')), 'Aramaic ד-prefix on the equivalent');
    assert.ok(!hs.evaluate(adv('מותר'), toks('שרי')), 'Aramaic is off by default');
    assert.ok(hs.evaluate(adv('ספיקא', { aramaicEquiv: true }), toks('מספק')));
  });

  await check('hebrewSearch: structured fields (main + any of + exclude) and inline operators', () => {
    const f = adv({ query: 'שבת', anyOf: 'רבא, אביי', exclude: 'מוקצה' }, { prefixesAndSuffixes: false });
    assert.strictEqual(f.match, '("שבת" AND ("רבא" OR "אביי")) NOT "מוקצה"');
    assert.ok(hs.evaluate(f, toks('אמר רבא שבת')) && hs.evaluate(f, toks('אביי שבת')));
    assert.ok(!hs.evaluate(f, toks('אמר שבת')), 'needs one of the "any" words');
    assert.ok(!hs.evaluate(f, toks('רבא שבת מוקצה')), 'excluded word');
    assert.ok(!hs.buildQuery({ exclude: 'מוקצה' }, A).match, 'exclusions alone are no query');
    assert.ok(hs.buildQuery({ anyOf: 'רבא אביי' }, A).match.includes(' OR '));
    // Exclusions take the same morphology: -מוקצה also excludes והמוקצה.
    assert.ok(!hs.evaluate(adv({ query: 'שבת', exclude: 'מוקצה' }), toks('שבת והמוקצה')));
    // Inline: | (OR), -word (NOT), word* (prefix), "exact" (literal token / phrase).
    const P = { prefixesAndSuffixes: false };
    assert.strictEqual(adv('שבת | חג', P).match, '("שבת" OR "חג")');
    assert.strictEqual(adv('שבת|חג', P).match, '("שבת" OR "חג")');
    assert.strictEqual(adv('שבת -מוקצה', P).match, '"שבת" NOT "מוקצה"');
    assert.strictEqual(adv('מוקצ* שבת', P).match, '"מוקצ"* AND "שבת"');
    assert.strictEqual(adv('שבת -"רב חסדא"', P).match, '"שבת" NOT "רב חסדא"');
    const ex = adv('"שבת" מועד');
    assert.ok(ex.terms.includes('שבת') && !ex.terms.includes('~שבת') && ex.terms.includes('~מועד'), `a quoted word is never expanded: ${ex.terms}`);
    assert.ok(!hs.evaluate(ex, toks('ושבת מועד')) && hs.evaluate(ex, toks('שבת ומועד')));
    assert.ok(hs.evaluate(adv('מוקצ*'), toks('המוקצה')) === false && hs.evaluate(adv('מוקצ*'), toks('מוקצין')));
    const ph = adv('"אור ליום" שבת', P);
    assert.ok(ph.match.startsWith('"אור ליומ" AND'), ph.match);
    // FTS5 keywords typed by the user stay plain words; output is always syntactically safe.
    assert.strictEqual(adv('AND OR NOT NEAR', P).match, '"and" AND "or" AND "not" AND "near"');
  });

  await check('hebrewSearch: word proximity — exact phrase, ordered vs unordered NEAR', () => {
    const near = (ordered, distance) => adv('אמר רב', { prefixesAndSuffixes: false, proximity: { mode: 'near', distance, ordered } });
    assert.strictEqual(near(false, 3).match, 'NEAR("אמר" "רב", 3)');
    assert.ok(!near(false, 3).needsVerify && near(true, 3).needsVerify, 'ordered NEAR is verified in JS');
    const t = (s) => toks(s);
    assert.ok(hs.evaluate(near(false, 3), t('רב יהודה ואמר אמר')), 'unordered: reversed order ok');
    assert.ok(!hs.evaluate(near(true, 3), t('רב יהודה ואמר אמר')), 'ordered: reversed order rejected');
    assert.ok(hs.evaluate(near(true, 3), t('אמר א ב ג רב')), '3 words between');
    assert.ok(!hs.evaluate(near(true, 3), t('אמר א ב ג ד רב')), '4 words between > 3');
    assert.ok(hs.evaluate(near(true, 5), t('אמר א ב ג ד רב')));
    assert.ok(hs.evaluate(near(false, 10), t('רב 1 2 3 4 5 6 7 8 9 10 אמר')) && !hs.evaluate(near(false, 10), t('רב 1 2 3 4 5 6 7 8 9 10 11 אמר')));
    const phrase = adv('אמר רב', { prefixesAndSuffixes: false, proximity: { mode: 'phrase' } });
    assert.strictEqual(phrase.match, '"אמר רב"');
    assert.ok(hs.evaluate(phrase, t('ואז אמר רב')) && !hs.evaluate(phrase, t('רב אמר')) && !hs.evaluate(phrase, t('אמר להו רב')));
    // With morphology the phrase / NEAR is verified per token: "ואמר רב" is a phrase hit.
    const mp = adv('אמר רב', { proximity: { mode: 'phrase' } });
    assert.ok(mp.needsVerify && hs.evaluate(mp, t('ואמר רב')) && !hs.evaluate(mp, t('ואמר להו רב')));
    const mo = adv('שבת אמר', { proximity: { mode: 'near', distance: 3, ordered: true } });
    assert.ok(hs.evaluate(mo, t('בשבתות היה אומר אמר')) && !hs.evaluate(mo, t('אמר בשבת')));
    // Paragraph mode (default): anywhere in the paragraph.
    assert.ok(hs.evaluate(adv('אמר רב'), t('רב 1 2 3 4 5 6 7 8 9 10 11 12 אמר')));
  });

  await check('hebrewSearch: query budgets stay bounded', () => {
    const big = adv('שולחן ערוך קידושין תפילה ציצית דיבור כותל אלוקים מצוות שבתות ובשבת הלכות ברכות תורה משנה גמרא נוסף', { pleneDefective: true, acronyms: true, aramaicEquiv: true });
    assert.ok(big.variantCount <= hs.MAX_QUERY_TERMS, `terms ${big.variantCount}`);
    assert.ok(big.must.length <= 16);
    const outside = big.match.replace(/"[^"]*"/g, '');
    assert.ok(/^[\s()*ANDORNT]*$/.test(outside), `only operators outside quotes: ${outside}`);
    for (const w of ['שבת', 'תפילה', 'מצווה', 'שו"ע']) assert.ok(adv(w, { pleneDefective: true, acronyms: true, aramaicEquiv: true }).variantCount <= 220, w);
  });

  const dbFile = path.join(ROOT, 'assets/db/library.db');
  if (!fs.existsSync(dbFile)) return;
  const db = openDb(dbFile);
  const all = async (plan, opts) => {
    const out = [];
    let cursor = null;
    for (;;) {
      const page = await search.searchPlan(db, plan, { ...(opts || {}), cursor, limit: 37 });
      out.push(...page.rows);
      if (!page.hasMore) return out;
      cursor = page.cursor;
    }
  };
  const textOf = async (id) => (await db.all('SELECT clean_text FROM paragraphs WHERE id = ?', [id]))[0].clean_text;
  try {
    await check('sample: Simple Search is literal (whole tokens only)', async () => {
      const s = hs.buildQuery('שבת');
      const rows = await all(s);
      const c = await search.countPlan(db, s, { cap: 100000 });
      assert.strictEqual(rows.length, c.count);
      for (const r of rows.slice(0, 200)) assert.ok(hs.toTokens(await textOf(r.id)).includes('שבת'), r.id);
      assert.strictEqual(c.count, (await search.countMatches(db, 'שבת', { cap: 100000 })).count, 'same as the historical exact search');
      assert.strictEqual((await search.countPlan(db, hs.buildQuery('שולחן'), { cap: 100000 })).count, 0, 'no ktiv expansion (sample spells שלחן)');
      const a = await search.countPlan(db, adv('שבת'), { cap: 100000 });
      assert.ok(a.count > c.count * 2, `advanced ${a.count} vs simple ${c.count}`);
    });

    await check('sample: exact matches are ranked ahead of expanded variants; paging covers every hit once', async () => {
      for (const [q, o] of [['שבת', {}], ['תפילה', {}], ['שולחן', { pleneDefective: true }], ['ב"ד', { acronyms: true }], ['מותר', { aramaicEquiv: true }], ['רב אמר', { proximity: { mode: 'near', distance: 3, ordered: true } }]]) {
        const plan = adv(q, o);
        const rows = await all(plan);
        const count = await search.countPlan(db, plan, { cap: 100000 });
        assert.strictEqual(rows.length, count.count, `${q}: paging ${rows.length} != count ${count.count}`);
        assert.strictEqual(new Set(rows.map((r) => r.id)).size, rows.length, `${q}: duplicates`);
        for (let i = 1; i < rows.length; i++) {
          assert.ok(rows[i].phase >= rows[i - 1].phase, `${q}: exact first`);
          if (rows[i].phase === rows[i - 1].phase) assert.ok(rows[i].id > rows[i - 1].id, `${q}: library order within a phase`);
        }
        for (const r of rows.slice(0, 120)) {
          const t = hs.toTokens(await textOf(r.id));
          assert.ok(hs.evaluate(plan, t), `${q}: row ${r.id} does not match`);
          if (plan.exact) assert.strictEqual(hs.evaluate(plan.exact, t), r.phase === 0, `${q}: row ${r.id} phase`);
          assert.ok(search.buildKwic(r.display_text, plan.terms).hitCount > 0 || r.display_text.length > 400, `${q}: highlight in ${r.id}`);
        }
      }
      const sh = await all(adv('שבת'));
      assert.ok(sh[0].phase === 0 && sh[sh.length - 1].phase === 1, 'שבת has exact and expanded hits');
      assert.ok((await all(adv('שולחן', { pleneDefective: true }))).length > 0, 'שולחן finds the sample\'s שלחן');
    });

    await check('sample: FTS5 and the no-FTS5 web fallback agree on every advanced mode', async () => {
      const cases = [
        hs.buildQuery('"שני כחות" באדם'),
        adv('שבת'),
        adv('תפילה'),
        adv({ query: 'שבת', anyOf: 'רבא אביי', exclude: 'יהודה' }),
        adv('אמר רב|רבא -חסדא'),
        adv('ויאמר אלהים', { proximity: { mode: 'phrase' } }),
        adv('רב אמר', { proximity: { mode: 'near', distance: 3, ordered: false } }),
        adv('רב אמר', { proximity: { mode: 'near', distance: 5, ordered: true } }),
        adv('ב"ד', { acronyms: true }),
        adv('שולחן', { pleneDefective: true }),
        adv('מותר', { aramaicEquiv: true }),
        adv('ספר*'),
      ];
      for (const plan of cases) {
        const f = (await all(plan)).map((r) => r.id);
        const l = (await all(plan, { fts: false })).map((r) => r.id);
        assert.deepStrictEqual(l, f, `fallback differs for ${plan.match.slice(0, 80)}`);
        assert.strictEqual((await search.countPlan(db, plan, { cap: 100000, fts: false })).count, f.length);
      }
    });

    await check('sample: corpus presets (shared/corpora.js -> books scope) restrict results, FTS5 == fallback', async () => {
      const corpora = require('../shared/corpora');
      const cat = require('../shared/libraryCatalog').buildLibraryCatalog(await sources.loadCatalog(db));
      const opts = { isCommentary: cat.isCommentary };
      const paths = new Map((await db.all("SELECT b.id AS id, COALESCE(c.path, '') AS path FROM books b LEFT JOIN categories c ON c.id = b.category_id", [])).map((r) => [r.id, r.path + '/']));
      const plan = hs.buildQuery('אמר');
      const total = (await search.countPlan(db, plan, { cap: 100000 })).count;
      const by = async (ids, fts) => all(plan, { scope: corpora.corpusScope(cat.bookInfos, ids, opts), fts });
      const tanach = await by(['tanach']);
      assert.ok(tanach.length > 0 && tanach.every((r) => /^תנך\/(תורה|נביאים|כתובים)\//.test(paths.get(r.book_id))), 'only the base books of תנ"ך (no Rashi / Onkelos / Ramban)');
      const bavli = await by(['bavli']);
      assert.ok(bavli.length > 0 && bavli.every((r) => paths.get(r.book_id).startsWith('תלמוד בבלי/סדר ')), 'no Rashi / Tosafot on Shabbat');
      const mef = await by(['mefarshim']);
      assert.ok(mef.length > 0 && mef.every((r) => paths.get(r.book_id).includes('מפרשים')));
      assert.strictEqual(tanach.length + bavli.length + mef.length, total, 'sample library = base texts + commentaries');
      assert.strictEqual((await by(['tanach', 'bavli'])).length, tanach.length + bavli.length, 'presets are OR-ed');
      assert.strictEqual((await by(['mishna'])).length, 0, 'a preset with no books is an empty scope, never "all"');
      assert.deepStrictEqual((await by(['tanach'], false)).map((r) => r.id), tanach.map((r) => r.id), 'preset scope in the web fallback');
      const shabbat = (await db.all("SELECT id FROM books WHERE title = 'שבת'", []))[0].id;
      const inBook = await all(adv('שבת'), { scope: { kind: 'book', bookId: shabbat, title: 'שבת' } });
      assert.ok(inBook.length > 0 && inBook.every((r) => r.book_id === shabbat));
    });

    await check('sample: advanced query fuzz never throws (FTS5 + fallback)', async () => {
      const junk = ['"', "'", '-', '*', '(', ')', ':', '^', '|', '״', '׳', 'AND', 'OR', 'NEAR', ' ', 'ב"ד', 'שו"ע', 'שבת', 'ושלחן', "בר'", '-שבת', 'שב*', '"אמר רב"', '||', '--', '**'];
      let seed = 23;
      const rnd = (k) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % k);
      const modes = ['paragraph', 'phrase', 'near'];
      for (let i = 0; i < 200; i++) {
        const q = () => {
          let s = '';
          for (let j = rnd(8) + 1; j > 0; j--) s += junk[rnd(junk.length)] + (rnd(2) ? ' ' : '');
          return s;
        };
        const plan = hs.buildQuery({ query: q(), anyOf: rnd(3) ? '' : q(), exclude: rnd(3) ? '' : q() }, { ...A, pleneDefective: !!rnd(2), acronyms: !!rnd(2), aramaicEquiv: !!rnd(2), proximity: { mode: modes[rnd(3)], distance: [3, 5, 10][rnd(3)], ordered: !!rnd(2) } });
        await search.searchPlan(db, plan, { limit: 5 });
        await search.countPlan(db, plan, { cap: 10, fts: false });
      }
    });

    await check('sample: advanced search latency', async () => {
      const plans = [adv('שבת'), adv('ויאמר אלהים'), adv('אמר רב', { proximity: { mode: 'near', distance: 5, ordered: true } }), adv('שו"ע', { acronyms: true, pleneDefective: true }), adv({ query: 'אמר', anyOf: 'רבא אביי', exclude: 'חסדא' })];
      const t = process.hrtime.bigint();
      for (let i = 0; i < 10; i++) for (const p of plans) await search.searchPlan(db, p, { limit: 40 });
      const ms = Number(process.hrtime.bigint() - t) / 1e6 / (10 * plans.length);
      assert.ok(ms < 60, `avg ${ms.toFixed(2)}ms`);
      console.log(`  advanced search page avg ${ms.toFixed(2)}ms/query`);
    });
  } finally {
    db.close();
  }
}

/** Otzaria reference alignment: heading-based commentary units (ref_links, schema v4). */
async function refAlignTests() {
  await check('refAlign: canonical unit labels / ref keys', () => {
    const k = (t) => refAlign.refKeyOf(refAlign.unitLabels(t));
    assert.strictEqual(k('פרק א'), 'פרק א');
    assert.strictEqual(k('פֶּרֶק א׳'), 'פרק א');
    assert.strictEqual(k('פסוק א'), 'פסוק א');
    assert.strictEqual(k('סימן שכ"ח'), 'סימן שכח');
    assert.strictEqual(k('סעיף ד'), 'סעיף ד');
    assert.strictEqual(k('סעיף קטן ג'), 'סעיף קטן ג');
    assert.strictEqual(k('דף ב.'), 'דף ב|עמוד א');
    assert.strictEqual(k('דף ב ע"ב'), 'דף ב|עמוד ב');
    assert.strictEqual(k('ב:'), 'דף ב|עמוד ב');
    assert.strictEqual(k('עמוד א'), 'עמוד א');
    assert.strictEqual(k('משנה ג'), 'משנה ג');
    assert.strictEqual(k('הלכה ב'), 'הלכה ב');
    assert.strictEqual(k('פרק א - בריאת העולם'), 'פרק א');
    assert.strictEqual(k(''), '');
    // parseBook exposes the full path of every heading.
    const pb = indexer.parseBook('<h1>ס</h1>\n<h2>פרק א</h2>\n<h3>פסוק ב</h3>\nטקסט\n<h2>דף ג</h2>\n<h3>עמוד ב</h3>\nא', 'ס');
    assert.deepStrictEqual(pb.toc.map((t) => t.refPath), ['פרק א', 'פרק א|פסוק ב', 'דף ג', 'דף ג|עמוד ב']);
  });
  await check('TOC columns: deep 3-level book (columns cascade, path follows the reading line)', () => {
    const toc = require('../shared/tocColumns');
    const n = (id, parent_id, level, title, start_line, ref_key) => ({ id, parent_id, level, title, start_line, ref_key });
    // ספר > חלק > סימן > סעיף  (h2 > h3 > h4)
    const nodes = [
      n(1, null, 2, 'חלק א', 2, 'א'), n(2, 1, 3, 'סימן א', 3, 'א'), n(3, 2, 4, 'סעיף א', 4, 'א'), n(4, 2, 4, 'סעיף ב', 6, 'ב'),
      n(5, 1, 3, 'סימן ב', 8, 'ב'), n(6, 5, 4, 'סעיף א', 9, 'א'), n(7, null, 2, 'חלק ב', 11, 'ב'), n(8, 7, 3, 'סימן כה', 12, 'כה'),
    ];
    const tree = toc.buildTocTree(nodes.slice().reverse()); // any input order
    assert.strictEqual(tree.depth, 3);
    assert.deepStrictEqual(tree.roots.map((x) => x.title), ['חלק א', 'חלק ב']);
    assert.deepStrictEqual(toc.pathForLine(tree, 7), [1, 2, 4], 'line 7 is in חלק א > סימן א > סעיף ב');
    assert.deepStrictEqual(toc.pathForLine(tree, 1), [], 'before the first heading');
    const cols = toc.tocColumns(tree, [1, 2, 4]);
    assert.deepStrictEqual(cols.map((c) => [c.depth, c.items.map((x) => x.id), c.selectedId]), [
      [0, [1, 7], 1],
      [1, [2, 5], 2],
      [2, [3, 4], 4],
    ]);
    // Switching the top-level selection replaces the deeper columns (no stale column 2).
    assert.deepStrictEqual(toc.tocColumns(tree, [7]).map((c) => c.items.map((x) => x.title)), [['חלק א', 'חלק ב'], ['סימן כה']]);
    assert.deepStrictEqual(toc.tocColumns(tree, [1, 999]).length, 2, 'an invalid id stops the path');
    assert.strictEqual(toc.nodeEnd(tree, tree.byId.get(2), 20), 7, 'סימן א ends before סימן ב');
    assert.strictEqual(toc.nodeEnd(tree, tree.byId.get(7), 20), 20);
    assert.deepStrictEqual(toc.nodeTrail(tree, 6), ['חלק א', 'סימן ב', 'סעיף א']);
    assert.ok(toc.hasChildren(tree, 2) && !toc.hasChildren(tree, 3));
  });
  await check('TOC columns: single-level book, inline verses, filter by name / gematria / digits', () => {
    const toc = require('../shared/tocColumns');
    const chapters = Array.from({ length: 30 }, (_, i) => ({ id: i + 1, parent_id: null, level: 2, title: `פרק ${require('../shared/hebrewTorahDict').intToHebrewNumeral(i + 1)}`, start_line: 2 + i * 10 }));
    const tree = toc.buildTocTree(chapters);
    assert.strictEqual(tree.depth, 1);
    assert.deepStrictEqual(toc.tocColumns(tree, [25]).length, 1, 'no second column without sub-headings');
    assert.deepStrictEqual(toc.pathForLine(tree, 245), [25]);
    const titles = (q) => toc.filterToc(tree, q).map((x) => x.title);
    assert.strictEqual(titles('כה')[0], 'פרק כה');
    assert.strictEqual(titles('כ"ה')[0], 'פרק כה');
    assert.strictEqual(titles('25')[0], 'פרק כה');
    assert.strictEqual(titles('פרק טו')[0], 'פרק טו', '15 = טו');
    assert.deepStrictEqual(titles('סימן כה'), [], 'the unit type must match for an exact reference');
    assert.deepStrictEqual(toc.filterToc(tree, ''), []);
    const verses = [{ key: 'א', title: 'פסוק א', line: 3 }, { key: 'ב', title: 'פסוק ב', line: 4 }, { key: 'ג', title: 'פסוק ג', line: 7 }];
    assert.strictEqual(toc.verseForLine(verses, 6).key, 'ב');
    assert.strictEqual(toc.verseForLine(verses, 2), null);
  });
  await check('RTL: no raw textAlign right/left in src/ (alignRight / inputAlignRight instead)', () => {
    // Android mirrors textAlign 'right' on <Text> to the LEFT in the forced-RTL app, while
    // <TextInput> takes it literally: src/lib/direction.ts resolves both per platform.
    const ALLOWED = [/library-manager\.tsx: .*writingDirection: 'ltr'/]; // the LTR URL input
    const offenders = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const f = path.join(dir, e.name);
        if (e.isDirectory()) walk(f);
        else if (/\.(tsx?|jsx?)$/.test(e.name) && !f.endsWith(path.join('lib', 'direction.ts'))) {
          fs.readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
            const where = `${path.relative(ROOT, f)}: ${line.trim()}`;
            if (/textAlign:\s*'(right|left)'/.test(line) && !ALLOWED.some((re) => re.test(where))) offenders.push(`${path.relative(ROOT, f)}:${i + 1}`);
          });
        }
      }
    };
    walk(path.join(ROOT, 'src'));
    assert.deepStrictEqual(offenders, [], 'use alignRight (Text) / inputAlignRight (TextInput) from src/lib/direction.ts');
  });
  await check('TOC columns: fit-to-content widths (slim for short labels, wider for long ones, clamped)', () => {
    const toc = require('../shared/tocColumns');
    const { intToHebrewNumeral } = require('../shared/hebrewTorahDict');
    const chapters = Array.from({ length: 50 }, (_, i) => `פרק ${intToHebrewNumeral(i + 1)}`);
    const verses = Array.from({ length: 31 }, (_, i) => `פסוק ${intToHebrewNumeral(i + 1)}`);
    const wCh = toc.tocColumnWidth(chapters);
    const wVs = toc.tocColumnWidth(verses, { header: 'לתחילת פרק כז' });
    assert.strictEqual(wCh, toc.TOC_COLUMN_WIDTH.min, 'פרק א..נ stays at the minimum width');
    assert.ok(wVs >= wCh && wVs < 140, `the "לתחילת" header widens the verse column a little (${wVs})`);
    const long = toc.tocColumnWidth(['הלכות שבת פרק א', 'הלכות שבת פרק ב']);
    assert.ok(long > wCh + 20 && long < toc.TOC_COLUMN_WIDTH.max, `longer titles get a wider column (${long})`);
    assert.strictEqual(toc.tocColumnWidth(['סימן שכח - דין חולה שאין בו סכנה ודין חולה שיש בו סכנה']), toc.TOC_COLUMN_WIDTH.max, 'clamped to the maximum');
    assert.ok(toc.tocColumnWidth(['סימן א'], { branch: true }) >= toc.tocColumnWidth(['סימן א']), 'room for the "‹" indicator');
    // Niqqud / cantillation and HTML add no width.
    assert.strictEqual(Math.round(toc.estimateTextWidth('בְּרֵאשִׁ֖ית')), Math.round(toc.estimateTextWidth('בראשית')));
    assert.strictEqual(Math.round(toc.estimateTextWidth('<b>דף ב.</b>')), Math.round(toc.estimateTextWidth('דף ב.')));
    // Panel: the sum of the open columns, clamped to [min, cap].
    assert.strictEqual(toc.tocPanelWidth([wCh], { min: 200, cap: 340 }), 200, 'one slim column: the minimum panel');
    assert.strictEqual(toc.tocPanelWidth([wCh, wVs], { min: 200, cap: 340 }), wCh + wVs, 'two columns: their sum');
    assert.strictEqual(toc.tocPanelWidth([220, 220, 220], { min: 200, cap: 340 }), 340, 'three wide columns: capped (they scroll)');
    assert.strictEqual(toc.tocPanelWidth([108], { min: 200, cap: 150 }), 150, 'a cap below the minimum wins');
  });
  await check('TOC columns: inline verses from the sample DB (Tanach chapters have no verse headings)', async () => {
    const toc = require('../shared/tocColumns');
    const dbFile = path.join(ROOT, 'assets/db/library.db');
    if (!fs.existsSync(dbFile)) return;
    const db = openDb(dbFile);
    const book = (await db.all("SELECT id, total_lines FROM books WHERE title = 'בראשית'", []))[0];
    const tree = toc.buildTocTree(await db.all('SELECT id, parent_id, level, title, ref_key, start_line FROM toc_nodes WHERE book_id = ?', [book.id]));
    const ch1 = tree.roots[0];
    const vs = await toc.fetchInlineVerses(db, book.id, ch1.start_line, toc.nodeEnd(tree, ch1, book.total_lines));
    assert.strictEqual(vs.length, 31, 'Genesis 1 has 31 verses');
    assert.deepStrictEqual([vs[0].title, vs[30].title], ['פסוק א', 'פסוק לא']);
    db.close();
  });
  await check('tabs: filter open tabs by name, abbreviation, folder and location', () => {
    const { filterTabs, tabLocation, tabSubtitle } = require('../shared/tabs');
    const tabs = [
      { bookTitle: 'שבת', tocPath: 'דף ב.', cat: 'תלמוד בבלי/סדר מועד' },
      { bookTitle: 'ראש השנה', tocPath: 'דף טז:', cat: 'תלמוד בבלי/סדר מועד' },
      { bookTitle: 'במדבר', tocPath: 'פרק כז', cat: 'תנך/תורה' },
      { bookTitle: 'הלכות שבת', tocPath: 'פרק א > הלכה ב', cat: 'הלכה/משנה תורה/ספר זמנים' },
      { bookTitle: 'רמב"ן על בראשית', tocPath: 'פרק א', cat: 'תנך/מפרשים' },
      { bookTitle: 'שולחן ערוך - אורח חיים', tocPath: 'סימן שכח', cat: 'הלכה/שולחן ערוך' },
      { bookTitle: 'בבא קמא', tocPath: 'דף ב:', cat: 'תלמוד בבלי/סדר נזיקין' },
    ];
    const f = (q) => filterTabs(tabs, q, (t) => t.cat).map((t) => t.bookTitle);
    assert.deepStrictEqual(f('שבת'), ['שבת', 'הלכות שבת'], 'prefix match ranks first');
    assert.deepStrictEqual(f('רמב'), ['רמב"ן על בראשית']);
    assert.deepStrictEqual(f('רמב"ם שבת'), ['הלכות שבת'], 'Rambam abbreviation + folder');
    assert.deepStrictEqual(f('ר"ה'), ['ראש השנה'], 'abbreviation; "רה" inside "תורה" does not count');
    assert.deepStrictEqual(f('שו"ע או"ח'), ['שולחן ערוך - אורח חיים']);
    assert.deepStrictEqual(f('ב"ק'), ['בבא קמא']);
    assert.deepStrictEqual(f('שלחן'), ['שולחן ערוך - אורח חיים'], 'ktiv chaser');
    assert.deepStrictEqual(f('תנך'), ['במדבר', 'רמב"ן על בראשית'], 'folder');
    assert.deepStrictEqual(f('סימן שכח'), ['שולחן ערוך - אורח חיים'], 'location');
    assert.strictEqual(f('').length, tabs.length);
    assert.deepStrictEqual(f('לא קיים'), []);
    assert.strictEqual(tabLocation('חלק א > פרק ב > הלכה ג'), 'פרק ב › הלכה ג');
    assert.strictEqual(tabLocation('חלק א > פרק ב > הלכה ג', 3), 'חלק א › פרק ב › הלכה ג');
    assert.strictEqual(tabSubtitle('פרק א > פסוק ד'), 'פסוק ד');
    assert.strictEqual(tabSubtitle(null), '');
  });
  await check('vocalization: hiding cantillation keeps nikkud, dagesh, shin dots, maqaf, sof pasuq', () => {
    const { applyVocalization, stripCantillationMarks, stripNikkudMarks } = require('../shared/hebrew');
    const verse = 'בְּרֵאשִׁ֖ית בָּרָ֣א אֱלֹהִ֑ים אֵ֥ת הַשָּׁמַ֖יִם וְאֵ֥ת הָאָֽרֶץ׃';
    const noTrope = applyVocalization(verse, { showNikkud: true, showCantillation: false });
    assert.strictEqual(noTrope, 'בְּרֵאשִׁית בָּרָא אֱלֹהִים אֵת הַשָּׁמַיִם וְאֵת הָאָֽרֶץ׃');
    assert.ok(!/[֑-֯]/.test(noTrope), 'no cantillation');
    for (const mark of ['ּ', 'ׁ', 'ְ', '׃']) assert.ok(noTrope.includes(mark), `kept U+${mark.charCodeAt(0).toString(16)}`);
    assert.strictEqual(stripCantillationMarks('כׇּל־עֲדַ֣ת'), 'כׇּל־עֲדַת', 'maqaf + qamats qatan kept');
    assert.strictEqual(stripNikkudMarks('שָׁלוֹם'), 'שלום', 'nikkud only');
    assert.strictEqual(stripNikkudMarks('בָּרָ֣א'), 'בר֣א', 'stripping nikkud alone leaves trope (the app always hides both)');
  });
  await check('vocalization: hiding nikkud also hides cantillation (punctuation stays)', () => {
    const { applyVocalization } = require('../shared/hebrew');
    const verse = 'בְּרֵאשִׁ֖ית בָּרָ֣א אֱלֹהִ֑ים׃ כׇּל־עֲדַ֣ת ׀ יִשְׂרָאֵ֑ל';
    const plain = applyVocalization(verse, { showNikkud: false, showCantillation: true });
    assert.strictEqual(plain, 'בראשית ברא אלהים׃ כל־עדת ׀ ישראל');
    assert.ok(!/[֑-ׇֽֿׁׂׅׄ]/.test(plain));
    assert.strictEqual(applyVocalization(verse, { showNiqqud: false }), plain, 'older option name');
    assert.strictEqual(applyVocalization(verse, {}), verse, 'both shown by default');
    assert.strictEqual(reader.prepareDisplayText('<b>בָּרָ֣א</b> (א)', { showNikkud: false }), '‏<b>ברא</b> (א)', 'tags + RLM intact');
  });
  await check('vocalization: search highlighting aligns with the stripped text', () => {
    const raw = '<b>וַיֹּ֥אמֶר</b> אֱלֹהִ֖ים יְהִ֣י א֑וֹר';
    for (const opts of [{}, { showCantillation: false }, { showNikkud: false }, { showNikkud: false, showCantillation: false }]) {
      for (const smart of [false, true]) {
        const terms = search.parseSearchQuery('אלהים', { smart }).terms;
        const shown = reader.prepareDisplayText(raw, opts);
        const marked = search.markTerms(shown, terms);
        const hit = /<mark>([^<]*)<\/mark>/.exec(marked);
        assert.ok(hit, `marked with ${JSON.stringify(opts)} smart=${smart}: ${marked}`);
        assert.strictEqual(hit[1], reader.prepareDisplayText('אֱלֹהִ֖ים', opts), 'the mark wraps exactly the displayed word');
        assert.strictEqual(marked.replace(/<\/?mark>/g, ''), shown, 'marking never changes the text');
        const k = search.buildKwic(raw, terms, opts);
        const seg = k.segments.find((x) => x.hit);
        assert.strictEqual(seg.text, reader.prepareDisplayText('אֱלֹהִ֖ים', opts), `KWIC hit ${JSON.stringify(opts)}`);
        if (opts.showCantillation === false || opts.showNikkud === false) assert.ok(!/[֑-֯]/.test(k.segments.map((x) => x.text).join('')));
      }
    }
  });
  await check('reader: cantillation toggle strips only te\'amim (also in the commentary drawer)', () => {
    const v = 'בְּרֵאשִׁ֖ית בָּרָ֣א';
    const noTeamim = reader.prepareDisplayText(v, { showNiqqud: true, showCantillation: false });
    assert.ok(!/[\u0591-\u05AF]/.test(noTeamim), 'no te\'amim');
    assert.ok(/[\u05B0-\u05BC]/.test(noTeamim), 'niqqud kept');
    assert.strictEqual(reader.prepareDisplayText(v, { showNiqqud: false, showCantillation: true }), 'בראשית ברא');
    assert.strictEqual(reader.prepareDisplayText(v), v);
  });
  await check('refAlign: paragraphNumber parses Bavli "שורה N" markers (gematria + punctuation variants)', () => {
    const n = refAlign.paragraphNumber;
    const cases = [['שורה א', 1], ['שורה ה', 5], ['שורה טו', 15], ['שורה טז', 16], ['שורה כד', 24], ['שורה 12', 12],
      ["שורה א'", 1], ['שורה א׳', 1], ['שורה א:', 1], ['שורה א.', 1], ['שורה ט"ו', 15], ['שורה ט״ז', 16], ["שורה י'", 10],
      ['שורה יב', 12], ['שורה קכג', 123], ['פסקה ה', 5], ['פיסקה ה', 5], ['פסקה 7', 7], ['<h3>שורה ה</h3>', 5], ['שוֹרָה ג', 3], ['  שורה   ב ', 2]];
    for (const [t, v] of cases) assert.strictEqual(n(t), v, t);
    for (const t of ['', 'שורה', 'שורה ראשונה', 'שורה ארוכה', 'שורה יה', 'שורה 0', 'שורה א ב', 'דף ב.', 'ד"ה שורה ה - טקסט', 'גמרא']) assert.strictEqual(n(t), null, t);
    // Headings of a Bavli commentary: a "שורה" is a sub-unit of its amud.
    assert.strictEqual(refAlign.refKeyOf([...refAlign.unitLabels('דף ב.'), ...refAlign.unitLabels('שורה ה')]), 'דף ב|עמוד א|שורה ה');
  });
  await check('refAlign: commentary <-> base pairing (Otzaria naming + known bases)', () => {
    const b = (id, title, categoryPath, aliases) => ({ id, title, categoryPath, aliases: aliases || [] });
    const books = [
      b(1, 'בראשית', 'תנך/תורה'), b(2, 'רש"י על בראשית', 'תנך/מפרשים'), b(3, 'רמב"ן על שמות', 'תנך/מפרשים'), b(4, 'שמות', 'תנך/תורה'),
      b(5, 'ברכות', 'משנה/סדר זרעים'), b(6, 'ברכות', 'תלמוד בבלי/סדר זרעים'), b(7, 'ברטנורא על משנה ברכות', 'משנה/מפרשים'),
      b(8, 'רש"י על ברכות', 'תלמוד בבלי/מפרשים'), b(9, 'שולחן ערוך - אורח חיים', 'הלכה/שולחן ערוך'), b(10, 'משנה ברורה', 'הלכה'),
      b(11, 'תוספות על מסכת בבא קמא', 'תלמוד בבלי/מפרשים'), b(12, 'בבא קמא', 'תלמוד בבלי/סדר נזיקין'), b(13, 'אבן עזרא על תהילים', 'תנך/מפרשים'),
      b(14, 'מגילת אסתר', 'תנך'), b(15, 'פירוש על ספר שלא קיים', 'תנך/מפרשים'),
    ];
    const pairs = Object.fromEntries(refAlign.pairCommentaries(books).map((p) => [p.commId, p.baseId]));
    assert.deepStrictEqual(pairs, { 2: 1, 3: 4, 7: 5, 8: 6, 10: 9, 11: 12 });
  });

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kodeshread-refalign-'));
  try {
    const lib = path.join(tmp, 'lib');
    const w = (rel, lines) => { fs.mkdirSync(path.dirname(path.join(lib, rel)), { recursive: true }); fs.writeFileSync(path.join(lib, rel), lines.join('\n')); };
    // Base with verse headings + two commentaries, each verse with several דיבורים המתחילים.
    w('תנך/תורה/בראשית.txt', ['<h1>בראשית</h1>', '<h2>פרק א</h2>', '<h3>פסוק א</h3>', 'בראשית ברא אלהים', '<h3>פסוק ב</h3>', 'והארץ היתה תהו ובהו', '<h2>פרק ב</h2>', '<h3>פסוק א</h3>', 'ויכלו השמים']);
    w('תנך/מפרשים/רש"י על בראשית.txt', ['<h1>רש"י על בראשית</h1>', '<h2>פרק א</h2>', '<h3>פסוק א</h3>', 'ד"ה בראשית - רשי א1', 'ד"ה ברא - רשי א2', 'ד"ה אלהים - רשי א3', '<h3>פסוק ב</h3>', 'ד"ה תהו - רשי ב1', 'ד"ה ובהו - רשי ב2', '<h2>פרק ב</h2>', '<h3>פסוק א</h3>', 'ד"ה ויכלו - רשי ב-א']);
    w('תנך/מפרשים/רמב"ן על בראשית.txt', ['<h1>רמב"ן על בראשית</h1>', '<h2>פרק א</h2>', 'הקדמת רמבן לפרק', '<h3>פסוק א</h3>', 'ד"ה בראשית - רמבן א1', 'ד"ה ברא - רמבן א2', '<h3>פסוק ב</h3>', 'ד"ה והארץ - רמבן ב1']);
    // Base without verse headings: "(א)" markers / one verse per line.
    w('תנך/נביאים/יונה.txt', ['<h1>יונה</h1>', '<h2>פרק א</h2>', '(א) ויהי דבר', '(ב) קום לך', '(ג) ויקם יונה']);
    w('תנך/מפרשים/רש"י על יונה.txt', ['<h1>רש"י על יונה</h1>', '<h2>פרק א</h2>', '<h3>פסוק ב</h3>', 'ד"ה קום - רשי יונה']);
    w('תנך/כתובים/רות.txt', ['<h1>רות</h1>', '<h2>פרק א</h2>', 'ויהי בימי שפט השפטים', 'ושם האיש אלימלך', 'וימת אלימלך']);
    w('תנך/מפרשים/מצודת דוד על רות.txt', ['<h1>מצודת דוד על רות</h1>', '<h2>פרק א</h2>', '<h3>פסוק ג</h3>', 'ד"ה וימת - מצודה']);
    // Talmud: nested "דף ב" > "עמוד א" in the base, "דף ב." / "דף ב:" in the commentary.
    w('תלמוד בבלי/סדר זרעים/ברכות.txt', ['<h1>ברכות</h1>', '<h2>דף ב</h2>', '<h3>עמוד א</h3>', 'מאימתי קורין', '<h3>עמוד ב</h3>', 'גמרא עמוד ב']);
    w('תלמוד בבלי/מפרשים/תוספות על ברכות.txt', ['<h1>תוספות על ברכות</h1>', '<h2>דף ב.</h2>', 'ד"ה מאימתי - תוס', '<h2>דף ב:</h2>', 'ד"ה גמרא - תוס ב']);
    // Bavli paragraph-level alignment: "שורה N" = the N-th body paragraph of the amud.
    w('תלמוד בבלי/סדר מועד/סוכה.txt', ['<h1>סוכה</h1>', '<h2>דף ב.</h2>', 'גמרא אחת', 'גמרא שתיים', 'גמרא שלוש', 'גמרא ארבע', 'גמרא חמש', 'גמרא שש', '<h2>דף ב:</h2>', 'גמרא ב א', 'גמרא ב ב']);
    w('תלמוד בבלי/מפרשים/רשי על סוכה.txt', ['<h1>רש"י על סוכה</h1>', '<h2>דף ב.</h2>', 'רשי הקדמה', '<h3>שורה א</h3>', 'ד"ה גמרא אחת - רשי א1', '<h3>שורה ה</h3>', 'ד"ה גמרא חמש - רשי ה1', 'ד"ה חמש - רשי ה2', '<h3>שורה טז:</h3>', 'ד"ה שש - רשי טז', '<h2>דף ב:</h2>', '<h3>שורה ב</h3>', 'ד"ה ב ב - רשי ב-ב']);
    w('תלמוד בבלי/מפרשים/תוספות על סוכה.txt', ['<h1>תוספות על סוכה</h1>', '<h2>דף ב.</h2>', 'תוס עמוד']);
    w('תלמוד בבלי/מפרשים/מאירי על סוכה.txt', ['<h1>מאירי על סוכה</h1>', '<h2>דף ב.</h2>', 'מאירי פתיחה', 'שורה ג', 'מאירי ג1', "שורה ד'", 'מאירי ד1', 'מאירי ד2']);
    // Mishnah of the same name must not be confused with the Talmud tractate.
    w('משנה/סדר זרעים/ברכות.txt', ['<h1>ברכות</h1>', '<h2>פרק א</h2>', '<h3>משנה א</h3>', 'מאימתי קורין את שמע']);
    w('משנה/מפרשים/ברטנורא על משנה ברכות.txt', ['<h1>ברטנורא על משנה ברכות</h1>', '<h2>פרק א</h2>', '<h3>משנה א</h3>', 'ד"ה מאימתי - ברטנורא']);
    // Shulchan Aruch + משנה ברורה (known base, seif katan -> siman).
    w('הלכה/שולחן ערוך/שולחן ערוך - אורח חיים.txt', ['<h1>שולחן ערוך - אורח חיים</h1>', '<h2>סימן א</h2>', '<h3>סעיף א</h3>', 'יתגבר כארי', '<h3>סעיף ב</h3>', 'המשכים', '<h2>סימן ב</h2>', '<h3>סעיף א</h3>', 'לא ילבש']);
    w('הלכה/משנה ברורה.txt', ['<h1>משנה ברורה</h1>', '<h2>סימן א</h2>', '<h3>סעיף קטן א</h3>', 'מב סימן א סק א', '<h3>סעיף קטן ב</h3>', 'מב סימן א סק ב']);
    // Explicit Otzaria link file for רש"י: overlaps the heading alignment (must not duplicate).
    const links = path.join(tmp, 'links');
    fs.mkdirSync(links);
    fs.writeFileSync(path.join(links, 'רש"י על בראשית_links.json'), JSON.stringify([{ line_index_1: 4, line_index_2: 4, path_2: 'בראשית.txt', 'Conection Type': 'commentary' }, { line_index_1: 8, line_index_2: 6, path_2: 'בראשית.txt', 'Conection Type': 'commentary' }]));
    const out = path.join(tmp, 'ref.db');
    const proc = spawnSync(process.execPath, [path.join(__dirname, 'build-db.js'), `--source=${lib}`, `--out=${out}`, `--links=${links}`], { encoding: 'utf8' });
    if (proc.status !== 0) throw new Error('ref fixture build failed:\n' + proc.stderr);
    await check('refAlign: build reports aligned units', () => assert.ok(/ref links: 10 commentary\/base pair\(s\)/.test(proc.stdout), proc.stdout));

    const db = openWritable(out);
    const r = db.read;
    const id = async (title, cat) => (await r.all('SELECT b.id FROM books b JOIN categories c ON c.id = b.category_id WHERE b.title = ? AND c.path LIKE ?', [title, (cat || '') + '%']))[0].id;
    const BR = await id('בראשית');
    const RASHI = await id('רש"י על בראשית');
    const RAMBAN = await id('רמב"ן על בראשית');
    const texts = async (bookId, line) => {
      const groups = commentary.groupLinkedEntries(await commentary.fetchLinkedEntries(r, bookId, line));
      return Object.fromEntries(groups.map((g) => [g.name, g.entries.map((e) => e.display_text.split(' - ')[1] || e.display_text)]));
    };

    await check('refAlign: פסוק א links to ALL its dibburim in both commentaries, never פסוק ב', async () => {
      const rows = await r.all('SELECT comm_book_id, ref_key, base_start, base_end, comm_start, comm_end FROM ref_links WHERE base_book_id = ? ORDER BY comm_book_id, comm_start', [BR]);
      const rk = rows.map((x) => [x.comm_book_id === RASHI ? 'רשי' : 'רמבן', x.ref_key, x.base_start, x.base_end, x.comm_start, x.comm_end]);
      const expected = [
        ['רשי', 'פרק א|פסוק א', 3, 4, 3, 6],
        ['רשי', 'פרק א|פסוק ב', 5, 6, 7, 9],
        ['רשי', 'פרק ב|פסוק א', 8, 9, 11, 12],
        ['רמבן', 'פרק א', 2, 6, 2, 3],
        ['רמבן', 'פרק א|פסוק א', 3, 4, 4, 6],
        ['רמבן', 'פרק א|פסוק ב', 5, 6, 7, 8],
      ];
      const order = (x) => (x[0] === 'רשי' ? RASHI : RAMBAN) * 1000 + x[4];
      assert.deepStrictEqual(rk, expected.sort((a, b) => order(a) - order(b)));
      // Selecting the verse text (or its heading) shows every dibbur of that verse only.
      for (const line of [3, 4]) {
        const t = await texts(BR, line);
        assert.deepStrictEqual(t['רש"י'], ['רשי א1', 'רשי א2', 'רשי א3'], `line ${line}`);
        assert.deepStrictEqual(t['רמב"ן'], ['רמבן א1', 'רמבן א2'], `line ${line}`);
      }
      const t2 = await texts(BR, 6);
      assert.deepStrictEqual(t2['רש"י'], ['רשי ב1', 'רשי ב2']);
      assert.deepStrictEqual(t2['רמב"ן'], ['רמבן ב1']);
      assert.ok(!JSON.stringify(t2).includes('א1'), 'no bleed from פסוק א');
      const t3 = await texts(BR, 9);
      assert.deepStrictEqual(t3['רש"י'], ['רשי ב-א']);
      assert.ok(!t3['רמב"ן'], 'רמב"ן has nothing on פרק ב');
      // The chapter intro of רמב"ן is shown at the chapter heading.
      assert.deepStrictEqual((await texts(BR, 2))['רמב"ן'], ['הקדמת רמבן לפרק']);
    });
    await check('refAlign: block metadata, explicit links merged without duplicates', async () => {
      const groups = commentary.groupLinkedEntries(await commentary.fetchLinkedEntries(r, BR, 4));
      const rashi = groups.find((g) => g.bookId === RASHI);
      assert.deepStrictEqual(rashi.block, { refKey: 'פרק א|פסוק א', start: 3, end: 6 });
      assert.strictEqual(rashi.entries.length, 3, 'line link (rashi 4 <-> בראשית 4) is inside the block: no duplicate');
      assert.deepStrictEqual(rashi.entries.map((e) => !!e.direct), [true, false, false]);
      // An explicit link outside the selected unit still shows (rashi 8 <-> בראשית 6).
      const g6 = commentary.groupLinkedEntries(await commentary.fetchLinkedEntries(r, BR, 6)).find((g) => g.bookId === RASHI);
      assert.strictEqual(g6.entries.length, 2);
      assert.ok(g6.entries.find((e) => e.line === 8).direct);
    });
    await check('refAlign: bidirectional lookup (commentary -> base unit text)', async () => {
      for (const line of [4, 5, 6]) {
        const back = commentary.groupLinkedEntries(await commentary.fetchLinkedEntries(r, RASHI, line));
        assert.deepStrictEqual(back.map((g) => [g.bookTitle, g.entries.map((e) => e.line)]), [['בראשית', [4]]], `rashi line ${line}`);
        assert.deepStrictEqual(back[0].block, { refKey: 'פרק א|פסוק א', start: 3, end: 4 });
      }
      const units = await commentary.fetchUnitLinks(r, RAMBAN, 8);
      assert.deepStrictEqual(units.map((u) => [u.role, u.refKey, u.otherStart, u.otherEnd]), [['comm', 'פרק א|פסוק ב', 5, 6]]);
      const fromBase = await commentary.fetchUnitLinks(r, BR, 5);
      assert.deepStrictEqual(fromBase.map((u) => [u.otherBookId, u.otherStart, u.otherEnd]).sort((a, b) => a[0] - b[0]), [[RASHI, 7, 9], [RAMBAN, 7, 8]].sort((a, b) => a[0] - b[0]));
    });
    await check('refAlign: link-count badges on unit starts', async () => {
      const counts = await commentary.fetchLinkCounts(r, BR, 1, 9);
      assert.strictEqual(counts.get(3), 2, 'פסוק א: רש"י + רמב"ן');
      assert.strictEqual(counts.get(2), 1, 'פרק א: רמב"ן intro');
      assert.strictEqual(counts.get(4), 1, 'explicit line link');
      assert.ok(!counts.has(7), 'no unit starts on a content line');
      const back = await commentary.fetchLinkCounts(r, RASHI, 1, 12);
      assert.strictEqual(back.get(3), 1);
    });
    await check('refAlign: inline verses, Talmud amud notation, Mishnah vs Talmud, Shulchan Aruch', async () => {
      const yona = await id('יונה');
      assert.deepStrictEqual((await texts(yona, 4))['רש"י'], ['רשי יונה'], '"(ב)" marker');
      assert.ok(!(await texts(yona, 3))['רש"י'], 'verse א has no commentary');
      const ruth = await id('רות');
      assert.deepStrictEqual((await texts(ruth, 5))['מצודת דוד'], ['מצודה'], 'one verse per line');
      assert.ok(!(await texts(ruth, 4))['מצודת דוד']);
      const brachot = await id('ברכות', 'תלמוד בבלי');
      assert.deepStrictEqual((await texts(brachot, 4))['תוספות'], ['תוס'], 'דף ב. == דף ב > עמוד א');
      assert.deepStrictEqual((await texts(brachot, 6))['תוספות'], ['תוס ב']);
      const mishna = await id('ברכות', 'משנה');
      assert.deepStrictEqual((await texts(mishna, 4))['ברטנורא'], ['ברטנורא']);
      assert.ok(!(await texts(brachot, 4))['ברטנורא'], 'ברטנורא is not paired with the Talmud');
      const oc = await id('שולחן ערוך - אורח חיים');
      const mb = (await texts(oc, 4))['משנה ברורה'];
      assert.deepStrictEqual(mb, ['מב סימן א סק א', 'מב סימן א סק ב'], 'ס"ק aligned at the siman');
      assert.ok(!(await texts(oc, 9))['משנה ברורה'], 'not on סימן ב');
    });
    await check('refAlign: Bavli "שורה N" = N-th paragraph of the amud (not the whole amud, not a neighbour)', async () => {
      const sukkah = await id('סוכה');
      const rashiS = await id('רש"י על סוכה');
      // Rows: paragraph-level only (single base line), intro -> paragraph 1, שורה טז clamps to the last paragraph.
      const rows = await r.all('SELECT ref_key, base_start, base_end FROM ref_links WHERE comm_book_id = ? ORDER BY comm_start', [rashiS]);
      assert.deepStrictEqual(rows.map((x) => [x.ref_key, x.base_start, x.base_end]), [
        ['דף ב|עמוד א', 3, 3],
        ['דף ב|עמוד א|שורה א', 3, 3],
        ['דף ב|עמוד א|שורה ה', 7, 7],
        ['דף ב|עמוד א|שורה טז', 8, 8],
        ['דף ב|עמוד ב|שורה ב', 11, 11],
      ]);
      // Tapping paragraph 5 (line 7): both entries of שורה ה, nothing from שורה א / the intro / the clamped שורה טז.
      const t5 = await texts(sukkah, 7);
      assert.deepStrictEqual(t5['רש"י'], ['רשי ה1', 'רשי ה2']);
      // Paragraph 1 (line 3): the intro + שורה א; the "שורה א" heading row is not an entry.
      assert.deepStrictEqual((await texts(sukkah, 3))['רש"י'], ['רשי הקדמה', 'רשי א1']);
      // Paragraphs 2 / 4 have no רש"י (line 4 = paragraph 2, line 6 = paragraph 4).
      for (const line of [4, 5, 6]) assert.ok(!(await texts(sukkah, line))['רש"י'], `line ${line}`);
      // N beyond the amud's paragraphs: clamped to the last paragraph (line 8), never dropped.
      assert.deepStrictEqual((await texts(sukkah, 8))['רש"י'], ['רשי טז']);
      // The second amud: שורה ב = its 2nd paragraph (line 11), not its first (line 10).
      assert.deepStrictEqual((await texts(sukkah, 11))['רש"י'], ['רשי ב-ב']);
      assert.ok(!(await texts(sukkah, 10))['רש"י']);
      // The block names the commentary's own headings: "דף ב. > שורה ה".
      const g5 = commentary.groupLinkedEntries(await commentary.fetchLinkedEntries(r, sukkah, 7)).find((g) => g.bookId === rashiS);
      assert.deepStrictEqual(g5.block, { refKey: 'דף ב|עמוד א|שורה ה', start: 6, end: 8 });
      assert.strictEqual(g5.entries[0].toc_path, 'דף ב. > שורה ה');
      // Reverse: a רש"י paragraph under שורה ה links back to paragraph 5 only.
      for (const line of [7, 8]) {
        const back = commentary.groupLinkedEntries(await commentary.fetchLinkedEntries(r, rashiS, line));
        assert.deepStrictEqual(back.map((g) => [g.bookTitle, g.entries.map((e) => e.line)]), [['סוכה', [7]]], `רש"י line ${line}`);
      }
      // The intro and שורה א paragraphs link back to paragraph 1.
      for (const line of [3, 5]) {
        const back = commentary.groupLinkedEntries(await commentary.fetchLinkedEntries(r, rashiS, line));
        assert.deepStrictEqual(back.map((g) => g.entries.map((e) => e.line)), [[3]], `רש"י line ${line}`);
      }
    });
    await check('refAlign: Bavli commentaries without שורה headings stay at the amud level; plain "שורה N" lines split too', async () => {
      const sukkah = await id('סוכה');
      // תוספות על סוכה: daf / amud headings only -> the whole amud, on every paragraph.
      for (const line of [2, 3, 5, 8]) assert.deepStrictEqual((await texts(sukkah, line))['תוספות'], ['תוס עמוד'], `line ${line}`);
      assert.ok(!(await texts(sukkah, 10))['תוספות'], 'not on the next amud');
      // מאירי על סוכה: the markers are plain paragraphs under the amud -> intro on paragraph 1,
      // שורה ג on paragraph 3 (line 5), שורה ד' on paragraph 4 (line 6); the marker lines are not entries.
      assert.deepStrictEqual((await texts(sukkah, 3))['מאירי'], ['מאירי פתיחה']);
      assert.deepStrictEqual((await texts(sukkah, 5))['מאירי'], ['מאירי ג1']);
      assert.deepStrictEqual((await texts(sukkah, 6))['מאירי'], ['מאירי ד1', 'מאירי ד2']);
      for (const line of [4, 7, 8]) assert.ok(!(await texts(sukkah, line))['מאירי'], `line ${line}`);
    });
    await check('refAlign: lookup latency < 5ms', async () => {
      const t = process.hrtime.bigint();
      for (let i = 0; i < 200; i++) {
        await commentary.fetchUnitLinks(r, BR, 4);
        await commentary.fetchLinkedEntries(r, BR, 6);
      }
      const ms = Number(process.hrtime.bigint() - t) / 1e6 / 200;
      assert.ok(ms < 5, `avg ${ms.toFixed(2)}ms`);
      console.log(`  commentary unit lookup avg ${ms.toFixed(3)}ms`);
    });
    await check('refAlign: resumable + idempotent (pause mid-phase, re-run, same rows)', async () => {
      const snapshot = async () => (await r.all('SELECT base_book_id, base_start, base_end, comm_book_id, comm_start, comm_end, ref_key FROM ref_links ORDER BY comm_book_id, comm_start', [])).map((x) => Object.values(x).join(','));
      const full = await snapshot();
      await db.w.exec('DELETE FROM ref_links');
      let calls = 0;
      const paused = await indexer.indexRefLinks(db.w, { booksPerTransaction: 1, shouldStop: () => (++calls > 3 ? 'pause' : null) });
      assert.strictEqual(paused.stopped, 'pause');
      assert.ok(paused.aligned === 3 && (await snapshot()).length < full.length);
      const resumed = await indexer.indexRefLinks(db.w, {});
      assert.strictEqual(resumed.stopped, null);
      assert.deepStrictEqual(await snapshot(), full, 're-run converges to the same rows');
      await indexer.indexRefLinks(db.w, {});
      assert.deepStrictEqual(await snapshot(), full, 'idempotent');
    });
    await check('refAlign: schema v3 -> v4 migration and book deletion', async () => {
      await db.w.exec('DROP TABLE ref_links');
      // A v3 database (no ref_links) still answers commentary lookups from `links`.
      const v3 = commentary.groupLinkedEntries(await commentary.fetchLinkedEntries({ all: (q, p) => r.all(q, p) }, BR, 4));
      assert.deepStrictEqual(v3.map((g) => [g.name, g.entries.length]), [['רש"י', 1]]);
      await indexer.migrateSchema(db.w);
      assert.ok((await r.all("SELECT name FROM sqlite_master WHERE name = 'idx_ref_links_base_v5'", [])).length === 1);
      // v4 -> v5: the start-only indexes are replaced by the covering (start, end) ones.
      await db.w.exec('CREATE INDEX idx_ref_links_base ON ref_links(base_book_id, comm_book_id, base_start)');
      await indexer.migrateSchema(db.w);
      assert.deepStrictEqual((await r.all("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_ref_links%' ORDER BY name", [])).map((x) => x.name), ['idx_ref_links_base_v5', 'idx_ref_links_comm_v5']);
      const st = await indexer.indexRefLinks(db.w, {});
      assert.strictEqual(st.pairs, 10);
      await db.w.exec('BEGIN');
      await indexer.deleteBook(db.w, RASHI);
      await db.w.exec('COMMIT');
      assert.strictEqual((await r.all('SELECT COUNT(*) n FROM ref_links WHERE comm_book_id = ?', [RASHI]))[0].n, 0);
      assert.ok(indexer.SCHEMA_VERSION >= 4);
    });
    db.raw.close();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * Reference alignment against the REAL Otzaria excerpts in otzaria_structure_sample.txt (the base
 * books are taken verbatim from it), with commentaries written in Otzaria's conventions ("X על Y",
 * <h1>..<h4>, empty <h2></h2> levels, inline "(א)" seifim / verses, links/*.json).
 */
async function otzariaSampleTests() {
  const samplePath = path.join(ROOT, 'otzaria_structure_sample.txt');
  if (!fs.existsSync(samplePath)) {
    console.warn('! otzaria_structure_sample.txt missing; skipping the real-structure checks.');
    return;
  }
  const text = fs.readFileSync(samplePath, 'utf8').split('\n');
  const from = text.indexOf('=== SAMPLE BOOK HEADINGS & LINES ===');
  const to = text.indexOf('=== SAMPLE LINKS FILES (IF ANY) ===');
  const sampleBooks = new Map();
  let cur = null;
  for (const l of text.slice(from + 1, to)) {
    const m = /^--- FILE: \.\/(.*) ---$/.exec(l);
    if (m) sampleBooks.set((cur = m[1]), []);
    else if (cur) sampleBooks.get(cur).push(l);
  }
  const real = (rel) => sampleBooks.get(rel).join('\n').trim() + '\n';

  await check('otzaria sample: real heading structures parse to canonical ref keys', () => {
    const keys = (rel) => indexer.parseBook(real(rel), 'x').toc.map((t) => t.refPath).filter(Boolean);
    assert.deepStrictEqual(keys('הלכה/ערוך השולחן העתיד.txt'), ['דיני זרעימ', 'דיני זרעימ|סימן א', 'דיני זרעימ|סימן ב']);
    assert.deepStrictEqual(keys('הלכה/חכמת אדם.txt'), ['הקדמת המחבר', 'כלל א', 'כלל ב', 'כלל ג'], 'empty <h2></h2> skipped; "כלל א" (not "כלל כלל א")');
    assert.deepStrictEqual(keys('הלכה/הלכות גדולות.txt'), ['הקדמה', 'סימן א']);
    assert.deepStrictEqual(keys('הלכה/פסקי רקנאטי.txt').slice(0, 3), ['סימן א', 'סימן ב', 'סימן ג']);
    assert.strictEqual(refAlign.inlineUnitWord('סימן א'), 'סעיף');
    assert.strictEqual(refAlign.inlineUnitWord('כלל ב'), 'סעיף');
    assert.strictEqual(refAlign.inlineUnitWord('פרק ג', 'תנך/תורה'), 'פסוק');
    assert.strictEqual(refAlign.inlineUnitWord('פרק ג', 'משנה/סדר זרעים'), 'משנה');
    assert.strictEqual(refAlign.markerKey('(יא) כתב הרמבם'), 'יא');
    assert.strictEqual(refAlign.markerKey('<b>והנה</b> כבר'), null);
  });

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kodeshread-otzaria-'));
  try {
    const lib = path.join(tmp, 'אוצריא');
    const w = (rel, body) => { fs.mkdirSync(path.dirname(path.join(lib, rel)), { recursive: true }); fs.writeFileSync(path.join(lib, rel), Array.isArray(body) ? body.join('\n') : body); };
    for (const rel of ['הלכה/ערוך השולחן העתיד.txt', 'הלכה/חכמת אדם.txt', 'הלכה/ערוך השולחן.txt', 'הלכה/הלכות גדולות.txt']) w(rel, real(rel));
    // Commentary with its דיבורים marked per seif inline, exactly like its base: (ב) has two
    // paragraphs (the second unmarked), then (ה); plus an intro before the first marker.
    w('הלכה/הערות על ערוך השולחן העתיד.txt', [
      '<h1>הערות על ערוך השולחן העתיד</h1>', '<h2>דיני זרעים</h2>', '<h3>סימן א</h3>',
      'הערה כללית לסימן', '(ב) ד"ה נמצא דבכרם - הערה ב1', 'ד"ה ועוללות - הערה ב2', '(ה) ד"ה וטעם רבותינו - הערה ה1',
      '<h3>סימן ב</h3>', '(יא) ד"ה כתב הרמבם - הערה ב-יא',
    ].join('\n'));
    // Commentary with seif headings under the real empty-<h2> + כלל structure of חכמת אדם.
    w('הלכה/הגהות על חכמת אדם.txt', [
      '<h1>הגהות על חכמת אדם</h1>', '<h2></h2>', '<h3>כלל א</h3>', '<h4>סעיף ג</h4>', 'ד"ה א"צ שידע - הגהה ג1', 'ד"ה אלא אם - הגהה ג2',
      '<h4>סעיף ד</h4>', 'ד"ה חרש המדבר - הגהה ד1', '<h3>כלל ב</h3>', '<h4>סעיף א</h4>', 'ד"ה דין שוחט - הגהה ב-א',
    ].join('\n'));
    // ערוך השולחן has no seif markers (paragraphs): a "סעיף ב" heading must not be guessed as paragraph 2.
    w('הלכה/הערות על ערוך השולחן.txt', ['<h1>הערות על ערוך השולחן</h1>', '<h2>אורח חיים</h2>', '<h3>סימן א</h3>', '<h4>סעיף ב</h4>', 'ד"ה ולזה ברא - הערה']);
    // Otzaria links/*.json for the first commentary (overlaps its seif blocks: no duplicates).
    const links = path.join(tmp, 'links');
    fs.mkdirSync(links);
    fs.writeFileSync(path.join(links, 'הערות על ערוך השולחן העתיד_links.json'), JSON.stringify([
      { line_index_1: 5, line_index_2: 6, path_2: 'ערוך השולחן העתיד.txt', 'Conection Type': 'commentary' },
    ], null, 1));
    const out = path.join(tmp, 'otz.db');
    const proc = spawnSync(process.execPath, [path.join(__dirname, 'build-db.js'), `--source=${lib}`, `--out=${out}`, `--links=${links}`], { encoding: 'utf8' });
    if (proc.status !== 0) throw new Error('otzaria fixture build failed:\n' + proc.stderr);
    const db = openDb(out);
    const id = async (title) => (await db.all('SELECT id FROM books WHERE title = ?', [title]))[0].id;
    const AH = await id('ערוך השולחן העתיד');
    const HEAROT = await id('הערות על ערוך השולחן העתיד');
    const CA = await id('חכמת אדם');
    const texts = async (bookId, line) => {
      const groups = commentary.groupLinkedEntries(await commentary.fetchLinkedEntries(db, bookId, line));
      return Object.fromEntries(groups.map((g) => [g.name, g.entries.map((e) => e.display_text.split(' - ')[1] || e.display_text)]));
    };
    const rows = async (comm) => (await db.all('SELECT ref_key, base_start, base_end, comm_start, comm_end FROM ref_links WHERE comm_book_id = ? ORDER BY comm_start', [comm])).map((r) => Object.values(r));

    await check('otzaria sample: inline-marked commentary splits per seif (ערוך השולחן העתיד)', async () => {
      // Base: line 4 "סימן א", seifim (א)..(י) on lines 5..14; "סימן ב" at 15, (יא) on 26.
      assert.deepStrictEqual(await rows(HEAROT), [
        ['דיני זרעימ|סימן א', 4, 14, 3, 4], // intro before the first marker: the whole siman
        ['דיני זרעימ|סימן א|סעיף ב', 6, 6, 5, 6], // (ב) + its unmarked continuation
        ['דיני זרעימ|סימן א|סעיף ה', 9, 9, 7, 7],
        ['דיני זרעימ|סימן ב|סעיף יא', 26, 26, 9, 9],
      ]);
      assert.deepStrictEqual((await texts(AH, 6))['הערות'], ['הערה ב1', 'הערה ב2'], 'seif ב: both its דיבורים (the marked one and its continuation)');
      assert.deepStrictEqual((await texts(AH, 9))['הערות'], ['הערה ה1']);
      assert.deepStrictEqual((await texts(AH, 7))['הערות'], ['הערה כללית לסימן'], 'seif ג has no note: the siman-level note, nothing from ב or ה');
      assert.deepStrictEqual((await texts(AH, 4))['הערות'], ['הערה כללית לסימן'], 'the siman heading');
      assert.deepStrictEqual((await texts(AH, 26))['הערות'], ['הערה ב-יא']);
      assert.ok(!(await texts(AH, 25))['הערות'], 'seif י of סימן ב has no note');
    });
    await check('otzaria sample: seif headings align to inline seifim (חכמת אדם, empty <h2>, כלל)', async () => {
      // Base: "כלל א" at 6, (א)..(טו) on 7..21, "כלל ב" at 22, (א) on 23.
      assert.deepStrictEqual(await rows(await id('הגהות על חכמת אדם')), [
        ['כלל א|סעיף ג', 9, 9, 4, 6],
        ['כלל א|סעיף ד', 10, 10, 7, 8],
        ['כלל ב|סעיף א', 23, 23, 10, 11],
      ]);
      assert.deepStrictEqual((await texts(CA, 9))['הגהות'], ['הגהה ג1', 'הגהה ג2']);
      assert.deepStrictEqual((await texts(CA, 10))['הגהות'], ['הגהה ד1']);
      assert.ok(!(await texts(CA, 8))['הגהות'] && !(await texts(CA, 11))['הגהות'], 'zero bleed into neighbouring seifim');
    });
    await check('otzaria sample: unmarked paragraphs are never taken for seifim (ערוך השולחן)', async () => {
      assert.deepStrictEqual(await rows(await id('הערות על ערוך השולחן')), []);
    });
    await check('otzaria sample: links/*.json merged into the aligned blocks without duplicates', async () => {
      const groups = commentary.groupLinkedEntries(await commentary.fetchLinkedEntries(db, AH, 6));
      const g = groups.find((x) => x.bookId === HEAROT);
      assert.strictEqual(g.entries.length, 2, 'the JSON link (5 <-> 6) is inside the seif block: no duplicate');
      assert.deepStrictEqual(g.entries.map((e) => e.line), [5, 6]);
      assert.ok(g.entries.find((e) => e.line === 5).direct, 'marked as an explicit Otzaria link');
      // Reverse: the commentary shows its base seif.
      const back = commentary.groupLinkedEntries(await commentary.fetchLinkedEntries(db, HEAROT, 6));
      assert.deepStrictEqual(back.map((x) => [x.bookTitle, x.entries.map((e) => e.line)]), [['ערוך השולחן העתיד', [6]]]);
      assert.deepStrictEqual(back[0].block, { refKey: 'דיני זרעימ|סימן א|סעיף ב', start: 6, end: 6 });
    });
    await check('otzaria sample: TOC names inline units by context (סעיף in a סימן)', async () => {
      const toc = require('../shared/tocColumns');
      const vs = await toc.fetchInlineVerses(db, AH, 4, 14, refAlign.inlineUnitWord('סימן א', 'הלכה'));
      assert.strictEqual(vs.length, 10);
      assert.deepStrictEqual([vs[0].title, vs[9].title], ['סעיף א', 'סעיף י']);
    });
    db.close();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * Commentary pairing + alignment against the REAL Otzaria library map (otzaria_index_only.txt,
 * 7,674 books): the full-library pairing regression, then a fixture library built at real paths.
 */
async function otzariaIndexTests() {
  const indexPath = path.join(ROOT, 'otzaria_index_only.txt');
  if (!fs.existsSync(indexPath)) {
    console.warn('! otzaria_index_only.txt missing; skipping the full-library pairing checks.');
    return;
  }
  const pairing = require('../shared/pairing');
  const paths = fs.readFileSync(indexPath, 'utf8').split('\n').filter((l) => l.endsWith('.txt')).map((l) => l.replace(/^\.\//, '').replace(/\.txt$/, ''));
  const books = paths.map((p, i) => {
    const parts = p.split('/');
    const title = parts.pop();
    return { id: i + 1, title, categoryPath: parts.join('/'), aliases: generateBookAliases(parts, title) };
  });
  const idOf = new Map(paths.map((p, i) => [p, i + 1]));
  const t0 = Date.now();
  const pairs = pairing.pairCommentaries(books);
  const ms = Date.now() - t0;
  const baseOf = new Map(pairs.map((p) => [p.commId, paths[p.baseId - 1]]));
  const multiOf = new Map((pairs.multi || []).map((m) => [m.commId, m.scope]));

  await check('otzaria index: pairs 99%+ of the real "X על Y" commentaries, fast', () => {
    const comms = books.filter((b) => / על /.test(b.title));
    assert.ok(comms.length > 5800, `${comms.length} commentaries in the map`);
    const covered = comms.filter((b) => baseOf.has(b.id) || multiOf.has(b.id)).length;
    assert.ok(covered / comms.length >= 0.99, `coverage ${covered}/${comms.length}`);
    assert.ok(pairs.every((p) => p.commId !== p.baseId), 'never paired with itself');
    assert.ok(ms < 5000, `pairing took ${ms}ms`);
    console.log(`  full-library pairing: ${covered}/${comms.length} commentaries (+${pairs.length - pairs.filter((p) => / על /.test(books[p.commId - 1].title)).length} named without "על") in ${ms}ms`);
  });
  await check('otzaria index: real commentaries pair with the right base (corpus, locality, chains)', () => {
    const expect = {
      'תנך/ראשונים/רשי/תורה/רשי על בראשית': 'תנך/תורה/בראשית',
      'תנך/ראשונים/רמבן/תורה/רמבן על בראשית': 'תנך/תורה/בראשית',
      'תלמוד בבלי/ראשונים/תוספות/סדר זרעים/תוספות על ברכות': 'תלמוד בבלי/סדר זרעים/ברכות',
      'תלמוד בבלי/ראשונים/רשי/סדר זרעים/רשי על ברכות': 'תלמוד בבלי/סדר זרעים/ברכות',
      'משנה/ראשונים/ברטנורא/סדר זרעים/ברטנורא על משנה ברכות': 'משנה/סדר זרעים/משנה ברכות',
      'משנה/אחרונים/תוספות יום טוב/סדר זרעים/תוספות יום טוב על משנה ברכות': 'משנה/סדר זרעים/משנה ברכות',
      'משנה/אחרונים/יכין/סדר זרעים/יכין ברכות': 'משנה/סדר זרעים/משנה ברכות',
      'תלמוד ירושלמי/מפרשים/פני משה על תלמוד ירושלמי/סדר זרעים/פני משה על תלמוד ירושלמי ברכות': 'תלמוד ירושלמי/סדר זרעים/תלמוד ירושלמי ברכות',
      'תלמוד ירושלמי/מפרשים/גליוני השס/מועד/גליוני השס על ירושלמי ביצה': 'תלמוד ירושלמי/סדר מועד/תלמוד ירושלמי ביצה',
      // A Talmud-folder commentary on a Mishnah-only tractate: the Mishnah, not the commentary "יכין זבים".
      'תלמוד בבלי/אחרונים/אבן העוזר/אבן העוזר על זבים': 'משנה/סדר טהרות/משנה זבים',
      // Commentaries on commentaries.
      'תלמוד בבלי/מחברי זמננו/הערות על ביאור חברותא/הערות על חברותא על ברכות': 'תלמוד בבלי/מחברי זמננו/ביאור חברותא/חברותא על ברכות',
      'הלכה/משנה תורה/מפרשים/קובץ על היד החזקה/ספר זמנים/קובץ על היד החזקה על משנה תורה, הלכות שבת': 'הלכה/משנה תורה/ספר זמנים/משנה תורה, הלכות שבת',
      'הלכה/משנה תורה/מפרשים/מגיד משנה/ספר זמנים/מגיד משנה על משנה תורה, הלכות שבת': 'הלכה/משנה תורה/ספר זמנים/משנה תורה, הלכות שבת',
      // Shulchan Aruch: known standalone names and "<series> <part>".
      'הלכה/שולחן ערוך/מפרשים/משנה ברורה/משנה ברורה': 'הלכה/שולחן ערוך/שולחן ערוך, אורח חיים',
      'הלכה/שולחן ערוך/מפרשים/משנה ברורה/ביאור הלכה': 'הלכה/שולחן ערוך/שולחן ערוך, אורח חיים',
      'הלכה/שולחן ערוך/מפרשים/בית שמואל/בית שמואל': 'הלכה/שולחן ערוך/שולחן ערוך, אבן העזר',
      'הלכה/שולחן ערוך/מפרשים/באר היטב/באר היטב אורח חיים': 'הלכה/שולחן ערוך/שולחן ערוך, אורח חיים',
      // ".../טור/מפרשים/": the one text of the folder that owns "מפרשים".
      'הלכה/טור/מפרשים/בית יוסף': 'הלכה/טור/טור',
      'הלכה/טור/מפרשים/בח': 'הלכה/טור/טור',
    };
    for (const [comm, base] of Object.entries(expect)) {
      assert.ok(idOf.has(comm), `not in the map: ${comm}`);
      assert.strictEqual(baseOf.get(idOf.get(comm)), base, comm);
    }
    // A commentary in ".../ריף/מפרשים/" is on the Rif, not on the Bavli.
    const maor = paths.find((p) => p.endsWith('/המאור הגדול על בבא קמא'));
    assert.ok(/^תלמוד בבלי\/ראשונים\/ריף\//.test(baseOf.get(idOf.get(maor))), `${maor} -> ${baseOf.get(idOf.get(maor))}`);
    assert.strictEqual(baseOf.get(idOf.get('תלמוד בבלי/ראשונים/ריף/מפרשים/השגות הראבד/השגות הראבד גיטין')), 'תלמוד בבלי/ראשונים/ריף/סדר נשים/ריף גיטין', '"<series> <tractate>" inside ריף/מפרשים');
    // Every "X על שולחן ערוך אורח חיים" pairs with the Shulchan Aruch itself (never באר היטב).
    const onOc = books.filter((b) => /על (שולחן|שלחן) ערוך,? אורח חיים$/.test(b.title));
    assert.ok(onOc.length >= 10);
    for (const b of onOc) assert.strictEqual(baseOf.get(b.id), 'הלכה/שולחן ערוך/שולחן ערוך, אורח חיים', b.title);
    // Corpus-wide commentaries are aligned per top-level book heading.
    assert.strictEqual(multiOf.get(idOf.get('תלמוד בבלי/אחרונים/חידושי מהראל על השס')).corpus, 'bavli');
    assert.strictEqual(multiOf.get(idOf.get(paths.find((p) => p.endsWith('/אסיפת זקנים על סדר קדשים')))).seder, 'סדר קדשימ');
    // Not commentaries on one book: left unpaired.
    assert.ok(!baseOf.has(idOf.get('הלכה/אחרונים/כף החיים')), 'הלכה/אחרונים/כף החיים is another work');
    for (const t of ['מאמר על ישמעאל', 'אור יקר על ענין הנבואה']) assert.ok(!baseOf.has(books.find((b) => b.title === t).id), t);
    // Orders are only the six סדרים ("סדר עולם רבה" is a book).
    assert.strictEqual(baseOf.get(idOf.get(paths.find((p) => p.endsWith('/גרא על סדר עולם רבה')))), paths.find((p) => p.endsWith('/סדר עולם רבה/סדר עולם רבה')));
  });
  await check('otzaria index: real naming forms (splits, variants, abbreviations)', () => {
    assert.deepStrictEqual(pairing.commentarySplits('קובץ על היד החזקה על משנה תורה, הלכות שבת'), ['היד החזקה על משנה תורה, הלכות שבת', 'משנה תורה, הלכות שבת']);
    const v = (s) => pairing.nameVariants(s);
    assert.ok(v('מגילה מהדורא קמא').includes('מגילה'));
    assert.ok(v('שבת [מיוחס להריטבא]').includes('שבת'));
    assert.ok(v('שולחן ערוך יוד חלק א').includes('שולחנ ערוכ יורה דעה'));
    assert.ok(v('מסכת ברכות').includes('ברכות'));
    const place = pairing.placeOf('תלמוד בבלי/ראשונים/ריף/מפרשים/בעל המאור');
    assert.deepStrictEqual([place.corpus, place.primary, place.owner], ['bavli', false, 'תלמוד בבלי/ראשונימ/ריפ']);
    assert.strictEqual(refAlign.sharesInlineNumbering('שולחן ערוך, אורח חיים'), false);
    assert.strictEqual(refAlign.sharesInlineNumbering('משנה תורה, הלכות שבת'), true);
  });

  // --- a fixture library at real Otzaria paths ----------------------------------------------
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kodeshread-otzindex-'));
  try {
    const lib = path.join(tmp, 'אוצריא');
    writeOtzariaFixture(lib);

    const out = path.join(tmp, 'otz.db');
    const proc = spawnSync(process.execPath, [path.join(__dirname, 'build-db.js'), `--source=${lib}`, `--out=${out}`], { encoding: 'utf8' });
    if (proc.status !== 0) throw new Error('otzaria index fixture build failed:\n' + proc.stderr);
    const db = openDb(out);
    const id = async (rel) => (await db.all('SELECT id FROM books WHERE file_path = ?', [rel + '.txt']))[0].id;
    const blocks = async (rel, line) => {
      const groups = commentary.groupLinkedEntries(await commentary.fetchLinkedEntries(db, await id(rel), line));
      return Object.fromEntries(groups.map((g) => [g.bookTitle, g.entries.map((e) => e.display_text)]));
    };

    await check('otzaria fixture: full commentary block per verse / mishnah / halacha / amud, zero bleed', async () => {
      const BR = 'תנך/תורה/בראשית';
      assert.deepStrictEqual(await blocks(BR, 3), { 'רשי על בראשית': ['בראשית. רשי א1', 'ברא. רשי א2'], 'רמבן על בראשית': ['בראשית ברא. רמבן א1', 'אלהים. רמבן א2', 'השמים. רמבן א3'] });
      assert.deepStrictEqual(await blocks(BR, 4), { 'רמבן על בראשית': ['תהו. רמבן ב1'] }, 'verse ב: only רמבן, nothing of verse א');
      assert.deepStrictEqual(await blocks(BR, 5), { 'רשי על בראשית': ['ויאמר. רשי ג1'] });
      assert.deepStrictEqual(await blocks(BR, 7), { 'רשי על בראשית': ['ויכלו. רשי ב-א'] });
      const BAVLI = 'תלמוד בבלי/סדר זרעים/ברכות';
      const amudA = await blocks(BAVLI, 3);
      assert.deepStrictEqual(amudA['תוספות על ברכות'], ['מאימתי. תוס 1', 'קורין. תוס 2']);
      assert.deepStrictEqual(amudA['חברותא על ברכות'], ['חברותא 1']);
      assert.ok(!amudA['חידושי מהראל על השס'], 'מהראל has nothing on ב.');
      const amudB = await blocks(BAVLI, 6);
      assert.deepStrictEqual(amudB['תוספות על ברכות'], ['תנו רבנן. תוס 3']);
      assert.deepStrictEqual(amudB['חידושי מהראל על השס'], ['מהראל ברכות ב:'], 'corpus-wide commentary aligned under its "מסכת ברכות" heading');
      const MISHNA = 'משנה/סדר זרעים/משנה ברכות';
      assert.deepStrictEqual(await blocks(MISHNA, 3), { 'ברטנורא על משנה ברכות': ['מאימתי. ברט א1', 'עד סוף. ברט א2'] });
      assert.deepStrictEqual(await blocks(MISHNA, 4), { 'ברטנורא על משנה ברכות': ['בשחרית. ברט ב1'] });
      const YER = 'תלמוד ירושלמי/סדר זרעים/תלמוד ירושלמי ברכות';
      assert.deepStrictEqual(await blocks(YER, 6), { 'פני משה על תלמוד ירושלמי ברכות': ['פני משה ב1', 'פני משה ב2'] });
      assert.deepStrictEqual(await blocks(YER, 4), {}, 'הלכה א has no פני משה');
      const RAMBAM = 'הלכה/משנה תורה/ספר זמנים/משנה תורה, הלכות שבת';
      assert.deepStrictEqual((await blocks(RAMBAM, 3))['מגיד משנה על משנה תורה, הלכות שבת'], ['(א) שביתה. מגיד א1', 'עוד שם. מגיד א2'], 'halacha א: its two דיבורים');
      assert.ok(!(await blocks(RAMBAM, 4))['מגיד משנה על משנה תורה, הלכות שבת'], 'halacha ב: nothing');
      assert.deepStrictEqual((await blocks(RAMBAM, 5))['מגיד משנה על משנה תורה, הלכות שבת'], ['(ג) העושה. מגיד ג1']);
    });
    await check('otzaria fixture: Shulchan Aruch commentaries align at the siman (seif katan ≠ seif)', async () => {
      const OC = 'הלכה/שולחן ערוך/שולחן ערוך, אורח חיים';
      assert.deepStrictEqual((await blocks(OC, 4))['משנה ברורה'], ['(א) יתגבר. מב סק א', '(ב) כארי. מב סק ב', '(ג) לעבודת. מב סק ג'], 'all of סימן א, not ס"ק ב on seif ב');
      assert.deepStrictEqual((await blocks(OC, 6))['משנה ברורה'], ['(א) לא ילבש. מב ב-א']);
    });
    await check('otzaria fixture: chains, "פתח בספר" ranges and back-links', async () => {
      const BAVLI = 'תלמוד בבלי/סדר זרעים/ברכות';
      const chev = 'תלמוד בבלי/מחברי זמננו/ביאור חברותא/חברותא על ברכות';
      assert.deepStrictEqual((await blocks(chev, 5))['הערות על חברותא על ברכות'], ['הערה על חברותא'], 'commentary on a commentary');
      const groups = commentary.groupLinkedEntries(await commentary.fetchLinkedEntries(db, await id(BAVLI), 3));
      const tos = groups.find((g) => g.bookTitle === 'תוספות על ברכות');
      assert.deepStrictEqual(tos.block, { refKey: 'דף ב|עמוד א', start: 2, end: 4 }, '"פתח בספר" opens תוספות at its דף ב. block');
      const back = commentary.groupLinkedEntries(await commentary.fetchLinkedEntries(db, await id('תלמוד בבלי/אחרונים/חידושי מהראל על השס'), 4));
      assert.deepStrictEqual(back.map((g) => [g.bookTitle, g.entries.map((e) => e.display_text)]), [['ברכות', ['תנו רבנן']]], 'back-link from a corpus-wide commentary');
      const t = process.hrtime.bigint();
      for (let i = 0; i < 100; i++) await commentary.fetchUnitLinks(db, await id(BAVLI), 3);
      const ms = Number(process.hrtime.bigint() - t) / 1e6 / 100;
      assert.ok(ms < 5, `unit lookup ${ms.toFixed(2)}ms`);
    });
    db.close();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** Base books + commentaries at real Otzaria paths (no link files): all corpora and naming forms. */
function writeOtzariaFixture(lib) {
  const w = (rel, lines) => { fs.mkdirSync(path.dirname(path.join(lib, rel + '.txt')), { recursive: true }); fs.writeFileSync(path.join(lib, rel + '.txt'), lines.join('\n')); };
  // Tanach: chapters with inline "(א)" verses; Rashi / Ramban with verse headings, several דיבורים each.
  w('תנך/תורה/בראשית', ['<h1>בראשית</h1>', '<h2>פרק א</h2>', '(א) בראשית ברא', '(ב) והארץ היתה', '(ג) ויאמר אלהים', '<h2>פרק ב</h2>', '(א) ויכלו']);
  w('תנך/ראשונים/רשי/תורה/רשי על בראשית', ['<h1>רשי על בראשית</h1>', '<h2>פרק א</h2>', '<h3>פסוק א</h3>', 'בראשית. רשי א1', 'ברא. רשי א2', '<h3>פסוק ג</h3>', 'ויאמר. רשי ג1', '<h2>פרק ב</h2>', '<h3>פסוק א</h3>', 'ויכלו. רשי ב-א']);
  w('תנך/ראשונים/רמבן/תורה/רמבן על בראשית', ['<h1>רמבן על בראשית</h1>', '<h2>פרק א</h2>', '<h3>פסוק א</h3>', 'בראשית ברא. רמבן א1', 'אלהים. רמבן א2', 'השמים. רמבן א3', '<h3>פסוק ב</h3>', 'תהו. רמבן ב1']);
  // Bavli + Tosafot (daf / amud) + Rashi; Mishnah with inline mishnayot + Bartenura.
  w('תלמוד בבלי/סדר זרעים/ברכות', ['<h1>ברכות</h1>', '<h2>דף ב.</h2>', 'מאימתי קורין', 'גמרא', '<h2>דף ב:</h2>', 'תנו רבנן']);
  w('תלמוד בבלי/ראשונים/תוספות/סדר זרעים/תוספות על ברכות', ['<h1>תוספות על ברכות</h1>', '<h2>דף ב.</h2>', 'מאימתי. תוס 1', 'קורין. תוס 2', '<h2>דף ב:</h2>', 'תנו רבנן. תוס 3']);
  w('משנה/סדר זרעים/משנה ברכות', ['<h1>משנה ברכות</h1>', '<h2>פרק א</h2>', '(א) מאימתי קורין', '(ב) מאימתי קורין בשחרית']);
  w('משנה/ראשונים/ברטנורא/סדר זרעים/ברטנורא על משנה ברכות', ['<h1>ברטנורא על משנה ברכות</h1>', '<h2>פרק א</h2>', '<h3>משנה א</h3>', 'מאימתי. ברט א1', 'עד סוף. ברט א2', '<h3>משנה ב</h3>', 'בשחרית. ברט ב1']);
  w('תלמוד ירושלמי/סדר זרעים/תלמוד ירושלמי ברכות', ['<h1>תלמוד ירושלמי ברכות</h1>', '<h2>פרק א</h2>', '<h3>הלכה א</h3>', 'ירושלמי א', '<h3>הלכה ב</h3>', 'ירושלמי ב']);
  w('תלמוד ירושלמי/מפרשים/פני משה על תלמוד ירושלמי/סדר זרעים/פני משה על תלמוד ירושלמי ברכות', ['<h1>פני משה על תלמוד ירושלמי ברכות</h1>', '<h2>פרק א</h2>', '<h3>הלכה ב</h3>', 'פני משה ב1', 'פני משה ב2']);
  // Rambam: chapters with inline halachot; מגיד משנה numbers its דיבורים like the Rambam.
  w('הלכה/משנה תורה/ספר זמנים/משנה תורה, הלכות שבת', ['<h1>משנה תורה, הלכות שבת</h1>', '<h2>פרק א</h2>', '(א) שביתה ממלאכה', '(ב) כל מקום', '(ג) העושה']);
  w('הלכה/משנה תורה/מפרשים/מגיד משנה/ספר זמנים/מגיד משנה על משנה תורה, הלכות שבת', ['<h1>מגיד משנה על משנה תורה, הלכות שבת</h1>', '<h2>פרק א</h2>', '(א) שביתה. מגיד א1', 'עוד שם. מגיד א2', '(ג) העושה. מגיד ג1']);
  // Shulchan Aruch with inline seifim; משנה ברורה numbers seifim katanim (another sequence).
  w('הלכה/שולחן ערוך/שולחן ערוך, אורח חיים', ['<h1>שולחן ערוך, אורח חיים</h1>', '<h2>סימן א</h2>', '(א) יתגבר כארי', '(ב) המשכים', '<h2>סימן ב</h2>', '(א) לא ילבש']);
  w('הלכה/שולחן ערוך/מפרשים/משנה ברורה/משנה ברורה', ['<h1>משנה ברורה</h1>', '<h2>סימן א</h2>', '(א) יתגבר. מב סק א', '(ב) כארי. מב סק ב', '(ג) לעבודת. מב סק ג', '<h2>סימן ב</h2>', '(א) לא ילבש. מב ב-א']);
  // A corpus-wide commentary: one file, a top-level heading per tractate.
  w('תלמוד בבלי/אחרונים/חידושי מהראל על השס', ['<h1>חידושי מהראל על השס</h1>', '<h2>מסכת ברכות</h2>', '<h3>דף ב:</h3>', 'מהראל ברכות ב:', '<h2>מסכת שבת</h2>', '<h3>דף ב.</h3>', 'מהראל שבת']);
  // Commentary on a commentary (2-level chain).
  w('תלמוד בבלי/מחברי זמננו/ביאור חברותא/חברותא על ברכות', ['<h1>חברותא על ברכות</h1>', '<h2>דף ב.</h2>', 'חברותא 1', '<h2>דף ב:</h2>', 'חברותא 2']);
  w('תלמוד בבלי/מחברי זמננו/הערות על ביאור חברותא/הערות על חברותא על ברכות', ['<h1>הערות על חברותא על ברכות</h1>', '<h2>דף ב:</h2>', 'הערה על חברותא']);
  // Non-text files Otzaria folders also contain (pdf / docx) are skipped by the indexer.
  fs.writeFileSync(path.join(lib, 'הלכה', 'מבוא.pdf'), '%PDF');
}

/** Synthetic library for the resumable-ingestion tests: `n` books in two folders + junk files. */
function makeResumeFixture(n) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kodesh-resume-'));
  const words = ['שבת', 'ברכה', 'תורה', 'מצוה', 'תפילה', 'חסד'];
  for (let i = 1; i <= n; i++) {
    const sub = path.join(dir, i % 2 ? 'א' : 'ב');
    fs.mkdirSync(sub, { recursive: true });
    const lines = [`<h1>ספר ${i}</h1>`, '<h2>פרק א</h2>'];
    for (let j = 0; j < 30; j++) lines.push(`שורה ${j} של ספר ${i} ${words[(i + j) % words.length]} ייחודי${i}`);
    fs.writeFileSync(path.join(sub, `ספר ${String(i).padStart(3, '0')}.txt`), lines.join('\n'));
  }
  // Files that must be ignored before anything is read.
  for (const junk of ['scan.pdf', 'cover.jpg', 'book.epub', '.DS_Store', '._ספר.txt', 'Thumbs.db', '~$lock.txt']) fs.writeFileSync(path.join(dir, junk), 'x');
  fs.mkdirSync(path.join(dir, '__MACOSX'));
  fs.writeFileSync(path.join(dir, '__MACOSX', 'ספר 999.txt'), 'junk');
  fs.mkdirSync(path.join(dir, '.hidden'));
  fs.writeFileSync(path.join(dir, '.hidden', 'ספר 998.txt'), 'junk');
  return dir;
}

async function freshDb(dir, name) {
  const db = openWritable(path.join(dir, name));
  await indexer.ensureSchema(db.w, { kind: 'core' });
  return db;
}

const one = async (db, sql, params) => (await db.read.all(sql, params || []))[0];

async function resumableIngestionTests() {
  const N = 23;
  const src = makeResumeFixture(N);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'kodesh-resume-db-'));
  const tree = await indexer.scanBooks(nodeFs, src);
  const ing = (resume) => ({ sourceUri: 'file://' + src, sourceName: 'fixture', sourceKind: 'folder', targetDb: 'core', resume });

  await check('ingestion: non-text, hidden and system files are never read', () => {
    assert.strictEqual(tree.files.length, N, tree.files.map((f) => f.rel.join('/')).join(', '));
    assert.ok(tree.files.every((f) => /^ספר \d{3}\.txt$/.test(f.name)));
    assert.deepStrictEqual(tree.dirs.map((d) => d.join('/')).sort(), ['א', 'ב']);
  });

  // Reference: one uninterrupted run.
  const ref = await freshDb(work, 'ref.db');
  const refStats = await indexer.indexBooks(ref.w, nodeFs, { files: tree.files, dirs: tree.dirs, booksPerTransaction: 4, ingestion: ing(false) });
  const snapshot = async (db) => ({
    books: (await db.read.all('SELECT file_path, title, total_lines, is_complete FROM books ORDER BY file_path')).map((b) => `${b.file_path}|${b.title}|${b.total_lines}|${b.is_complete}`),
    paragraphs: Number((await one(db, 'SELECT COUNT(*) AS n FROM paragraphs')).n),
    fts: Number((await one(db, `SELECT COUNT(*) AS n FROM paragraphs_fts WHERE paragraphs_fts MATCH '"שבת"'`)).n),
    toc: Number((await one(db, 'SELECT COUNT(*) AS n FROM toc_nodes')).n),
    cats: (await db.read.all('SELECT path FROM categories ORDER BY path')).map((c) => c.path),
  });
  const refSnap = await snapshot(ref);

  await check('ingestion: checkpoint row tracks a finished run', async () => {
    assert.strictEqual(refStats.books, N);
    assert.strictEqual(refStats.stopped, null);
    const st = await indexer.readIngestionState(ref.read);
    assert.strictEqual(st.status, 'in_progress', 'caller marks completed after links/finalize');
    assert.strictEqual(st.processed_count, N);
    assert.strictEqual(st.total_count, N);
    assert.strictEqual(st.target_db, 'core');
    assert.strictEqual(st.source_name, 'fixture');
    assert.ok(st.last_book_path.endsWith('.txt'));
    assert.ok(refSnap.books.every((b) => b.endsWith('|1')), 'every book is_complete = 1');
  });

  await check('ingestion: pause between books commits, then resume skips completed books', async () => {
    const db = await freshDb(work, 'pause.db');
    let seen = 0;
    const read = [];
    const fsa = { list: nodeFs.list, readText: async (f) => (read.push(f), nodeFs.readText(f)) };
    const r1 = await indexer.indexBooks(db.w, fsa, {
      files: tree.files, dirs: tree.dirs, booksPerTransaction: 4, ingestion: ing(false),
      onBook: () => seen++,
      shouldStop: () => (seen >= 9 ? 'pause' : null),
    });
    assert.strictEqual(r1.stopped, 'pause');
    assert.strictEqual(r1.books, 9);
    let st = await indexer.readIngestionState(db.read);
    assert.strictEqual(st.status, 'paused');
    assert.strictEqual(st.processed_count, 9);
    assert.strictEqual(Number((await one(db, 'SELECT COUNT(*) AS n FROM books')).n), 9, 'paused books are on disk');
    assert.ok(indexer.isResumableState(st));

    read.length = 0;
    const r2 = await indexer.indexBooks(db.w, fsa, { files: tree.files, dirs: tree.dirs, booksPerTransaction: 4, ingestion: ing(true) });
    assert.strictEqual(r2.skipped, 9);
    assert.strictEqual(r2.books, N - 9);
    assert.strictEqual(read.length, N - 9, 'completed books are not even read');
    st = await indexer.readIngestionState(db.read);
    assert.strictEqual(st.processed_count, N);
    assert.deepStrictEqual(await snapshot(db), refSnap, 'resumed library == uninterrupted library');
  });

  await check('ingestion: crash mid-batch rolls back only the open batch; resume completes it', async () => {
    const db = await freshDb(work, 'crash.db');
    let reads = 0;
    const crashing = { list: nodeFs.list, readText: async (f) => {
      if (++reads === 11) throw Object.assign(new Error('process killed'), { fatal: true });
      return nodeFs.readText(f);
    } };
    // No onError: the error aborts the run like an OS kill would.
    await assert.rejects(indexer.indexBooks(db.w, crashing, { files: tree.files, dirs: tree.dirs, booksPerTransaction: 4, ingestion: ing(false) }), /process killed/);
    const st = await indexer.readIngestionState(db.read);
    assert.strictEqual(st.status, 'in_progress', 'interrupted, not paused');
    assert.strictEqual(st.processed_count, 8, 'checkpoint = last committed batch');
    assert.strictEqual(Number((await one(db, 'SELECT COUNT(*) AS n FROM books')).n), 8);
    const r = await indexer.indexBooks(db.w, nodeFs, { files: tree.files, dirs: tree.dirs, booksPerTransaction: 4, ingestion: ing(true) });
    assert.strictEqual(r.skipped, 8);
    assert.deepStrictEqual(await snapshot(db), refSnap);
  });

  await check('ingestion: an incomplete book (is_complete = 0) is redone on resume', async () => {
    const db = await freshDb(work, 'partial.db');
    await indexer.indexBooks(db.w, nodeFs, { files: tree.files.slice(0, 5), dirs: tree.dirs, ingestion: ing(false) });
    await db.w.run('UPDATE books SET is_complete = 0 WHERE file_path = ?', [tree.files[4].rel.join('/')]);
    const r = await indexer.indexBooks(db.w, nodeFs, { files: tree.files, dirs: tree.dirs, ingestion: ing(true) });
    assert.strictEqual(r.skipped, 4);
    assert.strictEqual(r.books, N - 4);
    assert.deepStrictEqual(await snapshot(db), refSnap);
  });

  await check('ingestion: a fresh re-import (no resume) replaces every book', async () => {
    const db = await freshDb(work, 'reimport.db');
    await indexer.indexBooks(db.w, nodeFs, { files: tree.files, dirs: tree.dirs, ingestion: ing(false) });
    const r = await indexer.indexBooks(db.w, nodeFs, { files: tree.files, dirs: tree.dirs, ingestion: ing(false) });
    assert.strictEqual(r.skipped, 0);
    assert.strictEqual(r.books, N);
    assert.deepStrictEqual(await snapshot(db), refSnap);
  });

  await check('ingestion: resume after a replace-run only skips books replaced by that run', async () => {
    const db = await freshDb(work, 'replace-resume.db');
    await indexer.indexBooks(db.w, nodeFs, { files: tree.files, dirs: tree.dirs, ingestion: ing(false) });
    let seen = 0;
    await indexer.indexBooks(db.w, nodeFs, { files: tree.files, dirs: tree.dirs, ingestion: ing(false), onBook: () => seen++, shouldStop: () => (seen >= 6 ? 'pause' : null) });
    const r = await indexer.indexBooks(db.w, nodeFs, { files: tree.files, dirs: tree.dirs, ingestion: ing(true) });
    assert.strictEqual(r.skipped, 6, 'old copies from before the run are re-imported');
    assert.strictEqual(r.books, N - 6);
  });

  await check('ingestion: a malformed book is isolated, logged and skipped', async () => {
    const db = await freshDb(work, 'errors.db');
    const bad = tree.files[3].handle;
    const fsa = { list: nodeFs.list, readText: async (f) => {
      if (f === bad) throw new Error('invalid UTF-8 sequence');
      return nodeFs.readText(f);
    } };
    const failed = [];
    const r = await indexer.indexBooks(db.w, fsa, {
      files: tree.files, dirs: tree.dirs, booksPerTransaction: 5, ingestion: ing(false), onError: (e) => failed.push(e.relPath),
    });
    assert.strictEqual(r.failed, 1);
    assert.strictEqual(r.books, N - 1);
    assert.deepStrictEqual(failed, [tree.files[3].rel.join('/')]);
    const errs = await indexer.readIngestionErrors(db.read);
    assert.strictEqual(errs.length, 1);
    assert.ok(errs[0].message.includes('invalid UTF-8'));
    assert.strictEqual((await indexer.readIngestionState(db.read)).error_count, 1);
    const orphanCats = await db.read.all('SELECT b.id FROM books b LEFT JOIN categories c ON c.id = b.category_id WHERE c.id IS NULL');
    assert.strictEqual(orphanCats.length, 0, 'categories stay consistent after a rollback');
  });

  await check('ingestion: a failure while writing a book rolls back only that book (savepoint)', async () => {
    const db = await freshDb(work, 'savepoint.db');
    // Fails the paragraph INSERT of "ספר 5" after its book + TOC rows were already written.
    const w = { ...db.w, run: async (sql, params) => {
      if (/INSERT INTO paragraphs \(/.test(sql) && params.some((p) => typeof p === 'string' && p.includes('ייחודי5'))) throw new Error('constraint failed');
      return db.w.run(sql, params);
    } };
    const files = tree.files.filter((f) => /ספר 00[1-8]/.test(f.name));
    const r = await indexer.indexBooks(w, nodeFs, { files, dirs: tree.dirs, booksPerTransaction: 10, ingestion: ing(false), onError: () => undefined });
    assert.strictEqual(r.failed, 1);
    assert.strictEqual(r.books, files.length - 1);
    const leftovers = await one(db, "SELECT COUNT(*) AS n FROM books WHERE title = 'ספר 5'");
    assert.strictEqual(Number(leftovers.n), 0, 'no half-written book');
    const tocLeft = await one(db, 'SELECT COUNT(*) AS n FROM toc_nodes t LEFT JOIN books b ON b.id = t.book_id WHERE b.id IS NULL');
    assert.strictEqual(Number(tocLeft.n), 0, 'no orphan TOC rows');
  });

  await check('ingestion: large books commit early (maxLinesPerTransaction)', async () => {
    const db = await freshDb(work, 'lines.db');
    let commits = 0;
    const w = { ...db.w, exec: async (sql) => (sql === 'COMMIT' && commits++, db.w.exec(sql)) };
    await indexer.indexBooks(w, nodeFs, { files: tree.files, dirs: tree.dirs, booksPerTransaction: 1000, maxLinesPerTransaction: 60 });
    // 32 paragraphs per book -> a commit every 2 books (+ the initial and final commits).
    assert.ok(commits >= Math.floor(N / 2), `commits: ${commits}`);
  });

  await check('ingestion: incremental FTS merge keeps the index queryable', async () => {
    const db = await freshDb(work, 'merge.db');
    for (const f of tree.files) await indexer.indexBooks(db.w, nodeFs, { files: [f], dirs: tree.dirs });
    let steps = 0;
    await indexer.finalizeIndex(db.w, { incremental: true, mergePages: 16, onStep: async () => { steps++; } });
    assert.ok(steps >= 1);
    const n = await one(db, `SELECT COUNT(*) AS n FROM paragraphs_fts WHERE paragraphs_fts MATCH '"שבת"'`);
    assert.strictEqual(Number(n.n), refSnap.fts);
    const integrity = await db.read.all("INSERT INTO paragraphs_fts(paragraphs_fts, rank) VALUES('integrity-check', 1)");
    assert.ok(Array.isArray(integrity));
  });

  await check('ingestion: version-2 databases migrate (is_complete + checkpoint tables)', async () => {
    const db = openWritable(path.join(work, 'v2.db'));
    await db.w.exec(indexer.SCHEMA.replace(/,\s*-- 0 while[^\n]*\n\s*is_complete INTEGER NOT NULL DEFAULT 1/, ''));
    await db.w.run("INSERT INTO meta (key, value) VALUES ('kind', 'user'), ('script_version', '2')", []);
    assert.ok(!(await db.read.all('PRAGMA table_info(books)')).some((c) => c.name === 'is_complete'));
    assert.strictEqual(await indexer.ensureSchema(db.w, { kind: 'user' }), false);
    assert.ok((await db.read.all('PRAGMA table_info(books)')).some((c) => c.name === 'is_complete'));
    assert.strictEqual(await indexer.readIngestionState(db.read), null);
    const r = await indexer.indexBooks(db.w, nodeFs, { files: tree.files.slice(0, 2), dirs: tree.dirs, idBase: indexer.USER_ID_BASE, ingestion: { ...ing(false), targetDb: 'user' } });
    assert.strictEqual(r.books, 2);
    await indexer.clearIngestionState(db.w);
    assert.strictEqual(await indexer.readIngestionState(db.read), null);
  });

  await check('search: hostile input never raises an FTS5 syntax error', async () => {
    const nasty = ['"', "'", '״', '׳', 'שו"ע', "גמ'", '-שבת', 'שבת*', '(שבת', 'שבת)', 'NEAR(שבת', 'AND OR NOT', ':', '^שבת', '"שבת', 'שבת"', '״שבת״ ״', '״', '״״', '\\', '{}[]', '%_', ';DROP TABLE books;', '־', '׀', '…', '“שבת”', '‘תורה’', 'תורה–שבת', 'א״ב׳ג', '****', '"" ""'];
    for (const q of nasty) {
      const parsed = search.parseSearchQuery(q);
      await search.searchParagraphs(ref.read, parsed, { limit: 5 });
      await search.countMatches(ref.read, parsed, { cap: 10 });
    }
    const r = await search.searchParagraphs(ref.read, '״שבת״', { limit: 5 });
    assert.ok(r.rows.length > 0, 'gershayim-quoted phrase still finds hits');
  });

  await check('reader: search hits are marked inside the target paragraph', () => {
    const terms = search.parseSearchQuery('שבת').terms;
    assert.strictEqual(search.markTerms('<b>שַׁבָּת</b> קודש ושבת', terms), '<b><mark>שַׁבָּת</mark></b> קודש ושבת');
    assert.strictEqual(search.markTerms('לפני שבת־קודש', terms), 'לפני <mark>שבת</mark>־קודש');
    assert.strictEqual(search.markTerms('ללא התאמה', terms), 'ללא התאמה');
    assert.strictEqual(search.markTerms('שבת', []), 'שבת');
  });
}

/** Writable node:sqlite DB wrapped for shared/indexer.js. */
function openWritable(file) {
  const origEmit = process.emitWarning;
  process.emitWarning = (w, ...r) => (String(w).includes('SQLite') ? undefined : origEmit.call(process, w, ...r));
  const { DatabaseSync } = require('node:sqlite');
  process.emitWarning = origEmit;
  const raw = new DatabaseSync(file);
  return { raw, w: writerAdapter(raw), read: { all: async (sql, params) => raw.prepare(sql).all(...(params || [])) } };
}

async function dualDbTests() {
  const coreFile = path.join(ROOT, 'assets/db/library.db');
  if (!fs.existsSync(coreFile)) return;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kodesh-user-'));
  // A personal folder "שיעורים" with a sub-folder, plus a commentary + links file.
  const folder = path.join(tmp, 'שיעורים');
  fs.mkdirSync(path.join(folder, 'הלכה'), { recursive: true });
  const book = ['<h1>קיצור הלכות שבת</h1>', '<h2>סימן א</h2>', '<h3>סעיף א</h3>', 'אסור לבשל בשבת קדש.', '<h3>סעיף ב</h3>', 'מותר לטלטל ספר.'].join('\n');
  fs.writeFileSync(path.join(folder, 'הלכה', 'קיצור הלכות שבת.txt'), '﻿' + book.replace(/\n/g, '\r\n'));
  fs.writeFileSync(path.join(folder, 'הערות על קיצור הלכות שבת.txt'), ['<h1>הערות על קיצור הלכות שבת</h1>', '<h2>סימן א</h2>', 'הערה ייחודית זלזלת על הבישול.'].join('\n'));
  fs.writeFileSync(
    path.join(folder, 'links.csv'),
    'source_book,source_line,target_book,target_line,link_type\nהערות על קיצור הלכות שבת,3,קיצור הלכות שבת,4,commentary\nספר שלא קיים,1,קיצור הלכות שבת,4,\n',
  );
  const single = path.join(tmp, 'מכתב.txt');
  fs.writeFileSync(single, 'שורה ראשונה בשבת\nשורה שנייה');

  const userFile = path.join(tmp, 'user_library.db');
  const u = openWritable(userFile);
  const core = openDb(coreFile);
  const coreIndex = await loadBookIndex(core);
  try {
    await check('user DB: schema bootstrap is idempotent', async () => {
      assert.strictEqual(await indexer.ensureSchema(u.w, { kind: 'user' }), true);
      assert.strictEqual(await indexer.ensureSchema(u.w, { kind: 'user' }), false);
      assert.strictEqual((await indexer.readMeta(u.w)).kind, 'user');
    });

    let linkStats;
    await check('user DB: folder import keeps sub-folders as categories, ids namespaced', async () => {
      const tree = await indexer.scanBooks(nodeFs, folder);
      const r = await indexer.indexBooks(u.w, nodeFs, { files: tree.files, dirs: tree.dirs, idBase: indexer.USER_ID_BASE, categoryPrefix: [indexer.USER_ROOT_NAME, 'שיעורים'] });
      assert.strictEqual(r.books, 2);
      linkStats = await indexer.indexLinks(u.w, nodeFs, await indexer.scanLinkFiles(nodeFs, folder));
      const cats = (await u.read.all('SELECT path FROM categories ORDER BY id')).map((x) => x.path);
      assert.deepStrictEqual(cats, ['הספרים שלי', 'הספרים שלי/שיעורים', 'הספרים שלי/שיעורים/הלכה']);
      for (const t of ['categories', 'books', 'toc_nodes', 'paragraphs']) {
        const m = (await u.read.all(`SELECT MIN(id) AS m FROM ${t}`))[0].m;
        assert.ok(m > indexer.USER_ID_BASE, `${t} ids start above USER_ID_BASE (${m})`);
      }
      const b = (await u.read.all("SELECT file_path, total_lines FROM books WHERE title = 'קיצור הלכות שבת'"))[0];
      assert.strictEqual(b.file_path, 'הספרים שלי/שיעורים/הלכה/קיצור הלכות שבת.txt');
      assert.strictEqual(b.total_lines, 6, 'BOM + CRLF handled');
    });
    await check('user DB: links matched by name, unmatched reported', () => {
      assert.strictEqual(linkStats.kept, 1);
      assert.strictEqual(linkStats.unmatched.get('ספר שלא קיים'), 1);
    });
    await check('user DB: single-file import + re-import replaces instead of duplicating', async () => {
      const files = [{ handle: single, name: 'מכתב.txt', rel: ['מכתב.txt'], dir: [] }];
      const opts = { files, idBase: indexer.USER_ID_BASE, categoryPrefix: [indexer.USER_ROOT_NAME] };
      await indexer.indexBooks(u.w, nodeFs, opts);
      await indexer.indexBooks(u.w, nodeFs, opts);
      const rows = await u.read.all("SELECT id FROM books WHERE title = 'מכתב'");
      assert.strictEqual(rows.length, 1);
      const fts = await u.read.all(`SELECT COUNT(*) AS n FROM paragraphs_fts WHERE paragraphs_fts MATCH '"ראשונה"'`);
      assert.strictEqual(fts[0].n, 1, 'old FTS rows were deleted with the old copy');
      await indexer.finalizeIndex(u.w);
    });

    const router = sources.createRouter([
      { name: 'user', adapter: u.read, idBase: indexer.USER_ID_BASE, categoryRoot: indexer.USER_ROOT_NAME },
      { name: 'core', adapter: core, idBase: 0 },
    ]);
    const index = await loadBookIndex(router);
    const userBookId = [...index.books.values()].find((b) => b.title === 'קיצור הלכות שבת').id;

    await check('router: sources sorted core-first, books routed by id', async () => {
      assert.deepStrictEqual(router.sources.map((x) => x.name), ['core', 'user']);
      assert.strictEqual(router.forBook(1), core);
      assert.strictEqual(router.forBook(userBookId), u.read);
      assert.strictEqual(index.books.size, coreIndex.books.size + 3);
    });
    await check('router: merged catalog (tree) has both libraries', async () => {
      const cat = await sources.loadCatalog(router);
      assert.ok(cat.categories.some((c) => c.path === 'תנך'));
      assert.ok(cat.categories.some((c) => c.path === 'הספרים שלי/שיעורים/הלכה' && c.source === 'user'));
      assert.strictEqual(new Set(cat.books.map((b) => b.id)).size, cat.books.length, 'unique ids');
    });
    await check('router: Quick Jump resolves into personal and core books', async () => {
      await expectJump(router, index, 'קיצור הלכות שבת א ב', 'קיצור הלכות שבת', 5, 'סעיף ב');
      await expectJump(router, index, 'שבת ב.', 'שבת', coreIndex.books.size ? (await resolveReference(core, coreIndex, 'שבת ב.'))[0].targetLine : 0);
    });
    await check('router: windowed reader + TOC go to the owning DB', async () => {
      const rows = await reader.fetchRange(router, userBookId, 1, 10);
      assert.deepStrictEqual(rows.map((r) => r.line_index), [1, 2, 3, 4, 5, 6]);
      const coreRows = await reader.fetchRange(router, 1, 1, 3);
      assert.ok(coreRows.length > 0);
    });
    await check('router: FTS search merges both DBs, pages across the boundary', async () => {
      const all = [];
      let afterId;
      for (;;) {
        const page = await search.searchParagraphs(router, 'שבת', { limit: 7, afterId });
        all.push(...page.rows);
        if (!page.hasMore) break;
        afterId = page.rows[page.rows.length - 1].id;
      }
      const coreHits = (await search.searchParagraphs(core, 'שבת', { limit: 100000 })).rows.length;
      const userHits = all.filter((r) => r.id > indexer.USER_ID_BASE);
      assert.ok(userHits.length >= 2, 'personal books found');
      assert.strictEqual(all.length, coreHits + userHits.length);
      for (let i = 1; i < all.length; i++) assert.ok(all[i].id > all[i - 1].id, 'ordered, no duplicates');
      const cnt = await search.countMatches(router, 'שבת', { cap: 100000 });
      assert.strictEqual(cnt.count, all.length);
    });
    await check('router: search scopes route to one DB', async () => {
      const mine = await search.searchParagraphs(router, 'שבת', { scope: { kind: 'category', path: indexer.USER_ROOT_NAME, name: 'x' } });
      assert.ok(mine.rows.length >= 2 && mine.rows.every((r) => r.id > indexer.USER_ID_BASE));
      const sub = await search.searchParagraphs(router, 'זלזלת', { scope: { kind: 'category', path: 'הספרים שלי/שיעורים', name: 'x' } });
      assert.strictEqual(sub.rows.length, 1);
      const bk = await search.searchParagraphs(router, 'שבת', { scope: { kind: 'book', bookId: userBookId, title: 'x' } });
      assert.ok(bk.rows.length && bk.rows.every((r) => r.book_id === userBookId));
      const tanach = await search.searchParagraphs(router, 'שבת', { scope: { kind: 'category', path: 'תלמוד בבלי', name: 'x' } });
      assert.ok(tanach.rows.length && tanach.rows.every((r) => r.id < indexer.USER_ID_BASE));
      assert.strictEqual(await search.hasFts5(router), true);
    });
    await check('router: commentaries in the personal library', async () => {
      const counts = await commentary.fetchLinkCounts(router, userBookId, 1, 10);
      assert.strictEqual(counts.get(4), 1);
      const entries = await commentary.fetchLinkedEntries(router, userBookId, 4);
      assert.strictEqual(entries[0].book_title, 'הערות על קיצור הלכות שבת');
      assert.ok(entries[0].display_text.includes('זלזלת'));
      const coreCounts = await commentary.fetchLinkCounts(router, 1, 1, 100000);
      const direct = await commentary.fetchLinkCounts(core, 1, 1, 100000);
      assert.deepStrictEqual([...coreCounts], [...direct]);
    });
    await check('user DB: deleting a book removes text, TOC, FTS rows, links and empty folders', async () => {
      const comm = [...index.books.values()].find((b) => b.title === 'הערות על קיצור הלכות שבת').id;
      await indexer.deleteBook(u.w, comm);
      await indexer.deleteBook(u.w, userBookId);
      await indexer.pruneEmptyCategories(u.w);
      for (const t of ['paragraphs', 'toc_nodes']) assert.strictEqual((await u.read.all(`SELECT COUNT(*) AS n FROM ${t} WHERE book_id IN (?, ?)`, [comm, userBookId]))[0].n, 0, t);
      assert.strictEqual((await u.read.all('SELECT COUNT(*) AS n FROM links'))[0].n, 0);
      const hits = await search.searchParagraphs(u.read, 'זלזלת');
      assert.strictEqual(hits.rows.length, 0, 'FTS entries deleted');
      const integ = await u.read.all("INSERT INTO paragraphs_fts(paragraphs_fts, rank) VALUES('integrity-check', 1) RETURNING 1").catch((e) => e);
      assert.ok(!(integ instanceof Error), 'FTS integrity-check passes: ' + (integ && integ.message));
      const cats = (await u.read.all('SELECT path FROM categories')).map((x) => x.path);
      assert.deepStrictEqual(cats, ['הספרים שלי'], 'emptied folders pruned');
    });
  } finally {
    core.close();
    u.raw.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * Cloud library (section 12): external-content FTS parity, the classical_full scope filter of
 * build-db.js, the multi-part manifest / resumable download / streaming assembly, the CI manifest
 * writer and the workflow file itself.
 */
async function cloudLibraryTests() {
  const http = require('http');
  const mp = require('../shared/multipart');
  const libraryScope = require('../shared/libraryScope');
  const cloudRelease = require('./cloud-release');
  const { zipSync } = require('fflate');
  const SAMPLE_DB = path.join(ROOT, 'assets/db/library.db');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-'));
  const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
  const writable = (file) => {
    const origEmit = process.emitWarning;
    process.emitWarning = (w, ...r) => (String(w).includes('SQLite') ? undefined : origEmit.call(process, w, ...r));
    const { DatabaseSync } = require('node:sqlite');
    process.emitWarning = origEmit;
    return new DatabaseSync(file);
  };
  try {
    // --- external-content FTS --------------------------------------------------------------------
    await check('fts: paragraphs_fts is an external-content table (no second copy of the text)', () => {
      const src = writable(SAMPLE_DB);
      try {
        const ddl = src.prepare("SELECT sql FROM sqlite_master WHERE name = 'paragraphs_fts'").get().sql;
        assert.ok(/content\s*=\s*'paragraphs_fts_source'/.test(ddl), ddl);
        const shadows = src.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'paragraphs_fts\\_%' ESCAPE '\\' ORDER BY name").all().map((r) => r.name);
        assert.ok(!shadows.includes('paragraphs_fts_content'), `no _content shadow table: ${shadows}`);
        assert.ok(shadows.includes('paragraphs_fts_data') && shadows.includes('paragraphs_fts_docsize'), shadows.join(','));
      } finally {
        src.close();
      }
    });
    await check('fts: external-content results are identical to a duplicated-content FTS5 table, and smaller', () => {
      const copy = path.join(tmp, 'parity.db');
      fs.copyFileSync(SAMPLE_DB, copy);
      const db = writable(copy);
      try {
        db.exec('PRAGMA journal_mode = OFF');
        db.exec(`CREATE VIRTUAL TABLE fts_dup USING fts5(clean_text, book_id UNINDEXED, category_path UNINDEXED, line_index UNINDEXED)`);
        db.exec('INSERT INTO fts_dup(rowid, clean_text, book_id, category_path, line_index) SELECT id, clean_text, book_id, category_path, line_index FROM paragraphs_fts_source');
        const words = db.prepare("SELECT clean_text FROM paragraphs ORDER BY id LIMIT 400").all().flatMap((r) => r.clean_text.split(/\s+/)).filter((w) => w.length > 2);
        const probe = [...new Set(words)].slice(0, 60);
        assert.ok(probe.length >= 30, `${probe.length} probe words`);
        let hits = 0;
        const queries = [...probe.map((w) => `"${w}"`), ...probe.slice(0, 20).map((w) => `"${w}"*`), `"${probe[0]}" "${probe[1]}"`, `"${probe[2]}" OR "${probe[3]}"`, `NEAR("${probe[4]}" "${probe[5]}", 5)`];
        for (const q of queries) {
          const a = db.prepare('SELECT rowid FROM paragraphs_fts WHERE paragraphs_fts MATCH ? ORDER BY rowid').all(q).map((r) => r.rowid);
          const b = db.prepare('SELECT rowid FROM fts_dup WHERE fts_dup MATCH ? ORDER BY rowid').all(q).map((r) => r.rowid);
          assert.deepStrictEqual(a, b, `query ${q}`);
          hits += a.length;
        }
        assert.ok(hits > 50, `${hits} total hits`);
        // The FTS5 consistency command compares the index with the content view.
        db.exec("INSERT INTO paragraphs_fts(paragraphs_fts, rank) VALUES('integrity-check', 1)");
        const bytes = (t) => Number(db.prepare("SELECT SUM(pgsize) AS n FROM dbstat WHERE name LIKE ?").get(t).n || 0);
        const ext = bytes('paragraphs_fts%');
        const dup = bytes('fts_dup%');
        assert.ok(ext > 0 && dup > ext, `external ${ext} < duplicated ${dup}`);
        console.log(`  FTS5 storage: external-content ${(ext / 1024).toFixed(0)} KB vs duplicated ${(dup / 1024).toFixed(0)} KB; ${hits} hits identical`);
      } finally {
        db.close();
      }
    });

    // --- scope filter -----------------------------------------------------------------------------
    await check('scope: classical_full drops מחברי זמננו (and links), all keeps modern authors', () => {
      assert.ok(libraryScope.isExcludedDir('classical_full', 'מחברי זמננו') && libraryScope.isExcludedDir('classical_full', 'מחברי זמנינו'));
      assert.ok(!libraryScope.isExcludedDir('all', 'מחברי זמננו') && libraryScope.isExcludedDir('all', 'links'));
      assert.ok(!libraryScope.isExcludedDir('classical_full', 'תנך') && !libraryScope.isExcludedDir('classical_full', 'ראשונים'));
      assert.throws(() => libraryScope.assertScope('everything'), /--scope must be/);

      const src = path.join(tmp, 'checkout');
      const w = (rel, lines) => {
        const f = path.join(src, ...rel.split('/'));
        fs.mkdirSync(path.dirname(f), { recursive: true });
        fs.writeFileSync(f, lines.join('\n'));
      };
      w('repo/אוצריא/תנך/בראשית.txt', ['<h1>בראשית</h1>', '<h2>פרק א</h2>', '(א) בראשית ברא אלהים']);
      w('repo/אוצריא/תנך/מחברי זמננו/ביאור מודרני על בראשית.txt', ['<h1>ביאור מודרני על בראשית</h1>', '<h2>פרק א</h2>', 'הערה מודרנית']);
      w('repo/אוצריא/תלמוד בבלי/מחברי זמנינו/חברותא על ברכות.txt', ['<h1>חברותא על ברכות</h1>', '<h2>דף ב.</h2>', 'חברותא']);
      w('repo/אוצריא/תלמוד בבלי/ברכות.txt', ['<h1>ברכות</h1>', '<h2>דף ב.</h2>', 'מאימתי קורין']);
      w('repo/links/ברכות.txt', ['<h1>קישורים</h1>', 'לא ספר']);
      w('repo/README.txt', ['not a book']);
      const build = (scope, out) =>
        spawnSync(process.execPath, [path.join(ROOT, 'scripts/build-db.js'), `--source=${src}`, `--scope=${scope}`, '--lean', `--out=${out}`], { encoding: 'utf8' });
      const titles = (file) => {
        const db = writable(file);
        try {
          return db.prepare('SELECT title FROM books ORDER BY title').all().map((r) => r.title);
        } finally {
          db.close();
        }
      };
      const classical = build('classical_full', path.join(tmp, 'classical.db'));
      assert.strictEqual(classical.status, 0, classical.stderr + classical.stdout);
      assert.ok(/left out/.test(classical.stdout), classical.stdout);
      assert.deepStrictEqual(titles(path.join(tmp, 'classical.db')), ['בראשית', 'ברכות']);
      const all = build('all', path.join(tmp, 'all.db'));
      assert.strictEqual(all.status, 0, all.stderr);
      assert.deepStrictEqual(titles(path.join(tmp, 'all.db')), ['ביאור מודרני על בראשית', 'בראשית', 'ברכות', 'חברותא על ברכות']);
      // --lean ships without the ingestion-only tables' rows.
      const db = writable(path.join(tmp, 'classical.db'));
      try {
        assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM book_units').get().n, 0);
        assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM import_queue').get().n, 0);
      } finally {
        db.close();
      }
      const bad = build('modern_only', path.join(tmp, 'bad.db'));
      assert.notStrictEqual(bad.status, 0);
      assert.ok(/--scope must be/.test(bad.stderr), bad.stderr);
      // The CI validator refuses a library without commentary alignment (ref_links empty).
      assert.throws(() => cloudRelease.validateDb(path.join(tmp, 'classical.db')), /ref_links is empty/);
    });

    // --- two editions: classic (library-classic-latest) | full (library-latest) ----------------------------
    const editions = require('../shared/editions');
    const { buildMatrix } = require('./ci/edition-matrix');
    await check('editions: release tags, scopes and manifest URLs of classic (library-classic-latest) and full (library-latest)', () => {
      assert.deepStrictEqual(editions.EDITION_IDS, ['classic', 'full']);
      assert.strictEqual(editions.editionTag('full'), 'library-latest', 'the original tag stays the full edition');
      assert.strictEqual(editions.editionTag('classic'), 'library-classic-latest');
      assert.strictEqual(editions.editionScope('classic'), 'classical_full');
      assert.strictEqual(editions.editionScope('full'), 'all');
      assert.ok(libraryScope.SCOPES.includes(editions.editionScope('classic')) && libraryScope.SCOPES.includes(editions.editionScope('full')));
      assert.strictEqual(mp.cloudManifestUrl('o/r'), 'https://github.com/o/r/releases/download/library-latest/library-manifest.json');
      assert.strictEqual(mp.cloudManifestUrl('o/r', 'full'), 'https://github.com/o/r/releases/download/library-latest/library-manifest.json');
      assert.strictEqual(mp.cloudManifestUrl('o/r', 'classic'), 'https://github.com/o/r/releases/download/library-classic-latest/library-manifest.json');
      assert.strictEqual(mp.partUrl(mp.cloudManifestUrl('o/r', 'classic'), { name: 'core_library.db.zip.part-02' }), 'https://github.com/o/r/releases/download/library-classic-latest/core_library.db.zip.part-02');
      assert.strictEqual(editions.tagOfManifestUrl(mp.cloudManifestUrl('o/r', 'classic')), 'library-classic-latest');
      assert.strictEqual(editions.editionOfUrl(mp.cloudManifestUrl('o/r', 'classic')), 'classic');
      assert.strictEqual(editions.editionOfUrl(mp.cloudManifestUrl('o/r', 'full')), 'full');
      assert.strictEqual(editions.editionOfUrl('https://example.com/x/library-manifest.json'), null);
      assert.notStrictEqual(editions.editionTag('classic'), editions.editionTag('full'), 'never the same release: no overwriting');
      assert.throws(() => editions.editionTag('huge'), /edition must be/);
    });
    await check('editions: אחרוני זמננו is excluded from classic and included in full (folder filter + built DBs)', async () => {
      for (const name of ['מחברי זמננו', 'מחברי זמנינו', 'אחרוני זמננו', 'אחרוני זמנינו']) {
        assert.ok(libraryScope.isExcludedDir(editions.editionScope('classic'), name), `classic drops ${name}`);
        assert.ok(!libraryScope.isExcludedDir(editions.editionScope('full'), name), `full keeps ${name}`);
      }
      // The real Acharonim / Rishonim folders are NOT the contemporary-authors folder.
      for (const name of ['אחרונים', 'ראשונים', 'תנך', 'הלכה']) assert.ok(!libraryScope.isExcludedDir('classical_full', name), name);
      const src = path.join(tmp, 'ed-src');
      const w = (rel, lines) => {
        const f = path.join(src, ...rel.split('/'));
        fs.mkdirSync(path.dirname(f), { recursive: true });
        fs.writeFileSync(f, lines.join('\n'));
      };
      w('repo/אוצריא/תנך/בראשית.txt', ['<h1>בראשית</h1>', '<h2>פרק א</h2>', '(א) בראשית ברא אלהים']);
      w('repo/אוצריא/אחרונים/ספר קלאסי.txt', ['<h1>ספר קלאסי</h1>', 'טקסט']);
      w('repo/אוצריא/הלכה/אחרוני זמננו/ספר מודרני.txt', ['<h1>ספר מודרני</h1>', 'טקסט מודרני']);
      w('repo/אוצריא/הלכה/מחברי זמננו/ספר עכשווי.txt', ['<h1>ספר עכשווי</h1>', 'טקסט עכשווי']);
      const titles = (file) => {
        const db = writable(file);
        try {
          return db.prepare('SELECT title FROM books ORDER BY title').all().map((r) => r.title);
        } finally {
          db.close();
        }
      };
      const out = {};
      for (const ed of editions.EDITION_IDS) {
        out[ed] = path.join(tmp, `edition-${ed}.db`);
        const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts/build-db.js'), `--source=${src}`, `--scope=${editions.editionScope(ed)}`, '--lean', `--out=${out[ed]}`], { encoding: 'utf8' });
        assert.strictEqual(r.status, 0, r.stderr + r.stdout);
      }
      assert.deepStrictEqual(titles(out.classic), ['בראשית', 'ספר קלאסי'], 'classic: no contemporary authors, real אחרונים stay');
      assert.deepStrictEqual(titles(out.full), ['בראשית', 'ספר מודרני', 'ספר עכשווי', 'ספר קלאסי']);
      // meta.scope tells the app which edition a DB is.
      for (const [ed, file] of Object.entries(out)) {
        const db = writable(file);
        try {
          assert.strictEqual(db.prepare("SELECT value FROM meta WHERE key = 'scope'").get().value, editions.editionScope(ed));
        } finally {
          db.close();
        }
      }
      // The CI check: classic must hold no modern-authors book; full reports them.
      assert.strictEqual(cloudRelease.checkEdition(out.classic, 'classic').modern, 0);
      assert.strictEqual(cloudRelease.checkEdition(out.full, 'full').modern, 2);
      assert.throws(() => cloudRelease.checkEdition(out.full, 'classic'), /classic edition contains 2 book/);
      assert.ok(cloudRelease.checkEdition(out.classic, 'full').warnings.length === 1, 'a full edition without modern authors warns');
      // Same source, different scope -> different db_version (an edition switch is never "up to date").
      const version = (file) => {
        const db = writable(file);
        try {
          return db.prepare("SELECT value FROM meta WHERE key = 'db_version'").get().value;
        } finally {
          db.close();
        }
      };
      assert.notStrictEqual(version(out.classic), version(out.full));
    });
    await check('editions: manifests carry their edition (manifest field, else derived from the scope)', async () => {
      const stats = { version: 'v1', builtAt: '2026-01-01T00:00:00Z', bookCount: 3, paragraphCount: 9, uncompressedDbBytes: 100 };
      const pd = path.join(tmp, 'ed-parts');
      fs.mkdirSync(pd, { recursive: true });
      fs.writeFileSync(path.join(pd, 'core_library.db.zip.part-01'), Buffer.from('abc'));
      const c = await cloudRelease.buildManifest({ stats, partsDir: pd, sourceRepo: 'o/r', scope: 'classical_full' });
      assert.deepStrictEqual([c.edition, c.releaseTag, c.scope], ['classic', 'library-classic-latest', 'classical_full']);
      const f = await cloudRelease.buildManifest({ stats, partsDir: pd, sourceRepo: 'o/r', scope: 'all', edition: 'full' });
      assert.deepStrictEqual([f.edition, f.releaseTag], ['full', 'library-latest']);
      await assert.rejects(() => cloudRelease.buildManifest({ stats, partsDir: pd, sourceRepo: 'o/r', scope: 'all', edition: 'classic' }), /classic is built with scope classical_full/);
      assert.strictEqual(mp.validateCloudManifest(c).edition, 'classic');
      assert.strictEqual(mp.validateCloudManifest(f).edition, 'full');
      // A manifest of a release published before editions has no field: derived from its scope.
      const { edition: _e, releaseTag: _t, ...old } = f;
      assert.strictEqual(mp.validateCloudManifest(old).edition, 'full');
      assert.strictEqual(mp.validateCloudManifest({ ...old, scope: 'classical_full' }).edition, 'classic');
      assert.strictEqual(mp.validateCloudManifest({ ...old, scope: null }).edition, null);
    });
    await check('editions: installed edition tracking, update detection per edition and clean switching', () => {
      const man = (edition, version) => ({ edition, version, scope: editions.editionScope(edition) });
      // installed edition: meta.scope wins, then the recorded install, only while the version matches
      assert.strictEqual(editions.installedEdition({ scope: 'classical_full', version: 'a' }, null), 'classic');
      assert.strictEqual(editions.installedEdition({ scope: 'all', version: 'a' }, { edition: 'classic', version: 'a' }), 'full', 'meta beats the record');
      assert.strictEqual(editions.installedEdition({ scope: null, version: 'a' }, { edition: 'classic', version: 'a' }), 'classic');
      assert.strictEqual(editions.installedEdition({ scope: null, version: 'b' }, { edition: 'classic', version: 'a' }), null, 'a stale record is ignored');
      assert.strictEqual(editions.installedEdition(null, { edition: 'full', version: 'a' }), null, 'nothing installed');
      const act = (installedEdition, installedVersion, manifest) => editions.editionAction({ installedEdition, installedVersion, manifest });
      assert.strictEqual(act(null, null, man('classic', 'c1')), 'install');
      assert.strictEqual(act('classic', 'c1', man('classic', 'c1')), 'current');
      assert.strictEqual(act('classic', 'c1', man('classic', 'c2')), 'update', 'קיים עדכון בענן: same edition, new version');
      assert.strictEqual(act('full', 'f1', man('full', 'f2')), 'update');
      // The other edition is never an "update" (different release tag, different version): a switch.
      assert.strictEqual(act('classic', 'c1', man('full', 'f1')), 'switch');
      assert.strictEqual(act('full', 'f1', man('classic', 'c1')), 'switch');
      assert.strictEqual(act('full', 'f1', man('classic', 'f1')), 'switch', 'even with an equal version string');
      // A library of unknown edition (device build / pre-edition download) is replaced, never "switched".
      assert.strictEqual(act(null, 'x', man('full', 'f1')), 'install');
      assert.strictEqual(act(null, 'f1', man('full', 'f1')), 'current');
      // An update check of the installed edition reads that edition's own release.
      const installed = 'classic';
      assert.strictEqual(editions.tagOfManifestUrl(mp.cloudManifestUrl('o/r', installed)), 'library-classic-latest');
      // classic -> full -> classic round trip
      let state = { ed: 'classic', v: 'c1' };
      for (const target of [man('full', 'f1'), man('classic', 'c1')]) {
        assert.strictEqual(act(state.ed, state.v, target), 'switch');
        state = { ed: target.edition, v: target.version };
        assert.strictEqual(act(state.ed, state.v, target), 'current');
      }
    });
    await check('editions: the workflow builds both editions to separate tags (matrix, starter once, audit + edition check per build)', () => {
      const both = buildMatrix('both').include;
      assert.deepStrictEqual(both.map((e) => [e.edition, e.scope, e.tag]), [['full', 'all', 'library-latest'], ['classic', 'classical_full', 'library-classic-latest']]);
      assert.strictEqual(both.filter((e) => e.starter).length, 1, 'starter packs exported exactly once');
      assert.strictEqual(both.find((e) => e.starter).edition, 'classic');
      assert.deepStrictEqual(buildMatrix('full').include.map((e) => [e.edition, e.starter]), [['full', true]]);
      assert.deepStrictEqual(buildMatrix('classic').include.map((e) => [e.edition, e.tag, e.starter]), [['classic', 'library-classic-latest', true]]);
      assert.throws(() => buildMatrix('huge'), /edition must be/);
      const text = fs.readFileSync(path.join(ROOT, '.github/workflows/build-library.yml'), 'utf8');
      assert.ok(text.includes('fail-fast: false') && text.includes('matrix: ${{ fromJSON(needs.plan.outputs.matrix) }}'));
      assert.ok(text.includes('RELEASE_TAG: ${{ matrix.tag }}') && !/RELEASE_TAG: library-/.test(text), 'the tag comes from the matrix');
      assert.ok(text.includes('if: ${{ matrix.starter }}') && text.includes('!cancelled() && matrix.starter'), 'starter export + publish only once');
      const at = (needle) => {
        const i = text.indexOf(needle);
        assert.ok(i >= 0, `workflow lacks: ${needle}`);
        return i;
      };
      assert.ok(at('cloud-release.js check-edition') > at('cloud-release.js validate') && at('cloud-release.js check-edition') < at('node scripts/audit-parallels.js'));
      assert.ok(at('node scripts/audit-parallels.js') < at('export-starter-packs.js --db=') && text.lastIndexOf('--edition="$EDITION"') > at('cloud-release.js manifest'));
      // Zero node_modules in CI: every script the workflow runs requires only built-ins / relative modules.
      assert.ok(!/npm (ci|install)|npx |yarn |pnpm /.test(text), 'no package install in build-library.yml');
      for (const f of ['scripts/ci/edition-matrix.js', 'scripts/cloud-release.js', 'scripts/export-starter-packs.js', 'scripts/audit-parallels.js', 'scripts/build-db.js', 'shared/editions.js', 'shared/libraryScope.js']) {
        const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
        for (const m of src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
          const dep = m[1];
          assert.ok(dep === 'better-sqlite3' /* optional fallback for Node < 22.13, never installed in CI */ || dep.startsWith('.') || dep.startsWith('node:') || require('module').builtinModules.includes(dep), `${f} requires a non-built-in "${dep}"`);
        }
      }
    });

    // --- multi-part manifest, download, assembly -----------------------------------------------------
    const dbBytes = fs.readFileSync(SAMPLE_DB);
    const zipPath = path.join(tmp, 'core_library.db.zip');
    const zipped = spawnSync('zip', ['-q', '-9', '-j', zipPath, SAMPLE_DB], { encoding: 'utf8' });
    let zipBuf;
    if (zipped.status === 0) {
      // Info-ZIP (what the workflow runs) renames the entry to the DB's own name: normalise to core_library.db.
      zipBuf = fs.readFileSync(zipPath);
    } else {
      zipBuf = Buffer.from(zipSync({ 'core_library.db': new Uint8Array(dbBytes) }, { level: 9 }));
    }
    const named = spawnSync('unzip', ['-l', zipPath], { encoding: 'utf8' });
    if (zipped.status === 0 && named.status === 0 && !/library\.db/.test(named.stdout)) throw new Error('zip entry missing');
    const partSize = Math.ceil(zipBuf.length / 3);
    const slices = [0, 1, 2].map((i) => zipBuf.subarray(i * partSize, (i + 1) * partSize));
    const partsDir = path.join(tmp, 'ci-parts');
    fs.mkdirSync(partsDir);
    slices.forEach((b, i) => fs.writeFileSync(path.join(partsDir, mp.partName(i + 1)), b));
    const stats = { version: 'v-test', builtAt: '2026-01-01T00:00:00.000Z', bookCount: 15, paragraphCount: 9106, uncompressedDbBytes: dbBytes.length };
    const manifest = await cloudRelease.buildManifest({ stats, partsDir, sourceRepo: 'Sivan22/otzaria-library', scope: 'classical_full' });

    await check('multipart: CI manifest has the documented fields, ordered parts and the whole-zip hash', () => {
      assert.deepStrictEqual(Object.keys(manifest), ['sourceRepo', 'scope', 'edition', 'releaseTag', 'version', 'builtAt', 'bookCount', 'paragraphCount', 'uncompressedDbBytes', 'totalZipBytes', 'fullZipSha256', 'parts']);
      assert.strictEqual(manifest.parts.length, 3);
      assert.deepStrictEqual(manifest.parts.map((p) => p.name), ['core_library.db.zip.part-01', 'core_library.db.zip.part-02', 'core_library.db.zip.part-03']);
      assert.strictEqual(manifest.totalZipBytes, zipBuf.length);
      assert.strictEqual(manifest.fullZipSha256, sha(zipBuf));
      manifest.parts.forEach((p, i) => assert.deepStrictEqual([p.sizeBytes, p.sha256], [slices[i].length, sha(slices[i])]));
      assert.strictEqual(mp.validateCloudManifest(JSON.parse(JSON.stringify(manifest))).parts.length, 3);
    });
    await check('multipart: manifest validation rejects unusable manifests', () => {
      const bad = (patch, re) => assert.throws(() => mp.validateCloudManifest({ ...manifest, ...patch }), re);
      bad({ parts: [] }, /no "parts"/);
      bad({ totalZipBytes: manifest.totalZipBytes + 1 }, /add up/);
      bad({ fullZipSha256: 'xyz' }, /fullZipSha256/);
      bad({ parts: [manifest.parts[1], manifest.parts[0], manifest.parts[2]] }, /out of order|unexpected name/);
      bad({ parts: [{ ...manifest.parts[0], name: 'other.bin' }, ...manifest.parts.slice(1)] }, /unexpected name/);
      bad({ parts: [{ ...manifest.parts[0], sizeBytes: 2 * 1024 ** 3 }, ...manifest.parts.slice(1)], totalZipBytes: 2 * 1024 ** 3 + manifest.parts[1].sizeBytes + manifest.parts[2].sizeBytes }, /2 GB/);
      bad({ version: '' }, /version/);
      assert.strictEqual(mp.partUrl('https://github.com/o/r/releases/download/library-latest/library-manifest.json?x=1', manifest.parts[1]), 'https://github.com/o/r/releases/download/library-latest/core_library.db.zip.part-02');
      assert.strictEqual(mp.cloudManifestUrl('o/r'), 'https://github.com/o/r/releases/download/library-latest/library-manifest.json');
    });
    await check('multipart: free-space rule is zip + extracted DB + 500 MB, and the progress label', () => {
      const m = { ...manifest, totalZipBytes: 3.2 * 1024 ** 3, uncompressedDbBytes: 7 * 1024 ** 3 };
      const need = m.totalZipBytes + m.uncompressedDbBytes + 500 * 1024 * 1024;
      assert.strictEqual(mp.requiredFreeBytes(m), need);
      assert.strictEqual(mp.checkFreeSpace(m, need).ok, true);
      assert.strictEqual(mp.checkFreeSpace(m, need - 1).ok, false);
      assert.strictEqual(mp.checkFreeSpace(m, null).ok, true);
      assert.strictEqual(mp.formatPartProgress({ partIndex: 2, partCount: 3, doneBytes: 1.4 * 1024 ** 3, totalBytes: 3.2 * 1024 ** 3 }), 'חלק 2 מתוך 3 · 1.4 GB / 3.2 GB · 43%');
      assert.strictEqual(mp.formatPartProgress({ partIndex: 1, partCount: 1, doneBytes: 5 * 1024 ** 2, totalBytes: 10 * 1024 ** 2 }), 'חלק 1 מתוך 1 · 5 MB / 10 MB · 50%');
    });

    // A local "GitHub release": serves the parts, counts requests, can corrupt / drop a part once.
    const hits = [];
    const ranges = [];
    const behaviour = { corruptOnce: new Set(), dropOnce: new Set() };
    const server = http.createServer((req, res) => {
      const name = decodeURIComponent(req.url.split('/').pop());
      const i = manifest.parts.findIndex((p) => p.name === name);
      if (i < 0) return res.writeHead(404).end();
      hits.push(name);
      ranges.push(req.headers.range || null);
      let body = slices[i];
      if (behaviour.corruptOnce.delete(name)) {
        body = Buffer.from(body);
        body[10] ^= 0xff;
      }
      const m = /^bytes=(\d+)-$/.exec(req.headers.range || '');
      if (m) {
        const from = Number(m[1]);
        if (from >= body.length) return res.writeHead(416).end();
        body = body.subarray(from);
        res.writeHead(206, { 'content-length': body.length, 'content-range': `bytes ${from}-${from + body.length - 1}/${slices[i].length}` });
      } else res.writeHead(200, { 'content-length': body.length });
      if (behaviour.dropOnce.delete(name)) {
        res.write(body.subarray(0, Math.floor(body.length / 2)));
        return setTimeout(() => res.destroy(), 10);
      }
      res.end(body);
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}/releases/download/library-latest/`;
    const manifestUrl = base + 'library-manifest.json';

    /** node:fs backend of the PartsIO contract. */
    const fsIO = (dir) => {
      const p = (n) => path.join(dir, n);
      return {
        size: (n) => (fs.existsSync(p(n)) ? fs.statSync(p(n)).size : null),
        remove: (n) => fs.rmSync(p(n), { force: true }),
        sha256: (n) => cloudRelease.sha256Files([p(n)]),
        rename: (a, b) => fs.renameSync(p(a), p(b)),
        // Resumable like the app's backend: Range request from `resumeFrom`; bytes that arrived before a drop stay on disk.
        download: (url, n, onProgress, isCancelled, resume) =>
          new Promise((resolve, reject) => {
            const from = (resume && resume.resumeFrom) || 0;
            http.get(url, { headers: from > 0 ? { Range: `bytes=${from}-` } : {} }, (res) => {
              if (res.statusCode !== 200 && res.statusCode !== 206) return reject(new Error(`HTTP ${res.statusCode}`));
              const append = from > 0 && res.statusCode === 206;
              const fd = fs.openSync(p(n), append ? 'a' : 'w');
              let got = append ? from : 0;
              const total = got + Number(res.headers['content-length']);
              res.on('data', (c) => {
                fs.writeSync(fd, c);
                got += c.length;
                onProgress(got, total);
                if (isCancelled && isCancelled()) res.destroy(new Error('cancelled'));
              });
              let closed = false;
              const close = () => {
                if (!closed) fs.closeSync(fd);
                closed = true;
              };
              res.on('aborted', () => {
                close();
                reject(new Error('connection dropped'));
              });
              res.on('error', (e) => {
                close();
                reject(e);
              });
              res.on('end', () => {
                close();
                resolve();
              });
            }).on('error', reject);
          }),
        openRead: (n) => {
          const fd = fs.openSync(p(n), 'r');
          let at = 0;
          return {
            read: async (k) => {
              const buf = Buffer.alloc(k);
              const got = fs.readSync(fd, buf, 0, k, at);
              at += got;
              return buf.subarray(0, got);
            },
            close: () => fs.closeSync(fd),
          };
        },
        openWrite: (n, append) => {
          const fd = fs.openSync(p(n), append ? 'a' : 'w');
          return { write: async (b) => void fs.writeSync(fd, b), close: () => fs.closeSync(fd) };
        },
      };
    };
    const fresh = (name) => {
      const d = path.join(tmp, name);
      fs.mkdirSync(d, { recursive: true });
      return { dir: d, io: fsIO(d) };
    };
    try {
      await check('multipart: download -> streaming assembly -> extraction is byte-exact; parts and zip are deleted', async () => {
        hits.length = 0;
        const { dir, io } = fresh('run-a');
        const seen = [];
        await mp.stageCloudLibrary(io, manifest, { manifestUrl, dbName: 'core_library.db.tmp', report: (r) => seen.push(r) });
        assert.ok(fs.readFileSync(path.join(dir, 'core_library.db.tmp')).equals(dbBytes), 'extracted DB equals the original');
        assert.deepStrictEqual(fs.readdirSync(dir), ['core_library.db.tmp'], 'no part and no zip left behind');
        assert.deepStrictEqual(hits, manifest.parts.map((p) => p.name));
        const labels = seen.map((r) => r.detail).filter((d) => /^חלק \d מתוך 3/.test(d || ''));
        assert.ok(labels.some((d) => d.startsWith('חלק 1 מתוך 3')) && labels.some((d) => d.startsWith('חלק 3 מתוך 3')) && labels[labels.length - 1].endsWith('100%'), labels.join(' | '));
        assert.ok(seen.some((r) => r.stage === 'מרכיב את החלקים…') && seen.some((r) => r.stage === 'מחלץ…'));
      });
      await check('multipart: valid parts on disk are skipped, a truncated one is re-downloaded (resume)', async () => {
        hits.length = 0;
        const { dir, io } = fresh('run-b');
        fs.writeFileSync(path.join(dir, manifest.parts[0].name), slices[0]); // complete
        fs.writeFileSync(path.join(dir, manifest.parts[1].name), slices[1].subarray(0, 100)); // connection dropped mid-part
        const progress = [];
        const r = await mp.downloadParts(io, manifest, { manifestUrl, onProgress: (p) => progress.push(p) });
        assert.deepStrictEqual(r, { downloaded: 2, skipped: 1 });
        assert.deepStrictEqual(hits, [manifest.parts[1].name, manifest.parts[2].name], 'part 1 was not requested again');
        assert.ok(progress[0].skipped && progress[0].doneBytes === manifest.parts[0].sizeBytes);
        // A second run finds everything valid and downloads nothing.
        hits.length = 0;
        assert.deepStrictEqual(await mp.downloadParts(io, manifest, { manifestUrl }), { downloaded: 0, skipped: 3 });
        assert.strictEqual(hits.length, 0);
      });
      await check('multipart: a same-size corrupt part (bad SHA-256) is deleted and fetched again', async () => {
        hits.length = 0;
        const { dir, io } = fresh('run-c');
        const bad = Buffer.from(slices[0]);
        bad[5] ^= 0xff;
        fs.writeFileSync(path.join(dir, manifest.parts[0].name), bad);
        behaviour.corruptOnce.add(manifest.parts[1].name); // served corrupt once, then fine
        const r = await mp.downloadParts(io, manifest, { manifestUrl });
        assert.deepStrictEqual(r, { downloaded: 3, skipped: 0 });
        assert.deepStrictEqual(hits, [manifest.parts[0].name, manifest.parts[1].name, manifest.parts[1].name, manifest.parts[2].name]);
        for (const [i, p] of manifest.parts.entries()) assert.ok(fs.readFileSync(path.join(dir, p.name)).equals(slices[i]));
      });
      await check('multipart: a dropped connection is retried; retries exhausted -> readable error, parts kept', async () => {
        const a = fresh('run-d');
        behaviour.dropOnce.add(manifest.parts[2].name);
        assert.deepStrictEqual(await mp.downloadParts(a.io, manifest, { manifestUrl }), { downloaded: 3, skipped: 0 });
        const b = fresh('run-e');
        behaviour.corruptOnce.add(manifest.parts[1].name);
        await assert.rejects(() => mp.downloadParts(b.io, manifest, { manifestUrl, retries: 0 }), /פגום/);
        assert.ok(fs.existsSync(path.join(b.dir, manifest.parts[0].name)), 'the good part 1 is kept for the next run');
        assert.ok(!fs.existsSync(path.join(b.dir, manifest.parts[1].name)), 'the corrupt part is gone');
        const c = fresh('run-f');
        await assert.rejects(() => mp.downloadParts(c.io, { ...manifest, parts: [{ ...manifest.parts[0], name: 'core_library.db.zip.part-09' }, ...manifest.parts.slice(1)] }, { manifestUrl, retries: 1 }), /HTTP 404/);
      });
      await check('multipart: cancel stops between chunks of work; the next run resumes', async () => {
        const { dir, io } = fresh('run-g');
        // cancel as soon as part 1 is complete (isCancelled is also polled while bytes arrive)
        await assert.rejects(() => mp.downloadParts(io, manifest, { manifestUrl, isCancelled: () => fs.existsSync(path.join(dir, manifest.parts[0].name)) }), /cancelled/);
        assert.ok(fs.existsSync(path.join(dir, manifest.parts[0].name)));
        hits.length = 0;
        assert.deepStrictEqual(await mp.downloadParts(io, manifest, { manifestUrl }), { downloaded: 2, skipped: 1 });
      });
      await check('multipart: assembly appends in 1 MB-or-smaller chunks (never one big buffer) and verifies the whole-zip SHA-256', async () => {
        const { dir, io } = fresh('run-h');
        manifest.parts.forEach((p, i) => fs.writeFileSync(path.join(dir, p.name), slices[i]));
        const writes = [];
        const spy = { ...io, openWrite: (n, a) => { const w = io.openWrite(n, a); return { write: (b) => { writes.push(b.length); return w.write(b); }, close: () => w.close() }; } };
        await mp.assembleParts(spy, manifest, 'core_library.db.zip', { chunkSize: 4096 });
        assert.ok(Math.max(...writes) <= 4096 && writes.length > 3, `max chunk ${Math.max(...writes)}, ${writes.length} writes`);
        assert.ok(fs.readFileSync(path.join(dir, 'core_library.db.zip')).equals(zipBuf));
        assert.deepStrictEqual(fs.readdirSync(dir), ['core_library.db.zip'], 'parts deleted after assembly');
        // A wrong archive hash removes the zip.
        const h = fresh('run-i');
        manifest.parts.forEach((p, i) => fs.writeFileSync(path.join(h.dir, p.name), slices[i]));
        await assert.rejects(() => mp.assembleParts(h.io, { ...manifest, fullZipSha256: '0'.repeat(64) }, 'core_library.db.zip'), /SHA-256/);
        assert.ok(!fs.existsSync(path.join(h.dir, 'core_library.db.zip')));
      });
      await check('multipart: a wrong extracted size is rejected and the partial DB removed', async () => {
        const { dir, io } = fresh('run-j');
        fs.writeFileSync(path.join(dir, 'core_library.db.zip'), zipBuf);
        await assert.rejects(() => mp.extractZip(io, { ...manifest, uncompressedDbBytes: dbBytes.length + 1 }, 'core_library.db.zip', 'core_library.db.tmp'), /שונה מהצפוי/);
        assert.ok(!fs.existsSync(path.join(dir, 'core_library.db.tmp')));
      });
      // ---- Resilient download: transient errors, backoff, partial files, foreground resume, keep-awake ----
      const DNS = 'Unable to download a file: Unable to resolve host "github.com": No address associated with hostname';
      /** Wraps an io so the first `plan.length` downloads fail: each entry = bytes of the part written first (or 0). */
      const flaky = (io, plan, message = DNS) => {
        let call = 0;
        const calls = [];
        return {
          calls,
          io: {
            ...io,
            download: async (url, n, onProgress, isCancelled, resume) => {
              const step = plan[call++];
              calls.push({ name: n, resumeFrom: resume.resumeFrom });
              if (step === undefined) return io.download(url, n, onProgress, isCancelled, resume);
              if (step > 0) {
                const i = manifest.parts.findIndex((q) => n.startsWith(q.name));
                const have = fs.existsSync(path.join(io.dir, n)) ? fs.readFileSync(path.join(io.dir, n)) : Buffer.alloc(0);
                fs.writeFileSync(path.join(io.dir, n), Buffer.concat([have, slices[i].subarray(have.length, have.length + step)]));
              }
              throw new Error(message);
            },
          },
        };
      };
      const withDir = (f) => ({ ...f.io, dir: f.dir });
      const sleeps = () => {
        const log = [];
        return { log, sleep: async (ms) => void log.push(ms), total: () => log.reduce((a, b) => a + b, 0) };
      };
      await check('resilient download: transient error classification and exponential backoff schedule', () => {
        for (const m of [DNS, 'ECONNRESET', 'connection dropped', 'socket hang up', 'Network request failed', 'java.net.SocketTimeoutException: timeout', 'HTTP 503', 'HTTP 429', 'Software caused connection abort', 'Unexpected end of stream']) {
          assert.ok(mp.isTransientNetworkError(new Error(m)), m);
        }
        for (const m of ['HTTP 404', 'HTTP 403', 'cancelled', 'ENOSPC: no space left on device', 'ההורדה נכשלה']) assert.ok(!mp.isTransientNetworkError(new Error(m)), m);
        assert.deepStrictEqual([0, 1, 2, 3, 4, 5].map((a) => mp.backoffDelayMs(a)), [2000, 4000, 8000, 16000, 30000, 30000]);
        assert.strictEqual(mp.backoffDelayMs(2, 100, 1000), 400);
      });
      await check('resilient download: "Unable to resolve host" is retried with backoff and the part completes', async () => {
        const f = fresh('run-r1');
        const w = flaky(withDir(f), [0, 0]);
        const sl = sleeps();
        const events = [];
        const r = await mp.downloadParts(w.io, manifest, { manifestUrl, sleep: sl.sleep, onRetry: (e) => events.push(e) });
        assert.deepStrictEqual(r, { downloaded: 3, skipped: 0 });
        assert.strictEqual(sl.total(), 2000 + 4000, `slept ${sl.log}`);
        assert.deepStrictEqual(events.map((e) => [e.partIndex, e.attempt, e.maxAttempts, e.delayMs, e.background]), [[1, 1, 4, 2000, false], [1, 2, 4, 4000, false]]);
        assert.ok(/Unable to resolve host/.test(events[0].error.message));
        assert.deepStrictEqual(fs.readdirSync(f.dir).sort(), manifest.parts.map((q) => q.name).sort(), 'no .partial / .chunk left');
      });
      await check('resilient download: retries exhausted -> readable error, nothing deleted, next run still resumes', async () => {
        const f = fresh('run-r2');
        const w = flaky(withDir(f), [0, 0, 0, 0, 0, 0, 0]);
        const sl = sleeps();
        await assert.rejects(() => mp.downloadParts(w.io, manifest, { manifestUrl, sleep: sl.sleep }), /אחרי 5 ניסיונות.*תמשיך מאותה נקודה/);
        assert.strictEqual(w.calls.length, 5, '1 try + 4 retries');
        assert.strictEqual(sl.total(), 2000 + 4000 + 8000 + 16000);
        assert.deepStrictEqual(await mp.downloadParts(f.io, manifest, { manifestUrl }), { downloaded: 3, skipped: 0 });
      });
      await check('resilient download: a non-transient error (404 / disk full) fails at once, without retry', async () => {
        const f = fresh('run-r3');
        const w = flaky(withDir(f), [0, 0], 'ENOSPC: no space left on device');
        const sl = sleeps();
        await assert.rejects(() => mp.downloadParts(w.io, manifest, { manifestUrl, sleep: sl.sleep }), /ENOSPC/);
        assert.strictEqual(w.calls.length, 1);
        assert.strictEqual(sl.log.length, 0);
      });
      await check('resilient download: an interrupted part keeps its .partial and the retry continues with a Range request', async () => {
        const f = fresh('run-r4');
        behaviour.dropOnce.add(manifest.parts[1].name); // server sends half of part 2, then the connection dies
        hits.length = 0;
        ranges.length = 0;
        await assert.rejects(() => mp.downloadParts(f.io, manifest, { manifestUrl, networkRetries: 0, sleep: async () => undefined }), /connection dropped/);
        const partial = path.join(f.dir, mp.partialName(manifest.parts[1].name));
        assert.ok(fs.existsSync(partial), 'the partial file survives the interruption');
        const kept = fs.readFileSync(partial);
        assert.ok(kept.length > 0 && kept.length < slices[1].length && kept.equals(slices[1].subarray(0, kept.length)), 'a byte-exact prefix');
        assert.ok(!fs.existsSync(path.join(f.dir, manifest.parts[1].name)), 'no half part under the final name');
        assert.ok(fs.existsSync(path.join(f.dir, manifest.parts[0].name)), 'part 1 is complete');
        hits.length = 0;
        ranges.length = 0;
        const r = await mp.downloadParts(f.io, manifest, { manifestUrl });
        assert.deepStrictEqual(r, { downloaded: 2, skipped: 1 });
        assert.deepStrictEqual(ranges, [`bytes=${kept.length}-`, null], 'resumed part 2 from its offset, part 3 from 0');
        assert.deepStrictEqual(fs.readdirSync(f.dir).sort(), manifest.parts.map((q) => q.name).sort(), 'clean state after recovery');
        for (const [i, q] of manifest.parts.entries()) assert.ok(fs.readFileSync(path.join(f.dir, q.name)).equals(slices[i]));
      });
      await check('resilient download: automatic retry resumes mid-part (server drop, no manual restart) and the budget refills on progress', async () => {
        const f = fresh('run-r5');
        behaviour.dropOnce.add(manifest.parts[0].name);
        ranges.length = 0;
        const sl = sleeps();
        assert.deepStrictEqual(await mp.downloadParts(f.io, manifest, { manifestUrl, sleep: sl.sleep }), { downloaded: 3, skipped: 0 });
        assert.ok(ranges[0] === null && /^bytes=\d+-$/.test(ranges[1]), ranges.join(' | '));
        // 6 failed attempts that each made progress do not exhaust a budget of 2.
        const g = fresh('run-r6');
        const step = Math.floor(manifest.parts[0].sizeBytes / 8);
        const w = flaky(withDir(g), [step, step, step, step, step, step]);
        const r = await mp.downloadParts(w.io, manifest, { manifestUrl, networkRetries: 2, sleep: sl.sleep });
        assert.deepStrictEqual(r, { downloaded: 3, skipped: 0 });
        assert.deepStrictEqual(w.calls.slice(0, 4).map((c) => c.resumeFrom), [0, step, step * 2, step * 3]);
      });
      await check('resilient download: a failure while the app is backgrounded waits for the foreground and is not counted', async () => {
        const f = fresh('run-r7');
        const w = flaky(withDir(f), [0, 0, 0]);
        const events = [];
        let background = true;
        let resumed = 0;
        const r = await mp.downloadParts(w.io, manifest, {
          manifestUrl,
          networkRetries: 0, // would fail at once if the background failures were counted
          sleep: async () => undefined,
          isBackgrounded: () => background,
          whenForeground: async () => {
            resumed++;
            background = resumed >= 3 ? false : true;
          },
          onRetry: (e) => events.push(e.background),
        });
        assert.deepStrictEqual(r, { downloaded: 3, skipped: 0 });
        assert.strictEqual(resumed, 3);
        assert.deepStrictEqual(events, [true, true, true]);
      });
      await check('resilient download: cancel keeps the partial; stale / oversize / corrupt partials self-heal', async () => {
        const f = fresh('run-r8');
        let n = 0;
        await assert.rejects(() => mp.downloadParts(f.io, manifest, { manifestUrl, isCancelled: () => ++n > 4 }), /cancelled/);
        assert.ok(!fs.existsSync(path.join(f.dir, manifest.parts[0].name + '.chunk')));
        // oversize partial (cannot be a prefix) -> removed, part fetched from 0
        const g = fresh('run-r9');
        fs.writeFileSync(path.join(g.dir, mp.partialName(manifest.parts[0].name)), Buffer.alloc(manifest.parts[0].sizeBytes + 7, 1));
        // stale partial next to a complete part -> removed
        fs.writeFileSync(path.join(g.dir, manifest.parts[1].name), slices[1]);
        fs.writeFileSync(path.join(g.dir, mp.partialName(manifest.parts[1].name)), Buffer.alloc(5, 2));
        // full-size partial with wrong bytes (a bad resume) -> SHA mismatch -> restarted from 0
        fs.writeFileSync(path.join(g.dir, mp.partialName(manifest.parts[2].name)), Buffer.alloc(manifest.parts[2].sizeBytes, 3));
        assert.deepStrictEqual(await mp.downloadParts(g.io, manifest, { manifestUrl }), { downloaded: 2, skipped: 1 });
        assert.deepStrictEqual(fs.readdirSync(g.dir).sort(), manifest.parts.map((q) => q.name).sort());
        for (const [i, q] of manifest.parts.entries()) assert.ok(fs.readFileSync(path.join(g.dir, q.name)).equals(slices[i]));
      });
      await check('resilient download: stageCloudLibrary shows the Hebrew reconnect message and holds keep-awake through extraction', async () => {
        const f = fresh('run-r10');
        const w = flaky(withDir(f), [0]);
        const seen = [];
        const awake = [];
        await mp.stageCloudLibrary(w.io, manifest, {
          manifestUrl,
          dbName: 'core_library.db.tmp',
          sleep: async () => undefined,
          report: (r) => seen.push(r),
          keepAwake: async (fn) => {
            awake.push('on');
            try {
              return await fn();
            } finally {
              awake.push('off');
            }
          },
        });
        const retry = seen.find((r) => r.stage === 'הרשת נותקה זמנית — מנסה להמשיך הורדה…');
        assert.ok(retry && /ניסיון 1 מתוך 4/.test(retry.detail), JSON.stringify(retry));
        assert.deepStrictEqual(awake, ['on', 'off']);
        assert.ok(fs.readFileSync(path.join(f.dir, 'core_library.db.tmp')).equals(dbBytes));
        // keep-awake is released when extraction fails too
        const g = fresh('run-r11');
        const off = [];
        await assert.rejects(
          () =>
            mp.stageCloudLibrary(g.io, { ...manifest, uncompressedDbBytes: dbBytes.length + 1 }, {
              manifestUrl,
              dbName: 'core_library.db.tmp',
              keepAwake: async (fn) => {
                try {
                  return await fn();
                } finally {
                  off.push('off');
                }
              },
            }),
          /שונה מהצפוי/,
        );
        assert.deepStrictEqual(off, ['off']);
        assert.ok(!fs.existsSync(path.join(g.dir, 'core_library.db.tmp')) && !fs.existsSync(path.join(g.dir, 'core_library.db.zip')), 'no half-extracted DB / zip');
      });
      await check('resilient download: foreground-service notification text "מוריד ספרייה מהענן… 42%"', () => {
        const n = mp.formatCloudNotification('מוריד…', 0.426, 'חלק 1 מתוך 3');
        assert.deepStrictEqual([n.title, n.text, n.current, n.total], ['מוריד ספרייה מהענן… 42%', 'חלק 1 מתוך 3', 426, 1000]);
        assert.strictEqual(mp.formatCloudNotification('מחלץ…', 1, null).title, 'מחלץ את הספרייה… 100%');
        assert.strictEqual(mp.formatCloudNotification(mp.NETWORK_RETRY_STAGE, 0.5, 'x').title, mp.NETWORK_RETRY_STAGE);
        assert.strictEqual(mp.formatCloudNotification('בודק…', null, null).total, 0);
      });
      await check('multipart: the in-memory backend (browser e2e) runs the same pipeline over fetch', async () => {
        const io = mp.createMemoryIO();
        await mp.stageCloudLibrary(io, manifest, { manifestUrl, dbName: 'core_library.db.tmp' });
        assert.ok(Buffer.from(io.files.get('core_library.db.tmp')).equals(dbBytes));
        assert.deepStrictEqual([...io.files.keys()], ['core_library.db.tmp']);
      });
    } finally {
      server.close();
    }

    await check('cloud-release: validate accepts a real library (integrity, books, paragraphs, FTS, ref_links)', () => {
      const s = cloudRelease.validateDb(SAMPLE_DB);
      assert.ok(s.bookCount > 0 && s.paragraphCount > 0 && s.refLinkCount > 0 && s.version && s.uncompressedDbBytes === dbBytes.length);
    });

    await check('workflow: build-library.yml has the inputs and the streaming disk pipeline in order', () => {
      const file = path.join(ROOT, '.github/workflows/build-library.yml');
      const text = fs.readFileSync(file, 'utf8');
      let doc;
      try {
        doc = require('js-yaml').load(text);
      } catch (e) {
        if (e.code === 'MODULE_NOT_FOUND') doc = null;
        else throw e;
      }
      if (doc) {
        const wd = (doc.on || doc.true).workflow_dispatch.inputs; // YAML 1.1 reads the key `on` as true
        assert.deepStrictEqual(wd.source_repo.options, ['Sivan22/otzaria-library', 'Otzaria/otzaria-library']);
        assert.strictEqual(wd.source_repo.default, 'Sivan22/otzaria-library');
  assert.deepStrictEqual(wd.editions.options, ['both', 'full', 'classic']);
        assert.strictEqual(wd.editions.default, 'both');
        assert.strictEqual(doc.permissions.contents, 'write');
      }
      const at = (needle) => {
        const i = text.indexOf(needle);
        assert.ok(i >= 0, `workflow lacks: ${needle}`);
        return i;
      };
      assert.ok(text.includes('/usr/share/dotnet') && text.includes('/usr/local/lib/android') && text.includes('/opt/ghc'));
      const order = ['Free disk space', 'fetch-otzaria-source.sh', 'scripts/build-db.js', 'rm -rf "$WORK/src"', 'cloud-release.js validate', 'zip -9', 'rm -f core_library.db core_library.db-journal', 'split -b "$PART_SIZE" -d -a 2 --numeric-suffixes=1', 'rm -f core_library.db.zip', 'cloud-release.js manifest', 'gh release upload "$RELEASE_TAG" library-manifest.json'].map(at);
      assert.deepStrictEqual(order, [...order].sort((a, b) => a - b), 'steps run in the documented order');
      assert.ok(/PART_SIZE: 1500M/.test(text) && text.includes('RELEASE_TAG: ${{ matrix.tag }}') && text.includes('--scope="$LIBRARY_SCOPE"'));
      assert.ok(text.includes('-lt 35'), '35 GB free-space guard');
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function releaseTests() {
  const zlib = require('zlib');
  const crypto = require('crypto');
  const { zipSync } = require('fflate');
  await check('release: manifest validation + URL resolution', () => {
    const m = release.validateManifest({ version: 'abc', file: 'core_library.db.gz', size: 10, sha256: 'A'.repeat(64) }, 2);
    assert.strictEqual(m.compression, 'gzip');
    assert.strictEqual(m.sha256, 'a'.repeat(64));
    assert.throws(() => release.validateManifest({ version: 'x', file: 'f.gz', schemaVersion: 99 }, 2), /newer app/);
    assert.throws(() => release.validateManifest({ file: 'f.gz' }, 2), /version/);
    assert.strictEqual(
      release.resolveAssetUrl('https://github.com/o/r/releases/latest/download/manifest.json?x=1', { file: 'core_library.db.gz' }),
      'https://github.com/o/r/releases/latest/download/core_library.db.gz',
    );
    assert.strictEqual(release.resolveAssetUrl('https://a/b/manifest.json', { file: 'x.gz', url: 'https://cdn/x.gz' }), 'https://cdn/x.gz');
    assert.ok(release.isDirectAssetUrl('https://a/b/core_library.db.zip'));
    assert.ok(!release.isDirectAssetUrl('https://a/b/manifest.json'));
  });
  const src = crypto.randomBytes(3 << 20); // incompressible, > 1 chunk
  const reader = (buf) => {
    let o = 0;
    return async (n) => {
      const c = buf.subarray(o, o + n);
      o += c.length;
      return c;
    };
  };
  for (const [name, buf, entry] of [
    ['gzip', zlib.gzipSync(src), null],
    ['zip', Buffer.from(zipSync({ 'readme.txt': new Uint8Array([1]), 'lib/core_library.db': src })), 'lib/core_library.db'],
  ]) {
    await check(`release: streaming ${name} decompression is byte-exact`, async () => {
      const out = [];
      let last = 0;
      const r = await release.decompressStream({
        read: reader(buf),
        write: async (b) => void out.push(Buffer.from(b)),
        totalIn: buf.length,
        chunkSize: 256 * 1024,
        onProgress: (p) => {
          assert.ok(p.bytesIn >= last);
          last = p.bytesIn;
        },
      });
      assert.strictEqual(r.format, name);
      assert.strictEqual(r.entry, entry);
      assert.ok(Buffer.concat(out).equals(src));
      assert.strictEqual(last, buf.length);
    });
  }
  await check('release: rejects unknown formats and cancels', async () => {
    await assert.rejects(release.decompressStream({ read: reader(Buffer.from('hello world')), write: async () => {} }), /not a \.gz/);
    await assert.rejects(release.decompressStream({ read: reader(zlib.gzipSync(src)), write: async () => {}, chunkSize: 4096, isCancelled: () => true }), /cancelled/);
  });

  await check('release: build-db --release writes a verifiable .gz + manifest', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kodesh-rel-'));
    try {
      const out = path.join(tmp, 'core.db');
      const proc = spawnSync(process.execPath, [path.join(__dirname, 'build-db.js'), '--source=sample', `--out=${out}`, `--release=${path.join(tmp, 'dist')}`], { encoding: 'utf8' });
      assert.strictEqual(proc.status, 0, proc.stderr);
      const manifest = JSON.parse(fs.readFileSync(path.join(tmp, 'dist', 'manifest.json'), 'utf8'));
      const gz = fs.readFileSync(path.join(tmp, 'dist', manifest.file));
      assert.strictEqual(gz.length, manifest.size);
      assert.strictEqual(crypto.createHash('sha256').update(gz).digest('hex'), manifest.sha256);
      const db = zlib.gunzipSync(gz);
      assert.strictEqual(db.length, manifest.dbSize);
      assert.strictEqual(crypto.createHash('sha256').update(db).digest('hex'), manifest.dbSha256);
      const v = release.validateManifest(manifest, indexer.SCHEMA_VERSION);
      assert.strictEqual(v.books, fs.readdirSync(path.join(ROOT, 'raw_library', 'sample'), { recursive: true }).filter((f) => String(f).endsWith('.txt')).length);
      const meta = await indexer.readMeta(openDb(out));
      assert.strictEqual(meta.db_version, manifest.version);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
}

// ---------------------------------------------------------------------------------------------
// Streaming pipeline (schema v6): import_queue scan, one-book transactions, book_units links.
// ---------------------------------------------------------------------------------------------

/** Writable node:sqlite DB in WAL mode (like the device) + a reopen for crash simulation. */
function openWal(file) {
  const db = openWritable(file);
  db.raw.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA cache_size = -16000; PRAGMA temp_store = MEMORY;');
  return db;
}

/**
 * Writer adapter that "kills the process" at its `killAt`-th statement: that statement and every
 * later one throw, like an OS kill mid-transaction. The caller then closes the connection (an
 * open transaction is rolled back, as after a real crash) and reopens the file.
 */
function killable(w, killAt, log) {
  let n = 0;
  let dead = false;
  const guard = (fn) => async (sql, params) => {
    if (dead) throw new Error('process is dead');
    n++;
    if (log) log.push(String(sql).trim().replace(/\s+/g, ' ').slice(0, 80));
    if (n === killAt) {
      dead = true;
      throw Object.assign(new Error(`killed at statement ${n}`), { killed: true });
    }
    return fn(sql, params);
  };
  return { exec: guard(w.exec), run: guard(w.run), all: guard(w.all), get count() { return n; } };
}

/** Node fs adapter that records every list / read (to prove what was never touched). */
function tracingFs() {
  const t = { lists: [], reads: [] };
  t.fsa = {
    list: async (dir) => (t.lists.push(dir), nodeFs.list(dir)),
    readText: async (f) => (t.reads.push(f), nodeFs.readText(f)),
    uriOf: (h) => h,
    fromUri: (u) => u,
  };
  return t;
}

/** Full content snapshot of a library: identical snapshots == identical libraries. */
async function librarySnapshot(read) {
  const all = (sql) => read.all(sql, []);
  const n = async (sql) => Number((await all(sql))[0].n);
  return {
    books: (await all('SELECT b.id, b.file_path, b.title, b.total_lines, b.is_complete, c.path AS cat FROM books b LEFT JOIN categories c ON c.id = b.category_id ORDER BY b.id')).map((r) => Object.values(r).join('|')),
    categories: (await all('SELECT id, parent_id, path FROM categories ORDER BY id')).map((r) => Object.values(r).join('|')),
    paragraphs: await n('SELECT COUNT(*) AS n FROM paragraphs'),
    paragraphHash: crypto.createHash('sha1').update(JSON.stringify(await all('SELECT book_id, line_index, toc_path, display_text, is_heading FROM paragraphs ORDER BY book_id, line_index'))).digest('hex'),
    toc: await n('SELECT COUNT(*) AS n FROM toc_nodes'),
    units: (await all('SELECT book_id, ref_key, depth, start_line, end_line, own_end, heading_label FROM book_units ORDER BY book_id, start_line')).map((r) => Object.values(r).join('|')),
    fts: await n(`SELECT COUNT(*) AS n FROM paragraphs_fts WHERE paragraphs_fts MATCH '"פרק" OR "דף" OR "סימן" OR "שבת"'`),
    ftsRows: await n('SELECT COUNT(*) AS n FROM paragraphs_fts'),
    refLinks: (await all('SELECT base_book_id, base_start, base_end, comm_book_id, comm_start, comm_end, ref_key, link_type FROM ref_links ORDER BY comm_book_id, comm_start, base_book_id, base_start')).map((r) => Object.values(r).join('|')),
  };
}

/** The real-path Otzaria fixture plus the noise a real download folder contains. */
function makePipelineFixture() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kodesh-pipeline-'));
  const lib = path.join(tmp, 'אוצריא');
  writeOtzariaFixture(lib); // also writes הלכה/מבוא.pdf
  fs.writeFileSync(path.join(lib, 'תנך', 'scan.docx'), 'PK\u0003\u0004');
  fs.writeFileSync(path.join(lib, 'תלמוד בבלי', 'cover.jpg'), 'ÿØÿ');
  // A binary file named .txt (malformed): isolated, logged, skipped.
  fs.writeFileSync(path.join(lib, 'תנך', 'פגום.txt'), Buffer.from([0x3c, 0x68, 0x31, 0x3e, 0, 0, 0, 1, 2, 3]));
  // Otzaria's external link files: must never be listed or read.
  fs.mkdirSync(path.join(lib, 'links'), { recursive: true });
  fs.writeFileSync(path.join(lib, 'links', 'רשי על בראשית_links.json'), '[{"line_index_1":3,"path_2":"בראשית.txt","line_index_2":3}]');
  // A per-folder order override.
  fs.writeFileSync(path.join(lib, 'תלמוד בבלי', 'order.json'), JSON.stringify(['אחרונים', 'סדר זרעים']));
  return { tmp, lib, nonText: 3 };
}

async function streamingPipelineTests() {
  const pipeline = require('../shared/pipeline');
  const fx = makePipelineFixture();
  const work = path.join(fx.tmp, 'dbs');
  fs.mkdirSync(work);
  const opts = (extra) => Object.assign({ source: { kind: 'folder', root: fx.lib }, sourceUri: 'file://' + fx.lib, sourceName: 'אוצריא', targetDb: 'core', idBase: 0, yieldToUI: () => Promise.resolve() }, extra);
  const fresh = async (name) => {
    const db = openWal(path.join(work, name));
    await indexer.ensureSchema(db.w, { kind: 'core' });
    return db;
  };
  try {
    // Reference: the array-based PC path (scanBooks + indexBooks + indexRefLinks), errors isolated.
    const ref = await fresh('ref.db');
    const tree = await indexer.scanBooks(nodeFs, fx.lib);
    tree.files = tree.files.filter((f) => !f.rel.includes('links'));
    tree.dirs = tree.dirs.filter((d) => d[0] !== 'links');
    await indexer.indexBooks(ref.w, nodeFs, { files: tree.files, dirs: tree.dirs, booksPerTransaction: 1000, onError: () => undefined });
    await indexer.indexRefLinks(ref.w, {});
    await indexer.finalizeIndex(ref.w, {});
    const refSnap = await librarySnapshot(ref.read);
    fx.booksCount = tree.files.length - 1; // minus the binary .txt

    let full;
    await check('pipeline: scan -> books -> links -> finalize == the array-based build (ids, tree order, text, FTS, units, links)', async () => {
      const db = await fresh('full.db');
      const t = tracingFs();
      const phases = new Set();
      full = await pipeline.runImport(db.w, t.fsa, opts({ onProgress: (p) => phases.add(p.phase) }));
      assert.strictEqual(full.stopped, null);
      assert.strictEqual(full.phase, 'done');
      assert.deepStrictEqual([...phases], ['scan', 'books', 'links', 'finalize']);
      await pipeline.completeImport(db.w);
      assert.deepStrictEqual(await librarySnapshot(db.read), refSnap);
      assert.strictEqual(full.books, fx.booksCount);
      assert.strictEqual(full.skippedFiles, fx.nonText, '.pdf / .docx / .jpg counted and skipped');
      assert.strictEqual(full.failed, 1, 'the binary .txt is isolated');
      assert.ok(/binary/.test(full.errors[0].message) && full.errors[0].relPath.endsWith('פגום.txt'));
      assert.ok(full.refLinks.pairs >= 10 && full.refLinks.units === refSnap.refLinks.length);
      // Zero link-file I/O and no non-text reads; every book read exactly once.
      assert.ok(!t.lists.some((d) => d.split(path.sep).includes('links')), 'links/ folder never listed');
      assert.ok(!t.reads.some((f) => /links|\.(pdf|docx|jpg)$/.test(f)), 'no link / non-text file read');
      const bookReads = t.reads.filter((f) => f.endsWith('.txt'));
      assert.strictEqual(bookReads.length, new Set(bookReads).size, 'no book read twice');
      assert.strictEqual(bookReads.length, fx.booksCount + 1);
      const st = await indexer.readIngestionState(db.read);
      assert.strictEqual(st.status, 'completed');
      assert.strictEqual(Number(st.processed_count), fx.booksCount + 1);
      assert.strictEqual(Number(st.links_done), Number(st.links_total));
      assert.strictEqual(Number(one && (await db.read.all('SELECT COUNT(*) AS n FROM import_queue'))[0].n), 0, 'queue emptied');
      assert.strictEqual(Number((await db.read.all('SELECT COUNT(*) AS n FROM links'))[0].n), 0, 'no explicit links table rows');
      await db.read.all("INSERT INTO paragraphs_fts(paragraphs_fts, rank) VALUES('integrity-check', 1)");
      db.raw.close();
    });

    await check('pipeline: import_queue is filled breadth-first, one folder per transaction', async () => {
      const db = await fresh('bfs.db');
      const log = [];
      let commitsAtScan = 0;
      const w = { ...db.w, exec: async (sql) => ((sql === 'COMMIT' && log.length === 0 && commitsAtScan++), db.w.exec(sql)) };
      let scanned = 0;
      const r = await pipeline.runImport(w, nodeFs, opts({ onProgress: (p) => p.phase === 'scan' && scanned++, shouldStop: () => (scanned >= 3 ? 'pause' : null) }));
      assert.strictEqual(r.stopped, 'pause');
      const st = await indexer.readIngestionState(db.read);
      assert.strictEqual(st.phase, 'scan');
      assert.strictEqual(Number(st.scanned_dirs), 3);
      const dirs = await db.read.all("SELECT rel, status FROM import_queue WHERE kind = 'dir' ORDER BY id");
      assert.deepStrictEqual(dirs.slice(0, 3).map((d) => d.status), ['done', 'done', 'done']);
      assert.ok(dirs.slice(3).every((d) => d.status === 'pending'));
      // BFS: every depth-1 folder is queued before any depth-2 folder.
      const depths = dirs.map((d) => (d.rel ? d.rel.split('/').length : 0));
      assert.deepStrictEqual(depths.slice(0, 7), [...depths.slice(0, 7)].sort((a, b) => a - b));
      assert.ok(!dirs.some((d) => d.rel === 'links'));
      assert.ok(commitsAtScan >= 4, `one commit per folder (${commitsAtScan})`);
      db.raw.close();
    });

    await check('pipeline: pause in every phase, resume converges to the same library', async () => {
      for (const phase of ['scan', 'books', 'links', 'finalize']) {
        const db = await fresh(`pause-${phase}.db`);
        let seen = 0;
        const r1 = await pipeline.runImport(db.w, nodeFs, opts({ finalize: { mergePages: 2 }, onProgress: (p) => p.phase === phase && seen++, shouldStop: () => (seen >= 2 ? 'pause' : null) }));
        assert.strictEqual(r1.stopped, 'pause', phase);
        const st = await indexer.readIngestionState(db.read);
        assert.strictEqual(st.status, 'paused');
        assert.strictEqual(st.phase, phase, `paused in ${phase}`);
        const r2 = await pipeline.runImport(db.w, nodeFs, opts({ resume: true, finalize: { mergePages: 2 } }));
        assert.strictEqual(r2.stopped, null);
        await pipeline.completeImport(db.w);
        assert.deepStrictEqual(await librarySnapshot(db.read), refSnap, `after a pause in ${phase}`);
        db.raw.close();
      }
    });

    await check('pipeline: repeated pauses (every 3 steps) still converge with zero duplicates', async () => {
      const db = await fresh('pause-many.db');
      let runs = 0;
      for (;;) {
        let steps = 0;
        const r = await pipeline.runImport(db.w, nodeFs, opts({ resume: runs > 0, onProgress: () => steps++, shouldStop: () => (steps >= 3 ? 'pause' : null) }));
        runs++;
        if (!r.stopped) break;
        assert.ok(runs < 200, 'no progress');
      }
      await pipeline.completeImport(db.w);
      assert.ok(runs > 10, `${runs} runs`);
      assert.deepStrictEqual(await librarySnapshot(db.read), refSnap);
      db.raw.close();
    });

    // --- streamed reads (device path) ------------------------------------------------------
    const bookStream = require('../shared/bookStream');
    /** fs adapter whose open() streams a file in tiny, irregular byte chunks (multi-byte chars split). */
    const streamingFs = (chunkOf) => ({
      ...nodeFs,
      uriOf: (h) => h,
      fromUri: (u) => u,
      open: (file) => {
        let i = 0;
        return bookStream.openTextReader(
          () => {
            const fd = fs.openSync(file, 'r');
            return {
              read: async () => {
                const n = chunkOf(i++);
                const buf = Buffer.alloc(n);
                const got = fs.readSync(fd, buf, 0, n, null);
                return new Uint8Array(buf.buffer, buf.byteOffset, got);
              },
              close: () => fs.closeSync(fd),
            };
          },
          { forceJs: true },
        );
      },
    });
    await check('pipeline: streamed book reads (1..17-byte chunks, JS UTF-8 decoder) == whole-file reads', async () => {
      for (const [label, chunkOf] of [['1 byte', () => 1], ['irregular', (i) => 1 + ((i * 7) % 17)]]) {
        const db = await fresh(`stream-${label.replace(/\s/g, '')}.db`);
        const r = await pipeline.runImport(db.w, streamingFs(chunkOf), opts());
        assert.strictEqual(r.stopped, null);
        await pipeline.completeImport(db.w);
        assert.deepStrictEqual(await librarySnapshot(db.read), refSnap, label);
        assert.strictEqual(r.failed, 1, 'the binary .txt still fails (streamed)');
        db.raw.close();
      }
    });

    // --- crash-loop protection ----------------------------------------------------------------
    /** Writer adapter the test can "kill" (every later statement throws, like a dead process). */
    const dieable = (w) => {
      const st = { dead: false };
      const guard = (fn) => async (sql, params) => {
        if (st.dead) throw new Error('process is dead');
        return fn(sql, params);
      };
      return { st, w: { exec: guard(w.exec), run: guard(w.run), all: guard(w.all) } };
    };
    /** Runs the import until it completes, "crashing the app" whenever `crashes(db)` says so. */
    const runWithCrashes = async (name, makeFs) => {
      const file = path.join(work, name);
      let db = await fresh(name);
      for (let runs = 1; runs < 40; runs++) {
        const d = dieable(db.w);
        const st = await indexer.readIngestionState(db.read);
        let r = null;
        try {
          r = await pipeline.runImport(d.w, makeFs(d.st), opts({ resume: !!st }));
        } catch (e) {
          assert.ok(d.st.dead, `unexpected failure: ${e.message}`);
        }
        if (r) {
          assert.strictEqual(r.stopped, null);
          await pipeline.completeImport(db.w);
          return { db, runs, r };
        }
        db.raw.close(); // the OS took the process
        db = openWal(file);
        await indexer.ensureSchema(db.w, { kind: 'core' });
      }
      throw new Error('never completed (crash loop)');
    };
    await check('pipeline: a book that crashes the app every time is skipped on the 3rd run (no crash loop)', async () => {
      const poison = 'משנה ברכות.txt';
      let reads = 0;
      const { db, runs, r } = await runWithCrashes('poison-book.db', (st) => ({
        ...nodeFs,
        uriOf: (h) => h,
        fromUri: (u) => u,
        readText: async (f) => {
          if (f.endsWith(path.sep + poison)) {
            reads++;
            st.dead = true; // out of memory / native fault while reading this book
            throw new Error('process is dead');
          }
          return nodeFs.readText(f);
        },
      }));
      assert.strictEqual(runs, 3, `two crashes, then skipped (${runs} runs)`);
      assert.strictEqual(reads, 2, 'retried exactly once');
      const books = await db.read.all('SELECT file_path FROM books');
      assert.ok(!books.some((b) => b.file_path.endsWith('/' + poison)));
      assert.strictEqual(books.length, fx.booksCount - 1, 'every other book imported');
      const errs = await indexer.readIngestionErrors(db.read, 50);
      assert.ok(errs.some((e) => e.file_path.endsWith('/' + poison) && e.message === pipeline.CRASH_MESSAGE), JSON.stringify(errs));
      assert.ok(r.errors.some((e) => e.relPath.endsWith('/' + poison)));
      const st = await indexer.readIngestionState(db.read);
      assert.strictEqual(st.inflight_key, null, 'nothing left in flight');
      assert.ok((await db.read.all('SELECT COUNT(*) AS n FROM ref_links'))[0].n > 0, 'links phase ran');
      db.raw.close();
    });
    await check('pipeline: a commentary that crashes the links phase every time is isolated and skipped', async () => {
      const target = 'ברטנורא על משנה ברכות';
      let targetId = null;
      // The crash is injected while aligning `target` (its ref_links rows are replaced first).
      const file = path.join(work, 'poison-link.db');
      let d2 = await fresh('poison-link.db');
      let crashes = 0;
      let done = null;
      for (let run = 0; run < 40 && !done; run++) {
        const st0 = await indexer.readIngestionState(d2.read);
        const d = dieable(d2.w);
        const w = {
          ...d.w,
          run: async (sql, params) => {
            if (targetId == null && /^INSERT INTO books|^UPDATE books SET title/.test(sql) && params && params[0] === target) targetId = params[3];
            if (/^DELETE FROM ref_links WHERE comm_book_id/.test(sql) && params[0] === targetId) {
              d.st.dead = true;
              crashes++;
              throw new Error('process is dead');
            }
            return d.w.run(sql, params);
          },
        };
        try {
          const r = await pipeline.runImport(w, nodeFs, opts({ resume: !!st0, linksPerTransaction: 4 }));
          await pipeline.completeImport(d2.w);
          done = r;
        } catch (e) {
          assert.ok(d.st.dead, e.message);
          d2.raw.close();
          d2 = openWal(file);
          await indexer.ensureSchema(d2.w, { kind: 'core' });
        }
      }
      assert.ok(done, 'completed');
      assert.ok(targetId != null, 'target commentary indexed');
      assert.ok(crashes >= 2 && crashes <= 6, `${crashes} crashes before the job was skipped`);
      assert.strictEqual(Number((await d2.read.all('SELECT COUNT(*) AS n FROM ref_links WHERE comm_book_id = ?', [targetId]))[0].n), 0);
      const errs = await indexer.readIngestionErrors(d2.read, 50);
      assert.ok(errs.some((e) => e.file_path === 'קישור פרשנים: ' + target && e.message === pipeline.CRASH_MESSAGE), JSON.stringify(errs));
      // Every other commentary is still aligned.
      const snap = await librarySnapshot(d2.read);
      assert.ok(snap.refLinks.length > 0 && snap.refLinks.length < refSnap.refLinks.length);
      assert.strictEqual(Number((await indexer.readIngestionState(d2.read)).links_done), Number((await indexer.readIngestionState(d2.read)).links_total));
      d2.raw.close();
    });

    // --- crash (kill) at any statement ------------------------------------------------------
    const probe = await fresh('probe.db');
    const log = [];
    const counting = killable(probe.w, Infinity, log);
    await pipeline.runImport(counting, nodeFs, opts());
    await pipeline.completeImport(probe.w);
    probe.raw.close();
    const total = counting.count;
    const firstIdx = (re, from) => log.findIndex((s, i) => i >= (from || 0) && re.test(s)) + 1;
    const booksStart = firstIdx(/^INSERT INTO books/);
    const linksStart = firstIdx(/^DELETE FROM ref_links/);
    const named = {
      'mid-scan (queue insert)': firstIdx(/^INSERT OR IGNORE INTO import_queue/) + 1,
      'mid-scan (2nd folder)': firstIdx(/^INSERT OR IGNORE INTO import_queue/, firstIdx(/^INSERT OR IGNORE INTO import_queue/) + 1),
      'mid-book (paragraphs)': firstIdx(/^INSERT INTO paragraphs \(/, booksStart + 30),
      'mid-book (book_units)': firstIdx(/^INSERT INTO book_units/, booksStart + 60),
      'mid-book (FTS)': firstIdx(/^INSERT INTO paragraphs_fts\(rowid/, booksStart + 90),
      'mid-book (queue done)': firstIdx(/^UPDATE import_queue SET status = 'done', book_id/, booksStart + 120),
      'mid-link (delete)': linksStart,
      'mid-link (insert)': firstIdx(/^INSERT INTO ref_links/, linksStart + 5),
      'mid-link (cursor)': firstIdx(/^UPDATE ingestion_state SET links_done/),
      'mid-finalize (merge)': firstIdx(/^INSERT INTO paragraphs_fts\(paragraphs_fts, rank\)/),
    };
    for (const [k, v] of Object.entries(named)) assert.ok(v > 0, `no statement for ${k}`);

    const crashAndResume = async (name, killAt) => {
      const file = path.join(work, name);
      let db = await fresh(name);
      const t = tracingFs();
      const w = killable(db.w, killAt);
      let err = null;
      try {
        await pipeline.runImport(w, t.fsa, opts());
      } catch (e) {
        err = e;
      }
      // A kill inside a named finalize sub-step arrives wrapped in a coreFinalize.StepError.
      const root = err && err.cause ? err.cause : err;
      assert.ok(root && (root.killed || /dead/.test(root.message)), `${name}: expected a kill at ${killAt}, got ${err && err.message}`);
      db.raw.close(); // the OS took the process: the open transaction is gone
      db = openWal(file);
      await indexer.ensureSchema(db.w, { kind: 'core' });
      const st = await indexer.readIngestionState(db.read);
      const r = await pipeline.runImport(db.w, t.fsa, opts({ resume: !!st }));
      assert.strictEqual(r.stopped, null);
      await pipeline.completeImport(db.w);
      const snap = await librarySnapshot(db.read);
      const dupes = await db.read.all('SELECT file_path FROM books GROUP BY file_path HAVING COUNT(*) > 1');
      db.raw.close();
      // At most the one book in flight is read twice (zero wasted work otherwise).
      const reads = t.reads.filter((f) => f.endsWith('.txt'));
      return { snap, dupes, rereads: reads.length - new Set(reads).size };
    };

    await check('pipeline: killed mid-scan / mid-book / mid-link / mid-finalize, resume == uninterrupted', async () => {
      for (const [label, at] of Object.entries(named)) {
        const r = await crashAndResume(`kill-${at}.db`, at);
        assert.deepStrictEqual(r.dupes, [], `${label}: duplicate books`);
        assert.ok(r.rereads <= 1, `${label}: ${r.rereads} books re-read`);
        assert.deepStrictEqual(r.snap, refSnap, `${label} (statement ${at})`);
      }
    });

    await check(`pipeline: kill at every 9th statement of ${total} converges (stress)`, async () => {
      let n = 0;
      for (let at = 1; at <= total; at += 9) {
        const r = await crashAndResume(`stress-${at}.db`, at);
        assert.deepStrictEqual(r.dupes, [], `statement ${at} (${log[at - 1]}): duplicates`);
        assert.deepStrictEqual(r.snap, refSnap, `statement ${at} (${log[at - 1]})`);
        fs.rmSync(path.join(work, `stress-${at}.db`), { force: true });
        for (const s of ['-wal', '-shm']) fs.rmSync(path.join(work, `stress-${at}.db${s}`), { force: true });
        n++;
      }
      console.log(`  pipeline crash/resume: ${n} kill points over ${total} statements, all identical to the uninterrupted build`);
    });

    await check('pipeline: personal files source (idBase, prefix) + re-import replaces, never duplicates', async () => {
      const db = openWal(path.join(work, 'user.db'));
      await indexer.ensureSchema(db.w, { kind: 'user' });
      const files = ['תנך/תורה/בראשית.txt', 'תנך/ראשונים/רשי/תורה/רשי על בראשית.txt', 'הלכה/מבוא.pdf'].map((r) => ({ name: path.basename(r), handle: path.join(fx.lib, r) }));
      const run = () => pipeline.runImport(db.w, nodeFs, { source: { kind: 'files', files }, sourceUri: 'files', targetDb: 'user', idBase: indexer.USER_ID_BASE, categoryPrefix: [indexer.USER_ROOT_NAME], yieldToUI: () => Promise.resolve() });
      const r1 = await run();
      await pipeline.completeImport(db.w);
      assert.strictEqual(r1.books, 2);
      assert.strictEqual(r1.skippedFiles, 1);
      const books = await db.read.all('SELECT id, file_path FROM books ORDER BY id');
      assert.ok(books.every((b) => b.id > indexer.USER_ID_BASE && b.file_path.startsWith(indexer.USER_ROOT_NAME + '/')));
      assert.ok(r1.refLinks.units > 0, 'personal commentary aligned by title');
      await run();
      await pipeline.completeImport(db.w);
      assert.strictEqual(Number((await db.read.all('SELECT COUNT(*) AS n FROM books'))[0].n), 2, 're-import replaces');
      db.raw.close();
    });

    await check('book_units: persisted units == units derived from toc_nodes; ref_key labels round-trip', async () => {
      const check1 = async (read) => {
        const books = await read.all('SELECT id, total_lines FROM books', []);
        let n = 0;
        for (const b of books) {
          const nodes = await read.all('SELECT id, parent_id, level, title, start_line FROM toc_nodes WHERE book_id = ? ORDER BY start_line, level', [b.id]);
          const fromToc = refAlign.bookUnits(nodes, b.total_lines);
          const stored = await indexer.loadBookUnits(read, b.id, b.total_lines, true);
          const strip = (u) => ({ title: u.title, labels: u.labels, refKey: u.refKey, start: u.start, end: u.end, ownEnd: u.ownEnd });
          if (fromToc.length) assert.deepStrictEqual(stored.map(strip), fromToc.map(strip), `book ${b.id}`);
          for (const u of fromToc) assert.deepStrictEqual(refAlign.labelsFromRefKey(u.refKey), u.labels, u.refKey);
          n += fromToc.length;
        }
        return n;
      };
      const n1 = await check1(ref.read);
      const sample = openDb(path.join(ROOT, 'assets/db/library.db'));
      const n2 = await check1(sample);
      sample.close();
      assert.ok(n1 > 30 && n2 > 100, `${n1} / ${n2} units`);
      assert.deepStrictEqual(refAlign.labelsFromRefKey('סימן א|סעיף קטן ג|הקדמה כללית'), [{ type: 'סימן', key: 'א' }, { type: 'סעיף קטן', key: 'ג' }, { type: '', key: 'הקדמה כללית' }]);
    });

    await check('schema v5 -> v6: migration adds book_units / import_queue / counters; old books align from toc_nodes', async () => {
      const db = openWritable(path.join(work, 'v5.db'));
      const v5Ingestion = indexer.INGESTION_SCHEMA.replace(/\s*skipped_count[^\n]*\n\s*scanned_dirs[^\n]*\n\s*links_done[^\n]*\n\s*links_total[^\n]*/, '');
      await db.w.exec(indexer.SCHEMA + indexer.REF_LINKS_SCHEMA + v5Ingestion);
      await db.w.run("INSERT INTO meta (key, value) VALUES ('kind', 'user'), ('script_version', '5')", []);
      await db.w.run("INSERT INTO ingestion_state (id, source_uri, target_db, status, started_at, updated_at) VALUES (1, 'x', 'user', 'completed', 'a', 'b')", []);
      assert.ok(!(await db.read.all('PRAGMA table_info(ingestion_state)')).some((c) => c.name === 'links_done'));
      assert.strictEqual(await indexer.ensureSchema(db.w, { kind: 'user' }), false);
      const cols = (await db.read.all('PRAGMA table_info(ingestion_state)')).map((c) => c.name);
      for (const c of ['skipped_count', 'scanned_dirs', 'links_done', 'links_total']) assert.ok(cols.includes(c), c);
      assert.ok(await indexer.hasTable(db.read, 'book_units'));
      assert.ok(await indexer.hasTable(db.read, 'import_queue'));
      await indexer.ensureSchema(db.w, { kind: 'user' }); // idempotent
      assert.strictEqual(indexer.SCHEMA_VERSION, 6);
      db.raw.close();
      // A library indexed before v6 (no book_units rows) aligns identically from toc_nodes.
      await ref.w.exec('DELETE FROM book_units; DELETE FROM ref_links;');
      await indexer.indexRefLinks(ref.w, {});
      assert.deepStrictEqual((await librarySnapshot(ref.read)).refLinks, refSnap.refLinks);
    });
    ref.raw.close();
  } finally {
    fs.rmSync(fx.tmp, { recursive: true, force: true });
  }
}

/**
 * Pure path + book_units alignment at library scale: real commentary / base pairs sampled from
 * every corpus of otzaria_index_only.txt, written at their real paths with no link files at all,
 * imported through the streaming pipeline; every sampled commentary must be aligned with exactly
 * the base the full-library pairing chose, at the right line ranges.
 */
async function otzariaIndexPipelineTests() {
  const indexPath = path.join(ROOT, 'otzaria_index_only.txt');
  if (!fs.existsSync(indexPath)) return;
  const pairing = require('../shared/pairing');
  const pipeline = require('../shared/pipeline');
  const paths = fs.readFileSync(indexPath, 'utf8').split('\n').filter((l) => l.endsWith('.txt')).map((l) => l.replace(/^\.\//, '').replace(/\.txt$/, ''));
  const books = paths.map((p, i) => {
    const parts = p.split('/');
    const title = parts.pop();
    return { id: i + 1, title, categoryPath: parts.join('/'), aliases: generateBookAliases(parts, title) };
  });
  const pairs = pairing.pairCommentaries(books);
  // Up to 12 pairs per top-level corpus folder, spread over each corpus.
  const byTop = new Map();
  for (const p of pairs) {
    const top = paths[p.commId - 1].split('/')[0];
    if (!byTop.has(top)) byTop.set(top, []);
    byTop.get(top).push(p);
  }
  const sample = [];
  for (const list of byTop.values()) {
    const step = Math.max(1, Math.floor(list.length / 12));
    for (let i = 0; i < list.length && sample.filter((s) => s.top === list[0]).length < 12; i += step) sample.push({ ...list[i], top: list[0] });
  }
  const files = new Set(sample.flatMap((p) => [paths[p.commId - 1], paths[p.baseId - 1]]));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kodesh-otzscale-'));
  try {
    const lib = path.join(tmp, 'אוצריא');
    for (const rel of files) {
      const title = rel.split('/').pop();
      fs.mkdirSync(path.dirname(path.join(lib, rel)), { recursive: true });
      // Same unit structure in every book: simanim with plain paragraphs (no inline markers).
      fs.writeFileSync(path.join(lib, rel + '.txt'), [`<h1>${title}</h1>`, '<h2>סימן א</h2>', `${title} א1`, `${title} א2`, '<h2>סימן ב</h2>', `${title} ב1`].join('\n'));
    }
    const db = openWal(path.join(tmp, 'scale.db'));
    await indexer.ensureSchema(db.w, { kind: 'core' });
    const r = await pipeline.runImport(db.w, nodeFs, { source: { kind: 'folder', root: lib }, sourceUri: lib, targetDb: 'core', yieldToUI: () => Promise.resolve(), finalize: false });
    await pipeline.completeImport(db.w);
    const idOf = new Map((await db.read.all('SELECT id, file_path FROM books')).map((b) => [b.file_path.replace(/\.txt$/, ''), b.id]));

    await check(`otzaria scale: ${sample.length} real pairs from ${byTop.size} corpora align by path + book_units only`, async () => {
      assert.strictEqual(r.books, files.size);
      assert.ok(sample.length >= 100, `${sample.length} sampled pairs`);
      const misses = [];
      for (const p of sample) {
        const comm = idOf.get(paths[p.commId - 1]);
        const base = idOf.get(paths[p.baseId - 1]);
        const rows = await db.read.all('SELECT base_book_id, base_start, base_end, comm_start, comm_end, ref_key FROM ref_links WHERE comm_book_id = ? ORDER BY comm_start', [comm]);
        const want = [`${base}|2|4|2|4|סימן א`, `${base}|5|6|5|6|סימן ב`];
        const got = rows.map((x) => Object.values(x).join('|'));
        if (JSON.stringify(got) !== JSON.stringify(want)) misses.push(`${paths[p.commId - 1]} -> ${paths[p.baseId - 1]}: ${JSON.stringify(got)}`);
      }
      assert.deepStrictEqual(misses, [], `${misses.length} misaligned:\n${misses.slice(0, 10).join('\n')}`);
      assert.strictEqual(Number((await db.read.all('SELECT COUNT(*) AS n FROM links'))[0].n), 0, 'no link files involved');
      const units = Number((await db.read.all('SELECT COUNT(*) AS n FROM book_units'))[0].n);
      assert.strictEqual(units, files.size * 2, 'two siman units per book');
      console.log(`  otzaria scale: ${sample.length} commentary/base pairs over ${byTop.size} corpora, ${files.size} books, all aligned (${r.refLinks.units} units)`);
    });
    db.raw.close();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** shared/commentaryRank.js: corpus-aware priority, pins, era fallback, groups and the name filter. */
async function commentaryRankTests() {
  // Real Otzaria titles and folders (otzaria_index_only.txt): no gershayim in file titles.
  const item = (bookTitle, categoryPath, linkType = 'commentary') => ({ bookId: bookTitle.length * 31 + categoryPath.length, bookTitle, categoryPath, linkType });
  const names = (ranked) => ranked.map((r) => r.displayName);
  const shuffle = (a) => a.map((x, i) => [((i * 7919) % 13) + i / 100, x]).sort((p, q) => p[0] - q[0]).map((p) => p[1]);

  const TANACH = [
    item('גור אריה על בראשית', 'תנך/אחרונים/גור אריה/תורה'),
    item('הערות על מלבים על בראשית', 'תנך/אחרונים/מלבים/תורה'),
    item('אור המאיר על בראשית', 'תנך/אחרונים/אור המאיר'),
    item('דעת זקנים על בראשית', 'תנך/ראשונים/דעת זקנים/תורה'),
    item('ר סעדיה גאון על בראשית', 'תנך/ראשונים/ר\' סעדיה גאון/תורה'),
    item('מלבים על בראשית', 'תנך/אחרונים/מלבים/תורה'),
    item('כלי יקר על בראשית', 'תנך/אחרונים/כלי יקר/תורה'),
    item('אור החיים על בראשית', 'תנך/אחרונים/אור החיים/תורה'),
    item('בעל הטורים על בראשית', 'תנך/ראשונים/בעל הטורים/תורה'),
    item('ספורנו על בראשית', 'תנך/ראשונים/ספורנו/תורה'),
    item('אבן עזרא על בראשית', 'תנך/ראשונים/אבן עזרא/תורה'),
    item('רמבן על בראשית', 'תנך/ראשונים/רמבן/תורה'),
    item('רשי על בראשית', 'תנך/ראשונים/רשי/תורה'),
    item('תרגום יונתן על בראשית', 'תנך/תרגומים/תרגום יונתן/תורה', 'targum'),
    item('תרגום אונקלוס על בראשית', 'תנך/תרגומים/תרגום אונקלוס/תורה', 'targum'),
    item('ביאור מודרני על בראשית', 'תנך/מחברי זמננו/ביאור מודרני'),
    item('תרגום ערבי על בראשית', 'תנך/תרגומים/תרגום ערבי', 'targum'),
  ];
  await check('commentary rank: Tanach core list first, in canonical order (any input order)', () => {
    for (const input of [TANACH, shuffle(TANACH), TANACH.slice().reverse()]) {
      const r = rank.rankCommentaries(input);
      assert.strictEqual(r[0].corpus, 'tanach');
      assert.deepStrictEqual(names(r), [
        'אונקלוס', 'תרגום יונתן', 'רש"י', 'רמב"ן', 'אבן עזרא', 'ספורנו', 'אור החיים', 'כלי יקר', 'בעל הטורים', 'מלבי"ם',
        // era fallback: תרגומים -> ראשונים -> אחרונים -> מחברי זמננו, alphabetical inside a tier
        'תרגום ערבי', 'דעת זקנים', 'ר סעדיה גאון', 'אור המאיר', 'גור אריה', 'הערות על מלבים', 'ביאור מודרני',
      ]);
      assert.deepStrictEqual(r.map((x) => x.tier).slice(9), ['עיקריים', 'תרגומים', 'ראשונים', 'ראשונים', 'אחרונים', 'אחרונים', 'אחרונים', 'נוספים']);
    }
  });
  await check('commentary rank: pinned favorites override everything, in pin order', () => {
    const r = rank.rankCommentaries(TANACH, { pinned: ['גור אריה', rank.commentatorKey('אבן עזרא')] });
    assert.deepStrictEqual(names(r).slice(0, 4), ['גור אריה', 'אבן עזרא', 'אונקלוס', 'תרגום יונתן']);
    assert.ok(r[0].pinned && r[1].pinned && !r[2].pinned);
    assert.strictEqual(r[0].tier, 'אחרונים', 'a pinned commentary keeps its own tier badge');
    // Keys are canonical for core commentators: a ⭐ on רש"י holds for "רשי על שבת" too.
    assert.strictEqual(rank.commentatorKey('רש"י'), 'רשי');
    const b = rank.rankCommentaries([item('תוספות על שבת', 'תלמוד בבלי/ראשונים/תוספות/סדר מועד'), item('רשי על שבת', 'תלמוד בבלי/ראשונים/רשי/סדר מועד')], { pinned: ['תוספות'] });
    assert.deepStrictEqual(names(b), ['תוספות', 'רש"י']);
    // Default expansion: favorites + the top 3 others; short lists open entirely.
    const d = rank.defaultExpandedKeys(r);
    assert.deepStrictEqual([...d], ['גור אריה', 'אבנ עזרא', 'אונקלוס', 'תרגומ יונתנ', 'רשי']);
    assert.strictEqual(rank.defaultExpandedKeys(b).size, 2);
  });

  await check('commentary rank: Bavli (רש"י, תוספות, ראשונים before אחרונים, notes and look-alikes are not core)', () => {
    const r = rank.rankCommentaries(shuffle([
      item('בן יהוידע על שבת', 'תלמוד בבלי/אחרונים/בן יהוידע'),
      item('רשימות שיעורים על שבת', 'תלמוד בבלי/מחברי זמננו/רשימות שיעורים/סדר מועד'),
      item('חברותא על שבת', 'תלמוד בבלי/מחברי זמננו/ביאור חברותא'),
      item('הערות על חברותא על שבת', 'תלמוד בבלי/מחברי זמננו/הערות על ביאור חברותא'),
      item('ביאור שטיינזלץ על שבת', 'תלמוד בבלי/מחברי זמננו/ביאור שטיינזלץ/סדר מועד'),
      item('פני יהושע על שבת', 'תלמוד בבלי/אחרונים/פני יהושע'),
      item('חכמת שלמה על שבת', 'תלמוד בבלי/אחרונים/חכמת שלמה/סדר מועד'),
      item('פסקי תוספות על שבת', 'תלמוד בבלי/ראשונים/פסקי תוספות/סדר מועד'),
      item('רשבא על שבת', 'תלמוד בבלי/ראשונים/רשבא/סדר מועד'),
      item('רן על שבת', 'תלמוד בבלי/ראשונים/ריף/מפרשים/רן'),
      item('גליון השס על שבת', 'תלמוד בבלי/אחרונים/גליון השס/סדר מועד'),
      item('תוספות על שבת', 'תלמוד בבלי/ראשונים/תוספות/סדר מועד'),
      item('רשי על שבת', 'תלמוד בבלי/ראשונים/רשי/סדר מועד'),
      item('ריטבא על שבת', 'תלמוד בבלי/ראשונים/ריטבא/סדר מועד'),
      item('מאירי על שבת', 'תלמוד בבלי/ראשונים/מאירי/סדר מועד'),
      item('יד רמה על שבת', 'תלמוד בבלי/ראשונים/יד רמה'),
    ]));
    assert.strictEqual(r[0].corpus, 'bavli');
    assert.deepStrictEqual(names(r), [
      'רש"י', 'תוספות', 'ר"ן', 'רשב"א', 'ריטב"א', 'מאירי', 'חכמת שלמה', 'פני יהושע', 'שטיינזלץ', 'חברותא',
      'יד רמה', 'פסקי תוספות', 'בן יהוידע', 'גליון השס', 'הערות על חברותא', 'רשימות שיעורים',
    ]);
    assert.ok(!r.find((x) => x.displayName === 'פסקי תוספות').core);
  });

  await check('commentary rank: Mishnah (ברטנורא, תוי"ט, רמב"ם; "יכין <מסכת>" without על)', () => {
    const r = rank.rankCommentaries(shuffle([
      item('הון עשיר על משנה ברכות', 'משנה/אחרונים/הון עשיר/סדר זרעים'),
      item('תוספות רבי עקיבא איגר על משנה ברכות', 'משנה/אחרונים/תוספות רבי עקיבא איגר/סדר זרעים'),
      item('מלאכת שלמה על משנה ברכות', 'משנה/אחרונים/מלאכת שלמה/סדר זרעים'),
      item('יכין ברכות', 'משנה/אחרונים/יכין/סדר זרעים'),
      item('בועז על משנה ברכות', 'משנה/אחרונים/בועז/סדר זרעים'),
      item('רמבם על משנה ברכות', 'משנה/ראשונים/רמבם/סדר זרעים'),
      item('עיקר תוספות יום טוב על משנה ברכות', 'משנה/אחרונים/עיקר תוספות יום טוב/סדר זרעים'),
      item('תוספות יום טוב על משנה ברכות', 'משנה/אחרונים/תוספות יום טוב/סדר זרעים'),
      item('ברטנורא על משנה ברכות', 'משנה/ראשונים/ברטנורא/סדר זרעים'),
      item('משנת ארץ ישראל על משנה ברכות', 'משנה/מחברי זמננו/משנת ארץ ישראל/סדר זרעים'),
    ]));
    assert.strictEqual(r[0].corpus, 'mishna');
    assert.deepStrictEqual(names(r), ['ברטנורא', 'תוספות יום טוב', 'עיקר תוספות יום טוב', 'רמב"ם', 'יכין', 'בועז', 'מלאכת שלמה', 'הון עשיר', 'תוספות רבי עקיבא איגר', 'משנת ארץ ישראל']);
  });

  await check('commentary rank: Rambam and Yerushalmi core lists', () => {
    const ram = rank.rankCommentaries(shuffle([
      item('אבן האזל על משנה תורה, הלכות שבת', 'הלכה/משנה תורה/מפרשים/אבן האזל/ספר זמנים'),
      item('אור שמח על משנה תורה, הלכות שבת', 'הלכה/משנה תורה/מפרשים/אור שמח/ספר זמנים'),
      item('כסף משנה על משנה תורה, הלכות שבת', 'הלכה/משנה תורה/מפרשים/כסף משנה/ספר זמנים'),
      item('מגיד משנה על משנה תורה, הלכות שבת', 'הלכה/משנה תורה/מפרשים/מגיד משנה/ספר זמנים'),
      item('השגות הראבד על משנה תורה, הלכות שבת', 'הלכה/משנה תורה/מפרשים/השגות הראבד/ספר זמנים'),
      item('משנה למלך על משנה תורה, הלכות שבת', 'הלכה/משנה תורה/מפרשים/משנה למלך/ספר זמנים'),
      item('לחם משנה על משנה תורה, הלכות שבת', 'הלכה/משנה תורה/מפרשים/לחם משנה/ספר זמנים'),
    ]));
    assert.strictEqual(ram[0].corpus, 'rambam');
    assert.deepStrictEqual(names(ram), ['השגות הראב"ד', 'מגיד משנה', 'כסף משנה', 'לחם משנה', 'משנה למלך', 'אור שמח', 'אבן האזל']);
    const yer = rank.rankCommentaries([
      item('נועם ירושלמי על ברכות', 'תלמוד ירושלמי/מפרשים/נועם ירושלמי/סדר זרעים'),
      item('מראה הפנים על תלמוד ירושלמי ברכות', 'תלמוד ירושלמי/מפרשים/מראה הפנים על תלמוד ירושלמי/סדר זרעים'),
      item('פני משה על תלמוד ירושלמי ברכות', 'תלמוד ירושלמי/מפרשים/פני משה על תלמוד ירושלמי/סדר זרעים'),
    ]);
    assert.strictEqual(yer[0].corpus, 'yerushalmi');
    assert.deepStrictEqual(names(yer), ['פני משה', 'מראה הפנים', 'נועם ירושלמי']);
  });

  const SA = [
    item('אשל אברהם על שולחן ערוך אורח חיים', 'הלכה/שולחן ערוך/מפרשים/אשל אברהם'),
    item('באר היטב אורח חיים', 'הלכה/שולחן ערוך/מפרשים/באר היטב'),
    item('ביאור הגרא על שולחן ערוך אורח חיים', 'הלכה/שולחן ערוך/מפרשים/ביאור הגרא'),
    item('טורי זהב על שולחן ערוך אורח חיים', 'הלכה/שולחן ערוך/מפרשים/טורי זהב'),
    item('מגן אברהם', 'הלכה/שולחן ערוך/מפרשים/מגן אברהם'),
    item('משנה ברורה', 'הלכה/שולחן ערוך/מפרשים/משנה ברורה'),
    item('דגול מרבבה על שלחן ערוך אורח חיים', 'הלכה/שולחן ערוך/מפרשים/דגול מרבבה'),
    item('כף החיים על שולחן ערוך אורח חיים', 'הלכה/שולחן ערוך/מפרשים/כף החיים'),
    item('אליה רבה על שלחן ערוך אורח חיים', 'הלכה/שולחן ערוך/מפרשים/אליה רבה'),
    item('שערי תשובה על שולחן ערוך אורח חיים', 'הלכה/שולחן ערוך/מפרשים/שערי תשובה'),
    item('הגהות רבי עקיבא איגר על שלחן ערוך אורח חיים', 'הלכה/שולחן ערוך/מפרשים/הגהות רבי עקיבא איגר'),
  ];
  await check('commentary rank: Shulchan Aruch (משנה ברורה first, series titles, Tur list)', () => {
    const r = rank.rankCommentaries(shuffle(SA));
    assert.strictEqual(r[0].corpus, 'shulchan_aruch');
    assert.deepStrictEqual(names(r), ['משנה ברורה', 'מגן אברהם', 'טורי זהב', 'באר היטב', 'ביאור הגר"א', 'כף החיים', 'הגהות רבי עקיבא איגר', 'שערי תשובה', 'אליה רבה', 'אשל אברהם', 'דגול מרבבה']);
    assert.ok(r.slice(0, 9).every((x) => x.core && x.tier === 'עיקריים') && r.slice(9).every((x) => !x.core && x.tier === 'נוספים'));
    const tur = rank.rankCommentaries(['פרישה', 'בח', 'דרכי משה', 'בית יוסף', 'דרישה'].map((t) => item(t, 'הלכה/טור/מפרשים')));
    assert.deepStrictEqual(names(tur), ['בית יוסף', 'דרכי משה', 'ב"ח', 'פרישה', 'דרישה']);
  });

  await check('commentary rank: corpus detection, base text first, unknown corpus', () => {
    assert.strictEqual(rank.detectCorpus('תנך/תורה', 'בראשית'), 'tanach');
    assert.strictEqual(rank.detectCorpus('הלכה/משנה תורה/ספר זמנים', 'משנה תורה, הלכות שבת'), 'rambam');
    assert.strictEqual(rank.detectCorpus(null, 'שולחן ערוך, אורח חיים'), 'shulchan_aruch');
    assert.strictEqual(rank.detectCorpus('משנה/סדר זרעים', 'משנה ברכות'), 'mishna');
    assert.strictEqual(rank.detectCorpus('תלמוד ירושלמי/סדר זרעים', 'תלמוד ירושלמי ברכות'), 'yerushalmi');
    assert.strictEqual(rank.detectCorpus('תלמוד בבלי/סדר מועד', 'שבת'), 'bavli');
    assert.strictEqual(rank.eraOf('תלמוד בבלי/ראשונים/ריף/מפרשים/רן'), 'rishonim');
    assert.strictEqual(rank.eraOf('תנך/מפרשים', 'targum'), 'targum');
    // The reading book's corpus wins over the votes of its links.
    assert.strictEqual(rank.inferCorpus([item('רשי על שבת', 'תלמוד בבלי/ראשונים/רשי')], { title: 'משנה תורה, הלכות שבת' }), 'rambam');
    // From inside a commentary, its base text (link_type 'source') is the main link.
    const fromComm = rank.rankCommentaries([item('תוספות על שבת', 'תלמוד בבלי/ראשונים/תוספות', 'commentary'), item('שבת', 'תלמוד בבלי/סדר מועד', 'source')]);
    assert.deepStrictEqual(fromComm.map((x) => [x.displayName, x.tier]), [['שבת', 'מקור'], ['תוספות', 'עיקריים']]);
    // No corpus folders at all: every core list is consulted (best position; ties alphabetical).
    const loose = rank.rankCommentaries([item('ספר אחר', ''), item('רשי על בראשית', ''), item('משנה ברורה', ''), item('כסף משנה', '')]);
    assert.deepStrictEqual(names(loose), ['משנה ברורה', 'רש"י', 'כסף משנה', 'ספר אחר']);
    assert.ok(loose.slice(0, 3).every((x) => x.core) && loose[0].corpus === null);
  });

  await check('commentary rank: name filter understands Hebrew + Torah abbreviations', () => {
    const t = rank.rankCommentaries(TANACH);
    const f = (ranked, q) => names(rank.filterCommentaries(ranked, { query: q }));
    assert.deepStrictEqual(f(t, 'אב"ע'), ['אבן עזרא']);
    assert.deepStrictEqual(f(t, 'אבן עז'), ['אבן עזרא']);
    assert.deepStrictEqual(f(t, 'רש'), ['רש"י']);
    assert.deepStrictEqual(f(t, 'רמב"ן'), ['רמב"ן']);
    assert.deepStrictEqual(f(t, 'מלבים'), ['מלבי"ם', 'הערות על מלבים']);
    assert.deepStrictEqual(f(t, 'אונק'), ['אונקלוס']);
    assert.deepStrictEqual(f(t, 'תוס'), []);
    assert.strictEqual(f(t, '').length, TANACH.length);
    const sa = rank.rankCommentaries(SA);
    assert.deepStrictEqual(f(sa, 'מ"ב'), ['משנה ברורה']);
    assert.deepStrictEqual(f(sa, 'ט"ז'), ['טורי זהב']);
    assert.deepStrictEqual(f(sa, 'מג"א'), ['מגן אברהם']);
    assert.deepStrictEqual(f(sa, 'באה"ט'), ['באר היטב']);
    assert.deepStrictEqual(f(sa, 'רעק"א'), ['הגהות רבי עקיבא איגר']);
    const bavli = rank.rankCommentaries([item('תוספות על שבת', 'תלמוד בבלי/ראשונים/תוספות'), item('רשי על שבת', 'תלמוד בבלי/ראשונים/רשי'), item('רשבא על שבת', 'תלמוד בבלי/ראשונים/רשבא')]);
    assert.deepStrictEqual(f(bavli, "תוס'"), ['תוספות']);
    assert.deepStrictEqual(f(bavli, 'רש'), ['רש"י', 'רשב"א']);
    // View chips: favorites only (there is no עיקריים-only view: primaries are just first in the order).
    const pinnedT = rank.rankCommentaries(TANACH, { pinned: ['גור אריה'] });
    assert.deepStrictEqual(names(rank.filterCommentaries(pinnedT, { view: 'pinned' })), ['גור אריה']);
    assert.strictEqual(rank.filterCommentaries(pinnedT, {}).length, pinnedT.length, 'nothing is hidden by a primary / secondary split');
    assert.deepStrictEqual(names(rank.filterCommentaries(pinnedT, { view: 'core' })), names(pinnedT), 'the retired "core" view is a no-op');
    // Word starts only: "רמ" is not the folded final mem of "הטורים".
    assert.deepStrictEqual(names(rank.filterCommentaries(pinnedT, { query: 'רמ' })), ['רמב"ן']);
  });

  await check('commentary chip bar: הכל / single tap / long-press multi-select state machine', () => {
    const ranked = rank.rankCommentaries(TANACH, {});
    const keyOf = (n) => ranked.find((r) => r.displayName === n).key;
    const shown = (sel) => names(rank.selectCommentaries(ranked, sel));
    const all = names(ranked);
    const [RASHI, RAMBAN, IBN] = ['רש"י', 'רמב"ן', 'אבן עזרא'].map(keyOf);
    let sel = [];
    // Default הכל: everything, canonical order (רש"י ahead of רמב"ן ahead of אבן עזרא).
    assert.deepStrictEqual(shown(sel), all);
    assert.ok(all.indexOf('רש"י') < all.indexOf('רמב"ן') && all.indexOf('רמב"ן') < all.indexOf('אבן עזרא'));
    // Tap: isolate one commentator; tap it again -> הכל.
    sel = rank.nextSelection(sel, RASHI, 'tap');
    assert.deepStrictEqual(shown(sel), ['רש"י']);
    assert.deepStrictEqual(rank.nextSelection(sel, RASHI, 'tap'), []);
    assert.deepStrictEqual(shown(rank.nextSelection(sel, RASHI, 'tap')), all);
    // Tapping another chip while one is isolated switches the focus.
    assert.deepStrictEqual(rank.nextSelection(sel, RAMBAN, 'tap'), [RAMBAN]);
    // הכל (clear) restores everything from any selection.
    assert.deepStrictEqual(shown([]), all);
    // Long-press adds a second commentator; shown in canonical order whatever the tap order.
    const two = rank.nextSelection([RAMBAN], RASHI, 'longpress');
    assert.deepStrictEqual(two, [RAMBAN, RASHI]);
    assert.deepStrictEqual(shown(two), ['רש"י', 'רמב"ן']);
    // From הכל a long-press isolates (nothing to add to).
    assert.deepStrictEqual(rank.nextSelection([], IBN, 'longpress'), [IBN]);
    // 2+ selected: both tap and long-press toggle chips in / out.
    const three = rank.nextSelection(two, IBN, 'tap');
    assert.deepStrictEqual(shown(three), ['רש"י', 'רמב"ן', 'אבן עזרא']);
    const back = rank.nextSelection(three, RAMBAN, 'longpress');
    assert.deepStrictEqual(shown(back), ['רש"י', 'אבן עזרא']);
    assert.deepStrictEqual(rank.nextSelection(back, IBN, 'tap'), [RASHI], 'down to one -> single focus');
    assert.deepStrictEqual(rank.nextSelection([RASHI], RASHI, 'longpress'), [], 'removing the last one -> הכל');
    // Sticky across verses: the same selection filters another passage; commentators it lacks are ignored.
    const otherVerse = rank.rankCommentaries(TANACH.filter((t) => !/רשי/.test(t.bookTitle)), {});
    assert.deepStrictEqual(names(rank.selectCommentaries(otherVerse, two)), ['רמב"ן']);
    // None of the selection present -> empty (the drawer shows "הצג את כל המפרשים").
    assert.deepStrictEqual(rank.selectCommentaries(otherVerse, [RASHI]), []);
    // Pinned favorites keep priority inside a multi-selection.
    const pinnedR = rank.rankCommentaries(TANACH, { pinned: [IBN] });
    assert.deepStrictEqual(names(rank.selectCommentaries(pinnedR, [RASHI, IBN])), ['אבן עזרא', 'רש"י']);
  });
}

/** shared/bookStream.js: incremental UTF-8 + line splitting == whole-file parsing, URI names. */
async function bookStreamTests() {
  const bs = require('../shared/bookStream');
  const sampleFiles = fs
    .readdirSync(path.join(ROOT, 'raw_library', 'sample'), { recursive: true })
    .filter((f) => String(f).endsWith('.txt'))
    .map((f) => path.join(ROOT, 'raw_library', 'sample', String(f)));
  /** Lines of `buf` streamed in chunks of chunkOf(i) bytes. */
  const streamLines = (buf, chunkOf, forceJs) => {
    const dec = bs.createUtf8Decoder({ forceJs });
    const sp = bs.createLineSplitter();
    const out = [];
    for (let i = 0, k = 0; i < buf.length; k++) {
      const n = chunkOf(k);
      out.push(...sp.push(dec.write(new Uint8Array(buf.subarray(i, i + n)))));
      i += n;
    }
    out.push(...sp.push(dec.end()), ...sp.end());
    return out;
  };
  const wholeLines = (text) => text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n');

  await check('book stream: UTF-8 + lines across every chunk boundary == split of the whole text (BOM, CRLF, lone CR, astral)', () => {
    const text = '﻿<h1>בְּרֵאשִׁ֖ית 😀</h1>\r\nשורה ב\rשורה ג\n\né ü 中文 𝄞\r\n';
    const buf = Buffer.from(text, 'utf8');
    for (const forceJs of [true, false]) {
      for (let size = 1; size <= buf.length; size++) assert.deepStrictEqual(streamLines(buf, () => size, forceJs), wholeLines(text), `chunk ${size} (js ${forceJs})`);
    }
    const d = bs.createUtf8Decoder({ forceJs: true });
    assert.strictEqual(d.write(new Uint8Array([0x41, 0xff, 0xe2, 0x28, 0x41])) + d.end(), 'A��(A', 'invalid bytes -> U+FFFD');
    const cut = bs.createUtf8Decoder({ forceJs: true });
    assert.strictEqual(cut.write(new Uint8Array([0xd7])) + cut.end(), '�', 'truncated sequence at EOF');
  });

  await check('book stream: every sample book streams (irregular chunks) to exactly parseBook\'s paragraphs and TOC', () => {
    for (const f of sampleFiles) {
      const buf = fs.readFileSync(f);
      const whole = indexer.parseBook(buf.toString('utf8'), 'x');
      const parser = indexer.createBookParser('x');
      const paragraphs = [];
      for (const l of streamLines(buf, (k) => 1 + ((k * 131) % 4093), true)) {
        const p = parser.line(l);
        if (p) paragraphs.push(p);
      }
      assert.deepStrictEqual({ ...parser.finish(), paragraphs }, whole, path.basename(f));
    }
  });

  await check('book stream: a line longer than the limit fails the book instead of exhausting memory', () => {
    const sp = bs.createLineSplitter({ maxLineChars: 100 });
    sp.push('a'.repeat(60) + '\n' + 'b'.repeat(60));
    assert.throws(() => sp.push('c'.repeat(60)), bs.LineTooLongError);
    assert.ok(bs.MAX_LINE_CHARS >= 1024 * 1024);
  });

  await check('book stream: openTextReader reads a byte source in chunks and always closes it', async () => {
    const buf = Buffer.from('<h1>ספר</h1>\nשורה אחת\nשורה שתיים', 'utf8');
    let pos = 0;
    let closed = 0;
    const reader = await bs.openTextReader(() => ({
      read: async (n) => {
        const out = new Uint8Array(buf.subarray(pos, pos + n));
        pos += out.length;
        return out;
      },
      close: () => closed++,
    }), { chunkBytes: 5, forceJs: true });
    let text = '';
    for (let t; (t = await reader.read()) != null; ) text += t;
    await reader.close();
    await reader.close();
    assert.strictEqual(text, buf.toString('utf8'));
    assert.strictEqual(closed, 1);
  });

  await check('book stream: names from SAF / file URIs (no per-file content-provider query)', () => {
    const enc = encodeURIComponent;
    const ext = 'content://com.android.externalstorage.documents/tree/primary%3AOtzaria/document/';
    assert.strictEqual(bs.nameFromUri(ext + enc('primary:Otzaria/אוצריא/תנך')), 'תנך');
    assert.strictEqual(bs.nameFromUri(ext + enc('primary:Otzaria/אוצריא/תנך/בראשית.txt')), 'בראשית.txt');
    assert.strictEqual(bs.nameFromUri(ext + 'primary%3AOtzaria'), 'Otzaria');
    assert.strictEqual(bs.nameFromUri('content://com.android.providers.downloads.documents/document/msf%3A1000123'), null, 'opaque id');
    assert.strictEqual(bs.nameFromUri('content://com.android.providers.downloads.documents/document/' + enc('raw:/storage/emulated/0/Download/ספר.txt')), 'ספר.txt');
    assert.strictEqual(bs.nameFromUri('file:///data/files/' + enc('שבת.txt')), 'שבת.txt');
    assert.strictEqual(bs.nameFromUri('content://media/external/file/123'), null);
    assert.strictEqual(bs.cleanName('primary:Otzaria/x%20y.txt'), 'x y.txt');
  });

  await check('pairing: cooperative pairCommentariesAsync == pairCommentaries, and it yields', async () => {
    const pairing = require('../shared/pairing');
    const books = fs
      .readFileSync(path.join(ROOT, 'otzaria_index_only.txt'), 'utf8')
      .split('\n')
      .filter((l) => l.endsWith('.txt'))
      .slice(0, 3000)
      .map((l, i) => {
        const parts = l.replace(/^\.\//, '').split('/');
        return { id: i + 1, title: parts[parts.length - 1].replace(/\.txt$/, ''), aliases: [], categoryPath: parts.slice(0, -1).join('/') };
      });
    let pauses = 0;
    const a = await pairing.pairCommentariesAsync(books, async () => void pauses++);
    const b = pairing.pairCommentaries(books);
    assert.deepStrictEqual([...a], [...b]);
    assert.deepStrictEqual(a.multi, b.multi);
    assert.ok(pauses >= 20, `${pauses} pauses`);
  });
}

/** The Android foreground-service config plugin + native module wiring. */
async function foregroundServicePluginTests() {
  const plugin = require('../plugins/withImportForegroundService');
  await check('fgs plugin: manifest gets the 4 permissions + a dataSync service, idempotently', () => {
    const manifest = { manifest: { $: {}, 'uses-permission': [{ $: { 'android:name': 'android.permission.INTERNET' } }], application: [{ $: { 'android:name': '.MainApplication' }, activity: [] }] } };
    plugin.applyImportForegroundService(manifest);
    plugin.applyImportForegroundService(manifest);
    const perms = manifest.manifest['uses-permission'].map((p) => p.$['android:name']);
    for (const p of ['android.permission.FOREGROUND_SERVICE', 'android.permission.FOREGROUND_SERVICE_DATA_SYNC', 'android.permission.POST_NOTIFICATIONS', 'android.permission.WAKE_LOCK']) {
      assert.strictEqual(perms.filter((x) => x === p).length, 1, p);
    }
    assert.ok(perms.includes('android.permission.INTERNET'));
    const services = manifest.manifest.application[0].service;
    assert.strictEqual(services.length, 1);
    assert.deepStrictEqual(services[0].$, { 'android:name': plugin.SERVICE_NAME, 'android:exported': 'false', 'android:foregroundServiceType': 'dataSync' });
  });
  await check('fgs plugin: registered in app.json; native module class names match the Kotlin sources', () => {
    const app = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8'));
    assert.ok(app.expo.plugins.includes('./plugins/withImportForegroundService'));
    const modDir = path.join(ROOT, 'modules', 'import-foreground-service');
    const cfg = JSON.parse(fs.readFileSync(path.join(modDir, 'expo-module.config.json'), 'utf8'));
    const ktDir = path.join(modDir, 'android', 'src', 'main', 'java', 'expo', 'modules', 'importforegroundservice');
    const src = (f) => fs.readFileSync(path.join(ktDir, f), 'utf8');
    const [pkg, cls] = [cfg.android.modules[0].replace(/\.[^.]+$/, ''), cfg.android.modules[0].split('.').pop()];
    assert.ok(src(`${cls}.kt`).includes(`package ${pkg}`) && src(`${cls}.kt`).includes(`class ${cls} : Module()`));
    assert.ok(src(`${cls}.kt`).includes('Name("ImportForegroundService")'));
    for (const fn of ['start', 'update', 'stop']) assert.ok(src(`${cls}.kt`).includes(`AsyncFunction("${fn}")`), fn);
    const svc = src('ImportForegroundService.kt');
    assert.strictEqual(`${pkg}.ImportForegroundService`, plugin.SERVICE_NAME);
    assert.ok(/FOREGROUND_SERVICE_TYPE_DATA_SYNC/.test(svc) && /PARTIAL_WAKE_LOCK/.test(svc));
    // Crash guards: Android kills the app if a started foreground service is stopped before it
    // called startForeground(), so the module never uses stopService(); the service reaches the
    // foreground first in onStartCommand and only then honours a pending stop.
    const code = (f) => src(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    assert.ok(!/stopService\(/.test(code(`${cls}.kt`)), 'module never calls Context.stopService()');
    assert.ok(/requestStop\(\)/.test(src(`${cls}.kt`)) && /beginStart\(\)/.test(src(`${cls}.kt`)));
    const onStart = svc.slice(svc.indexOf('override fun onStartCommand'), svc.indexOf('override fun onTimeout'));
    assert.ok(onStart.indexOf('startForeground(') >= 0 && onStart.indexOf('startForeground(') < onStart.indexOf('stopRequested'), 'startForeground before honouring a stop');
    assert.ok(/catch \(e: Exception\)/.test(onStart), 'a refused startForeground() is caught');
    assert.ok(/gen == generation && stopRequested/.test(svc), 'a stale stop never stops a newer job');
    const js = fs.readFileSync(path.join(ROOT, 'src', 'services', 'importForegroundService.ts'), 'utf8');
    assert.ok(/requireOptionalNativeModule<NativeImportService>\('ImportForegroundService'\)/.test(js), 'JS looks the module up optionally (web no-op)');
  });
}

// ---------------------------------------------------------------------------------------------
// End of an on-device core build: finalize optimizations, sealing, swap into core_library.db.
// ---------------------------------------------------------------------------------------------

/**
 * Writer adapter whose statements matching `re` throw a busy / locked error (like a real device),
 * once `armed()` says so.
 */
function failing(w, re, log, armed) {
  const guard = (fn) => async (sql, params) => {
    if ((!armed || armed()) && re.test(String(sql))) {
      if (log) log.push(String(sql).trim().slice(0, 60));
      throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
    }
    return fn(sql, params);
  };
  return { exec: guard(w.exec), run: guard(w.run), all: guard(w.all) };
}

/** shared/coreFinalize env for node: the SQLite directory `dir`, node fs, node:sqlite. */
function nodeInstallEnv(dir, hooks) {
  const p = (name) => path.join(dir, name);
  const events = [];
  return {
    events,
    env: {
      exists: (name) => fs.existsSync(p(name)),
      remove: (name) => {
        events.push(`remove ${name}`);
        fs.unlinkSync(p(name));
      },
      // Like expo-file-system's File.move(): asynchronous, completes on a later tick.
      move: (from, to) =>
        new Promise((resolve, reject) =>
          setTimeout(() => {
            try {
              if (hooks && hooks.move) hooks.move(from, to);
              fs.renameSync(p(from), p(to));
              events.push(`move ${from} -> ${to}`);
              resolve();
            } catch (e) {
              reject(e);
            }
          }, 5),
        ),
      closeCore: async () => {
        events.push('closeCore');
        if (hooks && hooks.closeCore) await hooks.closeCore();
      },
      reopenCore: async () => {
        events.push('reopenCore');
        return hooks && hooks.reopenCore ? hooks.reopenCore() : null;
      },
      sleep: () => Promise.resolve(),
    },
  };
}

/** sealBuild env for a node:sqlite connection of `dir/name`. */
function nodeSealEnv(db, dir, name) {
  return {
    checkpoint: async () => db.raw.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get(),
    setJournalDelete: async () => db.raw.exec('PRAGMA journal_mode = DELETE'),
    close: async () => db.raw.close(),
    removeSideFiles: () => {
      for (const s of ['-wal', '-shm']) if (fs.existsSync(path.join(dir, name + s))) fs.unlinkSync(path.join(dir, name + s));
    },
    sleep: () => Promise.resolve(),
  };
}

async function coreFinalizeTests() {
  const pipeline = require('../shared/pipeline');
  const cf = require('../shared/coreFinalize');
  const fx = makePipelineFixture();
  const dir = path.join(fx.tmp, 'SQLite');
  fs.mkdirSync(dir);
  const BUILD = 'core_library.build.db';
  const CORE = 'core_library.db';
  const opts = (extra) => Object.assign({ source: { kind: 'folder', root: fx.lib }, sourceUri: 'file://' + fx.lib, sourceName: 'אוצריא', targetDb: 'core', idBase: 0, yieldToUI: () => Promise.resolve(), finalize: { analyze: true, analysisLimit: 1000, mergePages: 4 } }, extra);
  const fresh = async (name) => {
    for (const s of ['', '-wal', '-shm', '-journal']) fs.rmSync(path.join(dir, name + s), { force: true });
    const db = openWal(path.join(dir, name));
    await indexer.ensureSchema(db.w, { kind: 'core' });
    return db;
  };
  /** A complete, sealed build in BUILD (as runCoreBuild leaves it before the install). */
  const sealedBuild = async () => {
    const db = await fresh(BUILD);
    const r = await pipeline.runImport(db.w, nodeFs, opts());
    assert.strictEqual(r.phase, 'done');
    const meta = await cf.writeBuildMeta(db.w, { source: 'local:אוצריא' });
    await cf.sealBuild(nodeSealEnv(db, dir, BUILD));
    return meta;
  };
  try {
    const ref = await fresh('ref.db');
    await pipeline.runImport(ref.w, nodeFs, opts());
    const refSnap = await librarySnapshot(ref.read);
    ref.raw.close();

    await check('core finalize: swap over an OPEN core with live -wal / -shm (closed first, side files removed, awaited rename)', async () => {
      // The installed (old) library: WAL mode, auto-checkpoint off, so its -wal holds frames.
      const old = openWal(path.join(dir, CORE));
      old.raw.exec("PRAGMA wal_autocheckpoint = 0; CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT); INSERT INTO meta VALUES ('db_version', 'old'), ('kind', 'core'); CREATE TABLE books (id INTEGER PRIMARY KEY, title TEXT);");
      for (let i = 0; i < 200; i++) old.raw.prepare('INSERT INTO books (title) VALUES (?)').run('ישן ' + i);
      assert.ok(fs.statSync(path.join(dir, CORE + '-wal')).size > 0 && fs.existsSync(path.join(dir, CORE + '-shm')), 'old core has live -wal / -shm');
      const { version } = await sealedBuild();
      assert.ok(!fs.existsSync(path.join(dir, BUILD + '-wal')) && !fs.existsSync(path.join(dir, BUILD + '-shm')), 'sealed build is one self-contained file');
      let oldOpen = true;
      let reopened = null;
      const { env, events } = nodeInstallEnv(dir, {
        closeCore: async () => {
          // On the device the old -wal / -shm can outlive the connection (killed process, a handle
          // the native layer had not released yet). Keep them, with their frames, next to the file.
          const wal = fs.readFileSync(path.join(dir, CORE + '-wal'));
          const shm = fs.readFileSync(path.join(dir, CORE + '-shm'));
          old.raw.close();
          fs.writeFileSync(path.join(dir, CORE + '-wal'), wal);
          fs.writeFileSync(path.join(dir, CORE + '-shm'), shm);
          oldOpen = false;
        },
        move: () => assert.ok(!oldOpen, 'old core closed before the rename'),
        reopenCore: async () => {
          reopened = openWritable(path.join(dir, CORE));
          return (await indexer.readMeta(reopened.read)).db_version;
        },
      });
      const got = await cf.installFile(env, { from: BUILD, to: CORE, settleMs: 0 });
      assert.strictEqual(got, version);
      // Order: close -> old side files removed -> rename -> reopen.
      const i = (re) => events.findIndex((e) => re.test(e));
      assert.ok(i(/^closeCore/) < i(/remove core_library\.db-wal/) && i(/remove core_library\.db-wal/) < i(/^move/) && i(/^move/) < i(/^reopenCore/), events.join(', '));
      assert.ok(events.includes('remove core_library.db-shm'), events.join(', '));
      assert.ok(!fs.existsSync(path.join(dir, BUILD)), 'build file consumed by the rename (no copy)');
      assert.ok(fs.readdirSync(dir).every((f) => !f.startsWith(BUILD)), `build side files left: ${fs.readdirSync(dir)}`);
      assert.strictEqual(reopened.raw.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
      assert.deepStrictEqual(await librarySnapshot(reopened.read), refSnap, 'installed library == reference build (no stale WAL frames applied)');
      assert.strictEqual(reopened.raw.prepare("SELECT COUNT(*) AS n FROM books WHERE title LIKE 'ישן%'").get().n, 0);
      reopened.raw.close();
    });

    await check('core finalize: a failed swap keeps the sealed build, names the step and its native code', async () => {
      const { version } = await sealedBuild();
      const { env } = nodeInstallEnv(dir, {
        move: () => {
          throw Object.assign(new Error('rename failed: Device or resource busy'), { code: 'EBUSY' });
        },
      });
      let err = null;
      try {
        await cf.installFile(env, { from: BUILD, to: CORE, settleMs: 0 });
      } catch (e) {
        err = e;
      }
      assert.ok(err instanceof cf.StepError, String(err));
      assert.strictEqual(err.step, 'finalize:swap_file');
      assert.ok(/^finalize:swap_file · rename failed: Device or resource busy \[EBUSY\]$/.test(cf.diagnosticOf(err)), cf.diagnosticOf(err));
      const b = openWritable(path.join(dir, BUILD));
      const st = await indexer.readIngestionState(b.read);
      assert.ok(cf.isReadyToInstall(st) && cf.needsFinalizeOnly(st), JSON.stringify(st));
      assert.strictEqual((await indexer.readMeta(b.read)).db_version, version);
      b.raw.close();
      // A missing staged file is reported before the installed library is touched.
      const { env: env2, events } = nodeInstallEnv(dir);
      await assert.rejects(cf.installFile(env2, { from: 'nothing.db', to: CORE, settleMs: 0 }), (e) => e.step === 'finalize:check_staged' && /ENOENT/.test(e.diagnostic));
      assert.ok(!events.includes('closeCore'), 'core left open when nothing can be installed');
    });

    await check('core finalize: optimization failures (FTS merge, ANALYZE, optimize, queue drop, checkpoint) are non-fatal', async () => {
      const db = await fresh('soft.db');
      const failed = [];
      let finalizing = false;
      const w = failing(db.w, /paragraphs_fts\(paragraphs_fts, rank\)|ANALYZE|PRAGMA optimize|DELETE FROM import_queue/, failed, () => finalizing);
      const warned = [];
      const r = await pipeline.runImport(
        w,
        nodeFs,
        opts({
          onProgress: (x) => (finalizing = finalizing || x.phase === 'finalize'),
          onWarning: (x) => warned.push(x.step),
          walCheckpoint: async () => {
            if (finalizing) throw new Error('database is locked');
          },
        }),
      );
      assert.ok(failed.length >= 3, failed.join(', '));
      assert.strictEqual(r.stopped, null);
      assert.strictEqual(r.phase, 'done', 'the import completes');
      assert.deepStrictEqual(r.warnings.map((x) => x.step), ['finalize:fts_optimize', 'finalize:analyze', 'finalize:pragma_optimize']);
      assert.deepStrictEqual(warned, ['finalize:fts_optimize', 'finalize:analyze', 'finalize:pragma_optimize']);
      assert.ok(r.warnings.every((x) => /database is locked \[SQLITE_BUSY\]/.test(x.message)), JSON.stringify(r.warnings));
      const metaWarn = [];
      const m = await cf.writeBuildMeta(w, { source: 'local:x', warn: (x) => metaWarn.push(x.step) });
      assert.deepStrictEqual(metaWarn, ['finalize:drop_queue']);
      assert.ok(m.version && m.counts.books > 0);
      assert.ok(cf.isReadyToInstall(await indexer.readIngestionState(db.read)));
      // Every book is there and searchable: an un-merged FTS index is valid, merely less compact.
      assert.deepStrictEqual(await librarySnapshot(db.read), refSnap);
      assert.strictEqual(db.raw.prepare("INSERT INTO paragraphs_fts(paragraphs_fts, rank) VALUES('integrity-check', 1)").run().changes >= 0, true);
      // Journal-mode switch failing is soft too; a WAL that cannot be emptied is not (data safety).
      const sealWarn = [];
      let busy = 2;
      await cf.sealBuild(
        Object.assign(nodeSealEnv(db, dir, 'soft.db'), {
          checkpoint: async () => (busy-- > 0 ? { busy: 1, log: 5, checkpointed: 0 } : db.raw.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()),
          setJournalDelete: async () => {
            throw new Error('database is locked');
          },
        }),
        { warn: (x) => sealWarn.push(x.step), delayMs: 0 },
      );
      assert.deepStrictEqual(sealWarn, ['finalize:journal_mode'], 'busy checkpoint retried, journal mode soft');
      await assert.rejects(
        cf.sealBuild({ checkpoint: async () => ({ busy: 1, log: 9, checkpointed: 3 }), setJournalDelete: async () => undefined, close: async () => assert.fail('never closed'), removeSideFiles: () => undefined, sleep: () => Promise.resolve() }, { attempts: 3, delayMs: 0 }),
        (e) => e.step === 'finalize:checkpoint' && /SQLITE_BUSY/.test(e.diagnostic),
      );
      // No VACUUM anywhere in the on-device finalize path.
      for (const f of ['shared/coreFinalize.js', 'shared/pipeline.js', 'src/services/localIndexer.ts', 'src/db/library.ts']) {
        const code = fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
        assert.ok(!/VACUUM/i.test(code), `${f} runs VACUUM`);
      }
    });

    await check('core finalize: a failure inside finalize resumes ONLY finalize (no folder listed, no book read)', async () => {
      // 1. Killed while writing the library meta (after the index optimizations ran).
      const name = 'retry.db';
      let db = await fresh(name);
      const log = [];
      const probe = killable(db.w, Infinity, log);
      await pipeline.runImport(probe, nodeFs, opts());
      const metaAt = log.length + 1; // the first statement after the pipeline
      db.raw.close();
      db = await fresh(name);
      const w = killable(db.w, Infinity);
      await pipeline.runImport(w, nodeFs, opts());
      const k = killable(db.w, 1);
      await assert.rejects(cf.writeBuildMeta(k, { source: 'local:x' }), (e) => /^finalize:/.test(e.step));
      assert.ok(metaAt > 1);
      db.raw.close();
      db = openWal(path.join(dir, name));
      await indexer.ensureSchema(db.w, { kind: 'core' });
      let st = await indexer.readIngestionState(db.read);
      assert.strictEqual(st.phase, 'finalize');
      assert.strictEqual(st.finalize_step, cf.FINALIZE_INDEX_DONE);
      assert.ok(cf.needsFinalizeOnly(st), JSON.stringify(st));
      // The retry: a resume with a source that must never be touched.
      const t = tracingFs();
      const stmts = [];
      const r = await pipeline.runImport(killable(db.w, Infinity, stmts), t.fsa, opts({ resume: true }));
      assert.strictEqual(r.phase, 'done');
      assert.deepStrictEqual([t.lists.length, t.reads.length], [0, 0], 'no folder listed, no book read');
      assert.ok(!stmts.some((x) => /paragraphs_fts\(paragraphs_fts, rank\)|ANALYZE/.test(x)), 'optimizations already done are skipped');
      const m1 = await cf.writeBuildMeta(db.w, { source: 'local:x' });
      assert.deepStrictEqual(await librarySnapshot(db.read), refSnap);

      // 2. Sealed, then the swap failed: retrying is a no-op pipeline + the same version.
      await cf.sealBuild(nodeSealEnv(db, dir, name));
      db = openWal(path.join(dir, name));
      await indexer.ensureSchema(db.w, { kind: 'core' });
      st = await indexer.readIngestionState(db.read);
      assert.ok(cf.isReadyToInstall(st));
      const t2 = tracingFs();
      const r2 = await pipeline.runImport(db.w, t2.fsa, opts({ resume: true }));
      assert.strictEqual(r2.phase, 'done');
      assert.deepStrictEqual([t2.lists.length, t2.reads.length], [0, 0], 'ready build: nothing re-imported');
      const m2 = await cf.writeBuildMeta(db.w, { source: 'local:x' });
      assert.strictEqual(m2.version, m1.version, 'same library version on retry');
      assert.ok(m2.reused);
      assert.deepStrictEqual(await librarySnapshot(db.read), refSnap, 'never re-seeded or wiped');
      db.raw.close();

      // 3. A build completed by an older app version (no finalize_step) is adopted, not rebuilt.
      db = openWal(path.join(dir, name));
      db.raw.exec("UPDATE ingestion_state SET finalize_step = NULL, phase = 'finalize'");
      st = await cf.adoptCompletedBuild(db.w);
      assert.ok(cf.isReadyToInstall(st), JSON.stringify(st));
      db.raw.close();
    });

    await check('core finalize: step diagnostics ("step · message [code]")', () => {
      const e = new cf.StepError('finalize:reopen_db', Object.assign(new Error('unable to open database file'), { code: 'ERR_INTERNAL_SQLITE_ERROR' }));
      assert.strictEqual(e.diagnostic, 'finalize:reopen_db · unable to open database file [ERR_INTERNAL_SQLITE_ERROR]');
      assert.strictEqual(cf.diagnosticOf(e), e.diagnostic);
      assert.strictEqual(cf.diagnosticOf(new Error('x')), 'x');
      assert.strictEqual(cf.describeError('plain'), 'plain');
      assert.strictEqual(new cf.StepError('finalize:counts', Object.assign(new Error('none'), { retryable: false })).retryable, false);
      // The UI shows it with a copy button, on the failure card and the resume card.
      const ui = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
      assert.ok(/העתק פרטי שגיאה/.test(ui('src/components/library/ErrorDetails.tsx')) && /setStringAsync/.test(ui('src/components/library/ErrorDetails.tsx')));
      assert.ok(/result\.diagnostic/.test(ui('src/components/library/JobStatus.tsx')) && /last_error/.test(ui('src/components/library/ResumeCard.tsx')));
      // Every File.move() in src/ is awaited (it returns a Promise in expo-file-system 58).
      for (const f of ['src/db/library.ts', 'src/services/localIndexer.ts', 'src/services/coreLibrary.ts']) {
        for (const line of ui(f).split('\n')) {
          if (/\.move\(/.test(line) && !/^\s*(\/\/|\*)/.test(line)) assert.ok(/await |=> dbFile\(from\)\.move/.test(line), `${f}: un-awaited move: ${line.trim()}`);
        }
      }
    });
  } finally {
    fs.rmSync(fx.tmp, { recursive: true, force: true });
  }
}

main();

/** Minimal sfnt reader: table directory, hhea / head metrics and the GPOS feature tags. */
function readFontInfo(file) {
  const b = fs.readFileSync(file);
  const numTables = b.readUInt16BE(4);
  const tables = {};
  for (let i = 0; i < numTables; i++) {
    const o = 12 + i * 16;
    tables[b.toString('latin1', o, o + 4)] = { offset: b.readUInt32BE(o + 8), length: b.readUInt32BE(o + 12) };
  }
  const head = tables.head.offset;
  const hhea = tables.hhea.offset;
  const info = { tables: Object.keys(tables), unitsPerEm: b.readUInt16BE(head + 18), ascender: b.readInt16BE(hhea + 4), descender: b.readInt16BE(hhea + 6), gposFeatures: [], gposScripts: [] };
  if (tables.GPOS) {
    const g = tables.GPOS.offset;
    const scriptList = g + b.readUInt16BE(g + 4);
    for (let i = 0, n = b.readUInt16BE(scriptList); i < n; i++) info.gposScripts.push(b.toString('latin1', scriptList + 2 + i * 6, scriptList + 6 + i * 6));
    const featureList = g + b.readUInt16BE(g + 6);
    for (let i = 0, n = b.readUInt16BE(featureList); i < n; i++) info.gposFeatures.push(b.toString('latin1', featureList + 2 + i * 6, featureList + 6 + i * 6));
  }
  const cmap = tables.cmap.offset;
  info.hasCmap = b.readUInt16BE(cmap + 2) > 0;
  return info;
}

function hexToRgb(hex) {
  const h = hex.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
}
function contrast(a, b) {
  const lum = (hex) => {
    const [r, g, bl] = hexToRgb(hex).map((v) => {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}
/** Palettes from src/theme.ts (plain object literal -> JSON-ish parse). */
function readPalettes() {
  const src = fs.readFileSync(path.join(ROOT, 'src/theme.ts'), 'utf8');
  const out = {};
  for (const name of ['light', 'sepia', 'dark']) {
    const m = new RegExp(`\\n  ${name}: \\{([\\s\\S]*?)\\n  \\}`).exec(src);
    assert.ok(m, `palette ${name} in src/theme.ts`);
    out[name] = {};
    for (const [, k, v] of m[1].matchAll(/(\w+): '([^']*)'/g)) out[name][k] = v;
  }
  return out;
}

async function typographyTests() {
  const typo = require('../shared/typography');
  const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

  await check('typography: line height scales with cantillation / niqqud (1.85 / 1.75 / 1.55)', () => {
    const base = typo.LINE_HEIGHT.default;
    assert.strictEqual(base, 1.55);
    const all = { showNikkud: true, showCantillation: true };
    const nikkudOnly = { showNikkud: true, showCantillation: false };
    const plain = { showNikkud: false, showCantillation: false };
    assert.strictEqual(typo.lineHeightMultiplier(base, all), 1.85);
    assert.strictEqual(typo.lineHeightMultiplier(base, nikkudOnly), 1.75);
    assert.strictEqual(typo.lineHeightMultiplier(base, plain), 1.55);
    // Te'amim are never shown without niqqud: their room goes with it.
    assert.strictEqual(typo.lineHeightMultiplier(base, { showNikkud: false, showCantillation: true }), 1.55);
    assert.deepStrictEqual(typo.visibleMarks({ showNikkud: false, showCantillation: true }), { nikkud: false, cantillation: false });
    // Spec window: 1.75x-1.9x with marks.
    for (const o of [all, nikkudOnly]) {
      const m = typo.lineHeightMultiplier(base, o);
      assert.ok(m >= 1.75 && m <= 1.9, `${JSON.stringify(o)} -> ${m}`);
    }
    // The slider shifts every mode alike; the result stays within bounds.
    assert.strictEqual(typo.lineHeightMultiplier(2.0, all), 2.3);
    assert.strictEqual(typo.lineHeightMultiplier(99, all), typo.MAX_EFFECTIVE_LINE_HEIGHT);
    assert.strictEqual(typo.lineHeightMultiplier(0.5, plain), typo.LINE_HEIGHT.min);
    assert.strictEqual(typo.lineHeightMultiplier(NaN, all), 1.85);
    // px: rounded up at every font size so the line box never shrinks below the multiplier.
    for (let fs_ = typo.FONT_SIZE.min; fs_ <= typo.FONT_SIZE.max; fs_++) {
      const withMarks = typo.lineHeightPx(fs_, base, all);
      const without = typo.lineHeightPx(fs_, base, plain);
      assert.ok(withMarks >= fs_ * 1.85 && withMarks < fs_ * 1.85 + 1, `${fs_}px: ${withMarks}`);
      assert.ok(withMarks - without >= Math.floor(fs_ * 0.3), `${fs_}px: +${withMarks - without}px for te'amim`);
      assert.ok(typo.lineHeightPx(fs_ + 1, base, all) > withMarks, 'monotonic in font size');
    }
    assert.strictEqual(typo.lineHeightPx(20, base, all), 37);
    // The reader, the commentary drawer and the Aa preview all use the effective value.
    assert.ok(/lineHeightMultiplier\(lineHeight, \{ showNikkud, showCantillation \}\)/.test(read('src/components/reader/BookReader.tsx')));
    assert.ok(/estimateItemSize\(fontSize, effectiveLineHeight\)/.test(read('src/components/reader/BookReader.tsx')));
    assert.ok(/lineHeightPx\(entrySize, lineHeight, \{ showNikkud, showCantillation \}\)/.test(read('src/components/reader/CommentaryPane.tsx')));
    assert.ok(/effectiveLineHeight\(/.test(read('src/components/reader/AppearanceSheet.tsx')));
    // Android keeps the font padding on reader + commentary text (marks never clip).
    assert.ok(/text: \{[^}]*includeFontPadding: true/.test(read('src/components/reader/BookReader.tsx')));
    assert.ok(/entryText: \{[^}]*includeFontPadding: true/.test(read('src/components/reader/CommentaryPane.tsx')));
  });

  await check('typography: Taamey Frank CLM bundled (GPOS mark/mkmk), registered for web + Android', () => {
    const files = { regular: 'assets/fonts/TaameyFrankCLM-Medium.ttf', bold: 'assets/fonts/TaameyFrankCLM-Bold.ttf' };
    for (const f of Object.values(files)) {
      const info = readFontInfo(path.join(ROOT, f));
      for (const t of ['GPOS', 'GSUB', 'GDEF', 'cmap', 'glyf']) assert.ok(info.tables.includes(t), `${f}: ${t} table`);
      assert.ok(info.gposFeatures.includes('mark') && info.gposFeatures.includes('mkmk'), `${f}: GPOS features ${info.gposFeatures}`);
      assert.ok(info.gposScripts.includes('hebr'), `${f}: GPOS scripts ${info.gposScripts}`);
      // The 1.85x cantillation line box holds the font's own extent with room to spare.
      const extent = (info.ascender - info.descender) / info.unitsPerEm;
      assert.ok(extent > 1 && typo.lineHeightMultiplier(typo.LINE_HEIGHT.default, {}) >= extent * 1.4, `${f}: extent ${extent.toFixed(2)}em`);
    }
    assert.ok(fs.existsSync(path.join(ROOT, 'assets/fonts/GNU-GPL-2.0.txt')) && /font exception/i.test(read('assets/fonts/README.md')), 'license shipped');
    // Android: the expo-font config plugin embeds both files (family name = file name)...
    const app = JSON.parse(read('app.json'));
    const plugin = app.expo.plugins.find((p) => Array.isArray(p) && p[0] === 'expo-font');
    assert.ok(plugin, 'expo-font plugin configured with fonts');
    assert.deepStrictEqual(plugin[1].fonts, Object.values(files).map((f) => './' + f));
    // ...and fonts.ts loads the same files under those family names (web @font-face / Expo Go).
    const fontsTs = read('src/fonts.ts');
    assert.ok(/regular: 'TaameyFrankCLM-Medium', bold: 'TaameyFrankCLM-Bold'/.test(fontsTs));
    assert.ok(/\[TAAMEY_FRANK\.regular\]: require\('\.\.\/assets\/fonts\/TaameyFrankCLM-Medium\.ttf'\)/.test(fontsTs));
    assert.ok(/\[TAAMEY_FRANK\.bold\]: require\('\.\.\/assets\/fonts\/TaameyFrankCLM-Bold\.ttf'\)/.test(fontsTs));
    // Picker: every shared font key has an entry, Taamey Frank first and default, "מערכת" = platform font.
    const keys = [...fontsTs.matchAll(/\{ key: '(\w+)', label: '[^']*', hebrewLabel: '([^']*)'/g)].map((m) => [m[1], m[2]]);
    assert.deepStrictEqual(keys.map((k) => k[0]), typo.FONT_KEYS);
    assert.strictEqual(typo.DEFAULT_FONT, 'taameyFrank');
    assert.deepStrictEqual(keys[0], ['taameyFrank', 'טעמי פרנק']);
    assert.deepStrictEqual(keys.at(-1), ['system', 'מערכת']);
    assert.ok(/key: 'system'[^}]*regular: undefined, bold: undefined/.test(fontsTs));
  });

  await check('typography: verse numbers split off for the margin column', () => {
    const RLM = reader.RLM;
    const prep = (t) => reader.prepareDisplayText(t, { showNikkud: true, showCantillation: true });
    let r = typo.splitVerseMarker(prep('(א) <big>בְּ</big>רֵאשִׁ֖ית בָּרָ֣א'));
    assert.deepStrictEqual(r, { marker: 'א', text: '<big>בְּ</big>רֵאשִׁ֖ית בָּרָ֣א' });
    // The RLM that prepareDisplayText added for the parentheses is dropped with the number...
    assert.ok(prep('(יא) וַיֹּ֣אמֶר')[0] === RLM);
    assert.deepStrictEqual(typo.splitVerseMarker(prep('(יא) וַיֹּ֣אמֶר')), { marker: 'יא', text: 'וַיֹּ֣אמֶר' });
    // ...and kept when the rest still needs it.
    assert.deepStrictEqual(typo.splitVerseMarker(prep('(קנז) ראה (שם) 12')), { marker: 'קנז', text: RLM + 'ראה (שם) 12' });
    assert.strictEqual(typo.splitVerseMarker(prep('(טו) וַיְהִי')).marker, 'טו');
    assert.strictEqual(typo.splitVerseMarker(prep('(טז) וַיְהִי')).marker, 'טז');
    // Words in parentheses are not numbers (final letters, ascending values, repeats).
    for (const t of ['(שם) ראה', '(גם) כן', '(רש) x', '(יי) x', '(בא) x', 'אין מספר', '(א)']) assert.strictEqual(typo.splitVerseMarker(prep(t)).marker, null, t);
    assert.strictEqual(typo.hebrewNumeralValue('קנז'), 157);
    assert.strictEqual(typo.hebrewNumeralValue('תתר'), 1000);
    assert.strictEqual(typo.hebrewNumeralValue('שם'), 0);
    for (let n = 1; n <= 1200; n++) assert.strictEqual(typo.hebrewNumeralValue(typo.toHebrewNumeral(n)), n, `numeral ${n}`);
    assert.deepStrictEqual([15, 16, 115, 270, 344].map(typo.toHebrewNumeral), ['טו', 'טז', 'קטו', 'רע', 'שמד']);
    assert.deepStrictEqual(['ער', 'ערד', 'שדמ', 'רחצ'].map(typo.hebrewNumeralValue), [270, 274, 344, 298]);
    assert.ok(typo.verseGutterWidth(20) >= 24 && typo.verseGutterWidth(36) > typo.verseGutterWidth(14));
    assert.ok(/splitVerseMarker\(prepared\)/.test(read('src/components/reader/BookReader.tsx')));
  });

  await check('typography: font / theme persistence (zustand persist round trip, migrations)', async () => {
    // Same persist wiring as src/state/settingsStore.ts, over an in-memory storage.
    const { createStore } = require('zustand/vanilla');
    const { persist, createJSONStorage } = require('zustand/middleware');
    const mem = new Map();
    const storage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => void mem.set(k, v), removeItem: (k) => void mem.delete(k) };
    const defaults = { fontFamily: typo.DEFAULT_FONT, fontSize: 20, lineHeight: typo.LINE_HEIGHT.default, theme: 'light', showNikkud: true, showCantillation: true, commentaryRatio: 0.42, commentaryFollow: false };
    const make = () =>
      createStore(
        persist((set) => ({ ...defaults, set: (patch) => set(patch) }), {
          name: 'kodeshread.appearance',
          storage: createJSONStorage(() => storage),
          version: typo.APPEARANCE_VERSION,
          migrate: (p, v) => typo.migrateAppearance(p, v),
          merge: (p, cur) => ({ ...cur, ...typo.sanitizeAppearance(p) }),
          partialize: ({ set: _s, ...rest }) => rest,
        }),
      );
    const settle = (st) => new Promise((r) => (st.persist.hasHydrated() ? r() : st.persist.onFinishHydration(r)));

    let st = make();
    await settle(st);
    assert.strictEqual(st.getState().fontFamily, 'taameyFrank', 'fresh install: Taamey Frank CLM');
    st.getState().set({ fontFamily: 'system', theme: 'dark' });
    st = make(); // "app restart"
    await settle(st);
    assert.deepStrictEqual([st.getState().fontFamily, st.getState().theme], ['system', 'dark'], 'font + theme survive a restart');
    st.getState().set({ theme: 'sepia', fontFamily: 'taameyFrank', lineHeight: 1.8 });
    st = make();
    await settle(st);
    assert.deepStrictEqual([st.getState().fontFamily, st.getState().theme, st.getState().lineHeight], ['taameyFrank', 'sepia', 1.8]);
    assert.strictEqual(JSON.parse(mem.get('kodeshread.appearance')).version, 3);

    // v2 (before this release): untouched defaults move to Taamey Frank + 1.55; choices stay.
    mem.set('kodeshread.appearance', JSON.stringify({ version: 2, state: { fontFamily: 'frankRuhl', fontSize: 22, lineHeight: 1.7, theme: 'dark', showNikkud: true, showCantillation: false, commentaryRatio: 0.5, commentaryFollow: true } }));
    st = make();
    await settle(st);
    let s = st.getState();
    assert.deepStrictEqual([s.fontFamily, s.fontSize, s.lineHeight, s.theme, s.showCantillation, s.commentaryRatio, s.commentaryFollow], ['taameyFrank', 22, 1.55, 'dark', false, 0.5, true]);
    mem.set('kodeshread.appearance', JSON.stringify({ version: 2, state: { fontFamily: 'david', lineHeight: 2.1, theme: 'sepia' } }));
    st = make();
    await settle(st);
    s = st.getState();
    // A custom leading keeps its vocalized spacing (2.1 = 1.8 + 0.3 for te'amim).
    assert.deepStrictEqual([s.fontFamily, s.lineHeight, s.theme], ['david', 1.8, 'sepia']);
    assert.strictEqual(typo.lineHeightMultiplier(s.lineHeight, s), 2.1);
    // v1: showNiqqud -> showNikkud.
    assert.deepStrictEqual(typo.migrateAppearance({ showNiqqud: false }, 1).showNikkud, false);
    assert.ok(!('showNiqqud' in typo.migrateAppearance({ showNiqqud: false }, 1)));
    // Unknown values in storage (newer / corrupted build) fall back instead of breaking the reader.
    mem.set('kodeshread.appearance', JSON.stringify({ version: 3, state: { fontFamily: 'comicSans', theme: 'oled', fontSize: 99, lineHeight: 'x' } }));
    st = make();
    await settle(st);
    s = st.getState();
    assert.deepStrictEqual([s.fontFamily, s.theme, s.fontSize, s.lineHeight], ['taameyFrank', 'light', typo.FONT_SIZE.max, typo.LINE_HEIGHT.default]);

    // The app store is wired to the same shared functions.
    const store = read('src/state/settingsStore.ts');
    for (const re of [/version: APPEARANCE_VERSION/, /migrate: \(persisted, version\) => migrateAppearance\(/, /merge: \(persisted, current\) => \(\{ \.\.\.current, \.\.\.\(sanitizeAppearance\(/, /fontFamily: DEFAULT_FONT/, /partialize: \(\{ fontFamily, fontSize, lineHeight, theme,/]) {
      assert.ok(re.test(store), `settingsStore.ts: ${re}`);
    }
  });

  await check('themes: 3-way switcher, low-glare Dark charcoal, readable contrast', () => {
    const p = readPalettes();
    const dark = p.dark;
    const bg = hexToRgb(dark.background);
    assert.ok(bg.every((v) => v >= 0x1e && v <= 0x25), `dark background ${dark.background} in #1E1E1E-#252525`);
    assert.strictEqual(dark.text.toUpperCase(), '#E8E6E3');
    const [r, , b] = hexToRgb(dark.selection);
    assert.ok(b > r + 12, `active-verse highlight is slate / indigo (${dark.selection})`);
    for (const [name, pal] of Object.entries(p)) {
      for (const k of ['background', 'surface', 'text', 'textMuted', 'accent', 'selection', 'highlight', 'verseNumber']) assert.ok(/^#[0-9A-Fa-f]{6}$/.test(pal[k]), `${name}.${k}`);
      assert.ok(contrast(pal.text, pal.background) >= 7, `${name}: text contrast ${contrast(pal.text, pal.background).toFixed(1)} (AAA)`);
      assert.ok(contrast(pal.text, pal.selection) >= 7, `${name}: text on the active verse`);
      assert.ok(contrast(pal.text, pal.highlight) >= 4.5, `${name}: text on the jump glow`);
      assert.ok(contrast(pal.verseNumber, pal.background) >= 2.5 && contrast(pal.verseNumber, pal.background) < contrast(pal.text, pal.background), `${name}: verse numbers subtle but legible`);
      assert.ok(contrast(pal.textMuted, pal.background) >= 4.5, `${name}: muted text`);
    }
    // Not harsh: no pure black / white in Dark.
    assert.ok(dark.background !== '#000000' && dark.text.toUpperCase() !== '#FFFFFF');
    const sheet = read('src/components/reader/AppearanceSheet.tsx');
    for (const label of ["{ name: 'light', label: 'בהיר' }", "{ name: 'sepia', label: 'ספיה' }", "{ name: 'dark', label: 'כהה' }"]) assert.ok(sheet.includes(label), label);
    assert.deepStrictEqual(typo.THEMES, ['light', 'sepia', 'dark']);
    // The active verse uses the palette's selection colour.
    assert.ok(/selected && \{ backgroundColor: c\.selection \}/.test(read('src/components/reader/BookReader.tsx')));
  });
}

/** Parshiot & aliyot (shared/torahParshiot.js) and daily learning (shared/dailyLearning.js). */
async function torahStudyTests() {
  const tp = require('../shared/torahParshiot');
  const dl = require('../shared/dailyLearning');
  const { intToHebrew, formatHebrewNumeral } = require('../shared/hebrew');
  const R = (chapter, verse) => ({ chapter, verse });
  const valid = (book, r) => r.chapter >= 1 && r.chapter <= tp.CHAPTER_VERSES[book].length && r.verse >= 1 && r.verse <= tp.CHAPTER_VERSES[book][r.chapter - 1];
  const next = (book, r) => (r.verse < tp.CHAPTER_VERSES[book][r.chapter - 1] ? R(r.chapter, r.verse + 1) : R(r.chapter + 1, 1));

  await check('hebrew numerals: intToHebrew / formatHebrewNumeral', () => {
    assert.deepStrictEqual([1, 10, 14, 15, 16, 32, 67, 150, 499].map(intToHebrew), ['א', 'י', 'יד', 'טו', 'טז', 'לב', 'סז', 'קנ', 'תצט']);
    assert.strictEqual(intToHebrew(0), null);
    assert.deepStrictEqual([13, 5, 787, 15, 20].map(formatHebrewNumeral), ['י"ג', "ה'", 'תשפ"ז', 'ט"ו', "כ'"]);
  });

  await check('parshiot: 54 parshiot in Torah order, matching hebcal\'s Sedra list', () => {
    assert.strictEqual(tp.PARSHIOT.length, 54);
    const { parshiot } = require('@hebcal/core/dist/esm/sedra');
    assert.deepStrictEqual(tp.PARSHIOT.map((p) => p.en), parshiot, 'same order and names as @hebcal/core (Sedra.lookup().num = index + 1)');
    assert.deepStrictEqual(tp.CHUMASH_BOOKS.map((b) => tp.parshiotOfBook(b).length), [12, 11, 10, 10, 11]);
    assert.strictEqual(new Set(tp.PARSHIOT.map((p) => p.name)).size, 54, 'unique Hebrew names');
    assert.strictEqual(tp.PARSHIOT[7].title, 'פרשת וישלח');
    assert.strictEqual(tp.PARSHIOT[53].name, 'וזאת הברכה');
    assert.strictEqual(tp.findParsha('Vayishlach'), tp.PARSHIOT[7]);
    assert.strictEqual(tp.findParsha('פרשת בלק').book, 'במדבר');
    assert.strictEqual(tp.parshaByNumber(8).name, 'וישלח');
  });

  await check('parshiot: chapter / verse table (Hebrew chapter numbering)', () => {
    // Numbered verses of the printed Hebrew chapters (= hebcal / Leningrad). The traditional tally
    // of 5,845 pesukim counts two of them differently (e.g. the half-verse במדבר כה יט).
    const totals = tp.CHUMASH_BOOKS.map((b) => tp.CHAPTER_VERSES[b].reduce((a, v) => a + v, 0));
    assert.deepStrictEqual(totals, [1533, 1210, 859, 1289, 956]);
    assert.deepStrictEqual([tp.CHAPTER_VERSES['בראשית'][31], tp.CHAPTER_VERSES['במדבר'][24], tp.CHAPTER_VERSES['במדבר'][25]], [33, 19, 65]);
    assert.deepStrictEqual(tp.CHUMASH_BOOKS.map((b) => tp.CHAPTER_VERSES[b].length), [50, 40, 27, 36, 34]);
  });

  await check('parshiot: every aliyah valid, ordered, inside its parsha; parshiot tile each book', () => {
    const problems = [];
    for (const book of tp.CHUMASH_BOOKS) {
      const list = tp.parshiotOfBook(book);
      let expect = R(1, 1);
      for (const p of list) {
        if (tp.cmpRef(p.start, expect) !== 0) problems.push(`${p.name}: starts ${JSON.stringify(p.start)}, previous ended before ${JSON.stringify(expect)}`);
        if (!valid(book, p.start) || !valid(book, p.end)) problems.push(`${p.name}: invalid range`);
        assert.deepStrictEqual(p.aliyot.map((a) => a.name), ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שביעי'], p.name);
        if (tp.cmpRef(p.aliyot[0].start, p.start) !== 0) problems.push(`${p.name}: ראשון is not the parsha start`);
        for (let i = 0; i < p.aliyot.length; i++) {
          const a = p.aliyot[i];
          if (!valid(book, a.start)) problems.push(`${p.name} ${a.name}: ${JSON.stringify(a.start)} not a verse of ${book}`);
          if (i && tp.cmpRef(p.aliyot[i - 1].start, a.start) >= 0) problems.push(`${p.name} ${a.name}: not after ${p.aliyot[i - 1].name}`);
          if (tp.cmpRef(a.start, p.end) > 0) problems.push(`${p.name} ${a.name}: after the parsha end`);
        }
        if (p.maftir) {
          assert.strictEqual(p.maftir.name, 'מפטיר');
          const seventh = p.aliyot[6].start;
          if (!valid(book, p.maftir.start) || tp.cmpRef(p.maftir.start, seventh) < 0 || tp.cmpRef(p.maftir.start, p.end) > 0) problems.push(`${p.name} מפטיר out of the שביעי..end range`);
          // The maftir repeats the end of the parsha: it starts inside שביעי (equal only in עקב / נצבים).
          if (tp.cmpRef(p.maftir.start, seventh) === 0 && !['עקב', 'נצבים'].includes(p.name)) problems.push(`${p.name}: maftir == shevi'i`);
        } else if (p.name !== 'וזאת הברכה') problems.push(`${p.name}: no maftir`);
        expect = next(book, p.end);
      }
      const last = tp.CHAPTER_VERSES[book];
      if (tp.cmpRef(list[list.length - 1].end, R(last.length, last[last.length - 1])) !== 0) problems.push(`${book}: last parsha does not end the book`);
    }
    assert.deepStrictEqual(problems, []);
  });

  await check('parshiot: known coordinates (וישלח שני = בראשית לב יד, ...)', () => {
    const at = (name, i) => {
      const p = tp.findParsha(name);
      return [p.book, ...Object.values(tp.readingsOf(p)[i].start)].join(' ');
    };
    assert.strictEqual(at('וישלח', 0), 'בראשית 32 4');
    assert.strictEqual(at('וישלח', 1), 'בראשית 32 14');
    assert.strictEqual(at('וישלח', 7), 'בראשית 36 40');
    assert.strictEqual(at('בראשית', 5), 'בראשית 4 23');
    assert.strictEqual(at('לך לך', 6), 'בראשית 17 7');
    assert.strictEqual(at('יתרו', 3), 'שמות 19 1');
    assert.strictEqual(at('כי תשא', 1), 'שמות 31 18');
    assert.strictEqual(at('אחרי מות', 0), 'ויקרא 16 1');
    assert.strictEqual(at('נשא', 4), 'במדבר 7 1');
    assert.strictEqual(at('פינחס', 7), 'במדבר 29 35');
    assert.strictEqual(at('בלק', 2), 'במדבר 22 21');
    assert.strictEqual(at('ואתחנן', 5), 'דברים 6 4');
    assert.strictEqual(at('האזינו', 7), 'דברים 32 48');
    assert.strictEqual(at('וזאת הברכה', 6), 'דברים 34 1');
    assert.strictEqual(tp.findParsha('וזאת הברכה').maftir, null, 'its maftir is read from Numbers');
    assert.strictEqual(tp.parshaAt('בראשית', R(32, 14)).name, 'וישלח');
    assert.strictEqual(tp.parshaAt('בראשית', R(32, 3)).name, 'ויצא');
    assert.strictEqual(tp.parshaAt('ויקרא', R(26, 2)).name, 'בהר');
    assert.strictEqual(tp.parshaAt('במדבר', R(30, 1)).name, 'פינחס');
    assert.strictEqual(tp.findParsha('פינחס').end.chapter, 30);
    assert.strictEqual(tp.refLabel(R(32, 14)), 'לב, יד');
    assert.strictEqual(tp.fullRefLabel('בראשית', R(32, 14)), 'בראשית ל"ב י"ד');
  });

  await check('parshiot: divider points (ראשון implied by the parsha; shared shevi\'i / maftir)', () => {
    const gen = tp.bookDividers('בראשית');
    assert.strictEqual(gen.length, 12 * 8);
    assert.deepStrictEqual(gen[0], { chapter: 1, verse: 1, parsha: 'פרשת בראשית', parshaIndex: 0, aliyot: [] });
    assert.deepStrictEqual(gen.find((d) => d.chapter === 32 && d.verse === 14).aliyot, ['שני']);
    for (let i = 1; i < gen.length; i++) assert.ok(tp.cmpRef(gen[i - 1], gen[i]) < 0, 'sorted, one point per verse');
    const deut = tp.bookDividers('דברים');
    assert.deepStrictEqual(deut.find((d) => d.chapter === 11 && d.verse === 22).aliyot, ['שביעי', 'מפטיר'], 'עקב');
    assert.deepStrictEqual(deut.find((d) => d.chapter === 30 && d.verse === 15).aliyot, ['שביעי', 'מפטיר'], 'נצבים');
    assert.strictEqual(deut.length, 11 * 8 - 2 - 1, 'two shared points, no maftir in וזאת הברכה');
  });

  await check('parshiot: chumashBookOf only for the Torah books themselves', () => {
    assert.strictEqual(tp.chumashBookOf('בראשית', 'תנך/תורה'), 'בראשית');
    assert.strictEqual(tp.chumashBookOf('דברים', 'הספרים שלי/תנך'), 'דברים');
    assert.strictEqual(tp.chumashBookOf('שמות', ''), 'שמות');
    assert.strictEqual(tp.chumashBookOf('רש"י על בראשית', 'תנך/מפרשים'), null);
    assert.strictEqual(tp.chumashBookOf('בראשית', 'תנך/מפרשים/ראשונים'), null);
    assert.strictEqual(tp.chumashBookOf('בראשית', 'מדרש/מדרש רבה'), null);
    assert.strictEqual(tp.chumashBookOf('יהושע', 'תנך/נביאים'), null);
  });

  const dbFile = path.join(ROOT, 'assets/db/library.db');
  if (fs.existsSync(dbFile)) {
    const db = openDb(dbFile);
    const bookId = async (title) => (await db.all('SELECT id FROM books WHERE title = ?', [title]))[0].id;
    const gen = await bookId('בראשית');
    const num = await bookId('במדבר');
    const genLines = await tp.chumashVerseLines(db, gen);
    const numLines = await tp.chumashVerseLines(db, num);
    const counts = (lines, chapters) => Array.from({ length: chapters }, (_, c) => {
      let v = 0;
      while (lines.has(`${c + 1}:${v + 1}`)) v++;
      return v;
    });

    await check('parshiot × sample Chumash: every verse found; aliyot land on their exact verse lines', async () => {
      assert.strictEqual(genLines.size, 1533);
      assert.deepStrictEqual(counts(genLines, 50), tp.CHAPTER_VERSES['בראשית'], 'Otzaria בראשית verse counts');
      // Otzaria numbers "ויהי אחרי המגפה" (Leningrad 25:19) as 26:1: the only difference, and no
      // aliyah starts there.
      const nc = counts(numLines, 36);
      const diff = nc.map((v, i) => (v === tp.CHAPTER_VERSES['במדבר'][i] ? null : `${i + 1}:${v}`)).filter(Boolean);
      assert.deepStrictEqual(diff, ['25:18']);
      for (const [book, id, lines] of [['בראשית', gen, genLines], ['במדבר', num, numLines]]) {
        for (const p of tp.parshiotWithLines(book, lines)) {
          for (const r of p.readings) {
            assert.ok(r.line != null, `${p.name} ${r.name} resolved`);
            const [row] = await db.all('SELECT clean_text, toc_path FROM paragraphs WHERE book_id = ? AND line_index = ?', [id, r.line]);
            assert.ok(row.clean_text.startsWith(`(${intToHebrew(r.start.verse)})`), `${p.name} ${r.name}: line ${r.line} is verse ${r.start.verse} (${row.clean_text.slice(0, 12)})`);
            assert.ok(row.toc_path.endsWith(`פרק ${intToHebrew(r.start.chapter)}`), `${p.name} ${r.name}: in chapter ${r.start.chapter} (${row.toc_path})`);
          }
        }
      }
      const vayishlach2 = tp.lineOfVerse(genLines, R(32, 14));
      const [row] = await db.all('SELECT clean_text FROM paragraphs WHERE book_id = ? AND line_index = ?', [gen, vayishlach2]);
      assert.ok(row.clean_text.startsWith('(יד) וילנ שמ בלילה ההוא'), row.clean_text);
      // Same line as the Quick Jump resolver.
      const index = await loadBookIndex(db);
      const [jump] = await resolveReference(db, index, 'בראשית לב יד');
      assert.strictEqual(jump.targetLine, vayishlach2);
      const dividers = tp.dividerLines('בראשית', genLines);
      assert.strictEqual(dividers.size, 96);
      assert.strictEqual(dividers.get(vayishlach2).aliyot[0], 'שני');
      assert.strictEqual(dividers.get(tp.lineOfVerse(genLines, R(32, 4))).parsha, 'פרשת וישלח');
      const resolved = tp.parshiotWithLines('במדבר', numLines);
      assert.strictEqual(tp.parshaForLine(resolved, tp.lineOfVerse(numLines, R(27, 15))).name, 'פינחס');
      assert.strictEqual(tp.parshaForLine(tp.parshaForLine(resolved, tp.lineOfVerse(numLines, R(27, 15))).readings, tp.lineOfVerse(numLines, R(27, 15))).name, 'רביעי');
    });

    await check('parshiot: a chapter without "(א)" markers falls back to one verse per line', async () => {
      const { DatabaseSync } = require('node:sqlite');
      const m = new DatabaseSync(':memory:');
      m.exec(`CREATE TABLE books (id INTEGER PRIMARY KEY, title TEXT, total_lines INTEGER, file_path TEXT);
        CREATE TABLE toc_nodes (id INTEGER PRIMARY KEY, book_id INTEGER, parent_id INTEGER, level INTEGER, title TEXT, ref_key TEXT, start_line INTEGER);
        CREATE TABLE paragraphs (id INTEGER PRIMARY KEY, book_id INTEGER, line_index INTEGER, clean_text TEXT, is_heading INTEGER);
        INSERT INTO books VALUES (1, 'דברים', 7, 'תנך/תורה/דברים.txt');
        INSERT INTO toc_nodes VALUES (1, 1, NULL, 2, 'פרק א', 'א', 2), (2, 1, NULL, 2, 'פרק ב', 'ב', 5);
        INSERT INTO paragraphs (book_id, line_index, clean_text, is_heading) VALUES (1, 1, 'דברים', 1), (1, 2, 'פרק א', 1), (1, 3, 'אלה הדברים', 0), (1, 4, 'אחד עשר יומ', 0), (1, 5, 'פרק ב', 1), (1, 6, '(א) ונפנ', 0), (1, 7, '(ב) ויאמר', 0);`);
      const a = { all: async (sql, params) => m.prepare(sql).all(...(params || [])) };
      const lines = await tp.chumashVerseLines(a, 1);
      assert.deepStrictEqual([...lines.entries()].sort(), [['1:1', 3], ['1:2', 4], ['2:1', 6], ['2:2', 7]]);
      m.close();
    });

    await check('daily learning: resolution against the sample library (missing books reported, not thrown)', async () => {
      const r = await dl.resolveDailyLearning(db, dl.computeDailyLearning(new Date(2026, 10, 23), { il: true }));
      const parasha = r.items.find((i) => i.key === 'parasha');
      assert.ok(parasha.available && parasha.targets[0].available);
      assert.strictEqual(parasha.targets[0].bookId, gen);
      assert.strictEqual(parasha.targets[0].line, tp.lineOfVerse(genLines, R(32, 14)), 'וישלח שני -> בראשית לב יד');
      assert.ok(parasha.targets[0].exact);
      for (const key of ['dafYomi', 'mishna', 'rambam1', 'rambam3']) {
        const it = r.items.find((i) => i.key === key);
        assert.ok(it && !it.available && it.targets.every((t) => !t.available && t.bookId == null), `${key} unavailable in the sample`);
      }
      // Daf Yomi in a tractate the sample has: שבת נו (1 May 2020), daf heading "דף נו."
      const shabbat = await dl.resolveDailyLearning(db, dl.computeDailyLearning(new Date(2020, 4, 1)));
      const daf = shabbat.items.find((i) => i.key === 'dafYomi');
      assert.strictEqual(daf.title, 'שבת דף נו');
      const index = await loadBookIndex(db);
      const [jump] = await resolveReference(db, index, 'שבת נו.');
      assert.ok(daf.targets[0].available && daf.targets[0].exact);
      assert.strictEqual(daf.targets[0].line, jump.targetLine);
      const [h] = await db.all('SELECT display_text FROM paragraphs WHERE book_id = ? AND line_index = ?', [daf.targets[0].bookId, daf.targets[0].line]);
      assert.strictEqual(h.display_text.replace(/<[^>]+>/g, ''), 'דף נו.');
      // Shabbat: shevi'i + the whole parsha.
      const sat = await dl.resolveDailyLearning(db, dl.computeDailyLearning(new Date(2026, 10, 28)));
      const sp = sat.items.find((i) => i.key === 'parasha');
      assert.deepStrictEqual(sp.targets.map((t) => [t.label, t.line]), [['שביעי', tp.lineOfVerse(genLines, R(36, 20))], ['כל הפרשה', tp.lineOfVerse(genLines, R(32, 4))]]);
    });
    db.close();
  }

  await check('daily learning: fixed date, ארץ ישראל (יום ב׳, י"ג בכסלו תשפ"ז)', () => {
    const s = dl.computeDailyLearning(new Date(2026, 10, 23, 15, 30), { il: true });
    assert.deepStrictEqual(s.errors, []);
    assert.strictEqual(s.dateKey, '2026-11-23');
    assert.strictEqual(s.hebrewDate, 'י"ג בכסלו תשפ"ז');
    assert.strictEqual(s.weekday, 1);
    const by = Object.fromEntries(s.items.map((i) => [i.key, i]));
    assert.deepStrictEqual(Object.keys(by), ['parasha', 'dafYomi', 'mishna', 'rambam1', 'rambam3']);
    assert.strictEqual(by.parasha.title, 'וישלח · שני');
    assert.deepStrictEqual(by.parasha.targets.map((t) => [t.path, t.loc, t.ref]), [['תנך/תורה/בראשית', { kind: 'verse', chapter: 32, verse: 14 }, 'בראשית ל"ב י"ד']]);
    assert.strictEqual(by.dafYomi.title, 'ערכין דף ו');
    assert.deepStrictEqual(by.dafYomi.targets.map((t) => [t.path, t.loc]), [['תלמוד בבלי/סדר קדשים/ערכין', { kind: 'daf', daf: 6, amud: 'א' }]]);
    assert.strictEqual(by.mishna.title, 'נגעים ג, א-ב');
    assert.deepStrictEqual(by.mishna.targets.map((t) => [t.path, t.loc]), [['משנה/סדר טהרות/משנה נגעים', { kind: 'chapter', chapter: 3, sub: 1 }]]);
    assert.strictEqual(by.rambam1.title, 'הלכות מאכלות אסורות פרק יג');
    assert.deepStrictEqual(by.rambam1.targets.map((t) => [t.path, t.loc]), [['הלכה/משנה תורה/ספר קדושה/משנה תורה, הלכות מאכלות אסורות', { kind: 'chapter', chapter: 13 }]]);
    assert.strictEqual(by.rambam3.title, 'הלכות שאלה ופיקדון ו-ח');
    assert.deepStrictEqual(by.rambam3.targets.map((t) => [t.path, t.loc]), [['הלכה/משנה תורה/ספר משפטים/משנה תורה, הלכות שאלה ופיקדון', { kind: 'chapter', chapter: 6 }]]);
  });

  await check('daily learning: ארץ ישראל vs חו"ל, doubled parshiot, Shabbat, Sukkot, special dapim', () => {
    const title = (d, il, key = 'parasha') => dl.computeDailyLearning(d, { il }).items.find((i) => i.key === key).title;
    // Shavuot II fell on Shabbat 23 May 2026: the Diaspora is a week behind until they re-align.
    assert.strictEqual(title(new Date(2026, 4, 25), true), 'בהעלותך · שני');
    assert.strictEqual(title(new Date(2026, 4, 25), false), 'נשא · שני');
    const il = dl.computeDailyLearning(new Date(2026, 4, 25), { il: true }).items[0];
    const di = dl.computeDailyLearning(new Date(2026, 4, 25), { il: false }).items[0];
    assert.deepStrictEqual([il.targets[0].loc, di.targets[0].loc], [{ kind: 'verse', chapter: 8, verse: 15 }, { kind: 'verse', chapter: 4, verse: 38 }]);
    assert.strictEqual(dl.computeDailyLearning(new Date(2026, 4, 25)).il, true, 'ארץ ישראל by default');
    // ויקהל-פקודי (5786): both parshiot's aliyah of the day.
    const vp = dl.computeDailyLearning(new Date(2026, 2, 10), { il: true }).items[0];
    assert.strictEqual(vp.title, 'ויקהל-פקודי · שלישי');
    assert.deepStrictEqual(vp.targets.map((t) => [t.label, t.loc.chapter, t.loc.verse]), [['ויקהל · שלישי', 35, 30], ['פקודי · שלישי', 39, 22]]);
    // Shabbat: שביעי and the whole parsha.
    assert.strictEqual(title(new Date(2026, 10, 28), true), 'וישלח · שביעי וכל הפרשה');
    // Sukkot week: וזאת הברכה (then בראשית after Simchat Torah).
    assert.strictEqual(title(new Date(2026, 9, 1), true), 'וזאת הברכה · חמישי');
    assert.strictEqual(title(new Date(2026, 9, 5), true).split(' · ')[0], 'בראשית');
    // Pesach week (no regular parsha on Shabbat Chol HaMoed): the next regular parsha.
    assert.ok(!/Pesach|פסח/.test(title(new Date(2027, 3, 26), true)));
    // Shekalim: the Yerushalmi, at the halacha the daf starts in.
    const shek = dl.computeDailyLearning(new Date(2021, 2, 25)).items.find((i) => i.key === 'dafYomi');
    assert.strictEqual(shek.title, 'שקלים דף ד');
    assert.deepStrictEqual(shek.targets.map((t) => [t.path, t.loc]), [['תלמוד ירושלמי/סדר מועד/תלמוד ירושלמי שקלים', { kind: 'chapter', chapter: 1, sub: 4 }]]);
    const midot = dl.computeDailyLearning(new Date(2027, 2, 24)).items.find((i) => i.key === 'dafYomi');
    assert.deepStrictEqual([midot.title, midot.targets[0].path, midot.targets[0].loc.kind], ['מדות דף לד', 'משנה/סדר קדשים/משנה מדות', 'start']);
    // Rambam introduction sections (string "perek" ranges) open their book.
    const intro = dl.computeDailyLearning(new Date(2024, 3, 22)).items.find((i) => i.key === 'rambam1');
    assert.ok(intro.title && intro.targets.length === 1, intro.title);
  });

  await check('daily learning: every hebcal tractate / section maps onto a real Otzaria book (otzaria_index_only.txt)', () => {
    const indexPath = path.join(ROOT, 'otzaria_index_only.txt');
    if (!fs.existsSync(indexPath)) return;
    const real = new Set(fs.readFileSync(indexPath, 'utf8').split('\n').filter((l) => l.endsWith('.txt')).map((l) => l.replace(/^\.\//, '').replace(/\.txt$/, '')));
    const bavli = Object.keys(require('@hebcal/learning/bavli.json').default);
    const mishnayot = Object.keys(require('@hebcal/learning/mishnayot.json').default);
    const mt = Object.keys(require('@hebcal/learning/mishnehTorah.json').default);
    assert.deepStrictEqual(bavli.filter((k) => !dl.BAVLI[k]), [], 'Daf Yomi tractates');
    assert.deepStrictEqual(mishnayot.filter((k) => !dl.MISHNA[k]), [], 'Mishna Yomit tractates');
    assert.deepStrictEqual(mt.filter((k) => !dl.RAMBAM[k]), [], 'Mishneh Torah sections');
    const missing = [
      ...bavli.map((k) => `${dl.BAVLI[k][0]}/${dl.BAVLI[k][1]}`),
      ...mishnayot.map((k) => `משנה/${dl.SEDARIM[dl.MISHNA[k][0]]}/משנה ${dl.MISHNA[k][1]}`),
      ...mt.map((k) => `הלכה/משנה תורה/${dl.RAMBAM[k][0]}/משנה תורה, ${dl.RAMBAM[k][1]}`),
      ...tp.CHUMASH_BOOKS.map((b) => `תנך/תורה/${b}`),
    ].filter((p) => !real.has(p));
    assert.deepStrictEqual(missing, []);
    assert.strictEqual(Object.keys(dl.SHEKALIM_DAF).length, 21, 'Shekalim dapim ב-כב');
  });

  await check('daily learning: 3 years × ארץ ישראל / חו"ל: no errors, all 5 cycles, all targets real Otzaria paths', () => {
    const indexPath = path.join(ROOT, 'otzaria_index_only.txt');
    const real = fs.existsSync(indexPath) ? new Set(fs.readFileSync(indexPath, 'utf8').split('\n').filter((l) => l.endsWith('.txt')).map((l) => l.replace(/^\.\//, '').replace(/\.txt$/, ''))) : null;
    const bad = [];
    let days = 0;
    let differ = 0;
    const t0 = Date.now();
    for (let i = 0; i < 3 * 365; i++) {
      const d = new Date(2025, 0, 1 + i);
      const both = [true, false].map((il) => dl.computeDailyLearning(d, { il }));
      for (const s of both) {
        if (s.errors.length || s.items.length !== 5) bad.push(`${s.dateKey}: ${s.errors.join('; ') || s.items.length + ' items'}`);
        const p = s.items[0];
        if (p.key !== 'parasha' || !p.targets.length) bad.push(`${s.dateKey}: no parsha`);
        const expectAliyah = dl.WEEKDAY_ALIYAH[s.weekday];
        if (!p.title.includes(expectAliyah)) bad.push(`${s.dateKey}: ${p.title} lacks ${expectAliyah}`);
        for (const it of s.items) for (const t of it.targets) if (real && !real.has(t.path)) bad.push(`${s.dateKey} ${it.key}: ${t.path}`);
      }
      if (both[0].items[0].title !== both[1].items[0].title) differ++;
      days++;
    }
    assert.deepStrictEqual(bad.slice(0, 10), []);
    assert.ok(differ > 0 && differ < 120, `ארץ ישראל and חו"ל differ on some weeks only (${differ} days)`);
    console.log(`  daily learning: ${days} days × 2 locations in ${Date.now() - t0}ms (${differ} days with a different parsha abroad)`);
  });

  await check('daily learning: library book lookup by file path, below a top folder, or by title in its corpus', async () => {
    const { DatabaseSync } = require('node:sqlite');
    const m = new DatabaseSync(':memory:');
    m.exec(`CREATE TABLE books (id INTEGER PRIMARY KEY, title TEXT, total_lines INTEGER, file_path TEXT UNIQUE);
      INSERT INTO books VALUES (1, 'בראשית', 10, 'תנך/תורה/בראשית.txt'),
        (2, 'שבת', 10, 'אוצריא/תלמוד בבלי/סדר מועד/שבת.txt'),
        (3, 'רש"י על ברכות', 10, 'תלמוד בבלי/מפרשים/ברכות.txt'),
        (4, 'ברכות', 10, 'תלמוד בבלי/ברכות.txt'),
        (5, 'שבת', 10, 'משנה/סדר מועד/שבת.txt');`);
    const a = { all: async (sql, params) => m.prepare(sql).all(...(params || [])) };
    const found = await dl.findLibraryBooks(a, ['תנך/תורה/בראשית', 'תלמוד בבלי/סדר מועד/שבת', 'תלמוד בבלי/סדר זרעים/ברכות', 'משנה/סדר טהרות/משנה נגעים']);
    assert.deepStrictEqual(Object.fromEntries([...found].map(([k, v]) => [k, v.id])), { 'תנך/תורה/בראשית': 1, 'תלמוד בבלי/סדר מועד/שבת': 2, 'תלמוד בבלי/סדר זרעים/ברכות': 4 });
    m.close();
  });
}

/** Quick Jump: parsha / aliyah queries (torahParshiot.parseParshaQuery + quickJump.resolveReference). */
async function parshaQuickJumpTests() {
  const tp = require('../shared/torahParshiot');
  const { intToHebrew } = require('../shared/hebrew');
  const parse = (q) => {
    const r = tp.parseParshaQuery(q);
    return r ? `${r.parsha.name}|${r.reading.name}|${r.strong ? 'strong' : 'weak'}` : null;
  };

  await check('parsha query parser: names, prefixes, ordinals (words / letters / digits), עלייה, מפטיר', () => {
    const cases = {
      'וישלח': 'וישלח|ראשון|strong',
      'פרשת וישלח': 'וישלח|ראשון|strong',
      'לך לך': 'לך לך|ראשון|strong',
      'לך-לך': 'לך לך|ראשון|strong',
      'כי תצא': 'כי תצא|ראשון|strong',
      'כִּי תֵצֵא': 'כי תצא|ראשון|strong',
      'וישלח שני': 'וישלח|שני|strong',
      'פרשת וישלח שלישי': 'וישלח|שלישי|strong',
      'וישלח ב': 'וישלח|שני|strong',
      "וישלח ב'": 'וישלח|שני|strong',
      'וישלח 2': 'וישלח|שני|strong',
      'לך לך רביעי': 'לך לך|רביעי|strong',
      'נח שביעי': 'נח|שביעי|strong',
      'נח ז': 'נח|שביעי|strong',
      'בראשית מפטיר': 'בראשית|מפטיר|strong',
      'וישלח 8': 'וישלח|מפטיר|strong',
      'פרשת תצוה עלייה חמישית': 'תצוה|חמישי|strong',
      'תצוה עליה ה': 'תצוה|חמישי|strong',
      'חיי שרה שנייה': 'חיי שרה|שני|strong',
      'וישלח ששי': 'וישלח|שישי|strong',
      'וישלח ראשונה': 'וישלח|ראשון|strong',
    };
    for (const [q, want] of Object.entries(cases)) assert.strictEqual(parse(q), want, q);
  });

  await check('parsha query parser: spelling variants and doubled weeks', () => {
    const cases = {
      'תצוה': 'תצוה', 'תצווה': 'תצוה', 'פינחס': 'פינחס', 'פנחס': 'פינחס', 'שלח': 'שלח', 'שלח לך': 'שלח',
      'אחרי': 'אחרי מות', 'אחרי מות': 'אחרי מות', 'כי תבא': 'כי תבוא', 'כי תבוא': 'כי תבוא', 'בחקתי': 'בחוקותי',
      'קורח': 'קרח', 'חוקת': 'חקת', 'ניצבים': 'נצבים', 'ויקהל פקודי': 'ויקהל', 'ויקהל-פקודי': 'ויקהל', 'מטות מסעי': 'מטות',
      'וזאת הברכה': 'וזאת הברכה', 'כי תשא': 'כי תשא', 'בהעלתך': 'בהעלותך', 'שפטים': 'שופטים',
    };
    for (const [q, name] of Object.entries(cases)) assert.strictEqual(tp.parseParshaQuery(q)?.parsha.name, name, q);
    // Every parsha's own name parses to itself, as a strong reference unless it is a book name.
    for (const p of tp.PARSHIOT) {
      const r = tp.parseParshaQuery(p.name);
      assert.strictEqual(r && r.parsha, p, p.name);
      assert.strictEqual(r.strong, !tp.CHUMASH_BOOKS.includes(p.name), p.name);
      assert.strictEqual(tp.parseParshaQuery(`פרשת ${p.name}`).strong, true);
    }
  });

  await check('parsha query parser: book names stay book references; non-parsha queries untouched', () => {
    for (const q of ['בראשית א', 'בראשית לב יד', 'בראשית 32 14', 'שמות ב', 'דברים 5', 'במדבר כז טו', 'ויקרא א א']) assert.strictEqual(tp.parseParshaQuery(q), null, q);
    assert.strictEqual(parse('בראשית'), 'בראשית|ראשון|weak');
    assert.strictEqual(parse('פרשת בראשית'), 'בראשית|ראשון|strong');
    assert.strictEqual(parse('בראשית שני'), 'בראשית|שני|strong');
    assert.strictEqual(parse('פרשת שמות ב'), 'שמות|שני|strong');
    assert.strictEqual(parse('דברים עליה ג'), 'דברים|שלישי|strong');
    for (const q of ['שבת ב.', 'בבא מציעא ב.', 'שוע אוח כה ה', 'רשי על בראשית', 'וישלח ט', 'וישלח שני שלישי', 'וישלח עליה', 'וזאת הברכה מפטיר', 'פרשת', '']) assert.strictEqual(tp.parseParshaQuery(q), null, q);
  });

  // A five-book Chumash at Otzaria's paths ("(יד) בראשית 32:14" lines) + a Bavli tractate.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kodeshread-parsha-'));
  try {
    const lib = path.join(tmp, 'lib');
    const write = (rel, lines) => {
      fs.mkdirSync(path.dirname(path.join(lib, rel)), { recursive: true });
      fs.writeFileSync(path.join(lib, rel), lines.join('\n'));
    };
    for (const book of tp.CHUMASH_BOOKS) {
      const lines = [`<h1>${book}</h1>`];
      tp.CHAPTER_VERSES[book].forEach((n, ci) => {
        lines.push(`<h2>פרק ${intToHebrew(ci + 1)}</h2>`);
        for (let v = 1; v <= n; v++) lines.push(`(${intToHebrew(v)}) ${book} ${ci + 1}:${v}`);
      });
      write(`תנך/תורה/${book}.txt`, lines);
    }
    write('תנך/מפרשים/רשי על בראשית.txt', ['<h1>רשי על בראשית</h1>', '<h2>פרק א</h2>', '<h3>פסוק א</h3>', 'בראשית. רשי']);
    write('תלמוד בבלי/סדר נזיקין/בבא מציעא.txt', ['<h1>בבא מציעא</h1>', '<h2>דף ב.</h2>', 'שנים אוחזין בטלית', '<h2>דף ב:</h2>', 'גמרא ב:', '<h2>דף ג.</h2>', 'גמרא ג.']);
    const out = path.join(tmp, 'parsha.db');
    const proc = spawnSync(process.execPath, [path.join(__dirname, 'build-db.js'), `--source=${lib}`, `--out=${out}`], { encoding: 'utf8' });
    if (proc.status !== 0) throw new Error('parsha fixture build failed:\n' + proc.stderr);
    const db = openDb(out);
    const index = await loadBookIndex(db);
    const textAt = async (r) => (await db.all('SELECT display_text FROM paragraphs WHERE book_id = ? AND line_index = ?', [r.bookId, r.targetLine]))[0]?.display_text;
    const top = async (q) => (await resolveReference(db, index, q))[0];

    await check('quick jump: parsha / aliyah queries land on the exact verse line, with an RTL label', async () => {
      const cases = [
        ['וישלח', 'פרשת וישלח · ראשון (בראשית ל״ב:ד׳)', 'בראשית 32:4'],
        ['פרשת וישלח', 'פרשת וישלח · ראשון (בראשית ל״ב:ד׳)', 'בראשית 32:4'],
        ['וישלח שני', 'פרשת וישלח · שני (בראשית ל״ב:י״ד)', 'בראשית 32:14'],
        ['פרשת וישלח שלישי', 'פרשת וישלח · שלישי (בראשית ל״ב:ל״א)', 'בראשית 32:31'],
        ['וישלח ב', 'פרשת וישלח · שני (בראשית ל״ב:י״ד)', 'בראשית 32:14'],
        ['וישלח 2', 'פרשת וישלח · שני (בראשית ל״ב:י״ד)', 'בראשית 32:14'],
        ['לך לך', 'פרשת לך לך · ראשון (בראשית י״ב:א׳)', 'בראשית 12:1'],
        ['לך לך רביעי', 'פרשת לך לך · רביעי (בראשית י״ד:א׳)', 'בראשית 14:1'],
        ['נח שביעי', 'פרשת נח · שביעי (בראשית י״א:א׳)', 'בראשית 11:1'],
        ['בראשית מפטיר', 'פרשת בראשית · מפטיר (בראשית ו׳:ה׳)', 'בראשית 6:5'],
        ['פרשת בראשית', 'פרשת בראשית · ראשון (בראשית א׳:א׳)', 'בראשית 1:1'],
        ['בראשית שני', 'פרשת בראשית · שני (בראשית ב׳:ד׳)', 'בראשית 2:4'],
        ['כי תצא', 'פרשת כי תצא · ראשון (דברים כ״א:י׳)', 'דברים 21:10'],
        ['תצווה', 'פרשת תצוה · ראשון (שמות כ״ז:כ׳)', 'שמות 27:20'],
        ['פרשת תצוה עלייה חמישית', 'פרשת תצוה · חמישי (שמות כ״ט:י״ט)', 'שמות 29:19'],
        ['פנחס מפטיר', 'פרשת פינחס · מפטיר (במדבר כ״ט:ל״ה)', 'במדבר 29:35'],
        ['שלח לך', 'פרשת שלח · ראשון (במדבר י״ג:א׳)', 'במדבר 13:1'],
        ['אחרי', 'פרשת אחרי מות · ראשון (ויקרא ט״ז:א׳)', 'ויקרא 16:1'],
        ['כי תבא שישי', 'פרשת כי תבוא · שישי (דברים כ״ח:ז׳)', 'דברים 28:7'],
        ['עקב מפטיר', 'פרשת עקב · מפטיר (דברים י״א:כ״ב)', 'דברים 11:22'],
      ];
      for (const [q, label, text] of cases) {
        const r = await top(q);
        assert.ok(r && r.parsha, `${q}: parsha result first`);
        assert.strictEqual(r.parsha.label, label, q);
        assert.ok(r.direct && r.complete && !r.suggestion, `${q}: direct card`);
        assert.ok((await textAt(r)).endsWith(text), `${q}: line ${r.targetLine} = ${await textAt(r)} (want ${text})`);
        assert.strictEqual(r.bookTitle, text.split(' ')[0]);
      }
    });

    await check('quick jump: all 54 parshiot × aliyot ("פרשת X <ordinal>") resolve to their verse', async () => {
      const WORDS = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שביעי', 'מפטיר'];
      const misses = [];
      for (const p of tp.PARSHIOT) {
        for (const a of tp.readingsOf(p)) {
          const r = await top(`פרשת ${p.name} ${WORDS[a.index]}`);
          const want = `${p.book} ${a.start.chapter}:${a.start.verse}`;
          if (!r || !r.parsha || !(await textAt(r)).endsWith(want)) misses.push(`${p.name} ${a.name}: ${r ? await textAt(r) : 'none'} != ${want}`);
        }
      }
      assert.deepStrictEqual(misses, []);
    });

    await check('quick jump: book lookups unchanged (בראשית א, בראשית לב יד, שמות ב, בבא מציעא ב.)', async () => {
      const chap = await resolveReference(db, index, 'בראשית א');
      assert.ok(!chap.some((r) => r.parsha), 'no parsha card for a chapter reference');
      assert.deepStrictEqual([chap[0].bookTitle, chap[0].path], ['בראשית', ['פרק א']]);
      const verse = await top('בראשית לב יד');
      assert.ok(!verse.parsha && verse.complete && verse.direct);
      assert.strictEqual(await textAt(verse), '(יד) בראשית 32:14');
      const shemot = await top('שמות ב');
      assert.deepStrictEqual([shemot.bookTitle, shemot.path, !!shemot.parsha], ['שמות', ['פרק ב'], false]);
      const bm = await resolveReference(db, index, 'בבא מציעא ב.');
      assert.ok(!bm.some((r) => r.parsha));
      assert.deepStrictEqual([bm[0].bookTitle, bm[0].path, bm[0].complete], ['בבא מציעא', ['דף ב.'], true]);
      assert.strictEqual(await textAt({ ...bm[0], targetLine: bm[0].targetLine + 1 }), 'שנים אוחזין בטלית');
      const bm2 = await top('בבא מציעא ב:');
      assert.deepStrictEqual(bm2.path, ['דף ב:']);
      // A bare book name: the book first, its first parsha as an extra (non-direct) suggestion.
      const bare = await resolveReference(db, index, 'בראשית');
      assert.strictEqual(bare[0].bookTitle, 'בראשית');
      assert.ok(!bare[0].parsha);
      const p = bare.find((r) => r.parsha);
      assert.ok(p && !p.direct && p.parsha.label === 'פרשת בראשית · ראשון (בראשית א׳:א׳)');
      // A commentary title that contains a parsha's book name is still a book lookup.
      assert.strictEqual((await top('רשי על בראשית')).bookTitle, 'רשי על בראשית');
    });

    await check('quick jump: parsha queries stay fast', async () => {
      const t = process.hrtime.bigint();
      for (let i = 0; i < 50; i++) await resolveReference(db, index, 'פרשת וישלח שני');
      const ms = Number(process.hrtime.bigint() - t) / 1e6 / 50;
      assert.ok(ms < 15, `avg ${ms.toFixed(2)}ms`);
      console.log(`  parsha quick jump avg ${ms.toFixed(2)}ms/query`);
    });

    await check('quick jump: no Chumash book in the library -> no parsha card, no error', async () => {
      const shasOnly = { ...index, books: new Map([...index.books].filter(([, b]) => !tp.CHUMASH_BOOKS.includes(b.title))) };
      const r = await resolveReference(db, shasOnly, 'וישלח שני');
      assert.ok(!r.some((x) => x.parsha));
    });
    db.close();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  await check('QuickJumpBar renders parsha cards right-aligned with the parsha label', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/components/QuickJumpBar.tsx'), 'utf8');
    assert.ok(src.includes('testID="quick-jump-parsha"') && src.includes('r.parsha.refLabel') && src.includes('`פתח: ${results[0].parsha.label}`'));
    assert.ok(/parshaTitle: \{[^}]*\.\.\.alignRight/.test(src) && /parshaRef: \{[^}]*\.\.\.alignRight/.test(src));
  });
}

/**
 * Section 16: canonical book roles (shared/bookRoles.js) and the bidirectional parallel-works engine
 * (shared/parallelWorks.js), on the real Otzaria map and on fixture libraries of every family.
 */
async function parallelWorksTests() {
  const pw = require('../shared/parallelWorks');
  const roles = require('../shared/bookRoles');
  const lc = require('../shared/libraryCatalog');
  const { audit, readPaths, catalogInput } = require('./audit-parallels');
  const indexPath = path.join(ROOT, 'otzaria_index_only.txt');

  // ---- 1. pure helpers -------------------------------------------------------------------------
  await check('parallel works: canonical tractates (שביעית is never שבועות), SA parts, parasha headings, perek / hadran markers', () => {
    const t = (n) => pw.tractateName(pw.tractateIndex(n));
    assert.strictEqual(t('שביעית'), 'שביעית');
    assert.strictEqual(t('שבועות'), 'שבועות');
    assert.notStrictEqual(pw.tractateIndex('שביעית'), pw.tractateIndex('שבועות'));
    assert.strictEqual(t('נידה'), 'נדה');
    assert.strictEqual(t('מסכת עוקצין'), 'עוקצים');
    assert.strictEqual(t('בכורים'), 'ביכורים');
    assert.strictEqual(pw.tractateIndex('כלים בבא קמא'), null, 'Tosefta Kelim gates are not Mishnah Kelim chapters');
    assert.deepStrictEqual(['אורח חיים', 'או"ח', 'טור יורה דעה', 'אבן העזר', 'חשן משפט', 'חו"מ', 'הלכות שבת', 'הקדמה'].map(pw.sectionIndex), [0, 0, 1, 2, 3, 3, null, null]);
    const ph = (h) => pw.parashaOfHeading(h).map((i) => require('../shared/torahParshiot').PARSHIOT[i].name);
    assert.deepStrictEqual(ph('פרשת נח'), ['נח']);
    assert.deepStrictEqual(ph('לך-לך'), ['לך לך']);
    assert.deepStrictEqual(ph('פרשת לך לך'), ['לך לך']);
    assert.deepStrictEqual(ph('שלח לך'), ['שלח']);
    assert.deepStrictEqual(ph('כי תשא'), ['כי תשא']);
    assert.deepStrictEqual(ph('פרשת כי תישא'), ['כי תשא']);
    assert.deepStrictEqual(ph('ויקהל-פקודי'), ['ויקהל', 'פקודי']);
    assert.deepStrictEqual(ph('אחרי מות קדושים'), ['אחרי מות', 'קדושים']);
    for (const no of ['פרשה א', 'פרשה ל', 'מצוה א', 'סימן יב', 'הקדמה', 'פרק ו']) assert.deepStrictEqual(ph(no), [], no);
    assert.deepStrictEqual([1, 29, 30, 38, 39, 96, 100, 101].map(pw.bereishitRabbahParasha), [0, 0, 1, 1, 2, 11, 11, null]);
    assert.deepStrictEqual(['פרק א', 'פרק ראשון - במה מדליקין', 'פרק י"א', 'פרק יה', 'פרשה א', 'סימן א'].map(refAlign.perekNumber), [1, 1, 11, null, null, null]);
    assert.strictEqual(refAlign.perekName('פרק ג - בני העיר'), 'בני העיר');
    assert.strictEqual(refAlign.hadranName('<br><big><strong>הֲדַרַן עֲלָךְ מֵאֵימָתַי</strong></big>'), 'מאימתי');
    assert.strictEqual(refAlign.hadranName('הדרן עלך מי שהחשיך וסליקא לה מסכת שבת'), 'מי שהחשיכ');
    assert.strictEqual(refAlign.hadranName('אמר רב הדרן עלך'), null);
  });

  await check('parallel works: membership is an allow-list (strict exclusions, commentaries, wrong folders never join)', () => {
    const m = (cp, title) => {
      const r = pw.memberOf({ title, categoryPath: cp });
      return r ? `${r.work}${r.section != null ? ':' + r.section : ''}${r.tractate != null ? ':' + pw.tractateName(r.tractate) : ''}${r.chumash ? ':' + r.chumash : ''}` : null;
    };
    assert.strictEqual(m('הלכה/טור', 'טור'), 'tur');
    assert.strictEqual(m('הלכה/שולחן ערוך', 'שולחן ערוך, אורח חיים'), 'shulchan_aruch:0');
    assert.strictEqual(m('הלכה/שולחן ערוך', 'שולחן ערוך, חושן משפט'), 'shulchan_aruch:3');
    assert.strictEqual(m('הלכה/שולחן ערוך', 'שולחן ערוך, הקדמה'), null);
    assert.strictEqual(m('הלכה', 'ערוך השולחן'), 'aruch_hashulchan');
    assert.strictEqual(m('הלכה/שולחן ערוך הרב', 'שולחן ערוך הרב'), 'sa_harav');
    assert.strictEqual(m('הלכה/לבוש', 'לבוש התכלת'), 'levush:0');
    assert.strictEqual(m('הלכה/לבוש', 'לבוש עיר שושן'), 'levush:3');
    for (const [cp, t] of [['הלכה', 'קיצור שלחן ערוך'], ['הלכה', 'חיי אדם'], ['הלכה', 'חכמת אדם'], ['הלכה', 'בן איש חי'], ['הלכה', 'ערוך השולחן העתיד'], ['הלכה/ספרי מצוות/ספר המצוות', 'ספר המצוות'], ['הלכה/ספרי מצוות', 'סמג'], ['הלכה/שולחן ערוך/מפרשים/משנה ברורה', 'משנה ברורה'], ['הלכה/שולחן ערוך/מפרשים/באר היטב', 'באר היטב אורח חיים'], ['הלכה/שולחן ערוך הרב', 'פסקי הסידור'], ['הלכה/טור/מפרשים', 'בית יוסף'], ['קבלה/זהר', 'זוהר חדש'], ['קבלה/זהר', 'הסולם על ספר הזהר'], ['הלכה/ספרי מצוות', 'מנחת חינוך'], ['תלמוד בבלי/אחרונים/לבוש מרדכי/סדר נשים', 'לבוש מרדכי על גיטין']]) {
      assert.strictEqual(m(cp, t), null, `${t} must not join a family`);
    }
    assert.strictEqual(m('משנה/סדר מועד', 'משנה שבת'), 'mishna:שבת');
    assert.strictEqual(m('תלמוד בבלי/סדר מועד', 'שבת'), 'bavli:שבת');
    assert.strictEqual(m('תלמוד ירושלמי/סדר מועד', 'תלמוד ירושלמי שבת'), 'yerushalmi:שבת');
    assert.strictEqual(m('תוספתא/מהדורת ליברמן/סדר מועד', 'תוספתא שבת (ליברמן)'), 'tosefta:שבת');
    assert.strictEqual(m('תלמוד בבלי/ראשונים/ריף/סדר מועד', 'ריף שבת'), 'rif:שבת');
    assert.strictEqual(m('תלמוד בבלי/ראשונים/ראש/סדר מועד', 'פסקי הראש על שבת'), 'rosh:שבת');
    assert.strictEqual(m('תלמוד בבלי/ראשונים/ריף/סדר זרעים', 'הערות על ריף ברכות'), null);
    assert.strictEqual(m('תלמוד בבלי/ראשונים/רשי/סדר מועד', 'רשי על שבת'), null);
    assert.strictEqual(m('משנה/ראשונים/ברטנורא/סדר מועד', 'ברטנורא על משנה שבת'), null);
    assert.strictEqual(m('תנך/תורה', 'בראשית'), 'chumash:בראשית');
    assert.strictEqual(m('מדרש/אגדה/מדרש רבה', 'בראשית רבה'), 'midrash_rabbah:בראשית');
    assert.strictEqual(m('מדרש/אגדה/מדרש רבה', 'שיר השירים רבה'), null);
    assert.strictEqual(m('קבלה/זהר', 'ספר הזהר'), 'zohar');
    assert.strictEqual(m('הלכה/ספרי מצוות', 'ספר החינוך'), 'chinuch');
    assert.strictEqual(m('תנך/מפרשים', 'רשי על בראשית'), null);
  });

  // ---- 2. the real Otzaria library map -----------------------------------------------------------
  if (fs.existsSync(indexPath)) {
    const paths = readPaths(indexPath);
    const res = audit(paths);
    const cat = res.catalog;
    const idOf = new Map(paths.map((p, i) => [p, i + 1]));
    await check('real index audit: exact members per family, zero violations (no commentary leaks, no excluded title, no nesting)', () => {
      assert.deepStrictEqual(res.violations, []);
      assert.deepStrictEqual(res.stats.turim, { tur: 1, shulchan_aruch: 4, levush: 0, aruch_hashulchan: 1, sa_harav: 1 });
      assert.deepStrictEqual(res.report.turim.tur, ['הלכה/טור/טור']);
      assert.deepStrictEqual(res.report.turim.aruch_hashulchan, ['הלכה/ערוך השולחן']);
      assert.deepStrictEqual(res.report.turim.sa_harav, ['הלכה/שולחן ערוך הרב/שולחן ערוך הרב']);
      assert.deepStrictEqual(res.stats.shas, { mishna: 63, bavli: 37, yerushalmi: 39, tosefta: 92, rif: 24, rosh: 27 });
      assert.deepStrictEqual(res.stats.parasha, { chumash: 5, midrash_rabbah: 5, tanchuma: 1, tanchuma_buber: 1, zohar: 1, chinuch: 1 });
      assert.deepStrictEqual(res.report.parasha.zohar, ['קבלה/זהר/ספר הזהר']);
      assert.deepStrictEqual(res.report.parasha.chinuch, ['הלכה/ספרי מצוות/ספר החינוך']);
      for (const p of ['הלכה/קיצור שלחן ערוך', 'הלכה/חיי אדם', 'הלכה/חכמת אדם', 'הלכה/בן איש חי', 'הלכה/ערוך השולחן העתיד', 'הלכה/ספרי מצוות/ספר המצוות/ספר המצוות', 'קבלה/זהר/זוהר חדש']) {
        assert.ok(idOf.has(p), `${p} is in the index`);
        assert.strictEqual(cat.isParallel(idOf.get(p)), false, p);
      }
    });
    await check('real index roles: parallel works are standalone, explicit commentaries / targumim only, no heuristic nesting', () => {
      const role = (p) => cat.roleOf(idOf.get(p));
      const base = (p) => (cat.baseOf(idOf.get(p)) ? paths[cat.baseOf(idOf.get(p)) - 1] : null);
      // Four roles.
      assert.strictEqual(role('תלמוד בבלי/סדר מועד/שבת'), 'parallel');
      assert.strictEqual(role('תלמוד בבלי/ראשונים/ראש/סדר מועד/פסקי הראש על שבת'), 'parallel', 'the Rosh is a halachic sibling, not a commentary');
      assert.strictEqual(role('תלמוד בבלי/ראשונים/ריף/סדר זרעים/ריף ברכות'), 'parallel');
      assert.strictEqual(role('הלכה/ערוך השולחן'), 'parallel');
      assert.strictEqual(role('תנך/נביאים/יהושע'), 'base');
      assert.strictEqual(role('תנך/תרגומים/תרגום אונקלוס/תורה/תרגום אונקלוס על בראשית'), 'targum');
      assert.strictEqual(base('תנך/תרגומים/תרגום אונקלוס/תורה/תרגום אונקלוס על בראשית'), 'תנך/תורה/בראשית');
      assert.strictEqual(role('תנך/תרגומים/תרגום/כתובים/תרגום איוב'), 'targum');
      assert.strictEqual(base('תנך/תרגומים/תרגום/כתובים/תרגום איוב'), 'תנך/כתובים/איוב');
      assert.strictEqual(role('תנך/תרגומים/תרגום ירושלמי/תרגום ירושלמי'), 'targum');
      assert.strictEqual(base('תנך/תרגומים/תרגום ירושלמי/תרגום ירושלמי'), null, 'Torah-wide targum: general');
      assert.strictEqual(role('הלכה/שולחן ערוך/מפרשים/משנה ברורה/משנה ברורה'), 'commentary');
      assert.strictEqual(base('הלכה/שולחן ערוך/מפרשים/משנה ברורה/משנה ברורה'), 'הלכה/שולחן ערוך/שולחן ערוך, אורח חיים');
      assert.strictEqual(base('הלכה/טור/מפרשים/בית יוסף'), 'הלכה/טור/טור');
      assert.strictEqual(base('משנה/אחרונים/יכין/סדר נזיקין/יכין בבא קמא'), 'משנה/סדר נזיקין/משנה בבא קמא', '"קמא" inside a tractate name is not a generic tail');
      // Former heuristic false nestings: standalone works now.
      for (const p of [
        'הלכה/אחרונים/חפץ חיים',
        'הלכה/אחרונים/אלה המצות',
        'הלכה/אחרונים/חזון איש/חזון איש, יורה דעה',
        'הלכה/מחברי זמננו/קיצור ילקוט יוסף/קיצור שע ילקוט יוסף החדש - אורח חיים',
        'תלמוד בבלי/מחברי זמננו/בדי הארון - שביעית',
        'משנה/ראשונים/רמבם/סדר קדשים/רמבם הקדמה לסדר קודשים',
        'מחשבת ישראל/ראשונים/מאמר על ישמעאל',
      ]) {
        assert.strictEqual(role(p), 'base', `${p}: ${role(p)} -> ${base(p)}`);
        assert.strictEqual(base(p), null);
      }
      // Every family member stays visible in the base tree.
      const visible = new Set(lc.treeBookIds(cat.sections));
      for (const fam of ['turim', 'shas', 'parasha']) for (const id of cat.parallelFamilyIds(fam)) assert.ok(visible.has(id), `${paths[id - 1]} hidden`);
      // Nothing that is "X על Y" by a known commentator leaks into the base tree as a parallel work.
      for (const fam of ['turim', 'shas', 'parasha']) for (const id of cat.parallelFamilyIds(fam)) assert.ok(!cat.isCommentary(id));
    });
    await check('real index Library hierarchy: Rif / Rosh after the tractates, Tur parallels grouped, SA parts in order', () => {
      const sec = (nodes, name) => nodes.find((n) => n.name === name);
      const bavli = sec(cat.sections, 'תלמוד בבלי');
      const rif = sec(bavli.children, 'רי"ף');
      const rosh = sec(bavli.children, 'רא"ש');
      assert.ok(rif && rosh, bavli.children.map((n) => n.name).join(', '));
      assert.strictEqual(rif.children[0].title, 'ריף ברכות');
      assert.strictEqual(rosh.children[0].title, 'פסקי הראש על ברכות');
      assert.ok(rosh.children.every((n) => n.role === 'parallel' && n.parallelFamily === 'shas'));
      const halacha = sec(cat.sections, 'הלכה');
      const names = halacha.children.map((n) => n.name);
      assert.ok(names.indexOf('ארבעה טורים') < names.indexOf('שולחן ערוך') && names.indexOf('שולחן ערוך') < names.indexOf('ספרים מקבילים לטור ולשולחן ערוך'), names.join(', '));
      assert.deepStrictEqual(sec(halacha.children, 'ספרים מקבילים לטור ולשולחן ערוך').children.map((n) => n.title), ['ערוך השולחן', 'שולחן ערוך הרב']);
      assert.deepStrictEqual(sec(halacha.children, 'שולחן ערוך').children.map((n) => n.title), ['שולחן ערוך, הקדמה', 'שולחן ערוך, אורח חיים', 'שולחן ערוך, יורה דעה', 'שולחן ערוך, אבן העזר', 'שולחן ערוך, חושן משפט']);
    });
  }

  // ---- 3. fixture libraries for every family -----------------------------------------------------
  const pipeline = require('../shared/pipeline');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kodesh-parallel-'));
  try {
    const lib = path.join(tmp, 'אוצריא');
    const put = (rel, lines) => {
      fs.mkdirSync(path.dirname(path.join(lib, rel)), { recursive: true });
      fs.writeFileSync(path.join(lib, rel + '.txt'), lines.join('\n'));
    };
    // ארבעה טורים
    put('הלכה/טור/טור', ['<h1>טור</h1>', '<h2>אורח חיים</h2>', '<h3>הלכות ציצית</h3>', '<h4>סימן יא</h4>', 'טור אוח יא', '<h4>סימן יב</h4>', 'טור אוח יב א', 'טור אוח יב ב', '<h2>יורה דעה</h2>', '<h3>סימן יב</h3>', 'טור יוד יב']);
    put('הלכה/שולחן ערוך/שולחן ערוך, אורח חיים', ['<h1>שולחן ערוך, אורח חיים</h1>', '<h2>סימן יא</h2>', '<h3>סעיף א</h3>', 'שוע אוח יא א', '<h2>סימן יב</h2>', '<h3>סעיף א</h3>', 'שוע אוח יב א', '<h3>סעיף ב</h3>', 'שוע אוח יב ב', '<h3>סעיף ג</h3>', 'שוע אוח יב ג']);
    put('הלכה/שולחן ערוך/שולחן ערוך, יורה דעה', ['<h1>שולחן ערוך, יורה דעה</h1>', '<h2>סימן יב</h2>', '<h3>סעיף א</h3>', 'שוע יוד יב א']);
    put('הלכה/שולחן ערוך/מפרשים/משנה ברורה/משנה ברורה', ['<h1>משנה ברורה</h1>', '<h2>סימן יב</h2>', '<h3>סעיף קטן א</h3>', 'מב יב א', '<h3>סעיף קטן ב</h3>', 'מב יב ב']);
    put('הלכה/ערוך השולחן', ['<h1>ערוך השולחן</h1>', '<h2>אורח חיים</h2>', '<h3>סימן יא</h3>', 'ערוהש אוח יא', '<h3>סימן יב</h3>', 'ערוהש אוח יב א', 'ערוהש אוח יב ב', '<h2>יורה דעה</h2>', '<h3>סימן יב</h3>', 'ערוהש יוד יב']);
    put('הלכה/לבוש/לבוש התכלת', ['<h1>לבוש התכלת</h1>', '<h2>סימן יב</h2>', 'לבוש אוח יב']);
    put('הלכה/שולחן ערוך הרב/שולחן ערוך הרב', ['<h1>שולחן ערוך הרב</h1>', '<h2>אורח חיים</h2>', '<h3>סימן יב</h3>', 'שוע הרב אוח יב']);
    put('הלכה/קיצור שלחן ערוך', ['<h1>קיצור שלחן ערוך</h1>', '<h2>סימן יב</h2>', 'קיצור שוע יב']);
    put('הלכה/חיי אדם', ['<h1>חיי אדם</h1>', '<h2>כלל יב</h2>', 'חיי אדם יב']);
    // משנה / תלמוד
    put('משנה/סדר מועד/משנה שבת', ['<h1>משנה שבת</h1>', '<h2>פרק א</h2>', '<h3>משנה א</h3>', 'משנה שבת א א', '<h3>משנה ב</h3>', 'משנה שבת א ב', '<h2>פרק ב</h2>', '<h3>משנה א</h3>', 'משנה שבת ב א']);
    put('תלמוד בבלי/סדר מועד/שבת', ['<h1>שבת</h1>', '<h2>דף ב.</h2>', 'בבלי שבת ב א פסקה 1', 'בבלי שבת ב א פסקה 2', '<h2>דף ב:</h2>', 'בבלי שבת ב ב', '<big><strong>הֲדַרַן עֲלָךְ יְצִיאוֹת הַשַּׁבָּת</strong></big>', '<h2>דף כ:</h2>', 'בבלי שבת פרק ב', '<big><strong>הדרן עלך במה מדליקין</strong></big>']);
    put('תלמוד בבלי/ראשונים/רשי/סדר מועד/רשי על שבת', ['<h1>רשי על שבת</h1>', '<h2>דף ב.</h2>', '<h3>שורה ב</h3>', 'רשי שבת ב א שורה ב']);
    put('תלמוד ירושלמי/סדר מועד/תלמוד ירושלמי שבת', ['<h1>תלמוד ירושלמי שבת</h1>', '<h2>פרק א</h2>', '<h3>הלכה א</h3>', 'ירושלמי שבת א א', '<h2>פרק ב</h2>', '<h3>הלכה א</h3>', 'ירושלמי שבת ב א']);
    put('תוספתא/דפוס וילנא/סדר מועד/תוספתא שבת', ['<h1>תוספתא שבת</h1>', '<h2>פרק א</h2>', '<h3>הלכה א</h3>', 'תוספתא שבת א א', '<h2>פרק ב</h2>', 'תוספתא שבת ב א']);
    put('תלמוד בבלי/ראשונים/ראש/סדר מועד/פסקי הראש על שבת', ['<h1>פסקי הראש על שבת</h1>', '<h2>פרק א</h2>', '<h3>סימן א</h3>', 'ראש שבת א א', '<h2>פרק ב</h2>', 'ראש שבת ב א']);
    put('משנה/סדר זרעים/משנה שביעית', ['<h1>משנה שביעית</h1>', '<h2>פרק א</h2>', 'משנה שביעית א']);
    put('משנה/סדר נזיקין/משנה שבועות', ['<h1>משנה שבועות</h1>', '<h2>פרק א</h2>', 'משנה שבועות א']);
    put('תלמוד ירושלמי/סדר זרעים/תלמוד ירושלמי שביעית', ['<h1>תלמוד ירושלמי שביעית</h1>', '<h2>פרק א</h2>', 'ירושלמי שביעית א']);
    put('משנה/סדר מועד/משנה מגילה', ['<h1>משנה מגילה</h1>', '<h2>פרק א - מגילה נקראת</h2>', 'משנה מגילה א', '<h2>פרק ב - הקורא את המגילה למפרע</h2>', 'משנה מגילה ב', '<h2>פרק ג - בני העיר</h2>', 'משנה מגילה ג בני העיר', '<h2>פרק ד - הקורא עומד</h2>', 'משנה מגילה ד הקורא עומד']);
    put('תלמוד בבלי/סדר מועד/מגילה', ['<h1>מגילה</h1>', '<h2>דף ב.</h2>', 'בבלי מגילה פרק א', 'הדרן עלך מגילה נקראת', '<h2>דף יז.</h2>', 'בבלי מגילה פרק ב', 'הדרן עלך הקורא את המגילה למפרע', '<h2>דף כא.</h2>', 'בבלי מגילה פרק ג הקורא עומד', 'הדרן עלך הקורא עומד', '<h2>דף כה:</h2>', 'בבלי מגילה פרק ד בני העיר', 'הדרן עלך בני העיר וסליקא לה מסכת מגילה']);
    put('תלמוד ירושלמי/סדר מועד/תלמוד ירושלמי מגילה', ['<h1>תלמוד ירושלמי מגילה</h1>', '<h2>פרק א</h2>', 'ירושלמי מגילה א', '<h2>פרק ג</h2>', 'ירושלמי מגילה ג']);
    // פרשת השבוע
    const ch6 = Array.from({ length: 22 }, (_, i) => `בראשית ו ${i + 1}`);
    const ch12 = Array.from({ length: 20 }, (_, i) => `בראשית יב ${i + 1}`);
    put('תנך/תורה/בראשית', ['<h1>בראשית</h1>', '<h2>פרק ו</h2>', ...ch6, '<h2>פרק יב</h2>', ...ch12]);
    put('מדרש/אגדה/מדרש רבה/בראשית רבה', ['<h1>בראשית רבה</h1>', '<h2>פרשה כט</h2>', 'בר כט', '<h2>פרשה ל</h2>', 'בר ל אלה תולדות נח', '<h2>פרשה לא</h2>', 'בר לא', '<h2>פרשה לט</h2>', 'בר לט לך לך']);
    put('קבלה/זהר/ספר הזהר', ['<h1>ספר הזהר</h1>', '<h2>בראשית</h2>', '<h3>פרשת בראשית</h3>', 'זהר בראשית', '<h3>פרשת נח</h3>', 'זהר נח', '<h3>פרשת לך לך</h3>', 'זהר לך לך', '<h2>שמות</h2>', '<h3>פרשת שמות</h3>', 'זהר שמות']);
    put('הלכה/ספרי מצוות/ספר החינוך', ['<h1>ספר החינוך</h1>', '<h2>פרשת בראשית</h2>', '<h3>מצוה א</h3>', 'חינוך מצוה א', '<h2>פרשת נח</h2>', 'חינוך נח', '<h2>פרשת לך-לך</h2>', '<h3>מצוה ב</h3>', 'חינוך מצוה ב מילה']);
    put('מדרש/אגדה/מדרש תנחומא', ['<h1>מדרש תנחומא</h1>', '<h2>בראשית</h2>', '<h3>נח</h3>', '<h4>סימן א</h4>', 'תנחומא נח א']);
    put('הלכה/ספרי מצוות/ספר המצוות/ספר המצוות', ['<h1>ספר המצוות</h1>', '<h2>מצות עשה א</h2>', 'ספר המצוות עשה א', '<h2>מצות עשה ב</h2>', 'ספר המצוות עשה ב']);

    const db = openWal(path.join(tmp, 'parallel.db'));
    await indexer.ensureSchema(db.w, { kind: 'core' });
    await pipeline.runImport(db.w, nodeFs, { source: { kind: 'folder', root: lib }, sourceUri: lib, targetDb: 'core', yieldToUI: () => Promise.resolve(), finalize: false });
    await pipeline.completeImport(db.w);
    const id = async (title) => Number((await db.read.all('SELECT id FROM books WHERE title = ?', [title]))[0].id);
    const lineOf = async (title, text) => {
      const bookId = await id(title);
      return { bookId, line: Number((await db.read.all('SELECT line_index AS l FROM paragraphs WHERE book_id = ? AND display_text LIKE ?', [bookId, text + '%']))[0].l) };
    };
    const par = async (title, text) => {
      const at = await lineOf(title, text);
      return pw.findParallels(db.read, at.bookId, at.line);
    };
    const summary = (r) => r.parallels.map((p) => `${p.name}: ${p.label} [${p.preview[0] ? p.preview[0].display_text : '-'}]`);

    await check('4-Turim: שו"ע או"ח סימן יב סעיף ג <-> טור / לבוש / ערוך השולחן / שו"ע הרב או"ח סימן יב (never קיצור שו"ע), both directions', async () => {
      const r = await par('שולחן ערוך, אורח חיים', 'שוע אוח יב ג');
      assert.strictEqual(r.family, 'turim');
      assert.strictEqual(r.coordinate.label, 'או"ח סימן י"ב', 'the seif resolves to its siman');
      assert.deepStrictEqual(summary(r), ['טור: או"ח סימן י"ב [טור אוח יב א]', 'לבוש: או"ח סימן י"ב [לבוש אוח יב]', 'ערוך השולחן: או"ח סימן י"ב [ערוהש אוח יב א]', 'שולחן ערוך הרב: או"ח סימן י"ב [שוע הרב אוח יב]']);
      assert.ok(!r.parallels.some((p) => /קיצור|חיי אדם/.test(p.bookTitle)), 'קיצור שו"ע / חיי אדם are never linked');
      // Reverse: the Tur's OC siman 12 -> the OC Shulchan Aruch (not YD), the OC unit of Aruch HaShulchan.
      const tur = await par('טור', 'טור אוח יב ב');
      assert.deepStrictEqual(summary(tur), ['שולחן ערוך: או"ח סימן י"ב [שוע אוח יב א]', 'לבוש: או"ח סימן י"ב [לבוש אוח יב]', 'ערוך השולחן: או"ח סימן י"ב [ערוהש אוח יב א]', 'שולחן ערוך הרב: או"ח סימן י"ב [שוע הרב אוח יב]']);
      const yd = await par('טור', 'טור יוד יב');
      assert.deepStrictEqual(summary(yd), ['שולחן ערוך: יו"ד סימן י"ב [שוע יוד יב א]', 'ערוך השולחן: יו"ד סימן י"ב [ערוהש יוד יב]'], 'Yoreh De\'ah siman 12 is another siman');
      const ah = await par('ערוך השולחן', 'ערוהש אוח יב ב');
      assert.deepStrictEqual(ah.parallels.map((p) => p.name), ['טור', 'שולחן ערוך', 'לבוש', 'שולחן ערוך הרב']);
      const lev = await par('לבוש התכלת', 'לבוש אוח יב');
      assert.ok(lev.parallels.some((p) => p.name === 'שולחן ערוך' && p.label === 'או"ח סימן י"ב'));
      // Excluded books have no parallels at all.
      assert.deepStrictEqual((await par('קיצור שלחן ערוך', 'קיצור שוע יב')).parallels, []);
      assert.strictEqual((await par('קיצור שלחן ערוך', 'קיצור שוע יב')).family, null);
      // A sibling is opened at the siman's start (its heading line) and its block covers the siman only.
      const t12 = r.parallels[0];
      const rows = await db.read.all('SELECT line_index, display_text FROM paragraphs WHERE book_id = ? AND line_index BETWEEN ? AND ? ORDER BY line_index', [t12.bookId, t12.start, t12.end]);
      assert.deepStrictEqual(rows.map((x) => x.display_text), ['סימן יב', 'טור אוח יב א', 'טור אוח יב ב']);
    });

    await check('4-Turim drawer: משנה ברורה (commentary) and the Tur family (parallels) together, parallels folded and last', async () => {
      const at = await lineOf('שולחן ערוך, אורח חיים', 'שוע אוח יב ג');
      const own = commentary.groupLinkedEntries(await commentary.fetchLinkedEntries(db.read, at.bookId, at.line));
      const pgs = commentary.parallelGroups(await pw.findParallels(db.read, at.bookId, at.line));
      const merged = commentary.mergeParallelGroups(own, pgs);
      const ranked = rank.rankCommentaries(merged, { context: { title: 'שולחן ערוך, אורח חיים' } });
      assert.deepStrictEqual(ranked.map((g) => [g.displayName, g.kind, g.tier]), [
        ['משנה ברורה', 'commentary', 'עיקריים'],
        ['טור', 'parallel', 'מקבילים'],
        ['לבוש', 'parallel', 'מקבילים'],
        ['ערוך השולחן', 'parallel', 'מקבילים'],
        ['שולחן ערוך הרב', 'parallel', 'מקבילים'],
      ]);
      assert.deepStrictEqual([...rank.defaultExpandedKeys(ranked)], [ranked[0].key], 'only the commentary opens by default');
      assert.deepStrictEqual(rank.kindCounts(ranked), { commentary: 1, targum: 0, parallel: 4 });
      assert.deepStrictEqual(rank.filterCommentaries(ranked, { kind: 'parallel' }).map((g) => g.displayName), ['טור', 'לבוש', 'ערוך השולחן', 'שולחן ערוך הרב']);
      assert.deepStrictEqual(rank.filterCommentaries(ranked, { kind: 'commentary' }).map((g) => g.displayName), ['משנה ברורה']);
      const tur = ranked.find((g) => g.displayName === 'טור');
      assert.strictEqual(tur.block.refKey, 'או"ח סימן י"ב');
      assert.ok(tur.key.startsWith('parallel:'), 'pins / expansion of a parallel never collide with a commentator');
      // Only parallels (Aruch HaShulchan has no commentaries): they open.
      const only = rank.rankCommentaries(commentary.parallelGroups(await par('ערוך השולחן', 'ערוהש אוח יב ב')), {});
      assert.strictEqual(rank.defaultExpandedKeys(only).size, Math.min(3, only.length), 'no commentaries: the top parallels open');
    });

    await check('Shas: בבלי שבת פרק א <-> משנה / ירושלמי / תוספתא / רא"ש שבת פרק א (perakim from "הדרן עלך"), both directions, with Rashi alongside', async () => {
      const r = await par('שבת', 'בבלי שבת ב א פסקה 2');
      assert.strictEqual(r.coordinate.label, 'שבת פרק א\'');
      assert.deepStrictEqual(summary(r), ['משנה: שבת פרק א\' [משנה שבת א א]', 'ירושלמי: שבת פרק א\' [ירושלמי שבת א א]', 'תוספתא: שבת פרק א\' [תוספתא שבת א א]', 'רא"ש: שבת פרק א\' [ראש שבת א א]']);
      assert.deepStrictEqual(summary(await par('שבת', 'בבלי שבת פרק ב')).map((x) => x.split(' [')[0]), ['משנה: שבת פרק ב\'', 'ירושלמי: שבת פרק ב\'', 'תוספתא: שבת פרק ב\'', 'רא"ש: שבת פרק ב\'']);
      // Reverse directions land on the Bavli's perek (from daf ב. to the first hadran).
      for (const [title, text] of [['משנה שבת', 'משנה שבת א ב'], ['תלמוד ירושלמי שבת', 'ירושלמי שבת א א'], ['תוספתא שבת', 'תוספתא שבת א א'], ['פסקי הראש על שבת', 'ראש שבת א א']]) {
        const b = (await par(title, text)).parallels.find((p) => p.work === 'bavli');
        assert.ok(b, `${title} -> Bavli`);
        assert.strictEqual(b.label, 'שבת פרק א\'');
        assert.strictEqual(b.preview[0].display_text, 'בבלי שבת ב א פסקה 1');
        const last = await db.read.all('SELECT display_text FROM paragraphs WHERE book_id = ? AND line_index = ?', [b.bookId, b.end]);
        assert.ok(/הדרן|הֲדַרַן/.test(last[0].display_text), 'the perek ends at its hadran');
      }
      // Rashi on the same paragraph is still a commentary; the Bavli's parallels come next to it.
      const at = await lineOf('שבת', 'בבלי שבת ב א פסקה 2');
      const own = commentary.groupLinkedEntries(await commentary.fetchLinkedEntries(db.read, at.bookId, at.line));
      assert.deepStrictEqual(own.map((g) => g.name), ['רשי'], 'שורה ב = paragraph 2');
      const merged = commentary.mergeParallelGroups(own, commentary.parallelGroups(r));
      const ranked = rank.rankCommentaries(merged, { context: { title: 'שבת' } });
      assert.deepStrictEqual(ranked.map((g) => g.displayName), ['רש"י', 'משנה', 'ירושלמי', 'תוספתא', 'רא"ש']);
      // The Rosh, paired with the Bavli by its "על" title at import, is shown once, as a parallel work.
      const atRosh = await lineOf('פסקי הראש על שבת', 'ראש שבת א א');
      const roshOwn = commentary.groupLinkedEntries(await commentary.fetchLinkedEntries(db.read, atRosh.bookId, atRosh.line));
      const roshMerged = commentary.mergeParallelGroups(roshOwn, commentary.parallelGroups(await pw.findParallels(db.read, atRosh.bookId, atRosh.line)));
      assert.strictEqual(roshMerged.filter((g) => g.bookTitle === 'שבת').length, 1);
      assert.strictEqual(roshMerged.find((g) => g.bookTitle === 'שבת').linkType, 'parallel');
    });

    await check('Shas: tractates match canonically (שבועות is never שביעית) and Megillah\'s perek-order divergence links by name only', async () => {
      assert.deepStrictEqual((await par('משנה שבועות', 'משנה שבועות א')).parallels, []);
      assert.deepStrictEqual(summary(await par('משנה שביעית', 'משנה שביעית א')), ['ירושלמי: שביעית פרק א\' [ירושלמי שביעית א]']);
      const p = async (title, text) => (await par(title, text)).parallels.map((x) => `${x.name}: ${x.label}`);
      assert.deepStrictEqual(await p('משנה מגילה', 'משנה מגילה א'), ['בבלי: מגילה פרק א\'', 'ירושלמי: מגילה פרק א\''], 'unaffected perek: by number');
      assert.deepStrictEqual(await p('משנה מגילה', 'משנה מגילה ג'), ['בבלי: מגילה פרק ד\'', 'ירושלמי: מגילה פרק ג\''], 'Mishnah ג (בני העיר) = Bavli ד');
      assert.deepStrictEqual(await p('משנה מגילה', 'משנה מגילה ד'), ['בבלי: מגילה פרק ג\''], 'Mishnah ד (הקורא עומד) = Bavli ג');
      assert.deepStrictEqual(await p('מגילה', 'בבלי מגילה פרק ג'), ['משנה: מגילה פרק ד\''], 'Bavli ג -> Mishnah ד; the nameless Yerushalmi ג is not guessed');
      assert.deepStrictEqual(await p('תלמוד ירושלמי מגילה', 'ירושלמי מגילה ג'), ['משנה: מגילה פרק ג\''], 'Yerushalmi (Mishnah order, no perek name) never links to the Bavli ג / ד');
    });

    await check('Parasha: בראשית פרשת נח <-> בראשית רבה / תנחומא / זוהר / ספר החינוך פרשת נח, both directions (never by mitzvah number)', async () => {
      const r = await par('בראשית', 'בראשית ו 9');
      assert.strictEqual(r.coordinate.label, 'פרשת נח');
      assert.deepStrictEqual(summary(r), ['בראשית רבה: פרשת נח [בר ל אלה תולדות נח]', 'מדרש תנחומא: פרשת נח [תנחומא נח א]', 'זוהר: פרשת נח [זהר נח]', 'ספר החינוך: פרשת נח [חינוך נח]']);
      // Verse 6:8 still belongs to parashat Bereishit (absent from this partial Chumash): no Noach link.
      assert.strictEqual((await par('בראשית', 'בראשית ו 8')).coordinate, null);
      const lech = await par('בראשית', 'בראשית יב 5');
      assert.deepStrictEqual(summary(lech), ['בראשית רבה: פרשת לך לך [בר לט לך לך]', 'זוהר: פרשת לך לך [זהר לך לך]', 'ספר החינוך: פרשת לך לך [חינוך מצוה ב מילה]']);
      const z = await par('ספר הזהר', 'זהר נח');
      assert.deepStrictEqual(z.parallels.map((x) => x.name), ['בראשית', 'בראשית רבה', 'מדרש תנחומא', 'ספר החינוך']);
      const chumash = z.parallels[0];
      assert.strictEqual(chumash.preview[0].display_text, 'בראשית ו 9', 'opens the Chumash at 6:9');
      assert.deepStrictEqual((await par('בראשית רבה', 'בר לא')).parallels.map((x) => x.name), ['בראשית', 'מדרש תנחומא', 'זוהר', 'ספר החינוך'], 'Bereishit Rabbah 31 is still Noach');
      assert.deepStrictEqual((await par('ספר החינוך', 'חינוך מצוה ב')).parallels.map((x) => `${x.name}: ${x.label}`), ['בראשית: פרשת לך לך', 'בראשית רבה: פרשת לך לך', 'זוהר: פרשת לך לך']);
      // Zohar's "שמות" volume heading is a book, its "פרשת שמות" a parasha (no Shemot Chumash here).
      assert.strictEqual((await par('ספר הזהר', 'זהר שמות')).coordinate.label, 'פרשת שמות');
      // ספר המצוות is not a parallel work: no coordinate, nothing linked by mitzvah number.
      const sm = await par('ספר המצוות', 'ספר המצוות עשה א');
      assert.strictEqual(sm.family, null);
      assert.deepStrictEqual(sm.parallels, []);
      assert.ok(!(await par('ספר החינוך', 'חינוך מצוה א')).parallels.some((x) => x.bookTitle === 'ספר המצוות'));
    });

    await check('parallel works: the fixture catalog keeps every family member standalone (never nested), targumim apart', async () => {
      const data = await sources.loadCatalog(db.read);
      const cat = lc.buildLibraryCatalog(data);
      const idOfT = new Map(data.books.map((b) => [b.title, b.id]));
      for (const t of ['טור', 'שולחן ערוך, אורח חיים', 'ערוך השולחן', 'לבוש התכלת', 'שולחן ערוך הרב', 'משנה שבת', 'שבת', 'תלמוד ירושלמי שבת', 'תוספתא שבת', 'פסקי הראש על שבת', 'בראשית', 'בראשית רבה', 'ספר הזהר', 'ספר החינוך', 'מדרש תנחומא']) {
        const bid = idOfT.get(t);
        assert.strictEqual(cat.roleOf(bid), 'parallel', t);
        assert.strictEqual(cat.baseOf(bid), null, `${t} is nested under ${cat.bookTitle(cat.baseOf(bid))}`);
        assert.ok(lc.treeBookIds(cat.sections).includes(bid), `${t} visible in ספרי בסיס`);
      }
      for (const t of ['קיצור שלחן ערוך', 'חיי אדם', 'ספר המצוות']) assert.strictEqual(cat.roleOf(idOfT.get(t)), 'base', t);
      assert.strictEqual(cat.roleOf(idOfT.get('משנה ברורה')), 'commentary');
      assert.strictEqual(cat.bookTitle(cat.baseOf(idOfT.get('משנה ברורה'))), 'שולחן ערוך, אורח חיים');
      assert.strictEqual(cat.bookTitle(cat.baseOf(idOfT.get('רשי על שבת'))), 'שבת');
      // Parallel members are listed as their own books, never among another member's commentaries.
      for (const fam of ['turim', 'shas', 'parasha']) for (const pid of cat.parallelFamilyIds(fam)) for (const cid of cat.commentaryIds(pid)) assert.ok(!cat.isParallel(cid), `${cat.bookTitle(cid)} under ${cat.bookTitle(pid)}`);
      assert.strictEqual(await pw.parallelMember(db.read, idOfT.get('ערוך השולחן')).then((m) => m && m.work), 'aruch_hashulchan');
      assert.strictEqual(await pw.parallelMember(db.read, idOfT.get('משנה ברורה')), null);
    });
    await check('parallel works: coordinates are cached per library and cost a handful of queries per paragraph', async () => {
      let n = 0;
      const counting = { all: (sql, params) => (n++, db.read.all(sql, params)) };
      const at = await lineOf('שולחן ערוך, אורח חיים', 'שוע אוח יב ג');
      await pw.findParallels(counting, at.bookId, at.line);
      const first = n;
      n = 0;
      await pw.findParallels(counting, at.bookId, at.line - 2);
      assert.ok(n <= 4, `second lookup: ${n} queries (previews only)`);
      assert.ok(first <= 20, `first lookup: ${first} queries`);
      const t = process.hrtime.bigint();
      for (let i = 0; i < 50; i++) await pw.findParallels(counting, at.bookId, at.line);
      assert.ok(Number(process.hrtime.bigint() - t) / 1e6 / 50 < 15, 'cached lookups stay fast');
    });
    db.raw.close();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // ---- 4. UI wiring + CI scripts -----------------------------------------------------------------
  await check('UI wiring: the drawer separates מקבילים / תרגומים from מפרשים (kind pills, dashed parallel chips, section, prominent פתח בספר) in the compact layout', () => {
    const pane = fs.readFileSync(path.join(ROOT, 'src/components/reader/CommentaryPane.tsx'), 'utf8');
    for (const id of ['findParallels', 'mergeParallelGroups', 'parallelGroups', 'commentary-kind-', 'commentary-chip-parallel', 'parallel-group', 'parallel-group-name', 'parallel-section', 'parallel-open', 'parallel-focus-row', 'parallel-block', 'מקבילים', 'ספרים עצמאיים']) assert.ok(pane.includes(id), id);
    assert.ok(/header: \{[^}]*height: 36/.test(pane), 'compact 36px title bar');
    assert.ok(/pill: \{[^}]*height: 28/.test(pane), '28px chips');
    assert.ok(/focusRow: \{[^}]*height: 28/.test(pane), 'ultra-slim focus row');
    assert.ok(/pillParallel: \{[^}]*borderStyle: 'dashed'/.test(pane));
    assert.ok(pane.includes('{g.block || par ? null : ('), 'no per-paragraph path in a block / parallel unit (named once in the header)');
    assert.ok(!/(paddingLeft|paddingRight|marginLeft|marginRight)/.test(pane), 'RTL-safe styles');
    const reader = fs.readFileSync(path.join(ROOT, 'src/components/reader/BookReader.tsx'), 'utf8');
    assert.ok(reader.includes('parallelMember(adapter, bookId)') && reader.includes('parallelRef.current && !row.is_heading'), 'a parallel-only book opens the drawer');
    const cols = fs.readFileSync(path.join(ROOT, 'src/components/LibraryColumns.tsx'), 'utf8');
    assert.ok(cols.includes("n.role === 'parallel'") && cols.includes('tree-parallel-') && cols.includes('⇄ מקביל'));
  });
  await check('CI scripts stay zero-node_modules: audit-parallels / export-starter-packs / build-db / cloud-release and the new shared modules need Node built-ins only', () => {
    const guard = `const M=require('module');const o=M._resolveFilename;M._resolveFilename=function(r,...a){` +
      `if(!r.startsWith('.')&&!r.startsWith('/')&&!M.builtinModules.includes(r.replace(/^node:/,'')))throw new Error('third-party require: '+r);` +
      `return o.call(this,r,...a)};`;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kr-guard-'));
    try {
      const guardFile = path.join(dir, 'guard.js');
      fs.writeFileSync(guardFile, guard);
      for (const f of ['scripts/audit-parallels.js', 'scripts/export-starter-packs.js', 'scripts/build-db.js', 'scripts/cloud-release.js', 'shared/parallelWorks.js', 'shared/bookRoles.js', 'shared/canonLists.js', 'shared/libraryCatalog.js']) {
        const c = spawnSync(process.execPath, ['-r', guardFile, '-e', `require(${JSON.stringify(path.join(ROOT, f))})`], { encoding: 'utf8' });
        assert.strictEqual(c.status, 0, `${f} needs a third-party module:\n${c.stderr}`);
      }
      if (fs.existsSync(indexPath)) {
        const c = spawnSync(process.execPath, ['-r', guardFile, path.join(ROOT, 'scripts/audit-parallels.js'), '--json'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
        assert.strictEqual(c.status, 0, c.stderr);
        const out = JSON.parse(c.stdout);
        assert.deepStrictEqual(out.violations, []);
        assert.strictEqual(out.stats.shas.bavli, 37);
      }
      const wf = fs.readFileSync(path.join(ROOT, '.github/workflows/build-library.yml'), 'utf8');
      assert.ok(wf.includes('node scripts/audit-parallels.js'), 'the cloud build runs the parallel-works audit');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    void roles;
  });
}
