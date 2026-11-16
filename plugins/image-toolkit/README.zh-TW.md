[English](./README.en.md) · [简体中文](./README.md) · **繁體中文**

# 圖片工作臺（image-toolkit）

🎨 一體化 **AI 生圖與影像處理工作臺**：把「文生圖 / 參考圖生圖 / 服務商配置」與「壓縮、裁剪、縮放、格式轉換、旋轉、批次匯出、水印、濾鏡」無縫合二為一。

- **頂欄檢視**：🎨 AI 生圖 與 🖼 圖片處理 雙模式即點即切；
- **無縫流轉**：
  - **生圖 → 處理**：生圖卡片與大圖燈箱一鍵「進入處理 / 編輯」，自動把生成結果載入處理佇列並激活畫布，即刻裁剪、調色、加水印或按目標體積壓縮；
  - **處理 → 生圖**：處理工作臺佇列項與動作區一鍵「用作生圖參考圖」，自動帶入生圖面板墊圖列表，輸入提示詞即可進行圖生圖 / 風格重繪；
- **AI 智慧體可直接配置服務商**：智慧體通過 `image_config_service` 工具可檢視預設、新增修改端點、自動抓取模型清單、探測連通性並安全存入金鑰；
- **升級支援當下主流生圖模型**：預置通義萬相 2.1、FLUX.1-schnell/dev、豆包 Seedream 4.0、智譜 CogView-4、Google Imagen 3、GPT-Image-1、Stability SD3.5 等；
- **給 AI 配備 8 個一體化工具**：生圖、配置、讀圖、取色截圖、幾何、壓縮、水印全覆蓋。

---

## 快速安裝

```bash
# 倉庫內直接使用或安裝到資料目錄
pi-web-ui install xing-shuyin/pi-web-ui/plugins/image-toolkit

# 或本地複製
cp -r plugins/image-toolkit "<dataDir>/plugins/image-toolkit"
```

---

## 8 個 AI 智慧體工具

| 工具                   | 領域 | 作用                                                                                                          |
| ---------------------- | ---- | ------------------------------------------------------------------------------------------------------------- |
| `image_services`       | 生圖 | 查詢已配置的生圖服務、預設模型、畫幅/畫質選項、金鑰狀態                                                       |
| `image_generate`       | 生圖 | 文生圖與圖生圖；產物寫入工作區，**可直接無縫餵給影像處理工具二次加工**                                        |
| `image_config_service` | 配置 | **AI 配置生圖供應商**：列出預設/配置、新增修改服務（金鑰進 secrets）、探測端點、拉取模型、設為預設、刪除配置  |
| `image_info`           | 處理 | 讀工作區圖片格式、畫素尺寸、體積、透明通道、EXIF、主色調與直方圖峰值                                          |
| `image_pick_color`     | 處理 | **精準取色與色板提取**：支援單點座標取色、多點批次取樣或區域/全圖色板自動提取，返回各顏色準星截圖與拼貼總覽圖 |
| `image_transform`      | 處理 | 縮放（等比/長邊/百分比）、裁剪、旋轉、翻轉、逐畫素調色濾鏡；**產物可作為 references 喂回生圖**                |
| `image_compress`       | 處理 | 格式轉換、質量調節、**`targetKB` 二分逼近目標體積**（必要時自動降尺寸）                                       |
| `image_watermark`      | 處理 | 疊加圖片水印（九宮格位置、縮放、透明度、平鋪間距）                                                            |

### 協同流轉閉環（Prompt Guidelines）

1. **生圖產物後處理**：`image_generate` 出圖後返回工作區相對路徑（預設 `generated/` 目錄），AI 可直接呼叫 `image_transform` 裁剪居中或調色，呼叫 `image_compress` 壓到指定 KB 大小，或呼叫 `image_watermark` 打標；
2. **處理產物圖生圖**：工作區已有素材或經過 `image_transform` 處理後的產物路徑，可直接傳給 `image_generate` 的 `references` 引數進行風格遷移與改圖；
3. **AI 全自動配置服務**：使用者在對話中提供 API Key 或端點需求（如“幫我配置矽基流動的 Flux 模型，Key 是 sk-xxx”），AI 可直接呼叫 `image_config_service` 完成配置並測通。

---

## 支援的主流生圖模型與協議形狀

| 服務商 / 模板 ID                          | 協議形狀          | 推薦與主流模型                                                                      | 端點與特點                                      |
| ----------------------------------------- | ----------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------- |
| **阿里百鍊通義萬相** (`dashscope`)        | `openai-images`   | `wanx2.1-t2i-turbo`, `wanx2.1-t2i-plus`, `wanx-v1`                                  | 相容 OpenAI 端點，萬相 2.1 極速版與高畫質版     |
| **矽基流動** (`siliconflow`)              | `openai-images`   | `black-forest-labs/FLUX.1-schnell`, `FLUX.1-dev`, `sd3.5-large`, `Kolors`           | 超高性價比，FLUX.1-schnell 極速高畫質           |
| **火山方舟豆包** (`ark`)                  | `openai-images`   | `doubao-seedream-4-0-t2i`, `doubao-seedream-3-0-t2i-250415`                         | 位元組即夢/豆包最新 Seedream 生圖系列           |
| **智譜 GLM** (`zhipu`)                    | `openai-images`   | `cogview-4`, `cogview-3-plus`                                                       | 智譜最新 CogView-4 高畫質文生圖                 |
| **Google AI Studio** (`google`)           | `gemini`          | `imagen-3.0-generate-002`, `imagen-3.0-fast-generate-001`, `gemini-2.5-flash-image` | 官方 Imagen 3 正式版，Gemini Nano Banana        |
| **OpenAI** (`openai`)                     | `openai-images`   | `gpt-image-1`, `dall-e-3`                                                           | 官方原生圖模型與 DALL-E 3                       |
| **Stability AI** (`stability`)            | `stability`       | `sd3.5-large`, `sd3.5-large-turbo`, `sd3.5-medium`, `core`, `ultra`                 | 官方 SD3.5 全系列                               |
| **OpenRouter** (`openrouter`)             | `openrouter-chat` | `black-forest-labs/flux.2-flex`, `recraft-ai/recraft-v3`, `gemini-2.5-flash-image`  | 多模型聚合，支援 Recraft 專業設計排版模型       |
| **本地 Antigravity 反代** (`antigravity`) | `openai-images`   | `gemini-3.1-flash-image`, `imagen-3.0-generate-002`                                 | 本地反代（8045），支援 indexed 多圖生圖         |
| **本地 ComfyUI** (`comfyui`)              | `comfyui`         | 本地 Checkpoint / LoRA / ControlNet                                                 | 支援 API 格式 workflow 模板與 `{{prompt}}` 插值 |

---

## AI 配置生圖服務（`image_config_service`）用法

AI 可以在無需使用者開啟設定表單的情況下配置、切換生圖環境：

### 1. 查詢預設與當前配置

```json
{
	"action": "list"
}
```

### 2. 新增或更新服務商（自動安全儲存金鑰）

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

### 3. 測試連通性與自動拉取模型

```json
{
	"action": "fetch_models",
	"id": "my-siliconflow",
	"saveModels": true
}
```

### 4. 設為預設或刪除服務

```json
{ "action": "set_default", "id": "my-siliconflow" }
{ "action": "delete", "id": "old-service" }
```

---

## AI 畫素取色與色板提取（`image_pick_color`）用法

支援三種取色模式，兼顧精準定位與整圖配色體系分析：

### 1. 單點精準取色（返回帶準星的區域性放大截圖）

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

### 2. 批次多點取樣（一次性取多個元件/邊框顏色並生成總覽拼貼）

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

### 3. 全圖 / 區域性區域自動色板分析（自動定位代表座標並附截圖）

```json
{
	"path": "app-theme.png",
	"region": { "x": 0, "y": 0, "width": 400, "height": 300 },
	"maxColors": 6
}
```

---

## 介面與無縫流轉體驗

1. **頂欄模式切換**：頂欄中央 `🎨 AI 生圖` / `🖼 圖片處理` 一鍵切換；
2. **生圖卡片一鍵流轉**：
   - 滑鼠懸停在任何生成結果卡片上，或在 Lightbox 大圖預覽彈窗中，點選 **`🖼 進入處理`**；
   - 圖片自動無損載入到處理佇列並激活畫布，直接進行裁剪、旋轉、濾鏡調色、縮放、水印疊加或目標體積二分壓縮；
3. **處理畫布一鍵流轉**：
   - 在左側佇列項或右側動作欄中，點選 **`🎨 用作生圖參考圖`**；
   - 自動獲取/儲存工作區路徑，切換至生圖檢視並填入參考圖列表（`references`），輸入提示詞即可圖生圖重繪；
4. **工作區素材庫互通**：在處理工作臺點選「從工作區匯入」時可快速瀏覽與挑選 `generated/` 目錄中的全部生圖歷史。

---

## 與「web-ui 內建生圖模型選擇器」的關係（issue #886）

issue #886 想要的是「模型選擇器裡出現 image 模型 → 提示詞直出圖 → 在對話裡內聯渲染 → 支援自定義 `/v1/images/generations` 端點」。這些能力**全部由本外掛提供**，而不是改核心會話鏈路：

| issue 訴求                                     | 本外掛對應能力                                                                        |
| ---------------------------------------------- | ------------------------------------------------------------------------------------- |
| image 模型出現在選擇器、單獨標記               | `image_services` 列出已配置服務 / 模型 / 預設值 + 頂欄「AI 生圖」檢視自帶模型下拉     |
| 提示詞（+可選參考圖）直接出圖                  | `image_generate`（文生圖 / 圖生圖，`references` 傳工作區圖片）                        |
| 結果在對話裡內聯渲染、可下載                   | `image_generate` 返回 image content block，客戶端直接內聯顯示；產物落在工作區可取可下 |
| 自定義 OpenAI 相容端點（本地 ComfyUI / vLLM…） | `openai-images` shape 可換任意 `baseUrl`；`comfyui` shape 直連本地工作流              |
| size / steps / seed / 張數引數                 | size / quality / n / seed 按 shape 能力表透傳，剩餘引數走「額外請求體」               |

預置裡 OpenRouter 已帶 FLUX.2 全系（`flux.2-pro` / `flux.2-flex` / `flux.2-klein`），模型清單也能一鍵從端點重新拉取，不必等核心發版。

## 測試套件

```bash
node tests/image-toolkit-core-test.mjs    # 純 JS 編解碼與圖形變換核心
node tests/image-toolkit-test.mjs         # 服務端介面、真服務端接線與客戶端純邏輯
npx vitest run tests/unit/image-          # 一體化合並單測與生圖模型單測全集
```
