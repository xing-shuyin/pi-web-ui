import { spawn } from "node:child_process";
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";

const PORT = Number(process.argv[2] || 8967);
const BASE = `http://127.0.0.1:${PORT}`;

const serverPath = realpathSync(process.execPath);
const repoRoot = join(import.meta.dirname, "..");
let proc = null;
const dataDir = mkdtempSync(join(tmpdir(), "pi-web-vsc-plugin-"));
const workspace = join(dataDir, "workspace");

function fail(msg) {
	console.error(`✗ ${msg}`);
	process.exitCode = 1;
}

const plugDst = join(dataDir, "plugins", "vscode-editor");
mkdirSync(plugDst, { recursive: true });
cpSync(join(repoRoot, "plugins", "vscode-editor", "manifest.json"), join(plugDst, "manifest.json"));
cpSync(join(repoRoot, "plugins", "vscode-editor", "index.mjs"), join(plugDst, "index.mjs"));
cpSync(join(repoRoot, "plugins", "vscode-editor", "client"), join(plugDst, "client"), { recursive: true });

mkdirSync(join(workspace, "src"), { recursive: true });
mkdirSync(join(workspace, "node_modules", "noise-pkg"), { recursive: true });
writeFileSync(join(workspace, "src", "main.js"), 'console.log("hello vsc");\n');
writeFileSync(join(workspace, "README.md"), "# 测试仓库\n");
writeFileSync(join(workspace, "gbk.txt"), Buffer.from([0xc4, 0xe3, 0xba, 0xc3]));
writeFileSync(join(workspace, "node_modules", "noise-pkg", "index.js"), "// noise\n");

function connect(clientId = "vsc-test") {
	return new Promise((resolve, reject) => {
		const sock = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
		const timer = setTimeout(() => reject(new Error("connect timeout")), 15_000);
		sock.on("open", () => sock.send(JSON.stringify({ type: "hello", clientId })));
		sock.on("message", (raw) => {
			if (JSON.parse(raw.toString()).type === "ready") {
				clearTimeout(timer);
				resolve(sock);
			}
		});
		sock.on("error", (err) => {
			clearTimeout(timer);
			reject(err);
		});
	});
}

function rpc(sock, payload) {
	return new Promise((resolve, reject) => {
		const reqId = `t${Math.random().toString(36).slice(2)}`;
		const timer = setTimeout(() => reject(new Error(`rpc timeout: ${payload.action}`)), 10_000);
		const onMsg = (raw) => {
			const msg = JSON.parse(raw.toString());
			if (
				msg.type === "plugin_data" &&
				msg.pluginId === "vscode-editor" &&
				msg.payload?.res &&
				msg.payload?.reqId === reqId
			) {
				clearTimeout(timer);
				sock.off("message", onMsg);
				resolve(msg.payload);
			}
		};
		sock.on("message", onMsg);
		sock.send(JSON.stringify({ type: "plugin_message", pluginId: "vscode-editor", payload: { ...payload, reqId } }));
	});
}

try {
	proc = spawn(serverPath, [join(repoRoot, "dist", "server", "index.js")], {
		env: {
			...process.env,
			PI_WEB_PORT: String(PORT),
			PI_WEB_DATA_DIR: dataDir,
			PI_WEB_CWD: workspace,
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	proc.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));
	let serverLog = "";
	proc.stdout.on("data", (d) => {
		serverLog += d.toString();
	});
	proc.stderr.on("data", (d) => {
		serverLog += d.toString();
	});

	await new Promise((resolve, reject) => {
		const t0 = Date.now();
		const probe = async () => {
			try {
				const r = await fetch(`${BASE}/api/health`);
				if (r.ok) return resolve();
			} catch {}
			if (Date.now() - t0 > 20_000) return reject(new Error("server not ready"));
			setTimeout(probe, 300);
		};
		void probe();
	});

	let sock = await connect();

	const pluginsMsg = await new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			sock.off("message", onMsg);
			reject(new Error("no plugins message"));
		}, 10_000);
		const onMsg = (raw) => {
			const m = JSON.parse(raw.toString());
			if (m.type === "plugins") {
				clearTimeout(timer);
				sock.off("message", onMsg);
				resolve(m);
			}
		};
		sock.on("message", onMsg);
	});
	const me = (pluginsMsg.plugins ?? []).find((p) => p.id === "vscode-editor");
	if (!me || me.hasClient !== true || me.error !== undefined) {
		fail(`vscode-editor not listed correctly: ${JSON.stringify(me)}`);
	} else console.log("✓ plugins 清单含 vscode-editor（hasClient）");

	if (!serverLog.includes("activated; workspace root:")) fail("vscode-editor 服务端激活日志未找到");
	else console.log("✓ vscode-editor 正常激活");

	let r = await rpc(sock, { action: "list", dir: "" });
	if (!r.ok) fail(`list failed: ${r.error}`);
	else if ((readdirSync(workspace).some(() => false), true)) {
		const names = r.entries.map((e) => e.name);
		if (names.includes("node_modules")) fail("list 应跳过 node_modules");
		else if (r.entries[0]?.name !== "src" || r.entries[0]?.type !== "dir") fail(`目录应排在文件前: ${names}`);
		else console.log("✓ list 根目录：目录优先 + 忽略 node_modules");
	}

	r = await rpc(sock, { action: "list", dir: "src" });
	if (!r.ok || !r.entries.some((e) => e.name === "main.js")) fail(`list src failed: ${JSON.stringify(r)}`);
	else console.log("✓ list 子目录 src/main.js");

	r = await rpc(sock, { action: "read", path: "src/main.js" });
	if (!r.ok || r.text !== 'console.log("hello vsc");\n') fail(`read main.js wrong: ${JSON.stringify(r)}`);
	else console.log("✓ read 文本内容正确");

	r = await rpc(sock, { action: "read", path: "gbk.txt" });
	if (!r.ok || r.text !== "你好") fail(`GBK 解码失败: ${JSON.stringify(r)}`);
	else console.log("✓ read GBK 回退解码为「你好」");

	r = await rpc(sock, { action: "read", path: "../outside.txt" });
	if (r.ok) fail("../ 越界未被拒绝");
	else console.log("✓ ../ 路径越界被拒绝");

	r = await rpc(sock, { action: "delete", path: "." });
	if (r.ok) fail("删除根目录未被拒绝");
	else console.log("✓ 拒绝删除根目录");

	r = await rpc(sock, { action: "write", path: "src/new.ts", text: "const x: number = 1;\n" });
	if (!r.ok) fail(`write failed: ${r.error}`);
	else if (readFileSync(join(workspace, "src", "new.ts"), "utf-8") !== "const x: number = 1;\n") fail("write 未落盘");
	else console.log("✓ write 原子落盘（自动补父目录）");

	r = await rpc(sock, { action: "create", path: "docs/guide.md", kind: "file" });
	if (!r.ok) fail(`create file failed: ${r.error}`);
	else if (!existsSync(join(workspace, "docs", "guide.md"))) fail("create file 未落盘");
	else console.log("✓ create file（带子目录）");

	r = await rpc(sock, { action: "create", path: "assets", kind: "dir" });
	if (!r.ok) fail(`create dir failed: ${r.error}`);
	r = await rpc(sock, { action: "create", path: "assets", kind: "dir" });
	if (r.ok) fail("重复 create 应报错");
	else if (!/已存在/.test(r.error)) fail(`重名错误文案异常: ${r.error}`);
	else console.log("✓ create dir + 重名报错");

	r = await rpc(sock, { action: "rename", path: "docs/guide.md", newName: "tutorial.md" });
	if (!r.ok || !existsSync(join(workspace, "docs", "tutorial.md"))) fail(`rename failed: ${JSON.stringify(r)}`);
	else console.log("✓ rename");

	r = await rpc(sock, { action: "rename", path: "docs/tutorial.md", newName: "../evil.md" });
	if (r.ok) fail("rename 含 .. 未拒绝");
	else console.log("✓ rename 拒绝路径分隔符/..");

	r = await rpc(sock, { action: "flatlist" });
	if (!r.ok) fail(`flatlist failed: ${r.error}`);
	else {
		const files = r.files ?? [];
		if (files.some((f) => f.includes("node_modules"))) fail("flatlist 应跳过 node_modules");
		else if (!files.includes("README.md") || !files.includes("src/main.js") || !files.includes("docs/tutorial.md"))
			fail(`flatlist 缺项: ${files}`);
		else console.log(`✓ flatlist ${files.length} 个相对路径`);
	}

	r = await rpc(sock, { action: "delete", path: "docs" });
	if (!r.ok || existsSync(join(workspace, "docs"))) fail(`delete failed: ${JSON.stringify(r)}`);
	else console.log("✓ delete 目录递归删除");

	r = await rpc(sock, { action: "copy", src: "src/main.js", dest: "src/main_copy.js" });
	if (!r.ok) fail(`copy failed: ${r.error}`);
	else if (readFileSync(join(workspace, "src", "main_copy.js"), "utf-8") !== 'console.log("hello vsc");\n')
		fail("copy 内容不一致");
	else console.log("✓ copy 文件复制");

	r = await rpc(sock, { action: "copy", src: "src/main.js", dest: "src/main_copy.js" });
	if (r.ok) fail("copy 到已存在目标应拒绝");
	else console.log("✓ copy 拒绝覆盖已存在目标");

	r = await rpc(sock, { action: "copy", src: "src/main_copy.js", dest: "src/moved.js", move: true });
	if (!r.ok) fail(`move failed: ${r.error}`);
	else if (existsSync(join(workspace, "src", "main_copy.js")) || !existsSync(join(workspace, "src", "moved.js")))
		fail("move 未生效");
	else console.log("✓ copy move=true 移动");

	r = await rpc(sock, { action: "copy", src: "src", dest: "src-copy" });
	if (!r.ok) fail(`copy dir failed: ${r.error}`);
	else if (!existsSync(join(workspace, "src-copy", "main.js"))) fail("目录复制未递归");
	else console.log("✓ copy 目录递归复制");

	r = await rpc(sock, { action: "copy", src: "src", dest: "src/sub" });
	if (r.ok) fail("copy 到自身子目录应拒绝");
	else console.log("✓ copy 拒绝目标为源子目录");

	r = await rpc(sock, { action: "copy", src: "../outside.txt", dest: "evil.txt" });
	if (r.ok) fail("copy 越界源未拒绝");
	else console.log("✓ copy 路径越界被拒绝");

	r = await rpc(sock, { action: "search", query: "moved" });
	if (!r.ok) fail(`search failed: ${r.error}`);
	else if (!r.results.some((x) => x.path === "src/moved.js")) fail(`search 缺命中: ${JSON.stringify(r.results)}`);
	else console.log("✓ search 文件名命中");

	r = await rpc(sock, { action: "search", query: "MAIN" });
	if (!r.ok || !r.results.some((x) => x.path === "src/main.js")) fail("search 应大小写不敏感");
	else console.log("✓ search 大小写不敏感");

	r = await rpc(sock, { action: "search", query: "" });
	if (r.ok) fail("空关键词应拒绝");
	else console.log("✓ search 空关键词被拒绝");

	const b64 = (s) => Buffer.from(s).toString("base64");
	r = await rpc(sock, { action: "upload_begin", dir: "", name: "uploaded.txt", size: 11 });
	if (!r.ok || r.exists || !r.uploadId) fail(`upload_begin 新文件异常: ${JSON.stringify(r)}`);
	else {
		const uid = r.uploadId;
		const c1 = await rpc(sock, { action: "upload", uploadId: uid, i: 0, total: 2, b64: b64("hello ") });
		if (!c1.ok || c1.received !== 1) fail(`upload 分片 1 异常: ${JSON.stringify(c1)}`);
		else {
			const c2 = await rpc(sock, { action: "upload", uploadId: uid, i: 1, total: 2, b64: b64("world\n") });
			if (!c2.ok || !c2.done) fail(`upload 末片异常: ${JSON.stringify(c2)}`);
			else if (readFileSync(join(workspace, "uploaded.txt"), "utf-8") !== "hello world\n") fail("upload 未正确落盘");
			else console.log("✓ upload 分片上传落盘（新文件）");
		}
	}
	r = await rpc(sock, { action: "upload_begin", dir: "", name: "uploaded.txt", size: 2 });
	if (!r.ok || !r.exists) fail(`upload_begin 应报 exists: ${JSON.stringify(r)}`);
	else {
		const uid = r.uploadId;
		const c = await rpc(sock, { action: "upload", uploadId: uid, i: 0, total: 1, b64: b64("ok") });
		if (!c.ok || !c.done) fail(`upload 覆盖失败: ${JSON.stringify(c)}`);
		else if (readFileSync(join(workspace, "uploaded.txt"), "utf-8") !== "ok") fail("upload 覆盖未生效");
		else console.log("✓ upload 覆盖已存在文件（rename 原子取代）");
	}
	r = await rpc(sock, { action: "upload_begin", dir: "uploads/nested", name: "a.bin", size: 4 });
	if (!r.ok) fail(`upload_begin 子目录异常: ${JSON.stringify(r)}`);
	else {
		const c = await rpc(sock, {
			action: "upload",
			uploadId: r.uploadId,
			i: 0,
			total: 1,
			b64: Buffer.from([1, 2, 3, 4]).toString("base64"),
		});
		if (!c.ok) fail(`upload 子目录分片失败: ${JSON.stringify(c)}`);
		else if (!existsSync(join(workspace, "uploads", "nested", "a.bin"))) fail("upload 子目录未落盘");
		else console.log("✓ upload 自动创建目标目录");
	}
	r = await rpc(sock, { action: "upload_begin", dir: "", name: "../evil.txt", size: 1 });
	if (r.ok) fail("upload_begin 应拒绝 ../ 文件名");
	else console.log("✓ upload_begin 拒绝非法文件名");
	r = await rpc(sock, { action: "upload_begin", dir: "../../outside", name: "x.txt", size: 1 });
	if (r.ok) fail("upload_begin 应拒绝越界目录");
	else console.log("✓ upload_begin 拒绝越界目录");
	r = await rpc(sock, { action: "upload_begin", dir: "", name: "big.bin", size: 101 * 1024 * 1024 });
	if (r.ok) fail("upload_begin 应拒绝超上限大小");
	else console.log("✓ upload_begin 拒绝超上限文件大小");
	r = await rpc(sock, { action: "upload_begin", dir: "", name: "aborted.bin", size: 9 });
	if (!r.ok) fail(`upload_begin abort 场景失败: ${JSON.stringify(r)}`);
	else {
		const uid = r.uploadId;
		const c = await rpc(sock, { action: "upload", uploadId: uid, i: 0, total: 2, b64: b64("partial") });
		if (!c.ok) fail(`abort 前分片失败: ${JSON.stringify(c)}`);
		const ab = await rpc(sock, { action: "upload_abort", uploadId: uid });
		if (!ab.ok) fail("upload_abort 失败");
		if (existsSync(join(workspace, "aborted.bin"))) fail("abort 后不应落盘文件");
		const leftovers = readdirSync(workspace).filter((f) => f.startsWith(".vsc-upload-"));
		if (leftovers.length) fail(`abort 未清理临时文件: ${leftovers}`);
		else console.log("✓ upload_abort 丢弃分片 + 清理临时文件");
	}

	r = await rpc(sock, { action: "no-such-action" });
	if (r.ok) fail("未知 action 应失败");
	else console.log("✓ 未知 action 返回错误且进程存活");

	const jsRes = await fetch(`${BASE}/plugins/vscode-editor/client/entry.mjs`);
	const ct = jsRes.headers.get("content-type") ?? "";
	if (!jsRes.ok || !/javascript|ecmascript/.test(ct)) fail(`entry.mjs 静态服务异常: ${jsRes.status} ${ct}`);
	else if (!(await jsRes.text()).includes("vscode-editor 客户端 bundle")) fail("bundle 内容不符");
	else console.log("✓ client/entry.mjs 静态服务 200 + JS Content-Type");

	for (const u of [`${BASE}/plugins/vscode-editor/%2e%2e/index.mjs`, `${BASE}/plugins/vscode-editor/manifest.json`]) {
		const res = await fetch(u);
		const ct = res.headers.get("content-type") ?? "";
		const body = await res.text();
		if (/javascript|ecmascript/.test(ct) && /safeResolve|onMessage|路径越界/.test(body)) {
			fail(`插件服务端源码经 ${u} 泄露`);
		} else if (!/javascript|ecmascript/.test(ct)) {
			console.log(`✓ ${u.replace(BASE, "")} 未暴露插件文件（${ct.split(";")[0]}）`);
		}
	}
	sock.close();
} catch (err) {
	fail(err.message);
	console.error(err);
} finally {
	try {
		if (proc?.pid) process.kill(proc.pid, "SIGTERM");
	} catch {}
	await new Promise((r) => setTimeout(r, 500));
	let cleanErr;
	for (let i = 0; i < 120; i++) {
		try {
			rmSync(dataDir, { recursive: true, force: true });
			cleanErr = undefined;
			break;
		} catch (err) {
			cleanErr = err;
			if (err?.code === "ENOENT") break;
			await new Promise((r) => setTimeout(r, 500));
		}
	}
	if (cleanErr) {
		fail(`临时目录清理失败: ${cleanErr.message}`);
		console.error(cleanErr);
	}
}
process.exit(process.exitCode ?? 0);
