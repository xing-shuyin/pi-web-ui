**English** · [简体中文](./README.md) · [繁體中文](./README.zh-TW.md)

# Office preview and editing plugin

Univer-based Office canvas with structured AI operations. Supports `.xlsx`, `.docx`, `.pptx`, `.csv`, `.tsv`. Macro documents and legacy binary formats are neither opened nor written back; convert them to a supported format with Office or LibreOffice first.

## Usage and saving

Open a document from the workspace file tree. The runtime is downloaded on first use and reused from local assets afterwards. The plugin does not start the gateway on activation; it sleeps after 15 minutes idle, and never sleeps while an operation is running.

Local and remote pages both use a sandboxed canvas without same-origin privileges, forwarding document-scoped HTTP, XHR, and WebSocket over a MessageChannel and the authenticated plugin API. Browsers cannot reach the gateway directly; the gateway is confined to the current instance cache directory and rejects browser Origin, Fetch Metadata, and non-loopback Host. When the canvas fails to start, the plugin provides a structured read-only text preview and disables the edit and save buttons.

The first canvas start merges fixed runtime assets on the server (~62 MiB); later documents reuse the in-memory build cache. The runtime adaptation targets the current pinned version, and incompatible versions fail explicitly. Deployment must install the `esbuild` and `ws` dependencies declared in the plugin's package.json; missing dependencies produce an install hint instead of blocking the host install synchronously inside a request.

After editing the canvas, click save or press Ctrl/Cmd+S. The status bar shows saving, success, or an error. The runtime has no reliable modification-event protocol, so the plugin does not claim it can precisely show "unsaved changes"; save proactively before closing. Reloading discards the current canvas state and reads from disk, with a confirmation in the UI first.

Saving binds to the on-disk revision captured at first import. If another program modified or replaced the original file, it returns a conflict instead of overwriting external changes; you can save as a nonexistent file with the same extension, or reload. Save-as does not switch the current document path. Writes use an exclusive temp file in the same directory, fsync, and an atomic commit, preserving existing file permissions; new files are never overwritten. The revision check for existing files is optimistic concurrency control and cannot provide filesystem-level compare-and-swap guarantees against other processes.

Format import/export is limited by Univer's capabilities. Whether charts, comments, formulas, master slides, complex layout, and external references are preserved must be verified with real documents; there is no promise of full Microsoft Office parity or lossless round-tripping. Save important files as a copy first.

## Resources and lifecycle

- Each plugin instance uses its own temp cache; the document identifier is the SHA-256 of the full path.
- Server-side read, edit, and save of the same document run serially; in-canvas collaboration is still managed by the Univer gateway.
- Files and exports are capped at 64 MiB, each spreadsheet read covers at most 10,000 cells, and Worker output is capped at about 1 MB.
- At most 32 documents are retained; hitting the cap is an explicit error, and documents that may not be saved yet are never evicted automatically. Disabling the plugin frees the cache; reloading a document keeps its existing document slot.
- Downloads verify a pinned SHA-256; cancellation and plugin deactivation propagate to gateway requests and the Worker. The runtime is installed through the host asset pipeline.
- Canvas sessions use separate random tokens, at most 16, expiring after 10 minutes idle; per session at most 8 WebSockets and 32 concurrent requests, 6 MiB per upload and 16 MiB per response; per session cumulative upload 32 MiB, request bodies plus socket sends 64 MiB total, with bounds on queue and wait time.
- The iframe keeps `allow-scripts allow-downloads` and grants no same-origin privileges; CSP forbids direct network connections. Browser-side caching stays in memory only; persistence is performed by the host.
- `PI_WEB_OFFICE_IDLE_TIMEOUT_MS` adjusts the sleep timeout, minimum 60 seconds.

## Development verification

```sh
npx vitest run tests/unit/office-*.test.ts
node tests/office-canvas-test.mjs
```

Covers workspace and symlink boundaries, cache isolation, concurrent starts, repeated saves, external-modification conflicts, exclusive save-as, front-end destroy cancellation, polling boundaries, the message bridge, document transfer scope, and gateway browser-request interception.

Real Chrome has verified the sandboxed canvas without same-origin privileges, keyboard edits, collaborative commits, save-as XLSX followed by converting and re-reading the new document, zero external requests, and complete cleanup; screenshots and reports go to `.tmp-verify-data/` by default. Browser tests skip when Chrome or runtime assets are missing and consume no model tokens.

Real runtimes have verified XLSX edit-save and re-read after restart, DOCX/PPTX text import-export preservation, CSV/TSV edit export and delimiter escaping. Minimal sample documents passing does not mean visual fidelity for complex formats; charts, comments, formulas, master slides, and complex layout still need verification with real samples.
