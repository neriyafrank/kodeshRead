# Project Specification: Mobile Torah & Text Library (Otzaria-Compatible)

## 1. Vision & Core Architecture
An ultra-fast, offline-first **Android** mobile application built with **Expo (React Native)** and **TypeScript**, inspired by **Bar-Ilan Responsa (פרויקט השו"ת)** and powered by **Otzaria (אוצריא)** structured text files.

> **Milestone 5 supersedes the bundling decision below:** the APK bundles no database. The app keeps
> `core_library.db` (downloaded from a GitHub Release manifest, or built on-device from an Otzaria folder)
> and `user_library.db` (personal imports, ids >= 1,000,000,000) in `documentDirectory + 'SQLite/'`, and
> queries both through `shared/sources.js`. Ingestion logic lives in `shared/indexer.js`, shared by
> `scripts/build-db.js` and `src/services/localIndexer.ts`. See section 5 and README "Library storage & updates".
>
> **Resumable ingestion (schema v3):** `books.is_complete` plus `ingestion_state` / `ingestion_errors`
> checkpoint tables (written in the same transaction as the books); per-book SAVEPOINT error isolation;
> pause on `AppState` background + auto-resume; `expo-keep-awake` during jobs; on-device core builds in
> `core_library.build.db` until complete. APKs target `arm64-v8a` only (`plugins/withAndroidAbiFilters.js`).

> **Commentary reference alignment (schema v4):** `ref_links` (base/commentary line ranges + canonical
> `ref_key` like `פרק א|פסוק א`) is built in the links phase by `shared/refAlign.js` (`indexer.indexRefLinks`,
> idempotent per commentary book, pause-safe). `shared/commentary.js` merges it with `links`; the drawer shows
> whole commentary blocks per unit (schema v5: covering `(book, partner, start, end)` indexes). Commentary <->
> base pairing: `shared/pairing.js`, calibrated on the full library map `otzaria_index_only.txt` (regression-tested
> in `scripts/selftest.js`). Query-time Hebrew abbreviation/morphology engine: `shared/hebrewTorahDict.js`.

> **Streaming ingestion (schema v6):** `shared/pipeline.js` runs scan -> books -> links -> finalize. The scan
> persists folders/files breadth-first in the SQLite `import_queue` (one folder per transaction, non-text files
> counted in `skipped_count`, never read); books are written one per transaction (lines, TOC, FTS and the
> heading units in `book_units`) with the queue row marked done in the same transaction; the links phase pairs
> commentaries by folder path + title only (no external link files; `links/` is never read) and aligns them
> from `book_units`, 20 per transaction with a committed cursor. Android imports run under a foreground service
> (`modules/import-foreground-service` + `plugins/withImportForegroundService.js`, dataSync + WakeLock + progress
> notification; JS wrapper `src/services/importForegroundService.ts`, no-op on web). Kill/resume is self-tested
> at every 9th SQL statement in `scripts/selftest.js`.

> **Import stability:** books are streamed (`shared/bookStream.js`: 64KB `FileHandle` chunks -> incremental UTF-8
> -> lines -> `indexer.createBookParser`, 150-paragraph inserts, 2,000-row FTS statements), never held whole.
> `shared/pipeline.js` commits `ingestion_state.inflight_key/inflight_attempts` before each book / links batch and
> skips a unit the app died on twice (`CRASH_MESSAGE`). Pairing yields (`pairCommentariesAsync`). Personal imports
> use their own SQLite connection. The foreground service never `stopService()`s before `startForeground()`.
> Self-tested: streamed == whole-file builds, poison book / poison commentary, kill at every 9th statement.

> **End of a core build (finalize + swap):** `shared/coreFinalize.js` runs named sub-steps
> (`finalize:fts_optimize` ... `finalize:swap_file`, `finalize:reopen_db`); optimizations are non-fatal, no
> on-device VACUUM. `ingestion_state.finalize_step` ('index' / 'meta') + `last_error` make a failed finish retry
> only finalize (`localIndexer.finalizeCoreBuild`). The build installs by an awaited same-directory rename of
> `core_library.build.db` (`installCore(CORE_BUILD_DB)`), after draining readers, closing the core connection
> and deleting its `-wal` / `-shm`. Every `File.move()` must be awaited (async in expo-file-system 58).
> Failures carry `JobResult.diagnostic` (`ErrorDetails.tsx`, "העתק פרטי שגיאה").

> **Commentary drawer priority & accordion:** `shared/commentaryRank.js` orders linked commentaries
> (⭐ pins from `src/state/commentaryStore.ts` -> base text -> per-corpus canonical core lists -> Otzaria era
> folders תרגומים/ראשונים/אחרונים/מחברי זמננו -> alphabetical), assigns tier badges, picks the default-open
> cards (pins + top 3) and filters by name with Torah abbreviations. `CommentaryPane.tsx` renders collapsible
> cards with a sticky filter / chips / pill-strip header. Regression-tested in `scripts/selftest.js`.

> **Reading typography & themes:** `shared/typography.js` (font keys, vocalization-aware line height:
> slider = plain leading 1.55x, +0.2 niqqud / +0.3 te'amim; margin verse numbers via `splitVerseMarker`;
> persisted-settings migrate/sanitize, `APPEARANCE_VERSION` 3). Default reader font: bundled Taamey Frank CLM
> (`assets/fonts/`, GPOS mark/mkmk; `expo-font` plugin in `app.json` + `useFonts`), plus Frank Ruhl /
> David / Assistant / Heebo / `system` ("מערכת"). Themes בהיר / ספיה / כהה (Dark = charcoal `#212121`,
> text `#E8E6E3`, `selection` slate-indigo). Self-tested in `scripts/selftest.js`, e2e in `e2e:reader`.

> **Torah study (parshiot & daily learning):** `shared/torahParshiot.js` is the static dataset of the 54
> parshiot (7 aliyot + maftir, Hebrew chapter / verse numbering, cross-checked with hebcal) plus
> `chumashVerseLines()` (verse -> line from the `פרק` TOC + `(א)` markers). The reader draws centered
> parsha / aliyah dividers above the verse rows of a Chumash book (`BookReader.tsx`, outside the rows' press
> targets: no line index or link changes); the TOC drawer has a persisted `פרקים | פרשות` switch
> (`src/state/learningStore.ts`). `shared/dailyLearning.js` computes פרשת השבוע + today's aliyah, Daf Yomi,
> Mishna Yomit and Rambam 1 / 3 offline (deep imports of `@hebcal/core/dist/esm/sedra`,
> `@hebcal/learning/*Base`, `@hebcal/hdate`; ארץ ישראל default / חו"ל) and maps each onto a real Otzaria path,
> resolved via `quickJump.resolveInBook` (`src/services/dailyLearningNav.ts`; missing books = unavailable).
> UI: `src/components/learning/DailyLearning.tsx` (Library screen card only: the TOC drawer stays on the
> current book). e2e pins today with `globalThis.__KODESHREAD_TODAY__`. Quick Jump understands parshiot /
> aliyot (`torah.parseParshaQuery`, merged in `quickJump.resolveReference`; the 5 book names stay book
> references unless `פרשת` / an aliyah word / `מפטיר` is typed).

> **Simple vs Advanced Search:** `shared/hebrewSearch.js` builds every query plan (pure JS, over the existing
> `paragraphs_fts`, no schema change). Simple Search (`src/app/search.tsx`) is literal (`SIMPLE_DEFAULTS`:
> no expansion, no operators) with a "חיפוש מתקדם" button; Advanced Search (`src/app/advanced-search.tsx`)
> has main / אחת מהמילים / ללא המילים fields, inline `a|b`, `-word`, `word*`, `"exact"`, toggles
> (`ADVANCED_DEFAULTS`: prefixesAndSuffixes on; pleneDefective, acronyms, aramaicEquiv off), proximity
> (פסקה / ביטוי מדויק / קרבה 3·5·10 + order) and corpus chips (`search.CORPORA`). `shared/search.js`
> `searchPlan` / `countPlan` run plans: FTS5 candidates, `hebrewSearch.evaluate()` for exactness, exact
> matches first (`{ phase, afterId }` cursor); the no-FTS5 web fallback returns identical results.
> Highlight patterns `~x` / `^x` / `%x` go through `makeTermMatcher`. Self-tested in `scripts/selftest.js`
> (section 10), e2e in `e2e:search`.

> **Search progress UI:** `shared/searchLifecycle.js` (pure state machine: idle -> searching -> done | cancelled; every action
> carries a monotonic request id so stale / post-cancel results are ignored; Hebrew elapsed formatting with LTR-isolated numbers)
> drives `usePlanResults` (`src/components/search/`): loading state dispatched first, work starts after the next paint, an
> `AbortController` per run (`shared/search.js` `signal` / `onProgress`: real verify / count batch counts), first page shown while
> the total resolves (`counting`). `SearchProgress.tsx` = native-driver sweep bar + banner (scope / stage, live timer and `ביטול`
> after 300 ms, `החיפוש בוטל` + `חפש שוב`) + `LoadingMoreFooter`, used by Simple and Advanced Search. e2e slows runs with
> `globalThis.__KODESHREAD_SEARCH_DELAY_MS__` / `__KODESHREAD_COUNT_DELAY_MS__`. Self-tested (section 13), e2e in `e2e:search`.

> **Canonical library catalog & multi-select scope:** `shared/libraryCatalog.js` (pure JS, no schema change) is the
> single tree behind the Library screen (`LibraryColumns.tsx`: `ספרי בסיס` | `מפרשים לפי ספר`, live filter, inline
> `מפרשים (N)` pill) and the search Scope Picker (`ScopeSheet.tsx`, multi-select). `is_commentary` is derived: a book
> paired by `shared/pairing.js` (same pairing as the `ref_links` phase) with a base book is a commentary and is grouped
> under its root base book in `shared/commentaryRank.js` order (תרגומים / ראשונים / אחרונים together); corpus-wide or
> unpaired commentary-folder books go to "מפרשים כלליים". Base books use the traditional order (תנ"ך, משנה + תוספתא,
> Shas, ירושלמי, מדרש, הלכה with Rambam's 14 ספרים / ארבעה טורים / שו"ע, ...); empty sections are hidden. Built once per
> library generation (`src/db/useLibraryCatalog.ts`, async pairing). Search scope kind `books` (`booksScope`,
> `bookIdsCondition`) is one `book_id IN (...)` condition in FTS5 and the web fallback; chips: `ScopeChips.tsx`.
> Daf/amud spellings (`דף ב, א`, `דף ב - עמוד ב`, `ע"ב`, `דף ב עמוד א.`) normalize in `refAlign.unitLabels`.

> **Bavli paragraph-level commentary (`שורה N`):** in Otzaria's Bavli commentaries (רש"י, ...) the sub-headings
> `שורה א` / `שורה ה` / `שורה טו` (also `שורה א'`, `א:`, `12`, `פסקה ה`) under a daf / amud mean the **N-th body
> (non-heading) paragraph of that amud** in the base Gemara, not a visual line (`refAlign.paragraphNumber`, canonical
> gematria). `refAlign.alignUnits` links each `שורה N` block to that single base paragraph (`ref_links`, no schema change;
> N beyond the paragraph count clamps to the last paragraph), the amud's text before the first `שורה` to paragraph 1, and
> also splits plain-paragraph `שורה N` markers (stored as lines, not headings). A commentary without `שורה` headings keeps
> the amud-level link. Both directions are paragraph-exact (רש"י שורה ה <-> Gemara paragraph 5); the drawer shows only that
> block (heading rows are never entries; plain marker lines are filtered in `commentary.fetchLinkedEntries`), labelled
> "רש"י על שבת ‹ דף ב. ‹ שורה ה". The sample `רש"י על שבת` uses this format. Self-tested (gematria, fixtures, sample dibur
> hamatchil <-> Gemara paragraph) and in `e2e:commentary`.

> **Preset corpora (Simple + Advanced Search):** `shared/corpora.js` is the single source of truth for the presets
> (תנ"ך, משנה, בבלי, ירושלמי, משנה תורה, שולחן ערוך = base books only; מפרשים = commentaries). It never matches exact folder paths:
> a book qualifies when its corpus root (first folder after wrapper folders like `אוצריא/`) is recognised, its title is a canonical
> book of THAT corpus (`libraryCatalog.CANON`), and strict commentary exclusion passes (commentary / translation folders, "X על Y" /
> פירוש / תרגום titles, known commentators, the catalog's `isCommentary`). A selection resolves to a `books` scope
> (`corpusScope`, `scope.corpora` remembers the presets; name "בבבלי (37 ספרים)" feeds the progress banner) - the SQL folder-pattern
> scope is gone. UI: `CorpusPresets.tsx` + `src/db/useCorpora.ts` (counts per preset). Self-tested (section 15, incl. the real
> `otzaria_index_only.txt`: 39 / 63 / 37 / 39 / 83+ / 4 books), e2e in `e2e:search`.

> **Cloud library (multi-part release):** `.github/workflows/build-library.yml` (workflow_dispatch: `source_repo`,
> `library_scope` = `classical_full` | `all`) builds `core_library.db` on a runner (`scripts/ci/fetch-otzaria-source.sh`,
> `build-db.js --scope --lean`, `scripts/cloud-release.js validate|manifest`), zips it, splits it into 1.5 GB
> `core_library.db.zip.part-NN` and publishes them with `library-manifest.json` to the `library-latest` release. The app
> side is `shared/multipart.js` (manifest validation, resumable part download, streaming assembly, extraction;
> pure, io-injected) + `src/services/cloudLibrary.ts` + `CloudLibraryCard.tsx`. `paragraphs_fts` was already an
> external-content table (no duplicated text). Scope filter: `shared/libraryScope.js`. Self-tested (section 12) and
> covered by `e2e:library` (mocked 2-chunk release over in-memory storage).

> **Instant cloud starter (no download wall):** while no full `core_library.db` is installed the app runs on
> `starter_library.db` (same schema, `ensureSchema(kind: 'starter')`, one more `shared/sources.js` router source with
> core ids). `shared/starterPacks.js` = curated list (`STARTER_BOOKS`), selection in canonical `libraryCatalog` order,
> pack build/validate/decode, pure-JS SHA-256 fallback and `importStarterPack` (one transaction: categories by path,
> books by `file_path`, ids preserved or shifted on collision, FTS rows, `ref_links` of new books only; idempotent).
> `scripts/export-starter-packs.js` runs in `build-library.yml` before the DB is deleted and publishes
> `starter-catalog.json` + `starter-<slug>.json.gz` to the separate `starter-latest` release. App: `src/services/starterLibrary.ts`
> (catalog cache, download -> verify -> import), `src/state/starterStore.ts`, `StarterBooks.tsx` (+ upgrade banner,
> `OnboardingCard starter`). `LibraryContext` installs the full core via the unchanged `installCore`, then deletes the starter
> DB and remaps tabs by title + folder (`remapTabs`); `removeCore` goes back to starter mode. Self-tested (section 14), `e2e:library`.

> **Canonical book roles & parallel works:** `shared/bookRoles.js` classifies every book as base / parallel /
> commentary / targum (commentary only when explicitly matched by `shared/pairing.js`; series / owner pairs only in a
> commentary context; unpaired era-folder books stay standalone). `shared/parallelWorks.js` = allow-listed families linked
> bidirectionally at one level: turim (טור / שו"ע / לבוש / ערוך השולחן / שו"ע הרב by part + סימן, never סעיף; never
> קיצור שו"ע / חיי אדם / חכמת אדם / בן איש חי), shas (משנה / בבלי / ירושלמי / תוספתא / רי"ף / רא"ש by canonical tractate +
> perek; Bavli perakim cut at "הדרן עלך"; Megillah / Sanhedrin / Menachot / Tamid order divergences matched by perek name
> only), parasha (חומש / מדרש רבה / תנחומא / זוהר / ספר החינוך; never by mitzvah number). Resolved at query time from
> `toc_nodes` (`findParallels`, cached per router; no schema change, no rebuild). Drawer: `commentary.parallelGroups` /
> `mergeParallelGroups`, `commentaryRank` kinds (מפרשים / תרגומים / מקבילים pills, parallels last + folded),
> `CommentaryPane` `parallel-*` test ids. Library: `⇄ מקביל` tag, רי"ף / רא"ש sections, "ספרים מקבילים לטור ולשולחן
> ערוך". Audit: `node scripts/audit-parallels.js [--db=…]` (also in `build-library.yml`). Self-tested (section 16),
> e2e in `e2e:commentary` / `e2e:library` (sample `משנה שבת` excerpt).

> **Two cloud editions (basic / full):** `shared/editions.js` (pure) maps `classic` (`classical_full`, without the `מחברי זמננו` /
> `אחרוני זמננו` folders; release `library-classic-latest`) and `full` (`all`; release `library-latest`, unchanged tag and asset names)
> to scopes, tags and manifest URLs. `build-library.yml` (`editions`: `both` default | `full` | `classic`; matrix from
> `scripts/ci/edition-matrix.js`, Node built-ins only) builds each edition in its own job and publishes to its own tag, so they never
> overwrite each other; `starter-latest` is exported once per run (classic build, else full). Each build runs `cloud-release.js
> check-edition` and `audit-parallels.js`. Manifests carry `edition` + `releaseTag`; `meta.scope` in the DB and
> `libraryStore.installedCloud` tell the app which edition is installed (`editions.installedEdition`). `CloudLibraryCard.tsx` shows both
> editions (live size + book count from each manifest, `מותקן כעת` badge, `קיים עדכון בענן` only for the installed edition's own release,
> switching confirmed; `LibraryContext.installCore` remaps open tabs by title + folder). Self-tested (section 12 "editions"), `e2e:library`.

> **Resilient cloud download:** `shared/multipart.js` `downloadParts` writes each part to `<part>.partial` and renames it when it
> has the manifest size; the partial is never deleted on an error, the retry continues it with an HTTP Range request
> (`PartsIO.download(..., { resumeFrom, expectedBytes })`, native backend in `cloudLibrary.ts`: Range probe -> `.chunk` file ->
> appended to the partial, also after a process death). Transient errors (`isTransientNetworkError`: "Unable to resolve host",
> ECONNRESET, timeouts, 5xx) retry 4x with exponential backoff (`backoffDelayMs` 2/4/8/16 s; budget refills when bytes
> arrived) and show `הרשת נותקה זמנית — מנסה להמשיך הורדה…`; a failure while `AppState` is not active (and no foreground
> service) waits for `active` and is not counted. `runJob('download')` starts the import foreground service
> (`formatCloudNotification`: "מוריד ספרייה מהענן… 42%"); assembly + extraction (`keepAwake` option) and the DB swap run under
> `withKeepAwake` (`src/services/keepAwake.ts`, released in `finally`). Self-tested (section 12, "resilient download").

### Key Architectural Decision: Pre-Built Bundled SQLite Database
- The entire library is **bundled inside the APK** (zero runtime file importing needed on the device).
- A build-time Node.js ingestion script (`scripts/build-db.js`) runs on the developer's PC before building the app. It parses Otzaria folders, `.txt` files (with HTML heading tags), and commentary links into a single pre-indexed SQLite database (`assets/db/library.db`) with **SQLite FTS5**, book acronyms/aliases, and clean TOC reference keys.
- At runtime, the app opens `library.db` via `expo-sqlite` for instant (under 15ms) queries and reference jumps.

---

## 2. Tech Stack & Libraries
- **Framework:** Expo (SDK 52+), React Native, TypeScript, Expo Router (file-based routing).
- **Target Platform:** Android (standalone APK via EAS Build `preview` profile or local Gradle).
- **Database:** `expo-sqlite` (with FTS5 enabled) + `expo-build-properties` (`noCompress: ["db"]`).
- **Performance Lists:** `@shopify/flash-list` for 120fps virtualized rendering of massive books.
- **State & Persistence:** `zustand` + `react-native-mmkv` (or `AsyncStorage`) for persisting open tabs, exact scroll positions, DB version, and typography preferences.
- **RTL & Lifecycle:** `I18nManager.forceRTL(true)` + `expo-updates` (`Updates.reloadAsync()`) to enforce RTL layout immediately on very first app launch.
- **Fonts:** Bundled Hebrew fonts (`FrankRuhlLibre`, `DavidLibre`, `Assistant`, `Heebo`).

---

## 3. Data Structure & Ingestion Pipeline (`scripts/build-db.js`)

### Input Format & Sanitization
1. **Folder Hierarchy:** `raw_library/<Category>/<SubCategory>/<BookTitle>.txt` defines the library tree.
2. **File Hygiene:** Strip UTF-8 BOM (`\uFEFF`), normalize `\r\n` to `\n`, and sanitize raw HTML tags (preserve safe inline tags like `<b>` and `<small>` for rich text rendering; strip unsupported tags).
3. **Book Text Files (`.txt`, UTF-8):**
   - `<h1>` = Book Title
   - `<h2>` = Major Division (Part / Seder / Parasha)
   - `<h3>` = Chapter / Siman / Daf
   - `<h4>` = Section / Seif / Mishnah / Amud
   - Plain lines / `<p>` = Content paragraphs (sequentially numbered `line_index` starting at 1).
4. **Links / Commentaries (Optional CSV/JSON in `raw_links/`):**
   - Maps `(source_book, source_line)` <-> `(target_book, target_line)`. Use normalized fuzzy title matching when linking books, and log any unmatched book names to the console during build.

### Hebrew Normalization & Reference Key Extraction
- **`normalizeHebrew(text)`** (used for both `clean_text` indexing and user search queries):
  - Strip Hebrew Niqqud and Cantillation marks (Unicode range `\u0591-\u05C7`).
  - Strip HTML tags, Gershayim (`"` / `״`), and Geresh (`'` / `׳`).
  - Normalize final letters (`ך->כ`, `ם->מ`, `ן->נ`, `ף->פ`, `ץ->צ`) consistently across index and query.
- **Book Shorthand & Aliases (`generateBookAliases(categoryPath, bookTitle)`):**
  - Auto-generate Hebrew acronyms and shorthand aliases for every book (e.g., `"שולחן ערוך"` + `"אורח חיים"` -> `"שוע אוח"`, `"שולחן ערוך אורח חיים"`, `"אוח"`; `"משנה תורה"` + `"הלכות שבת"` -> `"רמבם שבת"`), plus support an optional `raw_library/aliases.json` override map.
- **TOC Reference Keys (`extractRefKey(headingTitle)`):**
  - Strip structural prefixes (`סימן`, `סעיף`, `פרק`, `הלכה`, `משנה`, `דף`, `עמוד`) and punctuation so `"סימן כה"` -> `ref_key = "כה"`, `"סעיף ה"` -> `ref_key = "ה"`, and Talmudic Amud notation (`"דף ב עמוד א"` / `"ב."`) normalizes to `"ב א"` / `"ב."` and `"ב ב"` / `"ב:"`.

### SQLite Database Schema (`library.db`)
Run `VACUUM;` and `PRAGMA optimize;` at the end of `scripts/build-db.js` to minimize APK size.

CREATE TABLE categories (
  id INTEGER PRIMARY KEY,
  parent_id INTEGER REFERENCES categories(id),
  name TEXT NOT NULL,
  path TEXT UNIQUE NOT NULL
);

CREATE TABLE books (
  id INTEGER PRIMARY KEY,
  category_id INTEGER REFERENCES categories(id),
  title TEXT NOT NULL,
  aliases TEXT NOT NULL,
  file_path TEXT UNIQUE NOT NULL,
  total_lines INTEGER NOT NULL
);

CREATE TABLE toc_nodes (
  id INTEGER PRIMARY KEY,
  book_id INTEGER REFERENCES books(id),
  parent_id INTEGER REFERENCES toc_nodes(id),
  level INTEGER NOT NULL,
  title TEXT NOT NULL,
  ref_key TEXT NOT NULL,
  start_line INTEGER NOT NULL
);
CREATE INDEX idx_toc_book_parent_ref ON toc_nodes(book_id, parent_id, ref_key);

CREATE TABLE paragraphs (
  id INTEGER PRIMARY KEY,
  book_id INTEGER REFERENCES books(id),
  line_index INTEGER NOT NULL,
  toc_path TEXT,
  display_text TEXT NOT NULL,
  clean_text TEXT NOT NULL,
  is_heading INTEGER DEFAULT 0
);
CREATE INDEX idx_paragraphs_book_line ON paragraphs(book_id, line_index);

CREATE VIRTUAL TABLE paragraphs_fts USING fts5(
  clean_text,
  book_id UNINDEXED,
  category_path UNINDEXED,
  line_index UNINDEXED,
  content='paragraphs',
  content_rowid='id'
);

CREATE TABLE links (
  id INTEGER PRIMARY KEY,
  book_a_id INTEGER NOT NULL,
  line_a INTEGER NOT NULL,
  book_b_id INTEGER NOT NULL,
  line_b INTEGER NOT NULL,
  link_type TEXT
);
CREATE INDEX idx_links_a ON links(book_a_id, line_a);
CREATE INDEX idx_links_b ON links(book_b_id, line_b);

---

## 4. Core Features & UX Specifications

### A. Quick Source Reference Jump ("קפיצה מהירה למקור")
- Prominent input bar at the top of the Library screen allowing shorthand navigation such as `"שוע אוח כה ה"`, `"רמבם שבת א א"`, or `"ברכות ב."`.
- Normalize input (`normalizeHebrew`), preserving `.` and `:` for Talmudic Amud shorthand. Match the longest leading token sequence against `books.title` and `books.aliases`, traverse `toc_nodes` using `ref_key`, and display an instant clickable preview card jumping directly to `start_line` with a 2-second highlight.

### B. Library Browser (Tree View)
- Collapsible, indented RTL folder tree matching `categories` and `books`.

### C. Advanced Full-Text Search Engine (FTS5)
- **Query Sanitization:** Strip all FTS5 reserved syntax characters (`"`, `'`, `-`, `*`, `(`, `)`, `:`, `^`) after `normalizeHebrew()` so user punctuation never throws `fts5: syntax error`.
- **Facet Filtering:** Restrict search scope to Entire Library, specific Category/Folder (`category_path LIKE 'folder/%'`), or specific Book (`book_id = ?`).
- **Results View (KWIC):** Compact cards showing `Book Title + toc_path` and a highlighted snippet. Tapping opens the book in a tab, jumps to `line_index`, and highlights the target paragraph for 2 seconds.

### D. High-Speed Windowed Reader Screen
- **Windowed DB Loading (OOM Prevention):** Load a sliding window of ~400 lines around `currentLineIndex` (`WHERE line_index BETWEEN ? AND ?`) and seamlessly fetch adjacent chunks as the user scrolls.
- **Virtualized Rendering:** Use `FlashList` with dynamic `estimatedItemSize` calculated from the active font size.
- **BiDi Safety:** Prepend Unicode Right-to-Left Mark (`\u200F`) to paragraphs containing parentheses or numbers.
- **Breadcrumb Header & TOC Drawer:** Sticky auto-hiding breadcrumb header + slide-over hierarchical `toc_nodes` drawer.

### E. Multi-Tab Workspace (Tabs)
- Tab switcher allowing multiple open books and search sessions simultaneously, persisting `{ tabId, bookId, bookTitle, currentLineIndex, tocPath }` in local storage.

### F. Live Typography & Appearance Panel (`Aa` Bottom Sheet)
- Font Family (`Frank Ruhl Libre`, `David Libre`, `Assistant`, `Heebo`), Font Size & Line Height sliders, Themes (Light, Sepia, OLED Dark), and live Niqqud Toggle (`\u0591-\u05C7`).

### G. Parallel Commentaries & Links (Otzaria-Style)
- Subtle indicator badge on paragraphs with linked commentaries. Tapping opens a resizable bottom/split drawer grouped by commentator book synchronized to the active paragraph.

---

## 5. Phased Implementation Milestones (Build Order)
Execute one milestone per clean session:
1. **Milestone 1:** Expo TypeScript setup, `metro.config.js` (`assetExts: ['db']`), `app.json` (`noCompress: ["db"]`), `DB_VERSION` copy check, first-launch `forceRTL(true)` + `Updates.reloadAsync()`, `scripts/build-db.js` (`--source=sample` / `--source=full`), and Library screen with Quick Source Jump + RTL tree.
2. **Milestone 2:** Sliding-window reader (`FlashList`), BiDi `\u200F` safety, target-line highlight, TOC drawer, Multi-Tab manager, and `Aa` typography bottom sheet.
3. **Milestone 3:** Hebrew FTS5 search with syntax sanitization, Folder/Book scope modal, and KWIC highlighted results.
4. **Milestone 4:** Synchronized commentaries drawer (`links` table) and standalone Android APK build configuration.
5. **Milestone 5:** Lightweight APK (no bundled DB); dual `core_library.db` / `user_library.db` with a unified query router; GitHub Release download (manifest + `.gz`/`.zip`, SHA-256, atomic swap); on-device indexer for personal books and core rebuilds; "ניהול ספרייה ועדכונים" manager + first-launch onboarding; `build-db.js --release` artifacts.

---

## 6. Strict Coding Guardrails
- **Metro Bundler Asset Config:** Ensure `metro.config.js` includes `'db'` in `resolver.assetExts`.
- **No Full-Book State:** Query by `book_id` using sliding windows; never load massive books entirely into React state.
- **RTL Consistency:** Always use `paddingStart`/`paddingEnd` and `marginStart`/`marginEnd` instead of `Left`/`Right`.
- **Git & Large Library Separation:** Configure `.gitignore` to ignore `assets/db/*.db` and `raw_library/full/**` while keeping `raw_library/sample/` tracked in Git. Make `scripts/build-db.js` accept `--source=sample` vs `--source=full`.
