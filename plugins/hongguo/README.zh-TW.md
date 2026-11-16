[English](./README.en.md) · [简体中文](./README.md) · **繁體中文**

# hongguo

將 [frostming/dsh-hongguo](https://github.com/frostming/dsh-hongguo) v1.2.1 移植為 pi-web-ui 原生外掛，基於 [openhongguo](https://github.com/beilunyang/openhongguo) 提供劇名 / 演員搜尋、參演作品、選集、進度續播、自動連播和下一集預載入。

點選頂欄 **hongguo** 開啟播放器，選擇 **懸浮** 或 **分屏**。懸浮窗可拖動標題欄移動，四邊四角均可調整尺寸，精簡模式也可縮放並單獨記憶大小；分屏在桌面端左右排布，窄屏上下排布。播放中切換模式會保留同一個影片例項。搜尋框左側選擇「演員」可按姓名查詢參演作品；「預載下一集」預設開啟，會提前下載並轉碼一集供切集複用。另支援精簡播放檢視與瀏覽器畫中畫。

開發環境安裝：

```bash
node scripts/link-plugins.mjs hongguo
```

隨後在設定裡重新載入外掛。首次訪問自動安裝外掛獨立依賴。MP4 統一轉為 H.264 + AAC 相容格式，舊快取自動遷移，避免部分客戶端出現有聲音但黑屏。影片處理及 HEIC 封面需要 FFmpeg，可在外掛設定中填寫執行檔路徑。

完整安裝、介面、快取、許可權、第三方來源和驗收說明見 [hongguo 外掛文件](../../docs/plugin-hongguo.zh-TW.md)。
