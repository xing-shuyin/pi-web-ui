import { spawn } from "node:child_process";
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { dirs as mDirs, files as mFiles, ensurePluginSsh2Dep, startMockSsh } from "./lib/mock-ssh.mjs";
import { ensureBuild } from "./lib/ensure-build.mjs";
import WebSocket from "ws";

const PORT = Number(process.argv[2] || 8976);
const SSH_PORT = PORT + 10000;
const PLUGIN_ID = "sftp";
const BASE = `http://127.0.0.1:${PORT}`;
const API = `${BASE}/plugins-api/${PLUGIN_ID}`;
const REPO = fileURLDirname(import.meta.url);
const PASS = "secret123";

function fileURLDirname(u) {
	return realpathSync(new globalThis.URL("..", u).pathname.replace(/^\/(?=[A-Za-z]:)/, ""));
}

ensureBuild(REPO, "sftp-plugin-test");

const serverPath = realpathSync(process.execPath);
const dataDir = mkdtempSync(join(tmpdir(), "pi-web-sftp-test-"));
const workDir = join(dataDir, "proj");
const plugDst = join(dataDir, "plugins", PLUGIN_ID);
let proc = null;
let sshServer = null;

function fail(msg) {
	console.error(`✗ ${msg}`);
	process.exitCode = 1;
}

function ok(msg) {
	console.log(`✓ ${msg}`);
}

function check(cond, msg) {
	if (cond) ok(msg);
	else fail(msg);
}

mkdirSync(join(workDir, "src", "sub"), { recursive: true });
mkdirSync(join(workDir, "node_modules", "junk"), { recursive: true });
mkdirSync(join(workDir, ".pi"), { recursive: true });
writeFileSync(join(workDir, "a.txt"), "hello ssh\n第二行\n", "utf8");
writeFileSync(join(workDir, "src", "new.txt"), "brand new\n", "utf8");
writeFileSync(join(workDir, "node_modules", "junk", "index.js"), "module.exports = 1;\n", "utf8");

const MODE = process.env.PI_WEB_SDK === "bundled" ? "bundled" : "global";
mkdirSync(plugDst, { recursive: true });
cpSync(join(REPO, "plugins", PLUGIN_ID, "manifest.json"), join(plugDst, "manifest.json"));
cpSync(join(REPO, "plugins", PLUGIN_ID, "index.mjs"), join(plugDst, "index.mjs"));
cpSync(join(REPO, "plugins", PLUGIN_ID, "lib"), join(plugDst, "lib"), { recursive: true });
cpSync(join(REPO, "plugins", PLUGIN_ID, "client"), join(plugDst, "client"), { recursive: true });
ensurePluginSsh2Dep(plugDst, join(REPO, "plugins", "vscode-editor"));

const CONFIG_PATH = join(workDir, ".pi", "sftp.json");
function writeConfig(obj) {
	writeFileSync(CONFIG_PATH, `${JSON.stringify(obj, null, "\t")}\n`, "utf8");
}

function spawnServer() {
	const p = spawn(serverPath, [join(REPO, "dist", "server", "index.js")], {
		env: {
			...process.env,
			PI_WEB_PORT: String(PORT),
			PI_WEB_DATA_DIR: dataDir,
			PI_WEB_CWD: workDir,
			PI_WEB_SSH_KNOWN_HOSTS: join(dataDir, "known_hosts"),
			PI_WEB_SDK: MODE,
			PI_WEB_TEST_PASS: PASS,
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	p.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));
	return p;
}

async function waitHealthy() {
	await new Promise((resolve, reject) => {
		const t0 = Date.now();
		const probe = async () => {
			try {
				const r = await fetch(`${BASE}/api/health`);
				if (r.ok) return resolve();
			} catch {}
			if (Date.now() - t0 > 25_000) return reject(new Error("server not ready"));
			setTimeout(probe, 300);
		};
		void probe();
	});
}

writeConfig({
	version: 1,
	active: "mock",
	connections: {
		mock: {
			host: "127.0.0.1",
			port: SSH_PORT,
			username: "tester",
			remotePath: "/home/test",
			auth: { method: "password", password: PASS },
		},
	},
});

async function api(path, { method = "GET", body } = {}) {
	const init = { method };
	if (body !== undefined) {
		init.headers = { "content-type": "application/json" };
		init.body = JSON.stringify(body);
	}
	const res = await fetch(`${API}${path}`, init);
	let json = null;
	try {
		json = await res.json();
	} catch {}
	return { status: res.status, ...json };
}

function readPlugins() {
	return new Promise((resolve, reject) => {
		const sock = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
		const timer = setTimeout(() => {
			sock.close();
			reject(new Error("plugins 清单超时"));
		}, 15_000);
		sock.on("open", () => sock.send(JSON.stringify({ type: "hello", clientId: "sftp-test" })));
		sock.on("message", (raw) => {
			const m = JSON.parse(raw.toString());
			if (m.type === "plugins") {
				clearTimeout(timer);
				sock.close();
				resolve(m.plugins ?? []);
			}
		});
		sock.on("error", (err) => {
			clearTimeout(timer);
			reject(err);
		});
	});
}

function trashKeysUnder(prefix) {
	return Object.keys(mFiles).filter((k) => k.startsWith(prefix));
}

try {
	sshServer = await startMockSsh(plugDst, SSH_PORT);
	writeFileSync(
		join(dataDir, "known_hosts"),
		`[127.0.0.1]:${SSH_PORT} ssh-rsa ${sshServer.hostPublicKey.toString("base64")}\n`,
	);

	proc = spawnServer();
	await waitHealthy();

	let pluginsSnapshot = [];
	let fastPlanSummary = null;
	{
		pluginsSnapshot = await readPlugins();
		const me = pluginsSnapshot.find((p) => p.id === PLUGIN_ID);
		check(Boolean(me), "plugins 清单里能看到本插件");
		check(me?.active === true, "插件激活成功");
		const names = (me?.agentTools ?? []).map((x) => x.name);
		check(names.length === 1 && names[0] === "sftp", `AI 工具合并为一个（${names.join(", ")}）`);
		const src = readFileSync(join(REPO, "plugins", PLUGIN_ID, "index.mjs"), "utf8");
		const enumBlock = src.slice(
			src.indexOf("const SFTP_ACTIONS = ["),
			src.indexOf("];", src.indexOf("const SFTP_ACTIONS = [")),
		);
		const actions = [...enumBlock.matchAll(/"([a-z]+)"/g)].map((m) => m[1]);
		const want = [
			"status",
			"save",
			"secret",
			"test",
			"plan",
			"sync",
			"ls",
			"read",
			"write",
			"mkdir",
			"mv",
			"rm",
			"search",
			"exec",
		];
		check(
			want.every((a) => actions.includes(a)),
			`sftp 动作表完整（${actions.length} 个：${actions.join(", ")}）`,
		);
		check(
			/src\.includes\(\s*`\$\{secret:\$\{name\}\}`/.test(src) || src.includes("${secret:${name}}"),
			"secret 动作只回引用（${secret:名}），不回明文",
		);
		const uiItems = me?.ui?.items ?? [];
		const barItems = uiItems.filter((x) => x.slot !== "contextmenu.file");
		check(
			barItems.length === 1 && barItems[0]?.slot === "topbar.primary" && barItems[0]?.kind === "view",
			`界面上只有一个 SFTP 入口（${barItems.map((x) => `${x.slot}/${x.id}/${x.kind}`).join(", ") || "无"}）`,
		);
		check(
			barItems[0]?.id === "__view" && barItems[0]?.view === `plugin:${PLUGIN_ID}`,
			"顶栏入口就是插件自己的视图 tab（id __view，不再依赖宿主合成 + 手动钉住）",
		);
		check(!uiItems.some((x) => x.slot === "bottombar"), "底栏不再有 SFTP 条目");
		check(
			uiItems.filter((x) => x.slot === "contextmenu.file").length === 6,
			"文件右键菜单包含六条上传、下载及忽略动作",
		);
		const clientSrc = readFileSync(join(REPO, "plugins", PLUGIN_ID, "client", "entry.mjs"), "utf8");
		for (const action of [
			"sftp:upload-file",
			"sftp:upload-dir",
			"sftp:download-file",
			"sftp:download-dir",
			"sftp:ignore-item",
			"sftp:unignore-item",
		]) {
			check(
				clientSrc.includes(`"${action}"`) && /onUiAction\?\.\(/.test(clientSrc),
				`右键菜单动作 ${action} 已被客户端接管`,
			);
		}
		check(
			(me?.ui?.items ?? []).every((x) => !/^sftp:open$/.test(x.action ?? "")),
			"没有残留的无人接管动作 sftp:open",
		);
	}

	{
		const r = await api("/state");
		const d = r.data;
		check(r.status === 200 && r.ok, "GET /state 可用");
		check(d?.active === "mock" && d?.profiles?.length === 1, `active/perfiles 正确（${d?.active}）`);
		check(d?.connection?.remotePath === "/home/test" && d?.connection?.ready === true, "连接解析：remotePath 与 ready");
		check(d?.connection?.auth?.password === "plain", "凭据脱敏：明文只报 plain，不回真值");
		check(JSON.stringify(d ?? {}).includes(PASS) === false, "state 里不含任何明文口令");
		check(d?.plaintext?.length === 1, "明文凭据告警被识别（auth.password）");
	}

	{
		const r = await api("/test", { method: "POST", body: { profile: "mock" } });
		check(r.ok && r.data?.remoteExists === true, "test：连接成功且远端根存在");
		check(r.data?.writable === true, "test：探针文件可写可删（写权限正常）");
	}

	{
		const r = await api("/plan", { method: "POST", body: { scope: "all" } });
		const s = r.data?.plan?.summary;
		check(r.ok, "POST /plan 可用");
		check(s?.upload === 1, `计划：本地独有 1 个待上传（实际 ${s?.upload}）`);
		check(s?.skip === 2, `计划：a.txt 一致 + big.bin 因删除策略跳过 = 2（实际 ${s?.skip}）`);
		check(s?.download === 0 && s?.trashRemote === 0, "计划：无下载、无清理（删除策略默认 none）");
		const rels = (r.data.plan.roots[0].entries ?? []).map((e) => e.rel).sort();
		check(rels.includes("node_modules/junk/index.js") === false, `默认 ignore 生效（扫描结果：${rels.join(", ")}）`);
		const big = (r.data.plan.roots[0].entries ?? []).find((e) => e.rel === "big.bin");
		check(big?.action === "skip" && /删除策略/.test(big?.reason ?? ""), "远端独有项给出「为什么不清理」的原因");
	}

	{
		const before = JSON.stringify(Object.keys(mFiles).sort());
		const r = await api("/sync", { method: "POST", body: { scope: "all", dryRun: true } });
		check(r.ok && r.data?.dryRun === true, "POST /sync dryRun=true 只回计划");
		check(JSON.stringify(Object.keys(mFiles).sort()) === before, "dry-run 后远端文件集合未变");
		check(mFiles["/home/test/src/new.txt"] === undefined, "dry-run 没有真的上传");
	}

	{
		const r = await api("/sync", { method: "POST", body: { scope: "all", dryRun: false } });
		check(r.ok && r.data?.result?.done?.upload === 1, `同步执行：上传 1（实际 ${r.data?.result?.done?.upload}）`);
		check(mFiles["/home/test/src/new.txt"]?.toString("utf8") === "brand new\n", "上传内容落到远端且字节一致");
		check(mFiles["/home/test/a.txt"]?.toString("utf8") === "hello ssh\n第二行\n", "一致的文件没有被重传覆盖");
		check(Object.keys(mFiles).some((k) => k.includes(".sftp-tmp")) === false, "传输用的半成品文件已清理，不留残渣");
	}

	{
		const r = await api("/plan", { method: "POST", body: { scope: "all" } });
		const s = r.data?.plan?.summary;
		check(s?.upload === 0 && s?.download === 0, `二次计划：无待传（upload=${s?.upload} download=${s?.download}）`);
		check(s?.skip === 3, `二次计划：3 个文件全部一致/跳过（实际 ${s?.skip}）`);
	}

	{
		const r = await api("/sync", {
			method: "POST",
			body: { scope: "all", dryRun: false, deletePolicy: "remote-only" },
		});
		check(
			r.data?.result?.done?.trashRemote === 1,
			`清理远端多余文件 1 个（实际 ${r.data?.result?.done?.trashRemote}）`,
		);
		check(mFiles["/home/test/big.bin"] === undefined, "被清理的文件确实离开原位");
		const trashed = trashKeysUnder("/home/test/.sftp-trash/");
		check(trashed.length === 1, `进入远端垃圾桶（${trashed[0] ?? "无"}）`);
		check(mFiles[trashed[0]]?.length === 4, "垃圾桶里的内容完好（4 字节）");

		const r2 = await api("/plan", { method: "POST", body: { scope: "all" } });
		const rels = (r2.data?.plan?.roots?.[0]?.entries ?? []).map((e) => e.rel);
		check(
			rels.some((x) => x.includes(".sftp-trash")) === false,
			`垃圾桶被内部护栏排除，不会被下次同步回传（本次扫描：${rels.join(", ")}）`,
		);
		check(
			r2.data?.plan?.summary?.total === 2,
			`垃圾桶排除后仅剩 2 个文件参与比对（实际 ${r2.data?.plan?.summary?.total}）`,
		);
	}

	{
		const sec = await api("/secret", { method: "POST", body: { name: "mock-pass", value: PASS } });
		check(sec.ok && sec.data?.ref === "${secret:mock-pass}", "POST /secret 写入加密机密并回引用（不回显明文）");

		let r = await api("/profile", {
			method: "POST",
			body: { name: "mock", patch: { password: "${secret:mock-pass}" } },
		});
		check(r.ok, "把连接凭据改成 ${secret:mock-pass} 引用");
		check(readFileSync(CONFIG_PATH, "utf8").includes(PASS) === false, "配置文件里不再有明文口令（只剩引用）");
		r = await api("/test", { method: "POST", body: { profile: "mock" } });
		check(r.ok, "用 ${secret:} 引用仍能连上（加密存储 → 引用解析链路通）");

		await api("/profile", { method: "POST", body: { name: "mock", patch: { password: "${env:PI_WEB_TEST_PASS}" } } });
		r = await api("/test", { method: "POST", body: { profile: "mock" } });
		check(r.ok, "用 ${env:PI_WEB_TEST_PASS} 引用仍能连上");

		await api("/profile", { method: "POST", body: { name: "mock", patch: { password: "${secret:does-not-exist}" } } });
		r = await api("/test", { method: "POST", body: { profile: "mock" } });
		check(r.ok === false && /does-not-exist/.test(r.error ?? ""), `引用不存在的机密显式报错（${r.error}）`);

		await api("/profile", { method: "POST", body: { name: "mock", patch: { password: "${env}" } } });
		r = await api("/test", { method: "POST", body: { profile: "mock" } });
		check(r.ok === false && /不合法/.test(r.error ?? ""), "写法不合法的引用报错而不是静默当成空密码");

		await api("/profile", { method: "POST", body: { name: "mock", patch: { password: PASS } } });
	}

	{
		let r = await api("/remote-write", {
			method: "POST",
			body: { path: "/home/test/deep/nest/n.txt", text: "nested" },
		});
		check(r.ok, "写远端文件（父目录自动创建）");
		r = await api(`/remote-file?path=${encodeURIComponent("/home/test/deep/nest/n.txt")}`);
		check(r.ok && r.data?.text === "nested", "读远端文件内容一致");
		r = await api("/remote-mv", {
			method: "POST",
			body: { from: "/home/test/deep/nest/n.txt", to: "/home/test/deep/moved.txt" },
		});
		check(r.ok && mFiles["/home/test/deep/moved.txt"]?.toString("utf8") === "nested", "移动远端文件");
		r = await api("/remote-mkdir", { method: "POST", body: { path: "/home/test/empty-dir" } });
		check(r.ok && Array.isArray(mDirs["/home/test/empty-dir"]), "远端递归建目录");
		r = await api("/remote-rm", { method: "POST", body: { path: "/home/test/deep" } });
		check(r.ok && r.data?.removed >= 2, `删除远端目录（递归，${r.data?.removed} 项）`);
		check(mFiles["/home/test/deep/moved.txt"] === undefined, "删除后文件确实不在原位");
		check(
			trashKeysUnder("/home/test/.sftp-trash/").some((k) => k.endsWith("moved.txt")),
			"删除走垃圾桶而不是真删",
		);
		r = await api(`/remote?path=${encodeURIComponent("/home/test")}`);
		check(r.ok && Array.isArray(r.data?.entries), "列远端目录");
	}

	{
		let r = await api(`/remote?path=${encodeURIComponent("/home/test/../..")}`);
		check(r.ok === false && /不能含 \.\./.test(r.error ?? ""), `远端路径含 .. 被拒（${r.error}）`);
		r = await api("/remote-write", { method: "POST", body: { path: "relative.txt", text: "x" } });
		check(r.ok === false && /绝对路径/.test(r.error ?? ""), "远端写相对路径被拒");
		r = await api("/remote-rm", { method: "POST", body: { path: "/home/test" } });
		check(r.ok === false && /拒绝删除同步根目录/.test(r.error ?? ""), "拒绝把同步根目录整个删掉");

		await api("/profile", {
			method: "POST",
			body: { name: "bad", patch: { host: "127.0.0.1", remotePath: "not/absolute" }, makeActive: false },
		});
		r = await api("/plan", { method: "POST", body: { profile: "bad" } });
		check(r.ok === false && /绝对路径/.test(r.error ?? ""), `remotePath 非绝对路径时计划直接拒绝（${r.error}）`);
		await api("/remove", { method: "POST", body: { name: "bad" } });
		const back = await api("/state");
		check(back.data?.active === "mock", `清理完临时 profile 后 active 不变（${back.data?.active}）`);
	}

	{
		mkdirSync(join(workDir, ".vscode"), { recursive: true });
		writeFileSync(
			join(workDir, ".vscode", "sftp.json"),
			JSON.stringify(
				{
					name: "legacy",
					host: "127.0.0.1",
					port: SSH_PORT,
					username: "tester",
					password: PASS,
					remotePath: "/home/test",
					ignore: ["dist"],
				},
				null,
				2,
			),
			"utf8",
		);
		const r = await api("/import", { method: "POST", body: {} });
		check(r.ok && r.data?.name === "legacy", "POST /import 迁移 vscode-sftp 配置");
		check((r.data?.importedSecrets ?? []).includes("legacy-password"), "明文口令转入加密机密");
		const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
		const legacy = raw.connections?.legacy ?? {};
		check(
			!JSON.stringify(legacy).includes(PASS),
			`迁移后 legacy 连接里没有明文口令（${JSON.stringify(legacy.auth ?? {})}）`,
		);
		check(legacy.auth?.password === "${secret:legacy-password}", "配置里落的是 ${secret:legacy-password} 引用");
		const t = await api("/test", { method: "POST", body: { profile: "legacy" } });
		check(t.ok && t.data?.writable === true, `迁移出来的连接可直接连通（${t.error ?? t.data?.host}）`);
	}

	{
		mFiles["/home/test/src/new.txt"] = Buffer.from("changed on server\n", "utf8");
		let r = await api("/sync", {
			method: "POST",
			body: { direction: "down", scope: "file", path: "src/new.txt", dryRun: false },
		});
		check(
			r.ok && r.data?.result?.done?.download === 1,
			`down 单文件：下载 1 个（实际 ${r.data?.result?.done?.download}）`,
		);
		check(
			readFileSync(join(workDir, "src", "new.txt"), "utf8") === "changed on server\n",
			"down 单文件：本地内容被远端覆盖",
		);

		writeFileSync(join(workDir, "only-local.txt"), "L", "utf8");
		mFiles["/home/test/only-remote.txt"] = Buffer.from("R", "utf8");
		mDirs["/home/test"].push("only-remote.txt");
		r = await api("/plan", { method: "POST", body: { direction: "both", scope: "all" } });
		const s = r.data?.plan?.summary;
		check(s?.upload >= 1 && s?.download >= 1, `both：两个方向都有活（up=${s?.upload} down=${s?.download}）`);
		r = await api("/sync", { method: "POST", body: { direction: "both", scope: "all", dryRun: false } });
		check(r.ok, "both：执行成功");
		check(mFiles["/home/test/only-local.txt"]?.toString("utf8") === "L", "both：本地独有的文件被传到远端");
		check(readFileSync(join(workDir, "only-remote.txt"), "utf8") === "R", "both：远端独有的文件被拉到本地");
		check(existsSync(join(workDir, "a.txt")), "both：原有文件没被误删（双向不删多余项）");

		await api("/profile", {
			method: "POST",
			body: {
				name: "mapped",
				patch: {
					host: "127.0.0.1",
					port: SSH_PORT,
					username: "tester",
					remotePath: "/home/test",
					mappings: [{ local: "src", remote: "/home/test/mapped" }],
					password: PASS,
				},
				makeActive: false,
			},
		});
		r = await api("/plan", { method: "POST", body: { profile: "mapped", scope: "all" } });
		const root = r.data?.plan?.roots?.[0];
		check(r.ok && r.data?.plan?.roots?.length === 1, `mappings：只产出一个同步根（${r.data?.plan?.roots?.length}）`);
		check(
			root?.localRel === "src" && root?.remoteRoot === "/home/test/mapped",
			`mappings：根映射正确（${root?.localRel} → ${root?.remoteRoot}）`,
		);
		check(
			(root?.entries ?? []).some((e) => e.rel === "new.txt"),
			`mappings：条目是相对映射根的相对路径（${(root?.entries ?? []).map((e) => e.rel).join(", ")}）`,
		);
		const mappedRun = await api("/sync", { method: "POST", body: { profile: "mapped", scope: "all", dryRun: false } });
		const got = mFiles["/home/test/mapped/new.txt"]?.toString("utf8");
		check(
			got === "changed on server\n",
			`mappings：内容落到映射后的远端目录（实际 ${JSON.stringify(got)}，结果 ${JSON.stringify(mappedRun.data?.result?.done)}，失败 ${JSON.stringify(mappedRun.data?.result?.failed)}）`,
		);
		r = await api("/plan", { method: "POST", body: { profile: "mapped", scope: "tree", path: "a.txt" } });
		check(r.ok === false && /mappings/.test(r.error ?? ""), `mappings：映射外的路径被拒且给出原因（${r.error}）`);
		await api("/remove", { method: "POST", body: { name: "mapped" } });

		r = await api("/exec", { method: "POST", body: { cmd: "echo hi" } });
		check(r.ok === false && /未开启/.test(r.error ?? ""), `sftp_exec 开关关着时路由也拒绝（${r.error}）`);

		const before = JSON.stringify(Object.keys(mFiles).sort());
		r = await api("/sync", { method: "POST" });
		check(r.ok && r.data?.dryRun === true, `POST /sync 缺 body → 当成 dry-run（dryRun=${r.data?.dryRun}）`);
		check(JSON.stringify(Object.keys(mFiles).sort()) === before, "POST /sync 缺 body 时远端文件集合未变");
		check(r.data?.result === null, "dry-run 不回 result（没执行就没什么可报的）");

		r = await api("/prune-trash", { method: "POST", body: { days: 30 } });
		check(
			r.ok && Array.isArray(r.data?.removed),
			`POST /prune-trash 可用（清除 ${r.data?.removed?.length ?? "?"} 个批次）`,
		);

		const stNow = await api("/state");
		check(
			(stNow.data?.connection?.ignore ?? []).includes(".vscode/sftp.json"),
			`默认排除里含 .vscode/sftp.json（${(stNow.data?.connection?.ignore ?? []).join(", ")}）`,
		);
	}

	{
		writeFileSync(join(workDir, "manual.txt"), "manual-up\n", "utf8");
		let r = await api("/transfer", { method: "POST", body: { direction: "up", path: "manual.txt" } });
		check(
			r.ok && r.data?.scope === "file" && r.data?.result?.done?.upload === 1,
			`手动上传单文件（scope=${r.data?.scope} upload=${r.data?.result?.done?.upload}）`,
		);
		check(mFiles["/home/test/manual.txt"]?.toString("utf8") === "manual-up\n", "单文件内容落到远端");

		mFiles["/home/test/manual.txt"] = Buffer.from("changed-again\n", "utf8");
		r = await api("/transfer", { method: "POST", body: { direction: "down", path: "/home/test/manual.txt" } });
		check(r.ok && r.data?.result?.done?.download === 1, `手动下载单文件（download=${r.data?.result?.done?.download}）`);
		check(readFileSync(join(workDir, "manual.txt"), "utf8") === "changed-again\n", "下载覆盖了本地内容");

		writeFileSync(join(workDir, "src", "extra.txt"), "extra\n", "utf8");
		r = await api("/transfer", { method: "POST", body: { direction: "up", path: "/home/test/src" } });
		check(
			r.ok && r.data?.scope === "tree" && r.data?.target === "src",
			`远端目录反查到本地子树（scope=${r.data?.scope} target=${r.data?.target}）`,
		);
		check(
			mFiles["/home/test/src/extra.txt"]?.toString("utf8") === "extra\n",
			`子树内容上传到对应远端目录（实际 ${JSON.stringify(mFiles["/home/test/src/extra.txt"]?.toString("utf8"))}，失败 ${JSON.stringify(r.data?.result?.failed)}）`,
		);

		mFiles["/home/test/src/only-remote.txt"] = Buffer.from("keep me\n", "utf8");
		mDirs["/home/test/src"].push("only-remote.txt");
		r = await api("/transfer", { method: "POST", body: { direction: "up", path: "src" } });
		check(
			r.ok && r.data?.result?.done?.trashRemote === 0 && mFiles["/home/test/src/only-remote.txt"] !== undefined,
			"手动传输不动删除策略（远端多出来的文件还在）",
		);

		r = await api("/transfer", { method: "POST", body: { direction: "up", path: "../outside" } });
		check(r.ok === false && /越出工作区/.test(r.error ?? ""), `手动上传拒绝越界（${r.error}）`);
		r = await api("/transfer", { method: "POST", body: { direction: "down", path: "/etc/passwd" } });
		check(r.ok === false && /不在任何同步根内/.test(r.error ?? ""), `手动下载拒绝同步根外的路径（${r.error}）`);
		r = await api("/transfer", { method: "POST", body: { direction: "down", path: "/home/test/nope.txt" } });
		check(r.ok === false && /远端不存在/.test(r.error ?? ""), `手动下载不存在的文件报错（${r.error}）`);
	}

	{
		writeFileSync(
			join(plugDst, "storage.json"),
			`${JSON.stringify({ settings: { allowExec: true, concurrency: 2 } }, null, "\t")}\n`,
			"utf8",
		);
		try {
			process.kill(proc.pid, "SIGTERM");
		} catch {}
		await sleep(600);
		proc = spawnServer();
		await waitHealthy();

		const src = readFileSync(join(REPO, "plugins", PLUGIN_ID, "index.mjs"), "utf8");
		check(
			/buildSftpTool\(readSettings\(\)\.allowExec\)/.test(src) || src.includes("buildSftpTool(on)"),
			"工具按 allowExec 重新组装（enum 里多/少一个 exec）",
		);
		const afterRestart = await readPlugins();
		check((afterRestart.find((p) => p.id === PLUGIN_ID)?.agentTools ?? []).length === 1, "重启后仍只有一个 sftp 工具");
		const ex = await api("/exec", { method: "POST", body: { cmd: "echo hello-sftp" } });
		check(ex.ok && ex.data?.stdout?.includes("hello-sftp"), `远端命令真的跑起来了（code=${ex.data?.code}）`);
		const bad = await api("/exec", { method: "POST", body: { cmd: "fail-now" } });
		check(bad.ok && bad.data?.code === 7 && bad.data?.stderr?.includes("boom"), "退出码与 stderr 原样回传");

		const st = await api("/state");
		check(st.data?.settings?.concurrency === 2, `设置页的并发值生效（${st.data?.settings?.concurrency}）`);
	}

	{
		const plugins = await readPlugins();
		const me = plugins.find((p) => p.id === PLUGIN_ID);
		check(me?.active === true, "重新读取插件清单仍为激活态");
		check(
			(me?.agentTools ?? []).length === 1 && me?.agentTools?.[0]?.name === "sftp",
			`重启后仍是单个 sftp 工具（${(me?.agentTools ?? []).map((x) => x.name).join(", ")}）`,
		);
	}
	{
		const p1 = await api("/plan", { method: "POST", body: { scope: "all" } });
		check(typeof p1.data?.planToken === "string" && p1.data.planToken.length > 0, "POST /plan 回计划 token");
		const reused = await api("/sync", {
			method: "POST",
			body: { scope: "all", dryRun: true, reuse: true, planToken: p1.data.planToken },
		});
		check(reused.data?.reused === true, "带 token 回来的任务沿用了刚才那份计划（没重扫）");
		const stale = await api("/sync", {
			method: "POST",
			body: { scope: "all", dryRun: true, reuse: true, planToken: "p-deadbeef" },
		});
		check(stale.data?.reused === false, "token 对不上就老老实实重扫（不传旧计划）");
	}

	{
		const dir = join(workDir, "fast");
		mkdirSync(join(dir, "nested"), { recursive: true });
		for (let i = 0; i < 12; i++) writeFileSync(join(dir, `f${i}.txt`), `fast-${i}\n`, "utf8");
		writeFileSync(join(dir, "nested", "deep.txt"), "deep\n", "utf8");

		const plan = await api("/plan", { method: "POST", body: { scope: "tree", path: "fast" } });
		check(
			plan.ok && plan.data?.plan?.summary?.upload === 13,
			`allowExec 打开时出计划（走一次 find 快扫，待上传 ${plan.data?.plan?.summary?.upload}）`,
		);

		const sync = await api("/sync", { method: "POST", body: { scope: "tree", path: "fast", dryRun: false } });
		check(sync.data?.result?.done?.upload === 13, `13 个小文件全部落盘（实际 ${sync.data?.result?.done?.upload}）`);
		check(
			(sync.data?.result?.batched ?? 0) >= 13,
			`13 个小文件走了一次 tar 批量（batched=${sync.data?.result?.batched}）`,
		);
		check(
			mFiles["/home/test/fast/nested/deep.txt"]?.toString("utf8") === "deep\n",
			"tar 解包出来的嵌套文件内容正确（相对路径算对了）",
		);
		check(
			Object.keys(mDirs).every((d) => !d.includes(".sftp-tmp")),
			"批量上传后暂存目录已清理（不会留半成品给下次同步）",
		);

		const after = await api("/plan", { method: "POST", body: { scope: "tree", path: "fast" } });
		fastPlanSummary = after.data?.plan?.summary ?? null;
		check(fastPlanSummary?.skip === 13, `find 快扫看到刚传上去的 13 个文件（skip=${fastPlanSummary?.skip}）`);

		rmSync(dir, { recursive: true, force: true });
		const down = await api("/sync", {
			method: "POST",
			body: { scope: "tree", path: "fast", direction: "down", dryRun: false },
		});
		check(down.data?.result?.done?.download === 13, `13 个小文件全部拉回（实际 ${down.data?.result?.done?.download}）`);
		check(
			(down.data?.result?.batched ?? 0) >= 13,
			`13 个小文件走了一次 tar 批量下载（batched=${down.data?.result?.batched}）`,
		);
		check(readFileSync(join(dir, "nested", "deep.txt"), "utf8") === "deep\n", "本地解包出来的嵌套文件内容正确");
		check(readFileSync(join(dir, "f7.txt"), "utf8") === "fast-7\n", "本地解包出来的普通文件内容正确");
		check(
			readdirSync(join(workDir, ".pi")).every((n) => !n.startsWith(".sftp-tmp")),
			"本地暂存目录已清理（不会留半成品在工作区）",
		);

		rmSync(dir, { recursive: true, force: true });
		sshServer.failTar.on = true;
		try {
			const fb = await api("/sync", {
				method: "POST",
				body: { scope: "tree", path: "fast", direction: "down", dryRun: false },
			});
			check(
				fb.data?.result?.done?.download === 13,
				`远端没有 tar 时回落逐文件仍全部拉回（${fb.data?.result?.done?.download}）`,
			);
			check(fb.data?.result?.batched === 0, "回落时 batched 诚实为 0");
			check((fb.data?.result?.failed ?? []).length === 0, "回落不是失败（failed 为空）");
			check(readFileSync(join(dir, "nested", "deep.txt"), "utf8") === "deep\n", "回落路径的内容也对");
		} finally {
			sshServer.failTar.on = false;
		}
	}

	{
		writeFileSync(
			join(plugDst, "storage.json"),
			`${JSON.stringify({ settings: { allowExec: false, concurrency: 2 } }, null, "\t")}\n`,
			"utf8",
		);
		try {
			process.kill(proc.pid, "SIGTERM");
		} catch {}
		await sleep(600);
		proc = spawnServer();
		await waitHealthy();
		await readPlugins();

		const planOff = await api("/plan", { method: "POST", body: { scope: "tree", path: "fast" } });
		check(
			JSON.stringify(planOff.data?.plan?.summary) === JSON.stringify(fastPlanSummary),
			`逐目录扫描与 find 快扫结论一致（${JSON.stringify(planOff.data?.plan?.summary)}）`,
		);

		const added = [];
		let cur = "/home/test";
		for (let i = 0; i < 30; i++) {
			const p = `${cur}/chain${i}`;
			mDirs[p] = [];
			mDirs[cur].push(`chain${i}`);
			added.push(p);
			cur = p;
		}
		sshServer.latency.latencyMs = 40;
		const t0 = Date.now();
		const pending = api("/sync", { method: "POST", body: { scope: "tree", path: "chain0", dryRun: false } });
		await sleep(250);
		const during = await api("/state");
		check(during.data?.job?.running === true, "扫描期间 /state 能看到运行中的任务（界面才画得出进度与停止键）");
		check(
			during.data?.job?.phase === "scan" || during.data?.job?.phase === "cancelling",
			`扫描期间 phase=scan（实际 ${during.data?.job?.phase}）`,
		);
		check(
			typeof during.data?.job?.scan?.dirs === "number",
			"扫描进度里有目录计数（前端据此显示「已扫 N 个文件 / M 个目录」）",
		);
		const c = await api("/cancel", { method: "POST", body: {} });
		check(c.data?.cancelled === true, "POST /cancel 接受了停止请求");
		const out = await pending;
		check(out.data?.cancelled === true, "被停掉的任务回 cancelled，而不是报错");
		check(Date.now() - t0 < 8000, `取消后很快收尾（${Date.now() - t0}ms，没等整棵树扫完）`);
		const after = await api("/state");
		check(
			after.data?.job?.running === false && after.data?.job?.cancelled === true,
			"取消后运行位释放、状态标成已停止（不会一直卡在「已有同步任务在运行」）",
		);
		const none = await api("/cancel", { method: "POST", body: {} });
		check(none.data?.cancelled === false, "没有任务在跑时 /cancel 幂等返回（不报错）");

		sshServer.latency.latencyMs = 0;
		for (let i = added.length - 1; i >= 0; i--) {
			const parent = i === 0 ? "/home/test" : added[i - 1];
			const list = mDirs[parent] ?? [];
			const idx = list.indexOf(`chain${i}`);
			if (idx >= 0) list.splice(idx, 1);
			delete mDirs[added[i]];
		}
		const okPlan = await api("/plan", { method: "POST", body: { scope: "all" } });
		check(okPlan.ok === true && Boolean(okPlan.data?.plan?.summary), "取消之后插件照常出计划（运行位没被卡住）");
	}
} catch (err) {
	fail(err?.stack ?? err?.message ?? String(err));
} finally {
	try {
		sshServer?.close();
		if (proc?.pid) process.kill(proc.pid, "SIGTERM");
	} catch {}
	await sleep(500);
	rmSync(dataDir, { recursive: true, force: true });
}
process.exit(process.exitCode ?? 0);
