import { describe, expect, it } from "vitest";
import {
	approvalSuppressionReason,
	checkDangerousToolCall,
	isApprovalPolicyEmpty,
	pluginApprovalCategory,
	unattendedApprovalTimeoutMs,
	type ApprovalPolicy,
} from "../../server/tool-approval.js";

function policy(allowAll: boolean, ids: string[] = []): ApprovalPolicy {
	return {
		allowAll,
		categories: new Map(ids.map((id) => [id, { id, label: id, labelEn: id }])),
	};
}

describe("高危操作识别与人机协同拦截 (Tool Approval / Human-in-the-Loop)", () => {
	const cwd = "/workspace/project";

	describe("bash 高危命令识别", () => {
		it("识别 rm -rf 危险删除命令", () => {
			const res = checkDangerousToolCall("bash", { command: "rm -rf /" }, cwd);
			expect(res.dangerous).toBe(true);
			expect(res.reason).toContain("rm -rf");

			const resStar = checkDangerousToolCall("bash", { command: "rm -rf *" }, cwd);
			expect(resStar.dangerous).toBe(true);

			const resTilde = checkDangerousToolCall("bash", { command: "rm -r ~" }, cwd);
			expect(resTilde.dangerous).toBe(true);
		});

		it("识别破坏性 Git 命令", () => {
			const resPush = checkDangerousToolCall("bash", { command: "git push origin main --force" }, cwd);
			expect(resPush.dangerous).toBe(true);
			expect(resPush.reason).toContain("Git");

			const resReset = checkDangerousToolCall("bash", { command: "git reset --hard HEAD~1" }, cwd);
			expect(resReset.dangerous).toBe(true);

			const resClean = checkDangerousToolCall("bash", { command: "git clean -fd" }, cwd);
			expect(resClean.dangerous).toBe(true);
		});

		it("识别磁盘格式化与系统破坏命令", () => {
			const resFormat = checkDangerousToolCall("bash", { command: "format C:" }, cwd);
			expect(resFormat.dangerous).toBe(true);

			const resMkfs = checkDangerousToolCall("bash", { command: "mkfs.ext4 /dev/sda1" }, cwd);
			expect(resMkfs.dangerous).toBe(true);

			const resChmod = checkDangerousToolCall("bash", { command: "chmod 777 -R /" }, cwd);
			expect(resChmod.dangerous).toBe(true);
		});

		it("安全命令不触发拦截", () => {
			const safe1 = checkDangerousToolCall("bash", { command: "git status" }, cwd);
			expect(safe1.dangerous).toBe(false);

			const safe2 = checkDangerousToolCall("bash", { command: "ls -la" }, cwd);
			expect(safe2.dangerous).toBe(false);

			const safe3 = checkDangerousToolCall("bash", { command: "npm test" }, cwd);
			expect(safe3.dangerous).toBe(false);
		});
	});

	describe("文件修改高危识别 (write/edit)", () => {
		it("识别修改敏感密钥与配置文件 (.env, ssh 密钥, shell 配置)", () => {
			const resEnv = checkDangerousToolCall("write", { path: ".env" }, cwd);
			expect(resEnv.dangerous).toBe(true);
			expect(resEnv.reason).toContain(".env");

			const resEnvProd = checkDangerousToolCall("edit", { path: "config/.env.production" }, cwd);
			expect(resEnvProd.dangerous).toBe(true);

			const resSsh = checkDangerousToolCall("write", { path: "/home/user/.ssh/id_rsa" }, cwd);
			expect(resSsh.dangerous).toBe(true);

			const resBashrc = checkDangerousToolCall("edit", { path: "/home/user/.bashrc" }, cwd);
			expect(resBashrc.dangerous).toBe(true);
		});

		it("识别越界修改工作区外部文件", () => {
			const resOutside = checkDangerousToolCall("write", { path: "../../external.txt" }, cwd);
			expect(resOutside.dangerous).toBe(true);
			expect(resOutside.reason).toContain("工作区外部");
		});

		it("允许工作区内部普通源文件修改", () => {
			const resCode = checkDangerousToolCall("write", { path: "src/index.ts" }, cwd);
			expect(resCode.dangerous).toBe(false);

			const resDoc = checkDangerousToolCall("edit", { path: "docs/readme.md" }, cwd);
			expect(resDoc.dangerous).toBe(false);
		});
	});

	describe("规则档位（「允许同类审批」的粒度）", () => {
		it("每条内置规则都带稳定档位 id", () => {
			const cases: Array<[string, unknown, string]> = [
				["bash", { command: "rm -rf /" }, "bash.rm-rf"],
				["bash", { command: "git reset --hard HEAD~1" }, "bash.git-destructive"],
				["bash", { command: "mkfs.ext4 /dev/sda1" }, "bash.disk"],
				["write", { path: ".env" }, "file.sensitive.env"],
				["write", { path: "/home/u/.ssh/id_rsa" }, "file.sensitive.ssh"],
				["edit", { path: "/home/u/.bashrc" }, "file.sensitive.shell"],
				["write", { path: "../../outside.txt" }, "file.outside-workspace"],
			];
			for (const [tool, params, id] of cases) {
				const res = checkDangerousToolCall(tool, params, cwd);
				expect(res.dangerous, `${tool} ${id}`).toBe(true);
				expect(res.category?.id, `${tool} ${id}`).toBe(id);
				expect(res.category?.label).toBeTruthy();
				expect(res.category?.labelEn).toBeTruthy();
			}
		});

		it("同一档位 id 稳定：同类规则命中同一个键（工作区外写入）", () => {
			const a = checkDangerousToolCall("write", { path: "../a.txt" }, cwd);
			const b = checkDangerousToolCall("edit", { path: "/tmp/b.txt" }, cwd);
			expect(a.category?.id).toBe(b.category?.id);
		});

		it("插件要求确认按插件分档", () => {
			const cat = pluginApprovalCategory("demo-plugin");
			expect(cat.id).toBe("plugin:demo-plugin");
			expect(cat.label).toContain("demo-plugin");
			expect(pluginApprovalCategory("other").id).not.toBe(cat.id);
		});
	});

	describe("三档放行判定（approvalSuppressionReason）", () => {
		it("全局开关关 → 一律放行（不看策略/档位）", () => {
			expect(approvalSuppressionReason(undefined, false)).toBe("disabled");
			expect(approvalSuppressionReason(policy(false, ["bash.rm-rf"]), false, "bash.git-destructive")).toBe("disabled");
		});

		it("本对话「全部允许」→ 任何档位都放行", () => {
			expect(approvalSuppressionReason(policy(true), true)).toBe("allow-all");
			expect(approvalSuppressionReason(policy(true), true, "bash.rm-rf")).toBe("allow-all");
		});

		it("只放行记住的同类，其他档位照常弹窗", () => {
			const p = policy(false, ["bash.rm-rf"]);
			expect(approvalSuppressionReason(p, true, "bash.rm-rf")).toBe("category");
			expect(approvalSuppressionReason(p, true, "bash.git-destructive")).toBeNull();
			expect(approvalSuppressionReason(p, true, undefined)).toBeNull();
		});

		it("空策略 / 未开开关时照常弹窗；空策略判定", () => {
			expect(approvalSuppressionReason(undefined, true, "bash.rm-rf")).toBeNull();
			expect(approvalSuppressionReason(policy(false), true, "bash.rm-rf")).toBeNull();
			expect(isApprovalPolicyEmpty(undefined)).toBe(true);
			expect(isApprovalPolicyEmpty(policy(false))).toBe(true);
			expect(isApprovalPolicyEmpty(policy(true))).toBe(false);
			expect(isApprovalPolicyEmpty(policy(false, ["bash.rm-rf"]))).toBe(false);
		});
	});

	describe("高危命中清单透传 (hits, issue #566)", () => {
		it("checkDangerousToolCall 返回详细命中清单 hits[]", () => {
			const cmd = "cd /project && rm -rf ./data && git reset --hard";
			const res = checkDangerousToolCall("bash", { command: cmd }, cwd);
			expect(res.dangerous).toBe(true);
			expect(res.hits).toBeDefined();
			expect(res.hits!.length).toBeGreaterThanOrEqual(2);
			expect(res.hits![0].field).toBe("command");
			expect(res.hits![0].text).toBeTruthy();
			expect(res.hits![0].index).toBeGreaterThanOrEqual(0);
			expect(res.hits![0].length).toBeGreaterThan(0);
		});

		it("安全命令返回 empty/undefined hits", () => {
			const res = checkDangerousToolCall("bash", { command: "ls -la" }, cwd);
			expect(res.dangerous).toBe(false);
			expect(res.hits).toBeUndefined();
		});
	});
});

describe("unattendedApprovalTimeoutMs（无人值守审批超时）", () => {
	it("普通会话返回 null —— 有真人看着就不自动拒绝", () => {
		expect(unattendedApprovalTimeoutMs("client-abc")).toBeNull();
		expect(unattendedApprovalTimeoutMs("device-xyz")).toBeNull();
	});

	it("伪客户端（plugin:/scheduler:/canvas:）默认 120s", () => {
		for (const id of ["plugin:qq:default", "scheduler:t1", "canvas:main", "canvas-3"]) {
			expect(unattendedApprovalTimeoutMs(id, undefined)).toBe(120_000);
		}
	});

	it("env 可覆盖，非法值回落默认，上限 1h", () => {
		expect(unattendedApprovalTimeoutMs("plugin:qq:default", "30")).toBe(30_000);
		expect(unattendedApprovalTimeoutMs("plugin:qq:default", "abc")).toBe(120_000);
		expect(unattendedApprovalTimeoutMs("plugin:qq:default", "0")).toBe(120_000);
		expect(unattendedApprovalTimeoutMs("plugin:qq:default", "999999")).toBe(3_600_000);
	});
});
