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
