import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { ATOMIC_RETRY_DELAY_MS, TRANSIENT_FS_CODES } from "../../server/atomic-file.js";
import { renderBinAtomicFile } from "../../scripts/lib/atomic-file-generator.mjs";

// Hub 升级 worker（bin/hub-upgrade.mjs）不能 import TS，所以退避逻辑以「构建期生成」的方式跟着单一实现走。
// 这个守卫保证：生成的 bin/lib/atomic-file.mjs 一旦和 server/atomic-file.ts 漂移就红。
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const generatedPath = join(repoRoot, "bin/lib/atomic-file.mjs");
const distEntry = join(repoRoot, "dist/server/atomic-file.js");

describe("bin/lib/atomic-file.mjs 与 server/atomic-file.ts 同源", () => {
	it("退避表与瞬时错误码是同一份拷贝", () => {
		const generated = readFileSync(generatedPath, "utf8").replace(/\s+/g, "");
		expect(generated).toContain(JSON.stringify([...TRANSIENT_FS_CODES]).replace(/\s+/g, ""));
		expect(generated).toContain(JSON.stringify([...ATOMIC_RETRY_DELAY_MS]).replace(/\s+/g, ""));
	});

	it.skipIf(!existsSync(distEntry))("dist 存在时逐字节比对生成结果（跑过 npm run build:server 就会覆盖）", async () => {
		const atomic = await import(pathToFileURL(distEntry).href);
		expect(readFileSync(generatedPath, "utf8")).toBe(await renderBinAtomicFile(atomic as never));
	});

	it("worker 用的是生成模块，而不是自己另写一套 rename 重试", () => {
		const source = readFileSync(join(repoRoot, "bin/hub-upgrade.mjs"), "utf8");
		expect(source).toContain('from "./lib/atomic-file.mjs"');
		expect(source).toContain("writeAtomicFileSync(");
		expect(source).toContain("readFileSyncRetry(");
		// 旧的非重试写法必须彻底消失，否则 EPERM 会再回来
		expect(source).not.toMatch(/renameSync\(\s*temp\s*,\s*path\s*\)/);
	});
});
