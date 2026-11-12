/**
 * 凭据保险库面板（工具栏钥匙图标 → 「凭据保险库」）。
 *
 * 一个面板、两个分段标签：**密码** 与 **TOTP**。两者在用户眼里是同一件事（"这个网站的凭据"），
 * 所以共用同一套交互：顶部图标工具条 → 先选中条目 → 再点图标操作。
 *
 * 两条安全边界（别打破）：
 * - **TOTP secret 永不出主进程**：这里拿到的是 `PublicTotpEntry`（无 secret），要码就发
 *   `totp.code { id }` 让主进程算；导出（`totp.export`）是唯一把 otpauth URI 带出来的出口。
 * - **密码明文按需揭示**：`passwords.list` 只下发投影（`hasPassword`，没有 password），
 *   点「显示密码」才走 `passwords.reveal { id }` 取一次明文，10 秒后自动盖回；
 *   写回只走 `passwords.upsert / remove`，渲染层从不持有整份明文列表。
 *
 * 条目里唯一的按钮是行右侧那串「验证码 / 密码」：点它 = 复制。其余动作都在顶栏。
 */
import {
	button,
	call,
	createSvg,
	editIcon,
	element,
	empty,
	hostName,
	input,
	label,
	notify,
	reportError,
	svgCircle,
	svgPath,
	svgRect,
	webUrl,
} from "./common.js";
import type { BrowserState } from "../contracts.js";
import { t } from "./i18n.js";

export type VaultTab = "passwords" | "totp";

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

/** 与主进程 `passwords.list` 的投影对齐（没有明文密码）。 */
interface CredentialSummary {
	id: string;
	name: string;
	url: string;
	username: string;
	createdAt: string;
	hasPassword: boolean;
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

/* --------------------------------- 工具图标 ---------------------------------
   16×16 描边图标，与外壳其它图标同口径（stroke: currentColor，线宽 1.2）。 */

function scanToolIcon(): SVGSVGElement {
	return createSvg(16, 16, "0 0 16 16", [
		svgPath("M3 6.2V4.6A1.6 1.6 0 0 1 4.6 3h1.6", "1.2"),
		svgPath("M9.8 3h1.6A1.6 1.6 0 0 1 13 4.6v1.6", "1.2"),
		svgPath("M13 9.8v1.6A1.6 1.6 0 0 1 11.4 13H9.8", "1.2"),
		svgPath("M6.2 13H4.6A1.6 1.6 0 0 1 3 11.4V9.8", "1.2"),
		svgPath("M2.6 8h10.8", "1.2"),
	]);
}

function imageToolIcon(): SVGSVGElement {
	return createSvg(16, 16, "0 0 16 16", [
		svgRect(2, 3, 12, 10, 2, "1.2"),
		svgCircle(6, 6.4, 1.05, "0", "currentColor"),
		svgPath("M2.7 11.5l3-2.7a1.3 1.3 0 0 1 1.7 0l3.5 3.2", "1.2"),
	]);
}

function plusToolIcon(): SVGSVGElement {
	return createSvg(16, 16, "0 0 16 16", [svgPath("M8 3.2v9.6M3.2 8h9.6", "1.3")]);
}

function fillToolIcon(): SVGSVGElement {
	return createSvg(16, 16, "0 0 16 16", [
		svgPath("M2.4 8h7.4", "1.2"),
		svgPath("M7.2 5L10.2 8l-3 3", "1.2"),
		svgPath("M12.6 3.4v9.2", "1.2"),
	]);
}

function eyeToolIcon(open: boolean): SVGSVGElement {
	return open
		? createSvg(16, 16, "0 0 16 16", [
				svgPath("M1.8 8s2.4-4.2 6.2-4.2S14.2 8 14.2 8 11.8 12.2 8 12.2 1.8 8 1.8 8z", "1.2"),
				svgCircle(8, 8, 2.1, "1.2"),
			])
		: createSvg(16, 16, "0 0 16 16", [
				svgPath("M1.8 8s2.4-4.2 6.2-4.2c1.2 0 2.2.4 3.1 1", "1.2"),
				svgPath("M14.2 8s-2.4 4.2-6.2 4.2c-1.2 0-2.2-.4-3.1-1", "1.2"),
				svgPath("M2.4 2.6l11.2 10.8", "1.2"),
			]);
}

function exportToolIcon(): SVGSVGElement {
	return createSvg(16, 16, "0 0 16 16", [
		svgPath("M8 10.4V3.2", "1.2"),
		svgPath("M5.4 5.8L8 3.2l2.6 2.6", "1.2"),
		svgPath("M3.5 10.2v1.6A1.6 1.6 0 0 0 5.1 13.4h5.8a1.6 1.6 0 0 0 1.6-1.6v-1.6", "1.2"),
	]);
}

function exportAllToolIcon(): SVGSVGElement {
	return createSvg(16, 16, "0 0 16 16", [
		svgPath("M6 8.6V3.1", "1.2"),
		svgPath("M4.3 4.8L6 3.1l1.7 1.7", "1.2"),
		svgPath("M10 8.6V3.1", "1.2"),
		svgPath("M8.3 4.8L10 3.1l1.7 1.7", "1.2"),
		svgPath("M3.2 10.4v1.6A1.4 1.4 0 0 0 4.6 13.4h6.8a1.4 1.4 0 0 0 1.4-1.4v-1.6", "1.2"),
	]);
}

function moveToolIcon(direction: "up" | "down"): SVGSVGElement {
	return direction === "up"
		? createSvg(16, 16, "0 0 16 16", [svgPath("M8 12.6V3.4", "1.2"), svgPath("M4.8 6.6L8 3.4l3.2 3.2", "1.2")])
		: createSvg(16, 16, "0 0 16 16", [svgPath("M8 3.4v9.2", "1.2"), svgPath("M4.8 9.4L8 12.6l3.2-3.2", "1.2")]);
}

function trashToolIcon(): SVGSVGElement {
	return createSvg(16, 16, "0 0 16 16", [
		svgPath("M2.8 4.6h10.4", "1.2"),
		svgPath("M6.3 4.6V3.3a.9.9 0 0 1 .9-.9h1.6a.9.9 0 0 1 .9.9v1.3", "1.2"),
		svgPath("M4.7 4.6l.6 8.1a1.3 1.3 0 0 0 1.3 1.2h2.8a1.3 1.3 0 0 0 1.3-1.2l.6-8.1", "1.2"),
	]);
}

/**
 * 图标工具按钮：名字走 `data-tip` 的 CSS 悬浮提示（`title` 留空，避免原生提示叠加一层）。
 * `data-tip-end` 让提示贴右对齐，免得最后几个图标的气泡被浮层圆角裁掉。
 */
function toolButton(
	icon: Node,
	tip: string,
	onClick: () => void | Promise<unknown>,
	options: { end?: boolean } = {},
): HTMLButtonElement {
	const node = button(icon, onClick, "pb-icon-button pb-vault-tool");
	node.dataset.tip = tip;
	if (options.end) node.dataset.tipEnd = "";
	node.setAttribute("aria-label", tip);
	return node;
}

/** 打开/刷新面板：每次都重新渲染（条目数不多，简单胜过增量 diff）。 */
export async function vaultPanel(
	container: HTMLElement,
	onChange: () => void,
	header?: HTMLElement,
	options: { tab?: VaultTab } = {},
): Promise<void> {
	const token = ++panelToken;
	const stale = () => token !== panelToken || !container.isConnected;
	container.replaceChildren();

	// 工具条挂在面板标题栏的动作槽里；没有标题栏（独立视图 / 单测）就落在内容区顶部
	const tools = element("div", "pb-vault-tools");
	if (header) header.replaceChildren(tools);
	else container.append(tools);

	const available = await call<boolean>("passwords.available").catch(() => false);
	const totpAvailable = await call<boolean>("totp.available").catch(() => false);
	if (!available && !totpAvailable) {
		container.append(element("p", "pb-muted", t("vaultUnavailable")));
		return;
	}

	const state = await call<BrowserState>("state").catch(() => undefined);
	const pageUrl = state?.tabs.find((tab) => tab.id === state.activeTabId)?.url;
	const pageOrigin = originOf(pageUrl);

	/* ------------------------------- 状态 ------------------------------- */

	let activeTab: VaultTab =
		options.tab && (options.tab === "passwords" ? available : totpAvailable) ? options.tab : "passwords";
	let credentials: CredentialSummary[] = [];
	let totpEntries: PublicTotpEntry[] = [];
	let orderedTotp: PublicTotpEntry[] = [];
	const codes = new Map<string, CodeState>();
	const rows = new Map<string, HTMLElement>();
	const links = new Map<string, HTMLButtonElement>();
	const bars = new Map<string, HTMLElement>();
	const seconds = new Map<string, HTMLElement>();
	const secrets = new Map<string, HTMLButtonElement>();
	let selectedPasswordId: string | undefined;
	let selectedTotpId: string | undefined;
	let editingPasswordId: string | undefined;
	let revealTimer: ReturnType<typeof setTimeout> | undefined;

	const selectedPassword = (): CredentialSummary | undefined =>
		credentials.find((entry) => entry.id === selectedPasswordId);
	const selectedTotp = (): PublicTotpEntry | undefined => orderedTotp.find((entry) => entry.id === selectedTotpId);
	const selectedEntry = (): CredentialSummary | PublicTotpEntry | undefined =>
		activeTab === "passwords" ? selectedPassword() : selectedTotp();

	/* ------------------------------ 骨架 ------------------------------ */

	const tabBar = element("div", "pb-vault-tabs");
	const passwordTabButton = element("button", "pb-vault-tab", t("vaultTabPasswords"));
	const totpTabButton = element("button", "pb-vault-tab", t("vaultTabTotp"));
	passwordTabButton.type = "button";
	totpTabButton.type = "button";
	const passwordCount = element("span", "pb-vault-count");
	const totpCount = element("span", "pb-vault-count");
	passwordTabButton.append(passwordCount);
	totpTabButton.append(totpCount);
	tabBar.append(passwordTabButton, totpTabButton);

	const list = element("div", "pb-list pb-vault-list");
	const exportArea = element("div", "pb-vault-export");
	exportArea.hidden = true;
	const hint = element("p", "pb-muted pb-vault-keys", t("vaultHintKeys"));

	/* --------------------------- 密码：表单与动作 --------------------------- */

	const passwordForm = element("form", "pb-form pb-editor-inline");
	passwordForm.hidden = true;
	const nameField = input();
	const urlField = input("", "url");
	const userField = input();
	userField.autocomplete = "off";
	const secretField = input("", "password");
	secretField.autocomplete = "new-password";
	const secretToggle = button(t("showPassword"), () => {
		const show = secretField.type === "password";
		secretField.type = show ? "text" : "password";
		secretToggle.textContent = t(show ? "hidePassword" : "showPassword");
	});
	const passwordSubmit = button(t("save"), () => {}, "pb-primary");
	passwordSubmit.type = "submit";
	const passwordFormButtons = element("div", "pb-vault-form-actions");
	passwordFormButtons.append(
		secretToggle,
		passwordSubmit,
		button(t("cancel"), () => closePasswordForm()),
	);
	passwordForm.append(
		label(t("name"), nameField),
		label(t("url"), urlField),
		label(t("username"), userField),
		label(t("password"), secretField),
		passwordFormButtons,
	);

	function closePasswordForm(): void {
		passwordForm.hidden = true;
		editingPasswordId = undefined;
		passwordForm.reset();
		secretField.value = "";
		secretField.type = "password";
		secretToggle.textContent = t("showPassword");
	}

	function openPasswordForm(entry?: CredentialSummary): void {
		editingPasswordId = entry?.id;
		nameField.value = entry?.name ?? "";
		urlField.value = entry?.url ?? pageOrigin;
		userField.value = entry?.username ?? "";
		secretField.value = "";
		secretField.placeholder = entry ? t("passwordKeep") : "";
		passwordForm.hidden = false;
		nameField.focus();
	}

	passwordForm.addEventListener("submit", (event) => {
		event.preventDefault();
		void (async () => {
			const normalized = webUrl(urlField.value.trim());
			if (!nameField.value.trim() || !normalized || !userField.value.trim()) throw new Error(t("credentialRequired"));
			if (!editingPasswordId && !secretField.value) throw new Error(t("credentialRequired"));
			await call("passwords.upsert", {
				id: editingPasswordId,
				name: nameField.value.trim(),
				url: normalized,
				username: userField.value.trim(),
				password: secretField.value,
			});
			await loadCredentials();
			closePasswordForm();
			render();
			onChange();
			notify(t("saved"));
		})().catch(reportError);
	});

	async function loadCredentials(): Promise<void> {
		credentials = await call<CredentialSummary[]>("passwords.list");
	}

	let revealedEver = false;

	function hideRevealed(): void {
		clearTimeout(revealTimer);
		for (const [id, node] of secrets) {
			const entry = credentials.find((item) => item.id === id);
			node.textContent = "•".repeat(10);
			node.classList.remove("pb-vault-revealed");
			if (entry) node.title = t("showPassword");
		}
		if (revealedEver) syncTools();
	}

	async function revealPassword(entry: CredentialSummary): Promise<void> {
		const node = secrets.get(entry.id);
		if (!node) return;
		if (node.classList.contains("pb-vault-revealed")) {
			hideRevealed();
			return;
		}
		const { password } = await call<{ password: string }>("passwords.reveal", { id: entry.id });
		hideRevealed();
		node.textContent = password;
		node.classList.add("pb-vault-revealed");
		revealedEver = true;
		syncTools();
		notify(t("passwordRevealed"));
		// 明文只在屏幕上停 10 秒：演示/同事路过时不该一直亮着
		revealTimer = setTimeout(() => {
			if (!stale()) hideRevealed();
		}, 10_000);
	}

	async function removePassword(entry: CredentialSummary): Promise<void> {
		await call("passwords.remove", { id: entry.id });
		await loadCredentials();
		render();
		onChange();
		notify(t("saved"));
	}

	async function fillPassword(entry: CredentialSummary): Promise<void> {
		await call("passwords.fill", { id: entry.id });
		notify(t("credentialFilled"));
	}

	/* ------------------------------- TOTP：动作 ------------------------------- */

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
					openTotpForm(uri, "");
					notify(t("totpScanned"));
				} catch (error) {
					notify(t("totpImportFailed"), true);
					reportError(error);
				}
			})();
		};
		reader.readAsDataURL(file);
	});

	const totpForm = element("form", "pb-form pb-editor-inline");
	totpForm.hidden = true;
	const uriField = element("textarea", "pb-input");
	uriField.rows = 2;
	uriField.placeholder = t("totpManualPlaceholder");
	uriField.spellcheck = false;
	const totpLabelField = input();
	const totpOriginField = input();
	const totpSubmit = button(t("totpAdd"), () => {}, "pb-primary");
	totpSubmit.type = "submit";
	const totpFormButtons = element("div", "pb-vault-form-actions");
	totpFormButtons.append(
		totpSubmit,
		button(t("cancel"), () => {
			totpForm.hidden = true;
			totpForm.reset();
			uriField.value = "";
		}),
	);
	totpForm.append(
		label(t("totpManual"), uriField),
		label(t("name"), totpLabelField),
		label(t("totpBound"), totpOriginField),
		totpFormButtons,
	);

	function openTotpForm(uri: string, origin: string): void {
		uriField.value = uri;
		totpOriginField.value = origin;
		totpLabelField.value = "";
		totpForm.hidden = false;
		uriField.focus();
	}

	totpForm.addEventListener("submit", (event) => {
		event.preventDefault();
		void (async () => {
			totpEntries = await call<PublicTotpEntry[]>("totp.add", {
				uri: uriField.value.trim(),
				label: totpLabelField.value.trim(),
				origin: totpOriginField.value.trim() || undefined,
			});
			totpForm.hidden = true;
			totpForm.reset();
			uriField.value = "";
			render();
			onChange();
			notify(t("saved"));
		})().catch(reportError);
	});

	async function copyTotpCode(entry: PublicTotpEntry): Promise<void> {
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

	async function fillTotp(entry: PublicTotpEntry): Promise<void> {
		await call("totp.fill", { id: entry.id });
		notify(t("totpFilled"));
	}

	async function exportTotpOne(entry: PublicTotpEntry): Promise<void> {
		const { uris } = await call<{ uris: string[] }>("totp.export");
		await copyText(uris[totpEntries.findIndex((item) => item.id === entry.id)] ?? "");
		notify(t("totpCopied"));
	}

	async function exportTotpAll(): Promise<void> {
		const { uris } = await call<{ uris: string[] }>("totp.export");
		const area = element("textarea", "pb-input");
		area.rows = 4;
		area.readOnly = true;
		area.value = uris.join("\n");
		exportArea.replaceChildren(element("p", "pb-muted", t("totpExportHint")), area);
		exportArea.hidden = false;
		area.focus();
		area.select();
	}

	async function moveTotp(entry: PublicTotpEntry, delta: number): Promise<void> {
		const index = totpEntries.findIndex((item) => item.id === entry.id);
		const target = index + delta;
		if (index < 0 || target < 0 || target >= totpEntries.length) return;
		const ids = totpEntries.map((item) => item.id);
		[ids[index], ids[target]] = [ids[target], ids[index]];
		totpEntries = await call<PublicTotpEntry[]>("totp.reorder", { ids });
		render();
		onChange();
	}

	async function refreshCode(entry: PublicTotpEntry): Promise<void> {
		try {
			const result = await call<CodeResponse>("totp.code", { id: entry.id });
			if (stale()) return;
			codes.set(entry.id, { ...result, fetchedAt: Date.now() });
			const link = links.get(entry.id);
			if (link) link.textContent = result.code;
			const secs = seconds.get(entry.id);
			if (secs) secs.textContent = `${Math.ceil(result.remainingMs / 1000)}s`;
			rows.get(entry.id)?.classList.remove("pb-totp-error");
		} catch {
			if (stale()) return;
			codes.delete(entry.id);
			const link = links.get(entry.id);
			if (link) link.textContent = "—";
			const secs = seconds.get(entry.id);
			if (secs) secs.textContent = "";
			rows.get(entry.id)?.classList.add("pb-totp-error");
		}
	}

	/* ------------------------------ 工具条 ------------------------------ */

	const separator = (): HTMLElement => element("span", "pb-vault-sep");
	const passwordGroup = element("div", "pb-vault-group");
	const totpGroup = element("div", "pb-vault-group");
	const refreshRevealIcon = (): void => {
		const open = Boolean(
			selectedPassword() && secrets.get(selectedPasswordId ?? "")?.classList.contains("pb-vault-revealed"),
		);
		revealButton.replaceChildren(eyeToolIcon(open));
	};

	const addPasswordButton = toolButton(plusToolIcon(), t("addCredential"), () => openPasswordForm());
	const fillPasswordButton = toolButton(fillToolIcon(), t("fillCredential"), () => {
		const entry = selectedPassword();
		if (entry) void fillPassword(entry).catch(reportError);
	});
	const revealButton = toolButton(eyeToolIcon(false), t("showPassword"), () => {
		const entry = selectedPassword();
		if (entry) void revealPassword(entry).catch(reportError);
	});
	const editPasswordButton = toolButton(editIcon(13), t("edit"), () => {
		const entry = selectedPassword();
		if (entry) openPasswordForm(entry);
	});
	const removePasswordButton = toolButton(
		trashToolIcon(),
		t("removeCredential"),
		() => {
			const entry = selectedPassword();
			if (!entry) return;
			const row = rows.get(entry.id);
			if (!row) return;
			const confirmation = element("div", "pb-confirm");
			confirmation.append(
				element("span", "", t("credentialRemoveConfirm")),
				button(t("yesDelete"), () => void removePassword(entry).catch(reportError)),
				button(t("cancel"), render),
			);
			row.replaceChildren(confirmation);
		},
		{ end: true },
	);

	passwordGroup.append(
		addPasswordButton,
		separator(),
		fillPasswordButton,
		revealButton,
		editPasswordButton,
		removePasswordButton,
	);

	const scanButton = toolButton(scanToolIcon(), t("totpScan"), async () => {
		scanButton.disabled = true;
		scanButton.dataset.tip = t("totpScanning");
		scanButton.setAttribute("aria-label", t("totpScanning"));
		try {
			const { url, uri } = await call<{ url: string; uri: string }>("totp.scan");
			openTotpForm(uri, originOf(url));
			notify(t("totpScanned"));
		} catch (error) {
			notify(t("totpScanFailed"), true);
			reportError(error);
		} finally {
			scanButton.dataset.tip = t("totpScan");
			scanButton.setAttribute("aria-label", t("totpScan"));
			syncTools();
		}
	});
	const importButton = toolButton(imageToolIcon(), t("totpImport"), () => filePicker.click());
	const addTotpButton = toolButton(plusToolIcon(), t("addCredential"), () => openTotpForm("", pageOrigin));
	const fillTotpButton = toolButton(fillToolIcon(), t("totpFill"), () => {
		const entry = selectedTotp();
		if (entry) void fillTotp(entry).catch(reportError);
	});
	const exportButton = toolButton(exportToolIcon(), t("totpExportOne"), () => {
		const entry = selectedTotp();
		if (entry) void exportTotpOne(entry).catch(reportError);
	});
	const exportAllButton = toolButton(
		exportAllToolIcon(),
		t("totpExportAll"),
		() => void exportTotpAll().catch(reportError),
	);
	const editTotpButton = toolButton(editIcon(13), t("edit"), () => {
		const entry = selectedTotp();
		if (!entry) return;
		const row = rows.get(entry.id);
		if (!row) return;
		const form = element("form", "pb-form");
		const editName = input(entry.label);
		const editSite = input(entry.origin, "text");
		const save = button(t("save"), () => {}, "pb-primary");
		save.type = "submit";
		const buttons = element("div", "pb-vault-form-actions");
		buttons.append(
			save,
			button(t("cancel"), () => render()),
		);
		form.append(label(t("name"), editName), label(t("totpBound"), editSite), buttons);
		form.addEventListener("submit", (event) => {
			event.preventDefault();
			void (async () => {
				totpEntries = await call<PublicTotpEntry[]>("totp.update", {
					id: entry.id,
					label: editName.value.trim(),
					origin: editSite.value.trim(),
				});
				render();
				onChange();
				notify(t("saved"));
			})().catch(reportError);
		});
		row.replaceChildren(form);
		editName.focus();
	});
	const upButton = toolButton(moveToolIcon("up"), t("totpMoveUp"), () => {
		const entry = selectedTotp();
		if (entry) void moveTotp(entry, -1).catch(reportError);
	});
	const downButton = toolButton(moveToolIcon("down"), t("totpMoveDown"), () => {
		const entry = selectedTotp();
		if (entry) void moveTotp(entry, 1).catch(reportError);
	});
	const removeTotpButton = toolButton(
		trashToolIcon(),
		t("removeCredential"),
		() => {
			const entry = selectedTotp();
			if (!entry) return;
			const row = rows.get(entry.id);
			if (!row) return;
			const confirmation = element("div", "pb-confirm");
			confirmation.append(
				element("span", "", t("totpRemoveConfirm")),
				button(t("yesDelete"), () => {
					void (async () => {
						totpEntries = await call<PublicTotpEntry[]>("totp.remove", { id: entry.id });
						codes.delete(entry.id);
						render();
						onChange();
					})().catch(reportError);
				}),
				button(t("cancel"), render),
			);
			row.replaceChildren(confirmation);
		},
		{ end: true },
	);

	totpGroup.append(
		scanButton,
		importButton,
		addTotpButton,
		separator(),
		fillTotpButton,
		exportButton,
		exportAllButton,
		editTotpButton,
		upButton,
		downButton,
		removeTotpButton,
	);

	tools.append(passwordGroup, totpGroup);

	/** 没选中行 / 已在首尾时把动作图标置灰（置灰 = 点了没反应，不让用户猜）。 */
	function syncTools(): void {
		passwordGroup.hidden = activeTab !== "passwords";
		totpGroup.hidden = activeTab !== "totp";
		const hasPassword = !!selectedPassword();
		for (const node of [fillPasswordButton, revealButton, editPasswordButton, removePasswordButton])
			node.disabled = !hasPassword;
		const index = orderedTotp.findIndex((entry) => entry.id === selectedTotpId);
		const hasTotp = index >= 0;
		for (const node of [fillTotpButton, exportButton, exportAllButton, editTotpButton, removeTotpButton])
			node.disabled = !hasTotp;
		// 扫码进行中不要被这里重新启用（它自己的 finally 会恢复）
		scanButton.disabled = scanButton.dataset.tip === t("totpScanning");
		upButton.disabled = !hasTotp || index === 0;
		downButton.disabled = !hasTotp || index >= orderedTotp.length - 1;
		refreshRevealIcon();
	}

	/* ------------------------------ 选中态 ------------------------------ */

	function selectPassword(id: string | undefined): void {
		selectedPasswordId = id;
		for (const [entryId, row] of rows) {
			if (!row.classList.contains("pb-vault-item-password")) continue;
			row.classList.toggle("pb-vault-selected", entryId === id);
		}
		syncTools();
	}

	function selectTotp(id: string | undefined): void {
		selectedTotpId = id;
		for (const [entryId, row] of rows) {
			if (!row.classList.contains("pb-vault-item-totp")) continue;
			row.classList.toggle("pb-vault-selected", entryId === id);
		}
		syncTools();
	}

	function selectByOffset(delta: number): void {
		const order =
			activeTab === "passwords" ? credentials.map((entry) => entry.id) : orderedTotp.map((entry) => entry.id);
		if (!order.length) return;
		const current = activeTab === "passwords" ? selectedPasswordId : selectedTotpId;
		const index = order.indexOf(current ?? "");
		const next =
			index < 0 ? (delta > 0 ? 0 : order.length - 1) : Math.min(order.length - 1, Math.max(0, index + delta));
		if (activeTab === "passwords") selectPassword(order[next]);
		else selectTotp(order[next]);
		rows.get(order[next])?.scrollIntoView({ block: "nearest" });
	}

	/* ------------------------------- 渲染 ------------------------------- */

	function passwordRow(entry: CredentialSummary): HTMLElement {
		const matched = !!pageOrigin && originOf(entry.url) === pageOrigin;
		const row = element("div", "pb-list-item pb-vault-item pb-vault-item-password");
		const head = element("div", "pb-vault-head");
		const title = element("div", "pb-vault-title");
		title.append(element("strong", "", entry.name));
		head.append(title);
		if (matched) head.append(element("span", "pb-vault-site", t("totpCurrentSite")));

		const secret = element("button", "pb-vault-main pb-pw-secret", "•".repeat(10));
		secret.type = "button";
		secret.title = t("showPassword");
		secrets.set(entry.id, secret);
		secret.addEventListener("click", () => {
			selectPassword(entry.id);
			void revealPassword(entry).catch(reportError);
		});
		secret.addEventListener("focus", () => selectPassword(entry.id));

		const meta = element("div", "pb-vault-meta");
		meta.append(
			element("span", "pb-muted pb-vault-account", entry.username),
			element("span", "pb-vault-origin", hostName(entry.url)),
		);

		row.addEventListener("pointerdown", () => selectPassword(entry.id));
		row.tabIndex = 0;
		row.addEventListener("focus", () => selectPassword(entry.id));
		row.append(head, secret, meta);
		rows.set(entry.id, row);
		return row;
	}

	function totpRow(entry: PublicTotpEntry): HTMLElement {
		const matched = !!entry.origin && entry.origin === pageOrigin;
		// 两行栅格：① 名称 + 站点徽标 / 验证码   ② 账号 + 站点 + 进度 + 秒数
		const row = element("div", "pb-list-item pb-vault-item pb-vault-item-totp");
		const head = element("div", "pb-vault-head");
		const title = element("div", "pb-vault-title");
		title.append(element("strong", "", entry.label));
		head.append(title);
		if (matched) head.append(element("span", "pb-vault-site", t("totpCurrentSite")));

		const code = element("button", "pb-vault-main pb-totp-code");
		code.type = "button";
		code.title = t("totpCopy");
		code.textContent = "•".repeat(entry.digits);
		links.set(entry.id, code);
		code.addEventListener("click", () => {
			selectTotp(entry.id);
			void copyTotpCode(entry).catch(reportError);
		});
		code.addEventListener("focus", () => selectTotp(entry.id));

		const meta = element("div", "pb-vault-meta");
		meta.append(element("span", "pb-muted pb-vault-account", formatAccount(entry)));
		if (entry.origin) {
			meta.append(element("span", `pb-vault-origin${matched ? " pb-vault-origin-hit" : ""}`, entry.origin));
		}
		const bar = element("span", "pb-totp-bar");
		bars.set(entry.id, bar);
		const secs = element("span", "pb-totp-secs", "—");
		seconds.set(entry.id, secs);
		meta.append(bar, secs);

		row.addEventListener("pointerdown", () => selectTotp(entry.id));
		row.tabIndex = 0;
		row.addEventListener("focus", () => selectTotp(entry.id));
		row.append(head, code, meta);
		rows.set(entry.id, row);
		return row;
	}

	function renderTabs(): void {
		passwordTabButton.classList.toggle("pb-vault-tab-on", activeTab === "passwords");
		totpTabButton.classList.toggle("pb-vault-tab-on", activeTab === "totp");
		passwordCount.textContent = String(credentials.length);
		totpCount.textContent = String(totpEntries.length);
		passwordTabButton.hidden = !available;
		totpTabButton.hidden = !totpAvailable;
		tabBar.hidden = !available || !totpAvailable;
	}

	function render(): void {
		rows.clear();
		links.clear();
		bars.clear();
		seconds.clear();
		secrets.clear();
		list.replaceChildren();
		exportArea.hidden = true;
		renderTabs();
		passwordForm.hidden = true;
		totpForm.hidden = true;
		const showingPasswords = activeTab === "passwords";
		hint.hidden = false;

		if (showingPasswords) {
			if (!credentials.length) {
				list.append(empty(t("noCredentials")));
				selectPassword(undefined);
				return;
			}
			// 当前站点的凭据置顶：用户十有八九是来填这一条
			credentials = credentials
				.slice()
				.sort((a, b) => Number(originOf(b.url) === pageOrigin) - Number(originOf(a.url) === pageOrigin));
			for (const entry of credentials) list.append(passwordRow(entry));
			selectPassword(
				credentials.some((entry) => entry.id === selectedPasswordId) ? selectedPasswordId : credentials[0]?.id,
			);
			return;
		}

		if (!totpEntries.length) {
			orderedTotp = [];
			list.append(empty(t("totpEmpty")));
			selectTotp(undefined);
			return;
		}
		orderedTotp = totpEntries
			.slice()
			.sort((a, b) => Number(b.origin && b.origin === pageOrigin) - Number(a.origin && a.origin === pageOrigin));
		for (const entry of orderedTotp) list.append(totpRow(entry));
		for (const entry of orderedTotp) void refreshCode(entry);
		selectTotp(orderedTotp.some((entry) => entry.id === selectedTotpId) ? selectedTotpId : orderedTotp[0]?.id);
	}

	function switchTab(tab: VaultTab): void {
		if (tab === activeTab) return;
		hideRevealed();
		activeTab = tab;
		render();
	}

	passwordTabButton.addEventListener("click", () => switchTab("passwords"));
	totpTabButton.addEventListener("click", () => switchTab("totp"));

	container.append(filePicker, tabBar, passwordForm, totpForm, list, exportArea, hint);

	await Promise.all([
		available ? loadCredentials() : Promise.resolve(),
		totpAvailable
			? call<PublicTotpEntry[]>("totp.list").then((value) => {
					totpEntries = value;
				})
			: Promise.resolve(),
	]);
	render();

	/* ------------------------------ 键盘流 ------------------------------ */

	const onKeydown = (event: KeyboardEvent): void => {
		if (stale()) {
			document.removeEventListener("keydown", onKeydown, true);
			return;
		}
		if (event.metaKey || event.ctrlKey || event.altKey) return;
		const target = event.target as HTMLElement | null;
		// 正在打字 / 焦点在按钮或链接上时一律不拦：Enter 在那些地方是原生的「点击」
		if (target && (/^(INPUT|TEXTAREA|SELECT|BUTTON|A)$/.test(target.tagName) || target.isContentEditable)) return;
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
			if (activeTab === "passwords") {
				const entry = selectedPassword();
				if (entry) void (event.shiftKey ? revealPassword(entry) : fillPassword(entry)).catch(reportError);
			} else {
				const entry = selectedTotp();
				if (entry) void (event.shiftKey ? fillTotp(entry) : copyTotpCode(entry)).catch(reportError);
			}
		}
	};
	document.addEventListener("keydown", onKeydown, true);

	// 码到点就换：按剩余时间精确调度，细线与秒数每秒走一格
	const timer = setInterval(() => {
		if (stale()) {
			clearInterval(timer);
			clearTimeout(revealTimer);
			document.removeEventListener("keydown", onKeydown, true);
			return;
		}
		if (activeTab !== "totp") return;
		const now = Date.now();
		for (const entry of totpEntries) {
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
			const secs = seconds.get(entry.id);
			if (secs) secs.textContent = `${Math.max(0, Math.ceil(left / 1000))}s`;
		}
	}, 1000);
}
