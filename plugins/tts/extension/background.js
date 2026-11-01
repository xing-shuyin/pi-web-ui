// 监听并自动静默同步豆包与 DeepSeek 凭证到本地服务
const DEFAULT_SERVER = "http://127.0.0.1:8787";

async function getServerUrl() {
	const data = await chrome.storage.local.get("serverUrl");
	return (data.serverUrl || DEFAULT_SERVER).replace(/\/+$/, "");
}

async function syncDoubaoCookies() {
	try {
		const [byUrl, byDomain] = await Promise.all([
			chrome.cookies.getAll({ url: "https://www.doubao.com" }).catch(() => []),
			chrome.cookies.getAll({ domain: "doubao.com" }).catch(() => []),
		]);

		const cookieMap = new Map();
		for (const c of [...byUrl, ...byDomain]) {
			if (c && c.name && c.value) {
				cookieMap.set(c.name, c.value);
			}
		}

		if (cookieMap.size === 0) return;
		const hasSession = cookieMap.has("sessionid") && Boolean(cookieMap.get("sessionid"));
		if (!hasSession) return;

		const cookieStr = Array.from(cookieMap.entries())
			.map(([k, v]) => `${k}=${v}`)
			.join("; ");
		const baseUrl = await getServerUrl();

		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), 6000);

		await fetch(`${baseUrl}/plugins-api/tts/sync-credentials`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ doubaoCookie: cookieStr }),
			signal: controller.signal,
		});
		clearTimeout(timeoutId);
	} catch  {
		// 本地服务未开时静默忽略
	}
}

// 1. 监听 Cookie 变化
chrome.cookies.onChanged.addListener((changeInfo) => {
	if (
		changeInfo.cookie.domain.includes("doubao.com") &&
		["sessionid", "sid_guard", "uid_tt"].includes(changeInfo.cookie.name)
	) {
		syncDoubaoCookies();
	}
});

// 2. 插件安装或唤醒时尝试同步一次
chrome.runtime.onInstalled.addListener(() => {
	syncDoubaoCookies();
});
