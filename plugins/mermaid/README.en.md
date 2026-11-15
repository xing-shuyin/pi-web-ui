**English** · [简体中文](./README.md) · [繁體中文](./README.zh-TW.md)

# mermaid plugin (renderer plugin)

Renders ` ```mermaid ` fences in messages as SVG diagrams — the first implementation of the **fenced-code renderer plugin mechanism**.

## Installation (plugins are not in the npm package; shipped with the repo)

```bash
# install from GitHub (the plugins/mermaid subdirectory of the main repo; install natively supports subpaths)
pi-web-ui install xing-shuyin/pi-web-ui/plugins/mermaid

# or, with the repo cloned locally, copy the directory into the data directory
cp -r plugins/mermaid "<dataDir>/plugins/mermaid"
```

Refresh the page after installing; it appears under「界面插件」(UI plugins) in the top bar/settings panel. When not needed, `pi-web-ui uninstall mermaid` or delete the directory and ` ```mermaid ` falls back to a plain code block.

## Engine (local vendor first, CDN fallback)

- `client/vendor/mermaid.bundle.mjs` is the prebuilt self-contained engine (a build artifact, see
  `scripts/build-mermaid-vendor.mjs`) — **copied/installed along with the plugin directory, it renders fully offline**,
  with no network access; (it lives in the client/ subtree because the plugin's static service only exposes `/plugins/:id/client/*`)
- If the directory has no vendor (for instance you only copy manifest + entry.mjs to save size), the plugin automatically
  falls back to lazy-loading from the CDN (esm.sh). **The CDN is only a degradation path**: the address is pinned in `client/entry.mjs`
  to the exact version matching the vendor (`mermaid@12.0.0`) — a floating major version pulls a different-behaving
  engine and the rendering/theme API may drift; production and offline environments should always carry the vendor;
- When an offline environment needs mermaid, put `client/vendor/` into the plugin directory; no configuration change needed.

## How it works

- `manifest.json` declares `renderers: ["mermaid"]` + `view: false` (no standalone view tab).
- `client/entry.mjs` exports `renderers.mermaid(code, ctx) → HTMLElement | null`.
- The main app (`web/src/plugin-fence.ts`) keeps a "language → plugin" registry; on a
  ` ```mermaid ` fence, `Markdown.tsx` **lazy-loads** this plugin's bundle on demand and renders — ordinary chat never downloads anything.

## Disabling rendering

To drop diagram rendering, `pi-web-ui uninstall mermaid` or delete the plugin directory: when no plugin claims the
` `` ```mermaid `` ` fence, the main app always shows a plain code block, with no configuration switch needed.

## Writing your own renderer plugin

Follow this directory's layout: `manifest.json` declares `renderers:[...]`, `client/entry.mjs` exports
`{ renderers: { "<lang>": (code, ctx) => HTMLElement|null } }`. For details see
the "fenced-code renderer plugins" section of `docs/architecture-plugins.md`.
