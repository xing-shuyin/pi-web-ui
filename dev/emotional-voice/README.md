# 大肥鱼 · 本机情绪语音

打字发消息，**在线 LLM API** 生成回复，本机只跑语音模型，用**带情绪的中文语音**念出来。不需要麦克风、不需要本地大语言模型。

技术栈：在线 API（OpenAI 兼容格式，默认 DeepSeek）→ 输出 `{emotion, text}` → 本机 CosyVoice2-0.5B instruct 模式 → 浏览器播放 WAV。

## 硬件要求与实测配置

开发机：Ryzen 9 7845HX / 31GB 内存 / RTX 4060 Laptop 8GB / Windows 11。

- **本机只有一个模型**：CosyVoice2-0.5B。LLM 完全在线，本机不加载。
- **默认 CPU 推理 + 短句队列**：回复按标点切成不超过 20 字的短句，一次只合成一句、合成完清缓存再排下一句，浏览器也逐句播放。这样显存峰值低，也不会再触发长文本 OOM。
- 实测 CPU 模式一句 20~60 字分 2~4 段，总共约 20~35 秒出声；在线 API 部分通常 1~3 秒。
- `tts.device` 可改成 `gpu`：本机实测显卡基线已被其它程序占到 7.6GB，短句仍会 2 分钟超时，**不建议开启**；关掉占显卡的程序后才值得试。

## 整机安全须知（重要）

8GB 显存的笔记本同时驻留两个模型时，Windows 会把显存溢到内存，可能直接卡死整机。**本项目把 LLM 完全挪到线上，本机只留 TTS**，从根上避开这个问题；另加三层保护：

1. **短句队列**：一次只合成一个 ≤20 字的片段，避免长文本把显存一次撑爆；
2. `set_per_process_memory_fraction(0.45)`：显存不够时报 OOM 而不是拖死系统；
3. 网页后端单飞行队列，任何时刻只跑一轮对话。

之前装的 Ollama 和本地 GGUF 模型可以不用了：`npm run setup` 已不再安装它们，可以在系统托盘退出 Ollama 释放后台进程。

## 使用

在仓库根目录执行：

```powershell
cd dev/emotional-voice
npm run setup     # 首次执行：装 uv/Python、下载 CosyVoice2 模型（约 2GB）
# 设置在线 API 密钥（密钥只留在服务端，不会发给浏览器）
$env:PI_VOICE_API_KEY = "你的密钥"
npm run start     # 启动服务
```

然后打开 <http://127.0.0.1:8787>。首次运行 `setup` 可能要 10~30 分钟，取决于网速；中途失败可以重复执行，已完成的步骤会跳过。

想临时验证整条链路又不想配密钥：把 `config.json` 里的 `llm.mock` 改成 `true`，会用一条固定回复代替在线 API。

界面里可以：

- 选「自动」让模型自己判断情绪，也可以手动指定「开心 / 傲娇 / 委屈 / 生气 / 惊讶 / 温柔 / 困倦 / 平静」。
- 输入框按 Enter 发送，Shift+Enter 换行。
- 语音合成失败时文字仍会显示，错误原因显示在聊天区。
- 「清空」按钮会清掉对话历史。

## 配置

改 `config.json` 后重启 `npm run start` 生效：

| 字段                   | 说明                                                     |
| ---------------------- | -------------------------------------------------------- |
| `persona`              | 大肥鱼的人设，直接改成你想要的性格                       |
| `emotions`             | 可选情绪列表，同时作为 LLM 的候选集                      |
| `llm.baseUrl`          | 在线 API 地址，默认 DeepSeek，任何 OpenAI 兼容服务都行   |
| `llm.model`            | 在线模型名，如 `deepseek-chat` / `gpt-4o-mini`           |
| `llm.apiKeyEnv`        | 存密钥的环境变量名，默认 `PI_VOICE_API_KEY`              |
| `llm.jsonMode`         | 是否要求 API 返回 JSON 对象；不支持的服务设 false        |
| `llm.mock`             | true = 不调 API，用固定回复测整条链路                    |
| `maxReplyChars`        | 回复字数上限，越短 TTS 越快、显存压力越小                |
| `tts.device`           | `cpu`（默认，不占显卡）/ `gpu`（本机实测会超时，不建议） |
| `tts.maxSegmentChars`  | 单次合成的最大字数，默认 20；调小更安全但段数更多        |
| `tts.gpuFraction`      | GPU 模式下 TTS 显存上限                                  |
| `tts.instructTemplate` | 情绪 → TTS 指令的模板，`{emotion}` 会被替换              |
| `tts.speed`            | 语速，1.0 为正常                                         |
| `port` / `ttsPort`     | 网页 / 语音服务端口                                      |

想换音色，替换 `.scratch/emotional-voice/prompt.wav`（16kHz 左右的单声道人声片段，几秒即可）。

## 文件落位

代码在 `dev/emotional-voice/`，运行时的虚拟环境、CosyVoice 源码、模型、参考音色全部在 `.scratch/emotional-voice/`（已被 gitignore）。不需要改动仓库其它文件。

## 常见问题

- **`winget` 找不到包 / 安装失败**：重开一个 PowerShell 再跑 `npm run setup`，PATH 才会刷新。
- **模型下载卡住**：`snapshot_download` 支持断点续传，直接重跑 `npm run setup`；也可手动用 huggingface 下载 `FunAudioLLM/CosyVoice2-0.5B` 到 `.scratch/emotional-voice/models/CosyVoice2-0.5B`。
- **在线 API 报错 401**：检查密钥环境变量；DeepSeek / OpenAI / 通义的 key 也分别认 `DEEPSEEK_API_KEY` / `OPENAI_API_KEY` / `DASHSCOPE_API_KEY`。
- **显存不够 / 机器卡过**：先把 `tts.maxSegmentChars` 降到 12，再不行把 `tts.device` 改成 `cpu`。
- **浏览器不自动播放声音**：点一下页面任意位置，或检查浏览器是否允许自动播放音频。
