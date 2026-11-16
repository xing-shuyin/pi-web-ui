[English](./streaming-stability.en.md) · [简体中文](./streaming-stability.md) · **繁體中文**

# 流式訊息穩定性約束

流式內容變化需要重新渲染；穩定性要求是已有內容不因身份交接而解除安裝、重置狀態或移動使用者閱讀位置。

## 身份貫穿三層

1. `MessageList` 將 stream ID 對映到正式訊息的穩定 render key。叢集外層同樣使用首訊息的穩定 key。不能僅穩定內層 Message 的 key：React key 只在同一父節點下有效。
2. 助手連續輸出保持相同 React 父級歸屬。普通模式中包含正文的叢集使用透明容器，不把正文放進密集工具外觀；flow 模式保留回合容器。訊息從空幀到思考、工具、正文、定稿時不遷移父節點。主題切換或會話切換不承諾保持相同節點。
3. `Message` 內部塊按塊位置標識，不使用會在定稿時變化的 message.id。`StreamMarkdown` 的凍結段與活動尾段使用同一種 Segment 元件和同一 keyed list，避免尾段凍結時改變元件型別。

塊位置規則依賴協議的內容塊追加順序。若未來允許在已有塊前插入、重排或刪除，必須引入穩定 block ID，不能繼續依賴索引。

同一個流式訊息的 pending 邊界不會被後續快照覆蓋。舊訊息定稿與新流開始可以分幀或同幀抵達，但不能讓下一條訊息繼承舊訊息的身份。

## 渲染與滾動

流式生成過的文本塊在定稿後保留 StreamMarkdown，不為了“最終校正”切回另一棵靜態 Markdown 樹。段落凍結立即使用最新文本，但保留 MarkdownBody。程式碼圍欄關閉後啟用完整語法高亮，允許高亮內部節點變化。

使用者向上滾動後，定稿不得重新吸底。瀏覽器測試通過實際 wheel 語義退出貼底，再檢查 scrollTop；僅指令碼設定 scrollTop 不能替代使用者滾動行為。

圖片、公式、外掛非同步載入可能有合理的尺寸變化，不能把它們的完成誤判為身份重建。本套測試不承諾任何內容變化都完全沒有佈局變化。

## 自動門禁

`npm test` 自動發現以下元件測試：

- `message-finalization-dom.test.ts`：真實 Message → StreamMarkdown → MarkdownBody，定稿保留正文節點。
- `stream-segment-identity.test.ts`：真實 Markdown，段落凍結保留 p/行內 code，長尾凍結不丟字，程式碼圍欄正常高亮。
- `message-list-identity.test.ts`：真實列表分支下檢查掛載生命週期與節點，覆蓋普通/flow、空幀→工具→正文、舊流定稿與新流交接。

`node tests/stream-stability-ui-test.mjs` 使用獨立 Vite 與 Chrome，不請求模型、不操作使用者瀏覽器。覆蓋真實 MessageList/Markdown、普通與 flow 佈局、段落凍結、正常/中止/錯誤定稿、思考轉正文，以及使用者閱讀位置。已登記到 `tests/run-smoke.mjs`，CI 冒煙執行；沒有 Chrome 時按倉庫慣例 SKIP。flow 測試開啟主題能力令牌，未載入完整自定義主題樣式。

測試夾具僅位於 tests/fixtures，不進入生產入口。斷言以 DOM identity、生命週期與滾動位置為主，不依賴截影像素或 React 渲染次數。
