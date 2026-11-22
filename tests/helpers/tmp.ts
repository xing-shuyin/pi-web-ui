import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * 测试用临时目录（单源）。
 *
 * 为什么需要它：这些用例以前在 win32 上写死 `E:/tmp`（当时的开发机把临时目录挪到了 E 盘），
 * 换一台机器就是 `ENOENT: mkdtemp 'E:\tmp\...'` —— 18 条用例整批红，看起来像代码坏了。
 * 临时目录属于环境，必须走 `os.tmpdir()`。
 */
export function testTmpRoot(): string {
	return tmpdir();
}

/** 建一个独立的临时目录；`prefix` 只用于辨认是哪条用例。 */
export async function makeTestTmpDir(prefix: string): Promise<string> {
	await mkdir(testTmpRoot(), { recursive: true });
	return mkdtemp(join(testTmpRoot(), `${prefix}-`));
}
