import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (relative: string) => readFileSync(join(root, relative), "utf8");

describe("P2P 助手必须随桌面安装包分发", () => {
	const workflow = read(".github/workflows/desktop-release.yml");
	const jobs = [...workflow.matchAll(/^ {2}([a-z][\w-]*):$/gm)].map((match) => ({
		name: match[1],
		start: match.index ?? 0,
	}));
	const section = (name: string) => {
		const index = jobs.findIndex((job) => job.name === name);
		expect(index, `desktop-release.yml 缺少 job ${name}`).toBeGreaterThan(-1);
		const end = jobs[index + 1]?.start ?? workflow.length;
		return workflow.slice(jobs[index].start, end);
	};

	// 没有助手二进制时 deviceP2PAvailable() 恒为 false，P2P 静默退回 Hub 中继，
	// 安装包因此看上去「P2P 不支持」。三个平台的 job 都必须自己构建本平台助手。
	for (const name of ["windows-installer", "macos-installer", "linux-installer"]) {
		it(`${name} 构建并打包本平台助手`, () => {
			const body = section(name);
			expect(body).toContain("actions/setup-go");
			expect(body).toContain("npm run build:device-p2p -- --host");
			// 必须在 electron-builder 之前构建，否则 bin/ 里没有助手可打包
			const helper = body.indexOf("build:device-p2p");
			const pack = body.indexOf("electron-builder");
			expect(helper).toBeLessThan(pack);
		});
	}

	it("安装包白名单包含 bin/，且构建脚本支持 --host 单平台构建", () => {
		expect(read("desktop/electron-builder.yml")).toMatch(/^files:\n(?: {2}- .*\n)*? {2}- bin$/m);
		expect(read("scripts/build-device-p2p.mjs")).toContain('process.argv.includes("--host")');
	});

	it("npm 发布链路同样构建助手并校验哈希", () => {
		const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
		expect(pkg.scripts["prepublishOnly"]).toContain("build:device-p2p");
		expect(pkg.scripts["pack:p2p"]).toContain("verify:device-p2p");
	});
});
