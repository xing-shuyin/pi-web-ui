import { createPluginI18n } from "@pi-web-ui/plugin-sdk/client";

/**
 * 动态壁纸面板的插件自有词典。
 * 语言解析 / 回退（当前 → 基语言 → en → key）与单遍插值由 SDK 的 createPluginI18n 统一实现，
 * 插件这边只维护 zh / en 两份文案，不再自己写 detectLang + 字符串拼接。
 */
export const DICT = {
	zh: {
		// 抽屉头部
		libraryTitle: "🖼️ 壁纸库",
		libraryTitleTooltip: "Wallpaper Engine 壁纸库",
		settingsToggleTooltip: "折叠/展开外观与渲染配置",
		settingsToggle: "配置",
		rescanTooltip: "重新扫描壁纸",
		rescan: "刷新",
		closeLibraryTooltip: "关闭壁纸库",

		// 外观与渲染配置
		themeLabel: "专属主题:",
		themeObsidian: "🌑 黑曜冷月（纯黑极简微透）",
		themeFlow: "🖋️ 极简行文（极致紧凑·无界正文）",
		blurLabel: "毛玻璃模糊度:",
		opacityLabel: "界面不透明度:",
		rotateLabel: "自动轮播:",
		rotateOff: "关闭轮播",
		rotateEveryMinutes: "每 {n} 分钟",
		rotateEveryHour: "每 1 小时",
		fpsLabel: "帧率:",
		fpsUnlimited: "无限制",
		qualityLabel: "场景画质:",
		qualityPerformance: "⚡ 节能极速（核显推荐）",
		qualityBalanced: "⚖️ 平衡流畅（默认推荐）",
		qualityHigh: "🎨 高清细腻（独显）",
		qualityUltra: "🌟 极致视网膜",
		aaLabel: "抗锯齿:",
		aaOff: "关闭",
		aaFxaa: "FXAA 快速",
		allowInteractive: "允许交互",
		audioSpectrum: "音乐频谱 🎵",
		lightModeTooltip: "在纯白、日光或高光壁纸下启用微描边锐化与微偏光，保证白字清晰易读",
		lightMode: "☀️ 亮色增强",
		mute: "静音",
		closeWallpaper: "关闭壁纸",
		exportPreset: "📤 导出预设",
		importPreset: "📥 导入预设",
		rotateNowTooltip: "立即随机切换下一张壁纸",
		rotateNow: "🎲 切下一张",

		// 搜索与分类
		searchPlaceholder: "搜索壁纸名称或标签...",
		tabAll: "全部",
		tabFavorites: "⭐ 收藏",
		tabVideo: "视频",
		tabScene: "场景",
		tabWeb: "网页",
		tabImage: "静态图",
		modeTooltip: "点击切换分页浏览与全部显示模式",
		modePaged: "📑 分页模式",
		modeAll: "📜 全部显示",

		// 列表状态
		loadingWallpapers: "正在加载壁纸...",
		pageStats: "共 {n} 张",
		pageStatsAll: "共 {total} 张 · 已全部展示 (点击顶栏切回分页)",
		pageStatsPaged: "共 {total} 张 · 第 {cur}/{totalPages} 页",
		pagePrev: "◀ 上一页",
		pagePrevTooltip: "上一页",
		pageNext: "下一页 ▶",
		pageNextTooltip: "下一页",
		rescanning: "正在全盘重新扫描...",
		rescanFailed: "扫描失败：{error}",
		noSteam: "未检测到 Steam 或创意工坊壁纸",
		noSteamHint: "请确认已安装 Steam 并订阅了 Wallpaper Engine 壁纸，或在插件设置中指定自定义路径。",
		loadFailed: "加载失败：{error}",
		noMatch: "未找到匹配的壁纸",
		activeBadge: "✓ 使用中",
		addFavorite: "加入收藏",
		removeFavorite: "取消收藏",

		// 外观预设导入导出
		presetCopied: "外观预设已成功复制到剪贴板！",
		presetCopyManual: "请复制外观预设 JSON：",
		exportFailed: "导出失败：{error}",
		presetPaste: "请粘贴外观预设 JSON 内容：",
		presetImported: "外观预设导入成功！",
		importFailed: "导入失败：{error}",

		// 工具详情检查器
		inspectorTitle: "工具详情",
		inspectorDone: "已完成",
		toggleRawTooltip: "点击切换回原有代码块展示",
		toggleRaw: "⚙️ 原始参数",
		togglePreviewTooltip: "点击切换回富媒体文件展示",
		togglePreview: "🖼️ 文件展示",
		copyAll: "📋 复制全部",
		closeTooltip: "关闭 (ESC)",
		argsLabel: "⚡ 调用入参 / 命令 (Arguments)",
		imagesLabel: "🖼️ 工具输出图片 ({n})",
		outputLabel: "📄 执行输出 (Output)",
		errorLabel: "❌ 执行报错 (Error Output)",
		runningOutput: "正在执行中，等待实时输出...",
		successNoText: "(执行成功，无文本返回)",
		thinkingTitle: "思考过程 (Thinking)",
		thinkingLabel: "💭 思考链路与分析过程",
		thinkingEmpty: "(暂无思考文本)",
		statusWithDuration: "{status} · {duration}",
		copied: "✓ 已复制",
		downloadTooltip: "下载文件",
		download: "⬇️ 下载",
		copyPathTooltip: "复制相对路径",
		copyPath: "📋 路径",
		statusFailed: "执行出错",
		statusRunning: "运行中",
		statusDone: "已完成",
	},
	en: {
		// Drawer header
		libraryTitle: "🖼️ Wallpaper library",
		libraryTitleTooltip: "Wallpaper Engine library",
		settingsToggleTooltip: "Collapse / expand appearance and rendering settings",
		settingsToggle: "Settings",
		rescanTooltip: "Rescan wallpapers",
		rescan: "Refresh",
		closeLibraryTooltip: "Close the wallpaper library",

		// Appearance and rendering settings
		themeLabel: "Exclusive theme:",
		themeObsidian: "🌑 Obsidian Moon (pure black, minimal glass)",
		themeFlow: "🖋️ Pure Flow (compact, borderless body)",
		blurLabel: "Frosted-glass blur:",
		opacityLabel: "UI opacity:",
		rotateLabel: "Auto rotation:",
		rotateOff: "Rotation off",
		rotateEveryMinutes: "Every {n} min",
		rotateEveryHour: "Every hour",
		fpsLabel: "Frame rate:",
		fpsUnlimited: "Unlimited",
		qualityLabel: "Scene quality:",
		qualityPerformance: "⚡ Power saver (integrated GPU)",
		qualityBalanced: "⚖️ Balanced (recommended)",
		qualityHigh: "🎨 High detail (discrete GPU)",
		qualityUltra: "🌟 Ultra retina",
		aaLabel: "Anti-aliasing:",
		aaOff: "Off",
		aaFxaa: "FXAA fast",
		allowInteractive: "Allow interaction",
		audioSpectrum: "Audio spectrum 🎵",
		lightModeTooltip:
			"Adds a hairline outline and slight polarization on white, daylight, or bright wallpapers so white text stays crisp",
		lightMode: "☀️ Light boost",
		mute: "Mute",
		closeWallpaper: "Close wallpaper",
		exportPreset: "📤 Export preset",
		importPreset: "📥 Import preset",
		rotateNowTooltip: "Switch to the next wallpaper right away",
		rotateNow: "🎲 Next wallpaper",

		// Search and categories
		searchPlaceholder: "Search wallpaper names or tags…",
		tabAll: "All",
		tabFavorites: "⭐ Favorites",
		tabVideo: "Video",
		tabScene: "Scene",
		tabWeb: "Web",
		tabImage: "Image",
		modeTooltip: "Switch between paged browsing and showing everything",
		modePaged: "📑 Paged",
		modeAll: "📜 Show all",

		// List states
		loadingWallpapers: "Loading wallpapers…",
		pageStats: "{n} wallpapers",
		pageStatsAll: "{total} wallpapers · showing all (use the mode button to return to paging)",
		pageStatsPaged: "{total} wallpapers · page {cur}/{totalPages}",
		pagePrev: "◀ Prev",
		pagePrevTooltip: "Previous page",
		pageNext: "Next ▶",
		pageNextTooltip: "Next page",
		rescanning: "Rescanning everything…",
		rescanFailed: "Scan failed: {error}",
		noSteam: "No Steam or Workshop wallpapers detected",
		noSteamHint:
			"Make sure Steam is installed and you are subscribed to Wallpaper Engine wallpapers, or set a custom path in the plugin settings.",
		loadFailed: "Load failed: {error}",
		noMatch: "No matching wallpapers",
		activeBadge: "✓ In use",
		addFavorite: "Add to favorites",
		removeFavorite: "Remove from favorites",

		// Appearance preset import / export
		presetCopied: "Appearance preset copied to the clipboard.",
		presetCopyManual: "Copy the appearance preset JSON:",
		exportFailed: "Export failed: {error}",
		presetPaste: "Paste the appearance preset JSON:",
		presetImported: "Appearance preset imported.",
		importFailed: "Import failed: {error}",

		// Tool inspector
		inspectorTitle: "Tool details",
		inspectorDone: "Done",
		toggleRawTooltip: "Switch back to the code block view",
		toggleRaw: "⚙️ Raw arguments",
		togglePreviewTooltip: "Switch back to the rich file view",
		togglePreview: "🖼️ File view",
		copyAll: "📋 Copy all",
		closeTooltip: "Close (Esc)",
		argsLabel: "⚡ Arguments / command",
		imagesLabel: "🖼️ Tool output images ({n})",
		outputLabel: "📄 Output",
		errorLabel: "❌ Error output",
		runningOutput: "Running, waiting for live output…",
		successNoText: "(succeeded, no text output)",
		thinkingTitle: "Thinking",
		thinkingLabel: "💭 Reasoning chain and analysis",
		thinkingEmpty: "(no thinking text yet)",
		statusWithDuration: "{status} · {duration}",
		copied: "✓ Copied",
		downloadTooltip: "Download file",
		download: "⬇️ Download",
		copyPathTooltip: "Copy the relative path",
		copyPath: "📋 Path",
		statusFailed: "Failed",
		statusRunning: "Running",
		statusDone: "Done",
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
