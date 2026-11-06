export function el(tag, attrs = {}, children = []) {
	const node = document.createElement(tag);
	for (const [k, v] of Object.entries(attrs)) {
		if (v === undefined || v === null || v === false) continue;
		if (k === "class") node.className = String(v);
		else if (k === "text") node.textContent = String(v);
		else if (k === "html") node.innerHTML = String(v);
		else if (k === "value") node.value = String(v);
		else if (k === "checked") node.checked = Boolean(v);
		else if (k === "style") {
			if (typeof v === "object" && v !== null) {
				Object.assign(node.style, v);
			} else {
				node.style.cssText = String(v);
			}
		} else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
		else node.setAttribute(k, v === true ? "" : String(v));
	}
	for (const c of [].concat(children)) {
		if (c === undefined || c === null || c === false) continue;
		node.append(typeof c === "string" || typeof c === "number" ? String(c) : c);
	}
	return node;
}

export function clamp(v, lo, hi) {
	return v < lo ? lo : v > hi ? hi : v;
}

export function fmtBytes(n) {
	if (!Number.isFinite(n)) return "?";
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
	return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

export function fmtInt(n) {
	return Number(n).toLocaleString("en-US");
}

export function basename(p) {
	return (
		String(p ?? "")
			.split(/[\\/]/)
			.pop() || "image"
	);
}

export function stem(name) {
	const i = String(name).lastIndexOf(".");
	return i > 0 ? String(name).slice(0, i) : String(name);
}

export function extOf(name) {
	const i = String(name).lastIndexOf(".");
	return i > 0
		? String(name)
				.slice(i + 1)
				.toLowerCase()
		: "";
}

export function debounce(fn, ms) {
	let t = 0;
	return (...args) => {
		clearTimeout(t);
		t = setTimeout(() => fn(...args), ms);
	};
}

export function nextFrame() {
	return new Promise((r) => requestAnimationFrame(() => r()));
}

export function downloadBlob(blob, name) {
	const url = URL.createObjectURL(blob);
	const a = el("a", { href: url, download: name });
	document.body.appendChild(a);
	a.click();
	a.remove();
	setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export async function copyImageToClipboard(blob) {
	if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
		throw new Error("clipboard unsupported");
	}
	await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
}

const CRC_TABLE = (() => {
	const t = new Uint32Array(256);
	for (let i = 0; i < 256; i++) {
		let c = i;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		t[i] = c >>> 0;
	}
	return t;
})();

function crc32(u8) {
	let c = 0xffffffff;
	for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

function dosTime(d) {
	return {
		time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
		date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
	};
}

export function makeZip(files) {
	const enc = new TextEncoder();
	const now = dosTime(new Date());
	const seen = new Set();
	const parts = [];
	const central = [];
	let offset = 0;

	for (const f of files) {
		let name = f.name;
		if (seen.has(name)) {
			const s = stem(name);
			const e = extOf(name);
			let i = 1;
			while (seen.has(`${s}-${i}.${e}`)) i++;
			name = `${s}-${i}.${e}`;
		}
		seen.add(name);

		const nameBytes = enc.encode(name);
		const crc = crc32(f.data);
		const local = new Uint8Array(30 + nameBytes.length);
		const lv = new DataView(local.buffer);
		lv.setUint32(0, 0x04034b50, true);
		lv.setUint16(4, 20, true);
		lv.setUint16(6, 0x0800, true);
		lv.setUint16(8, 0, true);
		lv.setUint16(10, now.time, true);
		lv.setUint16(12, now.date, true);
		lv.setUint32(14, crc, true);
		lv.setUint32(18, f.data.length, true);
		lv.setUint32(22, f.data.length, true);
		lv.setUint16(26, nameBytes.length, true);
		local.set(nameBytes, 30);

		const cd = new Uint8Array(46 + nameBytes.length);
		const cv = new DataView(cd.buffer);
		cv.setUint32(0, 0x02014b50, true);
		cv.setUint16(4, 20, true);
		cv.setUint16(6, 20, true);
		cv.setUint16(8, 0x0800, true);
		cv.setUint16(10, 0, true);
		cv.setUint16(12, now.time, true);
		cv.setUint16(14, now.date, true);
		cv.setUint32(16, crc, true);
		cv.setUint32(20, f.data.length, true);
		cv.setUint32(24, f.data.length, true);
		cv.setUint16(28, nameBytes.length, true);
		cv.setUint32(42, offset, true);
		cd.set(nameBytes, 46);

		parts.push(local, f.data);
		central.push(cd);
		offset += local.length + f.data.length;
	}

	const cdSize = central.reduce((a, c) => a + c.length, 0);
	const eocd = new Uint8Array(22);
	const ev = new DataView(eocd.buffer);
	ev.setUint32(0, 0x06054b50, true);
	ev.setUint16(8, files.length, true);
	ev.setUint16(10, files.length, true);
	ev.setUint32(12, cdSize, true);
	ev.setUint32(16, offset, true);

	return new Blob([...parts, ...central, eocd], { type: "application/zip" });
}
