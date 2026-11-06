import { describe, it, expect } from "vitest";
import { parsePptxSlides, parseXlsxSheets } from "../../server/office-parse.js";
import { deflateRawSync } from "node:zlib";

function createMockZip(files: Record<string, Buffer>): Buffer {
	const entries: Array<{
		name: string;
		data: Buffer;
		compData: Buffer;
		offset: number;
		crc: number;
	}> = [];

	let currentOffset = 0;
	const localChunks: Buffer[] = [];

	for (const [name, data] of Object.entries(files)) {
		const compData = deflateRawSync(data);
		const nameBuf = Buffer.from(name, "utf8");
		const localHeader = Buffer.alloc(30 + nameBuf.length);

		localHeader.writeUInt32LE(0x04034b50, 0);
		localHeader.writeUInt16LE(20, 4);
		localHeader.writeUInt16LE(0, 6);
		localHeader.writeUInt16LE(8, 8);
		localHeader.writeUInt16LE(0, 10);
		localHeader.writeUInt16LE(0, 12);
		localHeader.writeUInt32LE(0, 14);
		localHeader.writeUInt32LE(compData.length, 18);
		localHeader.writeUInt32LE(data.length, 22);
		localHeader.writeUInt16LE(nameBuf.length, 26);
		localHeader.writeUInt16LE(0, 28);
		nameBuf.copy(localHeader, 30);

		entries.push({
			name,
			data,
			compData,
			offset: currentOffset,
			crc: 0,
		});

		localChunks.push(localHeader, compData);
		currentOffset += localHeader.length + compData.length;
	}

	const cdStart = currentOffset;
	const cdChunks: Buffer[] = [];

	for (const entry of entries) {
		const nameBuf = Buffer.from(entry.name, "utf8");
		const cdHeader = Buffer.alloc(46 + nameBuf.length);

		cdHeader.writeUInt32LE(0x02014b50, 0);
		cdHeader.writeUInt16LE(20, 4);
		cdHeader.writeUInt16LE(20, 6);
		cdHeader.writeUInt16LE(0, 8);
		cdHeader.writeUInt16LE(8, 10);
		cdHeader.writeUInt16LE(0, 12);
		cdHeader.writeUInt16LE(0, 14);
		cdHeader.writeUInt32LE(entry.crc, 16);
		cdHeader.writeUInt32LE(entry.compData.length, 20);
		cdHeader.writeUInt32LE(entry.data.length, 24);
		cdHeader.writeUInt16LE(nameBuf.length, 28);
		cdHeader.writeUInt16LE(0, 30);
		cdHeader.writeUInt16LE(0, 32);
		cdHeader.writeUInt16LE(0, 34);
		cdHeader.writeUInt16LE(0, 36);
		cdHeader.writeUInt32LE(0, 38);
		cdHeader.writeUInt32LE(entry.offset, 42);
		nameBuf.copy(cdHeader, 46);

		cdChunks.push(cdHeader);
		currentOffset += cdHeader.length;
	}

	const cdSize = currentOffset - cdStart;
	const eocd = Buffer.alloc(22);
	eocd.writeUInt32LE(0x06054b50, 0);
	eocd.writeUInt16LE(0, 4);
	eocd.writeUInt16LE(0, 6);
	eocd.writeUInt16LE(entries.length, 8);
	eocd.writeUInt16LE(entries.length, 10);
	eocd.writeUInt32LE(cdSize, 12);
	eocd.writeUInt32LE(cdStart, 16);
	eocd.writeUInt16LE(0, 20);

	return Buffer.concat([...localChunks, ...cdChunks, eocd]);
}

describe("Office Parse DoS & Zip Bomb Protection (#337)", () => {
	it("safely handles huge row & column indices without OOM crash", () => {
		const maliciousSheetXml = `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
    <row r="1">
      <c r="A1" t="inlineStr"><is><t>Normal cell</t></is></c>
    </row>
    <row r="999999999">
      <c r="ZZZZ999999999" t="inlineStr"><is><t>Huge cell</t></is></c>
    </row>
  </sheetData>
</worksheet>`;

		const mockZip = createMockZip({
			"xl/workbook.xml": Buffer.from(
				`<?xml version="1.0"?><workbook><sheets><sheet name="TestSheet" r:id="rId1"/></sheets></workbook>`,
				"utf8",
			),
			"xl/_rels/workbook.xml.rels": Buffer.from(
				`<?xml version="1.0"?><Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>`,
				"utf8",
			),
			"xl/worksheets/sheet1.xml": Buffer.from(maliciousSheetXml, "utf8"),
		});

		const sheets = parseXlsxSheets(mockZip);
		expect(sheets.length).toBe(1);
		const sheet = sheets[0];
		expect(sheet.name).toBe("TestSheet");
		expect(sheet.truncated).toBe(true);
		expect(sheet.nRows).toBe(999999999);
		expect(sheet.rows.length).toBeLessThanOrEqual(500);
	});

	it("safely rejects oversized slide XML (>20MB) to prevent regex DoS", () => {
		const hugeSlideXml = Buffer.alloc(21 * 1024 * 1024, 0x20);
		hugeSlideXml.write(
			'<?xml version="1.0"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree></p:spTree></p:cSld></p:sld>',
			0,
		);

		const mockZip = createMockZip({
			"ppt/presentation.xml": Buffer.from(
				`<?xml version="1.0"?><p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst></p:presentation>`,
				"utf8",
			),
			"ppt/_rels/presentation.xml.rels": Buffer.from(
				`<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/></Relationships>`,
				"utf8",
			),
			"ppt/slides/slide1.xml": hugeSlideXml,
		});

		expect(() => parsePptxSlides(mockZip)).toThrow(/幻灯片内容过大/);
	});

	it("caps slide count at PPTX_MAX_SLIDES (500) without memory explosion", () => {
		const presEntries: string[] = [];
		const relsEntries: string[] = [];
		const files: Record<string, Buffer> = {};

		const slideTemplate = Buffer.from(
			'<?xml version="1.0"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Page</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>',
			"utf8",
		);

		for (let i = 1; i <= 550; i++) {
			presEntries.push(`<p:sldId id="${255 + i}" r:id="rId${i}"/>`);
			relsEntries.push(
				`<Relationship Id="rId${i}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${i}.xml"/>`,
			);
			files[`ppt/slides/slide${i}.xml`] = slideTemplate;
		}

		files["ppt/presentation.xml"] = Buffer.from(
			`<?xml version="1.0"?><p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst>${presEntries.join("")}</p:sldIdLst></p:presentation>`,
			"utf8",
		);
		files["ppt/_rels/presentation.xml.rels"] = Buffer.from(
			`<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relsEntries.join("")}</Relationships>`,
			"utf8",
		);

		const mockZip = createMockZip(files);
		const slides = parsePptxSlides(mockZip);
		expect(slides.length).toBe(500);
	});
});
