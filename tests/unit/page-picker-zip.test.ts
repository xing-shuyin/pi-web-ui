import { describe, expect, it } from "vitest";
import { buildZip, crc32, readZip } from "../../plugins/page-picker/extension/zip.mjs";

/** 分发用的 zip 打包器。
 *
 *  为什么值得单测：这个字节流最终会交到用户手里（下载 → 解压 → 加载扩展），
 *  而「写坏的 zip」在不同解压器上表现不一（有的直接拒绝、有的解出空目录）。
 *  Node 没有内置 zip，所以这里既有 CRC32 的标准测试向量，也有**独立于实现**的
 *  结构解析（按规范从本地文件头把数据抠出来），而不是只信自己写的 `readZip`。 */

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

describe("crc32", () => {
	it("标准测试向量（错一位整个包就废）", () => {
		expect(crc32(bytes(""))).toBe(0);
		expect(crc32(bytes("a"))).toBe(0xe8b7be43);
		expect(crc32(bytes("123456789"))).toBe(0xcbf43926);
		expect(crc32(bytes("The quick brown fox jumps over the lazy dog"))).toBe(0x414fa339);
	});

	it("是 32 位无符号（不会返回负数）", () => {
		expect(crc32(new Uint8Array([0xff, 0xff, 0xff, 0xff]))).toBeGreaterThan(0);
	});
});

describe("buildZip / readZip", () => {
	it("往返一致：条目名、长度、CRC 都对得上", () => {
		const entries = [
			{ name: "manifest.json", data: bytes('{"name":"x"}') },
			{ name: "dist/background.js", data: bytes("console.log(1)") },
		];
		const info = readZip(buildZip(entries));
		expect(info.entries.map((e) => e.name)).toEqual(["manifest.json", "dist/background.js"]);
		expect(info.entries[0].size).toBe(entries[0].data.length);
		expect(info.entries[0].crc).toBe(crc32(entries[0].data));
	});

	it("**独立解析本地文件头**也能抠出原始数据（不是只信自己的 readZip）", () => {
		const payload = bytes("// 内容");
		const zip = buildZip([{ name: "a/b.js", data: payload }]);
		const view = new DataView(zip.buffer);
		expect(view.getUint32(0, true)).toBe(0x04034b50); // 本地头签名
		expect(view.getUint16(8, true)).toBe(0); // store：未压缩
		const nameLen = view.getUint16(26, true);
		const size = view.getUint32(18, true);
		expect(view.getUint32(14, true)).toBe(crc32(payload)); // 头部里的 CRC 就是负载的 CRC
		expect(new TextDecoder().decode(zip.subarray(30, 30 + nameLen))).toBe("a/b.js");
		expect(zip.subarray(30 + nameLen, 30 + nameLen + size)).toEqual(payload);
	});

	it("置了 UTF-8 文件名标志位（非 ASCII 条目名才不会被解压器当乱码）", () => {
		const zip = buildZip([{ name: "说明.md", data: bytes("x") }]);
		expect(new DataView(zip.buffer).getUint16(6, true) & 0x0800).toBe(0x0800);
		expect(readZip(zip).entries[0].name).toBe("说明.md");
	});

	it("空列表 → 合法但无条目的 zip", () => {
		expect(readZip(buildZip([])).entries).toEqual([]);
	});

	it("确定性：同样的输入 → 完全一致的字节（时间戳固定）", () => {
		const mk = () => buildZip([{ name: "a", data: bytes("hello") }]);
		expect(mk()).toEqual(mk());
	});

	it("拒绝绝对路径与 ..（防解压时写出目录外）", () => {
		expect(() => buildZip([{ name: "/etc/passwd", data: bytes("x") }])).toThrow(/非法/);
		expect(() => buildZip([{ name: "../../evil", data: bytes("x") }])).toThrow(/非法/);
	});

	it("readZip 对垃圾字节明确报错（而不是假装成功）", () => {
		expect(() => readZip(bytes("this is not a zip"))).toThrow(/合法 zip/);
	});

	it("大二进制负载（截图级别的体积）也能往返", () => {
		const big = new Uint8Array(300 * 1024);
		for (let i = 0; i < big.length; i++) big[i] = i % 251;
		const zip = buildZip([{ name: "picker.js", data: big }]);
		const info = readZip(zip);
		expect(info.entries[0].size).toBe(big.length);
		expect(info.entries[0].crc).toBe(crc32(big));
	});
});
