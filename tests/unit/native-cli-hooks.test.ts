import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	NATIVE_CLI_HOOK_CAPABILITIES,
	NATIVE_CLI_HOOK_ENGINES,
	NATIVE_CLI_HOOK_ENTRY,
	NATIVE_CLI_HOOK_RULES,
	NATIVE_CLI_HOOK_TYPES,
	SharedHookConfigError,
	agySharedHookEntry,
	agySharedHooksPath,
	claudeHookSettings,
	codexHookConfigArgs,
	ensureAgySharedHooks,
	mergeAgySharedHooks,
	nativeCliHookDispatcher,
	nativeCliHookEvents,
	nativeCliHookSpoolDir,
	removeAgySharedHooks,
} from "../../server/native-cli-hooks.js";

/** agy 实测的会话 id 形状（UUID），dispatcher 只接受这一族或足够长的裸 id。 */
const SESSION_ID = "a3d087b4-2ff1-44fa-a361-127bc18fdbf1";
const COMMAND = "node /tmp/pi-web-ui/native-cli-hook.mjs";
const GUARD_MS = 20_000;

const temporaryRoots: string[] = [];

async function temporaryRoot(prefix = "native-cli-hooks-"): Promise<string> {
	const dir = await mkdtemp(path.join(tmpdir(), prefix));
	temporaryRoots.push(dir);
	return dir;
}

afterEach(async () => {
	const roots = temporaryRoots.splice(0);
	await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

interface HookRecord {
	eventId: string;
	type: string;
	nativeId: string;
	at: string;
}

async function listSpool(spoolDir: string): Promise<string[]> {
	try {
		return (await readdir(spoolDir)).sort();
	} catch {
		return [];
	}
}

async function readRecords(spoolDir: string, nativeId: string): Promise<HookRecord[]> {
	const dir = path.join(spoolDir, nativeId);
	let names: string[];
	try {
		names = await readdir(dir);
	} catch {
		return [];
	}
	const records: HookRecord[] = [];
	for (const name of names.sort()) {
		records.push(JSON.parse(await readFile(path.join(dir, name), "utf8")) as HookRecord);
	}
	return records;
}

async function recordTypes(spoolDir: string, nativeId: string): Promise<string[]> {
	return (await readRecords(spoolDir, nativeId)).map((record) => record.type);
}

interface RunResult {
	code: number | null;
	stdout: string;
	stderr: string;
}

/** 用真实子进程跑生成的 dispatcher：被测对象是 stdin → spool 的路由，mock 掉就失去意义。 */
function runHookScript(scriptPath: string, input: string): Promise<RunResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [scriptPath], {
			stdio: ["pipe", "pipe", "pipe"],
			// 路由键来自启动环境（CLI 继承），不是从 payload 猜；这里模拟启动时注入的那个变量。
			env: { ...process.env, PI_WEB_NATIVE_CLI_KEY: SESSION_ID },
		});
		let stdout = "";
		let stderr = "";
		// 测试自身也要兜底，否则 dispatcher 挂住会把整轮 vitest 拖死。
		const guard = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error(`hook dispatcher 未在 ${GUARD_MS}ms 内返回：${stdout}${stderr}`));
		}, GUARD_MS);
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => (stdout += chunk));
		child.stderr.on("data", (chunk: string) => (stderr += chunk));
		child.once("error", (error) => {
			clearTimeout(guard);
			reject(error);
		});
		child.once("close", (code) => {
			clearTimeout(guard);
			resolve({ code, stdout, stderr });
		});
		child.stdin.end(input);
	});
}

interface Dispatcher {
	root: string;
	spoolDir: string;
	script: string;
}

async function installDispatcher(engine: string, limit?: number): Promise<Dispatcher> {
	const root = await temporaryRoot();
	const spoolDir = path.join(root, "spool");
	const script = path.join(root, "dispatcher.mjs");
	await writeFile(script, nativeCliHookDispatcher({ engine, spoolDir, limit }), "utf8");
	return { root, spoolDir, script };
}

describe("nativeCliHookEvents", () => {
	it("agy 平坦事件直接数组、grouped 事件套 matcher 分组", () => {
		const events = nativeCliHookEvents("agy", COMMAND);
		expect(Object.keys(events)).toEqual([
			"SessionStart",
			"PreInvocation",
			"PreToolUse",
			"PostToolUse",
			"PostInvocation",
			"Stop",
		]);
		for (const flat of ["SessionStart", "PreInvocation", "PostInvocation", "Stop"]) {
			expect(events[flat]).toEqual([{ type: "command", command: COMMAND, timeout: 5 }]);
		}
		for (const grouped of ["PreToolUse", "PostToolUse"]) {
			expect(events[grouped]).toEqual([{ matcher: "*", hooks: [{ type: "command", command: COMMAND, timeout: 5 }] }]);
		}
	});

	it("claude 事件集合与分组形状按自身表", () => {
		const events = nativeCliHookEvents("claude", COMMAND);
		expect(Object.keys(events)).toEqual([...NATIVE_CLI_HOOK_ENGINES.claude.events]);
		expect(events.UserPromptSubmit).toEqual([
			{ matcher: "*", hooks: [{ type: "command", command: COMMAND, timeout: 5 }] },
		]);
		expect(events.StopFailure).toEqual([{ matcher: "*", hooks: [{ type: "command", command: COMMAND, timeout: 5 }] }]);
		for (const grouped of ["PreToolUse", "PostToolUse", "PermissionRequest"]) {
			expect(events[grouped]).toEqual([{ matcher: "*", hooks: [{ type: "command", command: COMMAND, timeout: 5 }] }]);
		}
	});

	it("codex 覆盖 0.170.0 的全部事件，全部 matcher 分组", () => {
		const events = nativeCliHookEvents("codex", COMMAND);
		expect(Object.keys(events)).toEqual([...NATIVE_CLI_HOOK_ENGINES.codex.events]);
		// 真机确认存在的事件（二进制 + --help 双向核对）。
		for (const event of [
			"SessionStart",
			"UserPromptSubmit",
			"PreCompact",
			"PostCompact",
			"SubagentStart",
			"SubagentStop",
			"Stop",
			"StopInterrupt",
			"SessionEnd",
		]) {
			expect(events[event]).toEqual([{ matcher: "*", hooks: [{ type: "command", command: COMMAND, timeout: 5 }] }]);
		}
	});

	it("超时参数透传到每个 handler", () => {
		const events = nativeCliHookEvents("agy", COMMAND, 42);
		expect(events.SessionStart).toEqual([{ type: "command", command: COMMAND, timeout: 42 }]);
		expect(events.PreToolUse).toEqual([{ matcher: "*", hooks: [{ type: "command", command: COMMAND, timeout: 42 }] }]);
	});

	it("未知引擎直接抛错，不返回半成品配置", () => {
		expect(() => nativeCliHookEvents("nope", COMMAND)).toThrow(/No hook profile for engine: nope/);
	});

	it("规则与能力表自洽：类型在超集内、分组事件都在事件表内", () => {
		const types = new Set<string>(NATIVE_CLI_HOOK_TYPES);
		for (const rule of NATIVE_CLI_HOOK_RULES) expect(types.has(rule.type)).toBe(true);
		for (const [engine, capabilities] of Object.entries(NATIVE_CLI_HOOK_CAPABILITIES)) {
			for (const type of capabilities) expect(types.has(type), `${engine}:${type}`).toBe(true);
		}
		for (const [engine, spec] of Object.entries(NATIVE_CLI_HOOK_ENGINES)) {
			for (const grouped of spec.grouped) expect(spec.events, `${engine}:${grouped}`).toContain(grouped);
		}
	});

	it("agy 共享条目就是 agy 事件表", () => {
		expect(agySharedHookEntry(COMMAND)).toEqual(nativeCliHookEvents("agy", COMMAND));
	});
});

describe("mergeAgySharedHooks", () => {
	it("existing 为 null 时只生成观察者条目", () => {
		const merged = mergeAgySharedHooks(null, COMMAND);
		expect(merged.endsWith("\n")).toBe(true);
		const document = JSON.parse(merged) as Record<string, unknown>;
		expect(Object.keys(document)).toEqual([NATIVE_CLI_HOOK_ENTRY]);
		expect(document[NATIVE_CLI_HOOK_ENTRY]).toEqual(agySharedHookEntry(COMMAND));
	});

	it("保留用户自己的命名 hook，并让我们的条目并存", () => {
		const existing = JSON.stringify({ "my-lint": { PostToolUse: [{ matcher: "*", hooks: [] }] } }, null, 2);
		const document = JSON.parse(mergeAgySharedHooks(existing, COMMAND)) as Record<string, unknown>;
		expect(Object.keys(document)).toEqual(["my-lint", NATIVE_CLI_HOOK_ENTRY]);
		expect(document["my-lint"]).toEqual({ PostToolUse: [{ matcher: "*", hooks: [] }] });
		expect(document[NATIVE_CLI_HOOK_ENTRY]).toEqual(agySharedHookEntry(COMMAND));
	});

	it("保留其它顶层键（如版本号）", () => {
		const document = JSON.parse(mergeAgySharedHooks('{"version": 2}', COMMAND)) as Record<string, unknown>;
		expect(document.version).toBe(2);
		expect(document[NATIVE_CLI_HOOK_ENTRY]).toEqual(agySharedHookEntry(COMMAND));
	});

	it("同一 existing 重复 merge 幂等（字符串完全一致）", () => {
		const existing = JSON.stringify({ "my-lint": { Stop: [] } }, null, 2);
		const once = mergeAgySharedHooks(existing, COMMAND);
		expect(mergeAgySharedHooks(once, COMMAND)).toBe(once);
		expect(mergeAgySharedHooks(mergeAgySharedHooks(null, COMMAND), COMMAND)).toBe(mergeAgySharedHooks(null, COMMAND));
	});

	it("键顺序稳定（排序后输出），便于文件比对", () => {
		const merged = mergeAgySharedHooks('{"zzz":1,"aaa":2}', COMMAND);
		expect(Object.keys(JSON.parse(merged) as Record<string, unknown>)).toEqual(["aaa", NATIVE_CLI_HOOK_ENTRY, "zzz"]);
	});

	it("非法 JSON 抛 SharedHookConfigError，绝不覆盖用户文件", () => {
		expect(() => mergeAgySharedHooks("{ not json", COMMAND)).toThrow(SharedHookConfigError);
		expect(() => mergeAgySharedHooks("{ not json", COMMAND)).toThrow(/not valid JSON/);
	});

	it("existing 是数组或标量同样拒绝", () => {
		expect(() => mergeAgySharedHooks("[]", COMMAND)).toThrow(SharedHookConfigError);
		expect(() => mergeAgySharedHooks("[1,2]", COMMAND)).toThrow(SharedHookConfigError);
		expect(() => mergeAgySharedHooks("42", COMMAND)).toThrow(SharedHookConfigError);
		expect(() => mergeAgySharedHooks('"text"', COMMAND)).toThrow(SharedHookConfigError);
		expect(() => mergeAgySharedHooks("null", COMMAND)).toThrow(SharedHookConfigError);
	});

	it("空白 existing 视为空文档", () => {
		const document = JSON.parse(mergeAgySharedHooks("  \n\t", COMMAND)) as Record<string, unknown>;
		expect(Object.keys(document)).toEqual([NATIVE_CLI_HOOK_ENTRY]);
	});
});

describe("ensureAgySharedHooks / removeAgySharedHooks", () => {
	it("首次写入 changed=true 且落在 <home>/.gemini/config/hooks.json", async () => {
		const home = await temporaryRoot("native-cli-agy-home-");
		const result = await ensureAgySharedHooks(home, COMMAND);
		const expected = path.join(home, ".gemini", "config", "hooks.json");
		expect(result).toEqual({ path: expected, changed: true });
		expect(result.path).toBe(agySharedHooksPath(home));
		const document = JSON.parse(await readFile(expected, "utf8")) as Record<string, unknown>;
		expect(document[NATIVE_CLI_HOOK_ENTRY]).toEqual(agySharedHookEntry(COMMAND));
	});

	it("第二次 changed=false 且文件内容一字不变", async () => {
		const home = await temporaryRoot("native-cli-agy-home-");
		await ensureAgySharedHooks(home, COMMAND);
		const first = await readFile(agySharedHooksPath(home), "utf8");
		const second = await ensureAgySharedHooks(home, COMMAND);
		expect(second.changed).toBe(false);
		expect(await readFile(agySharedHooksPath(home), "utf8")).toBe(first);
	});

	it("用户已有 hooks 时合并而非替换", async () => {
		const home = await temporaryRoot("native-cli-agy-home-");
		const file = agySharedHooksPath(home);
		await ensureAgySharedHooks(home, COMMAND);
		await writeFile(file, JSON.stringify({ "my-lint": { Stop: [{ hooks: [] }] } }, null, 2) + "\n", "utf8");
		const result = await ensureAgySharedHooks(home, COMMAND);
		expect(result.changed).toBe(true);
		const document = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
		expect(document["my-lint"]).toEqual({ Stop: [{ hooks: [] }] });
		expect(document[NATIVE_CLI_HOOK_ENTRY]).toEqual(agySharedHookEntry(COMMAND));
	});

	it("命令变化时重新写入（不再是幂等空转）", async () => {
		const home = await temporaryRoot("native-cli-agy-home-");
		await ensureAgySharedHooks(home, COMMAND);
		const result = await ensureAgySharedHooks(home, "node /other/hook.mjs");
		expect(result.changed).toBe(true);
		const document = JSON.parse(await readFile(agySharedHooksPath(home), "utf8")) as Record<string, unknown>;
		expect(document[NATIVE_CLI_HOOK_ENTRY]).toEqual(agySharedHookEntry("node /other/hook.mjs"));
	});

	it("非法现有文件时抛错且不覆盖", async () => {
		const home = await temporaryRoot("native-cli-agy-home-");
		const file = agySharedHooksPath(home);
		await ensureAgySharedHooks(home, COMMAND);
		await writeFile(file, "{ broken", "utf8");
		await expect(ensureAgySharedHooks(home, COMMAND)).rejects.toThrow(SharedHookConfigError);
		expect(await readFile(file, "utf8")).toBe("{ broken");
	});

	it("remove 只删我们的条目、保留用户条目", async () => {
		const home = await temporaryRoot("native-cli-agy-home-");
		const file = agySharedHooksPath(home);
		await ensureAgySharedHooks(home, COMMAND);
		const document = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
		document["my-lint"] = { PostToolUse: [{ matcher: "*", hooks: [] }] };
		await writeFile(file, JSON.stringify(document, null, 2) + "\n", "utf8");

		expect(await removeAgySharedHooks(home)).toBe(true);
		const remaining = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
		expect(remaining).toEqual({ "my-lint": { PostToolUse: [{ matcher: "*", hooks: [] }] } });
		// 条目已不在，再删无需改动
		expect(await removeAgySharedHooks(home)).toBe(false);
	});

	it("只剩我们的条目时 remove 直接删文件", async () => {
		const home = await temporaryRoot("native-cli-agy-home-");
		const file = agySharedHooksPath(home);
		await ensureAgySharedHooks(home, COMMAND);
		expect(await removeAgySharedHooks(home)).toBe(true);
		await expect(readFile(file, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
		expect(await removeAgySharedHooks(home)).toBe(false);
	});

	it("文件不存在或不是对象时 remove 返回 false", async () => {
		const home = await temporaryRoot("native-cli-agy-home-");
		expect(await removeAgySharedHooks(home)).toBe(false);
		const file = agySharedHooksPath(home);
		await ensureAgySharedHooks(home, COMMAND);
		await writeFile(file, "[]", "utf8");
		expect(await removeAgySharedHooks(home)).toBe(false);
		await writeFile(file, "{ not json", "utf8");
		expect(await removeAgySharedHooks(home)).toBe(false);
	});
});

describe("claudeHookSettings / codexHookConfigArgs", () => {
	it("claude settings 可 JSON.parse 出 hooks 对象且分组形状正确", () => {
		const settings = JSON.parse(claudeHookSettings(COMMAND)) as {
			hooks: Record<string, unknown>;
		};
		expect(Object.keys(settings)).toEqual(["hooks"]);
		expect(Object.keys(settings.hooks)).toEqual([...NATIVE_CLI_HOOK_ENGINES.claude.events]);
		expect(settings.hooks.PreToolUse).toEqual([
			{ matcher: "*", hooks: [{ type: "command", command: COMMAND, timeout: 5 }] },
		]);
		expect(settings.hooks.UserPromptSubmit).toEqual([
			{ matcher: "*", hooks: [{ type: "command", command: COMMAND, timeout: 5 }] },
		]);
	});

	it("codex 返回成对 --config，每个事件一对，超时透传", () => {
		const args = codexHookConfigArgs(COMMAND, 30);
		const events = NATIVE_CLI_HOOK_ENGINES.codex.events;
		expect(args.length).toBe(events.length * 2);
		for (let index = 0; index < args.length; index += 2) {
			expect(args[index]).toBe("--config");
			expect(args[index + 1].startsWith(`hooks.${events[index / 2]}=[{`)).toBe(true);
			expect(args[index + 1].endsWith("}]")).toBe(true);
			expect(args[index + 1]).toContain(`matcher = "*"`);
			expect(args[index + 1]).toContain(`type = "command"`);
			expect(args[index + 1]).toContain(`command = ${JSON.stringify(COMMAND)}`);
			expect(args[index + 1]).toContain("timeout = 30");
		}
	});
});

describe("nativeCliHookSpoolDir", () => {
	it("会话 spool 挂在 dataDir/native-cli/hook-spool", () => {
		expect(nativeCliHookSpoolDir(path.join("/data"))).toBe(path.join("/data", "native-cli", "hook-spool"));
	});
});

describe("dispatcher 端到端（agy）", () => {
	it("SessionStart 在 spool 下建 id 目录并写 session 记录", async () => {
		const { spoolDir, script } = await installDispatcher("agy");
		const result = await runHookScript(
			script,
			JSON.stringify({ hookEventName: "SessionStart", conversationId: SESSION_ID, cwd: "C:\\x" }),
		);
		expect(result.code).toBe(0);
		expect(await listSpool(spoolDir)).toEqual([SESSION_ID]);
		expect(await recordTypes(spoolDir, SESSION_ID)).toEqual(["session"]);
		const [record] = await readRecords(spoolDir, SESSION_ID);
		expect(record.nativeId).toBe(SESSION_ID);
		expect(record.eventId.endsWith("-session")).toBe(true);
		expect(record.eventId.startsWith(String(Date.parse(record.at)).padStart(19, "0"))).toBe(true);
	});

	it("PreInvocation 0 → submitted，1 → working；PostInvocation → working", async () => {
		const { spoolDir, script } = await installDispatcher("agy");
		const send = (payload: unknown) => runHookScript(script, JSON.stringify(payload));
		await send({ hookEventName: "PreInvocation", conversationId: SESSION_ID, invocationNum: 0 });
		await send({ hookEventName: "PreInvocation", conversationId: SESSION_ID, invocationNum: 1 });
		await send({ hookEventName: "PostInvocation", conversationId: SESSION_ID, invocationNum: 1 });
		expect(await recordTypes(spoolDir, SESSION_ID)).toEqual(["submitted", "working", "working"]);
	});

	it("PreToolUse run_command → tool，stdout 恰好是 allow 决策", async () => {
		const { spoolDir, script } = await installDispatcher("agy");
		const result = await runHookScript(
			script,
			JSON.stringify({ hookEventName: "PreToolUse", conversationId: SESSION_ID, toolCall: { name: "run_command" } }),
		);
		expect(result.code).toBe(0);
		expect(result.stdout).toBe('{"decision":"allow"}');
		expect(await recordTypes(spoolDir, SESSION_ID)).toEqual(["tool"]);
	});

	it("PostToolUse 同样记 tool（非 PreToolUse 时不再输出 allow 决策）", async () => {
		const { spoolDir, script } = await installDispatcher("agy");
		const result = await runHookScript(
			script,
			JSON.stringify({ hookEventName: "PostToolUse", conversationId: SESSION_ID, toolCall: { name: "run_command" } }),
		);
		expect(result.stdout).toBe("{}");
		expect(await recordTypes(spoolDir, SESSION_ID)).toEqual(["tool"]);
	});

	it("PreToolUse invoke_subagent → subagent（不是 tool）", async () => {
		const { spoolDir, script } = await installDispatcher("agy");
		const result = await runHookScript(
			script,
			JSON.stringify({
				hookEventName: "PreToolUse",
				conversationId: SESSION_ID,
				toolCall: { name: "invoke_subagent" },
			}),
		);
		expect(result.stdout).toBe('{"decision":"allow"}');
		expect(await recordTypes(spoolDir, SESSION_ID)).toEqual(["subagent"]);
	});

	it("Stop 按 terminationReason 分流 error / done", async () => {
		const { spoolDir, script } = await installDispatcher("agy");
		await runHookScript(
			script,
			JSON.stringify({ hookEventName: "Stop", conversationId: SESSION_ID, terminationReason: "ERROR" }),
		);
		await runHookScript(
			script,
			JSON.stringify({ hookEventName: "Stop", conversationId: SESSION_ID, terminationReason: "NO_TOOL_CALL" }),
		);
		await runHookScript(script, JSON.stringify({ hookEventName: "Stop", conversationId: SESSION_ID }));
		expect(await recordTypes(spoolDir, SESSION_ID)).toEqual(["error", "done", "done"]);
	});

	it("agy 不支持的事件（SessionEnd）不落盘", async () => {
		const { spoolDir, script } = await installDispatcher("agy");
		const result = await runHookScript(
			script,
			JSON.stringify({ hookEventName: "SessionEnd", conversationId: SESSION_ID }),
		);
		expect(result.code).toBe(0);
		expect(await listSpool(spoolDir)).toEqual([]);
	});

	it("非法 id 不写文件也不抛错", async () => {
		const { spoolDir, script } = await installDispatcher("agy");
		for (const conversationId of ["../../etc", "a", "", "..", "a/../../b"]) {
			const result = await runHookScript(script, JSON.stringify({ hookEventName: "SessionStart", conversationId }));
			expect(result.code, conversationId).toBe(0);
			expect(result.stderr, conversationId).toBe("");
		}
		expect(await listSpool(spoolDir)).toEqual([]);
	});

	it("载荷不是 JSON 时静默退出、不写文件", async () => {
		const { spoolDir, script } = await installDispatcher("agy");
		for (const input of ["not json at all", "{", ""]) {
			const result = await runHookScript(script, input);
			expect(result.code, input).toBe(0);
			expect(result.stderr, input).toBe("");
		}
		expect(await listSpool(spoolDir)).toEqual([]);
	});

	it("未知事件名不写文件", async () => {
		const { spoolDir, script } = await installDispatcher("agy");
		await runHookScript(script, JSON.stringify({ hookEventName: "Mystery", conversationId: SESSION_ID }));
		expect(await listSpool(spoolDir)).toEqual([]);
	});

	it("limit 裁剪每个会话目录只留最新 N 条", async () => {
		const { spoolDir, script } = await installDispatcher("agy", 2);
		const send = (payload: unknown) => runHookScript(script, JSON.stringify(payload));
		await send({ hookEventName: "SessionStart", conversationId: SESSION_ID });
		await send({ hookEventName: "PreInvocation", conversationId: SESSION_ID, invocationNum: 0 });
		await send({ hookEventName: "PreInvocation", conversationId: SESSION_ID, invocationNum: 1 });
		await send({ hookEventName: "Stop", conversationId: SESSION_ID });
		const names = await readdir(path.join(spoolDir, SESSION_ID));
		expect(names.length).toBe(2);
		expect(await recordTypes(spoolDir, SESSION_ID)).toEqual(["working", "done"]);
	});

	it("id 也接受 codex/claude 形状的 session_id", async () => {
		const { spoolDir, script } = await installDispatcher("agy");
		await runHookScript(script, JSON.stringify({ hookEventName: "SessionStart", session_id: SESSION_ID }));
		expect(await recordTypes(spoolDir, SESSION_ID)).toEqual(["session"]);
	});
});

describe("dispatcher 端到端（claude）", () => {
	it("UserPromptSubmit → submitted，且 stdout 为空（claude 不需要决策回执）", async () => {
		const { spoolDir, script } = await installDispatcher("claude");
		const result = await runHookScript(
			script,
			JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: SESSION_ID }),
		);
		expect(result.code).toBe(0);
		expect(result.stdout).toBe("");
		expect(await recordTypes(spoolDir, SESSION_ID)).toEqual(["submitted"]);
	});

	it("claude PreToolUse 记 tool 且不输出 agy 的 allow 决策", async () => {
		const { spoolDir, script } = await installDispatcher("claude");
		const result = await runHookScript(
			script,
			JSON.stringify({ hook_event_name: "PreToolUse", session_id: SESSION_ID, tool_name: "Bash" }),
		);
		expect(result.stdout).toBe("");
		expect(await recordTypes(spoolDir, SESSION_ID)).toEqual(["tool"]);
	});

	it("claude SessionEnd → end，Notification 按类型分流提问/审批", async () => {
		const { spoolDir, script } = await installDispatcher("claude");
		const send = (payload: unknown) => runHookScript(script, JSON.stringify(payload));
		await send({ hook_event_name: "SessionEnd", session_id: SESSION_ID });
		await send({ hook_event_name: "Notification", session_id: SESSION_ID, notification_type: "permission_prompt" });
		await send({ hook_event_name: "Notification", session_id: SESSION_ID, notification_type: "elicitation_dialog" });
		await send({ hook_event_name: "Notification", session_id: SESSION_ID, notification_type: "other" });
		expect(await recordTypes(spoolDir, SESSION_ID)).toEqual(["end", "approval", "question", "notification"]);
	});

	it("能力表为空（dsh）的引擎不写任何记录", async () => {
		const { spoolDir, script } = await installDispatcher("dsh");
		const result = await runHookScript(
			script,
			JSON.stringify({ hookEventName: "SessionStart", conversationId: SESSION_ID }),
		);
		expect(result.code).toBe(0);
		expect(await listSpool(spoolDir)).toEqual([]);
	});
});

describe("nativeCliHookCommand（真机结论：codex 不经 shell 执行 hook）", () => {
	it("agy / claude 走 shell，用带引号的两段命令", async () => {
		const { nativeCliHookCommand } = await import("../../server/native-cli-hooks.js");
		expect(nativeCliHookCommand("agy", "N.exe", "S.mjs", "win32")).toBe('"N.exe" "S.mjs"');
		expect(nativeCliHookCommand("claude", "N.exe", "S.mjs", "win32")).toBe('"N.exe" "S.mjs"');
	});
	it("codex 在 Windows 必须包一层 cmd /c，否则带引号的命令串永不执行", async () => {
		const { nativeCliHookCommand } = await import("../../server/native-cli-hooks.js");
		expect(nativeCliHookCommand("codex", "N.exe", "S.mjs", "win32")).toBe('cmd /c ""N.exe" "S.mjs""');
		expect(nativeCliHookCommand("codex", "/usr/bin/node", "S.mjs", "linux")).toBe("/usr/bin/node S.mjs");
	});
});

describe("NATIVE_CLI_HOOK_RULES（新增事件）", () => {
	it("PostCompact → compact，StopInterrupt → done", async () => {
		const { NATIVE_CLI_HOOK_RULES } = await import("../../server/native-cli-hooks.js");
		expect(NATIVE_CLI_HOOK_RULES.find((rule) => rule.event === "PostCompact")?.type).toBe("compact");
		expect(NATIVE_CLI_HOOK_RULES.find((rule) => rule.event === "StopInterrupt")?.type).toBe("done");
	});
});

describe("审批合成（agy 无权限事件，用 PreToolUse 决策代替）", () => {
	async function runWithApproval(engine: string, tool: string, approval?: { mode: "allow" | "ask"; tools: string[] }) {
		const root = await mkdtemp(path.join(tmpdir(), "hook-approval-"));
		const spool = path.join(root, "spool");
		const script = path.join(root, "dispatcher.mjs");
		await writeFile(script, nativeCliHookDispatcher({ engine, spoolDir: spool, approval }), "utf8");
		const stdout = await new Promise<string>((resolve) => {
			const child = spawn(process.execPath, [script], {
				stdio: ["pipe", "pipe", "pipe"],
				env: { ...process.env, PI_WEB_NATIVE_CLI_KEY: SESSION_ID },
			});
			let out = "";
			child.stdout.on("data", (c) => (out += c));
			child.on("exit", () => resolve(out));
			child.stdin.end(
				JSON.stringify({ hookEventName: "PreToolUse", conversationId: SESSION_ID, toolCall: { name: tool } }),
			);
		});
		const types = await recordTypes(spool, SESSION_ID);
		await rm(root, { recursive: true, force: true });
		return { stdout, types };
	}

	it("策略允许时输出 allow，不产生 approval 事件", async () => {
		const r = await runWithApproval("agy", "run_command");
		expect(r.stdout).toBe('{"decision":"allow"}');
		expect(r.types).toEqual(["tool"]);
	});

	it("命中策略的工具输出 ask 并额外落一条 approval 事件", async () => {
		const r = await runWithApproval("agy", "run_command", { mode: "ask", tools: ["run_command"] });
		expect(r.stdout).toBe('{"decision":"ask"}');
		// 同一毫秒内两条事件按文件名排序，顺序不重要，集合才是断言对象。
		expect([...r.types].sort()).toEqual(["approval", "tool"]);
	});

	it("通配 * 与未命中工具的区别", async () => {
		expect((await runWithApproval("agy", "read_file", { mode: "ask", tools: ["*"] })).stdout).toBe(
			'{"decision":"ask"}',
		);
		expect((await runWithApproval("agy", "read_file", { mode: "ask", tools: ["run_command"] })).stdout).toBe(
			'{"decision":"allow"}',
		);
	});

	it("claude 不受影响（无 allow 决策输出）", async () => {
		const r = await runWithApproval("claude", "run_command", { mode: "ask", tools: ["*"] });
		expect(r.stdout).toBe("");
	});
});
