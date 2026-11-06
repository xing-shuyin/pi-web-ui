import { describe, expect, it } from "vitest";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionLines } from "../../server/session-scan.js";
import { scanSessionListInfo } from "../../server/session-list-scan.js";

async function legacyListParse(filePath: string, fileMtime: number) {
	let id = "";
	let cwd = "";
	let name: string | undefined;
	let parentSessionPath: string | undefined;
	let firstMessage = "";
	let messageCount = 0;
	let lastActivityTime = 0;
	let headerTime = 0;
	for await (const line of sessionLines(filePath)) {
		if (!line.trim()) continue;
		if (id && firstMessage && line.length > 512 && !line.includes('"session_info"')) {
			const head = line.slice(0, 140);
			if (/"type"\s*:\s*"message"/.test(head)) {
				messageCount++;
				const tsMatch = /"timestamp"\s*:\s*(\d{10,16})/.exec(line);
				if (tsMatch) {
					const ts = Number(tsMatch[1]);
					if (ts > lastActivityTime) lastActivityTime = ts;
				}
			}
			continue;
		}
		let rec: Record<string, unknown> | null;
		try {
			rec = JSON.parse(line);
		} catch {
			continue;
		}
		if (!rec) continue;
		if (rec.type === "session") {
			id = typeof rec.id === "string" ? rec.id : "";
			cwd = typeof rec.cwd === "string" ? rec.cwd : "";
			if (typeof rec.timestamp === "string") headerTime = new Date(rec.timestamp).getTime();
			if (typeof rec.parentSession === "string") parentSessionPath = rec.parentSession;
		} else if (rec.type === "session_info") {
			if (typeof rec.name === "string" && rec.name.trim()) name = rec.name.trim();
		} else if (rec.type === "message") {
			messageCount++;
			const msg = rec.message as Record<string, unknown> | null;
			if (msg) {
				if (typeof msg.timestamp === "number") lastActivityTime = Math.max(lastActivityTime, msg.timestamp);
				if (!firstMessage && msg.role === "user") {
					let text = "";
					if (typeof msg.content === "string") text = msg.content;
					else if (Array.isArray(msg.content)) {
						for (const part of msg.content)
							if (part && typeof part.text === "string") text += (text ? " " : "") + part.text;
					}
					if (text) firstMessage = text;
				}
			}
		}
	}
	if (!id) return null;
	const modified = lastActivityTime > 0 ? lastActivityTime : headerTime > 0 ? headerTime : fileMtime;
	return {
		id,
		cwd,
		name,
		parentSessionPath,
		created: new Date(headerTime || fileMtime).getTime(),
		modified: new Date(modified).getTime(),
		messageCount,
		firstMessage: firstMessage || "(no messages)",
	};
}

function comparable(info: Awaited<ReturnType<typeof scanSessionListInfo>>) {
	const i = info?.info;
	if (!i) return null;
	return {
		id: i.id,
		cwd: i.cwd,
		name: i.name,
		parentSessionPath: i.parentSessionPath,
		created: i.created.getTime(),
		modified: i.modified.getTime(),
		messageCount: i.messageCount,
		firstMessage: i.firstMessage,
	};
}

function rng(seed: number) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function randomTranscript(r: () => number): string {
	const pick = <T>(xs: T[]) => xs[Math.floor(r() * xs.length)]!;
	const lines: string[] = [];
	if (r() < 0.95)
		lines.push(
			JSON.stringify({
				type: "session",
				id: `sess-${Math.floor(r() * 1e6)}`,
				cwd: "/p/中文 dir",
				timestamp: "2026-01-02T03:04:05.000Z",
				...(r() < 0.3 ? { parentSession: "/p/parent.jsonl" } : {}),
			}),
		);
	const n = Math.floor(r() * 30);
	let ts = 1_700_000_000_000;
	for (let i = 0; i < n; i++) {
		ts += Math.floor(r() * 100_000);
		const kind = r();
		if (kind < 0.08) {
			lines.push(JSON.stringify({ type: "session_info", name: pick(["", "  ", "Renamed", "重命名 ✓"]) }));
		} else if (kind < 0.12) {
			lines.push(pick(["", "   ", "{not json", '{"type":"message"', "null"]));
		} else {
			const role = pick(["user", "assistant", "toolResult"]);
			const big = r() < 0.4 ? "z".repeat(400 + Math.floor(r() * 3000)) : "";
			const image =
				r() < 0.15 ? [{ type: "image", mimeType: "image/png", data: "QUJD".repeat(200 + Math.floor(r() * 500)) }] : [];
			const content =
				r() < 0.3
					? `text ${i} ${big} 你好 "quoted"`
					: [
							...image,
							{ type: "text", text: `part ${i} ${big}` },
							...(r() < 0.3 ? [{ type: "text", text: "second" }] : []),
						];
			lines.push(
				JSON.stringify({
					type: "message",
					id: `m${i}`,
					parentId: i ? `m${i - 1}` : null,
					timestamp: new Date(ts).toISOString(),
					message: { role, content, ...(r() < 0.9 ? { timestamp: ts } : {}) },
				}),
			);
		}
	}
	const eol = r() < 0.2 ? "\r\n" : "\n";
	return lines.join(eol) + (r() < 0.8 ? eol : "");
}

function tmpFile(content: string): string {
	const dir = mkdtempSync(join(tmpdir(), "list-scan-"));
	const file = join(dir, "s.jsonl");
	writeFileSync(file, content, "utf8");
	return file;
}

describe("scanSessionListInfo 与原列表解析等价", () => {
	it("300 个随机转录（长行 / base64 图片 / 改名 / 坏行 / CRLF / 末尾半行）字段完全一致", async () => {
		for (let seed = 1; seed <= 300; seed++) {
			const file = tmpFile(randomTranscript(rng(seed)));
			const expected = await legacyListParse(file, 1234);
			const got = comparable(await scanSessionListInfo(file, 1234));
			expect({ seed, got }).toEqual({ seed, got: expected });
		}
	});
});

describe("CLI 类型元信息", () => {
	const header = { type: "session", id: "cli-session", cwd: "/workspace", timestamp: "2026-01-01T00:00:00.000Z" };
	const config = { preset: "codex", args: ["--model", "configured-model"] };
	const marker = (value: unknown = config, version = 1) => ({
		type: "custom",
		customType: "webui/native-cli",
		data: { version, config: value },
	});

	it("custom-only CLI session is visible with zero SDK messages and its persisted configuration", async () => {
		const file = tmpFile(
			[header, marker(), { type: "session_info", name: "Codex CLI" }].map((row) => JSON.stringify(row)).join("\n") +
				"\n",
		);
		const result = await scanSessionListInfo(file, 1234);
		expect(result?.info).toMatchObject({
			id: "cli-session",
			name: "Codex CLI",
			nativeCli: config,
			messageCount: 0,
			firstMessage: "",
		});
		expect(result?.state.nativeCli).toEqual(config);
	});

	it("preserves CLI type on incremental rename and accepts a long marker after a user message", async () => {
		const file = tmpFile(
			[header, { type: "message", message: { role: "user", content: "existing message" } }]
				.map((row) => JSON.stringify(row))
				.join("\n") + "\n",
		);
		const first = await scanSessionListInfo(file, 0);
		const configured = { preset: "custom", args: ["x".repeat(2000)], executable: "/native/program" };
		appendFileSync(file, JSON.stringify(marker(configured)) + "\n");
		const typed = await scanSessionListInfo(file, 0, first!.state);
		expect(typed?.resumedFrom).toBe(first!.state.offset);
		expect(typed?.info?.nativeCli).toEqual(configured);
		expect(typed?.info?.messageCount).toBe(1);
		appendFileSync(file, JSON.stringify({ type: "session_info", name: "Renamed CLI" }) + "\n");
		const renamed = await scanSessionListInfo(file, 0, typed!.state);
		expect(renamed?.info).toMatchObject({ nativeCli: configured, name: "Renamed CLI", messageCount: 1 });
	});

	it("does not advertise an invalid final CLI marker as valid configuration", async () => {
		const file = tmpFile([header, marker(), marker(config, 99)].map((row) => JSON.stringify(row)).join("\n") + "\n");
		expect((await scanSessionListInfo(file, 0))?.info?.nativeCli).toBeUndefined();
	});
});

describe("增量扫描", () => {
	const header = JSON.stringify({ type: "session", id: "s1", cwd: "/p", timestamp: "2026-01-01T00:00:00.000Z" });
	const msg = (i: number, role = "user", pad = 0) =>
		JSON.stringify({
			type: "message",
			id: `m${i}`,
			timestamp: "2026-01-01T00:00:00.000Z",
			message: { role, content: [{ type: "text", text: `t${i}${"x".repeat(pad)}` }], timestamp: 1_700_000_000_000 + i },
		});

	it("追加写入：从上次偏移续扫，结果与全量扫描一致", async () => {
		const file = tmpFile(`${header}\n${msg(1)}\n${msg(2, "assistant", 2000)}\n`);
		const first = await scanSessionListInfo(file, 0);
		expect(first!.resumedFrom).toBe(0);
		appendFileSync(file, `${msg(3, "assistant", 5000)}\n${JSON.stringify({ type: "session_info", name: "N" })}\n`);
		const inc = await scanSessionListInfo(file, 0, first!.state);
		expect(inc!.resumedFrom).toBe(first!.state.offset);
		const full = await scanSessionListInfo(file, 0);
		expect(comparable(inc)).toEqual(comparable(full));
		expect(inc!.info!.messageCount).toBe(3);
		expect(inc!.info!.name).toBe("N");
	});

	it("末尾半行：计入本次结果但不推进偏移；写完后续扫不重复计数", async () => {
		const file = tmpFile(`${header}\n${msg(1)}\n`);
		const line = msg(2, "assistant", 3000);
		appendFileSync(file, line.slice(0, 1500));
		const a = await scanSessionListInfo(file, 0);
		const offsetBefore = a!.state.offset;
		appendFileSync(file, `${line.slice(1500)}\n`);
		const b = await scanSessionListInfo(file, 0, a!.state);
		expect(b!.resumedFrom).toBe(offsetBefore);
		expect(comparable(b)).toEqual(comparable(await scanSessionListInfo(file, 0)));
		expect(b!.info!.messageCount).toBe(2);
	});

	it("文件被改写（中段变化 / 截断）：指纹不符，整份重扫", async () => {
		const file = tmpFile(`${header}\n${msg(1)}\n${msg(2)}\n${msg(3)}\n`);
		const first = await scanSessionListInfo(file, 0);
		writeFileSync(file, `${header}\n${msg(1)}\n${msg(2).replace('"m2"', '"m2--dup-1"')}\n${msg(3)}\n${msg(4)}\n`);
		const rescan = await scanSessionListInfo(file, 0, first!.state);
		expect(rescan!.resumedFrom).toBe(0);
		expect(rescan!.info!.messageCount).toBe(4);
		writeFileSync(file, `${header}\n${msg(1)}\n`);
		const truncated = await scanSessionListInfo(file, 0, rescan!.state);
		expect(truncated!.resumedFrom).toBe(0);
		expect(truncated!.info!.messageCount).toBe(1);
	});

	it("文件不存在：返回 null", async () => {
		expect(await scanSessionListInfo(join(tmpdir(), "no-such-session-file.jsonl"), 0)).toBeNull();
	});
});
