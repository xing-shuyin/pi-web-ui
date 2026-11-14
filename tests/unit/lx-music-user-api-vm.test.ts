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
 * 判定标准 = 能否拿到宿主 process：宿主 process 有 version，沙箱 process 只有 { env: {} }。
 *
 * 注意不要用 `.mainModule` 当判定：Node ≥20 的 ESM 宿主里 `process.mainModule` 本身就是
 * undefined，用它判定会把「宿主 Function 已到手」的真逃逸判成安全，断言等于没写。
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

/** 逃逸表达式：拿到宿主 Function 构造器时才会返回宿主版本号，否则是 undefined。 */
const escape = (target: string) => `${target}.constructor.constructor("return process")().version`;

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
		["裸对象原型链", "({})"],
		["沙箱 process 自身", "process"],
		["宿主 Buffer 返回值", "lx.utils.buffer.from('aGk=', 'base64')"],
		[
			"宿主 Buffer 的 bufToString 返回值",
			"lx.utils.buffer.bufToString(lx.utils.buffer.from('aGk=', 'base64'), 'binary')",
		],
		["暴露的宿主函数", "lx.utils.crypto.md5"],
		["zlib 包装函数", "lx.utils.zlib.inflate"],
		["定时器包装函数", "setTimeout"],
		["console 包装函数", "console.log"],
		["lx.request 包装函数", "lx.request"],
		["lx.send 包装函数", "lx.send"],
		["lx.on 包装函数", "lx.on"],
	])("%s 无法触达宿主 process", (_label, target) => {
		const engine = makeEngine();
		const res = engine.importScript(`escape-${_label}`, probeScript(escape(target)));
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

	it("宿主函数抛错时重建为沙箱 Error：err 不再携带宿主 realm，语义不丢", () => {
		const engine = makeEngine();
		const cases: Array<[string, string]> = [
			["buffer.from 无参", "lx.utils.buffer.from()"],
			["md5(null)", "lx.utils.crypto.md5(null)"],
			["aesEncrypt 长度非法", `lx.utils.crypto.aesEncrypt("x", "aes-128-cbc", "k", "iv")`],
			["bufToString 非法 encoding", `lx.utils.buffer.bufToString(lx.utils.buffer.from("hi"), "not-a-format")`],
		];
		for (const [label, call] of cases) {
			const script = `
lx.on("request", () => {});
let probe;
try {
	${call};
	probe = JSON.stringify({ escaped: false, thrown: false });
} catch (err) {
	probe = JSON.stringify({
		thrown: true,
		escaped: String(err.constructor.constructor("return process")().version),
		isError: err instanceof Error,
		name: String(err.name),
		messageIsString: typeof err.message === "string" && err.message.length > 0,
	});
}
lx.send("inited", { name: probe });
`;
			const res = engine.importScript(`throw-${label}`, script);
			expect(res.ok, label).toBe(true);
			const payload = JSON.parse(res.meta?.name ?? "{}") as Record<string, unknown>;
			expect(payload.thrown, label).toBe(true);
			expect(payload.escaped, label).toBe("undefined");
			expect(payload.isError, label).toBe(true);
			expect(payload.messageIsString, label).toBe(true);
		}
	});

	it("宿主 Promise 拒绝同样重建为沙箱 Error", async () => {
		const engine = makeEngine();
		const script = `
lx.on("request", () => {});
lx.utils.zlib.inflate(lx.utils.buffer.from("zzzz", "base64")).then(
	() => lx.send("inited", { name: JSON.stringify({ rejected: false }) }),
	(err) => lx.send("inited", {
		name: JSON.stringify({
			rejected: true,
			escaped: String(err.constructor.constructor("return process")().version),
			isError: err instanceof Error,
			messageIsString: typeof err.message === "string" && err.message.length > 0,
		}),
	}),
);
`;
		const res = engine.importScript("reject-path", script);
		expect(res.ok).toBe(true);
		await vi.waitFor(() => {
			expect(res.meta?.name?.trim().startsWith("{")).toBe(true);
		});
		const payload = JSON.parse(res.meta?.name ?? "{}") as Record<string, unknown>;
		expect(payload.rejected).toBe(true);
		expect(payload.escaped).toBe("undefined");
		expect(payload.isError).toBe(true);
		expect(payload.messageIsString).toBe(true);
	});

	it("脚本改写沙箱内建/桥接函数也无法让跨界数据退化透传", async () => {
		const engine = makeEngine();
		// __revive 曾是脚本可改的全局：改成恒等后在 host 调用 handler 时就能拿到宿主入参。
		// 现在桥接函数与内建都在 bootstrap 闭包里，改 globalThis 上的同名属性无效。
		const script = `
globalThis.__revive = (v) => v;
globalThis.__wrapIn = (fn) => fn;
globalThis.Uint8Array = function (v) { return v; };
globalThis.Object.keys = () => [];
globalThis.WeakSet = function () { return { has: () => false, add: () => {} }; };
let viaBuffer;
try {
	viaBuffer = String(lx.utils.buffer.from("aGk=", "base64").constructor.constructor("return process")().version);
} catch (err) {
	viaBuffer = "threw:" + ((err && err.message) || err);
}
let viaHandler = "handler-not-called";
lx.on("request", (req) => {
	try {
		viaHandler = String(req.info.musicInfo.constructor.constructor("return process")().version);
	} catch (err) {
		viaHandler = "threw:" + ((err && err.message) || err);
	}
	lx.send("inited", { name: JSON.stringify({ viaBuffer, viaHandler }) });
});
`;
		const res = engine.importScript("tamper-builtins", script);
		expect(res.ok).toBe(true);
		await engine.resolveUrl("wy", { id: "186016", name: "晴天" }, "128k");
		const payload = JSON.parse(res.meta?.name ?? "{}") as Record<string, string>;
		expect(payload.viaBuffer).toBe("undefined");
		expect(payload.viaHandler).toBe("undefined");
	});

	it("lx.request 回调参数被重建为沙箱对象，raw/body(含数组)/err 无宿主 realm 可逃逸", async () => {
		const engine = makeEngine();
		const body = JSON.stringify({
			data: { url: "https://example.test/audio.mp3", list: [{ url: "https://example.test/b.mp3" }] },
		});
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
		const viaRaw = resp ? String(resp.raw.constructor.constructor("return process")().version) : "no-resp";
		const viaErr = err ? String(err.constructor.constructor("return process")().version) : "no-err";
		// JSON 数组曾是漏点：宿主 Array.prototype.map 让 __revive 吐回宿主数组。
		const list = body && body.data ? body.data.list : null;
		const viaArray = list ? String(list.constructor.constructor("return process")().version) : "no-list";
		const viaItem = list ? String(list[0].constructor.constructor("return process")().version) : "no-list";
		probe = JSON.stringify({
			viaRaw,
			viaErr,
			viaArray,
			viaItem,
			isSandboxArray: Array.isArray(list),
			body: body && body.data ? body.data.url : null,
		});
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
		const payload = JSON.parse(res.meta?.name ?? "{}") as Record<string, unknown>;
		expect(payload.viaRaw).toBe("undefined");
		// 成功路径 err 为 null，探针输出 no-err；失败路径的 err 通道在下面单独验证。
		expect(payload.viaErr).toBe("no-err");
		expect(payload.viaArray).toBe("undefined");
		expect(payload.viaItem).toBe("undefined");
		expect(payload.isSandboxArray).toBe(true);
		expect(payload.body).toBe("https://example.test/audio.mp3");
	});

	it("lx.request 失败路径的 err 是沙箱 Error", async () => {
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
			escape: err ? String(err.constructor.constructor("return process")().version) : "no-err",
			message: err ? err.message : null,
			isError: err instanceof Error,
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
		const payload = JSON.parse(res.meta?.name ?? "{}") as { escape: string; message: string; isError: boolean };
		expect(payload.escape).toBe("undefined");
		expect(payload.message).toBe("fetch failed");
		expect(payload.isError).toBe(true);
	});

	it("crypto/buffer/zlib 功能不回归（md5 / base64 / inflate）", async () => {
		const engine = makeEngine();
		const script = `
lx.on("request", () => {});
const md5 = lx.utils.crypto.md5("abc");
const b64 = lx.utils.buffer.bufToString(lx.utils.buffer.from("aGk=", "base64"), "binary");
const raw = lx.utils.buffer.from("aGk=", "base64");
lx.utils.zlib.inflate(raw).catch(() => {});
lx.send("inited", { name: JSON.stringify({ md5, b64, rawLength: raw.length, rawIsU8: raw instanceof Uint8Array }) });
`;
		const res = engine.importScript("crypto-roundtrip", script);
		expect(res.ok).toBe(true);
		const payload = JSON.parse(res.meta?.name ?? "{}") as {
			md5: string;
			b64: string;
			rawLength: number;
			rawIsU8: boolean;
		};
		expect(payload.md5).toBe("900150983cd24fb0d6963f7d28e17f72");
		expect(payload.b64).toBe("hi");
		expect(payload.rawLength).toBe(2);
		expect(payload.rawIsU8).toBe(true);
	});

	it("宿主调用 request handler 时参数已被重建，脚本内无法沿参数逃逸", async () => {
		const engine = makeEngine();
		const script = `
let probe = "never-called";
lx.on("request", (req) => {
	try {
		probe = String(req.info.musicInfo.constructor.constructor("return process")().version);
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
