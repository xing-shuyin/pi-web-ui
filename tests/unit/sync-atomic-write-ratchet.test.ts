import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { blankNonCode } from "../helpers/code-scan.js";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const SYNC_ATOMIC_CALL = /\b(writeAtomicSync|writeJsonAtomicSync|readFileSyncRetry)\s*\(/;
const SYNC_ATOMIC_DECL =
	/^\s*(export\s+)?(async\s+)?function\s+(writeAtomicSync|writeJsonAtomicSync|readFileSyncRetry)\b/;

/**
 * 棘轮：`writeAtomicSync` / `writeJsonAtomicSync` / `readFileSyncRetry` 的退避等待发生在调用线程上
 * （Windows 杀毒占用触发时最坏 630ms，期间该进程所有 WS 推送与请求一起停摆，issue #966）。
 *
 * 这件事不能靠「记得别用」来守：新增一个同步原子写，就是新增一处全服务停摆点。所以存量逐个登记在
 * 下面，**只允许变短**：删掉一行是迁移完成，新增一行会红。
 *
 * 迁移方式二选一：
 * - 可重建的缓存/投影 → `server/serialized-json-writer.ts` 的 `write()`（排队、不阻塞、同文件有序）；
 * - 真值存储（用户数据 / 授权 / 账本）→ `writeNow()` 或 `writeJsonAtomic()` + `await`。
 */
const ALLOWED: Record<string, number> = {
	// 外部进程的自包含生成件与其宿主：不在本进程事件循环上，且不能 import 服务端模块。
	"server/atomic-file.ts": 1,

	// 启动期一次性引导 / SDK 补丁：发生在 HTTP/WS 开始服务之前，不存在「请求被阻塞」。
	"server/ensure-bash.ts": 1,
	"server/patch-node-pty.ts": 1,
	"server/patch-remote-catalog.ts": 1,

	// 子进程启动前的 argv 构造（同步函数）：写 0600 临时 overlay，不在请求热路径；
	// 改成异步要连带把 native-cli / engine-cli 整条同步启动链改成 Promise（接口级变更）。
	"server/native-cli-model.ts": 1,

	// versioned-doc 的 handle 同时持有读与写：写入侧已异步化，只剩读侧的同步退避重试。
	"server/versioned-doc.ts": 1,

	// 设置 / 客户端状态：saveSettings 的失败契约是同步抛错（订阅者据此不广播），
	// 异步化要先拆「提交」语义并改动 40+ 调用点。
	"server/client-state.ts": 2,

	// 会话列表水合发生在同步读里（listConversations 仍是同步 API）：
	// 迁移会让「升级后第一次列表」读不到，需先把列表链改成 async。
	"server/universal/session-store.ts": 2,

	// 图片投影链是同步的（serializeMessage 被同步快照构造调用）：
	// 改成 async 要动整条投影链，属于独立改造。
	"server/attachment-store.ts": 1,
};

function walk(dir: string, out: string[] = []): string[] {
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) walk(path, out);
		else if (name.endsWith(".ts")) out.push(path);
	}
	return out;
}

function currentSyncAtomicSites(): Record<string, number> {
	const files = walk(join(repoRoot, "server"));
	const counts: Record<string, number> = {};
	for (const file of files) {
		const lines = blankNonCode(readFileSync(file, "utf8")).split("\n");
		let hits = 0;
		for (const line of lines) {
			if (!SYNC_ATOMIC_CALL.test(line) || SYNC_ATOMIC_DECL.test(line) || /from "/.test(line)) continue;
			hits++;
		}
		if (hits > 0)
			counts[
				file
					.split("\\")
					.join("/")
					.replace(/^.*\/server\//, "server/")
			] = hits;
	}
	return counts;
}

describe("同步原子写的棘轮（#966）", () => {
	it("没有新增的同步原子写调用点，且登记过的只能变少", () => {
		const current = currentSyncAtomicSites();
		const added = Object.keys(current).filter((file) => !(file in ALLOWED));
		expect(
			added,
			"新增同步原子写会把最坏 630ms 阻塞放到事件循环上；请改用 writeJsonAtomic / serialized-json-writer",
		).toEqual([]);
		const grown = Object.entries(current).filter(([file, count]) => count > (ALLOWED[file] ?? 0));
		expect(grown, "同一文件里的同步原子写变多了").toEqual([]);
	});

	it("迁移完成后必须把登记行删掉（棘轮只收紧）", () => {
		const current = currentSyncAtomicSites();
		const stale = Object.entries(ALLOWED)
			.filter(([file, count]) => count > 0 && (current[file] ?? 0) < count)
			.map(([file]) => file);
		expect(stale, "这些文件的同步原子写已经减少，请把 ALLOWED 里对应数字调小或删行").toEqual([]);
	});
});
