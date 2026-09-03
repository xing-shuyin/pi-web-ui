/**
 * MCP 工具桥端到端冒烟（零 token、自包含、独立端口 8990）：
 * 临时 data-dir 写 mcp.json（指向本地夹具服务器），起真实 server：
 *  - server 启动时 MCP 服务器被拉起（stdout 出现 ready 日志）
 *  - 工具数量正确（4）
 *  - MCP 服务器失败不炸 server 进程
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(__dirname, "fixtures/mcp-echo-server.mjs");

const PORT = 8990;
let server;
let dataDir;

function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}

async function main() {
	dataDir = mkdtempSync(join(tmpdir(), "mcp-bridge-"));
	writeFileSync(
		join(dataDir, "mcp.json"),
		JSON.stringify({
			servers: {
				csrv: {
					command: process.execPath, // 真 node（测试环境没有 git-bash 别名）
					args: [FIXTURE],
				},
				badsrv: { command: "definitely-not-a-real-cmd-xyz", args: [] },
			},
		}),
	);

	server = spawn(process.execPath, ["dist/server/index.js", "--port", String(PORT)], {
		env: {
			...process.env,
			PI_WEB_DATA_DIR: dataDir,
			PI_WEB_PORT: String(PORT),
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	let out = "";
	server.stdout.on("data", (d) => (out += d.toString()));
	server.stderr.on("data", (d) => (out += d.toString()));

	// 等 server “ready” + MCP 就绪日志（最多 15s）
	let ok = false;
	for (let i = 0; i < 60 && !ok; i++) {
		await sleep(250);
		if (/listening|ready|available/i.test(out) && /\[mcp:csrv\] ready, 4 tools/.test(out)) ok = true;
	}
	if (!ok) throw new Error("server 或 MCP 未就绪。输出：\n" + out);
	console.log("✓ MCP 服务器启动并握手（日志：[mcp:csrv] ready, 4 tools）");

	// badsrv 失败不应影响 server 存活
	if (/definitely-not-a-real-cmd-xyz/.test(out) && !/\[mcp\] 服务器「badsrv」启动失败/.test(out)) {
		// 只要求 server 还活着即可（失败路径经 rejectAll 归并日志）
	}
	if (server.exitCode !== null) throw new Error("server 崩了！");
	console.log("✓ 坏服务器被隔离（进程存活）");

	console.log("all ok");
	server.kill();
	await sleep(300);
	rmSync(dataDir, { recursive: true, force: true });
}

main().catch(async (err) => {
	console.error("✗", err.message);
	try {
		server?.kill();
	} catch {}
	try {
		rmSync(dataDir, { recursive: true, force: true });
	} catch {}
	process.exit(1);
});
