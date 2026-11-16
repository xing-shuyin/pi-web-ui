import { createPluginI18n } from "@pi-web-ui/plugin-sdk/client";

/**
 * SoL-Pi 状态面板的插件自有词典。
 * 语言解析 / 回退（当前 → 基语言 → en → key）与单遍插值由 SDK 的 createPluginI18n 统一实现，
 * 插件这边只维护 zh / en 两份文案，不再自己写 detectLang + 字符串拼接。
 */
export const DICT = {
	zh: {
		// 通用
		close: "关闭",
		unknownError: "未知错误",

		// 弹窗骨架
		panelTitle: "⚡ SoL-Pi 状态与配置管理",

		// 当前会话节省看板
		savingsTitle: "📊 当前会话节省看板",
		savingsScope: "仅限当前会话 · 跨会话隔离",
		statTotalSaved: "累计节省 Token",
		statPacked: "大输出打包截断",
		statPackedUnit: "次 ({bytes})",
		toolBreakdownItem: "{name}: {count} 次",
		toolBreakdownNone: "无",
		toolBreakdown: "• 工具打包明细: {list}",
		planProgress: "• 活动规划进度: {progress} {marker} {goal}",
		emptyTip:
			"💡 提示：当前会话尚未产生 &gt;10KB 的工具大输出（或处于前 2 轮观察期），未触发截断，节省量为 0。切换至其他会话将展示对应会话的独立节省数据。",

		// 运行与配置区块
		runtimeSection: "⚙️ SoL-Pi 运行与配置",
		installed: "扩展已安装",
		notInstalled: "未安装扩展",
		expandCollapse: "▶ 展开/收起",
		statusMissingPkg: "• 未检测到 SoL-Pi 扩展包 (NVlabs/SoL-Pi)。",
		statusConfigActive: "• 配置文件生效中: {path}",
		statusConfigMissing: "• 扩展已安装，但尚未配置 <code>sol-pi.json</code>，特性未激活。",

		// 预设
		presetsLabel: "快速预设:",
		presetWebui: "🛡️ WebUI 推荐",
		presetMax: "⚡ 极致节能 (全开)",
		presetLight: "📦 轻量省流",

		// 特性开关
		optObservationPackLabel: "📦 大工具输出打包 (observationPack)",
		optObservationPackDesc: "工具输出 >10KB 时替换为紧凑占位符，由 obs_recall 按需读取，有效减少上下文占用。",
		optOnlineCompactLabel: "🎯 在线规划与边界压缩 (onlineContextCompact)",
		optOnlineCompactDesc: "任务阶段完成时触发上下文压缩点。由扩展注册 update_plan 工具。",
		optOnlineCompactTip:
			"💡 提示：若当前主要使用 Web 界面内置的「任务计划看板 (Plan Mode)」，可取消勾选此项以避免工具提示词与 plan_update 冲突。",
		optActionFusionLabel: "⚡ 操作融合 (actionFusion)",
		optActionFusionDesc: "自动融合连续的只读/只写操作，替换原生 edit/write 工具（实验性）。",
		optEvidenceReducerLabel: "🛡️ 诊断证据保留 (evidencePreservingReducer)",
		optEvidenceReducerDesc: "在上下文压缩过程中尽可能保留关键诊断日志与执行证据痕迹（实验性）。",

		// 缓存读写比
		ratioLabel: "缓存读写比阈值 (cacheWriteReadRatio)",
		ratioDesc: "Prompt Cache 阈值因子（默认 12.5，0 为不惩罚写入）",

		// 证据缩减器辅模型
		advSummary: "⚙️ 证据缩减器专属辅模型路由 (可选)",
		advExpand: "▶ 展开配置",
		advDesc:
			"为 Evidence-Preserving Reducer 指定廉价极速的专用辅模型（如 gpt-4o-mini / deepseek-chat），避免占用高阶主模型。留空自动跟随主会话模型。",
		providerLabel: "服务商 (Provider):",
		providerPlaceholder: "例如 openai, deepseek",
		modelLabel: "模型 ID (Model):",
		modelPlaceholder: "例如 gpt-4o-mini",
		pickModel: "✨ 调起统一模型选择器点选...",
		jsonPreview: "🔍 查看即将生成的 sol-pi.json 配置预览",

		// 安装 / 写配置
		installBtn: "📦 一键安装 SoL-Pi 扩展",
		installConfirm:
			"确认安装 SoL-Pi 扩展？\n\n将从网络执行：pi install git:github.com/NVlabs/SoL-Pi\n（已有配置不会被覆盖）",
		installing: "⏳ 正在安装...",
		installDone: "✅ SoL-Pi 扩展安装成功！已同时自动写入推荐开启配置。",
		installFailed: "❌ 安装失败: {error}",
		enableBtn: "🚀 一键生成推荐配置",
		writingConfig: "⏳ 配置写入中...",
		writeDone: "✅ 已成功写入 sol-pi.json！",
		writeFailed: "❌ 写入配置失败: {error}",

		// 底部操作
		resetBtn: "↺ 恢复推荐",
		resetConfirm: "确认恢复为 SoL-Pi 默认推荐配置？",
		resetDone: "✅ 已重置为推荐配置",
		resetFailed: "❌ 重置失败: {error}",
		resetError: "❌ 重置异常: {error}",
		saveBtn: "💾 保存配置",
		saving: "⏳ 保存中...",
		saveDone: "✅ 配置已保存（新会话或重启生效）",
		serverRestart: "⚠️ 服务端待重启",
		serverRestartAlert:
			"⚠️ 当前后台 Node 服务尚未热加载新版保存路由。\n\n• 当前所勾选配置已同步写入本地 sol-pi.json（下次会话即可生效）；\n• 如需在界面中直接热保存，请在控制台按 Ctrl+C 重启一次 npm start 即可！",
		saveFailed: "❌ 保存配置失败: {error}",
		saveError: "❌ 保存异常: {error}",

		// 无数据兜底正文
		defaultContent: "⚡ SoL-Pi（当前会话）：当前会话暂未产生大输出打包或上下文规划数据。",
	},
	"zh-TW": {
		// 通用
		close: "關閉",
		unknownError: "未知錯誤",

		// 弹窗骨架
		panelTitle: "⚡ SoL-Pi 狀態與配置管理",

		// 当前会话节省看板
		savingsTitle: "📊 當前會話節省看板",
		savingsScope: "僅限當前會話 · 跨會話隔離",
		statTotalSaved: "累計節省 Token",
		statPacked: "大輸出打包截斷",
		statPackedUnit: "次 ({bytes})",
		toolBreakdownItem: "{name}: {count} 次",
		toolBreakdownNone: "無",
		toolBreakdown: "• 工具打包明細: {list}",
		planProgress: "• 活動規劃進度: {progress} {marker} {goal}",
		emptyTip:
			"💡 提示：當前會話尚未產生 &gt;10KB 的工具大輸出（或處於前 2 輪觀察期），未觸發截斷，節省量為 0。切換至其他會話將展示對應會話的獨立節省資料。",

		// 运行与配置区块
		runtimeSection: "⚙️ SoL-Pi 執行與配置",
		installed: "擴充套件已安裝",
		notInstalled: "未安裝擴充套件",
		expandCollapse: "▶ 展開/收起",
		statusMissingPkg: "• 未檢測到 SoL-Pi 擴充套件包 (NVlabs/SoL-Pi)。",
		statusConfigActive: "• 配置檔案生效中: {path}",
		statusConfigMissing: "• 擴充套件已安裝，但尚未配置 <code>sol-pi.json</code>，特性未啟用。",

		// 预设
		presetsLabel: "快速預設:",
		presetWebui: "🛡️ WebUI 推薦",
		presetMax: "⚡ 極致節能 (全開)",
		presetLight: "📦 輕量省流",

		// 特性开关
		optObservationPackLabel: "📦 大工具輸出打包 (observationPack)",
		optObservationPackDesc: "工具輸出 >10KB 時替換為緊湊佔位符，由 obs_recall 按需讀取，有效減少上下文佔用。",
		optOnlineCompactLabel: "🎯 線上規劃與邊界壓縮 (onlineContextCompact)",
		optOnlineCompactDesc: "任務階段完成時觸發上下文壓縮點。由擴充套件註冊 update_plan 工具。",
		optOnlineCompactTip:
			"💡 提示：若當前主要使用 Web 介面內建的「任務計劃看板 (Plan Mode)」，可取消勾選此項以避免工具提示詞與 plan_update 衝突。",
		optActionFusionLabel: "⚡ 操作融合 (actionFusion)",
		optActionFusionDesc: "自動融合連續的只讀/只寫操作，替換原生 edit/write 工具（實驗性）。",
		optEvidenceReducerLabel: "🛡️ 診斷證據保留 (evidencePreservingReducer)",
		optEvidenceReducerDesc: "在上下文壓縮過程中儘可能保留關鍵診斷日誌與執行證據痕跡（實驗性）。",

		// 缓存读写比
		ratioLabel: "快取讀寫比閾值 (cacheWriteReadRatio)",
		ratioDesc: "Prompt Cache 閾值因子（預設 12.5，0 為不懲罰寫入）",

		// 证据缩减器辅模型
		advSummary: "⚙️ 證據縮減器專屬輔模型路由 (可選)",
		advExpand: "▶ 展開配置",
		advDesc:
			"為 Evidence-Preserving Reducer 指定廉價極速的專用輔模型（如 gpt-4o-mini / deepseek-chat），避免佔用高階主模型。留空自動跟隨主會話模型。",
		providerLabel: "服務商 (Provider):",
		providerPlaceholder: "例如 openai, deepseek",
		modelLabel: "模型 ID (Model):",
		modelPlaceholder: "例如 gpt-4o-mini",
		pickModel: "✨ 調起統一模型選擇器點選...",
		jsonPreview: "🔍 檢視即將生成的 sol-pi.json 配置預覽",

		// 安装 / 写配置
		installBtn: "📦 一鍵安裝 SoL-Pi 擴充套件",
		installConfirm:
			"確認安裝 SoL-Pi 擴充套件？\n\n將從網路執行：pi install git:github.com/NVlabs/SoL-Pi\n（已有配置不會被覆蓋）",
		installing: "⏳ 正在安裝...",
		installDone: "✅ SoL-Pi 擴充套件安裝成功！已同時自動寫入推薦開啟配置。",
		installFailed: "❌ 安裝失敗: {error}",
		enableBtn: "🚀 一鍵生成推薦配置",
		writingConfig: "⏳ 配置寫入中...",
		writeDone: "✅ 已成功寫入 sol-pi.json！",
		writeFailed: "❌ 寫入配置失敗: {error}",

		// 底部操作
		resetBtn: "↺ 恢復推薦",
		resetConfirm: "確認恢復為 SoL-Pi 預設推薦配置？",
		resetDone: "✅ 已重置為推薦配置",
		resetFailed: "❌ 重置失敗: {error}",
		resetError: "❌ 重置異常: {error}",
		saveBtn: "💾 儲存配置",
		saving: "⏳ 儲存中...",
		saveDone: "✅ 配置已儲存（新會話或重啟生效）",
		serverRestart: "⚠️ 服務端待重啟",
		serverRestartAlert:
			"⚠️ 當前後臺 Node 服務尚未熱載入新版儲存路由。\n\n• 當前所勾選配置已同步寫入本地 sol-pi.json（下次會話即可生效）；\n• 如需在介面中直接熱儲存，請在控制台按 Ctrl+C 重啟一次 npm start 即可！",
		saveFailed: "❌ 儲存配置失敗: {error}",
		saveError: "❌ 儲存異常: {error}",

		// 无数据兜底正文
		defaultContent: "⚡ SoL-Pi（當前會話）：當前會話暫未產生大輸出打包或上下文規劃資料。",
	},
	en: {
		// Common
		close: "Close",
		unknownError: "unknown error",

		// Dialog shell
		panelTitle: "⚡ SoL-Pi status & configuration",

		// Current-session savings board
		savingsTitle: "📊 Current-session savings",
		savingsScope: "Current session only · isolated across sessions",
		statTotalSaved: "Tokens saved in total",
		statPacked: "Large-output packing truncations",
		statPackedUnit: "× ({bytes})",
		toolBreakdownItem: "{name}: {count}×",
		toolBreakdownNone: "none",
		toolBreakdown: "• Tool packing breakdown: {list}",
		planProgress: "• Active plan progress: {progress} {marker} {goal}",
		emptyTip:
			"💡 Tip: this session has not produced tool output over 10 KB yet (or it is still inside the first 2 observation rounds), so no truncation happened and savings are 0. Switch to another conversation to see that conversation's own savings.",

		// Runtime and config section
		runtimeSection: "⚙️ SoL-Pi runtime & configuration",
		installed: "Extension installed",
		notInstalled: "Extension not installed",
		expandCollapse: "▶ Expand/collapse",
		statusMissingPkg: "• SoL-Pi extension package (NVlabs/SoL-Pi) not detected.",
		statusConfigActive: "• Config file in effect: {path}",
		statusConfigMissing:
			"• Extension installed, but <code>sol-pi.json</code> is not configured yet; features are inactive.",

		// Presets
		presetsLabel: "Quick presets:",
		presetWebui: "🛡️ WebUI recommended",
		presetMax: "⚡ Maximum savings (all on)",
		presetLight: "📦 Light savings",

		// Feature toggles
		optObservationPackLabel: "📦 Large tool-output packing (observationPack)",
		optObservationPackDesc:
			"Tool output over 10 KB is replaced by a compact placeholder that obs_recall reads on demand, keeping context usage down.",
		optOnlineCompactLabel: "🎯 Online planning & context-edge compaction (onlineContextCompact)",
		optOnlineCompactDesc:
			"Triggers a context compaction point when a task phase completes. The extension registers the update_plan tool.",
		optOnlineCompactTip:
			"💡 Tip: if you mainly use the Web UI's built-in Plan Mode board, clear this option to avoid conflicting tool prompts with plan_update.",
		optActionFusionLabel: "⚡ Action fusion (actionFusion)",
		optActionFusionDesc:
			"Automatically fuses consecutive read-only/write-only actions and replaces the native edit/write tools (experimental).",
		optEvidenceReducerLabel: "🛡️ Preserve diagnostic evidence (evidencePreservingReducer)",
		optEvidenceReducerDesc:
			"Keeps key diagnostic logs and execution evidence traces during context compaction as far as possible (experimental).",

		// Cache write/read ratio
		ratioLabel: "Cache write/read ratio threshold (cacheWriteReadRatio)",
		ratioDesc: "Prompt Cache threshold factor (default 12.5; 0 means writes are not penalised)",

		// Evidence-reducer helper model
		advSummary: "⚙️ Dedicated helper-model route for the evidence reducer (optional)",
		advExpand: "▶ Expand config",
		advDesc:
			"Give the Evidence-Preserving Reducer a cheap, fast helper model (e.g. gpt-4o-mini / deepseek-chat) so it does not occupy the high-end main model. Leave empty to follow the main session model.",
		providerLabel: "Provider:",
		providerPlaceholder: "e.g. openai, deepseek",
		modelLabel: "Model ID:",
		modelPlaceholder: "e.g. gpt-4o-mini",
		pickModel: "✨ Pick from the unified model selector...",
		jsonPreview: "🔍 Preview the sol-pi.json that will be generated",

		// Install / write config
		installBtn: "📦 Install the SoL-Pi extension",
		installConfirm:
			"Install the SoL-Pi extension?\n\nThis runs over the network: pi install git:github.com/NVlabs/SoL-Pi\n(Existing config is not overwritten)",
		installing: "⏳ Installing...",
		installDone: "✅ SoL-Pi extension installed! The recommended settings were written automatically.",
		installFailed: "❌ Install failed: {error}",
		enableBtn: "🚀 Generate the recommended config",
		writingConfig: "⏳ Writing config...",
		writeDone: "✅ sol-pi.json written successfully!",
		writeFailed: "❌ Writing config failed: {error}",

		// Footer actions
		resetBtn: "↺ Restore recommended",
		resetConfirm: "Restore the default SoL-Pi recommended config?",
		resetDone: "✅ Restored the recommended config",
		resetFailed: "❌ Reset failed: {error}",
		resetError: "❌ Reset error: {error}",
		saveBtn: "💾 Save config",
		saving: "⏳ Saving...",
		saveDone: "✅ Config saved (takes effect in a new session or after a restart)",
		serverRestart: "⚠️ Server restart pending",
		serverRestartAlert:
			"⚠️ The background Node service has not hot-loaded the new save route yet.\n\n• The options you selected were still written to the local sol-pi.json (they apply in the next session);\n• To save directly from the UI, press Ctrl+C in the console and restart npm start once.",
		saveFailed: "❌ Saving config failed: {error}",
		saveError: "❌ Save error: {error}",

		// Fallback body when there is no data
		defaultContent: "⚡ SoL-Pi (current session): no large-output packing or plan data in this session yet.",
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
