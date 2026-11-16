import { createPluginI18n } from "@pi-web-ui/plugin-sdk/client";

/**
 * 运行轨迹（trace）面板的插件自有词典。
 * 语言解析 / 回退（当前 → 基语言 → en → key）与单遍插值由 SDK 的 createPluginI18n 统一实现，
 * 插件这边只维护 zh / en 两份文案；面板内的 EN / 中文 切换按钮通过 makeT(lang) 显式传语言。
 *
 * 不进词典的字符串（数据 / 开发者向）：
 * - `chipFor()` 里 `seg.kind` 的原始取值与工具名（`meta.tool`，接口数据）；
 * - 语言切换按钮上的 “EN / 中文” 目标语言自称（不是界面文案）；
 * - `index.mjs` 生成的时间线标签（`用户 · 第 N 轮`、`工具 · name`、`失败/完成`），属服务端产物。
 */
export const DICT = {
	zh: {
		// 头部与工具栏
		title: "运行轨迹",
		live: "实时",
		search: "搜索分段…",
		fit: "⤢ 适应",
		follow: "◎ 跟随",
		zoomHint: "滚轮缩放 · 拖拽平移 · 点击色块看分析",
		flowHint: "实时流动 · 刻度固定 · 拖拽暂停跟随",
		replay: "回放",
		exitReplay: "退出回放",
		play: "播放",
		pause: "暂停",
		speed: "速度",
		skipIdle: "跳过空闲",
		clear: "清空",
		confirmClear: "确定清空全部轨迹吗？（重拉当前对话恢复）",

		// 空态与提示
		empty: "暂无对话",
		emptyHint: "打开一个对话后，这里直接显示它的时间线与分析。",
		selectHint: "点击时间轴色块或左侧分段查看分析。",
		loading: "加载中…",
		noMatch: "没有匹配的分段（检查搜索/筛选）。",
		copy: "复制",
		copied: "已复制",

		// 泳道 / 页签 / 状态
		laneInput: "输入",
		laneModel: "模型",
		laneTools: "工具",
		tabOverview: "概述",
		tabPreview: "预览",
		tabRaw: "原始内容",
		tabSource: "来源",
		statusDone: "已完成",
		statusRunning: "执行中",
		statusError: "失败",

		// 分段色块与图例
		chipUser: "用户",
		chipThinking: "思考",
		chipText: "回答",
		chipFile: "文件",
		chipSystem: "系统",
		chipResult: "结果",

		// 分析字段
		fSource: "来源",
		fStatus: "状态",
		fDur: "时长",
		fTurn: "轮次",
		fLen: "长度",
		fPos: "位置",
		fTotal: "总时长",
		fTurns: "轮数",
		fSegs: "分段",
		fToolCalls: "工具调用",
		fToolErr: "工具失败",
		fToolTime: "工具耗时",
		fSlowest: "最慢工具",
		fFiles: "文件改动",
		fPhase: "阶段分布",
		fCalls: "累计调用",
		fAvg: "平均",
		fErrRate: "失败率",
		fShare: "耗时占比",
		fMsgKey: "消息",
		fToolCall: "调用",
		fConv: "对话",
		fTime: "时间",

		// 数值单位（{count} / {turn} 由调用方传入数字）
		unitFiles: "{count} 个",
		unitChars: "{count} 字",
		turnLabel: "第 {turn} 轮",
		turnOfTotal: "第 {turn} 轮 · 共 {total} 轮",
		callsWithErrors: "{calls}（{errLabel} {errs}）",
		callsWithErrorsRate: "{calls}（{errLabel} {errs}，{rateLabel} {rate}%）",
	},
	"zh-TW": {
		// 头部与工具栏
		title: "執行軌跡",
		live: "即時",
		search: "搜尋分段…",
		fit: "⤢ 適應",
		follow: "◎ 跟隨",
		zoomHint: "滾輪縮放 · 拖拽平移 · 點選色塊看分析",
		flowHint: "即時流動 · 刻度固定 · 拖拽暫停跟隨",
		replay: "回放",
		exitReplay: "退出回放",
		play: "播放",
		pause: "暫停",
		speed: "速度",
		skipIdle: "跳過空閒",
		clear: "清空",
		confirmClear: "確定清空全部軌跡嗎？（重拉當前對話恢復）",

		// 空态与提示
		empty: "暫無對話",
		emptyHint: "開啟一個對話後，這裡直接顯示它的時間線與分析。",
		selectHint: "點選時間軸色塊或左側分段檢視分析。",
		loading: "載入中…",
		noMatch: "沒有匹配的分段（檢查搜尋/篩選）。",
		copy: "複製",
		copied: "已複製",

		// 泳道 / 页签 / 状态
		laneInput: "輸入",
		laneModel: "模型",
		laneTools: "工具",
		tabOverview: "概述",
		tabPreview: "預覽",
		tabRaw: "原始內容",
		tabSource: "來源",
		statusDone: "已完成",
		statusRunning: "執行中",
		statusError: "失敗",

		// 分段色块与图例
		chipUser: "使用者",
		chipThinking: "思考",
		chipText: "回答",
		chipFile: "檔案",
		chipSystem: "系統",
		chipResult: "結果",

		// 分析字段
		fSource: "來源",
		fStatus: "狀態",
		fDur: "時長",
		fTurn: "輪次",
		fLen: "長度",
		fPos: "位置",
		fTotal: "總時長",
		fTurns: "輪數",
		fSegs: "分段",
		fToolCalls: "工具呼叫",
		fToolErr: "工具失敗",
		fToolTime: "工具耗時",
		fSlowest: "最慢工具",
		fFiles: "檔案改動",
		fPhase: "階段分佈",
		fCalls: "累計呼叫",
		fAvg: "平均",
		fErrRate: "失敗率",
		fShare: "耗時佔比",
		fMsgKey: "訊息",
		fToolCall: "呼叫",
		fConv: "對話",
		fTime: "時間",

		// 数值单位（{count} / {turn} 由调用方传入数字）
		unitFiles: "{count} 個",
		unitChars: "{count} 字",
		turnLabel: "第 {turn} 輪",
		turnOfTotal: "第 {turn} 輪 · 共 {total} 輪",
		callsWithErrors: "{calls}（{errLabel} {errs}）",
		callsWithErrorsRate: "{calls}（{errLabel} {errs}，{rateLabel} {rate}%）",
	},
	en: {
		// Header and toolbar
		title: "Run Trace",
		live: "live",
		search: "Search segments…",
		fit: "⤢ Fit",
		follow: "◎ Follow",
		zoomHint: "wheel zoom · drag pan · click a block for analysis",
		flowHint: "live flow · fixed ruler · drag pauses follow",
		replay: "Replay",
		exitReplay: "Exit replay",
		play: "Play",
		pause: "Pause",
		speed: "Speed",
		skipIdle: "skip idle",
		clear: "Clear",
		confirmClear: "Clear all traces? (re-pull restores the open conversation)",

		// Empty states and hints
		empty: "No conversation",
		emptyHint: "Open a conversation and its timeline + analysis show up here.",
		selectHint: "Click a ruler block or a left segment for analysis.",
		loading: "Loading…",
		noMatch: "No matching segments (check search/filters).",
		copy: "Copy",
		copied: "Copied",

		// Lanes / tabs / status
		laneInput: "Input",
		laneModel: "Model",
		laneTools: "Tools",
		tabOverview: "Overview",
		tabPreview: "Preview",
		tabRaw: "Raw",
		tabSource: "Source",
		statusDone: "Done",
		statusRunning: "Running",
		statusError: "Failed",

		// Segment chips and legend
		chipUser: "user",
		chipThinking: "think",
		chipText: "text",
		chipFile: "file",
		chipSystem: "sys",
		chipResult: "done",

		// Analysis fields
		fSource: "Source",
		fStatus: "Status",
		fDur: "Duration",
		fTurn: "Turn",
		fLen: "Length",
		fPos: "Position",
		fTotal: "Total",
		fTurns: "Turns",
		fSegs: "Segments",
		fToolCalls: "Tool calls",
		fToolErr: "Tool errors",
		fToolTime: "Tool time",
		fSlowest: "Slowest tools",
		fFiles: "Files changed",
		fPhase: "Phases",
		fCalls: "Calls",
		fAvg: "Avg",
		fErrRate: "Error rate",
		fShare: "Time share",
		fMsgKey: "Message",
		fToolCall: "Call",
		fConv: "Conversation",
		fTime: "Time",

		// Units ({count} / {turn} come from the caller)
		unitFiles: "{count} files",
		unitChars: "{count} chars",
		turnLabel: "turn {turn}",
		turnOfTotal: "turn {turn} of {total}",
		callsWithErrors: "{calls} ({errLabel} {errs})",
		callsWithErrorsRate: "{calls} ({errLabel} {errs}, {rateLabel} {rate}%)",
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
