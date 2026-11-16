[English](./README.en.md) · [简体中文](./README.md) · **繁體中文**

# 圖片文字識別 / Image OCR

在任意圖片預覽中點選“識別文字”。未安裝時同一個按鈕會安裝本外掛，安裝後再次點選即可識別。

- 預設識別簡體中文和英文，結果可選擇或一鍵複製。
- 無需 API Key；圖片在瀏覽器本地識別，不上傳到 OCR 服務。
- 首次使用需要從 jsDelivr 下載 Tesseract.js 6.0.1、WASM 與字型檔；字型檔緩存於瀏覽器。下載期間可取消。
- 遠端圖片需要服務端允許 CORS。讀取失敗時，可把圖片儲存為本地附件再識別。
- 字型很小、旋轉、手寫或低清圖片可能識別不準。
- 取消、關閉預覽、切換圖片或停用外掛會停止任務。沒有後臺輪詢或常駐識別引擎。

`view:false` / `preload:true`：客戶端頂層只註冊宿主 API v15 的 `imageOcrProviders`，點選才建立 Worker。圖片讀取沿用應用原始地址及同源身份驗證，不把應用憑據發給 CDN。

Image OCR recognizes Simplified Chinese and English in the shared image preview. The first click installs the plugin when needed. Recognition runs locally, requires no API key, and supports cancellation and copying. First use needs internet access for engine/language downloads. Remote images require CORS; attach them locally if access is blocked.
