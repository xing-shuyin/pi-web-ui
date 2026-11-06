import { describe, expect, it } from "vitest";
import { TerminalManager } from "../../server/terminals.js";

const safeCwdOf = (workspaceRoot: string): ((raw: string) => string | null) => {
	const mgr = new TerminalManager(() => {}, workspaceRoot);
	return (mgr as unknown as { safeCwd(raw: string): string | null }).safeCwd.bind(mgr);
};

describe("safeCwd：远程 ssh:// 工作区（0.103 审计修复）", () => {
	it("远程 URI 与相对路径都挂到远程根下解析", () => {
		const safeCwd = safeCwdOf("ssh://root@dev:22/srv/app");
		expect(safeCwd("ssh://root@dev:22/srv/app/logs")).toBe("ssh://root@dev:22/srv/app/logs");
		expect(safeCwd("logs")).toBe("ssh://root@dev:22/srv/app/logs");
		expect(safeCwd("./logs")).toBe("ssh://root@dev:22/srv/app/logs");
		expect(safeCwd("")).toBe("ssh://root@dev:22/srv/app");
	});

	it("无端口 URI 规范化补全 22（spawnShell 的 URI 正则要求带端口）", () => {
		const safeCwd = safeCwdOf("ssh://root@dev/srv/app");
		expect(safeCwd("")).toBe("ssh://root@dev:22/srv/app");
		expect(safeCwd("ssh://root@dev/srv/app/sub")).toBe("ssh://root@dev:22/srv/app/sub");
	});

	it("跨主机/跨用户拒绝", () => {
		const safeCwd = safeCwdOf("ssh://root@dev:22/srv/app");
		expect(safeCwd("ssh://root@other:22/srv")).toBeNull();
		expect(safeCwd("ssh://adm@dev:22/srv")).toBeNull();
		expect(safeCwd("ssh://root@dev:2222/srv")).toBeNull();
	});

	it("同主机绝对 URI 也不能越出远程项目根", () => {
		const safeCwd = safeCwdOf("ssh://root@dev:22/srv/app");
		expect(safeCwd("ssh://root@dev:22/etc")).toBeNull();
		expect(safeCwd("ssh://root@dev:22/srv/app/../../etc")).toBeNull();
		expect(safeCwd("ssh://root@dev:22/srv/application")).toBeNull();
		expect(safeCwd("ssh://root@dev:22/srv/app/sub/..")).toBe("ssh://root@dev:22/srv/app");
	});

	it("相对路径越出远程根拒绝", () => {
		const safeCwd = safeCwdOf("ssh://root@dev:22/srv/app");
		expect(safeCwd("../../etc")).toBeNull();
		expect(safeCwd("..\\..\\etc")).toBeNull();
	});
});
