export const DESKTOP_FILE_LIMITS = Object.freeze({
	bytes: 16 * 1024 ** 3,
	entries: 10000,
	chunk: 1024 ** 2,
	jobs: 4,
	idleMs: 30 * 60_000,
});

export function fileChunkCrc(bytes: Uint8Array, previous = 0): number {
	const table = new Uint32Array(256);
	for (let index = 0; index < 256; index++) {
		let value = index;
		for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (0xedb88320 & -(value & 1));
		table[index] = value;
	}
	let crc = previous ^ -1;
	for (const byte of bytes) crc = (crc >>> 8) ^ table[(crc ^ byte) & 255];
	return (crc ^ -1) >>> 0;
}

export function desktopDownloadLimit(path: unknown, method = "GET"): number | undefined {
	return method === "GET" &&
		typeof path === "string" &&
		/^\/api\/device-desktop\/files\/download\/[a-f0-9]{32}(?:\?|$)/.test(path)
		? DESKTOP_FILE_LIMITS.bytes + 64 * 1024 ** 2
		: undefined;
}
