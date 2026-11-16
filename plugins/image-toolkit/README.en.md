**English** · [简体中文](./README.md) · [繁體中文](./README.zh-TW.md)

# Image Toolkit (image-toolkit)

🎨 An all-in-one **AI image generation and image processing workbench**: fuses "text-to-image / reference-image-to-image / provider configuration" with "compression, cropping, scaling, format conversion, rotation, batch export, watermarking, filters" into one seamless surface.

- **Topbar views**: 🎨 AI Gen and 🖼 Image Edit, two modes one click apart;
- **Seamless hand-off**:
  - **Generation → processing**: one click on **Edit in Toolkit** — on a generation card or in the full-size lightbox — loads the result into the processing queue and activates the canvas, ready for cropping, color grading, watermarking, or compression to a target size;
  - **Processing → generation**: one click on **Use as Gen Reference** — on a queue item or in the action bar — carries the image into the generation panel's reference list; type a prompt and go straight to image-to-image / style repaint;
- **The AI agent configures providers itself**: via the `image_config_service` tool the agent lists presets, adds or edits endpoints, auto-fetches the model list, probes connectivity, and stores keys safely;
- **Ships today's mainstream image models**: presets for Tongyi Wanxiang 2.1, FLUX.1-schnell/dev, Doubao Seedream 4.0, Zhipu CogView-4, Google Imagen 3, GPT-Image-1, Stability SD3.5 and more;
- **8 integrated tools for the AI**: generation, configuration, image info, color picking with screenshots, geometry, compression, watermarking — full coverage.

---

## Quick install

```bash
# Use in-repo directly, or install into the data directory
pi-web-ui install xing-shuyin/pi-web-ui/plugins/image-toolkit

# Or copy it locally
cp -r plugins/image-toolkit "<dataDir>/plugins/image-toolkit"
```

---

## The 8 AI agent tools

| Tool                   | Domain     | Purpose                                                                                                                                                                                                                 |
| ---------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `image_services`       | generation | List configured image services, default model, aspect/quality options, key status                                                                                                                                       |
| `image_generate`       | generation | Text-to-image and image-to-image; artifacts are written to the workspace and **can feed straight into the processing tools for a second pass**                                                                          |
| `image_config_service` | config     | **AI-driven provider setup**: list presets/configs, add or edit services (keys go to secrets), probe endpoints, pull models, set default, delete                                                                        |
| `image_info`           | processing | Read workspace image format, pixel size, bytes, alpha channel, EXIF, dominant colors, histogram peaks                                                                                                                   |
| `image_pick_color`     | processing | **Precise color picking and palette extraction**: single-point coordinates, multi-point batch sampling, or automatic region/full-image palette, returning per-color crosshair screenshots plus a contact-sheet overview |
| `image_transform`      | processing | Scale (proportional / longest edge / percentage), crop, rotate, flip, per-pixel color filters; **artifacts can go back to generation as references**                                                                    |
| `image_compress`       | processing | Format conversion, quality tuning, **binary search toward a `targetKB` budget** (auto downscaling when needed)                                                                                                          |
| `image_watermark`      | processing | Overlay image watermarks (3×3 placement, scale, opacity, tiling gap)                                                                                                                                                    |

### The round-trip loop (Prompt Guidelines)

1. **Post-process generated artifacts**: `image_generate` returns workspace-relative paths (default `generated/`); the AI can call `image_transform` to crop centered or color grade, `image_compress` to hit a target KB size, or `image_watermark` to brand it;
2. **Generated from processed artifacts**: existing workspace assets or paths produced by `image_transform` can be passed straight into `image_generate`'s `references` parameter for style transfer and edits;
3. **Fully automatic service setup**: when the user supplies an API key or endpoint requirement in conversation (e.g. "set up SiliconFlow's Flux model for me, the key is sk-xxx"), the AI calls `image_config_service` to configure and verify it end to end.

---

## Supported mainstream image models and protocol shapes

| Provider / template ID                            | Protocol shape    | Recommended and mainstream models                                                   | Endpoints and characteristics                                                 |
| ------------------------------------------------- | ----------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| **Alibaba Bailian Tongyi Wanxiang** (`dashscope`) | `openai-images`   | `wanx2.1-t2i-turbo`, `wanx2.1-t2i-plus`, `wanx-v1`                                  | OpenAI-compatible endpoint, Wanxiang 2.1 turbo and high-quality tiers         |
| **SiliconFlow** (`siliconflow`)                   | `openai-images`   | `black-forest-labs/FLUX.1-schnell`, `FLUX.1-dev`, `sd3.5-large`, `Kolors`           | Excellent price/performance; FLUX.1-schnell is fast with high quality         |
| **Volcano Ark Doubao** (`ark`)                    | `openai-images`   | `doubao-seedream-4-0-t2i`, `doubao-seedream-3-0-t2i-250415`                         | ByteDance's latest Seedream generation line                                   |
| **Zhipu GLM** (`zhipu`)                           | `openai-images`   | `cogview-4`, `cogview-3-plus`                                                       | Zhipu's latest CogView-4 HD text-to-image                                     |
| **Google AI Studio** (`google`)                   | `gemini`          | `imagen-3.0-generate-002`, `imagen-3.0-fast-generate-001`, `gemini-2.5-flash-image` | Official Imagen 3 GA, Gemini Nano Banana                                      |
| **OpenAI** (`openai`)                             | `openai-images`   | `gpt-image-1`, `dall-e-3`                                                           | Official native image models plus DALL-E 3                                    |
| **Stability AI** (`stability`)                    | `stability`       | `sd3.5-large`, `sd3.5-large-turbo`, `sd3.5-medium`, `core`, `ultra`                 | The full official SD3.5 line                                                  |
| **OpenRouter** (`openrouter`)                     | `openrouter-chat` | `black-forest-labs/flux.2-flex`, `recraft-ai/recraft-v3`, `gemini-2.5-flash-image`  | Multi-model aggregator, including Recraft's professional design/layout models |
| **Local Antigravity proxy** (`antigravity`)       | `openai-images`   | `gemini-3.1-flash-image`, `imagen-3.0-generate-002`                                 | Local reverse proxy (8045), supports indexed multi-image generation           |
| **Local ComfyUI** (`comfyui`)                     | `comfyui`         | Local checkpoints / LoRA / ControlNet                                               | Supports API-format workflow templates and `{{prompt}}` interpolation         |

---

## Using AI to configure image services (`image_config_service`)

The AI can configure and switch image generation environments without the user opening the settings form:

### 1. List presets and current configuration

```json
{
	"action": "list"
}
```

### 2. Add or update a provider (keys stored securely)

```json
{
	"action": "upsert",
	"id": "my-siliconflow",
	"preset": "siliconflow",
	"apiKey": "sk-xxxxxxxxxxxxxxxx",
	"defaultModel": "black-forest-labs/FLUX.1-schnell",
	"setDefault": true
}
```

### 3. Test connectivity and auto-pull models

```json
{
	"action": "fetch_models",
	"id": "my-siliconflow",
	"saveModels": true
}
```

### 4. Set as default or delete a service

```json
{ "action": "set_default", "id": "my-siliconflow" }
{ "action": "delete", "id": "old-service" }
```

---

## Using AI pixel picking and palette extraction (`image_pick_color`)

Three picking modes, covering both precise targeting and whole-image palette analysis:

### 1. Single-point precise picking (returns a zoomed crop with a crosshair)

```json
{
	"path": "ui-screenshot.png",
	"x": 120,
	"y": 45,
	"zoom": 4,
	"cropSize": 32,
	"marker": true
}
```

### 2. Batch multi-point sampling (grab several component/border colors at once and build an overview contact sheet)

```json
{
	"path": "dashboard.png",
	"points": [
		{ "x": 30, "y": 40, "label": "sidebar_bg" },
		{ "x": 150, "y": 80, "label": "active_border" },
		{ "x": 260, "y": 80, "label": "tag_green" }
	]
}
```

### 3. Whole-image / region palette analysis (automatically locates representative coordinates and attaches screenshots)

```json
{
	"path": "app-theme.png",
	"region": { "x": 0, "y": 0, "width": 400, "height": 300 },
	"maxColors": 6
}
```

---

## UI and the seamless hand-off experience

1. **Topbar mode switch**: `🎨 AI Gen` / `🖼 Image Edit` in the topbar center, one click apart;
2. **One-click hand-off from generation cards**:
   - Hover any generation result card, or open the Lightbox preview, and click **`🖼 Edit in Toolkit`**;
   - The image loads losslessly into the processing queue and activates the canvas for cropping, rotating, filter grading, scaling, watermarking, or binary-search compression to a target size;
3. **One-click hand-off from the processing canvas**:
   - On a queue item at the left or in the action bar at the right, click **`🎨 Use as Gen Reference`**;
   - The workspace path is resolved/saved, the app switches to the generation view and fills the reference list (`references`) — type a prompt to regenerate with image-to-image;
4. **Shared workspace library**: clicking "From workspace" in the processing workbench lets you browse and pick from every past generation under `generated/`.

---

## Relationship to the built-in image model picker in web-ui (issue #886)

issue #886 asks for "image models show up in the model picker → a prompt renders an image directly → rendered inline in the conversation → custom `/v1/images/generations` endpoints supported". **All of that is provided by this plugin**, without touching the core conversation pipeline:

| issue requirement                                                | Capability in this plugin                                                                                                                 |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Image models appear in the picker, marked separately             | `image_services` lists configured services / models / defaults, plus the topbar "AI Gen" view has its own model dropdown                  |
| A prompt (+ optional reference images) renders an image directly | `image_generate` (text-to-image / image-to-image, with `references` passing workspace images)                                             |
| Results render inline in the conversation and are downloadable   | `image_generate` returns image content blocks that the client renders inline; artifacts land in the workspace, ready to fetch or download |
| Custom OpenAI-compatible endpoints (local ComfyUI / vLLM…)       | The `openai-images` shape accepts any `baseUrl`; the `comfyui` shape talks to local workflows directly                                    |
| size / steps / seed / count parameters                           | size / quality / n / seed pass through per the shape capability table; the rest go through the "extra request body"                       |

The OpenRouter preset already ships the full FLUX.2 line (`flux.2-pro` / `flux.2-flex` / `flux.2-klein`), and model lists can be re-pulled from the endpoint in one click — no need to wait for a core release.

## Test suite

```bash
node tests/image-toolkit-core-test.mjs    # pure-JS codec and graphics transform kernel
node tests/image-toolkit-test.mjs         # server API, real server wiring, and client pure logic
npx vitest run tests/unit/image-          # the full merged integration unit tests plus image model unit tests
```
