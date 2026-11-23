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
const rank = require('../shared/commentaryRank');

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
      assert.strictEqual(counts.get(3), 3, `line 3: ${counts.get(3)}`); // 2x רש"י + תוספות (line links)
      assert.strictEqual(counts.get(2), 2, 'amud heading: רש"י + תוספות aligned units');
      assert.ok(!counts.has(4));
      const rows = commentary.attachLinkCounts(await reader.fetchRange(db, shabbat, 1, 10), counts);
      assert.strictEqual(rows.find((r) => r.line_index === 3).link_count, 3);
      assert.strictEqual(rows.find((r) => r.line_index === 4).link_count, 0);
      // The whole aligned amud block of each commentator; the explicitly linked dibburim are `direct`.
      const groups = commentary.groupLinkedEntries(await commentary.fetchLinkedEntries(db, shabbat, 3));
      assert.deepStrictEqual(groups.map((g) => [g.name, g.entries.length, g.entries.filter((e) => e.direct).length]), [['רש"י', 6, 2], ['תוספות', 2, 1]]);
      assert.ok(groups[0].entries.every((e) => e.display_text && e.toc_path === 'דף ב.'), JSON.stringify(groups[0].entries));
      assert.deepStrictEqual(groups[0].block, { refKey: 'דף ב|עמוד א', start: 2, end: 8 });
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
        [['אונקלוס', 'עיקריים'], ['רש"י', 'עיקריים'], ['רמב"ן', 'עיקריים'], ['אבן עזרא', 'עיקריים'], ['ספורנו', 'עיקריים'], ['מלבי"ם', 'עיקריים'], ['דעת זקנים', 'ראשונים'], ['גור אריה', 'אחרונים']],
      );
      assert.deepStrictEqual([...rank.defaultExpandedKeys(ranked)], ['אונקלוס', 'רשי', 'רמבנ']);
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
  await resumableIngestionTests();
  await refAlignTests();
  await otzariaSampleTests();
  await otzariaIndexTests();
  // 6. Schema v6 streaming pipeline (import_queue, book_units) + the Android foreground service.
  await streamingPipelineTests();
  await otzariaIndexPipelineTests();
  await foregroundServicePluginTests();

  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
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
    await check('refAlign: build reports aligned units', () => assert.ok(/ref links: 7 commentary\/base pair\(s\)/.test(proc.stdout), proc.stdout));

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
      assert.strictEqual(st.pairs, 7);
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
      assert.ok(err && (err.killed || /dead/.test(err.message)), `${name}: expected a kill at ${killAt}, got ${err && err.message}`);
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
    // View chips: core only / favorites only.
    const pinnedT = rank.rankCommentaries(TANACH, { pinned: ['גור אריה'] });
    assert.deepStrictEqual(names(rank.filterCommentaries(pinnedT, { view: 'pinned' })), ['גור אריה']);
    assert.ok(rank.filterCommentaries(pinnedT, { view: 'core' }).every((x) => x.core));
    assert.strictEqual(rank.filterCommentaries(pinnedT, { view: 'core' }).length, 10);
    // Word starts only: "רמ" is not the folded final mem of "הטורים".
    assert.deepStrictEqual(names(rank.filterCommentaries(pinnedT, { view: 'core', query: 'רמ' })), ['רמב"ן']);
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

main();
