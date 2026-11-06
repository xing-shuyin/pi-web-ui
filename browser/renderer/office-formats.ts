export interface OfficePreview {
	kind: "document" | "sheet" | "slides";
	paragraphs?: string[];
	sheets?: { name: string; rows: string[][] }[];
	slides?: string[][];
}
const maxSize = 32 * 1024 * 1024;
async function unzip(bytes: Uint8Array): Promise<Map<string, Uint8Array>> {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const files = new Map<string, Uint8Array>();
	if (bytes.length > maxSize) throw new Error("Office preview limit: 32 MB");
	let end = bytes.length - 22;
	for (; end >= Math.max(0, bytes.length - 65557); end--) if (view.getUint32(end, true) === 0x06054b50) break;
	if (end < Math.max(0, bytes.length - 65557)) throw new Error("Invalid Office archive");
	const count = view.getUint16(end + 10, true);
	let offset = view.getUint32(end + 16, true);
	let total = 0;
	if (count > 10000) throw new Error("Office archive contains too many entries");
	const decoder = new TextDecoder();
	for (let index = 0; index < count; index++) {
		if (offset + 46 > bytes.length || view.getUint32(offset, true) !== 0x02014b50)
			throw new Error("Invalid Office directory");
		const flags = view.getUint16(offset + 8, true);
		const method = view.getUint16(offset + 10, true);
		const compressed = view.getUint32(offset + 20, true);
		const expanded = view.getUint32(offset + 24, true);
		const nameLength = view.getUint16(offset + 28, true);
		const extraLength = view.getUint16(offset + 30, true);
		const commentLength = view.getUint16(offset + 32, true);
		const start = view.getUint32(offset + 42, true);
		const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
		offset += 46 + nameLength + extraLength + commentLength;
		if (
			!/^(word\/document\.xml|xl\/(workbook\.xml|_rels\/workbook\.xml\.rels|sharedStrings\.xml|worksheets\/sheet\d+\.xml)|ppt\/slides\/slide\d+\.xml)$/.test(
				name,
			)
		)
			continue;
		total += expanded;
		if (total > maxSize || expanded > maxSize || flags & 1)
			throw new Error("Office preview exceeds its size limit or is encrypted");
		if (start + 30 > bytes.length || view.getUint32(start, true) !== 0x04034b50)
			throw new Error("Invalid Office entry");
		const dataStart = start + 30 + view.getUint16(start + 26, true) + view.getUint16(start + 28, true);
		if (dataStart + compressed > bytes.length) throw new Error("Truncated Office archive");
		const data = bytes.slice(dataStart, dataStart + compressed);
		if (method === 0) files.set(name, data);
		else if (method === 8) {
			const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
			const reader = stream.getReader();
			const chunks: Uint8Array[] = [];
			let length = 0;
			try {
				for (;;) {
					const { value, done } = await reader.read();
					if (done) break;
					length += value.length;
					if (length > expanded || length > maxSize) throw new Error("Invalid Office entry size");
					chunks.push(value);
				}
			} finally {
				await reader.cancel();
			}
			const result = new Uint8Array(length);
			let cursor = 0;
			for (const chunk of chunks) {
				result.set(chunk, cursor);
				cursor += chunk.length;
			}
			files.set(name, result);
		}
	}
	return files;
}
function xml(bytes: Uint8Array | undefined): Document {
	const doc = new DOMParser().parseFromString(new TextDecoder().decode(bytes || new Uint8Array()), "application/xml");
	if (doc.querySelector("parsererror")) throw new Error("Invalid Office XML");
	return doc;
}
function nodes(parent: Document | Element, name: string): Element[] {
	return Array.from(parent.getElementsByTagNameNS("*", name));
}
function texts(parent: Document | Element): string {
	return nodes(parent, "t")
		.map((node) => node.textContent || "")
		.join("");
}
export async function readOfficePreview(base64: string, extension: string): Promise<OfficePreview> {
	if (base64.length > maxSize * 1.4) throw new Error("Office preview limit: 32 MB");
	const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
	const files = await unzip(bytes);
	if (extension === ".docx") {
		const doc = xml(files.get("word/document.xml"));
		return { kind: "document", paragraphs: nodes(doc, "p").slice(0, 20000).map(texts) };
	}
	if (extension === ".pptx") {
		const slides = [...files.keys()]
			.filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
			.sort((a, b) => Number(a.match(/slide(\d+)/)?.[1]) - Number(b.match(/slide(\d+)/)?.[1]));
		return {
			kind: "slides",
			slides: slides.slice(0, 300).map((name) =>
				nodes(xml(files.get(name)), "p")
					.map(texts)
					.filter(Boolean),
			),
		};
	}
	const strings = files.has("xl/sharedStrings.xml")
		? nodes(xml(files.get("xl/sharedStrings.xml")), "si").map(texts)
		: [];
	const workbook = xml(files.get("xl/workbook.xml"));
	const rels = xml(files.get("xl/_rels/workbook.xml.rels"));
	const targets = new Map(
		nodes(rels, "Relationship").map((rel) => [rel.getAttribute("Id"), rel.getAttribute("Target") || ""]),
	);
	const sheets = nodes(workbook, "sheet")
		.slice(0, 50)
		.map((sheet, index) => {
			const rel = sheet.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id");
			const target = targets.get(rel) || `worksheets/sheet${index + 1}.xml`;
			const path = target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//, "")}`;
			const doc = xml(files.get(path));
			const rows = nodes(doc, "row")
				.slice(0, 5000)
				.map((row) => {
					const result: string[] = [];
					for (const cell of nodes(row, "c")) {
						const letters = cell.getAttribute("r")?.match(/^[A-Z]+/)?.[0] || "A";
						const column = [...letters].reduce((value, letter) => value * 26 + letter.charCodeAt(0) - 64, 0) - 1;
						if (column > 255) continue;
						const value = nodes(cell, "v")[0]?.textContent || "";
						result[column] =
							cell.getAttribute("t") === "s"
								? strings[Number(value)] || ""
								: cell.getAttribute("t") === "inlineStr"
									? texts(cell)
									: value;
					}
					return Array.from({ length: result.length }, (_, i) => result[i] || "");
				});
			return { name: sheet.getAttribute("name") || `Sheet ${index + 1}`, rows };
		});
	return { kind: "sheet", sheets };
}
export function parseCsv(text: string, delimiter = ","): string[][] {
	const rows: string[][] = [];
	let row: string[] = [];
	let cell = "";
	let quoted = false;
	for (let i = 0; i < text.length; i++) {
		const char = text[i];
		if (char === '"') {
			if (quoted && text[i + 1] === '"') {
				cell += '"';
				i++;
			} else quoted = !quoted;
		} else if (char === delimiter && !quoted) {
			row.push(cell);
			cell = "";
		} else if ((char === "\n" || char === "\r") && !quoted) {
			if (char === "\r" && text[i + 1] === "\n") i++;
			row.push(cell);
			rows.push(row);
			row = [];
			cell = "";
		} else cell += char;
	}
	if (cell || row.length || !rows.length) {
		row.push(cell);
		rows.push(row);
	}
	return rows;
}
export function serializeCsv(rows: string[][], delimiter = ","): string {
	return rows
		.map((row) => row.map((cell) => (/["\r\n,\t]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell)).join(delimiter))
		.join("\r\n");
}
