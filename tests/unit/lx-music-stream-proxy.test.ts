import { describe, expect, it, afterEach } from "vitest";
import http from "node:http";
import {
	parseRangeHeader,
	createRangeSliceStream,
	proxyAudioStream,
} from "../../plugins/lx-music/server/stream-proxy.mjs";

describe("LX Music stream proxy", () => {
	const serversToClose: http.Server[] = [];

	afterEach(async () => {
		for (const s of serversToClose) {
			await new Promise<void>((resolve) => s.close(() => resolve()));
		}
		serversToClose.length = 0;
	});

	it("parses Range headers correctly", () => {
		expect(parseRangeHeader("bytes=0-1023", 2048)).toEqual({ start: 0, end: 1023 });
		expect(parseRangeHeader("bytes=1000-", 2048)).toEqual({ start: 1000, end: 2047 });
		expect(parseRangeHeader("bytes=-500", 2000)).toEqual({ start: 1500, end: 1999 });
		expect(parseRangeHeader("bytes=3000-", 2000)).toEqual({ unsatisfied: true, totalLength: 2000 });
		expect(parseRangeHeader("invalid", 2000)).toBeNull();
		expect(parseRangeHeader("", 2000)).toBeNull();
	});

	it("slices stream when upstream does not support range (returns 200)", async () => {
		const slice = createRangeSliceStream(5, 9);
		const chunks: Buffer[] = [];
		slice.on("data", (c) => chunks.push(c));

		await new Promise<void>((resolve) => {
			slice.on("end", resolve);
			slice.write(Buffer.from("0123456789abcdef"));
			slice.end();
		});

		const result = Buffer.concat(chunks).toString("utf8");
		expect(result).toBe("56789");
	});

	it("proxies normal audio stream without range", async () => {
		const data = "mock-audio-12";
		const upstream = http.createServer((req, res) => {
			res.writeHead(200, {
				"Content-Type": "audio/mpeg",
				"Content-Length": String(Buffer.byteLength(data)),
			});
			res.end(data);
		});
		await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
		serversToClose.push(upstream);
		const upstreamPort = (upstream.address() as any).port;

		const proxy = http.createServer((req, res) => {
			proxyAudioStream(req, res, `http://127.0.0.1:${upstreamPort}/audio.mp3`);
		});
		await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
		serversToClose.push(proxy);
		const proxyPort = (proxy.address() as any).port;

		const res = await fetch(`http://127.0.0.1:${proxyPort}/stream`);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("audio/mpeg");
		expect(res.headers.get("accept-ranges")).toBe("bytes");
		expect(await res.text()).toBe("mock-audio-12");
	});

	it("clears socket timeout once response headers arrive so long streams are not prematurely killed", async () => {
		const part1 = "first-chunk-";
		const part2 = "second-chunk";
		const total = part1 + part2;
		const upstream = http.createServer((req, res) => {
			res.writeHead(200, {
				"Content-Type": "audio/mpeg",
				"Content-Length": String(Buffer.byteLength(total)),
			});
			res.write(part1);
			// 故意不立刻发送第二个 chunk，模拟客户端暂停读取与流控
			setTimeout(() => {
				res.end(part2);
			}, 100);
		});
		await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
		serversToClose.push(upstream);
		const upstreamPort = (upstream.address() as any).port;

		const proxy = http.createServer((req, res) => {
			proxyAudioStream(req, res, `http://127.0.0.1:${upstreamPort}/audio.mp3`);
		});
		await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
		serversToClose.push(proxy);
		const proxyPort = (proxy.address() as any).port;

		const res = await fetch(`http://127.0.0.1:${proxyPort}/stream`);
		expect(res.status).toBe(200);
		const text = await res.text();
		expect(text).toBe("first-chunk-second-chunk");
	});

	it("slices range request when upstream returns 200 without range support", async () => {
		const upstream = http.createServer((req, res) => {
			// 即使客户端发了 Range，上游依然返回 200
			res.writeHead(200, {
				"Content-Type": "audio/mpeg",
				"Content-Length": "10",
			});
			res.end("0123456789");
		});
		await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
		serversToClose.push(upstream);
		const upstreamPort = (upstream.address() as any).port;

		const proxy = http.createServer((req, res) => {
			proxyAudioStream(req, res, `http://127.0.0.1:${upstreamPort}/audio.mp3`);
		});
		await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
		serversToClose.push(proxy);
		const proxyPort = (proxy.address() as any).port;

		const res = await fetch(`http://127.0.0.1:${proxyPort}/stream`, {
			headers: { Range: "bytes=3-7" },
		});
		expect(res.status).toBe(206);
		expect(res.headers.get("content-range")).toBe("bytes 3-7/10");
		expect(res.headers.get("content-length")).toBe("5");
		expect(await res.text()).toBe("34567");
	});

	it("follows 302 redirect smoothly", async () => {
		const upstreamFinal = http.createServer((req, res) => {
			res.writeHead(200, { "Content-Type": "audio/mpeg" });
			res.end("final-audio-data");
		});
		await new Promise<void>((r) => upstreamFinal.listen(0, "127.0.0.1", r));
		serversToClose.push(upstreamFinal);
		const finalPort = (upstreamFinal.address() as any).port;

		const upstreamInitial = http.createServer((req, res) => {
			res.writeHead(302, { Location: `http://127.0.0.1:${finalPort}/real.mp3` });
			res.end();
		});
		await new Promise<void>((r) => upstreamInitial.listen(0, "127.0.0.1", r));
		serversToClose.push(upstreamInitial);
		const initialPort = (upstreamInitial.address() as any).port;

		const proxy = http.createServer((req, res) => {
			proxyAudioStream(req, res, `http://127.0.0.1:${initialPort}/init.mp3`);
		});
		await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
		serversToClose.push(proxy);
		const proxyPort = (proxy.address() as any).port;

		const res = await fetch(`http://127.0.0.1:${proxyPort}/stream`);
		expect(res.status).toBe(200);
		expect(await res.text()).toBe("final-audio-data");
	});

	it("returns 504 gateway timeout if upstream connection stalls before headers", async () => {
		const upstreamStall = http.createServer((req, res) => {
			// 模拟上游死锁或极慢卡死，不返回任何头
		});
		await new Promise<void>((r) => upstreamStall.listen(0, "127.0.0.1", r));
		serversToClose.push(upstreamStall);
		const stallPort = (upstreamStall.address() as any).port;

		const proxy = http.createServer((req, res) => {
			// 设置较短的连接超时 80ms
			proxyAudioStream(req, res, `http://127.0.0.1:${stallPort}/stall.mp3`, "", "", 0, 80);
		});
		await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
		serversToClose.push(proxy);
		const proxyPort = (proxy.address() as any).port;

		const res = await fetch(`http://127.0.0.1:${proxyPort}/stream`);
		expect(res.status).toBe(504);
		expect(await res.text()).toContain("Audio stream gateway timeout");
	});
});
