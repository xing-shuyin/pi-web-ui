/**
 * 桌面壳的内核判定（细则见 `docs/architecture-kernel.md`）。
 *
 * 目标形态：**内核永远是独立进程**（全局 npm 包 + 系统服务托管），桌面壳只是客户端。
 * 所以壳启动时先问"有没有一个活着的内核"，有就只连、不再拉起自己那份；
 * 没有才回退本地 sidecar。这条判据必须集中在这里，不能在 main.ts 里散着写 if。
 *
 * 本模块**不 import electron**：纯函数 + 可注入 fetch，方便单测（tests/unit/desktop-kernel-mode.test.ts）。
 */
import type { BrowserKernelState, KernelInstallKind } from "../browser/contracts.js";
import type { ServiceInstallState } from "./kernel-env.js";
import { compareKernelCompat, describeKernelCompat } from "./kernel-compat.js";
import { KERNEL_SERVICE_FIRST, SHELL_CAPABILITY_VERSION } from "./runtime-config.js";

export { describeKernelState, formatUptime } from "../browser/kernel-view.js";

/** `/api/health` 里我们关心的部分（其余字段忽略，避免与协议版本强绑）。 */
export interface HealthProbeBody {
	ok?: unknown;
	piVersion?: unknown;
	kernel?: {
		mode?: unknown;
		supervisor?: unknown;
		serviceName?: unknown;
		version?: unknown;
		installKind?: unknown;
		uptimeMs?: unknown;
		minShell?: unknown;
		protocol?: unknown;
		lock?: unknown;
	};
	/** 界面资源是否齐全：内核活着 ≠ 能提供界面（缺 web/dist/index.html 时只能回诊断页）。 */
	web?: { ok?: unknown; missing?: unknown };
}

export interface KernelProbeResult {
	reachable: boolean;
	version?: string;
	installKind?: KernelInstallKind;
	supervisor?: string | null;
	serviceName?: string | null;
	uptimeMs?: number;
	/** 内核要求的最低壳能力版本（高过本壳就提示先更新壳）。 */
	minShell?: number;
	/** 内核自己上报的协议版本（与壳构建期锁定的值比对，不等就提示升级全局包）。 */
	protocol?: number;
	/** 不可达时的原因（展示给用户，不要吞掉）。 */
	error?: string;
	/** 内核自己上报的界面资源状态（`/api/health.web`）；老内核不报 → undefined（当作可用）。 */
	webBuild?: "ok" | "missing";
}

export type FetchLike = (
	url: string,
	init?: { signal?: AbortSignal },
) => Promise<{
	ok: boolean;
	status?: number;
	json: () => Promise<unknown>;
}>;

export const KERNEL_PROBE_TIMEOUT_MS = 1500;

function normalizeBaseUrl(url: string): string {
	const trimmed = url.trim();
	try {
		// 按 origin 归一：壳里的 agentUrl 常带尾斜杠（`http://127.0.0.1:8787/`），直接比字符串会误判。
		return new URL(trimmed).origin;
	} catch {
		return trimmed.replace(/\/+$/, "");
	}
}

function isInstallKind(value: unknown): value is KernelInstallKind {
	return value === "global-npm" || value === "packaged" || value === "source";
}

/**
 * 探测某个地址上是不是一个活着的 pi-web-ui 内核。
 * 判据与 page-picker 扩展一致：`/api/health` 返回 `ok: true`（免鉴权端点）。
 * 超时/网络错误一律 `reachable: false` 并带回原因 —— 壳要能告诉用户"配置的内核没起来"。
 */
export async function probeKernel(
	url: string,
	options: { timeoutMs?: number; fetchImpl?: FetchLike } = {},
): Promise<KernelProbeResult> {
	const base = normalizeBaseUrl(url);
	if (!base) return { reachable: false, error: "未配置内核地址" };
	const fetchImpl: FetchLike = options.fetchImpl ?? ((target, init) => fetch(target, init));
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? KERNEL_PROBE_TIMEOUT_MS);
	try {
		const response = await fetchImpl(`${base}/api/health`, { signal: controller.signal });
		if (!response.ok) return { reachable: false, error: `HTTP ${response.status ?? "错误"}` };
		const body = (await response.json()) as HealthProbeBody;
		if (body?.ok !== true) return { reachable: false, error: "响应不是 pi-web-ui 内核" };
		const kernel = (body.kernel ?? {}) as NonNullable<HealthProbeBody["kernel"]>;
		return {
			reachable: true,
			version: typeof kernel.version === "string" ? kernel.version : undefined,
			installKind: isInstallKind(kernel.installKind) ? kernel.installKind : undefined,
			supervisor: typeof kernel.supervisor === "string" ? kernel.supervisor : null,
			serviceName: typeof kernel.serviceName === "string" ? kernel.serviceName : null,
			uptimeMs: typeof kernel.uptimeMs === "number" ? kernel.uptimeMs : undefined,
			minShell: typeof kernel.minShell === "number" ? kernel.minShell : undefined,
			protocol: typeof kernel.protocol === "number" ? kernel.protocol : undefined,
			// 只有内核明确说 `ok:false` 才算缺：老内核没这个字段，不能当成坏安装。
			...(typeof body.web?.ok === "boolean" ? { webBuild: body.web.ok ? "ok" : "missing" } : {}),
		};
	} catch (error) {
		const message = (error as Error)?.name === "AbortError" ? "探测超时" : ((error as Error)?.message ?? "连接失败");
		return { reachable: false, error: message };
	} finally {
		clearTimeout(timer);
	}
}

export type KernelMode = "external" | "local";

/**
 * 两个地址是不是同一个内核。
 * 必须按 origin 比：壳里的 agentUrl 常常带尾斜杠（`http://127.0.0.1:8787/`），
 * 字符串直接比会把"自己的 sidecar"误判成外部内核 —— 于是重启按钮消失、点了也重启错对象。
 */
export function isSameKernel(a: string, b: string): boolean {
	return normalizeBaseUrl(a) === normalizeBaseUrl(b);
}

export interface KernelDecision {
	mode: KernelMode;
	/** 为什么这么判（日志/面板提示用，便于用户理解为什么壳又拉了一份内核）。 */
	reason: "external-reachable" | "no-external-configured" | "external-unreachable";
}

/**
 * 是否复用外部内核。
 * - 配置了地址且可达 → external（**不 spawn**，这是"关掉壳内核还在跑"的关键）
 * - 没配置 → local（首次使用/单机自带内核的既有行为）
 * - 配置了但不可达 → local（回退本地，同时把不可达原因透给用户；不能白屏）
 */
export function decideKernelMode(input: {
	externalUrl?: string | null;
	probe: KernelProbeResult | null;
}): KernelDecision {
	const configured = (input.externalUrl ?? "").trim();
	if (!configured) return { mode: "local", reason: "no-external-configured" };
	if (input.probe?.reachable) return { mode: "external", reason: "external-reachable" };
	return { mode: "local", reason: "external-unreachable" };
}

/**
 * 壳的内核生命周期策略：打包版默认「后台服务优先」（壳只做客户端，不再自己拉 sidecar）。
 * 开发/冒烟默认关（保持本地 sidecar 的调试手感），`PI_DESKTOP_KERNEL_SERVICE_FIRST` 可双向覆盖。
 */
export function resolveKernelServiceFirst(input: { packaged: boolean; env?: NodeJS.ProcessEnv }): boolean {
	const raw = (input.env ?? process.env).PI_DESKTOP_KERNEL_SERVICE_FIRST?.trim().toLowerCase();
	if (raw === "0" || raw === "false" || raw === "no") return false;
	if (raw === "1" || raw === "true" || raw === "yes") return true;
	return input.packaged && KERNEL_SERVICE_FIRST;
}

/** 启动前壳手上握着的全部事实（都是探测结果，不含判断）。 */
export interface KernelBootFacts {
	/** 设置里配的 Agent 地址（可能是别人机器上的内核）。 */
	configuredUrl: string | null;
	configuredProbe: KernelProbeResult | null;
	/** 数据目录锁里那个活内核（本机服务 / 上一次运行留下的）。 */
	adoptedUrl: string | null;
	/** 默认端口上已经有一个可达内核（同一个或别的数据目录）。 */
	defaultPortUrl: string | null;
	serviceFirst: boolean;
	platform: NodeJS.Platform;
	serviceInstalled: ServiceInstallState;
	/** 磁盘上有没有「全局 npm 包」那份内核。 */
	globalKernelAvailable: boolean;
	node: { found: boolean; ok: boolean };
	/** 包内自带 / userData 运行时能不能跑起来（离线活路）。 */
	ephemeralKernelAvailable: boolean;
}

/**
 * 一次启动的结论。**壳要不要自己拉进程**只由这里决定（`main.ts` 不许另写 if）。
 *
 * - `connect`：已经有一个活内核，只连不拉（关掉壳它继续跑的前提）
 * - `provision-service`：本机有全局包内核但还没被系统托管 → 交给 `server install/start`，壳不拉
 * - `install-kernel` / `install-node`：连内核都没有 → 把「安装」作为可执行的下一步交给界面
 * - `ephemeral-kernel`：只能临时内核（开发/冒烟、Linux 无 TTY、离线只有包内自带那份）
 */
export type KernelBootPlan =
	| { kind: "connect"; url: string; reason: "configured" | "adopted" | "default-port" }
	| { kind: "provision-service"; action: "start" | "install"; reason: "service-installed" | "global-kernel" }
	| { kind: "install-kernel" }
	| { kind: "install-node"; reason: "node-missing" | "node-too-old" }
	| { kind: "ephemeral-kernel"; reason: "policy-off" | "needs-terminal" | "prerequisite-missing" };

/**
 * 启动决策（唯一出口）。顺序即语义：
 * 先找活内核（配置 → 数据目录锁 → 默认端口），再决定要不要把自己变成「后台服务」。
 * 服务优先的前提是**磁盘上有全局 npm 包**：否则服务会钉死在安装目录，应用一升级就失效。
 */
export function planKernelBoot(facts: KernelBootFacts): KernelBootPlan {
	const decision = decideKernelMode({ externalUrl: facts.configuredUrl ?? "", probe: facts.configuredProbe });
	if (decision.mode === "external" && facts.configuredUrl)
		return { kind: "connect", url: facts.configuredUrl, reason: "configured" };
	if (facts.adoptedUrl) return { kind: "connect", url: facts.adoptedUrl, reason: "adopted" };
	if (facts.defaultPortUrl) return { kind: "connect", url: facts.defaultPortUrl, reason: "default-port" };

	// 开发/冒烟/显式关闭策略：保持旧行为，壳自己拉 sidecar。
	if (!facts.serviceFirst) return { kind: "ephemeral-kernel", reason: "policy-off" };
	// Linux 的 systemd 系统单元要 root，GUI 里拿不到 TTY → 只能回落临时内核，装服务交给面板给命令。
	if (facts.platform === "linux") return { kind: "ephemeral-kernel", reason: "needs-terminal" };

	// 前置条件不满足：还有能跑的代码就先用临时内核，什么都跑不了才把安装交给界面。
	const fallback = (): KernelBootPlan => {
		if (facts.globalKernelAvailable || facts.ephemeralKernelAvailable)
			return { kind: "ephemeral-kernel", reason: "prerequisite-missing" };
		if (!facts.node.found) return { kind: "install-node", reason: "node-missing" };
		if (!facts.node.ok) return { kind: "install-node", reason: "node-too-old" };
		return { kind: "install-kernel" };
	};
	if (!facts.globalKernelAvailable || !facts.node.ok) return fallback();

	const installed = facts.serviceInstalled === "installed";
	return {
		kind: "provision-service",
		action: installed ? "start" : "install",
		reason: installed ? "service-installed" : "global-kernel",
	};
}

/** 面板要展示的内核状态（也是 `pi-browser:state` 里的 `kernel` 字段）。 */
export function toKernelState(input: {
	decision: KernelDecision;
	url: string;
	probe: KernelProbeResult | null;
}): BrowserKernelState {
	const { decision, url, probe } = input;
	// 兼容结论只在“真的连上了”时才有意义；探不到内核时算出来只会是误导。
	const verdict = probe?.reachable
		? compareKernelCompat({
				kernelProtocol: probe.protocol,
				kernelMinShell: probe.minShell,
				shellCapability: SHELL_CAPABILITY_VERSION,
			})
		: null;
	const compat = verdict ? { kind: verdict.kind, message: describeKernelCompat(verdict) } : null;
	return {
		mode: decision.mode,
		reason: decision.reason,
		url,
		reachable: probe?.reachable === true,
		...(probe?.version ? { version: probe.version } : {}),
		...(probe?.installKind ? { installKind: probe.installKind } : {}),
		supervisor: probe?.supervisor ?? null,
		...(probe?.serviceName ? { serviceName: probe.serviceName } : {}),
		...(typeof probe?.uptimeMs === "number" ? { uptimeMs: probe.uptimeMs } : {}),
		...(typeof probe?.minShell === "number" ? { minShell: probe.minShell } : {}),
		...(typeof probe?.protocol === "number" ? { protocol: probe.protocol } : {}),
		...(probe?.webBuild ? { webBuild: probe.webBuild } : {}),
		...(compat ? { compat } : {}),
		...(probe?.error ? { error: probe.error } : {}),
	};
}
