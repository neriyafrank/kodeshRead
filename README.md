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
  * Each book is indexed in its own transaction with a yield to the UI in between, so the app
    stays usable while importing. Jobs keep running if you leave the screen (a progress banner
    shows on the Library screen).
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
