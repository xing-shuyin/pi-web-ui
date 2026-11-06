/// <reference path="./chrome.d.ts" />
/// <reference lib="dom" />

import {
	DEFAULT_SETTINGS,
	normalizeServerUrl,
	normalizeSettings,
	originPattern,
	tabMatchesBase,
	type PickerSettings,
} from "./shared/settings.js";
import {
	SHOT_PERMISSION_ORIGINS,
	normalizeOrigin,
	removePair,
	upsertPair,
	type AiPage,
	type BridgePair,
} from "./shared/bridge.js";
import {
	AI_PAGES_KEY,
	PAIRS_KEY,
	grantAiPage,
	loadAiPages,
	loadPairs,
	loadRecent,
	revokeAiPage,
	savePairs,
} from "./shared/bridge-store.js";
import {
	PICK_SECTIONS,
	SECTION_INFO,
	SECTION_PRESETS,
	describeSections,
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

function applyI18n(): void {
	for (const el of document.querySelectorAll<HTMLElement>("[data-i18n]")) {
		const key = el.dataset.i18n;
		if (key) el.textContent = chrome.i18n.getMessage(key);
	}
	for (const el of document.querySelectorAll<HTMLElement>("[data-i18n-html]")) {
		const key = el.dataset.i18nHtml;
		if (key) el.innerHTML = chrome.i18n.getMessage(key);
	}
	for (const el of document.querySelectorAll<HTMLInputElement>("[data-i18n-ph]")) {
		const key = el.dataset.i18nPh;
		if (key) el.placeholder = chrome.i18n.getMessage(key);
	}
}

const fields = {
	serverUrl: $<HTMLInputElement>("serverUrl"),
	token: $<HTMLInputElement>("token"),
	preset: $<HTMLSelectElement>("preset"),
	copyToClipboard: $<HTMLInputElement>("copyToClipboard"),
	screenshots: $<HTMLInputElement>("screenshots"),
	focusTarget: $<HTMLInputElement>("focusTarget"),
	aiControl: $<HTMLInputElement>("aiControl"),
	allowEval: $<HTMLInputElement>("allowEval"),
	allowShot: $<HTMLInputElement>("allowShot"),
};

const sectionBoxes = new Map<PickSection, HTMLInputElement>();
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
	custom.textContent = chrome.i18n.getMessage("preset_customItem");
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
					if (picked.length === 0) status(chrome.i18n.getMessage("status_atLeastOne"), "warn");
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

function renderPresetSelect(sections: PickSection[]): void {
	const matched = presetForSections(sections);
	fields.preset.value = matched ? matched.id : "custom";
	$("sectionSummary").textContent = describeSections(sections);
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
		aiControl: fields.aiControl.checked,
		allowEval: fields.allowEval.checked,
		allowShot: fields.allowShot.checked,
	});
}

function fillForm(s: PickerSettings): void {
	fields.serverUrl.value = s.serverUrl;
	fields.token.value = s.token;
	fields.copyToClipboard.checked = s.copyToClipboard;
	fields.screenshots.checked = s.screenshots;
	fields.focusTarget.checked = s.focusTarget;
	fields.aiControl.checked = s.aiControl;
	fields.allowEval.checked = s.allowEval;
	fields.allowShot.checked = s.allowShot;
	depth = s.detail;
	const effective = s.sections.length > 0 ? s.sections : sectionsForDepth(s.detail);
	for (const [key, box] of sectionBoxes) box.checked = effective.includes(key);
	renderPresetSelect(effective);
}

async function load(): Promise<void> {
	applyI18n();
	try {
		fillForm(normalizeSettings(await chrome.storage.sync.get(null)));
	} catch {
		fillForm(DEFAULT_SETTINGS);
	}
}

async function save(): Promise<void> {
	const settings = readForm();
	fields.serverUrl.value = settings.serverUrl;
	await chrome.storage.sync.set({ ...settings });
	await refreshGrant();
	status(chrome.i18n.getMessage("status_saved"), "ok");
}

async function originGranted(): Promise<boolean> {
	try {
		return await chrome.permissions.contains({ origins: [originPattern(fields.serverUrl.value)] });
	} catch {
		return false;
	}
}

async function refreshGrant(): Promise<void> {
	const pattern = originPattern(fields.serverUrl.value);
	const granted = await originGranted();
	const label = $("grantState");
	label.textContent = granted
		? chrome.i18n.getMessage("status_grantGranted", [pattern])
		: chrome.i18n.getMessage("status_grantNotGranted", [pattern]);
	label.className = `grant-state ${granted ? "ok" : "warn"}`;
	const button = $<HTMLButtonElement>("grant");
	button.disabled = granted;
	button.textContent = granted
		? chrome.i18n.getMessage("options_grantButtonDone")
		: chrome.i18n.getMessage("options_grantButton");
}

async function ensureOrigin(): Promise<boolean> {
	const pattern = originPattern(fields.serverUrl.value);
	const granted = await chrome.permissions.request({ origins: [pattern] });
	await refreshGrant();
	status(
		granted
			? chrome.i18n.getMessage("status_grantGranted", [pattern])
			: chrome.i18n.getMessage("status_originNotGrantedAuthRequired", [pattern]),
		granted ? "ok" : "err",
	);
	return granted;
}

async function testConnection(): Promise<void> {
	const base = normalizeServerUrl(fields.serverUrl.value);
	if (!(await originGranted())) {
		status(chrome.i18n.getMessage("status_grantNotGranted", [originPattern(base)]), "err");
		return;
	}
	status(chrome.i18n.getMessage("status_testingProbing"));
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
				? chrome.i18n.getMessage("status_serverOnlineWithTabs", [info.cwd ?? "?", String(open)])
				: chrome.i18n.getMessage("status_serverOnlineNoTabs", [info.cwd ?? "?"]),
			open > 0 ? "ok" : "warn",
		);
	} catch (err) {
		status(
			chrome.i18n.getMessage("status_connectionFailed", [err instanceof Error ? err.message : String(err)]),
			"err",
		);
	}
}

async function countOpenTabs(base: string): Promise<number> {
	try {
		const tabs = await chrome.tabs.query({ url: [originPattern(base)] });
		return tabs.filter((t) => tabMatchesBase(t.url, base)).length;
	} catch {
		return 0;
	}
}

buildSectionList();
for (const [key, node] of Object.entries(fields)) {
	if (key === "preset") continue;
	if (key === "allowShot") continue;
	node.addEventListener("change", () => void save());
}

async function toggleShot(on: boolean): Promise<void> {
	if (!on) {
		await save();
		status(chrome.i18n.getMessage("status_shotDisabled"), "info");
		return;
	}
	let granted = false;
	try {
		granted = await chrome.permissions.contains({ origins: [...SHOT_PERMISSION_ORIGINS] });
		if (!granted) granted = await chrome.permissions.request({ origins: [...SHOT_PERMISSION_ORIGINS] });
	} catch {
		granted = false;
	}
	if (!granted) {
		fields.allowShot.checked = false;
		status(chrome.i18n.getMessage("status_shotNeedPermission"), "err");
		return;
	}
	await save();
	status(chrome.i18n.getMessage("status_shotEnabled"), "ok");
}
fields.allowShot.addEventListener("change", () => void toggleShot(fields.allowShot.checked));
fields.preset.addEventListener("change", () => {
	const preset = SECTION_PRESETS.find((p) => p.id === fields.preset.value);
	if (!preset) return;
	depth = preset.depth;
	for (const [key, box] of sectionBoxes) box.checked = preset.sections.includes(key);
	renderPresetSelect(preset.sections);
	void save();
});
$("grant").addEventListener("click", () => void ensureOrigin());
chrome.storage.onChanged?.addListener((changes, area) => {
	if (area !== "sync") return;
	if (!changes.detail && !changes.sections) return;
	void load();
});
$("test").addEventListener("click", () => void testConnection());
$("reset").addEventListener("click", () => {
	fillForm({ ...DEFAULT_SETTINGS, sections: [...normalizeSections(DEFAULT_SETTINGS.sections)] });
	void save();
});

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
		title.textContent = chrome.i18n.getMessage("status_bindAlreadyCurrent", [base]);
		body.textContent = chrome.i18n.getMessage("status_bindAlreadyCurrentBody");
		accept.classList.add("hidden");
	} else {
		const granted = await originGranted();
		title.textContent = granted
			? chrome.i18n.getMessage("status_bindSetAsServer", [base])
			: chrome.i18n.getMessage("status_bindDetectedPage", [base]);
		body.textContent = granted
			? chrome.i18n.getMessage("options_bindBodyGranted")
			: chrome.i18n.getMessage("options_bindBodyNotGranted", [originPattern(base)]);
		accept.textContent = granted
			? chrome.i18n.getMessage("status_bindAcceptGranted")
			: chrome.i18n.getMessage("status_bindAcceptNotGranted");
		accept.addEventListener("click", () => void acceptBind(base));
	}
	$("bindPanel").classList.remove("hidden");
	$("bindDismiss").addEventListener("click", () => $("bindPanel").classList.add("hidden"));
}

async function acceptBind(base: string): Promise<void> {
	if (!(await originGranted()) && !(await ensureOrigin())) return;
	await save();
	status(chrome.i18n.getMessage("status_bindBound", [base]), "ok");
	$("bindPanel").classList.add("hidden");
}

void load().then(async () => {
	await refreshGrant();
	await initBindPanel();
});

let pairs: BridgePair[] = [];
const pairFields = {
	a: $<HTMLInputElement>("pairA"),
	b: $<HTMLInputElement>("pairB"),
	note: $<HTMLInputElement>("pairNote"),
};

function pairStatus(text: string, kind: "ok" | "err" | "warn" | "info" = "info"): void {
	const box = $("pairStatus");
	box.textContent = text;
	box.className = `status ${kind}`;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	if (cls) node.className = cls;
	if (text !== undefined) node.textContent = text;
	return node;
}

function renderPairs(): void {
	const list = $("pairList");
	if (pairs.length === 0) {
		list.replaceChildren(el("div", "empty", chrome.i18n.getMessage("options_pairEmpty")));
		return;
	}
	list.replaceChildren(...pairs.map(renderPair));
}

function renderPair(pair: BridgePair): HTMLElement {
	const card = el("div", `pair${pair.enabled ? "" : " off"}`);
	card.append(el("div", "who", `${pair.a} ↔ ${pair.b}`));
	const meta = el(
		"div",
		"meta",
		pair.note
			? `${pair.note} · ${chrome.i18n.getMessage("options_pairPermissionChecking")}`
			: chrome.i18n.getMessage("options_pairPermissionChecking"),
	);
	card.append(meta);

	const toggle = el("input");
	toggle.type = "checkbox";
	toggle.checked = pair.enabled;
	toggle.addEventListener("change", () => void setPairEnabled(pair, toggle.checked));
	const toggleLabel = el("label", "check");
	toggleLabel.append(
		toggle,
		el(
			"span",
			undefined,
			pair.enabled ? chrome.i18n.getMessage("options_pairEnabled") : chrome.i18n.getMessage("options_pairDisabled"),
		),
	);

	const drop = el("button", undefined, chrome.i18n.getMessage("options_pairDelete"));
	drop.addEventListener("click", () => void dropPair(pair));

	const actions = el("div", "actions");
	actions.append(toggleLabel, drop);
	card.append(actions);

	void showPairPermission(meta, pair);
	return card;
}

async function showPairPermission(meta: HTMLElement, pair: BridgePair): Promise<void> {
	const patterns = [originPattern(pair.a), originPattern(pair.b)];
	const missing: string[] = [];
	for (const pattern of patterns) {
		let granted = true;
		try {
			granted = await chrome.permissions.contains({ origins: [pattern] });
		} catch {
			granted = true;
		}
		if (!granted) missing.push(pattern);
	}
	const head = pair.note ? `${pair.note} · ` : "";
	meta.textContent =
		missing.length === 0
			? `${head}${chrome.i18n.getMessage("options_pairBothGranted")}`
			: `${head}${chrome.i18n.getMessage("options_pairMissingGrant", [missing.join(chrome.i18n.getMessage("ai_opSeparator"))])}`;
}

async function notifyPairsChanged(
	removedOrigins: string[] = [],
): Promise<{ installed?: number; uninstalled?: number } | undefined> {
	try {
		return (await chrome.runtime.sendMessage({ type: "page-picker:bridges-changed", removedOrigins })) as
			{ installed?: number; uninstalled?: number } | undefined;
	} catch {
		return undefined;
	}
}

async function addPair(): Promise<void> {
	const merged = upsertPair(pairs, pairFields.a.value, pairFields.b.value, {
		note: pairFields.note.value,
		now: new Date().toISOString(),
	});
	if (merged.error || !merged.pair) {
		pairStatus(merged.error ?? chrome.i18n.getMessage("status_pairInvalid"), "err");
		return;
	}
	const pair = merged.pair;
	const patterns = [originPattern(pair.a), originPattern(pair.b)];
	let granted = false;
	try {
		granted = await chrome.permissions.request({ origins: patterns });
	} catch {
		granted = false;
	}
	if (!granted) {
		pairStatus(
			chrome.i18n.getMessage("status_pairNotGranted", [patterns.join(chrome.i18n.getMessage("ai_opSeparator"))]),
			"err",
		);
		return;
	}
	pairs = merged.pairs;
	await savePairs(pairs);
	pairFields.note.value = "";
	renderPairs();
	const res = await notifyPairsChanged();
	pairStatus(
		res?.installed
			? chrome.i18n.getMessage("status_pairAddedWithInstall", [pair.a, pair.b, String(res.installed)])
			: chrome.i18n.getMessage("status_pairAddedAuto", [pair.a, pair.b]),
		"ok",
	);
	await refreshOriginOptions();
}

async function setPairEnabled(pair: BridgePair, enabled: boolean): Promise<void> {
	pairs = pairs.map((p) => (p.id === pair.id ? { ...p, enabled } : p));
	await savePairs(pairs);
	renderPairs();
	const res = await notifyPairsChanged(enabled ? [] : [pair.a, pair.b]);
	pairStatus(
		enabled
			? res?.installed
				? chrome.i18n.getMessage("status_pairEnabledWithInstall", [String(res.installed)])
				: chrome.i18n.getMessage("status_pairEnabledAuto")
			: chrome.i18n.getMessage("status_pairDisabled"),
		"ok",
	);
}

async function dropPair(pair: BridgePair): Promise<void> {
	pairs = removePair(pairs, pair.id);
	await savePairs(pairs);
	renderPairs();
	const res = await notifyPairsChanged([pair.a, pair.b]);
	pairStatus(
		res?.uninstalled
			? chrome.i18n.getMessage("status_pairDeletedWithUninstall", [String(res.uninstalled)])
			: chrome.i18n.getMessage("status_pairDeleted"),
		"ok",
	);
}

async function refreshOriginOptions(): Promise<void> {
	const known = new Map<string, string>();
	for (const item of await loadRecent()) known.set(item.origin, item.title ?? item.origin);
	for (const pair of pairs) {
		if (!known.has(pair.a)) known.set(pair.a, chrome.i18n.getMessage("options_pairCandidatePaired", [pair.a]));
		if (!known.has(pair.b)) known.set(pair.b, chrome.i18n.getMessage("options_pairCandidatePaired", [pair.b]));
	}
	const list = $("piOrigins");
	list.replaceChildren(
		...[...known.entries()].map(([origin, label]) => {
			const opt = document.createElement("option");
			opt.value = origin;
			opt.label = label;
			opt.textContent = label;
			return opt;
		}),
	);
}

async function initPairDeepLink(): Promise<void> {
	const raw = new URLSearchParams(location.search).get("pair");
	if (!raw) return;
	const origin = normalizeOrigin(raw);
	if (!origin) return;
	pairFields.a.value = origin;
	pairStatus(chrome.i18n.getMessage("status_pairDeepLinkFilled", [origin]), "info");
	pairFields.b.focus();
}

async function initBridgePanel(): Promise<void> {
	pairs = await loadPairs();
	renderPairs();
	$("pairAdd").addEventListener("click", () => void addPair());
	chrome.storage.onChanged?.addListener((changes, area) => {
		if (area !== "local" || !changes[PAIRS_KEY]) return;
		void (async () => {
			pairs = await loadPairs();
			renderPairs();
		})();
	});
	await refreshOriginOptions();
	await initPairDeepLink();
}

void initBridgePanel();

let aiPages: AiPage[] = [];

function aiStatus(text: string, kind: "ok" | "err" | "warn" | "info" = "info"): void {
	const box = $("aiStatus");
	box.textContent = text;
	box.className = `status ${kind}`;
}

function renderAiPages(): void {
	const list = $("aiList");
	if (aiPages.length === 0) {
		list.replaceChildren(el("div", "empty", chrome.i18n.getMessage("options_aiEmpty")));
		return;
	}
	list.replaceChildren(
		...aiPages.map((page) => {
			const named = Boolean(page.title) && page.title !== page.origin;
			const card = el("div", "pair");
			card.append(el("div", "who", named ? (page.title as string) : page.origin));
			if (named) card.append(el("div", "meta", page.origin));
			const actions = el("div", "actions");
			const drop = el("button", undefined, chrome.i18n.getMessage("options_aiRevoke"));
			drop.addEventListener("click", () => void revokePage(page));
			actions.append(drop);
			card.append(actions);
			return card;
		}),
	);
}

async function grantPage(): Promise<void> {
	const origin = normalizeOrigin($<HTMLInputElement>("aiPageInput").value);
	if (!origin) {
		aiStatus(chrome.i18n.getMessage("status_aiInvalidAddress"), "err");
		return;
	}
	const pattern = originPattern(origin);
	let granted = false;
	try {
		granted = await chrome.permissions.request({ origins: [pattern] });
	} catch {
		granted = false;
	}
	if (!granted) {
		aiStatus(chrome.i18n.getMessage("status_aiNotGranted", [pattern]), "err");
		return;
	}
	const recent = await loadRecent();
	aiPages = await grantAiPage(origin, recent.find((item) => item.origin === origin)?.title);
	$<HTMLInputElement>("aiPageInput").value = "";
	renderAiPages();
	const res = await notifyPairsChanged();
	aiStatus(
		res?.installed
			? chrome.i18n.getMessage("status_aiGrantedWithInstall", [origin, String(res.installed)])
			: chrome.i18n.getMessage("status_aiGrantedAuto", [origin]),
		"ok",
	);
	await refreshOriginOptions();
}

async function revokePage(page: AiPage): Promise<void> {
	aiPages = await revokeAiPage(page.origin);
	renderAiPages();
	await notifyPairsChanged([page.origin]);
	aiStatus(chrome.i18n.getMessage("status_aiRevoked", [page.origin]), "ok");
}

async function initGrantDeepLink(): Promise<void> {
	const raw = new URLSearchParams(location.search).get("grant");
	if (!raw) return;
	const origin = normalizeOrigin(raw);
	if (!origin) return;
	$<HTMLInputElement>("aiPageInput").value = origin;
	aiStatus(chrome.i18n.getMessage("status_aiDeepLinkFilled", [origin]), "info");
	$<HTMLButtonElement>("aiGrant").focus();
}

async function initAiPanel(): Promise<void> {
	aiPages = await loadAiPages();
	renderAiPages();
	$("aiGrant").addEventListener("click", () => void grantPage());
	chrome.storage.onChanged?.addListener((changes, area) => {
		if (area !== "local" || !changes[AI_PAGES_KEY]) return;
		void (async () => {
			aiPages = await loadAiPages();
			renderAiPages();
		})();
	});
}

void initAiPanel().then(initGrantDeepLink);
