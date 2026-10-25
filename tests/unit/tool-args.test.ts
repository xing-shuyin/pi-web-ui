/**
 * tool-args.ts 单测：卡头参数提示的安全提取。
 * 重点是「AI 把参数填错」的各类脏输入：非 JSON、半截 JSON、类型不对、超长、
 * 带控制字符、缺字段、脏 timeout 值——一律静默降级，绝不抛错。
 */
import { describe, expect, it } from "vitest";
import { parseDelegateArgs, resolveToolHeadline, shortenPath, toolArgHints } from "../../web/src/tool-args.js";

describe("toolArgHints — 脏输入不抛错", () => {
	it("undefined / 空串 / 纯空白 → 全空", () => {
		for (const v of [undefined, "", "   ", "\n"]) {
			expect(toolArgHints(v)).toEqual({ path: undefined, timeout: undefined, command: undefined });
		}
	});

	it("非 JSON / JSON 标量 / 数组 → 全空", () => {
		const cases = [
			"not json at all",
			"null",
			"123",
			'"just a string"',
			"true",
			"[1,2,3]",
			'["path", "x"]',
			"{",
			'{"path": }',
			'{"path": "src/a', // 值本身被截断（流式中途）
		];
		for (const v of cases) {
			const h = toolArgHints(v);
			expect(h.path, v).toBeUndefined();
			expect(h.timeout, v).toBeUndefined();
			expect(h.command, v).toBeUndefined();
		}
	});

	it("半截 JSON 但 path 值已完整 → 仍能显示（流式体验）", () => {
		expect(toolArgHints('{"path": "src/a.ts"').path).toBe("src/a.ts");
		expect(toolArgHints('{"path": "src/a.ts", "content": "partial...').path).toBe("src/a.ts");
		// 半截的 command 不显示（等 JSON 到齐，正文先回落 <pre>）
		expect(toolArgHints('{"command": "npm test').command).toBeUndefined();
	});

	it("path 类型不对 / 空串 / 纯空白 → 不显示", () => {
		for (const v of [
			'{"path": 123}',
			'{"path": null}',
			'{"path": true}',
			'{"path": {}}',
			'{"path": []}',
			'{"path": ""}',
			'{"path": "   "}',
		]) {
			expect(toolArgHints(v).path, v).toBeUndefined();
		}
	});

	it("随机怪值不抛错", () => {
		const weird = [
			'{"path":"\\',
			'{"path":"a\\',
			'\ufeff{"path":"x"}',
			'{"path":"\\u0000"}',
			'{"timeout":}',
			'{"timeout":NaN}',
			'{"timeout":Infinity}',
			'{"path":{"a":{"b":"c"}}}',
		];
		for (const v of weird) expect(() => toolArgHints(v)).not.toThrow();
	});
});

describe("toolArgHints — 路径", () => {
	it("识别 path（read / write / edit / edit_soft / ls 都用它）", () => {
		expect(toolArgHints('{"path":"src/a.ts"}').path).toBe("src/a.ts");
		expect(toolArgHints('{"path":"E:\\\\pi-web-ui\\\\web\\\\src\\\\a.ts","offset":1}').path).toBe(
			"E:\\pi-web-ui\\web\\src\\a.ts",
		);
	});

	it("兼容 file_path（SDK read 两种键都收）与其他常见键", () => {
		expect(toolArgHints('{"file_path":"/tmp/x.txt"}').path).toBe("/tmp/x.txt");
		expect(toolArgHints('{"filePath":"C:/x.txt"}').path).toBe("C:/x.txt");
		expect(toolArgHints('{"filename":"notes.md"}').path).toBe("notes.md");
		expect(toolArgHints('{"file":"a/b.rb"}').path).toBe("a/b.rb");
	});

	it("嵌套在 edits 数组里的 path 也能取到", () => {
		expect(toolArgHints('{"edits":[{"path":"src/b.ts","oldText":"x","newText":"y"}]}').path).toBe("src/b.ts");
	});

	it('值里的转义字符正确解码（\\n / \\" / \\\\）', () => {
		expect(toolArgHints('{"path":"a\\nb.ts"}').path).toBe("a b.ts");
		expect(toolArgHints('{"path":"we\\"ird.ts"}').path).toBe('we"ird.ts');
		expect(toolArgHints('{"path":"dir\\\\file.ts"}').path).toBe("dir\\file.ts");
	});

	it("控制字符与多余空白归一，超长截断到 300 字符", () => {
		expect(toolArgHints('{"path":"a\t\tb   c"}').path).toBe("a b c");
		const long = "d/".repeat(400) + "f.ts";
		const got = toolArgHints(JSON.stringify({ path: long })).path ?? "";
		expect(got.length).toBeLessThanOrEqual(300);
		expect(got.endsWith("…")).toBe(true);
	});

	it('转义在值内部出现的 "path" 不会被误当成参数', () => {
		expect(toolArgHints('{"content":"say \\"path\\": \\"fake.ts\\" here"}').path).toBeUndefined();
	});
});

describe("toolArgHints — 超时", () => {
	it("timeout 是秒（SDK bash / 本项目终端工具语义）", () => {
		expect(toolArgHints('{"command":"ls","timeout":30}').timeout).toBe("30s");
		expect(toolArgHints('{"command":"ls","timeout":1.5}').timeout).toBe("1.5s");
		expect(toolArgHints('{"timeoutSeconds":45}').timeout).toBe("45s");
		expect(toolArgHints('{"timeout_seconds":45}').timeout).toBe("45s");
	});

	it("毫秒族参数换算成秒/毫秒", () => {
		expect(toolArgHints('{"timeoutMs":30000}').timeout).toBe("30s");
		expect(toolArgHints('{"timeout_ms":1500}').timeout).toBe("1.5s");
		expect(toolArgHints('{"timeoutMilliseconds":500}').timeout).toBe("500ms");
	});

	it("脏 timeout（0 / 负数 / 非数字 / 指数写法 / 超上限）→ 不显示", () => {
		for (const v of [
			'{"timeout":0}',
			'{"timeout":-3}',
			'{"timeout":"30"}',
			'{"timeout":null}',
			'{"timeout":1e12}',
			'{"timeout":1e12}',
		]) {
			expect(toolArgHints(v).timeout, v).toBeUndefined();
		}
	});

	it("任何带 timeout 的工具都显示（不限于 bash）", () => {
		expect(toolArgHints('{"path":"x.ts","timeout":10}')).toMatchObject({ path: "x.ts", timeout: "10s" });
		expect(toolArgHints('{"server":"db","query":"select 1","timeout":5}').timeout).toBe("5s");
	});
});

describe("toolArgHints — 命令行", () => {
	it("bash 参数里的 command（保留换行）", () => {
		expect(toolArgHints('{"command":"npm test","timeout":30}').command).toBe("npm test");
		expect(toolArgHints('{"command":"line1\\nline2"}').command).toBe("line1\nline2");
	});

	it("command 缺失 / 非字符串 / 空 → undefined（正文回落 <pre>）", () => {
		expect(toolArgHints('{"timeout":30}').command).toBeUndefined();
		expect(toolArgHints('{"command":123}').command).toBeUndefined();
		expect(toolArgHints('{"command":"   "}').command).toBeUndefined();
		expect(toolArgHints("plain text args").command).toBeUndefined();
	});

	it("超大参数不再解析 command（避免 write 的大 content 卡渲染）", () => {
		const big = JSON.stringify({ command: "echo hi", content: "x".repeat(300 * 1024) });
		expect(toolArgHints(big).command).toBeUndefined();
		// 但路径仍能在前 256KB 里扫到
		const bigWithPath = JSON.stringify({ path: "src/big.ts", content: "x".repeat(300 * 1024) });
		expect(toolArgHints(bigWithPath).path).toBe("src/big.ts");
	});
});

describe("shortenPath", () => {
	it("短路径原样返回", () => {
		expect(shortenPath("src/a.ts")).toBe("src/a.ts");
		expect(shortenPath("a".repeat(56))).toBe("a".repeat(56));
	});

	it("长路径保住尾段（文件名可见）", () => {
		const p = "E:/very/long/project/path/that/keeps/going/deep/nested/dir/file.ts";
		const got = shortenPath(p, 40);
		expect(got.startsWith("…/")).toBe(true);
		expect(got.endsWith("file.ts")).toBe(true);
		expect(got.length).toBeLessThanOrEqual(42);
	});

	it("单个超长片段（无分隔符）截尾", () => {
		const got = shortenPath("x".repeat(200), 30);
		expect(got.startsWith("…")).toBe(true);
		expect(got.length).toBeLessThanOrEqual(30);
	});

	it("Windows 反斜杠路径同样压缩", () => {
		const got = shortenPath("C:\\Users\\me\\projects\\pi-web-ui\\web\\src\\components\\ToolCallBlock.tsx", 40);
		expect(got).toContain("ToolCallBlock.tsx");
		expect(got.startsWith("…/")).toBe(true);
	});
});

describe("delegate_task 参数解析", () => {
	it("agent 名流式 early 显示 + 超长截断", () => {
		expect(toolArgHints('{"agent": "oracle", "task": "').agent).toBe("oracle");
		expect(toolArgHints('{"task": "x"}').agent).toBeUndefined();
		expect(toolArgHints('{"agent": 42}').agent).toBeUndefined();
	});

	it("parseDelegateArgs 取出六段 + model；脏输入回空对象", () => {
		const args = JSON.stringify({
			agent: "oracle",
			task: "Do X",
			expected_outcome: "Y",
			required_tools: "read",
			must_do: "a",
			must_not_do: "b",
			context: "c",
			model: "p/m",
			extra: 42,
		});
		const got = parseDelegateArgs(args);
		expect(got.agent).toBe("oracle");
		expect(got.task).toBe("Do X");
		expect(got.model).toBe("p/m");
		expect("extra" in got).toBe(false);
		for (const bad of [undefined, "", "not json", "[1]", '{"task": 42}']) {
			expect(parseDelegateArgs(bad)).toEqual({});
		}
	});
});

describe("toolArgHints — skillName", () => {
	it("识别 name 参数（skill 工具标准参数）", () => {
		expect(toolArgHints('{"name":"coding-workflow"}').skillName).toBe("coding-workflow");
		expect(toolArgHints('{"name": "git-commit-helper"}').skillName).toBe("git-commit-helper");
	});

	it("兼容 skill 键", () => {
		expect(toolArgHints('{"skill":"review-code"}').skillName).toBe("review-code");
	});

	it("半截 JSON 时仍能提取 skillName（流式早期显示）", () => {
		expect(toolArgHints('{"name":"coding-workflow"').skillName).toBe("coding-workflow");
		expect(toolArgHints('{"name":"coding-workflow", "args": {').skillName).toBe("coding-workflow");
	});

	it("转义字符解码与控制字符剥离", () => {
		expect(toolArgHints('{"name":"my\\u002dskill"}').skillName).toBe("my-skill");
		expect(toolArgHints('{"name":"clean\\nname"}').skillName).toBe("clean name");
	});

	it("脏输入 / 非字符串 / 空串 → undefined", () => {
		expect(toolArgHints('{"name": 123}').skillName).toBeUndefined();
		expect(toolArgHints('{"name": ""}').skillName).toBeUndefined();
		expect(toolArgHints('{"name": "   "}').skillName).toBeUndefined();
		expect(toolArgHints('{"other": "value"}').skillName).toBeUndefined();
	});

	it("超长 skill 名截断至 VALUE_LIMIT", () => {
		const long = "skill-".repeat(100);
		const got = toolArgHints(JSON.stringify({ name: long })).skillName ?? "";
		expect(got.length).toBeLessThanOrEqual(301);
		expect(got.endsWith("…")).toBe(true);
	});
});

describe("resolveToolHeadline — 元数据驱动关键信息统一提取", () => {
	it("bash: 折叠态显示带 $ 前缀，展开态不显示", () => {
		const hlCollapsed = resolveToolHeadline({
			name: "bash",
			argumentsText: '{"command":"echo hello\\necho world"}',
			isCollapsed: true,
		});
		expect(hlCollapsed).toEqual({
			text: "echo hello +1",
			title: "echo hello\necho world",
			prefix: "$ ",
			className: "toolcall-cmd",
		});

		const hlExpanded = resolveToolHeadline({
			name: "bash",
			argumentsText: '{"command":"echo hello"}',
			isCollapsed: false,
		});
		expect(hlExpanded).toBeNull();
	});

	it("read / write / edit: 提取并缩写路径", () => {
		const hl = resolveToolHeadline({
			name: "read",
			argumentsText: '{"path":"src/components/ToolCallBlock.tsx"}',
		});
		expect(hl?.text).toBe("src/components/ToolCallBlock.tsx");
		expect(hl?.className).toBe("toolcall-path");
	});

	it("skill: 提取技能名与专用样式", () => {
		const hl = resolveToolHeadline({
			name: "skill",
			argumentsText: '{"name":"coding-workflow"}',
		});
		expect(hl).toEqual({
			text: "coding-workflow",
			title: "coding-workflow",
			className: "toolcall-skill",
		});
	});

	it("delegate_task: 提取 agent 模板名并带 ◈ 前缀", () => {
		const hl = resolveToolHeadline({
			name: "delegate_task",
			argumentsText: '{"agent":"oracle"}',
		});
		expect(hl).toEqual({
			text: "oracle",
			title: "oracle",
			prefix: "◈ ",
			className: "toolcall-agent",
		});
	});

	it("codemode: 提取代码行数并带 λ 前缀", () => {
		const hl = resolveToolHeadline({
			name: "codemode",
			argumentsText: '{"code":"const a = 1;\\nconst b = 2;"}',
		});
		expect(hl?.text).toBe("2L");
		expect(hl?.prefix).toBe("λ ");
		expect(hl?.className).toBe("toolcall-timeout");
	});

	it("tool_search: 提取搜索关键词", () => {
		const hl = resolveToolHeadline({
			name: "tool_search",
			argumentsText: '{"query":"terminal"}',
		});
		expect(hl?.text).toBe("terminal");
		expect(hl?.className).toBe("toolcall-query");
	});
});
