import { afterEach, describe, expect, it, vi } from "vitest";
import { UserApiEngine } from "../../plugins/lx-music/server/user-api-vm.mjs";

type UserApiEngineLike = {
	importScript(id: string, script: string): { ok: boolean; error?: string; meta?: Record<string, string> };
	resolveUrl(source: string, raw: unknown, quality?: string): Promise<{ url: string; quality: string } | null>;
};

function makeEngine(): UserApiEngineLike {
	return new UserApiEngine({ log: () => {} }) as unknown as UserApiEngineLike;
}

/**
 * 逃逸探针脚本：执行 `expr`，把结果写进音源 meta.name 回传给宿主断言。
 * 逃逸成立的判定标准是「拿到宿主 process 且 mainModule/require 可用」——
 * 沙箱自带的 process 只有 { env: {} }（见 importScript 的 context 组装）。
 */
function probeScript(expr: string): string {
	return `
lx.on("request", () => {});
let probe;
try {
	probe = String(${expr});
} catch (err) {
	probe = "threw:" + String((err && err.message) || err);
}
lx.send("inited", { name: probe });
`;
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("lx-music User API 脚本沙箱（宿主 realm 隔离）", () => {
	it("宿主内建不再直注：Buffer/fetch/URL/TextEncoder 在沙箱内不可见", () => {
		const engine = makeEngine();
		for (const name of ["Buffer", "fetch", "URL", "URLSearchParams", "TextEncoder", "TextDecoder"]) {
			const res = engine.importScript(`probe-${name}`, probeScript(`typeof ${name}`));
			expect(res.ok, name).toBe(true);
			expect(res.meta?.name, name).toBe("undefined");
		}
	});

	it("沙箱自带内建仍可用：Math/JSON/encodeURIComponent/md5 正常", () => {
		const engine = makeEngine();
		const res = engine.importScript(
			"builtin",
			probeScript(`JSON.stringify({ a: Math.round(1.6), b: encodeURIComponent("a b"), c: typeof Date })`),
		);
		expect(res.ok).toBe(true);
		expect(JSON.parse(res.meta?.name ?? "{}")).toEqual({ a: 2, b: "a%20b", c: "function" });
	});

	it.each([
		["裸对象原型链", "({}).constructor.constructor('return process')().mainModule"],
		[
			"宿主 Buffer 返回值",
			"lx.utils.buffer.from('aGk=', 'base64').constructor.constructor('return process')().mainModule",
		],
		["暴露的宿主函数", "lx.utils.crypto.md5.constructor.constructor('return process')().mainModule"],
		["定时器包装函数", "setTimeout.constructor.constructor('return process')().mainModule"],
		["console 包装函数", "console.log.constructor.constructor('return process')().mainModule"],
		["lx.request 包装函数", "lx.request.constructor.constructor('return process')().mainModule"],
	])("%s 无法触达宿主 process", (_label, expr) => {
		const engine = makeEngine();
		const res = engine.importScript(`escape-${expr.length}`, probeScript(expr));
		expect(res.ok).toBe(true);
		expect(res.meta?.name).toBe("undefined");
	});

	it("沙箱 process 只暴露空 env", () => {
		const engine = makeEngine();
		const res = engine.importScript(
			"process-shape",
			probeScript(
				`JSON.stringify({ env: typeof process.env, main: typeof process.mainModule, req: typeof process.require })`,
			),
		);
		expect(res.ok).toBe(true);
		expect(JSON.parse(res.meta?.name ?? "{}")).toEqual({ env: "object", main: "undefined", req: "undefined" });
	});

	it("lx.request 回调参数被重建为沙箱对象，raw/err 无宿主 realm 可逃逸", async () => {
		const engine = makeEngine();
		const body = JSON.stringify({ data: { url: "https://example.test/audio.mp3" } });
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({
				ok: true,
				status: 200,
				statusText: "OK",
				headers: { entries: () => [["content-type", "application/json"]] },
				arrayBuffer: async () => new TextEncoder().encode(body).buffer,
			})),
		);
		const script = `
lx.request("https://upstream.test/api", { method: "GET" }, (err, resp, body) => {
	let probe;
	try {
		const viaRaw = resp ? String(resp.raw.constructor.constructor("return process")().mainModule) : "no-resp";
		const viaErr = err ? String(err.constructor.constructor("return process")().mainModule) : "no-err";
		probe = JSON.stringify({ viaRaw, viaErr, body: body && body.data ? body.data.url : null });
	} catch (e) {
		probe = "threw:" + String((e && e.message) || e);
	}
	lx.send("inited", { name: probe });
});
`;
		const res = engine.importScript("request-callback", script);
		expect(res.ok).toBe(true);
		// callback 异步回调里才 send，等 meta.name 被探针 JSON 覆盖（默认名是真值会提前放行）。
		await vi.waitFor(() => {
			expect(res.meta?.name?.trim().startsWith("{")).toBe(true);
		});
		const payload = JSON.parse(res.meta?.name ?? "{}") as Record<string, string>;
		expect(payload.viaRaw).toBe("undefined");
		// 成功路径 err 为 null，探针输出 no-err；失败路径的 err 通道在下面单独验证。
		expect(payload.viaErr).toBe("no-err");
		expect(payload.body).toBe("https://example.test/audio.mp3");
	});

	it("lx.request 失败路径的 err 同样是沙箱纯数据对象", async () => {
		const engine = makeEngine();
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new TypeError("fetch failed");
			}),
		);
		const script = `
lx.request("https://upstream.test/api", { method: "GET" }, (err) => {
	let probe;
	try {
		probe = JSON.stringify({
			escape: err ? String(err.constructor.constructor("return process")().mainModule) : "no-err",
			message: err ? err.message : null,
		});
	} catch (e) {
		probe = "threw:" + String((e && e.message) || e);
	}
	lx.send("inited", { name: probe });
});
`;
		const res = engine.importScript("request-error", script);
		expect(res.ok).toBe(true);
		await vi.waitFor(() => {
			expect(res.meta?.name?.trim().startsWith("{")).toBe(true);
		});
		const payload = JSON.parse(res.meta?.name ?? "{}") as { escape: string; message: string };
		expect(payload.escape).toBe("undefined");
		expect(payload.message).toBe("fetch failed");
	});

	it("crypto/buffer/zlib 功能不回归（md5 / base64 / inflate）", async () => {
		const engine = makeEngine();
		const script = `
lx.on("request", () => {});
const md5 = lx.utils.crypto.md5("abc");
const b64 = lx.utils.buffer.bufToString(lx.utils.buffer.from("aGk=", "base64"), "binary");
lx.utils.zlib.inflate(lx.utils.buffer.from("", "binary")).catch(() => {});
lx.send("inited", { name: JSON.stringify({ md5, b64 }) });
`;
		const res = engine.importScript("crypto-roundtrip", script);
		expect(res.ok).toBe(true);
		const payload = JSON.parse(res.meta?.name ?? "{}") as { md5: string; b64: string };
		expect(payload.md5).toBe("900150983cd24fb0d6963f7d28e17f72");
		expect(payload.b64).toBe("hi");
	});

	it("宿主调用 request handler 时参数已被重建，脚本内无法沿参数逃逸", async () => {
		const engine = makeEngine();
		const script = `
let probe = "never-called";
lx.on("request", (req) => {
	try {
		probe = String(req.info.musicInfo.constructor.constructor("return process")().mainModule);
	} catch (err) {
		probe = "threw:" + String((err && err.message) || err);
	}
	lx.send("inited", { name: probe });
});
`;
		const res = engine.importScript("handler-args", script);
		expect(res.ok).toBe(true);
		const out = await engine.resolveUrl("wy", { id: "186016", name: "晴天" }, "128k");
		// 无 fetch mock，handler 里的 lx.request 不会返回有效 URL，但探针值已经落进 meta。
		expect(out).toBeNull();
		expect(res.meta?.name).toBe("undefined");
	});
});
