#!/usr/bin/env node
// install-git-hooks：把 scripts/git-hooks/ 下的钩子装进当前仓库的 .git/hooks。
//
// 为什么不用 core.hooksPath：那会把整个 hooks 目录交给本仓库管理，
// 其他人（和 husky 之类）已装的钩子会被静默盖掉。这里只按文件拷贝，装了什么一目了然。
//
//   npm run hooks:install      # 安装（幂等，覆盖同名钩子）
//   npm run hooks:install -- --uninstall
//   npm run hooks:install -- --list
import { chmodSync, copyFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC_DIR = join(ROOT, "scripts", "git-hooks");

function gitDir() {
	const out = execFileSync("git", ["rev-parse", "--git-dir"], { cwd: ROOT, encoding: "utf8" }).trim();
	return join(ROOT, out);
}

function main(argv) {
	if (argv.includes("--help") || argv.includes("-h")) {
		console.log("用法: node scripts/install-git-hooks.mjs [--uninstall|--list]");
		return 0;
	}
	if (!existsSync(SRC_DIR)) {
		console.error(`[hooks] 找不到钩子源目录：${SRC_DIR}`);
		return 1;
	}
	const hooks = readdirSync(SRC_DIR).filter((f) => !f.startsWith("."));
	const target = join(gitDir(), "hooks");

	if (argv.includes("--list")) {
		for (const name of hooks) {
			const dest = join(target, name);
			console.log(`${existsSync(dest) ? "已安装" : "未安装"}  ${name}  →  ${dest}`);
		}
		return 0;
	}

	if (argv.includes("--uninstall")) {
		for (const name of hooks) {
			const dest = join(target, name);
			if (existsSync(dest)) {
				rmSync(dest, { force: true });
				console.log(`[hooks] 已移除 ${name}`);
			}
		}
		return 0;
	}

	for (const name of hooks) {
		const dest = join(target, name);
		copyFileSync(join(SRC_DIR, name), dest);
		// Windows 上 chmod 是空操作，Git for Windows 靠 shebang 走自己的 sh，照样能跑。
		try {
			chmodSync(dest, 0o755);
		} catch {}
		console.log(`[hooks] 已安装 ${name} → ${dest}`);
	}
	console.log(`
[hooks] 完成。pre-push 默认跑 static 档（格式/lint/协议/语言包/类型）：
  CI_LOCAL_PROFILE=pr|full git push   # 更严的档位
  SKIP_CI_LOCAL=1 git push            # 跳过
  完整复刻 CI：npm run ci:local`);
	return 0;
}

process.exit(main(process.argv.slice(2)));
