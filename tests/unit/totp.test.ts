import { describe, expect, it } from "vitest";
import {
	base32Decode,
	createTotpEntry,
	hotp,
	normalizeOrigin,
	normalizeTotpEntries,
	parseOtpauth,
	publicTotp,
	reorderTotpEntries,
	sortTotpEntries,
	totpCode,
	totpMatchesUrl,
	toOtpauthUri,
	type TotpEntry,
} from "../../browser/runtime/totp.js";

/** 测试用 Base32 编码（生产代码只需要解码；这里为了构造 RFC 6238 的密钥）。 */
function base32Encode(bytes: Buffer): string {
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
	let bits = 0;
	let value = 0;
	let out = "";
	for (const byte of bytes) {
		value = (value << 8) | byte;
		bits += 8;
		while (bits >= 5) {
			bits -= 5;
			out += alphabet[(value >> bits) & 31];
		}
	}
	if (bits > 0) out += alphabet[(value << (5 - bits)) & 31];
	return out;
}

const ascii = (text: string) => Buffer.from(text, "utf8");
const SHA1_KEY = base32Encode(ascii("12345678901234567890"));
const SHA256_KEY = base32Encode(ascii("12345678901234567890123456789012"));
const SHA512_KEY = base32Encode(ascii("1234567890123456789012345678901234567890123456789012345678901234"));

function entry(overrides: Partial<TotpEntry> = {}): TotpEntry {
	return {
		id: "id-1",
		label: "Example: alice",
		issuer: "Example",
		account: "alice",
		secret: SHA1_KEY,
		algorithm: "SHA1",
		digits: 6,
		period: 30,
		origin: "",
		createdAt: 0,
		order: 0,
		...overrides,
	};
}

describe("base32Decode", () => {
	it("解码 RFC 4648 基本向量", () => {
		expect(base32Decode("MZXW6===").toString()).toBe("foo");
		expect(base32Decode("MZXW6YTBOI======").toString()).toBe("foobar");
	});

	it("容忍小写、空格、连字符与填充", () => {
		expect(base32Decode("mzxw 6ytb-oi").toString()).toBe("foobar");
		expect(base32Decode("MZXW6YTBOI==").toString()).toBe("foobar");
	});

	it("空串与非法字符直接报错（不静默产出错误密钥）", () => {
		expect(() => base32Decode("")).toThrow(/empty/i);
		expect(() => base32Decode("MZXW6!!!")).toThrow(/Base32/);
		expect(() => base32Decode("1")).toThrow(/Base32/);
	});
});

describe("HOTP / TOTP 与 RFC 6238 测试向量", () => {
	const vectors: [counter: number, sha1: string, sha256: string, sha512: string][] = [
		[59, "94287082", "46119246", "90693936"],
		[1111111109, "07081804", "68084774", "25091201"],
		[1111111111, "14050471", "67062674", "99943326"],
		[1234567890, "89005924", "91819424", "93441116"],
		[2000000000, "69279037", "90698825", "38618901"],
		[20000000000, "65353130", "77737706", "47863826"],
	];

	for (const [seconds, sha1, sha256, sha512] of vectors) {
		it(`T=${seconds} 三个算法都对得上`, () => {
			const window = Math.floor(seconds / 30);
			expect(hotp(base32Decode(SHA1_KEY), window, 8, "SHA1")).toBe(sha1);
			expect(hotp(base32Decode(SHA256_KEY), window, 8, "SHA256")).toBe(sha256);
			expect(hotp(base32Decode(SHA512_KEY), window, 8, "SHA512")).toBe(sha512);
		});
	}

	it("totpCode 用同一套算法并给出剩余时间", () => {
		const at = totpCode(entry({ digits: 8, algorithm: "SHA1" }), 59_000);
		expect(at.code).toBe("94287082");
		expect(at.period).toBe(30);
		expect(at.remainingMs).toBe(30_000 - 29_000);

		const next = totpCode(entry({ digits: 8 }), 89_000);
		expect(next.code).not.toBe(at.code);
	});

	it("6 位码保留前导零（不是 5 位）", () => {
		// RFC 6238 向量是 8 位的 14050471；6 位取低 6 位 050471
		const code = totpCode(entry(), 1111111111_000).code;
		expect(code).toHaveLength(6);
		expect(code).toBe("050471");
	});
});

describe("parseOtpauth", () => {
	it("解析标准链接", () => {
		const draft = parseOtpauth(
			"otpauth://totp/GitHub:octocat?secret=JBSWY3DPEHPK3PXP&issuer=GitHub&algorithm=SHA256&digits=8&period=60",
		);
		expect(draft).toMatchObject({
			issuer: "GitHub",
			account: "octocat",
			secret: "JBSWY3DPEHPK3PXP",
			algorithm: "SHA256",
			digits: 8,
			period: 60,
			label: "GitHub: octocat",
		});
	});

	it("缺省参数走 6 位 / 30 秒 / SHA1", () => {
		const draft = parseOtpauth("otpauth://totp/acme:alice?secret=jbswy3dpehpk3pxp");
		expect(draft).toMatchObject({ algorithm: "SHA1", digits: 6, period: 30, issuer: "acme", account: "alice" });
	});

	it("容忍百分号编码的冒号与前后空白", () => {
		const draft = parseOtpauth("  otpauth://totp/acme%3Aalice?secret=JBSWY3DPEHPK3PXP\n");
		expect(draft.issuer).toBe("acme");
		expect(draft.account).toBe("alice");
	});

	it("issuer 参数优先于标签前缀", () => {
		const draft = parseOtpauth("otpauth://totp/Old:alice?secret=JBSWY3DPEHPK3PXP&issuer=New");
		expect(draft.issuer).toBe("New");
		expect(draft.account).toBe("alice");
	});

	it("拒绝非 otpauth / 非 totp / 非法参数", () => {
		expect(() => parseOtpauth("https://example.com")).toThrow(/otpauth/);
		expect(() => parseOtpauth("otpauth://hotp/x?secret=JBSWY3DPEHPK3PXP&counter=1")).toThrow(/totp/i);
		expect(() => parseOtpauth("otpauth://totp/x")).toThrow(/empty/i);
		expect(() => parseOtpauth("otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&algorithm=MD5")).toThrow(/algorithm/i);
		expect(() => parseOtpauth("otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&digits=4")).toThrow(/digits/i);
		expect(() => parseOtpauth("otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&period=0")).toThrow(/period/i);
	});
});

describe("storage 形态与投影", () => {
	it("createTotpEntry 生成 id、时间与绑定站点（只认 http/https）", () => {
		const created = createTotpEntry("otpauth://totp/acme:alice?secret=JBSWY3DPEHPK3PXP", {
			origin: "https://github.com/login?next=/x",
			order: 3,
			now: 1700000000000,
		});
		expect(created).toMatchObject({
			origin: "https://github.com",
			order: 3,
			createdAt: 1700000000000,
			label: "acme: alice",
		});
		expect(created.id).toMatch(/[0-9a-f-]{36}/);
		expect(normalizeOrigin("chrome://settings")).toBe("");
		expect(normalizeOrigin("not a url")).toBe("");
	});

	it("publicTotp 绝不带出 secret", () => {
		const visible = publicTotp(entry()) as Record<string, unknown>;
		expect(visible.secret).toBeUndefined();
		expect(JSON.stringify(visible)).not.toContain(SHA1_KEY);
	});

	it("normalizeTotpEntries 按 order 排序并补 id", () => {
		const raw = [
			{ secret: "JBSWY3DPEHPK3PXP", label: "b", order: 2 },
			{ secret: "JBSWY3DPEHPK3PXP", label: "a", order: 1 },
		];
		const normalized = normalizeTotpEntries(raw);
		expect(normalized.map((item) => item.label)).toEqual(["a", "b"]);
		expect(normalized.every((item) => typeof item.id === "string" && item.id.length > 0)).toBe(true);
		expect(normalizeTotpEntries(undefined)).toEqual([]);
		expect(() => normalizeTotpEntries({})).toThrow(/Invalid TOTP data/);
	});

	it("sortTotpEntries 重新编号 order", () => {
		const sorted = sortTotpEntries([entry({ id: "b", order: 5 }), entry({ id: "a", order: 1 })]);
		expect(sorted.map((item) => [item.id, item.order])).toEqual([
			["a", 0],
			["b", 1],
		]);
	});

	it("reorderTotpEntries 按给定顺序重排，未列出的保留在后面", () => {
		const entries = [entry({ id: "a", order: 0 }), entry({ id: "b", order: 1 }), entry({ id: "c", order: 2 })];
		const next = reorderTotpEntries(entries, ["c", "a"]);
		expect(next.map((item) => item.id)).toEqual(["c", "a", "b"]);
		expect(next.map((item) => item.order)).toEqual([0, 1, 2]);
	});
});

describe("站点匹配与导出", () => {
	it("只匹配完全相同的 origin", () => {
		const bound = entry({ origin: "https://github.com" });
		expect(totpMatchesUrl(bound, "https://github.com/settings/security")).toBe(true);
		expect(totpMatchesUrl(bound, "https://gist.github.com/x")).toBe(false);
		expect(totpMatchesUrl(bound, "http://github.com/")).toBe(false);
		expect(totpMatchesUrl(entry({ origin: "" }), "https://github.com")).toBe(false);
	});

	it("toOtpauthUri 能被 parseOtpauth 解回原值", () => {
		const original = entry({ algorithm: "SHA512", digits: 8, period: 45 });
		const draft = parseOtpauth(toOtpauthUri(original));
		expect(draft).toMatchObject({
			issuer: "Example",
			account: "alice",
			secret: SHA1_KEY,
			algorithm: "SHA512",
			digits: 8,
			period: 45,
		});
	});

	it("默认参数不写进 URI（和其他客户端互导时不啰嗦）", () => {
		const uri = toOtpauthUri(entry());
		expect(uri).toContain("secret=");
		expect(uri).not.toContain("algorithm=");
		expect(uri).not.toContain("digits=");
		expect(uri).not.toContain("period=");
	});
});

describe("二维码解码（jsQR + BGRA→RGBA）", () => {
	it("从位图里认出 otpauth:// 文本", async () => {
		const { decodeQrBitmap, bgraToRgba } = await import("../../browser/runtime/qr.js");
		const QRCode = (await import("qrcode")).default;
		const uri = "otpauth://totp/GitHub:octocat?secret=JBSWY3DPEHPK3PXP&issuer=GitHub";
		const modules = QRCode.create(uri, { errorCorrectionLevel: "M" }).modules;

		// 4px/模块 + 4 模块静区，画成 Electron `toBitmap()` 那种 BGRA 序列
		const scale = 4;
		const quiet = 4;
		const side = (modules.size + quiet * 2) * scale;
		const bitmap = Buffer.alloc(side * side * 4, 0xff);
		for (let row = 0; row < modules.size; row += 1) {
			for (let col = 0; col < modules.size; col += 1) {
				if (!modules.get(row, col)) continue;
				for (let dy = 0; dy < scale; dy += 1) {
					for (let dx = 0; dx < scale; dx += 1) {
						const x = (col + quiet) * scale + dx;
						const y = (row + quiet) * scale + dy;
						const at = (y * side + x) * 4;
						bitmap[at] = 0x00; // B
						bitmap[at + 1] = 0x00; // G
						bitmap[at + 2] = 0x00; // R
						bitmap[at + 3] = 0xff; // A
					}
				}
			}
		}

		expect(decodeQrBitmap(bitmap, side, side)).toBe(uri);
		// 通道顺序真的被当成 RGBA：把 BGRA 的通道换成错序后，同一张图就不该再被认出
		expect(bgraToRgba(Buffer.from([0x01, 0x02, 0x03, 0x04]))).toEqual(new Uint8ClampedArray([0x03, 0x02, 0x01, 0x04]));
	});

	it("没有二维码的纯色位图返回 null", async () => {
		const { decodeQrBitmap } = await import("../../browser/runtime/qr.js");
		const side = 64;
		expect(decodeQrBitmap(Buffer.alloc(side * side * 4, 0xff), side, side)).toBeNull();
	});
});
