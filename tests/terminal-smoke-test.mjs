import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, realpathSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { freePort } from "./lib/port-utils.mjs";

const PORT = 20000 + Math.floor(Math.random() * 10000);
const workdir = mkdtempSync(join(tmpdir(), "piweb-term-"));
const dataDir = mkdtempSync(join(tmpdir(), "piweb-term-data-"));
process.env.PI_WEB_PORT = String(PORT);
process.env.PI_WEB_CWD = workdir;
process.env.PI_WEB_DATA_DIR = dataDir;
process.env.PI_WEB_TOOL_LAZY_LOADING = "0";

const NODE = realpathSync(process.execPath);
const REPO = fileURLToPath(new globalThis.URL("../", import.meta.url));

const server = spawn(NODE, [join(REPO, "dist", "server", "index.js")], {
	cwd: REPO,
	stdio: ["ignore", "pipe", "pipe"],
	detached: true,
});
server.on("error", (e) => console.error("[srv spawn error]", e));
server.on("exit", (code) => console.error(`[srv exited early: ${code}]`));
server.stdout.on("data", (d) => process.stdout.write(`[srv] ${d}`));
server.stderr.on("data", (d) => process.stdout.write(`[srv!] ${d}`));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, ms = 5000, step = 100) {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		if (pred()) return true;
		await sleep(step);
	}
	return pred();
}
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
		} catch {}
		await sleep(250);
	}
	throw new Error("server did not start");
}

const outputs = new Map();
const exits = new Map();
let commandsReply = null;
let sessionsReply = null;
let snapshotReply = null;
const notices = [];
let lastTermList = null;

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
		if (msg.type === "snapshot_delta") snapshotReply = msg.state;
		if (msg.type === "notice") notices.push(msg.text);
		if (msg.type === "terminal_list") lastTermList = msg.terminals;
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
			} catch {}
		});
	});
	console.log("ready received");
	await sleep(300);
	send({ type: "set_settings", terminalToolsEnabled: true });
	const TERM_TOOL_EXPECT = ["terminal"];
	await waitFor(() => TERM_TOOL_EXPECT.every((name) => snapshotReply?.tools?.includes(name)), 8000, 200);
	check(
		"agent exposes persistent terminal tools",
		TERM_TOOL_EXPECT.every((name) => snapshotReply?.tools?.includes(name)),
	);

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
		process.on("exit", () => {
			try {
				rmSync(tuiFile, { force: true });
				rmSync(tuiDir, { recursive: true, force: true });
			} catch {}
		});
		send({ type: "list_sessions" });
		await sleep(1000);
		check(
			"persisted session appears in the conversation list",
			sessionsReply?.some((s) => s.path === tuiFile && s.firstMessage === "TUI 会话标题") ?? false,
		);
	}

	const t1 = "t-1";
	send({
		type: "terminal_create",
		terminalId: t1,
		cwd: workdir,
		cols: 80,
		rows: 24,
	});
	check("shell produced output", await waitFor(() => (outputs.get(t1) ?? "").length > 0));
	check(
		"terminal_list identifies the active conversation",
		snapshotReply?.conversationId && snapshotReply.conversationId.length > 0,
	);
	send({ type: "terminal_input", terminalId: t1, data: "echo WS_ECHO_OK\r" });
	await sleep(800);
	check("input echoes through PTY", (outputs.get(t1) ?? "").includes("WS_ECHO_OK"));

	send({ type: "terminal_resize", terminalId: t1, cols: 100, rows: 40 });
	await sleep(200);

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

	send({ type: "terminal_input", terminalId: t2, data: "pwd\r" });
	await sleep(600);
	check("${pwd} resolved to session cwd", (outputs.get(t2) ?? "").includes(workdir));

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
	send({
		type: "terminal_input",
		terminalId: t2,
		data: "echo WS_AFTER_RERUN\r",
	});
	await sleep(600);
	check("restarted shell accepts input", (outputs.get(t2) ?? "").includes("WS_AFTER_RERUN"));

	const countPath = join(workdir, "attach-count.txt");
	send({
		type: "run_command",
		terminalId: t2,
		command: { name: "attach audit", command: "printf 'RUN\\n' >> attach-count.txt", cwd: "${pwd}" },
		cols: 80,
		rows: 24,
	});
	check("attach setup command completed", await waitFor(() => existsSync(countPath), 5000));
	const countBeforeAttach = readFileSync(countPath, "utf8");
	send({ type: "terminal_attach", terminalId: t2, ownerKind: "client", cols: 90, rows: 30 });
	send({ type: "terminal_attach", terminalId: t2, ownerKind: "client", cols: 100, rows: 40 });
	await sleep(500);
	check(
		"attach does not rerun command side effects",
		readFileSync(countPath, "utf8") === countBeforeAttach && countBeforeAttach.trim() === "RUN",
	);
	check(
		"attach resizes the existing process",
		lastTermList?.some((t) => t.id === t2 && t.running && t.ownerKind === "client"),
	);

	send({ type: "terminal_kill", terminalId: t1 });
	await sleep(400);
	check("terminal_kill emits exit", exits.has(t1));

	send({ type: "terminal_input", terminalId: t2, data: "exit\r" });
	await waitFor(() => exits.has(t2), 3000);
	check("shell exit emits terminal_exit", exits.has(t2));
	send({
		type: "terminal_create",
		terminalId: t2,
		cwd: workdir,
		cols: 80,
		rows: 24,
	});
	await sleep(500);
	send({ type: "terminal_input", terminalId: t2, data: "echo REUSED_OK\r" });
	const reused = await waitFor(() => (outputs.get(t2) ?? "").includes("REUSED_OK"), 3000);
	check("exited terminal name can be reused", reused);

	const capIds = Array.from({ length: 15 }, (_, i) => `cap-${i}`);
	for (const id of capIds) {
		send({ type: "terminal_create", terminalId: id, cwd: workdir, cols: 40, rows: 12 });
	}
	check(
		"terminal limit setup: sixteen user PTYs are live",
		await waitFor(
			() =>
				capIds.every((id) => lastTermList?.some((t) => t.id === id && t.running)) &&
				lastTermList?.some((t) => t.id === t2 && t.running),
			10000,
		),
	);
	send({
		type: "run_command",
		terminalId: "cap-overflow",
		command: { name: "overflow", command: "echo SHOULD_NOT_RUN", cwd: "${pwd}" },
		cols: 40,
		rows: 12,
	});
	check(
		"run_command enforces terminal limit",
		await waitFor(() => notices.some((text) => /终端数量已达上限|Terminal limit reached/.test(text)), 8000),
	);
	for (const id of capIds) send({ type: "terminal_kill", terminalId: id });

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

	{
		const histIds = Array.from({ length: 16 }, (_, i) => `hist-${i}`);
		for (const id of histIds) {
			send({ type: "terminal_create", terminalId: id, cwd: workdir, cols: 40, rows: 12 });
		}
		await sleep(1200);
		send({ type: "terminal_input", terminalId: "hist-0", data: "exit\r" });
		for (let i = 0; i < 30 && !exits.has("hist-0"); i++) await sleep(100);
		check("hist-0 exited and moved to history", exits.has("hist-0"));
		send({ type: "terminal_create", terminalId: "hist-fill", cwd: workdir, cols: 40, rows: 12 });
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

	{
		const priorIds = [
			"t-1",
			"t-2",
			"cap-overflow",
			...Array.from({ length: 15 }, (_, i) => `cap-${i}`),
			...Array.from({ length: 16 }, (_, i) => `hist-${i}`),
			"hist-fill",
		];
		for (const id of priorIds) send({ type: "terminal_kill", terminalId: id });
		const settled = await waitFor(() => lastTermList !== null && lastTermList.every((t) => !t.running), 15000);
		check("issue #147 setup: earlier terminals settled", settled);
		const ids147 = Array.from({ length: 16 }, (_, i) => `b147-${i}`);
		const fillNotices = notices.length;
		for (const id of ids147) {
			send({ type: "terminal_create", terminalId: id, cwd: workdir, cols: 40, rows: 12 });
		}
		await waitFor(() => (lastTermList?.filter((t) => t.running).length ?? 0) >= 16, 5000);
		send({ type: "terminal_create", terminalId: "b147-over", cwd: workdir, cols: 40, rows: 12 });
		const capped = await waitFor(() => notices.slice(fillNotices).some((n) => n.includes("终端数量已达上限")), 3000);
		check("issue #147 setup: user cap is full", capped);
		if (capped) {
			const before = notices.length;
			send({ type: "terminal_create", terminalId: "b147-ai", cwd: workdir, cols: 40, rows: 12, agentBash: true });
			let alive147 = false;
			for (let i = 0; i < 10 && !alive147; i++) {
				send({ type: "terminal_input", terminalId: "b147-ai", data: "echo B147_ALIVE\r" });
				alive147 = await waitFor(() => (outputs.get("b147-ai") ?? "").includes("B147_ALIVE"), 1000);
			}
			check(
				"terminal_create with agentBash:true bypasses the full user cap",
				alive147 && !notices.slice(before).some((n) => n.includes("终端数量已达上限")),
			);
		}
		for (const id of [...ids147, "b147-ai"]) send({ type: "terminal_kill", terminalId: id });
		await sleep(400);
	}

	{
		const { TerminalManager, makePersistentTerminalTools } = await import("../dist/server/terminals.js");
		const toolManager = new TerminalManager(() => {}, workdir);
		const tools = new Map(makePersistentTerminalTools(toolManager, workdir).map((tool) => [tool.name, tool]));
		const invoke = async (name, params) =>
			tools
				.get("terminal")
				.execute("tool-smoke", { action: name.replace(/^terminal_/, ""), ...params }, undefined, undefined, undefined);
		try {
			await invoke("terminal_create", { terminalId: "agent-smoke", cwd: ".", cols: 40, rows: 12 });
			const listed = await invoke("terminal_list", {});
			check(
				"agent terminal_create/list works",
				JSON.parse(listed.content[0].text).some((t) => t.id === "agent-smoke"),
			);
			let initialRead = { cursor: 0 };
			for (let i = 0; i < 30; i++) {
				const r = await invoke("terminal_read", { terminalId: "agent-smoke", cursor: 0, maxBytes: 2000 });
				initialRead = JSON.parse(r.content[0].text);
				if (initialRead.cursor > 0) break;
				await sleep(100);
			}
			await invoke("terminal_input", { terminalId: "agent-smoke", data: "echo TOOL_WAIT_OK\r" });
			let waitedText = "";
			let cur = initialRead.cursor;
			for (let i = 0; i < 30 && !waitedText.includes("TOOL_WAIT_OK"); i++) {
				const waited = await invoke("terminal_read", {
					terminalId: "agent-smoke",
					cursor: cur,
					waitMs: 500,
					maxBytes: 4000,
				});
				const parsed = JSON.parse(waited.content[0].text);
				waitedText += parsed.data;
				cur = parsed.cursor;
			}
			check("agent terminal_read waits for incremental output", waitedText.includes("TOOL_WAIT_OK"));

			await invoke("terminal_input", { terminalId: "agent-smoke", data: "echo TOOL_KEY_OK" });
			await invoke("terminal_key", { terminalId: "agent-smoke", key: "Enter" });
			let keyedText = "";
			for (let i = 0; i < 30 && !keyedText.includes("TOOL_KEY_OK"); i++) {
				const keyed = await invoke("terminal_read", {
					terminalId: "agent-smoke",
					cursor: cur,
					waitMs: 500,
					maxBytes: 4000,
				});
				const parsed = JSON.parse(keyed.content[0].text);
				keyedText += parsed.data;
				cur = parsed.cursor;
			}
			check("agent terminal_key sends named keys", keyedText.includes("TOOL_KEY_OK"));
			await invoke("terminal_close", { terminalId: "agent-smoke" });
			const afterClose = await invoke("terminal_list", {});
			check("agent terminal_close releases the PTY", JSON.parse(afterClose.content[0].text).length === 0);

			await invoke("terminal_create", { terminalId: "agent-live", cwd: ".", cols: 40, rows: 12 });
			check("countLive counts a live PTY", toolManager.countLive() === 1);
			await invoke("terminal_input", { terminalId: "agent-live", data: "exit\r" });
			const exited = await waitFor(() => toolManager.countLive() === 0, 3000);
			check("countLive drops to 0 after the PTY exits", exited);
			check(
				"exited terminal stays readable in list but not live",
				toolManager.list().some((t) => t.id === "agent-live" && !t.running) && toolManager.countLive() === 0,
			);

			toolManager.create("pristine-smoke", ".", 40, 12, ".", "pristine-smoke");
			check(
				"pristine shell is live but not blocking",
				toolManager.countLive() === 1 && toolManager.countBlockingLive() === 0,
			);
			await invoke("terminal_input", { terminalId: "pristine-smoke", data: "true\r" });
			check("touched shell becomes blocking", toolManager.countLive() === 1 && toolManager.countBlockingLive() === 1);
			toolManager.create("aibash-smoke", ".", 40, 12, ".", "aibash-smoke", { agentBash: true });
			check("ai-bash shell is blocking from birth", toolManager.countBlockingLive() === 2);
			await invoke("terminal_close", { terminalId: "pristine-smoke" });
			await invoke("terminal_close", { terminalId: "aibash-smoke" });
			check(
				"closing pristine/ai-bash test shells releases all slots",
				toolManager.countLive() === 0 && toolManager.countBlockingLive() === 0,
			);

			for (let i = 0; i < 16; i++) toolManager.create(`u147-${i}`, ".", 40, 12, ".", `u147-${i}`);
			toolManager.create("ai147", ".", 40, 12, ".", "ai147", { agentBash: true });
			await invoke("terminal_input", { terminalId: "ai147", data: "exit\r" });
			const aiExited = await waitFor(() => toolManager.list().some((t) => t.id === "ai147" && !t.running), 5000);
			check("issue #147 setup: AI terminal exited into history", aiExited);
			const rebuilt = toolManager.create("ai147", ".", 40, 12, ".", "ai147");
			check(
				"rebuilt exited AI terminal inherits agentBash despite the full user cap",
				rebuilt !== null && rebuilt.agentBash === true,
			);
			await invoke("terminal_input", { terminalId: "u147-0", data: "exit\r" });
			const uExited = await waitFor(() => toolManager.list().some((t) => t.id === "u147-0" && !t.running), 5000);
			check("issue #147 setup: user terminal exited into history", uExited);
			toolManager.create("u147-new", ".", 40, 12, ".", "u147-new");
			const userRebuild = toolManager.create("u147-0", ".", 40, 12, ".", "u147-0");
			check("exited user terminal is still rejected at the cap", userRebuild === null);
			for (let i = 0; i < 16; i++) toolManager.kill(`u147-${i}`);
			toolManager.kill("u147-new");
			toolManager.kill("ai147");
		} finally {
			toolManager.killAll();
		}
	}

	send({ type: "terminal_input", terminalId: "nope", data: "x" });
	send({ type: "terminal_resize", terminalId: "nope", cols: 10, rows: 10 });
	await sleep(200);
	check("server still alive after bogus messages", true);

	ws.close();
	stopServer();
	await sleep(800);
	console.log(`\n${passed} checks passed`);
	process.exit(process.exitCode ?? 0);
}

process.on("uncaughtException", (err) => {
	if (err && err.code === "EAGAIN") return;
	console.error("UNCAUGHT EXCEPTION:", err);
	process.exitCode = 1;
});

process.on("unhandledRejection", (err) => {
	console.error("UNHANDLED REJECTION:", err);
	process.exitCode = 1;
});

main().catch((err) => {
	console.error("TEST ERROR:", err);
	process.exitCode = 1;
	process.exit(1);
});

let serverStopped = false;
function stopServer() {
	if (serverStopped) return;
	serverStopped = true;
	try {
		if (process.platform === "win32") {
			execFileSync("taskkill", ["/F", "/T", "/PID", String(server.pid)], { stdio: "ignore", timeout: 5000 });
		} else process.kill(-server.pid, "SIGKILL");
	} catch {
		try {
			server.kill();
		} catch {}
	}
}
process.on("exit", () => {
	stopServer();
	if (process.platform !== "win32") freePort(PORT);
	try {
		rmSync(workdir, { recursive: true, force: true });
		rmSync(dataDir, { recursive: true, force: true });
	} catch {}
});
