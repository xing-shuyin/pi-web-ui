import {
	EditorView,
	keymap,
	lineNumbers,
	highlightActiveLine,
	highlightActiveLineGutter,
	drawSelection,
	rectangularSelection,
	crosshairCursor,
	dropCursor,
	highlightSpecialChars,
} from "@codemirror/view";
import { EditorState, Compartment, Prec } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import {
	bracketMatching,
	foldGutter,
	foldKeymap,
	indentOnInput,
	indentUnit,
	syntaxHighlighting,
	defaultHighlightStyle,
} from "@codemirror/language";
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from "@codemirror/autocomplete";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { lintKeymap } from "@codemirror/lint";
import { oneDark } from "@codemirror/theme-one-dark";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import xtermCss from "@xterm/xterm/css/xterm.css";

function esc(s) {
	return String(s ?? "").replace(
		/[&<>"']/g,
		(c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
	);
}

let reqSeq = 0;

const b64 = {
	enc: (s) => btoa(unescape(encodeURIComponent(s))),
	bytes: (b64s) => Uint8Array.from(atob(b64s), (c) => c.charCodeAt(0)),
};

const shQuote = (s) => `'${String(s ?? "").replace(/'/g, "'\\''")}'`;

// ---- i18n（插件内自包含 ZH/EN 字典；注释可保留中文，用户可见字符串一律走 t()） ----
const VSC_LANG_KEY = "vsc-editor-lang";
const HOST_LANG_KEY = "pi-web-ui:lang";
const UI_LOCALE_EVENT = "pi-web-ui:locale";
function normalizeLangTag(v) {
	const s = String(v ?? "")
		.trim()
		.toLowerCase()
		.replace(/_/g, "-");
	if (!s) return null;
	if (s === "zh" || s.startsWith("zh-")) return "zh";
	if (s === "en" || s.startsWith("en-")) return "en";
	return null;
}
function readHostLang() {
	try {
		return normalizeLangTag(localStorage.getItem(HOST_LANG_KEY));
	} catch {
		return null;
	}
}
function hasPluginLangOverride() {
	try {
		const v = localStorage.getItem(VSC_LANG_KEY);
		return v === "zh" || v === "en";
	} catch {
		return false;
	}
}
function resolveInitialLang() {
	try {
		const saved = localStorage.getItem(VSC_LANG_KEY);
		if (saved === "zh" || saved === "en") return saved;
	} catch {}
	const hostLang = readHostLang();
	if (hostLang) return hostLang;
	try {
		// 宿主支持多语言但插件仅中英：非中英宿主语言回落到英文
		const rawHost = localStorage.getItem(HOST_LANG_KEY);
		if (rawHost && String(rawHost).trim()) return "en";
	} catch {}
	try {
		if ((navigator.language || "").toLowerCase().startsWith("en")) return "en";
	} catch {}
	return "zh";
}
let lang = resolveInitialLang();
const STR = {
	zh: {
		filesTab: "📁 文件",
		sshTab: "🖥 SSH",
		mobileTitle: "文件",
		newFileT: "新建文件（当前选中的目录）",
		newDirT: "新建文件夹（当前选中的目录）",
		uploadT: "上传文件到工作区根目录（也可拖拽到文件树）",
		searchLocalT: "按文件名搜索（本地工作区）",
		searchRemoteT: "按文件名搜索（远端）",
		uploadRemoteT: "上传文件到当前选中目录",
		refreshT: "刷新",
		refreshRemoteT: "刷新远端目录",
		zipT: "下载为 ZIP（多选：按住 Ctrl/Cmd 点选）",
		extractT: "解压 ZIP 到当前目录…",
		addHostT: "添加主机",
		depsT: "安装 ssh2 依赖",
		depsBusyT: "依赖安装中…",
		depsBusy: "依赖安装中…",
		newTermT: "新建远程终端",
		newTermBtnT: "新建终端",
		hidePanelT: "收起面板",
		burgerT: "文件树",
		saveBtn: "💾 保存",
		saveTitle: "保存 (Ctrl+S / Cmd+S)",
		saveDirtyTitle: "有未保存的修改 — 保存 (Ctrl+S / Cmd+S)",
		saveReadonlyTitle: "大文件只读，不可保存",
		saveAsTitle: "另存为 (Ctrl+Shift+S / Cmd+Shift+S)",
		langBtnT: "切换语言 / Switch language",
		emptyMain: "从左侧打开一个文件开始编辑",
		emptyHint: "Ctrl+P 快速打开 · Ctrl+S 保存",
		termTitle: "终端",
		quickPh: "输入文件名筛选…（Esc 关闭）",
		noMatch: "无匹配文件",
		localRoot: "📁 本地工作区",
		remoteEmpty: "连接主机后，远程文件列表显示在这里",
		sshConfigSec: "⚙ ssh config（自动加载）",
		manualSec: "🏠 手动主机",
		noHost: "还没有主机，点击添加",
		loadingDir: "加载中…",
		localScope: "本地",
		binarySt: "二进制（只读）",
		unsavedSt: "未保存 ●",
		savedSt: "已保存",
		conflictSt: "⚠ 外部已变更（草稿保留）",
		bigReadonlySt: "大文件只读",
		lineCol: "第 {line} 行 · 第 {col} 列",
		closeT: "关闭",
		connT: "连接",
		disT: "断开",
		editT: "编辑",
		delT: "删除",
		timeoutErr: "请求超时",
		copiedPath: "已复制路径",
		copyFail: "复制失败",
		pasteEmpty: "剪贴板为空（先右键复制/剪切一个文件）",
		sameSrcDst: "源与目标相同",
		dupTooMany: "创建副本失败：重名次数过多",
		uploading: "正在上传，请稍候…",
		uploadFolderT: "上传文件夹（含子目录结构）",
		uploadFolderRemoteT: "上传文件夹到当前选中目录（含子目录结构）",
		mUploadFolderHere: "上传文件夹到此处…",
		folderUploadNo: "文件夹上传暂不支持，请选择文件",
		dropEmpty: "拖放为空，未找到可上传的文件",
		uploadProg: "⬆ {done}/{total} · {name}（{chunk}/{chunks}）",
		retryHint: "（点击状态栏重试）",
		retrying: "正在重试 {label}…",
		taskRetry: "❌ {label}失败：{error} — 点击此处重试",
		dropZipDoing: "已上传 {name}，正在解压到 {dir}…",
		dropZipOneFail: "拖拽的 ZIP「{name}」解压失败：{error}（文件已保留，可右键手动解压）",
		noSsh: "请先连接一台 SSH 主机",
		noSshLeft: "请先连接一台 SSH 主机（左侧点主机名）",
		truncated: "文件较多，列表已截断",
		noResult: "无匹配",
		searchMany: "结果较多，只显示前 50 项",
		promptSearch: "搜索文件名：",
		promptNewName: "新名称：",
		promptNewFile: "新文件名称（可带子路径 a/b.js）：",
		promptNewDir: "新文件夹名称：",
		promptZipName: "要解压的 ZIP 文件名（位于当前目录）：",
		promptSaveAs: "另存为（新文件路径）：",
		saveAsRemoteNo: "另存为暂仅支持本地文件",
		readOnlyNo: "只读文件不可保存",
		mNewFile: "新建文件",
		mNewDir: "新建文件夹",
		mUploadHere: "上传文件到此处…",
		mDownload: "下载到电脑",
		mDownloadZip: "下载为 ZIP（.zip）",
		mDownloadTar: "下载到电脑（.tar.gz 打包）",
		mExtractHere: "解压 ZIP 到此处",
		mCut: "剪切",
		mCopy: "复制",
		mPaste: "粘贴到此处",
		mPasteMove: "粘贴（移动到此处）",
		mDuplicate: "创建副本",
		mCopyPath: "复制路径",
		mRename: "重命名",
		mDelete: "删除",
		mRefresh: "刷新",
		mOpenTermHere: "在此打开终端",
		mOpenTermInDir: "在所在文件夹打开终端",
		cutToast: "已剪切「{name}」（在目标目录右键粘贴）",
		copyToast: "已复制「{name}」（在目标目录右键粘贴）",
		confirmDelDir: "确定删除「{path}」？（目录将递归删除，不可撤销）",
		confirmDelFile: "确定删除「{path}」？（不可撤销）",
		confirmDelHost: "删除主机「{name}」？",
		confirmClose: "「{name}」有未保存的修改，确定关闭？",
		confirmSwitch: "「{name}」有未保存的修改（草稿会保留），仍要切换？",
		confirmRefresh: "{n} 个标签有未保存修改，刷新将重新读取磁盘（草稿保留并标记冲突）。继续？",
		confirmWorkspace: "工作区即将切换，{n} 个本地标签有未保存修改，切换将关闭它们。继续？",
		workspaceSwitched: "工作区已切换",
		wsSep: "：",
		workspaceDirtyTail: "（关闭了 {n} 个未保存的本地标签）",
		pickForZip: "请先点选要打包的文件/文件夹（可按住 Ctrl 多选）",
		needZip: "请选择 .zip 文件",
		connClosedDrop: "连接已关闭",
		hostDeletedT: "主机已删除",
		manualDiscT: "手动断开",
		downloadingFile: "正在下载 {name}…",
		downloadingPack: "正在下载 {name}（打包中）…",
		downloadFail: "下载失败：{error}",
		zipFallbackTar: "远端无 zip，已改用 tar.gz",
		zipFallbackNode: "系统无 zip，已用内置打包",
		unzipping: "正在解压 {name}…",
		unzipOk: "解压完成",
		unzipOkCount: "解压完成（{count} 个文件）",
		unzipFail: "解压失败：{error}",
		openFail: "打开失败：{error}",
		saveFail: "保存失败：{error}",
		readFail: "读取失败：{error}",
		readDirFail: "读取目录失败：{error}",
		delFail: "删除失败：{error}",
		renameFail: "重命名失败：{error}",
		createFail: "创建失败：{error}",
		dupFail: "创建副本失败：{error}",
		searchFail: "搜索失败：{error}",
		pasteFail: "粘贴失败：{error}",
		uploadFail: "上传失败：{error}",
		connFail: "连接失败：{error}",
		termFail: "打开终端失败：{error}",
		importFail: "导入失败：{error}",
		savedAs: "{name} 已保存",
		openingBig: "正在打开大文件（{size}）…",
		bigReadonly: "大文件已只读打开（>1MB），编辑已禁用",
		binaryNo: "二进制文件暂不支持编辑",
		connClosed: "连接断开：{label} {reason}",
		shellExited: "〔shell 已退出〕",
		tooBigSkip: "「{name}」超过 100MB 上限，已跳过",
		coverConfirm: "「{name}」已存在，是否覆盖？",
		uploadOneFail: "上传「{name}」失败：{error}",
		uploadDoneAll: "已上传 {ok} 个文件{dest}",
		uploadToDir: " 到 {dir}",
		uploadToRoot: "（工作区根目录）",
		uploadDonePart: "上传完成：{ok}/{total} 成功",
		hostNew: "新建主机",
		hostEdit: "编辑主机",
		hostNameL: "名称（可选）",
		hostHostL: "主机地址 *",
		hostPortL: "端口",
		hostUserL: "用户名",
		hostPassL: "密码（编辑时留空 = 保持不变）",
		hostKeyL: "私钥（PEM，可选）",
		hostKeyPathL: "私钥路径（可选，支持 ~ 展开如 ~/.ssh/id_rsa；填写则优先使用，不必粘贴私钥全文）",
		hostPpL: "私钥口令 passphrase（可选，带口令的私钥用）",
		hostAgentL: "SSH agent socket（可选，如 $SSH_AUTH_SOCK；与密码/私钥二选一）",
		hostHint:
			"凭据只保存在本机插件目录（ssh-hosts.json），不会上传。密码 / 私钥 / 私钥路径 / agent 四选一即可。<br>已有 ~/.ssh/config 的无需导入——SSH 面板「⚙ ssh config」自动加载（与 VSCode Remote-SSH 同源，支持 Include / ProxyJump / ProxyCommand），点别名直连。",
		cancelB: "取消",
		importCfgB: "从 ssh config 导入",
		importCfgT: "从 ~/.ssh/config 批量导入主机",
		saveB: "保存",
		keptPh: "已保存（留空保持不变）",
		readingCfg: "读取 ~/.ssh/config 中…",
		allImported: "共 {n} 台，均已导入。",
		importSelected: "导入选中",
		pickHosts: "请先勾选要导入的主机",
		imported: "已导入 {added} 台{skip}",
		importedSkip: "（跳过 {n} 台）",
		configSaved: "ssh config 已保存（旧版已备份 .bak），列表已刷新",
		sshCfgPrompt:
			"编辑 {path}（与 VSCode 写法完全一样）：\nHost 别名\n  HostName 主机\n  User 用户\n  Port 端口\n  IdentityFile 私钥路径\n  ProxyJump 跳板",
		editCfgT: "编辑 {path}（与 VSCode 写法完全一样）",
	},
	en: {
		filesTab: "📁 Files",
		sshTab: "🖥 SSH",
		mobileTitle: "Files",
		newFileT: "New file (in selected directory)",
		newDirT: "New folder (in selected directory)",
		uploadT: "Upload files to workspace root (or drag into the tree)",
		searchLocalT: "Search file names (local workspace)",
		searchRemoteT: "Search file names (remote)",
		uploadRemoteT: "Upload files to selected directory",
		refreshT: "Refresh",
		refreshRemoteT: "Refresh remote directory",
		zipT: "Download as ZIP (multi-select with Ctrl/Cmd+click)",
		extractT: "Extract a ZIP file into the current directory…",
		addHostT: "Add host",
		depsT: "Install ssh2 dependency",
		depsBusyT: "Installing dependency…",
		depsBusy: "Installing dependency…",
		newTermT: "New remote terminal",
		newTermBtnT: "New terminal",
		hidePanelT: "Collapse panel",
		burgerT: "File tree",
		saveBtn: "💾 Save",
		saveTitle: "Save (Ctrl+S / Cmd+S)",
		saveDirtyTitle: "Unsaved changes — save (Ctrl+S / Cmd+S)",
		saveReadonlyTitle: "Large file is read-only",
		saveAsTitle: "Save as (Ctrl+Shift+S / Cmd+Shift+S)",
		langBtnT: "切换语言 / Switch language",
		emptyMain: "Open a file from the left to start editing",
		emptyHint: "Ctrl+P quick open · Ctrl+S save",
		termTitle: "Terminal",
		quickPh: "Filter by file name… (Esc to close)",
		noMatch: "No matching files",
		localRoot: "📁 Local workspace",
		remoteEmpty: "Remote files appear here after connecting",
		sshConfigSec: "⚙ ssh config (auto-loaded)",
		manualSec: "🏠 Manual hosts",
		noHost: "No hosts yet — click to add",
		loadingDir: "Loading…",
		localScope: "Local",
		binarySt: "Binary (read-only)",
		unsavedSt: "Unsaved ●",
		savedSt: "Saved",
		conflictSt: "⚠ Changed on disk (draft kept)",
		bigReadonlySt: "Large file read-only",
		lineCol: "Ln {line}, Col {col}",
		closeT: "Close",
		connT: "Connect",
		disT: "Disconnect",
		editT: "Edit",
		delT: "Delete",
		timeoutErr: "Request timed out",
		copiedPath: "Path copied",
		copyFail: "Copy failed",
		pasteEmpty: "Clipboard is empty (right-click a file to copy/cut first)",
		sameSrcDst: "Source and destination are the same",
		dupTooMany: "Duplicate failed: too many name clashes",
		uploading: "Uploading, please wait…",
		uploadFolderT: "Upload folder (keep structure)",
		uploadFolderRemoteT: "Upload folder to selected directory (keep structure)",
		mUploadFolderHere: "Upload folder here…",
		folderUploadNo: "Folder upload is not supported, please choose files",
		dropEmpty: "Drop is empty, no uploadable files found",
		uploadProg: "⬆ {done}/{total} · {name} ({chunk}/{chunks})",
		retryHint: " (click status bar to retry)",
		retrying: "Retrying {label}…",
		taskRetry: "❌ {label} failed: {error} — click here to retry",
		dropZipDoing: "Uploaded {name}, extracting to {dir}…",
		dropZipOneFail: 'Dropped ZIP "{name}" failed to extract: {error} (file kept, right-click to extract manually)',
		noSsh: "Please connect an SSH host first",
		noSshLeft: "Please connect an SSH host first (click a host on the left)",
		truncated: "Too many files, list truncated",
		noResult: "No matches",
		searchMany: "Too many results, showing first 50",
		promptSearch: "Search file name:",
		promptNewName: "New name:",
		promptNewFile: "New file name (subpath allowed, e.g. a/b.js):",
		promptNewDir: "New folder name:",
		promptZipName: "ZIP file name to extract (in current directory):",
		promptSaveAs: "Save as (new file path):",
		saveAsRemoteNo: "Save As supports local files only",
		readOnlyNo: "Read-only file cannot be saved",
		mNewFile: "New file",
		mNewDir: "New folder",
		mUploadHere: "Upload files here…",
		mDownload: "Download to PC",
		mDownloadZip: "Download as ZIP (.zip)",
		mDownloadTar: "Download to PC (.tar.gz)",
		mExtractHere: "Extract ZIP here",
		mCut: "Cut",
		mCopy: "Copy",
		mPaste: "Paste here",
		mPasteMove: "Paste (move here)",
		mDuplicate: "Duplicate",
		mCopyPath: "Copy path",
		mRename: "Rename",
		mDelete: "Delete",
		mRefresh: "Refresh",
		mOpenTermHere: "Open terminal here",
		mOpenTermInDir: "Open terminal in containing folder",
		cutToast: 'Cut "{name}" (right-click target directory to paste)',
		copyToast: 'Copied "{name}" (right-click target directory to paste)',
		confirmDelDir: 'Delete "{path}"? (directory deletes recursively, irreversible)',
		confirmDelFile: 'Delete "{path}"? (irreversible)',
		confirmDelHost: 'Delete host "{name}"?',
		confirmClose: '"{name}" has unsaved changes. Close anyway?',
		confirmSwitch: '"{name}" has unsaved changes (draft is kept). Switch anyway?',
		confirmRefresh: "{n} tab(s) have unsaved changes. Refresh re-reads from disk (drafts kept & flagged). Continue?",
		confirmWorkspace:
			"Workspace is about to switch. {n} local tab(s) have unsaved changes and will be closed. Continue?",
		workspaceSwitched: "Workspace switched",
		wsSep: ": ",
		workspaceDirtyTail: " (closed {n} unsaved local tab(s))",
		pickForZip: "Please select files/folders to pack (Ctrl+click for multi-select)",
		needZip: "Please choose a .zip file",
		connClosedDrop: "Connection closed",
		hostDeletedT: "Host deleted",
		manualDiscT: "Disconnected manually",
		downloadingFile: "Downloading {name}…",
		downloadingPack: "Packing & downloading {name}…",
		downloadFail: "Download failed: {error}",
		zipFallbackTar: "Remote host has no zip, fell back to tar.gz",
		zipFallbackNode: "No system zip, used built-in packer",
		unzipping: "Extracting {name}…",
		unzipOk: "Extraction done",
		unzipOkCount: "Extracted {count} file(s)",
		unzipFail: "Extraction failed: {error}",
		openFail: "Open failed: {error}",
		saveFail: "Save failed: {error}",
		readFail: "Read failed: {error}",
		readDirFail: "Read directory failed: {error}",
		delFail: "Delete failed: {error}",
		renameFail: "Rename failed: {error}",
		createFail: "Create failed: {error}",
		dupFail: "Duplicate failed: {error}",
		searchFail: "Search failed: {error}",
		pasteFail: "Paste failed: {error}",
		uploadFail: "Upload failed: {error}",
		connFail: "Connect failed: {error}",
		termFail: "Open terminal failed: {error}",
		importFail: "Import failed: {error}",
		savedAs: "{name} saved",
		openingBig: "Opening large file ({size})…",
		bigReadonly: "Large file opened read-only (>1MB); editing disabled",
		binaryNo: "Binary files cannot be edited",
		connClosed: "Connection closed: {label} {reason}",
		shellExited: "[shell exited]",
		tooBigSkip: '"{name}" exceeds the 100MB limit, skipped',
		coverConfirm: '"{name}" already exists. Overwrite?',
		uploadOneFail: 'Upload "{name}" failed: {error}',
		uploadDoneAll: "Uploaded {ok} file(s){dest}",
		uploadToDir: " to {dir}",
		uploadToRoot: " (workspace root)",
		uploadDonePart: "Upload done: {ok}/{total} succeeded",
		hostNew: "New host",
		hostEdit: "Edit host",
		hostNameL: "Name (optional)",
		hostHostL: "Host *",
		hostPortL: "Port",
		hostUserL: "Username",
		hostPassL: "Password (blank = keep)",
		hostKeyL: "Private key (PEM, optional)",
		hostKeyPathL: "Key path (optional, ~ expands, e.g. ~/.ssh/id_rsa; preferred over pasting the key)",
		hostPpL: "Key passphrase (optional, for protected keys)",
		hostAgentL: "SSH agent socket (optional, e.g. $SSH_AUTH_SOCK; use instead of password/key)",
		hostHint:
			'Credentials stay in this plugin directory (ssh-hosts.json) and are never uploaded. Use one of password / private key / key path / agent.<br>If you already have ~/.ssh/config, no import needed — the SSH panel\'s "⚙ ssh config" loads it automatically (same source as VSCode Remote-SSH: Include / ProxyJump / ProxyCommand supported). Click an alias to connect.',
		cancelB: "Cancel",
		importCfgB: "Import from ssh config",
		importCfgT: "Bulk import hosts from ~/.ssh/config",
		saveB: "Save",
		keptPh: "Saved (blank = keep)",
		readingCfg: "Reading ~/.ssh/config…",
		allImported: "{n} host(s), all imported.",
		importSelected: "Import selected",
		pickHosts: "Please tick the hosts to import first",
		imported: "Imported {added} host(s){skip}",
		importedSkip: " ({n} skipped)",
		configSaved: "ssh config saved (previous version backed up as .bak), list refreshed",
		sshCfgPrompt:
			"Edit {path} (same syntax as VSCode):\nHost alias\n  HostName host\n  User user\n  Port port\n  IdentityFile key path\n  ProxyJump jump",
		editCfgT: "Edit {path} (same syntax as VSCode)",
	},
};
function tr(key, vars) {
	let s = (STR[lang] && STR[lang][key]) ?? STR.zh[key] ?? key;
	if (vars) for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v));
	return s;
}
function setLang(next) {
	lang = next === "en" ? "en" : "zh";
	try {
		localStorage.setItem(VSC_LANG_KEY, lang);
	} catch {}
	// 注意：UI 刷新由挂载点的 applyI18n() 负责（避免模块级引用内部函数导致 ReferenceError）
}

const THEME_CHANGE_EVENT = "pi-web-ui:theme-change";
function isLightTheme() {
	try {
		return getComputedStyle(document.documentElement).getPropertyValue("color-scheme").trim().startsWith("light");
	} catch {
		return false;
	}
}
function buildTermTheme() {
	let cs = null;
	try {
		cs = getComputedStyle(document.documentElement);
	} catch {
		cs = null;
	}
	const v = (name, fallback) => {
		try {
			const val = cs?.getPropertyValue(name).trim();
			return val || fallback;
		} catch {
			return fallback;
		}
	};
	return {
		background: v("--term-bg", "#0b0d12"),
		foreground: v("--term-fg", "#e6e8ef"),
		cursor: v("--term-cursor", "#8b5cf6"),
		cursorAccent: v("--term-cursor-accent", "#0b0d12"),
		selectionBackground: v("--term-selection", "rgba(139, 92, 246, 0.35)"),
		black: v("--term-black", "#1a1d26"),
		red: v("--term-red", "#f87171"),
		green: v("--term-green", "#34d399"),
		yellow: v("--term-yellow", "#fbbf24"),
		blue: v("--term-blue", "#60a5fa"),
		magenta: v("--term-magenta", "#c084fc"),
		cyan: v("--term-cyan", "#22d3ee"),
		white: v("--term-white", "#e6e8ef"),
		brightBlack: v("--term-bright-black", "#6b7284"),
		brightRed: v("--term-bright-red", "#f87171"),
		brightGreen: v("--term-bright-green", "#34d399"),
		brightYellow: v("--term-bright-yellow", "#fbbf24"),
		brightBlue: v("--term-bright-blue", "#60a5fa"),
		brightMagenta: v("--term-bright-magenta", "#c084fc"),
		brightCyan: v("--term-bright-cyan", "#22d3ee"),
		brightWhite: v("--term-bright-white", "#ffffff"),
	};
}
const cmLight = EditorView.theme(
	{
		"&": { backgroundColor: "var(--bg, #ffffff)", color: "var(--text, #1f2328)" },
		".cm-content": { caretColor: "var(--accent, #0969da)" },
		".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--accent, #0969da)" },
		".cm-activeLine": { backgroundColor: "color-mix(in srgb, var(--accent, #0969da) 8%, transparent)" },
		".cm-activeLineGutter": { backgroundColor: "transparent" },
		".cm-gutters": {
			backgroundColor: "var(--bg, #ffffff)",
			color: "var(--text-faint, #818b98)",
			borderRight: "1px solid var(--border, #d0d7de)",
		},
		".cm-selectionMatch": { backgroundColor: "color-mix(in srgb, var(--accent, #0969da) 18%, transparent)" },
		"&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground": {
			backgroundColor: "color-mix(in srgb, var(--accent, #0969da) 22%, transparent)",
		},
	},
	{ dark: false },
);

const LANGS = [
	[/\.(jsx?|mjs|cjs)$/, () => javascript()],
	[/\.tsx?$/, () => javascript({ typescript: true })],
	[/\.json5?$/, () => json()],
	[/\.css$/, () => css()],
	[/\.(html?|vue|svelte)$/, () => html()],
	[/\.(md|markdown)$/, () => markdown()],
	[/\.py$/, () => python()],
];

function langFor(path) {
	const p = path.toLowerCase();
	for (const [re, make] of LANGS) if (re.test(p)) return make();
	return null;
}

function langName(path) {
	if (/\.tsx?$/.test(path)) return "TypeScript";
	if (/\.(jsx?|mjs|cjs)$/.test(path)) return "JavaScript";
	if (/\.json5?$/.test(path)) return "JSON";
	if (/\.css$/.test(path)) return "CSS";
	if (/\.(html?|vue|svelte)$/.test(path)) return "HTML";
	if (/\.(md|markdown)$/.test(path)) return "Markdown";
	if (/\.py$/.test(path)) return "Python";
	return "Plain Text";
}

function iconFor(name, type) {
	if (type === "dir") return "📁";
	const ext = (name.match(/\.([^.]+)$/) || [, ""])[1].toLowerCase();
	const map = {
		js: "🟨",
		mjs: "🟨",
		cjs: "🟨",
		jsx: "⚛️",
		ts: "🟦",
		tsx: "⚛️",
		json: "🔧",
		md: "📝",
		css: "🎨",
		html: "🌐",
		py: "🐍",
		png: "🖼",
		jpg: "🖼",
		jpeg: "🖼",
		gif: "🖼",
		webp: "🖼",
		svg: "🖼",
		lock: "🔒",
		yml: "⚙️",
		yaml: "⚙️",
		toml: "⚙️",
		sh: "💻",
		bat: "💻",
	};
	return map[ext] || "📄";
}

export function fuzzyScore(query, target) {
	const q = query.toLowerCase();
	const t = target.toLowerCase();
	let qi = 0,
		score = 0,
		streak = 0;
	for (let ti = 0; ti < t.length && qi < q.length; ti++) {
		if (t[ti] === q[qi]) {
			streak++;
			score += 1 + streak;
			qi++;
		} else streak = 0;
	}
	if (qi < q.length) return -1;
	score += Math.max(0, 40 - t.length) / 10;
	return score;
}

export default {
	mount(container, ctx) {
		container.innerHTML = `
<div class="vsc">
	<style>${xtermCss}</style>
	<style>
		.vsc { position: relative; display: flex; height: 100%; min-height: 480px;
			overflow: hidden;
			background: var(--bg, #101016); color: var(--text, #e6e6ef); font-size: 13px; }
		/* ---- 左侧多根文件树 ---- */
		.vsc-side { width: 240px; min-width: 160px; flex-shrink: 0; display: flex; flex-direction: column;
			border-right: 1px solid var(--border, #333); background: var(--bg-elev, #16161d); }
		.vsc-side-head { display: flex; align-items: center; gap: 4px; padding: 8px 10px 6px;
			font-size: 11px; letter-spacing: .08em; text-transform: uppercase; opacity: .85; }
		.vsc-side-head b { flex: 1; font-weight: 600; }
		.vsc-side-head button { all: unset; cursor: pointer; padding: 2px 5px; border-radius: 4px; font-size: 12px; }
		.vsc-side-head button:hover { background: var(--bg-elev2, #20202b); }
		/* ---- 侧栏双 tab：文件 / SSH ---- */
		.vsc-stabs { display: flex; gap: 4px; padding: 6px 8px;
			border-bottom: 1px solid var(--border, #333); background: var(--bg-elev, #16161d); }
		.vsc-stabs .stab { all: unset; cursor: pointer; padding: 3px 12px; border-radius: 6px; font-size: 12.5px; opacity: .65; }
		.vsc-stabs .stab.active { background: color-mix(in srgb, var(--accent, #7c5cff) 25%, transparent);
			opacity: 1; font-weight: 600; }
		.vsc-pane { flex: 1; min-height: 0; display: flex; flex-direction: column; }
		.vsc-hosts { flex-shrink: 0; max-height: 32%; overflow: auto; padding: 2px 0 6px; user-select: none; }
		.vsc-sshtree { flex: 1; min-height: 0; overflow: auto; padding: 4px 0 12px; user-select: none;
			border-top: 1px solid var(--border, #333); }
		.vsc-sect .cwd { opacity: .45; font-size: 10.5px; overflow: hidden; text-overflow: ellipsis; margin-left: 6px; direction: rtl; }
		.vsc-tree { flex: 1; overflow: auto; padding: 2px 0 12px; user-select: none; }
		.vsc-row { display: flex; align-items: center; gap: 5px; padding: 2px 8px; cursor: pointer;
			white-space: nowrap; line-height: 1.7; }
		.vsc-row:hover { background: var(--bg-elev2, #20202b); }
		.vsc-row.active { background: color-mix(in srgb, var(--accent, #7c5cff) 22%, transparent); }
		/* 选中态（区别于打开文件的 active）：提示工具栏新建的落点 */
		.vsc-row.sel { background: color-mix(in srgb, var(--accent, #7c5cff) 12%, transparent);
			box-shadow: inset 2px 0 0 var(--accent, #7c5cff); }
		.vsc-row.loading { opacity: .45; }
		/* 拖拽上传落点高亮 */
		.vsc-row.drop-target { outline: 1px dashed var(--accent, #7c5cff); outline-offset: -2px;
			background: color-mix(in srgb, var(--accent, #7c5cff) 16%, transparent); }
		.vsc-tree.drop-root, .vsc-sshtree.drop-root { outline: 2px dashed var(--accent, #7c5cff); outline-offset: -2px; }
		.vsc-status .vsc-up { color: var(--amber, #fbbf24); }
		.vsc-row .caret { width: 12px; text-align: center; opacity: .55; font-size: 9px; flex-shrink: 0; }
		.vsc-row .nm { overflow: hidden; text-overflow: ellipsis; }
		.vsc-sect { display: flex; align-items: center; gap: 4px; padding: 8px 8px 3px;
			font-size: 10.5px; letter-spacing: .07em; text-transform: uppercase; opacity: .75; }
		.vsc-sect b { flex: 1; font-weight: 600; }
		.vsc-sect button { all: unset; cursor: pointer; padding: 1px 5px; border-radius: 4px; font-size: 11px; }
		.vsc-sect button:hover { background: var(--bg-elev2, #20202b); }
		.vsc-hrow .dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0;
			background: var(--text-dim, #666); }
		.vsc-hrow .dot.on { background: var(--green, #4ade80); box-shadow: 0 0 6px var(--green, #4ade80); }
		.vsc-hrow .dot.busy { background: var(--amber, #fbbf24); animation: vscpulse 1s infinite alternate; }
		@keyframes vscpulse { from { opacity: .4 } to { opacity: 1 } }
		.vsc-hrow .ops { display: none; gap: 2px; margin-left: auto; }
		.vsc-hrow:hover .ops { display: flex; }
		.vsc-hrow .ops button { all: unset; cursor: pointer; padding: 0 4px; border-radius: 4px; font-size: 11px; opacity: .7; }
		.vsc-hrow .ops button:hover { opacity: 1; background: var(--bg-elev3, #2a2a38); }
		.vsc-deps { padding: 4px 10px; }
		.vsc-deps button { all: unset; display: block; width: 100%; box-sizing: border-box; cursor: pointer;
			padding: 4px 8px; border-radius: 5px; font-size: 11.5px; color: var(--amber, #fbbf24); }
		.vsc-deps button:hover { background: var(--bg-elev2, #20202b); }
		/* ---- 右侧主区 ---- */
		.vsc-main { flex: 1; display: flex; flex-direction: column; min-width: 0; }
		.vsc-tabbar { display: flex; align-items: stretch; border-bottom: 1px solid var(--border, #333);
			background: var(--bg-elev, #16161d); }
		.vsc-tabs { flex: 1; display: flex; overflow-x: auto; min-width: 0;
			background: transparent; scrollbar-width: thin; }
		.vsc-savebtn, .vsc-saveasbtn, .vsc-langbtn { all: unset; display: inline-flex; align-items: center; gap: 4px; cursor: pointer;
			padding: 4px 10px; font-size: 12px; white-space: nowrap; color: var(--text-dim, #9a9ab0);
			border-left: 1px solid var(--border, #333); }
		.vsc-savebtn:hover, .vsc-saveasbtn:hover, .vsc-langbtn:hover { background: var(--bg-elev2, #20202b); color: var(--text, #eee); }
		.vsc-savebtn.is-dirty { color: var(--amber, #fbbf24); font-weight: 700; }
		.vsc-savebtn:disabled, .vsc-saveasbtn:disabled { opacity: .35; cursor: default; }
		.vsc-tab { display: inline-flex; align-items: center; gap: 6px; padding: 6px 8px 6px 12px;
			cursor: pointer; border-right: 1px solid var(--border, #333); white-space: nowrap;
			color: var(--text-dim, #9a9ab0); max-width: 200px; }
		.vsc-tab.active { background: var(--bg, #101016); color: var(--text, #e6e6ef);
			box-shadow: inset 0 2px 0 var(--accent, #7c5cff); }
		.vsc-tab .tn { overflow: hidden; text-overflow: ellipsis; }
		.vsc-tab .dot { color: var(--amber, #fbbf24); }
		.vsc-tab .x { all: unset; cursor: pointer; padding: 0 3px; border-radius: 4px; opacity: .55; }
		.vsc-tab .x:hover { opacity: 1; background: var(--bg-elev2, #20202b); }
		.vsc-edwrap { flex: 1; min-height: 0; position: relative; }
		.vsc-empty { position: absolute; inset: 0; display: grid; place-items: center;
			opacity: .45; text-align: center; line-height: 2; }
		.vsc-editor { height: 100%; }
		.vsc-editor .cm-editor { height: 100%; }
		.vsc-editor .cm-scroller { font-family: ui-monospace, Consolas, "Cascadia Mono", monospace; }
		/* ---- 底部终端面板 ---- */
		.vsc-termdrag { height: 4px; cursor: row-resize; flex-shrink: 0;
			background: var(--bg-elev, #16161d); border-top: 1px solid var(--border, #333); }
		.vsc-termdrag:hover { background: color-mix(in srgb, var(--accent, #7c5cff) 35%, transparent); }
		.vsc-termpanel { height: 240px; min-height: 80px; display: flex; flex-direction: column;
			flex-shrink: 0; background: var(--term-bg, #101016); }
		.vsc-termbar { display: flex; align-items: center; gap: 4px; padding: 3px 8px;
			border-bottom: 1px solid var(--border, #333); background: var(--bg-elev, #16161d);
			font-size: 11.5px; user-select: none; }
		.vsc-termbar .tt { opacity: .6; text-transform: uppercase; letter-spacing: .06em; font-size: 10.5px; margin-right: 4px; }
		.vsc-termbar .grow { flex: 1; }
		.vsc-termbar button { all: unset; cursor: pointer; padding: 1px 7px; border-radius: 5px; font-size: 12px; }
		.vsc-termbar button:hover { background: var(--bg-elev2, #20202b); }
		.vsc-ttab { display: inline-flex; align-items: center; gap: 5px; padding: 2px 8px; cursor: pointer;
			border-radius: 5px; color: var(--text-dim, #9a9ab0); white-space: nowrap; max-width: 180px; }
		.vsc-ttab.active { background: color-mix(in srgb, var(--accent, #7c5cff) 25%, transparent); color: var(--text, #e6e6ef); }
		.vsc-ttab .tn { overflow: hidden; text-overflow: ellipsis; }
		.vsc-ttab .x { all: unset; cursor: pointer; opacity: .5; font-size: 10px; padding: 0 2px; }
		.vsc-ttab .x:hover { opacity: 1; }
		.vsc-termarea { flex: 1; min-height: 0; position: relative; padding: 4px 6px; }
		.vsc-term { position: absolute; inset: 4px 6px; }
		.vsc-term .xterm { height: 100%; }
		/* ---- 状态栏 ---- */
		.vsc-status { display: flex; align-items: center; gap: 14px; padding: 4px 12px;
			border-top: 1px solid var(--border, #333); background: var(--bg-elev, #16161d);
			font-size: 11.5px; color: var(--text-dim, #9a9ab0); }
		.vsc-status .grow { flex: 1; }
		.vsc-status .dirty { color: var(--amber, #fbbf24); }
		.vsc-status .remote { color: var(--green, #4ade80); }
		.vsc-err { color: var(--red, #f87171); }
		/* 快速打开弹层 */
		.vsc-quickopen { position: absolute; left: 50%; top: 40px; transform: translateX(-50%);
			width: min(520px, 80%); z-index: 30; background: var(--bg-elev2, #20202b);
			border: 1px solid var(--border, #444); border-radius: 10px;
			box-shadow: 0 12px 40px rgba(0,0,0,.45); overflow: hidden; }
		.vsc-quickopen input { width: 100%; box-sizing: border-box; background: transparent; color: inherit;
			border: 0; outline: 0; padding: 10px 14px; font: inherit; border-bottom: 1px solid var(--border, #333); }
		.vsc-quickopen ul { list-style: none; margin: 0; padding: 4px 0; max-height: 300px; overflow: auto; }
		.vsc-quickopen li { padding: 5px 14px; cursor: pointer; display: flex; gap: 8px; align-items: baseline; }
		.vsc-quickopen li.sel, .vsc-quickopen li:hover { background: color-mix(in srgb, var(--accent, #7c5cff) 25%, transparent); }
		.vsc-quickopen li small { opacity: .5; margin-left: auto; direction: rtl; }
		.vsc-hidden { display: none !important; }
		/* 树上右键菜单 / 同步菜单 */
		.vsc-menu { position: absolute; z-index: 40; min-width: 150px; background: var(--bg-elev2, #20202b);
			border: 1px solid var(--border, #444); border-radius: 8px; padding: 4px;
			box-shadow: 0 10px 30px rgba(0,0,0,.4); }
		.vsc-menu button { all: unset; display: block; width: 100%; box-sizing: border-box; cursor: pointer;
			padding: 5px 10px; border-radius: 5px; font: inherit; }
		.vsc-menu button:hover { background: color-mix(in srgb, var(--accent, #7c5cff) 30%, transparent); }
		.vsc-menu button.dim { opacity: .55; }
		/* 弹层（主机表单共用样式） */
		.vsc-modal-bg { position: absolute; inset: 0; z-index: 50; background: rgba(0,0,0,.45);
			display: grid; place-items: center; }
		.vsc-modal { width: min(430px, 90%); max-height: 94%; overflow: auto; background: var(--bg-elev2, #20202b);
			border: 1px solid var(--border, #444); border-radius: 12px; padding: 16px 18px; }
		.vsc-modal h3 { margin: 0 0 10px; }
		.vsc-modal label { display: block; font-size: 11.5px; opacity: .7; margin: 9px 0 3px; }
		.vsc-modal input, .vsc-modal textarea { width: 100%; box-sizing: border-box; background: var(--bg, #101016);
			color: inherit; border: 1px solid var(--border, #444); border-radius: 6px; padding: 6px 9px; font: inherit; }
		.vsc-modal textarea { font: 12px ui-monospace, monospace; resize: vertical; }
		.vsc-modal .grid2 { display: grid; grid-template-columns: 1fr 100px; gap: 8px; }
		.vsc-modal .hint { font-size: 11px; opacity: .5; margin-top: 8px; line-height: 1.6; }
		.vsc-modal .btns { display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; }
		.vsc-modal .btns button { all: unset; cursor: pointer; padding: 6px 14px; border-radius: 7px; font-size: 13px;
			border: 1px solid var(--border, #444); }
		.vsc-modal .btns button.primary { background: var(--accent, #7c5cff); border-color: transparent; color: var(--accent-contrast, #fff); }
		.vsc-modal .btns button:hover { filter: brightness(1.15); }
		/* ---- 手机窄屏适配（≤640px）：桌面端零变化 ---- */
		.vsc-mobilebar { display: none; }
		.vsc-backdrop { display: none; }
		@media (max-width: 640px) {
			/* 主区顶栏：窄屏工具条（☰ + 标题），桌面端隐藏 */
			.vsc-mobilebar { display: flex; align-items: center; gap: 8px; padding: 4px 8px;
				border-bottom: 1px solid var(--border, #333); background: var(--bg-elev, #16161d); }
			.vsc-mobilebar .vsc-burger { all: unset; cursor: pointer; font-size: 18px;
				padding: 6px 10px; border-radius: 6px; line-height: 1; }
			.vsc-mobilebar .vsc-burger:hover { background: var(--bg-elev2, #20202b); }
			.vsc-mobilebar .vsc-mtitle { flex: 1; overflow: hidden; text-overflow: ellipsis;
				white-space: nowrap; font-size: 12px; opacity: .7; }
			/* 侧栏变左侧覆盖式抽屉 */
			.vsc-side { position: absolute; left: 0; top: 0; bottom: 0; z-index: 35;
				width: min(280px, 82vw); max-width: 82vw;
				transform: translateX(-105%); transition: transform .22s ease; }
			.vsc.drawer-open .vsc-side { transform: none;
				box-shadow: 8px 0 28px rgba(0,0,0,.5); }
			.vsc.drawer-open .vsc-backdrop { display: block; position: absolute; inset: 0; z-index: 30;
				background: rgba(0,0,0,.45); }
			/* 底部终端面板：占全宽、高度可控，不挤没编辑器 */
			.vsc-termpanel { width: 100%; max-height: 45dvh; }
			.vsc-termbar { min-height: 40px; }
			/* tabs 横滑 + 触摸目标放大 */
			.vsc-tabs { overflow-x: auto; -webkit-overflow-scrolling: touch; }
			.vsc-tab { padding: 8px 8px 8px 12px; }
			.vsc-tab .x { padding: 6px 8px; font-size: 13px; }
			.vsc-hrow .ops button { padding: 6px 8px; font-size: 12px; }
			.vsc-side-head button, .vsc-sect button, .vsc-termbar button { padding: 5px 9px; }
			/* iOS 聚焦缩放：表单字号提到 16px（CodeMirror 编辑区不动） */
			.vsc-quickopen input, .vsc-modal input, .vsc-modal select, .vsc-modal textarea { font-size: 16px; }
			.vsc-modal .grid2 { grid-template-columns: 1fr; }
			.vsc-modal { width: min(430px, 94%); }
			.vsc-quickopen { width: min(520px, 94%); }
			.vsc-status { gap: 8px; overflow-x: auto; white-space: nowrap; }
			.vsc-status .vsc-path { max-width: 40vw; overflow: hidden; text-overflow: ellipsis; }
		}
		.vsc-status .vsc-up.retry { cursor: pointer; text-decoration: underline; }
		/* 触屏无 hover：行操作按钮常显 */
		@media (hover: none) {
			.vsc-hrow .ops { display: flex; }
		}
	</style>
	<div class="vsc-side">
		<div class="vsc-stabs">
			<button class="stab active" data-pane="files">📁 文件</button>
			<button class="stab" data-pane="ssh">🖥 SSH</button>
		</div>
		<div class="vsc-pane" data-pane="files">
			<div class="vsc-side-head">
				<span style="flex:1"></span>
				<button data-act="new-file" title="新建文件（当前选中的目录）">📄</button>
				<button data-act="new-dir" title="新建文件夹（当前选中的目录）">📁</button>
				<button data-act="upload" title="上传文件到工作区根目录（也可拖拽到文件树）">⬆</button>
				<button data-act="upload-folder" title="上传文件夹（含子目录结构）">📂</button>
				<button data-act="zip" title="下载为 ZIP（多选：按住 Ctrl/Cmd 点选）">🗜</button>
				<button data-act="extract" title="解压 ZIP 到当前目录…">📦</button>
				<button data-act="search" title="按文件名搜索（本地工作区）">🔍</button>
				<button data-act="refresh" title="刷新">⟳</button>
			</div>
			<div class="vsc-tree"></div>
		</div>
		<div class="vsc-pane vsc-hidden" data-pane="ssh">
			<div class="vsc-side-head">
				<span style="flex:1"></span>
				<button data-act="add-host" title="添加主机">🏠</button>
				<button data-act="deps" class="vsc-hidden" title="安装 ssh2 依赖">⚠ssh2</button>
				<button data-act="new-term" title="新建远程终端">🖥</button>
				<button data-act="r-new-file" title="新建文件（当前选中的目录）">📄</button>
				<button data-act="r-new-dir" title="新建文件夹（当前选中的目录）">📁</button>
				<button data-act="r-upload" title="上传文件到当前选中目录">⬆</button>
				<button data-act="r-upload-folder" title="上传文件夹到当前选中目录（含子目录结构）">📂</button>
				<button data-act="r-zip" title="下载为 ZIP（多选：按住 Ctrl/Cmd 点选）">🗜</button>
				<button data-act="r-extract" title="解压 ZIP 到当前目录…">📦</button>
				<button data-act="r-search" title="按文件名搜索（远端）">🔍</button>
				<button data-act="r-refresh" title="刷新远端目录">⟳</button>
			</div>
			<div class="vsc-hosts"></div>
			<div class="vsc-sshtree"></div>
		</div>
	</div>
	<div class="vsc-backdrop"></div>
	<div class="vsc-main">
		<div class="vsc-mobilebar">
			<button class="vsc-burger" title="文件树">☰</button>
			<span class="vsc-mtitle">文件</span>
		</div>
		<div class="vsc-tabbar"><div class="vsc-tabs"></div><button class="vsc-saveasbtn" title="另存为 (Ctrl+Shift+S / Cmd+Shift+S)">💾+</button><button class="vsc-savebtn" title="保存 (Ctrl+S / Cmd+S)">💾 保存</button><button class="vsc-langbtn" title="切换语言 / Switch language">EN</button></div>
		<div class="vsc-edwrap">
			<div class="vsc-empty">从左侧打开一个文件开始编辑<br><small>Ctrl+P 快速打开 · Ctrl+S 保存</small></div>
			<div class="vsc-editor vsc-hidden"></div>
		</div>
		<div class="vsc-termdrag vsc-hidden"></div>
		<div class="vsc-termpanel vsc-hidden">
			<div class="vsc-termbar">
				<span class="tt">终端</span>
				<span class="tts"></span>
				<button class="t-add" title="新建终端">＋</button>
				<span class="grow"></span>
				<button class="t-hide" title="收起面板">▾</button>
			</div>
			<div class="vsc-termarea"></div>
		</div>
		<div class="vsc-status">
			<span class="vsc-scope"></span>
			<span class="vsc-path">—</span>
			<span class="grow"></span>
			<span class="vsc-lang"></span>
			<span class="vsc-pos"></span>
			<span class="vsc-up"></span>
			<span class="vsc-state"></span>
		</div>
	</div>
	<div class="vsc-quickopen vsc-hidden">
		<input placeholder="输入文件名筛选…（Esc 关闭）" />
		<ul></ul>
	</div>
	<input type="file" multiple class="vsc-filepick vsc-hidden" />
	<input type="file" multiple webkitdirectory class="vsc-folderpick vsc-hidden" />
	<div class="vsc-menu vsc-hidden"></div>
	<div class="vsc-modal-bg vsc-host-bg vsc-hidden">
		<div class="vsc-modal">
			<h3 class="h-title">新建主机</h3>
			<label>名称（可选）</label><input name="h-name" placeholder="my-server" />
			<div class="grid2">
				<span><label>主机地址 *</label><input name="h-host" placeholder="192.168.1.10" /></span>
				<span><label>端口</label><input name="h-port" value="22" /></span>
			</div>
			<label>用户名</label><input name="h-user" value="root" />
			<label>密码（编辑时留空 = 保持不变）</label><input name="h-pass" type="password" autocomplete="off" />
			<label>私钥（PEM，可选）</label><textarea name="h-key" rows="3" placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"></textarea>
			<label>私钥路径（可选，支持 ~ 展开如 ~/.ssh/id_rsa；填写则优先使用，不必粘贴私钥全文）</label><input name="h-keypath" placeholder="~/.ssh/id_rsa" />
			<label>私钥口令 passphrase（可选，带口令的私钥用）</label><input name="h-pp" type="password" autocomplete="off" />
			<label>SSH agent socket（可选，如 $SSH_AUTH_SOCK；与密码/私钥二选一）</label><input name="h-agent" placeholder="$SSH_AUTH_SOCK" />
			<div class="hint">凭据只保存在本机插件目录（ssh-hosts.json），不会上传。密码 / 私钥 / 私钥路径 / agent 四选一即可。<br>已有 ~/.ssh/config 的无需导入——SSH 面板「⚙ ssh config」自动加载（与 VSCode Remote-SSH 同源，支持 Include / ProxyJump / ProxyCommand），点别名直连。</div>
			<div class="sshcfg-import vsc-hidden"></div>
			<div class="btns"><button class="cancel">取消</button><button class="import-cfg" title="从 ~/.ssh/config 批量导入主机">从 ssh config 导入</button><button class="primary save-host">保存</button></div>
		</div>
	</div>
</div>`;

		const root = container.querySelector(".vsc");
		const treeEl = root.querySelector(".vsc-tree");
		const hostsEl = root.querySelector(".vsc-hosts");
		const sshTreeEl = root.querySelector(".vsc-sshtree");
		const tabsEl = root.querySelector(".vsc-tabs");
		const saveBtnEl = root.querySelector(".vsc-savebtn");
		const saveAsBtnEl = root.querySelector(".vsc-saveasbtn");
		const langBtnEl = root.querySelector(".vsc-langbtn");
		const edHost = root.querySelector(".vsc-editor");
		const emptyEl = root.querySelector(".vsc-empty");
		const stScope = root.querySelector(".vsc-scope");
		const stPath = root.querySelector(".vsc-path");
		const stLang = root.querySelector(".vsc-lang");
		const stPos = root.querySelector(".vsc-pos");
		const stState = root.querySelector(".vsc-state");
		const stUp = root.querySelector(".vsc-up");
		const quick = root.querySelector(".vsc-quickopen");
		const quickInput = quick.querySelector("input");
		const quickList = quick.querySelector("ul");
		const menuEl = root.querySelector(".vsc-menu");
		const filePick = root.querySelector(".vsc-filepick");
		const folderPick = root.querySelector(".vsc-folderpick");
		try {
			folderPick?.setAttribute("webkitdirectory", "");
		} catch {}
		const hostBg = root.querySelector(".vsc-host-bg");
		const dragEl = root.querySelector(".vsc-termdrag");
		const panelEl = root.querySelector(".vsc-termpanel");
		const termTabsEl = root.querySelector(".vsc-termbar .tts");
		const termAreaEl = root.querySelector(".vsc-termarea");

		const burger = root.querySelector(".vsc-burger");
		const backdrop = root.querySelector(".vsc-backdrop");
		function closeDrawer() {
			root.classList.remove("drawer-open");
		}
		if (burger) burger.addEventListener("click", () => root.classList.toggle("drawer-open"));
		if (backdrop) backdrop.addEventListener("click", closeDrawer);

		const pending = new Map();
		function request(payload) {
			const reqId = `r${++reqSeq}`;
			return new Promise((resolve) => {
				pending.set(reqId, resolve);
				ctx.send({ ...payload, reqId, lang });
				setTimeout(() => {
					if (pending.delete(reqId)) resolve({ ok: false, error: tr("timeoutErr") });
				}, 60000);
			});
		}
		function req(scope, payload) {
			return scope === "local" ? request(payload) : request({ connId: scope, ...payload });
		}

		function toast(text) {
			root.dispatchEvent(new CustomEvent("vsc-toast", { detail: text, bubbles: true }));
			stState.textContent = text;
			stState.classList.add("vsc-err");
			setTimeout(() => {
				stState.textContent = "";
				stState.classList.remove("vsc-err");
			}, 4000);
		}

		function copyText(text) {
			const done = () => toast(tr("copiedPath"));
			const fallback = () => {
				try {
					const ta = document.createElement("textarea");
					ta.value = text;
					document.body.appendChild(ta);
					ta.select();
					document.execCommand("copy");
					document.body.removeChild(ta);
					done();
				} catch {
					toast(tr("copyFail"));
				}
			};
			try {
				if (navigator.clipboard?.writeText) void navigator.clipboard.writeText(text).then(done, fallback);
				else fallback();
			} catch {
				fallback();
			}
		}

		async function pasteClipboardTo(scope, dir) {
			if (!clipboard || clipboard.scope !== scope) {
				toast(tr("pasteEmpty"));
				return;
			}
			const dest = dir ? `${dir.replace(/\/$/, "")}/${clipboard.src.split("/").pop()}` : clipboard.src.split("/").pop();
			if (dest === clipboard.src) {
				toast(tr("sameSrcDst"));
				return;
			}
			const wasCut = clipboard.cut;
			const src = clipboard.src;
			const r = await req(scope, { action: "copy", src, dest, move: wasCut });
			if (!r.ok) {
				toast(tr("pasteFail", { error: r.error }));
				return;
			}
			if (wasCut) {
				clipboard = null;
				for (const k of [...tabs.keys()]) {
					const { scope: s, path } = parseTk(k);
					if (s === scope && (path === src || path.startsWith(src + "/"))) void closeTab(k);
				}
			}
			await invalidateScope(scope);
		}

		async function duplicateEntry(scope, srcW, type) {
			const dir = scope === "local" ? localParentOf(srcW) : parentOf(srcW);
			const base = srcW.split("/").pop();
			const dot = type === "dir" ? -1 : base.lastIndexOf(".");
			const stem = dot > 0 ? base.slice(0, dot) : base;
			const ext = dot > 0 ? base.slice(dot) : "";
			let siblings = new Set();
			try {
				const r = await req(scope, { action: "list", dir: dir === "" ? "" : dir });
				if (r.ok) siblings = new Set((r.entries ?? []).map((e) => e.name));
			} catch {}
			for (let i = 0; i < 20; i++) {
				const name = i === 0 ? `${stem}_copy${ext}` : `${stem}_copy${i + 1}${ext}`;
				if (siblings.has(name)) continue;
				const dest = dir ? `${dir.replace(/\/$/, "")}/${name}` : name;
				const r = await req(scope, { action: "copy", src: srcW, dest });
				if (r.ok) {
					selNode = { scope, path: dest, type };
					await invalidateScope(scope);
					return;
				}
				if (r && r.code !== "VSC_TARGET_EXISTS" && !/已存在|already exists/i.test(String(r.error ?? ""))) {
					toast(tr("dupFail", { error: r.error }));
					return;
				}
			}
			toast(tr("dupTooMany"));
		}

		let S = {
			depsReady: true,
			depsInstalling: false,
			hosts: [],
			conns: [],
			configHosts: [],
			configPath: "~/.ssh/config",
		};
		const conns = new Map();
		const connecting = new Set();
		const expanded = new Set(["local:"]);
		const dirCache = new Map();
		const flatFiles = new Set();
		const tabs = new Map();
		let activeTk = null;
		const multiSel = new Set();
		function refreshSaveBtn() {
			if (!saveBtnEl) return;
			const tb = activeTk ? tabs.get(activeTk) : null;
			const dirty = !!tb?.dirty && !tb?.binary;
			const ro = !!tb?.readonly;
			saveBtnEl.classList.toggle("is-dirty", dirty);
			saveBtnEl.disabled = !tb || !!tb.binary || ro;
			saveBtnEl.textContent = tr("saveBtn");
			saveBtnEl.title = ro ? tr("saveReadonlyTitle") : dirty ? tr("saveDirtyTitle") : tr("saveTitle");
			if (saveAsBtnEl) {
				saveAsBtnEl.disabled = !tb || !!tb.binary || ro || tb.scope !== "local";
				saveAsBtnEl.title = tr("saveAsTitle");
			}
			if (langBtnEl) {
				langBtnEl.textContent = lang === "zh" ? "EN" : "中文";
				langBtnEl.title = tr("langBtnT");
			}
		}
		if (saveBtnEl) saveBtnEl.addEventListener("click", () => void saveActive());
		if (saveAsBtnEl) saveAsBtnEl.addEventListener("click", () => void saveAsActive());
		if (langBtnEl)
			langBtnEl.addEventListener("click", () => {
				setLang(lang === "zh" ? "en" : "zh");
				applyI18n();
			});
		// 插件语言跟随宿主：无手动切换时，跟随 pi-web-ui:lang / pi-web-ui:locale 事件 / navigator
		const followHostLang = (raw) => {
			if (hasPluginLangOverride()) return;
			const mapped = normalizeLangTag(raw);
			if (!mapped || mapped === lang) return;
			lang = mapped;
			applyI18n();
		};
		try {
			window.addEventListener("storage", (ev) => {
				if (ev.key === HOST_LANG_KEY) followHostLang(ev.newValue);
			});
		} catch {}
		try {
			window.addEventListener(UI_LOCALE_EVENT, (ev) => followHostLang(ev.detail));
		} catch {}
		let selNode = null;
		let clipboard = null;

		const TITLE_BY_ACT = {
			"new-file": "newFileT",
			"new-dir": "newDirT",
			upload: "uploadT",
			"upload-folder": "uploadFolderT",
			search: "searchLocalT",
			refresh: "refreshT",
			zip: "zipT",
			extract: "extractT",
			"add-host": "addHostT",
			deps: "depsT",
			"new-term": "newTermT",
			"r-new-file": "newFileT",
			"r-new-dir": "newDirT",
			"r-upload": "uploadRemoteT",
			"r-upload-folder": "uploadFolderRemoteT",
			"r-search": "searchRemoteT",
			"r-refresh": "refreshRemoteT",
			"r-zip": "zipT",
			"r-extract": "extractT",
		};
		const LABEL_BY_NAME = {
			"h-name": "hostNameL",
			"h-host": "hostHostL",
			"h-port": "hostPortL",
			"h-user": "hostUserL",
			"h-pass": "hostPassL",
			"h-key": "hostKeyL",
			"h-keypath": "hostKeyPathL",
			"h-pp": "hostPpL",
			"h-agent": "hostAgentL",
		};
		function fmtSize(n) {
			if (!Number.isFinite(n)) return "";
			if (n >= 1048576) return `${(n / 1048576).toFixed(1)} MB`;
			if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
			return `${n} B`;
		}
		function applyI18n() {
			const stabFiles = root.querySelector('.stab[data-pane="files"]');
			if (stabFiles) stabFiles.textContent = tr("filesTab");
			const stabSsh = root.querySelector('.stab[data-pane="ssh"]');
			if (stabSsh) stabSsh.textContent = tr("sshTab");
			root.querySelectorAll(".vsc-side-head button[data-act]").forEach((b) => {
				const k = TITLE_BY_ACT[b.dataset.act];
				if (k) b.title = tr(k);
			});
			const burger = root.querySelector(".vsc-burger");
			if (burger) burger.title = tr("burgerT");
			const mtitle = root.querySelector(".vsc-mtitle");
			if (mtitle) mtitle.textContent = tr("mobileTitle");
			if (emptyEl) emptyEl.innerHTML = `${esc(tr("emptyMain"))}<br><small>${esc(tr("emptyHint"))}</small>`;
			const tt = root.querySelector(".vsc-termbar .tt");
			if (tt) tt.textContent = tr("termTitle");
			const tAdd = root.querySelector(".vsc-termbar .t-add");
			if (tAdd) tAdd.title = tr("newTermBtnT");
			const tHide = root.querySelector(".vsc-termbar .t-hide");
			if (tHide) tHide.title = tr("hidePanelT");
			if (quickInput) quickInput.placeholder = tr("quickPh");
			hostBg.querySelectorAll("input[name], textarea[name]").forEach((el) => {
				const k = LABEL_BY_NAME[el.getAttribute("name")];
				if (!k) return;
				const wrap = el.closest("span");
				const lab = wrap ? wrap.querySelector("label") : el.previousElementSibling;
				if (lab && lab.tagName === "LABEL") lab.textContent = tr(k);
			});
			const hintEl = hostBg.querySelector(".vsc-modal > .hint");
			if (hintEl) hintEl.innerHTML = tr("hostHint");
			const cancelEl = hostBg.querySelector(".cancel");
			if (cancelEl) cancelEl.textContent = tr("cancelB");
			const saveHostEl = hostBg.querySelector(".save-host");
			if (saveHostEl) saveHostEl.textContent = tr("saveB");
			const importCfgEl = hostBg.querySelector(".import-cfg");
			if (importCfgEl) {
				importCfgEl.textContent = tr("importCfgB");
				importCfgEl.title = tr("importCfgT");
			}
			refreshSaveBtn();
			renderTabs();
			renderHosts();
			void renderTree();
			if (activeTk && tabs.has(activeTk)) {
				try {
					updateStatus(view.state);
				} catch {}
			}
		}

		const tkey = (scope, p) => `${scope}:${p}`;
		function parseTk(k) {
			const i = k.indexOf(":");
			return { scope: k.slice(0, i), path: k.slice(i + 1) };
		}
		function connMeta(connId) {
			return S.conns.find((x) => x.connId === connId);
		}
		function connOfHost(hostId) {
			for (const id of conns.keys()) {
				if (connMeta(id)?.hostId === hostId) return id;
			}
			return null;
		}
		function connLabel(connId) {
			return conns.get(connId)?.label ?? connMeta(connId)?.label ?? connId;
		}

		function applyState(next) {
			S = next ?? S;
			for (const c of S.conns) {
				if (c.status === "connected" && !conns.has(c.connId)) {
					conns.set(c.connId, { label: c.label, cwd: "/" });
				}
			}
			void renderTree();
			renderHosts();
		}

		const langComp = new Compartment();
		const themeComp = new Compartment();

		function makeExtensions() {
			return [
				lineNumbers(),
				highlightActiveLineGutter(),
				highlightSpecialChars(),
				history(),
				foldGutter(),
				drawSelection(),
				dropCursor(),
				EditorState.allowMultipleSelections.of(true),
				EditorState.readOnly.of(!!tabs.get(activeTk)?.readonly),
				indentOnInput(),
				indentUnit.of("    "),
				syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
				bracketMatching(),
				closeBrackets(),
				autocompletion(),
				rectangularSelection(),
				crosshairCursor(),
				highlightActiveLine(),
				highlightSelectionMatches(),
				keymap.of([
					...closeBracketsKeymap,
					...defaultKeymap,
					...searchKeymap,
					...historyKeymap,
					...foldKeymap,
					...completionKeymap,
					...lintKeymap,
					indentWithTab,
					Prec.highest(
						keymap.of([
							{
								key: "Mod-s",
								run: () => {
									void saveActive();
									return true;
								},
							},
							{
								key: "Mod-Shift-s",
								run: () => {
									void saveAsActive();
									return true;
								},
							},
							{
								key: "Mod-p",
								run: () => {
									openQuickOpen();
									return true;
								},
							},
						]),
					),
				]),
				langComp.of(langFor(parseTk(activeTk ?? "local:")?.path ?? "") ?? []),
				themeComp.of(isLightTheme() ? cmLight : oneDark),
				EditorView.updateListener.of((u) => {
					if (u.docChanged || u.selectionSet) updateStatus(u.state);
					if (u.docChanged) {
						const t = tabs.get(activeTk);
						if (t && !t.binary && !t.dirty) {
							t.dirty = true;
							renderTabs();
						}
					}
				}),
			];
		}

		const view = new EditorView({ state: EditorState.create({ extensions: makeExtensions() }), parent: edHost });

		function currentDoc() {
			return view.state.doc.toString();
		}

		function updateStatus(state) {
			const head = state.selection.main.head;
			const line = state.doc.lineAt(head);
			stPos.textContent = tr("lineCol", { line: line.number, col: head - line.from + 1 });
			if (activeTk) {
				const tb = tabs.get(activeTk);
				stState.textContent = tb?.binary
					? tr("binarySt")
					: tb?.readonly
						? tr("bigReadonlySt")
						: tb?.conflict
							? tr("conflictSt")
							: tb?.dirty
								? tr("unsavedSt")
								: tr("savedSt");
				stState.classList.toggle("dirty", !!tb?.dirty || !!tb?.conflict);
			}
			refreshSaveBtn();
		}

		async function ensureDir(scope, dirWire) {
			const key = tkey(scope, dirWire ?? "");
			if (!dirCache.has(key)) {
				const r = await req(scope, { action: "list", dir: dirWire ?? "" });
				if (!r.ok) {
					toast(tr("readDirFail", { error: r.error }));
					return [];
				}
				dirCache.set(key, r.entries);
				if (scope === "local") {
					for (const e of r.entries) {
						if (e.type === "file") flatFiles.add(dirWire ? `${dirWire}/${e.name}` : e.name);
					}
				}
			}
			return dirCache.get(key);
		}

		function switchPane(name) {
			root.querySelectorAll(".vsc-stabs .stab").forEach((b) => b.classList.toggle("active", b.dataset.pane === name));
			root.querySelectorAll(".vsc-pane").forEach((p) => p.classList.toggle("vsc-hidden", p.dataset.pane !== name));
		}
		root.querySelector(".vsc-stabs").addEventListener("click", (ev) => {
			const b = ev.target.closest(".stab");
			if (b) switchPane(b.dataset.pane);
		});

		let renderChain = Promise.resolve();
		function enqueue(fn) {
			renderChain = renderChain.then(fn, fn);
			return renderChain;
		}

		async function renderTree() {
			await enqueue(async () => {
				const st = treeEl.scrollTop;
				treeEl.innerHTML = "";
				const lh = document.createElement("div");
				lh.className = "vsc-sect";
				lh.innerHTML = `<b>${tr("localRoot")}</b>`;
				treeEl.appendChild(lh);
				await renderDir("local", "", treeEl, 0);
				renderTreeHighlight();
				applySelHighlight();
				treeEl.scrollTop = st;
			});
		}

		function renderHosts() {
			const st = hostsEl.scrollTop;
			hostsEl.innerHTML = "";
			const depsBtn = root.querySelector('.vsc-pane[data-pane="ssh"] button[data-act="deps"]');
			depsBtn.classList.toggle("vsc-hidden", Boolean(S.depsReady));
			depsBtn.title = S.depsInstalling ? tr("depsBusyT") : tr("depsT");
			if (!S.depsReady && S.depsInstalling) {
				const d = document.createElement("div");
				d.className = "vsc-deps";
				d.textContent = tr("depsBusy");
				hostsEl.appendChild(d);
			}
			if (!S.hosts.length && !(S.configHosts ?? []).length) {
				const d = document.createElement("div");
				d.className = "vsc-deps";
				const btn = document.createElement("button");
				btn.textContent = tr("noHost");
				btn.addEventListener("click", () => openHostModal(null));
				d.appendChild(btn);
				hostsEl.appendChild(d);
			}
			if ((S.configHosts ?? []).length) {
				const sec = document.createElement("div");
				sec.className = "vsc-sect";
				sec.innerHTML = `<b>${tr("sshConfigSec")}</b>`;
				const edit = document.createElement("button");
				edit.textContent = "✎";
				edit.title = tr("editCfgT", { path: S.configPath ?? "~/.ssh/config" });
				edit.addEventListener("click", () => void openSshConfigEditor());
				sec.appendChild(edit);
				hostsEl.appendChild(sec);
				for (const c of S.configHosts) renderConfigRow(c);
			}
			if ((S.configHosts ?? []).length && S.hosts.length) {
				const sec = document.createElement("div");
				sec.className = "vsc-sect";
				sec.innerHTML = `<b>${tr("manualSec")}</b>`;
				hostsEl.appendChild(sec);
			}
			for (const h of S.hosts) renderHostRow(h);
			hostsEl.scrollTop = st;
			void renderRemoteTrees();
		}

		async function renderRemoteTrees() {
			await enqueue(async () => {
				const st = sshTreeEl.scrollTop;
				sshTreeEl.innerHTML = "";
				for (const [connId, c] of conns) {
					const sec = document.createElement("div");
					sec.className = "vsc-sect";
					sec.innerHTML = `<b>🖥 ${esc(c.label)}</b><span class="cwd" title="${esc(c.cwd)}">${esc(c.cwd)}</span>`;
					sshTreeEl.appendChild(sec);
					const sub = document.createElement("div");
					sshTreeEl.appendChild(sub);
					await renderConnTree(connId, sub);
				}
				if (!conns.size) {
					const d = document.createElement("div");
					d.className = "vsc-deps";
					d.textContent = tr("remoteEmpty");
					sshTreeEl.appendChild(d);
				}
				sshTreeEl.scrollTop = st;
				applySelHighlight();
			});
		}

		function renderConfigRow(c) {
			const row = document.createElement("div");
			row.className = "vsc-row vsc-hrow";
			row.dataset.cfg = c.alias;
			const busy = connecting.has(`cfg:${c.alias}`);
			const live = [...conns.keys()].find((id) => (conns.get(id)?.label ?? "").startsWith(`${c.alias}（`));
			const dotCls = busy ? "busy" : live ? "on" : "";
			const via = c.proxyJump ? ` ⇢ ${esc(c.proxyJump)}` : c.proxyCommand ? " ⇢ ⬢" : "";
			row.innerHTML =
				`<span class="dot ${dotCls}"></span>` +
				`<span class="nm" title="${esc(c.username)}@${esc(c.host)}:${c.port}${c.privateKeyPath ? ` · ${esc(c.privateKeyPath)}` : ""}">${esc(c.alias)}<span style="opacity:.5"> ${esc(c.username)}@${esc(c.host)}${via}</span></span>` +
				`<span class="ops">` +
				(live
					? `<button data-hop="term" title="${tr("newTermBtnT")}">🖥</button>`
					: `<button data-hop="conn" title="${tr("connT")}">⇄</button>`) +
				`</span>`;
			row.addEventListener("click", async (ev) => {
				const btn = ev.target.closest("button[data-hop]");
				if (btn?.dataset.hop === "term" && live) {
					showTermPanel();
					void newTerm(live);
					return;
				}
				if (btn) ev.stopPropagation();
				if (live) {
					showTermPanel();
					void newTerm(live);
					return;
				}
				await connectConfig(c.alias);
			});
			hostsEl.appendChild(row);
		}

		function renderHostRow(h) {
			const connId = connOfHost(h.id);
			const row = document.createElement("div");
			row.className = "vsc-row vsc-hrow";
			row.dataset.host = h.id;
			const busy = connecting.has(h.id) || connMeta(connId)?.status === "connecting";
			const dotCls = busy ? "busy" : connId ? "on" : "";
			row.innerHTML =
				`<span class="dot ${dotCls}"></span>` +
				`<span class="nm" title="${esc(h.username)}@${esc(h.host)}:${h.port}">${esc(h.name || h.host)}</span>` +
				`<span class="ops">` +
				(connId
					? `<button data-hop="term" title="${tr("newTermBtnT")}">🖥</button><button data-hop="dis" title="${tr("disT")}">⏏</button>`
					: `<button data-hop="conn" title="${tr("connT")}">⇄</button>`) +
				`<button data-hop="edit" title="${tr("editT")}">✎</button>` +
				`<button data-hop="del" title="${tr("delT")}">🗑</button></span>`;
			row.addEventListener("click", async (ev) => {
				const btn = ev.target.closest("button[data-hop]");
				if (btn) {
					ev.stopPropagation();
					if (btn.dataset.hop === "edit") openHostModal(h);
					else if (btn.dataset.hop === "del") {
						if (confirm(tr("confirmDelHost", { name: h.name || h.host }))) {
							const r = await request({ action: "hosts_delete", id: h.id });
							if (!r.ok) toast(tr("delFail", { error: r.error }));
							else renderHosts();
						}
					} else if (btn.dataset.hop === "term" && connId) {
						showTermPanel();
						void newTerm(connId);
					} else if (btn.dataset.hop === "dis" && connId) {
						void request({ action: "disconnect", connId });
					} else if (btn.dataset.hop === "conn") void connectHost(h);
					return;
				}
				if (!connId) {
					await connectHost(h);
					return;
				}
				showTermPanel();
				void newTerm(connId);
			});
			hostsEl.appendChild(row);
		}

		async function renderConnTree(connId, parentEl) {
			const c = conns.get(connId);
			if (!c) return;
			if (c.cwd && c.cwd !== "/") {
				const up = document.createElement("div");
				up.className = "vsc-row";
				up.style.paddingLeft = "22px";
				up.innerHTML = `<span class="caret"></span><span>⬆</span><span class="nm">..</span>`;
				up.addEventListener("click", async () => {
					c.cwd = parentOf(c.cwd);
					for (const key of [...dirCache.keys()]) {
						if (key.startsWith(`${connId}:`)) dirCache.delete(key);
					}
					renderHosts();
				});
				parentEl.appendChild(up);
			}
			await renderDir(connId, c.cwd, parentEl, 1);
		}

		async function renderDir(scope, dirWire, parentEl, depth) {
			const entries = await ensureDir(scope, dirWire);
			await renderEntries(scope, entries, dirWire, parentEl, depth);
		}

		async function renderEntries(scope, entries, dirWire, parentEl, depth) {
			for (const e of entries) {
				const p = dirWire ? `${dirWire.replace(/\/$/, "")}/${e.name}` : e.name;
				const row = document.createElement("div");
				row.className = "vsc-row";
				row.style.paddingLeft = `${8 + depth * 14}px`;
				row.dataset.scope = scope;
				row.dataset.path = p;
				row.dataset.type = e.type;
				row.dataset.depth = depth;
				const ek = tkey(scope, p);
				const isOpen = expanded.has(ek);
				row.innerHTML =
					`<span class="caret">${e.type === "dir" ? (isOpen ? "▾" : "▸") : ""}</span>` +
					`<span>${iconFor(e.name, e.type)}</span><span class="nm">${esc(e.name)}</span>`;
				row.addEventListener("click", async (ev) => {
					if (ev.ctrlKey || ev.metaKey) {
						const k = tkey(scope, p);
						if (multiSel.has(k)) multiSel.delete(k);
						else multiSel.add(k);
						selectNode(scope, p, e.type);
						applySelHighlight();
						return;
					}
					multiSel.clear();
					selectNode(scope, p, e.type);
					if (e.type !== "dir") {
						void openFile(scope, p);
						return;
					}
					const caret = row.querySelector(".caret");
					if (expanded.has(ek)) {
						expanded.delete(ek);
						if (caret) caret.textContent = "▸";
						const sub = row.nextElementSibling;
						if (sub instanceof Element && sub.classList.contains("vsc-sub")) sub.remove();
					} else {
						expanded.add(ek);
						if (caret) caret.textContent = "▾";
						await expandDirInPlace(scope, p, row);
					}
				});
				row.addEventListener("contextmenu", (ev) => {
					ev.preventDefault();
					ev.stopPropagation();
					selectNode(scope, p, e.type);
					if (scope === "local" && window.__piWebUiHost?.openFileContextMenu) {
						window.__piWebUiHost.openFileContextMenu({
							x: ev.clientX,
							y: ev.clientY,
							path: p,
							kind: e.type === "dir" ? "dir" : "file",
							label: p.split("/").pop() || p,
							onHostAction: (actionId) => handleLocalHostAction(actionId, p, e.type),
						});
						return;
					}
					showMenu(ev.clientX, ev.clientY, scope, p, e.type);
				});
				parentEl.appendChild(row);
				if (e.type === "dir" && isOpen) {
					const sub = document.createElement("div");
					sub.className = "vsc-sub";
					sub.dataset.loaded = "1";
					parentEl.appendChild(sub);
					await renderDir(scope, p, sub, depth + 1);
				}
			}
		}

		async function expandDirInPlace(scope, p, row) {
			const ek = tkey(scope, p);
			const depth = Number(row.dataset.depth ?? 0);
			let sub = row.nextElementSibling;
			if (!(sub instanceof Element && sub.classList.contains("vsc-sub"))) {
				sub = document.createElement("div");
				sub.className = "vsc-sub";
				sub.dataset.loaded = "0";
				row.insertAdjacentElement("afterend", sub);
			}
			sub.innerHTML =
				`<div class="vsc-row loading" style="padding-left:${8 + (depth + 1) * 14}px">` +
				`<span class="caret"></span><span>⏳</span><span class="nm">${tr("loadingDir")}</span></div>`;
			const entries = await ensureDir(scope, p);
			if (!expanded.has(ek)) {
				sub.remove();
				return;
			}
			sub.innerHTML = "";
			sub.dataset.loaded = "1";
			await renderEntries(scope, entries, p, sub, depth + 1);
			applySelHighlight();
		}

		function selectNode(scope, pathW, type) {
			selNode = { scope, path: pathW, type };
			applySelHighlight();
		}

		async function downloadToPC(scope, pathW, isDir = false) {
			const name = pathW.split("/").filter(Boolean).pop() || pathW;
			toast(isDir ? tr("downloadingPack", { name }) : tr("downloadingFile", { name }));
			const payload =
				scope === "local" ? { action: "download", path: pathW } : { action: "download", connId: scope, path: pathW };
			const r = await request(payload);
			if (!r.ok) {
				toast(tr("downloadFail", { error: r.error }));
				return;
			}
			const bin = atob(r.b64);
			const bytes = new Uint8Array(bin.length);
			for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
			saveBlob(new Blob([bytes]), r.name || (isDir ? `${name}.tar.gz` : name));
		}

		function saveBlob(blob, suggestedName) {
			if (window.showSaveFilePicker) {
				window
					.showSaveFilePicker({ suggestedName })
					.then(async (fh) => {
						const w = await fh.createWritable();
						await w.write(blob);
						await w.close();
						stState.textContent = tr("savedAs", { name: suggestedName });
						setTimeout(() => {
							stState.textContent = "";
						}, 3000);
					})
					.catch((e) => {
						if (e?.name === "AbortError") return;
						fallbackAnchor();
					});
				return;
			}
			fallbackAnchor();
			function fallbackAnchor() {
				const url = URL.createObjectURL(blob);
				const a = document.createElement("a");
				a.href = url;
				a.download = suggestedName;
				a.click();
				setTimeout(() => URL.revokeObjectURL(url), 30_000);
			}
		}

		function zipSelection(scope) {
			const keys = [...multiSel].filter((k) => parseTk(k).scope === scope);
			if (keys.length > 1) return keys.map((k) => parseTk(k).path);
			if (selNode && selNode.scope === scope) return [selNode.path];
			return [];
		}

		async function downloadZipFor(scope, paths) {
			const list = (paths ?? []).filter(Boolean);
			if (!list.length) {
				toast(tr("pickForZip"));
				return;
			}
			const label = list.length === 1 ? list[0].split("/").filter(Boolean).pop() : `${list.length} items`;
			toast(tr("downloadingPack", { name: label }));
			setTask(tr("downloadingPack", { name: label }));
			const payload =
				scope === "local"
					? { action: "download_zip", paths: list }
					: { action: "download_zip", connId: scope, paths: list };
			const r = await request(payload);
			if (!r.ok) {
				failTask(label, r.error, () => void downloadZipFor(scope, paths));
				return;
			}
			if (r.fallback === "tar.gz") toast(tr("zipFallbackTar"));
			else if (r.fallback === "node") toast(tr("zipFallbackNode"));
			const bin = atob(r.b64);
			const bytes = new Uint8Array(bin.length);
			for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
			saveBlob(new Blob([bytes]), r.name || "files.zip");
			setTask("");
		}

		async function unzipToHere(scope, dir, suggested) {
			let zipName = suggested;
			if (!zipName) {
				zipName = prompt(tr("promptZipName"));
				if (!zipName) return;
			}
			if (!zipName.toLowerCase().endsWith(".zip")) {
				toast(tr("needZip"));
				return;
			}
			const zipPath = dir ? `${dir.replace(/\/$/, "")}/${zipName}` : zipName;
			const dest = dir || (scope === "local" ? "" : "/");
			await doUnzipPath(scope, zipPath, dest, zipName);
		}

		function applySelHighlight() {
			root
				.querySelectorAll(".vsc-row[data-scope]")
				.forEach((el) =>
					el.classList.toggle(
						"sel",
						multiSel.has(tkey(el.dataset.scope, el.dataset.path)) ||
							(!!selNode && el.dataset.scope === selNode.scope && el.dataset.path === selNode.path),
					),
				);
		}

		function renderTreeHighlight() {
			treeEl
				.querySelectorAll(".vsc-row[data-path]")
				.forEach((el) =>
					el.classList.toggle(
						"active",
						activeTk === tkey(el.dataset.scope, el.dataset.path) && el.dataset.type === "file",
					),
				);
		}

		function renderTabs() {
			tabsEl.innerHTML = "";
			for (const [k, t] of tabs.entries()) {
				const el = document.createElement("div");
				el.className = "vsc-tab" + (k === activeTk ? " active" : "");
				el.innerHTML =
					`<span>${t.scope !== "local" ? "🖥" : iconFor(t.name, "file")}</span>` +
					`<span class="tn">${esc(t.name)}</span>` +
					(t.conflict ? '<span class="dot">⚠</span>' : "") +
					(t.dirty ? '<span class="dot">●</span>' : "") +
					`<button class="x" title="${tr("closeT")}">✕</button>`;
				el.addEventListener("click", (ev) => {
					if (ev.target.closest(".x")) return;
					void activateTab(k);
				});
				el.querySelector(".x").addEventListener("click", () => void closeTab(k));
				tabsEl.appendChild(el);
			}
			refreshSaveBtn();
		}

		async function openFile(scope, p) {
			closeDrawer();
			const k = tkey(scope, p);
			if (!tabs.has(k)) {
				let stSize = 0;
				try {
					const s0 = await req(scope, { action: "stat", path: p });
					if (s0.ok) stSize = s0.size ?? 0;
				} catch {}
				if (stSize > 1024 * 1024) toast(tr("openingBig", { size: fmtSize(stSize) }));
				const r = await req(scope, { action: "read", path: p });
				if (!r.ok) {
					toast(tr("openFail", { error: r.error }));
					return;
				}
				const readonly = !r.binary && (stSize || r.size || 0) > 1024 * 1024;
				tabs.set(k, {
					scope,
					path: p,
					name: p.split("/").pop(),
					savedText: r.text ?? "",
					binary: !!r.binary,
					dirty: false,
					conflict: false,
					readonly,
					savedSize: r.size ?? stSize,
					savedMtime: r.mtimeMs ?? 0,
					crlf: (r.text ?? "").includes("\r\n"),
				});
				if (r.binary) toast(tr("binaryNo"));
				else if (readonly) toast(tr("bigReadonly"));
			}
			await activateTab(k);
		}

		async function activateTab(k) {
			const t = tabs.get(k);
			if (!t) return;
			if (activeTk && activeTk !== k) {
				const cur = tabs.get(activeTk);
				if (cur && cur.dirty && !confirm(tr("confirmSwitch", { name: cur.name }))) return;
			}
			activeTk = k;
			emptyEl.classList.add("vsc-hidden");
			edHost.classList.remove("vsc-hidden");
			view.setState(
				EditorState.create({
					doc: t.binary ? "" : t.savedText,
					extensions: makeExtensions(),
				}),
			);
			t.dirty = false;
			view.dispatch({ effects: langComp.reconfigure(langFor(t.path) ?? []) });
			stScope.textContent = t.scope !== "local" ? `🖥 ${connLabel(t.scope)}` : tr("localScope");
			stScope.classList.toggle("remote", t.scope !== "local");
			stPath.textContent = t.path;
			stLang.textContent = langName(t.path);
			renderTabs();
			renderTreeHighlight();
			updateStatus(view.state);
			view.focus();
		}

		async function saveActive() {
			const tb = tabs.get(activeTk);
			if (!activeTk || !tb || tb.binary || tb.readonly) {
				if (tb?.readonly) toast(tr("readOnlyNo"));
				return false;
			}
			const text = currentDoc();
			const wire = tb.crlf ? text.replace(/\n/g, "\r\n") : text;
			const r = await req(tb.scope, { action: "write", path: tb.path, text: wire });
			if (!r.ok) {
				toast(tr("saveFail", { error: r.error }));
				return true;
			}
			try {
				const back = await req(tb.scope, { action: "read", path: tb.path });
				if (!back.ok) throw new Error(back.error);
				if ((back.text ?? "") !== wire) {
					tb.conflict = true;
					toast(tr("conflictSt"));
					renderTabs();
					updateStatus(view.state);
					return true;
				}
				tb.savedSize = back.size ?? r.bytes ?? wire.length;
				tb.savedMtime = back.mtimeMs ?? 0;
			} catch (err) {
				toast(tr("saveFail", { error: err?.message ?? err }));
				return true;
			}
			tb.savedText = text;
			tb.dirty = false;
			tb.conflict = false;
			renderTabs();
			updateStatus(view.state);
			return true;
		}

		async function saveAsActive() {
			const tb = tabs.get(activeTk);
			if (!activeTk || !tb || tb.binary || tb.readonly) {
				if (tb?.readonly) toast(tr("readOnlyNo"));
				return false;
			}
			if (tb.scope !== "local") {
				toast(tr("saveAsRemoteNo"));
				return false;
			}
			const text = currentDoc();
			const wire = tb.crlf ? text.replace(/\n/g, "\r\n") : text;
			const np = prompt(tr("promptSaveAs"), tb.path);
			if (!np || !np.trim() || np.trim() === tb.path) return false;
			const r = await req("local", { action: "write", path: np.trim(), text: wire });
			if (!r.ok) {
				toast(tr("saveFail", { error: r.error }));
				return false;
			}
			selNode = { scope: "local", path: np.trim(), type: "file" };
			multiSel.clear();
			await invalidateScope("local");
			await openFile("local", np.trim());
			return true;
		}

		async function closeTab(k) {
			const t = tabs.get(k);
			if (t && t.dirty && !confirm(tr("confirmClose", { name: t.name }))) return;
			tabs.delete(k);
			if (activeTk === k) {
				activeTk = null;
				if (tabs.size) await activateTab([...tabs.keys()].pop());
				else {
					emptyEl.classList.remove("vsc-hidden");
					edHost.classList.add("vsc-hidden");
					stScope.textContent = "";
					stPath.textContent = "—";
					stLang.textContent = "";
					stPos.textContent = "";
					stState.textContent = "";
					renderTabs();
				}
			} else renderTabs();
		}

		function closeTabsOfScope(scope) {
			for (const k of [...tabs.keys()]) {
				if (parseTk(k).scope === scope) tabs.delete(k);
			}
			if (activeTk && parseTk(activeTk).scope === scope) {
				activeTk = null;
				if (tabs.size) void activateTab([...tabs.keys()].pop());
				else {
					emptyEl.classList.remove("vsc-hidden");
					edHost.classList.add("vsc-hidden");
					stScope.textContent = "";
					stPath.textContent = "—";
					stLang.textContent = "";
					stPos.textContent = "";
					stState.textContent = "";
				}
			}
			renderTabs();
		}

		async function applyWorkspace(newRoot) {
			dirCache.clear();
			flatFiles.clear();
			flatLoaded = false;
			for (const k of [...expanded]) {
				if (parseTk(k).scope === "local") expanded.delete(k);
			}
			if (selNode?.scope === "local") selNode = null;
			let dirtyLost = 0;
			for (const [k, t] of tabs.entries()) {
				if (parseTk(k).scope === "local" && t.dirty) dirtyLost++;
			}
			if (dirtyLost) {
				multiSel.clear();
				confirm(tr("confirmWorkspace", { n: dirtyLost }));
			}
			closeTabsOfScope("local");
			await renderTree();
			const rootSuffix = newRoot ? tr("wsSep") + newRoot : "";
			toast(tr("workspaceSwitched") + rootSuffix + (dirtyLost ? tr("workspaceDirtyTail", { n: dirtyLost }) : ""));
		}

		let flatLoaded = false;
		async function loadFlat() {
			if (flatLoaded) return;
			const r = await request({ action: "flatlist" });
			if (r.ok) {
				flatLoaded = true;
				for (const f of r.files) flatFiles.add(f);
				if (r.truncated) toast(tr("truncated"));
			}
		}

		let quickSel = 0;
		let quickOverride = null;
		function quickMatches() {
			const q = quickInput.value.trim().toLowerCase();
			if (quickOverride) {
				return quickOverride.filter((x) => !q || x.path.toLowerCase().includes(q)).slice(0, 100);
			}
			const all = [...flatFiles];
			if (!q) return all.slice(0, 100).map((f) => ({ scope: "local", path: f, type: "file" }));
			return all
				.map((f) => ({
					f,
					s: fuzzyScore(quickInput.value.trim(), f.split("/").pop()) + fuzzyScore(quickInput.value.trim(), f) * 0.3,
				}))
				.filter((x) => x.s >= 0)
				.sort((a, b) => b.s - a.s)
				.slice(0, 100)
				.map((x) => ({ scope: "local", path: x.f, type: "file" }));
		}

		function renderQuick() {
			const ms = quickMatches();
			quickSel = Math.min(quickSel, Math.max(0, ms.length - 1));
			quickList.innerHTML =
				ms
					.map(
						(x, i) =>
							`<li data-s="${esc(x.scope)}" data-p="${esc(x.path)}" class="${i === quickSel ? "sel" : ""}">` +
							`${iconFor(x.path.split("/").pop(), x.type)} ${esc(x.path.split("/").pop())}${x.scope !== "local" ? " 🌐" : ""}<small>${esc(x.path)}</small></li>`,
					)
					.join("") || `<li style="opacity:.5;cursor:default">${tr("noMatch")}</li>`;
		}

		function openQuickOpen() {
			quickOverride = null;
			void loadFlat().then(() => {
				quickSel = 0;
				renderQuick();
				quick.classList.remove("vsc-hidden");
				quickInput.focus();
				quickInput.select();
			});
		}

		function closeQuickOpen() {
			quick.classList.add("vsc-hidden");
		}

		quickInput.addEventListener("input", () => {
			quickSel = 0;
			renderQuick();
		});
		quickInput.addEventListener("keydown", (ev) => {
			const ms = quickMatches();
			if (ev.key === "Escape") {
				closeQuickOpen();
				view.focus();
			} else if (ev.key === "ArrowDown") {
				quickSel = Math.min(quickSel + 1, ms.length - 1);
				renderQuick();
				ev.preventDefault();
			} else if (ev.key === "ArrowUp") {
				quickSel = Math.max(quickSel - 1, 0);
				renderQuick();
				ev.preventDefault();
			} else if (ev.key === "Enter" && ms[quickSel] && ms[quickSel].type !== "dir") {
				const t = ms[quickSel];
				closeQuickOpen();
				void openFile(t.scope, t.path);
			}
		});
		quickList.addEventListener("click", (ev) => {
			const li = ev.target.closest("li[data-p]");
			if (!li) return;
			const scope = li.dataset.s || "local";
			if (li.textContent && quickOverride) {
				const hit = quickOverride.find((x) => x.scope === scope && x.path === li.dataset.p);
				if (hit?.type === "dir") return;
			}
			closeQuickOpen();
			void openFile(scope, li.dataset.p);
		});

		async function runSearch(scope, baseOverride) {
			let base = baseOverride ?? "";
			if (scope !== "local" && baseOverride === undefined) {
				const t = pickRemoteDir();
				if (!t) return;
				scope = t.connId;
				base = t.dir;
			}
			const q = prompt(tr("promptSearch"));
			if (!q || !q.trim()) return;
			const r =
				scope === "local"
					? await request({ action: "search", query: q.trim(), base })
					: await request({ action: "search", connId: scope, query: q.trim(), baseDir: base || "/" });
			if (!r.ok) {
				toast(tr("searchFail", { error: r.error }));
				return;
			}
			const list = r.results ?? [];
			if (!list.length) {
				toast(tr("noResult"));
				return;
			}
			if (r.truncated) toast(tr("searchMany"));
			quickOverride = list.map((x) => ({ scope, path: x.path, type: x.type }));
			quickSel = 0;
			quickInput.value = q.trim();
			renderQuick();
			quick.classList.remove("vsc-hidden");
			quickInput.focus();
			quickInput.select();
		}

		function handleLocalHostAction(actionId, pathW, type) {
			const _base = pathW.split("/").filter(Boolean).pop() || "";
			const _dir = type === "dir" ? pathW : localParentOf(pathW);
			switch (actionId) {
				case "host:file-new-file":
					void promptCreate("local", _dir, "file");
					return true;
				case "host:file-new-dir":
					void promptCreate("local", _dir, "dir");
					return true;
				case "host:file-rename":
					void (async () => {
						const nn = prompt(tr("promptNewName"), _base);
						if (!nn || nn === _base) return;
						const r = await req("local", { action: "rename", path: pathW, newName: nn });
						if (!r.ok) {
							toast(tr("renameFail", { error: r.error }));
							return;
						}
						await invalidateScope("local");
					})();
					return true;
				case "host:file-delete":
					void (async () => {
						if (!confirm(tr(type === "dir" ? "confirmDelDir" : "confirmDelFile", { path: pathW }))) return;
						const r = await req("local", { action: "delete", path: pathW, isDir: type === "dir" });
						if (!r.ok) {
							toast(tr("delFail", { error: r.error }));
							return;
						}
						for (const k of [...tabs.keys()]) {
							const { scope: s, path } = parseTk(k);
							if (s === "local" && (path === pathW || path.startsWith(pathW + "/"))) void closeTab(k);
						}
						await invalidateScope("local");
					})();
					return true;
				case "host:file-duplicate":
					void duplicateEntry("local", pathW, type);
					return true;
				case "host:file-cut":
					clipboard = { scope: "local", src: pathW, cut: true };
					toast(tr("cutToast", { name: _base }));
					return true;
				case "host:file-copy":
					clipboard = { scope: "local", src: pathW, cut: false };
					toast(tr("copyToast", { name: _base }));
					return true;
				case "host:file-paste":
					void pasteClipboardTo("local", _dir);
					return true;
				case "host:file-upload":
					void (async () => {
						const files = await pickFiles();
						if (files.length) void uploadFilesTo("local", _dir, files);
					})();
					return true;
				case "host:file-download":
					void downloadToPC("local", pathW, type === "dir");
					return true;
				case "host:file-open":
					if (type !== "dir") void openFile("local", pathW);
					return true;
				case "host:file-refresh":
					void refreshAll();
					return true;
			}
			return false;
		}

		function parentOf(dir) {
			if (!dir || dir === "/" || dir === ".") return "/";
			const s = dir.replace(/\/$/, "");
			const idx = s.lastIndexOf("/");
			return idx <= 0 ? "/" : s.slice(0, idx);
		}

		function showMenu(x, y, scope, pathW, type) {
			menuEl.innerHTML = "";
			const items = [];
			const rowDir = type === "dir" ? pathW : scope === "local" ? localParentOf(pathW) : parentOf(pathW);
			const fileName = pathW.split("/").pop();
			if (type === "dir") {
				items.push(
					[
						tr("mNewFile"),
						async () => {
							await promptCreate(scope, pathW, "file");
						},
					],
					[
						tr("mNewDir"),
						async () => {
							await promptCreate(scope, pathW, "dir");
						},
					],
					[
						tr("mUploadHere"),
						async () => {
							const files = await pickFiles();
							if (files.length) void uploadFilesTo(scope, pathW, files);
						},
					],
					[
						tr("mUploadFolderHere"),
						async () => {
							const files = await pickFolder();
							if (files.length) void uploadFilesTo(scope, pathW, files);
						},
					],
					[tr("mDownloadZip"), () => void downloadZipFor(scope, [pathW])],
				);
				if (scope === "local") {
					items.push([tr("mDownloadTar"), () => void downloadToPC(scope, pathW, true)]);
				}
			} else {
				items.push([tr("mDownload"), () => void downloadToPC(scope, pathW, false)]);
				if (pathW.toLowerCase().endsWith(".zip")) {
					items.push([tr("mExtractHere"), () => void unzipToHere(scope, rowDir, fileName)]);
				}
				items.push([
					tr("mUploadHere"),
					async () => {
						const files = await pickFiles();
						const dir = scope === "local" ? localParentOf(pathW) : parentOf(pathW);
						if (files.length) void uploadFilesTo(scope, dir, files);
					},
				]);
				items.push([
					tr("mUploadFolderHere"),
					async () => {
						const files = await pickFolder();
						const dir = scope === "local" ? localParentOf(pathW) : parentOf(pathW);
						if (files.length) void uploadFilesTo(scope, dir, files);
					},
				]);
			}
			const _base = fileName;
			const _rowDir = rowDir;
			items.push(
				[
					tr("mCut"),
					() => {
						clipboard = { scope, src: pathW, cut: true };
						toast(tr("cutToast", { name: _base }));
					},
				],
				[
					tr("mCopy"),
					() => {
						clipboard = { scope, src: pathW, cut: false };
						toast(tr("copyToast", { name: _base }));
					},
				],
			);
			if (clipboard && clipboard.scope === scope) {
				items.push([clipboard.cut ? tr("mPasteMove") : tr("mPaste"), () => void pasteClipboardTo(scope, _rowDir)]);
			}
			items.push(
				[tr("mDuplicate"), () => void duplicateEntry(scope, pathW, type)],
				[tr("mCopyPath"), () => copyText(pathW)],
			);
			items.push(
				[
					tr("mRename"),
					async () => {
						const nn = prompt(tr("promptNewName"), pathW.split("/").pop());
						if (!nn || nn === pathW.split("/").pop()) return;
						const r = await req(scope, { action: "rename", path: pathW, newName: nn });
						if (!r.ok) {
							toast(tr("renameFail", { error: r.error }));
							return;
						}
						await invalidateScope(scope);
					},
				],
				[
					tr("mDelete"),
					async () => {
						if (!confirm(tr(type === "dir" ? "confirmDelDir" : "confirmDelFile", { path: pathW }))) return;
						const r = await req(scope, { action: "delete", path: pathW, isDir: type === "dir" });
						if (!r.ok) {
							toast(tr("delFail", { error: r.error }));
							return;
						}
						for (const k of [...tabs.keys()]) {
							const { scope: s, path } = parseTk(k);
							if (s === scope && (path === pathW || path.startsWith(pathW + "/"))) void closeTab(k);
						}
						await invalidateScope(scope);
					},
				],
			);
			if (scope !== "local") {
				items.push([
					tr(type === "dir" ? "mOpenTermHere" : "mOpenTermInDir"),
					async () => {
						const dir = type === "dir" ? pathW : parentOf(pathW);
						conns.get(scope).cwd = dir;
						showTermPanel();
						await newTerm(scope, dir);
					},
				]);
			}
			for (const [label, fn] of items) {
				const b = document.createElement("button");
				b.textContent = label;
				if (!fn) b.className = "dim";
				else
					b.addEventListener("click", () => {
						hideMenu();
						void fn();
					});
				menuEl.appendChild(b);
			}
			menuEl.classList.remove("vsc-hidden");
			const rect = root.getBoundingClientRect();
			menuEl.style.left = `${Math.min(x - rect.left, rect.width - 170)}px`;
			menuEl.style.top = `${Math.min(y - rect.top, rect.height - items.length * 32 - 20)}px`;
		}
		function hideMenu() {
			menuEl.classList.add("vsc-hidden");
		}
		document.addEventListener("click", hideMenu);

		async function invalidateScope(scope) {
			for (const key of [...dirCache.keys()]) {
				if (key.startsWith(`${scope}:`)) dirCache.delete(key);
			}
			if (scope === "local") {
				flatFiles.clear();
				flatLoaded = false;
			}
			await renderTree();
			renderHosts();
		}

		async function promptCreate(scope, dirWire, kind) {
			const name = prompt(kind === "dir" ? tr("promptNewDir") : tr("promptNewFile"));
			if (!name) return;
			const p = dirWire ? `${dirWire.replace(/\/$/, "")}/${name.trim()}` : name.trim();
			const r = await req(scope, { action: "create", path: p, kind });
			if (!r.ok) {
				toast(tr("createFail", { error: r.error }));
				return;
			}
			expanded.add(tkey(scope, dirWire));
			selNode = { scope, path: p, type: kind };
			if (kind === "file") void openFile(scope, p);
			await invalidateScope(scope);
		}

		async function refreshAll() {
			let dirtyCount = 0;
			for (const [, tb] of tabs.entries()) if (!tb.binary && tb.dirty) dirtyCount++;
			if (dirtyCount && !confirm(tr("confirmRefresh", { n: dirtyCount }))) return;
			dirCache.clear();
			flatFiles.clear();
			flatLoaded = false;
			for (const [k, t] of tabs.entries()) {
				if (t.binary) continue;
				const r = await req(t.scope, { action: "read", path: t.path });
				if (r.ok && r.text != null) {
					if (t.dirty && r.text !== t.savedText) {
						t.conflict = true;
						toast(tr("conflictSt"));
					} else {
						t.savedText = r.text;
						t.crlf = r.text.includes("\r\n");
						t.dirty = false;
						t.conflict = false;
					}
					t.savedSize = r.size;
					t.savedMtime = r.mtimeMs;
				}
			}
			if (activeTk && tabs.has(activeTk)) await activateTab(activeTk);
			await renderTree();
			renderTabs();
			renderHosts();
		}

		const UPLOAD_CHUNK = 512 * 1024;
		let uploading = false;
		let taskRetry = null;
		function setTask(text, retry) {
			taskRetry = typeof retry === "function" ? retry : null;
			stUp.textContent = text ?? "";
			stUp.classList.toggle("retry", !!taskRetry);
			try {
				stUp.title = taskRetry ? tr("retryHint") : "";
			} catch {}
		}
		function failTask(label, error, retry) {
			const msg = tr("taskRetry", { label, error: error ?? "" });
			setTask(msg, retry);
			toast(msg + tr("retryHint"));
		}
		if (!stUp.dataset.retryBound) {
			stUp.dataset.retryBound = "1";
			stUp.addEventListener("click", () => {
				const fn = taskRetry;
				if (!fn) return;
				taskRetry = null;
				stUp.classList.remove("retry");
				toast(tr("retrying", { label: "" }).replace(/\s*[…\.]+\s*$/, "…"));
				void fn();
			});
		}

		function pickFiles() {
			return new Promise((resolve) => {
				filePick.onchange = () => {
					const files = [...(filePick.files ?? [])];
					filePick.value = "";
					resolve(files);
				};
				filePick.click();
			});
		}

		function pickFolder() {
			return new Promise((resolve) => {
				if (!folderPick) {
					resolve([]);
					return;
				}
				folderPick.onchange = () => {
					const files = [...(folderPick.files ?? [])];
					folderPick.value = "";
					resolve(files);
				};
				folderPick.click();
			});
		}

		function isZipName(name) {
			return String(name ?? "")
				.toLowerCase()
				.endsWith(".zip");
		}

		function joinUploadDir(scope, baseDir, sub) {
			const b = String(baseDir ?? "");
			const s = String(sub ?? "").replace(/^\/+/, "");
			if (!s) return b;
			if (!b) return scope === "local" ? s : `/${s}`;
			return `${b.replace(/\/+$/, "")}/${s}`;
		}

		function targetDirFor(scope, baseDir, file) {
			const raw = String(file?._relPath || file?.webkitRelativePath || file?.name || "").replace(/\\/g, "/");
			const parts = raw.split("/").filter(Boolean);
			if (parts.length <= 1) return baseDir;
			if (parts.includes("..") || parts.includes(".")) return baseDir;
			return joinUploadDir(scope, baseDir, parts.slice(0, -1).join("/"));
		}

		function fileDisplayRel(file) {
			return String(file?._relPath || file?.webkitRelativePath || file?.name || "");
		}

		function bufToB64(u8) {
			let bin = "";
			for (let i = 0; i < u8.length; i += 0x8000) {
				bin += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
			}
			return btoa(bin);
		}

		function setUploadProgress(text) {
			setTask(text);
		}

		async function uploadOne(scope, baseDir, file, prog) {
			const rel = fileDisplayRel(file);
			const leaf = String(rel).split("/").filter(Boolean).pop() || file.name;
			const name = leaf;
			const dir = targetDirFor(scope, baseDir, file);
			if (file.size > 100 * 1024 * 1024) {
				toast(tr("tooBigSkip", { name: rel || name }));
				return false;
			}
			const begin = await req(scope, { action: "upload_begin", dir, name, size: file.size });
			if (!begin.ok) {
				toast(tr("uploadFail", { error: begin.error }));
				return false;
			}
			if (begin.exists && !confirm(tr("coverConfirm", { name: rel || name }))) {
				void request({ action: "upload_abort", uploadId: begin.uploadId });
				return false;
			}
			const total = Math.max(1, Math.ceil(file.size / UPLOAD_CHUNK));
			try {
				for (let i = 0; i < total; i++) {
					const slice = file.slice(i * UPLOAD_CHUNK, (i + 1) * UPLOAD_CHUNK);
					const u8 = new Uint8Array(await slice.arrayBuffer());
					const r = await req(scope, { action: "upload", uploadId: begin.uploadId, i, total, b64: bufToB64(u8) });
					if (!r.ok) throw new Error(r.error);
					if (prog)
						setTask(
							tr("uploadProg", { done: prog.done, total: prog.total, name: rel || name, chunk: i + 1, chunks: total }),
						);
					else setTask(`⬆ ${rel || name}（${i + 1}/${total}）`);
				}
				return true;
			} catch (err) {
				void request({ action: "upload_abort", uploadId: begin.uploadId });
				toast(tr("uploadOneFail", { name: rel || name, error: err?.message ?? err }));
				return false;
			}
		}

		async function doUnzipPath(scope, zipWire, destWire, label) {
			setTask(tr("unzipping", { name: label }));
			const r = await req(scope, { action: "unzip", zip: zipWire, dest: destWire });
			if (!r.ok) {
				failTask(
					label,
					r.error,
					() => void doUnzipPath(scope, zipWire, destWire, label).then(() => invalidateScope(scope)),
				);
				return r;
			}
			toast(r.count >= 0 ? tr("unzipOkCount", { count: r.count }) : tr("unzipOk"));
			setTask("");
			await invalidateScope(scope);
			return r;
		}

		async function uploadFilesTo(scope, dir, files) {
			if (!files?.length) return;
			if (uploading) {
				toast(tr("uploading"));
				return;
			}
			uploading = true;
			let ok = 0;
			const label = `${scope === "local" ? dir || "/" : dir}`;
			try {
				for (let idx = 0; idx < files.length; idx++) {
					const f = files[idx];
					if (await uploadOne(scope, dir, f, { done: idx + 1, total: files.length })) ok++;
				}
				if (ok) await invalidateScope(scope);
				setTask("");
				if (ok === files.length)
					toast(tr("uploadDoneAll", { ok, dest: dir ? tr("uploadToDir", { dir }) : tr("uploadToRoot") }));
				else {
					const msg = tr("uploadDonePart", { ok, total: files.length });
					failTask(label, msg, () => void uploadFilesTo(scope, dir, files));
				}
			} finally {
				uploading = false;
			}
		}

		async function collectDropEntries(dt) {
			const items = [...(dt?.items ?? [])].filter((it) => it && it.kind === "file");
			if (items.length && typeof items[0].webkitGetAsEntry === "function") {
				try {
					const roots = items.map((it) => it.webkitGetAsEntry()).filter(Boolean);
					const out = [];
					const walk = async (entry) => {
						if (entry.isFile) {
							const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
							const relPath = String(entry.fullPath || `/${file.name}`).replace(/^\/+/, "");
							if (relPath.split("/").includes("..")) return;
							file._relPath = relPath;
							out.push({ file, relPath });
						} else if (entry.isDirectory) {
							const reader = entry.createReader();
							let batch;
							do {
								batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
								for (const child of batch) await walk(child);
							} while (batch && batch.length);
						}
					};
					for (const r of roots) await walk(r);
					if (out.length) return out;
				} catch {}
			}
			const files = [...(dt?.files ?? [])];
			return files.map((f) => ({ file: f, relPath: String(f.webkitRelativePath || f.name || "") }));
		}

		async function uploadEntriesTo(scope, baseDir, entries) {
			if (!entries?.length) {
				toast(tr("dropEmpty"));
				return;
			}
			if (uploading) {
				toast(tr("uploading"));
				return;
			}
			uploading = true;
			let ok = 0;
			try {
				for (let idx = 0; idx < entries.length; idx++) {
					const { file, relPath } = entries[idx];
					if (relPath && !file._relPath) file._relPath = relPath;
					const uploaded = await uploadOne(scope, baseDir, file, { done: idx + 1, total: entries.length });
					if (!uploaded) continue;
					ok++;
					if (isZipName(file.name)) {
						const dir = targetDirFor(scope, baseDir, file);
						const leaf = String(fileDisplayRel(file)).split("/").filter(Boolean).pop() || file.name;
						const zipWire = dir ? `${String(dir).replace(/\/+$/, "")}/${leaf}` : leaf;
						const destWire = dir || (scope === "local" ? "" : "/");
						const showDir = destWire || (scope === "local" ? "/" : "/");
						setTask(tr("dropZipDoing", { name: leaf, dir: showDir }));
						toast(tr("dropZipDoing", { name: leaf, dir: showDir }));
						const r = await req(scope, { action: "unzip", zip: zipWire, dest: destWire });
						if (!r.ok) {
							toast(tr("dropZipOneFail", { name: leaf, error: r.error }));
							failTask(
								leaf,
								r.error,
								() => void doUnzipPath(scope, zipWire, destWire, leaf).then(() => invalidateScope(scope)),
							);
						} else {
							toast(r.count >= 0 ? tr("unzipOkCount", { count: r.count }) : tr("unzipOk"));
						}
					}
				}
				if (ok) await invalidateScope(scope);
				setTask("");
				if (ok === entries.length) {
					toast(tr("uploadDoneAll", { ok, dest: baseDir ? tr("uploadToDir", { dir: baseDir }) : tr("uploadToRoot") }));
				} else {
					const msg = tr("uploadDonePart", { ok, total: entries.length });
					failTask(baseDir || "/", msg, () => void uploadEntriesTo(scope, baseDir, entries));
				}
			} finally {
				uploading = false;
			}
		}

		function isFileDrag(ev) {
			return Array.from(ev.dataTransfer?.types ?? []).includes("Files");
		}

		function clearDropTargets() {
			root.querySelectorAll(".vsc-row.drop-target").forEach((el) => el.classList.remove("drop-target"));
			treeEl.classList.remove("drop-root");
			sshTreeEl.classList.remove("drop-root");
		}

		function localParentOf(p) {
			const i = p.lastIndexOf("/");
			return i <= 0 ? "" : p.slice(0, i);
		}

		function dropTargetFrom(ev, containerScope) {
			const row = ev.target.closest(".vsc-row");
			if (row && row.dataset.scope) {
				return {
					scope: row.dataset.scope,
					dir:
						row.dataset.type === "dir"
							? row.dataset.path
							: row.dataset.scope === "local"
								? localParentOf(row.dataset.path)
								: parentOf(row.dataset.path),
				};
			}
			if (containerScope === "local") return { scope: "local", dir: "" };
			const first = [...conns.keys()][0];
			return first ? { scope: first, dir: conns.get(first).cwd } : null;
		}

		function setDropHighlight(t) {
			clearDropTargets();
			if (!t) return;
			if (t.dir && t.dir !== "/") {
				root
					.querySelector(`.vsc-row[data-scope="${CSS.escape(t.scope)}"][data-path="${CSS.escape(t.dir)}"]`)
					?.classList.add("drop-target");
			} else {
				(t.scope === "local" ? treeEl : sshTreeEl).classList.add("drop-root");
			}
		}

		function clearAppDropOverlay() {
			const appEl = container.ownerDocument.querySelector(".app");
			if (appEl) appEl.dispatchEvent(new DragEvent("dragleave", { bubbles: true }));
		}

		for (const [el, containerScope] of [
			[treeEl, "local"],
			[sshTreeEl, null],
		]) {
			el.addEventListener("dragover", (ev) => {
				if (!isFileDrag(ev)) return;
				ev.preventDefault();
				ev.stopPropagation();
				clearAppDropOverlay();
				setDropHighlight(dropTargetFrom(ev, containerScope));
				ev.dataTransfer.dropEffect = "copy";
			});
			el.addEventListener("dragleave", (ev) => {
				if (ev.relatedTarget && el.contains(ev.relatedTarget)) return;
				clearDropTargets();
			});
			el.addEventListener("drop", (ev) => {
				if (!isFileDrag(ev)) return;
				ev.preventDefault();
				ev.stopPropagation();
				clearDropTargets();
				clearAppDropOverlay();
				const t = dropTargetFrom(ev, containerScope);
				if (!t) {
					toast(tr("noSsh"));
					return;
				}
				// 文件夹 / ZIP 拖放：保留目录结构，ZIP 自动解到落点目录（复用落点规则 + 服务端 ZipSlip 防护）
				void collectDropEntries(ev.dataTransfer).then((entries) => uploadEntriesTo(t.scope, t.dir, entries));
			});
		}

		for (const [el, containerScope] of [
			[treeEl, "local"],
			[sshTreeEl, null],
		]) {
			el.addEventListener("contextmenu", (ev) => {
				const tgt = ev.target instanceof Element ? ev.target : el;
				if (tgt.closest(".vsc-row")) return;
				ev.preventDefault();
				ev.stopPropagation();
				if (containerScope === "local" && window.__piWebUiHost?.openFileContextMenu) {
					window.__piWebUiHost.openFileContextMenu({
						x: ev.clientX,
						y: ev.clientY,
						path: "",
						kind: "list",
						label: "workspace",
						onHostAction: (actionId) => handleLocalHostAction(actionId, "", "dir"),
					});
					return;
				}
				const t = dropTargetFrom(ev, containerScope);
				if (!t) {
					toast(tr("noSsh"));
					return;
				}
				hideMenu();
				const items = [];
				items.push([
					tr("mUploadHere"),
					async () => {
						const files = await pickFiles();
						if (files.length) void uploadFilesTo(t.scope, t.dir, files);
					},
				]);
				items.push([
					tr("mUploadFolderHere"),
					async () => {
						const files = await pickFolder();
						if (files.length) void uploadFilesTo(t.scope, t.dir, files);
					},
				]);
				items.push([tr("mExtractHere"), () => void unzipToHere(t.scope, t.dir)]);
				if (clipboard && clipboard.scope === t.scope) {
					items.push([clipboard.cut ? tr("mPasteMove") : tr("mPaste"), () => void pasteClipboardTo(t.scope, t.dir)]);
				}
				if (containerScope === "local" && t.dir === "") {
					items.push([tr("mRefresh"), () => void refreshAll()]);
				}
				menuEl.innerHTML = "";
				for (const [label, fn] of items) {
					const b = document.createElement("button");
					b.textContent = label;
					b.addEventListener("click", () => {
						hideMenu();
						void fn();
					});
					menuEl.appendChild(b);
				}
				menuEl.classList.remove("vsc-hidden");
				const rect = root.getBoundingClientRect();
				menuEl.style.left = `${Math.min(ev.clientX - rect.left, rect.width - 170)}px`;
				menuEl.style.top = `${Math.min(ev.clientY - rect.top, rect.height - items.length * 32 - 20)}px`;
			});
		}
		root.querySelector(".vsc-side-head").addEventListener("click", (ev) => {
			const btn = ev.target.closest("button[data-act]");
			if (!btn) return;
			ev.stopPropagation();
			const act = btn.dataset.act;
			if (act === "refresh") {
				void refreshAll();
			} else if (act === "search") {
				void runSearch("local");
			} else if (act === "new-file") {
				void promptCreate("local", pickLocalDir(), "file");
			} else if (act === "new-dir") {
				void promptCreate("local", pickLocalDir(), "dir");
			} else if (act === "zip") {
				void downloadZipFor("local", zipSelection("local"));
			} else if (act === "extract") {
				void unzipToHere("local", pickLocalDir());
			} else if (act === "upload") {
				void pickFiles().then((files) => uploadFilesTo("local", "", files));
			} else if (act === "upload-folder") {
				void pickFolder().then((files) => uploadFilesTo("local", "", files));
			}
		});

		let modalEditId = null;
		function openHostModal(h) {
			modalEditId = h?.id ?? null;
			hostBg.querySelector(".h-title").textContent = h ? tr("hostEdit") : tr("hostNew");
			const q = (n) => hostBg.querySelector(`[name="${n}"]`);
			q("h-name").value = h?.name ?? "";
			q("h-host").value = h?.host ?? "";
			q("h-port").value = h?.port ?? 22;
			q("h-user").value = h?.username ?? "root";
			q("h-pass").value = "";
			q("h-key").value = "";
			q("h-keypath").value = h?.privateKeyPath ?? "";
			q("h-pp").value = "";
			q("h-agent").value = h?.agent ?? "";
			q("h-pass").placeholder = h?.hasPass ? tr("keptPh") : "";
			q("h-key").placeholder = h?.hasKey ? tr("keptPh") : "-----BEGIN OPENSSH PRIVATE KEY-----";
			q("h-pp").placeholder = h?.hasPassphrase ? tr("keptPh") : "";
			const panel = hostBg.querySelector(".sshcfg-import");
			panel.classList.add("vsc-hidden");
			panel.innerHTML = "";
			hostBg.classList.remove("vsc-hidden");
			q("h-host").focus();
		}
		hostBg.querySelector(".cancel").addEventListener("click", () => hostBg.classList.add("vsc-hidden"));
		hostBg.addEventListener("click", (ev) => {
			if (ev.target === hostBg) hostBg.classList.add("vsc-hidden");
		});
		hostBg.querySelector(".save-host").addEventListener("click", async () => {
			const q = (n) => hostBg.querySelector(`[name="${n}"]`);
			const body = {
				name: q("h-name").value.trim(),
				host: q("h-host").value.trim(),
				port: Number(q("h-port").value) || 22,
				username: q("h-user").value.trim() || "root",
				password: q("h-pass").value || undefined,
				privateKey: q("h-key").value.trim() || undefined,
				passphrase: q("h-pp").value || undefined,
				privateKeyPath: q("h-keypath").value.trim(),
				agent: q("h-agent").value.trim(),
			};
			if (modalEditId) body.id = modalEditId;
			const r = await request({ action: "hosts_save", host: body });
			if (!r.ok) {
				toast(tr("saveFail", { error: r.error }));
				return;
			}
			hostBg.classList.add("vsc-hidden");
		});
		hostBg.querySelector(".import-cfg").addEventListener("click", async () => {
			const panel = hostBg.querySelector(".sshcfg-import");
			panel.innerHTML = `<div class="hint">${tr("readingCfg")}</div>`;
			panel.classList.remove("vsc-hidden");
			const r = await request({ action: "sshconfig_list" });
			if (!r.ok) {
				panel.innerHTML = `<div class="hint">${tr("readFail", { error: esc(r.error) })}</div>`;
				return;
			}
			const fresh = (r.hosts ?? []).filter((x) => !x.imported);
			if (!fresh.length) {
				panel.innerHTML = `<div class="hint">${tr("allImported", { n: (r.hosts ?? []).length })}</div>`;
				return;
			}
			panel.innerHTML = "";
			for (const x of fresh) {
				const label = document.createElement("label");
				label.style.cssText = "display:flex;align-items:center;gap:6px;font-weight:normal";
				const cb = document.createElement("input");
				cb.type = "checkbox";
				cb.checked = true;
				cb.value = x.alias;
				cb.style.width = "auto";
				label.appendChild(cb);
				const span = document.createElement("span");
				span.textContent =
					`${x.alias} — ${x.username}@${x.host}:${x.port}` + (x.privateKeyPath ? `（${x.privateKeyPath}）` : "");
				label.appendChild(span);
				panel.appendChild(label);
			}
			const btn = document.createElement("button");
			btn.className = "primary";
			btn.textContent = tr("importSelected");
			btn.addEventListener("click", async () => {
				const aliases = [...panel.querySelectorAll("input[type=checkbox]:checked")].map((c) => c.value);
				if (!aliases.length) {
					toast(tr("pickHosts"));
					return;
				}
				const r2 = await request({ action: "sshconfig_import", aliases });
				if (!r2.ok) {
					toast(tr("importFail", { error: r2.error }));
					return;
				}
				panel.classList.add("vsc-hidden");
				panel.innerHTML = "";
				hostBg.classList.add("vsc-hidden");
				toast(tr("imported", { added: r2.added, skip: r2.skipped ? tr("importedSkip", { n: r2.skipped }) : "" }));
			});
			panel.appendChild(btn);
		});

		async function connectConfig(alias) {
			const key = `cfg:${alias}`;
			if (connecting.has(key)) return;
			for (const [id, c] of conns) {
				if ((c.label ?? "").startsWith(`${alias}（`)) return id;
			}
			connecting.add(key);
			renderHosts();
			const r = await request({ action: "config_connect", alias });
			connecting.delete(key);
			if (!r.ok) {
				toast(tr("connFail", { error: r.error }));
				renderHosts();
				return null;
			}
			let cwd = "/";
			const pwd = await request({ action: "exec", connId: r.connId, cmd: "pwd" });
			if (pwd.ok && pwd.exitCode === 0) {
				const home = pwd.output.trim().split(/\r?\n/).pop()?.trim();
				if (home?.startsWith("/")) cwd = home;
			}
			conns.set(r.connId, { label: r.label, cwd });
			lastConnId = r.connId;
			selNode = { scope: r.connId, path: cwd, type: "dir" };
			renderHosts();
			await renderTree();
			return r.connId;
		}

		async function openSshConfigEditor() {
			const r = await request({ action: "sshconfig_get" });
			if (!r.ok) {
				toast(tr("readFail", { error: r.error }));
				return;
			}
			const text = prompt(tr("sshCfgPrompt", { path: S.configPath ?? "~/.ssh/config" }), r.text ?? "");
			if (text === null) return;
			const r2 = await request({ action: "sshconfig_save", text });
			if (!r2.ok) toast(tr("saveFail", { error: r2.error }));
			else toast(tr("configSaved"));
		}

		async function connectHost(h) {
			if (connecting.has(h.id) || connOfHost(h.id)) return;
			connecting.add(h.id);
			renderTree();
			const r = await request({ action: "connect", id: h.id });
			connecting.delete(h.id);
			if (!r.ok) {
				toast(tr("connFail", { error: r.error }));
				renderTree();
				return;
			}
			let cwd = "/";
			const pwd = await request({ action: "exec", connId: r.connId, cmd: "pwd" });
			if (pwd.ok && pwd.exitCode === 0) {
				const home = pwd.output.trim().split(/\r?\n/).pop()?.trim();
				if (home?.startsWith("/")) cwd = home;
			}
			conns.set(r.connId, { label: r.label, cwd });
			lastConnId = r.connId;
			selNode = { scope: r.connId, path: cwd, type: "dir" };
			renderHosts();
			await renderTree();
		}

		function handleConnClosed(connId, reason) {
			for (const [, t] of terms.entries()) {
				if (t.connId === connId) disposeTerm(t);
			}
			conns.delete(connId);
			closeTabsOfScope(connId);
			for (const key of [...dirCache.keys()]) {
				if (key.startsWith(`${connId}:`)) dirCache.delete(key);
			}
			if (lastConnId === connId) lastConnId = [...conns.keys()].pop() ?? null;
			if (selNode && selNode.scope === connId) selNode = null;
			renderTermTabs();
			syncPanelVisibility();
			void renderTree();
			renderHosts();
			if (reason) {
				const why =
					reason === "连接已关闭"
						? tr("connClosedDrop")
						: reason === "主机已删除"
							? tr("hostDeletedT")
							: reason === "手动断开"
								? tr("manualDiscT")
								: reason;
				toast(tr("connClosed", { label: connLabel(connId), reason: why }));
			}
		}

		const terms = new Map();
		let termSeq = 0;
		let activeTermId = null;
		let lastConnId = null;
		let termH = 240;
		const inputQueue = new Map();

		function pickConnId() {
			const t = tabs.get(activeTk);
			if (t && t.scope !== "local" && conns.has(t.scope)) return t.scope;
			if (lastConnId && conns.has(lastConnId)) return lastConnId;
			return [...conns.keys()][0] ?? null;
		}

		function showTermPanel() {
			panelEl.classList.remove("vsc-hidden");
			dragEl.classList.remove("vsc-hidden");
			panelEl.style.height = `${termH}px`;
		}
		function hideTermPanel() {
			panelEl.classList.add("vsc-hidden");
			dragEl.classList.add("vsc-hidden");
		}
		function syncPanelVisibility() {
			if (terms.size) showTermPanel();
			else hideTermPanel();
		}
		function onThemeChange() {
			try {
				view.dispatch({ effects: themeComp.reconfigure(isLightTheme() ? cmLight : oneDark) });
			} catch {}
			const th = buildTermTheme();
			for (const [, t] of terms.entries()) {
				try {
					t.term.options.theme = th;
				} catch {}
			}
		}
		window.addEventListener(THEME_CHANGE_EVENT, onThemeChange);

		async function newTerm(connId, startCwd) {
			connId = connId ?? pickConnId();
			if (!connId || !conns.has(connId)) {
				toast(tr("noSshLeft"));
				return;
			}
			const sameConn = [...terms.values()].filter((t) => t.connId === connId).length;
			const t = {
				id: `t${++termSeq}`,
				connId,
				shellId: null,
				label: connLabel(connId),
				n: sameConn + 1,
				dead: false,
				term: null,
				fit: null,
				el: null,
				opened: false,
			};
			terms.set(t.id, t);
			showTermPanel();
			t.el = document.createElement("div");
			t.el.className = "vsc-term";
			termAreaEl.appendChild(t.el);
			const term = new Terminal({
				fontFamily: 'ui-monospace, Consolas, "Cascadia Mono", monospace',
				fontSize: 13,
				cursorBlink: true,
				theme: buildTermTheme(),
			});
			const fit = new FitAddon();
			term.loadAddon(fit);
			t.term = term;
			t.fit = fit;
			term.open(t.el);
			try {
				fit.fit();
			} catch {}
			term.onData((d) => {
				if (t.dead) return;
				if (t.shellId) ctx.send({ action: "shell_input", connId: t.connId, shellId: t.shellId, b64: b64.enc(d) });
				else {
					if (!inputQueue.has(t.id)) inputQueue.set(t.id, []);
					inputQueue.get(t.id).push(d);
				}
			});
			setActiveTerm(t.id);
			const r = await request({
				action: "shell_open",
				connId: t.connId,
				cols: term.cols,
				rows: term.rows,
			});
			if (!r.ok) {
				toast(tr("termFail", { error: r.error }));
				disposeTerm(t);
				renderTermTabs();
				syncPanelVisibility();
				return;
			}
			t.shellId = r.shellId;
			const queued = inputQueue.get(t.id);
			if (queued?.length && !t.dead) {
				ctx.send({ action: "shell_input", connId: t.connId, shellId: t.shellId, b64: b64.enc(queued.join("")) });
			}
			inputQueue.delete(t.id);
			if (startCwd && !t.dead) {
				ctx.send({
					action: "shell_input",
					connId: t.connId,
					shellId: t.shellId,
					b64: b64.enc(`cd ${shQuote(startCwd)}\n`),
				});
			}
			term.focus();
		}

		function setActiveTerm(id) {
			activeTermId = id;
			for (const [tid, t] of terms.entries()) {
				t.el.classList.toggle("vsc-hidden", tid !== id);
				if (tid === id)
					requestAnimationFrame(() => {
						try {
							t.fit.fit();
						} catch {}
						t.term?.focus();
					});
			}
			renderTermTabs();
		}

		function renderTermTabs() {
			termTabsEl.innerHTML = "";
			for (const [tid, t] of terms.entries()) {
				const el = document.createElement("span");
				el.className = "vsc-ttab" + (tid === activeTermId ? " active" : "");
				el.innerHTML = `<span class="tn">🖥 ${esc(t.label)}${t.n > 1 ? ` ${t.n}` : ""}</span><button class="x" title="${tr("closeT")}">✕</button>`;
				el.addEventListener("click", (ev) => {
					if (ev.target.closest(".x")) {
						killTerm(t);
						return;
					}
					setActiveTerm(tid);
				});
				termTabsEl.appendChild(el);
			}
		}

		function killTerm(t) {
			if (t.shellId) void request({ action: "shell_close", connId: t.connId, shellId: t.shellId });
			disposeTerm(t);
			if (activeTermId === t.id) {
				activeTermId = null;
				const rest = [...terms.keys()];
				if (rest.length) setActiveTerm(rest[rest.length - 1]);
			}
			renderTermTabs();
			syncPanelVisibility();
		}

		function disposeTerm(t) {
			t.dead = true;
			try {
				t.ro?.disconnect();
			} catch {}
			try {
				t.term?.dispose();
			} catch {}
			try {
				t.el?.remove();
			} catch {}
			terms.delete(t.id);
		}

		root.querySelector(".vsc-termbar .t-add").addEventListener("click", () => void newTerm());
		root.querySelector(".vsc-termbar .t-hide").addEventListener("click", hideTermPanel);

		dragEl.addEventListener("mousedown", (ev) => {
			ev.preventDefault();
			const startY = ev.clientY;
			const startH = panelEl.getBoundingClientRect().height;
			const maxH = Math.max(120, root.getBoundingClientRect().height * 0.7);
			const onMove = (e) => {
				termH = Math.round(Math.min(Math.max(startH + (startY - e.clientY), 80), maxH));
				panelEl.style.height = `${termH}px`;
				for (const [, t] of terms.entries()) {
					try {
						t.fit.fit();
					} catch {}
				}
			};
			const onUp = () => {
				document.removeEventListener("mousemove", onMove);
				document.removeEventListener("mouseup", onUp);
			};
			document.addEventListener("mousemove", onMove);
			document.addEventListener("mouseup", onUp);
		});

		const offData = ctx.onData((payload) => {
			if (!payload) return;
			if (payload.res && pending.has(payload.reqId)) {
				const p = pending.get(payload.reqId);
				pending.delete(payload.reqId);
				p(payload);
				return;
			}
			if (payload.res && !payload.reqId) {
				console.warn("[vscode-editor] 收到无 reqId 的响应（已忽略），请用 request() 发请求：", payload.action);
			}
			if (payload.kind === "workspace") {
				void applyWorkspace(payload.root);
				return;
			}
			if (payload.kind === "state") {
				applyState(payload.state);
				return;
			}
			switch (payload.event) {
				case "shell_data": {
					for (const [, t] of terms.entries()) {
						if (t.connId === payload.connId && t.shellId === payload.shellId) {
							t.term?.write(b64.bytes(payload.b64));
							break;
						}
					}
					break;
				}
				case "shell_exit": {
					for (const [, t] of terms.entries()) {
						if (t.connId === payload.connId && t.shellId === payload.shellId) {
							t.term?.write("\r\n\x1b[90m" + tr("shellExited") + "\x1b[0m\r\n");
							break;
						}
					}
					break;
				}
				case "conn_closed":
					handleConnClosed(payload.connId, payload.reason);
					break;
			}
		});

		function onGlobalKey(ev) {
			const mod = ev.ctrlKey || ev.metaKey;
			if (mod && ev.key.toLowerCase() === "p") {
				ev.preventDefault();
				openQuickOpen();
			} else if (mod && ev.shiftKey && ev.key.toLowerCase() === "s") {
				ev.preventDefault();
				void saveAsActive();
			} else if (mod && ev.key.toLowerCase() === "s") {
				ev.preventDefault();
				void saveActive();
			} else if (ev.key === "Escape") {
				if (!quick.classList.contains("vsc-hidden")) closeQuickOpen();
				if (!menuEl.classList.contains("vsc-hidden")) hideMenu();
			}
		}
		container.ownerDocument.addEventListener("keydown", onGlobalKey, true);
		const onBeforeUnload = (ev) => {
			let dirty = 0;
			for (const [, tb] of tabs) if (!tb.binary && tb.dirty) dirty++;
			if (dirty) {
				ev.preventDefault();
				ev.returnValue = "";
			}
		};
		window.addEventListener("beforeunload", onBeforeUnload);

		root.querySelector('.vsc-pane[data-pane="ssh"] .vsc-side-head').addEventListener("click", (ev) => {
			const btn = ev.target.closest("button[data-act]");
			if (!btn) return;
			ev.stopPropagation();
			if (btn.dataset.act === "add-host") openHostModal(null);
			else if (btn.dataset.act === "deps") void request({ action: "deps_install" });
			else if (btn.dataset.act === "new-term") {
				showTermPanel();
				void newTerm();
			} else if (btn.dataset.act === "r-new-file" || btn.dataset.act === "r-new-dir") {
				const t = pickRemoteDir();
				if (t) void promptCreate(t.connId, t.dir, btn.dataset.act === "r-new-dir" ? "dir" : "file");
			} else if (btn.dataset.act === "r-upload") {
				const t = pickRemoteDir();
				if (t) void pickFiles().then((files) => uploadFilesTo(t.connId, t.dir, files));
			} else if (btn.dataset.act === "r-upload-folder") {
				const t = pickRemoteDir();
				if (t) void pickFolder().then((files) => uploadFilesTo(t.connId, t.dir, files));
			} else if (btn.dataset.act === "r-zip") {
				const t = pickRemoteDir();
				if (t) void downloadZipFor(t.connId, zipSelection(t.connId));
			} else if (btn.dataset.act === "r-extract") {
				const t = pickRemoteDir();
				if (t) void unzipToHere(t.connId, t.dir);
			} else if (btn.dataset.act === "r-search") {
				const t = pickRemoteDir();
				if (t) void runSearch(t.connId, t.dir);
			} else if (btn.dataset.act === "r-refresh") {
				void refreshAll();
				void request({ action: "state" }).then((r) => {
					if (r.ok && r.state) applyState(r.state);
				});
			}
		});
		function pickLocalDir() {
			if (selNode?.scope === "local") return selNode.type === "dir" ? selNode.path : parentOf(selNode.path);
			return "";
		}

		function pickRemoteDir() {
			if (selNode && selNode.scope !== "local" && conns.has(selNode.scope)) {
				return { connId: selNode.scope, dir: selNode.type === "dir" ? selNode.path : parentOf(selNode.path) };
			}
			const first = [...conns.keys()][0];
			if (!first) {
				toast(tr("noSsh"));
				return null;
			}
			return { connId: first, dir: conns.get(first).cwd };
		}

		switchPane("files");
		void request({ action: "state" }).then((r) => {
			if (r.ok && r.state) applyState(r.state);
		});
		applyI18n();

		return () => {
			container.ownerDocument.removeEventListener("keydown", onGlobalKey, true);
			window.removeEventListener("beforeunload", onBeforeUnload);
			document.removeEventListener("click", hideMenu);
			window.removeEventListener(THEME_CHANGE_EVENT, onThemeChange);
			for (const [, t] of terms.entries()) {
				try {
					t.ro?.disconnect();
				} catch {}
				try {
					t.term?.dispose();
				} catch {}
			}
			terms.clear();
			offData();
			view.destroy();
			root.remove();
		};
	},
};
