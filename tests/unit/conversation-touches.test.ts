import { describe, expect, it } from "vitest";
import {
	bashWriteTargets,
	extractTouches,
	formatTouchEntry,
	formatTouchesCompact,
	intersectTouches,
	normalizeTouchPath,
	toolCallRefsOfContent,
	toolCallsOf,
	unionTouchLists,
	type TouchableMessage,
} from "../../server/conversation-touches.js";

function toolMsg(name: string, args: unknown, ts?: number): TouchableMessage {
	const m: TouchableMessage = {
		role: "assistant",
		content: [{ type: "toolCall", name, arguments: args }],
		toolCalls: [{ name, args }],
	};
	if (ts !== undefined) m.timestamp = ts;
	return m;
}

describe("extractTouches 只算写不算读", () => {
	it("edit/write 的 path 算写（含次数与最后时间）", () => {
		const msgs = [
			toolMsg("edit", { path: "E:/repo/a.ts" }, 10),
			toolMsg("write", { path: "E:/repo/b.ts" }, 20),
			toolMsg("edit", { path: "E:/repo/a.ts" }, 30),
		];
		const out = extractTouches(msgs);
		expect(out).toHaveLength(2);
		expect(out[0]).toEqual({ path: "E:/repo/a.ts", count: 2, lastTs: 30 });
		expect(out[1]).toEqual({ path: "E:/repo/b.ts", count: 1, lastTs: 20 });
	});
	it("path 别名 file_path/filePath 也认", () => {
		expect(extractTouches([toolMsg("edit", { file_path: "x.ts" })])[0].path).toBe("x.ts");
		expect(extractTouches([toolMsg("write", { filePath: "y.ts" })])[0].path).toBe("y.ts");
	});
	it("read/ls/glob/grep 与只读 bash 一律不算", () => {
		const msgs: TouchableMessage[] = [
			toolMsg("read", { path: "E:/repo/a.ts" }),
			toolMsg("ls", { path: "E:/repo" }),
			toolMsg("glob", { pattern: "**/*.ts" }),
			toolMsg("grep", { pattern: "foo" }),
			toolMsg("bash", { command: "npm test" }),
			toolMsg("bash", { command: "git status" }),
			toolMsg("bash", { command: "echo hello" }),
			{ role: "user", content: "看看 E:/repo/a.ts" },
			{ role: "assistant", content: [{ type: "text", text: "好的" }] },
		];
		expect(extractTouches(msgs)).toEqual([]);
	});
	it("未知工具即使带 path 也不算（白名单之外一律忽略）", () => {
		expect(extractTouches([toolMsg("present_files", { path: "a.png" })])).toEqual([]);
		expect(extractTouches([toolMsg("ask_user_question", {})])).toEqual([]);
	});
	it("无 toolCalls 字段时回落扫 content（历史脏数据也工作）", () => {
		const m: TouchableMessage = {
			role: "assistant",
			content: [{ type: "toolCall", name: "edit", arguments: { path: "z.ts" } }],
		};
		expect(extractTouches([m])[0].path).toBe("z.ts");
	});
	it("content 里 input 键的 toolCall 也认（SDK 历史写法兼容）", () => {
		const m: TouchableMessage = {
			role: "assistant",
			content: [{ type: "toolCall", name: "write", input: { path: "w.ts" } }],
		};
		expect(extractTouches([m])[0].path).toBe("w.ts");
	});
});

describe("bash 高置信度提取", () => {
	it("重定向目标：> 与 >>（含 fd 前缀）", () => {
		expect(bashWriteTargets("echo hi > out.txt")).toEqual(["out.txt"]);
		expect(bashWriteTargets("cmd >> logs/a.log 2>&1")).toEqual(["logs/a.log"]);
		expect(bashWriteTargets("x 2> err.txt")).toEqual(["err.txt"]);
	});
	it("rm/mkdir/touch 的参数；cp/mv 只取目标端", () => {
		expect(bashWriteTargets("rm -rf dist tmp")).toEqual(["dist", "tmp"]);
		expect(bashWriteTargets("mkdir -p a/b")).toEqual(["a/b"]);
		expect(bashWriteTargets("touch x.txt")).toEqual(["x.txt"]);
		expect(bashWriteTargets("mv a.txt b.txt")).toEqual(["b.txt"]);
		expect(bashWriteTargets("cp -r src/ dst/")).toEqual(["dst/"]);
		expect(bashWriteTargets("rm -- -weird")).toEqual(["-weird"]);
	});
	it("拿不准的不提：>&N、/dev/null、引号内、heredoc、纯读命令", () => {
		expect(bashWriteTargets("cmd 2>&1")).toEqual([]);
		expect(bashWriteTargets("echo x > /dev/null")).toEqual([]);
		expect(bashWriteTargets('echo "a > b"')).toEqual([]);
		expect(bashWriteTargets("cat <<EOF\nhi\nEOF")).toEqual([]);
		expect(bashWriteTargets("echo a > ; rm x")).toEqual(["x"]);
		expect(bashWriteTargets("")).toEqual([]);
	});
	it("复合命令切分 + sudo 包装", () => {
		expect(bashWriteTargets("npm test && rm -f cache.json; mkdir out")).toEqual(["cache.json", "out"]);
		expect(bashWriteTargets("sudo rm x")).toEqual(["x"]);
		expect(bashWriteTargets("echo a | tee kept.txt")).toEqual([]);
	});
	it("bashExecution 顶层 command 也算", () => {
		const m: TouchableMessage = { role: "bashExecution", command: "echo x > f.log", output: "x" };
		expect(extractTouches([m])[0].path).toBe("f.log");
	});
	it("bash 工具调用走 command 参数", () => {
		expect(extractTouches([toolMsg("bash", { command: "rm gone.txt" })])[0].path).toBe("gone.txt");
		expect(extractTouches([toolMsg("bash", { timeout: 10 })])).toEqual([]);
	});
});

describe("交集与格式化", () => {
	const a = [
		{ path: "x.ts", count: 2, lastTs: 5 },
		{ path: "y.ts", count: 1, lastTs: 9 },
	];
	const b = [
		{ path: "y.ts", count: 7, lastTs: 1 },
		{ path: "z.ts", count: 1, lastTs: 2 },
	];
	it("intersectTouches 取交集（计数沿用 a）", () => {
		expect(intersectTouches(a, b)).toEqual([{ path: "y.ts", count: 1, lastTs: 9 }]);
		expect(intersectTouches(a, [])).toEqual([]);
		expect(intersectTouches([], b)).toEqual([]);
	});
	it("formatTouchEntry 按条截断但路径永不截断", () => {
		expect(formatTouchEntry({ path: "a.ts", count: 1, lastTs: 0 })).toBe("a.ts");
		expect(formatTouchEntry({ path: "a.ts", count: 3, lastTs: 0 })).toBe("a.ts ×3");
		const long = `E:/very/long/project/dir/${"d/".repeat(30)}file.ts`;
		expect(formatTouchEntry({ path: long, count: 2, lastTs: 0 })).toBe(long);
	});
	it("formatTouchesCompact 前 N 条 + 计数不断尾", () => {
		const files = ["a", "b", "c", "d"].map((p, i) => ({ path: `${p}.ts`, count: 1, lastTs: i }));
		expect(formatTouchesCompact(files)).toBe("a.ts、b.ts、c.ts、… (+1)");
		expect(formatTouchesCompact(files.slice(0, 2))).toBe("a.ts、b.ts");
		expect(formatTouchesCompact([])).toBe("");
	});
	it("normalizeTouchPath 轻归一", () => {
		expect(normalizeTouchPath("  ./a/b.ts ")).toBe("a/b.ts");
		expect(normalizeTouchPath("E:\\repo\\x.ts")).toBe("E:/repo/x.ts");
	});
});

describe("patch 工具的写触碰提取", () => {
	it("段头 [path#TAG]/[path] 与 MV 目标都算写", () => {
		const patch = "[recon/parse.py#ABCD]\nPUT 1.=1:\n+x\n[new_dir/new.py]\nPUT <1:\n+y\nMV dest/moved.txt";
		const out = extractTouches([toolMsg("patch", { patch }, 5)]);
		const paths = out.map((e) => e.path);
		expect(paths).toContain("recon/parse.py");
		expect(paths).toContain("new_dir/new.py");
		expect(paths).toContain("dest/moved.txt");
	});

	it("普通文本与 -/+ 行不会被误提取", () => {
		const patch = "[a.txt]\nPUT 1.=1:\n+not [a header]\n- removed [b.txt] line";
		const out = extractTouches([toolMsg("patch", { patch }, 5)]);
		expect(out.map((e) => e.path)).toEqual(["a.txt"]);
	});
});

describe("unionTouchLists", () => {
	it("按路径求并，count 取大（sidecar 与 live 消息集重叠，不能相加）", () => {
		const out = unionTouchLists(
			[{ path: "a.ts", count: 3, lastTs: 10 }],
			[
				{ path: "a.ts", count: 2, lastTs: 20 },
				{ path: "b.ts", count: 1, lastTs: 5 },
			],
		);
		expect(out.find((f) => f.path === "a.ts")).toEqual({ path: "a.ts", count: 3, lastTs: 20 });
		expect(out).toHaveLength(2);
		expect(unionTouchLists(null as never, undefined as never)).toEqual([]);
	});
});

describe("空集与脏数据不抛错", () => {
	it("undefined/null/空数组/脏元素", () => {
		expect(extractTouches(undefined)).toEqual([]);
		expect(extractTouches(null)).toEqual([]);
		expect(extractTouches([])).toEqual([]);
		expect(extractTouches([null, undefined, 42, "x", {}] as unknown as TouchableMessage[])).toEqual([]);
		expect(intersectTouches(null as never, null as never)).toEqual([]);
		expect(toolCallsOf(null)).toEqual([]);
		expect(toolCallRefsOfContent("str")).toEqual([]);
		expect(toolCallRefsOfContent([{ type: "text", text: "hi" }])).toEqual([]);
	});
	it("无 timestamp 时 lastTs 为 0；maxMessages 只看尾部", () => {
		expect(extractTouches([toolMsg("edit", { path: "a.ts" })])[0].lastTs).toBe(0);
		const msgs = [toolMsg("edit", { path: "old.ts" }, 1), toolMsg("edit", { path: "new.ts" }, 2)];
		expect(extractTouches(msgs, { maxMessages: 1 }).map((f) => f.path)).toEqual(["new.ts"]);
	});
});
