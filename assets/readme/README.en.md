**English** · [简体中文](./README.md) · [繁體中文](./README.zh-TW.md)

# README recording assets

These assets were recorded from an existing build of pi-web-ui running from this repository, using a separate service, separate configuration and the Color Notes sample Git project. No existing user conversations, credentials or working directories were read, and no model was called. The official icons use assets bundled in the repository. The circular indicator visible in the recordings marks the real mouse position.

| File                   | Contents                                                                                                         | Size     | Duration     |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------- | -------- | ------------ |
| `hero.svg`             | Transparent-background cover for light pages                                                                     | 1200×360 | Static       |
| `hero-dark.svg`        | Transparent-background cover for dark pages                                                                      | 1200×360 | Static       |
| `workspace.gif`        | Previewing the sample README, viewing the real Git diff, running `node src/palette.mjs` in the built-in terminal | 1080×675 | About 11.5 s |
| `canvas.gif`           | Actually running a five-node local text flow, with two conversion branches merging into one output               | 1080×675 | About 8.7 s  |
| `showcase.mp4`         | The workspace and canvas sequences played back to back                                                           | 1440×900 | About 20.2 s |
| `workspace-poster.png` | A file-preview frame from the workspace recording                                                                | 1440×900 | Static       |
| `canvas-poster.png`    | A completed-flow frame from the canvas recording                                                                 | 1440×900 | Static       |

GIFs are 6 fps; the MP4 is H.264, 24 fps, no audio track. The interactions are edited and time-compressed and are not meant to gauge performance; the node outputs in the video come from deterministic local text transformations, not from AI inference. The recordings show the real UI edge to edge and bake no page background, decorative frame or title into the media, so they can be embedded on light or dark pages.

GIFs can be embedded directly in GitHub Markdown. The MP4 offers higher-fidelity playback/download; the project README uses a plain link and does not upload it to the GitHub attachment service.

The Chinese and English READMEs use `<picture>` with `prefers-color-scheme` to pick a light or dark cover, and a plain `<img>` falls back to `hero.svg`. Both SVGs have transparent backgrounds and depend on no custom CSS.

## Regenerating the recordings

Requires Node.js, FFmpeg and the original 6 fps PNG recordings. The recording directory must contain `workspace-frames/` and `canvas-frames/` with files numbered consecutively from `00000.png`:

```sh
node assets/readme/build-media.mjs <录制目录>
```

The generator builds the GIFs, still frames and MP4 straight from the raw frames and outputs them to this directory. Do not feed it composited frames carrying the old gradient backdrop.
