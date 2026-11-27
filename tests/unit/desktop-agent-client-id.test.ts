import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	AGENT_CLIENT_ID_FILENAME,
	formatAgentClientIdArg,
	isValidAgentClientId,
	parseAgentClientIdArg,
	resolveOrCreateAgentClientId,
} from "../../desktop/agent-client-id.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-desktop-cid-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
});

describe("desktop agent clientId 持久化与参数解析", () => {
	it("首次生成 UUID 并写入 userData 目录，后续调用稳定复用", () => {
		const dir = makeTempDir();
		const first = resolveOrCreateAgentClientId(dir);
		expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
		expect(readFileSync(join(dir, AGENT_CLIENT_ID_FILENAME), "utf8").trim()).toBe(first);

		const second = resolveOrCreateAgentClientId(dir);
		expect(second).toBe(first);
	});

	it("已存文件损坏或为空时自动重新生成有效 UUID", () => {
		const dir = makeTempDir();
		writeFileSync(join(dir, AGENT_CLIENT_ID_FILENAME), "bad\n", "utf8");
		const next = resolveOrCreateAgentClientId(dir);
		expect(isValidAgentClientId(next)).toBe(true);
		expect(next).not.toBe("bad");
	});

	it("formatAgentClientIdArg / parseAgentClientIdArg 往返一致且忽略非法值", () => {
		const id = "11111111-2222-3333-4444-555555555555";
		const arg = formatAgentClientIdArg(id);
		expect(parseAgentClientIdArg(["--foo", arg])).toBe(id);
		expect(parseAgentClientIdArg(["--pi-agent-client-id=bad"])).toBeUndefined();
		expect(parseAgentClientIdArg(["--foo"])).toBeUndefined();
	});
});
