import { createPluginI18n } from "@pi-web-ui/plugin-sdk/client";

/**
 * GitHub 工作台面板的插件自有词典。
 * 语言解析 / 回退（当前 → 基语言 → en → key）与单遍插值由 SDK 的 createPluginI18n 统一实现，
 * 插件这边只维护 zh / en 两份文案。
 *
 * 不进词典的字符串（数据 / 开发者向）：
 * - FILTERS / KINDS 的第一列（repository、review-requested、pr…）既是接口入参又是 `is:` 搜索词的取值；
 * - `buildReference()` 的 `PR #42` / `Issue #42` 会写进附件引用并持久化到草稿；
 * - 服务端 `index.mjs` 的校验错误与 `gh` CLI 错误文本（开发者向，由宿主原样展示）。
 */
export const DICT = {
	zh: {
		// 头部与连接状态
		appName: "GitHub 工作台",
		connecting: "正在连接…",
		refreshInbox: "刷新待办",
		filterFormLabel: "GitHub 待办筛选",
		repoLabel: "仓库",
		repoPlaceholder: "owner/repo · 留空查看个人待办",
		loadRepo: "加载仓库",
		filterLabel: "待办分类",
		expandSearch: "展开搜索条件",
		searchQuery: "搜索条件",
		searchPlaceholder: "搜索标题、label:bug…",
		search: "搜索",
		kindLabel: "待办类型",
		kindAll: "全部",
		kindPr: "PR",
		kindIssue: "Issue",
		inboxList: "待办列表",
		detailPane: "待办详情",
		loadingInbox: "正在加载待办",
		loadingInboxHint: "正在连接你的 GitHub 账号",
		selectItem: "选择一条待办",
		selectItemHint: "查看详情、参与讨论，或交给 AI 处理",

		// 待办分类（第一列是接口值，这里只翻译展示文案）
		filterRepository: "仓库待办",
		filterReviewRequested: "待我评审",
		filterAssigned: "分配给我",
		filterAuthored: "我创建的",
		filterMentioned: "提到我的",
		filterCustom: "自定义搜索",

		// 列表
		inbox: "待办",
		sortRecent: "最近更新",
		commentCountLabel: "{count} 条评论",
		emptyInbox: "暂时没有待办",
		emptyInboxHint: "换个分类，或试试其他搜索条件",
		prevPage: "上一页",
		nextPage: "下一页",
		pageSummary: "第 {page} 页 · {total} 条待办",
		loadingInboxQuick: "马上就好",

		// 状态
		stateMerged: "已合并",
		stateOpen: "进行中",
		stateClosed: "已关闭",

		// 详情
		backToList: "返回列表",
		detailUpdated: "{date} 更新",
		processWithAi: "交给 AI 处理",
		quoteToChat: "引用到对话",
		closeItem: "关闭",
		reopenItem: "重新打开",
		draftTag: "草稿",
		changedFiles: "{count} 个文件",
		mergeStatus: "合并状态 {state}",
		mergeComputing: "计算中",
		reviewStatus: "待评审 {reviewers}",
		noReviewers: "无指定评审人",
		prExternalHint: "完整 diff、CI 与代码行评审可在 GitHub 查看。",
		noBody: "（无正文）",
		discussion: "讨论",
		commentsTruncated: "仅显示最近一页评论，完整讨论可在 GitHub 查看。",
		noComments: "还没有评论，来开启讨论。",
		postComment: "发表评论",
		commentPlaceholder: "分享你的想法，支持 Markdown",
		commentTarget: "发布到 #{number}",
		publishComment: "发布评论",

		// 加载、操作与提示
		searchIncomplete: "搜索结果不完整，可缩小条件后重试。",
		loadingDetail: "正在加载详情",
		loadingDetailHint: "获取正文与最近讨论",
		detailFailed: "详情加载失败",
		detailFailedHint: "返回列表后点击条目重试",
		requestFailed: "请求失败 ({status})",
		accountHint: "使用服务所在机器的 GitHub CLI 登录",
		notConnected: "尚未连接 GitHub",
		connectTitle: "连接你的 GitHub",
		connectInstall: "在运行服务的机器安装 GitHub CLI，然后在终端执行：",
		connectDone: "完成后点击右上角刷新，即可查看 PR 与 Issue。",
		publishingComment: "正在发布评论…",
		updatingState: "正在更新状态…",
		mutationUncertain: "；操作结果不确定时请刷新确认后再重试。",
		stateUpdated: "状态已更新",
		commentPublished: "评论已发布",
		noComposer: "当前没有可用的对话输入框，请先打开一个对话。",
		quoted: "已引用到当前对话，可继续填写处理要求。",
		commentEmpty: "请输入评论内容。",
		finishingPrevious: "正在完成上一次操作…",
	},
	"zh-TW": {
		// 头部与连接状态
		appName: "GitHub 工作臺",
		connecting: "正在連線…",
		refreshInbox: "重新整理待辦",
		filterFormLabel: "GitHub 待辦篩選",
		repoLabel: "倉庫",
		repoPlaceholder: "owner/repo · 留空檢視個人待辦",
		loadRepo: "載入倉庫",
		filterLabel: "待辦分類",
		expandSearch: "展開搜尋條件",
		searchQuery: "搜尋條件",
		searchPlaceholder: "搜尋標題、label:bug…",
		search: "搜尋",
		kindLabel: "待辦型別",
		kindAll: "全部",
		kindPr: "PR",
		kindIssue: "Issue",
		inboxList: "待辦列表",
		detailPane: "待辦詳情",
		loadingInbox: "正在載入待辦",
		loadingInboxHint: "正在連線你的 GitHub 賬號",
		selectItem: "選擇一條待辦",
		selectItemHint: "檢視詳情、參與討論，或交給 AI 處理",

		// 待办分类（第一列是接口值，这里只翻译展示文案）
		filterRepository: "倉庫待辦",
		filterReviewRequested: "待我評審",
		filterAssigned: "分配給我",
		filterAuthored: "我建立的",
		filterMentioned: "提到我的",
		filterCustom: "自定義搜尋",

		// 列表
		inbox: "待辦",
		sortRecent: "最近更新",
		commentCountLabel: "{count} 條評論",
		emptyInbox: "暫時沒有待辦",
		emptyInboxHint: "換個分類，或試試其他搜尋條件",
		prevPage: "上一頁",
		nextPage: "下一頁",
		pageSummary: "第 {page} 頁 · {total} 條待辦",
		loadingInboxQuick: "馬上就好",

		// 状态
		stateMerged: "已合併",
		stateOpen: "進行中",
		stateClosed: "已關閉",

		// 详情
		backToList: "返回列表",
		detailUpdated: "{date} 更新",
		processWithAi: "交給 AI 處理",
		quoteToChat: "引用到對話",
		closeItem: "關閉",
		reopenItem: "重新開啟",
		draftTag: "草稿",
		changedFiles: "{count} 個檔案",
		mergeStatus: "合併狀態 {state}",
		mergeComputing: "計算中",
		reviewStatus: "待評審 {reviewers}",
		noReviewers: "無指定評審人",
		prExternalHint: "完整 diff、CI 與程式碼行評審可在 GitHub 檢視。",
		noBody: "（無正文）",
		discussion: "討論",
		commentsTruncated: "僅顯示最近一頁評論，完整討論可在 GitHub 檢視。",
		noComments: "還沒有評論，來開啟討論。",
		postComment: "發表評論",
		commentPlaceholder: "分享你的想法，支援 Markdown",
		commentTarget: "釋出到 #{number}",
		publishComment: "釋出評論",

		// 加载、操作与提示
		searchIncomplete: "搜尋結果不完整，可縮小條件後重試。",
		loadingDetail: "正在載入詳情",
		loadingDetailHint: "獲取正文與最近討論",
		detailFailed: "詳情載入失敗",
		detailFailedHint: "返回列表後點擊條目重試",
		requestFailed: "請求失敗 ({status})",
		accountHint: "使用服務所在機器的 GitHub CLI 登入",
		notConnected: "尚未連線 GitHub",
		connectTitle: "連線你的 GitHub",
		connectInstall: "在執行服務的機器安裝 GitHub CLI，然後在終端執行：",
		connectDone: "完成後點選右上角重新整理，即可檢視 PR 與 Issue。",
		publishingComment: "正在釋出評論…",
		updatingState: "正在更新狀態…",
		mutationUncertain: "；操作結果不確定時請重新整理確認後再重試。",
		stateUpdated: "狀態已更新",
		commentPublished: "評論已釋出",
		noComposer: "當前沒有可用的對話輸入框，請先開啟一個對話。",
		quoted: "已引用到當前對話，可繼續填寫處理要求。",
		commentEmpty: "請輸入評論內容。",
		finishingPrevious: "正在完成上一次操作…",
	},
	en: {
		// Header and connection status
		appName: "GitHub Workbench",
		connecting: "Connecting…",
		refreshInbox: "Refresh inbox",
		filterFormLabel: "GitHub inbox filters",
		repoLabel: "Repository",
		repoPlaceholder: "owner/repo · leave empty to see your inbox",
		loadRepo: "Load repository",
		filterLabel: "Inbox category",
		expandSearch: "Show search filters",
		searchQuery: "Search query",
		searchPlaceholder: "Search titles, label:bug…",
		search: "Search",
		kindLabel: "Item type",
		kindAll: "All",
		kindPr: "PR",
		kindIssue: "Issue",
		inboxList: "Inbox list",
		detailPane: "Item details",
		loadingInbox: "Loading inbox",
		loadingInboxHint: "Connecting to your GitHub account",
		selectItem: "Select an item",
		selectItemHint: "View details, join the discussion, or hand it to AI",

		// Inbox categories (the first column is the API value; only the label is translated)
		filterRepository: "Repository inbox",
		filterReviewRequested: "Review requested",
		filterAssigned: "Assigned to me",
		filterAuthored: "Created by me",
		filterMentioned: "Mentions",
		filterCustom: "Custom search",

		// List
		inbox: "Inbox",
		sortRecent: "Recently updated",
		commentCountLabel: "{count} comments",
		emptyInbox: "No inbox items",
		emptyInboxHint: "Try another category or a different search",
		prevPage: "Previous page",
		nextPage: "Next page",
		pageSummary: "Page {page} · {total} items",
		loadingInboxQuick: "Almost there",

		// State
		stateMerged: "Merged",
		stateOpen: "Open",
		stateClosed: "Closed",

		// Details
		backToList: "Back to list",
		detailUpdated: "updated {date}",
		processWithAi: "Hand to AI",
		quoteToChat: "Quote in chat",
		closeItem: "Close",
		reopenItem: "Reopen",
		draftTag: "Draft",
		changedFiles: "{count} files",
		mergeStatus: "Merge status {state}",
		mergeComputing: "computing",
		reviewStatus: "Reviewers {reviewers}",
		noReviewers: "none assigned",
		prExternalHint: "See the full diff, CI checks and line-by-line review on GitHub.",
		noBody: "(no description)",
		discussion: "Discussion",
		commentsTruncated: "Only the latest page of comments is shown; see the full discussion on GitHub.",
		noComments: "No comments yet — start the discussion.",
		postComment: "Post a comment",
		commentPlaceholder: "Share your thoughts; Markdown supported",
		commentTarget: "Posting to #{number}",
		publishComment: "Post comment",

		// Loading, actions and notices
		searchIncomplete: "The search results are incomplete; narrow the filters and try again.",
		loadingDetail: "Loading details",
		loadingDetailHint: "Fetching the description and recent discussion",
		detailFailed: "Could not load the details",
		detailFailedHint: "Back to list and click the item to retry",
		requestFailed: "Request failed ({status})",
		accountHint: "Uses the GitHub CLI login on the machine running the service",
		notConnected: "GitHub not connected",
		connectTitle: "Connect your GitHub",
		connectInstall: "Install the GitHub CLI on the machine running the service, then run this in a terminal:",
		connectDone: "Then click refresh in the top right to browse pull requests and issues.",
		publishingComment: "Publishing comment…",
		updatingState: "Updating state…",
		mutationUncertain: "; if the outcome is unclear, refresh and try again.",
		stateUpdated: "State updated",
		commentPublished: "Comment published",
		noComposer: "No chat composer is available; open a conversation first.",
		quoted: "Quoted in the current conversation; add your instructions to continue.",
		commentEmpty: "Enter a comment first.",
		finishingPrevious: "Finishing the previous action…",
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
