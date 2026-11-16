import { createPluginI18n } from "@pi-web-ui/plugin-sdk/client";

/**
 * Office 面板的插件自有词典。
 * 语言解析 / 回退（当前 → 基语言 → en → key）与单遍插值由 SDK 的 createPluginI18n 统一实现，
 * 插件这边只维护 zh / en 两份文案。
 *
 * 不进词典的字符串（数据 / 开发者向）：
 * - 文档格式名与扩展名（docx / xlsx / pptx / csv / tsv）、MIME 类型、`#canvas` 通道名等协议词汇；
 * - 文件名、工作区路径、`${n} B` 体积、`(Ctrl/⌘+S)` 之外的快捷键组合与 `Office` 产品名；
 * - `preview.mjs` 生成的只读预览骨架文案（`Sheet 1:` / `Slide 1:` / `Preview unavailable.` /
 *   `[Preview truncated]`）：那是纯英文预览数据格式，与 inspection 结构一一对应；
 * - 服务端返回的 error 文本、`AbortError` 的 name、注入 iframe 的 srcdoc 内容。
 */
export const DICT = {
	zh: {
		// 通用
		canceled: "已取消",
		invalidJson: "服务器返回了无效 JSON",
		requestFailed: "请求失败",
		invalidData: "服务器返回了无效数据",
		timeoutRetry: "请求超时，请重试；服务器操作可能仍在继续",
		retry: "重试",
		refresh: "刷新",

		// 文件视图工具栏
		reload: "重新加载",
		reloadDiscard: "重新加载（放弃当前编辑）",
		saveAs: "另存为",
		save: "保存 (Ctrl/⌘+S)",
		saving: "正在保存…",
		editingHint:
			"编辑后请手动保存。当前未接入查看器编辑事件，修改与同步状态尚未确认；保存结果仅表示服务器写盘结果。快捷键仅在此面板获得键盘事件时生效。",
		copyPathLabel: "工作区内的副本路径（已有文件可能被覆盖，请使用新路径）",
		saveCopy: "保存副本",
		cancel: "取消",

		// 打开与加载状态
		openFailed: "打开失败：{error}",
		previewLoading: "编辑器不可用，正在读取文档的只读文本预览…",
		previewAria: "Office 只读文本预览",
		previewNotice: "编辑器不可用：{error}。当前为只读文本预览，编辑和保存已禁用。",
		previewHint: "此预览展示服务器返回的有限文本内容，可能省略格式或数据。",
		previewFailed: "编辑器不可用：{error}；只读预览失败：{inspection}",
		canvasStarting: "正在启动安全画布编辑器…",
		canvasInvalid: "安全画布返回了无效数据",
		documentTitle: "Office 文档：{name}",
		canvasTimeout: "安全画布启动超时",
		canvasLoadFailed: "安全画布加载失败",
		docOpening: "正在启动运行时并打开文档…",

		// 运行时准备
		runtimeDownloading: "正在下载运行时组件…",
		runtimeTimeout: "运行时安装等待超时",
		runtimeInstalling: "正在安装运行时：{percent}%",
		progressRetry: "进度查询失败，正在重试 ({failures}/3)：{error}",
		checkingRuntime: "正在检查 Office 运行时…",
		runtimePrompt: "需要下载 Office 运行时组件（约 34MB）。",
		downloadAndOpen: "下载并打开",

		// 保存
		copyNeedsNewPath: "另存为需要使用不同的新文件路径。",
		savedCopy: "副本已保存：",
		savedToDisk: "已保存到磁盘：",
		conflictTail: "；原文件冲突仍需重新加载处理。",
		conflictSave: "保存冲突：{error}。请重新加载（放弃当前编辑），或另存为新文件以保留当前内容。",
		saveFailed: "保存失败：{error}",

		// 文档列表视图
		listTitle: "📑 Office",
		scanning: "正在扫描工作区中的 Office 文档…",
		listInvalid: "文档列表格式无效",
		listEmpty: "工作区暂无 Office 文档",
		listFailed: "加载列表失败：{error}",
	},
	"zh-TW": {
		// 通用
		canceled: "已取消",
		invalidJson: "伺服器返回了無效 JSON",
		requestFailed: "請求失敗",
		invalidData: "伺服器返回了無效資料",
		timeoutRetry: "請求超時，請重試；伺服器操作可能仍在繼續",
		retry: "重試",
		refresh: "重新整理",

		// 文件视图工具栏
		reload: "重新載入",
		reloadDiscard: "重新載入（放棄當前編輯）",
		saveAs: "另存為",
		save: "儲存 (Ctrl/⌘+S)",
		saving: "正在儲存…",
		editingHint:
			"編輯後請手動儲存。當前未接入檢視器編輯事件，修改與同步狀態尚未確認；儲存結果僅表示伺服器寫盤結果。快捷鍵僅在此面板獲得鍵盤事件時生效。",
		copyPathLabel: "工作區內的副本路徑（已有檔案可能被覆蓋，請使用新路徑）",
		saveCopy: "儲存副本",
		cancel: "取消",

		// 打开与加载状态
		openFailed: "開啟失敗：{error}",
		previewLoading: "編輯器不可用，正在讀取文件的只讀文本預覽…",
		previewAria: "Office 只讀文本預覽",
		previewNotice: "編輯器不可用：{error}。當前為只讀文本預覽，編輯和儲存已停用。",
		previewHint: "此預覽展示伺服器返回的有限文本內容，可能省略格式或資料。",
		previewFailed: "編輯器不可用：{error}；只讀預覽失敗：{inspection}",
		canvasStarting: "正在啟動安全畫布編輯器…",
		canvasInvalid: "安全畫布返回了無效資料",
		documentTitle: "Office 文件：{name}",
		canvasTimeout: "安全畫布啟動超時",
		canvasLoadFailed: "安全畫布載入失敗",
		docOpening: "正在啟動執行時並開啟文件…",

		// 运行时准备
		runtimeDownloading: "正在下載執行時元件…",
		runtimeTimeout: "執行時安裝等待超時",
		runtimeInstalling: "正在安裝執行時：{percent}%",
		progressRetry: "進度查詢失敗，正在重試 ({failures}/3)：{error}",
		checkingRuntime: "正在檢查 Office 執行時…",
		runtimePrompt: "需要下載 Office 執行時元件（約 34MB）。",
		downloadAndOpen: "下載並開啟",

		// 保存
		copyNeedsNewPath: "另存為需要使用不同的新檔案路徑。",
		savedCopy: "副本已儲存：",
		savedToDisk: "已儲存到磁碟：",
		conflictTail: "；原檔案衝突仍需重新載入處理。",
		conflictSave: "儲存衝突：{error}。請重新載入（放棄當前編輯），或另存為新檔案以保留當前內容。",
		saveFailed: "儲存失敗：{error}",

		// 文档列表视图
		listTitle: "📑 Office",
		scanning: "正在掃描工作區中的 Office 文件…",
		listInvalid: "文件列表格式無效",
		listEmpty: "工作區暫無 Office 文件",
		listFailed: "載入列表失敗：{error}",
	},
	en: {
		// Common
		canceled: "Canceled",
		invalidJson: "the server returned invalid JSON",
		requestFailed: "request failed",
		invalidData: "the server returned invalid data",
		timeoutRetry: "The request timed out; please retry — the server operation may still be running",
		retry: "Retry",
		refresh: "Refresh",

		// File view toolbar
		reload: "Reload",
		reloadDiscard: "Reload (discard current edits)",
		saveAs: "Save as",
		save: "Save (Ctrl/⌘+S)",
		saving: "Saving…",
		editingHint:
			"Save manually after editing. Viewer edit events are not wired up yet, so changes and sync state are unconfirmed; a successful save only means the server wrote the file. The shortcut works only when this panel has keyboard focus.",
		copyPathLabel: "Copy path inside the workspace (an existing file may be overwritten — use a new path)",
		saveCopy: "Save copy",
		cancel: "Cancel",

		// Opening and loading states
		openFailed: "Failed to open: {error}",
		previewLoading: "Editor unavailable; reading the document's read-only text preview…",
		previewAria: "Office read-only text preview",
		previewNotice: "Editor unavailable: {error}. Showing a read-only text preview; editing and saving are disabled.",
		previewHint: "This preview shows the limited text the server returned and may omit formatting or data.",
		previewFailed: "Editor unavailable: {error}; the read-only preview also failed: {inspection}",
		canvasStarting: "Starting the secure canvas editor…",
		canvasInvalid: "the secure canvas returned invalid data",
		documentTitle: "Office document: {name}",
		canvasTimeout: "Secure canvas startup timed out",
		canvasLoadFailed: "Secure canvas failed to load",
		docOpening: "Starting the runtime and opening the document…",

		// Runtime provisioning
		runtimeDownloading: "Downloading runtime components…",
		runtimeTimeout: "Timed out waiting for the runtime install",
		runtimeInstalling: "Installing the runtime: {percent}%",
		progressRetry: "Progress check failed, retrying ({failures}/3): {error}",
		checkingRuntime: "Checking the Office runtime…",
		runtimePrompt: "The Office runtime components (about 34 MB) must be downloaded.",
		downloadAndOpen: "Download and open",

		// Saving
		copyNeedsNewPath: "Save as needs a different new file path.",
		savedCopy: "Copy saved: ",
		savedToDisk: "Saved to disk: ",
		conflictTail: "; the original-file conflict still needs a reload.",
		conflictSave:
			"Save conflict: {error}. Reload (discarding current edits) or save as a new file to keep the content.",
		saveFailed: "Save failed: {error}",

		// Document list view
		listTitle: "📑 Office",
		scanning: "Scanning the workspace for Office documents…",
		listInvalid: "Invalid document list format",
		listEmpty: "No Office documents in the workspace",
		listFailed: "Failed to load the list: {error}",
	},
};

/** 当前界面语言（词典里存在的那一个）；解析与回退由 SDK 统一实现。 */
export function detectLang() {
	return createPluginI18n(DICT).locale;
}

/** 取文案函数；语言可以是字符串、undefined（跟随界面）或惰性 getter，每次调用时按当前语言解析。 */
export function makeT(lang) {
	return (key, params) => {
		const current = typeof lang === "function" ? lang() : lang;
		return createPluginI18n(DICT, { locale: current }).t(key, params);
	};
}
