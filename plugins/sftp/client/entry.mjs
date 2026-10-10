/**
 * sftp 客户端视图 —— 连接管理 + 差异预览 + 传输进度 + 远端文件浏览。
 *
 * 纯 DOM（不依赖主应用 React），样式自带 <style> 且颜色走主应用 CSS 变量，
 * 主题切换自动跟随。数据面全部走插件的 HTTP 路由 `/plugins-api/sftp/*`
 * （host.route）——请求/响应语义比 WS 往返更省事，轮询只在有任务时加速。
 *
 * 关键设计：**预览与执行是同一份计划**。点「预览差异」拿到 dry-run 的 plan，
 * 确认无误再点「执行」；执行时若两边都没改，结果与预览一致。删除类条目在列表里
 * 单独标红，且执行前会二次确认（删掉的东西虽然进垃圾桶，但没人愿意误删线上文件）。
 */

const TEXT = {
	zh: {
		title: "SFTP 同步",
		subtitle: "项目级配置 · 差异预览 · 删除保护",
		profile: "连接",
		noProfile: "（未配置）",
		host: "主机",
		port: "端口",
		username: "用户名",
		remotePath: "远端根目录",
		authMethod: "认证方式",
		authPassword: "密码",
		authKey: "密钥文件",
		authAgent: "ssh-agent",
		password: "密码",
		passwordPlaceholder: "留空 = 不改；建议填 ${secret:名} 引用",
		privateKeyPath: "私钥路径",
		passphrase: "私钥口令",
		agent: "agent socket",
		ignore: "额外排除（逗号或换行分隔）",
		save: "保存",
		testing: "测试中…",
		test: "测试连接",
		import: "导入 .vscode/sftp.json",
		importing: "导入中…",
		direction: "方向",
		sync: "同步",
		up: "上传 本地→远端",
		down: "下载 远端→本地",
		both: "双向",
		scope: "范围",
		all: "全部同步根",
		tree: "子树",
		file: "单文件",
		path: "路径",
		pathHint: "相对工作区，如 web/dist",
		plan: "预览差异",
		planning: "扫描中…",
		stopBtn: "停止",
		stopping: "正在停止…",
		stopped: "已停止（已完成的文件保留）",
		scanStat: "扫描{side}：{files} 个文件 / {dirs} 个目录",
		sideLocal: "本地",
		sideRemote: "远端",
		reusedPlan: "沿用刚才预览的计划（未重新扫描）",
		run: "执行同步",
		confirmDelete: "本次计划包含 {n} 项删除（会先进垃圾桶）。确认执行？",
		confirmRun: "开始同步？",
		summary: "待上传 {up} · 待下载 {down} · 待清理 {trash} · 一致 {same} · 冲突 {conflict}",
		noPlan: "还没有计划 —— 先点「预览差异」看要改什么。",
		identical: "没有需要变更的文件。",
		upload: "上传",
		download: "下载",
		trashRemote: "清远端",
		trashLocal: "清本地",
		skip: "跳过",
		conflict: "冲突",
		reason: "原因",
		failed: "失败 {n} 个",
		done: "完成：上传 {up} / 下载 {down} / 清理 {trash}",
		running: "传输中",
		remote: "远端文件",
		refresh: "刷新",
		goUp: "上一级",
		uploadHere: "上传本地对应目录",
		uploading: "上传中…",
		downloading: "下载中…",
		transferred: "已{dir} {n} 个文件",
		size: "大小",
		openFile: "打开",
		go: "前往",
		close: "关闭",
		write: "写回远端",
		writing: "写入中…",
		binary: "二进制文件，不在面板里编辑",
		plaintextWarn: "⚠ 配置里有明文凭据：{list}。改成 ${secret:名} 更安全。",
		importAvailable: "检测到 .vscode/sftp.json —— 可以一键导入（口令会转成加密机密）。",
		trash: "垃圾桶",
		needConn: "先在左侧配好连接并保存。",
		secretBtn: "写入加密机密",
		secretPrompt: "机密名（如 prod-password）",
		secretValue: "机密值（不会回显）",
		settingsHint: "并发数、扫描并发、删除策略、远端命令开关在「设置 → 插件 → SFTP 同步」里。",
		outsideWorkspace: "只能同步工作区内的文件：{path}（右键菜单里的机器浏览路径不在工作区里）",
		keypathPlaceholder: "留空自动尝试 ~/.ssh/ 默认密钥（id_ed25519 等）",
		copyKey: "添加公钥到远端",
		copyKeyPrompt: "请输入远程服务器的密码以安装公钥：",
		copyKeyTesting: "正在添加公钥并验证…",
		copyKeySuccess: "✓ 公钥已成功写入远端 authorized_keys，且密钥登录验证通过！",
		copyKeyAlready: "✓ 远端 authorized_keys 已存在该公钥，密钥登录验证通过！",
		copyKeyWarn: "⚠ 公钥已写入，但密钥验证失败：{err}",
		goProjectRoot: "项目根",
		goProjectRootHint: "回到当前项目的远端根目录 ({root})",
		uploadHereDisabled: "上传本地对应目录 (非项目内)",
		outsideRootUploadHint: "当前远端路径在项目根目录（{root}）之外，无法映射到本地工作区",
		outsideRootDownloadHint: "此项在项目根目录（{root}）之外，无法同步到本地工作区",
		uploadItemHint: "上传本地对应内容到此 (覆盖远端)",
		downloadItemHint: "下载此项同步到本地 (覆盖本地)",
		ignoreItemHint: "将对应路径添加到 SFTP 忽略",
		outsideRootUploadItemHint: "在项目根目录之外，无本地对应文件可上传",
		outsideRootIgnoreHint: "在项目根目录之外，无需添加忽略",
		diffTabActionable: "待同步变更",
		diffTabUpload: "待上传",
		diffTabDownload: "待下载",
		diffTabTrash: "待清理",
		diffTabRemoteOnly: "仅远端存在 (保留)",
		diffTabSame: "两端一致",
		diffNoChanges: "✓ 没有需要同步的变更文件（两端文件已一致）",
		summaryDetailed:
			"待同步变更：待上传 {up} · 待下载 {down} · 待清理 {trash}（已跳过 {same} 个一致文件，{remoteOnly} 个远端独有文件）",
	},
	en: {
		title: "SFTP Sync",
		subtitle: "Project config · diff preview · delete protection",
		profile: "Connection",
		noProfile: "(none)",
		host: "Host",
		port: "Port",
		username: "User",
		remotePath: "Remote root",
		authMethod: "Auth",
		authPassword: "Password",
		authKey: "Key file",
		authAgent: "ssh-agent",
		password: "Password",
		passwordPlaceholder: "blank = keep; prefer a ${secret:name} reference",
		keypathPlaceholder: "blank = probe ~/.ssh/ default keys (id_ed25519, etc.)",
		copyKey: "Copy Key to Remote",
		copyKeyPrompt: "Enter remote server password to install public key:",
		copyKeyTesting: "Adding key and verifying…",
		copyKeySuccess: "✓ Successfully added public key to remote authorized_keys and verified!",
		copyKeyAlready: "✓ Public key already exists in remote authorized_keys, verified!",
		copyKeyWarn: "⚠ Key added, but verification failed: {err}",
		goProjectRoot: "Project Root",
		goProjectRootHint: "Jump to project remote root ({root})",
		uploadHereDisabled: "Upload local folder (outside project)",
		outsideRootUploadHint: "Current remote path is outside the project root ({root}), no corresponding local directory",
		outsideRootDownloadHint: "This item is outside the project root ({root}), cannot download to local workspace",
		uploadItemHint: "Upload local corresponding item to here",
		downloadItemHint: "Download and sync this item to local",
		ignoreItemHint: "Add corresponding path to SFTP ignore",
		outsideRootUploadItemHint: "Outside project root, no local file to upload",
		outsideRootIgnoreHint: "Outside project root, cannot ignore",
		diffTabActionable: "Changes to Sync",
		diffTabUpload: "Upload",
		diffTabDownload: "Download",
		diffTabTrash: "Trash",
		diffTabRemoteOnly: "Remote-only (kept)",
		diffTabSame: "Identical",
		diffNoChanges: "✓ No changes to sync (files are in sync)",
		summaryDetailed:
			"Changes to sync: {up} upload · {down} download · {trash} trash ({same} identical skipped, {remoteOnly} remote-only kept)",
		privateKeyPath: "Private key path",
		passphrase: "Key passphrase",
		agent: "agent socket",
		ignore: "Extra excludes (comma or newline separated)",
		save: "Save",
		testing: "Testing…",
		test: "Test connection",
		import: "Import .vscode/sftp.json",
		importing: "Importing…",
		direction: "Direction",
		sync: "Sync",
		up: "Upload local→remote",
		down: "Download remote→local",
		both: "Two-way",
		scope: "Scope",
		all: "All roots",
		tree: "Subtree",
		file: "Single file",
		path: "Path",
		pathHint: "relative to the workspace, e.g. web/dist",
		plan: "Preview diff",
		planning: "Scanning…",
		stopBtn: "Stop",
		stopping: "Stopping…",
		stopped: "Stopped (finished files are kept)",
		scanStat: "Scanning {side}: {files} files / {dirs} dirs",
		sideLocal: "local",
		sideRemote: "remote",
		reusedPlan: "Reused the plan you just previewed (no rescan)",
		run: "Run sync",
		confirmDelete: "This plan deletes {n} entries (moved to trash). Continue?",
		confirmRun: "Start the sync?",
		summary: "{up} to send · {down} to fetch · {trash} to clean · {same} same · {conflict} conflicts",
		noPlan: "No plan yet — hit “Preview diff” to see what would change.",
		identical: "Nothing to change.",
		upload: "upload",
		download: "download",
		trashRemote: "clean remote",
		trashLocal: "clean local",
		skip: "skip",
		conflict: "conflict",
		reason: "Why",
		failed: "{n} failed",
		done: "Done: {up} up / {down} down / {trash} cleaned",
		running: "Transferring",
		remote: "Remote files",
		refresh: "Refresh",
		goUp: "Up",
		uploadHere: "Upload the matching local folder",
		uploading: "Uploading…",
		downloading: "Downloading…",
		transferred: "{dir} {n} files",
		size: "Size",
		openFile: "Open",
		go: "Go",
		close: "Close",
		write: "Write to remote",
		writing: "Writing…",
		binary: "Binary file — not editable here",
		plaintextWarn: "⚠ Plaintext credentials in config: {list}. Use ${secret:name} instead.",
		importAvailable: "Found .vscode/sftp.json — one-click import available (passwords move to the encrypted store).",
		trash: "Trash",
		needConn: "Configure and save a connection on the left first.",
		secretBtn: "Store encrypted secret",
		secretPrompt: "Secret name (e.g. prod-password)",
		secretValue: "Secret value (never echoed)",
		settingsHint:
			"Concurrency, scan concurrency, delete policy and remote command access live in Settings → Plugins → SFTP Sync.",
		outsideWorkspace: "Only files inside the workspace can be synced: {path} (machine-browse paths live outside it)",
	},
};

/** 从 bundle 自己的 URL 推 API 前缀：<base>/plugins/sftp/client/entry.mjs → <base>/plugins-api/sftp */
function resolveApiBase(importMetaUrl) {
	const s = String(importMetaUrl);
	const i = s.indexOf("/plugins/");
	const root = i >= 0 ? s.slice(0, i) : s.replace(/\/[^/]*$/, "");
	return `${root}/plugins-api/sftp`;
}

const API = resolveApiBase(import.meta.url);

function esc(s) {
	return String(s ?? "").replace(
		/[&<>"']/g,
		(c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
	);
}

function fmtSize(n) {
	if (n === null || n === undefined) return "—";
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
	return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function fmtTime(sec) {
	if (!sec) return "—";
	const d = new Date(sec * 1000);
	return d.toLocaleString([], { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function detectLang() {
	const el = globalThis.document?.documentElement;
	const attr = el?.getAttribute?.("lang") || globalThis.navigator?.language || "zh";
	return String(attr).toLowerCase().startsWith("zh") ? "zh" : "en";
}

// ---------------------------------------------------------------- 宿主动作桥
/**
 * 文件树右键菜单里的两条动作（manifest `ui["contextmenu.file"]`）由本 bundle 接管：
 * 先把同步面板切出来，再把这次手动上传交给**面板自己**跑 —— 进度、报错、刷新走的
 * 都是面板按钮那条完全相同的路径，不另造一套静默上传。
 *
 * 时序：宿主是「按需加载 bundle → 回调 handler」，所以回调可能发生在面板第一次
 * mount 之前；面板没挂载时请求先排队，mount 完（且初始 refresh 回来、cwd 可用）再消费。
 */
const ACTION_UPLOAD_FILE = "sftp:upload-file";
const ACTION_UPLOAD_DIR = "sftp:upload-dir";
const ACTION_DOWNLOAD_FILE = "sftp:download-file";
const ACTION_DOWNLOAD_DIR = "sftp:download-dir";
const ACTION_IGNORE_ITEM = "sftp:ignore-item";
const ACTION_UNIGNORE_ITEM = "sftp:unignore-item";

/** 当前挂载中的面板（null = 没挂载）——只暴露一个「外部上传/下载请求」入口。 */
let panelSink = null;
/** 外部忽略请求（支持面板未挂载时直接调用 API）。 */
let panelIgnoreSink = null;
/** 面板没挂载时攒下的请求（最多 8 条，防连点堆爆）。 */
const pendingOps = [];

/** 相对路径转换，纯工具函数 */
function cleanWorkspaceRel(raw) {
	const p = String(raw ?? "")
		.replace(/\\/g, "/")
		.trim();
	if (!p) return "";
	return p.replace(/^\/+|\/+$/g, "");
}

async function handleIgnoreAction(mode, target) {
	if (!target || target.id === "@root") return;
	const raw = target.id != null ? String(target.id).trim() : "";
	const rel = cleanWorkspaceRel(raw);
	if (!rel) {
		try {
			globalThis.window?.__piWebUiHost?.notify?.("warning", "无法忽略工作区根目录", "Cannot ignore workspace root");
		} catch {}
		return;
	}
	if (panelIgnoreSink) {
		await panelIgnoreSink(mode, rel);
		return;
	}
	// 无论面板是否挂载，直接发 HTTP 请求更新忽略规则
	try {
		const res = await fetch("/plugins-api/sftp/ignore-toggle", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ path: rel, mode }),
		});
		const json = await res.json();
		if (!json.ok) throw new Error(json.error || "请求失败");
	} catch (err) {
		try {
			globalThis.window?.__piWebUiHost?.notify?.("error", `SFTP 忽略操作失败：${err.message ?? err}`);
		} catch {}
	}
}

/** 请求：打开面板 + 传输这个路径（dir 只影响文案与提示，服务端按 stat 判目录）。 */
function requestTransfer(action, target) {
	if (!target || target.id === "@root") return;
	const path = target.id !== undefined && target.id !== null ? String(target.id).trim() : "";
	try {
		globalThis.window?.__piWebUiHost?.setView?.("plugin:sftp");
	} catch {
		/* 宿主桥没有：面板照样能从顶栏按钮进，不影响功能 */
	}
	const isDir = action === ACTION_UPLOAD_DIR || action === ACTION_DOWNLOAD_DIR;
	const isDown = action === ACTION_DOWNLOAD_FILE || action === ACTION_DOWNLOAD_DIR;
	const req = {
		path,
		dir: isDir,
		direction: isDown ? "down" : "up",
		label: String(target?.label ?? (path || ".")),
	};
	if (panelSink) {
		panelSink(req);
		return;
	}
	pendingOps.push(req);
	if (pendingOps.length > 8) pendingOps.splice(0, pendingOps.length - 8);
}

/** 具名 handler：注册两次也只会存进 Set 一次（Set 按引用去重）。 */
function onUploadFile(_itemId, _value, target) {
	requestTransfer(ACTION_UPLOAD_FILE, target);
}
function onUploadDir(_itemId, _value, target) {
	requestTransfer(ACTION_UPLOAD_DIR, target);
}
function onDownloadFile(_itemId, _value, target) {
	requestTransfer(ACTION_DOWNLOAD_FILE, target);
}
function onDownloadDir(_itemId, _value, target) {
	requestTransfer(ACTION_DOWNLOAD_DIR, target);
}
function onIgnoreItem(_itemId, _value, target) {
	void handleIgnoreAction("add", target);
}
function onUnignoreItem(_itemId, _value, target) {
	void handleIgnoreAction("remove", target);
}

/** 等宿主桥就绪（宿主先挂 App 再 import bundle，按需加载时可能抢先一步）。 */
function whenBridge(fn, tries = 40) {
	const bridge = globalThis.window?.__piWebUiHost;
	if (bridge && typeof bridge === "object") {
		fn(bridge);
		return;
	}
	if (tries <= 0) return;
	setTimeout(() => whenBridge(fn, tries - 1), 250);
}

whenBridge((bridge) => {
	try {
		bridge.onUiAction?.(ACTION_UPLOAD_FILE, onUploadFile);
		bridge.onUiAction?.(ACTION_UPLOAD_DIR, onUploadDir);
		bridge.onUiAction?.(ACTION_DOWNLOAD_FILE, onDownloadFile);
		bridge.onUiAction?.(ACTION_DOWNLOAD_DIR, onDownloadDir);
		bridge.onUiAction?.(ACTION_IGNORE_ITEM, onIgnoreItem);
		bridge.onUiAction?.(ACTION_UNIGNORE_ITEM, onUnignoreItem);
	} catch {
		/* 宿主太旧：菜单点了没反应总比崩好（manifest apiVersion 会先拦住旧版） */
	}
});

export default {
	mount(container, _ctx) {
		const t = (key, vars) => {
			const dict = TEXT[detectLang()] ?? TEXT.zh;
			let out = dict[key] ?? TEXT.zh[key] ?? key;
			for (const [k, v] of Object.entries(vars ?? {})) out = out.split(`{${k}}`).join(String(v));
			return out;
		};

		let disposed = false;
		let state = null;
		let pollTimer = null;
		let busy = false;
		/** 远端浏览器路径栈 */
		let remoteDir = "";
		let editor = { path: "", text: "", binary: false };
		/** 最近一次计划的摘要 —— 执行前用它判断要不要弹「包含 n 项删除」的确认 */
		let lastPlanSummary = null;
		/** 最近一次预览的计划 token + 参数签名：执行时参数没变就直接沿用（省一次全量扫描） */
		let lastPlanToken = null;
		let lastPlanKey = null;
		/** profile 下拉的当前签名：只有清单真的变了才重建（否则会把用户选中的项/焦点冲掉） */
		let profileSig = "";

		container.innerHTML = `
<div class="sfx">
	<style>
		.sfx { max-width: 1180px; margin: 0 auto; font-size: 13px; display: grid; gap: 10px; }
		.sfx h2 { margin: 0; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
		.sfx h3 { margin: 0 0 6px; font-size: 13px; display: flex; align-items: center; gap: 8px; }
		.sfx .sub { opacity: .55; font-size: 11px; font-weight: normal; }
		.sfx .chip { font-size: 11px; padding: 1px 8px; border-radius: 99px; border: 1px solid var(--border, #333); opacity: .85; font-weight: normal; }
		.sfx .chip.ok { color: var(--green, #4ade80); border-color: color-mix(in srgb, var(--green, #4ade80) 40%, transparent); }
		.sfx .chip.err { color: var(--red, #f87171); border-color: color-mix(in srgb, var(--red, #f87171) 40%, transparent); }
		.sfx .chip.warn { color: var(--amber, #fbbf24); border-color: color-mix(in srgb, var(--amber, #fbbf24) 40%, transparent); }
		.sfx button { background: var(--bg-elev, #16161d); color: inherit; border: 1px solid var(--border, #333); border-radius: 6px; padding: 3px 10px; cursor: pointer; font: inherit; font-size: 12px; }
		.sfx button.primary { background: var(--accent, #7c5cff); color: #fff; border-color: transparent; }
		.sfx button.danger { color: var(--red, #f87171); border-color: color-mix(in srgb, var(--red, #f87171) 45%, transparent); }
		.sfx button:disabled { opacity: .45; cursor: default; }
		.sfx input, .sfx select, .sfx textarea { background: var(--bg-elev, #16161d); color: inherit; border: 1px solid var(--border, #333); border-radius: 6px; padding: 4px 7px; font: inherit; font-size: 12px; }
		.sfx textarea { resize: vertical; min-width: 0; }
		.sfx .cols { display: grid; grid-template-columns: minmax(320px, 1fr) minmax(340px, 1.15fr); gap: 12px; align-items: start; }
		@media (max-width: 860px) { .sfx .cols { grid-template-columns: 1fr; } }
		.sfx .card { border: 1px solid var(--border, #333); border-radius: 8px; padding: 10px; display: grid; gap: 8px; min-width: 0; }
		.sfx .grid2 { display: grid; grid-template-columns: auto 1fr; gap: 6px 8px; align-items: center; min-width: 0; }
		.sfx .grid2 > label { opacity: .7; font-size: 12px; white-space: nowrap; }
		.sfx .row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
		.sfx .grow { flex: 1; min-width: 0; }
		.sfx .hint { opacity: .55; font-size: 11px; }
		.sfx .warn { color: var(--amber, #fbbf24); font-size: 11px; }
		.sfx .err { color: var(--red, #f87171); font-size: 12px; }
		.sfx .ok { color: var(--green, #4ade80); font-size: 12px; }
		.sfx .list { border: 1px solid var(--border, #333); border-radius: 7px; max-height: 280px; overflow: auto; overscroll-behavior: contain; }
		.sfx .diff-tabs { display: flex; gap: 4px; flex-wrap: wrap; margin-top: 4px; }
		.sfx .diff-tabs button { padding: 2px 8px; font-size: 11px; border-radius: 99px; }
		.sfx .diff-tabs button.active { background: var(--accent, #7c5cff); color: #fff; border-color: transparent; }
		.sfx .list .it { display: grid; grid-template-columns: 66px 1fr; gap: 8px; padding: 4px 8px; border-bottom: 1px solid color-mix(in srgb, var(--border, #333) 55%, transparent); font-size: 12px; }
		.sfx .list .it:last-child { border-bottom: 0; }
		.sfx .list .it .rel { overflow-wrap: anywhere; min-width: 0; }
		.sfx .list .it .why { opacity: .75; font-size: 11px; margin-top: 2px; }
		.sfx .list .it.upload .tag { color: var(--accent, #7c5cff); }
		.sfx .list .it.download .tag { color: var(--green, #4ade80); }
		.sfx .list .it.trash .tag { color: var(--red, #f87171); }
		.sfx .list .it.remote-only .tag { color: var(--amber, #fbbf24); }
		.sfx .list .it.same .tag { color: var(--green, #4ade80); }
		.sfx .list .it.conflict .tag { color: var(--amber, #fbbf24); }
		.sfx .bar { height: 6px; border-radius: 99px; background: var(--bg-elev, #16161d); border: 1px solid var(--border, #333); overflow: hidden; }
		.sfx .bar > i { display: block; height: 100%; background: var(--accent, #7c5cff); width: 0; transition: width .2s; }
		/* 扫描阶段没有「总量」可换算百分比 —— 走不确定态滑动条纹，不然条子永远是空的 */
		.sfx .bar.indet > i { width: 40% !important; background: linear-gradient(90deg, transparent, var(--accent, #7c5cff), transparent); animation: sfx-indet 1.2s linear infinite; }
		@keyframes sfx-indet { from { transform: translateX(-100%); } to { transform: translateX(250%); } }
		.sfx .tree { border: 1px solid var(--border, #333); border-radius: 7px; max-height: 320px; overflow: auto; overscroll-behavior: contain; }
		.sfx .tree .fr { display: grid; grid-template-columns: 18px 1fr auto auto auto; gap: 8px; align-items: center; padding: 3px 8px; font-size: 12px; border-bottom: 1px solid color-mix(in srgb, var(--border, #333) 45%, transparent); }
		.sfx .tree .fr:last-child { border-bottom: 0; }
		.sfx .tree .fr:hover { background: color-mix(in srgb, var(--accent, #7c5cff) 7%, transparent); }
		.sfx .tree .fr .actions { display: inline-flex; gap: 2px; align-items: center; justify-content: flex-end; }
		.sfx .tree .fr .act-btn { padding: 0 4px; line-height: 18px; opacity: .7; border-radius: 4px; border: 1px solid transparent; background: transparent; cursor: pointer; font-size: 11px; }
		.sfx .tree .fr .act-btn:hover:not(:disabled) { opacity: 1; background: var(--bg-elev, #252530); border-color: var(--border, #333); }
		.sfx .tree .fr .nm { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
		.sfx .tree .fr .nm.dir { cursor: pointer; color: var(--accent, #7c5cff); }
		.sfx .tree .fr .sz { opacity: .5; font-size: 11px; white-space: nowrap; }
		.sfx .editor { border: 1px solid var(--border, #333); border-radius: 7px; padding: 8px; display: grid; gap: 6px; }
		.sfx .editor textarea { width: 100%; min-height: 200px; font-family: ui-monospace, monospace; box-sizing: border-box; }
		.sfx .hidden { display: none !important; }
	</style>

	<header class="row">
		<h2>☁ <span class="ttl"></span> <span class="sub"></span></h2>
		<span class="chips row" style="margin-left:auto"></span>
	</header>

	<div class="banner warn-profile warn hidden"></div>

	<div class="cols">
		<section class="card">
			<h3>🔌 <span class="ttl-profile"></span></h3>
			<div class="row">
				<select class="profile grow"></select>
				<button class="btn-test"></button>
				<button class="btn-copy-key"></button>
				<button class="btn-import"></button>
			</div>
			<div class="grid2">
				<label class="l-host"></label><input class="f-host" placeholder="example.com" />
				<label class="l-port"></label><input class="f-port" type="number" min="1" max="65535" />
				<label class="l-user"></label><input class="f-user" />
				<label class="l-remote"></label><input class="f-remote" placeholder="/srv/app" />
				<label class="l-auth"></label>
				<select class="f-auth">
					<option value="password"></option>
					<option value="key"></option>
					<option value="agent"></option>
				</select>
				<label class="l-pass"></label><input class="f-pass" type="password" autocomplete="new-password" />
				<label class="l-keypath"></label><input class="f-keypath" placeholder="~/.ssh/id_ed25519" />
				<label class="l-passphrase"></label><input class="f-passphrase" type="password" autocomplete="new-password" />
				<label class="l-agent"></label><input class="f-agent" placeholder="$SSH_AUTH_SOCK" />
				<label class="l-ignore"></label><textarea class="f-ignore" rows="2"></textarea>
			</div>
			<div class="row">
				<button class="btn-save primary"></button>
				<button class="btn-secret"></button>
				<span class="hint grow hint-settings"></span>
			</div>
			<div class="msg err hidden"></div>
			<div class="msg ok hidden"></div>
		</section>

		<section class="card">
			<h3>🔄 <span class="ttl-sync"></span></h3>
			<div class="row">
				<label class="l-dir hint"></label>
				<select class="f-dir">
					<option value="up"></option>
					<option value="down"></option>
					<option value="both"></option>
				</select>
				<label class="l-scope hint"></label>
				<select class="f-scope">
					<option value="all"></option>
					<option value="tree"></option>
					<option value="file"></option>
				</select>
				<input class="f-path grow" placeholder="" />
			</div>
			<div class="row">
				<button class="btn-plan"></button>
				<button class="btn-run primary"></button>
				<button class="btn-stop hidden"></button>
				<span class="hint grow"></span>
			</div>
			<div class="bar hidden"><i></i></div>
			<div class="progress hint hidden"></div>
			<div class="summary hint"></div>
			<div class="diff-tabs row hidden"></div>
			<div class="diff list"></div>
		</section>
	</div>

	<section class="card">
		<h3>📁 <span class="ttl-remote"></span></h3>
		<div class="row">
			<button class="btn-up"></button>
			<button class="btn-rroot"></button>
			<input class="f-rdir grow" />
			<button class="btn-rgo"></button>
			<button class="btn-rup"></button>
			<button class="btn-rfresh"></button>
		</div>
		<div class="tree"></div>
	</section>

	<section class="editor hidden">
		<div class="row">
			<b class="ed-path grow" style="overflow-wrap:anywhere"></b>
			<button class="btn-ed-save primary"></button>
			<button class="btn-ed-close"></button>
		</div>
		<textarea class="ed-text" spellcheck="false"></textarea>
		<div class="ed-msg hint"></div>
	</section>
</div>`;

		const $ = (sel) => container.querySelector(sel);
		const setText = (sel, text) => {
			const el = $(sel);
			if (el) el.textContent = text;
		};

		// 静态文案（切换语言时不会重挂，但视图本来就随语言重载）
		setText(".ttl", t("title"));
		setText(".sub", t("subtitle"));
		setText(".ttl-profile", t("profile"));
		setText(".l-host", t("host"));
		setText(".l-port", t("port"));
		setText(".l-user", t("username"));
		setText(".l-remote", t("remotePath"));
		setText(".l-auth", t("authMethod"));
		setText(".l-pass", t("password"));
		setText(".l-keypath", t("privateKeyPath"));
		setText(".l-passphrase", t("passphrase"));
		setText(".l-agent", t("agent"));
		setText(".l-ignore", t("ignore"));
		setText(".l-dir", t("direction"));
		setText(".l-scope", t("scope"));
		setText(".btn-save", t("save"));
		setText(".btn-secret", t("secretBtn"));
		setText(".btn-test", t("test"));
		setText(".btn-copy-key", t("copyKey"));
		setText(".btn-import", t("import"));
		setText(".btn-plan", t("plan"));
		setText(".btn-run", t("run"));
		setText(".btn-stop", t("stopBtn"));
		setText(".ttl-sync", t("sync"));
		setText(".ttl-remote", t("remote"));
		setText(".btn-up", t("goUp"));
		setText(".btn-rroot", t("goProjectRoot"));
		setText(".btn-rgo", t("go"));
		setText(".btn-rup", t("uploadHere"));
		setText(".btn-rfresh", t("refresh"));
		setText(".btn-ed-save", t("write"));
		setText(".btn-ed-close", t("close"));
		setText(".hint-settings", t("settingsHint"));
		const opts = [
			[".f-dir", ["up", "down", "both"], ["up", "down", "both"]],
			[".f-scope", ["all", "tree", "file"], ["all", "tree", "file"]],
			[".f-auth", ["password", "key", "agent"], ["authPassword", "authKey", "authAgent"]],
		];
		for (const [sel, values, keys] of opts) {
			const el = $(sel);
			el.innerHTML = values.map((v, i) => `<option value="${v}">${esc(t(keys[i]))}</option>`).join("");
		}
		$(".f-pass").placeholder = t("passwordPlaceholder");
		$(".f-keypath").placeholder = t("keypathPlaceholder");
		$(".f-path").placeholder = t("pathHint");

		/** fetch 包装：统一解 `{ok,data}` / `{ok:false,error}`。 */
		async function api(p, { method = "GET", body } = {}) {
			const init = { method };
			if (body !== undefined) {
				init.headers = { "content-type": "application/json" };
				init.body = JSON.stringify(body);
			}
			const res = await fetch(`${API}${p}`, init);
			let json;
			try {
				json = await res.json();
			} catch {
				throw new Error(`${method} ${p} → HTTP ${res.status}`);
			}
			if (!json?.ok) throw new Error(json?.error ?? `HTTP ${res.status}`);
			return json.data;
		}

		function showError(sel, msg) {
			const el = $(sel);
			if (!el) return;
			if (!msg) {
				el.classList.add("hidden");
				el.textContent = "";
				return;
			}
			el.classList.remove("hidden");
			el.textContent = msg;
		}

		function updateProfileChrome() {
			const list = state?.profiles ?? [];
			const sig = list.map((p) => `${p.name}:${p.ready ? 1 : 0}`).join(",") + `#${state?.active ?? ""}`;
			if (sig !== profileSig) {
				profileSig = sig;
				$(".profile").innerHTML = list.length
					? list.map((p) => `<option value="${esc(p.name)}">${esc(p.name)}${p.ready ? "" : " ⚠"}</option>`).join("")
					: `<option value="">${esc(t("noProfile"))}</option>`;
				if (state?.active) $(".profile").value = state.active;
			}
			$(".btn-import").classList.toggle("hidden", !state?.vscodeImportAvailable);
			$(".banner.warn-profile").classList.toggle("hidden", !(state?.warnings?.length || state?.plaintext?.length));
			$(".banner.warn-profile").textContent = [
				...(state?.warnings ?? []),
				...((state?.plaintext ?? []).length
					? [t("plaintextWarn", { list: state.plaintext.map((p) => `${p.connection}.${p.field}`).join(", ") })]
					: []),
			].join(" · ");
		}

		let filledProfile = null;
		function fillForm() {
			updateProfileChrome();
			const c = state?.connection;
			filledProfile = state?.active ?? null;
			if (!c) {
				$(".f-host").value = "";
				return;
			}
			$(".f-host").value = c.host ?? "";
			$(".f-port").value = c.port ?? 22;
			$(".f-user").value = c.username ?? "";
			$(".f-remote").value = c.remotePath ?? "";
			$(".f-auth").value = c.auth?.method ?? "password";
			$(".f-pass").value = "";
			$(".f-passphrase").value = "";
			$(".f-keypath").value = c.auth?.privateKeyPath ?? "";
			$(".f-agent").value = c.auth?.agent ?? "";
			// ignore 里剔除内置默认，只显示用户额外加的那部分（否则表单里全是噪音）
			const builtin = new Set([
				".git",
				"node_modules",
				".pi",
				".sftp-trash",
				"*.log",
				"*.tmp",
				".vscode/sftp.json",
				"**/.vscode/sftp.json",
			]);
			$(".f-ignore").value = (c.ignore ?? []).filter((x) => !builtin.has(x)).join("\n");
		}

		function paintChips() {
			const chips = $(".chips");
			const dep = state?.dep ?? {};
			const parts = [];
			parts.push(
				dep.status === "ready"
					? `<span class="chip ok">ssh2 ✓</span>`
					: dep.status === "failed"
						? `<span class="chip err">ssh2 ✗</span>`
						: `<span class="chip warn">ssh2 ${esc(dep.status ?? "?")}</span>`,
			);
			if (state?.job?.running) {
				const j = state.job;
				const scanning = j.phase === "scan" || j.phase === "cancelling";
				parts.push(
					scanning
						? `<span class="chip warn">${esc(t("planning"))} ${j.scan?.files ?? 0}</span>`
						: `<span class="chip warn">${esc(t("running"))} ${j.done}/${j.total}</span>`,
				);
			}
			parts.push(`<span class="chip">${esc(state?.configPath ?? ".pi/sftp.json")}</span>`);
			const j = state?.job;
			if (j && !j.running && j.cancelled) parts.push(`<span class="chip">${esc(t("stopped"))}</span>`);
			if (j && !j.running && j.error) parts.push(`<span class="chip err">${esc(j.error.slice(0, 60))}</span>`);
			chips.innerHTML = parts.join("");
		}

		function actionLabel(action, kind) {
			if (action === "upload") return kind === "add" ? "+ 上传" : "↑ 更新";
			if (action === "download") return kind === "add" ? "↓ 新增" : "↓ 拉取";
			if (action === "trash-remote" || action === "trash-local") return "✗ 清理";
			if (kind === "remote-only") return "· 远端";
			if (kind === "same") return "✓ 一致";
			if (kind === "conflict") return "⚠ 冲突";
			return "跳过";
		}

		function formatDetailedReason(e) {
			if (e.action === "upload" && e.kind === "add") {
				return `本地新增文件 (${fmtSize(e.localSize)}) · 准备上传至远端`;
			}
			if (e.action === "upload" && e.kind === "update") {
				if (e.localSize !== e.remoteSize) {
					const diff = (e.localSize ?? 0) - (e.remoteSize ?? 0);
					const diffStr = diff > 0 ? `+${fmtSize(diff)}` : `-${fmtSize(Math.abs(diff))}`;
					return `内容修改：本地 ${fmtSize(e.localSize)} vs 远端 ${fmtSize(e.remoteSize)} (${diffStr}) · 准备覆盖上传`;
				}
				if (e.localMtime && e.remoteMtime && e.localMtime !== e.remoteMtime) {
					return `修改时间更新：本地 ${fmtTime(e.localMtime)} vs 远端 ${fmtTime(e.remoteMtime)} · 准备覆盖上传`;
				}
				return `内容有改动 · 准备覆盖上传`;
			}
			if (e.action === "download" && e.kind === "add") {
				return `远端新增文件 (${fmtSize(e.remoteSize)}) · 准备拉取到本地`;
			}
			if (e.action === "download" && e.kind === "update") {
				return `远端内容更新 (${fmtSize(e.remoteSize)}) · 准备拉取覆盖本地`;
			}
			if (e.action === "trash-remote") {
				return `远端多余文件 (${fmtSize(e.remoteSize)}) · 本地已不存在，准备移入远端垃圾桶`;
			}
			if (e.action === "trash-local") {
				return `本地多余文件 (${fmtSize(e.localSize)}) · 远端已不存在，准备移入本地垃圾桶`;
			}
			if (e.kind === "remote-only" && e.action === "skip") {
				return `仅远端存在 (${fmtSize(e.remoteSize)}) · 删除策略设为从不删除，保留不清理`;
			}
			if (e.kind === "local-only" && e.action === "skip") {
				return `仅本地存在 (${fmtSize(e.localSize)}) · 远端无对应文件，保留不上传`;
			}
			if (e.kind === "same") {
				return `两侧内容完全一致 (${fmtSize(e.localSize)}) · 无需同步`;
			}
			if (e.kind === "conflict") {
				return `两侧均有冲突修改 · ${e.reason}`;
			}
			return e.reason || "";
		}

		let activePlan = null;
		let activeDiffTab = "actionable";

		function renderDiffItems(filteredRows) {
			const box = $(".diff");
			if (!filteredRows.length) {
				box.innerHTML = `<div class="it"><span class="tag"></span><span class="rel hint">${esc(t("diffNoChanges"))}</span></div>`;
				return;
			}
			box.innerHTML = filteredRows
				.slice(0, 400)
				.map((e) => {
					const cls =
						e.action === "upload"
							? "upload"
							: e.action === "download"
								? "download"
								: e.action.startsWith("trash")
									? "trash"
									: e.kind === "conflict"
										? "conflict"
										: e.kind === "remote-only"
											? "remote-only"
											: e.kind === "same"
												? "same"
												: "";
					return `<div class="it ${cls}"><span class="tag">${esc(actionLabel(e.action, e.kind))}</span><span class="rel">${esc(e.rel)}<div class="why">${esc(formatDetailedReason(e))}${e.kind === "conflict" ? " ⚠" : ""}</div></span></div>`;
				})
				.join("");
			if (filteredRows.length > 400) {
				box.insertAdjacentHTML(
					"beforeend",
					`<div class="it"><span class="tag"></span><span class="rel hint">+${filteredRows.length - 400} …</span></div>`,
				);
			}
			for (const w of activePlan?.warnings ?? []) {
				box.insertAdjacentHTML(
					"beforeend",
					`<div class="it"><span class="tag"></span><span class="rel warn">⚠ ${esc(w)}</span></div>`,
				);
			}
		}

		function paintPlan(plan) {
			activePlan = plan;
			lastPlanSummary = plan?.summary ?? null;
			const box = $(".diff");
			const tabsBox = $(".diff-tabs");
			if (!plan) {
				box.innerHTML = `<div class="it"><span class="tag"></span><span class="rel hint">${esc(t("noPlan"))}</span></div>`;
				$(".summary").textContent = "";
				tabsBox.classList.add("hidden");
				tabsBox.innerHTML = "";
				return;
			}

			const allEntries = [];
			for (const root of plan.roots ?? []) {
				for (const e of root.entries ?? []) {
					allEntries.push(e);
				}
			}

			const actionable = allEntries.filter((e) => e.action !== "skip" || e.kind === "conflict");
			const uploads = allEntries.filter((e) => e.action === "upload");
			const downloads = allEntries.filter((e) => e.action === "download");
			const trashes = allEntries.filter((e) => e.action.startsWith("trash"));
			const remoteOnly = allEntries.filter((e) => e.kind === "remote-only" && e.action === "skip");
			const same = allEntries.filter((e) => e.kind === "same");

			const s = plan.summary;
			$(".summary").textContent = t("summaryDetailed", {
				up: s.upload,
				down: s.download,
				trash: s.trashRemote + s.trashLocal,
				same: same.length,
				remoteOnly: remoteOnly.length,
			});

			const tabDefs = [
				{ key: "actionable", label: t("diffTabActionable"), count: actionable.length, items: actionable },
				{ key: "upload", label: t("diffTabUpload"), count: uploads.length, items: uploads, hideZero: true },
				{ key: "download", label: t("diffTabDownload"), count: downloads.length, items: downloads, hideZero: true },
				{ key: "trash", label: t("diffTabTrash"), count: trashes.length, items: trashes, hideZero: true },
				{
					key: "remote-only",
					label: t("diffTabRemoteOnly"),
					count: remoteOnly.length,
					items: remoteOnly,
					hideZero: true,
				},
				{ key: "same", label: t("diffTabSame"), count: same.length, items: same, hideZero: true },
			].filter((tb) => !tb.hideZero || tb.count > 0);

			if (!tabDefs.some((tb) => tb.key === activeDiffTab)) {
				activeDiffTab = "actionable";
			}

			tabsBox.classList.remove("hidden");
			tabsBox.innerHTML = tabDefs
				.map(
					(tb) =>
						`<button class="${tb.key === activeDiffTab ? "active" : ""}" data-tab="${tb.key}">${esc(tb.label)} (${tb.count})</button>`,
				)
				.join("");

			tabsBox.onclick = (ev) => {
				const btn = ev.target.closest?.("button[data-tab]");
				if (!btn) return;
				activeDiffTab = btn.dataset.tab;
				paintPlan(activePlan);
			};

			const currentTab = tabDefs.find((tb) => tb.key === activeDiffTab) || tabDefs[0];
			renderDiffItems(currentTab ? currentTab.items : actionable);
		}

		function paintJob() {
			const j = state?.job;
			const bar = $(".bar");
			const prog = $(".progress");
			const stop = $(".btn-stop");
			const scanning = j?.running && (j.phase === "scan" || j.phase === "cancelling");
			if (stop) {
				// 停止按钮在扫描期间也要亮着：大树上「扫描」比传输还久，这段停不了等于卡死
				stop.classList.toggle("hidden", !j?.running);
				stop.disabled = j?.phase === "cancelling";
				stop.textContent = j?.phase === "cancelling" ? t("stopping") : t("stopBtn");
			}
			if (!j?.running) {
				bar.classList.add("hidden");
				bar.classList.remove("indet");
				if (j?.result) {
					prog.classList.remove("hidden");
					prog.textContent =
						t("done", {
							up: j.result.done.upload,
							down: j.result.done.download,
							trash: j.result.done.trashRemote + j.result.done.trashLocal,
						}) + (j.result.failed?.length ? ` · ${t("failed", { n: j.result.failed.length })}` : "");
				} else if (j?.cancelled) {
					prog.classList.remove("hidden");
					prog.textContent = t("stopped");
				} else {
					prog.classList.add("hidden");
				}
				return;
			}
			bar.classList.remove("hidden");
			prog.classList.remove("hidden");
			if (scanning) {
				// 扫描没有「总量」：走不确定态条纹 + 实时计数，让用户看到它在动
				bar.classList.add("indet");
				prog.textContent = t("scanStat", {
					side: j.scan?.side === "remote" ? t("sideRemote") : t("sideLocal"),
					files: j.scan?.files ?? 0,
					dirs: j.scan?.dirs ?? 0,
				});
				return;
			}
			bar.classList.remove("indet");
			const pct = Math.round((j.done / Math.max(1, j.total)) * 100);
			bar.querySelector("i").style.width = `${pct}%`;
			prog.textContent = `${t("running")} ${j.done}/${j.total} ${j.rel ? `· ${j.rel}` : ""}${j.reusedPlan ? ` · ${t("reusedPlan")}` : ""}`;
		}

		async function refresh(fill = true) {
			if (disposed) return;
			try {
				state = await api("/state");
			} catch (err) {
				paintChips();
				showError(".msg.err", String(err.message ?? err));
				return;
			}
			paintChips();
			paintJob();
			if (fill || (state?.active ?? null) !== filledProfile) fillForm();
			else updateProfileChrome();
			$(".btn-run").disabled = !state.connection?.ready || !!state.job?.running;
			$(".btn-plan").disabled = !state.connection?.ready || !!state.job?.running;
		}

		function scheduleRefresh() {
			if (pollTimer) clearTimeout(pollTimer);
			const fast = state?.job?.running;
			pollTimer = setTimeout(
				async () => {
					await refresh(false);
					scheduleRefresh();
				},
				fast ? 600 : 2500,
			);
		}

		function findSyncRoot(abs) {
			const c = state?.connection;
			if (!c) return null;
			const roots = c.mappings?.length ? c.mappings : [{ local: "", remote: c.remotePath || "/" }];
			return roots.find((r) => {
				const rem = (r.remote || "/").replace(/\/+$/, "");
				return abs === rem || abs.startsWith(`${rem}/`);
			});
		}

		// ── 远端浏览器 ──────────────────────────────────────────────────────
		async function loadRemote(dir) {
			try {
				const data = await api(`/remote?path=${encodeURIComponent(dir)}`);
				remoteDir = data.dir;
				$(".f-rdir").value = remoteDir;
				const inRoot = Boolean(findSyncRoot(remoteDir));
				const rootPath = state?.connection?.remotePath || "/";
				const btnRup = $(".btn-rup");
				if (btnRup) {
					btnRup.disabled = !inRoot;
					btnRup.textContent = inRoot ? t("uploadHere") : t("uploadHereDisabled");
					btnRup.title = inRoot ? "" : t("outsideRootUploadHint", { root: rootPath });
				}
				const btnRroot = $(".btn-rroot");
				if (btnRroot) {
					btnRroot.title = t("goProjectRootHint", { root: rootPath });
					btnRroot.style.borderColor = inRoot ? "" : "var(--accent, #7c5cff)";
				}
				const tree = $(".tree");
				if (!data.entries.length) {
					tree.innerHTML = `<div class="fr"><span></span><span class="nm hint">∅</span><span class="sz"></span><span></span></div>`;
					return;
				}
				tree.innerHTML = data.entries
					.map((e) => {
						const itemInRoot = Boolean(findSyncRoot(e.path));
						return `
					<div class="fr" data-path="${esc(e.path)}" data-type="${e.type}">
						<span>${e.type === "dir" ? "📁" : "📄"}</span>
						<span class="nm ${e.type === "dir" ? "dir" : ""}">${esc(e.name)}</span>
						<span class="sz">${e.type === "dir" ? "" : fmtSize(e.size)}</span>
						<span class="sz">${esc(fmtTime(e.mtime ? Math.floor(e.mtime / 1000) : null))}</span>
						<span class="actions">
							<button class="act-btn up" ${
								itemInRoot
									? `data-up="1" title="${esc(t("uploadItemHint"))}"`
									: `disabled style="opacity:.2;cursor:not-allowed;" title="${esc(t("outsideRootUploadItemHint"))}"`
							}>⬆</button>
							<button class="act-btn dl" ${
								itemInRoot
									? `data-dl="1" title="${esc(t("downloadItemHint"))}"`
									: `disabled style="opacity:.2;cursor:not-allowed;" title="${esc(t("outsideRootDownloadHint", { root: rootPath }))}"`
							}>⬇</button>
							<button class="act-btn ign" ${
								itemInRoot
									? `data-ign="1" title="${esc(t("ignoreItemHint"))}"`
									: `disabled style="opacity:.2;cursor:not-allowed;" title="${esc(t("outsideRootIgnoreHint"))}"`
							}>🚫</button>
						</span>
					</div>`;
					})
					.join("");
			} catch (err) {
				showError(".msg.err", String(err.message ?? err));
			}
		}

		/** 手动传一个明确的对象（文件/子树/整根）—— 服务端固定 deletePolicy=none，永不删。 */
		async function transfer(direction, path, label) {
			const prog = $(".progress");
			prog.classList.remove("hidden");
			prog.textContent = direction === "up" ? t("uploading") : t("downloading");
			try {
				const out = await api("/transfer", { method: "POST", body: { direction, path } });
				const r = out.result ?? {};
				if (out.cancelled) {
					prog.textContent = `${label || path || "."} —— ${t("stopped")}`;
				} else {
					const n = (r.done?.upload ?? 0) + (r.done?.download ?? 0);
					prog.textContent = `${label || path || "."} —— ${t("transferred", { dir: direction === "up" ? t("upload") : t("download"), n })}${
						r.failed?.length ? ` · ${t("failed", { n: r.failed.length })}` : ""
					}`;
				}
				await refresh();
				await loadRemote(remoteDir);
			} catch (err) {
				prog.textContent = "";
				prog.classList.add("hidden");
				showError(".msg.err", String(err.message ?? err));
			}
		}

		/** 右键菜单给的路径 → 工作区相对路径。
		 *  文件树在工作区里给的是相对路径；机器浏览给的是绝对路径 —— 只有确实在工作区内
		 *  才折算成相对路径，工作区外一律拒绝（服务端 /transfer 只认工作区内的相对路径：
		 *  硬塞绝对路径只会得到一句莫名的「本地不存在」，POSIX 上还会被当成远端路径）。 */
		function toWorkspaceRel(raw) {
			const p = String(raw ?? "")
				.replace(/\\/g, "/")
				.trim();
			if (!p) return "";
			const isAbs = /^[A-Za-z]:\//.test(p) || p.startsWith("/");
			if (!isAbs) return p;
			const cwd = String(state?.cwd ?? "")
				.replace(/\\/g, "/")
				.replace(/\/+$/, "");
			if (!cwd) return null;
			const abs = p.toLowerCase();
			const root = cwd.toLowerCase();
			if (abs === root) return "";
			if (abs.startsWith(`${root}/`)) return p.slice(cwd.length + 1);
			return null;
		}

		/** 右键菜单来的上传/下载：面板已经切出来了，进度与结果就写在这张卡片里。 */
		async function transferExternal(req) {
			showError(".msg.err", "");
			const rel = toWorkspaceRel(req.path);
			if (rel === null) {
				showError(".msg.err", t("outsideWorkspace", { path: req.path }));
				return;
			}
			await transfer(req.direction ?? "up", rel, req.label || rel || ".");
		}

		// 初始快照。**声明必须在 drainExternal 之前**：右键菜单唤起时那个同步调用会
		// 立刻求值 `ready`（在后面声明就撞 TDZ）。refresh() 自带 try/catch，不会 reject。
		const ready = refresh().then(() => {
			const root = state?.connection?.remotePath;
			if (root) void loadRemote(root);
			scheduleRefresh();
		});

		/** 外部请求队列：串行跑（两条并发会互相刷同一个进度条）。 */
		const externalQueue = [];
		let draining = false;
		async function drainExternal() {
			if (draining) return;
			draining = true;
			try {
				// 初始 refresh 回来前 state.cwd 是空的，而绝对路径要靠它折算 —— 先等一下
				await ready.catch(() => {});
				while (externalQueue.length) {
					await transferExternal(externalQueue.shift());
				}
			} finally {
				draining = false;
			}
		}
		panelSink = (req) => {
			externalQueue.push(req);
			void drainExternal();
		};
		panelIgnoreSink = async (mode, rel) => {
			try {
				const out = await api("/ignore-toggle", {
					method: "POST",
					body: {
						profile: state?.active || $(".profile")?.value || "default",
						path: rel,
						mode,
					},
				});
				if (out.message) {
					try {
						globalThis.window?.__piWebUiHost?.notify?.("info", `☁ ${out.message}`, `☁ ${out.message}`);
					} catch {}
				}
				await refresh(true);
			} catch (err) {
				try {
					globalThis.window?.__piWebUiHost?.notify?.("error", `SFTP 忽略操作失败：${err.message ?? err}`);
				} catch {}
			}
		};
		// 面板就是被右键菜单唤起的那一次：把模块级攒下的请求转进来
		if (pendingOps.length) {
			externalQueue.push(...pendingOps.splice(0, pendingOps.length));
			void drainExternal();
		}

		async function openRemoteFile(path) {
			try {
				const f = await api(`/remote-file?path=${encodeURIComponent(path)}`);
				editor = { path: f.path, text: f.text, binary: f.binary };
				$(".editor").classList.remove("hidden");
				$(".ed-path").textContent = f.path + (f.binary ? ` — ${t("binary")}` : `（${fmtSize(f.size)}）`);
				$(".ed-text").value = f.text;
				$(".ed-text").readOnly = f.binary;
				$(".btn-ed-save").disabled = f.binary;
				$(".ed-msg").textContent = "";
			} catch (err) {
				showError(".msg.err", String(err.message ?? err));
			}
		}

		// ── 事件绑定 ────────────────────────────────────────────────────────
		const on = (sel, ev, fn) => {
			const el = $(sel);
			if (el) el.addEventListener(ev, fn);
		};

		on(".profile", "change", async (e) => {
			try {
				await api("/active", { method: "POST", body: { name: e.target.value } });
				await refresh();
			} catch (err) {
				showError(".msg.err", String(err.message ?? err));
			}
		});

		on(".btn-save", "click", async () => {
			if (busy) return;
			busy = true;
			showError(".msg.err", "");
			showError(".msg.ok", "");
			try {
				const name = $(".profile").value || "default";
				const patch = {
					host: $(".f-host").value.trim(),
					port: Number($(".f-port").value) || 22,
					username: $(".f-user").value.trim(),
					remotePath: $(".f-remote").value.trim(),
					ignore: $(".f-ignore")
						.value.split(/[\n,]/)
						.map((x) => x.trim())
						.filter(Boolean),
					method: $(".f-auth").value,
					privateKeyPath: $(".f-keypath").value.trim(),
					agent: $(".f-agent").value.trim(),
				};
				if ($(".f-pass").value) patch.password = $(".f-pass").value;
				if ($(".f-passphrase").value) patch.passphrase = $(".f-passphrase").value;
				await api("/profile", { method: "POST", body: { name, patch, makeActive: true } });
				showError(".msg.ok", "✓");
				await refresh();
			} catch (err) {
				showError(".msg.err", String(err.message ?? err));
			} finally {
				busy = false;
			}
		});

		on(".btn-secret", "click", async () => {
			const name = globalThis.prompt?.(t("secretPrompt")) ?? "";
			if (!name) return;
			const value = globalThis.prompt?.(t("secretValue")) ?? "";
			if (!value) return;
			try {
				const out = await api("/secret", { method: "POST", body: { name, value } });
				showError(".msg.ok", out.ref);
			} catch (err) {
				showError(".msg.err", String(err.message ?? err));
			}
		});

		on(".btn-test", "click", async () => {
			const btn = $(".btn-test");
			btn.disabled = true;
			btn.textContent = t("testing");
			showError(".msg.err", "");
			showError(".msg.ok", "");
			try {
				const out = await api("/test", { method: "POST", body: { profile: $(".profile").value } });
				showError(
					".msg.ok",
					`${out.host}:${out.port} ✓ ${out.remoteExists ? "" : "（远端根不存在，首次同步会创建）"}${out.writable ? "" : " ⚠ 不可写"}`,
				);
			} catch (err) {
				showError(".msg.err", String(err.message ?? err));
			} finally {
				btn.disabled = false;
				btn.textContent = t("test");
			}
		});

		on(".btn-copy-key", "click", async () => {
			const btn = $(".btn-copy-key");
			btn.disabled = true;
			btn.textContent = t("copyKeyTesting");
			showError(".msg.err", "");
			showError(".msg.ok", "");
			const callCopy = (pw) =>
				api("/copy-pubkey", {
					method: "POST",
					body: {
						profile: $(".profile").value,
						host: $(".f-host").value.trim(),
						port: Number($(".f-port").value) || undefined,
						username: $(".f-user").value.trim(),
						password: pw || undefined,
						privateKeyPath: $(".f-keypath").value.trim() || undefined,
					},
				});
			try {
				let password = $(".f-pass").value.trim();
				let out;
				try {
					out = await callCopy(password);
				} catch (err) {
					const msg = String(err.message ?? err);
					if (!password && msg.startsWith("NEED_PASSWORD:")) {
						const prompted = globalThis.prompt?.(t("copyKeyPrompt")) ?? "";
						if (prompted) {
							out = await callCopy(prompted);
						} else {
							$(".f-pass")?.focus?.();
							throw new Error(msg.replace(/^NEED_PASSWORD:\s*/, ""));
						}
					} else {
						throw err;
					}
				}
				if (out.verified) {
					showError(".msg.ok", out.alreadyPresent ? t("copyKeyAlready") : t("copyKeySuccess"));
					const root = remoteDir || state?.connection?.remotePath || "/";
					void loadRemote(root);
				} else {
					showError(".msg.err", t("copyKeyWarn", { err: out.verifyError || "验证未通过" }));
				}
				await refresh(false);
			} catch (err) {
				showError(".msg.err", String(err.message ?? err).replace(/^NEED_PASSWORD:\s*/, ""));
			} finally {
				btn.disabled = false;
				btn.textContent = t("copyKey");
			}
		});

		on(".btn-import", "click", async () => {
			const btn = $(".btn-import");
			btn.disabled = true;
			btn.textContent = t("importing");
			try {
				const out = await api("/import", { method: "POST", body: {} });
				showError(".msg.ok", `✓ ${out.name} ${out.note ?? ""}`);
				await refresh();
			} catch (err) {
				showError(".msg.err", String(err.message ?? err));
			} finally {
				btn.disabled = false;
				btn.textContent = t("import");
			}
		});

		async function doPlanOrSync(run) {
			showError(".msg.err", "");
			const body = {
				profile: $(".profile").value,
				direction: $(".f-dir").value,
				scope: $(".f-scope").value,
				path: $(".f-path").value.trim(),
			};
			const key = JSON.stringify([body.profile, body.direction, body.scope, body.path]);
			const btn = run ? $(".btn-run") : $(".btn-plan");
			btn.disabled = true;
			const old = btn.textContent;
			btn.textContent = t("planning");
			try {
				if (!run) {
					const out = await api("/plan", { method: "POST", body });
					if (out.cancelled) {
						progLine(t("stopped"));
						paintPlan(null);
						return;
					}
					lastPlanToken = out.planToken ?? null;
					lastPlanKey = key;
					paintPlan(out.plan);
				} else {
					if (lastPlanSummary) {
						const deletions = lastPlanSummary.trashRemote + lastPlanSummary.trashLocal;
						if (deletions && !globalThis.confirm?.(t("confirmDelete", { n: deletions }))) return;
					} else if (!globalThis.confirm?.(t("confirmRun"))) {
						return;
					}
					// 参数没变就用刚才预览的那份计划：大树上「预览→执行」等于扫两遍，第二遍纯属白等
					const reuse = Boolean(lastPlanToken) && lastPlanKey === key;
					const out = await api("/sync", {
						method: "POST",
						body: { ...body, dryRun: false, ...(reuse ? { reuse: true, planToken: lastPlanToken } : {}) },
					});
					// 计划一到手就作废：下次执行必须重新扫，不能让改完的文件拿旧计划去传
					lastPlanToken = null;
					lastPlanKey = null;
					if (out.cancelled) {
						progLine(t("stopped"));
						return;
					}
					paintPlan(out.plan);
					if (out.reused) progLine(t("reusedPlan"));
					await refresh();
				}
			} catch (err) {
				showError(".msg.err", String(err.message ?? err));
			} finally {
				btn.textContent = old;
				btn.disabled = false;
			}
		}

		/** 进度行就地写一句话（不经过 refresh，因为任务已经结束、state 里未必马上有）。 */
		function progLine(text) {
			const prog = $(".progress");
			prog.classList.remove("hidden");
			prog.textContent = text;
		}

		on(".btn-plan", "click", () => doPlanOrSync(false));
		on(".btn-run", "click", () => doPlanOrSync(true));

		// 停止：扫描阶段和传输阶段都能停（服务端复用同一个 AbortController）。
		on(".btn-stop", "click", async () => {
			const btn = $(".btn-stop");
			btn.disabled = true;
			btn.textContent = t("stopping");
			try {
				await api("/cancel", { method: "POST", body: {} });
			} catch (err) {
				showError(".msg.err", String(err.message ?? err));
			}
			await refresh();
		});

		on(".btn-up", "click", () => {
			const parent = remoteDir.replace(/\/+$/, "").split("/").slice(0, -1).join("/") || "/";
			void loadRemote(parent);
		});
		on(".btn-rroot", "click", () => void loadRemote(state?.connection?.remotePath || "/"));
		on(".btn-rgo", "click", () => void loadRemote($(".f-rdir").value.trim() || "/"));
		on(".btn-rfresh", "click", () => void loadRemote(remoteDir));
		// 手动上传：把当前远端目录对应的本地目录推上去（服务端反查 mappings）
		on(".btn-rup", "click", async () => {
			const btn = $(".btn-rup");
			btn.disabled = true;
			try {
				await transfer("up", remoteDir, remoteDir);
			} finally {
				btn.disabled = false;
			}
		});

		const tree = $(".tree");
		tree.addEventListener("click", (e) => {
			const row = e.target.closest?.(".fr");
			if (!row) return;
			const p = row.dataset.path;
			// ⬆ 手动上传本地对应文件/目录到此处
			if (e.target.closest?.("[data-up]")) {
				e.stopPropagation();
				void transfer("up", p, row.querySelector(".nm")?.textContent ?? p);
				return;
			}
			// ⬇ 手动下载这一项（目录则整棵子树）
			if (e.target.closest?.("[data-dl]")) {
				e.stopPropagation();
				void transfer("down", p, row.querySelector(".nm")?.textContent ?? p);
				return;
			}
			// 🚫 将对应路径加入 SFTP 忽略
			if (e.target.closest?.("[data-ign]")) {
				e.stopPropagation();
				const hit = findSyncRoot(p);
				if (hit) {
					const rem = (hit.remote || "/").replace(/\/+$/, "");
					const rest = p.slice(rem.length).replace(/^\/+/, "");
					const rel = hit.local ? (rest ? `${hit.local}/${rest}` : hit.local) : rest;
					void handleIgnoreAction("add", { id: rel });
				}
				return;
			}
			if (row.dataset.type === "dir") void loadRemote(p);
			else void openRemoteFile(p);
		});

		on(".btn-ed-save", "click", async () => {
			const btn = $(".btn-ed-save");
			btn.disabled = true;
			btn.textContent = t("writing");
			try {
				await api("/remote-write", { method: "POST", body: { path: editor.path, text: $(".ed-text").value } });
				$(".ed-msg").textContent = "✓";
			} catch (err) {
				$(".ed-msg").textContent = String(err.message ?? err);
			} finally {
				btn.disabled = false;
				btn.textContent = t("write");
			}
		});
		on(".btn-ed-close", "click", () => {
			$(".editor").classList.add("hidden");
			editor = { path: "", text: "", binary: false };
		});

		return () => {
			disposed = true;
			if (pollTimer) clearTimeout(pollTimer);
			panelSink = null;
			panelIgnoreSink = null;
			container.innerHTML = "";
		};
	},
};
