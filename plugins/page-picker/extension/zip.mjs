/**
 * 最小 ZIP 写入器（store 模式，不压缩）—— 纯 JS + JSDoc 类型，无依赖，可在单测里钉住。
 *
 * 为什么自己写：分发扩展要产出一个「解压后 manifest.json 就在根目录」的 zip，而 Node
 * 没有内置 zip；靠 `zip` / `Compress-Archive` 会变成两套平台分支（CI 在 ubuntu、用户可能
 * 在 Windows）。扩展产物只有几十 KB，store 模式（不压缩）完全够用，于是自己拼字节最省事、
 * 也最容易测。
 *
 * 格式要点（错了 Windows 就拒绝解压，所以逐项按规范来）：
 * - 文件名用 `/` 分隔 + 置 UTF-8 标志位（bit 11）；
 * - CRC32 必须对**未压缩**数据算（多项式 0xEDB88320）；
 * - 时间戳固定成常量，让产物可复现（同样的输入 → 同样的字节）。
 *
 * @typedef {{ name: string, data: Uint8Array }} ZipEntry
 * @typedef {{ entries: { name: string, size: number, crc: number }[] }} ZipInfo
 */

/**
 * CRC32（IEEE 802.3，ZIP 用的是它的反射写法）。
 * @param {Uint8Array} bytes
 * @returns {number}
 */
export function crc32(bytes) {
	let crc = 0xffffffff;
	for (let i = 0; i < bytes.length; i++) {
		crc ^= bytes[i];
		for (let bit = 0; bit < 8; bit++) {
			crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
		}
	}
	return (crc ^ 0xffffffff) >>> 0;
}

/** 固定时间戳（DOS 格式）：2024-01-01 00:00:00，保证产物可复现。 */
const DOS_TIME = 0;
const DOS_DATE = ((2024 - 1980) << 9) | (1 << 5) | 1;

/**
 * 把若干条目拼成一个 zip 字节流（store 模式）。
 * @param {ZipEntry[]} entries
 * @returns {Uint8Array}
 */
export function buildZip(entries) {
	const encoder = new TextEncoder();
	/** @type {Uint8Array[]} */
	const locals = [];
	/** @type {Uint8Array[]} */
	const centrals = [];
	let offset = 0;

	for (const entry of entries) {
		if (/^\//.test(entry.name) || entry.name.includes("..")) {
			throw new Error(`zip 条目名非法（不允许绝对路径或 ..）：${entry.name}`);
		}
		const nameBytes = encoder.encode(entry.name);
		const crc = crc32(entry.data);
		const size = entry.data.length;

		const local = new Uint8Array(30 + nameBytes.length);
		const lv = new DataView(local.buffer);
		lv.setUint32(0, 0x04034b50, true); // 本地文件头签名
		lv.setUint16(4, 20, true); // 解压所需版本 2.0
		lv.setUint16(6, 0x0800, true); // 标志位：文件名为 UTF-8
		lv.setUint16(8, 0, true); // 压缩方法 0 = store
		lv.setUint16(10, DOS_TIME, true);
		lv.setUint16(12, DOS_DATE, true);
		lv.setUint32(14, crc, true);
		lv.setUint32(18, size, true);
		lv.setUint32(22, size, true);
		lv.setUint16(26, nameBytes.length, true);
		lv.setUint16(28, 0, true); // extra 长度
		local.set(nameBytes, 30);
		locals.push(local, entry.data);

		const central = new Uint8Array(46 + nameBytes.length);
		const cv = new DataView(central.buffer);
		cv.setUint32(0, 0x02014b50, true); // 中央目录签名
		cv.setUint16(4, 20, true); // 打包者版本
		cv.setUint16(6, 20, true); // 解压所需版本
		cv.setUint16(8, 0x0800, true);
		cv.setUint16(10, 0, true);
		cv.setUint16(12, DOS_TIME, true);
		cv.setUint16(14, DOS_DATE, true);
		cv.setUint32(16, crc, true);
		cv.setUint32(20, size, true);
		cv.setUint32(24, size, true);
		cv.setUint16(28, nameBytes.length, true);
		cv.setUint16(30, 0, true); // extra
		cv.setUint16(32, 0, true); // comment
		cv.setUint16(34, 0, true); // 起始磁盘号
		cv.setUint16(36, 0, true); // 内部属性
		cv.setUint32(38, 0, true); // 外部属性
		cv.setUint32(42, offset, true); // 本地头偏移
		central.set(nameBytes, 46);
		centrals.push(central);

		offset += local.length + size;
	}

	const centralSize = centrals.reduce((n, c) => n + c.length, 0);
	const eocd = new Uint8Array(22);
	const ev = new DataView(eocd.buffer);
	ev.setUint32(0, 0x06054b50, true); // 中央目录结束记录
	ev.setUint16(4, 0, true);
	ev.setUint16(6, 0, true);
	ev.setUint16(8, entries.length, true);
	ev.setUint16(10, entries.length, true);
	ev.setUint32(12, centralSize, true);
	ev.setUint32(16, offset, true);
	ev.setUint16(20, 0, true);

	const out = new Uint8Array(offset + centralSize + eocd.length);
	let at = 0;
	for (const part of [...locals, ...centrals, eocd]) {
		out.set(part, at);
		at += part.length;
	}
	return out;
}

/**
 * 读回自己写的 zip（**只认 store 模式**）—— 打包脚本用它做自校验，
 * 免得「写出来的 zip 打不开」这种事只到用户手里才发现。
 * @param {Uint8Array} bytes
 * @returns {ZipInfo}
 */
export function readZip(bytes) {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	// 从尾部找中央目录结束记录（可能有注释，最多回退 66KB）
	let eocd = -1;
	for (let i = bytes.length - 22; i >= 0 && i >= bytes.length - 22 - 65536; i--) {
		if (view.getUint32(i, true) === 0x06054b50) {
			eocd = i;
			break;
		}
	}
	if (eocd < 0) throw new Error("不是合法 zip：找不到中央目录结束记录");
	const count = view.getUint16(eocd + 10, true);
	let cdOffset = view.getUint32(eocd + 16, true);
	const decoder = new TextDecoder();
	/** @type {ZipInfo["entries"]} */
	const entries = [];
	for (let i = 0; i < count; i++) {
		if (view.getUint32(cdOffset, true) !== 0x02014b50) throw new Error("中央目录损坏");
		const crc = view.getUint32(cdOffset + 16, true);
		const size = view.getUint32(cdOffset + 24, true);
		const nameLen = view.getUint16(cdOffset + 28, true);
		const extraLen = view.getUint16(cdOffset + 30, true);
		const commentLen = view.getUint16(cdOffset + 32, true);
		const name = decoder.decode(bytes.subarray(cdOffset + 46, cdOffset + 46 + nameLen));
		entries.push({ name, size, crc });
		cdOffset += 46 + nameLen + extraLen + commentLen;
	}
	return { entries };
}
