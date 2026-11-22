import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
	EditOperations,
	FindOperations,
	LsOperations,
	ReadOperations,
	WriteOperations,
} from "@earendil-works/pi-coding-agent";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	createRemoteSdkOperations,
	resolveWorkspaceSessionDir,
	setGlobalRemoteSshService,
} from "../../server/remote-ssh-service.js";

/**
 * 远程桥接 ops 的契约锚点。
 *
 * SDK 的 ops 接口用可选项演进（`read` 的 `detectImageMimeType` / `createReadStream` 都是可选），
 * `?` 天然绕过 TypeScript 的赋值检查：少实现一个成员不报错，只会静默降级（图片按 UTF-8 解码成
 * 乱码、文本整文件传回内存）。下面这些字面量以 `Record<keyof Required<...>, true>` 声明：上游
 * 任何成员变更（含可选项）都会让本文件编译失败，逼迫桥接层做一次显式决定——实现它，或者在这里
 * 写下不实现的理由——而不是无声退化。
 *
 * 与 SDK 默认实现对齐的取舍见 `docs/architecture-remote-workspace.md`。
 */
const READ_CONTRACT: Record<keyof Required<ReadOperations>, true> = {
	readFile: true,
	access: true,
	detectImageMimeType: true,
	createReadStream: true,
};
const WRITE_CONTRACT: Record<keyof Required<WriteOperations>, true> = { writeFile: true, mkdir: true };
const EDIT_CONTRACT: Record<keyof Required<EditOperations>, true> = { readFile: true, writeFile: true, access: true };
const LS_CONTRACT: Record<keyof Required<LsOperations>, true> = { exists: true, stat: true, readdir: true };
const FIND_CONTRACT: Record<keyof Required<FindOperations>, true> = { exists: true, glob: true };

const REMOTE_URI = "ssh://root@198.51.100.10:22/project/game-share";

let dataDir = "";

beforeAll(async () => {
	dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-web-remote-ops-contract-"));
});

afterAll(async () => {
	setGlobalRemoteSshService(null);
	await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
});

describe("远程 SSH 桥接 ops 必须覆盖 SDK 契约的全部成员", () => {
	it("read / write / edit / ls / find 逐成员覆盖（含可选项）", () => {
		const ops = createRemoteSdkOperations(resolveWorkspaceSessionDir(dataDir, REMOTE_URI));
		expect(ops).not.toBeNull();
		const cases: Array<[string, object, Record<string, true>]> = [
			["read", ops!.read, READ_CONTRACT],
			["write", ops!.write, WRITE_CONTRACT],
			["edit", ops!.edit, EDIT_CONTRACT],
			["ls", ops!.ls, LS_CONTRACT],
			["find", ops!.find, FIND_CONTRACT],
		];
		for (const [name, actual, contract] of cases) {
			expect(Object.keys(actual).sort(), `${name} ops 与 SDK 契约不一致`).toEqual(Object.keys(contract).sort());
			for (const key of Object.keys(contract)) {
				expect(typeof (actual as Record<string, unknown>)[key], `${name}.${key} 必须是函数`).toBe("function");
			}
		}
	});
});
