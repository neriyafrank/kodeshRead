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
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const assert = require('assert');
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
      // Commentaries rank before translations (Onkelos is a targum).
      const bereshit = (await db.all("SELECT id FROM books WHERE title='בראשית'", []))[0].id;
      const bg = commentary.groupLinkedEntries(await commentary.fetchLinkedEntries(db, bereshit, 3));
      assert.deepStrictEqual(bg.map((g) => g.name), ['רש"י', 'אונקלוס']);
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
      assert.strictEqual(v.books, 9);
      const meta = await indexer.readMeta(openDb(out));
      assert.strictEqual(meta.db_version, manifest.version);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
}

main();
