import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	exportableSessionPath,
	findSessionsById,
	importSessionText,
	parsePiSessionText,
} from "../../plugins/session-migrate/index.mjs";

let root = "";
let outside = "";

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "sm-sessions-"));
	outside = mkdtempSync(join(tmpdir(), "sm-outside-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
	rmSync(outside, { recursive: true, force: true });
});

function sessionText(id: string, cwd: string, lines = 2) {
	const head = JSON.stringify({ type: "session", version: 3, id, timestamp: new Date(0).toISOString(), cwd });
	const body = Array.from({ length: lines }, (_, i) =>
		JSON.stringify({
			type: "message",
			id: `m${i}`,
			parentId: null,
			message: { role: i % 2 === 0 ? "user" : "assistant", content: [{ type: "text", text: `hello ${i}` }] },
		}),
	);
	return [head, ...body].join("\n") + "\n";
}

describe("session 导出路径白名单（#887）", () => {
	it("只放行会话库里的 jsonl", () => {
		const dir = join(root, "--proj--");
		mkdirSync(dir, { recursive: true });
		const file = join(dir, "2024_session-1.jsonl");
		writeFileSync(file, sessionText("session-1", "/proj"), "utf8");

		expect(exportableSessionPath(file, [root])).toBe(file);
		expect(exportableSessionPath(`${file}`, [root, outside])).toBe(file);
	});

	it("拦掉越界路径与非 jsonl", () => {
		const secret = join(outside, "id_rsa");
		writeFileSync(secret, "secret", "utf8");
		expect(exportableSessionPath(secret, [root])).toBeNull();
		expect(exportableSessionPath(join(outside, "x.jsonl"), [root])).toBeNull();
		expect(exportableSessionPath(root, [root])).toBeNull();
		expect(exportableSessionPath("", [root])).toBeNull();
		expect(exportableSessionPath("../escape.jsonl", [root])).toBeNull();
	});
});

describe("session jsonl 校验与导入（#887）", () => {
	it("首行必须是 pi 会话头", () => {
		expect(parsePiSessionText("").ok).toBe(false);
		expect(parsePiSessionText("not json\n").ok).toBe(false);
		expect(parsePiSessionText(JSON.stringify({ type: "message" })).ok).toBe(false);
		const ok = parsePiSessionText(sessionText("s1", "/proj"));
		expect(ok.ok).toBe(true);
		expect(ok.header.id).toBe("s1");
		expect(ok.messages).toBe(2);
	});

	it("首次导入落到 SDK 同款目录 <--cwd-->/<ts>_<id>.jsonl", () => {
		const res = importSessionText({ text: sessionText("s1", "/proj"), root });
		expect(res.ok).toBe(true);
		expect(dirname(res.dest)).toBe(join(root, "--proj--"));
		expect(basename(res.dest)).toMatch(/_s1\.jsonl$/);
		expect(readFileSync(res.dest, "utf8")).toContain('"id":"s1"');
	});

	it("目录编码与 SDK 一致（Windows 盘符 / 反斜杠 / 冒号）", () => {
		const res = importSessionText({ text: sessionText("w1", String.raw`E:\pi-web-ui`), root });
		expect(res.ok).toBe(true);
		expect(dirname(res.dest)).toBe(join(root, "--E--pi-web-ui--"));
	});

	it("重名先问：不给 mode 返回 duplicate 且不落盘", () => {
		importSessionText({ text: sessionText("s1", "/proj"), root });
		const again = importSessionText({ text: sessionText("s1", "/proj"), root });
		expect(again.ok).toBe(false);
		expect(again.duplicate).toBe(true);
		expect(again.existing.length).toBe(1);
	});

	it("copy 换新 id 另存，原会话保持不变", () => {
		const first = importSessionText({ text: sessionText("s1", "/proj"), root });
		const copy = importSessionText({ text: sessionText("s1", "/proj"), root, mode: "copy" });
		expect(copy.ok).toBe(true);
		expect(copy.sessionId).not.toBe("s1");
		expect(readFileSync(first.dest, "utf8")).toContain('"id":"s1"');
		expect(readFileSync(copy.dest, "utf8")).toContain(`"id":"${copy.sessionId}"`);
	});

	it("overwrite 就地写回同一个文件，不产生副本", () => {
		const first = importSessionText({ text: sessionText("s1", "/proj", 2), root });
		const updated = sessionText("s1", "/proj", 5);
		const res = importSessionText({ text: updated, root, mode: "overwrite" });
		expect(res.ok).toBe(true);
		expect(res.dest).toBe(first.dest);
		expect(readFileSync(first.dest, "utf8").trim().split("\n").length).toBe(6);
		expect(findSessionsById("s1", root).length).toBe(1);
	});

	it("cwd 可重定向，缺 cwd 就报错", () => {
		const head = JSON.stringify({ type: "session", id: "s2", timestamp: new Date(0).toISOString() });
		expect(importSessionText({ text: `${head}\n`, root }).ok).toBe(false);
		const res = importSessionText({ text: `${head}\n`, root, targetCwd: "/redirected" });
		expect(res.ok).toBe(true);
		expect(dirname(res.dest)).toBe(join(root, "--redirected--"));
	});

	it("容忍夹杂坏行的历史文件（只统计不阻断）", () => {
		const text = `${sessionText("s3", "/proj")}{broken line\n`;
		const parsed = parsePiSessionText(text);
		expect(parsed.ok).toBe(true);
		expect(parsed.bad).toBe(1);
	});

	it("scans and imports agy transcript.jsonl into pi v3 session", async () => {
		const agyHome = mkdtempSync(join(tmpdir(), "agy-home-"));
		const piAgentDir = mkdtempSync(join(tmpdir(), "pi-agent-"));
		const prevAgy = process.env.AGY_HOME;
		const prevPi = process.env.PI_CODING_AGENT_DIR;
		try {
			const convId = "conv-agy-001";
			const logsDir = join(agyHome, "brain", convId, ".system_generated", "logs");
			mkdirSync(logsDir, { recursive: true });
			writeFileSync(
				join(logsDir, "transcript.jsonl"),
				[
					JSON.stringify({
						step_index: 0,
						source: "USER_EXPLICIT",
						type: "USER_INPUT",
						created_at: "2026-11-27T05:00:00Z",
						content: "<USER_REQUEST>\n帮我修一下更新报错\n</USER_REQUEST>\nActive Workspaces:\n- /tmp/demo-proj",
					}),
					JSON.stringify({
						step_index: 1,
						source: "MODEL",
						type: "PLANNER_RESPONSE",
						created_at: "2026-11-27T05:00:05Z",
						content: "已经定位并修复。",
					}),
				].join("\n") + "\n",
				"utf8",
			);

			process.env.AGY_HOME = agyHome;
			process.env.PI_CODING_AGENT_DIR = piAgentDir;
			vi.resetModules();
			const mod = (await import("../../plugins/session-migrate/index.mjs")) as any;
			const scanned = mod.scanSources();
			expect(scanned.agy.length).toBe(1);
			expect(scanned.agy[0]).toMatchObject({
				source: "agy",
				id: convId,
				cwd: "/tmp/demo-proj",
				messages: 2,
				preview: "帮我修一下更新报错",
			});

			const imported = mod.importSessions([scanned.agy[0].file]);
			expect(imported[0].ok).toBe(true);
			const lines = readFileSync(imported[0].dest, "utf8")
				.trim()
				.split("\n")
				.map((l: string) => JSON.parse(l));
			expect(lines[0]).toMatchObject({ type: "session", version: 3, cwd: "/tmp/demo-proj" });
			expect(lines[1].message.content[0].text).toContain("[imported-from:agy]");
			expect(lines[2].message.content[0].text).toBe("帮我修一下更新报错");
			expect(lines[3].message.content[0].text).toBe("已经定位并修复。");
		} finally {
			if (prevAgy === undefined) delete process.env.AGY_HOME;
			else process.env.AGY_HOME = prevAgy;
			if (prevPi === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = prevPi;
			rmSync(agyHome, { recursive: true, force: true });
			rmSync(piAgentDir, { recursive: true, force: true });
		}
	});
});
