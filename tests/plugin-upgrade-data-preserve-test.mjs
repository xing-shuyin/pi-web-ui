import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BIN = resolve(__dirname, "../bin/pi-web-ui.mjs");

function cli(args, env) {
	const r = spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8", env });
	if (r.status !== 0) throw new Error(`CLI 失败(${args[0]}): ${r.stderr || r.stdout}`);
	return r.stdout;
}

function assert(cond, message) {
	if (!cond) throw new Error(message);
}

const root = mkdtempSync(join(tmpdir(), "plugin-upgrade-preserve-"));
const pluginDir = join(root, "plugin");
const dataDir = join(root, "data");
const env = { ...process.env, PI_WEB_DATA_DIR: dataDir };
const target = join(dataDir, "plugins", "dbx");

try {
	mkdirSync(pluginDir, { recursive: true });
	writeFileSync(join(pluginDir, "manifest.json"), JSON.stringify({ id: "dbx", name: "DB", version: "1.0.0" }));
	writeFileSync(join(pluginDir, "index.mjs"), "// v1\n");
	writeFileSync(join(pluginDir, "dropped.mjs"), "// shipped in v1 only\n");

	cli(["install", pluginDir, "--name", "dbx"], env);
	const data = JSON.stringify({ conns: [{ host: "db.example", port: 5432 }] });
	writeFileSync(join(target, "db-connections.json"), data);
	writeFileSync(join(target, "config.json"), JSON.stringify({ apiKey: "secret" }));
	assert(
		JSON.parse(readFileSync(join(target, ".pi-files.json"), "utf8")).files.includes("dropped.mjs"),
		"安装后应记录随包文件清单",
	);

	rmSync(join(pluginDir, "dropped.mjs"));
	writeFileSync(join(pluginDir, "added.mjs"), "// new in v2\n");
	writeFileSync(join(pluginDir, "manifest.json"), JSON.stringify({ id: "dbx", name: "DB", version: "2.0.0" }));
	cli(["install", pluginDir, "--name", "dbx", "--force"], env);

	const files = readdirSync(target);
	assert(files.includes("db-connections.json"), `插件数据被删掉了：${files.join(", ")}`);
	assert(readFileSync(join(target, "db-connections.json"), "utf8") === data, "插件数据内容被改写");
	assert(JSON.parse(readFileSync(join(target, "config.json"), "utf8")).apiKey === "secret", "config.json 被新包覆盖");
	assert(files.includes("added.mjs"), "新版本文件没装上");
	assert(!files.includes("dropped.mjs"), `旧版本代码文件没被清理：${files.join(", ")}`);

	rmSync(join(target, ".pi-files.json"));
	writeFileSync(join(target, "legacy-stale.mjs"), "// left over from an old install\n");
	writeFileSync(join(pluginDir, "manifest.json"), JSON.stringify({ id: "dbx", name: "DB", version: "3.0.0" }));
	const out = cli(["install", pluginDir, "--name", "dbx", "--force"], env);
	assert(out.includes("随包文件清单") || out.includes("shipped-file list"), `应有降级提示：${out}`);
	assert(readFileSync(join(target, "db-connections.json"), "utf8") === data, "无清单时也绝不能删插件数据");
	assert(readdirSync(target).includes("legacy-stale.mjs"), "无清单时应保守地不清理旧文件");

	console.log("ok: 升级保留插件数据 + 清单驱动清理旧代码 + 无清单降级");
} finally {
	rmSync(root, { recursive: true, force: true });
}
