import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import WebSocket from "ws";
import { checkPluginImports, staticImportSpecifiers } from "../plugin-sdk/import-check.mjs";
import { freePort, portUp } from "./lib/port-utils.mjs";

const PORT = 8960;
const BASE = `http://127.0.0.1:${PORT}`;
const NODE = realpathSync(process.execPath);
const REPO = fileURLToPath(new URL("..", import.meta.url));
const CLI = join(REPO, "bin", "pi-web-ui.mjs");
const TEMPLATES = ["minimal", "ui-slot", "agent-tool", "renderer"];
const SDK_TEMPLATES = TEMPLATES.filter((t) => t !== "renderer");

const tmp = mkdtempSync(join(tmpdir(), "piweb-scaffold-"));
const dataDir = join(tmp, "data");
const work = join(tmp, "work");
const pluginsDir = join(dataDir, "plugins");
mkdirSync(work, { recursive: true });

let failures = 0;
const check = (name, cond, extra = "") => {
	if (cond) console.log(`  ✓ ${name}`);
	else {
		failures++;
		console.log(`  ✗ FAIL: ${name}${extra ? ` — ${extra}` : ""}`);
	}
};
const idOf = (t) => `scaffold-${t}`;
const dirOf = (t) => join(pluginsDir, idOf(t));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cli(args) {
	const r = spawnSync(NODE, [CLI, ...args], { encoding: "utf8", cwd: REPO });
	return { stdout: `${r.stdout ?? ""}${r.stderr ?? ""}`, status: r.status };
}

let proc = null;
let sock = null;

async function crawlClientGraph(id) {
	const seen = new Map();
	const queue = ["client/entry.mjs"];
	const problems = [];
	while (queue.length > 0) {
		const rel = queue.shift();
		if (seen.has(rel)) continue;
		const url = `${BASE}/plugins/${id}/${rel}`;
		let res;
		try {
			res = await fetch(url);
		} catch (err) {
			problems.push(`${rel}: fetch 失败 ${err?.message ?? err}`);
			continue;
		}
		const contentType = res.headers.get("content-type") ?? "";
		seen.set(rel, { status: res.status, contentType });
		if (res.status !== 200) problems.push(`${rel}: HTTP ${res.status}`);
		else if (!/javascript/i.test(contentType)) problems.push(`${rel}: content-type=${contentType}（不是 JS）`);
		if (res.status !== 200 || !/javascript/i.test(contentType)) continue;
		for (const spec of staticImportSpecifiers(await res.text())) {
			if (!spec.startsWith("./") && !spec.startsWith("../")) continue;
			const target = new URL(spec, url);
			const prefix = `/plugins/${id}/`;
			if (!target.pathname.startsWith(prefix)) {
				problems.push(`${rel}: import "${spec}" 解析到暴露面之外（${target.pathname}）`);
				continue;
			}
			queue.push(target.pathname.slice(prefix.length));
		}
	}
	return { seen, problems };
}

try {
	try {
		freePort(PORT);
	} catch {}

	console.log("▶ 脚手架生成与静态自检");
	for (const t of TEMPLATES) {
		const { stdout, status } = cli(["plugin", "create", idOf(t), "--template", t, "--data-dir", dataDir]);
		check(`${t}：CLI 退出码 0`, status === 0, stdout.trim());
		check(
			`${t}：无自检告警`,
			!stdout.includes("⚠"),
			stdout
				.split("\n")
				.filter((l) => l.includes("⚠"))
				.join(" "),
		);
		const dir = dirOf(t);
		for (const f of [
			"manifest.json",
			"index.mjs",
			"client/entry.mjs",
			"sdk/index.mjs",
			"sdk/client.mjs",
			"sdk/client-utils.mjs",
			"sdk/testing.mjs",
		])
			check(`${t}：${f} 已生成`, existsSync(join(dir, f)));
		const usesClientSdk = SDK_TEMPLATES.includes(t);
		check(
			`${t}：client/sdk/${usesClientSdk ? "已拷（客户端要用）" : "不白拷（客户端不用 SDK）"}`,
			existsSync(join(dir, "client", "sdk", "index.mjs")) === usesClientSdk &&
				existsSync(join(dir, "client", "sdk", "client.mjs")) === usesClientSdk &&
				existsSync(join(dir, "client", "sdk", "client-utils.mjs")) === usesClientSdk &&
				!existsSync(join(dir, "client", "sdk", "testing.mjs")),
		);
		if (usesClientSdk) {
			check(
				`${t}：client/sdk/index.mjs 是兼容入口`,
				readFileSync(join(dir, "client", "sdk", "index.mjs"), "utf8").trim() === 'export * from "./client.mjs";',
			);
		}
		const clientSrc = readFileSync(join(dir, "client/entry.mjs"), "utf8");
		check(
			`${t}：客户端 import 落在 client/ 内并使用 client.mjs`,
			usesClientSdk ? clientSrc.includes('from "./sdk/client.mjs"') : !clientSrc.includes("sdk/"),
		);
		const readmeSrc = readFileSync(join(dir, "README.md"), "utf8");
		check(`${t}：README 说明包含 sdk/`, readmeSrc.includes("sdk/"));
		const scan = checkPluginImports(dir);
		check(`${t}：import 自检零问题`, scan.problems.length === 0, JSON.stringify(scan.problems));
	}
	for (const t of TEMPLATES) {
		const mod = await import(pathToFileURL(join(dirOf(t), "index.mjs")).href);
		check(`${t}：服务端入口可加载`, typeof mod.default?.activate === "function");
	}
	check(
		"renderer：客户端是裸 ESM（renderers 表）",
		readFileSync(join(dirOf("renderer"), "client/entry.mjs"), "utf8").includes("renderers:"),
	);

	console.log("▶ with-test 模板单测验证");
	const testId = "scaffold-with-test";
	const testDir = join(pluginsDir, testId);
	const testGen = cli(["plugin", "create", testId, "--template", "minimal", "--with-test", "--data-dir", dataDir]);
	check("with-test：CLI 退出码 0", testGen.status === 0, testGen.stdout.trim());
	check("with-test：index.test.mjs 存在", existsSync(join(testDir, "index.test.mjs")));
	const testSrc = readFileSync(join(testDir, "index.test.mjs"), "utf8");
	check("with-test：从 ./sdk/testing.mjs 导入 createMockHost", testSrc.includes('from "./sdk/testing.mjs"'));
	const testRun = spawnSync(NODE, ["--test", "index.test.mjs"], { cwd: testDir, encoding: "utf8" });
	check("with-test：node --test 单测通过", testRun.status === 0, testRun.stdout.trim());

	console.log("▶ plugin upgrade-sdk：补齐两处拷贝");
	const healDir = dirOf("ui-slot");
	rmSync(join(healDir, "client", "sdk"), { recursive: true, force: true });
	rmSync(join(healDir, "sdk", "client-utils.mjs"), { force: true });
	const up = cli(["plugin", "upgrade-sdk", idOf("ui-slot"), "--dir", pluginsDir]);
	check("upgrade-sdk：退出码 0", up.status === 0, up.stdout.trim());
	check(
		"upgrade-sdk：服务端副本补齐 client-utils.mjs 与 testing.mjs",
		existsSync(join(healDir, "sdk", "client-utils.mjs")) &&
			existsSync(join(healDir, "sdk", "index.mjs")) &&
			existsSync(join(healDir, "sdk", "testing.mjs")) &&
			existsSync(join(healDir, "sdk", "client.mjs")),
	);
	check(
		"upgrade-sdk：客户端副本补建（代码 import ./sdk/ 但目录曾被删）",
		existsSync(join(healDir, "client", "sdk", "index.mjs")) &&
			existsSync(join(healDir, "client", "sdk", "client.mjs")) &&
			existsSync(join(healDir, "client", "sdk", "client-utils.mjs")) &&
			!existsSync(join(healDir, "client", "sdk", "testing.mjs")),
		up.stdout.trim(),
	);

	console.log("▶ plugin upgrade-sdk：旧 testing.mjs 清理与兼容入口刷新");
	const dirtyDir = dirOf("minimal");
	writeFileSync(join(dirtyDir, "client", "sdk", "testing.mjs"), "import 'node:path';\n");
	writeFileSync(join(dirtyDir, "client", "sdk", "index.mjs"), "// old content\n");
	const cleanUp = cli(["plugin", "upgrade-sdk", idOf("minimal"), "--dir", pluginsDir]);
	check("upgrade-sdk 清理：退出码 0", cleanUp.status === 0, cleanUp.stdout.trim());
	check("upgrade-sdk 清理：client/sdk/testing.mjs 被移除", !existsSync(join(dirtyDir, "client", "sdk", "testing.mjs")));
	check(
		"upgrade-sdk 清理：client/sdk/index.mjs 刷新为兼容入口",
		readFileSync(join(dirtyDir, "client", "sdk", "index.mjs"), "utf8").trim() === 'export * from "./client.mjs";',
	);

	console.log("▶ plugin upgrade-sdk：升级幂等性");
	const idem = cli(["plugin", "upgrade-sdk", "--dir", pluginsDir]);
	check("upgrade-sdk 幂等：退出码 0", idem.status === 0, idem.stdout.trim());
	check(
		"upgrade-sdk 幂等：全部已是最新（刷新 0 个）",
		idem.stdout.includes("刷新 0 个") || idem.stdout.includes("refreshed 0"),
		idem.stdout.trim(),
	);

	console.log("▶ 旧导入迁移兼容性");
	const legacyMigrateDir = join(pluginsDir, "legacy-migrated");
	cli(["plugin", "create", "legacy-migrated", "--template", "minimal", "--data-dir", dataDir]);
	const oldClientFile = join(legacyMigrateDir, "client", "entry.mjs");
	writeFileSync(oldClientFile, readFileSync(oldClientFile, "utf8").replace('"./sdk/client.mjs"', '"./sdk/index.mjs"'));
	const legacyIndex = 'export const SDK_VERSION = "0.2.0";\n';
	for (const sdkDir of [join(legacyMigrateDir, "sdk"), join(legacyMigrateDir, "client", "sdk")]) {
		writeFileSync(join(sdkDir, "index.mjs"), legacyIndex);
		rmSync(join(sdkDir, "client.mjs"), { force: true });
		rmSync(join(sdkDir, "testing.mjs"), { force: true });
	}
	const migrate = cli(["plugin", "upgrade-sdk", "legacy-migrated", "--dir", pluginsDir]);
	check("旧版本升级：CLI 退出码 0", migrate.status === 0, migrate.stdout.trim());
	check("旧版本升级：识别 index.mjs 中的 0.2.0", migrate.stdout.includes("0.2.0 →"), migrate.stdout.trim());
	check(
		"旧版本升级：服务端入口恢复且可加载",
		typeof (await import(pathToFileURL(join(legacyMigrateDir, "index.mjs")).href)).default?.activate === "function",
	);
	const legacyScan = checkPluginImports(legacyMigrateDir);
	check("旧导入兼容：import 自检零问题", legacyScan.problems.length === 0, JSON.stringify(legacyScan.problems));
	const legacyClientMod = await import(pathToFileURL(oldClientFile).href);
	check("旧导入兼容：客户端模块可加载并成功执行", typeof legacyClientMod.default?.mount === "function");

	console.log("▶ 客户端零 Node 模块守卫");
	let anyNodeImport = false;
	let anyTestingMjs = false;
	for (const id of [...TEMPLATES.map(idOf), testId, "legacy-migrated"]) {
		const cSdk = join(pluginsDir, id, "client", "sdk");
		if (!existsSync(cSdk)) continue;
		if (existsSync(join(cSdk, "testing.mjs"))) anyTestingMjs = true;
		for (const f of ["index.mjs", "client.mjs", "client-utils.mjs"]) {
			const fp = join(cSdk, f);
			if (!existsSync(fp)) continue;
			const src = readFileSync(fp, "utf8");
			for (const spec of staticImportSpecifiers(src)) {
				if (spec.startsWith("node:")) anyNodeImport = true;
			}
		}
	}
	check("客户端不含 testing.mjs", !anyTestingMjs);
	check("客户端 SDK 零 node: 依赖", !anyNodeImport);

	const oldBad = join(pluginsDir, "legacy-broken");
	cli(["plugin", "create", "legacy-broken", "--template", "minimal", "--data-dir", dataDir]);
	const badClient = join(oldBad, "client", "entry.mjs");
	writeFileSync(
		badClient,
		readFileSync(badClient, "utf8")
			.replace('"./sdk/client.mjs"', '"../sdk/client.mjs"')
			.replace('"./sdk/index.mjs"', '"../sdk/index.mjs"'),
	);
	rmSync(join(oldBad, "client", "sdk"), { recursive: true, force: true });
	const legacy = cli(["plugin", "upgrade-sdk", "legacy-broken", "--dir", pluginsDir]);
	check(
		"upgrade-sdk：修复前的坏骨架被点名（escapes-client 告警）",
		legacy.stdout.includes("client/ 之外") || legacy.stdout.includes("outside client/"),
		legacy.stdout.trim(),
	);

	console.log("▶ 真服务：清单 + 客户端 import 图");
	proc = spawn(NODE, [join(REPO, "dist", "server", "index.js")], {
		env: {
			...process.env,
			PI_WEB_PORT: String(PORT),
			PI_WEB_DATA_DIR: dataDir,
			PI_WEB_CWD: work,
			PI_WEB_PLUGIN_CATALOG_URL: "",
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	let serverLog = "";
	proc.stdout.on("data", (d) => {
		serverLog += d.toString();
	});
	proc.stderr.on("data", (d) => {
		serverLog += d.toString();
	});
	{
		const t0 = Date.now();
		while (!(await portUp(PORT))) {
			if (Date.now() - t0 > 25_000) throw new Error("server not ready");
			await sleep(250);
		}
	}
	await sleep(800);

	const plugins = await new Promise((res, rej) => {
		sock = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
		const timer = setTimeout(() => rej(new Error("attach timeout")), 20_000);
		sock.on("open", () => sock.send(JSON.stringify({ type: "hello", clientId: "scaffold-test" })));
		sock.on("message", (raw) => {
			const m = JSON.parse(raw.toString());
			if (m.type === "plugins") {
				clearTimeout(timer);
				res(m.plugins ?? []);
			}
		});
	});
	for (const t of TEMPLATES) {
		const info = plugins.find((p) => p.id === idOf(t));
		check(`${t}：清单里有它且 hasClient`, info?.hasClient === true, JSON.stringify(info));
		check(`${t}：激活无 error`, info?.error === undefined, JSON.stringify(info?.error));
	}
	for (const t of TEMPLATES)
		check(
			`${t}：activate 真的跑过（服务端有 [plugin:${idOf(t)}] 日志）`,
			serverLog.includes(`[plugin:${idOf(t)}]`),
			serverLog
				.split("\n")
				.filter((l) => l.includes(idOf(t)))
				.slice(0, 2)
				.join(" | "),
		);

	for (const t of TEMPLATES) {
		const { seen, problems } = await crawlClientGraph(idOf(t));
		check(`${t}：客户端 import 图全部可加载`, problems.length === 0, problems.join(" | "));
		if (SDK_TEMPLATES.includes(t)) {
			check(
				`${t}：import 图包含 client/sdk/（client + client-utils）`,
				seen.has("client/sdk/client.mjs") &&
					seen.has("client/sdk/client-utils.mjs") &&
					[...seen.values()].every((v) => /javascript/i.test(v.contentType)),
			);
		}
	}
	{
		const { seen, problems } = await crawlClientGraph("legacy-migrated");
		check("legacy-migrated：客户端 import 图全部可加载", problems.length === 0, problems.join(" | "));
		check(
			"legacy-migrated：通过兼容入口加载（index + client + client-utils）",
			seen.has("client/sdk/index.mjs") &&
				seen.has("client/sdk/client.mjs") &&
				seen.has("client/sdk/client-utils.mjs") &&
				[...seen.values()].every((v) => /javascript/i.test(v.contentType)),
		);
	}
	{
		const res = await fetch(`${BASE}/plugins/${idOf("ui-slot")}/sdk/index.mjs`);
		const ct = res.headers.get("content-type") ?? "";
		check("暴露面边界：/plugins/<id>/sdk/* 不是 JS（故客户端依赖必须拷进 client/）", !/javascript/i.test(ct), ct);
	}
} catch (err) {
	check(`未捕获异常：${err?.message ?? err}`, false);
	console.error(err?.stack ?? err);
} finally {
	try {
		sock?.close();
	} catch {}
	if (proc?.pid) {
		try {
			process.kill(proc.pid, "SIGKILL");
		} catch {}
	}
	try {
		freePort(PORT);
	} catch {}
	rmSync(tmp, { recursive: true, force: true });
	await sleep(200);
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
