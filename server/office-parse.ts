import { inflateRawSync } from "node:zlib";
import type { PptxSlideImagePayload, PptxSlidePayload } from "./protocol.js";

const OFFICE_EXTS = new Set([".docx", ".xlsx", ".xlsm", ".pptx", ".pptm", ".ppsx", ".potx"]);

export const OFFICE_MAX_FILE_BYTES = 15 * 1024 * 1024;
export const OFFICE_MAX_UNCOMPRESSED_BYTES = 64 * 1024 * 1024;
export const OFFICE_MAX_TEXT_CHARS = 200_000;
const MAX_ROWS = 500;
const MAX_COLS = 20;

export function isOfficeFile(name: string): boolean {
	const dot = String(name ?? "")
		.toLowerCase()
		.lastIndexOf(".");
	const ext = dot > 0 ? String(name).toLowerCase().slice(dot) : "";
	return OFFICE_EXTS.has(ext);
}

function findEocd(buf: Buffer): number {
	const sig = 0x06054b50;
	const minLen = 22;
	if (buf.length < minLen) throw new Error("不是有效的 zip 文件（太小）");
	const start = Math.max(0, buf.length - 65536 - minLen);
	for (let i = buf.length - minLen; i >= start; i--) {
		if (buf.readUInt32LE(i) === sig) return i;
	}
	throw new Error("不是有效的 zip 文件（找不到 EOCD）");
}

export function unzipFiles(buf: Buffer, wanted: string[]): Map<string, Buffer> {
	const want = new Set(wanted);
	const eocd = findEocd(buf);
	const cdCount = buf.readUInt16LE(eocd + 10);
	const cdOffset = buf.readUInt32LE(eocd + 16);
	const files = new Map<
		string,
		{ method: number; compSize: number; flag: number; localOffset: number; uncompSize: number }
	>();
	let p = cdOffset;
	for (let i = 0; i < cdCount; i++) {
		if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("zip 中央目录损坏");
		const flag = buf.readUInt16LE(p + 8);
		const method = buf.readUInt16LE(p + 10);
		const compSize = buf.readUInt32LE(p + 20);
		const uncompSize = buf.readUInt32LE(p + 24);
		const nameLen = buf.readUInt16LE(p + 28);
		const extraLen = buf.readUInt16LE(p + 30);
		const commentLen = buf.readUInt16LE(p + 32);
		const localOffset = buf.readUInt32LE(p + 42);
		const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
		if (want.has(name)) files.set(name, { method, compSize, flag, localOffset, uncompSize });
		p += 46 + nameLen + extraLen + commentLen;
	}
	let totalUncomp = 0;
	const out = new Map<string, Buffer>();
	for (const [name, meta] of files) {
		if (meta.uncompSize > OFFICE_MAX_UNCOMPRESSED_BYTES) {
			throw new Error("解包后内容过大（疑似 zip 炸弹），拒绝预览");
		}
		const lp = meta.localOffset;
		if (buf.readUInt32LE(lp) !== 0x04034b50) throw new Error(`zip 局部头损坏：${name}`);
		const lMethod = buf.readUInt16LE(lp + 8);
		const lNameLen = buf.readUInt16LE(lp + 26);
		const lExtraLen = buf.readUInt16LE(lp + 28);
		const dataStart = lp + 30 + lNameLen + lExtraLen;
		const raw = buf.subarray(dataStart, dataStart + meta.compSize);
		if (meta.flag & 0x1) throw new Error(`不支持加密 zip 条目：${name}`);
		const method = lMethod || meta.method;
		let decompressed: Buffer;
		if (method === 0) {
			decompressed = Buffer.from(raw);
		} else if (method === 8) {
			const remainingQuota = OFFICE_MAX_UNCOMPRESSED_BYTES - totalUncomp;
			if (remainingQuota <= 0) throw new Error("解包后内容过大（疑似 zip 炸弹），拒绝预览");
			try {
				decompressed = Buffer.from(inflateRawSync(raw, { maxOutputLength: remainingQuota }));
			} catch (err) {
				if (
					(err as Error).message?.includes("maxOutputLength") ||
					(err as { code?: string }).code === "ERR_BUFFER_TOO_LARGE"
				) {
					throw new Error("解包后内容过大（疑似 zip 炸弹），拒绝预览");
				}
				throw err;
			}
		} else {
			throw new Error(`不支持的压缩方式 ${method}：${name}`);
		}
		totalUncomp += decompressed.length;
		if (totalUncomp > OFFICE_MAX_UNCOMPRESSED_BYTES) {
			throw new Error("解包后内容过大（疑似 zip 炸弹），拒绝预览");
		}
		out.set(name, decompressed);
	}
	return out;
}

export function listZipEntries(buf: Buffer): string[] {
	const eocd = findEocd(buf);
	const cdCount = buf.readUInt16LE(eocd + 10);
	const cdOffset = buf.readUInt32LE(eocd + 16);
	const names: string[] = [];
	let p = cdOffset;
	for (let i = 0; i < cdCount; i++) {
		if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("zip 中央目录损坏");
		const nameLen = buf.readUInt16LE(p + 28);
		const extraLen = buf.readUInt16LE(p + 30);
		const commentLen = buf.readUInt16LE(p + 32);
		const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
		names.push(name);
		p += 46 + nameLen + extraLen + commentLen;
	}
	return names;
}

const NAMED_ENTITIES: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

function decodeEntities(s: string): string {
	return String(s ?? "").replace(
		/&(?:#([0-9]+);|#x([0-9a-fA-F]+);|([a-zA-Z]+);)/g,
		(_whole, dec: string | undefined, hex: string | undefined, name: string | undefined) => {
			if (dec !== undefined) {
				try {
					return String.fromCodePoint(Number(dec));
				} catch {
					return "";
				}
			}
			if (hex !== undefined) {
				try {
					return String.fromCodePoint(Number.parseInt(hex, 16));
				} catch {
					return "";
				}
			}
			return NAMED_ENTITIES[name ?? ""] ?? _whole;
		},
	);
}

const stripTags = (s: string): string => decodeEntities(String(s ?? "").replace(/<[^>]+>/g, ""));

const DOCX_MAX_XML_BYTES = 20 * 1024 * 1024;

export function parseDocxParagraphs(buf: Buffer): string[] {
	const files = unzipFiles(buf, ["word/document.xml"]);
	const xml = files.get("word/document.xml")?.toString("utf8");
	if (!xml) throw new Error("docx 里找不到 word/document.xml");
	if (xml.length > DOCX_MAX_XML_BYTES) {
		throw new Error(
			`文档内容过大（document.xml 解压后 ${(xml.length / 1048576).toFixed(1)} MB，上限 20 MB），拒绝预览`,
		);
	}
	const opens = xml.match(/<w:p[\s>]/g)?.length ?? 0;
	const closes = xml.match(/<\/w:p>/g)?.length ?? 0;
	if (opens > 0 && closes === 0) {
		throw new Error("文档结构异常（段落标签大量未闭合），疑似恶意文档，拒绝预览");
	}
	const paragraphs: string[] = [];
	for (const m of xml.matchAll(/<w:p[\s>][\s\S]*?<\/w:p>/g)) {
		const pXml = m[0];
		let text = "";
		for (const n of pXml.matchAll(/<w:(t|tab|br)[^>]*\/?>([^<]*)(?:<\/w:t>)?/g)) {
			if (n[1] === "tab") text += "\t";
			else if (n[1] === "br") text += "\n";
			else text += decodeEntities(n[2]);
		}
		paragraphs.push(text);
	}
	while (
		paragraphs.length > 1 &&
		paragraphs[paragraphs.length - 1] === "" &&
		paragraphs[paragraphs.length - 2] === ""
	) {
		paragraphs.pop();
	}
	return paragraphs;
}

function colLettersToIndex(letters: string): number {
	let n = 0;
	for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
	return n - 1;
}

function splitCellRef(ref: string): { col: number; row: number } | null {
	const m = /^([A-Za-z]+)(\d+)$/.exec(String(ref ?? "").trim());
	if (!m) return null;
	return { col: colLettersToIndex(m[1]), row: Number(m[2]) - 1 };
}

function parseSharedStrings(xml: string | undefined): string[] {
	if (!xml) return [];
	const out: string[] = [];
	for (const m of xml.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
		const texts = [...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => decodeEntities(x[1]));
		out.push(texts.join(""));
	}
	return out;
}

export interface XlsxSheet {
	name: string;
	nRows: number;
	nCols: number;
	rows: string[][];
	truncated: boolean;
}

const MAX_PARSE_ROWS = 1000;
const MAX_PARSE_COLS = 100;

function parseSheet(xml: string, shared: string[]): { rows: string[][]; nRows: number; nCols: number } {
	const rows: string[][] = [];
	let maxRowSeen = 0;
	let maxColSeen = 0;
	for (const m of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
		const rowAttr = m[0].slice(0, m[0].indexOf(">"));
		const rawRNum = /r="(\d+)"/.exec(rowAttr)?.[1];
		const rNum = rawRNum ? Number(rawRNum) - 1 : rows.length;
		if (!Number.isFinite(rNum) || rNum < 0) continue;
		maxRowSeen = Math.max(maxRowSeen, rNum + 1);

		if (rNum >= MAX_PARSE_ROWS) continue;

		while (rows.length <= rNum) rows.push([]);
		const row = rows[rNum];
		for (const c of m[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
			const attrs = c[1];
			const ref = /r="([^"]+)"/.exec(attrs)?.[1];
			const t = /t="([^"]+)"/.exec(attrs)?.[1];
			const pos = splitCellRef(ref ?? "");
			if (!pos || pos.col < 0) continue;
			maxColSeen = Math.max(maxColSeen, pos.col + 1);

			if (pos.col >= MAX_PARSE_COLS) continue;

			const inner = c[2];
			let val = "";
			if (t === "inlineStr") {
				val = [...inner.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => decodeEntities(x[1])).join("");
			} else if (t === "s") {
				const idx = Number(stripTags(/<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? ""));
				val = Number.isFinite(idx) && shared[idx] !== undefined ? shared[idx] : "";
			} else if (t === "b") {
				val = stripTags(/<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? "") === "1" ? "TRUE" : "FALSE";
			} else {
				val = stripTags(/<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? "");
				if (!val) val = stripTags(inner);
			}
			while (row.length <= pos.col) row.push("");
			row[pos.col] = val;
		}
	}
	return {
		rows,
		nRows: Math.max(rows.length, maxRowSeen),
		nCols: Math.max(Math.max(0, ...rows.map((r) => r.length)), maxColSeen),
	};
}

export function parseXlsxSheets(buf: Buffer): XlsxSheet[] {
	const probe = unzipFiles(buf, ["xl/workbook.xml", "xl/_rels/workbook.xml.rels"]);
	const wbXml = probe.get("xl/workbook.xml")?.toString("utf8") ?? "";
	const relsXml = probe.get("xl/_rels/workbook.xml.rels")?.toString("utf8") ?? "";
	const relTarget = new Map<string, string>();
	for (const m of relsXml.matchAll(/<Relationship\b[^>]*>/g)) {
		const id = /Id="([^"]+)"/.exec(m[0])?.[1];
		const target = /Target="([^"]+)"/.exec(m[0])?.[1];
		if (id && target) relTarget.set(id, target.replace(/^\/+/, "").replace(/^xl\//, ""));
	}
	const sheetDefs: { name: string; rid: string | undefined }[] = [];
	for (const m of wbXml.matchAll(/<sheet\b[^>]*\/>/g)) {
		const name = /name="([^"]*)"/.exec(m[0])?.[1] ?? `Sheet${sheetDefs.length + 1}`;
		const rid = /r:id="([^"]+)"/.exec(m[0])?.[1];
		sheetDefs.push({ name: decodeEntities(name), rid });
	}
	let targets = sheetDefs.map((d, i) => {
		const t = d.rid && relTarget.get(d.rid);
		return { name: d.name, file: t ? `xl/${t}` : `xl/worksheets/sheet${i + 1}.xml` };
	});
	if (targets.length === 0) targets = [{ name: "Sheet1", file: "xl/worksheets/sheet1.xml" }];

	const files = unzipFiles(buf, ["xl/sharedStrings.xml", ...targets.map((t) => t.file)]);
	const shared = parseSharedStrings(files.get("xl/sharedStrings.xml")?.toString("utf8"));
	return targets.map((t) => {
		const xml = files.get(t.file)?.toString("utf8");
		const parsed = xml ? parseSheet(xml, shared) : { rows: [], nRows: 0, nCols: 0 };
		const fullCols = parsed.nCols;
		const fullRows = parsed.nRows;
		const nCols = Math.min(MAX_COLS, fullCols);
		const cut = parsed.rows.slice(0, MAX_ROWS).map((r) => {
			const row = r.slice(0, MAX_COLS);
			while (row.length < nCols) row.push("");
			return row;
		});
		return {
			name: t.name,
			nRows: fullRows,
			nCols: fullCols,
			rows: cut,
			truncated: fullRows > MAX_ROWS || fullCols > MAX_COLS,
		};
	});
}

const mdCell = (s: string): string =>
	String(s ?? "")
		.replace(/\|/g, "\\|")
		.replace(/\r?\n/g, " ");

function colName(i: number): string {
	let s = "";
	let n = i;
	do {
		s = String.fromCharCode(65 + (n % 26)) + s;
		n = Math.floor(n / 26) - 1;
	} while (n >= 0);
	return s;
}

export const PPTX_MAX_SLIDES = 500;

export type PptxSlideImage = PptxSlideImagePayload;
export type PptxSlide = PptxSlidePayload;

interface ShapePara {
	text: string;
	lvl: number;
	isBullet: boolean;
}

function extractShapePlainText(spXml: string): string {
	const parts: string[] = [];
	for (const m of spXml.matchAll(/<a:(t|tab|br)\b[^>]*\/?>([^<]*)(?:<\/a:t>)?/g)) {
		if (m[1] === "tab") parts.push("\t");
		else if (m[1] === "br") parts.push(" ");
		else parts.push(decodeEntities(m[2]));
	}
	return parts.join("").trim();
}

function extractShapeParagraphs(spXml: string, isBodyPlaceholder = false): ShapePara[] {
	const out: ShapePara[] = [];
	for (const pMatch of spXml.matchAll(/<a:p\b[\s\S]*?<\/a:p>/g)) {
		const pXml = pMatch[0];
		const pPr = /<a:pPr\b([^>]*)>([\s\S]*?)<\/a:pPr>|<a:pPr\b([^>]*)\/>/.exec(pXml);
		let lvl = 0;
		let hasBuNone = false;
		let hasBuChar = false;
		let hasBuAutoNum = false;
		if (pPr) {
			const attrs = pPr[1] ?? pPr[3] ?? "";
			const inner = pPr[2] ?? "";
			const lvlMatch = /\blvl=["'](\d+)["']/.exec(attrs);
			if (lvlMatch) lvl = Number(lvlMatch[1]);
			hasBuNone = /<a:buNone\b/.test(inner);
			hasBuChar = /<a:buChar\b/.test(inner);
			hasBuAutoNum = /<a:buAutoNum\b/.test(inner);
		}
		const isBullet = !hasBuNone && (hasBuChar || hasBuAutoNum || lvl > 0 || isBodyPlaceholder);

		let text = "";
		for (const m of pXml.matchAll(/<a:(t|tab|br)\b[^>]*\/?>([^<]*)(?:<\/a:t>)?/g)) {
			if (m[1] === "tab") text += "\t";
			else if (m[1] === "br") text += "\n";
			else text += decodeEntities(m[2]);
		}
		text = text.trim();
		if (text) {
			out.push({ text, lvl, isBullet });
		}
	}
	return out;
}

function parseTable(tblXml: string): string[][] {
	const rows: string[][] = [];
	for (const trMatch of tblXml.matchAll(/<a:tr\b[^>]*>([\s\S]*?)<\/a:tr>/g)) {
		const rowXml = trMatch[1];
		const row: string[] = [];
		for (const tcMatch of rowXml.matchAll(/<a:tc\b[^>]*>([\s\S]*?)<\/a:tc>/g)) {
			const cellXml = tcMatch[1];
			const cellText: string[] = [];
			for (const m of cellXml.matchAll(/<a:(t|tab|br)\b[^>]*\/?>([^<]*)(?:<\/a:t>)?/g)) {
				if (m[1] === "tab") cellText.push("\t");
				else if (m[1] === "br") cellText.push(" ");
				else cellText.push(decodeEntities(m[2]));
			}
			row.push(cellText.join("").trim());
		}
		if (row.length > 0) rows.push(row);
	}
	return rows;
}

function tableToMarkdown(rows: string[][]): string {
	if (rows.length === 0) return "";
	const colCount = Math.max(...rows.map((r) => r.length));
	if (colCount === 0) return "";
	const pad = (r: string[]): string[] => {
		const row = r.slice(0, colCount);
		while (row.length < colCount) row.push("");
		return row;
	};
	const headerRow = pad(rows[0]);
	const separatorRow = Array(colCount).fill("---");
	const dataRows = rows.slice(1).map(pad);
	const lines = [headerRow, separatorRow, ...dataRows].map((r) => `| ${r.map(mdCell).join(" | ")} |`);
	return lines.join("\n");
}

function slideToMarkdown(slide: PptxSlide): string {
	const titlePart = slide.title ? `：${slide.title}` : "";
	const head = `## 幻灯片 ${slide.index}${titlePart}`;
	const bodyParts: string[] = [];
	if (slide.subtitle) {
		bodyParts.push(`*${slide.subtitle}*`);
	}
	if (slide.images && slide.images.length > 0) {
		for (const img of slide.images) {
			bodyParts.push(`🖼️ **图片**：${img.descr || img.media}`);
		}
	}
	if (slide.paragraphs.length > 0) {
		bodyParts.push(slide.paragraphs.join("\n"));
	}
	if (slide.tables && slide.tables.length > 0) {
		for (const tbl of slide.tables) {
			const mdTbl = tableToMarkdown(tbl);
			if (mdTbl) bodyParts.push(mdTbl);
		}
	}
	if (slide.notes) {
		bodyParts.push(`> 💡 **备注**：${slide.notes}`);
	}
	if (bodyParts.length === 0) {
		return `${head}\n\n（空幻灯片）`;
	}
	return `${head}\n\n${bodyParts.join("\n\n")}`;
}

export function parsePptxSlides(buf: Buffer): PptxSlide[] {
	const allEntries = new Set(listZipEntries(buf));
	const probeTargets = ["ppt/presentation.xml", "ppt/_rels/presentation.xml.rels"].filter((n) => allEntries.has(n));
	const probe = unzipFiles(buf, probeTargets);
	const presXml = probe.get("ppt/presentation.xml")?.toString("utf8") ?? "";
	const relsXml = probe.get("ppt/_rels/presentation.xml.rels")?.toString("utf8") ?? "";

	const relTarget = new Map<string, string>();
	for (const m of relsXml.matchAll(/<Relationship\b[^>]*>/gi)) {
		const id = /\bId=["']([^"']+)["']/i.exec(m[0])?.[1];
		const target = /\bTarget=["']([^"']+)["']/i.exec(m[0])?.[1];
		if (id && target) {
			const clean = target
				.replace(/\\/g, "/")
				.replace(/^\/+/, "")
				.replace(/^ppt\//, "");
			relTarget.set(id, clean);
		}
	}

	const slideRids: string[] = [];
	for (const m of presXml.matchAll(/<[a-zA-Z0-9:]*sldId\b[^>]*\br:id=["']([^"']+)["']/gi)) {
		slideRids.push(m[1]);
	}

	let slideTargets = slideRids
		.map((rid) => relTarget.get(rid))
		.filter((t): t is string => Boolean(t))
		.map((t) => (t.startsWith("ppt/") ? t : `ppt/${t}`));

	if (slideTargets.length === 0) {
		for (const m of relsXml.matchAll(/<Relationship\b[^>]*>/gi)) {
			const type = /\bType=["']([^"']+)["']/i.exec(m[0])?.[1] ?? "";
			const target = /\bTarget=["']([^"']+)["']/i.exec(m[0])?.[1] ?? "";
			if (type.endsWith("/slide") || target.includes("slides/slide")) {
				const clean = target
					.replace(/\\/g, "/")
					.replace(/^\/+/, "")
					.replace(/^ppt\//, "");
				slideTargets.push(clean.startsWith("ppt/") ? clean : `ppt/${clean}`);
			}
		}
		slideTargets.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
	}

	if (slideTargets.length === 0) {
		slideTargets = Array.from(allEntries)
			.filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
			.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
	}

	if (slideTargets.length === 0) {
		throw new Error("PPTX 文件中未找到幻灯片内容");
	}

	const cappedSlideTargets = slideTargets.slice(0, PPTX_MAX_SLIDES);

	const slideRelsMap = new Map<string, Map<string, string>>();
	const slideToNotes = new Map<string, string>();
	const slideRelsToFetch: string[] = [];
	for (const st of cappedSlideTargets) {
		const base = st.split("/").pop();
		const relsName = `ppt/slides/_rels/${base}.rels`;
		if (allEntries.has(relsName)) slideRelsToFetch.push(relsName);
	}
	if (slideRelsToFetch.length > 0) {
		const slideRelsData = unzipFiles(buf, slideRelsToFetch);
		for (const [relsPath, relsBuf] of slideRelsData) {
			const xml = relsBuf.toString("utf8");
			const rMap = new Map<string, string>();
			const base = relsPath
				.split("/")
				.pop()
				?.replace(/\.rels$/, "");
			const slideTarget = cappedSlideTargets.find((st) => st.endsWith(`/${base}`));
			for (const m of xml.matchAll(/<Relationship\b[^>]*>/gi)) {
				const id = /\bId=["']([^"']+)["']/i.exec(m[0])?.[1];
				const target = /\bTarget=["']([^"']+)["']/i.exec(m[0])?.[1];
				const type = /\bType=["']([^"']+)["']/i.exec(m[0])?.[1] ?? "";
				if (id && target) {
					rMap.set(id, target);
				}
				if ((type.endsWith("/notesSlide") || target?.includes("notesSlide")) && target && slideTarget) {
					const clean = target
						.replace(/\\/g, "/")
						.replace(/^\.\.\//, "")
						.replace(/^ppt\//, "");
					const fullNotesPath = clean.startsWith("ppt/") ? clean : `ppt/${clean}`;
					if (allEntries.has(fullNotesPath)) {
						slideToNotes.set(slideTarget, fullNotesPath);
					}
				}
			}
			if (slideTarget) slideRelsMap.set(slideTarget, rMap);
		}
	}

	const filesToUnzip = [...cappedSlideTargets, ...Array.from(new Set(slideToNotes.values()))];
	const unzipped = unzipFiles(buf, filesToUnzip);

	const slides: PptxSlide[] = [];
	for (let i = 0; i < cappedSlideTargets.length; i++) {
		const target = cappedSlideTargets[i];
		const slideXml = unzipped.get(target)?.toString("utf8") ?? "";
		if (!slideXml) continue;

		if (slideXml.length > DOCX_MAX_XML_BYTES) {
			throw new Error(`幻灯片内容过大（解压后 ${(slideXml.length / 1048576).toFixed(1)} MB，上限 20 MB），拒绝预览`);
		}

		let title = "";
		let titleShapeXml: string | null = null;
		let subtitle: string | undefined;

		for (const spMatch of slideXml.matchAll(/<p:sp\b[\s\S]*?<\/p:sp>/g)) {
			const sp = spMatch[0];
			if (!title && /<p:ph\b[^>]*\btype=["'](?:title|ctrTitle)["']/i.test(sp)) {
				const text = extractShapePlainText(sp);
				if (text) {
					title = text;
					titleShapeXml = sp;
				}
			} else if (!subtitle && /<p:ph\b[^>]*\btype=["']subTitle["']/i.test(sp)) {
				const text = extractShapePlainText(sp);
				if (text) {
					subtitle = text;
				}
			}
		}

		if (!title) {
			for (const spMatch of slideXml.matchAll(/<p:sp\b[\s\S]*?<\/p:sp>/g)) {
				const sp = spMatch[0];
				const isTitle =
					/<p:ph\b(?![^>]*type=)(?:[^>]*idx=["']0["'])?/i.test(sp) ||
					/<p:cNvPr\b[^>]*name=["'][^"']*(?:Title|标题)/i.test(sp);
				if (isTitle) {
					const text = extractShapePlainText(sp);
					if (text && text.length <= 120) {
						title = text;
						titleShapeXml = sp;
						break;
					}
				}
			}
		}

		if (!title) {
			for (const spMatch of slideXml.matchAll(/<p:sp\b[\s\S]*?<\/p:sp>/g)) {
				const sp = spMatch[0];
				if (/<p:ph\b[^>]*type=["'](?:sldNum|dt|ftr)["']/i.test(sp)) continue;
				const paras = extractShapeParagraphs(sp);
				if (paras.length === 1 && paras[0].text.length <= 60 && !paras[0].isBullet) {
					title = paras[0].text;
					titleShapeXml = sp;
					break;
				}
				if (paras.length > 0) break;
			}
		}

		const paragraphs: string[] = [];
		const tables: string[][][] = [];
		const images: PptxSlideImage[] = [];

		const rMap = slideRelsMap.get(target);

		for (const picMatch of slideXml.matchAll(/<p:pic\b[\s\S]*?<\/p:pic>/gi)) {
			const pic = picMatch[0];
			const rEmbed = /<a:blip\b[^>]*r:embed=["']([^"']+)["']/i.exec(pic)?.[1];
			const imgTarget = rEmbed && rMap ? rMap.get(rEmbed) : null;
			if (imgTarget) {
				const media = imgTarget.replace(/\\/g, "/").split("/").pop() ?? "";
				if (media && /^image\d+\./i.test(media)) {
					const descr =
						/<p:cNvPr\b[^>]*descr=["']([^"']*)["']/i.exec(pic)?.[1] ||
						/<p:cNvPr\b[^>]*name=["']([^"']*)["']/i.exec(pic)?.[1];
					images.push({ media, descr: descr?.trim() || undefined });
				}
			}
		}

		let bg: string | undefined;
		const bgPrMatch = /<p:bgPr\b[\s\S]*?<a:srgbClr\b[^>]*val=["']([0-9a-fA-F]{6})["']/i.exec(slideXml);
		if (bgPrMatch) {
			bg = `#${bgPrMatch[1]}`;
		} else {
			const fullSp =
				/<p:sp\b[\s\S]*?<a:ext\b[^>]*cx=["'](?:12\d{6}|9\d{6})["'][\s\S]*?<a:srgbClr\b[^>]*val=["']([0-9a-fA-F]{6})["']/i.exec(
					slideXml,
				);
			if (fullSp) {
				bg = `#${fullSp[1]}`;
			}
		}

		for (const elemMatch of slideXml.matchAll(/<p:sp\b[\s\S]*?<\/p:sp>|<a:tbl\b[\s\S]*?<\/a:tbl>/g)) {
			const elem = elemMatch[0];
			if (elem.startsWith("<p:sp")) {
				if (elem === titleShapeXml) continue;
				if (/<p:ph\b[^>]*type=["'](?:sldNum|dt|ftr)["']/i.test(elem)) continue;
				const isBodyPlaceholder = /<p:ph\b[^>]*type=["']body["']/i.test(elem);
				const paras = extractShapeParagraphs(elem, isBodyPlaceholder);
				for (const p of paras) {
					if (p.isBullet) {
						const clean = p.text.replace(/^[\s•·\-*]+\s*/, "");
						paragraphs.push(`${"  ".repeat(p.lvl)}- ${clean}`);
					} else {
						paragraphs.push(p.text);
					}
				}
			} else if (elem.startsWith("<a:tbl")) {
				const tbl = parseTable(elem);
				if (tbl.length > 0) tables.push(tbl);
			}
		}

		let notes: string | undefined;
		const notesPath = slideToNotes.get(target);
		if (notesPath) {
			const notesXml = unzipped.get(notesPath)?.toString("utf8");
			if (notesXml) {
				for (const spMatch of notesXml.matchAll(/<p:sp\b[\s\S]*?<\/p:sp>/g)) {
					const sp = spMatch[0];
					if (/<p:ph\b[^>]*type=["']body["']/i.test(sp)) {
						const paras = extractShapeParagraphs(sp, false);
						const noteText = paras
							.map((p) => p.text)
							.join("\n")
							.trim();
						if (noteText) {
							notes = noteText;
							break;
						}
					}
				}
			}
		}

		slides.push({
			index: i + 1,
			title,
			subtitle,
			paragraphs,
			tables: tables.length > 0 ? tables : undefined,
			images: images.length > 0 ? images : undefined,
			notes,
			bg,
		});
	}

	return slides;
}

function sheetToMarkdown(sheet: XlsxSheet): string {
	const head = `## ${sheet.name}（${sheet.nRows} 行 × ${sheet.nCols} 列${sheet.truncated ? "，只看前一部分" : ""}）`;
	if (sheet.rows.length === 0) return `${head}\n\n（空表）`;
	const width = Math.max(1, ...sheet.rows.map((r) => r.length));
	const pad = (r: string[]): string[] => {
		const row = r.slice(0, width);
		while (row.length < width) row.push("");
		return row;
	};
	const lines = [Array.from({ length: width }, (_, i) => colName(i)), ...sheet.rows.map(pad)].map(
		(r) => `| ${r.map(mdCell).join(" | ")} |`,
	);
	lines.splice(1, 0, `| ${Array(width).fill("---").join(" | ")} |`);
	return [head, "", ...lines].join("\n");
}

export interface OfficeExtractResult {
	text: string;
	truncated: boolean;
	slides?: PptxSlide[];
}

export function extractOfficeText(filename: string, buf: Buffer): OfficeExtractResult | null {
	const dot = String(filename ?? "")
		.toLowerCase()
		.lastIndexOf(".");
	const ext = dot > 0 ? String(filename).toLowerCase().slice(dot) : "";
	if (!OFFICE_EXTS.has(ext)) return null;
	if (buf.length > OFFICE_MAX_FILE_BYTES) {
		throw new Error(`文件太大（${(buf.length / 1048576).toFixed(1)} MB），Office 预览上限 15 MB`);
	}
	let text: string;
	let truncated = false;
	let slides: PptxSlide[] | undefined;
	if (ext === ".docx") {
		const paras = parseDocxParagraphs(buf);
		text = paras.join("\n");
		truncated = text.length > OFFICE_MAX_TEXT_CHARS;
	} else if (ext === ".pptx" || ext === ".pptm" || ext === ".ppsx" || ext === ".potx") {
		slides = parsePptxSlides(buf);
		text = slides.map(slideToMarkdown).join("\n\n---\n\n");
		truncated = text.length > OFFICE_MAX_TEXT_CHARS || slides.length >= PPTX_MAX_SLIDES;
	} else {
		const sheets = parseXlsxSheets(buf);
		text = sheets.map(sheetToMarkdown).join("\n\n");
		truncated = text.length > OFFICE_MAX_TEXT_CHARS || sheets.some((s) => s.truncated);
	}
	if (text.length > OFFICE_MAX_TEXT_CHARS) text = text.slice(0, OFFICE_MAX_TEXT_CHARS);
	return { text, truncated, slides };
}
