# kodeshRead

Offline-first Android Torah library (Expo + TypeScript) powered by
[Otzaria](https://github.com/Sivan22/otzaria) text files. The library lives in FTS5-indexed
SQLite databases on the device. The APK itself stays small and bundles no books: the main
library is downloaded once as a compressed release from GitHub, or indexed on the device
from an Otzaria folder, and personal books can be imported next to it. See
[`CLAUDE.md`](CLAUDE.md) for the full spec.

**Status:** Milestone 5: project setup, the DB build pipeline, the Library screen with
Quick Source Jump and the RTL tree (M1), the windowed reader workspace (M2), Hebrew
full-text search (M3), parallel commentaries and Android APK packaging (M4), and a
lightweight APK with downloadable / on-device-indexed libraries (M5, see
[Library storage & updates](#library-storage--updates)):

* **Sliding-window reader** (`src/components/reader/BookReader.tsx`): ~400 lines around
  the current line, +200-line chunks fetched near either edge, far edge trimmed at 800 rows;
  rendered with FlashList. Jump targets land just below the breadcrumb and glow for 2 s.
* **Text safety**: only `<b> <strong> <i> <em> <u> <small> <big> <sup> <sub>` are rendered;
  lines with parentheses/digits get a leading `\u200F` (see `shared/reader.js`).
* **Breadcrumb + TOC**: sticky breadcrumb that hides on scroll-down and returns on scroll-up;
  tap it (or ☰) for the slide-over hierarchical TOC, opened at the current section.
* **Tabs**: several books open at once; each tab persists `{ tabId, bookId, bookTitle,
  currentLineIndex, tocPath, lineOffset }` so switching tabs or relaunching restores the
  exact scroll position.
* **`Aa` sheet**: Frank Ruhl Libre / David Libre / Assistant / Heebo (bundled via
  `@expo-google-fonts/*`), font size and line height sliders, Light / Sepia / OLED Dark,
  live Niqqud & cantillation toggle. Settings persist.

* **Full-text search** (`src/app/search.tsx`, logic in `shared/search.js`): opened from the
  Library header (חיפוש) or the reader toolbar (🔍 = scoped to the open book).
  * Queries go through the same `normalizeHebrew()` as `clean_text` (niqqud, finals, gershayim
    don't matter), then every FTS5 syntax character (`" ' - * ( ) : ^` and any other punctuation)
    is stripped and each token is re-quoted, so no input can raise `fts5: syntax error`.
  * Words are AND-ed; `"quoted text"` is an exact phrase (a quote inside a word, as in `שו"ע`,
    is gershayim, not a phrase delimiter).
  * Scope sheet: Entire Library / a folder (`category_path LIKE 'folder/%'`, sub-folders included)
    / a single book (`book_id = ?`), with a filter box and a "book open in the reader" shortcut.
  * KWIC cards: book title + `toc_path` breadcrumb and a snippet around the first hit with the
    matched words emphasized. Results stream in library order (keyset paging, 40 per page);
    the total is counted up to 1000+.
  * Tapping a result opens or re-uses the book's tab, jumps to the line and highlights it for 2 s.
  * The web preview's SQLite has no FTS5, so there (only) search falls back to a slower
    substring `LIKE` scan.

* **Parallel commentaries** (`src/components/reader/CommentaryPane.tsx`, queries in
  `shared/commentary.js`):
  * Paragraphs with entries in the `links` table show a small count badge in the margin
    (counts are fetched with each window chunk, so they cost one indexed query per chunk).
  * Tapping such a paragraph (or its badge) opens a drawer docked under the text as a split
    view, so the text stays scrollable. Tapping another paragraph re-syncs it; tapping the
    selected paragraph again closes it. Paragraphs without links do nothing while it is closed.
  * Entries are grouped by commentator book (רש"י, תוספות, …; commentaries first, then
    translations such as אונקלוס, then cross-references). Groups collapse, and every entry has
    a **פתח ↗** button that opens that book at that exact line in a tab and highlights it.
  * Drag the grabber to resize (or tap it to toggle short/tall; the size persists). Use → / ←
    to step to the previous or next paragraph with commentaries (the text scrolls along), and
    **סנכרון** to make the drawer follow the reading line while you scroll.
  * Links work in both directions: open a commentary and its drawer shows the source line.
  * It uses the active theme (Light / Sepia / OLED Dark), font, size, line height and niqqud
    setting.

## Quick start

Requires **Node ≥ 22.13** (the DB build script uses the built-in `node:sqlite`).

```bash
npm install
npm run db:sample      # raw_library/sample -> assets/db/library.db (tests + web preview)
npm test               # pipeline, Quick Jump, reader, FTS5 search, dual-DB & release self-test
npm start              # Expo dev server (also auto-builds the sample DB if missing)
```

`npm run android` builds a native dev build (`expo run:android`, needs the Android SDK).
To build an installable APK, see [Building the Android APK](#building-the-android-apk).
The app uses `expo-updates` for the first-launch RTL reload, so run it as a dev build
rather than in Expo Go. `npm run web` gives a quick browser preview of the UI;
with it running, `npm run e2e:search`, `npm run e2e:commentary` and `npm run e2e:library`
drive the Search screen, the commentary drawer and the Library Manager end to end with
Playwright (needs `playwright` + Chromium available). The web preview has no file system, so
it shows the sample library as the core library and disables download / import.

## Library sources

| Folder | Tracked in git | Build command |
| --- | --- | --- |
| `raw_library/sample/` + `raw_links/sample/` | yes | `npm run db:sample` |
| `raw_library/full/` + `raw_links/full/` | no (put the full Otzaria library here) | `npm run db:full` |

Layout: `raw_library/<source>/<Category>/<SubCategory>/<Book>.txt`. Headings use
`<h1>` (title) … `<h6>`; every other non-empty line is a paragraph. Optional:

* `raw_library/aliases.json`: extra shorthand per book, e.g. `{ "שולחן ערוך אורח חיים": ["שו\"ע או\"ח"] }`
* `<folder>/order.json`: explicit display order of that folder's entries (well-known
  Tanach/Shas/Shulchan Aruch orders are built in)
* `raw_links/<source>/`: commentary links for that source (`raw_links/sample/` or
  `raw_links/full/`, so sample line numbers never leak into a full build; `--links=<dir>`
  overrides). Either Otzaria's `<Book>_links.json` (`line_index_1` in that book,
  `line_index_2` in `path_2`, `Conection Type`), or CSV/JSON with
  `source_book,source_line,target_book,target_line,link_type`. Any sub-folder layout works.
  * Book names are matched after normalization (niqqud, `"`/`״`/`''`, final letters, `.txt`,
    `_links` and folders ignored, aliases accepted, leading `מסכת`/`ספר`/`תלמוד בבלי`
    dropped). A name only matches a longer title as whole words and only if that is unique,
    so `רש"י על ראש השנה` never falls back to `ראש השנה`.
  * Each link is stored once: Otzaria writes every link in both books' files, and the reverse
    copies are de-duplicated. Links to a line that is not a paragraph of its book are dropped.
  * The build prints a summary (`links: N file(s), parsed, stored, duplicates, missing lines`)
    and a **WARNING** listing unmatched book names with counts. The sample deliberately
    contains one: a תוספות cross-reference to `ברכות`, which is not in the sample library.

The sample library includes four small commentary books with links: רש"י and תוספות on
שבת ב (JSON, Otzaria format) and רש"י and אונקלוס on בראשית א (JSON and CSV).

Every build writes `assets/db/library.db` + `assets/db/db-version.json`. They are used by
`npm test` and the web preview only; the APK does not contain them. `--release` also writes
the compressed release artifact (see [Publishing a library release](#publishing-a-library-release)).

## Quick Source Jump examples

`שבת ב.` · `שבת קנז ב` · `ר"ה טז:` · `מסכת ראש השנה ג` · `בראשית יב א` (verse) ·
`שוע אוח כה ה` · `רמבם שבת א א` (once those books are in the library)

Abbreviations, other spellings and structural words are understood (`shared/hebrewTorahDict.js`):
`שו"ע או"ח סי' שכח ד` · `שוע אוח 328 4` · `ב"ק דף ב ע"ב` · `רמב"ם הל' שבת פ"א` · `בר' א א` ·
`מ"ב` · `שלחן ערוך אורח חיים כה`. A fully resolved reference shows a **פתח: ספר — מיקום** card on top.
The search scope picker's book filter is abbreviation-aware too.

## Reader display & library browser

- **טעמים / ניקוד** pills in the reader toolbar (also in the `Aa` sheet), persisted as `showCantillation` /
  `showNikkud` (both on by default). Hiding טעמים strips U+0591–U+05AF only, so vowels, dagesh, shin/sin dots
  and maqaf stay. Hiding ניקוד strips the vowel points and the trope too. The same toggles apply to the
  commentary drawer and search snippets (`shared/hebrew.js applyVocalization`). Highlighting matches
  normalized words, so it is unaffected.
- **Library browser:** RTL cascading columns (`src/components/LibraryColumns.tsx`). Root folders sit in
  the rightmost column; each tap opens the folder's sub-folders and books in a new column to its left. The
  active path is highlighted in every column and shown as a tappable breadcrumb. Shows ~2 columns on
  phones and 3–4 on tablets, with independent vertical scrolling. The selected path is saved.

## Tabs & table of contents

- **Tab bar:** two compact rows. Row 1 holds back, the RTL tab strip (title + current section, `×`) and
  the open-tabs counter. Row 2 holds תוכן, search, טעמים / ניקוד and `Aa`. The active tab is always scrolled
  into view. Long-press a tab to close it, close the others, or close the tabs to its left. Up to 40 tabs
  stay open; beyond that the least recently used one is dropped.
- **Tab switcher:** the counter opens a list of all tabs, most recently used first, with an instant filter
  that understands abbreviations and other spellings (`shared/tabs.js` → `hebrewTorahDict`). Each card shows
  the exact location and a folder badge. Header actions: close the other tabs, and close all (asks for a
  second tap to confirm).
- **TOC:** RTL cascading columns (`shared/tocColumns.js`). Top-level divisions are on the right; the
  selected one's sub-items open in a column to its left, and deeper levels add further columns. Tanach
  chapters without verse headings get a verse column built from their `(א)` lines. It opens synced to the
  reading position. A filter jumps by name, gematria, digits or chapter + verse (`כז טו`). On phones it is
  a slide-over drawer that closes after a jump; on screens ≥ 900 px it is docked beside the text.

## Commentaries: Otzaria reference alignment

Base books and their commentaries share parallel heading trees in Otzaria (פרק › פסוק, דף › עמוד,
סימן › סעיף). In the links phase (`shared/refAlign.js`, called from `shared/indexer.js indexRefLinks`):

- every heading becomes canonical unit labels, so each TOC node gets a reference path
  (`פרק א|פסוק א`, `דף ב|עמוד א` — `דף ב.` and `דף ב` › `עמוד א` are the same unit, `סימן שכח|סעיף ד`);
- commentaries are paired with their base book by `shared/pairing.js`, calibrated on the full library
  map (`otzaria_index_only.txt`: 7,674 books, 5,850 named `X על Y`). It pairs 99.7% of them, plus 197
  books named without `על`, in about 0.5 s:
  - bare names go to the right corpus (`תוספות על ברכות` → the Bavli);
  - explicit corpus prefixes are honoured (`ברטנורא על משנה ברכות`, `… על תלמוד ירושלמי, מסכת יומא`);
  - comma titles match (`… על משנה תורה, הלכות שבת`, `… על שולחן ערוך אורח חיים` → `שולחן ערוך, אורח חיים`);
  - commentaries on commentaries are followed through every ` על `
    (`הערות על חברותא על ברכות`, `קובץ על היד החזקה על משנה תורה, …`);
  - a commentary's `מפרשים` folder decides its base (`ריף/מפרשים/…/המאור הגדול על בבא קמא` → the Rif;
    `טור/מפרשים/בית יוסף` → `טור`);
  - `<series> <base>` titles without `על` pair by their suffix (`באר היטב אורח חיים`, `יכין ברכות`);
  - known standalone names pair directly (`משנה ברורה`, `מגן אברהם`, `בית שמואל`);
  - primary texts win over same-named commentaries (`אבן העוזר על זבים` → `משנה זבים`, not `יכין זבים`);
  - corpus-wide commentaries (`… על השס`, `… על התורה`, `… על סדר קדשים`) are aligned per top-level
    heading that names a base book (`מסכת ברכות`).
- every commentary unit with its own text (all its דיבורים המתחילים) is stored in `ref_links` with the
  base unit of the same path, as two line ranges. A base without verse headings gets the verse from
  `(א)` markers or one-verse-per-line. Leaves the base lacks (`סעיף קטן`) align at the siman.
  Verses never fall back to the whole chapter.

Halacha books in the real Otzaria sample (`otzaria_structure_sample.txt`: ערוך השולחן העתיד, חכמת אדם, הלכות
גדולות) mark seifim inline as `(א)`…`(כ)` under each `סימן` / `כלל`, so:

- a commentary whose דיבורים carry the same markers is split per seif (`סימן א|סעיף ב`), including the unmarked
  paragraphs that continue a seif; its text before the first marker links to the whole siman;
- a `סעיף` heading in a commentary is resolved to the base's inline `(ב)` line;
- unmarked paragraphs (ערוך השולחן) are never guessed to be seifim. Only Tanach verses fall back to
  one verse per line;
- commentaries on the Shulchan Aruch / Tur align at the siman: their `(א)` notes count seifim
  katanim, which is a different sequence from the base's seifim;
- TOC columns name inline units by context: סעיף in a סימן / כלל, פסוק in Tanach, משנה in Mishnah.

For each commentator the drawer shows the innermost unit covering the line: the seif's note, or the siman's
note when the seif has none. Lookups use covering `(book, partner, start, end)` indexes (schema v5;
`migrateSchema` replaces the v4 indexes), ~0.5 ms per line. The reader drawer shows
each commentator's **whole block** for the selected verse/amud, plus explicit Otzaria line links. Explicit
links that fall inside a block are merged into it and marked, never duplicated. **פתח בספר** opens the block
in the commentary, highlighting all of it. From a commentary, the drawer shows the base text of its unit.
Schema v4; older read-only libraries keep working with line links only. Re-running the phase is idempotent,
so pause/resume just redoes the remaining books.

## Hebrew Torah linguistic engine (search)

`shared/hebrewTorahDict.js` is a zero-dependency module shared by search and Quick Jump. It works
at query time on the index's normalized form, so it needs no schema change or re-indexing:

- ~580 bidirectional abbreviation entries (books, Shulchan Aruch / Rambam sections, tractates,
  Tanach, midrash, sages, 300+ general phrases): `ב"ד` ↔ `בית דין`, `שו"ע` ↔ `שולחן ערוך`.
  `רמבם` / `רמב"ם` / `רמב״ם` resolve identically.
- Ktiv male/chaser variants (`שולחן` ↔ `שלחן`, `קידושין` ↔ `קדושין`, `תפילין` ↔ `תפלין`, `אלוקים` / `אלהים`).
- Proclitic prefixes (`ו ה ב כ ל מ ש`, `וב`, `וה`, `של`, `כש`…) and suffixes (FTS5 prefix queries `"שבת"*`).
  Words of 1–2 letters are never expanded.

The Search screen's **חיפוש מורחב** mode (default) builds an OR-group of variants per word, capped at
24 per word and 160 per query; **חיפוש מדויק** matches the typed words only. A `"quoted phrase"` is always
exact. Result cards and the reader mark the variant that actually matched (`ושלחן`, `בית דין`, `ובשבת`).

## Library storage & updates

Nothing is bundled in the APK. On the device there are two SQLite databases in the app's
`FileSystem.documentDirectory + 'SQLite/'`:

| File | Contents | Where it comes from |
| --- | --- | --- |
| `core_library.db` | the main (Otzaria) library | downloaded from a GitHub Release, **or** built on the device from an Otzaria folder |
| `user_library.db` | personal books | imported on the device (`.txt` files or whole folders) |

* **One library in the UI.** `shared/sources.js` routes every per-book query (reader window,
  TOC, Quick Jump traversal, commentaries) to the database that owns the book, and merges
  library-wide ones (Quick Jump index, the tree, the search scope picker, full-text search with
  keyset paging across both databases). Personal books use ids above 1,000,000,000 for
  categories, books, TOC nodes and paragraphs, so ids never collide, and they all live under a
  "הספרים שלי" folder in the tree. (`ATTACH` + `UNION ALL` views were measured and rejected:
  SQLite materializes the whole `paragraphs` table when such a view is joined.)
* **Same indexer on the PC and the phone.** Parsing, `normalizeHebrew`, aliases, `extractRefKey`,
  link matching, batched paragraph + FTS inserts and link de-duplication live in
  `shared/indexer.js`. `scripts/build-db.js` and the on-device indexer
  (`src/services/localIndexer.ts`) both call it, so a book indexed on the phone behaves exactly
  like one from a release.
* **First launch** (no `core_library.db`): the Library screen shows a welcome card with
  **הורד ספרייה מוכנה מהענן** (download) and **ייבא ספרים מהמכשיר** (import).
* **ניהול ספרייה ועדכונים** (the **ניהול** button in the Library header):
  * *Core library*: installed version, build date, source, books / paragraphs / links / size.
    **בדוק עדכונים** reads the release manifest and shows whether a newer version exists;
    **הורד והתקן** downloads it with a live progress bar, checks the byte size and SHA-256
    (computed natively), stream-decompresses `.gz` / `.zip` in 1 MB chunks into
    `core_library.db.tmp`, opens it to check `meta.db_version` and the schema, then renames it
    over `core_library.db` (atomic) and reopens. Free space is checked first, the download can
    be cancelled, and `user_library.db` is never touched. The release URL is editable: a
    `manifest.json`, or a direct `.gz` / `.zip` / `.db` link (no SHA-256 check then). The
    default is `expo.extra.libraryManifestUrl` in `app.json`.
  * **בנה ספרייה מתיקיית אוצריא במכשיר**: pick the Otzaria folder (the one containing `אוצריא/`
    and `links/`, or just a books folder). The library is indexed into the staging file with live
    progress (file count + current book) and swapped in only when complete.
  * *Personal books*: **ייבוא קובץ ספר (.txt)** (one or more files) and **ייבוא תיקיית ספרים**
    (sub-folders become categories; link CSV/JSON files in the folder, an `aliases.json` and
    `order.json` are honoured). Re-importing the same file replaces it. Books or whole folders
    can be deleted (text, TOC, FTS rows and links are removed).
  * Jobs keep running if you leave the screen (a progress banner shows on the Library screen),
    and the device is kept awake (`expo-keep-awake`) while one runs.
* **Resumable, crash-proof imports** (core builds and personal imports, built for 4GB+ Otzaria
  folders):
  * *Checkpoints.* Each target DB has an `ingestion_state` row (`source_uri`, `target_db`,
    `status` = `in_progress` / `paused` / `completed`, `phase` = books / links / finalize,
    `processed_count` / `total_count`, `last_book_path`, `base_book_id`, `updated_at`) and an
    `ingestion_errors` log. They are written **in the same transaction** as the books they
    describe, so after a crash the checkpoint always matches what is on disk.
  * *Small commits.* Core builds commit every 10 books, personal imports every book, and any
    batch commits early once 20,000 paragraphs are pending (huge tractates). Every book is
    inserted with `books.is_complete = 0` and flipped to `1` only after its paragraphs, TOC and
    FTS rows are in.
  * *Idempotent resume.* Resuming the same folder skips books that the interrupted run already
    completed (same `file_path`, `is_complete = 1`, id above the run's `base_book_id`) without
    reading them, and redoes anything half-written. A finished link or finalize phase is not
    repeated.
  * *Pause / background.* **השהה** in the progress card, or the app going to the background
    (`AppState` `background` / `inactive`), stops the job right after the current book commits
    (status `paused`). When the app is active again the job continues automatically. If the OS
    killed the app instead, the next launch shows **המשך בנייה שנעצרה** / **המשך ייבוא שנעצר**
    (Library screen + manager) with `X / Y ספרים הושלמו` and **המשך** / **מחק ואפס**. If the
    folder permission did not survive the restart, you are asked to pick the same folder again.
    **ביטול** (after a confirmation) stops and discards the partial import.
  * *Error isolation.* Every book runs in a `SAVEPOINT`: a malformed or unreadable file is
    rolled back alone, logged (`ingestion_errors`, shown in the result card) and skipped.
    Hidden files, `__MACOSX`, `Thumbs.db`, Office lock files and every non-`.txt` file (pdf,
    jpg, epub, ...) are filtered by name before anything is read.
  * *Bounded memory.* A UI yield after every book; the core build file uses WAL with
    `synchronous = NORMAL`, a 16 MB page cache and on-disk temp tables, and runs
    `wal_checkpoint(TRUNCATE)` every few commits. FTS rows are added per book and merged at the
    end with incremental FTS5 `merge` steps (each its own short transaction + WAL checkpoint)
    instead of one giant `optimize`.
  * The on-device core build lives in `SQLite/core_library.build.db` (kept across restarts);
    when complete it is moved to `core_library.db.tmp` and installed atomically like a download.
* Tabs and search scopes pointing at books that disappeared (core replaced, book deleted) are
  closed or reset automatically.
* Upgrading from a pre-M5 build: the old copied `library.db` is adopted as `core_library.db`.

## Publishing a library release

Build the full library on a PC (Node ≥ 22.13) and upload two files to a GitHub Release.

```bash
# 1. Put the Otzaria sources in place (once)
#   Windows (PowerShell):  Copy-Item -Recurse "C:\otzaria\אוצריא\*" raw_library\full\
#                          Copy-Item -Recurse "C:\otzaria\links\*" raw_links\full\
#   macOS / Linux:         cp -R ~/otzaria/אוצריא/* raw_library/full/
#                          cp -R ~/otzaria/links/* raw_links/full/

# 2. Build the DB and the release artifact
npm run db:release      # -> assets/db/library.db, dist/core_library.db.gz, dist/manifest.json
# (npm run db:release:sample does the same for the sample library)
```

`dist/manifest.json` looks like this (sample library shown):

```json
{
  "format": 1,
  "version": "e9c3bccb1437",
  "schemaVersion": 2,
  "builtAt": "2026-11-22T12:07:35.643Z",
  "source": "sample",
  "books": 9, "categories": 6, "paragraphs": 9083, "links": 26, "tocNodes": 530,
  "file": "core_library.db.gz",
  "compression": "gzip",
  "size": 2059320,
  "sha256": "<sha-256 of the .gz>",
  "dbSize": 7327744,
  "dbSha256": "<sha-256 of the .db>"
}
```

```bash
# 3. Publish: create a release and attach BOTH files (GitHub CLI shown; the web UI works too)
gh release create library-$(node -p "require('./dist/manifest.json').version") \
  dist/core_library.db.gz dist/manifest.json \
  --title "Library $(node -p "require('./dist/manifest.json').version")" --notes "Otzaria core library"
```

The app's default URL is `https://github.com/<owner>/<repo>/releases/latest/download/manifest.json`
(set in `app.json` → `expo.extra.libraryManifestUrl`). `releases/latest/download/<name>` always
points at the newest non-prerelease release, so publishing a new release is all it takes; the
app resolves `file` relative to the manifest URL. To host the `.gz` elsewhere, pass
`--release-url=<absolute url>` to `build-db.js` (stored as `url` in the manifest).

* Read the build output: `links: … stored (…)` and `WARNING: N unmatched book name(s)` (add
  spellings to `raw_library/aliases.json`, `{ "שם בספרייה": ["שם בקובץ הקישורים"] }`, and
  rebuild, or ignore them; those links are skipped).
* GitHub limits release assets to 2 GB each. A `.zip` containing one `.db` file also works
  (the app takes the first `*.db` entry).
* The phone needs free space for the download plus the extracted DB (the downloaded file is
  deleted after extraction). The manager checks this before starting.
* To ship a smaller library, build from a subset: `raw_library/full` can hold any subset of
  Otzaria's folders, with or without their link files.

## Building the Android APK

The APK contains no library, so every profile builds the same lightweight app (no DB step):

| Command | Output |
| --- | --- |
| `npm run eas:preview` (EAS `preview` profile) | installable APK (internal distribution), built in the cloud |
| `npm run apk` | APK built locally with Gradle |
| `eas.json` → `production` | AAB for Google Play (the library is downloaded after install, so Play's size limit is not a concern) |

Settings (already configured):

* `app.json`: `android.package` `com.kodeshread.app`, `versionCode` (bump it for every
  release), `expo-sqlite` `enableFTS`, `minSdkVersion` 24, `expo-updates` for the first-launch
  RTL reload, `extra.libraryManifestUrl` (where **הורד** looks for a library).
* **arm64-v8a only** (APK ~100 MB -> ~35-40 MB): `expo-build-properties` `android.buildArchs`
  limits what React Native / Expo modules compile (`reactNativeArchitectures`), and
  `plugins/withAndroidAbiFilters.js` adds `defaultConfig { ndk { abiFilters "arm64-v8a" } }`
  so prebuilt native libraries inside AARs are not packaged for the other ABIs either. Every
  64-bit Android phone runs arm64-v8a. For an x86_64 emulator build, override at prebuild time:
  `KODESHREAD_ABIS=arm64-v8a,x86_64 npx expo prebuild --platform android --clean` (EAS: set
  `KODESHREAD_ABIS` in the build profile's `env`).
* `metro.config.js`: `db` in `resolver.assetExts` (only the web preview imports the sample DB
  asset, via `src/db/webSeed.web.ts`; native bundles never reference it), `raw_library/` and
  `raw_links/` blocked from the bundler.

### Local Gradle build

Needs the Android SDK and JDK 17 (installing Android Studio provides both; set
`ANDROID_HOME`).

```bash
npm install
npm run apk
```

This runs `expo prebuild --platform android --clean` (generates `android/`, which is
git-ignored, so never edit it by hand) and `./gradlew assembleRelease`. The APK is at
`android/app/build/outputs/apk/release/app-release.apk`. Install it with
`adb install -r android/app/build/outputs/apk/release/app-release.apk` or copy it to the
phone. The generated project signs release builds with the debug keystore, which is fine for
side-loading; for a store release use EAS, which manages a real keystore.

### EAS build

```bash
npx eas-cli@latest login
npx eas-cli@latest build:configure      # first time only: links the project to your Expo account
npm run eas:preview                     # cloud build -> APK download link
```

After installing, open the app and choose **הורד ספרייה מוכנה מהענן** (after you have
published a library release) or import books from the device.
