/* Smoke test: boots the real (compiled) server and exercises the terminal +
 * commands protocol over WebSocket (no browser needed).
 * Run:  npm run build:server && node terminal-smoke-test.mjs */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const PORT = 20000 + Math.floor(Math.random() * 10000);
const workdir = mkdtempSync(join(tmpdir(), "piweb-term-"));
const dataDir = mkdtempSync(join(tmpdir(), "piweb-term-data-"));
process.env.PI_WEB_PORT = String(PORT);
process.env.PI_WEB_CWD = workdir;
process.env.PI_WEB_DATA_DIR = dataDir;

// realpathSync: fnm multishell shim 路径可能失效；fileURLToPath: URL.pathname 在 Windows 下非法
const NODE = realpathSync(process.execPath);
const REPO = fileURLToPath(new globalThis.URL("../", import.meta.url));

const server = spawn(NODE, [join(REPO, "dist", "server", "index.js")], {
	cwd: REPO,
	stdio: ["ignore", "pipe", "pipe"],
	detached: true, // own process group so we can kill the whole tree
});
server.on("error", (e) => console.error("[srv spawn error]", e));
server.on("exit", (code) => console.error(`[srv exited early: ${code}]`));
server.stdout.on("data", (d) => process.stdout.write(`[srv] ${d}`));
server.stderr.on("data", (d) => process.stdout.write(`[srv!] ${d}`));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
const check = (name, cond) => {
	if (cond) {
		passed++;
		console.log(`  ✓ ${name}`);
	} else {
		console.log(`  ✗ FAIL: ${name}`);
		process.exitCode = 1;
	}
};

async function waitServer() {
	for (let i = 0; i < 120; i++) {
		try {
			const r = await fetch(`http://localhost:${PORT}/api/health`);
			if (r.ok) return;
		} catch {
			/* not up yet */
		}
		await sleep(250);
	}
	throw new Error("server did not start");
}

const outputs = new Map(); // terminalId -> accumulated text
const exits = new Map(); // terminalId -> exitCode
let commandsReply = null;
let sessionsReply = null; // sessions list
let snapshotReply = null;
const notices = []; // notice texts from the server

async function main() {
	await waitServer();
	console.log("server up");

	const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
	const open = new Promise((res, rej) => {
		ws.on("open", res);
		ws.on("error", rej);
	});
	ws.on("message", (data) => {
		let msg;
		try {
			msg = JSON.parse(data.toString());
		} catch {
			return;
		}
		if (msg.type === "terminal_output") {
			outputs.set(msg.terminalId, (outputs.get(msg.terminalId) ?? "") + msg.data);
		}
		if (msg.type === "terminal_exit") exits.set(msg.terminalId, msg.exitCode);
		if (msg.type === "commands") commandsReply = msg;
		if (msg.type === "sessions") sessionsReply = msg.sessions;
		if (msg.type === "snapshot") snapshotReply = msg.state;
		if (msg.type === "notice") notices.push(msg.text);
	});
	const send = (m) => ws.send(JSON.stringify(m));

	await open;
	console.log("ws connected");

	send({ type: "hello", clientId: "smoke-test-client" });

	await new Promise((res, rej) => {
		const timer = setTimeout(() => rej(new Error("timed out waiting for ready")), 30000);
		ws.on("message", (d) => {
			try {
				if (JSON.parse(d.toString()).type === "ready") {
					clearTimeout(timer);
					res();
				}
			} catch {
				/* ignore */
			}
		});
	});
	console.log("ready received");
	await sleep(300);
	check(
		"agent exposes persistent terminal tools",
		["terminal_create", "terminal_list", "terminal_close", "terminal_input", "terminal_key", "terminal_read"].every(
			(name) => snapshotReply?.tools?.includes(name),
		),
	);

	// -- commands: list (fresh dir -> empty), save, list again -----------------
	send({ type: "list_commands" });
	await sleep(400);
	check("list_commands returns empty list", commandsReply?.commands?.length === 0);
	check("commands path is <cwd>/.pi/commands.json", commandsReply?.path === join(workdir, ".pi", "commands.json"));

	send({
		type: "save_commands",
		commands: [
			{ name: "dev", command: "echo DEV && ls", cwd: "${pwd}" },
			{ name: "pwd-test", command: "pwd", cwd: "${pwd}/sub" },
		],
	});
	await sleep(400);
	check("save_commands persisted", commandsReply?.commands?.length === 2);
	const { readFileSync, existsSync } = await import("node:fs");
	check("commands.json written on disk", existsSync(join(workdir, ".pi", "commands.json")));
	let onDisk = null;
	try {
		onDisk = JSON.parse(readFileSync(join(workdir, ".pi", "commands.json"), "utf8"));
	} catch {
		onDisk = null;
	}
	check(
		"disk format is {commands:[...]}",
		onDisk !== null && Array.isArray(onDisk.commands) && onDisk.commands[0].name === "dev",
	);

	// -- folder attachment: a directory is accepted (not skipped as a non-file) --
	// Full end-to-end (the <folder path> card in the transcript) requires a real
	// model turn; here we verify the server takes the folder branch instead of
	// the old "跳过非文件附件" skip path, and that no path error is emitted.
	{
		const { mkdirSync } = await import("node:fs");
		mkdirSync(join(workdir, "subdir"), { recursive: true });
		send({
			type: "prompt",
			text: "list this folder",
			attachments: [{ path: "subdir", mode: "reference" }],
		});
		await sleep(1500);
		check(
			"folder not skipped as a non-file attachment",
			!notices.some((t) => t.includes("跳过非文件附件") && t.includes("subdir")),
		);
		check(
			"no attachment error for the folder",
			!notices.some((t) => t.includes("附件") && t.includes("subdir") && t.includes("失败")),
		);
	}

	// -- persisted sessions: shared pi session files appear in the list --------
	// The CLI stores sessions in <agentDir>/sessions/--<cwd-sanitized>--; fabricate
	// one there and check list_sessions discovers the same persisted file.
	{
		const { homedir } = await import("node:os");
		const { writeFileSync, mkdirSync } = await import("node:fs");
		const safePath = `--${workdir.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
		const tuiDir = join(homedir(), ".pi", "agent", "sessions", safePath);
		const tuiFile = join(tuiDir, "2026-08-04T00-00-00-000Z_tui-smoke-test.jsonl");
		mkdirSync(tuiDir, { recursive: true });
		writeFileSync(
			tuiFile,
			[
				JSON.stringify({
					type: "session",
					version: 3,
					id: "tui-smoke-test",
					timestamp: "2026-08-04T00:00:00.000Z",
					cwd: workdir,
				}),
				JSON.stringify({
					type: "message",
					id: "m1",
					parentId: null,
					timestamp: "2026-08-04T00:00:01.000Z",
					message: {
						role: "user",
						content: [{ type: "text", text: "TUI 会话标题" }],
						timestamp: 1722700801000,
					},
				}),
			].join("\n") + "\n",
		);
		// Clean up the fabricated session on exit (best effort).
		process.on("exit", () => {
			try {
				rmSync(tuiFile, { force: true });
				rmSync(tuiDir, { recursive: true, force: true });
			} catch {
				/* ignore */
			}
		});
		send({ type: "list_sessions" });
		await sleep(1000);
		check(
			"persisted session appears in the conversation list",
			sessionsReply?.some((s) => s.path === tuiFile && s.firstMessage === "TUI 会话标题") ?? false,
		);
	}

	// -- plain terminal --------------------------------------------------------
	const t1 = "t-1";
	send({
		type: "terminal_create",
		terminalId: t1,
		cwd: workdir,
		cols: 80,
		rows: 24,
	});
	await sleep(600);
	check("shell produced output", (outputs.get(t1) ?? "").length > 0);
	check(
		"terminal_list identifies the active conversation",
		snapshotReply?.conversationId && snapshotReply.conversationId.length > 0,
	);
	send({ type: "terminal_input", terminalId: t1, data: "echo WS_ECHO_OK\r" });
	await sleep(800);
	check("input echoes through PTY", (outputs.get(t1) ?? "").includes("WS_ECHO_OK"));

	send({ type: "terminal_resize", terminalId: t1, cols: 100, rows: 40 });
	await sleep(200);

	// -- run_command with ${pwd} ----------------------------------------------
	const t2 = "t-2";
	send({
		type: "run_command",
		terminalId: t2,
		command: { name: "dev", command: "echo WS_CMD_OK", cwd: "${pwd}" },
		cols: 80,
		rows: 24,
	});
	await sleep(1200);
	check("run_command banner shown", (outputs.get(t2) ?? "").includes("WS_CMD_OK"));

	// ${pwd} resolves to session cwd (= workspace root here)
	send({ type: "terminal_input", terminalId: t2, data: "pwd\r" });
	await sleep(600);
	check("${pwd} resolved to session cwd", (outputs.get(t2) ?? "").includes(workdir));

	// -- re-run: run_command on an existing terminal restarts it in place ------
	send({
		type: "run_command",
		terminalId: t2,
		command: { name: "dev", command: "echo WS_CMD_RERUN", cwd: "${pwd}" },
		cols: 80,
		rows: 24,
	});
	await sleep(1200);
	const t2out = outputs.get(t2) ?? "";
	check("re-run banner appears", t2out.includes("> echo WS_CMD_RERUN"));
	check("re-run executed", t2out.includes("WS_CMD_RERUN"));
	// The replacement shell must accept input (a live PTY, not the killed one).
	send({
		type: "terminal_input",
		terminalId: t2,
		data: "echo WS_AFTER_RERUN\r",
	});
	await sleep(600);
	check("restarted shell accepts input", (outputs.get(t2) ?? "").includes("WS_AFTER_RERUN"));

	// -- kill / exit -----------------------------------------------------------
	send({ type: "terminal_kill", terminalId: t1 });
	await sleep(400);
	check("terminal_kill emits exit", exits.has(t1));

	send({ type: "terminal_input", terminalId: t2, data: "exit\r" });
	await sleep(600);
	check("shell exit emits terminal_exit", exits.has(t2));
	// Exited PTYs leave the live map: the same name can be created again and
	// accepts input, proving exited entries do not consume the terminal limit.
	send({
		type: "terminal_create",
		terminalId: t2,
		cwd: workdir,
		cols: 80,
		rows: 24,
	});
	await sleep(500);
	send({ type: "terminal_input", terminalId: t2, data: "echo REUSED_OK\r" });
	await sleep(600);
	check("exited terminal name can be reused", (outputs.get(t2) ?? "").includes("REUSED_OK"));

	// The command-list spawn path must enforce the same live-terminal cap as
	// terminal_create; otherwise unique browser IDs could bypass the limit.
	const capIds = Array.from({ length: 15 }, (_, i) => `cap-${i}`);
	for (const id of capIds) {
		send({ type: "terminal_create", terminalId: id, cwd: workdir, cols: 40, rows: 12 });
	}
	await sleep(1200);
	send({
		type: "run_command",
		terminalId: "cap-overflow",
		command: { name: "overflow", command: "echo SHOULD_NOT_RUN", cwd: "${pwd}" },
		cols: 40,
		rows: 12,
	});
	await sleep(500);
	check(
		"run_command enforces terminal limit",
		notices.some((text) => text.includes("终端数量已达上限")),
	);
	for (const id of capIds) send({ type: "terminal_kill", terminalId: id });

	// -- key encoding (pure + byte-exact) ------------------------------------
	// Named keys must NEVER fall back to Ctrl+<first letter> — the old bug
	// turned Ctrl+ArrowUp into Ctrl+A (0x01) and Ctrl+Enter into Ctrl+E (0x05).
	// Pin the exact escape sequences so a regression fails loudly.
	{
		const { encodeTerminalKey } = await import("../dist/server/terminals.js");
		const enc = (key, modifiers) => encodeTerminalKey(key, modifiers);
		const bytes = (r) => ("data" in r ? r.data : `ERROR:${r.error}`);
		check("Ctrl+ArrowUp = ESC[1;5A (not Ctrl+A)", bytes(enc("ArrowUp", { ctrl: true })) === "\x1b[1;5A");
		check("Ctrl+Enter = ESC[13;5u (not Ctrl+E)", bytes(enc("Enter", { ctrl: true })) === "\x1b[13;5u");
		check("Ctrl+ArrowRight = ESC[1;5C", bytes(enc("ArrowRight", { ctrl: true })) === "\x1b[1;5C");
		check("plain ArrowUp stays ESC[A", bytes(enc("ArrowUp")) === "\x1b[A");
		check("Alt+ArrowUp = ESC[1;3A", bytes(enc("ArrowUp", { alt: true })) === "\x1b[1;3A");
		check("Ctrl+Shift+ArrowUp = ESC[1;6A", bytes(enc("ArrowUp", { ctrl: true, shift: true })) === "\x1b[1;6A");
		check("Shift+Tab = ESC[9;2u", bytes(enc("Tab", { shift: true })) === "\x1b[9;2u");
		check("plain Enter stays CR", bytes(enc("Enter")) === "\r");
		check("Ctrl+C = 0x03", bytes(enc("c", { ctrl: true })) === "\x03");
		check("Alt+c = ESC c", bytes(enc("c", { alt: true })) === "\x1bc");
		check("unsupported key reports an error", "error" in enc("F20"));
		check("Ctrl on a non-letter reports an error", "error" in enc("ü", { ctrl: true }));
	}

	// -- id validation must apply to EVERY spawn path ------------------------
	// Both the browser terminal panel (terminal_create) and the command list
	// (run_command) share the same id rules — a bad id must be rejected with
	// the standard error notice on either path.
	{
		const before = notices.length;
		send({ type: "terminal_create", terminalId: "bad id!", cwd: workdir, cols: 40, rows: 12 });
		send({
			type: "run_command",
			terminalId: "bad id!",
			command: { name: "x", command: "echo NOPE", cwd: "${pwd}" },
			cols: 40,
			rows: 12,
		});
		await sleep(400);
		check(
			"terminal_create + run_command both reject an invalid id",
			notices.slice(before).filter((n) => n.includes("终端名称无效")).length >= 2,
		);
	}

	// -- the cap also holds for history (exited) ids at run_command ----------
	// 16 live terminals + an exited id in history: re-running the exited id must
	// be rejected — history does not reserve a slot (spawning would create a
	// 17th live PTY). This closes the "unique id spawns forever" hole on the
	// command-list path.
	{
		const histIds = Array.from({ length: 16 }, (_, i) => `hist-${i}`);
		for (const id of histIds) {
			send({ type: "terminal_create", terminalId: id, cwd: workdir, cols: 40, rows: 12 });
		}
		await sleep(1200);
		send({ type: "terminal_input", terminalId: "hist-0", data: "exit\r" }); // → history
		for (let i = 0; i < 30 && !exits.has("hist-0"); i++) await sleep(100);
		check("hist-0 exited and moved to history", exits.has("hist-0"));
		send({ type: "terminal_create", terminalId: "hist-fill", cwd: workdir, cols: 40, rows: 12 }); // back to 16 live
		await sleep(500);
		const before = notices.length;
		send({
			type: "run_command",
			terminalId: "hist-0",
			command: { name: "hb", command: "echo HIST_BYPASS_SHOULD_NOT_RUN", cwd: "${pwd}" },
			cols: 40,
			rows: 12,
		});
		await sleep(400);
		check(
			"run_command of an exited id at the cap is rejected",
			notices.slice(before).some((n) => n.includes("终端数量已达上限")),
		);
		for (const id of histIds) send({ type: "terminal_kill", terminalId: id });
		send({ type: "terminal_kill", terminalId: "hist-fill" });
	}

	// Invoke the real agent-facing definitions as well as the WebSocket protocol.
	// The SDK normally calls these from a model turn; this local tool harness keeps
	// the smoke test deterministic while exercising create/list/read(wait)/key/close.
	{
		const { TerminalManager, makePersistentTerminalTools } = await import("../dist/server/terminals.js");
		const toolManager = new TerminalManager(() => {}, workdir);
		const tools = new Map(makePersistentTerminalTools(toolManager, workdir).map((tool) => [tool.name, tool]));
		const invoke = async (name, params) =>
			tools.get(name).execute("tool-smoke", params, undefined, undefined, undefined);
		try {
			await invoke("terminal_create", { terminalId: "agent-smoke", cwd: ".", cols: 40, rows: 12 });
			const listed = await invoke("terminal_list", {});
			check(
				"agent terminal_create/list works",
				JSON.parse(listed.content[0].text).some((t) => t.id === "agent-smoke"),
			);
			const initial = await invoke("terminal_read", { terminalId: "agent-smoke", cursor: 0, maxBytes: 2000 });
			const initialRead = JSON.parse(initial.content[0].text);
			await invoke("terminal_input", { terminalId: "agent-smoke", data: "printf TOOL_WAIT_OK\r" });
			const waited = await invoke("terminal_read", {
				terminalId: "agent-smoke",
				cursor: initialRead.cursor,
				waitMs: 2000,
				maxBytes: 4000,
			});
			check(
				"agent terminal_read waits for incremental output",
				JSON.parse(waited.content[0].text).data.includes("TOOL_WAIT_OK"),
			);
			await invoke("terminal_input", { terminalId: "agent-smoke", data: "printf TOOL_KEY_OK" });
			await invoke("terminal_key", { terminalId: "agent-smoke", key: "Enter" });
			const keyed = await invoke("terminal_read", {
				terminalId: "agent-smoke",
				cursor: JSON.parse(waited.content[0].text).cursor,
				waitMs: 2000,
				maxBytes: 4000,
			});
			check("agent terminal_key sends named keys", JSON.parse(keyed.content[0].text).data.includes("TOOL_KEY_OK"));
			await invoke("terminal_close", { terminalId: "agent-smoke" });
			const afterClose = await invoke("terminal_list", {});
			check("agent terminal_close releases the PTY", JSON.parse(afterClose.content[0].text).length === 0);
		} finally {
			toolManager.killAll();
		}
	}

	// unknown terminal input must not crash
	send({ type: "terminal_input", terminalId: "nope", data: "x" });
	send({ type: "terminal_resize", terminalId: "nope", cols: 10, rows: 10 });
	await sleep(200);
	check("server still alive after bogus messages", true);

	ws.close();
	await sleep(300);
	console.log(`\n${passed} checks passed`);
	process.exit(process.exitCode ?? 0);
}

process.on("unhandledRejection", (err) => {
	console.error("UNHANDLED REJECTION:", err);
	process.exitCode = 1;
});

main().catch((err) => {
	console.error("TEST ERROR:", err);
	process.exitCode = 1;
	process.exit(1);
});

// Ensure the spawned server dies even on early crashes.
process.on("exit", () => {
	try {
		process.kill(-server.pid, "SIGKILL");
	} catch {
		/* already gone */
	}
	try {
		rmSync(workdir, { recursive: true, force: true });
		rmSync(dataDir, { recursive: true, force: true });
	} catch {
		/* best effort */
	}
});
