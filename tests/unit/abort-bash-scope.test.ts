import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { makeKillableBashTool } from "../../server/bash-tool.js";
import { ClientSession } from "../../server/agent-service.js";
import { fakeClientSession } from "../helpers/fake-session.js";

function client(): any {
	return Object.assign(fakeClientSession(), {
		activeId: "A",
		convs: new Map(),
		settingsSvc: { current: {} },
		emit: vi.fn(),
		flushSnapshot: vi.fn(),
	});
}

function conversation(id: string): any {
	return {
		id,
		isSubagent: false,
		runtime: { session: { sendUserMessage: vi.fn().mockResolvedValue(undefined) } },
	};
}

function register(session: any, conv: any) {
	const controller = new AbortController();
	session.bashKillsOf(conv).add(controller);
	return controller;
}

describe("abortBash stable ownership", () => {
	it("terminates a real native bash subprocess after its Conversation changes holders", async () => {
		const directory = mkdtempSync(join(tmpdir(), "abort-bash-scope-"));
		const ready = join(directory, "ready.json");
		const script = join(directory, "worker.cjs");
		writeFileSync(
			script,
			'require("node:fs").writeFileSync(process.argv[2], JSON.stringify({pid:process.pid})); setInterval(() => {}, 1000);',
		);
		const source = client();
		const destination = client();
		const conv = conversation("A");
		source.convs.set(conv.id, conv);
		const kills = source.bashKillsOf(conv);
		const tool = makeKillableBashTool(directory, kills);
		const quote = (value: string) => "'" + value.replaceAll("\\", "/").replaceAll("'", "'\\''") + "'";
		const running = tool.execute(
			"native",
			{ command: [process.execPath, script, ready].map(quote).join(" "), timeout: 20 },
			undefined,
			undefined,
			{ sessionManager: { getSessionId: () => "bash-scope", getSessionFile: () => undefined } } as any,
		);
		// Attach a rejection handler immediately; cancellation may settle during readiness checks.
		const settled = running.then(
			(value) => ({ value }),
			(error) => ({ error }),
		);
		const otherReady = join(directory, "other-ready.json");
		const replacement = conversation("A");
		const otherKills = source.bashKillsOf(replacement);
		const otherRunning = makeKillableBashTool(directory, otherKills).execute(
			"other-native",
			{ command: [process.execPath, script, otherReady].map(quote).join(" "), timeout: 20 },
			undefined,
			undefined,
			{ sessionManager: { getSessionId: () => "other-bash", getSessionFile: () => undefined } } as any,
		);
		const otherSettled = otherRunning.then(
			(value) => ({ value }),
			(error) => ({ error }),
		);
		let pid: number | undefined;
		let otherPid: number | undefined;
		try {
			await Promise.race([
				vi.waitFor(() => expect(existsSync(ready)).toBe(true), { timeout: 10000 }),
				settled.then((result) => {
					throw new Error(
						`Bash exited before readiness: ${"error" in result ? String(result.error) : JSON.stringify(result.value)}`,
					);
				}),
			]);
			pid = JSON.parse(readFileSync(ready, "utf8")).pid;
			await Promise.race([
				vi.waitFor(() => expect(existsSync(otherReady)).toBe(true), { timeout: 10000 }),
				otherSettled.then((result) => {
					throw new Error(
						`Other bash exited before readiness: ${"error" in result ? String(result.error) : JSON.stringify(result.value)}`,
					);
				}),
			]);
			otherPid = JSON.parse(readFileSync(otherReady, "utf8")).pid;
			expect(kills.size).toBe(1);
			expect(otherKills.size).toBe(1);
			source.convs.delete("A");
			conv.id = "transferred-A";
			destination.convs.set(conv.id, conv);
			source.convs.set("A", replacement);
			await destination.abortBash(conv.id);
			await vi.waitFor(() => expect(kills.size).toBe(0), { timeout: 10000 });
			await settled;
			await vi.waitFor(() => expect(() => process.kill(pid!, 0)).toThrow(), { timeout: 5000 });
			expect(otherKills.size).toBe(1);
			expect(() => process.kill(otherPid!, 0)).not.toThrow();
			expect(conv.runtime.session.sendUserMessage).toHaveBeenCalledOnce();
			expect(replacement.runtime.session.sendUserMessage).not.toHaveBeenCalled();
		} finally {
			for (const controller of [...kills, ...otherKills]) controller.abort();
			await Promise.all([settled, otherSettled]);
			for (const processId of [pid, otherPid]) {
				if (!processId) continue;
				try {
					process.kill(processId, "SIGKILL");
				} catch {
					/* already exited */
				}
			}
			rmSync(directory, { recursive: true, force: true });
		}
	}, 30000);

	it.each(["A", undefined])("stops only the exact target %s", async (target) => {
		const session = client();
		const a = conversation("A");
		const b = conversation("B");
		session.convs.set(a.id, a);
		session.convs.set(b.id, b);
		const mine = register(session, a);
		const other = register(session, b);
		await session.abortBash(target);
		expect(mine.signal.aborted).toBe(true);
		expect(other.signal.aborted).toBe(false);
		expect(a.runtime.session.sendUserMessage).toHaveBeenCalledOnce();
		expect(b.runtime.session.sendUserMessage).not.toHaveBeenCalled();
	});

	it.each([undefined, "missing", ""])("does not fall back to an unrelated live command for %s", async (target) => {
		const session = client();
		session.convs.set("A", conversation("A"));
		const other = conversation("B");
		session.convs.set("B", other);
		const running = register(session, other);
		await session.abortBash(target);
		expect(running.signal.aborted).toBe(false);
		expect(other.runtime.session.sendUserMessage).not.toHaveBeenCalled();
		expect(session.emit).toHaveBeenCalledWith(expect.objectContaining({ textEn: "No bash command is running" }));
	});

	it("keeps running controllers with the transferred object and isolates reused IDs", async () => {
		const source = client();
		const destination = client();
		const original = conversation("A");
		source.convs.set("A", original);
		const running = register(source, original);
		source.convs.delete("A");
		original.id = "moved-A";
		destination.convs.set(original.id, original);
		const replacement = conversation("A");
		source.convs.set("A", replacement);
		const unrelated = register(source, replacement);
		await source.abortBash("moved-A");
		expect(running.signal.aborted).toBe(false);
		await destination.abortBash(original.id);
		expect(running.signal.aborted).toBe(true);
		expect(unrelated.signal.aborted).toBe(false);
		expect(original.runtime.session.sendUserMessage).toHaveBeenCalledOnce();
		expect(replacement.runtime.session.sendUserMessage).not.toHaveBeenCalled();
	});

	it("captures the runtime before synchronous abort listeners replace the owner", async () => {
		const session = client();
		const original = conversation("A");
		const replacement = conversation("A");
		const runtime = original.runtime;
		session.convs.set("A", original);
		const running = register(session, original);
		running.signal.addEventListener("abort", () => {
			session.convs.set("A", replacement);
			original.runtime = replacement.runtime;
		});
		await session.abortBash("A");
		expect(runtime.session.sendUserMessage).toHaveBeenCalledOnce();
		expect(replacement.runtime.session.sendUserMessage).not.toHaveBeenCalled();
	});
});
