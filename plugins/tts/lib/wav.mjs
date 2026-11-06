import { PCM } from "./constants.mjs";
import { usageError } from "./errors.mjs";

export const WAV_HEADER_BYTES = 44;
const RIFF_MAX = 0xffffffff;

/**
 * 只生成 44 字节头。
 * @param {{dataLength:number, sampleRate?:number, channels?:number, bitsPerSample?:number}} o
 */
export function wavHeader({
	dataLength,
	sampleRate = PCM.sampleRate,
	channels = PCM.channels,
	bitsPerSample = PCM.bitsPerSample,
} = {}) {
	for (const [k, v] of Object.entries({ dataLength, sampleRate, channels, bitsPerSample })) {
		if (!Number.isInteger(v) || v < 0) {
			throw usageError(`wavHeader 的 ${k} 必须是非负整数，收到 ${String(v)}`);
		}
	}
	if (!channels || !bitsPerSample || !sampleRate) {
		throw usageError("wavHeader: sampleRate / channels / bitsPerSample 都不能是 0");
	}
	if (bitsPerSample % 8 !== 0) {
		throw usageError(`wavHeader: bitsPerSample 必须是 8 的倍数，收到 ${bitsPerSample}`);
	}

	const blockAlign = (channels * bitsPerSample) / 8;
	const byteRate = sampleRate * blockAlign;
	const riffSize = 36 + dataLength;
	if (riffSize > RIFF_MAX) {
		throw usageError(`PCM 太大了，RIFF 块长度 ${riffSize} 超出 uint32（WAV 上限约 4GiB）`);
	}

	const buf = Buffer.alloc(WAV_HEADER_BYTES);
	buf.write("RIFF", 0, "ascii");
	buf.writeUInt32LE(riffSize, 4);
	buf.write("WAVE", 8, "ascii");
	buf.write("fmt ", 12, "ascii");
	buf.writeUInt32LE(16, 16);
	buf.writeUInt16LE(1, 20);
	buf.writeUInt16LE(channels, 22);
	buf.writeUInt32LE(sampleRate, 24);
	buf.writeUInt32LE(byteRate, 28);
	buf.writeUInt16LE(blockAlign, 32);
	buf.writeUInt16LE(bitsPerSample, 34);
	buf.write("data", 36, "ascii");
	buf.writeUInt32LE(dataLength, 40);
	return buf;
}

export function pcmToWav(pcm, options = {}) {
	const { sampleRate = PCM.sampleRate, channels = PCM.channels, bitsPerSample = PCM.bitsPerSample } = options;

	if (!Buffer.isBuffer(pcm) && !ArrayBuffer.isView(pcm)) {
		throw usageError("pcmToWav 需要 Buffer 或 TypedArray");
	}
	const data = Buffer.isBuffer(pcm) ? pcm : Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);

	const blockAlign = (channels * bitsPerSample) / 8;
	if (data.length % blockAlign !== 0) {
		throw usageError(`PCM 长度 ${data.length} 不是 blockAlign(${blockAlign}) 的整数倍，流可能被截断了`, {
			byteLength: data.length,
			blockAlign,
		});
	}

	return Buffer.concat([wavHeader({ dataLength: data.length, sampleRate, channels, bitsPerSample }), data]);
}

function parseWavHeader(buf) {
	const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
	if (b.length < WAV_HEADER_BYTES) {
		throw usageError(`WAV 至少要 ${WAV_HEADER_BYTES} 字节，只有 ${b.length}`);
	}
	const chunkId = b.toString("ascii", 0, 4);
	const format = b.toString("ascii", 8, 12);
	const subchunk1Id = b.toString("ascii", 12, 16);
	const subchunk2Id = b.toString("ascii", 36, 40);
	return {
		chunkId,
		chunkSize: b.readUInt32LE(4),
		format,
		subchunk1Id,
		subchunk1Size: b.readUInt32LE(16),
		audioFormat: b.readUInt16LE(20),
		channels: b.readUInt16LE(22),
		sampleRate: b.readUInt32LE(24),
		byteRate: b.readUInt32LE(28),
		blockAlign: b.readUInt16LE(32),
		bitsPerSample: b.readUInt16LE(34),
		subchunk2Id,
		dataLength: b.readUInt32LE(40),
		headerBytes: WAV_HEADER_BYTES,
		valid:
			chunkId === "RIFF" &&
			format === "WAVE" &&
			subchunk1Id === "fmt " &&
			subchunk2Id === "data" &&
			b.readUInt32LE(4) === 36 + b.readUInt32LE(40),
	};
}
