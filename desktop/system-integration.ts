/**
 * Windows 系统集成：把桌面版注册成「默认浏览器候选」与「文件关联候选」。
 *
 * 三条硬约束（Windows 10/11 现实）：
 * 1. 默认应用由系统 `UserChoice` + 哈希守卫，任何程序都**不能**静默改写；我们能做的只有
 *    写好 ProgId 与 Capabilities（让 pi 出现在「打开方式 / 默认应用」列表里），再把人送到
 *    系统设置页由用户确认。
 * 2. 注册表走 HKCU（用户级），不需要管理员权限，卸载/解绑就是删自己的键。
 * 3. 便携版换目录后 ProgId 里的 exe 路径会失效，所以每次启动核对一次命令目标（`stale`）。
 *
 * 本模块的纯函数部分（注册表命令构建、reg 输出解析、argv 解析）不碰 electron / 不吃进程状态，
 * 单测直接跑；真正的 reg.exe 执行器只在主进程里被注入使用（异步 spawn，禁止 spawnSync）。
 */
import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { win32 } from "node:path";

/** 出现在「默认应用」列表里的名字，同时是 RegisteredApplications 的值名。 */
export const INTEGRATION_APP_NAME = "Pi Web UI";
/** 我们自己所有 ProgId / Capabilities 的前缀。 */
export const INTEGRATION_APP_ID = "PiWebUI.Desktop";
export const BROWSER_PROG_ID = `${INTEGRATION_APP_ID}.Html`;
export const CAPABILITIES_KEY = "Software\\PiWebUI\\Capabilities";
export const REGISTERED_APPLICATIONS_KEY = "Software\\RegisteredApplications";
/**
 * 「Web 浏览器」聚合列表读的是 StartMenuInternet，不是 RegisteredApplications。
 * 只写后者 pi 会出现在「按协议选择默认应用」里，但不会出现在 Web 浏览器下拉中。
 */
export const BROWSER_CLIENT_KEY = `Software\\Clients\\StartMenuInternet\\${INTEGRATION_APP_ID}`;
const CLASSES_KEY = "Software\\Classes";
const URL_CHOICE_KEY = "Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations";
const FILE_CHOICE_KEY = "Software\\Microsoft\\Windows\\Shell\\Associations\\FileExts";

/** 允许绑定的扩展名（默认值只在 UI 侧用；这里给个上界，防止把注册表写炸）。 */
export const MAX_ASSOCIATED_EXTENSIONS = 32;

/** 新用户默认登记：内置预览的 PDF + Office 插件接管的三种主流格式。用户自己勾过的以配置文件为准。 */
export const DEFAULT_ASSOCIATION_EXTENSIONS = [".pdf", ".docx", ".xlsx", ".pptx"] as const;

export type RegistryAction =
	| { op: "set"; key: string; name: string | null; value: string }
	| { op: "deleteValue"; key: string; name: string }
	| { op: "deleteKey"; key: string };

export interface FileAssociationState {
	ext: string;
	progId: string;
	/** ProgId 已注册且命令指向当前 exe */
	registered: boolean;
	/** 系统当前默认程序就是 pi（UserChoice） */
	isDefault: boolean;
}

export interface SystemIntegrationState {
	supported: boolean;
	platform: string;
	/** 打包前（dev）注册会把 electron.exe 写成默认浏览器，所以直接禁用 */
	packaged: boolean;
	exePath: string;
	/** 我们自己写的键还在 */
	registered: boolean;
	/** 注册命令指向的 exe 与当前进程不一致（便携版换目录 / 装了新版本） */
	stale: boolean;
	registeredExe: string | null;
	browser: { progId: string; registered: boolean; isDefault: boolean };
	files: FileAssociationState[];
}

export interface RegistryRunResult {
	ok: boolean;
	stdout: string;
	stderr: string;
}

export type RegistryRunner = (args: string[]) => Promise<RegistryRunResult>;

export interface CollectOpenTargetsOptions {
	exists?: (path: string) => boolean;
	isFile?: (path: string) => boolean;
	cwd?: string;
}

export interface OpenTargets {
	files: string[];
	urls: string[];
}

/** `.PDF ` → `.pdf`；非法值返回 null。 */
export function normalizeExtension(value: string): string | null {
	const trimmed = String(value ?? "")
		.trim()
		.toLowerCase();
	if (!trimmed) return null;
	const withDot = trimmed.startsWith(".") ? trimmed : `.${trimmed}`;
	return /^\.[a-z0-9][a-z0-9._-]{0,31}$/.test(withDot) ? withDot : null;
}

export function normalizeExtensions(values: readonly string[]): string[] {
	const out: string[] = [];
	for (const value of values) {
		const ext = normalizeExtension(value);
		if (!ext || out.includes(ext)) continue;
		out.push(ext);
		if (out.length >= MAX_ASSOCIATED_EXTENSIONS) break;
	}
	return out;
}

/** 一个扩展名一个 ProgId：图标/描述/命令互不牵连，删起来也干净。 */
export function fileProgId(ext: string): string {
	const normalized = normalizeExtension(ext);
	if (!normalized) throw new Error(`Invalid extension: ${String(ext)}`);
	return `${INTEGRATION_APP_ID}${normalized}`;
}

/** ProgId 的 shell\open\command：带引号的 exe + `"%1"`，reg 里空格路径必须这么写。 */
export function shellCommand(exePath: string): string {
	return `"${exePath}" "%1"`;
}

export function browserRegistrationActions(exePath: string): RegistryAction[] {
	const progIdKey = `${CLASSES_KEY}\\${BROWSER_PROG_ID}`;
	const icon = `"${exePath}",0`;
	return [
		{ op: "set", key: progIdKey, name: null, value: INTEGRATION_APP_NAME },
		{ op: "set", key: progIdKey, name: "FriendlyTypeName", value: INTEGRATION_APP_NAME },
		{ op: "set", key: `${progIdKey}\\DefaultIcon`, name: null, value: icon },
		{ op: "set", key: `${progIdKey}\\shell\\open\\command`, name: null, value: shellCommand(exePath) },
		// Windows 10/11 的「默认应用 → Web 浏览器」下拉只列 StartMenuInternet 客户端
		{ op: "set", key: BROWSER_CLIENT_KEY, name: null, value: INTEGRATION_APP_NAME },
		{ op: "set", key: `${BROWSER_CLIENT_KEY}\\DefaultIcon`, name: null, value: icon },
		{ op: "set", key: `${BROWSER_CLIENT_KEY}\\shell\\open\\command`, name: null, value: shellCommand(exePath) },
		{ op: "set", key: CAPABILITIES_KEY, name: null, value: INTEGRATION_APP_NAME },
		{ op: "set", key: CAPABILITIES_KEY, name: "ApplicationName", value: INTEGRATION_APP_NAME },
		{
			op: "set",
			key: CAPABILITIES_KEY,
			name: "ApplicationDescription",
			value: "Pi Web UI — browser, agent and workspace in one window",
		},
		{ op: "set", key: CAPABILITIES_KEY, name: "ApplicationIcon", value: icon },
		{ op: "set", key: `${CAPABILITIES_KEY}\\UrlAssociations`, name: "http", value: BROWSER_PROG_ID },
		{ op: "set", key: `${CAPABILITIES_KEY}\\UrlAssociations`, name: "https", value: BROWSER_PROG_ID },
		{ op: "set", key: REGISTERED_APPLICATIONS_KEY, name: INTEGRATION_APP_NAME, value: CAPABILITIES_KEY },
	];
}

export function fileRegistrationActions(exePath: string, extensions: readonly string[]): RegistryAction[] {
	const exts = normalizeExtensions(extensions);
	if (!exts.length) return [];
	const actions: RegistryAction[] = [];
	const icon = `"${exePath}",0`;
	for (const ext of exts) {
		const progId = fileProgId(ext);
		const progIdKey = `${CLASSES_KEY}\\${progId}`;
		actions.push(
			{ op: "set", key: progIdKey, name: null, value: `${ext.slice(1).toUpperCase()} document` },
			{ op: "set", key: progIdKey, name: "FriendlyTypeName", value: `${ext.slice(1).toUpperCase()} document` },
			{ op: "set", key: `${progIdKey}\\DefaultIcon`, name: null, value: icon },
			{ op: "set", key: `${progIdKey}\\shell\\open\\command`, name: null, value: shellCommand(exePath) },
			// 只登记「可打开」候选：不写 .ext 的默认值，避免和系统 UserChoice 打架（Win10+ 也写不进去）
			{ op: "set", key: `${CLASSES_KEY}\\${ext}\\OpenWithProgids`, name: progId, value: "" },
			{ op: "set", key: `${CAPABILITIES_KEY}\\FileAssociations`, name: ext, value: progId },
		);
	}
	return actions;
}

export function browserRemovalActions(): RegistryAction[] {
	return [
		{ op: "deleteKey", key: `${CLASSES_KEY}\\${BROWSER_PROG_ID}` },
		{ op: "deleteKey", key: BROWSER_CLIENT_KEY },
		{ op: "deleteValue", key: `${CAPABILITIES_KEY}\\UrlAssociations`, name: "http" },
		{ op: "deleteValue", key: `${CAPABILITIES_KEY}\\UrlAssociations`, name: "https" },
	];
}

export function fileRemovalActions(extensions: readonly string[]): RegistryAction[] {
	const actions: RegistryAction[] = [];
	for (const ext of normalizeExtensions(extensions)) {
		const progId = fileProgId(ext);
		actions.push(
			{ op: "deleteKey", key: `${CLASSES_KEY}\\${progId}` },
			{ op: "deleteValue", key: `${CLASSES_KEY}\\${ext}\\OpenWithProgids`, name: progId },
			{ op: "deleteValue", key: `${CAPABILITIES_KEY}\\FileAssociations`, name: ext },
		);
	}
	return actions;
}

/** 全部解绑：自己的键、RegisteredApplications 登记、各扩展名的 OpenWithProgids 值都清掉。 */
export function removalActions(extensions: readonly string[]): RegistryAction[] {
	return [
		...browserRemovalActions(),
		...fileRemovalActions(extensions),
		{ op: "deleteValue", key: REGISTERED_APPLICATIONS_KEY, name: INTEGRATION_APP_NAME },
		{ op: "deleteKey", key: "Software\\PiWebUI" },
	];
}

export interface IntegrationSelection {
	browser: boolean;
	extensions: readonly string[];
}

/**
 * 把注册表读到的真实状态合并进本地文件里的勾选（纯函数，不碰注册表也不改写入语义）。
 *
 * `<userData>/system-integration.json` 只在「点了保存且注册表写入成功」时才落盘，
 * 用户手动注册、旧版本注册、在系统默认应用里确认过，都会让文件落后于注册表。
 * 这里只做并集：真实注册的一定勾上；文件里记着但当前没读到的（例如命令暂时 stale）保留，
 * 免得把用户原来的选择丢掉。显示与保存时的 `current` 都必须过这一层。
 */
export function reconcileIntegrationSelection(
	stored: IntegrationSelection,
	state: SystemIntegrationState,
): { browser: boolean; extensions: string[] } {
	return {
		browser: stored.browser || state.browser.registered,
		extensions: normalizeExtensions([
			...stored.extensions,
			...state.files.filter((file) => file.registered).map((file) => file.ext),
		]),
	};
}

/**
 * 勾选变化 → 注册表动作：新增的写、去掉的删、保留的不动（幂等，重复点“保存”不会抖）。
 * 全部取消时把自己在 RegisteredApplications 的登记也收掉，不在系统列表里留空壳。
 */
export function planIntegrationActions(
	current: IntegrationSelection,
	next: IntegrationSelection,
	exePath: string,
): RegistryAction[] {
	const currentExts = normalizeExtensions(current.extensions);
	const nextExts = normalizeExtensions(next.extensions);
	const removed = currentExts.filter((ext) => !nextExts.includes(ext));
	const actions: RegistryAction[] = [];
	actions.push(
		...(next.browser ? browserRegistrationActions(exePath) : browserRemovalActions()),
		...(removed.length ? fileRemovalActions(removed) : []),
		...(nextExts.length ? fileRegistrationActions(exePath, nextExts) : []),
	);
	if (!next.browser && nextExts.length === 0) {
		actions.push(
			{ op: "deleteValue", key: REGISTERED_APPLICATIONS_KEY, name: INTEGRATION_APP_NAME },
			{ op: "deleteKey", key: "Software\\PiWebUI" },
		);
	}
	return actions;
}

/**
 * 纯构建：RegistyAction → `reg.exe` 参数数组（不含 "reg.exe" 本身）。
 * key 一律补 `HKCU\`：queryValue 查询时加，写入/删除也必须加，否则 reg.exe 直接报「无效参数」。
 */
export function registryArgs(action: RegistryAction): string[] {
	const key = `HKCU\\${action.key}`;
	if (action.op === "deleteKey") return ["delete", key, "/f"];
	if (action.op === "deleteValue") return ["delete", key, "/v", action.name, "/f"];
	const nameArgs = action.name === null ? ["/ve"] : ["/v", action.name];
	return ["add", key, ...nameArgs, "/t", "REG_SZ", "/d", action.value, "/f"];
}

/**
 * reg query 的典型输出（每行一个值）：
 * `    ProgId    REG_SZ    MSEdgeHTML` / `    .pdf    REG_SZ    PiWebUI.Desktop.pdf`
 * 返回命中的第一个值；键不存在时返回 null。
 */
export function parseRegQueryValue(stdout: string, name: string): string | null {
	const wanted = name.toLowerCase();
	for (const line of stdout.split(/\r?\n/)) {
		const match = /^\s{2,}(.+?)\s{2,}REG_[A-Z_]+\s{2,}(.*)$/.exec(line);
		if (!match) continue;
		if ((match[1] ?? "").trim().toLowerCase() !== wanted) continue;
		return (match[2] ?? "").trim();
	}
	return null;
}

/** 列出 reg query 输出里所有值名（含 `(默认)`）。 */
export function parseRegQueryValueNames(stdout: string): string[] {
	const names: string[] = [];
	for (const line of stdout.split(/\r?\n/)) {
		const match = /^\s{2,}(.+?)\s{2,}REG_[A-Z_]+\s{2,}(.*)$/.exec(line);
		if (!match) continue;
		const name = (match[1] ?? "").trim();
		if (name) names.push(name);
	}
	return names;
}

/** 从 `"C:\a b\app.exe" "%1"` 里取出 exe 路径。 */
export function extractExeFromCommand(command: string | null): string | null {
	if (!command) return null;
	const trimmed = command.trim();
	if (!trimmed) return null;
	if (trimmed.startsWith('"')) {
		const end = trimmed.indexOf('"', 1);
		return end > 1 ? trimmed.slice(1, end) : null;
	}
	const space = trimmed.search(/\s/);
	return space === -1 ? trimmed : trimmed.slice(0, space);
}

export function samePath(a: string | null, b: string | null): boolean {
	if (!a || !b) return false;
	const norm = (value: string): string => value.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
	return norm(a) === norm(b);
}

/**
 * Windows 少数启动链路会把中文路径按系统 ANSI(GBK) 字节读进来，显示成 `Ðò±ê.xlsx` 这类 Latin-1 乱码。
 * 只在明确能解出 CJK 时修复，正常 UTF-8 路径（码点 > U+00FF）不会被误伤。
 */
function repairMojibake(value: string): string {
	if (!/[\u0080-\u00ff]/.test(value)) return value;
	try {
		const decoded = new TextDecoder("gbk", { fatal: true }).decode(Buffer.from(value, "latin1"));
		if (decoded !== value && /[\u4e00-\u9fff]/.test(decoded)) return decoded;
	} catch {
		// 解不出来就当它是合法文案，原样返回
	}
	return value;
}

/**
 * 从进程 argv 里挑出「双击文件 / 点链接」带来的目标。
 * 打包后 argv[0] 是 exe 自身，Electron 的开关（`--inspect`、`--pi-browser-embedded`）要排掉，
 * 剩下的才按存在性判定——不存在的路径交给系统提示没意义，静默丢弃。
 */
export function collectOpenTargets(argv: readonly string[], options: CollectOpenTargetsOptions = {}): OpenTargets {
	const exists = options.exists ?? ((p: string) => existsSync(p));
	const isFile = options.isFile ?? ((p: string) => safeIsFile(p));
	const cwd = options.cwd ?? process.cwd();
	const files: string[] = [];
	const urls: string[] = [];
	for (const raw of argv.slice(1)) {
		if (typeof raw !== "string") continue;
		const value = repairMojibake(raw.trim());
		if (!value || value.startsWith("-")) continue;
		if (/^https?:\/\//i.test(value) || /^file:\/\//i.test(value)) {
			if (!urls.includes(value)) urls.push(value);
			continue;
		}
		// 单平台（Windows 文件关联）专用：必须用 win32 语义。
		// 用宿主 path 时，在 Linux/macOS 上（含 CI）`C:\...` 不算绝对路径，会被拼成怪路径。
		const absolute = win32.isAbsolute(value) ? value : win32.resolve(cwd, value);
		if (!exists(absolute) || !isFile(absolute)) continue;
		if (!files.includes(absolute)) files.push(absolute);
	}
	return { files, urls };
}

function safeIsFile(path: string): boolean {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

/** 默认执行器：异步 spawn reg.exe（红线禁同步子进程）。 */
export function createRegistryRunner(executable = "reg.exe"): RegistryRunner {
	return (args) =>
		new Promise<RegistryRunResult>((resolveResult) => {
			let stdout = "";
			let stderr = "";
			let child;
			try {
				child = spawn(executable, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
			} catch (error) {
				resolveResult({ ok: false, stdout: "", stderr: error instanceof Error ? error.message : String(error) });
				return;
			}
			child.stdout?.on("data", (chunk: Buffer | string) => {
				stdout += chunk.toString();
			});
			child.stderr?.on("data", (chunk: Buffer | string) => {
				stderr += chunk.toString();
			});
			child.on("error", (error) => {
				resolveResult({ ok: false, stdout, stderr: stderr || error.message });
			});
			child.on("close", (code) => {
				resolveResult({ ok: code === 0, stdout, stderr });
			});
		});
}

export interface ApplyRegistryResult {
	ok: boolean;
	failed: RegistryAction[];
	error?: string;
}

export async function applyRegistryActions(
	actions: readonly RegistryAction[],
	runner: RegistryRunner,
): Promise<ApplyRegistryResult> {
	const failed: RegistryAction[] = [];
	let error: string | undefined;
	for (const action of actions) {
		const result = await runner(registryArgs(action));
		// 删不存在的键/值 = 已经是目标状态，不算失败（reg 返回 1 并念叨一句）
		const deleting = action.op !== "set";
		if (result.ok || deleting) continue;
		failed.push(action);
		error = error ?? result.stderr.trim();
	}
	return { ok: failed.length === 0, failed, error };
}

async function queryValue(runner: RegistryRunner, key: string, name: string | null): Promise<string | null> {
	const args = ["query", `HKCU\\${key}`, ...(name === null ? ["/ve"] : ["/v", name])];
	const result = await runner(args);
	if (!result.ok) return null;
	if (name === null) return parseRegQueryValue(result.stdout, "(默认)") ?? defaultLineValue(result.stdout);
	return parseRegQueryValue(result.stdout, name);
}

/** `/ve` 的输出里值名是 `(默认)`，有的系统语言版本会写成 `(Default)`，最后按「只有一个值」兜底。 */
function defaultLineValue(stdout: string): string | null {
	const rows = stdout
		.split(/\r?\n/)
		.map((line) => /^\s{2,}(.+?)\s{2,}REG_[A-Z_]+\s{2,}(.*)$/.exec(line))
		.filter((m): m is RegExpExecArray => m !== null);
	if (rows.length !== 1) return null;
	return (rows[0][2] ?? "").trim();
}

export interface ReadStateOptions {
	runner: RegistryRunner;
	exePath: string;
	extensions: readonly string[];
	platform?: NodeJS.Platform;
	packaged?: boolean;
}

/** 读一遍真实状态（注册命令指向哪个 exe、哪些扩展名已登记、系统默认是不是我们）。 */
export async function readIntegrationState(options: ReadStateOptions): Promise<SystemIntegrationState> {
	const platform = options.platform ?? process.platform;
	const supported = platform === "win32";
	const exts = normalizeExtensions(options.extensions);
	const state: SystemIntegrationState = {
		supported,
		platform,
		packaged: options.packaged ?? true,
		exePath: options.exePath,
		registered: false,
		stale: false,
		registeredExe: null,
		browser: { progId: BROWSER_PROG_ID, registered: false, isDefault: false },
		files: exts.map((ext) => ({ ext, progId: fileProgId(ext), registered: false, isDefault: false })),
	};
	if (!supported) return state;

	const runner = options.runner;
	const [command, clientCommand, urlChoice, registeredValue, capabilities] = await Promise.all([
		queryValue(runner, `${CLASSES_KEY}\\${BROWSER_PROG_ID}\\shell\\open\\command`, null),
		queryValue(runner, `${BROWSER_CLIENT_KEY}\\shell\\open\\command`, null),
		queryValue(runner, `${URL_CHOICE_KEY}\\https\\UserChoice`, "ProgId"),
		queryValue(runner, REGISTERED_APPLICATIONS_KEY, INTEGRATION_APP_NAME),
		runner(["query", `HKCU\\${CAPABILITIES_KEY}`]),
	]);
	// 兼容老版本：当年只写了 ProgId command，或只写了 StartMenuInternet command。
	// 任一处有 command 就算已注册；stale 用第一处能解出来的 exe 跟当前 exe 比。
	const progIdExe = extractExeFromCommand(command);
	const clientExe = extractExeFromCommand(clientCommand);
	const browserExe = progIdExe ?? clientExe;
	const browserRegistered = command !== null || clientCommand !== null;
	state.registeredExe = browserExe;
	state.registered = browserRegistered || registeredValue !== null || capabilities.ok;
	state.stale = browserExe !== null && !samePath(browserExe, options.exePath);
	state.browser.registered = browserRegistered;
	// 注册了我们 ≠ 用户已经在系统里设为默认，后者只认 UserChoice。
	state.browser.isDefault = urlChoice === BROWSER_PROG_ID;

	const perFile = await Promise.all(
		exts.map(async (ext) => {
			const progId = fileProgId(ext);
			const [openWith, choice, cmd] = await Promise.all([
				queryValue(runner, `${CLASSES_KEY}\\${ext}\\OpenWithProgids`, progId),
				queryValue(runner, `${FILE_CHOICE_KEY}\\${ext}\\UserChoice`, "ProgId"),
				queryValue(runner, `${CLASSES_KEY}\\${progId}\\shell\\open\\command`, null),
			]);
			const exe = extractExeFromCommand(cmd);
			return {
				ext,
				progId,
				registered: openWith !== null && samePath(exe, options.exePath),
				isDefault: choice === progId,
			} satisfies FileAssociationState;
		}),
	);
	state.files = perFile;
	return state;
}

/** 便携版换了目录 / 升级换了安装位置时，把 ProgId 指向当前 exe（键已存在才刷新，且只重写用户勾过的类型）。 */
export async function refreshStaleRegistration(
	state: SystemIntegrationState,
	runner: RegistryRunner,
	options: { browser: boolean } = { browser: true },
): Promise<boolean> {
	if (!state.supported || !state.registered || !state.stale) return false;
	const exts = state.files.map((file) => file.ext);
	const actions = [
		...(options.browser ? browserRegistrationActions(state.exePath) : []),
		...(exts.length ? fileRegistrationActions(state.exePath, exts) : []),
	];
	if (!actions.length) return false;
	return (await applyRegistryActions(actions, runner)).ok;
}
