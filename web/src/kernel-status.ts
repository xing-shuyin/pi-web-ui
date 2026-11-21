/**
 * Web 端（浏览器版）的内核状态：只读。
 *
 * 为什么要有：装了系统服务之后，内核就独立于任何客户端了；用户在浏览器里也应该能确认
 * "我连的这个内核是常驻的、归谁托管、跑的哪一版"，而不是只能猜。
 *
 * 数据源只有一处：`GET /api/health` 的 `kernel` 块（`server/kernel-identity.ts` 产出）。
 * 这里只做**纯解析**：不碰 DOM、不发请求、不产出面向用户的汉字（文案一律走 i18n，见
 * `i18n-hardcoded-guard`）；请求与渲染在 `components/KernelStatusCard.tsx`。
 */
export type KernelTone = "supervised" | "standalone" | "unknown";

/** uptime 的结构化拆解：给人看的单位文案由调用方用 i18n 拼。 */
export type KernelUptime =
	| { unit: "minutes"; minutes: number }
	| { unit: "hours"; hours: number; minutes: number }
	| { unit: "days"; days: number; hours: number }
	| null;

export interface KernelStatusModel {
	tone: KernelTone;
	version?: string;
	/** 托管者：launchd / systemd / windows-watchdog。 */
	supervisor?: string;
	serviceName?: string;
	uptimeMs?: number;
	/** 安装形态：global-npm / packaged / source。 */
	installKind?: string;
	/** 内核要求的最低壳能力（浏览器不适用，留着给排障显示）。 */
	minShell?: number;
}

interface HealthLike {
	kernel?: {
		mode?: unknown;
		supervisor?: unknown;
		serviceName?: unknown;
		version?: unknown;
		installKind?: unknown;
		uptimeMs?: unknown;
		minShell?: unknown;
	};
}

/**
 * 解析 `/api/health` 的响应。老内核没有 `kernel` 块 → `unknown`，不报错也不当故障：
 * 用户只是看不到托管信息，功能一切正常。
 */
export function parseKernelStatus(body: unknown): KernelStatusModel {
	const health = body as HealthLike | null | undefined;
	const kernel = health?.kernel;
	if (!kernel || typeof kernel !== "object") return { tone: "unknown" };
	const supervisor = typeof kernel.supervisor === "string" && kernel.supervisor ? kernel.supervisor : undefined;
	return {
		tone: supervisor ? "supervised" : kernel.mode === "standalone" ? "standalone" : "unknown",
		...(typeof kernel.version === "string" ? { version: kernel.version } : {}),
		...(supervisor ? { supervisor } : {}),
		...(typeof kernel.serviceName === "string" && kernel.serviceName ? { serviceName: kernel.serviceName } : {}),
		...(typeof kernel.uptimeMs === "number" ? { uptimeMs: kernel.uptimeMs } : {}),
		...(typeof kernel.installKind === "string" ? { installKind: kernel.installKind } : {}),
		...(typeof kernel.minShell === "number" ? { minShell: kernel.minShell } : {}),
	};
}

/** uptime 拆成「单位 + 数字」，文案留给 i18n（`kernelUptimeMinutes` 等）。 */
export function splitKernelUptime(ms: number | undefined): KernelUptime {
	if (typeof ms !== "number" || ms <= 0) return null;
	const totalMinutes = Math.floor(ms / 60_000);
	if (totalMinutes < 1) return { unit: "minutes", minutes: 0 };
	if (totalMinutes < 60) return { unit: "minutes", minutes: totalMinutes };
	const hours = Math.floor(totalMinutes / 60);
	if (hours < 24) return { unit: "hours", hours, minutes: totalMinutes % 60 };
	return { unit: "days", days: Math.floor(hours / 24), hours: hours % 24 };
}
