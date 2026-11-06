import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const INDEX = join(ROOT, "server", "index.ts");

describe("heartbeat unref", () => {
	it("heartbeatTimer 存在且已 unref（空闲不吊住进程）", () => {
		const src = readFileSync(INDEX, "utf8");
		expect(src).toContain("const heartbeatTimer = setInterval(");
		expect(src).toMatch(/heartbeatTimer\.unref\?\.\(\)/);
	});

	it("shutdown 路径仍 clearInterval(heartbeatTimer)", () => {
		const src = readFileSync(INDEX, "utf8");
		expect(src).toContain("clearInterval(heartbeatTimer)");
	});
});
