import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { FilesService, MACHINE_ROOT } from "../../server/files-service.js";
import type { ServerMessage } from "../../server/protocol.js";

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function makeService(cwd: string) {
	const seen: ServerMessage[] = [];
	const spawnCalls: Array<{ cmd: string; args: string[]; okText: string; okTextEn: string }> = [];
	const svc = new FilesService({
		emit: (m) => void seen.push(m),
		isDisposed: () => false,
		getCwd: () => cwd,
		getActiveCwd: () => cwd,
	});
	(svc as unknown as { spawnDetached: unknown }).spawnDetached = async (
		cmd: string,
		args: string[],
		okText: string,
		okTextEn: string,
	) => {
		spawnCalls.push({ cmd, args, okText, okTextEn });
		(svc as unknown as { host: { emit: (m: ServerMessage) => void } }).host.emit({
			type: "notice",
			level: "info",
			text: okText,
			textEn: okTextEn,
		});
	};
	return { svc, seen, spawnCalls };
}

describe("files-service: revealEntry 系统资源管理器定位", () => {
	it("空路径 '' 正确解析为工作区根目录并调用定位", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "piweb-reveal-test-"));
		dirs.push(cwd);
		const { svc, seen, spawnCalls } = makeService(cwd);

		await svc.revealEntry("");

		expect(spawnCalls.length).toBe(1);
		const call = spawnCalls[0];
		if (process.platform === "win32") {
			expect(call.cmd).toBe("explorer.exe");
			expect(call.args).toEqual(["/n,", cwd]);
		} else if (process.platform === "darwin") {
			expect(call.cmd).toBe("open");
			expect(call.args).toEqual([cwd]);
		} else {
			expect(call.cmd).toBe("xdg-open");
			expect(call.args).toEqual([cwd]);
		}
		expect(call.okText).toContain(basename(cwd));
		const infos = seen.filter((m) => m.type === "notice" && m.level === "info");
		expect(infos.length).toBe(1);
	});

	it("子目录和文件路径正确区分目录 / 选中文件行为", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "piweb-reveal-test-"));
		dirs.push(cwd);
		mkdirSync(join(cwd, "src"));
		writeFileSync(join(cwd, "src", "index.ts"), "console.log('hi');");
		const { svc, spawnCalls } = makeService(cwd);

		await svc.revealEntry("src");
		expect(spawnCalls.length).toBe(1);
		if (process.platform === "win32") {
			expect(spawnCalls[0].args).toEqual(["/n,", join(cwd, "src")]);
		}

		await svc.revealEntry("src/index.ts");
		expect(spawnCalls.length).toBe(2);
		if (process.platform === "win32") {
			expect(spawnCalls[1].args).toEqual(["/select,", join(cwd, "src", "index.ts")]);
		}
	});

	it("机器根 @root 拒绝定位并发出警告 notice", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "piweb-reveal-test-"));
		dirs.push(cwd);
		const { svc, seen, spawnCalls } = makeService(cwd);

		await svc.revealEntry(MACHINE_ROOT);

		expect(spawnCalls.length).toBe(0);
		const warns = seen.filter((m) => m.type === "notice" && m.level === "warning");
		expect(warns.length).toBe(1);
		expect((warns[0] as { text: string }).text).toContain("此处不可定位");
	});

	it("不存在的文件发出警告 notice", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "piweb-reveal-test-"));
		dirs.push(cwd);
		const { svc, seen, spawnCalls } = makeService(cwd);

		await svc.revealEntry("non-existent-file.txt");

		expect(spawnCalls.length).toBe(0);
		const warns = seen.filter((m) => m.type === "notice" && m.level === "warning");
		expect(warns.length).toBe(1);
		expect((warns[0] as { text: string }).text).toContain("文件不存在");
	});
});
