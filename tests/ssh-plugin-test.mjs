/**
 * 编辑器插件（vscode-editor，含 Remote-SSH）协议冒烟测试（零 token、自包含）。
 *
 * 用 ssh2 自带的 Server 在进程内起一个 mock SSH 远端（密码认证 + PTY shell
 * 回显 + exec + 内存 SFTP），把 plugins/vscode-editor 拷进临时 data-dir 并
 * 离线补装 ssh2（从本仓库构建目录拷贝 node_modules 子集），起隔离端口 server 验证：
 * - state / hosts_save（校验+脱敏）/ hosts_delete
 * - connect：错误密码拒绝、正确密码建立
 * - shell_open → 欢迎横幅；shell_input 回显
 * - exec 输出与退出码
 * - 远程文件全链路：与本地同名 action 带 connId（list/read/write/create/
 *   rename/delete 路由到该连接的 SFTP；内存文件系统核对）
 * - 本地文件操作不受影响（不带 connId）
 * - disconnect → conn_closed 事件
 *
 * 运行：先 npm run build:server，再 node tests/ssh-plugin-test.mjs
 */
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { setTimeout as sleep } from "node:timers/promises";
import { startMockSsh, dirs as mDirs, files as mFiles, ensurePluginSsh2Dep } from "./lib/mock-ssh.mjs";
import WebSocket from "ws";

const PORT = 8964;
const SSH_PORT = 22964;
const PLUGIN_ID = "vscode-editor";
const BASE = `http://127.0.0.1:${PORT}`;
const REPO = fileURLDirname(import.meta.url);

function fileURLDirname(u) {
	return realpathSync(new globalThis.URL("..", u).pathname.replace(/^\/(?=[A-Za-z]:)/, ""));
}

const serverPath = realpathSync(process.execPath);
let proc = null;
let sshServer = null;
let shells = [];
const dataDir = mkdtempSync(join(tmpdir(), "pi-web-ssh-test-"));
const plugDst = join(dataDir, "plugins", PLUGIN_ID);

// ---- 种插件目录 + 离线补装 ssh2 --------------------------------------------
mkdirSync(plugDst, { recursive: true });
cpSync(join(REPO, "plugins/vscode-editor/manifest.json"), join(plugDst, "manifest.json"));
cpSync(join(REPO, "plugins/vscode-editor/index.mjs"), join(plugDst, "index.mjs"));
cpSync(join(REPO, "plugins/vscode-editor/client"), join(plugDst, "client"), { recursive: true });
// 准备 ssh2 依赖：离线拷本地构建目录；CI 上回退 npm install
ensurePluginSsh2Dep(plugDst, join(REPO, "plugins/vscode-editor"));

// 本地工作区种一个文件（验证本地操作不受 Remote-SSH 改造影响）
mkdirSync(join(dataDir, "local-proj"), { recursive: true });

function fail(msg) {
	console.error(`✗ ${msg}`);
	process.exitCode = 1;
}

// ---- WS 工具 ----------------------------------------------------------------
function connect(clientId = "ssh-test") {
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

function rpc(sock, payload, timeoutMs = 25_000) {
	return new Promise((resolve, reject) => {
		const reqId = `t${Math.random().toString(36).slice(2)}`;
		const timer = setTimeout(() => reject(new Error(`rpc timeout: ${payload.action}`)), timeoutMs);
		const onMsg = (raw) => {
			const msg = JSON.parse(raw.toString());
			if (
				msg.type === "plugin_data" &&
				msg.pluginId === PLUGIN_ID &&
				msg.payload?.res &&
				msg.payload?.reqId === reqId
			) {
				clearTimeout(timer);
				sock.off("message", onMsg);
				resolve(msg.payload);
			}
		};
		sock.on("message", onMsg);
		sock.send(JSON.stringify({ type: "plugin_message", pluginId: PLUGIN_ID, payload: { ...payload, reqId } }));
	});
}

/** 收集事件直到谓词命中或超时。 */
function waitForEvent(sock, pred, label, timeoutMs = 15000) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			sock.off("message", onMsg);
			reject(new Error(`timeout waiting for event: ${label}`));
		}, timeoutMs);
		const onMsg = (raw) => {
			const m = JSON.parse(raw.toString());
			if (m.type === "plugin_data" && m.pluginId === PLUGIN_ID && m.payload?.event && pred(m.payload)) {
				clearTimeout(timer);
				sock.off("message", onMsg);
				resolve(m.payload);
			}
		};
		sock.on("message", onMsg);
	});
}

/** 等到某条 shell_data 的累计输出里出现指定文本。 */
async function expectShellText(sock, connId, text, timeoutMs = 15000) {
	let acc = "";
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			sock.off("message", onMsg);
			reject(new Error(`shell 未出现「${text}」，实际累计：${JSON.stringify(acc.slice(-300))}`));
		}, timeoutMs);
		const onMsg = (raw) => {
			const m = JSON.parse(raw.toString());
			const p = m.payload;
			if (m.type === "plugin_data" && p?.event === "shell_data" && p.connId === connId) {
				acc += Buffer.from(p.b64, "base64").toString("utf8");
				if (acc.includes(text)) {
					clearTimeout(timer);
					sock.off("message", onMsg);
					resolve(acc);
				}
			}
		};
		sock.on("message", onMsg);
	});
}

// ---- 主流程 ------------------------------------------------------------------
try {
	sshServer = await startMockSsh(plugDst, SSH_PORT);

	proc = spawn(serverPath, [join(REPO, "dist", "server", "index.js")], {
		env: { ...process.env, PI_WEB_PORT: String(PORT), PI_WEB_DATA_DIR: dataDir, PI_WEB_CWD: dataDir },
		stdio: ["ignore", "pipe", "pipe"],
	});
	proc.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));

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

	// -- 0. onAttach 推送：新客户端接入后不发任何请求，也应主动收到初始状态 ------
	{
		const statePush = await new Promise((resolve) => {
			const timer = setTimeout(() => resolve(null), 10_000);
			const onMsg = (raw) => {
				const m = JSON.parse(raw.toString());
				if (m.type === "plugin_data" && m.pluginId === PLUGIN_ID && m.payload?.kind === "state") {
					clearTimeout(timer);
					sock.off("message", onMsg);
					resolve(m.payload);
				}
			};
			sock.on("message", onMsg);
		});
		if (!statePush?.state || !Array.isArray(statePush.state.hosts)) fail('onAttach 未主动推送 kind:"state" 初始状态');
		else console.log("✓ attach 后主动收到插件状态推送（服务端唯一事实源）");
	}

	// -- 1. state：初始状态 + 依赖已就绪（我们拷了 ssh2） ------------------------
	let r = await rpc(sock, { action: "state" });
	if (!r.ok || !Array.isArray(r.state?.hosts)) fail(`state 异常: ${JSON.stringify(r)}`);
	else if (!r.state.depsReady) fail("deps 应已就绪（已离线拷贝 ssh2）");
	else console.log("✓ state 初始返回，ssh2 依赖就绪");

	// -- 1b. 本地文件操作（不带 connId）不受改造影响 --------------------------------
	r = await rpc(sock, { action: "write", path: "local-proj/a.txt", text: "local-hello" });
	if (!r.ok) fail(`本地 write 失败: ${r.error}`);
	r = await rpc(sock, { action: "read", path: "local-proj/a.txt" });
	if (!r.ok || r.text !== "local-hello") fail(`本地 read 不一致: ${JSON.stringify(r)}`);
	else console.log("✓ 本地文件读写正常（无 connId 直走 fs）");

	// -- 2. 主机配置：校验 + 脱敏 -------------------------------------------------
	r = await rpc(sock, { action: "hosts_save", host: { name: "", host: "" } });
	if (r.ok) fail("空主机地址应被拒绝");
	else console.log("✓ 空 host 校验拒绝");

	r = await rpc(sock, {
		action: "hosts_save",
		host: { name: "bad", host: "127.0.0.1", port: SSH_PORT, username: "tester", password: "wrong" },
	});
	if (!r.ok) fail(`hosts_save bad 失败: ${r.error}`);

	r = await rpc(sock, {
		action: "hosts_save",
		host: { name: "local", host: "127.0.0.1", port: SSH_PORT, username: "tester", password: "secret123" },
	});
	if (!r.ok) fail(`hosts_save 失败: ${r.error}`);
	r = await rpc(sock, { action: "state" });
	const goodHost = r.state.hosts.find((h) => h.name === "local");
	const badHost = r.state.hosts.find((h) => h.name === "bad");
	if (!goodHost || !goodHost.hasPass || goodHost.password !== undefined)
		fail(`主机回显应脱敏: ${JSON.stringify(goodHost)}`);
	else console.log("✓ hosts_save 落盘 + 回显脱敏（password 不回传）");

	// 凭据已迁移进加密机密库（host.secrets）：ssh-hosts.json 不再含明文密码，
	// secrets.bin 存在；后续 connect 步骤验证真实密码仍可认证。
	const plugDirPath = join(dataDir, "plugins", PLUGIN_ID);
	const cfgRaw = readFileSync(join(plugDirPath, "ssh-hosts.json"), "utf8");
	if (cfgRaw.includes("secret123")) fail("明文密码不应落在 ssh-hosts.json（应只在加密机密库）");
	else console.log("✓ ssh-hosts.json 不再含明文密码（已迁入 host.secrets）");
	if (!existsSync(join(plugDirPath, "secrets.bin"))) fail("secrets.bin 机密文件缺失");
	else console.log("✓ 加密机密文件 secrets.bin 已生成");

	// -- 3. 连接：错误密码拒绝 ----------------------------------------------------
	r = await rpc(sock, { action: "connect", id: badHost.id }, 30_000);
	if (r.ok) fail("错误密码不应连上");
	else console.log(`✓ 错误密码连接被拒（${r.error.slice(0, 40)}…）`);

	// -- 4. 正确密码连接 ----------------------------------------------------------
	r = await rpc(sock, { action: "connect", id: goodHost.id }, 30_000);
	if (!r.ok || !r.connId) fail(`connect 失败: ${JSON.stringify(r)}`);
	else console.log(`✓ 连接成功 connId=${r.connId}`);
	const connId = r.connId;

	// -- 5. PTY shell：横幅 + 输入回显 ---------------------------------------------
	r = await rpc(sock, { action: "shell_open", connId, cols: 120, rows: 30 });
	if (!r.ok || !r.shellId) fail(`shell_open 失败: ${JSON.stringify(r)}`);
	await expectShellText(sock, connId, "welcome-to-mock");
	console.log("✓ shell 打开并收到欢迎横幅");

	sock.send(
		JSON.stringify({
			type: "plugin_message",
			pluginId: PLUGIN_ID,
			payload: {
				action: "shell_input",
				connId,
				shellId: r.shellId,
				b64: Buffer.from("ping-test\r").toString("base64"),
			},
		}),
	);
	await expectShellText(sock, connId, "echo:ping-test");
	console.log("✓ 终端输入回显正常");

	// -- 6. exec --------------------------------------------------------------------
	r = await rpc(sock, { action: "exec", connId, cmd: "echo abc-123" });
	if (!r.ok || r.exitCode !== 0 || !r.output.includes("abc-123")) fail(`exec 异常: ${JSON.stringify(r)}`);
	else console.log("✓ exec 输出与退出码 0");

	r = await rpc(sock, { action: "exec", connId, cmd: "fail-now" });
	if (!r.ok || r.exitCode !== 7 || !r.output.includes("boom")) fail(`exec 失败命令异常: ${JSON.stringify(r)}`);
	else console.log("✓ exec 非零退出码 + stderr 合并");

	// -- 7. 远程目录列表（统一 action list + connId） ----------------------------------
	r = await rpc(sock, { action: "list", connId, dir: "/home/test" });
	if (!r.ok) fail(`远程 list 失败: ${r.error}`);
	else {
		const names = r.entries.map((e) => e.name);
		if (!(names.includes("a.txt") && names.includes("sub") && names.includes("big.bin"))) fail(`列表缺项: ${names}`);
		else if (r.entries[r.entries.length - 1].type !== "file") fail("文件应排在目录后");
		else console.log(`✓ 远程 list（connId 路由）${names.join(", ")}`);
	}

	// -- 8. 远程读（文本 + 二进制嗅探） -----------------------------------------------
	r = await rpc(sock, { action: "read", connId, path: "/home/test/a.txt" });
	if (!r.ok || r.text !== "hello ssh\n第二行\n") fail(`远程 read 文本异常: ${JSON.stringify(r)}`);
	else console.log("✓ 远程 read 文本内容");

	r = await rpc(sock, { action: "read", connId, path: "/home/test/big.bin" });
	if (!r.ok || r.binary !== true) fail(`二进制嗅探异常: ${JSON.stringify(r)}`);
	else console.log("✓ 远程 read 二进制标记（NUL 嗅探）");

	// -- 9. 远程写 → 读回核对 ----------------------------------------------------------
	r = await rpc(sock, { action: "write", connId, path: "/home/test/b.txt", text: "written-by-test 中文" });
	if (!r.ok) fail(`远程 write 失败: ${r.error}`);
	r = await rpc(sock, { action: "read", connId, path: "/home/test/b.txt" });
	if (!r.ok || r.text !== "written-by-test 中文") fail(`write→read 不一致: ${JSON.stringify(r)}`);
	else console.log("✓ 远程 write 写入后读回一致（UTF-8）");

	// -- 10. create / rename / delete ---------------------------------------------------
	r = await rpc(sock, { action: "create", connId, path: "/home/test/newdir", kind: "dir" });
	if (!r.ok || !mDirs["/home/test/newdir"]) fail(`create dir 异常: ${JSON.stringify(r)}`);
	else console.log("✓ 远程 create 目录");

	r = await rpc(sock, { action: "rename", connId, path: "/home/test/b.txt", newName: "renamed.txt" });
	if (!r.ok || !mFiles["/home/test/renamed.txt"] || mFiles["/home/test/b.txt"])
		fail(`rename 异常: ${JSON.stringify(r)}`);
	else console.log("✓ 远程 rename");

	r = await rpc(sock, { action: "delete", connId, path: "/home/test/renamed.txt", isDir: false });
	if (!r.ok || mFiles["/home/test/renamed.txt"]) fail(`delete 异常: ${JSON.stringify(r)}`);
	else console.log("✓ 远程 delete 文件");

	// rename 含路径分隔符应拒绝
	r = await rpc(sock, { action: "rename", connId, path: "/home/test/sub", newName: "../evil" });
	if (r.ok) fail("rename ../ 应拒绝");
	else console.log("✓ rename 非法名称拒绝");

	// -- 10b. 远程上传（connId 路由，分片暂存内存末片一次 sftp.writeFile） ------------------
	const b64 = (s) => Buffer.from(s).toString("base64");
	// 新文件
	r = await rpc(sock, { action: "upload_begin", connId, dir: "/home/test", name: "remote-up.bin", size: 7 });
	if (!r.ok || r.exists || !r.uploadId) fail(`远程 upload_begin 异常: ${JSON.stringify(r)}`);
	else {
		const uid = r.uploadId;
		const c1 = await rpc(sock, { action: "upload", connId, uploadId: uid, i: 0, total: 2, b64: b64("remote") });
		if (!c1.ok || c1.received !== 1) fail(`远程分片 1 异常: ${JSON.stringify(c1)}`);
		else {
			const c2 = await rpc(sock, { action: "upload", connId, uploadId: uid, i: 1, total: 2, b64: b64("-up\n") });
			if (!c2.ok || !c2.done) fail(`远程末片异常: ${JSON.stringify(c2)}`);
			else if (mFiles["/home/test/remote-up.bin"].toString() !== "remote-up\n") fail("远程 upload 未落盘");
			else console.log("✓ 远程 upload 分片上传落盘（exists=false）");
		}
	}
	// 已存在文件：exists=true（覆盖确认依据）
	r = await rpc(sock, { action: "upload_begin", connId, dir: "/home/test", name: "remote-up.bin", size: 2 });
	if (!r.ok || !r.exists) fail(`远程 upload_begin 应报 exists: ${JSON.stringify(r)}`);
	else console.log("✓ 远程 upload_begin 识别已存在文件（exists=true）");
	// 目标目录不存在：自动创建（与本地同语义）
	r = await rpc(sock, { action: "upload_begin", connId, dir: "/home/test/new/sub", name: "deep.txt", size: 4 });
	if (!r.ok) fail(`远程子目录 upload_begin 失败: ${JSON.stringify(r)}`);
	else {
		const c = await rpc(sock, { action: "upload", connId, uploadId: r.uploadId, i: 0, total: 1, b64: b64("deep") });
		if (!c.ok || !c.done) fail(`远程子目录上传失败: ${JSON.stringify(c)}`);
		else if (mFiles["/home/test/new/sub/deep.txt"]?.toString() !== "deep") fail("远程子目录上传未落盘");
		else console.log("✓ 远程 upload 自动创建目标目录");
	}
	// abort：分片未写盘（内存暂存，末片才 sftp.writeFile）
	r = await rpc(sock, { action: "upload_begin", connId, dir: "/home/test", name: "abort-me.bin", size: 9 });
	if (!r.ok) fail(`远程 abort 场景 upload_begin 失败: ${JSON.stringify(r)}`);
	else {
		const uid = r.uploadId;
		const c = await rpc(sock, { action: "upload", connId, uploadId: uid, i: 0, total: 2, b64: b64("partial") });
		if (!c.ok) fail(`远程 abort 前分片失败: ${JSON.stringify(c)}`);
		await rpc(sock, { action: "upload_abort", connId, uploadId: uid });
		if (mFiles["/home/test/abort-me.bin"]) fail("远程 abort 后不应落盘");
		else console.log("✓ 远程 upload_abort 丢弃内存分片不落盘");
	}

	// -- 11. disconnect → conn_closed --------------------------------------------------------
	const closedP = waitForEvent(sock, (p) => p.event === "conn_closed" && p.connId === connId, "conn_closed");
	await rpc(sock, { action: "disconnect", connId });
	await closedP;
	console.log("✓ disconnect 触发 conn_closed 事件");

	// -- 12. hosts_delete --------------------------------------------------------------------
	r = await rpc(sock, { action: "hosts_delete", id: badHost.id });
	if (!r.ok) fail(`hosts_delete 失败: ${r.error}`);
	r = await rpc(sock, { action: "state" });
	if (r.state.hosts.some((h) => h.id === badHost.id)) fail("主机未删除");
	else console.log("✓ hosts_delete");

	// -- 13. 未知 action ------------------------------------------------------------------------
	r = await rpc(sock, { action: "no-such" });
	if (r.ok) fail("未知 action 应失败");
	else console.log("✓ 未知 action 报错不崩");

	// -- 14. 同步配置文件（工作区 .vscode/sftp.json，vscode-sftp 兼容格式） ---------------------
	r = await rpc(sock, { action: "sync_get" });
	if (!r.ok) fail(`sync_get 失败: ${r.error}`);
	else if (r.config.configured) fail("未配置时 configured 应为 false");
	else if (r.configPath !== ".vscode/sftp.json") fail("configPath 应为 .vscode/sftp.json");
	else console.log("✓ sync_get 初始未配置（configured:false + configPath）");

	// 保存 → 以 vscode-sftp 字段名落到工作区 .vscode/sftp.json
	r = await rpc(sock, {
		action: "sync_save",
		config: {
			host: "127.0.0.1",
			port: SSH_PORT,
			username: "test",
			password: "secret",
			remoteRoot: "/home/test",
			exclude: ["node_modules/**", "**/*.map", "*.log"],
			uploadOnSave: true,
		},
	});
	if (!r.ok) fail(`sync_save 失败: ${r.error}`);
	const cfgFile = join(dataDir, ".vscode", "sftp.json");
	let rawCfg = {};
	try {
		rawCfg = JSON.parse(readFileSync(cfgFile, "utf8"));
	} catch {}
	if (
		rawCfg.host !== "127.0.0.1" ||
		rawCfg.remotePath !== "/home/test" ||
		!Array.isArray(rawCfg.ignore) ||
		rawCfg.uploadOnSave !== true
	) {
		fail(`sftp.json 内容异常: ${JSON.stringify(rawCfg)}`);
	} else if (rawCfg.password !== "secret") {
		fail("sftp.json 应保存密码（本机文件约定，供 vscode-sftp 兼容读取）");
	} else console.log("✓ sync_save 写入工作区 .vscode/sftp.json（remotePath/ignore 字段名）");

	// 回读：configured + 凭据脱敏（不回传明文，只报 hasPass）
	r = await rpc(sock, { action: "sync_get" });
	if (!r.ok || !r.config.configured || r.config.hasPass !== true || r.config.password !== undefined) {
		fail(`sync_get 回读异常: ${JSON.stringify(r)}`);
	} else if (r.config.exclude?.length !== 3 || r.config.uploadOnSave !== true) {
		fail("sync_get 回读 ignore/uploadOnSave 不一致");
	} else console.log("✓ sync_get 回读脱敏（hasPass，不回传明文密码）");

	// 密码/私钥留空 = 沿用旧值
	r = await rpc(sock, {
		action: "sync_save",
		config: {
			host: "127.0.0.1",
			port: SSH_PORT,
			username: "test",
			remoteRoot: "/home/test",
		},
	});
	if (!r.ok || r.config.hasPass !== true) fail(`留空密码应沿用旧值: ${JSON.stringify(r)}`);
	else console.log("✓ sync_save 留空凭据沿用旧值");

	// 非法远端根拒绝
	r = await rpc(sock, { action: "sync_save", config: { host: "x", port: 22, remoteRoot: "relative/path" } });
	if (r.ok) fail("相对路径 remoteRoot 应拒绝");
	else console.log("✓ 相对路径远端根拒绝");

	// sync_ensure：已配置时只返回路径，不覆盖现有配置
	r = await rpc(sock, { action: "sync_ensure" });
	if (!r.ok || r.path !== ".vscode/sftp.json") fail(`sync_ensure 异常: ${JSON.stringify(r)}`);
	rawCfg = JSON.parse(readFileSync(cfgFile, "utf8"));
	if (rawCfg.host !== "127.0.0.1") fail("sync_ensure 不应覆盖已有配置");
	else console.log("✓ sync_ensure 返回配置文件路径且不覆盖");

	// -- 15. 同步回环：down/up 单文件（真实走 mock SFTP） ---------------------------------
	// 写工作区 .vscode/sftp.json 指向 mock SSH（tester/secret123）
	r = await rpc(sock, {
		action: "write",
		path: ".vscode/sftp.json",
		text: JSON.stringify({
			host: "127.0.0.1",
			port: SSH_PORT,
			username: "tester",
			password: "secret123",
			remotePath: "/home/test",
			uploadOnSave: false,
			ignore: [],
		}),
	});
	if (!r.ok) fail(`写 .vscode/sftp.json 失败: ${r.error}`);

	// down：远端 a.txt → 本地工作区
	rmSync(join(dataDir, "a.txt"), { force: true });
	r = await rpc(sock, { action: "sync_run", dir: "down", scope: "file", path: "a.txt" }, 30_000);
	if (!r.ok) fail(`sync_run down 失败: ${r.error}`);
	let dlText = "";
	try {
		dlText = readFileSync(join(dataDir, "a.txt"), "utf8");
	} catch {}
	if (dlText !== "hello ssh\n第二行\n") fail(`down 内容不符: ${JSON.stringify(dlText)}`);
	else console.log("✓ sync down：远端文件下载到本地工作区");

	// up：本地新建文件 → 远端内存
	r = await rpc(sock, { action: "write", path: "b.txt", text: "local-upload\n" });
	if (!r.ok) fail(`写本地 b.txt 失败: ${r.error}`);
	r = await rpc(sock, { action: "sync_run", dir: "up", scope: "file", path: "b.txt" }, 30_000);
	if (!r.ok) fail(`sync_run up 失败: ${r.error}`);
	const upBuf = mFiles["/home/test/b.txt"];
	if (!upBuf || !upBuf.toString().includes("local-upload")) fail("up 后远端没有 b.txt");
	else console.log("✓ sync up：本地文件上传到远端");
	delete mFiles["/home/test/b.txt"]; // 清理，不污染其它断言
	rmSync(join(dataDir, "b.txt"), { force: true });
	rmSync(join(dataDir, "a.txt"), { force: true });

	// -- 16. download：本地文件下载到电脑（base64 经 WS） ---------------------------------
	r = await rpc(sock, { action: "write", path: "dl.bin", text: "download-me\n" });
	if (!r.ok) fail(`写 dl.bin 失败: ${r.error}`);
	r = await rpc(sock, { action: "download", path: "dl.bin" });
	if (!r.ok || Buffer.from(r.b64, "base64").toString("utf8") !== "download-me\n") {
		fail(`download 内容不符: ${JSON.stringify(r).slice(0, 120)}`);
	} else console.log("✓ download：本地文件 base64 回传正确");

	r = await rpc(sock, { action: "download", path: "../outside.txt" });
	if (r.ok) fail("download ../ 越界应拒绝");
	else console.log("✓ download：路径越界拒绝");

	// -- 17. 远端文件/文件夹直接下载到电脑（不经工作区映射） -------------------------------
	// 重新连接 mock 主机（§11 已断开）
	r = await rpc(sock, { action: "state" });
	const hid2 = r.state.hosts.find((h) => h.name === "local").id;
	r = await rpc(sock, { action: "connect", id: hid2 }, 30_000);
	if (!r.ok) fail(`重连失败: ${r.error}`);
	const cid2 = r.connId;

	r = await rpc(sock, { action: "download", connId: cid2, path: "/home/test/a.txt" });
	if (!r.ok || Buffer.from(r.b64, "base64").toString("utf8") !== "hello ssh\n第二行\n" || r.name !== "a.txt") {
		fail(`远端文件下载异常: ${JSON.stringify({ ...r, b64: undefined }).slice(0, 160)}`);
	} else console.log("✓ download 远端：单文件内容与文件名正确");

	r = await rpc(sock, { action: "download", connId: cid2, path: "/home/test/sub" });
	if (!r.ok || !r.name?.endsWith("sub.tar.gz")) {
		fail(`远端文件夹打包下载异常: ${JSON.stringify({ ...r, b64: undefined })}`);
	} else {
		const raw = gunzipSync(Buffer.from(r.b64, "base64"));
		if (!raw.includes(Buffer.from("sub", "utf8"))) fail("tar.gz 内未包含目录名 sub");
		else console.log("✓ download 远端：文件夹 tar.gz 打包内容正确");
	}

	r = await rpc(sock, { action: "download", connId: cid2, path: "../evil" });
	if (r.ok) fail("远端 download ../ 应拒绝");
	else console.log("✓ download 远端：路径越界拒绝");

	sock.close();
} catch (err) {
	fail(err.message);
	console.error(err);
} finally {
	try {
		for (const s of shells)
			try {
				s.end();
			} catch {}
		sshServer?.close();
		if (proc?.pid) process.kill(proc.pid, "SIGTERM");
	} catch {}
	await sleep(500);
	rmSync(dataDir, { recursive: true, force: true });
}
process.exit(process.exitCode ?? 0);
