import { describe, expect, it } from "vitest";
import { parseLsofListening, parseNetstatListening } from "../../server/process-utils.js";

describe("parseNetstatListening", () => {
	it("解析 IPv4 / IPv6 监听行（netstat -ano -p tcp）", () => {
		const out = [
			"活动连接",
			"",
			"  协议  本地地址          外部地址        状态           PID",
			"  TCP    0.0.0.0:5173     0.0.0.0:0       LISTENING       12345",
			"  TCP    127.0.0.1:8787   0.0.0.0:0       LISTENING       6789",
			"  TCP    [::1]:9000       [::]:0          LISTENING       4321",
			"  TCP    127.0.0.1:54321  127.0.0.1:5173  ESTABLISHED     12345",
			"  UDP    0.0.0.0:5353     *:*                             9999",
		].join("\r\n");
		const ports = parseNetstatListening(out);
		expect([...ports.entries()].sort((a, b) => a[0] - b[0])).toEqual([
			[5173, 12345],
			[8787, 6789],
			[9000, 4321],
		]);
	});

	it("空输出 / 表头 / 脏行不抛错", () => {
		expect(parseNetstatListening("").size).toBe(0);
		expect(parseNetstatListening("协议 本地地址 外部地址 状态 PID").size).toBe(0);
		expect(parseNetstatListening("TCP ??? LISTENING nan").size).toBe(0);
	});
});

describe("parseLsofListening", () => {
	const header = "COMMAND   PID  USER   FD   TYPE  DEVICE SIZE/OFF NODE NAME";

	it("`(LISTEN)` 自成最后一列时也能取到 NAME 里的端口（旧实现取最后一列 → 整段失效）", () => {
		const out = [
			header,
			"node    12345  user   23u  IPv4  123456      0t0  TCP  *:5173 (LISTEN)",
			"node     6789  user   24u  IPv6  234567      0t0  TCP  [::1]:9000 (LISTEN)",
		].join("\n");
		expect([...parseLsofListening(out).entries()].sort((a, b) => a[0] - b[0])).toEqual([
			[5173, 12345],
			[9000, 6789],
		]);
	});

	it("`(LISTEN)` 贴在 NAME 列里同样能解析（BSD/macOS 风格）", () => {
		const out = [
			header,
			"node    12345  user   23u  IPv4  123456      0t0  TCP  127.0.0.1:8787",
			"python   3210  user    5u  IPv6  987654      0t0  TCP  *:8080",
		].join("\n");
		expect([...parseLsofListening(out).entries()].sort((a, b) => a[0] - b[0])).toEqual([
			[8080, 3210],
			[8787, 12345],
		]);
	});

	it("空输出 / 只有表头 / 端口越界不抛错", () => {
		expect(parseLsofListening("").size).toBe(0);
		expect(parseLsofListening(header).size).toBe(0);
		expect(parseLsofListening(`${header}\nnode 1 u 3u IPv4 1 0t0 TCP *:99999`).size).toBe(0);
	});
});
