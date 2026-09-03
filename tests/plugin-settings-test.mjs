/**
 * 插件声明式设置协议测试（零 token、自包含）。
 *
 * 覆盖：plugins 清单带 settingsSchema + settingsValues（默认）；plugin_settings
 * 消息 → 服务端校验 + 持久化到 storage.json + 通知插件 onSettingsChanged +
 * 重推清单回显；非法值（越界/坏选项）被拒并 notice 报错。
 *
 * 运行：先 npm run build:server，再 node tests/plugin-settings-test.mjs
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";

const PORT = 8983;
const BASE = `http://127.0.0.1:${PORT}`;

const serverPath = realpathSync(process.execPath);
let proc = null;
const dataDir = mkdtempSync(join(tmpdir(), "pi-web-settings-plugin-"));

const plugDir = join(dataDir, "plugins", "opts");
mkdirSync(plugDir, { recursive: true });
writeFileSync(
	join(plugDir, "manifest.json"),
	JSON.stringify({
		name: "opts",
		version: "0.1.0",
		settings: [
			{ key: "pollSec", type: "number", label: "间隔", default: 60, min: 10, max: 600 },
			{ key: "notify", type: "boolean", label: "通知", default: true },
			{ key: "theme", type: "select", label: "主题", default: "dark", options: ["dark", "light"] },
		],
	}),
);
writeFileSync(
	join(plugDir, "index.mjs"),
	`export default {
	activate(host) {
		globalThis.__opts = [];
		host.onSettingsChanged((v) => globalThis.__opts.push(v));
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

function waitFor(sock, pred, label, timeoutMs = 10_000) {
	return new Promise((resolve2, reject) => {
		const timer = setTimeout(() => {
			sock.off("message", onMsg);
			reject(new Error(`timeout waiting for ${label}`));
		}, timeoutMs);
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

let latestPlugins = [];
async function pluginsAfter(sock) {
	return (await waitFor(sock, (m) => m.type === "plugins", "plugins")).plugins ?? [];
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

	const sock = await connect("settings-test");
	sock.on("message", (raw) => {
		const m = JSON.parse(raw.toString());
		if (m.type === "plugins") latestPlugins = m.plugins ?? [];
	});

	// -- 1. 清单带 schema + 默认值 -------------------------------------------------
	let opts;
	for (let i = 0; i < 40 && !opts; i++) {
		opts = latestPlugins.find((x) => x.id === "opts");
		if (!opts) await new Promise((r) => setTimeout(r, 250));
	}
	if (!opts || opts.settingsSchema?.length !== 3 || opts.settingsValues?.pollSec !== 60) {
		fail(`schema/默认值未下发：${JSON.stringify(opts)}`);
	} else {
		console.log("✓ plugins 清单带 settingsSchema + 默认 settingsValues");
	}

	// -- 2. plugin_settings 保存 → storage.json + onSettingsChanged + 回显 -------------
	sock.send(
		JSON.stringify({
			type: "plugin_settings",
			pluginId: "opts",
			values: { pollSec: 120, notify: false, theme: "light" },
		}),
	);
	await waitFor(sock, (m) => m.type === "notice" && m.text === "插件设置已保存", "save notice");
	// 落盘断言
	const raw = JSON.parse(readFileSync(join(plugDir, "storage.json"), "utf8"));
	if (raw.settings?.pollSec !== 120 || raw.settings?.notify !== false || raw.settings?.theme !== "light") {
		fail(`storage.json 未正确落盘：${JSON.stringify(raw.settings)}`);
	}
	// 回显（重推的 plugins 清单）
	let echoed;
	for (let i = 0; i < 40 && !echoed; i++) {
		echoed = latestPlugins.find((x) => x.id === "opts")?.settingsValues?.pollSec === 120 ? latestPlugins : undefined;
		if (!echoed) await new Promise((r) => setTimeout(r, 250));
	}
	if (!echoed) fail("保存后清单未回显新值");
	else console.log("✓ plugin_settings 保存 → 落盘 + 重推回显");

	// -- 3. 非法值被拒 -----------------------------------------------------------------
	sock.send(JSON.stringify({ type: "plugin_settings", pluginId: "opts", values: { pollSec: 5 } }));
	const err = await waitFor(sock, (m) => m.type === "notice" && m.text.includes("插件设置保存失败"), "reject notice");
	if (!err.text.includes("超出范围")) fail(`拒绝文案不对：${err.text}`);
	const raw2 = JSON.parse(readFileSync(join(plugDir, "storage.json"), "utf8"));
	if (raw2.settings?.pollSec !== 120) fail("非法保存不应改动已存值");
	else console.log("✓ 越界值被拒（notice 报错）且已存值不变");

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
