import { brand, button, call, element, empty, input, notify, reportError } from "./common.js";
import { t } from "./i18n.js";
import { parseCsv, readOfficePreview, serializeCsv, type OfficePreview } from "./office-formats.js";

interface ReadFile {
	ok: boolean;
	path: string;
	name: string;
	ext: string;
	size: number;
	isText: boolean;
	content?: string;
	base64?: string;
	mimeType?: string;
	error?: string;
}
const office = location.pathname.endsWith("/office.html");
document.body.classList.add("pb-internal");
document.title = t(office ? "office" : "workspace");
const app = document.querySelector<HTMLElement>("#app")!;
const main = element("main", "pb-workspace");
const header = element("header", "pb-workspace-header");
const identity = element("div", "pb-identity");
identity.append(brand(), element("strong", "", t(office ? "office" : "workspace")));
const fileName = input("Untitled.txt");
fileName.setAttribute("aria-label", t("fileName"));
const fileStatus = element("span", "pb-muted", t("notSaved"));
const open = button(t("openFile"), () =>
	guard(() => call("files.open", { category: office ? "office" : "workspace" })),
);
const save = button(t("saveFile"), saveCurrent, "pb-primary");
const exportFile = button(t("export"), exportCurrent);
header.append(identity, fileName, fileStatus, open, save, exportFile);
const actions = element("nav", "pb-workspace-actions");
actions.append(
	button(t("newDocument"), () => guard(() => newDocument(false))),
	button(t("newSheet"), () => guard(() => newDocument(true))),
);
const sheetActions = element("div", "pb-toolbar");
sheetActions.hidden = true;
sheetActions.append(
	button(t("insertRow"), () => {
		rows.push(Array.from({ length: Math.max(1, rows[0]?.length || 1) }, () => ""));
		setDirty(true);
		renderSheet(rows, true);
	}),
	button(t("insertColumn"), () => {
		rows.forEach((row) => row.push(""));
		setDirty(true);
		renderSheet(rows, true);
	}),
);
actions.append(sheetActions);
const confirmation = element("div", "pb-file-confirm");
confirmation.hidden = true;
const body = element("section", "pb-document-body");
const footer = element("footer", "pb-workspace-footer pb-muted");
main.append(header, actions, confirmation, body, footer);
app.append(main);
let path = "";
let extension = ".txt";
let dirty = false;
let editable = true;
let content = "";
let rows: string[][] = [];
let objectUrl = "";
let sheetMode = false;
let pendingGuard: (() => Promise<unknown> | unknown) | undefined;
function setDirty(value: boolean): void {
	dirty = value;
	fileStatus.textContent = dirty ? t("changed") : path ? t("saved") : t("notSaved");
	document.title = `${dirty ? "● " : ""}${fileName.value} · ${t(office ? "office" : "workspace")}`;
}
async function guard(action: () => Promise<unknown> | unknown): Promise<void> {
	if (!dirty) {
		await action();
		return;
	}
	pendingGuard = action;
	confirmation.hidden = false;
	confirmation.replaceChildren(
		element("span", "", t("unsaved")),
		button(t("save"), async () => {
			const next = pendingGuard;
			await saveCurrent();
			if (!dirty) {
				confirmation.hidden = true;
				pendingGuard = undefined;
				await next?.();
			}
		}),
		button(t("discard"), async () => {
			const next = pendingGuard;
			pendingGuard = undefined;
			confirmation.hidden = true;
			setDirty(false);
			await next?.();
		}),
		button(t("keepEditing"), () => {
			pendingGuard = undefined;
			confirmation.hidden = true;
		}),
	);
}
function clearObjectUrl(): void {
	if (objectUrl) {
		URL.revokeObjectURL(objectUrl);
		objectUrl = "";
	}
}
function newDocument(sheet: boolean): void {
	clearObjectUrl();
	path = "";
	extension = sheet ? ".csv" : ".txt";
	fileName.value = `Untitled${extension}`;
	editable = true;
	content = "";
	rows = [
		["", "", ""],
		["", "", ""],
		["", "", ""],
	];
	sheetMode = sheet;
	save.disabled = false;
	exportFile.disabled = false;
	sheetActions.hidden = !sheet;
	setDirty(false);
	if (sheet) renderSheet(rows, true);
	else renderText("");
}
function updateFooter(): void {
	footer.textContent = `${path || t("notSaved")} · ${sheetMode ? `${rows.length} × ${rows.reduce((max, row) => Math.max(max, row.length), 0)}` : `${content.length.toLocaleString()} ${t("documentStats")}`}`;
}
function renderText(value: string): void {
	sheetMode = false;
	sheetActions.hidden = true;
	const textarea = element("textarea", "pb-text-editor");
	textarea.value = value;
	textarea.spellcheck = false;
	textarea.setAttribute("aria-label", t("editor"));
	textarea.readOnly = !editable;
	textarea.addEventListener("input", () => {
		content = textarea.value;
		setDirty(true);
		updateFooter();
	});
	textarea.addEventListener("keydown", (event) => {
		if (event.key === "Tab" && editable) {
			event.preventDefault();
			const start = textarea.selectionStart;
			textarea.setRangeText("  ", start, textarea.selectionEnd, "end");
			content = textarea.value;
			setDirty(true);
			updateFooter();
		}
	});
	body.replaceChildren(textarea);
	updateFooter();
}
function renderSheet(data: string[][], canEdit: boolean): void {
	const wrap = element("div", "pb-sheet-wrap");
	const table = element("table", "pb-sheet");
	const columns = Math.min(
		256,
		data.reduce((max, row) => Math.max(max, row.length), 1),
	);
	const thead = element("thead");
	const headers = element("tr");
	headers.append(element("th", "", "#"));
	for (let index = 0; index < columns; index++) {
		let name = "";
		let value = index + 1;
		while (value) {
			name = String.fromCharCode(65 + ((value - 1) % 26)) + name;
			value = Math.floor((value - 1) / 26);
		}
		headers.append(element("th", "", name));
	}
	thead.append(headers);
	const tbody = element("tbody");
	data.slice(0, Math.min(5000, Math.floor(30000 / columns))).forEach((row, rowIndex) => {
		const tr = element("tr");
		const rowHeader = element("th", "", String(rowIndex + 1));
		rowHeader.scope = "row";
		tr.append(rowHeader);
		for (let column = 0; column < columns; column++) {
			const td = element("td");
			if (canEdit) {
				const cell = input(row[column] || "");
				cell.setAttribute("aria-label", `${rowIndex + 1}, ${column + 1}`);
				cell.addEventListener("input", () => {
					rows[rowIndex][column] = cell.value;
					setDirty(true);
				});
				td.append(cell);
			} else td.textContent = row[column] || "";
			tr.append(td);
		}
		tbody.append(tr);
	});
	table.append(thead, tbody);
	wrap.append(table);
	body.replaceChildren(wrap);
	updateFooter();
}
function renderOffice(preview: OfficePreview): void {
	editable = false;
	save.disabled = true;
	exportFile.disabled = true;
	sheetActions.hidden = true;
	if (preview.kind === "document") {
		const page = element("article", "pb-office-page");
		for (const paragraph of preview.paragraphs || []) page.append(element("p", "", paragraph || "\u00a0"));
		body.replaceChildren(page);
	} else if (preview.kind === "slides") {
		const deck = element("div", "pb-slides");
		(preview.slides || []).forEach((slide, index) => {
			const card = element("article", "pb-slide");
			card.append(element("span", "pb-muted", String(index + 1)));
			slide.forEach((text, line) => card.append(element(line === 0 ? "h2" : "p", "", text)));
			deck.append(card);
		});
		body.replaceChildren(deck);
	} else {
		const tabs = element("nav", "pb-toolbar");
		for (const sheet of preview.sheets || [])
			tabs.append(
				button(sheet.name, () => {
					renderSheet(sheet.rows, false);
					body.prepend(tabs);
				}),
			);
		if (preview.sheets?.length) renderSheet(preview.sheets[0].rows, false);
		else body.replaceChildren(empty());
		body.prepend(tabs);
	}
	body.prepend(element("p", "pb-muted", t("previewHelp")));
	footer.textContent = `${path} · ${t("previewOnly")}`;
}
function fileBlob(file: ReadFile): Blob {
	const bytes = Uint8Array.from(atob(file.base64 || ""), (char) => char.charCodeAt(0));
	const mime =
		(
			{
				".pdf": "application/pdf",
				".png": "image/png",
				".jpg": "image/jpeg",
				".jpeg": "image/jpeg",
				".gif": "image/gif",
				".webp": "image/webp",
				".bmp": "image/bmp",
				".mp3": "audio/mpeg",
				".wav": "audio/wav",
				".ogg": "audio/ogg",
				".flac": "audio/flac",
				".m4a": "audio/mp4",
				".mp4": "video/mp4",
				".webm": "video/webm",
				".mov": "video/quicktime",
			} as Record<string, string>
		)[extension] || "application/octet-stream";
	return new Blob([bytes], { type: mime });
}
async function loadFile(filePath: string): Promise<void> {
	body.replaceChildren(empty(t("loading")));
	const file = await call<ReadFile>("files.read", { path: filePath });
	if (!file.ok) throw new Error(file.error || t("error"));
	clearObjectUrl();
	path = file.path || filePath;
	fileName.value = file.name || path.split(/[\\/]/).pop() || t("untitled");
	extension = (file.ext || `.${fileName.value.split(".").pop()}`).toLowerCase();
	editable = file.isText;
	save.disabled = !editable;
	exportFile.disabled = !editable;
	content = file.content || "";
	setDirty(false);
	sheetMode = false;
	if ([".docx", ".xlsx", ".pptx"].includes(extension) && file.base64) {
		try {
			renderOffice(await readOfficePreview(file.base64, extension));
		} catch {
			throw new Error(t("archiveError"));
		}
		return;
	}
	if (file.isText) {
		sheetMode = extension === ".csv" || extension === ".tsv";
		if (sheetMode) {
			rows = parseCsv(content, extension === ".tsv" ? "\t" : ",");
			const cells = rows.reduce((total, row) => total + row.length, 0);
			if (rows.length <= 5000 && cells <= 30000 && rows.every((row) => row.length <= 256)) {
				sheetActions.hidden = false;
				renderSheet(rows, true);
			} else renderText(content);
		} else renderText(content);
		return;
	}
	sheetActions.hidden = true;
	body.replaceChildren();
	if (!file.base64) {
		body.append(empty(t("unsupportedPreview")));
		return;
	}
	objectUrl = URL.createObjectURL(fileBlob(file));
	if (/^\.(png|jpe?g|gif|webp|bmp)$/.test(extension)) {
		const image = element("img", "pb-media-image");
		image.alt = file.name;
		image.src = objectUrl;
		body.append(image);
	} else if (/^\.(mp3|wav|ogg|flac|m4a|mp4|webm|mov)$/.test(extension)) {
		const media = /\.(mp4|webm|mov)$/.test(extension) ? element("video", "pb-media") : element("audio", "pb-media");
		media.controls = true;
		media.src = objectUrl;
		body.append(media);
	} else if (extension === ".pdf") {
		const frame = element("iframe", "pb-pdf");
		frame.title = file.name;
		frame.src = objectUrl;
		body.append(frame);
	} else body.append(empty(t("unsupported")));
	footer.textContent = `${path} · ${(file.size / 1024).toFixed(1)} KB`;
}
function currentContent(): string {
	return sheetMode ? serializeCsv(rows, extension === ".tsv" ? "\t" : ",") : content;
}
async function saveCurrent(): Promise<void> {
	if (!editable) return;
	if (!path) {
		const result = await call<{ ok?: boolean; path?: string; name?: string } | null>("files.save", {
			path: fileName.value,
			saveAs: true,
			content: currentContent(),
		});
		if (result?.path) {
			path = result.path;
			if (result.name) fileName.value = result.name;
			extension = `.${path.split(".").pop()?.toLowerCase()}`;
			setDirty(false);
			notify(t("saved"));
			updateFooter();
		}
		return;
	}
	const result = await call<{ ok: boolean; error?: string }>("files.save", { path, content: currentContent() });
	if (!result.ok) throw new Error(result.error || t("error"));
	setDirty(false);
	notify(t("saved"));
	updateFooter();
}
function exportCurrent(): void {
	const blob = new Blob([currentContent()], { type: "text/plain;charset=utf-8" });
	const url = URL.createObjectURL(blob);
	const anchor = element("a");
	anchor.href = url;
	anchor.download = fileName.value || `Untitled${extension}`;
	anchor.click();
	setTimeout(() => URL.revokeObjectURL(url), 1000);
}
fileName.addEventListener("input", () => {
	if (!path) setDirty(true);
});
window.addEventListener("beforeunload", (event) => {
	if (dirty) {
		event.preventDefault();
		event.returnValue = "";
	}
});
window.addEventListener("pagehide", clearObjectUrl);
window.addEventListener("keydown", (event) => {
	if (!(event.ctrlKey || event.metaKey)) return;
	if (event.key.toLowerCase() === "s") {
		event.preventDefault();
		void saveCurrent().catch(reportError);
	}
	if (event.key.toLowerCase() === "o") {
		event.preventDefault();
		void guard(() => call("files.open", { category: office ? "office" : "workspace" })).catch(reportError);
	}
});
const initialPath =
	new URLSearchParams(location.search).get("path") || new URLSearchParams(location.search).get("file");
if (initialPath)
	void loadFile(initialPath).catch((error) => {
		body.replaceChildren(
			empty(error instanceof Error ? error.message : t("error")),
			button(t("retry"), () => loadFile(initialPath)),
		);
		reportError(error);
	});
else {
	const welcome = element("div", "pb-workspace-welcome");
	welcome.append(
		brand(),
		element("h1", "", t(office ? "office" : "workspace")),
		element("p", "pb-muted", t(office ? "fileHelp" : "workspaceHelp")),
		button(t("openFile"), () => call("files.open", { category: office ? "office" : "workspace" }), "pb-primary"),
		element("p", "pb-muted", "DOCX · XLSX · PPTX · TXT · MD · CSV · PDF · PNG · MP3 · MP4"),
	);
	body.append(welcome);
	save.disabled = true;
	exportFile.disabled = true;
}
