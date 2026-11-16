import { createPluginI18n } from "@pi-web-ui/plugin-sdk/client";

/**
 * 短剧播放器的插件自有词典。
 * 语言解析 / 回退（当前 → 基语言 → en → key）与单遍插值由 SDK 的 createPluginI18n 统一实现，
 * 插件这边只维护 zh / en 两份文案，不再自己写 detectLang + 字符串拼接。
 */
export const DICT = {
	zh: {
		// 通用 / 播放器外壳
		serviceUnavailable: "短剧服务暂时不可用",
		playerAria: "hongguo 播放器",
		brandName: "红果",
		brandTagline: "短剧放映室",
		layoutGroup: "播放布局",
		modeFloat: "悬浮",
		modeSplit: "分屏",
		sideFullscreen: "侧边全屏",
		compactPlayer: "精简播放器",
		closeAndPause: "关闭并暂停",
		videoAria: "短剧视频",
		resizeEdge: "拖动边缘调整大小",
		retry: "重试",
		backToLibrary: "返回剧场",
		backToActors: "返回演员搜索",
		loading: "正在加载…",
		loadingBusy: "加载中…",
		loadMore: "加载更多",

		// 播放 / 画中画
		buffering: "正在缓冲…",
		videoLoadFailed: "视频加载失败，请重试或检查网络与 FFmpeg。",
		preparingVideo: "正在准备视频…",
		noSource: "没有可用的视频线路",
		pressPlay: "点击视频播放按钮开始观看",
		pipUnsupported: "当前浏览器不支持画中画，请使用悬浮模式",
		pipAfterLoad: "视频加载后再尝试画中画",
		systemPip: "系统画中画",
		vendorLoadFailed: "播放器组件加载失败",
		ffmpegHint: "部分视频需要 FFmpeg，可在插件设置中配置路径",

		// 控制条
		prevEpisode: "上一集",
		nextEpisode: "下一集",
		playbackSpeed: "播放速度",
		quality: "清晰度",
		autoNext: "自动连播",
		preloadNext: "预载下一集",
		nextReady: "下一集已就绪",
		preparingNext: "准备下一集…",
		episodeNumber: "第 {n} 集",
		episodeCount: "{n} 集",
		episodeBadge: "{n}集",
		resumeEpisode: "续播第 {n} 集",

		// 剧场 / 搜索
		searchActorPlaceholder: "搜索演员姓名",
		searchDramaPlaceholder: "搜索剧名或关键词",
		searchActorAria: "搜索演员",
		searchDramaAria: "搜索短剧",
		searchType: "搜索类型",
		typeDrama: "剧名",
		typeActor: "演员",
		search: "搜索",
		tabDiscover: "推荐剧场",
		tabHistory: "观看记录",
		tabNowPlaying: "正在播放",
		viewWorks: "查看参演作品",
		chooseEpisode: "点击选集",
		actorWorks: "{name}的作品",

		// 空态
		loadingEpisodes: "正在加载剧集…",
		noEpisodes: "暂时没有剧集",
		emptyHistory: "看过的短剧会出现在这里",
		emptyActorWorks: "暂无公开参演作品",
		emptyActorNotFound: "没有找到演员，试试完整姓名",
		emptyActorPrompt: "输入演员姓名，查看参演短剧",
		emptyDramas: "没有找到短剧，试试其他关键词",
	},
	"zh-TW": {
		// 通用 / 播放器外壳
		serviceUnavailable: "短劇服務暫時不可用",
		playerAria: "hongguo 播放器",
		brandName: "紅果",
		brandTagline: "短劇放映室",
		layoutGroup: "播放佈局",
		modeFloat: "懸浮",
		modeSplit: "分屏",
		sideFullscreen: "側邊全屏",
		compactPlayer: "精簡播放器",
		closeAndPause: "關閉並暫停",
		videoAria: "短劇影片",
		resizeEdge: "拖動邊緣調整大小",
		retry: "重試",
		backToLibrary: "返回劇場",
		backToActors: "返回演員搜尋",
		loading: "正在載入…",
		loadingBusy: "載入中…",
		loadMore: "載入更多",

		// 播放 / 画中画
		buffering: "正在緩衝…",
		videoLoadFailed: "影片載入失敗，請重試或檢查網路與 FFmpeg。",
		preparingVideo: "正在準備影片…",
		noSource: "沒有可用的影片線路",
		pressPlay: "點選影片播放按鈕開始觀看",
		pipUnsupported: "當前瀏覽器不支援畫中畫，請使用懸浮模式",
		pipAfterLoad: "影片載入後再嘗試畫中畫",
		systemPip: "系統畫中畫",
		vendorLoadFailed: "播放器元件載入失敗",
		ffmpegHint: "部分影片需要 FFmpeg，可在外掛設定中配置路徑",

		// 控制条
		prevEpisode: "上一集",
		nextEpisode: "下一集",
		playbackSpeed: "播放速度",
		quality: "清晰度",
		autoNext: "自動連播",
		preloadNext: "預載下一集",
		nextReady: "下一集已就緒",
		preparingNext: "準備下一集…",
		episodeNumber: "第 {n} 集",
		episodeCount: "{n} 集",
		episodeBadge: "{n}集",
		resumeEpisode: "續播第 {n} 集",

		// 剧场 / 搜索
		searchActorPlaceholder: "搜尋演員姓名",
		searchDramaPlaceholder: "搜尋劇名或關鍵詞",
		searchActorAria: "搜尋演員",
		searchDramaAria: "搜尋短劇",
		searchType: "搜尋型別",
		typeDrama: "劇名",
		typeActor: "演員",
		search: "搜尋",
		tabDiscover: "推薦劇場",
		tabHistory: "觀看記錄",
		tabNowPlaying: "正在播放",
		viewWorks: "檢視參演作品",
		chooseEpisode: "點選選集",
		actorWorks: "{name}的作品",

		// 空态
		loadingEpisodes: "正在載入劇集…",
		noEpisodes: "暫時沒有劇集",
		emptyHistory: "看過的短劇會出現在這裡",
		emptyActorWorks: "暫無公開參演作品",
		emptyActorNotFound: "沒有找到演員，試試完整姓名",
		emptyActorPrompt: "輸入演員姓名，檢視參演短劇",
		emptyDramas: "沒有找到短劇，試試其他關鍵詞",
	},
	en: {
		// Common / player shell
		serviceUnavailable: "Drama service unavailable",
		playerAria: "hongguo player",
		brandName: "Drama",
		brandTagline: "HONGGUO",
		layoutGroup: "Player layout",
		modeFloat: "Float",
		modeSplit: "Split",
		sideFullscreen: "Side fullscreen",
		compactPlayer: "Compact player",
		closeAndPause: "Close and pause",
		videoAria: "Drama video",
		resizeEdge: "Drag an edge to resize",
		retry: "Retry",
		backToLibrary: "Back to library",
		backToActors: "Back to actors",
		loading: "Loading…",
		loadingBusy: "Loading…",
		loadMore: "Load more",

		// Playback / picture-in-picture
		buffering: "Buffering…",
		videoLoadFailed: "Video failed to load. Retry or check the network and FFmpeg.",
		preparingVideo: "Preparing video…",
		noSource: "No playable video source",
		pressPlay: "Press play on the video to start",
		pipUnsupported: "Picture-in-picture is unavailable; use floating mode",
		pipAfterLoad: "Try picture-in-picture after the video loads",
		systemPip: "System picture-in-picture",
		vendorLoadFailed: "Player component failed to load",
		ffmpegHint: "Some videos need FFmpeg. Configure its path in plugin settings.",

		// Control bar
		prevEpisode: "Previous",
		nextEpisode: "Next",
		playbackSpeed: "Playback speed",
		quality: "Quality",
		autoNext: "Auto-next",
		preloadNext: "Preload next",
		nextReady: "Next episode ready",
		preparingNext: "Preparing next…",
		episodeNumber: "Episode {n}",
		episodeCount: "{n} episodes",
		episodeBadge: "{n} ep",
		resumeEpisode: "Resume episode {n}",

		// Library / search
		searchActorPlaceholder: "Search actors by name",
		searchDramaPlaceholder: "Search dramas or keywords",
		searchActorAria: "Search actors",
		searchDramaAria: "Search dramas",
		searchType: "Search type",
		typeDrama: "Drama",
		typeActor: "Actor",
		search: "Search",
		tabDiscover: "Discover",
		tabHistory: "History",
		tabNowPlaying: "Now playing",
		viewWorks: "View dramas",
		chooseEpisode: "Choose an episode",
		actorWorks: "Dramas by {name}",

		// Empty states
		loadingEpisodes: "Loading episodes…",
		noEpisodes: "No episodes available",
		emptyHistory: "Your watched dramas will appear here",
		emptyActorWorks: "No public dramas found for this actor",
		emptyActorNotFound: "No actors found. Try their full name.",
		emptyActorPrompt: "Enter an actor's name to find their dramas",
		emptyDramas: "No dramas found. Try another search.",
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
