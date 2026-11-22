/**
 * Hebrew Torah linguistic & abbreviation engine (zero dependencies besides ./hebrew).
 *
 * Shared by full-text search (shared/search.js: smart FTS5 query expansion + hit
 * highlighting) and Quick Source Navigation (shared/quickJump.js: abbreviation-aware
 * book lookup + location parsing). It works purely at query time on the same
 * normalized form the index uses (normalizeHebrew: no niqqud, no gershayim/geresh,
 * final letters folded), so no database schema change or re-indexing is needed.
 *
 *  1. Bidirectional abbreviation dictionary (ראשי תיבות / קיצורים):
 *       expandAbbreviation('שו"ע')    -> ['שולחנ ערוכ']
 *       abbreviationsFor('בית דין')   -> ['בד', 'ביד']
 *     `רמבם`, `רמב"ם` and `רמב״ם` all resolve identically.
 *  2. Ktiv male / chaser (full / defective spelling) variants for internal ו / י.
 *  3. Proclitic prefixes (ו ה ב כ ל מ ש + combinations) and suffix handling.
 *  4. Hebrew numerals (gematria) <-> integers for location parsing.
 *
 * All returned strings are in normalized index form (finals folded: "שולחנ").
 */
'use strict';

const { normalizeHebrew, normalizeFinals, hebrewNumeralToInt } = require('./hebrew');

// ---------------------------------------------------------------------------
// Dictionary data
// ---------------------------------------------------------------------------
// Entry syntax: 'abbr1|abbr2=full1|full2'. Abbreviations keep their gershayim (")
// or geresh (') so their type is known: acronym (ראשי תיבות, with ") or truncation
// (קיצור, ending with '). Several full forms = an ambiguous abbreviation (most
// common sense first).

/** Works: Shulchan Aruch, poskim, rishonim / acharonim, responsa. */
const BOOKS = [
  'שו"ע|ש"ע|שוע=שולחן ערוך',
  'טוש"ע=טור שולחן ערוך',
  'מ"ב|משנ"ב|מש"ב=משנה ברורה',
  'ב"י=בית יוסף',
  'דרכ"מ|ד"מ=דרכי משה',
  'ב"ח=בית חדש|בעל חוב',
  'ש"ך=שפתי כהן',
  'ט"ז=טורי זהב',
  'מג"א=מגן אברהם',
  'פמ"ג=פרי מגדים',
  'מחה"ש=מחצית השקל',
  'באה"ט=באר היטב',
  'שעה"צ=שער הציון',
  'בה"ל=ביאור הלכה',
  'בא"ח=בן איש חי',
  'כה"ח=כף החיים',
  'ערוה"ש=ערוך השולחן',
  'קצשו"ע|קצוש"ע|קיצשו"ע|קיצור שו"ע=קיצור שולחן ערוך',
  'שוע"ר|שו"ע הרב=שולחן ערוך הרב',
  'ילק"י=ילקוט יוסף',
  'חזו"א=חזון איש',
  'אג"מ|אגר"מ|אגרו"מ=אגרות משה',
  'יבי"א=יביע אומר',
  'יחו"ד=יחוה דעת',
  'שש"כ=שמירת שבת כהלכתה',
  'צי"א=ציץ אליעזר',
  'מנח"י=מנחת יצחק',
  'שבה"ל=שבט הלוי',
  'חוו"י=חוות יאיר',
  'חכ"צ=חכם צבי',
  'נוב"י|נו"ב=נודע ביהודה',
  'אבנ"מ=אבני מילואים',
  'חלק"מ=חלקת מחוקק',
  'ב"ש=בית שמואל|בית שמאי',
  'פ"ת|פת"ש=פתחי תשובה',
  'יש"ש=ים של שלמה',
  'סמ"ע=ספר מאירת עינים',
  'קצוה"ח|קצה"ח=קצות החושן',
  'נתיבו"מ|נתיה"מ=נתיבות המשפט',
  'סמ"ג=ספר מצוות גדול',
  'סמ"ק=ספר מצוות קטן',
  'סה"מ=ספר המצוות',
  'סה"ח=ספר החינוך',
  'מנ"ח=מנחת חינוך',
  'שאג"א=שאגת אריה',
  'או"ז=אור זרוע',
  'תוי"ט=תוספות יום טוב',
  'תוס\'|תוספ\'=תוספות',
  'תוספת\'=תוספתא',
  'מל"מ=משנה למלך',
  'כס"מ=כסף משנה',
  'לח"מ=לחם משנה',
  'הגמ"י=הגהות מיימוניות',
  'פנ"י=פני יהושע',
  'שטמ"ק|שיטמ"ק=שיטה מקובצת',
  'חדא"ג=חידושי אגדות',
  'חדה"ל=חידושי הלכות',
  'חי\'=חידושי',
  'גליה"ש=גליון הש"ס',
  'שו"ת=שאלות ותשובות',
  'חת"ס=חתם סופר',
  'רמב"ם=משנה תורה|רבי משה בן מימון',
  'יד החזקה=משנה תורה',
  'ש"ס=שישה סדרים',
  'תנ"ך=תורה נביאים כתובים',
  'תושבע"פ=תורה שבעל פה',
  'תושב"כ=תורה שבכתב',
  'זוה"ק=זוהר הקדוש',
  'תיקו"ז|תקו"ז=תיקוני זוהר',
  'ע"ח=עץ חיים',
  'מס"י=מסילת ישרים',
  'חוה"ל=חובות הלבבות',
  'של"ה=שני לוחות הברית',
  'אוה"ח=אור החיים',
  'נפה"ח=נפש החיים',
];

/** Sections: Shulchan Aruch parts and Mishneh Torah hilchot. */
const SECTIONS = [
  'או"ח|אוח=אורח חיים',
  'יו"ד=יורה דעה',
  'אה"ע|אבהע"ז|אבה"ע=אבן העזר',
  'חו"מ=חושן משפט',
  'הל\'|הלכ\'=הלכות',
  'יסוה"ת|יסודה"ת=יסודי התורה',
  'ת"ת=תלמוד תורה',
  'ק"ש=קריאת שמע',
  'יוה"כ|יוהכ"פ|יוה"כפ=יום הכיפורים',
  'איסו"ב=איסורי ביאה',
  'מאכ"א=מאכלות אסורות',
  'שבי"ע=שביתת עשור',
  'שבי"ט|שביו"ט=שביתת יום טוב',
  'חו"מ=חמץ ומצה',
  'שו"ס=שופר וסוכה ולולב',
  'קדה"ח|קה"ח=קידוש החודש',
  'מגו"ח=מגילה וחנוכה',
  'יבו"ח=יבום וחליצה',
  'מתנ"ע|מת"ע=מתנות עניים',
  'מע"ש=מעשר שני',
  'שמו"י=שמיטה ויובל',
  'ביה"ב=בית הבחירה',
  'איסו"מ=איסורי מזבח',
  'מעה"ק=מעשה הקרבנות',
  'תו"מ=תמידין ומוספין',
  'פסוה"מ=פסולי המוקדשין',
  'ק"פ=קרבן פסח',
  'מחו"כ=מחוסרי כפרה',
  'טו"מ=טומאת מת',
  'פר"א=פרה אדומה',
  'טו"צ=טומאת צרעת',
  'שאה"ט=שאר אבות הטומאות',
  'טו"א=טומאת אוכלין',
  'נז"מ=נזקי ממון',
  'גו"א=גזילה ואבידה',
  'רו"ש|רוצ"ש=רוצח ושמירת נפש',
  'זו"מ=זכייה ומתנה',
  'שלו"ש=שלוחין ושותפין',
  'שו"פ=שאלה ופיקדון',
  'מו"ל=מלוה ולוה',
  'טו"נ=טוען ונטען',
  'מלכ"מ=מלכים ומלחמותיהם',
  'עו"ח=ערכין וחרמין',
  'נש"כ=נשיאת כפיים',
];

/** Talmud tractates (acronyms + common truncations). */
const TRACTATES = [
  'ב"ק=בבא קמא',
  'ב"מ=בבא מציעא',
  'ב"ב=בבא בתרא',
  'ר"ה=ראש השנה',
  'ע"ז=עבודה זרה',
  'מ"ק=מועד קטן',
  'ברכ\'=ברכות',
  'עירו\'|ערו\'=עירובין',
  'פסח\'=פסחים',
  'שקל\'=שקלים',
  'סוכ\'=סוכה',
  'ביצ\'=ביצה',
  'תענ\'=תענית',
  'מגיל\'|מגי\'=מגילה',
  'חגי\'=חגיגה',
  'יבמ\'=יבמות',
  'כתו\'|כתוב\'=כתובות',
  'נדר\'=נדרים',
  'נזי\'=נזיר',
  'סוט\'=סוטה',
  'גיט\'=גיטין',
  'קידו\'|קדו\'|קידוש\'=קידושין',
  'סנה\'|סנהד\'=סנהדרין',
  'מכו\'=מכות',
  'שבוע\'|שבו\'=שבועות',
  'הורי\'=הוריות',
  'זבח\'=זבחים',
  'מנח\'=מנחות',
  'חול\'=חולין',
  'בכו\'|בכור\'=בכורות',
  'ערכ\'=ערכין',
  'תמו\'=תמורה',
  'כרי\'|כרית\'=כריתות',
  'מעיל\'=מעילה',
  'נד\'|נדה\'=נדה',
  'ירוש\'|ירו\'=ירושלמי',
];

/** Tanach books. */
const TANACH = [
  'בר\'|ברא\'|בראש\'=בראשית',
  'שמ\'|שמו\'=שמות',
  'ויק\'|ויקר\'=ויקרא',
  'במ\'|במד\'|במדב\'=במדבר',
  'דב\'|דבר\'|דברי\'=דברים',
  'יהו\'|יהוש\'=יהושע',
  'שופ\'|שופט\'=שופטים',
  'שמ"א|ש"א=שמואל א',
  'שמ"ב|ש"ב=שמואל ב',
  'מל"א=מלכים א',
  'מל"ב=מלכים ב',
  'ישע\'|ישעי\'=ישעיהו',
  'ירמ\'|ירמי\'=ירמיהו',
  'יחז\'|יחזק\'=יחזקאל',
  'הוש\'=הושע',
  'יוא\'=יואל',
  'עמו\'=עמוס',
  'עובד\'=עובדיה',
  'מיכ\'=מיכה',
  'חבק\'=חבקוק',
  'צפנ\'=צפניה',
  'זכר\'=זכריה',
  'מלא\'|מלאכ\'=מלאכי',
  'תה\'|תהל\'|תהי\'=תהילים',
  'מש\'|משל\'=משלי',
  'איו\'=איוב',
  'שה"ש|שיה"ש=שיר השירים',
  'איכ\'=איכה',
  'קה\'|קהל\'=קהלת',
  'אסת\'=אסתר',
  'דני\'|דנ\'=דניאל',
  'עזר\'=עזרא',
  'נחמ\'=נחמיה',
  'דה"א|דבה"א=דברי הימים א',
  'דה"ב|דבה"ב=דברי הימים ב',
  'תרי"ע=תרי עשר',
];

/** Midrash & aggadah. */
const MIDRASH = [
  'ב"ר|בר"ר=בראשית רבה',
  'שמו"ר|שמ"ר=שמות רבה',
  'ויק"ר|וי"ר=ויקרא רבה',
  'במ"ר|במד"ר=במדבר רבה',
  'דב"ר|דבר"ר=דברים רבה',
  'שהש"ר|שה"ר=שיר השירים רבה',
  'איכ"ר|א"ר=איכה רבה',
  'קה"ר|קהל"ר=קהלת רבה',
  'אס"ר|אסת"ר=אסתר רבה',
  'רו"ר=רות רבה',
  'מכיל\'=מכילתא',
  'תנחו\'|תנח\'=תנחומא',
  'ילק"ש|יל"ש=ילקוט שמעוני',
  'פדר"א|פרדר"א=פרקי דרבי אליעזר',
  'אדר"נ|אבדר"נ=אבות דרבי נתן',
  'תדא"ר|תנדב"א=תנא דבי אליהו',
  'פסדר"כ|פדר"כ=פסיקתא דרב כהנא',
  'פס"ר=פסיקתא רבתי',
  'מדה"ג=מדרש הגדול',
  'מדר"ת=מדרש תהילים',
];

/** Sages, rishonim, acharonim. */
const PEOPLE = [
  'רש"י=רבי שלמה יצחקי',
  'רשב"ם=רבי שמואל בן מאיר',
  'רשב"א=רבי שלמה בן אדרת',
  'ריטב"א=רבי יום טוב בן אברהם',
  'רמב"ן=רבי משה בן נחמן',
  'ראב"ד=רבי אברהם בן דוד|אב בית דין',
  'ראב"ע|אב"ע=אבן עזרא|רבי אברהם אבן עזרא',
  'רלב"ג=רבי לוי בן גרשום',
  'רא"ש=רבנו אשר|רבינו אשר',
  'רי"ף=רבי יצחק אלפסי',
  'ר"ן=רבנו נסים|רבינו נסים',
  'ר"ח=רבנו חננאל|ראש חודש',
  'ר"ת=רבנו תם|ראשי תיבות|רבינו תם',
  'ר"י=רבי יהודה|רבי יוחנן|רבנו יצחק',
  'ר"מ=רבי מאיר',
  'ר"ש=רבי שמעון',
  'ר"א=רבי אליעזר|רבי אלעזר',
  'ר"ע=רבי עקיבא',
  'ריב"ז=רבן יוחנן בן זכאי',
  'רשב"י=רבי שמעון בר יוחאי',
  'רשב"ג=רבן שמעון בן גמליאל',
  'ריב"ל=רבי יהושע בן לוי',
  'רע"א|רעק"א=רבי עקיבא איגר',
  'רמ"א=רבי משה איסרליש',
  'מהרש"א=מורנו הרב שמואל אליעזר',
  'מהרש"ל=מורנו הרב שלמה לוריא',
  'מהר"ל=מורנו הרב ליווא',
  'מהרי"ק=מורנו הרב יוסף קולון',
  'מהרי"ל=מורנו הרב יעקב לוי',
  'גר"א|הגר"א=גאון רבי אליהו|הגאון רבי אליהו',
  'בעש"ט=בעל שם טוב',
  'רמח"ל=רבי משה חיים לוצאטו',
  'אריז"ל|האריז"ל=האר"י זכרונו לברכה',
  'חיד"א=חיים יוסף דוד אזולאי',
  'ת"ק=תנא קמא',
];

/** General Torah phrases (full-text search). */
const GENERAL = [
  'ב"ד|בי"ד=בית דין',
  'אב"ד=אב בית דין',
  'יו"ט=יום טוב',
  'ת"ח=תלמיד חכם|תלמידי חכמים',
  'ע"ה=עם הארץ|עליו השלום',
  'לש"ה|לה"ר=לשון הרע',
  'פרו"ר=פריה ורביה',
  'ב"נ=בני נח|בן נח',
  'עכו"ם|עכומ"ז=עובדי כוכבים ומזלות|עובד כוכבים ומזלות',
  'עובד ע"ז=עובד עבודה זרה',
  'הקב"ה=הקדוש ברוך הוא',
  'קוב"ה=קודשא בריך הוא',
  'אע"פ=אף על פי',
  'אעפ"כ=אף על פי כן',
  'אע"ג=אף על גב',
  'מ"מ=מכל מקום|מגיד משנה',
  'ק"ו=קל וחומר',
  'גז"ש|ג"ש=גזירה שווה',
  'ס"ד=סלקא דעתך|סייעתא דשמיא',
  'סד"א=סלקא דעתך אמינא',
  'בע"כ=בעל כרחו|בעל כרחך',
  'ד"א=דבר אחר|ארבע אמות',
  'ד\' אמות=ארבע אמות',
  'א"י=ארץ ישראל',
  'חו"ל=חוץ לארץ',
  'בהמ"ק|ביהמ"ק=בית המקדש',
  'כה"ג=כהן גדול|כהאי גוונא',
  'ס"ת|סה"ת=ספר תורה|סוף תיבה',
  'א"א=אי אפשר|אדוני אבי',
  'א"ב=אלף בית',
  'א"ל=אמר ליה|אמר לו',
  'א"ר=אמר רבי|אמר רב|אליה רבה',
  'א"כ=אם כן',
  'א"נ=אי נמי',
  'א"ת=אם תאמר|אל תקרי',
  'א"צ=אין צריך',
  'אא"כ=אלא אם כן',
  'אה"נ=אין הכי נמי',
  'א"ש=אתי שפיר',
  'אפ"ה=אפילו הכי',
  'אפי\'=אפילו',
  'אחז"ל=אמרו חכמינו זכרונם לברכה',
  'אוה"ע=אומות העולם',
  'בד"א=במה דברים אמורים',
  'ב"ה=ברוך השם|בית הלל|ברוך הוא',
  'בהכ"נ|ביהכ"נ|בה"כ=בית הכנסת',
  'בהמ"ד|ביהמ"ד=בית המדרש',
  'בע"ח=בעלי חיים|בעל חוב',
  'בעה"ב|בעל הב\'=בעל הבית',
  'בע"פ=בעל פה',
  'ב"ו=בשר ודם',
  'בשו"א=בשום אופן',
  'בכ"מ=בכל מקום',
  'בפ"ע=בפני עצמו',
  'בתוה"ד=בתוך הדברים',
  'ג"כ=גם כן',
  'ג"ע=גילוי עריות|גן עדן',
  'גו\'|וגו\'=וגומר',
  'ד"ה=דיבור המתחיל',
  'ד"ת=דברי תורה|דין תורה',
  'ד"ס=דברי סופרים',
  'דאו\'|דאורי\'=דאורייתא',
  'מדאו\'|מדאורי\'=מדאורייתא',
  'דרבנ\'|מדרבנ\'=דרבנן',
  'ה"מ=הני מילי|הגהות מיימוניות',
  'ה"נ=הכי נמי',
  'ה"ד=היכי דמי',
  'ה"ה=הוא הדין|הרי הוא',
  'ה"ק=הכי קאמר',
  'הש"י|השי"ת=השם יתברך',
  'הלמ"מ|הל"מ=הלכה למשה מסיני',
  'הנ"ל=הנזכר לעיל',
  'וכו\'=וכולי',
  'וא"ת=ואם תאמר',
  'וי"ל=ויש לומר',
  'וי"א=ויש אומרים',
  'וכ"ת=וכי תימא',
  'ודו"ק=ודוק ותשכח',
  'ז"ל=זכרונו לברכה|זה לשונו',
  'זצ"ל=זכר צדיק לברכה',
  'זצוק"ל=זכר צדיק וקדוש לברכה',
  'זי"ע=זכותו יגן עלינו',
  'ז"א=זאת אומרת|זעיר אנפין',
  'חז"ל=חכמינו זכרונם לברכה',
  'ח"ו=חס ושלום',
  'חש"ו=חרש שוטה וקטן',
  'חוה"מ|חה"מ=חול המועד',
  'ט"ס=טעות סופר',
  'י"א=יש אומרים',
  'י"ל=יש לומר',
  'י"מ=יש מפרשים',
  'יוה"כ=יום הכיפורים',
  'יצה"ר=יצר הרע',
  'יצה"ט=יצר הטוב',
  'י"ח=ידי חובה|ידי חובתו',
  'יה"ר=יהי רצון',
  'יר"ש=יראת שמים',
  'יצ"מ=יציאת מצרים',
  'ימוה"מ=ימות המשיח',
  'כ"ש=כל שכן',
  'כ"ז=כל זה|כל זמן',
  'כ"ה=כן הוא',
  'כ"כ=כל כך|כמו כן',
  'כנ"ל=כנזכר לעיל',
  'כמש"כ=כמו שכתב',
  'כמ"ש=כמו שכתוב|כמו שכתב',
  'כו"כ=כמה וכמה',
  'כ"א=כל אחד',
  'כ"ע=כולי עלמא|כל עיקר',
  'לכ"ע=לכולי עלמא',
  'ל"ש=לא שנא|לא שנו',
  'לק"מ=לא קשיא מידי',
  'ל"ק=לא קשיא',
  'לפ"ז=לפי זה',
  'לפ"ד=לפי דבריו|לפי דעת',
  'לענ"ד=לעניות דעתי',
  'לפענ"ד|לפע"ד=לפי עניות דעתי',
  'נלענ"ד|נלע"ד=נראה לעניות דעתי',
  'ל"ת=לא תעשה',
  'לכתחי\'=לכתחילה',
  'לכאו\'=לכאורה',
  'לעת"ל|לע"ל=לעתיד לבוא',
  'מ"ע=מצות עשה|מצוות עשה',
  'מל"ת=מצות לא תעשה',
  'מ"ט=מאי טעמא',
  'מ"ד=מאן דאמר',
  'מנ"ל=מנא לן',
  'משא"כ=מה שאין כן',
  'מש"כ=מה שכתב',
  'מ"ש=מה שכתב|מוצאי שבת',
  'מוצ"ש|מוצש"ק=מוצאי שבת|מוצאי שבת קודש',
  'מ"ת=מתן תורה',
  'מה"ת=מן התורה',
  'מו"מ=משא ומתן',
  'מו"ה=מורנו הרב',
  'מוהר"ר=מורנו הרב רבי',
  'מסנ"פ|מס"נ=מסירות נפש',
  'משה"כ|מש"ה|משו"ה=משום הכי',
  'נ"ל=נראה לי',
  'נ"מ=נפקא מינה',
  'נ"י=נרו יאיר',
  'נ"ע=נשמתו עדן',
  'נ"ט=נותן טעם',
  'נט"י=נטילת ידים',
  'נ"נ=נעשה נבילה',
  'ס"ה=סך הכל',
  'ס"פ=סוף פרק',
  'ס"ס=סוף סימן|ספק ספיקא',
  'ס"ק=סעיף קטן',
  'ספ"ס=ספק ספיקא',
  'ע"ש|עיי"ש=עיין שם|ערב שבת|על שם',
  'ע"כ=עד כאן|על כרחך',
  'עכ"ל=עד כאן לשונו',
  'עכ"פ=על כל פנים',
  'ע"פ=על פי|ערב פסח',
  'ע"י=על ידי',
  'ע"ד=על דרך|על דעת',
  'ע"ג=על גבי|עובד גילולים',
  'ע"מ=על מנת',
  'ע"א=עמוד א',
  'ע"ב=עמוד ב',
  'עה"ת=על התורה',
  'עה"ק=עיר הקודש',
  'עוה"ב=עולם הבא',
  'עוה"ז=עולם הזה',
  'ער"ה=ערב ראש השנה',
  'עיוה"כ=ערב יום הכיפורים',
  'עש"ק=ערב שבת קודש',
  'שב"ק=שבת קודש',
  'פ"ק=פרק קמא',
  'פי\'=פירוש',
  'פירש"י|פרש"י=פירש רש"י|פירוש רש"י',
  'פסק"ד|פס"ד=פסק דין',
  'פקו"נ|פק"נ=פיקוח נפש',
  'צ"ל=צריך לומר|צריך להיות',
  'צ"ע=צריך עיון',
  'צ"ב=צריך ביאור',
  'צ"ת=צריך תלמוד',
  'ק"ש=קריאת שמע',
  'קי"ל|קיי"ל=קיימא לן',
  'ק"ק=קהילה קדושה|קדשי קדשים',
  'ר"ל=רוצה לומר|רחמנא ליצלן',
  'ש"מ=שמע מינה',
  'שמ"ע=שמונה עשרה|שמיני עצרת',
  'שמח"ת=שמחת תורה',
  'ש"ץ=שליח ציבור',
  'שכ"מ=שכיב מרע',
  'ש"ש=שם שמים',
  'שליט"א=שיחיה לאורך ימים טובים אמן',
  'תו"מ=תורה ומצוות',
  'ת"ל=תלמוד לומר|תודה לאל',
  'ת"ר=תנו רבנן',
  'ת"ש=תא שמע',
  'תנ"ה=תניא נמי הכי',
  'תשו\'=תשובה|תשובות',
  'תחה"מ=תחיית המתים',
  'תוה"ק=תורה הקדושה',
  'אדמו"ר=אדוננו מורנו ורבנו',
  'הרה"ג=הרב הגאון',
  'הרה"ק=הרב הקדוש',
  'ת"ו=תבנה ותכונן',
  'כ"י=כתב יד',
  'דפו"ר=דפוס ראשון',
  'ש"נ=שנאמר',
  'שנא\'=שנאמר',
  'דכתי\'|דכתיב\'=דכתיב',
  'וכתי\'=וכתיב',
  'דכ"ע=דכולי עלמא',
  'דס"ל=דסבירא ליה',
  'ס"ל=סבירא ליה|סבירא להו',
  'קמ"ל=קא משמע לן',
  'מ"ל=משמע לן',
  'ל"ל=למה לי',
  'מאי נ"מ=מאי נפקא מינה',
  'ה"א=הוה אמינא',
  'הו"א=הוה אמינא',
  'ה"ל=הוה ליה',
  'ע"ע=עיין עוד',
  'עי\'=עיין',
  'עמ\'=עמוד',
  'סי\'=סימן',
  'סע\'|סעי\'=סעיף',
  'פ\'=פרק|פרשת',
  'פר\'=פרשת',
  'פרש\'=פרשת',
  'הלכ"פ=הלכה פסוקה',
  'ד"ז=דבר זה',
  'בזה"ז=בזמן הזה',
  'בזמה"ז=בזמן הזה',
  'ר"פ=ריש פרק|רב פפא',
  'רפ"ק=ריש פרק קמא',
  'תשב"ר=תינוקות של בית רבן',
  'ב"ב=בני ברק',
  'ל"מ=לא מיבעיא',
  'ל"א=לישנא אחרינא|לשון אחר',
  'לשה"ק|לה"ק=לשון הקודש',
  'רוה"ק=רוח הקודש',
  'מלה"ש=מלאכי השרת',
  'מה"מ=מלאך המות',
  'עו"ג=עובד גילולים',
  'מוה"ר=מורנו הרב',
  'חכ"א=חכמים אומרים',
  'וחכ"א=וחכמים אומרים',
  'מתני\'=מתניתין',
  'גמ\'=גמרא',
  'בריי\'|בריית\'=ברייתא',
  'ירושל\'=ירושלמי',
  'אר"י=אמר רבי יוחנן',
  'אריב"ל=אמר רבי יהושע בן לוי',
  'א"ר יוחנן=אמר רבי יוחנן',
  'ר"נ=רב נחמן',
  'שה"ק=שבת הקודש',
  'יו"כ=יום כיפור',
  'ש"פ=שבת פרשת',
  'עשי"ת=עשרת ימי תשובה',
  'חנוכ\'=חנוכה',
  'פו"ר=פריה ורביה',
  'בא"י=ברוך אתה ה\'',
  'בשכמל"ו=ברוך שם כבוד מלכותו לעולם ועד',
  'ברה"מ=ברכת המזון',
  'ברכה"נ=ברכת הנהנין',
  'בה"נ=ברכת הנהנין',
  'בפה"ג=בורא פרי הגפן',
  'בפה"ע=בורא פרי העץ',
  'בפה"א=בורא פרי האדמה',
  'שהחי\'=שהחיינו',
  'תפי\'=תפילה|תפילין',
  'קה"ת=קריאת התורה',
  'סה"ת=ספר תורה',
  'ת"ב=תשעה באב',
  'ת"צ=תענית ציבור',
  'ת"י=תענית יחיד|תרגום יונתן',
  'תרגו\'|תרג\'=תרגום',
  'אונק\'=אונקלוס',
  'בעהמ"ח=בעל המחבר',
  'מחב\'=מחבר',
  'הגה\'=הגהה|הגהות',
  'נוסח\'=נוסחא',
  'גי\'|גירס\'=גירסא',
  'מהדו"ק=מהדורא קמא',
  'מהדו"ת=מהדורא תניינא',
  'ח"א=חלק א|חלק ראשון',
  'ח"ב=חלק ב|חלק שני',
  'ח"ג=חלק ג|חלק שלישי',
  'ח"ד=חלק ד',
  'אח"כ|אחר"כ=אחר כך',
  'בד"כ|בדר"כ=בדרך כלל',
  'בכה"ג=בכהאי גוונא',
  'בלא"ה|בלאו"ה=בלאו הכי',
  'וא"כ=ואם כן',
  'וא"ל=ואמר ליה',
  'וה"ה=והוא הדין',
  'וכ"ש=וכל שכן',
  'וכה"ג=וכהאי גוונא',
  'ומ"מ=ומכל מקום',
  'וע"ש=ועיין שם',
  'ועי\'=ועיין',
  'וז"ל=וזה לשונו',
  'ז"ש=זהו שכתוב|זה שאמר',
  'כדאי\'=כדאיתא',
  'כמבו\'=כמבואר',
  'משו"כ=משום כך',
  'מד"ס=מדברי סופרים',
  'מה"ט=מהאי טעמא',
  'עפ"י=על פי',
  'עפ"ז=על פי זה',
  'עכ"ד=עד כאן דבריו',
  'עכתו"ד=עד כאן תורף דבריו',
  'תו"ד=תורף דבריו',
  'שא"ה=שאני הכא',
  'דהו"א=דהוה אמינא',
  'מצה"ב=מצוה הבאה בעבירה',
  'קו"ח=קל וחומר',
  'מק"ו=מקל וחומר',
  'במ"א=במקום אחר',
  'ממ"נ|ממנ"פ=ממה נפשך',
  'מנה"מ=מנא הני מילי',
  'בעו"ה=בעוונותינו הרבים',
  'בעה"י=בעזרת השם יתברך',
  'בס"ד=בסייעתא דשמיא',
  'בע"ה=בעזרת השם',
  'אי"ה=אם ירצה השם',
  'בל"נ=בלי נדר',
  'עמ"ס=על מסכת',
  'אדה"ר=אדם הראשון',
  'אאע"ה=אברהם אבינו עליו השלום',
  'מרע"ה|משרע"ה=משה רבנו עליו השלום',
  'דהמע"ה=דוד המלך עליו השלום',
  'מו"ר=מורי ורבי',
  'הי"ד=השם ינקום דמו',
  'בגמ\'=בגמרא',
  'בתוס\'=בתוספות',
  'בשו"ע=בשולחן ערוך',
];

const DICTIONARY_SECTIONS = { book: BOOKS, section: SECTIONS, tractate: TRACTATES, tanach: TANACH, midrash: MIDRASH, person: PEOPLE, general: GENERAL };

// ---------------------------------------------------------------------------
// Normalization helpers
// ---------------------------------------------------------------------------

/** Normalized dictionary / query key: no niqqud, gershayim, geresh or punctuation; finals folded. */
function normKey(s) {
  return normalizeHebrew(s, { keepPunctuation: false });
}

const GERSHAYIM_IN_WORD_RE = /[א-ת][״"”“][א-ת]/;
const GERESH_END_RE = /[א-ת][׳'‘’`]$/;

/** True when a raw token carries an abbreviation mark (gershayim inside or a trailing geresh). */
function hasAbbrevMark(raw) {
  const s = String(raw || '').trim();
  return GERSHAYIM_IN_WORD_RE.test(s) || GERESH_END_RE.test(s);
}

/** Abbreviation type from its raw spelling. */
function abbrType(raw) {
  if (GERSHAYIM_IN_WORD_RE.test(raw)) return 'acronym';
  if (GERESH_END_RE.test(raw)) return 'trunc';
  return 'plain';
}

/**
 * Defective-spelling skeleton: every internal ו / י (not the first or last letter) is
 * removed: "שולחנ" -> "שלחנ", "קידושינ" -> "קדשנ". Used only to compare spellings
 * (never shown or searched directly).
 */
function skeleton(word) {
  const w = String(word || '');
  if (w.length <= 2) return w;
  return w[0] + w.slice(1, -1).replace(/[וי]/g, '') + w[w.length - 1];
}

function skeletonPhrase(phrase) {
  return String(phrase).split(' ').filter(Boolean).map(skeleton).join(' ');
}

// ---------------------------------------------------------------------------
// Hebrew numerals
// ---------------------------------------------------------------------------

const GEMATRIA = { א: 1, ב: 2, ג: 3, ד: 4, ה: 5, ו: 6, ז: 7, ח: 8, ט: 9, י: 10, כ: 20, ל: 30, מ: 40, נ: 50, ס: 60, ע: 70, פ: 80, צ: 90, ק: 100, ר: 200, ש: 300, ת: 400 };
const ONES = ['', 'א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ז', 'ח', 'ט'];
const TENS = ['', 'י', 'כ', 'ל', 'מ', 'נ', 'ס', 'ע', 'פ', 'צ'];

/** 1..9999 -> Hebrew numeral in normalized form (no gershayim, no finals): 15 -> "טו", 328 -> "שכח". */
function intToHebrewNumeral(n) {
  let v = Math.floor(Number(n));
  if (!Number.isFinite(v) || v <= 0 || v >= 10000) return null;
  let out = '';
  if (v >= 1000) {
    out += ONES[Math.floor(v / 1000)];
    v %= 1000;
  }
  while (v >= 400) {
    out += 'ת';
    v -= 400;
  }
  if (v >= 300) { out += 'ש'; v -= 300; }
  if (v >= 200) { out += 'ר'; v -= 200; }
  if (v >= 100) { out += 'ק'; v -= 100; }
  if (v === 15) return out + 'טו';
  if (v === 16) return out + 'טז';
  out += TENS[Math.floor(v / 10)] + ONES[v % 10];
  return out;
}

/** True for a well-formed Hebrew numeral (letters in non-increasing value; טו / טז allowed). */
function isHebrewNumeral(token) {
  const t = normalizeFinals(String(token || '').replace(/[.:"'״׳]/g, ''));
  if (!t || t.length > 5 || !/^[א-ת]+$/.test(t)) return false;
  const n = hebrewNumeralToInt(t);
  return n != null && intToHebrewNumeral(n) === t;
}

/** Hebrew numeral or digits -> integer (null when neither). "קכ\"ד" -> 124, "12" -> 12. */
function parseHebrewNumber(token) {
  const s = String(token || '').replace(/[.:]$/, '');
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  return isHebrewNumeral(s) ? hebrewNumeralToInt(s) : null;
}

// ---------------------------------------------------------------------------
// Dictionary indexes
// ---------------------------------------------------------------------------

/** Common short words an un-marked abbreviation key must never be expanded from / to. */
const STOP_WORDS = new Set(
  [
    'אב', 'אמ', 'בנ', 'בר', 'בי', 'בה', 'בו', 'דא', 'די', 'הא', 'הי', 'הו', 'זה', 'זו', 'כי', 'כל', 'כנ', 'לא', 'לו', 'לי',
    'לה', 'מה', 'מי', 'מנ', 'נא', 'עמ', 'על', 'עד', 'פה', 'רב', 'שמ', 'תנ', 'יש', 'אי', 'או', 'אנ', 'את', 'גמ', 'הנ', 'אל',
    'ביד', 'ברא', 'ישע', 'דב', 'דבר', 'במ', 'שמ', 'מש', 'תה', 'קה', 'הל', 'פי', 'עי', 'סי', 'סע', 'נד', 'חי', 'גו', 'פר',
    'שנא', 'עמו', 'מלא', 'מיכ', 'זכר', 'נחמ', 'עזר', 'איכ', 'שופ', 'יהו', 'הוש', 'חול', 'ערכ', 'תמו', 'נדר', 'שקל', 'סוכ',
    'מנח', 'זבח', 'חגי', 'כתו', 'קדו', 'מכו', 'שבו', 'שבוע', 'בכו', 'גיט', 'ביצ', 'נזי', 'פסח', 'דני', 'דנ', 'ירו', 'ירמ',
    'שמו', 'בראש', 'ויקר', 'במד', 'דברי', 'תשו', 'תפי', 'מתני', 'אפי', 'כרי', 'מעיל', 'יוא', 'מוה', 'נוסח', 'הגה',
    // 3+ letter acronym keys that are also everyday words.
    'ראש', 'שלה', 'שכמ', 'אגמ', 'בהל', 'אבד', 'עוג', 'שמע', 'לחמ', 'מלמ', 'פני', 'עשק', 'שבק', 'יביא', 'ארי', 'חידא', 'ריפ', 'ענינ',
  ].map(normalizeFinals),
);

/** Built once at module load. */
const ENTRIES = [];
/** normalized abbreviation key -> [{ entry, abbr }] */
const ABBR_INDEX = new Map();
/** skeleton of a full phrase -> [entry] */
const FULL_INDEX = new Map();
let MAX_FULL_WORDS = 1;

(function buildIndexes() {
  for (const [kind, list] of Object.entries(DICTIONARY_SECTIONS)) {
    for (const line of list) {
      const eq = line.indexOf('=');
      if (eq < 0) continue;
      const abbrs = line.slice(0, eq).split('|').map((raw) => ({ raw, key: normKey(raw), type: abbrType(raw) })).filter((a) => a.key);
      const fulls = line.slice(eq + 1).split('|').map((raw) => ({ raw, key: normKey(raw) })).filter((f) => f.key);
      if (!abbrs.length || !fulls.length) continue;
      const entry = { kind, abbrs, fulls };
      ENTRIES.push(entry);
      for (const a of abbrs) {
        const list2 = ABBR_INDEX.get(a.key) || [];
        list2.push({ entry, abbr: a });
        ABBR_INDEX.set(a.key, list2);
      }
      for (const f of fulls) {
        const sk = skeletonPhrase(f.key);
        const list3 = FULL_INDEX.get(sk) || [];
        if (!list3.includes(entry)) list3.push(entry);
        FULL_INDEX.set(sk, list3);
        MAX_FULL_WORDS = Math.max(MAX_FULL_WORDS, f.key.split(' ').length);
      }
    }
  }
})();

const KIND_ORDER = ['book', 'section', 'tractate', 'tanach', 'midrash', 'person', 'general'];
const kindRank = (k) => KIND_ORDER.indexOf(k);

function uniq(list) {
  return [...new Set(list.filter(Boolean))];
}

/**
 * Full forms of an abbreviation (normalized, most relevant first).
 *   expandAbbreviation('שו"ע') -> ['שולחנ ערוכ'];  expandAbbreviation('רמבם') -> ['משנה תורה', 'רבי משה בנ מימונ']
 *
 * @param {string} token   raw ("ב\"ד") or normalized ("בד") abbreviation
 * @param {{ strict?: boolean, truncNeedsMark?: boolean, kinds?: string[] }} [opts]
 *   strict (search mode): an un-marked token only expands when it is >= 3 letters and not a
 *   common word, and a truncation (ישע') only when its geresh was typed.
 *   truncNeedsMark (quick open): only the truncation rule ("ברא" is still being typed).
 */
function expandAbbreviation(token, opts) {
  const strict = !!(opts && opts.strict);
  const kinds = opts && opts.kinds;
  const marked = hasAbbrevMark(token);
  const key = normKey(token);
  if (!key || key.includes(' ')) return [];
  const hits = ABBR_INDEX.get(key);
  if (!hits) return [];
  if (strict && !marked && (key.length < 3 || STOP_WORDS.has(key))) return [];
  const out = [];
  const sorted = hits.slice().sort((a, b) => kindRank(a.entry.kind) - kindRank(b.entry.kind));
  for (const { entry, abbr } of sorted) {
    if (kinds && !kinds.includes(entry.kind)) continue;
    if ((strict || (opts && opts.truncNeedsMark)) && abbr.type === 'trunc' && !marked) continue;
    for (const f of entry.fulls) out.push(f.key);
  }
  return uniq(out).filter((f) => f !== key);
}

/**
 * Abbreviations of a full phrase (normalized), matched spelling-insensitively (ktiv male /
 * chaser): abbreviationsFor('בית דין') -> ['בד', 'ביד'];  abbreviationsFor('שלחן ערוך') -> ['שוע', 'שע'].
 *
 * @param {{ strict?: boolean }} [opts] strict (search mode) drops abbreviations that would be
 *   too noisy as search terms: 2-letter keys that are common words or numerals ("שכ" = 320),
 *   and truncations that are themselves words (ישע').
 */
function abbreviationsFor(phrase, opts) {
  const strict = !!(opts && opts.strict);
  const key = normKey(phrase);
  if (!key) return [];
  const entries = FULL_INDEX.get(skeletonPhrase(key)) || [];
  const out = [];
  for (const entry of entries) {
    for (const a of entry.abbrs) {
      if (a.key === key) continue;
      if (strict) {
        if (STOP_WORDS.has(a.key)) continue;
        if (a.type === 'trunc' && a.key.length < 3) continue;
        // "שכ" (ש"ך) or "מב" (מ"ב) are mostly siman numbers in running text; tractates (ר"ה, ע"ז) are kept.
        if (a.key.length <= 3 && isHebrewNumeral(a.key) && entry.kind !== 'tractate') continue;
        if (a.key.length < 2) continue;
      }
      out.push(a.key);
    }
  }
  return uniq(out);
}

/** True when the normalized word sequence is a dictionary full phrase. */
function isFullPhrase(words) {
  return FULL_INDEX.has(skeletonPhrase(Array.isArray(words) ? words.join(' ') : words));
}

// ---------------------------------------------------------------------------
// Ktiv male / chaser
// ---------------------------------------------------------------------------

/** Curated spelling families for short / irregular words (normalized). */
const KTIV_GROUPS = [
  ['אלהימ', 'אלוהימ', 'אלקימ', 'אלוקימ'],
  ['אלהינו', 'אלוהינו', 'אלקינו', 'אלוקינו'],
  ['כתל', 'כותל'],
  ['קדש', 'קודש'],
  ['כהנ', 'כוהנ'],
  ['בקר', 'בוקר'],
  ['אהל', 'אוהל'],
  ['ירושלימ', 'ירושלמ'],
  ['מצוה', 'מצווה'],
  ['מצות', 'מצוות'],
  ['תפלה', 'תפילה'],
  ['תפלינ', 'תפילינ'],
  ['שלחנ', 'שולחנ'],
  ['צצית', 'ציצית'],
  ['דבור', 'דיבור'],
  ['קדושינ', 'קידושינ'],
  ['ענינ', 'עניינ'],
  ['דינ', 'דיינ'],
  ['חכמה', 'חוכמה'],
  ['אמנ', 'אומנ'],
  ['כפורימ', 'כיפורימ', 'כפורימ'],
  ['עוה', 'עווה'],
  ['צוה', 'צווה'],
];
const KTIV_MAP = new Map();
for (const g of KTIV_GROUPS) for (const w of g) KTIV_MAP.set(w, uniq([...(KTIV_MAP.get(w) || []), ...g.filter((x) => x !== w)]));

/**
 * Plausible full/defective spelling variants of one normalized word (the word itself excluded),
 * most plausible first, at most `max`:
 *   "שולחנ" -> ["שלחנ", ...]   "קדושינ" -> ["קידושינ", ...]   "תפלינ" -> ["תפילינ", ...]
 * Words shorter than 4 letters only get curated variants (כתל <-> כותל), so short roots never
 * turn into unrelated words.
 */
function ktivVariants(word, max) {
  const limit = max == null ? 6 : max;
  const w = String(word || '');
  const out = [];
  const push = (v) => {
    if (v && v !== w && v.length >= 2 && !out.includes(v)) out.push(v);
  };
  for (const v of KTIV_MAP.get(w) || []) push(v);
  if (w.length >= 4) {
    const inner = (i) => i > 0 && i < w.length - 1;
    // 1. Male -> chaser: drop internal matres (all, then one at a time), collapse וו / יי.
    push(skeleton(w));
    for (let i = 1; i < w.length - 1; i++) if (inner(i) && (w[i] === 'ו' || w[i] === 'י')) push(w.slice(0, i) + w.slice(i + 1));
    push(w.replace(/(?!^)וו(?!$)/g, 'ו').replace(/(?!^)יי(?!$)/g, 'י'));
    // 2. Chaser -> male: chirik / cholam after the first letter ("דבור" -> "דיבור", "שלחנ" -> "שולחנ"),
    //    chirik after the second letter for longer words ("תפלינ" -> "תפילינ").
    const isMater = (c) => c === 'ו' || c === 'י';
    if (!isMater(w[1])) {
      push(w[0] + 'י' + w.slice(1));
      push(w[0] + 'ו' + w.slice(1));
    }
    if (w.length >= 5 && !isMater(w[2]) && !isMater(w[1])) push(w.slice(0, 2) + 'י' + w.slice(2));
    // 3. Consonantal vav / yud doubled in ktiv male ("מצוה" -> "מצווה", "ענינ" -> "עניינ").
    const m = /^(.+[^וי])([וי])([^וי].*)$/.exec(w);
    if (m && m[1].length >= 2) push(m[1] + m[2] + m[2] + m[3]);
  }
  return out.slice(0, limit);
}

// ---------------------------------------------------------------------------
// Prefixes & suffixes
// ---------------------------------------------------------------------------

/** Proclitic prefixes, most frequent first. */
const PREFIXES = ['ו', 'ה', 'ב', 'ל', 'מ', 'ש', 'כ', 'וה', 'וב', 'ול', 'ומ', 'וש', 'וכ', 'שה', 'שב', 'של', 'שמ', 'כש', 'מה', 'וכש', 'ובה', 'ולה', 'מלה'];
/** Plural / construct / possessive endings (normalized: ים -> ימ). */
const SUFFIXES = ['ימ', 'ות', 'ה', 'י', 'יו', 'יה', 'המ', 'כמ', 'נו', 'ת'];
/** Words shorter than this are never prefix-expanded or wildcarded (keeps precision high). */
const MIN_EXPAND_LEN = 3;

/** Prefixed forms of a word ("שבת" -> "ושבת", "בשבת", ...); none for words shorter than 3 letters. */
function prefixVariants(word, max) {
  const w = String(word || '');
  if (w.length < MIN_EXPAND_LEN) return [];
  const out = [];
  for (const p of PREFIXES) {
    out.push(p + w);
    // The definite article is elided after ב/כ/ל: "הבית" -> "בבית", "לבית".
    if (w[0] === 'ה' && w.length > MIN_EXPAND_LEN && /[בכל]$/.test(p) && p.length === 1) out.push(p + w.slice(1));
  }
  return uniq(out).slice(0, max == null ? out.length : max);
}

/**
 * Base forms of an inflected word ("שבתות" -> "שבת", "מצוות" -> "מצוה", "תורת" -> "תורה").
 * Only stems of at least 3 letters are returned.
 */
function suffixStems(word) {
  const w = String(word || '');
  const out = [];
  const add = (s) => {
    if (s && s.length >= MIN_EXPAND_LEN && s !== w) out.push(s);
  };
  if (w.length >= 5 && w.endsWith('ימ')) add(w.slice(0, -2));
  if (w.length >= 5 && w.endsWith('ות')) {
    add(w.slice(0, -2));
    add(w.slice(0, -2) + 'ה');
  }
  if (w.length >= 4 && w.endsWith('ת') && !w.endsWith('ות')) add(w.slice(0, -1) + 'ה');
  if (w.length >= 4 && w.endsWith('ה')) add(w.slice(0, -1) + 'ת');
  return uniq(out);
}

/** A leading proclitic stripped off ("ובשבת" -> ["בשבת", "שבת"]); stems of >= 3 letters only. */
function prefixStems(word) {
  const w = String(word || '');
  const out = [];
  for (const p of PREFIXES.slice().sort((a, b) => b.length - a.length)) {
    if (w.length - p.length >= MIN_EXPAND_LEN && w.startsWith(p) && p.startsWith('ו')) out.push(w.slice(p.length));
  }
  return uniq(out);
}

// ---------------------------------------------------------------------------
// Morphological expansion of one search word
// ---------------------------------------------------------------------------

/** Maximum FTS5 OR-variants generated for one word. */
const MAX_VARIANTS_PER_WORD = 24;

/**
 * FTS5 term variants of one normalized word (smart search), most relevant first. A trailing
 * `*` marks an FTS5 prefix query (which also covers every suffix: "שבת*" -> שבתות, שבתו...).
 *   expandWordVariants("שולחנ") -> ["שולחנ*", "שלחנ*", "ושולחנ*", ...]
 *
 * Words of 1-2 letters are returned as-is (no prefix / suffix / ktiv expansion).
 * @param {{ wildcard?: boolean }} [opts] wildcard: false for abbreviations ("שוע" must not match "שועל").
 */
function expandWordVariants(word, max, opts) {
  const limit = Math.max(1, max || MAX_VARIANTS_PER_WORD);
  const wildcard = !opts || opts.wildcard !== false;
  const w = String(word || '');
  if (!w) return [];
  if (w.length < MIN_EXPAND_LEN || /^\d+$/.test(w) || /[a-z]/i.test(w)) return [w];
  const out = [];
  const push = (v) => {
    if (!v || out.length >= limit) return;
    const t = wildcard && v.length >= MIN_EXPAND_LEN ? v + '*' : v;
    if (!out.includes(t)) out.push(t);
  };
  // Base forms: the word, its two likeliest spellings, its uninflected / un-prefixed stems.
  const spellings = wildcard ? ktivVariants(w, 6) : [];
  const forms = uniq([w, ...spellings.slice(0, 2), ...suffixStems(w), ...prefixStems(w)]).slice(0, 5);
  for (const f of forms) push(f);
  // Proclitic prefixes: single letters on the main forms, then the combinations.
  const primary = forms.slice(0, 2);
  const singles = PREFIXES.filter((p) => p.length === 1);
  const combos = PREFIXES.filter((p) => p.length > 1);
  for (const f of primary) for (const p of singles) push(p + f);
  if (primary[0][0] === 'ה') for (const p of ['ב', 'כ', 'ל']) push(p + primary[0].slice(1));
  for (const p of combos) push(p + primary[0]);
  // Remaining (less likely) spellings, then combinations on the second form.
  for (const f of spellings.slice(2)) push(f);
  for (const p of combos) if (primary[1]) push(p + primary[1]);
  return out;
}

// ---------------------------------------------------------------------------
// Canonical forms (book lookup)
// ---------------------------------------------------------------------------

/** Filler words dropped from canonical book keys ("הלכות שבת" == "שבת" after a series name). */
const FILLER_WORDS = new Set(['הלכות', 'הלכת', 'מסכת', 'ספר', 'פירוש', 'פרשת', 'על'].map((w) => skeleton(normalizeFinals(w))));

/**
 * Spelling- and abbreviation-insensitive keys for a normalized token sequence, used to match a
 * typed book name against stored titles / aliases: every abbreviation is expanded (all senses,
 * capped), every word reduced to its ktiv skeleton, and a filler-free variant is added.
 *   canonicalForms(['שוע','אוח'])         -> ['שלחנ ערכ ארח חמ', ...]
 *   canonicalForms(['שולחנ','ערוכ','אורח','חיימ']) -> ['שלחנ ערכ ארח חמ', ...]
 * @param {{ typed?: boolean }} [opts] typed: `tokens` are raw user input (keeps gershayim / geresh).
 */
function canonicalForms(tokens, max, opts) {
  const limit = max || 8;
  const typed = !!(opts && opts.typed);
  let variants = [[]];
  for (const raw of tokens) {
    // Typed input (raw tokens): a truncation only expands with its geresh ("בר'" yes, "בר" no).
    const exp = expandAbbreviation(raw, { truncNeedsMark: typed }).slice(0, 3);
    const t = typed ? normKey(raw) : raw;
    if (!t) continue;
    const options = uniq([...(exp.length ? exp : []), t]).slice(0, 3);
    const next = [];
    for (const v of variants) for (const o of options) if (next.length < limit * 2) next.push(v.concat(o.split(' ')));
    variants = next;
  }
  const out = [];
  for (const v of variants) {
    const sk = v.map(skeleton);
    out.push(sk.join(' '));
    const noFiller = sk.filter((x) => !FILLER_WORDS.has(x));
    if (noFiller.length && noFiller.length !== sk.length) out.push(noFiller.join(' '));
  }
  return uniq(out).slice(0, limit);
}

const bookKeyCache = new Map();
/** Canonical keys of a book (title alone and "folder path + title"), memoized. */
function bookKeys(title, categoryPath) {
  const id = (categoryPath || '') + '\u0000' + title;
  let keys = bookKeyCache.get(id);
  if (!keys) {
    const t = normKey(title).split(' ').filter(Boolean);
    const folders = String(categoryPath || '').split('/').map(normKey).filter(Boolean);
    // The series may sit several folders up ("משנה תורה/ספר זמנים/הלכות שבת"): pair each ancestor with the title.
    keys = uniq([...canonicalForms(t), ...folders.flatMap((f) => canonicalForms([...f.split(' '), ...t], 4))]);
    if (bookKeyCache.size > 20000) bookKeyCache.clear();
    bookKeyCache.set(id, keys);
  }
  return keys;
}

/**
 * Abbreviation- and spelling-aware book-name filter score (0 = no match, higher = better):
 *   bookMatchScore('שו"ע או"ח', 'אורח חיים', 'הלכה/שולחן ערוך') > 0
 *   bookMatchScore('ב"ק', 'בבא קמא') > 0;  bookMatchScore('רמב"ם שבת', 'הלכות שבת', '.../משנה תורה/...') > 0
 */
function bookMatchScore(query, title, categoryPath) {
  const q = normKey(query).split(' ').filter(Boolean);
  if (!q.length) return 0;
  const qs = canonicalForms(String(query).split(/\s+/).filter(Boolean), 8, { typed: true });
  if (!qs.length) return 0;
  const keys = bookKeys(title, categoryPath);
  let best = 0;
  for (const k of keys) {
    for (const x of qs) {
      if (k === x) best = Math.max(best, 2);
      else if ((' ' + k + ' ').includes(' ' + x + ' ') || k.startsWith(x) || (' ' + k).includes(' ' + x)) best = Math.max(best, 1);
    }
  }
  return best;
}

/** Dictionary statistics (for tests / diagnostics). */
function dictionaryStats() {
  const byKind = {};
  for (const e of ENTRIES) byKind[e.kind] = (byKind[e.kind] || 0) + 1;
  return { entries: ENTRIES.length, abbreviations: ABBR_INDEX.size, fullPhrases: FULL_INDEX.size, byKind };
}

module.exports = {
  PREFIXES,
  SUFFIXES,
  MIN_EXPAND_LEN,
  MAX_VARIANTS_PER_WORD,
  STOP_WORDS,
  normKey,
  hasAbbrevMark,
  skeleton,
  skeletonPhrase,
  expandAbbreviation,
  abbreviationsFor,
  isFullPhrase,
  maxFullPhraseWords: () => MAX_FULL_WORDS,
  ktivVariants,
  prefixVariants,
  suffixStems,
  prefixStems,
  expandWordVariants,
  canonicalForms,
  bookMatchScore,
  intToHebrewNumeral,
  isHebrewNumeral,
  parseHebrewNumber,
  dictionaryStats,
};
