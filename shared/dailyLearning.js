/**
 * Offline daily study schedule ("לימוד יומי") and its mapping onto Otzaria library books.
 *
 *   computeDailyLearning(date, { il })  ->  today's Hebrew date and the items:
 *     parasha   פרשת השבוע + today's aliyah (Sunday = ראשון ... Friday = שישי, Shabbat = שביעי
 *               and the whole parsha); doubled weeks give both parshiot's aliyah
 *     dafYomi   דף היומי (Bavli tractate + daf; Shekalim -> Yerushalmi perek / halacha)
 *     mishna    משנה יומית (two mishnayot)
 *     rambam1   רמב"ם יומי, one chapter a day
 *     rambam3   רמב"ם יומי, three chapters a day
 *
 * Pure JavaScript, no network: @hebcal/core (weekly sedra, Israel / Diaspora), @hebcal/learning
 * (Daf Yomi, Mishna Yomit, Rambam schedules) and @hebcal/hdate (Hebrew date). Only the light
 * per-schedule modules are imported, not the packages' full indexes.
 *
 * Every item carries `targets`: the real Otzaria file path of the book (as in
 * otzaria_index_only.txt, "תנך/תורה/בראשית", "משנה/סדר טהרות/משנה נגעים", "הלכה/משנה תורה/ספר
 * קדושה/משנה תורה, הלכות מאכלות אסורות") and a location to resolve inside it. findLibraryBooks()
 * + resolveTarget() map them onto the open library (src/services/dailyLearningNav.ts); a book that
 * is not in the library is reported as unavailable, never thrown.
 */
'use strict';

const { HDate } = require('@hebcal/hdate');
const { getSedra } = require('@hebcal/core/dist/esm/sedra');
const { DafYomi } = require('@hebcal/learning/dafYomiBase');
const { MishnaYomiIndex } = require('@hebcal/learning/mishnaYomiBase');
const { dailyRambam1 } = require('@hebcal/learning/rambam1Base');
const { dailyRambam3 } = require('@hebcal/learning/rambam3Base');

const { formatHebrewNumeral, intToHebrew } = require('./hebrew');
const { sourcesOf } = require('./sources');
const { resolveInBook } = require('./quickJump');
const torah = require('./torahParshiot');

// --- Otzaria book maps ------------------------------------------------------------------------

/** hebcal Daf Yomi tractate -> [folder, Otzaria title]. */
const BAVLI = {
  Berachot: ['תלמוד בבלי/סדר זרעים', 'ברכות'],
  Shabbat: ['תלמוד בבלי/סדר מועד', 'שבת'],
  Eruvin: ['תלמוד בבלי/סדר מועד', 'עירובין'],
  Pesachim: ['תלמוד בבלי/סדר מועד', 'פסחים'],
  // Otzaria's Bavli has no Shekalim text: the Daf Yomi learns the Yerushalmi (see SHEKALIM_DAF).
  Shekalim: ['תלמוד ירושלמי/סדר מועד', 'תלמוד ירושלמי שקלים', 'שקלים'],
  Yoma: ['תלמוד בבלי/סדר מועד', 'יומא'],
  Sukkah: ['תלמוד בבלי/סדר מועד', 'סוכה'],
  Beitzah: ['תלמוד בבלי/סדר מועד', 'ביצה'],
  'Rosh Hashana': ['תלמוד בבלי/סדר מועד', 'ראש השנה'],
  Taanit: ['תלמוד בבלי/סדר מועד', 'תענית'],
  Megillah: ['תלמוד בבלי/סדר מועד', 'מגילה'],
  'Moed Katan': ['תלמוד בבלי/סדר מועד', 'מועד קטן'],
  Chagigah: ['תלמוד בבלי/סדר מועד', 'חגיגה'],
  Yevamot: ['תלמוד בבלי/סדר נשים', 'יבמות'],
  Ketubot: ['תלמוד בבלי/סדר נשים', 'כתובות'],
  Nedarim: ['תלמוד בבלי/סדר נשים', 'נדרים'],
  Nazir: ['תלמוד בבלי/סדר נשים', 'נזיר'],
  Sotah: ['תלמוד בבלי/סדר נשים', 'סוטה'],
  Gitin: ['תלמוד בבלי/סדר נשים', 'גיטין'],
  Kiddushin: ['תלמוד בבלי/סדר נשים', 'קידושין'],
  'Baba Kamma': ['תלמוד בבלי/סדר נזיקין', 'בבא קמא'],
  'Baba Metzia': ['תלמוד בבלי/סדר נזיקין', 'בבא מציעא'],
  'Baba Batra': ['תלמוד בבלי/סדר נזיקין', 'בבא בתרא'],
  Sanhedrin: ['תלמוד בבלי/סדר נזיקין', 'סנהדרין'],
  Makkot: ['תלמוד בבלי/סדר נזיקין', 'מכות'],
  Shevuot: ['תלמוד בבלי/סדר נזיקין', 'שבועות'],
  'Avodah Zarah': ['תלמוד בבלי/סדר נזיקין', 'עבודה זרה'],
  Horayot: ['תלמוד בבלי/סדר נזיקין', 'הוריות'],
  Zevachim: ['תלמוד בבלי/סדר קדשים', 'זבחים'],
  Menachot: ['תלמוד בבלי/סדר קדשים', 'מנחות'],
  Chullin: ['תלמוד בבלי/סדר קדשים', 'חולין'],
  Bechorot: ['תלמוד בבלי/סדר קדשים', 'בכורות'],
  Arachin: ['תלמוד בבלי/סדר קדשים', 'ערכין'],
  Temurah: ['תלמוד בבלי/סדר קדשים', 'תמורה'],
  Keritot: ['תלמוד בבלי/סדר קדשים', 'כריתות'],
  Meilah: ['תלמוד בבלי/סדר קדשים', 'מעילה'],
  // Kinnim and Middot have no Gemara: their Daf Yomi pages are the Mishnah (opened at its start).
  Kinnim: ['משנה/סדר קדשים', 'משנה קינים', 'קינים'],
  Tamid: ['תלמוד בבלי/סדר קדשים', 'תמיד'],
  Midot: ['משנה/סדר קדשים', 'משנה מדות', 'מדות'],
  Niddah: ['תלמוד בבלי/סדר טהרות', 'נדה'],
};

/** Daf Yomi Shekalim daf (amud א) -> Yerushalmi [perek, halacha] (hebcal's shekalimDafYomiMap). */
const SHEKALIM_DAF = { 2: [1, 1], 3: [1, 1], 4: [1, 4], 5: [1, 4], 6: [2, 3], 7: [2, 4], 8: [3, 1], 9: [3, 2], 10: [4, 1], 11: [4, 2], 12: [4, 4], 13: [4, 4], 14: [5, 1], 15: [5, 3], 16: [6, 1], 17: [6, 2], 18: [6, 3], 19: [6, 4], 20: [7, 2], 21: [7, 3], 22: [8, 3] };

const SEDARIM = ['סדר זרעים', 'סדר מועד', 'סדר נשים', 'סדר נזיקין', 'סדר קדשים', 'סדר טהרות'];
/** hebcal Mishna Yomit tractate -> [seder index, Hebrew name] (Otzaria title "משנה <name>"). */
const MISHNA = {
  Berakhot: [0, 'ברכות'], Peah: [0, 'פאה'], Demai: [0, 'דמאי'], Kilayim: [0, 'כלאים'], Sheviit: [0, 'שביעית'], Terumot: [0, 'תרומות'],
  Maasrot: [0, 'מעשרות'], 'Maaser Sheni': [0, 'מעשר שני'], Challah: [0, 'חלה'], Orlah: [0, 'ערלה'], Bikkurim: [0, 'ביכורים'],
  Shabbat: [1, 'שבת'], Eruvin: [1, 'עירובין'], Pesachim: [1, 'פסחים'], Shekalim: [1, 'שקלים'], Yoma: [1, 'יומא'], Sukkah: [1, 'סוכה'],
  Beitzah: [1, 'ביצה'], 'Rosh Hashanah': [1, 'ראש השנה'], Taanit: [1, 'תענית'], Megillah: [1, 'מגילה'], 'Moed Katan': [1, 'מועד קטן'], Chagigah: [1, 'חגיגה'],
  Yevamot: [2, 'יבמות'], Ketubot: [2, 'כתובות'], Nedarim: [2, 'נדרים'], Nazir: [2, 'נזיר'], Sotah: [2, 'סוטה'], Gittin: [2, 'גיטין'], Kiddushin: [2, 'קידושין'],
  'Bava Kamma': [3, 'בבא קמא'], 'Bava Metzia': [3, 'בבא מציעא'], 'Bava Batra': [3, 'בבא בתרא'], Sanhedrin: [3, 'סנהדרין'], Makkot: [3, 'מכות'],
  Shevuot: [3, 'שבועות'], Eduyot: [3, 'עדיות'], 'Avodah Zarah': [3, 'עבודה זרה'], Avot: [3, 'אבות'], Horayot: [3, 'הוריות'],
  Zevachim: [4, 'זבחים'], Menachot: [4, 'מנחות'], Chullin: [4, 'חולין'], Bekhorot: [4, 'בכורות'], Arakhin: [4, 'ערכין'], Temurah: [4, 'תמורה'],
  Keritot: [4, 'כריתות'], Meilah: [4, 'מעילה'], Tamid: [4, 'תמיד'], Middot: [4, 'מדות'], Kinnim: [4, 'קינים'],
  Kelim: [5, 'כלים'], Oholot: [5, 'אהלות'], Negaim: [5, 'נגעים'], Parah: [5, 'פרה'], Tahorot: [5, 'טהרות'], Mikvaot: [5, 'מקואות'],
  Niddah: [5, 'נדה'], Makhshirin: [5, 'מכשירין'], Zavim: [5, 'זבים'], 'Tevul Yom': [5, 'טבול יום'], Yadayim: [5, 'ידים'], Oktzin: [5, 'עוקצים'],
};

/** hebcal Rambam section -> [sefer folder, Hebrew name] (Otzaria title "משנה תורה, <name>"). */
const RAMBAM = {
  'Transmission of the Oral Law': ['הקדמה', 'מסירת תורה שבעל פה'],
  'Positive Mitzvot': ['הקדמה', 'מצוות עשה'],
  'Negative Mitzvot': ['הקדמה', 'מצוות לא תעשה'],
  'Overview of Mishneh Torah Contents': ['הקדמה', 'תוכן החיבור'],
  'Foundations of the Torah': ['ספר מדע', 'הלכות יסודי התורה'],
  'Human Dispositions': ['ספר מדע', 'הלכות דעות'],
  'Torah Study': ['ספר מדע', 'הלכות תלמוד תורה'],
  'Foreign Worship and Customs of the Nations': ['ספר מדע', 'הלכות עבודה זרה וחוקות הגויים'],
  Repentance: ['ספר מדע', 'הלכות תשובה'],
  'Reading the Shema': ['ספר אהבה', 'הלכות קריאת שמע'],
  'Prayer and the Priestly Blessing': ['ספר אהבה', 'הלכות תפילה וברכת כהנים'],
  'Tefillin, Mezuzah and the Torah Scroll': ['ספר אהבה', 'הלכות תפילין ומזוזה וספר תורה'],
  Fringes: ['ספר אהבה', 'הלכות ציצית'],
  Blessings: ['ספר אהבה', 'הלכות ברכות'],
  Circumcision: ['ספר אהבה', 'הלכות מילה'],
  'The Order of Prayer': ['ספר אהבה', 'סדר התפילה'],
  Sabbath: ['ספר זמנים', 'הלכות שבת'],
  Eruvin: ['ספר זמנים', 'הלכות עירובין'],
  'Rest on the Tenth of Tishrei': ['ספר זמנים', 'הלכות שביתת עשור'],
  'Rest on a Holiday': ['ספר זמנים', 'הלכות שביתת יום טוב'],
  'Leavened and Unleavened Bread': ['ספר זמנים', 'הלכות חמץ ומצה'],
  'Shofar, Sukkah and Lulav': ['ספר זמנים', 'הלכות שופר וסוכה ולולב'],
  'Sheqel Dues': ['ספר זמנים', 'הלכות שקלים'],
  'Sanctification of the New Month': ['ספר זמנים', 'הלכות קידוש החודש'],
  Fasts: ['ספר זמנים', 'הלכות תעניות'],
  'Scroll of Esther and Hanukkah': ['ספר זמנים', 'הלכות מגילה וחנוכה'],
  Marriage: ['ספר נשים', 'הלכות אישות'],
  Divorce: ['ספר נשים', 'הלכות גירושין'],
  'Levirate Marriage and Release': ['ספר נשים', 'הלכות יבום וחליצה'],
  'Virgin Maiden': ['ספר נשים', 'הלכות נערה בתולה'],
  'Woman Suspected of Infidelity': ['ספר נשים', 'הלכות סוטה'],
  'Forbidden Intercourse': ['ספר קדושה', 'הלכות איסורי ביאה'],
  'Forbidden Foods': ['ספר קדושה', 'הלכות מאכלות אסורות'],
  'Ritual Slaughter': ['ספר קדושה', 'הלכות שחיטה'],
  Oaths: ['ספר הפלאה', 'הלכות שבועות'],
  Vows: ['ספר הפלאה', 'הלכות נדרים'],
  Nazariteship: ['ספר הפלאה', 'הלכות נזירות'],
  'Appraisals and Devoted Property': ['ספר הפלאה', 'הלכות ערכים וחרמין'],
  'Diverse Species': ['ספר זרעים', 'הלכות כלאים'],
  'Gifts to the Poor': ['ספר זרעים', 'הלכות מתנות עניים'],
  'Heave Offerings': ['ספר זרעים', 'הלכות תרומות'],
  Tithes: ['ספר זרעים', 'הלכות מעשרות'],
  "Second Tithes and Fourth Year's Fruit": ['ספר זרעים', 'הלכות מעשר שני ונטע רבעי'],
  'First Fruits and other Gifts to Priests Outside the Sanctuary': ['ספר זרעים', 'הלכות ביכורים ושאר מתנות כהונה שבגבולין'],
  'Sabbatical Year and the Jubilee': ['ספר זרעים', 'הלכות שמיטה ויובל'],
  'The Chosen Temple': ['ספר עבודה', 'הלכות בית הבחירה'],
  'Vessels of the Sanctuary and Those who Serve Therein': ['ספר עבודה', 'הלכות כלי המקדש והעובדין בו'],
  'Admission into the Sanctuary': ['ספר עבודה', 'הלכות ביאת מקדש'],
  'Things Forbidden on the Altar': ['ספר עבודה', 'הלכות איסורי המזבח'],
  'Sacrificial Procedure': ['ספר עבודה', 'הלכות מעשה הקרבנות'],
  'Daily Offerings and Additional Offerings': ['ספר עבודה', 'הלכות תמידים ומוספין'],
  'Sacrifices Rendered Unfit': ['ספר עבודה', 'הלכות פסולי המוקדשין'],
  'Service on the Day of Atonement': ['ספר עבודה', 'הלכות עבודת יום הכפורים'],
  Trespass: ['ספר עבודה', 'הלכות מעילה'],
  'Paschal Offering': ['ספר קורבנות', 'הלכות קרבן פסח'],
  'Festival Offering': ['ספר קורבנות', 'הלכות חגיגה'],
  Firstlings: ['ספר קורבנות', 'הלכות בכורות'],
  'Offerings for Unintentional Transgressions': ['ספר קורבנות', 'הלכות שגגות'],
  'Offerings for Those with Incomplete Atonement': ['ספר קורבנות', 'הלכות מחוסרי כפרה'],
  Substitution: ['ספר קורבנות', 'הלכות תמורה'],
  'Defilement by a Corpse': ['ספר טהרה', 'הלכות טומאת מת'],
  'Red Heifer': ['ספר טהרה', 'הלכות פרה אדומה'],
  'Defilement by Leprosy': ['ספר טהרה', 'הלכות טומאת צרעת'],
  'Those Who Defile Bed or Seat': ['ספר טהרה', 'הלכות מטמאי משכב ומושב'],
  'Other Sources of Defilement': ['ספר טהרה', 'הלכות שאר אבות הטומאות'],
  'Defilement of Foods': ['ספר טהרה', 'הלכות טומאת אוכלים'],
  Vessels: ['ספר טהרה', 'הלכות כלים'],
  'Immersion Pools': ['ספר טהרה', 'הלכות מקואות'],
  'Damages to Property': ['ספר נזיקין', 'הלכות נזקי ממון'],
  Theft: ['ספר נזיקין', 'הלכות גניבה'],
  'Robbery and Lost Property': ['ספר נזיקין', 'הלכות גזילה ואבידה'],
  'One Who Injures a Person or Property': ['ספר נזיקין', 'הלכות חובל ומזיק'],
  'Murderer and the Preservation of Life': ['ספר נזיקין', 'הלכות רוצח ושמירת נפש'],
  Sales: ['ספר קניין', 'הלכות מכירה'],
  'Ownerless Property and Gifts': ['ספר קניין', 'הלכות זכייה ומתנה'],
  Neighbors: ['ספר קניין', 'הלכות שכנים'],
  'Agents and Partners': ['ספר קניין', 'הלכות שלוחין ושותפין'],
  Slaves: ['ספר קניין', 'הלכות עבדים'],
  Hiring: ['ספר משפטים', 'הלכות שכירות'],
  'Borrowing and Deposit': ['ספר משפטים', 'הלכות שאלה ופיקדון'],
  'Creditor and Debtor': ['ספר משפטים', 'הלכות מלווה ולווה'],
  'Plaintiff and Defendant': ['ספר משפטים', 'הלכות טוען ונטען'],
  Inheritances: ['ספר משפטים', 'הלכות נחלות'],
  'The Sanhedrin and the Penalties within their Jurisdiction': ['ספר שופטים', 'הלכות סנהדרין והעונשין המסורין להם'],
  Testimony: ['ספר שופטים', 'הלכות עדות'],
  Rebels: ['ספר שופטים', 'הלכות ממרים'],
  Mourning: ['ספר שופטים', 'הלכות אבל'],
  'Kings and Wars': ['ספר שופטים', 'הלכות מלכים ומלחמות'],
};

const WEEKDAY_ALIYAH = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שביעי'];

// --- labels ---------------------------------------------------------------------------------

const num = (n) => intToHebrew(n) || String(n);

/** 'י"ג בכסלו תשפ"ז' (gershayim as ASCII quotes, like the rest of the UI). */
function hebrewDateLabel(hd) {
  const parts = hd.renderGematriya(true).replace(/״/g, '"').replace(/׳/g, "'").split(' ');
  const day = parts.shift();
  const year = parts.pop();
  return `${day} ב${parts.join(' ')} ${year}`;
}

/** "1-21" / "8-9" / 13 -> Hebrew numerals ("א-כא", "ח-ט", "יג"). */
function perekLabel(perek) {
  if (typeof perek === 'number') return num(perek);
  return String(perek).replace(/\d+/g, (d) => num(Number(d)));
}

function firstChapter(perek) {
  if (typeof perek === 'number') return perek;
  const m = /^(\d+)/.exec(String(perek));
  return m ? Number(m[1]) : null;
}

// --- schedule -----------------------------------------------------------------------------

function toHDate(date) {
  return date instanceof HDate ? date : new HDate(date);
}

/**
 * The weekly parsha being studied on a date: the parsha read on the coming Shabbat (on Shabbat
 * itself, that day's). A Shabbat with a festival reading moves on to the next regular parsha,
 * except that from the Shabbat after האזינו through Simchat Torah the week studies וזאת הברכה.
 * @returns {{ parshiot: object[], shabbat: HDate }}
 */
function weeklyParsha(hd, il) {
  let probe = hd;
  let skippedChag = false;
  for (let i = 0; i < 6; i++) {
    const r = getSedra(probe.getFullYear(), il).lookup(probe);
    if (!r.chag) {
      const nums = Array.isArray(r.num) ? r.num : [r.num];
      let parshiot = nums.map((n) => torah.parshaByNumber(n)).filter(Boolean);
      // Sukkot week (after האזינו, up to and including Simchat Torah): וזאת הברכה.
      const simchatTorah = il ? 22 : 23;
      if (skippedChag && parshiot[0] && parshiot[0].num === 1 && hd.getMonth() === 7 && hd.getDate() <= simchatTorah) {
        parshiot = [torah.PARSHIOT[53]];
      }
      return { parshiot, shabbat: r.hdate };
    }
    skippedChag = true;
    probe = new HDate(r.hdate.abs() + 1);
  }
  return { parshiot: [], shabbat: hd };
}

function parashaItem(date, hd, il) {
  const { parshiot } = weeklyParsha(hd, il);
  if (!parshiot.length) return null;
  const weekday = date.getDay();
  const aliyahName = WEEKDAY_ALIYAH[weekday];
  const targets = parshiot.map((p) => {
    const a = p.aliyot[Math.min(weekday, 6)];
    return {
      path: `תנך/תורה/${p.book}`,
      bookTitle: p.book,
      label: parshiot.length > 1 ? `${p.name} · ${a.name}` : a.name,
      loc: { kind: 'verse', chapter: a.start.chapter, verse: a.start.verse },
      ref: torah.fullRefLabel(p.book, a.start),
    };
  });
  // Shabbat: the seventh aliyah, and the whole parsha from its start.
  if (weekday === 6) {
    for (const p of parshiot) {
      targets.push({ path: `תנך/תורה/${p.book}`, bookTitle: p.book, label: parshiot.length > 1 ? `כל פרשת ${p.name}` : 'כל הפרשה', loc: { kind: 'verse', chapter: p.start.chapter, verse: p.start.verse }, ref: torah.fullRefLabel(p.book, p.start) });
    }
  }
  const name = parshiot.map((p) => p.name).join('-');
  return {
    key: 'parasha',
    label: 'פרשת השבוע',
    title: `${name} · ${weekday === 6 ? 'שביעי וכל הפרשה' : aliyahName}`,
    detail: '',
    parsha: { names: parshiot.map((p) => p.name), nums: parshiot.map((p) => p.num), aliyah: aliyahName },
    targets,
  };
}

function dafYomiItem(date) {
  const daf = new DafYomi(date);
  const name = daf.getName();
  const blatt = Number(daf.getBlatt());
  const map = BAVLI[name];
  if (!map) return { key: 'dafYomi', label: 'דף היומי', title: `${name} ${blatt}`, detail: '', targets: [] };
  const [folder, otzTitle, shortName] = map;
  const display = shortName || otzTitle;
  let loc;
  let note = '';
  if (name === 'Shekalim') {
    const [perek, halacha] = SHEKALIM_DAF[blatt] || [1, 1];
    loc = { kind: 'chapter', chapter: perek, sub: halacha };
    note = `ירושלמי פרק ${num(perek)} הלכה ${num(halacha)}`;
  } else if (folder.startsWith('משנה')) {
    loc = { kind: 'start' };
    note = 'משנה';
  } else {
    loc = { kind: 'daf', daf: blatt, amud: 'א' };
  }
  return {
    key: 'dafYomi',
    label: 'דף היומי',
    title: `${display} דף ${num(blatt)}`,
    detail: note,
    daf: { tractate: name, blatt },
    targets: [{ path: `${folder}/${otzTitle}`, bookTitle: otzTitle, label: `${display} ${num(blatt)}.`, loc, ref: `${display} ${num(blatt)}.` }],
  };
}

let mishnaIndex = null;
function mishnaItem(date) {
  if (!mishnaIndex) mishnaIndex = new MishnaYomiIndex();
  const list = mishnaIndex.lookup(date);
  if (!list || !list.length) return null;
  const parts = list.map(({ k, v }) => {
    const [chapter, mishna] = String(v).split(':').map(Number);
    const m = MISHNA[k];
    return { tractate: k, name: m ? m[1] : k, seder: m ? SEDARIM[m[0]] : null, chapter, mishna };
  });
  const a = parts[0];
  const b = parts[parts.length - 1];
  let title;
  if (parts.length === 1) title = `${a.name} ${num(a.chapter)}, ${num(a.mishna)}`;
  else if (a.tractate !== b.tractate) title = `${a.name} ${num(a.chapter)}, ${num(a.mishna)} – ${b.name} ${num(b.chapter)}, ${num(b.mishna)}`;
  else if (a.chapter !== b.chapter) title = `${a.name} ${num(a.chapter)}, ${num(a.mishna)} – ${num(b.chapter)}, ${num(b.mishna)}`;
  else title = `${a.name} ${num(a.chapter)}, ${num(a.mishna)}-${num(b.mishna)}`;
  const targets = [];
  for (const p of parts) {
    if (!p.seder) continue;
    if (targets.some((t) => t.path === `משנה/${p.seder}/משנה ${p.name}` && t.loc.chapter === p.chapter)) continue;
    targets.push({ path: `משנה/${p.seder}/משנה ${p.name}`, bookTitle: `משנה ${p.name}`, label: `${p.name} ${num(p.chapter)}, ${num(p.mishna)}`, loc: { kind: 'chapter', chapter: p.chapter, sub: p.mishna }, ref: `משנה ${p.name} ${num(p.chapter)}, ${num(p.mishna)}` });
  }
  return { key: 'mishna', label: 'משנה יומית', title, detail: '', mishnayot: parts.map((p) => ({ tractate: p.tractate, chapter: p.chapter, mishna: p.mishna })), targets };
}

function rambamTarget(r) {
  const m = RAMBAM[r.name];
  if (!m) return null;
  const [sefer, name] = m;
  const chapter = sefer === 'הקדמה' ? null : firstChapter(r.perek);
  return {
    path: `הלכה/משנה תורה/${sefer}/משנה תורה, ${name}`,
    bookTitle: `משנה תורה, ${name}`,
    name,
    label: `${name} ${perekLabel(r.perek)}`,
    loc: chapter ? { kind: 'chapter', chapter } : { kind: 'start' },
    ref: `רמב"ם ${name} ${perekLabel(r.perek)}`,
  };
}

function rambamItem(key, label, readings) {
  const parts = readings.map((r) => ({ r, t: rambamTarget(r) }));
  const named = parts.filter((p) => p.t);
  if (!named.length) return { key, label, title: readings.map((r) => `${r.name} ${r.perek}`).join(', '), detail: '', targets: [] };
  // "הלכות שאלה ופיקדון ו-ח" (one section) / "הלכות א ט – הלכות ב ב" (two sections).
  const groups = [];
  for (const p of named) {
    const g = groups[groups.length - 1];
    if (g && g.name === p.t.name) g.pereks.push(p.r.perek);
    else groups.push({ name: p.t.name, pereks: [p.r.perek] });
  }
  const title = groups
    .map((g) => (g.pereks.length === 1 ? `${g.name} ${readings.length === 1 && typeof g.pereks[0] === 'number' ? 'פרק ' : ''}${perekLabel(g.pereks[0])}` : `${g.name} ${perekLabel(g.pereks[0])}-${perekLabel(g.pereks[g.pereks.length - 1])}`))
    .join(' – ');
  const targets = [];
  for (const p of named) if (!targets.some((t) => t.path === p.t.path)) targets.push(p.t);
  return { key, label, title, detail: '', rambam: readings.map((r) => ({ name: r.name, perek: r.perek })), targets };
}

/**
 * Today's study schedule.
 * @param {Date} [date]  civil date (local); defaults to now
 * @param {{ il?: boolean }} [opts]  il: Israel (default) or Diaspora parsha schedule
 */
function computeDailyLearning(date, opts) {
  const d = date ? new Date(date.getFullYear(), date.getMonth(), date.getDate()) : (() => { const n = new Date(); return new Date(n.getFullYear(), n.getMonth(), n.getDate()); })();
  const il = !opts || opts.il !== false;
  const hd = toHDate(d);
  const items = [];
  const errors = [];
  const add = (fn) => {
    try {
      const it = fn();
      if (it) items.push(it);
    } catch (e) {
      errors.push(String((e && e.message) || e));
    }
  };
  add(() => parashaItem(d, hd, il));
  add(() => dafYomiItem(d));
  add(() => mishnaItem(d));
  add(() => rambamItem('rambam1', 'רמב"ם יומי – פרק אחד', [dailyRambam1(d)]));
  add(() => rambamItem('rambam3', 'רמב"ם יומי – 3 פרקים', dailyRambam3(d)));
  return {
    date: d,
    dateKey: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
    il,
    hebrewDate: hebrewDateLabel(hd),
    weekday: d.getDay(),
    items,
    errors,
  };
}

// --- library resolution ----------------------------------------------------------------------

/**
 * Finds the library books for Otzaria paths ("תנך/תורה/בראשית"): Map(path -> { id, title,
 * totalLines }). A book matches by its file_path ("<path>.txt", also below a top folder such as
 * "אוצריא/<path>.txt"); otherwise by title inside the same corpus folder (first path segment), so a
 * library imported with a different folder layout still resolves. Missing paths are left out.
 */
async function findLibraryBooks(db, paths) {
  const want = [...new Set(paths)];
  const out = new Map();
  if (!want.length) return out;
  for (const s of sourcesOf(db)) {
    const missing = want.filter((p) => !out.has(p));
    if (!missing.length) break;
    const files = missing.map((p) => `${p}.txt`);
    const rows = await s.adapter.all(`SELECT id, title, total_lines, file_path FROM books WHERE file_path IN (${files.map(() => '?').join(',')})`, files);
    for (const r of rows) out.set(String(r.file_path).replace(/\.txt$/, ''), { id: r.id, title: r.title, totalLines: r.total_lines });
    for (const p of missing.filter((x) => !out.has(x))) {
      const name = p.split('/').pop();
      const top = p.split('/')[0];
      const hit = await s.adapter.all(
        `SELECT b.id, b.title, b.total_lines, b.file_path FROM books b
          WHERE b.file_path LIKE ? OR (b.file_path LIKE ? AND b.file_path LIKE ? AND b.file_path NOT LIKE '%מפרשים%')
          ORDER BY length(b.file_path) LIMIT 1`,
        [`%/${p}.txt`, `%/${name}.txt`, `%${top}/%`],
      );
      if (hit[0]) out.set(p, { id: hit[0].id, title: hit[0].title, totalLines: hit[0].total_lines });
    }
  }
  return out;
}

/**
 * The line of a target inside its library book: TOC headings (chapter / daf / perek, by ref_key)
 * and inline "(א)" markers (verse / mishnah / halacha). `exact` is false when only part of the
 * location was found (the deepest match is used) or the book has no such structure (line 1).
 */
async function resolveTarget(db, book, loc) {
  const keys = [];
  if (loc.kind === 'verse') keys.push({ key: num(loc.chapter) }, { key: num(loc.verse) });
  else if (loc.kind === 'daf') keys.push({ key: `${num(loc.daf)}${loc.amud === 'ב' ? ':' : '.'}` });
  else if (loc.kind === 'chapter') {
    keys.push({ key: num(loc.chapter) });
    if (loc.sub && loc.sub > 1) keys.push({ key: num(loc.sub) });
  }
  if (!keys.length) return { line: 1, exact: true, path: [] };
  const r = await resolveInBook(db, { id: book.id, totalLines: book.totalLines }, keys);
  const matched = keys.length - r.unmatched.length;
  return { line: matched > 0 ? r.targetLine : 1, exact: r.unmatched.length === 0, path: r.path };
}

/**
 * Resolves every target of a schedule against the library:
 * items[i].targets[j] gains { available, bookId, libraryTitle, line, exact }.
 */
async function resolveDailyLearning(db, schedule) {
  const paths = schedule.items.flatMap((it) => it.targets.map((t) => t.path));
  const books = await findLibraryBooks(db, paths);
  const items = [];
  for (const it of schedule.items) {
    const targets = [];
    for (const t of it.targets) {
      const b = books.get(t.path);
      if (!b) {
        targets.push({ ...t, available: false, bookId: null, libraryTitle: null, line: null, exact: false });
        continue;
      }
      try {
        const r = await resolveTarget(db, b, t.loc);
        targets.push({ ...t, available: true, bookId: b.id, libraryTitle: b.title, line: r.line, exact: r.exact });
      } catch {
        targets.push({ ...t, available: true, bookId: b.id, libraryTitle: b.title, line: 1, exact: false });
      }
    }
    items.push({ ...it, targets, available: targets.some((t) => t.available) });
  }
  return { ...schedule, items };
}

/**
 * ארץ ישראל or חו"ל for the weekly parsha, from an IANA time zone: Asia/Jerusalem (and its old aliases) = Israel,
 * any other zone = the Diaspora; no zone (unknown / detection unavailable) = Israel.
 */
function isIsraelTimeZone(tz) {
  if (!tz || typeof tz !== 'string') return true;
  return tz === 'Asia/Jerusalem' || tz === 'Asia/Tel_Aviv' || tz === 'Israel';
}

/** Detects `il` from the device's time zone (`tz` overrides it, for tests; `null` = unavailable). */
function detectIl(tz) {
  let zone = tz;
  if (zone === undefined) {
    try {
      zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch {
      zone = null;
    }
  }
  return isIsraelTimeZone(zone);
}

module.exports = {
  isIsraelTimeZone,
  detectIl,
  BAVLI,
  MISHNA,
  RAMBAM,
  SEDARIM,
  SHEKALIM_DAF,
  WEEKDAY_ALIYAH,
  hebrewDateLabel,
  weeklyParsha,
  computeDailyLearning,
  findLibraryBooks,
  resolveTarget,
  resolveDailyLearning,
};
