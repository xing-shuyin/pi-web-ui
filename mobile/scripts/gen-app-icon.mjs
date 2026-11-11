// mobile/scripts/gen-app-icon.mjs
// 生成 Android 图标与启动图（仓库忽略 *.png，所以图标靠这个脚本复现，不要手改二进制）。
//
// 视觉与 web/public/favicon.svg 同一套：紫底圆角方块 + 白色 π（三根圆角条，不依赖字体）。
//
// 用法：node scripts/gen-app-icon.mjs
// 产物：
//   res/mipmap-*/ic_launcher.png          48/72/96/144/192
//   res/mipmap-*/ic_launcher_round.png    同上（圆形底）
//   res/mipmap-*/ic_launcher_foreground.png  108/162/216/324/432（透明底，图形在安全区内）
//   res/drawable*/splash.png              按现有各密度尺寸重绘（深底 + 居中品牌块）
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const res = join(root, "android", "app", "src", "main", "res");

const BRAND = [0x8b, 0x5c, 0xf6];
const GLYPH = [0xff, 0xff, 0xff];
const SPLASH_BG = [0x10, 0x12, 0x16];
const SS = 4; // 超采样倍数：先画 4x 再盒式滤波缩小，边缘才不锯齿

// favicon.svg（viewBox 64）里的三根圆角条，单位是 64 格。
const BARS = [
	[14, 17, 36, 6.5],
	[17.5, 23.5, 6.5, 25],
	[40, 23.5, 6.5, 25],
];
const GLYPH_BOX = { x: 14, y: 17, w: 32.5, h: 31.5 };
const CORNER = 14 / 64;

function insideRoundedRect(px, py, x, y, w, h, r) {
	if (px < x || px > x + w || py < y || py > y + h) return false;
	const cx = Math.min(Math.max(px, x + r), x + w - r);
	const cy = Math.min(Math.max(py, y + r), y + h - r);
	const dx = px - cx;
	const dy = py - cy;
	return dx * dx + dy * dy <= r * r;
}

function insideCircle(px, py, cx, cy, r) {
	const dx = px - cx;
	const dy = py - cy;
	return dx * dx + dy * dy <= r * r;
}

/** 在 w×h 的画布上按 supersample 逐像素决定 RGBA，再缩小。 */
function paint(width, height, shade) {
	const sw = width * SS;
	const sh = height * SS;
	const out = Buffer.alloc(width * height * 4);
	const acc = new Float64Array(4 * SS * SS);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			acc.fill(0);
			for (let sy = 0; sy < SS; sy++) {
				for (let sx = 0; sx < SS; sx++) {
					const px = x + (sx + 0.5) / SS;
					const py = y + (sy + 0.5) / SS;
					const rgba = shade(px, py, sw / width, sh / height);
					const at = (sy * SS + sx) * 4;
					acc[at] += rgba[0] * rgba[3];
					acc[at + 1] += rgba[1] * rgba[3];
					acc[at + 2] += rgba[2] * rgba[3];
					acc[at + 3] += rgba[3];
				}
			}
			const base = (y * width + x) * 4;
			const samples = SS * SS;
			const alpha = acc[3] / samples;
			if (alpha <= 0) continue;
			// 先把超采样里的 alpha 加权色还原成直通色，再写回（PNG 用直通 alpha）
			out[base] = Math.round(acc[0] / acc[3]);
			out[base + 1] = Math.round(acc[1] / acc[3]);
			out[base + 2] = Math.round(acc[2] / acc[3]);
			out[base + 3] = Math.round(alpha * 255);
		}
	}
	return out;
}

/** 画一整枚图标：底（圆角方块或圆形）+ 白 π。 */
function iconShader(size, { round = false, withGlyph = true } = {}) {
	const corner = size * CORNER;
	const scale = (size * 0.508) / GLYPH_BOX.w; // favicon 里 π 占 32.5/64
	const ox = (size - GLYPH_BOX.w * scale) / 2 - GLYPH_BOX.x * scale;
	const oy = (size - GLYPH_BOX.h * scale) / 2 - GLYPH_BOX.y * scale;
	return (px, py) => {
		if (withGlyph) {
			for (const [bx, by, bw, bh] of BARS) {
				if (
					insideRoundedRect(
						px,
						py,
						bx * scale + ox,
						by * scale + oy,
						bw * scale,
						bh * scale,
						Math.min(bw, bh) * scale * 0.5,
					)
				) {
					return [...GLYPH, 1];
				}
			}
		}
		const covered = round
			? insideCircle(px, py, size / 2, size / 2, size / 2)
			: insideRoundedRect(px, py, 0, 0, size, size, corner);
		return covered ? [...BRAND, 1] : [0, 0, 0, 0];
	};
}

/** 自适应图标前景：透明底，π 收进 66% 安全区。 */
function foregroundShader(size) {
	const target = size * 0.42;
	const scale = target / GLYPH_BOX.w;
	const ox = (size - GLYPH_BOX.w * scale) / 2 - GLYPH_BOX.x * scale;
	const oy = (size - GLYPH_BOX.h * scale) / 2 - GLYPH_BOX.y * scale;
	return (px, py) => {
		for (const [bx, by, bw, bh] of BARS) {
			if (
				insideRoundedRect(
					px,
					py,
					bx * scale + ox,
					by * scale + oy,
					bw * scale,
					bh * scale,
					Math.min(bw, bh) * scale * 0.5,
				)
			) {
				return [...GLYPH, 1];
			}
		}
		return [0, 0, 0, 0];
	};
}

/** 启动图：整屏深底 + 居中品牌块（与 App 深色背景、图标同色，起屏不闪白）。 */
function splashShader(width, height) {
	const side = Math.min(width, height) * 0.26;
	const left = (width - side) / 2;
	const top = (height - side) / 2;
	const scale = (side * 0.508) / GLYPH_BOX.w;
	const ox = left + (side - GLYPH_BOX.w * scale) / 2 - GLYPH_BOX.x * scale;
	const oy = top + (side - GLYPH_BOX.h * scale) / 2 - GLYPH_BOX.y * scale;
	return (px, py) => {
		if (insideRoundedRect(px, py, left, top, side, side, side * CORNER)) {
			for (const [bx, by, bw, bh] of BARS) {
				if (
					insideRoundedRect(
						px,
						py,
						bx * scale + ox,
						by * scale + oy,
						bw * scale,
						bh * scale,
						Math.min(bw, bh) * scale * 0.5,
					)
				) {
					return [...GLYPH, 1];
				}
			}
			return [...BRAND, 1];
		}
		return [...SPLASH_BG, 1];
	};
}

// ---- PNG 编码（无需第三方依赖） ----
const CRC_TABLE = (() => {
	const table = new Int32Array(256);
	for (let index = 0; index < 256; index++) {
		let value = index;
		for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
		table[index] = value;
	}
	return table;
})();

function crc32(buffer) {
	let crc = -1;
	for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
	return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
	const length = Buffer.alloc(4);
	length.writeUInt32BE(data.length, 0);
	const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(body), 0);
	return Buffer.concat([length, body, crc]);
}

function encodePng(width, height, rgba) {
	const stride = width * 4;
	const raw = Buffer.alloc((stride + 1) * height);
	for (let y = 0; y < height; y++) {
		raw[y * (stride + 1)] = 0; // filter: none
		rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
	}
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8; // bit depth
	ihdr[9] = 6; // RGBA
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", ihdr),
		chunk("IDAT", deflateSync(raw, { level: 9 })),
		chunk("IEND", Buffer.alloc(0)),
	]);
}

function write(path, width, height, rgba) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, encodePng(width, height, rgba));
	return path;
}

// ---- 产物 ----
const DENSITIES = [
	["mdpi", 48, 108],
	["hdpi", 72, 162],
	["xhdpi", 96, 216],
	["xxhdpi", 144, 324],
	["xxxhdpi", 192, 432],
];

const written = [];
for (const [density, launcher, foreground] of DENSITIES) {
	const dir = join(res, `mipmap-${density}`);
	written.push(
		write(join(dir, "ic_launcher.png"), launcher, launcher, paint(launcher, launcher, iconShader(launcher))),
	);
	written.push(
		write(
			join(dir, "ic_launcher_round.png"),
			launcher,
			launcher,
			paint(launcher, launcher, iconShader(launcher, { round: true })),
		),
	);
	written.push(
		write(
			join(dir, "ic_launcher_foreground.png"),
			foreground,
			foreground,
			paint(foreground, foreground, foregroundShader(foreground)),
		),
	);
}

const SPLASHES = [
	["drawable/splash.png", 480, 320],
	["drawable-land-mdpi/splash.png", 480, 320],
	["drawable-land-hdpi/splash.png", 800, 480],
	["drawable-land-xhdpi/splash.png", 1280, 720],
	["drawable-land-xxhdpi/splash.png", 1600, 960],
	["drawable-land-xxxhdpi/splash.png", 1920, 1280],
	["drawable-port-mdpi/splash.png", 320, 480],
	["drawable-port-hdpi/splash.png", 480, 800],
	["drawable-port-xhdpi/splash.png", 720, 1280],
	["drawable-port-xxhdpi/splash.png", 960, 1600],
	["drawable-port-xxxhdpi/splash.png", 1280, 1920],
];
for (const [relative, width, height] of SPLASHES) {
	written.push(write(join(res, relative), width, height, paint(width, height, splashShader(width, height))));
}

console.log(`✓ 生成 ${written.length} 个图标/启动图 → ${res}`);
for (const path of written) console.log("  " + path.slice(res.length + 1));
