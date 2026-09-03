/**
 * 插件斜杠命令协议测试（零 token、自包含）。
 *
 * 覆盖：host.registerCommand 注册的 /cmd 出现在 slash_commands 目录
 * （source: "plugin"）；prompt("/cmd args") 被服务端拦截执行——插件收到参数、
 * 广播送达、字符串返回值以 notice 回显；命令不打到 SDK（零 token 的前提本身
 * 就是断言的一部分——若透传 SDK，测试会真的发起模型请求而失败得很难看）。
 *
 * 运行：先 npm run build:server，再 node tests/plugin-command-test.mjs
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";

const PORT = 8979;
const BASE = `http://127.0.0.1:${PORT}`;

const serverPath = realpathSync(process.execPath);
let proc = null;
const dataDir = mkdtempSync(join(tmpdir(), "pi-web-cmd-plugin-"));

const plugDir = join(dataDir, "plugins", "cmder");
mkdirSync(plugDir, { recursive: true });
writeFileSync(join(plugDir, "manifest.json"), JSON.stringify({ name: "cmder", version: "0.1.0" }));
writeFileSync(
	join(plugDir, "index.mjs"),
	`globalThis.__cmds = [];
export default {
	activate(host) {
		host.registerCommand({
			name: "probe-echo",
			description: "回显参数",
			descriptionEn: "Echo args",
			argumentHint: "<文本>",
			run(args) {
				globalThis.__cmds.push(args);
				host.broadcast({ kind: "cmd", args });
				return args ? \`已收到：\${args}\` : "已收到（空参数）";
			},
		});
		return () => {};
	},
};`,
);

function fail(msg) {
	console.error(`✗ ${msg}`);
	process.exitCode = 1;
}

function connect(clientId) {
	return new Promise((resolve2, reject) => {
		const sock = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
		const timer = setTimeout(() => reject(new Error("connect timeout")), 15_000);
		sock.on("open", () => sock.send(JSON.stringify({ type: "hello", clientId })));
		sock.on("message", (raw) => {
			if (JSON.parse(raw.toString()).type === "ready") {
				clearTimeout(timer);
				resolve2(sock);
			}
		});
		sock.on("error", (err) => {
			clearTimeout(timer);
			reject(err);
		});
	});
}

/** 等到谓词命中（自带监听器安装与超时）。 */
function waitFor(sock, pred, label, timeoutMs = 10_000) {
	return new Promise((resolve2, reject) => {
		const timer = setTimeout(() => reject(new Error(`timeout waiting for ${label}`)), timeoutMs);
		const onMsg = (raw) => {
			const msg = JSON.parse(raw.toString());
			if (pred(msg)) {
				clearTimeout(timer);
				sock.off("message", onMsg);
				resolve2(msg);
			}
		};
		sock.on("message", onMsg);
	});
}

try {
	proc = spawn(serverPath, [join(import.meta.dirname, "..", "dist", "server", "index.js")], {
		env: { ...process.env, PI_WEB_PORT: String(PORT), PI_WEB_DATA_DIR: dataDir, PI_WEB_CWD: import.meta.dirname },
		stdio: ["ignore", "pipe", "pipe"],
	});
	proc.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));

	await new Promise((resolve2, reject) => {
		const t0 = Date.now();
		const ping = async () => {
			try {
				if ((await fetch(`${BASE}/api/health`)).ok) return resolve2();
			} catch {}
			if (Date.now() - t0 > 20_000) return reject(new Error("server not ready"));
			setTimeout(ping, 300);
		};
		void ping();
	});

	const sock = await connect("cmd-test");

	// -- 1. 命令目录：可能先推无插件的初版（插件异步激活），持续扫到含条目为止 --
	let entry;
	{
		let lastCat;
		for (let i = 0; i < 50 && !entry; i++) {
			try {
				lastCat = await waitFor(sock, (m) => m.type === "slash_commands", "slash_commands", 8000);
			} catch {
				break;
			}
			entry = (lastCat.commands ?? []).find((c) => c.name === "probe-echo");
			if (!entry) sock.send(JSON.stringify({ type: "get_commands" })); // 主动刷新
		}
	}
	if (!entry || entry.source !== "plugin") {
		fail(`命令目录缺少 probe-echo/plugin：${JSON.stringify(entry)}`);
	} else {
		console.log(`✓ 命令目录含 /probe-echo（source=${entry.source}, hint=${entry.argumentHint}）`);
	}

	// -- 2. 拦截执行：广播 + notice 回显；不落 SDK --------------------------------
	const broadcasts = [];
	sock.on("message", (raw) => {
		const m = JSON.parse(raw.toString());
		if (m.type === "plugin_data" && m.payload?.kind === "cmd") broadcasts.push(m.payload.args);
	});

	sock.send(JSON.stringify({ type: "prompt", text: "/probe-echo hello 世界" }));
	const notice1 = await waitFor(sock, (m) => m.type === "notice" && String(m.text).includes("已收到"), "notice echo");
	if (!broadcasts.includes("hello 世界")) fail(`插件未收到参数：${JSON.stringify(broadcasts)}`);
	else console.log(`✓ 插件 run 收到参数并广播；notice 回显「${notice1.text}」`);

	// 空参数分支（三元表达式返回值）
	sock.send(JSON.stringify({ type: "prompt", text: "/probe-echo" }));
	await waitFor(sock, (m) => m.type === "notice" && m.text === "已收到（空参数）", "empty-arg notice");
	console.log("✓ 空参数调用正常");

	sock.close();
} catch (err) {
	fail(err?.stack ?? String(err));
} finally {
	if (proc?.pid) {
		try {
			process.kill(proc.pid, "SIGTERM");
		} catch {}
	}
	await new Promise((r) => setTimeout(r, 600));
	rmSync(dataDir, { recursive: true, force: true });
}
if (!process.exitCode) console.log("\nall ok");
