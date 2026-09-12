/// <reference path="./chrome.d.ts" />
/// <reference lib="dom" />
/**
 * 设置页（options）。
 *
 * 只有一件事值得注意：**访问非 localhost 的地址需要单独申请 host 权限**
 * （manifest 里只预置了 localhost/127.0.0.1，避免装扩展时就吓人的「读取所有网站数据」）。
 * 用户把 pi-web-ui 挂在局域网/反代域名上时，在这里点一下授权即可。
 */

import {
	DEFAULT_SETTINGS,
	normalizeServerUrl,
	normalizeSettings,
	originPattern,
	type PickerSettings,
} from "./shared/settings.js";

const $ = <T extends HTMLElement>(id: string): T => {
	const node = document.getElementById(id);
	if (!node) throw new Error(`missing #${id}`);
	return node as T;
};

const fields = {
	serverUrl: $<HTMLInputElement>("serverUrl"),
	token: $<HTMLInputElement>("token"),
	detail: $<HTMLSelectElement>("detail"),
	copyToClipboard: $<HTMLInputElement>("copyToClipboard"),
	screenshots: $<HTMLInputElement>("screenshots"),
	focusTarget: $<HTMLInputElement>("focusTarget"),
};

function status(text: string, kind: "ok" | "err" | "warn" | "info" = "info"): void {
	const box = $("status");
	box.textContent = text;
	box.className = `status ${kind}`;
}

function readForm(): PickerSettings {
	return normalizeSettings({
		serverUrl: fields.serverUrl.value,
		token: fields.token.value,
		detail: fields.detail.value,
		copyToClipboard: fields.copyToClipboard.checked,
		screenshots: fields.screenshots.checked,
		focusTarget: fields.focusTarget.checked,
	});
}

function fillForm(s: PickerSettings): void {
	fields.serverUrl.value = s.serverUrl;
	fields.token.value = s.token;
	fields.detail.value = s.detail;
	fields.copyToClipboard.checked = s.copyToClipboard;
	fields.screenshots.checked = s.screenshots;
	fields.focusTarget.checked = s.focusTarget;
}

async function load(): Promise<void> {
	try {
		fillForm(normalizeSettings(await chrome.storage.sync.get(null)));
	} catch {
		fillForm(DEFAULT_SETTINGS);
	}
}

async function save(): Promise<void> {
	const settings = readForm();
	fields.serverUrl.value = settings.serverUrl; // 回显归一后的地址，让用户看到实际会用哪个
	await chrome.storage.sync.set({ ...settings });
	await refreshGrant();
	status("已保存", "ok");
}

/** 该地址的 host 权限有没有（没有就请求；默认 localhost 已内置）。 */
async function originGranted(): Promise<boolean> {
	try {
		return await chrome.permissions.contains({ origins: [originPattern(fields.serverUrl.value)] });
	} catch {
		return false;
	}
}

/** 刷新授权状态显示（远程部署全靠这一步：没授权连「找到 pi-web-ui 页面」都做不到）。 */
async function refreshGrant(): Promise<void> {
	const pattern = originPattern(fields.serverUrl.value);
	const granted = await originGranted();
	const label = $("grantState");
	label.textContent = granted ? `已授权 ${pattern}` : `未授权 ${pattern}`;
	label.className = `grant-state ${granted ? "ok" : "warn"}`;
	const button = $<HTMLButtonElement>("grant");
	button.disabled = granted;
	button.textContent = granted ? "已授权" : "授权该地址";
}

async function ensureOrigin(): Promise<boolean> {
	const pattern = originPattern(fields.serverUrl.value);
	const granted = await chrome.permissions.request({ origins: [pattern] });
	await refreshGrant();
	status(granted ? `已授权 ${pattern}` : `未授权 ${pattern}（非本机地址必须授权才能注入）`, granted ? "ok" : "err");
	return granted;
}

async function testConnection(): Promise<void> {
	const base = normalizeServerUrl(fields.serverUrl.value);
	if (!(await originGranted())) {
		status(`未授权 ${originPattern(base)} —— 先点「授权该地址」`, "err");
		return;
	}
	status("正在探测服务端…");
	try {
		const res = await fetch(`${base}/api/health`, { cache: "no-store" });
		if (!res.ok) {
			status(`服务端返回 HTTP ${res.status}`, "err");
			return;
		}
		const info = (await res.json()) as { cwd?: string; piVersion?: string };
		const open = await countOpenTabs(base);
		status(
			open > 0
				? `服务端在线（cwd: ${info.cwd ?? "?"}），已打开 ${open} 个 pi-web-ui 页面`
				: `服务端在线（cwd: ${info.cwd ?? "?"}），但浏览器里还没打开这个页面 —— 投递需要它开着`,
			open > 0 ? "ok" : "warn",
		);
	} catch (err) {
		status(`连不上服务端：${err instanceof Error ? err.message : String(err)}（地址对吗？证书受信吗？）`, "err");
	}
}

/** 浏览器里当前开着几个这个地址的 pi-web-ui 页面（投递的目标）。 */
async function countOpenTabs(base: string): Promise<number> {
	try {
		const tabs = await chrome.tabs.query({ url: [`${base}/*`, `${base}`] });
		return tabs.filter((t) => t.url === base || t.url?.startsWith(`${base}/`) || t.url?.startsWith(`${base}?`)).length;
	} catch {
		return 0;
	}
}

for (const node of Object.values(fields)) {
	node.addEventListener("change", () => void save());
}
$("grant").addEventListener("click", () => void ensureOrigin());
$("test").addEventListener("click", () => void testConnection());
$("reset").addEventListener("click", () => {
	fillForm(DEFAULT_SETTINGS);
	void save();
});

void load().then(refreshGrant);
