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
	tabMatchesBase,
	type PickerSettings,
} from "./shared/settings.js";
import {
	PICK_SECTIONS,
	SECTION_INFO,
	SECTION_PRESETS,
	normalizeSections,
	presetForSections,
	sectionsForDepth,
	type DetailLevel,
	type PickSection,
} from "./shared/contract.js";

const $ = <T extends HTMLElement>(id: string): T => {
	const node = document.getElementById(id);
	if (!node) throw new Error(`missing #${id}`);
	return node as T;
};

const fields = {
	serverUrl: $<HTMLInputElement>("serverUrl"),
	token: $<HTMLInputElement>("token"),
	preset: $<HTMLSelectElement>("preset"),
	copyToClipboard: $<HTMLInputElement>("copyToClipboard"),
	screenshots: $<HTMLInputElement>("screenshots"),
	focusTarget: $<HTMLInputElement>("focusTarget"),
};

/**
 * 「发送什么」的多选控件。
 *
 * 设计：**预设 + 逐项勾选**。预设决定「采多深 + 默认勾哪些」，用户再自己增减；
 * 勾选只影响内容项，深度（文本长度/骨架深度）沿用最近一次预设 —— 这样「嫌多」时
 * 只需取消勾选，不必再关心档位。
 */
const sectionBoxes = new Map<PickSection, HTMLInputElement>();
/** 最近一次应用的预设深度（手动勾选不改它）。 */
let depth: DetailLevel = DEFAULT_SETTINGS.detail;

function buildSectionList(): void {
	const list = $("sectionList");
	fields.preset.replaceChildren(
		...SECTION_PRESETS.map((p) => {
			const opt = document.createElement("option");
			opt.value = p.id;
			opt.textContent = `${p.label} — ${p.hint}`;
			return opt;
		}),
	);
	const custom = document.createElement("option");
	custom.value = "custom";
	custom.textContent = "自定义（自己勾）";
	fields.preset.append(custom);

	list.replaceChildren(
		...PICK_SECTIONS.map((key) => {
			const info = SECTION_INFO[key];
			const box = document.createElement("input");
			box.type = "checkbox";
			box.id = `sec-${key}`;
			box.addEventListener("change", () => {
				const picked = checkedSections();
				renderPresetSelect(picked);
				void (async () => {
					await save();
					// 提示要在「已保存」之后落笔，否则会被它覆盖掉
					if (picked.length === 0) status("至少要勾一项；全不勾会回落成标准组合", "warn");
				})();
			});
			sectionBoxes.set(key, box);
			const label = document.createElement("label");
			label.className = "check";
			const span = document.createElement("span");
			const b = document.createElement("b");
			b.textContent = info.label;
			const i = document.createElement("i");
			i.textContent = info.hint;
			span.append(b, i);
			label.append(box, span);
			return label;
		}),
	);
}

function checkedSections(): PickSection[] {
	return PICK_SECTIONS.filter((key) => sectionBoxes.get(key)?.checked);
}

/** 预设下拉的选中项：与某个预设一致就选它，否则「自定义」。 */
function renderPresetSelect(sections: PickSection[]): void {
	const matched = presetForSections(sections);
	fields.preset.value = matched ? matched.id : "custom";
	renderSummary(sections, matched?.label);
}

function renderSummary(sections: PickSection[], presetLabel?: string): void {
	const names = sections.map((k) => SECTION_INFO[k].label);
	$("sectionSummary").textContent =
		`当前发送：${names.length > 0 ? names.join(" / ") : "（都没勾 —— 将回落标准组合）"}` +
		`（共 ${sections.length} 项${presetLabel ? `，预设：${presetLabel}` : "，自定义"}）`;
}

function status(text: string, kind: "ok" | "err" | "warn" | "info" = "info"): void {
	const box = $("status");
	box.textContent = text;
	box.className = `status ${kind}`;
}

function readForm(): PickerSettings {
	return normalizeSettings({
		serverUrl: fields.serverUrl.value,
		token: fields.token.value,
		detail: depth,
		sections: checkedSections(),
		copyToClipboard: fields.copyToClipboard.checked,
		screenshots: fields.screenshots.checked,
		focusTarget: fields.focusTarget.checked,
	});
}

function fillForm(s: PickerSettings): void {
	fields.serverUrl.value = s.serverUrl;
	fields.token.value = s.token;
	fields.copyToClipboard.checked = s.copyToClipboard;
	fields.screenshots.checked = s.screenshots;
	fields.focusTarget.checked = s.focusTarget;
	depth = s.detail;
	const effective = s.sections.length > 0 ? s.sections : sectionsForDepth(s.detail);
	for (const [key, box] of sectionBoxes) box.checked = effective.includes(key);
	renderPresetSelect(effective);
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
		// 同 findTargetTab：只能用 origin 级 match pattern（裸 origin 会让 tabs.query 抛异常），
		// 路径前缀自己复核（否则 `https://host/pi-other` 也会被算成我们的页面）
		const tabs = await chrome.tabs.query({ url: [originPattern(base)] });
		return tabs.filter((t) => tabMatchesBase(t.url, base)).length;
	} catch {
		return 0;
	}
}

buildSectionList();
for (const [key, node] of Object.entries(fields)) {
	if (key === "preset") continue; // 预设自己处理（要连带勾选项与深度）
	node.addEventListener("change", () => void save());
}
fields.preset.addEventListener("change", () => {
	const preset = SECTION_PRESETS.find((p) => p.id === fields.preset.value);
	if (!preset) return; // 「自定义」= 不动勾选（只是当前状态的名字）
	depth = preset.depth;
	for (const [key, box] of sectionBoxes) box.checked = preset.sections.includes(key);
	renderPresetSelect(preset.sections);
	void save();
});
$("grant").addEventListener("click", () => void ensureOrigin());
$("test").addEventListener("click", () => void testConnection());
$("reset").addEventListener("click", () => {
	fillForm({ ...DEFAULT_SETTINGS, sections: [...normalizeSections(DEFAULT_SETTINGS.sections)] });
	void save();
});

// --------------------------------------------------------------------- ?bind= 绑定面板

/**
 * `?bind=<url>`：从 pi-web-ui 页面上的绑定浮条跳过来（用户在那个页面上点了「设为服务地址」）。
 *
 * 为什么不能就地完成：`chrome.permissions.request` 必须在**用户手势**里发出，而浮条的按钮
 * 点在网页上（content script 的 UI），浏览器不认这个手势 —— 只能把用户送到扩展自己的页面，
 * 这里的点击一定带手势。所以这条路径不是多余的，是权限模型要求的。
 */
async function initBindPanel(): Promise<void> {
	const raw = new URLSearchParams(location.search).get("bind");
	if (!raw) return;
	const base = normalizeServerUrl(raw);
	const already = normalizeServerUrl(fields.serverUrl.value) === base;
	fields.serverUrl.value = base;

	const title = $("bindTitle");
	const body = $("bindBody");
	const accept = $<HTMLButtonElement>("bindAccept");
	if (already) {
		title.textContent = `已经是当前服务地址：${base}`;
		body.textContent = "无需改动。要换地址就直接改上面的输入框（改完自动保存）。";
		accept.classList.add("hidden");
	} else {
		const granted = await originGranted();
		title.textContent = granted ? `把 ${base} 设为服务地址？` : `检测到 pi-web-ui 页面：${base}`;
		body.textContent = granted
			? "该地址已授权，点下面按钮就能绑定（之后在别的页面拾取的内容都注入到这里）。"
			: `浏览器要求在本页点一次才能授权 ${originPattern(base)}；点下面按钮即可授权并绑定。`;
		accept.textContent = granted ? "设为服务地址" : "授权并绑定";
		accept.addEventListener("click", () => void acceptBind(base));
	}
	$("bindPanel").classList.remove("hidden");
	$("bindDismiss").addEventListener("click", () => $("bindPanel").classList.add("hidden"));
}

/** 授权（如需要）+ 写入设置。失败时 ensureOrigin 已经写了原因，不要静默。 */
async function acceptBind(base: string): Promise<void> {
	if (!(await originGranted()) && !(await ensureOrigin())) return;
	await save(); // save 会回显归一后的地址，用户看得见实际会用哪个
	status(`已绑定 ${base} —— 以后拾取的内容都注入到这里`, "ok");
	$("bindPanel").classList.add("hidden");
}

void load().then(async () => {
	await refreshGrant();
	await initBindPanel();
});
