# kodeshRead

Offline-first Android Torah library (Expo + TypeScript) powered by
[Otzaria](https://github.com/Sivan22/otzaria) text files. The whole library is
pre-built into one SQLite database (`assets/db/library.db`, FTS5-indexed) that is
bundled inside the APK. See [`CLAUDE.md`](CLAUDE.md) for the full spec.

**Status:** Milestone 4 (all spec milestones done): project setup, the DB build pipeline,
the Library screen with Quick Source Jump and the RTL tree (M1), the windowed reader
workspace (M2), Hebrew full-text search (M3), and parallel commentaries plus standalone
Android APK packaging (M4):

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
npm run db:sample      # raw_library/sample -> assets/db/library.db
npm test               # pipeline, Quick Jump, reader & FTS5 search self-test
npm start              # Expo dev server (also auto-builds the DB if missing)
```

`npm run android` builds a native dev build (`expo run:android`, needs the Android SDK).
To build an installable APK, see [Building the Android APK](#building-the-android-apk).
The app uses `expo-updates` for the first-launch RTL reload, so run it as a dev build
rather than in Expo Go. `npm run web` gives a quick browser preview of the UI;
with it running, `npm run e2e:search` and `npm run e2e:commentary` drive the Search screen
and the commentary drawer end to end with Playwright (needs `playwright` + Chromium available).

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

Every build writes `assets/db/db-version.json`. When the bundled version differs from
the copy on the device, the app re-copies the DB on next launch.

## Quick Source Jump examples

`שבת ב.` · `שבת קנז ב` · `ר"ה טז:` · `מסכת ראש השנה ג` · `בראשית יב א` (verse) ·
`שוע אוח כה ה` · `רמבם שבת א א` (once those books are in the library)

## Building the Android APK

The library DB is **bundled inside the APK** (`assets/db/library.db`, stored uncompressed
via `plugins/withAndroidNoCompress.js`; FTS5 via `expo-sqlite`'s `enableFTS`). So the DB
must be built **before** the native build. `scripts/eas-build-db.js` checks this for
every build:

| Profile / command | Library | What happens to the DB |
| --- | --- | --- |
| `eas.json` → `preview` · `npm run apk:sample` | sample | rebuilt from `raw_library/sample` |
| `eas.json` → `preview-full`, `production` · `npm run apk:full` | full | uses the DB you built with `npm run db:full`; the build **fails** if it is missing or was built from the sample |

Settings that make standalone builds work (already configured):

* `metro.config.js`: `db` in `resolver.assetExts`; `raw_library/` and `raw_links/` are
  blocked from the bundler.
* `app.json`: `android.package` `com.kodeshread.app`, `versionCode` (bump it for every
  release), `expo-sqlite` `enableFTS`, `minSdkVersion` 24, `noCompress: ["db"]`,
  `expo-updates` for the first-launch RTL reload.
* `eas.json`: `preview` / `preview-full` produce an **APK** (`android.buildType: "apk"`,
  internal distribution); `production` produces an AAB for Google Play.
* `.easignore`: same as `.gitignore` but **uploads** `assets/db/library.db`, so a full DB built
  on your PC reaches EAS. `raw_library/full` and `raw_links/full` are never uploaded.
* `eas-build-post-install` (in `package.json`) runs `scripts/eas-build-db.js` on the build
  machine with the profile's `LIBRARY_SOURCE`.

### 1. Build the full library DB on your PC

Needs Node ≥ 22.13 and a copy of the Otzaria library (the folder that contains `אוצריא/`
and `links/`).

```bash
git clone <this repo> && cd kodeshRead
npm install

# Books: the category folders (תנך, תלמוד בבלי, הלכה, …) go straight into raw_library/full
#   Windows (PowerShell):  Copy-Item -Recurse "C:\otzaria\אוצריא\*" raw_library\full\
#   macOS / Linux:         cp -R ~/otzaria/אוצריא/* raw_library/full/
# Links: Otzaria's *_links.json files go into raw_links/full
#   Windows (PowerShell):  Copy-Item -Recurse "C:\otzaria\links\*" raw_links\full\
#   macOS / Linux:         cp -R ~/otzaria/links/* raw_links/full/

npm run db:full        # -> assets/db/library.db (can take several minutes)
```

Read the build output:

* `links: … stored (… duplicate/reverse, … pointing at missing lines …)`: what went into
  the `links` table.
* `WARNING: N unmatched book name(s) in links`: link files naming books that are not in
  `raw_library/full` (or are spelled differently). Add their spelling to
  `raw_library/aliases.json` (`{ "שם בספרייה": ["שם בקובץ הקישורים"] }`) and rebuild,
  or ignore them; those links are simply skipped.
* The final line gives the DB size and `DB_VERSION`. Every new DB version is re-copied on the
  device on the next launch.

Optional checks: `npm test` (runs against whatever DB is in `assets/db`) and `npm start`
to try it in a dev build.

### 2a. Build the APK on your PC (local Gradle, recommended for the full library)

Needs the Android SDK and JDK 17 (installing Android Studio provides both; set
`ANDROID_HOME`).

```bash
npm run apk:full       # or: npm run apk:sample
```

This checks the DB, runs `expo prebuild --platform android --clean` (generates `android/`,
which is git-ignored, so never edit it by hand) and `./gradlew assembleRelease`. The APK is at
`android/app/build/outputs/apk/release/app-release.apk`. Install it with
`adb install -r android/app/build/outputs/apk/release/app-release.apk` or copy it to the
phone.

The generated project signs release builds with the debug keystore, which is fine for
side-loading. For a store release, use EAS (step 2b), which manages a real keystore,
or configure your own signing.

### 2b. Build the APK with EAS

```bash
npx eas-cli@latest login
npx eas-cli@latest build:configure      # first time only: links the project to your Expo account

npm run eas:preview                     # sample library, cloud build -> APK download link
npm run db:full && npm run eas:preview-full   # full library, built on THIS machine (--local)
```

* `preview` (sample) builds in the cloud: the build machine regenerates the sample DB itself.
* `preview-full` runs `eas build --local` (needs the Android SDK, like 2a), because the full
  DB can be very large to upload. To build it in the cloud instead, run
  `npx eas-cli@latest build --platform android --profile preview-full` after `npm run db:full`:
  `.easignore` uploads the pre-built DB, and the build fails early if it is missing.
* `production` makes an AAB for Google Play with the full library. Play limits the base
  download size, so a very large library needs Play Asset Delivery; the APK route has no such
  limit.

### Size notes

The DB is stored uncompressed in the APK (SQLite needs random access), and on first launch
it is copied once into the app's data folder. So the installed app needs about twice the
DB size of free space. To shrink it, build from a subset of the library: `raw_library/full`
can hold any subset of Otzaria's folders, with or without their link files.

