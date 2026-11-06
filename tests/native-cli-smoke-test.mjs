import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = await mkdtemp(join(tmpdir(), "pi-native-cli smoke-"));
const project = join(root, "project with spaces");
const dataDir = join(root, "data");
const node = await realpath(process.execPath);
const { mkdir } = await import("node:fs/promises");
await mkdir(project);
await mkdir(dataDir);
const probe = createServer();
probe.listen(0, "127.0.0.1");
await once(probe, "listening");
const port = probe.address().port;
await new Promise((done) => probe.close(done));
assert.ok(port >= 8900);
const fixture = join(project, "native cli fixture.mjs");
const bootFile = join(project, "boots.txt");
await writeFile(join(project, "reference.txt"), "workspace reference");
await writeFile(
	fixture,
	`import fs from 'node:fs';
const boot = ${JSON.stringify(bootFile)};
fs.appendFileSync(boot, 'boot\\n');
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdout.write('\\x1b[?2004hCLI_READY ' + JSON.stringify(process.argv.slice(2)) + '\\r\\n');
let draft = '', pending = '';
process.stdin.on('data', chunk => {
  pending += chunk.toString('utf8');
  while (pending.length) {
    if ('\\x1b[200~'.startsWith(pending) || '\\x1b[201~'.startsWith(pending)) break;
    if (pending.startsWith('\\x1b[200~') || pending.startsWith('\\x1b[201~')) { pending = pending.slice(6); continue; }
    const char = pending[0]; pending = pending.slice(1);
    if (char === '\\x05') process.stdout.write('\\x1b[?25l\\x1b[2;1HIME_INPUT\\x1b[5;65HIME_STATUS\\x1b[2;10H');
    else if (char === '\\x06') process.stdout.write('\\x1b[?25h\\r\\n');
    else if (char === '\\r') { process.stdout.write('SUBMITTED:' + JSON.stringify(draft) + '\\r\\n'); draft = ''; }
    else if (char === '\\x03') process.exit(0);
    else draft += char;
  }
});`,
);

const shim = join(project, "native-cli.cmd");
await writeFile(
	shim,
	'@ECHO off\r\nSET "_prog=node"\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%" "%dp0%\\native cli fixture.mjs" %*\r\n',
);
const nativeConfig = {
	preset: "custom",
	executable: process.platform === "win32" ? shim : node,
	args: [...(process.platform === "win32" ? [] : [fixture]), "literal value with spaces", "a&b"],
};

const server = spawn(node, [join(repo, "dist/server/index.js")], {
	cwd: repo,
	detached: process.platform !== "win32",
	stdio: ["ignore", "pipe", "pipe"],
	env: {
		...process.env,
		PI_WEB_HOST: "127.0.0.1",
		PI_WEB_PORT: String(port),
		PI_WEB_CWD: project,
		PI_WEB_DATA_DIR: dataDir,
		PI_CODING_AGENT_DIR: join(root, "agent"),
		PI_WEB_TOKEN: "",
		PI_WEB_TABS: "chat,terminal",
		PI_WEB_TOOL_LAZY_LOADING: "0",
	},
});
let serverOutput = "";
for (const stream of [server.stdout, server.stderr])
	stream.on("data", (chunk) => (serverOutput = (serverOutput + chunk).slice(-16000)));
const sockets = [];
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
async function until(predicate, label, timeout = 15000) {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		const value = await predicate();
		if (value) return value;
		await pause(40);
	}
	throw new Error(`Timed out: ${label}`);
}
async function connect(clientId) {
	const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
	sockets.push(socket);
	const messages = [];
	const output = new Map();
	socket.on("message", (bytes) => {
		const message = JSON.parse(bytes.toString());
		messages.push(message);
		if (message.type === "terminal_output")
			output.set(message.terminalId, (message.reset ? "" : output.get(message.terminalId) || "") + message.data);
	});
	await once(socket, "open");
	const send = (message) => socket.send(JSON.stringify(message));
	send({ type: "hello", clientId, locale: "en" });
	await until(() => messages.find((message) => message.type === "ready"), "client ready");
	return { socket, messages, output, send };
}
let passed = 0;
function check(label, condition) {
	assert.ok(condition, label);
	console.log(`  ✓ ${label}`);
	passed++;
}
try {
	await until(
		async () => {
			if (server.exitCode !== null) throw new Error(`Server exited: ${serverOutput}`);
			try {
				return (await fetch(`http://127.0.0.1:${port}/api/health`)).ok;
			} catch {
				return false;
			}
		},
		"server health",
		30000,
	);
	const first = await connect("native-cli-smoke");
	const id = "native-smoke";
	first.send({
		type: "terminal_create",
		ownerKind: "client",
		terminalId: id,
		cwd: project,
		cols: 100,
		rows: 30,
		title: "Native smoke",
		nativeCli: nativeConfig,
	});
	await until(() => first.output.get(id)?.includes("CLI_READY"), "native PTY ready");
	check(
		"native CLI starts with literal argv",
		first.output.get(id).includes("literal value with spaces") && first.output.get(id).includes("a&b"),
	);
	check(
		"terminal metadata preserves native CLI config",
		first.messages.some(
			(m) => m.type === "terminal_list" && m.terminals.some((t) => t.id === id && t.nativeCli?.preset === "custom"),
		),
	);
	first.send({ type: "terminal_input", terminalId: id, ownerKind: "client", data: "\x05" });
	await until(() => first.output.get(id)?.includes("\x1b[2;10H"), "hidden cursor move reaches xterm");
	check("hidden cursor position survives PTY transport for IME placement", first.output.get(id).includes("IME_STATUS"));
	first.send({ type: "terminal_input", terminalId: id, ownerKind: "client", data: "\x06" });
	first.send({
		type: "terminal_cli_paste",
		requestId: "paste-one",
		terminalId: id,
		ownerKind: "client",
		data: "first line\n第二行\u001b[31m",
		attachments: [
			{ path: "reference.txt", mode: "reference" },
			{ name: "upload with spaces.txt", fileData: Buffer.from("actual uploaded bytes").toString("base64") },
			{ path: ".", mode: "reference" },
		],
	});
	const result = await until(
		() => first.messages.find((m) => m.type === "terminal_cli_paste_result" && m.requestId === "paste-one"),
		"paste acknowledgement",
	);
	check("paste acknowledged after preparing attachments", result.ok);
	await pause(150);
	check("paste does not submit Enter", !first.output.get(id).includes("SUBMITTED:"));
	first.send({ type: "terminal_input", terminalId: id, ownerKind: "client", data: "\r" });
	await until(() => first.output.get(id)?.includes("SUBMITTED:"), "explicit Enter submits");
	const text = first.output.get(id);
	check(
		"explicit Enter submits multiline text and real paths",
		text.includes("第二行") && text.includes("reference.txt") && text.includes("Directory path:"),
	);
	check("terminal control escapes are not pasted", !text.includes("\\u001b"));
	const clientUploads = join(dataDir, "uploads", "native-cli-smoke");
	const { readdir } = await import("node:fs/promises");
	const saved = await readdir(clientUploads, { recursive: true });
	let uploaded = false;
	for (const item of saved) {
		try {
			if ((await readFile(join(clientUploads, item), "utf8")) === "actual uploaded bytes") uploaded = true;
		} catch {}
	}
	check("uploaded attachment exists on disk with original bytes", uploaded);
	first.socket.close();
	await once(first.socket, "close");
	const reconnected = await connect("native-cli-smoke");
	reconnected.send({ type: "terminal_attach", terminalId: id, ownerKind: "client", cols: 110, rows: 32 });
	await until(() => reconnected.output.get(id)?.includes("CLI_READY"), "reconnect replays PTY output");
	check("reconnect attaches without relaunch", (await readFile(bootFile, "utf8")).trim().split("\n").length === 1);
	const other = await connect("native-cli-other-client");
	other.send({
		type: "terminal_cli_paste",
		requestId: "foreign",
		terminalId: id,
		ownerKind: "client",
		data: "foreign input",
	});
	const refused = await until(
		() => other.messages.find((m) => m.type === "terminal_cli_paste_result" && m.requestId === "foreign"),
		"foreign client refusal",
	);
	check("another client cannot paste into this PTY", !refused.ok);
	reconnected.send({ type: "terminal_kill", terminalId: id, ownerKind: "client" });
	await until(
		() => reconnected.messages.some((m) => m.type === "terminal_exit" && m.terminalId === id),
		"native CLI terminated",
	);
	reconnected.send({
		type: "terminal_cli_paste",
		requestId: "after-close",
		terminalId: id,
		ownerKind: "client",
		data: "should fail",
	});
	const closed = await until(
		() => reconnected.messages.find((m) => m.type === "terminal_cli_paste_result" && m.requestId === "after-close"),
		"closed target refusal",
	);
	check(
		"closed CLI rejects paste without relaunch",
		!closed.ok && (await readFile(bootFile, "utf8")).trim().split("\n").length === 1,
	);
	reconnected.send({ type: "new_cli_chat", requestId: "create-conversation", config: nativeConfig, cwd: project });
	const created = await until(
		() => reconnected.messages.find((m) => m.type === "new_chat_result" && m.requestId === "create-conversation"),
		"CLI conversation acknowledgement",
	);
	check("CLI creates an independent conversation", created.ok && Boolean(created.conversationId));
	const cliSnapshot = await until(
		() =>
			reconnected.messages.find(
				(m) => m.type === "snapshot" && m.state.conversationId === created.conversationId && m.state.nativeCli,
			),
		"CLI conversation snapshot",
	);
	const cliId = cliSnapshot.state.nativeCli.terminalId;
	reconnected.send({
		type: "terminal_attach",
		terminalId: cliId,
		conversationId: created.conversationId,
		ownerKind: "conversation",
		cols: 100,
		rows: 30,
	});
	await until(() => reconnected.output.get(cliId)?.includes("CLI_READY"), "conversation PTY ready");
	const bootCount = (await readFile(bootFile, "utf8")).trim().split("\n").length;
	reconnected.send({
		type: "terminal_cli_paste",
		requestId: "conversation-paste",
		terminalId: cliId,
		conversationId: created.conversationId,
		ownerKind: "conversation",
		data: "conversation-scoped draft",
		attachments: [{ path: "reference.txt", mode: "lines", lines: { start: 1, end: 1 } }],
	});
	const ownPaste = await until(
		() =>
			reconnected.messages.find((m) => m.type === "terminal_cli_paste_result" && m.requestId === "conversation-paste"),
		"conversation paste acknowledged",
	);
	check("file references target the conversation-owned CLI", ownPaste.ok);
	reconnected.send({ type: "new_chat", requestId: "ordinary-after-cli" });
	const normal = await until(
		() => reconnected.messages.find((m) => m.type === "new_chat_result" && m.requestId === "ordinary-after-cli"),
		"normal conversation acknowledgement",
	);
	check(
		"ordinary new chat never reuses a blank CLI conversation",
		normal.ok && normal.conversationId !== created.conversationId,
	);
	reconnected.send({ type: "switch_conversation", id: created.conversationId });
	reconnected.send({
		type: "terminal_attach",
		terminalId: cliId,
		conversationId: created.conversationId,
		ownerKind: "conversation",
		cols: 100,
		rows: 30,
	});
	await until(
		() =>
			reconnected.messages.filter((m) => m.type === "snapshot" && m.state.conversationId === created.conversationId)
				.length >= 2,
		"switch back to CLI conversation",
	);
	check(
		"conversation navigation does not restart the CLI process",
		(await readFile(bootFile, "utf8")).trim().split("\n").length === bootCount,
	);
	check(
		"referenced content remains unsent across conversation switches",
		!reconnected.output.get(cliId).includes("SUBMITTED:"),
	);
	reconnected.send({
		type: "terminal_input",
		terminalId: cliId,
		conversationId: created.conversationId,
		ownerKind: "conversation",
		data: "\r",
	});
	await until(() => reconnected.output.get(cliId)?.includes("SUBMITTED:"), "retained native draft submitted");
	check(
		"native input retains its draft and line reference after navigation",
		reconnected.output.get(cliId).includes("conversation-scoped draft") &&
			reconnected.output.get(cliId).includes("lines 1-1"),
	);
	reconnected.send({
		type: "terminal_kill",
		terminalId: cliId,
		conversationId: created.conversationId,
		ownerKind: "conversation",
	});
	await until(
		() => reconnected.messages.some((m) => m.type === "terminal_exit" && m.terminalId === cliId),
		"conversation CLI terminated",
	);
	console.log(`Native CLI smoke: ${passed} checks passed.`);
} catch (error) {
	console.error(serverOutput);
	throw error;
} finally {
	for (const socket of sockets) socket.terminate();
	if (server.exitCode === null) {
		if (process.platform === "win32") {
			const kill = spawn("taskkill", ["/pid", String(server.pid), "/t", "/f"], { stdio: "ignore" });
			await once(kill, "exit");
		} else {
			try {
				process.kill(-server.pid, "SIGTERM");
			} catch {}
		}
	}
	await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
