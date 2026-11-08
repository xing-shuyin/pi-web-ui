import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { crxPayloadOffset, crxZipPayload, extractCrxInto, readCrxManifest } from "../../browser/runtime/crx.js";

interface StoredEntry {
	name: string;
	data?: string;
	mode?: number;
}

/** 手搓「stored（不压缩）」zip —— 只为测 crx 解包，不引额外依赖。 */
function zipStored(entries: StoredEntry[]): Buffer {
	const locals: Buffer[] = [];
	const centrals: Buffer[] = [];
	let offset = 0;
	for (const entry of entries) {
		const name = Buffer.from(entry.name, "utf8");
		const data = Buffer.from(entry.data ?? "", "utf8");
		const extAttrs = entry.mode ? (entry.mode << 16) >>> 0 : 0;
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt16LE(0x0800, 6);
		local.writeUInt16LE(0, 8);
		local.writeUInt32LE(0, 14);
		local.writeUInt32LE(data.length, 18);
		local.writeUInt32LE(data.length, 22);
		local.writeUInt16LE(name.length, 26);
		local.writeUInt16LE(0, 28);
		locals.push(local, name, data);

		const central = Buffer.alloc(46);
		central.writeUInt32LE(0x02014b50, 0);
		central.writeUInt16LE(20, 4);
		central.writeUInt16LE(20, 6);
		central.writeUInt16LE(0x0800, 8);
		central.writeUInt16LE(0, 10);
		central.writeUInt32LE(0, 16);
		central.writeUInt32LE(data.length, 20);
		central.writeUInt32LE(data.length, 24);
		central.writeUInt16LE(name.length, 28);
		central.writeUInt32LE(extAttrs, 38);
		central.writeUInt32LE(offset, 42);
		centrals.push(central, name);

		offset += local.length + name.length + data.length;
	}
	const cd = Buffer.concat(centrals);
	const eocd = Buffer.alloc(22);
	eocd.writeUInt32LE(0x06054b50, 0);
	eocd.writeUInt16LE(entries.length, 8);
	eocd.writeUInt16LE(entries.length, 10);
	eocd.writeUInt32LE(cd.length, 12);
	eocd.writeUInt32LE(offset, 16);
	return Buffer.concat([...locals, cd, eocd]);
}

function makeCrx3(zip: Buffer, headerSize = 8): Buffer {
	const magic = Buffer.from("Cr24", "latin1");
	const head = Buffer.alloc(12);
	magic.copy(head, 0);
	head.writeUInt32LE(3, 4);
	head.writeUInt32LE(headerSize, 8);
	return Buffer.concat([head, Buffer.alloc(headerSize, 0xab), zip]);
}

describe("browser/runtime/crx.ts CRX 解码与解包", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pi-crx-test-"));
	});

	afterEach(() => {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {}
	});

	const manifest = JSON.stringify({ manifest_version: 3, name: "Test ext", version: "1.2.3" }, null, 2);

	it("剥掉 Cr24 头部（版本 3）并定位 zip 起点", () => {
		const buf = makeCrx3(zipStored([{ name: "manifest.json", data: manifest }]), 12);
		expect(crxPayloadOffset(buf)).toBe(24);
		expect(crxZipPayload(buf).toString("latin1", 0, 4)).toBe("PK\u0003\u0004");
	});

	it("版本 2 头部按公钥/签名长度跳过", () => {
		const zip = zipStored([{ name: "manifest.json", data: manifest }]);
		const head = Buffer.alloc(16);
		head.write("Cr24", 0, "latin1");
		head.writeUInt32LE(2, 4);
		head.writeUInt32LE(294, 8);
		head.writeUInt32LE(128, 12);
		const buf = Buffer.concat([head, Buffer.alloc(294 + 128), zip]);
		expect(crxPayloadOffset(buf)).toBe(16 + 294 + 128);
		expect(crxZipPayload(buf).equals(zip)).toBe(true);
	});

	it("拒绝非 crx、未知版本与不是 zip 的内容", () => {
		expect(() => crxPayloadOffset(Buffer.from("PK\u0003\u0004not-a-crx", "latin1"))).toThrow(/Cr24/);
		const bad = makeCrx3(Buffer.from("nope", "utf8"));
		expect(() => crxZipPayload(bad)).toThrow(/zip/);
		const head = Buffer.alloc(12);
		head.write("Cr24", 0, "latin1");
		head.writeUInt32LE(9, 4);
		expect(() => crxPayloadOffset(head)).toThrow(/版本/);
	});

	it("解包出文件，并能读到 manifest", async () => {
		const zip = zipStored([
			{ name: "manifest.json", data: manifest },
			{ name: "background.js", data: "console.log('hi')" },
			{ name: "icons/", mode: 0o040000 },
			{ name: "icons/16.png", data: "PNG" },
		]);
		const crx = makeCrx3(zip);
		const dest = join(dir, "ext");
		await extractCrxInto(crx, dest);

		expect(readFileSync(join(dest, "background.js"), "utf8")).toBe("console.log('hi')");
		expect(existsSync(join(dest, "icons", "16.png"))).toBe(true);
		await expect(readCrxManifest(dest)).resolves.toMatchObject({ name: "Test ext", version: "1.2.3" });
	});

	it("挡住越界路径与符号链接（解包即失败，不留半成品）", async () => {
		for (const zip of [
			zipStored([{ name: "../escape.txt", data: "x" }]),
			zipStored([{ name: "C:/windows/evil.txt", data: "x" }]),
			zipStored([{ name: "/abs.txt", data: "x" }]),
			zipStored([{ name: "link", data: "/target", mode: 0o120000 }]),
			zipStored([
				{ name: "manifest.json", data: manifest },
				{ name: "MANIFEST.json", data: manifest },
			]),
		]) {
			const dest = join(dir, `bad-${Math.random().toString(16).slice(2)}`);
			// yauzl 自己会拦一部分（如 ../escape.txt），拦不到的由我们的路径/类型检查揃下
			await expect(extractCrxInto(makeCrx3(zip), dest)).rejects.toThrow();
			expect(existsSync(dest)).toBe(false);
		}
	});

	it("缺 manifest.json / 非法 JSON 时给出可读报错", async () => {
		const dest = join(dir, "no-manifest");
		await extractCrxInto(makeCrx3(zipStored([{ name: "readme.txt", data: "x" }])), dest);
		await expect(readCrxManifest(dest)).rejects.toThrow(/manifest\.json/);

		const broken = join(dir, "broken-manifest");
		await extractCrxInto(makeCrx3(zipStored([{ name: "manifest.json", data: "{oops" }])), broken);
		await expect(readCrxManifest(broken)).rejects.toThrow(/JSON/);
	});
});
