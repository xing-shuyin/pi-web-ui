// scripts/lib/npm-tarball.mjs
// npm 包里的 bin 入口必须自带可执行位，而唯一跨平台的真相源是 tarball 头里的 mode：
//   · npm 的 bin 链接只在「新建符号链接」时补 x 位（bin-links/link-bin.js: linked && fixBin），
//     链接已存在而目标文件被重新解压时会跳过，用户拿到 644 就是 `Permission denied`；
//   · Windows 打包机上 fs 根本没有 x 位，npm pack 只能按 tar 的 portable 规则写 0644
//     （tar/mode-fix.js: (mode | 0o600) & ~0o22），所以「仓库里 chmod +x」在 Windows 上不生效。
// 结论：发布前直接改写 tarball 条目头（连校验和一起重算），让产物自己声明可执行，
// 而不是指望安装器的 fixBin 时机。这里同时提供 inspect：拿线上/候选 tarball 就能复查这件事。
import { gunzipSync, gzipSync } from "node:zlib";

const BLOCK = 512;
const FILE_TYPE = "0";
const EXECUTABLE_MODE = 0o755;
const BIN_ROOT = "package/bin/";

const gzipped = (buffer) => buffer.length > 2 && buffer[0] === 0x1f && buffer[1] === 0x8b;

function decode(tarball) {
	return gzipped(tarball)
		? { compressed: true, buffer: gunzipSync(tarball) }
		: { compressed: false, buffer: Buffer.from(tarball) };
}

function readCString(field) {
	const end = field.indexOf(0);
	return field.subarray(0, end === -1 ? field.length : end).toString("latin1");
}

/** tar 的数值字段：八进制 ASCII，或（超大值）base-256。 */
function readNumber(field) {
	if (field[0] & 0x80) {
		let value = 0;
		for (let index = 1; index < field.length; index++) value = value * 256 + field[index];
		return value;
	}
	const value = Number.parseInt(readCString(field).trim() || "0", 8);
	return Number.isFinite(value) ? value : 0;
}

function readName(header) {
	const name = readCString(header.subarray(0, 100));
	const prefix = readCString(header.subarray(345, 500));
	return header.subarray(257, 262).toString("latin1") === "ustar" && prefix ? `${prefix}/${name}` : name;
}

/** pax 扩展头（typeflag x/g）里只有 path 会影响条目名，其余键对权限判断无意义。 */
function readPaxPath(data) {
	const text = data.toString("utf8");
	let path;
	let offset = 0;
	while (offset < text.length) {
		const space = text.indexOf(" ", offset);
		if (space === -1) break;
		const length = Number.parseInt(text.slice(offset, space), 10);
		if (!Number.isFinite(length) || length <= 0) break;
		const record = text.slice(space + 1, offset + length);
		const separator = record.indexOf("=");
		if (separator > 0 && record.startsWith("path=")) path = record.slice(separator + 1).replace(/\n$/, "");
		offset += length;
	}
	return path;
}

/**
 * 顺序扫一遍 tar 块，把每个真实条目交给回调。pax 长文件名 / GNU longlink 会改变紧随其后的条目名，
 * 所以名字必须按流式上下文解析，不能只看当前头部。
 */
function scanTarball(buffer, onEntry) {
	let offset = 0;
	let paxPath;
	let longName;
	while (offset + BLOCK <= buffer.length) {
		const header = buffer.subarray(offset, offset + BLOCK);
		if (!header.some((byte) => byte !== 0)) break;
		const size = readNumber(header.subarray(124, 136));
		const type = header[156] === 0 ? FILE_TYPE : String.fromCharCode(header[156]);
		const dataStart = offset + BLOCK;
		const dataEnd = dataStart + size;
		if (dataEnd > buffer.length) throw new Error(`tarball 被截断：${readName(header)} 声明 ${size} 字节`);
		if (type === "x") paxPath = readPaxPath(buffer.subarray(dataStart, dataEnd));
		else if (type === "L") longName = readCString(buffer.subarray(dataStart, dataEnd));
		else {
			onEntry({
				name: paxPath ?? longName ?? readName(header),
				type,
				mode: readNumber(header.subarray(100, 108)) & 0o7777,
				size,
				headerOffset: offset,
				dataStart,
				dataEnd,
				magic: buffer.subarray(dataStart, Math.min(dataEnd, dataStart + 8)),
			});
			paxPath = undefined;
			longName = undefined;
		}
		offset = dataStart + Math.ceil(size / BLOCK) * BLOCK;
	}
}

const ELF = [0x7f, 0x45, 0x4c, 0x46];
const MACH_O = [
	[0xfe, 0xed, 0xfa, 0xce], // 32 位大端
	[0xce, 0xfa, 0xed, 0xfe], // 32 位小端
	[0xfe, 0xed, 0xfa, 0xcf], // 64 位大端
	[0xcf, 0xfa, 0xed, 0xfe], // 64 位小端
	[0xca, 0xfe, 0xba, 0xbe], // 通用二进制
];
const SHEBANG = [0x23, 0x21];

const startsWith = (magic, bytes) => bytes.every((byte, index) => magic[index] === byte);

/**
 * 需要在 POSIX 上带 x 位的条目：shebang 脚本，或 ELF / Mach-O 原生可执行文件。
 * PE（MZ）只跑在 Windows，x 位无意义，保持 0644 以免制造无谓的改动。
 */
function isPosixExecutable(magic) {
	if (startsWith(magic, SHEBANG) || startsWith(magic, ELF)) return true;
	return MACH_O.some((bytes) => startsWith(magic, bytes));
}

/** 只有 bin/ 下的入口需要可执行位；bin/lib 之类被 import 的模块没有 shebang，自然落在外面。 */
function executableEntryMode({ name, magic }) {
	return name.startsWith(BIN_ROOT) && isPosixExecutable(magic) ? EXECUTABLE_MODE : undefined;
}

function writeMode(buffer, headerOffset, mode) {
	buffer.write(mode.toString(8).padStart(7, "0"), headerOffset + 100, "latin1");
	buffer[headerOffset + 107] = 0;
	// 校验和字段自身按 8 个空格参与计算，写回 "%06o\0 "。
	buffer.fill(0x20, headerOffset + 148, headerOffset + 156);
	let sum = 0;
	for (let index = 0; index < BLOCK; index++) sum += buffer[headerOffset + index];
	buffer.write(sum.toString(8).padStart(6, "0"), headerOffset + 148, "latin1");
	buffer[headerOffset + 154] = 0;
	buffer[headerOffset + 155] = 0x20;
}

function formatMode(mode) {
	return `0${mode.toString(8).padStart(3, "0")}`;
}

export function readTarballEntry(tarball, name) {
	const { buffer } = decode(tarball);
	let found;
	scanTarball(buffer, (entry) => {
		if (!found && entry.name === name) found = entry;
	});
	return found ? buffer.subarray(found.dataStart, found.dataEnd) : null;
}

/**
 * 把 bin/ 下应可执行的条目改成 0755，其余条目一个字节都不动。
 * 返回的 buffer 与输入同格式（.tgz 进 .tgz 出）；没有改动时原样返回，便于「幂等即无需重写」。
 */
export function normalizeNpmTarball(tarball) {
	const { compressed, buffer } = decode(tarball);
	const patches = [];
	scanTarball(buffer, (entry) => {
		if (entry.type !== FILE_TYPE) return;
		const mode = executableEntryMode(entry);
		if (mode === undefined || mode === entry.mode) return;
		patches.push({ name: entry.name, from: entry.mode, to: mode, headerOffset: entry.headerOffset });
	});
	if (!patches.length) return { buffer: tarball, changes: [] };
	const patched = Buffer.from(buffer);
	for (const patch of patches) writeMode(patched, patch.headerOffset, patch.to);
	return {
		buffer: compressed ? gzipSync(patched) : patched,
		changes: patches.map(({ name, from, to }) => ({ name, from, to })),
	};
}

/**
 * 复查一个「即将发布 / 已经发布」的 tarball：声明的 bin 必须存在、有 shebang、权限 0755。
 * 只看包内 package.json，不看工作区 —— 要检的是用户实际拿到的那份。
 */
export function inspectNpmTarball(tarball) {
	const { buffer } = decode(tarball);
	const entries = [];
	scanTarball(buffer, (entry) => entries.push(entry));
	const byName = new Map(entries.map((entry) => [entry.name, entry]));
	const problems = new Set();
	const bins = [];

	const manifest = byName.get("package/package.json");
	if (!manifest) problems.add("包里没有 package/package.json");
	else {
		const pkg = JSON.parse(buffer.subarray(manifest.dataStart, manifest.dataEnd).toString("utf8"));
		const declared = typeof pkg.bin === "string" ? { [pkg.name]: pkg.bin } : (pkg.bin ?? {});
		for (const [command, target] of Object.entries(declared)) {
			const path = String(target).replace(/^\.?\//, "");
			const entry = byName.get(`package/${path}`);
			bins.push({ command, path, mode: entry?.mode });
			if (!entry) problems.add(`bin "${command}" 指向的 ${path} 不在包里`);
			else if (!startsWith(entry.magic, SHEBANG))
				problems.add(`bin "${command}" 指向的 ${path} 没有 shebang（装成全局命令后必然执行失败）`);
			else if (entry.mode !== EXECUTABLE_MODE)
				problems.add(`bin "${command}" 指向的 ${path} 权限是 ${formatMode(entry.mode)}，缺可执行位`);
		}
	}

	for (const entry of entries) {
		if (entry.type !== FILE_TYPE || entry.mode === EXECUTABLE_MODE) continue;
		if (executableEntryMode(entry) === undefined) continue;
		problems.add(`${entry.name} 是入口脚本 / 原生可执行文件，权限是 ${formatMode(entry.mode)}（应为 0755）`);
	}

	return { bins, problems: [...problems] };
}

/** 人类可读的复查报告：谁被改了、声明的 bin 现在是什么权限、有没有问题。 */
export function describeNpmTarball({ changes = [], inspection }) {
	const lines = changes.map((change) => `  ${change.name} ${formatMode(change.from)} → ${formatMode(change.to)}`);
	for (const bin of inspection.bins) {
		lines.push(`  ${bin.command.padEnd(12)} ${bin.path} ${bin.mode === undefined ? "（缺失）" : formatMode(bin.mode)}`);
	}
	for (const problem of inspection.problems) lines.push(`  ✗ ${problem}`);
	return lines;
}
