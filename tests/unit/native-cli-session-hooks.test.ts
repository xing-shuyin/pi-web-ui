import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
	nativeCliCodexHookConflicts,
	nativeCliPiExtension,
	nativeCliPosixReporter,
	parseNativeCliHookEvent,
} from "../../server/native-cli-session-hooks.js";

const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "native-cli-hook-"));
	roots.push(root);
	await mkdir(join(root, "events"));
	return root;
}
function hook(file: string, kind: string, payload: unknown): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn("bash", [file, kind], { stdio: ["pipe", "pipe", "pipe"] });
		const timer = setTimeout(() => {
			child.kill();
			reject(new Error("hook timeout"));
		}, 5000);
		child.on("error", reject);
		child.on("close", (code) => {
			clearTimeout(timer);
			code === 0 ? resolve() : reject(new Error("hook failed"));
		});
		child.stdin.on("error", () => {});
		child.stdin.end(JSON.stringify(payload));
	});
}

describe("native CLI lifecycle reporters", () => {
	it("whitelists tiny stable events and drops all hook content", () => {
		expect(
			parseNativeCliHookEvent(
				JSON.stringify({ type: "approval", eventId: "123-456", prompt: "secret", tool_input: { key: "secret" } }),
			),
		).toEqual({ type: "approval", eventId: "123-456" });
		expect(parseNativeCliHookEvent('{"eventId":"../bad","type":"done"}')).toBeUndefined();
		expect(parseNativeCliHookEvent(" ".repeat(2049))).toBeUndefined();
		expect(parseNativeCliHookEvent('{"eventId":"ok","type":"screen_text"}')).toBeUndefined();
	});

	it("executes a real POSIX reporter without persisting prompts, tool args or secrets", async () => {
		const root = await fixture();
		const file = join(root, "hook.sh");
		await writeFile(file, nativeCliPosixReporter(root.replace(/\\/g, "/")));
		await hook(file, "approval", {
			session_id: "11111111-1111-4111-8111-111111111111",
			prompt: "private prompt",
			tool_input: { api_key: "private api key" },
		});
		const names = await readdir(join(root, "events"));
		expect(names).toHaveLength(1);
		const record = await readFile(join(root, "events", names[0]), "utf8");
		expect(parseNativeCliHookEvent(record)).toMatchObject({
			type: "approval",
			nativeId: "11111111-1111-4111-8111-111111111111",
		});
		expect(record).not.toContain("private");
		expect(record).not.toContain("tool_input");
	});

	it("reports submitted only for the official top-level UserPromptSubmit event", async () => {
		const root = await fixture();
		const file = join(root, "hook.sh");
		await writeFile(file, nativeCliPosixReporter(root.replace(/\\/g, "/")));
		for (const hook_event_name of [null, "Stop", "PreToolUse"]) {
			await hook(file, "submitted", {
				hook_event_name,
				prompt: "UserPromptSubmit",
				tool_input: { hook_event_name: "UserPromptSubmit" },
			});
		}
		expect(await readdir(join(root, "events"))).toEqual([]);
		await hook(file, "submitted", {
			hook_event_name: "UserPromptSubmit",
			session_id: "11111111-1111-4111-8111-111111111111",
			prompt: "private user submission",
		});
		const files = await readdir(join(root, "events"));
		expect(files).toHaveLength(1);
		const record = await readFile(join(root, "events", files[0]), "utf8");
		expect(parseNativeCliHookEvent(record)).toMatchObject({
			type: "submitted",
			nativeId: "11111111-1111-4111-8111-111111111111",
		});
		expect(record).not.toContain("private");
	});

	it("reads only top-level official fields, ignoring prompt strings and nested tool arguments", async () => {
		const root = await fixture();
		const file = join(root, "hook.sh");
		await writeFile(file, nativeCliPosixReporter(root.replace(/\\/g, "/")));
		await hook(file, "working", {
			session_id: "11111111-1111-4111-8111-111111111111",
			tool_input: { session_id: "22222222-2222-4222-8222-222222222222" },
			prompt: '\\"session_id\\": \\"33333333-3333-4333-8333-333333333333\\"',
		});
		const names = await readdir(join(root, "events"));
		expect(parseNativeCliHookEvent(await readFile(join(root, "events", names[0]), "utf8"))?.nativeId).toBe(
			"11111111-1111-4111-8111-111111111111",
		);
		await hook(file, "notification", {
			notification_type: "idle_prompt",
			message: '\\"permission_prompt\\"',
			tool_input: { notification_type: "permission_prompt" },
		});
		expect(await readdir(join(root, "events"))).toHaveLength(1);
	});

	it("keeps a private root identity independent of rotated or child-agent events", async () => {
		const root = await fixture();
		const file = join(root, "hook.sh");
		await writeFile(file, nativeCliPosixReporter(root.replace(/\\/g, "/")));
		await hook(file, "session", { session_id: "11111111-1111-4111-8111-111111111111" });
		await hook(file, "done", { session_id: "22222222-2222-4222-8222-222222222222" });
		expect(await readFile(join(root, "native-id"), "utf8")).toBe("11111111-1111-4111-8111-111111111111");
	});

	it("bounds retained event files and interprets official notification types only", async () => {
		const root = await fixture();
		const file = join(root, "hook.sh");
		await writeFile(file, nativeCliPosixReporter(root.replace(/\\/g, "/")));
		await Promise.all(
			Array.from({ length: 132 }, (_, index) =>
				writeFile(join(root, "events", `${String(index).padStart(6, "0")}.json`), "{}"),
			),
		);
		await hook(file, "notification", { notification_type: "permission_prompt", message: "anything" });
		expect((await readdir(join(root, "events"))).length).toBe(128);
		await hook(file, "notification", { notification_type: "idle_prompt", message: "waiting for approval" });
		expect((await readdir(join(root, "events"))).length).toBe(128);
	});

	it("uses Pi final settlement and official waiting spans", async () => {
		const root = await fixture();
		const file = join(root, "extension.mjs");
		await writeFile(file, nativeCliPiExtension(root));
		const extension = await import(/* @vite-ignore */ "file:///" + file.replace(/\\/g, "/"));
		const handlers = new Map<string, Function>();
		extension.default({
			on(name: string, handler: Function) {
				handlers.set(name, handler);
			},
		});
		expect(handlers.has("agent_end")).toBe(false);
		const ctx = { sessionManager: { getSessionFile: () => undefined }, isIdle: () => false };
		handlers.get("ui_prompt_start")!({ kind: "confirm", title: "private title" }, ctx);
		handlers.get("agent_settled")!({ aborted: true }, ctx);
		const records = await Promise.all(
			(await readdir(join(root, "events"))).map(async (name) =>
				parseNativeCliHookEvent(await readFile(join(root, "events", name), "utf8")),
			),
		);
		expect(records.map((record) => record?.type).sort()).toEqual(["approval", "done"]);
		expect(records.find((record) => record?.type === "done")).toMatchObject({ aborted: true });
		expect(JSON.stringify(records)).not.toContain("private");
	});

	it("reports Pi submissions once for interactive input and excludes RPC/extension input", async () => {
		const root = await fixture();
		const file = join(root, "extension.mjs");
		await writeFile(file, nativeCliPiExtension(root));
		const extension = await import(/* @vite-ignore */ "file:///" + file.replace(/\\/g, "/"));
		const handlers = new Map<string, Function>();
		extension.default({
			on(name: string, handler: Function) {
				handlers.set(name, handler);
			},
		});
		const ctx = { sessionManager: { getSessionFile: () => undefined }, isIdle: () => false };
		for (const source of ["rpc", "extension", null, "unknown"]) {
			expect(handlers.get("input")!({ source, text: "private injected input" }, ctx)).toBeUndefined();
		}
		expect(await readdir(join(root, "events"))).toEqual([]);
		expect(handlers.get("input")!({ source: "interactive", text: "private user input" }, ctx)).toBeUndefined();
		handlers.get("agent_start")!({}, ctx);
		handlers.get("ui_prompt_end")!({}, ctx);
		handlers.get("agent_settled")!({}, ctx);
		const records = await Promise.all(
			(await readdir(join(root, "events"))).map(async (name) =>
				parseNativeCliHookEvent(await readFile(join(root, "events", name), "utf8")),
			),
		);
		expect(records.filter((record) => record?.type === "submitted")).toHaveLength(1);
		expect(records.some((record) => record?.type === "working")).toBe(true);
		expect(JSON.stringify(records)).not.toContain("private");
	});

	it.each([
		['[[hooks.Stop]]\nmatcher="x"', ["Stop"]],
		["hooks = { SessionStart = [], Stop = [] }", ["SessionStart", "Stop"]],
		["hooks.Stop=[]", ["Stop"]],
		["--config\nhooks.PermissionRequest=[]", ["PermissionRequest"]],
		['model = "x"\nnotify = ["custom-notifier"]', []],
		['"hooks".Stop=[]', ["Stop"]],
		["'hooks'.'Stop'=[]", ["Stop"]],
		[" \"hooks\" . 'Stop' = []", ["Stop"]],
		['["hooks"."Stop"]\nhooks=[]', ["Stop"]],
		["[[ 'hooks' . 'Stop' ]]\nhooks=[]", ["Stop"]],
		['["hooks"]\n"Stop"=[]', ["Stop"]],
		['"hooks" = { "Stop" = [] }', ["Stop"]],
		['"ho\\u006fks"."St\\u006fp"=[]', ["Stop"]],
		['"\\U00000068ooks"."Stop"=[]', ["Stop"]],
		['--config\n"hooks" . "PermissionRequest" = []', ["PermissionRequest"]],
	])("detects hook conflicts per event: %s", (text, conflicts) => {
		expect([...nativeCliCodexHookConflicts(text)].sort()).toEqual(conflicts.sort());
	});
});
