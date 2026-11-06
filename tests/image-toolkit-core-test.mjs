import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { deflateSync } from "node:zlib";
import {
	decodeImage,
	encodeImage,
	hasJpegCodec,
	mimeForFormat,
	setJpegCodec,
	sniffFormat,
} from "../plugins/image-toolkit/core/codec.mjs";
import {
	addBorder,
	adjustImage,
	compositeOverlay,
	cropImage,
	dominantColors,
	extractRegionPalette,
	flipImage,
	histogram,
	pickColor,
	pickColorsBatch,
	resizeImage,
	rotateArbitrary,
	rotateImage,
	roundCorners,
} from "../plugins/image-toolkit/core/ops.mjs";
import { parseExif, probeImage } from "../plugins/image-toolkit/core/probe.mjs";

let passed = 0;
function ok(name) {
	passed++;
	console.log(`✓ ${name}`);
}
function fail(name, err) {
	console.error(`✗ ${name}\n    ${err?.message ?? err}`);
	process.exitCode = 1;
}
function check(name, fn) {
	try {
		fn();
		ok(name);
	} catch (err) {
		fail(name, err);
	}
}
async function checkAsync(name, fn) {
	try {
		await fn();
		ok(name);
	} catch (err) {
		fail(name, err);
	}
}

const CRC_TABLE = (() => {
	const t = new Int32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		t[n] = c;
	}
	return t;
})();

function crc32(buf) {
	let c = 0xffffffff;
	for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
	const head = Buffer.alloc(8);
	head.writeUInt32BE(data.length, 0);
	head.write(type, 4, "latin1");
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
	return Buffer.concat([head, data, crc]);
}

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function buildPng({ width, height, bitDepth, colorType, palette, trns, interlace = 0, scanlines }) {
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = bitDepth;
	ihdr[9] = colorType;
	ihdr[10] = 0;
	ihdr[11] = 0;
	ihdr[12] = interlace;
	const parts = [PNG_SIG, pngChunk("IHDR", ihdr)];
	if (palette) parts.push(pngChunk("PLTE", palette));
	if (trns) parts.push(pngChunk("tRNS", trns));
	parts.push(pngChunk("IDAT", deflateSync(Buffer.concat(scanlines))));
	parts.push(pngChunk("IEND", Buffer.alloc(0)));
	return Buffer.concat(parts);
}

function pngRgba(width, height, pixels) {
	const scanlines = [];
	for (let y = 0; y < height; y++) {
		const row = Buffer.alloc(1 + width * 4);
		row[0] = 0;
		for (let x = 0; x < width; x++) {
			const p = pixels[y * width + x];
			row.set(p, 1 + x * 4);
		}
		scanlines.push(row);
	}
	return buildPng({ width, height, bitDepth: 8, colorType: 6, scanlines });
}

function paethF(a, b, c) {
	const p = a + b - c;
	const pa = Math.abs(p - a);
	const pb = Math.abs(p - b);
	const pc = Math.abs(p - c);
	if (pa <= pb && pa <= pc) return a;
	if (pb <= pc) return b;
	return c;
}

function forwardFilter(type, cur, prev, bpp) {
	const out = Buffer.alloc(cur.length);
	for (let i = 0; i < cur.length; i++) {
		const a = i >= bpp ? cur[i - bpp] : 0;
		const b = prev ? prev[i] : 0;
		const c = prev && i >= bpp ? prev[i - bpp] : 0;
		let v;
		if (type === 0) v = cur[i];
		else if (type === 1) v = cur[i] - a;
		else if (type === 2) v = cur[i] - b;
		else if (type === 3) v = cur[i] - ((a + b) >> 1);
		else v = cur[i] - paethF(a, b, c);
		out[i] = v & 0xff;
	}
	return out;
}

function buildBmp24(width, height, rows) {
	const stride = ((width * 24 + 31) >> 5) * 4;
	const fileSize = 54 + stride * height;
	const buf = Buffer.alloc(fileSize);
	buf.write("BM", 0, "latin1");
	buf.writeUInt32LE(fileSize, 2);
	buf.writeUInt32LE(54, 10);
	buf.writeUInt32LE(40, 14);
	buf.writeInt32LE(width, 18);
	buf.writeInt32LE(height, 22);
	buf.writeUInt16LE(1, 26);
	buf.writeUInt16LE(24, 28);
	buf.writeUInt32LE(stride * height, 34);
	for (let row = 0; row < height; row++) {
		const src = rows[height - 1 - row];
		let p = 54 + row * stride;
		for (let x = 0; x < width; x++) {
			buf[p++] = src[x][2];
			buf[p++] = src[x][1];
			buf[p++] = src[x][0];
		}
	}
	return buf;
}

function buildBmp8(width, height, palette, rows) {
	const stride = ((width * 8 + 31) >> 5) * 4;
	const off = 14 + 40 + 256 * 4;
	const buf = Buffer.alloc(off + stride * height);
	buf.write("BM", 0, "latin1");
	buf.writeUInt32LE(buf.length, 2);
	buf.writeUInt32LE(off, 10);
	buf.writeUInt32LE(40, 14);
	buf.writeInt32LE(width, 18);
	buf.writeInt32LE(height, 22);
	buf.writeUInt16LE(1, 26);
	buf.writeUInt16LE(8, 28);
	buf.writeUInt32LE(0, 30);
	buf.writeUInt32LE(stride * height, 34);
	buf.writeUInt32LE(256, 46);
	for (let i = 0; i < palette.length; i++) {
		const p = 54 + i * 4;
		buf[p] = palette[i][2];
		buf[p + 1] = palette[i][1];
		buf[p + 2] = palette[i][0];
		buf[p + 3] = 0;
	}
	for (let row = 0; row < height; row++) {
		const src = rows[height - 1 - row];
		const p = off + row * stride;
		for (let x = 0; x < width; x++) buf[p + x] = src[x];
	}
	return buf;
}

class Layout {
	constructor(le) {
		this.le = le;
		this.bufs = [];
		this.size = 0;
	}
	alloc(n) {
		const b = Buffer.alloc(n);
		this.bufs.push(b);
		const off = this.size;
		this.size += n;
		return off;
	}
	locate(off, n) {
		let acc = 0;
		for (const b of this.bufs) {
			if (off >= acc && off + n <= acc + b.length) return { buf: b, rel: off - acc };
			acc += b.length;
		}
		throw new Error(`夹具越界写入 @${off}+${n}`);
	}
	u16(off, v) {
		const { buf, rel } = this.locate(off, 2);
		if (this.le) buf.writeUInt16LE(v, rel);
		else buf.writeUInt16BE(v, rel);
	}
	u32(off, v) {
		const { buf, rel } = this.locate(off, 4);
		if (this.le) buf.writeUInt32LE(v, rel);
		else buf.writeUInt32BE(v, rel);
	}
	ascii(off, s) {
		const { buf, rel } = this.locate(off, s.length);
		buf.write(s, rel, "latin1");
	}
	entry(off, tag, type, count, valueOrOffset) {
		this.u16(off, tag);
		this.u16(off + 2, type);
		this.u32(off + 4, count);
		if (type === 3) {
			this.u16(off + 8, valueOrOffset);
		} else {
			this.u32(off + 8, valueOrOffset);
		}
	}
	done() {
		return Buffer.concat(this.bufs);
	}
}

function buildTiff(le) {
	const L = new Layout(le);
	const header = L.alloc(8);
	L.u16(header, le ? 0x4949 : 0x4d4d);
	L.u16(header + 2, 42);
	L.u32(header + 4, 8);

	const ifd0 = L.alloc(2 + 5 * 12 + 4);
	const dMake = L.alloc(8);
	const dModel = L.alloc(7);
	const dDate = L.alloc(20);
	L.u16(ifd0, 5);
	L.entry(ifd0 + 2, 0x010f, 2, 8, dMake);
	L.entry(ifd0 + 14, 0x0110, 2, 7, dModel);
	L.entry(ifd0 + 26, 0x0112, 3, 1, 6);
	L.entry(ifd0 + 38, 0x0132, 2, 20, dDate);
	const exifIfd = L.alloc(2 + 5 * 12 + 4);
	L.entry(ifd0 + 50, 0x8769, 4, 1, exifIfd);
	L.u32(ifd0 + 62, 0);
	L.ascii(dMake, "TestCam\0");
	L.ascii(dModel, "ModelX\0");
	L.ascii(dDate, "2024:05:01 12:34:56\0");

	const dExposure = L.alloc(8);
	const dFnum = L.alloc(8);
	const dFocal = L.alloc(8);
	const dLens = L.alloc(12);
	L.u16(exifIfd, 5);
	L.entry(exifIfd + 2, 0x829a, 5, 1, dExposure);
	L.entry(exifIfd + 14, 0x829d, 5, 1, dFnum);
	L.entry(exifIfd + 26, 0x8827, 3, 1, 400);
	L.entry(exifIfd + 38, 0x920a, 5, 1, dFocal);
	L.entry(exifIfd + 50, 0xa434, 2, 12, dLens);
	L.u32(exifIfd + 62, 0);
	L.u32(dExposure, 1);
	L.u32(dExposure + 4, 250);
	L.u32(dFnum, 28);
	L.u32(dFnum + 4, 10);
	L.u32(dFocal, 35);
	L.u32(dFocal + 4, 1);
	L.ascii(dLens, "TestLens 35\0");
	return L.done();
}

function buildJpegWithExif(le = false) {
	const tiff = buildTiff(le);
	const app1data = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff]);
	const app1 = Buffer.alloc(4);
	app1[0] = 0xff;
	app1[1] = 0xe1;
	app1.writeUInt16BE(app1data.length + 2, 2);
	const sof = Buffer.alloc(2 + 2 + 1 + 2 + 2 + 1 + 9);
	sof[0] = 0xff;
	sof[1] = 0xc0;
	sof.writeUInt16BE(sof.length - 2, 2);
	sof[4] = 8;
	sof.writeUInt16BE(32, 5);
	sof.writeUInt16BE(48, 7);
	sof[9] = 3;
	return Buffer.concat([Buffer.from([0xff, 0xd8]), app1, app1data, sof, Buffer.from([0xff, 0xd9])]);
}

function makeImage(width, height, pixels, hasAlpha = true) {
	const data = new Uint8Array(width * height * 4);
	for (let i = 0; i < pixels.length; i++) data.set(pixels[i], i * 4);
	return { width, height, data, hasAlpha, format: "rgba" };
}

function makeImageBy(width, height, fn, hasAlpha = true) {
	const data = new Uint8Array(width * height * 4);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const o = (y * width + x) * 4;
			const p = fn(x, y);
			data[o] = p[0];
			data[o + 1] = p[1];
			data[o + 2] = p[2];
			data[o + 3] = p[3] ?? 255;
		}
	}
	return { width, height, data, hasAlpha, format: "rgba" };
}

function pixel(img, x, y) {
	const o = (y * img.width + x) * 4;
	return [img.data[o], img.data[o + 1], img.data[o + 2], img.data[o + 3]];
}

function assertPixel(img, x, y, expected, label = "") {
	assert.deepEqual(pixel(img, x, y), expected, `${label} 像素 (${x},${y})`);
}

function assertSize(img, w, h, label = "") {
	assert.equal(img.width, w, `${label} 宽度`);
	assert.equal(img.height, h, `${label} 高度`);
}

function gradient4() {
	const pixels = [];
	for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) pixels.push([x * 16, y * 16, 100, 255]);
	return makeImage(4, 4, pixels, false);
}

const RED = [255, 0, 0, 255];
const GREEN = [0, 255, 0, 255];
const BLUE = [0, 0, 255, 255];
const YELLOW = [255, 255, 0, 255];
function quad() {
	return makeImage(2, 2, [RED, GREEN, BLUE, YELLOW], false);
}

check("sniffFormat：png / jpeg / gif / webp / bmp / avif / svg 魔数各识别一次", () => {
	assert.equal(sniffFormat(pngRgba(1, 1, [[1, 2, 3, 4]])), "png");
	assert.equal(sniffFormat(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00])), "jpeg");
	assert.equal(sniffFormat(Buffer.from("GIF89a....", "latin1")), "gif");
	const webp = Buffer.alloc(16);
	webp.write("RIFF", 0, "latin1");
	webp.writeUInt32LE(8, 4);
	webp.write("WEBP", 8, "latin1");
	assert.equal(sniffFormat(webp), "webp");
	assert.equal(sniffFormat(buildBmp24(1, 1, [[[1, 2, 3]]])), "bmp");
	const avif = Buffer.alloc(24);
	avif.writeUInt32BE(20, 0);
	avif.write("ftyp", 4, "latin1");
	avif.write("avif", 8, "latin1");
	assert.equal(sniffFormat(avif), "avif");
	assert.equal(
		sniffFormat(Buffer.from('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"></svg>')),
		"svg",
	);
	assert.equal(sniffFormat(Buffer.from("   \n<svg viewBox='0 0 1 1'></svg>")), "svg");
	assert.equal(sniffFormat(Buffer.from("not an image at all")), "unknown");
	assert.equal(sniffFormat(Buffer.alloc(0)), "unknown");
	assert.equal(mimeForFormat("png"), "image/png");
	assert.equal(mimeForFormat("svg"), "image/svg+xml");
	assert.equal(mimeForFormat("bogus"), "application/octet-stream");
});

const fixtureA = {
	width: 3,
	height: 2,
	pixels: [
		[255, 0, 0, 255],
		[0, 255, 0, 128],
		[0, 0, 255, 0],
		[10, 20, 30, 40],
		[200, 100, 50, 255],
		[0, 0, 0, 255],
	],
};
const pngA = pngRgba(fixtureA.width, fixtureA.height, fixtureA.pixels);

check("probeImage(自建 PNG)：宽高/格式/hasAlpha/mime/bytes/aspect 正确", () => {
	const info = probeImage(pngA);
	assert.equal(info.format, "png");
	assert.equal(info.mime, "image/png");
	assert.equal(info.width, 3);
	assert.equal(info.height, 2);
	assert.equal(info.bytes, pngA.length);
	assert.equal(info.megapixels, 0.000006);
	assert.equal(info.aspect, 1.5);
	assert.equal(info.hasAlpha, true);
	assert.equal(info.bitDepth, 8);
	assert.equal(info.animated, false);
});

await checkAsync("decodeImage(自建 PNG)：每个像素值逐一核对", async () => {
	const img = await decodeImage(pngA);
	assertSize(img, 3, 2, "decode");
	assert.equal(img.format, "png");
	assert.equal(img.hasAlpha, true);
	let i = 0;
	for (let y = 0; y < 2; y++) {
		for (let x = 0; x < 3; x++, i++) assertPixel(img, x, y, fixtureA.pixels[i], "decode");
	}
});

await checkAsync("encodeImage(png) → decodeImage：RGBA 像素完全一致（roundtrip）", async () => {
	const src = makeImage(3, 2, fixtureA.pixels, true);
	const encoded = await encodeImage(src, "png");
	assert.ok(Buffer.isBuffer(encoded), "应返回 Buffer");
	assert.equal(sniffFormat(encoded), "png");
	const back = await decodeImage(encoded);
	assertSize(back, 3, 2, "roundtrip");
	for (let y = 0; y < 2; y++) {
		for (let x = 0; x < 3; x++) assertPixel(back, x, y, fixtureA.pixels[y * 3 + x], "roundtrip");
	}
});

await checkAsync("encodeImage(png, pngLevel:0)：高压缩级别与无压缩都能自解回同一像素", async () => {
	const src = gradient4();
	for (const level of [0, 1, 6, 9]) {
		const back = await decodeImage(await encodeImage(src, "png", { pngLevel: level }));
		for (let y = 0; y < 4; y++)
			for (let x = 0; x < 4; x++) assertPixel(back, x, y, [x * 16, y * 16, 100, 255], `level ${level}`);
	}
});

function rgbRows4x4() {
	const rows = [];
	for (let y = 0; y < 4; y++) {
		const row = Buffer.alloc(12);
		for (let x = 0; x < 4; x++) {
			row[x * 3] = 10 + x * 30;
			row[x * 3 + 1] = 20 + y * 40;
			row[x * 3 + 2] = 50 + x * 5 + y * 7;
		}
		rows.push(row);
	}
	return rows;
}

const rgbRows = rgbRows4x4();
const pngFilters = buildPng({
	width: 4,
	height: 4,
	bitDepth: 8,
	colorType: 2,
	scanlines: rgbRows.map((row, y) => {
		const type = y;
		const filtered = forwardFilter(type, row, y === 0 ? null : rgbRows[y - 1], 3);
		return Buffer.concat([Buffer.from([type]), filtered]);
	}),
});

await checkAsync("PNG filter 1(Sub)/2(Up)/3(Average)/4(Paeth) 解码结果与原始像素一致", async () => {
	const img = await decodeImage(pngFilters);
	assertSize(img, 4, 4, "filter");
	assert.equal(img.hasAlpha, false);
	for (let y = 0; y < 4; y++) {
		for (let x = 0; x < 4; x++) {
			assertPixel(img, x, y, [10 + x * 30, 20 + y * 40, 50 + x * 5 + y * 7, 255], "filter");
		}
	}
});

const PALETTE = [];
for (let i = 0; i < 16; i++) PALETTE.push((i * 16) % 256, (255 - i * 16) % 256, (i * 8) % 256);
const palette8 = Buffer.from(PALETTE);
const trns8 = Buffer.from([0, 128, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255]);
const palettePng8 = buildPng({
	width: 4,
	height: 2,
	bitDepth: 8,
	colorType: 3,
	palette: palette8,
	trns: trns8,
	scanlines: [Buffer.from([0, 0, 1, 2, 3]), Buffer.from([0, 3, 2, 1, 0])],
});

await checkAsync("8 位调色板 PNG + tRNS：颜色与逐索引透明度都正确", async () => {
	const img = await decodeImage(palettePng8);
	assertSize(img, 4, 2, "palette8");
	const expect = [
		[0, 255, 0, 0],
		[16, 239, 8, 128],
		[32, 223, 16, 255],
		[48, 207, 24, 255],
		[48, 207, 24, 255],
		[32, 223, 16, 255],
		[16, 239, 8, 128],
		[0, 255, 0, 0],
	];
	for (let i = 0; i < 8; i++) assertPixel(img, i % 4, Math.floor(i / 4), expect[i], "palette8");
	assert.equal(img.hasAlpha, true);
	assert.equal(probeImage(palettePng8).hasAlpha, true);
	assert.equal(probeImage(palettePng8).bitDepth, 8);
});

const palettePng4 = buildPng({
	width: 8,
	height: 1,
	bitDepth: 4,
	colorType: 3,
	palette: palette8,
	trns: trns8,
	scanlines: [Buffer.from([0, 0x12, 0x34, 0x56, 0x78])],
});

await checkAsync("4 位调色板 PNG：位打包解包正确（含 alpha）", async () => {
	const img = await decodeImage(palettePng4);
	assertSize(img, 8, 1, "palette4");
	const expect = [1, 2, 3, 4, 5, 6, 7, 8].map((i) => [(i * 16) % 256, (255 - i * 16) % 256, (i * 8) % 256, trns8[i]]);
	for (let x = 0; x < 8; x++) assertPixel(img, x, 0, expect[x], "palette4");
});

await checkAsync("16 位 RGBA PNG：用 257 倍数选值，缩放结果必须精确", async () => {
	const line = Buffer.from([0, 0xff, 0xff, 0x80, 0x80, 0x00, 0x00, 0x40, 0x40]);
	const png16 = buildPng({ width: 1, height: 1, bitDepth: 16, colorType: 6, scanlines: [line] });
	const img = await decodeImage(png16);
	assertPixel(img, 0, 0, [255, 128, 0, 64], "png16");
	assert.equal(probeImage(png16).bitDepth, 16);
});

await checkAsync("灰度 PNG（bitDepth 1，colorType 0）解码成 0/255", async () => {
	const png1 = buildPng({ width: 8, height: 1, bitDepth: 1, colorType: 0, scanlines: [Buffer.from([0, 0xaa])] });
	const img = await decodeImage(png1);
	for (let x = 0; x < 8; x++) {
		const v = (0xaa >> (7 - x)) & 1 ? 255 : 0;
		assertPixel(img, x, 0, [v, v, v, 255], "gray1");
	}
});

await checkAsync("隔行 PNG（interlace=1）抛错且信息提到「隔行」", async () => {
	const png = buildPng({
		width: 2,
		height: 1,
		bitDepth: 8,
		colorType: 6,
		interlace: 1,
		scanlines: [Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8])],
	});
	await assert.rejects(decodeImage(png), (err) => {
		assert.match(err.message, /隔行/);
		return true;
	});
});

await checkAsync("24 位/32 位 BMP roundtrip（编码 → 解码像素一致）", async () => {
	const rgb = makeImage(
		3,
		2,
		[
			[1, 2, 3, 255],
			[4, 5, 6, 255],
			[7, 8, 9, 255],
			[10, 11, 12, 255],
			[13, 14, 15, 255],
			[16, 17, 18, 255],
		],
		false,
	);
	const bmp24 = await encodeImage(rgb, "bmp");
	assert.equal(sniffFormat(bmp24), "bmp");
	assert.equal(bmp24.readUInt16LE(28), 24, "24 位");
	const back24 = await decodeImage(bmp24);
	assertSize(back24, 3, 2, "bmp24");
	for (let y = 0; y < 2; y++)
		for (let x = 0; x < 3; x++)
			assertPixel(back24, x, y, [1 + (y * 3 + x) * 3, 2 + (y * 3 + x) * 3, 3 + (y * 3 + x) * 3, 255], "bmp24");

	const rgba = makeImage(
		3,
		2,
		[
			[1, 2, 3, 0],
			[4, 5, 6, 128],
			[7, 8, 9, 255],
			[10, 11, 12, 255],
			[13, 14, 15, 64],
			[16, 17, 18, 255],
		],
		true,
	);
	const bmp32 = await encodeImage(rgba, "bmp");
	assert.equal(bmp32.readUInt16LE(28), 32, "32 位");
	const back32 = await decodeImage(bmp32);
	assertSize(back32, 3, 2, "bmp32");
	for (let y = 0; y < 2; y++) {
		for (let x = 0; x < 3; x++) {
			const i = y * 3 + x;
			assertPixel(back32, x, y, [1 + i * 3, 2 + i * 3, 3 + i * 3, [0, 128, 255, 255, 64, 255][i]], "bmp32");
		}
	}
});

await checkAsync("手工 24 位 BMP：bottom-up 行序正确（首行红、末行蓝）", async () => {
	const bmp = buildBmp24(2, 2, [
		[
			[255, 0, 0],
			[255, 0, 0],
		],
		[
			[0, 0, 255],
			[0, 0, 255],
		],
	]);
	const img = await decodeImage(bmp);
	assertSize(img, 2, 2, "bmp25");
	assertPixel(img, 0, 0, [255, 0, 0, 255], "bottom-up");
	assertPixel(img, 1, 1, [0, 0, 255, 255], "bottom-up");
});

await checkAsync("手工 8 位调色板 BMP：调色板查表与 bottom-up 都正确", async () => {
	const bmp = buildBmp8(
		2,
		2,
		[
			[255, 0, 0],
			[0, 255, 0],
		],
		[
			[0, 1],
			[1, 0],
		],
	);
	const img = await decodeImage(bmp);
	assertSize(img, 2, 2, "bmp8");
	assertPixel(img, 0, 0, [255, 0, 0, 255], "bmp8");
	assertPixel(img, 1, 0, [0, 255, 0, 255], "bmp8");
	assertPixel(img, 0, 1, [0, 255, 0, 255], "bmp8");
	assertPixel(img, 1, 1, [255, 0, 0, 255], "bmp8");
	assert.equal(probeImage(bmp).bitDepth, 8);
});

check("resizeImage：4×4 → 8×8 / 2×2 / 只给 width 时按比例算高", () => {
	const g = gradient4();
	const up = resizeImage(g, { width: 8 });
	assertSize(up, 8, 8, "放大");
	assertPixel(up, 0, 0, [0, 0, 100, 255], "放大左上角");
	const down = resizeImage(g, { height: 2 });
	assertSize(down, 2, 2, "缩小");
	const half = resizeImage(
		makeImage(
			4,
			2,
			Array.from({ length: 8 }, () => [10, 10, 10, 255]),
			true,
		),
		{ width: 2 },
	);
	assertSize(half, 2, 1, "等比");
	assert.throws(() => resizeImage(g, {}), /必须指定 width 或 height/);
	assert.throws(() => resizeImage(g, { width: 0 }), /宽度必须为正整数/);
});

check("resizeImage 缩到 1×1 = 全图面积平均（渐变图取平均色）", () => {
	const one = resizeImage(gradient4(), { width: 1, height: 1 });
	assertSize(one, 1, 1, "1×1");
	assert.deepEqual(pixel(one, 0, 0), [24, 24, 100, 255], "4×4 平均色");
	const flat = makeImage(
		4,
		4,
		Array.from({ length: 16 }, () => [7, 200, 33, 255]),
		true,
	);
	assert.deepEqual(pixel(resizeImage(flat, { width: 2, height: 2 }), 1, 1), [7, 200, 33, 255], "纯色下采样");
	assert.deepEqual(pixel(resizeImage(flat, { width: 5, height: 5 }), 4, 4), [7, 200, 33, 255], "纯色上采样");
});

check("cropImage：正向裁剪取到正确像素", () => {
	const g = gradient4();
	const c = cropImage(g, { x: 1, y: 2, width: 2, height: 2 });
	assertSize(c, 2, 2, "crop");
	for (let y = 0; y < 2; y++) {
		for (let x = 0; x < 2; x++) assertPixel(c, x, y, [(x + 1) * 16, (y + 2) * 16, 100, 255], "crop");
	}
});

check("cropImage：越界部分补全透明，且 width/height 至少 1×1", () => {
	const c = cropImage(gradient4(), { x: -1, y: -2, width: 4, height: 4 });
	assertSize(c, 4, 4, "越界");
	assertPixel(c, 0, 0, [0, 0, 0, 0], "越界左上透明");
	assertPixel(c, 0, 1, [0, 0, 0, 0], "越界第二行仍透明");
	assertPixel(c, 1, 2, [0, 0, 100, 255], "源(0,0) 落位");
	assertPixel(c, 3, 3, [32, 16, 100, 255], "源(2,1) 落位");
	const tail = cropImage(gradient4(), { x: 2, y: 2, width: 4, height: 4 });
	assertPixel(tail, 0, 0, [32, 32, 100, 255], "右下起点");
	assertPixel(tail, 2, 2, [0, 0, 0, 0], "右下越界透明");
	const tiny = cropImage(gradient4(), { x: 0, y: 0, width: 0, height: -3 });
	assertSize(tiny, 1, 1, "至少 1×1");
});

check("rotateImage：90 / 180 / 270 像素位置与画布尺寸都正确", () => {
	const q = quad();
	const r90 = rotateImage(q, 90);
	assertSize(r90, 2, 2, "90");
	assertPixel(r90, 0, 0, BLUE, "90");
	assertPixel(r90, 1, 0, RED, "90");
	assertPixel(r90, 0, 1, YELLOW, "90");
	assertPixel(r90, 1, 1, GREEN, "90");

	const r180 = rotateImage(q, 180);
	assertPixel(r180, 0, 0, YELLOW, "180");
	assertPixel(r180, 1, 0, BLUE, "180");
	assertPixel(r180, 0, 1, GREEN, "180");
	assertPixel(r180, 1, 1, RED, "180");

	const r270 = rotateImage(q, 270);
	assertPixel(r270, 0, 0, GREEN, "270");
	assertPixel(r270, 1, 0, YELLOW, "270");
	assertPixel(r270, 0, 1, RED, "270");
	assertPixel(r270, 1, 1, BLUE, "270");

	const wide = makeImage(
		3,
		2,
		[
			[1, 1, 1, 255],
			[2, 2, 2, 255],
			[3, 3, 3, 255],
			[4, 4, 4, 255],
			[5, 5, 5, 255],
			[6, 6, 6, 255],
		],
		false,
	);
	const wide90 = rotateImage(wide, 90);
	assertSize(wide90, 2, 3, "3×2 → 90°");
	assertPixel(wide90, 0, 0, [4, 4, 4, 255], "3×2 → 90°");
	assertPixel(wide90, 1, 2, [3, 3, 3, 255], "3×2 → 90°");
	assert.deepEqual(rotateImage(wide, -90).data, rotateImage(wide, 270).data, "-90 等价 270");
	assert.deepEqual(rotateImage(wide, 100).data, rotateImage(wide, 90).data, "100 就近到 90");
	assert.deepEqual(rotateImage(wide, 0).data, wide.data, "0 度原样");
});

check("flipImage：h 左右翻转、v 上下翻转", () => {
	const q = quad();
	const h = flipImage(q, "h");
	assertSize(h, 2, 2, "h");
	assertPixel(h, 0, 0, GREEN, "h");
	assertPixel(h, 1, 0, RED, "h");
	assertPixel(h, 0, 1, YELLOW, "h");
	assertPixel(h, 1, 1, BLUE, "h");
	const v = flipImage(q, "v");
	assertPixel(v, 0, 0, BLUE, "v");
	assertPixel(v, 1, 0, YELLOW, "v");
	assertPixel(v, 0, 1, RED, "v");
	assertPixel(v, 1, 1, GREEN, "v");
	assert.throws(() => flipImage(q, "x"), /镜像轴/);
});

check("rotateArbitrary：任意角度 expand 扩画布、0/90 度近似恒等、背景填充生效", () => {
	const wide = makeImageBy(3, 2, (x, y) => [40 * (y * 3 + x + 1), 0, 0, 255], false);
	const r0 = rotateArbitrary(wide, 0);
	assertSize(r0, 3, 2, "0 度");
	assert.equal(pixel(r0, 0, 0)[0], 40, "0 度原样");
	assert.equal(pixel(r0, 2, 1)[0], 240, "0 度原样");
	const r45 = rotateArbitrary(wide, 45, { background: [0, 0, 0, 0] });
	assertSize(
		r45,
		Math.ceil(Math.abs(3 * Math.cos(Math.PI / 4)) + Math.abs(2 * Math.sin(Math.PI / 4))),
		Math.ceil(Math.abs(3 * Math.sin(Math.PI / 4)) + Math.abs(2 * Math.cos(Math.PI / 4))),
		"45 度",
	);
	assertPixel(r45, 0, 0, [0, 0, 0, 0], "45 度角外为背景");
	assert.ok(pixel(r45, Math.floor(r45.width / 2), Math.floor(r45.height / 2))[0] > 0, "中心有内容");
	const r90 = rotateArbitrary(wide, 90);
	assertSize(r90, 2, 3, "90 度 expand");
	assert.equal(pixel(r90, 0, 0)[0], 160, "90 度：左下角转到左上角");
	assert.equal(pixel(r90, 1, 0)[0], 40, "90 度：左上角转到右上角");
	assert.equal(pixel(r90, 1, 2)[0], 120, "90 度：右上角转到右下角");
	assert.ok(pixel(r90, 1, 0)[3] >= 254, "90 度边缘像素仍接近不透明");
	const sized = rotateArbitrary(wide, 30, { expand: false });
	assertSize(sized, 3, 2, "expand:false 保持原尺寸");
});

check("adjustImage：brightness=200 变亮且数值符合 (v*2-128)+128", () => {
	const img = makeImage(
		2,
		1,
		[
			[100, 100, 100, 255],
			[64, 64, 64, 255],
		],
		false,
	);
	const out = adjustImage(img, { brightness: 200 });
	assertPixel(out, 0, 0, [200, 200, 200, 255], "brightness");
	assertPixel(out, 1, 0, [128, 128, 128, 255], "brightness");
	assert.deepEqual(Array.from(adjustImage(img, {}).data), Array.from(img.data), "缺省不变");
});

check("adjustImage：grayscale=100 后 R=G=B=亮度；invert=100 后 255-v", () => {
	const img = makeImage(
		2,
		1,
		[
			[255, 0, 0, 255],
			[0, 0, 255, 255],
		],
		false,
	);
	const gray = adjustImage(img, { grayscale: 100 });
	const p0 = pixel(gray, 0, 0);
	assert.equal(p0[0], p0[1], "灰度 R=G");
	assert.equal(p0[1], p0[2], "灰度 G=B");
	assert.ok(p0[0] > 0 && p0[0] < 255, `红色灰度应在中间 (${p0[0]})`);
	const p1 = pixel(gray, 1, 0);
	assert.equal(p1[0], p1[1], "灰度 R=G");
	assert.equal(p1[1], p1[2], "灰度 G=B");

	const inv = adjustImage(img, { invert: 100 });
	assertPixel(inv, 0, 0, [0, 255, 255, 255], "invert");
	assertPixel(inv, 1, 0, [255, 255, 0, 255], "invert");
	assert.throws(() => adjustImage(img, { blur: 99 }), /模糊参数/);
	assert.throws(() => adjustImage(img, { grayscale: 500 }), /灰度参数/);
});

check("adjustImage：饱和度/色相/模糊/锐化/暗角/棕褐都能跑且结果在有效范围", () => {
	const g = gradient4();
	const out = adjustImage(g, {
		saturation: 150,
		hue: 30,
		gamma: 120,
		sepia: 40,
		blur: 2,
		sharpen: 30,
		vignette: 40,
		contrast: 110,
	});
	assertSize(out, 4, 4, "组合");
	for (let i = 0; i < out.data.length; i += 4) {
		for (let c = 0; c < 3; c++) assert.ok(out.data[i + c] >= 0 && out.data[i + c] <= 255, "通道范围");
		assert.equal(out.data[i + 3], 255, "alpha 保持");
	}
	const flat = makeImage(
		5,
		5,
		Array.from({ length: 25 }, (_, i) => (i === 12 ? [255, 255, 255, 255] : [0, 0, 0, 255])),
		false,
	);
	const blurred = adjustImage(flat, { blur: 1 });
	assert.ok(pixel(blurred, 2, 2)[0] < 255 && pixel(blurred, 2, 2)[0] > 0, "模糊把白点铺开");
	const vg = adjustImage(
		makeImage(
			9,
			9,
			Array.from({ length: 81 }, () => [200, 200, 200, 255]),
			false,
		),
		{ vignette: 100 },
	);
	assert.ok(pixel(vg, 0, 0)[0] < pixel(vg, 4, 4)[0], "暗角中心比四角亮");
	assert.equal(pixel(vg, 4, 4)[0], 200, "暗角中心不衰减");
});

check("roundCorners：四角透明、中心与边中点不变、半径自动夹到 min(w,h)/2", () => {
	const white = makeImage(
		16,
		16,
		Array.from({ length: 256 }, () => [255, 255, 255, 255]),
		false,
	);
	const rc = roundCorners(white, 5);
	assert.equal(pixel(rc, 0, 0)[3], 0, "左上角透明");
	assert.equal(pixel(rc, 15, 15)[3], 0, "右下角透明");
	assert.equal(pixel(rc, 15, 0)[3], 0, "右上角透明");
	assert.equal(pixel(rc, 0, 15)[3], 0, "左下角透明");
	assert.deepEqual(pixel(rc, 8, 8), [255, 255, 255, 255], "中心不变");
	assert.deepEqual(pixel(rc, 8, 0), [255, 255, 255, 255], "上边中点不变");
	assert.deepEqual(pixel(rc, 0, 8), [255, 255, 255, 255], "左边中点不变");
	assertSize(rc, 16, 16, "roundCorners");
	assert.deepEqual(Array.from(roundCorners(white, 500).data), Array.from(roundCorners(white, 8).data), "半径夹取");
	assert.deepEqual(Array.from(roundCorners(white, 0).data), Array.from(white.data), "半径 0 原样");
	assert.throws(() => roundCorners(white, -1), /圆角半径/);
});

check("addBorder：画布扩大、边框色正确、原图居中", () => {
	const img = makeImage(2, 2, [RED, GREEN, BLUE, YELLOW], false);
	const bordered = addBorder(img, 1, "#ff0000");
	assertSize(bordered, 4, 4, "border");
	assertPixel(bordered, 0, 0, [255, 0, 0, 255], "边框色");
	assertPixel(bordered, 3, 3, [255, 0, 0, 255], "边框色");
	assertPixel(bordered, 1, 1, RED, "原图落位");
	assertPixel(bordered, 2, 1, GREEN, "原图落位");
	assertPixel(bordered, 2, 2, YELLOW, "原图落位");
	const arr = addBorder(img, 2, [0, 0, 255, 128]);
	assertSize(arr, 6, 6, "border2");
	assertPixel(arr, 0, 0, [0, 0, 255, 128], "数组色");
	assertPixel(arr, 2, 2, RED, "原图落位");
	assert.throws(() => addBorder(img, -1, "#ff0000"), /边框宽度/);
	assert.throws(() => addBorder(img, 1, "red"), /边框颜色/);
});

check("compositeOverlay：不透明覆盖、半透明混合、负坐标与平铺", () => {
	const base = makeImage(
		4,
		4,
		Array.from({ length: 16 }, () => [0, 0, 0, 255]),
		false,
	);
	const ov = makeImage(
		2,
		2,
		Array.from({ length: 4 }, () => [255, 255, 255, 255]),
		true,
	);
	const solid = compositeOverlay(base, ov, { x: 1, y: 1 });
	assertPixel(solid, 1, 1, [255, 255, 255, 255], "不透明覆盖");
	assertPixel(solid, 0, 0, [0, 0, 0, 255], "未覆盖处不变");
	assertPixel(solid, 2, 2, [255, 255, 255, 255], "覆盖右下");
	assert.ok(pixel(solid, 3, 3)[0] === 0, "超出部分裁掉");

	const half = compositeOverlay(base, ov, { x: 0, y: 0, opacity: 0.5 });
	assert.deepEqual(pixel(half, 0, 0), [128, 128, 128, 255], "50% 混合");

	const negative = compositeOverlay(base, ov, { x: -1, y: -1 });
	assertPixel(negative, 0, 0, [255, 255, 255, 255], "负坐标仍落位");
	assertPixel(negative, 1, 1, [0, 0, 0, 255], "负坐标只覆盖左上角");

	const tiled = compositeOverlay(base, ov, { tile: true, gap: 1 });
	assertPixel(tiled, 0, 0, [255, 255, 255, 255], "平铺起点");
	assertPixel(tiled, 3, 3, [255, 255, 255, 255], "平铺第四格");
	assertPixel(tiled, 2, 1, [0, 0, 0, 255], "平铺留缝");

	const scaled = compositeOverlay(base, makeImage(1, 1, [[255, 0, 0, 255]], true), { scale: 2, x: 0, y: 0 });
	assert.deepEqual(pixel(scaled, 1, 1), [255, 0, 0, 255], "scale 生效");
	assert.throws(() => compositeOverlay(base, ov, { opacity: 2 }), /不透明度/);
});

check("histogram：纯红图峰值在 r=255 / g=b=0，且峰值归一化为 1", () => {
	const red = makeImage(
		4,
		4,
		Array.from({ length: 16 }, () => [255, 0, 0, 255]),
		true,
	);
	const h = histogram(red);
	assert.equal(h.r.length, 256);
	assert.equal(h.g.length, 256);
	assert.equal(h.b.length, 256);
	assert.equal(h.luma.length, 256);
	assert.equal(h.r[255], 1, "红峰在 255");
	assert.equal(h.g[0], 1, "绿峰在 0");
	assert.equal(h.b[0], 1, "蓝峰在 0");
	assert.equal(h.r[254], 0, "非峰值为 0");
	assert.equal(h.luma[Math.floor((0.2126 * 255 * 256) / 256)], 1, "亮度峰位置");
	const half = histogram(
		makeImage(
			2,
			1,
			[
				[0, 0, 0, 255],
				[200, 0, 0, 255],
			],
			false,
		),
		4,
	);
	assert.equal(half.r.length, 4, "自定义桶数");
	assert.equal(half.r[0], 1, "r=0 落在第 0 桶");
	assert.equal(half.r[3], 1, "r=200 落在第 3 桶");
	assert.equal(half.r[1], 0, "中间桶为空");
	assert.equal(half.b[0], 1, "b 全 0 → 第 0 桶");
});

check("dominantColors：纯红图主色是红色且 share=1；双色图占比正确", () => {
	const red = makeImage(
		4,
		4,
		Array.from({ length: 16 }, () => [255, 0, 0, 255]),
		true,
	);
	const dc = dominantColors(red);
	assert.equal(dc.length, 1, "只有一种色");
	assert.deepEqual(dc[0].rgb, [255, 0, 0], "主色红");
	assert.equal(dc[0].share, 1, "占比 1");

	const two = makeImage(2, 2, [RED, RED, RED, [0, 0, 255, 255]], true);
	const dc2 = dominantColors(two);
	assert.deepEqual(dc2[0].rgb, [255, 0, 0], "主色红");
	assert.equal(dc2[0].share, 0.75, "红占 3/4");
	assert.deepEqual(dc2[1].rgb, [0, 0, 255], "次色蓝");
	assert.equal(dc2[1].share, 0.25, "蓝占 1/4");

	const transparent = makeImage(
		2,
		1,
		[
			[255, 0, 0, 255],
			[0, 0, 0, 0],
		],
		true,
	);
	assert.equal(dominantColors(transparent)[0].share, 1, "全透明像素不参与统计");
	assert.equal(dominantColors(makeImage(1, 1, [[0, 0, 0, 0]], true)).length, 0, "全透明无主色");
});

const jpegBuf = buildJpegWithExif(false);

await checkAsync("JPEG 未注入：hasJpegCodec() 为 false，decode/encode 的错误信息都含 JPEG", async () => {
	assert.equal(hasJpegCodec(), false);
	await assert.rejects(decodeImage(jpegBuf), (err) => {
		assert.match(err.message, /jpeg/i);
		return true;
	});
	await assert.rejects(encodeImage(makeImage(1, 1, [[0, 0, 0, 255]], false), "jpeg"), (err) => {
		assert.match(err.message, /jpeg/i);
		return true;
	});
	assert.throws(() => setJpegCodec({ decode() {} }), /decode 与 encode/);
});

await checkAsync("JPEG 注入后：decode/encode 走注入的 codec，注入非法对象抛错，可复位", async () => {
	setJpegCodec({
		decode() {
			return { width: 2, height: 1, data: new Uint8Array([9, 8, 7, 255, 6, 5, 4, 255]) };
		},
		encode(img, quality) {
			return { data: Buffer.from(`stub:${img.width}x${img.height}@${quality}`) };
		},
	});
	try {
		assert.equal(hasJpegCodec(), true);
		const decoded = await decodeImage(jpegBuf);
		assertSize(decoded, 2, 1, "注入解码");
		assertPixel(decoded, 1, 0, [6, 5, 4, 255], "注入解码");
		assert.equal(decoded.format, "jpeg");
		assert.equal(decoded.hasAlpha, false);
		const encoded = await encodeImage(makeImage(1, 1, [[0, 0, 0, 255]], false), "jpeg", { quality: 60 });
		assert.equal(encoded.toString("latin1"), "stub:1x1@60", "注入编码 + quality 传递");
	} finally {
		setJpegCodec(null);
	}
	assert.equal(hasJpegCodec(), false);
});

check("probeImage：GIF / WEBP / BMP / AVIF / SVG / unknown", () => {
	const gif = Buffer.alloc(13 + 1);
	gif.write("GIF89a", 0, "latin1");
	gif.writeUInt16LE(3, 6);
	gif.writeUInt16LE(2, 8);
	gif[13] = 0x3b;
	const gifInfo = probeImage(gif);
	assert.equal(gifInfo.format, "gif");
	assert.equal(gifInfo.width, 3);
	assert.equal(gifInfo.height, 2);
	assert.equal(gifInfo.mime, "image/gif");
	assert.equal(gifInfo.animated, false);

	const webp = Buffer.alloc(30);
	webp.write("RIFF", 0, "latin1");
	webp.writeUInt32LE(22, 4);
	webp.write("WEBP", 8, "latin1");
	webp.write("VP8X", 12, "latin1");
	webp.writeUInt32LE(10, 16);
	webp[20] = 0x10;
	webp.writeUIntLE(63, 24, 3);
	webp.writeUIntLE(47, 27, 3);
	const webpInfo = probeImage(webp);
	assert.equal(webpInfo.format, "webp");
	assert.equal(webpInfo.width, 64);
	assert.equal(webpInfo.height, 48);
	assert.equal(webpInfo.hasAlpha, true);
	assert.equal(webpInfo.animated, false);

	const bmpInfo = probeImage(
		buildBmp24(5, 3, [
			[
				[1, 2, 3],
				[1, 2, 3],
				[1, 2, 3],
				[1, 2, 3],
				[1, 2, 3],
			],
			[
				[4, 5, 6],
				[4, 5, 6],
				[4, 5, 6],
				[4, 5, 6],
				[4, 5, 6],
			],
			[
				[7, 8, 9],
				[7, 8, 9],
				[7, 8, 9],
				[7, 8, 9],
				[7, 8, 9],
			],
		]),
	);
	assert.equal(bmpInfo.format, "bmp");
	assert.equal(bmpInfo.width, 5);
	assert.equal(bmpInfo.height, 3);
	assert.equal(bmpInfo.bitDepth, 24);
	assert.equal(bmpInfo.hasAlpha, false);

	const ftyp = Buffer.alloc(20);
	ftyp.writeUInt32BE(20, 0);
	ftyp.write("ftyp", 4, "latin1");
	ftyp.write("avif", 8, "latin1");
	ftyp.writeUInt32BE(0, 12);
	ftyp.write("avif", 16, "latin1");
	const ispe = Buffer.alloc(20);
	ispe.writeUInt32BE(20, 0);
	ispe.write("ispe", 4, "latin1");
	ispe.writeUInt32BE(640, 12);
	ispe.writeUInt32BE(480, 16);
	const urn = "urn:mpeg:mpegB:cicp:systems:auxiliary:alpha\0";
	const auxC = Buffer.alloc(8 + urn.length);
	auxC.writeUInt32BE(auxC.length, 0);
	auxC.write("auxC", 4, "latin1");
	auxC.write(urn, 8, "latin1");
	const avifInfo = probeImage(Buffer.concat([ftyp, ispe, auxC]));
	assert.equal(avifInfo.format, "avif");
	assert.equal(avifInfo.width, 640);
	assert.equal(avifInfo.height, 480);
	assert.equal(avifInfo.hasAlpha, true);

	const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"><rect/></svg>');
	const svgInfo = probeImage(svg);
	assert.equal(svgInfo.format, "svg");
	assert.equal(svgInfo.width, 120);
	assert.equal(svgInfo.height, 80);
	assert.equal(svgInfo.mime, "image/svg+xml");
	assert.equal(svgInfo.hasAlpha, true);
	assert.equal(svgInfo.aspect, 1.5);
	const svgViewBox = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 32"></svg>');
	assert.equal(probeImage(svgViewBox).width, 64);
	assert.equal(probeImage(svgViewBox).height, 32);
	const svgPercent = Buffer.from('<svg width="100%" height="100%" viewBox="0 0 10 20"></svg>');
	assert.equal(probeImage(svgPercent).height, 20);
	const svgNone = Buffer.from("<svg><rect/></svg>");
	assert.equal(probeImage(svgNone).width, null);
	assert.equal(probeImage(svgNone).megapixels, null);

	const unknown = probeImage(Buffer.from("这不是图片，只是一段文本"));
	assert.equal(unknown.format, "unknown");
	assert.equal(unknown.width, null);
	assert.equal(unknown.height, null);
	assert.equal(unknown.mime, "application/octet-stream");
	assert.equal(unknown.bytes, Buffer.byteLength("这不是图片，只是一段文本"));
});

check("parseExif：大端 JPEG APP1 全字段解析（相机/镜头/曝光/ISO/GPS 缺失返回 null）", () => {
	const exif = parseExif(jpegBuf);
	assert.ok(exif, "应有 EXIF");
	assert.equal(exif.make, "TestCam");
	assert.equal(exif.model, "ModelX");
	assert.equal(exif.lens, "TestLens 35");
	assert.equal(exif.fNumber, "f/2.8");
	assert.equal(exif.exposureTime, "1/250");
	assert.equal(exif.iso, 400);
	assert.equal(exif.focalLength, "35mm");
	assert.equal(exif.dateTime, "2024-05-01 12:34:56");
	assert.equal(exif.orientation, 6);
	assert.equal(exif.gps, undefined, "无 GPS IFD 时不返回 gps");
	assert.equal(parseExif(Buffer.from([0xff, 0xd8, 0xff, 0xd9])), null, "无 APP1 返回 null");
	const plainPng = pngRgba(1, 1, [[1, 2, 3, 4]]);
	assert.equal(parseExif(plainPng), null, "PNG 无 eXIf 返回 null");
});

check("parseExif：小端 TIFF 与 PNG eXIf 块都能解析", () => {
	const le = parseExif(buildJpegWithExif(true));
	assert.ok(le, "小端应有 EXIF");
	assert.equal(le.make, "TestCam");
	assert.equal(le.exposureTime, "1/250");
	assert.equal(le.focalLength, "35mm");
	assert.equal(le.orientation, 6);

	const tiff = buildTiff(false);
	const eXIf = pngChunk("eXIf", tiff);
	const png = Buffer.concat([
		PNG_SIG,
		pngChunk(
			"IHDR",
			(() => {
				const h = Buffer.alloc(13);
				h.writeUInt32BE(1, 0);
				h.writeUInt32BE(1, 4);
				h[8] = 8;
				h[9] = 6;
				return h;
			})(),
		),
		eXIf,
		pngChunk("IDAT", deflateSync(Buffer.from([0, 1, 2, 3, 4]))),
		pngChunk("IEND", Buffer.alloc(0)),
	]);
	const fromPng = parseExif(png);
	assert.ok(fromPng, "PNG eXIf 应有 EXIF");
	assert.equal(fromPng.model, "ModelX");
	assert.equal(fromPng.fNumber, "f/2.8");
	assert.equal(fromPng.iso, 400);
});

check("probeImage：带 EXIF 的 JPEG 仍能从 SOF0 读出宽高", () => {
	const info = probeImage(jpegBuf);
	assert.equal(info.format, "jpeg");
	assert.equal(info.width, 48);
	assert.equal(info.height, 32);
	assert.equal(info.bitDepth, 8);
	assert.equal(info.hasAlpha, false);
	assert.equal(info.megapixels, 0.001536);
	assert.equal(info.aspect, 1.5);
});

check("pickColor：精确单点取色与丰富色彩表示", () => {
	const img = makeImageBy(10, 10, (x, y) => {
		if (x === 3 && y === 4) return [255, 0, 0, 255];
		if (x === 5 && y === 5) return [0, 200, 0, 128];
		return [20, 20, 20, 255];
	});

	const resRed = pickColor(img, { x: 3, y: 4, cropSize: 8, zoom: 2, marker: false });
	assert.equal(resRed.color.r, 255);
	assert.equal(resRed.color.g, 0);
	assert.equal(resRed.color.b, 0);
	assert.equal(resRed.color.a, 255);
	assert.equal(resRed.color.hex, "#ff0000");
	assert.equal(resRed.color.rgb, "rgb(255, 0, 0)");
	assert.equal(resRed.color.rgba, "rgb(255, 0, 0)");
	assert.equal(resRed.color.hsl.h, 0);
	assert.equal(resRed.color.hsl.s, 100);
	assert.equal(resRed.color.hsl.l, 50);
	assert.ok(resRed.color.name.includes("red"));
	assert.equal(resRed.cropImage.width, 16);
	assert.equal(resRed.cropImage.height, 16);

	const resGreen = pickColor(img, { x: 5, y: 5, cropSize: 8, zoom: 1 });
	assert.equal(resGreen.color.r, 0);
	assert.equal(resGreen.color.g, 200);
	assert.equal(resGreen.color.b, 0);
	assert.equal(resGreen.color.a, 128);
	assert.ok(resGreen.color.hex.startsWith("#00c80080"));
	assert.ok(resGreen.color.rgba.includes("rgba(0, 200, 0, 0.50)"));
});

check("pickColor：平滑采样与区域均值", () => {
	const img = makeImageBy(5, 5, (x, y) => [x * 50, y * 50, 100, 255]);
	const res = pickColor(img, { x: 2, y: 2, sampleRadius: 1 });
	assert.ok(res.color.sampled);
	assert.equal(res.color.sampleRegion.radius, 1);
	assert.equal(res.color.sampleRegion.pixelCount, 9);
	assert.equal(res.color.sampled.r, 100);
	assert.equal(res.color.sampled.g, 100);
});

check("pickColor：准星标记绝不遮挡目标像素自身", () => {
	const img = makeImageBy(20, 20, (x, y) => (x === 10 && y === 10 ? [123, 234, 45, 255] : [0, 0, 0, 255]));
	const res = pickColor(img, { x: 10, y: 10, cropSize: 16, zoom: 4, marker: true });
	assert.equal(res.hasMarker, true);
	const tx = res.targetInCrop.x * res.zoom;
	const ty = res.targetInCrop.y * res.zoom;
	for (let dy = 0; dy < res.zoom; dy++) {
		for (let dx = 0; dx < res.zoom; dx++) {
			const idx = ((ty + dy) * res.cropImage.width + (tx + dx)) * 4;
			assert.equal(res.cropImage.data[idx], 123, "目标像素 R 未被准星遮挡");
			assert.equal(res.cropImage.data[idx + 1], 234, "目标像素 G 未被准星遮挡");
			assert.equal(res.cropImage.data[idx + 2], 45, "目标像素 B 未被准星遮挡");
		}
	}
});

check("pickColor：越界坐标与非法参数抛出明确错误", () => {
	const img = makeImage(5, 5, [[0, 0, 0, 255]], false);
	assert.throws(() => pickColor(img, { x: -1, y: 0 }), /超出图像尺寸/);
	assert.throws(() => pickColor(img, { x: 5, y: 0 }), /超出图像尺寸/);
	assert.throws(() => pickColor(img, { x: 0, y: 10 }), /超出图像尺寸/);
	assert.throws(() => pickColor(img, { x: "abc", y: 0 }), /有效数字/);
});

check("pickColorsBatch：批量多点取色与拼接图输出", () => {
	const img = makeImageBy(30, 10, (x) => {
		if (x < 10) return [255, 0, 0, 255];
		if (x < 20) return [0, 255, 0, 255];
		return [0, 0, 255, 255];
	});
	const points = [
		{ x: 5, y: 5, label: "red_region" },
		{ x: 15, y: 5, label: "green_region" },
		{ x: 25, y: 5, label: "blue_region" },
	];
	const res = pickColorsBatch(img, points, { cropSize: 8, zoom: 2 });
	assert.equal(res.points.length, 3);
	assert.equal(res.points[0].color.hex, "#ff0000");
	assert.equal(res.points[1].color.hex, "#00ff00");
	assert.equal(res.points[2].color.hex, "#0000ff");
	assert.ok(res.contactSheet);
	assert.ok(res.contactSheet.width > 0 && res.contactSheet.height > 0);
});

check("extractRegionPalette：全图/区域自动色板提取并定位代表像素", () => {
	const img = makeImageBy(40, 20, (x, y) => {
		if (x >= 5 && x < 15 && y >= 5 && y < 15) return [30, 144, 255, 255];
		if (x >= 25 && x < 35 && y >= 5 && y < 15) return [50, 205, 50, 255];
		return [20, 20, 20, 255];
	});

	const res = extractRegionPalette(img, { maxColors: 4, cropSize: 12, zoom: 2 });
	assert.ok(res.colors.length >= 3, `提取出色板数量至少 3 种（实际：${res.colors.length}）`);
	const hexes = res.colors.map((c) => c.color.hex.toLowerCase());
	const hasBlue = hexes.some((h) => h.includes("1e90ff"));
	const hasGreen = hexes.some((h) => h.includes("32cd32"));
	const hasDark = hexes.some((h) => h.includes("141414"));
	assert.ok(hasBlue, "提取出蓝色特征色");
	assert.ok(hasGreen, "提取出绿色特征色");
	assert.ok(hasDark, "提取出暗黑背景色");

	for (const item of res.colors) {
		assert.ok(Number.isFinite(item.coords.x) && Number.isFinite(item.coords.y));
		assert.ok(item.cropImage.width > 0 && item.cropImage.height > 0);
	}
	assert.ok(res.contactSheet, "生成总览 Contact Sheet 图像");
});

await checkAsync("非法参数都抛中文错误", async () => {
	await assert.rejects(decodeImage(Buffer.alloc(0)), /数据为空/);
	await assert.rejects(decodeImage(Buffer.from("hello world")), /无法识别/);
	await assert.rejects(decodeImage(pngA, { maxPixels: -1 }), /maxPixels/);
	const big = buildPng({
		width: 4,
		height: 4,
		bitDepth: 8,
		colorType: 6,
		scanlines: Array.from({ length: 4 }, () => Buffer.alloc(17)),
	});
	await assert.rejects(decodeImage(big, { maxPixels: 8 }), /超过上限/);
	const img = makeImage(1, 1, [[0, 0, 0, 255]], false);
	await assert.rejects(encodeImage({ width: 2, height: 2, data: new Uint8Array(4), hasAlpha: false }, "png"), /不匹配/);
	await assert.rejects(encodeImage(img, "webp"), /不支持的编码格式/);
	await assert.rejects(encodeImage(img, "png", { pngLevel: 42 }), /pngLevel/);
	assert.throws(() => resizeImage(img, { width: -1 }), /宽度必须为正整数/);
	assert.throws(() => cropImage(null, {}), /图像对象无效/);
	assert.throws(() => adjustImage(img, { vignette: -1 }), /暗角参数/);
	assert.throws(() => histogram(img, 0), /桶数/);
	assert.throws(() => dominantColors(img, 0), /主色数量/);
});

check("性能：2000×1500 上 resize + adjust（含预计算 LUT）耗时 < 2000ms", () => {
	const w = 2000;
	const h = 1500;
	const big = makeImageBy(w, h, (x, y) => [(x * 7) % 256, (y * 5) % 256, (x + y) % 256, 255]);
	const t0 = performance.now();
	const small = resizeImage(big, { width: 1000 });
	const out = adjustImage(small, { brightness: 110, contrast: 105, saturation: 130, gamma: 105, vignette: 20 });
	const ms = performance.now() - t0;
	assertSize(small, 1000, 750, "缩放结果");
	assertSize(out, 1000, 750, "调色结果");
	assert.ok(ms < 2000, `耗时 ${ms.toFixed(0)}ms 超过 2000ms`);
	console.log(`    · 2000×1500 → resize(1000×750) + adjust = ${ms.toFixed(0)}ms`);
	const t1 = performance.now();
	adjustImage(big, { brightness: 105, gamma: 110, grayscale: 20 });
	const ms2 = performance.now() - t1;
	assert.ok(ms2 < 2000, `全图调色耗时 ${ms2.toFixed(0)}ms 超过 2000ms`);
	console.log(`    · 2000×1500 全图 adjust = ${ms2.toFixed(0)}ms`);
});

console.log(`\n${process.exitCode ? "有失败项" : "全部通过"}：${passed} 项 ✓`);
