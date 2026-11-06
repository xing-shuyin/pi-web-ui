import { describe, expect, it } from "vitest";
import {
	approvalSuppressionReason,
	isWideScopeOrRootOperation,
	type ApprovalPolicy,
} from "../../server/tool-approval.js";

describe("审批特权边界收敛与超宽操作熔断 (Issue #722)", () => {
	function policyWithCategory(categoryId: string): ApprovalPolicy {
		return {
			allowAll: false,
			categories: new Map([[categoryId, { id: categoryId, label: categoryId, labelEn: categoryId }]]),
		};
	}

	describe("isWideScopeOrRootOperation 判定", () => {
		it("识别针对根目录、家目录、父目录与通配符的大范围删除", () => {
			expect(isWideScopeOrRootOperation("bash", { command: "rm -rf /" })).toBe(true);
			expect(isWideScopeOrRootOperation("bash", { command: "rm -rf ~" })).toBe(true);
			expect(isWideScopeOrRootOperation("bash", { command: "rm -rf *" })).toBe(true);
			expect(isWideScopeOrRootOperation("bash", { command: "rm -rf .." })).toBe(true);
			expect(isWideScopeOrRootOperation("bash", { command: "rm -r -f /" })).toBe(true);
			expect(isWideScopeOrRootOperation("bash", { command: "rm --recursive --force C:\\" })).toBe(true);
		});

		it("普通相对子目录的删除不属于全局根操作", () => {
			expect(isWideScopeOrRootOperation("bash", { command: "rm -rf ./build" })).toBe(false);
			expect(isWideScopeOrRootOperation("bash", { command: "rm -rf dist" })).toBe(false);
			expect(isWideScopeOrRootOperation("bash", { command: "rm -rf node_modules/.cache" })).toBe(false);
		});

		it("识别磁盘格式化与系统目录重定向写入", () => {
			expect(isWideScopeOrRootOperation("bash", { command: "format C:" })).toBe(true);
			expect(isWideScopeOrRootOperation("bash", { command: "mkfs.ext4 /dev/sda1" })).toBe(true);
			expect(isWideScopeOrRootOperation("bash", { command: "echo bad > /etc/hosts" })).toBe(true);
			expect(isWideScopeOrRootOperation("bash", { command: "chmod 777 -R /" })).toBe(true);
		});

		it("识别敏感凭据与系统关键文件写入", () => {
			expect(isWideScopeOrRootOperation("write", { path: "/etc/passwd" })).toBe(true);
			expect(isWideScopeOrRootOperation("edit", { path: "~/.ssh/id_rsa" })).toBe(true);
			expect(isWideScopeOrRootOperation("patch", { path: "C:\\Windows\\system32\\evil.dll" })).toBe(true);
			expect(isWideScopeOrRootOperation("write", { path: "src/index.ts" })).toBe(false);
		});
	});

	describe("approvalSuppressionReason 边界熔断", () => {
		const rmRfPolicy = policyWithCategory("bash.rm-rf");

		it("已记住同类时，局部子目录的同类删除允许放行", () => {
			const res = approvalSuppressionReason(rmRfPolicy, true, "bash.rm-rf", "bash", { command: "rm -rf ./dist" });
			expect(res).toBe("category");
		});

		it("已记住同类时，一旦执行全盘/根目录/家目录删除，同类记忆强制熔断并要求弹窗", () => {
			const rootRes = approvalSuppressionReason(rmRfPolicy, true, "bash.rm-rf", "bash", { command: "rm -rf /" });
			expect(rootRes).toBeNull();

			const homeRes = approvalSuppressionReason(rmRfPolicy, true, "bash.rm-rf", "bash", { command: "rm -rf ~" });
			expect(homeRes).toBeNull();

			const starRes = approvalSuppressionReason(rmRfPolicy, true, "bash.rm-rf", "bash", { command: "rm -rf *" });
			expect(starRes).toBeNull();
		});

		it("显式选择本对话「全部允许」(allowAll) 时，根操作正常放行", () => {
			const allowAllPolicy: ApprovalPolicy = {
				allowAll: true,
				categories: new Map(),
			};

			const res = approvalSuppressionReason(allowAllPolicy, true, "bash.rm-rf", "bash", { command: "rm -rf /" });
			expect(res).toBe("allow-all");
		});

		it("全局开关关闭时，直接放行", () => {
			const res = approvalSuppressionReason(undefined, false, "bash.rm-rf", "bash", { command: "rm -rf /" });
			expect(res).toBe("disabled");
		});
	});
});
