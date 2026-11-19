import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeClientSession } from "../helpers/fake-session.js";

/**
 * issue #943：同一份 transcript 被并发打开会造出两份 runtime 并双写同一份记录。
 * 服务端用 `openingSessions` 占位：任何 await 之前登记，冲突的第二个请求等第一个的结果复用。
 */
const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0)) {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {}
	}
});

function setup() {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-open-dedupe-"));
	dirs.push(agentDir);
	const sessionDir = join(agentDir, "sessions", "--proj--");
	mkdirSync(sessionDir, { recursive: true });
	const target = join(sessionDir, "2026-01-01T00-00-00-000Z_abc.jsonl");
	writeFileSync(target, '{"type":"session","id":"s"}\n');
	const cs: any = fakeClientSession();
	cs.agentDir = agentDir;
	cs.quiesceBlocked = () => false;
	cs.convs = new Map();
	cs.activeId = "A";
	cs.openingSessions = new Map();
	cs.emit = vi.fn();
	cs.flushSnapshot = vi.fn();
	cs.switchConversation = vi.fn(async (id: string) => {
		cs.activeId = id;
	});
	return { cs, target, agentDir };
}

describe("switchSession 并发打开去重 (issue #943)", () => {
	it("第一份还在创建时：第二个请求等它完成并复用同一个对话，不再进创建流程", async () => {
		const { cs, target } = setup();
		let settle!: (id?: string) => void;
		const opening = new Promise<string | undefined>((done) => {
			settle = done;
		});
		cs.openingSessions.set(resolve(target), opening);

		const second = cs.switchSession(target);
		// 第一个请求“创建”完成：登记 conv 并 settle 占位。
		cs.convs.set("opened-1", { id: "opened-1", session: { sessionFile: target } });
		settle("opened-1");
		await second;

		expect(cs.switchConversation).toHaveBeenCalledWith("opened-1");
		expect(cs.convs.size).toBe(1);
		expect(cs.emit).toHaveBeenCalledWith(
			expect.objectContaining({ type: "transition_progress", kind: "session", phase: "done", progress: 100 }),
		);
	});

	it("第一份打开失败时：第二个请求只提示重试，不重复一轮长耗时创建", async () => {
		const { cs, target } = setup();
		cs.openingSessions.set(resolve(target), Promise.resolve(undefined));

		await cs.switchSession(target);

		expect(cs.convs.size).toBe(0);
		expect(cs.switchConversation).not.toHaveBeenCalled();
		expect(cs.emit).toHaveBeenCalledWith(expect.objectContaining({ type: "notice", level: "warning" }));
	});

	it("静态保障：占位在任何创建前的 await 之前登记，并在 finally 里按身份清理", () => {
		const src = readFileSync(join(__dirname, "../../server/agent-service.ts"), "utf-8");
		const start = src.indexOf("async switchSession(path: string,");
		expect(start).toBeGreaterThan(0);
		const end = src.indexOf("private resolveUserMessageEntryId(", start);
		expect(end).toBeGreaterThan(start);
		const body = src.slice(start, end);

		// 先查在飞占位（冲突即等），再登记占位，且登记必须早于任何创建前的 await。
		const lookupAt = body.indexOf("const inflight = this.openingSessions.get(targetPath)");
		const registerAt = body.indexOf("this.openingSessions.set(targetPath, openingPromise)");
		const repairAt = body.indexOf("await this.repairTranscriptFileBeforeOpen(");
		const sdkAt = body.indexOf("await openSessionManagerAsync(");
		expect(lookupAt).toBeGreaterThan(0);
		expect(registerAt).toBeGreaterThan(0);
		expect(repairAt).toBeGreaterThan(0);
		expect(sdkAt).toBeGreaterThan(0);
		expect(lookupAt).toBeLessThan(registerAt);
		expect(registerAt).toBeLessThan(repairAt);
		expect(registerAt).toBeLessThan(sdkAt);
		// 任何出口（成功/失败/被拦截）都要清占位，否则后续打开会被永久挡住。
		expect(body).toContain("this.openingSessions.delete(openingKey)");
		expect(body).toContain("settleOpening(openedConversationId)");
	});
});
