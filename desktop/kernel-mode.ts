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
		lock?: unknown;
	};
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
	/** 不可达时的原因（展示给用户，不要吞掉）。 */
	error?: string;
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
	return url.trim().replace(/\/+$/, "");
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
		};
	} catch (error) {
		const message = (error as Error)?.name === "AbortError" ? "探测超时" : ((error as Error)?.message ?? "连接失败");
		return { reachable: false, error: message };
	} finally {
		clearTimeout(timer);
	}
}

export type KernelMode = "external" | "local";

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

/** 面板要展示的内核状态（也是 `pi-browser:state` 里的 `kernel` 字段）。 */
export function toKernelState(input: {
	decision: KernelDecision;
	url: string;
	probe: KernelProbeResult | null;
}): BrowserKernelState {
	const { decision, url, probe } = input;
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
		...(probe?.error ? { error: probe.error } : {}),
	};
}
