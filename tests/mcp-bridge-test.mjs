import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const FIXTURE = resolve(__dirname, "fixtures/mcp-echo-server.mjs");
const PORT = Number(process.argv[2] || 8990);
let server;
let client;
let dataDir;
let out = "";

function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(pred, label) {
	const deadline = Date.now() + 15000;
	while (Date.now() < deadline) {
		if (server.exitCode !== null || server.signalCode !== null) break;
		if (await pred()) return;
		await sleep(100);
	}
	throw new Error(`${label} 未就绪。输出：\n${out}`);
}

async function main() {
	dataDir = mkdtempSync(join(tmpdir(), "mcp-bridge-"));
	const cwd = join(dataDir, "work");
	mkdirSync(cwd);
	writeFileSync(
		join(dataDir, "mcp.json"),
		JSON.stringify({
			servers: {
				csrv: {
					command: process.execPath,
					args: [FIXTURE],
				},
				badsrv: { command: "definitely-not-a-real-cmd-xyz", args: [] },
			},
		}),
	);

	server = spawn(process.execPath, ["dist/server/index.js", "--port", String(PORT), "--cwd", cwd], {
		cwd: ROOT,
		env: {
			...process.env,
			PI_WEB_DATA_DIR: dataDir,
			PI_CODING_AGENT_DIR: dataDir,
			PI_WEB_CWD: cwd,
			PI_WEB_HOST: "127.0.0.1",
			PI_WEB_TOKEN: "",
			PI_WEB_PORT: String(PORT),
			PI_WEB_PLUGIN_CATALOG_URL: "off",
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	server.stdout.on("data", (d) => (out += d.toString()));
	server.stderr.on("data", (d) => (out += d.toString()));

	await waitFor(
		() =>
			fetch(`http://127.0.0.1:${PORT}/api/health`)
				.then((r) => r.ok)
				.catch(() => false),
		"server",
	);

	client = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
	let ready = false;
	let servers = [];
	let clientError;
	client.on("error", (err) => (clientError = err));
	client.on("message", (data) => {
		const msg = JSON.parse(data.toString());
		if (msg.type === "ready") ready = true;
		if (msg.type === "mcp_servers") servers = msg.servers;
		if (msg.type === "settings_state") servers = msg.settings.mcpServers ?? [];
	});
	client.on("open", () =>
		client.send(JSON.stringify({ type: "hello", clientId: "mcp-bridge-smoke", protocolVersion: 1 })),
	);
	await waitFor(() => {
		if (clientError) throw clientError;
		return ready;
	}, "客户端项目会话");
	await waitFor(() => {
		client.send(JSON.stringify({ type: "get_settings" }));
		const good = servers.find((s) => s.name === "csrv");
		const bad = servers.find((s) => s.name === "badsrv");
		return good?.status === "running" && bad?.status === "error";
	}, "MCP 管理 API");

	const good = servers.find((s) => s.name === "csrv");
	assert.equal(good.tools.length, 10);
	console.log("✓ 项目 MCP 服务器启动并握手，管理 API 返回 running 和 10 个工具");
	assert.equal(server.exitCode, null);
	assert.equal(server.signalCode, null);
	assert.equal((await fetch(`http://127.0.0.1:${PORT}/api/health`)).ok, true);
	console.log("✓ 坏服务器返回 error，其它服务器及宿主仍正常运行");
	console.log("all ok");
}

async function cleanup() {
	client?.terminate();
	if (server && server.exitCode === null && server.signalCode === null) {
		const exited = once(server, "exit");
		server.kill();
		await exited;
	}
	if (dataDir) rmSync(dataDir, { recursive: true, force: true });
}

main()
	.catch((err) => {
		console.error("✗", err.message);
		process.exitCode = 1;
	})
	.finally(cleanup);
