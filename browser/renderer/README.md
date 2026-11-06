# Browser renderer

Vite root: `browser/renderer`, base: `./`. Entries: `shell.html`, `newtab.html`, `office.html`, `workspace.html`.

- The shell owns exactly two 44px rows. Its remaining surface stays transparent; browser/Agent content belongs to native WebContentsViews positioned by the desktop host below y=88.
- `common.ts` imports the shared `web/src/styles.css` baseline. `browser.css` defines prefixed browser structures using existing theme tokens.
- Preload may attach asynchronously. Calls and state subscriptions wait up to three seconds for `window.piBrowserShell`.
- `call(action,args)` returns data directly and rejects on failure. State is initialized with `state` and updated with `onState`.
- Shell dialogs acquire `overlay {open:true}` before display and release with `{open:false}`. Internal-page dialogs use the same signal, but the host keeps their sender visible.
- Window controls use `window.piDesktop.window`. Optional `onOpenOptions` and `onFocusAddress` bridge events support native menus/shortcuts while page views own focus.
- Additional host actions: `downloads.list`, `extensions.list`, `extensions.load`. Download entries accept `filename` and legacy `name`; opening a download sends `download.open {id}`.
- Bookmarks use folder/link arrays. All page titles, bookmark names, imported content and credentials are rendered through DOM properties; user HTML is never inserted.
- Settings expose search engine, link target, Agent URL, `aiControl`, `allowShot`, `allowEval`, secure credential management, unpacked extensions and legacy data import.
- File pages accept `?path=...` (and the legacy `?file=...`). Reads use `files.read {path}`; existing text files save with `files.save {path,content}`; new files use `{path:name,saveAs:true,content}`. The host grants paths through its native chooser.
- DOCX/XLSX/PPTX previews read real OOXML from bounded ZIP archives. They show document paragraphs, cached sheet values and ordered slide text. They do not preserve layout/images, evaluate formulas or execute macros, and cannot overwrite binary originals. Text/Markdown/CSV/TSV support editing. Large tables fall back to the text editor to preserve all data.
- Workspace previews raster images, audio, video and PDF from granted bytes in Blob URLs. HTML/SVG and other active content are shown only as text or rejected as unsupported.
- The old search popup is represented by the shell address bar; map the `search` internal alias to `newtab.html`.

Local checks (no global build):

```sh
npx tsc -p desktop/tsconfig.json --noEmit
node browser/renderer/verify-ui.mjs
```

`verify-ui.mjs` starts a temporary Vite server on 8994 and uses `playwright-core` with local Chrome/Edge. Set `BROWSER_EXECUTABLE` to use another Chromium executable. It checks delayed preload, fixed transparent chrome, navigation/modes, overlay lifecycle, bookmark escaping/mutation, settings, permissions, credential add/delete, extension loading, download opening, responsive newtab, CSV save and compressed OOXML fixtures. The host bridge is mocked; native Electron behavior is verified separately by the parent task.
