import { describe, expect, it, vi, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, basename } from "node:path";
import { FilesService, MACHINE_ROOT } from "../../server/files-service.js";
import type { ServerMessage } from "../../server/protocol.js";

const dirs: string[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function makeService(cwd: string) {
	const seen: ServerMessage[] = [];
	const svc = new FilesService({
		emit: (m) => void seen.push(m),
		isDisposed: () => false,
		getCwd: () => cwd,
		getActiveCwd: () => cwd,
	});
	return { svc, seen };
}

describe("files-service: revealEntry 支持定位根目录与空白处", () => {
	it("空字符串 '' 定位工作区根目录", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-reveal-test-"));
		dirs.push(tempDir);

		const { svc, seen } = makeService(tempDir);
		const calls: { cmd: string; args: string[]; okText: string }[] = [];
		(svc as any).spawnDetached = vi.fn(async (cmd: string, args: string[], okText: string) => {
			calls.push({ cmd, args, okText });
			seen.push({ type: "notice", level: "info", text: okText });
		});

		await svc.revealEntry("");

		expect(calls.length).toBe(1);
		const expectedAbs = resolve(tempDir);
		expect(calls[0].args).toContain(expectedAbs);

		const successNotice = seen.find((m) => m.type === "notice" && m.level === "info");
		expect(successNotice).toBeDefined();
		if (successNotice?.type === "notice") {
			expect(successNotice.text).toContain(basename(expectedAbs));
		}
	});

	it("定位子目录正常工作", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-reveal-test-"));
		dirs.push(tempDir);
		const subDir = join(tempDir, "subfolder");
		mkdirSync(subDir);

		const { svc, seen } = makeService(tempDir);
		const calls: { cmd: string; args: string[]; okText: string }[] = [];
		(svc as any).spawnDetached = vi.fn(async (cmd: string, args: string[], okText: string) => {
			calls.push({ cmd, args, okText });
			seen.push({ type: "notice", level: "info", text: okText });
		});

		await svc.revealEntry("subfolder");

		expect(calls.length).toBe(1);
		expect(calls[0].args).toContain(resolve(subDir));

		const successNotice = seen.find((m) => m.type === "notice" && m.level === "info");
		expect(successNotice).toBeDefined();
	});

	it("MACHINE_ROOT 机器根不可定位并给出友好提示", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-reveal-test-"));
		dirs.push(tempDir);

		const { svc, seen } = makeService(tempDir);
		await svc.revealEntry(MACHINE_ROOT);

		const warnNotice = seen.find((m) => m.type === "notice" && m.level === "warning");
		expect(warnNotice).toBeDefined();
		if (warnNotice?.type === "notice") {
			expect(warnNotice.text).toContain("此处不可定位");
		}
	});
});
