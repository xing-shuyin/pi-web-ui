[English](./README.en.md) · [简体中文](./README.md) · **繁體中文**

# 多源通用語音合成外掛 (TTS)

將 **位元組豆包大模型語音** 與 **DeepSeek 語音** 註冊到系統統一 TTS 中心。網頁播報、QQ 自動語音回覆和其他工具共用引擎與音色目錄；內建 Chrome 伴侶擴充套件用於同步雙平臺憑據。

> 🛡️ **重要提示：關於 DeepSeek 防風控偽裝模型與賬號安全**：
>
> 1. **機制與風險分析**：DeepSeek 官方未開放獨立的純文本 TTS 合成 API。舊版外掛由於每次臨時新建會話且秒刪會話，並附帶指令碼特徵標頭，極易被官方反作弊風控判定並封號。
> 2. **v1.4.0 全面防風控改造措施**：
>    - **徹底偽裝真實 Chrome Headers**：移除了所有第三方指令碼特徵，對齊 Chrome 133 最新標準標頭與 `sec-ch-ua` 指紋；
>    - **專屬長期會話複用（Session Reuse）**：不再新建與秒刪會話，自動建立並長期複用一個專屬語音橋接會話，完全契合正常使用者的多輪對話行為；
>    - **自然多樣化 Prompt**：採用多變的人性化提問模板隨機輪換，避免單一文本聚類；
>    - **人性化防抖與排隊鎖**：限制呼叫間歇，防止高頻併發脈衝。
> 3. **使用建議**：
>    - 生產與大量長文本流式伴讀強烈推薦使用 **豆包語音**（支援火山引擎 API Key 商業通道，正規穩定且絕對免封）或**伺服器系統語音**；
>    - 若使用 DeepSeek 音色，改造後安全性已大幅提升，但鑑於其屬於逆向介面，仍建議配合不重要的測試小號使用。

---

## 統一 TTS 中心

引擎在外掛服務端通過 `host.tts.registerEngine()` 註冊，無需開啟外掛頁面。網頁「設定 → 聲音與語音」、本外掛試聽面板、QQ 語音設定都從中心讀取引擎與音色。`builtin` 系統引擎由宿主提供，外掛註冊 `doubao-tts` 與 `deepseek-tts`。

AI `tts` 工具支援 `action: "list"` 查詢全部引擎，帶 `engine` 查詢對應音色；合成時可選擇系統或其他外掛註冊的引擎。舊 `doubao` / `deepseek` 引數繼續可用。解除安裝外掛會撤銷引擎註冊並取消進行中的請求。介面與遷移說明見 [`docs/architecture-tts.md`](../../docs/architecture-tts.zh-TW.md)。

## 特性亮點

1. **雙平臺頂級語音聚合**：
   - **豆包大模型語音**：陽光阿辰/陽光青年、磁性俊宇、清爽男大、溫柔桃子、陽光甜妹等優質角色音色（支援網頁 Cookie 與火山引擎 API Key）；
   - **DeepSeek 官方語音**：白浪 Echo (明朗男聲)、暗潮 Tide (低沉男聲)、貝殼 Mira (活潑女聲)、海星 Stella (甜美女聲)。
2. **伴侶擴充套件雙向同步**：
   - 配套擴充套件同時支援 `doubao.com` 與 `chat.deepseek.com`，在任一網頁中點開擴充套件圖示，一鍵將當前登入態同步到本地。
3. **系統內建語音無縫切換**：
   - 在 **設定 -> 聲音與語音 -> 語音引擎** 下拉框中，可直接在「系統語音」、「豆包語音」、「DeepSeek 語音」以及其他已註冊引擎之間自由切換；
   - 訊息卡片右下角的小喇叭、後臺提示音、流式邊打字邊朗讀全部原生生效。
4. **流式分句播放佇列**：
   - 網頁按句播放生成的音訊；中心按引擎統一排隊，停止朗讀時取消生成並釋放音訊資源。
5. **AI 工具支援**：
   - 提供 `tts` 工具，AI 可查詢中心引擎、選擇音色並生成音訊檔案，副檔名根據引擎返回格式確定。

---

## 快速安裝與配置

### 1. 伴侶擴充套件載入（30秒完成）

1. Chrome / Edge 開啟 `chrome://extensions` 並開啟右上角「開發者模式」；
2. 在 pi-web-ui 左側選單進入「語音合成 (TTS)」面板，點選 **【📂 在電腦中定位擴充套件目錄】**；
3. 將彈出的 `extension` 資料夾直接拖進瀏覽器的擴充套件頁面中即可。

### 2. 同步憑據

- 在瀏覽器開啟 [doubao.com](https://www.doubao.com) 或 [chat.deepseek.com](https://chat.deepseek.com) 並登入；
- 點選瀏覽器右上角擴充套件欄的 🔊 圖示，點選 **【🚀 一鍵提取全部】** 即可同步。

---

## 支援音色列表

### 1. 豆包大模型音色 (Doubao)

- 陽光青年 / 陽光阿辰 (`yangguang`，經典朝氣男聲)
- 磁性俊宇 (`junyu`，暖心磁性男聲)
- 清爽男大 (`nanda`，活力少年男聲)
- 溫柔桃子 (`taozi`，溫暖對話女聲)
- 陽光甜妹 (`tianmei`，清新甜美女聲)
- 知性小棠 (`xiaotang`，知性穩重女聲)
- 北京大妞 (`shuangkuai`，爽快大方女聲)
- 冷酷霸總 (`bazong`，特色角色)
- 病嬌少爺 (`bingjiao`，特色角色)

### 2. DeepSeek 官方音色 (DeepSeek) ⚠️ 存在封號風控

> ⚠️ **警告**：DeepSeek 引擎高頻呼叫易被官方封禁網頁賬號，請使用測試小號或僅偶發試聽！

- 白浪 Echo (`echo`，明朗堅定男聲)
- 暗潮 Tide (`tide`，低沉渾厚男聲)
- 貝殼 Mira (`mira`，百變活潑女聲，可唱歌)
- 海星 Stella (`stella`，俏皮甜美女聲)

---

## 本地 HTTP 介面說明

- `POST /plugins-api/tts/sync-credentials`：接收並持久化豆包 Cookie 與 DeepSeek token。
- `POST /plugins-api/tts/speak`：相容入口，呼叫統一中心合成並返回 base64 音訊；`engine` 接受註冊 ID，也相容 `doubao` / `deepseek`。網頁統一入口為 `/api/tts/engines`、`/api/tts/voices` 和 `/api/tts/synthesize`。
- `POST /plugins-api/tts/open-folder`：定位擴充套件所在目錄。
- `GET /plugins-api/tts/download-extension`：下載擴充套件 ZIP 壓縮包。
