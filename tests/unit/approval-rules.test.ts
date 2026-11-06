import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	ApprovalRulesStore,
	DEFAULT_APPROVAL_RULES,
	checkBashCommandDanger,
	evaluateApprovalRules,
	extractRuleFieldValue,
	extractTargetPath,
	globToRegex,
	matchApprovalRule,
	matchApprovalRuleDetail,
	normalizeApprovalRule,
	type ApprovalRule,
} from "../../server/approval-rules.js";

describe("审批规则引擎纯函数与匹配逻辑 (Approval Rules Engine)", () => {
	it("maps legacy terminal rules without widening actions or preempting new denials", () => {
		const legacy: ApprovalRule = {
			id: "legacy",
			enabled: true,
			tools: ["terminal_input"],
			field: "params",
			match: "prefix",
			value: '{"terminalId":',
			action: "allow",
			label: "old",
		};
		const params = { action: "input", terminalId: "t1", data: "hello" };
		expect(matchApprovalRule(legacy, "terminal", params, "/project")).toBe(true);
		expect(matchApprovalRule(legacy, "terminal", { ...params, action: "key" }, "/project")).toBe(false);
		const deny: ApprovalRule = {
			...legacy,
			id: "new",
			tools: ["terminal"],
			match: "contains",
			value: '"action":"input"',
			action: "deny",
		};
		expect(evaluateApprovalRules([legacy, deny], "terminal", params, "/project").action).toBe("deny");
		expect(evaluateApprovalRules([legacy, { ...deny, action: "ask" }], "terminal", params, "/project").action).toBe(
			"ask",
		);
	});
	const cwd = "/workspace/project";

	describe("globToRegex 通配符转换", () => {
		it("单星号 * 匹配单路径段", () => {
			const re = globToRegex("*.txt");
			expect(re.test("file.txt")).toBe(true);
			expect(re.test("a/file.txt")).toBe(false);
		});

		it("双星号 ** 跨目录匹配", () => {
			const re = globToRegex("**/*.secret");
			expect(re.test("top.secret")).toBe(true);
			expect(re.test("sub/folder/file.secret")).toBe(true);
			expect(re.test("sub/folder/file.txt")).toBe(false);
		});

		it("正反斜杠统一归一化", () => {
			const re = globToRegex("src/**/*.ts");
			expect(re.test("src/components/A.ts")).toBe(true);
			expect(re.test("src\\components\\A.ts".replace(/\\/g, "/"))).toBe(true);
		});
	});

	describe("extractRuleFieldValue 参数提取", () => {
		it("提取 command", () => {
			expect(extractRuleFieldValue("command", "bash", { command: "rm -rf /" })).toBe("rm -rf /");
			expect(extractRuleFieldValue("command", "bash", {})).toBe("");
		});

		it("提取 path", () => {
			expect(extractRuleFieldValue("path", "write", { path: "src/index.ts" })).toBe("src/index.ts");
		});

		it("path 字段认三种写法：path / file_path / file（扩展实现如 pi-better-edit 的 edit 用 file）", () => {
			expect(extractTargetPath({ path: "a.ts" })).toBe("a.ts");
			expect(extractTargetPath({ file_path: "b.ts" })).toBe("b.ts");
			expect(extractTargetPath({ file: "c.ts" })).toBe("c.ts");
			expect(extractTargetPath({ path: "a.ts", file: "c.ts" })).toBe("a.ts");
			expect(extractTargetPath({ path: "  ", file: "c.ts" })).toBe("c.ts");
			expect(extractTargetPath({})).toBe("");
			expect(extractTargetPath(null)).toBe("");
			expect(extractTargetPath("nonsense")).toBe("");
			expect(extractTargetPath({ path: 42 })).toBe("");
			expect(extractRuleFieldValue("path", "edit", { file: "c.ts" })).toBe("c.ts");
		});

		it("按 path 匹配的规则对用 file 的扩展实现同样生效", () => {
			const rule: ApprovalRule = {
				id: "custom.env",
				enabled: true,
				tools: ["edit"],
				field: "path",
				match: "glob",
				value: "**/.env",
				action: "ask",
				label: "改 .env 先问",
			};
			expect(matchApprovalRule(rule, "edit", { path: "app/.env" }, cwd)).toBe(true);
			expect(matchApprovalRule(rule, "edit", { file: "app/.env" }, cwd)).toBe(true);
			expect(matchApprovalRule(rule, "edit", { file: "app/.env.local" }, cwd)).toBe(false);
		});

		it("提取 params 完整 JSON", () => {
			const json = extractRuleFieldValue("params", "custom", { a: 1, b: "test" });
			expect(json).toContain('"a":1');
			expect(json).toContain('"b":"test"');
		});
	});

	describe("matchApprovalRule 单规则匹配", () => {
		const ruleBashDeny: ApprovalRule = {
			id: "custom.docker-rm",
			enabled: true,
			tools: ["bash"],
			field: "command",
			match: "regex",
			value: "\\bdocker\\s+(rm|rmi)\\b",
			action: "deny",
			label: "禁止删除 Docker 容器与镜像",
		};

		it("正则匹配命令", () => {
			expect(matchApprovalRule(ruleBashDeny, "bash", { command: "docker rm -f c1" }, cwd)).toBe(true);
			expect(matchApprovalRule(ruleBashDeny, "bash", { command: "docker ps" }, cwd)).toBe(false);
		});

		it("工具不匹配时直接返回 false", () => {
			expect(matchApprovalRule(ruleBashDeny, "write", { command: "docker rm -f c1" }, cwd)).toBe(false);
		});

		it("停用规则不匹配", () => {
			const disabledRule = { ...ruleBashDeny, enabled: false };
			expect(matchApprovalRule(disabledRule, "bash", { command: "docker rm -f c1" }, cwd)).toBe(false);
		});

		it("前缀匹配与包含匹配", () => {
			const rulePrefix: ApprovalRule = {
				id: "custom.prod-path",
				enabled: true,
				tools: ["write", "edit"],
				field: "path",
				match: "prefix",
				value: "production/",
				action: "deny",
				label: "禁止修改生产配置",
			};
			expect(matchApprovalRule(rulePrefix, "write", { path: "production/config.json" }, cwd)).toBe(true);
			expect(matchApprovalRule(rulePrefix, "write", { path: "src/production/config.json" }, cwd)).toBe(false);

			const ruleContains: ApprovalRule = {
				id: "custom.token",
				enabled: true,
				tools: ["*"],
				field: "params",
				match: "contains",
				value: "PRIVATE_KEY",
				action: "deny",
				label: "禁止传递私钥",
			};
			expect(matchApprovalRule(ruleContains, "custom_tool", { token: "MY_PRIVATE_KEY_HERE" }, cwd)).toBe(true);
			expect(matchApprovalRule(ruleContains, "custom_tool", { token: "PUBLIC_KEY" }, cwd)).toBe(false);
		});

		it("工作区外越界写入匹配 (outside_workspace)", () => {
			const ruleWs: ApprovalRule = {
				id: "builtin.file.outside-workspace",
				enabled: true,
				tools: ["write", "edit"],
				field: "path",
				match: "outside_workspace",
				value: "",
				action: "ask",
				label: "工作区外写入",
			};
			expect(matchApprovalRule(ruleWs, "write", { path: "../../external.txt" }, cwd)).toBe(true);
			expect(matchApprovalRule(ruleWs, "write", { path: "src/index.ts" }, cwd)).toBe(false);
		});
	});

	describe("evaluateApprovalRules 多规则决策流", () => {
		it("白名单优先放行 (allow) 胜过后续 ask 规则", () => {
			const rules: ApprovalRule[] = [
				{
					id: "custom.allow-temp",
					enabled: true,
					tools: ["bash"],
					field: "command",
					match: "contains",
					value: "rm -rf /tmp/my-build",
					action: "allow",
					label: "允许清理指定临时目录",
				},
				...DEFAULT_APPROVAL_RULES,
			];

			const resAllowed = evaluateApprovalRules(rules, "bash", { command: "rm -rf /tmp/my-build" }, cwd);
			expect(resAllowed.action).toBe("allow");

			const resAsk = evaluateApprovalRules(rules, "bash", { command: "rm -rf /" }, cwd);
			expect(resAsk.action).toBe("ask");
			expect(resAsk.category?.id).toBe("bash.rm-rf");
		});

		it("直接拒绝 (deny) 规则生效", () => {
			const rules: ApprovalRule[] = [
				{
					id: "custom.deny-drop",
					enabled: true,
					tools: ["bash"],
					field: "command",
					match: "contains",
					value: "DROP DATABASE",
					action: "deny",
					label: "严禁删库",
					reason: "已检测到删库指令，被系统规则硬性阻断",
				},
			];

			const res = evaluateApprovalRules(rules, "bash", { command: "mysql -e 'DROP DATABASE prod;'" }, cwd);
			expect(res.action).toBe("deny");
			expect(res.reason).toContain("硬性阻断");
		});

		it("无匹配规则返回 none", () => {
			const res = evaluateApprovalRules([], "bash", { command: "echo hello" }, cwd);
			expect(res.action).toBe("none");
		});
	});

	describe("normalizeApprovalRule 数据校验", () => {
		it("过滤非法与空字段", () => {
			expect(normalizeApprovalRule(null)).toBeNull();
			expect(normalizeApprovalRule({})).toBeNull();
			expect(normalizeApprovalRule({ id: "", label: "test" })).toBeNull();
			expect(normalizeApprovalRule({ id: "valid", label: "" })).toBeNull();
		});

		it("捕获坏正则", () => {
			const badRegex = {
				id: "bad",
				label: "坏正则",
				tools: ["bash"],
				field: "command",
				match: "regex",
				value: "[unclosed",
				action: "ask",
			};
			expect(normalizeApprovalRule(badRegex)).toBeNull();
		});

		it("补齐并归一化缺省字段", () => {
			const good = normalizeApprovalRule({
				id: "ok",
				label: "合法规则",
				value: "echo",
			});
			expect(good).not.toBeNull();
			expect(good?.enabled).toBe(true);
			expect(good?.tools).toEqual(["*"]);
			expect(good?.action).toBe("ask");
			expect(good?.field).toBe("command");
			expect(good?.match).toBe("regex");
		});
	});
});

describe("ApprovalRulesStore 持久化库与播种机制", () => {
	let tmpDir: string;
	let storePath: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "rules-store-test-"));
		storePath = join(tmpDir, "approval-rules.json");
	});

	afterEach(() => {
		try {
			rmSync(tmpDir, { recursive: true, force: true });
		} catch {}
	});

	it("初次加载自动播种全部内置默认规则", () => {
		const store = new ApprovalRulesStore(storePath);
		const list = store.list();
		expect(list.length).toBe(DEFAULT_APPROVAL_RULES.length);
		const rmRf = list.find((r) => r.id === "builtin.bash.rm-rf");
		expect(rmRf).toBeDefined();
		expect(rmRf?.builtin).toBe(true);
	});

	it("添加、编辑与删除自定义规则", () => {
		const store = new ApprovalRulesStore(storePath);
		const err = store.upsert({
			id: "custom.test-rule",
			enabled: true,
			tools: ["bash"],
			field: "command",
			match: "contains",
			value: "danger-cmd",
			action: "deny",
			label: "测试自定义规则",
		});
		expect(err).toBeNull();

		let list = store.list();
		expect(list.find((r) => r.id === "custom.test-rule")).toBeDefined();

		store.upsert({
			id: "custom.test-rule",
			enabled: false,
			tools: ["bash"],
			field: "command",
			match: "contains",
			value: "danger-cmd-2",
			action: "allow",
			label: "测试修改",
		});
		list = store.list();
		const updated = list.find((r) => r.id === "custom.test-rule");
		expect(updated?.enabled).toBe(false);
		expect(updated?.value).toBe("danger-cmd-2");

		const removed = store.remove("custom.test-rule");
		expect(removed).toBe(true);
		list = store.list();
		expect(list.find((r) => r.id === "custom.test-rule")).toBeUndefined();
	});

	it("禁止直接删除内置规则（只允许禁用），支持恢复默认", () => {
		const store = new ApprovalRulesStore(storePath);
		const rmSuccess = store.remove("builtin.bash.rm-rf");
		expect(rmSuccess).toBe(false);

		store.upsert({
			...DEFAULT_APPROVAL_RULES[0],
			action: "allow",
			label: "已魔改",
		});
		let item = store.list().find((r) => r.id === "builtin.bash.rm-rf");
		expect(item?.action).toBe("allow");

		const resetOk = store.resetBuiltin("builtin.bash.rm-rf");
		expect(resetOk).toBe(true);
		item = store.list().find((r) => r.id === "builtin.bash.rm-rf");
		expect(item?.action).toBe("ask");
		expect(item?.label).toBe("递归/强制删除 (rm -rf)");
	});

	it("saveAll 批量重排", () => {
		const store = new ApprovalRulesStore(storePath);
		const list = store.list();
		const reversed = [...list].reverse();
		const err = store.saveAll(reversed);
		expect(err).toBeNull();
		const current = store.list();
		expect(current[0].id).toBe(reversed[0].id);
	});

	it("saveAll 不含内置规则的清单 → 内置规则被补种且追加队尾", () => {
		const store = new ApprovalRulesStore(storePath);
		const err = store.saveAll([
			{
				id: "custom.only-one",
				enabled: true,
				tools: ["bash"],
				field: "command",
				match: "contains",
				value: "danger-cmd",
				action: "deny",
				label: "唯一自定义规则",
			},
		]);
		expect(err).toBeNull();

		const list = store.list();
		for (const def of DEFAULT_APPROVAL_RULES) {
			expect(list.find((r) => r.id === def.id)).toBeDefined();
		}
		expect(list[0].id).toBe("custom.only-one");
		expect(list.length).toBe(1 + DEFAULT_APPROVAL_RULES.length);
		const last = list[list.length - 1];
		expect(last.builtin).toBe(true);
		expect(DEFAULT_APPROVAL_RULES.some((d) => d.id === last.id)).toBe(true);
	});

	it("saveAll 送来 builtin:false 的内置规则 → builtin 标记被强制保留", () => {
		const store = new ApprovalRulesStore(storePath);
		const err = store.saveAll([
			{
				id: "builtin.bash.rm-rf",
				enabled: true,
				tools: ["bash"],
				field: "command",
				match: "prefix",
				value: "rm -rf",
				action: "deny",
				label: "魔改内置",
				builtin: false,
			},
		]);
		expect(err).toBeNull();
		const item = store.list().find((r) => r.id === "builtin.bash.rm-rf");
		expect(item?.builtin).toBe(true);
		expect(store.remove("builtin.bash.rm-rf")).toBe(false);
	});
});

describe("matchApprovalRuleDetail & 命中清单 (issue #566)", () => {
	const cwd = "/workspace/project";

	it("regex 模式：返回精确的 index, length 与 text 命中区间", () => {
		const rule: ApprovalRule = {
			id: "test.rm",
			enabled: true,
			tools: ["bash"],
			field: "command",
			match: "regex",
			value: "rm\\s+-rf\\s+[^\\s;&|]+",
			action: "ask",
			label: "rm -rf 删除",
		};
		const cmd = "cd /srv && rm -rf ./dist && echo done";
		const detail = matchApprovalRuleDetail(rule, "bash", { command: cmd }, cwd);
		expect(detail).not.toBeNull();
		expect(detail?.index).toBe(11);
		expect(detail?.text).toBe("rm -rf ./dist");
		expect(detail?.length).toBe("rm -rf ./dist".length);
	});

	it("contains 模式：返回匹配字符串的起始下标与长度", () => {
		const rule: ApprovalRule = {
			id: "test.drop",
			enabled: true,
			tools: ["bash"],
			field: "command",
			match: "contains",
			value: "DROP DATABASE",
			action: "ask",
			label: "删库操作",
		};
		const cmd = "psql -c 'DROP DATABASE prod;'";
		const detail = matchApprovalRuleDetail(rule, "bash", { command: cmd }, cwd);
		expect(detail).not.toBeNull();
		expect(detail?.index).toBe(9);
		expect(detail?.text).toBe("DROP DATABASE");
		expect(detail?.length).toBe(13);
	});

	it("prefix 模式：从 0 开始命中", () => {
		const rule: ApprovalRule = {
			id: "test.sudo",
			enabled: true,
			tools: ["bash"],
			field: "command",
			match: "prefix",
			value: "sudo ",
			action: "ask",
			label: "提权命令",
		};
		const detail = matchApprovalRuleDetail(rule, "bash", { command: "sudo apt update" }, cwd);
		expect(detail).toEqual({
			index: 0,
			length: 5,
			text: "sudo ",
		});
	});

	it("不匹配时返回 null", () => {
		const rule: ApprovalRule = {
			id: "test.safe",
			enabled: true,
			tools: ["bash"],
			field: "command",
			match: "contains",
			value: "nuclear",
			action: "ask",
			label: "危险操作",
		};
		expect(matchApprovalRuleDetail(rule, "bash", { command: "ls -la" }, cwd)).toBeNull();
	});

	it("evaluateApprovalRules 收集完整命中清单 (hits[])，首条命中决定动作", () => {
		const r1: ApprovalRule = {
			id: "r1",
			enabled: true,
			tools: ["bash"],
			field: "command",
			match: "contains",
			value: "rm -rf",
			action: "ask",
			label: "规则1",
		};
		const r2: ApprovalRule = {
			id: "r2",
			enabled: true,
			tools: ["bash"],
			field: "command",
			match: "contains",
			value: "docker",
			action: "deny",
			label: "规则2",
		};
		const cmd = "rm -rf /tmp && docker run -d";
		const res = evaluateApprovalRules([r1, r2], "bash", { command: cmd }, cwd);
		expect(res.action).toBe("ask");
		expect(res.matchedRule?.id).toBe("r1");
		expect(res.hits).toHaveLength(2);
		expect(res.hits?.[0].ruleId).toBe("r1");
		expect(res.hits?.[0].text).toBe("rm -rf");
		expect(res.hits?.[1].ruleId).toBe("r2");
		expect(res.hits?.[1].text).toBe("docker");
	});

	it("checkBashCommandDanger 快速检测命令并返回高危命中详情", () => {
		const cmd = "cd /app && rm -rf ./data && git reset --hard";
		const hits = checkBashCommandDanger(cmd);
		expect(hits.length).toBeGreaterThanOrEqual(2);
		expect(hits.some((h) => h.ruleId === "builtin.bash.rm-rf")).toBe(true);
		expect(hits.some((h) => h.ruleId === "builtin.bash.git-destructive")).toBe(true);
	});
});
