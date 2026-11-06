const inputUrl = document.getElementById("server-url");
const btnSyncAll = document.getElementById("btn-sync-all");
const btnSyncDoubao = document.getElementById("btn-sync-doubao");
const btnSyncDeepseek = document.getElementById("btn-sync-deepseek");
const msg = document.getElementById("msg");

chrome.storage.local.get("serverUrl", (data) => {
	if (data.serverUrl) {
		inputUrl.value = data.serverUrl;
	}
});

async function getDoubaoCookie() {
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
		if (cookieMap.has("sessionid") && Boolean(cookieMap.get("sessionid"))) {
			return Array.from(cookieMap.entries())
				.map(([k, v]) => `${k}=${v}`)
				.join("; ");
		}
	} catch {}
	return "";
}

async function getDeepSeekToken() {
	try {
		const tabs = await chrome.tabs.query({ url: "*://chat.deepseek.com/*" });
		for (const tab of tabs) {
			if (tab.id) {
				try {
					const results = await chrome.scripting.executeScript({
						target: { tabId: tab.id },
						func: () => {
							try {
								const raw = localStorage.getItem("userToken");
								if (!raw) return null;
								const parsed = JSON.parse(raw);
								return parsed?.value || null;
							} catch {
								return null;
							}
						},
					});
					const token = results?.[0]?.result;
					if (token && typeof token === "string" && token.length > 20) {
						return token;
					}
				} catch {}
			}
		}

		const cookies = await chrome.cookies.getAll({ domain: "deepseek.com" });
		for (const c of cookies) {
			if (c.name.toLowerCase().includes("token") && c.value && c.value.length > 30) {
				return c.value;
			}
		}
	} catch {}
	return "";
}

async function syncPayload(payload) {
	const serverUrl = (inputUrl.value || "http://127.0.0.1:8787").trim().replace(/\/+$/, "");
	await chrome.storage.local.set({ serverUrl });

	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), 6000);

	const res = await fetch(`${serverUrl}/plugins-api/tts/sync-credentials`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(payload),
		signal: controller.signal,
	});
	clearTimeout(timeoutId);

	return res.json();
}

btnSyncAll.onclick = async () => {
	msg.style.color = "#a1a1aa";
	msg.innerText = "正在扫描浏览器登录态...";

	try {
		const [doubaoCookie, deepseekToken] = await Promise.all([getDoubaoCookie(), getDeepSeekToken()]);

		if (!doubaoCookie && !deepseekToken) {
			msg.style.color = "#f87171";
			msg.innerText = "未检测到豆包或 DeepSeek 登录态，请先登录！";
			return;
		}

		const result = await syncPayload({
			doubaoCookie,
			deepseekToken,
		});

		if (result.ok) {
			msg.style.color = "#4ade80";
			const items = [];
			if (doubaoCookie) items.push("豆包");
			if (deepseekToken) items.push("DeepSeek (⚠️易封号)");
			msg.innerText = `🎉 成功同步: ${items.join(" + ")}！`;
		} else {
			msg.style.color = "#f87171";
			msg.innerText = `同步失败: ${result.error || "未知错误"}`;
		}
	} catch (err) {
		msg.style.color = "#f87171";
		msg.innerText = `连接失败: ${err.message}`;
	}
};

btnSyncDoubao.onclick = async () => {
	msg.style.color = "#a1a1aa";
	msg.innerText = "正在读取豆包凭证...";
	try {
		const doubaoCookie = await getDoubaoCookie();
		if (!doubaoCookie) {
			msg.style.color = "#f87171";
			msg.innerText = "未找到有效的豆包 Cookie，请在 doubao.com 登录！";
			return;
		}
		const result = await syncPayload({ doubaoCookie });
		msg.style.color = result.ok ? "#4ade80" : "#f87171";
		msg.innerText = result.ok ? "🎉 豆包登录态同步成功！" : `同步失败: ${result.error}`;
	} catch (err) {
		msg.style.color = "#f87171";
		msg.innerText = `连接失败: ${err.message}`;
	}
};

btnSyncDeepseek.onclick = async () => {
	msg.style.color = "#a1a1aa";
	msg.innerText = "正在读取 DeepSeek 凭证...";
	try {
		const deepseekToken = await getDeepSeekToken();
		if (!deepseekToken) {
			msg.style.color = "#f87171";
			msg.innerText = "未找到 DeepSeek userToken，请确保在浏览器中打开了 chat.deepseek.com！";
			return;
		}
		const result = await syncPayload({ deepseekToken });
		msg.style.color = result.ok ? "#4ade80" : "#f87171";
		msg.innerText = result.ok ? "🎉 DeepSeek 凭据同步成功！(⚠️注意网页账号封禁风险)" : `同步失败: ${result.error}`;
	} catch (err) {
		msg.style.color = "#f87171";
		msg.innerText = `连接失败: ${err.message}`;
	}
};
