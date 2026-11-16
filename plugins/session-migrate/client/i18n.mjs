import { createPluginI18n } from "@pi-web-ui/plugin-sdk/client";

/**
 * 会话迁移面板的插件自有词典。
 * 语言解析 / 回退（当前 → 基语言 → en → key）与单遍插值由 SDK 的 createPluginI18n 统一实现，
 * 插件这边只维护 zh / en 两份文案，不再自己写 detectLang + 字符串拼接。
 */
export const DICT = {
	zh: {
		// 扫描 / 导入工具栏
		sourceAll: "全部来源",
		onlyKind: "仅 {kind}",
		scan: "🔍 扫描",
		importSelected: "📥 导入选中",
		cwdPlaceholder: "目标 cwd（可选重定向）",

		// 上传导入
		uploadImport: "⬆️ 上传导入",
		uploadHint: "导出过的 .jsonl / 其它机器的会话文件",

		// 扫描结果与导入回执
		scanning: "扫描中…",
		msgCount: "{n}条",
		export: "⬇ 导出",
		downloadStarted: "已开始下载：{name}.jsonl",
		selectSessionsFirst: "请先勾选要导入的会话。",
		importFinished: "导入完成：成功 {ok}，跳过 {skip}，失败 {failed}",
		refreshHintAfterImport: "导入后回到左栏「历史会话」刷新即可看到。",

		// 上传导入回执
		selectFileFirst: "请先选择要导入的 .jsonl 文件。",
		uploading: "上传中…（{size} KB）",
		sessionExists: "会话 {id} 已存在：{paths}",
		conflictPrompt: "该会话已存在于本机会话库，请选择处理方式。",
		overwrite: "覆盖原会话",
		saveCopy: "另存副本",
		cancel: "取消",
		cancelled: "已取消导入。",
		overwriting: "覆盖中…",
		savingCopy: "另存副本中…",
		importDone: "导入完成：",
		importFailed: "导入失败：",
		refreshHint: "回到左栏「历史会话」刷新即可看到。",
		importFailedReason: "导入失败：{error}",
		serverReturned: "服务端返回 {status}",
	},
	"zh-TW": {
		// 扫描 / 导入工具栏
		sourceAll: "全部來源",
		onlyKind: "僅 {kind}",
		scan: "🔍 掃描",
		importSelected: "📥 匯入選中",
		cwdPlaceholder: "目標 cwd（可選重定向）",

		// 上传导入
		uploadImport: "⬆️ 上傳匯入",
		uploadHint: "匯出過的 .jsonl / 其它機器的會話檔案",

		// 扫描结果与导入回执
		scanning: "掃描中…",
		msgCount: "{n}條",
		export: "⬇ 匯出",
		downloadStarted: "已開始下載：{name}.jsonl",
		selectSessionsFirst: "請先勾選要匯入的會話。",
		importFinished: "匯入完成：成功 {ok}，跳過 {skip}，失敗 {failed}",
		refreshHintAfterImport: "匯入後回到左欄「歷史會話」重新整理即可看到。",

		// 上传导入回执
		selectFileFirst: "請先選擇要匯入的 .jsonl 檔案。",
		uploading: "上傳中…（{size} KB）",
		sessionExists: "會話 {id} 已存在：{paths}",
		conflictPrompt: "該會話已存在於本機會話庫，請選擇處理方式。",
		overwrite: "覆蓋原會話",
		saveCopy: "另存副本",
		cancel: "取消",
		cancelled: "已取消匯入。",
		overwriting: "覆蓋中…",
		savingCopy: "另存副本中…",
		importDone: "匯入完成：",
		importFailed: "匯入失敗：",
		refreshHint: "回到左欄「歷史會話」重新整理即可看到。",
		importFailedReason: "匯入失敗：{error}",
		serverReturned: "服務端返回 {status}",
	},
	en: {
		// Scan / import toolbar
		sourceAll: "All sources",
		onlyKind: "{kind} only",
		scan: "🔍 Scan",
		importSelected: "📥 Import selected",
		cwdPlaceholder: "Target cwd (optional redirect)",

		// Upload import
		uploadImport: "⬆️ Upload and import",
		uploadHint: "A previously exported .jsonl / a session file from another machine",

		// Scan results and import receipts
		scanning: "Scanning…",
		msgCount: "{n} msgs",
		export: "⬇ Export",
		downloadStarted: "Download started: {name}.jsonl",
		selectSessionsFirst: "Select the sessions to import first.",
		importFinished: "Import finished: {ok} succeeded, {skip} skipped, {failed} failed",
		refreshHintAfterImport: "After importing, refresh the “History” list in the left panel to see them.",

		// Upload import receipts
		selectFileFirst: "Choose the .jsonl file to import first.",
		uploading: "Uploading… ({size} KB)",
		sessionExists: "Session {id} already exists: {paths}",
		conflictPrompt: "This session already exists in the local library; choose how to handle it.",
		overwrite: "Overwrite the session",
		saveCopy: "Save a copy",
		cancel: "Cancel",
		cancelled: "Import cancelled.",
		overwriting: "Overwriting…",
		savingCopy: "Saving a copy…",
		importDone: "Import finished:",
		importFailed: "Import failed:",
		refreshHint: "Refresh the “History” list in the left panel to see them.",
		importFailedReason: "Import failed: {error}",
		serverReturned: "Server returned {status}",
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
