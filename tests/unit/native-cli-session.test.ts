import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { mkdir, mkdtemp, open, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	prepareNativeCliSessionLaunch,
	type NativeCliSessionLaunch,
	type NativeCliSessionEvent,
} from "../../server/native-cli-session.js";
import type { NativeCliSessionContext } from "../../server/native-cli-session.js";

const os = vi.hoisted(() => ({ home: "" }));
vi.mock("node:os", async (importOriginal) => ({
	...(await importOriginal<typeof import("node:os")>()),
	homedir: () => os.home,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
	const fs = await importOriginal<typeof import("node:fs/promises")>();
	return { ...fs, open: vi.fn(fs.open) };
});
const key = "11111111-1111-4111-8111-111111111111";
const nativeId = "22222222-2222-4222-8222-222222222222";
let root: string;
let ctx: NativeCliSessionContext;
let launches: NativeCliSessionLaunch[];
let received: NativeCliSessionEvent[];
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "native-cli-session-"));
	os.home = join(root, "home");
	await mkdir(os.home);
	vi.stubEnv("CODEX_HOME", join(os.home, ".codex"));
	vi.stubEnv("CLAUDE_CONFIG_DIR", join(os.home, ".claude"));
	received = [];
	ctx = { cwd: root, dataDir: root, onEvent: (event) => received.push(event) };
	launches = [];
	vi.mocked(open).mockClear();
});
afterEach(async () => {
	for (const launch of launches) await launch.dispose();
	vi.useRealTimers();
	vi.unstubAllEnvs();
	await rm(root, { recursive: true, force: true });
});
async function prepare(preset: "pi" | "claude" | "codex" | "agy" | "custom", args: string[] = [], ref = { key }) {
	const launch = await prepareNativeCliSessionLaunch({ preset, args }, ref, ctx);
	launches.push(launch);
	return launch;
}
async function event(eventId: string, type: string, id?: string) {
	const dir = join(root, "native-cli", key, "events");
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, `${eventId}.json`), JSON.stringify({ eventId, type, ...(id ? { nativeId: id } : {}) }));
}
async function claudeTranscript(id = key) {
	const dir = join(os.home, ".claude", "projects", "test-project");
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, `${id}.jsonl`), "{}\n");
}

async function durableNativeId(id: string) {
	const directory = join(root, "native-cli", key);
	await mkdir(directory, { recursive: true });
	await writeFile(join(directory, "native-id"), id);
}
async function transcript(preset: "claude" | "pi" | "codex", id: string, archived = false): Promise<string> {
	if (preset === "claude") {
		await claudeTranscript(id);
		return id;
	}
	const directory =
		preset === "pi"
			? join(root, "pi-sessions")
			: archived
				? join(os.home, ".codex", "archived_sessions")
				: join(os.home, ".codex", "sessions", "2026", "11", "07");
	await mkdir(directory, { recursive: true });
	const file = join(directory, preset === "pi" ? id + ".jsonl" : "rollout-2026-11-07T00-00-00-" + id + ".jsonl");
	await writeFile(file, "{}\n");
	return preset === "pi" ? file : id;
}

describe("native CLI exact session binding", () => {
	it("fixes the first Claude UUID and recovers a transcript after a server crash", async () => {
		const launch = await prepare("claude", ["--model", "chosen"]);
		expect(launch.config.args).toContain("--session-id");
		expect(launch.config.args).toContain(key);
		expect(launch.ref.nativeId).toBeUndefined();
		await claudeTranscript();
		const resumed = await prepare("claude");
		expect(resumed.config.args).toContain("--resume");
		expect(resumed.ref.nativeId).toBe(key);
	});
	it("safely restarts an empty Claude launch even if its SessionStart reporter ran", async () => {
		await event("100", "session", key);
		const launch = await prepare("claude");
		expect(launch.config.args).toContain("--session-id");
		expect(launch.config.args).not.toContain("--resume");
	});
	it("reports missing bound Claude/Pi transcripts rather than selecting cwd's latest", async () => {
		await expect(prepare("claude", [], { key, nativeId } as any)).rejects.toThrow("no longer exists");
		await expect(prepare("pi", [], { key, nativeId: join(root, "missing.jsonl") } as any)).rejects.toThrow(
			"no longer exists",
		);
	});
	it("leaves explicit Claude resume/settings and other user flags intact", async () => {
		const args = ["--resume", nativeId, "--settings", '{"hooks":{"Stop":[]}}', "--model", "chosen"];
		const launch = await prepare("claude", args, { key, nativeId: "bad-bound-id" } as any);
		expect(launch.config.args).toEqual(args);
		expect(launch.capabilities.events).toBe("process");
	});
	it("binds Pi to a private exact path and recovers it without a recent-session heuristic", async () => {
		const first = await prepare("pi");
		const file = first.config.args![first.config.args!.indexOf("--session") + 1];
		expect(file).toContain(key);
		expect(first.config.args).not.toContain("--continue");
		await writeFile(file, "{}\n");
		const second = await prepare("pi");
		expect(second.ref.nativeId).toBe(file);
		expect(second.config.args).toContain(file);
	});
	it("preserves Pi explicit sessions and extension flags", async () => {
		const launch = await prepare("pi", ["--session", "user-session.jsonl", "--extension", "user-extension.ts"]);
		expect(launch.config.args!.filter((x) => x === "--session")).toHaveLength(1);
		expect(launch.config.args).toContain("user-extension.ts");
		expect(launch.config.args).not.toContain("--session-dir");
	});
	it("captures Codex thread identity before deciding resume after a crash", async () => {
		await transcript("codex", nativeId);
		await event("100", "session", nativeId);
		const launch = await prepare("codex", ["--model", "chosen"]);
		expect(launch.ref.nativeId).toBe(nativeId);
		expect(launch.config.args!.slice(-4)).toEqual(["resume", nativeId, "--model", "chosen"]);
		expect(launch.config.args).not.toContain("--last");
	});
	it("recovers Codex identity from private metadata after event rotation", async () => {
		await transcript("codex", nativeId);
		await event("100", "working", "33333333-3333-4333-8333-333333333333");
		await writeFile(join(root, "native-cli", key, "native-id"), nativeId);
		const launch = await prepare("codex");
		expect(launch.ref.nativeId).toBe(nativeId);
		expect(launch.config.args!.slice(-2)).toEqual(["resume", nativeId]);
	});
	it("preserves a user's Codex Stop hook but still injects SessionStart for identity", async () => {
		await mkdir(join(os.home, ".codex"));
		await writeFile(
			join(os.home, ".codex", "config.toml"),
			'[[hooks.Stop]]\nmatcher="x"\n[[hooks.Stop.hooks]]\ncommand="user-hook"\ntype="command"\n',
		);
		const launch = await prepare("codex");
		expect(launch.config.args!.some((x) => x.startsWith("hooks.Stop="))).toBe(false);
		expect(launch.config.args!.some((x) => x.startsWith("hooks.SessionStart="))).toBe(true);
		expect(launch.capabilities).toEqual({ resume: "exact", events: "process" });
	});
	it.each(["codex-home", "project"] as const)(
		"preserves quoted TOML Stop hooks from %s configuration files",
		async (location) => {
			const codexHome = join(root, "custom-codex-home");
			vi.stubEnv("CODEX_HOME", codexHome);
			const directory = location === "codex-home" ? codexHome : join(root, ".codex");
			await mkdir(directory, { recursive: true });
			const declarations = [
				'"hooks".Stop=[]',
				"'hooks'.'Stop'=[]",
				" \"hooks\" . 'Stop' = []",
				'["hooks"."Stop"]\nhooks=[]',
				"[[ 'hooks' . 'Stop' ]]\nmatcher='*'\nhooks=[{type='command',command='user-hook'}]",
				'["hooks"]\n"Stop"=[]',
				'"hooks" = { "Stop" = [] }',
				'"ho\\u006fks"."St\\u006fp"=[]',
			];
			for (const declaration of declarations) {
				const file = join(directory, "config.toml");
				await writeFile(file, declaration);
				const launch = await prepare("codex");
				expect(
					launch.config.args!.some((arg) => arg.startsWith("hooks.Stop=")),
					declaration,
				).toBe(false);
				expect(
					launch.config.args!.some((arg) => arg.startsWith("hooks.SessionStart=")),
					declaration,
				).toBe(true);
				expect(
					launch.config.args!.some((arg) => arg.startsWith("hooks.PermissionRequest=")),
					declaration,
				).toBe(true);
				expect(launch.capabilities, declaration).toEqual({ resume: "exact", events: "process" });
				expect(await readFile(file, "utf8")).toBe(declaration);
			}
		},
	);
	it("does not replace user Codex notify or config flags", async () => {
		const args = ["--config", 'notify=["user"]', "--config", "hooks.SessionStart=[]"];
		const launch = await prepare("codex", args);
		expect(launch.config.args!.slice(-args.length)).toEqual(args);
		expect(launch.config.args!.filter((x) => x.startsWith("hooks.SessionStart="))).toHaveLength(1);
		expect(launch.capabilities.resume).toBe("explicit-only");
	});
	it.each(["claude", "codex"] as const)("wires %s UserPromptSubmit to the narrow submitted signal", async (preset) => {
		const launch = await prepare(preset);
		if (preset === "claude") {
			const settings = JSON.parse(launch.config.args![launch.config.args!.indexOf("--settings") + 1]);
			expect(settings.hooks.UserPromptSubmit[0].hooks[0].command).toMatch(/ submitted$/);
		} else {
			const hook = launch.config.args!.find((arg) => arg.startsWith("hooks.UserPromptSubmit="));
			expect(hook).toContain(" submitted");
			expect(hook).not.toContain(" working");
		}
	});
	it("does not treat a Codex model value as the resume subcommand", async () => {
		const launch = await prepare("codex", ["--model", "resume"], { key, nativeId } as any);
		expect(launch.config.args!.slice(-4)).toEqual(["resume", nativeId, "--model", "resume"]);
	});
	it("marks explicit latest-session/picker options honestly and preserves them", async () => {
		for (const preset of ["pi", "claude"] as const) {
			const launch = await prepare(preset, ["--continue"]);
			expect(launch.capabilities.resume).toBe("explicit-only");
			expect(launch.config.args).not.toContain("--session-dir");
		}
		const codex = await prepare("codex", ["resume", "--last"]);
		expect(codex.capabilities.resume).toBe("explicit-only");
	});
	it("keeps agy and custom honest about process-only lifecycle and initial identity", async () => {
		const agy = await prepare("agy");
		expect(agy.config.args).toEqual([]);
		expect(agy.capabilities).toEqual({ resume: "explicit-only", events: "process" });
		const custom = await prepare("custom", ["--my-option"]);
		expect(custom.config.args).toEqual(["--my-option"]);
		expect(custom.capabilities).toEqual({ resume: "none", events: "process" });
	});
	it("inserts internal flags before -- without consuming user prompt arguments", async () => {
		const launch = await prepare("pi", ["--", "--session", "this is prompt content"]);
		expect(launch.config.args!.slice(-3)).toEqual(["--", "--session", "this is prompt content"]);
		expect(launch.config.args!.filter((x) => x === "--session")).toHaveLength(2);
	});
});

describe("native CLI process restart boundaries", () => {
	it.each([false, true])("handles pending old activity with observeOnly=%s", async (observeOnly) => {
		await event("050", "working");
		await event("100", "working");
		await event("200", "question");
		await event("300", "approval");
		await event("350", "submitted");
		await event("400", "done");
		await event("500", "error");
		ctx.lastEventId = "050";
		ctx.observeOnly = observeOnly;
		const launch = await prepare("pi");
		launch.start();
		await launch.flush();
		expect(received.map((current) => current.type)).toEqual(
			observeOnly ? ["working", "question", "approval", "submitted", "done", "error"] : ["submitted", "done", "error"],
		);
	});
	it.each(["claude", "pi", "codex"] as const)(
		"prefers the persisted current %s identity without replaying old roots or activity",
		async (preset) => {
			const old = await transcript(preset, nativeId);
			const current = await transcript(preset, "33333333-3333-4333-8333-333333333333");
			await transcript(preset, "44444444-4444-4444-8444-444444444444");
			await durableNativeId(current);
			await event("050", "working", old);
			await event("100", "session", old);
			await event("200", "session", current);
			await event("250", "working", current);
			await event("260", "question", current);
			await event("270", "approval", current);
			await event("300", "done", current);
			await event("310", "error", current);
			ctx.lastEventId = "050";
			const launch = await prepare(preset, [], { key, nativeId: old } as any);
			expect(launch.ref.nativeId).toBe(current);
			expect(launch.config.args).toContain(current);
			expect(launch.config.args).not.toContain(old);
			expect(vi.mocked(open).mock.calls.some((call) => String(call[0]).endsWith(".jsonl"))).toBe(false);
			launch.start();
			await launch.flush();
			expect(received.map((event) => [event.type, event.eventId])).toEqual([
				["done", "300"],
				["error", "310"],
			]);
			expect(launch.ref.nativeId).toBe(current);
		},
	);
	it.each(["claude", "pi", "codex"] as const)(
		"ignores missing or malformed durable %s IDs while retaining a known binding",
		async (preset) => {
			const old = await transcript(preset, nativeId);
			const absent = preset === "pi" ? join(root, "missing-pi-session.jsonl") : "33333333-3333-4333-8333-333333333333";
			for (const candidate of [absent, "invalid\nid"]) {
				await durableNativeId(candidate);
				const launch = await prepare(preset, [], { key, nativeId: old } as any);
				expect(launch.ref.nativeId).toBe(old);
				expect(launch.config.args).toContain(old);
				expect(launch.config.args).not.toContain(candidate);
			}
		},
	);
	it.each(["claude", "pi"] as const)(
		"still errors for a missing known %s transcript when durable recovery cannot replace it",
		async (preset) => {
			const old = preset === "pi" ? join(root, "old-missing.jsonl") : nativeId;
			await durableNativeId(preset === "pi" ? join(root, "new-missing.jsonl") : "33333333-3333-4333-8333-333333333333");
			await expect(prepare(preset, [], { key, nativeId: old } as any)).rejects.toThrow("no longer exists");
		},
	);
	it.each(["claude", "pi", "codex"] as const)(
		"preserves explicit %s session parameters over durable current identity",
		async (preset) => {
			const old = await transcript(preset, nativeId);
			const current = await transcript(preset, "33333333-3333-4333-8333-333333333333");
			await durableNativeId(current);
			const args = [preset === "claude" ? "--resume" : preset === "pi" ? "--session" : "resume", old];
			const launch = await prepare(preset, args, { key, nativeId: old } as any);
			expect(launch.ref.nativeId).toBe(old);
			expect(launch.config.args).toContain(old);
			expect(launch.config.args).not.toContain(current);
		},
	);
	it("starts a new Codex session when an unbound durable ID has no persisted rollout", async () => {
		await durableNativeId("33333333-3333-4333-8333-333333333333");
		const launch = await prepare("codex");
		expect(launch.ref.nativeId).toBeUndefined();
		expect(launch.config.args).not.toContain("resume");
	});
	it("recovers an exact archived Codex rollout without selecting another thread", async () => {
		await transcript("codex", nativeId);
		const current = await transcript("codex", "33333333-3333-4333-8333-333333333333", true);
		await durableNativeId(current);
		const launch = await prepare("codex", [], { key, nativeId } as any);
		expect(launch.ref.nativeId).toBe(current);
		expect(launch.config.args!.slice(-2)).toEqual(["resume", current]);
	});
	it.each([false, true])("validates remote Codex durable rollout existence=%s using exact IDs", async (persisted) => {
		const current = "33333333-3333-4333-8333-333333333333";
		const execute = vi.fn(async (_uri: string, command: string) => {
			let stdout = "";
			if (command.startsWith("printf '%s'"))
				stdout = command.includes("CODEX_HOME") ? "/mock/codex-home" : "/mock/home";
			else if (command.includes("bs=1024 count=1")) stdout = current;
			else if (command.startsWith("for f in") && command.includes("rollout-*-")) stdout = persisted ? "yes" : "";
			return { stdout, stderr: "", exitCode: 0 };
		});
		ctx.cwd = "ssh://fixture/work";
		ctx.service = { execInWorkspace: execute } as any;
		const launch = await prepare("codex", [], { key, nativeId } as any);
		expect(launch.ref.nativeId).toBe(persisted ? current : nativeId);
		expect(launch.config.args!.slice(-2)).toEqual(["resume", persisted ? current : nativeId]);
		expect(
			execute.mock.calls.some((call) => call[1].includes("rollout-*-'") && call[1].includes(current + ".jsonl")),
		).toBe(true);
	});
});

describe("native CLI observe-only attachment", () => {
	it.each(["claude", "pi", "codex"] as const)(
		"observes %s without its missing transcript or changing launch/configuration files",
		async (preset) => {
			ctx.observeOnly = true;
			await event("100", "working", nativeId);
			const directory = join(root, "native-cli", key);
			await writeFile(join(directory, "native-id"), nativeId);
			await writeFile(join(directory, "hook.sh"), "existing running-process hook");
			await mkdir(join(os.home, ".codex"));
			const settings = join(os.home, ".codex", "config.toml");
			await writeFile(settings, '[[hooks.Stop]]\nuser = "leave untouched"');
			const config = { preset, executable: join(root, "removed-cli.exe"), args: ["--model", "old-provider-model"] };
			const launch = await prepareNativeCliSessionLaunch(
				config,
				{ key, nativeId: join(root, "missing-transcript.jsonl") },
				ctx,
			);
			launches.push(launch);
			expect(launch.config).toBe(config);
			expect(launch.ref.nativeId).toBe(nativeId);
			expect(vi.mocked(open).mock.calls.some((call) => String(call[0]).includes("config.toml"))).toBe(false);
			expect(await readFile(settings, "utf8")).toBe('[[hooks.Stop]]\nuser = "leave untouched"');
			expect(await readFile(join(directory, "hook.sh"), "utf8")).toBe("existing running-process hook");
			expect((await readdir(directory)).sort()).toEqual(["events", "hook.sh", "native-id"]);
			await event("200", "done", nativeId);
			launch.start();
			await launch.flush();
			expect(received).toEqual([{ type: "done", eventId: "200" }]);
		},
	);
	it("preserves a known native ID when its transcript and all observation files are missing", async () => {
		ctx.observeOnly = true;
		const config = { preset: "claude" as const };
		const launch = await prepareNativeCliSessionLaunch(config, { key, nativeId }, ctx);
		launches.push(launch);
		expect(launch.config).toBe(config);
		expect(launch.ref).toEqual({ key, nativeId });
		expect(launch.capabilities.events).toBe("process");
		launch.start();
		await launch.flush();
		expect(received).toContainEqual(expect.objectContaining({ type: "error", code: "event_observer" }));
		expect(await readdir(root)).toEqual(["home"]);
	});
	it("reads remote binding/events without modifying scripts, settings or the running process", async () => {
		ctx.observeOnly = true;
		ctx.cwd = "ssh://fixture/work";
		let type = "working";
		const execute = vi.fn(async (_uri: string, command: string) => ({
			stdout: command.includes('"$HOME"')
				? "/srv/home"
				: command.includes("/*.json")
					? JSON.stringify({ eventId: type === "working" ? "100" : "200", type, nativeId })
					: nativeId,
			stderr: "",
			exitCode: 0,
		}));
		ctx.service = { execInWorkspace: execute } as any;
		const config = { preset: "codex" as const, executable: "/removed/bin/codex", args: ["--config", "hooks.Stop=[]"] };
		const launch = await prepareNativeCliSessionLaunch(config, { key, nativeId }, ctx);
		launches.push(launch);
		expect(launch.config).toBe(config);
		type = "done";
		launch.start();
		await launch.flush();
		expect(received).toEqual([{ type: "done", eventId: "200" }]);
		expect(execute.mock.calls.map((call) => call[1]).join("\n")).not.toMatch(
			/mkdir|chmod|mv -f|config\.toml|hook\.sh|resume/,
		);
	});
});

describe("native CLI event observation", () => {
	it("delivers whitelisted events once and stops callbacks while retaining tmux resources", async () => {
		const launch = await prepare("pi");
		await event("100", "approval");
		const stop = launch.start();
		await vi.waitFor(() => expect(received).toEqual([{ eventId: "100", type: "approval" }]));
		await vi.waitFor(() => expect(received).toHaveLength(1));
		stop();
		await event("200", "done");
		await launch.dispose();
		expect(received).toHaveLength(1);
		expect(await readFile(join(root, "native-cli", key, "pi-extension.mjs"), "utf8")).toContain("agent_settled");
	});
	it("ignores child-agent events with a different native identity", async () => {
		const launch = await prepare("codex");
		await event("100", "session", nativeId);
		await event("200", "done", "33333333-3333-4333-8333-333333333333");
		await event("300", "working", nativeId);
		launch.start();
		await launch.flush();
		expect(received).toEqual([
			{ type: "session", eventId: "100:session", nativeId, cursor: "100" },
			{ type: "working", eventId: "300" },
		]);
	});
	it("commits a raw SessionStart cursor and skips it after reconnect", async () => {
		const launch = await prepare("codex");
		await event("100", "session", nativeId);
		launch.start();
		await launch.flush();
		expect(received).toEqual([{ type: "session", eventId: "100:session", cursor: "100", nativeId }]);
		const session = received[0];
		if (session.type !== "session") throw new Error("Expected identity event");
		ctx.lastEventId = session.cursor;
		await launch.dispose();
		received.length = 0;
		ctx.observeOnly = true;
		const attached = await prepare("codex", [], launch.ref);
		attached.start();
		await attached.flush();
		expect(received).toEqual([]);
		expect(attached.ref.nativeId).toBe(nativeId);
	});
	it.each(["200", "200:session"])("does not replay old root identities after reconnect at %s", async (cursor) => {
		const nextId = "33333333-3333-4333-8333-333333333333";
		await event("100", "session", nativeId);
		await event("150", "working", nativeId);
		const launch = await prepare("codex", [], { key, nativeId } as any);
		await event("200", "session", nextId);
		launch.start();
		await launch.flush();
		expect(received).toEqual([{ type: "session", eventId: "200:session", cursor: "200", nativeId: nextId }]);
		await launch.dispose();
		received.length = 0;
		ctx.lastEventId = cursor;
		ctx.observeOnly = true;
		const attached = await prepare("codex", [], launch.ref);
		await event("300", "working", nextId);
		attached.start();
		await attached.flush();
		expect(received).toEqual([{ type: "working", eventId: "300" }]);
		expect(attached.ref.nativeId).toBe(nextId);
	});
	it.each(["submitted", "done"] as const)("preserves identity plus %s semantics from one raw record", async (type) => {
		const semanticIds = new Set<string>();
		ctx.onEvent = (current) => {
			if (semanticIds.has(current.eventId)) return;
			semanticIds.add(current.eventId);
			received.push(current);
			if (current.type !== "session") ctx.lastEventId = current.eventId;
			else if (current.cursor) ctx.lastEventId = current.cursor;
		};
		const launch = await prepare("codex");
		await event("100", type, nativeId);
		launch.start();
		await launch.flush();
		expect(received).toEqual([
			{ type: "session", eventId: "100:session", nativeId },
			{ type, eventId: "100" },
		]);
		expect(ctx.lastEventId).toBe("100");
		expect(semanticIds.size).toBe(2);
		await launch.flush();
		expect(received).toHaveLength(2);
	});
	it("does not commit a done cursor when observation stops after its derived identity", async () => {
		await event("050", "working");
		ctx.lastEventId = "050";
		let stop = () => {};
		ctx.onEvent = (current) => {
			received.push(current);
			if (current.type === "session") {
				if (current.cursor) ctx.lastEventId = current.cursor;
				stop();
			} else ctx.lastEventId = current.eventId;
		};
		const launch = await prepare("codex");
		await event("100", "done", nativeId);
		stop = launch.start();
		await launch.flush();
		expect(received).toEqual([{ type: "session", eventId: "100:session", nativeId }]);
		expect(ctx.lastEventId).toBe("050");
		await launch.dispose();
		ctx.observeOnly = true;
		ctx.onEvent = (current) => {
			received.push(current);
			if (current.type !== "session") ctx.lastEventId = current.eventId;
		};
		const attached = await prepare("codex", [], launch.ref);
		attached.start();
		await attached.flush();
		expect(received).toEqual([
			{ type: "session", eventId: "100:session", nativeId },
			{ type: "done", eventId: "100" },
		]);
		expect(ctx.lastEventId).toBe("100");
	});
	it("flushes final Stop events before disposal without replaying or emitting after detach", async () => {
		const launch = await prepare("pi");
		launch.start();
		await launch.flush();
		await event("100", "done");
		await Promise.all([launch.flush(), launch.flush()]);
		expect(received).toEqual([{ type: "done", eventId: "100" }]);
		await launch.dispose();
		await event("200", "done");
		await launch.flush();
		expect(received).toHaveLength(1);
	});
	it("retains official aborted settlement without turning it into a successful completion", async () => {
		const launch = await prepare("pi");
		await writeFile(
			join(root, "native-cli", key, "events", "100.json"),
			JSON.stringify({ type: "done", eventId: "100", aborted: true }),
		);
		launch.start();
		await launch.flush();
		expect(received).toEqual([{ type: "done", eventId: "100", aborted: true }]);
	});
	it("does not replay baseline submissions on reconnect and delivers a new submission only once", async () => {
		await event("100", "submitted");
		const initial = await prepare("pi");
		initial.start();
		await initial.flush();
		expect(received).toEqual([]);
		await initial.dispose();
		ctx.observeOnly = true;
		const reconnected = await prepare("pi");
		const stop = reconnected.start();
		await reconnected.flush();
		expect(received).toEqual([]);
		await event("200", "submitted");
		await Promise.all([reconnected.flush(), reconnected.flush()]);
		expect(received).toEqual([{ type: "submitted", eventId: "200" }]);
		stop();
		reconnected.start();
		await reconnected.flush();
		expect(received).toEqual([{ type: "submitted", eventId: "200" }]);
	});
	it("restores precise identity while suppressing historical done notifications without a marker", async () => {
		const file = join(root, "existing.jsonl");
		await writeFile(file, "{}\n");
		await event("100", "done", file);
		const launch = await prepare("pi");
		expect(launch.ref.nativeId).toBe(file);
		launch.start();
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(received).toEqual([]);
	});
	it("only consumes events after the parent's durable lastEventId", async () => {
		await event("100", "working");
		await event("200", "approval");
		await event("300", "done");
		ctx.lastEventId = "200";
		const launch = await prepare("pi");
		launch.start();
		await vi.waitFor(() => expect(received).toEqual([{ eventId: "300", type: "done" }]));
	});
	it("consumes retained live-process events when lastEventId has rotated out", async () => {
		await event("200", "question");
		ctx.lastEventId = "old-event";
		ctx.observeOnly = true;
		const launch = await prepare("pi");
		launch.start();
		await vi.waitFor(() => expect(received).toEqual([{ eventId: "200", type: "question" }]));
	});
	it("suppresses late callbacks when the consumer stops observation synchronously", async () => {
		const launch = await prepare("pi");
		await event("100", "approval");
		await event("200", "done");
		let stop = () => {};
		ctx.onEvent = (current) => {
			received.push(current);
			stop();
		};
		stop = launch.start();
		await vi.waitFor(() => expect(received).toHaveLength(1));
		expect(received[0].type).toBe("approval");
	});
	it("runs remote preparation and bounded polling with POSIX tools and retains its scripts", async () => {
		const execute = vi.fn(
			(_uri: string, command: string, options: any) =>
				new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve, reject) => {
					const child = spawn("bash", ["-c", command], {
						cwd: root,
						env: { ...process.env, HOME: os.home.replace(/\\/g, "/"), CODEX_HOME: "", CLAUDE_CONFIG_DIR: "" },
						signal: options.signal,
					});
					let stdout = "";
					let stderr = "";
					child.stdout.on("data", (data) => {
						stdout += data;
					});
					child.stderr.on("data", (data) => {
						stderr += data;
					});
					child.on("error", reject);
					child.on("close", (code) => resolve({ stdout, stderr, exitCode: code ?? 1 }));
				}),
		);
		ctx.service = { execInWorkspace: execute } as any;
		ctx.cwd = "ssh://fixture/work";
		const launch = await prepare("pi");
		const directory = join(os.home, ".pi-web", "native-cli", key);
		await writeFile(join(directory, "events", "100.json"), '{"eventId":"100","type":"done"}');
		launch.start();
		await vi.waitFor(() => expect(received).toEqual([{ type: "done", eventId: "100" }]));
		await launch.dispose();
		expect(await readFile(join(directory, "pi-extension.mjs"), "utf8")).toContain("agent_settled");
		expect(execute.mock.calls.every((call) => call[2].timeoutMs === 5000)).toBe(true);
		expect(execute.mock.calls.map((call) => call[1]).join("\\n")).not.toMatch(/python|node -/);
	});
	it("handles cancellation before launch with no listener or process left behind", async () => {
		const abort = new AbortController();
		abort.abort();
		ctx.signal = abort.signal;
		await expect(prepare("pi")).rejects.toThrow();
		expect(await readdir(root)).toEqual(["home"]);
	});
	it("isolates a failing event consumer from the polling promise", async () => {
		ctx.onEvent = () => {
			throw new Error("consumer failure");
		};
		const launch = await prepare("pi");
		await event("100", "done");
		launch.start();
		await new Promise((resolve) => setTimeout(resolve, 30));
		await expect(launch.dispose()).resolves.toBeUndefined();
	});
});
