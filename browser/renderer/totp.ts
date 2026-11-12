/**
 * TOTP 验证器面板（工具栏钥匙图标 → 「TOTP 验证器」）。
 *
 * 关键边界：**secret 从不进入渲染层**。这里拿到的都是 `PublicTotpEntry`（无 secret），
 * 要 6 位码就发 `totp.code { id }` 让主进程算；导出（`totp.export`）是唯一会把 otpauth URI
 * 带出来的出口，且必须由用户显式点击。
 *
 * 扫码走主进程 `totp.scan`：截当前标签页找码，所以网页里的 `<img>` / `<canvas>` / 内联 SVG
 * 一视同仁，也不需要摄像头权限或字体/CORS 之类的配合。
 */
import { button, call, closeIcon, element, empty, iconButton, input, label, notify, reportError } from "./common.js";
import type { BrowserState } from "../contracts.js";
import { t } from "./i18n.js";

/** 与主进程 `PublicTotpEntry` 对齐（没有 secret）。 */
interface PublicTotpEntry {
	id: string;
	label: string;
	issuer: string;
	account: string;
	algorithm: string;
	digits: number;
	period: number;
	origin: string;
	createdAt: number;
	order: number;
}

interface CodeResponse {
	code: string;
	remainingMs: number;
	period: number;
}

interface CodeState extends CodeResponse {
	fetchedAt: number;
}

let panelToken = 0;

function originOf(url: string | undefined): string {
	if (!url) return "";
	try {
		const parsed = new URL(url);
		return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.origin : "";
	} catch {
		return "";
	}
}

async function copyText(value: string): Promise<void> {
	try {
		await navigator.clipboard.writeText(value);
		return;
	} catch {
		// 面板视图没有剪贴板权限时退回 execCommand
	}
	const area = element("textarea");
	area.value = value;
	area.style.position = "fixed";
	area.style.opacity = "0";
	document.body.append(area);
	area.select();
	const ok = document.execCommand("copy");
	area.remove();
	if (!ok) throw new Error("Clipboard is unavailable");
}

function formatAccount(entry: PublicTotpEntry): string {
	return [entry.issuer, entry.account].filter(Boolean).join(" · ") || entry.label;
}

function actions(...nodes: HTMLElement[]): HTMLElement {
	const row = element("div", "pb-totp-actions");
	row.append(...nodes);
	return row;
}

/** 打开/刷新面板：每次都重新渲染（条目数不多，简单胜过增量 diff）。 */
export async function totpPanel(container: HTMLElement, onChange: () => void): Promise<void> {
	const token = ++panelToken;
	const stale = () => token !== panelToken || !container.isConnected;
	container.replaceChildren();
	container.append(element("p", "pb-muted", t("totpHelp")));

	if (!(await call<boolean>("totp.available").catch(() => false))) {
		container.append(element("p", "pb-muted", t("totpUnavailable")));
		return;
	}

	const state = await call<BrowserState>("state").catch(() => undefined);
	const pageUrl = state?.tabs.find((tab) => tab.id === state.activeTabId)?.url;
	const pageOrigin = originOf(pageUrl);

	let entries: PublicTotpEntry[] = await call<PublicTotpEntry[]>("totp.list");
	const codes = new Map<string, CodeState>();
	const rows = new Map<string, HTMLElement>();
	const links = new Map<string, HTMLElement>();
	const bars = new Map<string, HTMLElement>();

	const list = element("div", "pb-list pb-totp-list");
	const exportArea = element("div", "pb-totp-export");
	exportArea.hidden = true;

	// ---- 新增区：扫码 / 导入图片 / 手工粘贴 ----
	const editor = element("form", "pb-form pb-editor-inline");
	editor.hidden = true;
	const uriField = element("textarea", "pb-input");
	uriField.rows = 2;
	uriField.placeholder = t("totpManualPlaceholder");
	uriField.spellcheck = false;
	const labelField = input();
	const originField = input();
	const submit = button(t("totpAdd"), () => {}, "pb-primary");
	submit.type = "submit";
	const cancel = button(t("cancel"), () => {
		editor.hidden = true;
		uriField.value = "";
		labelField.value = "";
		originField.value = "";
	});
	editor.append(
		element("p", "pb-muted", t("totpManual")),
		label(t("totpManual"), uriField),
		label(t("name"), labelField),
		label(t("totpBound"), originField),
		actions(submit, cancel),
	);

	const filePicker = element("input");
	filePicker.type = "file";
	filePicker.accept = "image/*";
	filePicker.hidden = true;
	filePicker.addEventListener("change", () => {
		const file = filePicker.files?.[0];
		filePicker.value = "";
		if (!file) return;
		const reader = new FileReader();
		reader.onload = () => {
			void (async () => {
				try {
					const { uri } = await call<{ uri: string }>("totp.importImage", { dataUrl: String(reader.result) });
					openEditor(uri, "");
					notify(t("totpScanned"));
				} catch (error) {
					notify(t("totpImportFailed"), true);
					reportError(error);
				}
			})();
		};
		reader.readAsDataURL(file);
	});

	const scanButton = button(t("totpScan"), async () => {
		scanButton.disabled = true;
		scanButton.textContent = t("totpScanning");
		try {
			const { url, uri } = await call<{ url: string; uri: string }>("totp.scan");
			openEditor(uri, originOf(url));
			notify(t("totpScanned"));
		} catch (error) {
			notify(t("totpScanFailed"), true);
			reportError(error);
		} finally {
			scanButton.disabled = false;
			scanButton.textContent = t("totpScan");
		}
	});
	const importButton = button(t("totpImport"), () => filePicker.click());
	const manualButton = button(t("addCredential"), () => openEditor("", pageOrigin));

	function openEditor(uri: string, origin: string): void {
		uriField.value = uri;
		originField.value = origin;
		labelField.value = "";
		editor.hidden = false;
		uriField.focus();
	}

	editor.addEventListener("submit", (event) => {
		event.preventDefault();
		void (async () => {
			entries = await call<PublicTotpEntry[]>("totp.add", {
				uri: uriField.value.trim(),
				label: labelField.value.trim(),
				origin: originField.value.trim() || undefined,
			});
			editor.hidden = true;
			uriField.value = "";
			labelField.value = "";
			originField.value = "";
			render();
			onChange();
			notify(t("saved"));
		})().catch(reportError);
	});

	// ---- 条目列表 ----
	let selectedId: string | undefined;
	let ordered: PublicTotpEntry[] = [];

	async function copyCode(entry: PublicTotpEntry): Promise<void> {
		const value = codes.get(entry.id)?.code;
		if (!value) {
			await refreshCode(entry);
			const retry = codes.get(entry.id)?.code;
			if (!retry) {
				notify(t("totpCodeFailed"), true);
				return;
			}
			await copyText(retry);
			notify(t("totpCopied"));
			return;
		}
		await copyText(value);
		notify(t("totpCopied"));
	}

	async function fillCode(entry: PublicTotpEntry): Promise<void> {
		await call("totp.fill", { id: entry.id });
		notify(t("totpFilled"));
	}

	/** 选中态：键盘操作（↑↓ / Enter / 数字键）靠它定位当前行。 */
	function select(id: string | undefined): void {
		selectedId = id;
		for (const [entryId, row] of rows) row.classList.toggle("pb-totp-selected", entryId === id);
	}

	function selectByOffset(delta: number): void {
		if (!ordered.length) return;
		const index = ordered.findIndex((entry) => entry.id === selectedId);
		const next =
			index < 0 ? (delta > 0 ? 0 : ordered.length - 1) : Math.min(ordered.length - 1, Math.max(0, index + delta));
		select(ordered[next]?.id);
		rows.get(ordered[next]?.id ?? "")?.scrollIntoView({ block: "nearest" });
	}

	async function refreshCode(entry: PublicTotpEntry): Promise<void> {
		try {
			const result = await call<CodeResponse>("totp.code", { id: entry.id });
			if (stale()) return;
			codes.set(entry.id, { ...result, fetchedAt: Date.now() });
			const link = links.get(entry.id);
			if (link) link.textContent = result.code;
			const row = rows.get(entry.id);
			if (row) row.classList.remove("pb-totp-error");
		} catch {
			if (stale()) return;
			codes.delete(entry.id);
			const link = links.get(entry.id);
			if (link) link.textContent = "—";
			rows.get(entry.id)?.classList.add("pb-totp-error");
		}
	}

	function rowFor(entry: PublicTotpEntry): HTMLElement {
		const row = element("div", "pb-list-item pb-totp-item");
		const head = element("div", "pb-totp-head");
		const title = element("div", "pb-totp-title");
		title.append(element("strong", "", entry.label));
		if (formatAccount(entry) !== entry.label) title.append(element("span", "pb-muted", formatAccount(entry)));
		head.append(title);
		if (entry.origin) head.append(element("span", "pb-tag", entry.origin));

		const code = element("button", "pb-totp-code");
		code.type = "button";
		code.title = t("totpCopy");
		code.textContent = "•".repeat(entry.digits);
		links.set(entry.id, code);
		code.addEventListener("click", () => {
			void copyCode(entry).catch(reportError);
		});
		code.addEventListener("focus", () => select(entry.id));
		const bar = element("span", "pb-totp-bar");
		bars.set(entry.id, bar);
		row.addEventListener("pointerdown", () => select(entry.id));
		// 行可聚焦：点一下行 → Enter 就是「复制这一条」（焦点在按钮上时 Enter 仍是点按钮）
		row.tabIndex = 0;
		row.addEventListener("focus", () => select(entry.id));

		const move = async (delta: number) => {
			const index = entries.findIndex((item) => item.id === entry.id);
			const target = index + delta;
			if (index < 0 || target < 0 || target >= entries.length) return;
			const ids = entries.map((item) => item.id);
			[ids[index], ids[target]] = [ids[target], ids[index]];
			entries = await call<PublicTotpEntry[]>("totp.reorder", { ids });
			render();
			onChange();
		};

		const editButton = iconButton(element("span", "", "✎"), t("edit"), () => {
			const form = element("form", "pb-form");
			const nameField = input(entry.label);
			const siteField = input(entry.origin, "text");
			const save = button(t("save"), () => {}, "pb-primary");
			save.type = "submit";
			form.append(
				label(t("name"), nameField),
				label(t("totpBound"), siteField),
				actions(
					save,
					button(t("cancel"), () => render()),
				),
			);
			form.addEventListener("submit", (event) => {
				event.preventDefault();
				void (async () => {
					entries = await call<PublicTotpEntry[]>("totp.update", {
						id: entry.id,
						label: nameField.value.trim(),
						origin: siteField.value.trim(),
					});
					render();
					onChange();
					notify(t("saved"));
				})().catch(reportError);
			});
			row.replaceChildren(head, form);
			nameField.focus();
		});

		row.append(
			head,
			code,
			bar,
			actions(
				button(t("totpFill"), () => void fillCode(entry).catch(reportError)),
				button(t("totpExportOne"), async () => {
					const { uris } = await call<{ uris: string[] }>("totp.export");
					await copyText(uris[entries.findIndex((item) => item.id === entry.id)] ?? "");
					notify(t("totpCopied"));
				}),
				editButton,
				iconButton(element("span", "", "↑"), t("totpMoveUp"), () => move(-1)),
				iconButton(element("span", "", "↓"), t("totpMoveDown"), () => move(1)),
				iconButton(closeIcon(8), t("removeCredential"), () => {
					const confirmation = element("div", "pb-confirm");
					confirmation.append(
						element("span", "", t("totpRemoveConfirm")),
						button(t("yesDelete"), async () => {
							entries = await call<PublicTotpEntry[]>("totp.remove", { id: entry.id });
							codes.delete(entry.id);
							render();
							onChange();
						}),
						button(t("cancel"), render),
					);
					row.replaceChildren(confirmation);
				}),
			),
		);
		rows.set(entry.id, row);
		return row;
	}

	function render(): void {
		rows.clear();
		links.clear();
		bars.clear();
		list.replaceChildren();
		if (!entries.length) {
			list.append(empty(t("totpEmpty")));
			return;
		}
		// 当前标签页有绑定的条目置顶：用户十有八九是来拿这一条
		ordered = entries
			.slice()
			.sort((a, b) => Number(b.origin && b.origin === pageOrigin) - Number(a.origin && a.origin === pageOrigin));
		for (const entry of ordered) list.append(rowFor(entry));
		for (const entry of ordered) void refreshCode(entry);
		// 选中项保持（行被重建过），没了就回落到第一条：键盘操作永远有个靶子
		select(ordered.some((entry) => entry.id === selectedId) ? selectedId : ordered[0]?.id);
	}

	const exportAll = button(t("totpExportAll"), async () => {
		const { uris } = await call<{ uris: string[] }>("totp.export");
		const area = element("textarea", "pb-input");
		area.rows = 4;
		area.readOnly = true;
		area.value = uris.join("\n");
		exportArea.replaceChildren(element("p", "pb-muted", t("totpExportHint")), area);
		exportArea.hidden = false;
		area.focus();
		area.select();
	});

	container.append(
		actions(scanButton, importButton, manualButton),
		filePicker,
		editor,
		list,
		exportArea,
		exportAll,
		element("p", "pb-muted pb-totp-keys", t("totpHintKeys")),
	);
	render();

	// 键盘流：↑↓ 选行、Enter 复制、Shift+Enter 填到页面、数字键直接复制第 N 条（正在输入框里打字时不拦）
	const onKeydown = (event: KeyboardEvent): void => {
		if (stale()) {
			document.removeEventListener("keydown", onKeydown, true);
			return;
		}
		if (event.metaKey || event.ctrlKey || event.altKey) return;
		const target = event.target as HTMLElement | null;
		// 正在打字 / 焦点在按钮或链接上时一律不拦：Enter 在那些地方是原生的「点击」
		if (target && (/^(INPUT|TEXTAREA|SELECT|BUTTON|A)$/.test(target.tagName) || target.isContentEditable)) return;
		if (!ordered.length) return;
		const selected = ordered.find((entry) => entry.id === selectedId) ?? ordered[0];
		if (event.key === "ArrowDown") {
			event.preventDefault();
			selectByOffset(1);
			return;
		}
		if (event.key === "ArrowUp") {
			event.preventDefault();
			selectByOffset(-1);
			return;
		}
		if (event.key === "Enter") {
			event.preventDefault();
			void (event.shiftKey ? fillCode(selected) : copyCode(selected)).catch(reportError);
			return;
		}
		const digit = Number(event.key);
		if (Number.isInteger(digit) && digit >= 1 && digit <= 9 && ordered[digit - 1]) {
			event.preventDefault();
			select(ordered[digit - 1].id);
			void (event.shiftKey ? fillCode(ordered[digit - 1]) : copyCode(ordered[digit - 1])).catch(reportError);
		}
	};
	document.addEventListener("keydown", onKeydown, true);

	// 码到点就换：按剩余时间精确调度，进度条每秒走一格
	const timer = setInterval(() => {
		if (stale()) {
			clearInterval(timer);
			document.removeEventListener("keydown", onKeydown, true);
			return;
		}
		const now = Date.now();
		for (const entry of entries) {
			const cached = codes.get(entry.id);
			if (!cached) {
				void refreshCode(entry);
				continue;
			}
			const elapsed = now - cached.fetchedAt;
			if (elapsed >= cached.remainingMs) void refreshCode(entry);
			const left = Math.max(0, cached.remainingMs - elapsed);
			const bar = bars.get(entry.id);
			if (bar) bar.style.setProperty("--pb-totp-left", `${Math.round((left / (cached.period * 1000)) * 100)}%`);
		}
	}, 1000);
}
