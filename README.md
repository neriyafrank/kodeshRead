# kodeshRead

Offline-first Android Torah library (Expo + TypeScript) powered by
[Otzaria](https://github.com/Sivan22/otzaria) text files. The whole library is
pre-built into one SQLite database (`assets/db/library.db`, FTS5-indexed) that is
bundled inside the APK. See [`CLAUDE.md`](CLAUDE.md) for the full spec.

**Status:** Milestone 2. Done so far: project setup, the DB build pipeline, the
Library screen with Quick Source Jump and the RTL tree (M1), and the windowed
reader workspace (M2):

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

## Quick start

Requires **Node ≥ 22.13** (the DB build script uses the built-in `node:sqlite`).

```bash
npm install
npm run db:sample      # raw_library/sample -> assets/db/library.db
npm test               # pipeline + Quick Jump self-test
npm start              # Expo dev server (also auto-builds the DB if missing)
```

`npm run android` builds a native dev build (`expo run:android`, needs the Android SDK).
The app uses `expo-updates` for the first-launch RTL reload, so run it as a dev build
rather than in Expo Go. `npm run web` gives a quick browser preview of the UI.

## Library sources

| Folder | Tracked in git | Build command |
| --- | --- | --- |
| `raw_library/sample/` | yes | `npm run db:sample` |
| `raw_library/full/` | no (put the full Otzaria library here) | `npm run db:full` |

Layout: `raw_library/<source>/<Category>/<SubCategory>/<Book>.txt`. Headings use
`<h1>` (title) … `<h6>`; every other non-empty line is a paragraph. Optional:

* `raw_library/aliases.json`: extra shorthand per book, e.g. `{ "שולחן ערוך אורח חיים": ["שו\"ע או\"ח"] }`
* `<folder>/order.json`: explicit display order of that folder's entries (well-known
  Tanach/Shas/Shulchan Aruch orders are built in)
* `raw_links/`: commentary links. Either Otzaria's `<Book>_links.json`
  (`line_index_1`, `line_index_2`, `path_2`), or CSV/JSON with
  `source_book,source_line,target_book,target_line,link_type`. Unmatched book names are
  listed during the build.

Every build writes `assets/db/db-version.json`. When the bundled version differs from
the copy on the device, the app re-copies the DB on next launch.

## Quick Source Jump examples

`שבת ב.` · `שבת קנז ב` · `ר"ה טז:` · `מסכת ראש השנה ג` · `בראשית יב א` (verse) ·
`שוע אוח כה ה` · `רמבם שבת א א` (once those books are in the library)
