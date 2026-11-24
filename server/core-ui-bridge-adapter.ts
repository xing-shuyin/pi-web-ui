import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import type {
	UiBridgePort,
	UiCliInstallResult,
	UiCliProbe,
	UiDialogSurface,
	UiOverlaySurface,
} from "../packages/keel/src/contracts/ui-bridge.js";
import { ENGINE_CATALOG } from "../packages/keel/src/engine-catalog.js";
import { runProcess } from "./run-process.js";

/** 宿主 UI 上下文里内核真正用到的那两张表（`WebUIContext` 的实现就是内核那两份）。 */
export interface CoreUiBridgeTables {
	readonly dialogs: UiDialogSurface;
	readonly overlays: UiOverlaySurface;
}

export interface CoreUiBridgeSinks {
	/** 这个客户端的 UI 上下文（`server/webui-context.ts` 的 `WebUIContext`）。 */
	webUi: CoreUiBridgeTables;
	/** pi 的配置目录（`auth.json` / `models.json` 在这；`npm i -g` 前先建出来）。 */
	agentDir?: string;
	/** 有可用模型 = 已配置（宿主模型运行时的可用快照长度 > 0）。 */
	hasAvailableModels?(): boolean;
	/** PATH 上有没有 pi（注入宿主自己的判定；缺省用本文件里的 PATH 探测）。 */
	isCliInstalled?(): boolean;
	/** 装完之后失效宿主自己的探针缓存（缓存是宿主的账）。 */
	invalidateProbe?(): void;
	/** 跑安装进程（测试注入；缺省 `runProcess` + Windows `cmd.exe` 包装）。 */
	runInstall?(): Promise<UiCliInstallResult>;
}

/** 包名单源在 kernel 的引擎目录（安装命令/包名只在那里写一次）。 */
const PI_PACKAGE = ENGINE_CATALOG.pi.packageName;
const INSTALL_TIMEOUT_MS = 180_000;
/** 探针缓存 TTL（与老实现同口径：配置 2s / 安装 10s，都是「别每个快照都读盘」。） */
const CONFIGURED_TTL_MS = 2_000;
const INSTALLED_TTL_MS = 10_000;

/** `pi` / `pi.cmd` / `pi.exe` 在不在 PATH 上（便携版恒为已安装）。 */
function piCliOnPath(): boolean {
	if (process.env.PI_PORTABLE === "1") return true;
	for (const dir of (process.env.PATH ?? "").split(delimiter)) {
		if (!dir) continue;
		if (existsSync(join(dir, "pi"))) return true;
		if (process.platform === "win32" && (existsSync(join(dir, "pi.cmd")) || existsSync(join(dir, "pi.exe")))) {
			return true;
		}
	}
	return false;
}

/** `auth.json` / `models.json` 里有内容 = 已配置（与老实现同口径，只读文件头一层）。 */
function hasProviderCredentials(agentDir: string | undefined): boolean {
	if (!agentDir) return false;
	for (const [file, key] of [
		["auth.json", undefined],
		["models.json", "providers"],
	] as const) {
		try {
			const path = join(agentDir, file);
			if (!existsSync(path)) continue;
			const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
			const target = key ? (parsed?.[key] as Record<string, unknown> | undefined) : parsed;
			if (target && typeof target === "object" && Object.keys(target).length > 0) return true;
		} catch {
			// 读不动就当没配置：这条只影响引导条，不能把设置页炸掉。
		}
	}
	return false;
}

async function defaultInstall(agentDir: string | undefined): Promise<UiCliInstallResult> {
	if (agentDir) mkdirSync(agentDir, { recursive: true });
	const result = await runProcess({
		cmd: "npm",
		args: ["i", "-g", PI_PACKAGE],
		timeoutMs: INSTALL_TIMEOUT_MS,
		// Windows 上 npm 是 .cmd 包装器，必须经 cmd.exe /d /s /c 起（`run-process` 的单源句式）。
		windowsShell: true,
	});
	const output = `${result.stdout}${result.stderr}` || (result.spawnError ?? "");
	return { ok: result.code === 0, code: result.code, output };
}

/**
 * 宿主侧 `UiBridgePort` 的适配器。
 *
 * 它只做三件事，别的一件事都不做：
 * 1. **把内核的两张表递回去**（`dialogs` / `overlays`）：挂起表的实现在内核，宿主 `WebUIContext` 用的就是它们，
 *    所以扩展开出来的 dialog、浏览器回包、内核的 `resolveDialog` 走的是同一份表；
 * 2. **装 pi CLI**：`ENGINE_CATALOG.pi.installCommand`（Windows `cmd.exe` 包装由 `runProcess` 单源），
 *    装完让宿主的探针缓存失效；
 * 3. **探针真值**：`env.piConfigured` / `env.piAgentInstalled` 是**宿主环境**的事实（可用模型 / `auth.json` /
 *    PATH），内核不读盘也不看 PATH —— core 模式此前把这两个硬编码成 `false`，引导条永远亮着。
 *
 * `isPiConfigured` / `isPiCliInstalled` 的老实现在 `server/agent-service.ts` 上是 `private static`
 * （2s / 10s 两级缓存 + `PI_PORTABLE` 恒真），这里按同一口径实现；两处口径要合一时，
 * 把老那两个挪成 public 再让这里注入（`sinks.isCliInstalled` / `sinks.hasAvailableModels` 就是给那天留的）。
 */
export function createCoreUiBridge(sinks: CoreUiBridgeSinks): UiBridgePort {
	let configuredCache: { at: number; value: boolean } | null = null;
	let installedCache: { at: number; value: boolean } | null = null;

	const probe = (): UiCliProbe => {
		const now = Date.now();
		if (!configuredCache || now - configuredCache.at >= CONFIGURED_TTL_MS) {
			const value = (sinks.hasAvailableModels?.() ?? false) || hasProviderCredentials(sinks.agentDir);
			configuredCache = { at: now, value };
		}
		if (!installedCache || now - installedCache.at >= INSTALLED_TTL_MS) {
			const value = sinks.isCliInstalled?.() ?? piCliOnPath();
			installedCache = { at: now, value };
		}
		return { piConfigured: configuredCache.value, piAgentInstalled: installedCache.value };
	};

	return {
		dialogs: sinks.webUi.dialogs,
		overlays: sinks.webUi.overlays,
		async installCli(): Promise<UiCliInstallResult> {
			try {
				return await (sinks.runInstall?.() ?? defaultInstall(sinks.agentDir));
			} finally {
				// 不管成没成都要重探：失败也可能已经把 bin 落到 PATH 上（半装上）。
				installedCache = null;
				configuredCache = null;
				sinks.invalidateProbe?.();
			}
		},
		probe,
	};
}

export interface CoreUiBridgesOptions extends Omit<CoreUiBridgeSinks, "webUi"> {}

/**
 * 每客户端一份的 UI 桥（**id 表必须按客户端隔离**：`p-1` 在两个客户端里是两条不同的调用）。
 *
 * 宿主的用法：`uiBridge: (clientId, send) => uiBridges.portOf(clientId, webUiOf(clientId, send))`
 * （`webUiOf` 返回那个客户端的 `WebUIContext`；没有 UI 上下文的客户端传 `WebUIContext.headless()` 即可）。
 */
export class CoreUiBridges {
	private readonly ports = new Map<string, UiBridgePort>();

	constructor(private readonly options: CoreUiBridgesOptions) {}

	portOf(clientId: string, tables: CoreUiBridgeTables): UiBridgePort {
		const existing = this.ports.get(clientId);
		if (existing) return existing;
		const created = createCoreUiBridge({ ...this.options, webUi: tables });
		this.ports.set(clientId, created);
		return created;
	}

	/** 客户端断开：只丢引用（挂起表的清理由内核 `dispose()` 做，它才知道哪些 Promise 在等）。 */
	forget(clientId: string): void {
		this.ports.delete(clientId);
	}

	size(): number {
		return this.ports.size;
	}
}
