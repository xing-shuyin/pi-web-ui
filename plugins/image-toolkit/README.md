# 图片工作台（image-toolkit）

🎨 一体化 **AI 生图与图像处理工作台**：把「文生图 / 参考图生图 / 服务商配置」与「压缩、裁剪、缩放、格式转换、旋转、批量导出、水印、滤镜」无缝合二为一。

- **顶栏视图**：🎨 AI 生图 与 🖼 图片处理 双模式即点即切；
- **无缝流转**：
  - **生图 → 处理**：生图卡片与大图灯箱一键「进入处理 / 编辑」，自动把生成结果载入处理队列并激活画布，即刻裁剪、调色、加水印或按目标体积压缩；
  - **处理 → 生图**：处理工作台队列项与动作区一键「用作生图参考图」，自动带入生图面板垫图列表，输入提示词即可进行图生图 / 风格重绘；
- **AI 智能体可直接配置服务商**：智能体通过 `image_config_service` 工具可查看预设、添加修改端点、自动抓取模型清单、探测连通性并安全存入密钥；
- **升级支持当下主流生图模型**：预置通义万相 2.1、FLUX.1-schnell/dev、豆包 Seedream 4.0、智谱 CogView-4、Google Imagen 3、GPT-Image-1、Stability SD3.5 等；
- **给 AI 配备 8 个一体化工具**：生图、配置、读图、取色截图、几何、压缩、水印全覆盖。

---

## 快速安装

```bash
# 仓库内直接使用或安装到数据目录
pi-web-ui install xing-shuyin/pi-web-ui/plugins/image-toolkit

# 或本地复制
cp -r plugins/image-toolkit "<dataDir>/plugins/image-toolkit"
```

---

## 8 个 AI 智能体工具

| 工具                   | 领域 | 作用                                                                                                          |
| ---------------------- | ---- | ------------------------------------------------------------------------------------------------------------- |
| `image_services`       | 生图 | 查询已配置的生图服务、默认模型、画幅/画质选项、密钥状态                                                       |
| `image_generate`       | 生图 | 文生图与图生图；产物写入工作区，**可直接无缝喂给图像处理工具二次加工**                                        |
| `image_config_service` | 配置 | **AI 配置生图供应商**：列出预设/配置、添加修改服务（密钥进 secrets）、探测端点、拉取模型、设为默认、删除配置  |
| `image_info`           | 处理 | 读工作区图片格式、像素尺寸、体积、透明通道、EXIF、主色调与直方图峰值                                          |
| `image_pick_color`     | 处理 | **精准取色与色板提取**：支持单点坐标取色、多点批量采样或区域/全图色板自动提取，返回各颜色准星截图与拼贴总览图 |
| `image_transform`      | 处理 | 缩放（等比/长边/百分比）、裁剪、旋转、翻转、逐像素调色滤镜；**产物可作为 references 喂回生图**                |
| `image_compress`       | 处理 | 格式转换、质量调节、**`targetKB` 二分逼近目标体积**（必要时自动降尺寸）                                       |
| `image_watermark`      | 处理 | 叠加图片水印（九宫格位置、缩放、透明度、平铺间距）                                                            |

### 协同流转闭环（Prompt Guidelines）

1. **生图产物后处理**：`image_generate` 出图后返回工作区相对路径（默认 `generated/` 目录），AI 可直接调用 `image_transform` 裁剪居中或调色，调用 `image_compress` 压到指定 KB 大小，或调用 `image_watermark` 打标；
2. **处理产物图生图**：工作区已有素材或经过 `image_transform` 处理后的产物路径，可直接传给 `image_generate` 的 `references` 参数进行风格迁移与改图；
3. **AI 全自动配置服务**：用户在对话中提供 API Key 或端点需求（如“帮我配置硅基流动的 Flux 模型，Key 是 sk-xxx”），AI 可直接调用 `image_config_service` 完成配置并测通。

---

## 支持的主流生图模型与协议形状

| 服务商 / 模板 ID                          | 协议形状          | 推荐与主流模型                                                                      | 端点与特点                                      |
| ----------------------------------------- | ----------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------- |
| **阿里百炼通义万相** (`dashscope`)        | `openai-images`   | `wanx2.1-t2i-turbo`, `wanx2.1-t2i-plus`, `wanx-v1`                                  | 兼容 OpenAI 端点，万相 2.1 极速版与高画质版     |
| **硅基流动** (`siliconflow`)              | `openai-images`   | `black-forest-labs/FLUX.1-schnell`, `FLUX.1-dev`, `sd3.5-large`, `Kolors`           | 超高性价比，FLUX.1-schnell 极速高画质           |
| **火山方舟豆包** (`ark`)                  | `openai-images`   | `doubao-seedream-4-0-t2i`, `doubao-seedream-3-0-t2i-250415`                         | 字节即梦/豆包最新 Seedream 生图系列             |
| **智谱 GLM** (`zhipu`)                    | `openai-images`   | `cogview-4`, `cogview-3-plus`                                                       | 智谱最新 CogView-4 高清文生图                   |
| **Google AI Studio** (`google`)           | `gemini`          | `imagen-3.0-generate-002`, `imagen-3.0-fast-generate-001`, `gemini-2.5-flash-image` | 官方 Imagen 3 正式版，Gemini Nano Banana        |
| **OpenAI** (`openai`)                     | `openai-images`   | `gpt-image-1`, `dall-e-3`                                                           | 官方原生图模型与 DALL-E 3                       |
| **Stability AI** (`stability`)            | `stability`       | `sd3.5-large`, `sd3.5-large-turbo`, `sd3.5-medium`, `core`, `ultra`                 | 官方 SD3.5 全系列                               |
| **OpenRouter** (`openrouter`)             | `openrouter-chat` | `black-forest-labs/flux.2-flex`, `recraft-ai/recraft-v3`, `gemini-2.5-flash-image`  | 多模型聚合，支持 Recraft 专业设计排版模型       |
| **本地 Antigravity 反代** (`antigravity`) | `openai-images`   | `gemini-3.1-flash-image`, `imagen-3.0-generate-002`                                 | 本地反代（8045），支持 indexed 多图生图         |
| **本地 ComfyUI** (`comfyui`)              | `comfyui`         | 本地 Checkpoint / LoRA / ControlNet                                                 | 支持 API 格式 workflow 模板与 `{{prompt}}` 插值 |

---

## AI 配置生图服务（`image_config_service`）用法

AI 可以在无需用户打开设置表单的情况下配置、切换生图环境：

### 1. 查询预设与当前配置

```json
{
	"action": "list"
}
```

### 2. 添加或更新服务商（自动安全保存密钥）

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

### 3. 测试连通性与自动拉取模型

```json
{
	"action": "fetch_models",
	"id": "my-siliconflow",
	"saveModels": true
}
```

### 4. 设为默认或删除服务

```json
{ "action": "set_default", "id": "my-siliconflow" }
{ "action": "delete", "id": "old-service" }
```

---

## AI 像素取色与色板提取（`image_pick_color`）用法

支持三种取色模式，兼顾精准定位与整图配色体系分析：

### 1. 单点精准取色（返回带准星的局部放大截图）

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

### 2. 批量多点采样（一次性取多个组件/边框颜色并生成总览拼贴）

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

### 3. 全图 / 局部区域自动色板分析（自动定位代表坐标并附截图）

```json
{
	"path": "app-theme.png",
	"region": { "x": 0, "y": 0, "width": 400, "height": 300 },
	"maxColors": 6
}
```

---

## 界面与无缝流转体验

1. **顶栏模式切换**：顶栏中央 `🎨 AI 生图` / `🖼 图片处理` 一键切换；
2. **生图卡片一键流转**：
   - 鼠标悬停在任何生成结果卡片上，或在 Lightbox 大图预览弹窗中，点击 **`🖼 进入处理`**；
   - 图片自动无损载入到处理队列并激活画布，直接进行裁剪、旋转、滤镜调色、缩放、水印叠加或目标体积二分压缩；
3. **处理画布一键流转**：
   - 在左侧队列项或右侧动作栏中，点击 **`🎨 用作生图参考图`**；
   - 自动获取/保存工作区路径，切换至生图视图并填入参考图列表（`references`），输入提示词即可图生图重绘；
4. **工作区素材库互通**：在处理工作台点击「从工作区导入」时可快速浏览与挑选 `generated/` 目录中的全部生图历史。

---

## 与「web-ui 内置生图模型选择器」的关系（issue #886）

issue #886 想要的是「模型选择器里出现 image 模型 → 提示词直出图 → 在对话里内联渲染 → 支持自定义 `/v1/images/generations` 端点」。这些能力**全部由本插件提供**，而不是改核心会话链路：

| issue 诉求                                     | 本插件对应能力                                                                        |
| ---------------------------------------------- | ------------------------------------------------------------------------------------- |
| image 模型出现在选择器、单独标记               | `image_services` 列出已配置服务 / 模型 / 默认值 + 顶栏「AI 生图」视图自带模型下拉     |
| 提示词（+可选参考图）直接出图                  | `image_generate`（文生图 / 图生图，`references` 传工作区图片）                        |
| 结果在对话里内联渲染、可下载                   | `image_generate` 返回 image content block，客户端直接内联显示；产物落在工作区可取可下 |
| 自定义 OpenAI 兼容端点（本地 ComfyUI / vLLM…） | `openai-images` shape 可换任意 `baseUrl`；`comfyui` shape 直连本地工作流              |
| size / steps / seed / 张数参数                 | size / quality / n / seed 按 shape 能力表透传，剩余参数走「额外请求体」               |

预置里 OpenRouter 已带 FLUX.2 全系（`flux.2-pro` / `flux.2-flex` / `flux.2-klein`），模型清单也能一键从端点重新拉取，不必等核心发版。

## 测试套件

```bash
node tests/image-toolkit-core-test.mjs    # 纯 JS 编解码与图形变换内核
node tests/image-toolkit-test.mjs         # 服务端接口、真服务端接线与客户端纯逻辑
npx vitest run tests/unit/image-          # 一体化合并单测与生图模型单测全集
```
