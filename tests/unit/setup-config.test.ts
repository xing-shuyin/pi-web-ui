import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { saveSetupConfig, type SetupRuntimeConfig } from "../../server/setup-config.js";
import {
	configFilePath,
	loadServerFileConfig,
	readServerFileConfig,
	saveServerFileConfig,
} from "../../server/server-config.js";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const runtime = (): SetupRuntimeConfig => ({
	token: "old-token",
	host: "127.0.0.1",
	port: 8787,
	allowHosts: [],
	allowOrigins: [],
});

describe("setup configuration transaction", () => {
	it.each([{ host: "invalid/host" }, { port: 0 }, { port: true }, { allowHosts: [] }, { allowOrigins: 123 }])(
		"does not publish a token or save on validation failure: %j",
		async (invalid) => {
			const current = runtime();
			const previous = { token: "old-token" };
			const save = vi.fn();
			const result = await saveSetupConfig({ token: "new-token", ...invalid }, previous, current, save);
			expect(result).toMatchObject({ ok: false, status: 400 });
			expect(result).not.toHaveProperty("nextToken");
			expect(current.token).toBe("old-token");
			expect(previous.token).toBe("old-token");
			expect(save).not.toHaveBeenCalled();
		},
	);

	it("keeps the runtime token when a real filesystem save fails", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-setup-transaction-"));
		dirs.push(dir);
		const blocked = join(dir, "not-a-directory");
		writeFileSync(blocked, "block mkdir");
		const current = runtime();
		const result = await saveSetupConfig({ token: "new-token" }, { token: current.token }, current, (config) =>
			saveServerFileConfig(blocked, config),
		);
		if (result.ok) current.token = result.nextToken;
		expect(result).toMatchObject({ ok: false, status: 500 });
		expect(result).not.toHaveProperty("nextToken");
		expect(current.token).toBe("old-token");
	});

	it("publishes the trimmed next token only after successful persistence", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-setup-transaction-"));
		dirs.push(dir);
		const current = runtime();
		const result = await saveSetupConfig(
			{ token: " new-token ", host: "0.0.0.0", port: "9001" },
			{ token: current.token },
			current,
			(config) => {
				expect(current.token).toBe("old-token");
				return saveServerFileConfig(dir, config);
			},
		);
		expect(result).toMatchObject({ ok: true, nextToken: "new-token", tokenApplied: true, restartRequired: true });
		expect(loadServerFileConfig(dir)).toEqual({ token: "new-token", host: "0.0.0.0", port: 9001 });
		expect(current.token).toBe("old-token");
	});

	it("clears token and optional fields only in the saved candidate", async () => {
		const current = runtime();
		const previous = { token: "old-token", host: "localhost", port: 9000, allowHosts: "example.com" };
		const save = vi.fn();
		const result = await saveSetupConfig({ token: " ", host: "", port: "", allowHosts: "" }, previous, current, save);
		expect(save).toHaveBeenCalledWith({});
		expect(result).toMatchObject({ ok: true, nextToken: "", tokenApplied: true });
		expect(previous.token).toBe("old-token");
	});

	it("retains runtime token for omitted token and normalizes allowlists for restart comparison", async () => {
		const current = { ...runtime(), allowHosts: ["example.com"], allowOrigins: ["https://example.com"] };
		const result = await saveSetupConfig(
			{ allowHosts: " EXAMPLE.COM ", allowOrigins: " HTTPS://EXAMPLE.COM " },
			{},
			current,
			vi.fn(),
		);
		expect(result).toMatchObject({ ok: true, nextToken: "old-token", tokenApplied: false, restartRequired: false });
	});

	// 损坏的配置走 /setup 修：`previous` 来自 `loadServerFileConfig`（损坏时是本次启动的临时口令），
	// 用户提交新口令后必须能写回一个能读的 0600 文件（而不是继续损坏）。
	it("repairs a corrupt config through the setup save", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-setup-repair-"));
		dirs.push(dir);
		writeFileSync(configFilePath(dir), '{ "token": "trunc', "utf8");
		expect(readServerFileConfig(dir).state).toBe("corrupt");
		const current = runtime();
		const result = await saveSetupConfig({ token: "recovered-token" }, loadServerFileConfig(dir), current, (config) =>
			saveServerFileConfig(dir, config),
		);
		expect(result).toMatchObject({ ok: true, nextToken: "recovered-token", tokenApplied: true });
		expect(readServerFileConfig(dir)).toEqual({ state: "ok", config: { token: "recovered-token" }, error: "" });
	});
});
