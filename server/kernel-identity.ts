/**
 * 内核身份的单一推导点（细则见 `docs/architecture-kernel.md`）。
 *
 * "内核" = 唯一的 pi-web-ui 服务进程；桌面壳 / 浏览器 / 手机都只是它的客户端。
 * 本模块只做**纯推导**（不读环境、不写文件、不含时钟以外的副作用），方便单测与多点复用：
 * - `classifyKernelInstall()`：这份内核是从哪装出来的（全局 npm / 打包壳 / 源码）
 * - `buildKernelInfo()`：交给客户端看的公开快照（不含 pid、不含本机路径）
 *
 * 为什么必须有单源：客户端要判断"关掉桌面壳之后这个内核还在不在、归谁托管、版本对不对"，
 * 而这些事实只有内核自己知道；让客户端各算一遍必然分叉（历史上就是两套数据目录 + 两套更新链）。
 */
import type { KernelInstallKind, KernelPublicInfo, ServiceSupervisor } from "./protocol.js";

/**
 * 从包根路径推导安装形态。只认结构事实，不看环境变量：
 * - 出现在 `app.asar` 内 → 随桌面安装包发布（`packaged`）
 * - 末两段是 `node_modules/pi-web-ui` → npm 包（`global-npm`；本地依赖树同理，客户端只需知道"不是壳里的"）
 * - 其余（源码仓库直跑、`dist/` 构建产物）→ `source`
 */
export function classifyKernelInstall(packageRoot: string): KernelInstallKind {
	const normalized = packageRoot.replace(/\\/g, "/").replace(/\/+$/, "");
	if (/app\.asar(\.unpacked)?(\/|$)/.test(normalized)) return "packaged";
	if (/(^|\/)node_modules\/pi-web-ui$/.test(normalized)) return "global-npm";
	return "source";
}

export interface KernelInfoInput {
	version: string;
	packageRoot: string;
	/** 内核自己的协议版本（`PROTOCOL_VERSION`）。由调用方传入，保持本模块纯推导。 */
	protocol: number;
	startedAt: number;
	now: number;
	supervisor: ServiceSupervisor | null;
	serviceName: string | null;
	lock: "held" | "disabled";
}

/**
 * 内核要求的最低壳能力版本（与 `desktop/runtime-config.ts` 的 `SHELL_CAPABILITY_VERSION` 对表）。
 * `/api/health.kernel.minShell` 高于客户端的值 → 客户端提示"先更新桌面应用"，而不是白屏或协议错乱。
 * 改这里等同于提高内核侧兼容线，要跟文档一起走。
 */
export const KERNEL_MIN_SHELL = 1;

/**
 * 公开快照。刻意不含 pid / 数据目录 / node 路径：
 * `/api/health` 是免鉴权端点（page-picker 扩展靠它探测"这是不是 pi-web-ui"），
 * 把本机路径暴露给公网绑定场景是没必要的风险。要路径的排障走日志与 `pi-web-ui server status`。
 */
export function buildKernelInfo(input: KernelInfoInput): KernelPublicInfo {
	return {
		mode: input.supervisor ? "service" : "standalone",
		supervisor: input.supervisor,
		serviceName: input.serviceName,
		version: input.version,
		installKind: classifyKernelInstall(input.packageRoot),
		startedAt: input.startedAt,
		uptimeMs: Math.max(0, Math.floor(input.now - input.startedAt)),
		protocol: input.protocol,
		minShell: KERNEL_MIN_SHELL,
		lock: input.lock,
	};
}

/** 面向用户的中文描述（日志/横幅/设置面板共用一套措辞）。 */
export function describeKernelInstall(kind: KernelInstallKind): string {
	switch (kind) {
		case "global-npm":
			return "全局 npm 包";
		case "packaged":
			return "桌面安装包内置";
		default:
			return "源码";
	}
}
