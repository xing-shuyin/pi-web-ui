import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initHttpProxy, resolveProxySettings } from "../../server/http-proxy.js";

describe("HTTP Proxy 支持", () => {
	let dir: string;
	const origHttpProxy = process.env.HTTP_PROXY;
	const origHttpsProxy = process.env.HTTPS_PROXY;
	const origAllProxy = process.env.ALL_PROXY;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pi-proxy-test-"));
		delete process.env.HTTP_PROXY;
		delete process.env.HTTPS_PROXY;
		delete process.env.ALL_PROXY;
	});

	afterEach(() => {
		if (origHttpProxy !== undefined) process.env.HTTP_PROXY = origHttpProxy;
		else delete process.env.HTTP_PROXY;
		if (origHttpsProxy !== undefined) process.env.HTTPS_PROXY = origHttpsProxy;
		else delete process.env.HTTPS_PROXY;
		if (origAllProxy !== undefined) process.env.ALL_PROXY = origAllProxy;
		else delete process.env.ALL_PROXY;

		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {}
	});

	it("从 settings.json 正确解析 httpProxy", () => {
		const settingsPath = join(dir, "settings.json");
		writeFileSync(settingsPath, JSON.stringify({ httpProxy: "http://127.0.0.1:7890" }));

		const config = resolveProxySettings(dir);
		expect(config.httpProxy).toBe("http://127.0.0.1:7890");
	});

	it("initHttpProxy 将 settings.json 的 httpProxy 注入 process.env", () => {
		const settingsPath = join(dir, "settings.json");
		writeFileSync(settingsPath, JSON.stringify({ httpProxy: "http://127.0.0.1:7890" }));

		const res = initHttpProxy(dir);
		expect(res.active).toBe(true);
		expect(res.proxyUrl).toBe("http://127.0.0.1:7890");
		expect(process.env.HTTP_PROXY).toBe("http://127.0.0.1:7890");
		expect(process.env.HTTPS_PROXY).toBe("http://127.0.0.1:7890");
	});

	it("当无代理配置时返回 active: false，不影响正常启动", () => {
		const res = initHttpProxy(dir);
		expect(res.active).toBe(false);
	});
});
