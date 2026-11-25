#!/usr/bin/env node
/**
 * Builds shared/halachaTopics.json: the topical divisions (הלכות ...) of Shulchan Aruch and Tur, from Sefaria's
 * Index API (`/api/v2/raw/index/<Title>`, the `alt_structs` of each text). Run once, commit the JSON; the app never
 * calls Sefaria (works offline).
 *
 *   node scripts/fetch-sa-topics.js            # fetch + write shared/halachaTopics.json
 *   node scripts/fetch-sa-topics.js --dry      # fetch + print a summary, write nothing
 *   node scripts/fetch-sa-topics.js --from=dir # read <dir>/<slug>.json (saved index responses) instead of the network
 *
 * Node shape read from `alt_structs` (any struct; "Topic" / "Subject" / "Topics" preferred, else the first with
 * usable nodes): { nodes: [ { titles: [{lang:'he', text, primary}] | heTitle, wholeRef: "Shulchan Arukh, Orach Chayim 8-24",
 * refs?: [...], nodes?: [...] } ] }. Nodes without a range descend into their children. A Tur section without
 * alt_structs falls back to the Shulchan Aruch siman ranges of the same section (recorded in `turFallback`).
 *
 * Output: { source, fetched, pending: false, sa: { oc, yd, eh, cm: [{ t, from, to }] }, tur: {...}, turFallback: [...] }
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');

const OUT = path.join(__dirname, '..', 'shared', 'halachaTopics.json');
const SECTIONS = ['oc', 'yd', 'eh', 'cm'];
const TITLES = {
  sa: {
    oc: ['Shulchan Arukh, Orach Chayim', 'Shulchan Arukh, Orach Chaim'],
    yd: ["Shulchan Arukh, Yoreh De'ah", 'Shulchan Arukh, Yoreh Deah'],
    eh: ['Shulchan Arukh, Even HaEzer'],
    cm: ['Shulchan Arukh, Choshen Mishpat'],
  },
  tur: {
    oc: ['Tur, Orach Chaim', 'Tur, Orach Chayim'],
    yd: ['Tur, Yoreh Deah', "Tur, Yoreh De'ah"],
    eh: ['Tur, Even HaEzer'],
    cm: ['Tur, Choshen Mishpat'],
  },
};
/** Section named inside a Sefaria ref ("Tur, Yoreh De'ah 1-28" -> 'yd'); null when the ref names none. */
function sectionOfRef(ref) {
  const r = String(ref || '');
  if (/orach\s*chay?i?m/i.test(r)) return 'oc';
  if (/yoreh\s*de/i.test(r)) return 'yd';
  if (/even\s*ha-?\s*ezer/i.test(r)) return 'eh';
  if (/choshen\s*mishpat/i.test(r)) return 'cm';
  return null;
}

/** Number of simanim per section (Shulchan Aruch and Tur share them): a larger topic range means the wrong section's topics. */
const MAX_SIMAN = { oc: 697, yd: 403, eh: 178, cm: 427 };
const PREFERRED = ['topic', 'topics', 'subject', 'subjects'];

function getJson(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { 'User-Agent': 'text-library-build/1.0', Accept: 'application/json' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) return resolve(getJson(new URL(res.headers.location, url).href));
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(new Error(`bad JSON from ${url}: ${e.message}`));
          }
        });
      })
      .on('error', reject);
  });
}

const heTitleOf = (node) => {
  const ts = Array.isArray(node.titles) ? node.titles.filter((t) => t && t.lang === 'he') : [];
  const t = ts.find((x) => x.primary) || ts[0];
  return String((t && t.text) || node.heTitle || '').replace(/<[^>]*>/g, '').trim();
};

/** "Shulchan Arukh, Orach Chayim 8-24" / "...8:1-24:3" / "... 8" -> { from, to } */
function rangeOf(ref) {
  const m = /\s(\d+)(?::\d+[a-z]?)?(?:\s*[-–]\s*(\d+)(?::\d+[a-z]?)?)?\s*$/i.exec(String(ref || '').trim());
  if (!m) return null;
  const from = Number(m[1]);
  const to = m[2] ? Number(m[2]) : from;
  return from >= 1 && to >= from ? { from, to } : null;
}

function nodeRange(node) {
  const whole = rangeOf(node.wholeRef);
  if (whole) return whole;
  const refs = Array.isArray(node.refs) ? node.refs.map(rangeOf).filter(Boolean) : [];
  return refs.length ? { from: Math.min(...refs.map((r) => r.from)), to: Math.max(...refs.map((r) => r.to)) } : null;
}

function collect(nodes, out) {
  for (const n of nodes || []) {
    const range = nodeRange(n);
    const t = heTitleOf(n);
    if (t && range) out.push({ t, from: range.from, to: range.to, sec: sectionOfRef(n.wholeRef || (Array.isArray(n.refs) && n.refs[0])) });
    else if (Array.isArray(n.nodes)) collect(n.nodes, out);
  }
  return out;
}

/** Topic list of one index response, or [] (no alt_structs / nothing usable). */
function topicsOf(index, sec) {
  const alt = index && index.alt_structs && typeof index.alt_structs === 'object' ? index.alt_structs : null;
  if (!alt) return [];
  const names = Object.keys(alt).sort((a, b) => PREFERRED.indexOf(a.toLowerCase()) - PREFERRED.indexOf(b.toLowerCase()));
  const ordered = [...names.filter((k) => PREFERRED.includes(k.toLowerCase())), ...names.filter((k) => !PREFERRED.includes(k.toLowerCase()))];
  for (const k of ordered) {
    const list = collect(alt[k] && alt[k].nodes, []);
    // Sefaria's Tur alt_structs can hold the topics of all four parts: keep only the requested section's (refs name their part).
    const mine = sec ? list.filter((t) => !t.sec || t.sec === sec) : list;
    if (mine.length) return clean(mine.map(({ t, from, to }) => ({ t, from, to })));
  }
  return [];
}

/** Sorted, de-duplicated, overlap-free (a later topic starts after the previous one ended). */
function clean(list) {
  const sorted = list.slice().sort((a, b) => a.from - b.from || b.to - a.to);
  const out = [];
  for (const t of sorted) {
    const prev = out[out.length - 1];
    if (prev && t.from <= prev.to) {
      if (t.to <= prev.to) continue; // nested in the previous one
      t.from = prev.to + 1;
    }
    out.push(t);
  }
  return out;
}

/** Compact structure dump of an index response (what Sefaria returned), printed when nothing could be parsed. */
function describe(index) {
  if (!index || typeof index !== 'object') return `response is ${typeof index}`;
  const lines = [`top-level keys: ${Object.keys(index).join(', ')}`];
  const alt = index.alt_structs;
  if (!alt || typeof alt !== 'object') lines.push('alt_structs: MISSING');
  else {
    for (const [name, st] of Object.entries(alt)) {
      const nodes = (st && st.nodes) || [];
      lines.push(`alt_structs.${name}: keys [${Object.keys(st || {}).join(', ')}], ${nodes.length} top-level nodes`);
      if (nodes[0]) lines.push(`  first node: ${JSON.stringify(nodes[0]).slice(0, 600)}`);
    }
  }
  return lines.join('\n');
}

async function load(kind, sec, dir) {
  const errors = [];
  for (const title of TITLES[kind][sec]) {
    try {
      if (dir) {
        const f = path.join(dir, `${kind}-${sec}.json`);
        return { title, index: JSON.parse(fs.readFileSync(f, 'utf8')) };
      }
      const url = `https://www.sefaria.org/api/v2/raw/index/${encodeURIComponent(title.replace(/ /g, '_'))}`;
      return { title, index: await getJson(url) };
    } catch (e) {
      errors.push(e.message);
      if (dir) break;
    }
  }
  throw new Error(`${kind}/${sec}: ${errors.join('; ')}`);
}

async function main() {
  const dry = process.argv.includes('--dry');
  const fromArg = process.argv.find((a) => a.startsWith('--from='));
  const dir = fromArg ? fromArg.slice(7) : null;
  const out = { source: 'Sefaria Index API (alt_structs)', fetched: new Date().toISOString().slice(0, 10), pending: false, sa: {}, tur: {}, turFallback: [] };
  for (const sec of SECTIONS) {
    const sa = await load('sa', sec, dir);
    out.sa[sec] = topicsOf(sa.index, sec);
    if (out.sa[sec].length && out.sa[sec][out.sa[sec].length - 1].to > MAX_SIMAN[sec]) throw new Error(`Shulchan Aruch ${sec}: topic ranges run past siman ${MAX_SIMAN[sec]}`);
    if (!out.sa[sec].length) {
      console.error(`--- Sefaria response for ${sa.title} ---\n${describe(sa.index)}`);
      throw new Error(`Shulchan Aruch ${sec}: no topical alt_structs found (see the structure above)`);
    }
  }
  for (const sec of SECTIONS) {
    let topics = [];
    try {
      topics = topicsOf((await load('tur', sec, dir)).index, sec);
    } catch (e) {
      console.warn(`! Tur ${sec}: ${e.message}`);
    }
    if (!topics.length) {
      topics = out.sa[sec].map((t) => ({ ...t }));
      out.turFallback.push(sec);
      console.warn(`! Tur ${sec}: no alt_structs, using the Shulchan Aruch ranges`);
    }
    out.tur[sec] = topics;
    const max = MAX_SIMAN[sec];
    if (topics[topics.length - 1].to > max) throw new Error(`Tur ${sec}: topic ranges run past siman ${max} (${topics[topics.length - 1].t} ${topics[topics.length - 1].from}-${topics[topics.length - 1].to}): the alt_structs mix sections`);
  }
  for (const kind of ['sa', 'tur']) for (const sec of SECTIONS) console.log(`${kind}/${sec}: ${out[kind][sec].length} topics, simanim ${out[kind][sec][0].from}-${out[kind][sec][out[kind][sec].length - 1].to}`);
  if (!dry) {
    fs.writeFileSync(OUT, JSON.stringify(out) + '\n');
    console.log(`wrote ${path.relative(process.cwd(), OUT)}`);
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error('fetch-sa-topics failed:', e.message);
    process.exit(1);
  });
}
module.exports = { MAX_SIMAN, sectionOfRef, topicsOf, rangeOf, clean, describe };
