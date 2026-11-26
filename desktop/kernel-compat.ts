/**
 * 壳 ↔ 内核（全局 npm 包）的兼容判定（细则见 `docs/architecture-kernel.md` §9.1.2）。
 *
 * 纯壳包里内核是**另一个产品安装物**（`npm i -g pi-web-ui`），装完之后完全可能出现：
 * 壳是新的、全局包还是旧的（或反过来）。两边不能靠"应该一致"这种默契活着 ——
 * 各报各的版本，由这一处判定谁该升级，界面只负责把结论说出来。
 *
 * 两个方向不对称，这是关键：
 * - 内核要求的最低壳能力（`minShell`）高过本壳 → 只能升级**壳**（壳的 preload/IPC 不存在可热更的路径）；
 * - 内核协议比本壳旧 → 升级**全局包**（`npm i -g pi-web-ui@latest`，就是面板里的「升级内核」）。
 *
 * 纯函数，不 import electron，单测直接跑（`tests/unit/desktop-kernel-compat.test.ts`）。
 */
import { DESKTOP_EXPECTED_PROTOCOL, DESKTOP_KERNEL_MIN_SHELL } from "./protocol-expectation.js";

export type KernelCompatVerdict =
	/** 两边协议一致，且本壳满足内核的最低能力要求。 */
	| { kind: "ok" }
	/** 内核比壳旧（或壳比内核旧到读不懂）：升级全局包。 */
	| { kind: "upgrade-kernel"; kernelProtocol: number; shellProtocol: number }
	/** 内核要求更高的壳能力：只能升级壳。 */
	| { kind: "upgrade-shell"; kernelMinShell: number; shellCapability: number }
	/** 内核没报协议（老版本内核装在机器上）：按"升级全局包"处理，否则用户只会看到白屏。 */
	| { kind: "unknown-kernel"; detail: string };

export interface KernelCompatInput {
	/** 内核 `/api/health.kernel.protocol`；没报就是 undefined。 */
	kernelProtocol: number | undefined;
	/** 内核 `/api/health.kernel.minShell`。 */
	kernelMinShell: number | undefined;
	/** 本壳构建期锁定的协议版本（`desktop/protocol-expectation.ts`，构建时生成）。 */
	shellProtocol?: number;
	/** 本壳能力版本（`desktop/runtime-config.ts` 的 `SHELL_CAPABILITY_VERSION`）。 */
	shellCapability: number;
}

/**
 * 判定顺序（顺序本身就是语义，别调换）：
 * 1. 内核要的壳能力高过本壳 → 升级壳（再怎么升内核也救不了，壳的 IPC 是编译进去的）。
 * 2. 内核没报协议 → 老内核，升级全局包。
 * 3. 协议不相等 → 升级全局包（壳不能降级，也不能假装看懂新协议）。
 * 4. 其余 → ok。
 */
export function compareKernelCompat(input: KernelCompatInput): KernelCompatVerdict {
	const shellProtocol = input.shellProtocol ?? DESKTOP_EXPECTED_PROTOCOL;
	if (typeof input.kernelMinShell === "number" && input.kernelMinShell > input.shellCapability) {
		return { kind: "upgrade-shell", kernelMinShell: input.kernelMinShell, shellCapability: input.shellCapability };
	}
	if (typeof input.kernelProtocol !== "number" || !Number.isFinite(input.kernelProtocol)) {
		return { kind: "unknown-kernel", detail: "内核没有上报协议版本（大概率是旧版全局包）" };
	}
	if (input.kernelProtocol !== shellProtocol) {
		// 两个方向都归到「升级全局包」：壳的协议是构建期烘进去的常量，装好的壳无法就地改；
		// 而内核是可替换的（npm 一条命令），所以能动手的一侧永远是全局包。
		return { kind: "upgrade-kernel", kernelProtocol: input.kernelProtocol, shellProtocol };
	}
	return { kind: "ok" };
}

/** 内核侧的兼容下限（构建期从 `server/kernel-identity.ts` 抄来；读不到就 null）。 */
export function expectedKernelMinShell(): number | null {
	return DESKTOP_KERNEL_MIN_SHELL;
}

/** 一句话告诉用户该做什么（面板/顶栏共用；不在这里拼命令，命令由 `kernel-env.ts` 单源提供）。 */
export function describeKernelCompat(verdict: KernelCompatVerdict): string {
	switch (verdict.kind) {
		case "ok":
			return "";
		case "upgrade-kernel":
			return `内核协议 v${verdict.kernelProtocol} 与本壳 v${verdict.shellProtocol} 不一致：请升级全局包（npm i -g keel-agent@latest）`;
		case "upgrade-shell":
			return `内核要求桌面应用能力 ≥${verdict.kernelMinShell}（本壳 ${verdict.shellCapability}）：请先更新桌面应用`;
		case "unknown-kernel":
			return `${verdict.detail}：请升级全局包（npm i -g keel-agent@latest）`;
	}
}
