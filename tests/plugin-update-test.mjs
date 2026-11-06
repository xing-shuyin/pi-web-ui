import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BIN = resolve(__dirname, "../bin/pi-web-ui.mjs");
const GIT = "git";

function git(...args) {
	return execFileSync(GIT, args, { encoding: "utf8" });
}
const { LC_ALL: _lcAll, LC_MESSAGES: _lcMessages, ...baseEnv } = process.env;
const ZH_ENV = { ...baseEnv, LANG: "zh_CN.UTF-8" };

function cli(args) {
	const r = spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8", env: ZH_ENV });
	if (r.status !== 0) throw new Error(`CLI 失败(${args[0]}): ${r.stderr || r.stdout}`);
	return r.stdout;
}

function main() {
	try {
		execFileSync(GIT, ["--version"], { stdio: "ignore" });
	} catch {
		console.log("skip: git 不可用");
		return;
	}
	const root = mkdtempSync(join(tmpdir(), "plugin-update-e2e-"));
	const upstream = join(root, "upstream");
	const dataDir = join(root, "data");
	try {
		git("init", "-q", upstream);
		git("-C", upstream, "config", "user.email", "t@t");
		git("-C", upstream, "config", "user.name", "t");
		writeFileSync(join(upstream, "manifest.json"), JSON.stringify({ id: "upd", name: "更新演示", version: "v1" }));
		writeFileSync(join(upstream, "index.mjs"), "// v1\n");
		git("-C", upstream, "add", "-A");
		git("-C", upstream, "commit", "-qm", "v1");

		const inst = cli(["install", upstream, "--data-dir", dataDir]);
		if (!/已安装插件 upd/.test(inst)) throw new Error("install 失败: " + inst);
		const sha1 = readFileSync(join(dataDir, "plugins", "upd", ".pi-git-sha"), "utf8").trim();
		if (!/^[0-9a-f]{12}$/.test(sha1)) throw new Error(`.pi-git-sha 缺失: ${sha1}`);
		console.log(`✓ install 记录 sha=${sha1}`);

		writeFileSync(join(upstream, "manifest.json"), JSON.stringify({ id: "upd", name: "更新演示", version: "v2" }));
		writeFileSync(join(upstream, "index.mjs"), "// v2\n");
		git("-C", upstream, "add", "-A");
		git("-C", upstream, "commit", "-qm", "v2");
		const chk1 = cli(["plugins", "--check-updates", "--data-dir", dataDir]);
		if (!/🔄 upd.*可更新/.test(chk1)) throw new Error("check-updates 未报可更新:\n" + chk1);
		console.log("✓ check-updates 报可更新");

		const upd = cli(["install", upstream, "--name", "upd", "--force", "--data-dir", dataDir]);
		if (!/v2/.test(upd)) throw new Error("更新失败: " + upd);
		const backups = readdirSync(join(dataDir, "plugin-backups"));
		if (backups.length !== 1 || !backups[0].startsWith("upd-")) throw new Error("备份缺失: " + backups.join(","));
		if (readFileSync(join(dataDir, "plugins", "upd", "index.mjs"), "utf8") !== "// v2\n")
			throw new Error("未更新到 v2");
		const chk2 = cli(["plugins", "--check-updates", "--data-dir", dataDir]);
		if (!/已是最新/.test(chk2)) throw new Error("更新后未报最新:\n" + chk2);
		console.log("✓ install --force 更新 + 自动备份 + sha 刷新 → 已是最新");

		const rb = cli(["plugins", "--rollback", "upd", "--data-dir", dataDir]);
		if (!/已回滚/.test(rb)) throw new Error("回滚失败: " + rb);
		if (readFileSync(join(dataDir, "plugins", "upd", "index.mjs"), "utf8") !== "// v1\n")
			throw new Error("回滚后不是 v1");
		if (existsSync(join(dataDir, "plugin-backups"))) {
			const left = readdirSync(join(dataDir, "plugin-backups"));
			if (left.length !== 0) throw new Error("备份未清理: " + left.join(","));
		}
		console.log("✓ --rollback 回滚 v1 + 备份清理");

		const chk3 = cli(["plugins", "--check-updates", "--data-dir", dataDir]);
		if (!/🔄 upd.*可更新/.test(chk3)) throw new Error("回滚后未重新报可更新:\n" + chk3);
		console.log("✓ 回滚后 check-updates 重新报可更新");

		console.log("all ok");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

main();
