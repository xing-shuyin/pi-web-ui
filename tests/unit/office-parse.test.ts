import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
	extractOfficeText,
	isOfficeFile,
	listZipEntries,
	parseDocxParagraphs,
	parsePptxSlides,
	parseXlsxSheets,
} from "../../server/office-parse.js";

function makeZip(entries: { name: string; data: string; method?: number }[]): Buffer {
	const chunks: Buffer[] = [];
	const central: { nameBuf: Buffer; method: number; compLen: number; rawLen: number; offset: number }[] = [];
	let offset = 0;
	for (const { name, data, method = 8 } of entries) {
		const raw = Buffer.from(data, "utf8");
		const comp = method === 8 ? deflateRawSync(raw) : raw;
		const nameBuf = Buffer.from(name, "utf8");
		const lh = Buffer.alloc(30);
		lh.writeUInt32LE(0x04034b50, 0);
		lh.writeUInt16LE(20, 4);
		lh.writeUInt16LE(method, 10);
		lh.writeUInt32LE(comp.length, 18);
		lh.writeUInt32LE(raw.length, 22);
		lh.writeUInt16LE(nameBuf.length, 26);
		chunks.push(lh, nameBuf, comp);
		central.push({ nameBuf, method, compLen: comp.length, rawLen: raw.length, offset });
		offset += 30 + nameBuf.length + comp.length;
	}
	const cdStart = offset;
	const cdChunks: Buffer[] = [];
	for (const c of central) {
		const h = Buffer.alloc(46);
		h.writeUInt32LE(0x02014b50, 0);
		h.writeUInt16LE(c.method, 10);
		h.writeUInt32LE(c.compLen, 20);
		h.writeUInt32LE(c.rawLen, 24);
		h.writeUInt16LE(c.nameBuf.length, 28);
		h.writeUInt32LE(c.offset, 42);
		cdChunks.push(h, c.nameBuf);
		offset += 46 + c.nameBuf.length;
	}
	const cdSize = offset - cdStart;
	const eocd = Buffer.alloc(22);
	eocd.writeUInt32LE(0x06054b50, 0);
	eocd.writeUInt16LE(central.length, 10);
	eocd.writeUInt32LE(cdSize, 12);
	eocd.writeUInt32LE(cdStart, 16);
	return Buffer.concat([...chunks, ...cdChunks, eocd]);
}

const DOC_XML =
	'<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
	"<w:p><w:r><w:t>你好，世界</w:t></w:r></w:p>" +
	"<w:p><w:r><w:t>A</w:t></w:r><w:r><w:t>&amp;B</w:t></w:r></w:p><w:p/></w:body></w:document>";

describe("isOfficeFile", () => {
	it("只认 docx/xlsx/xlsm/pptx/pptm/ppsx/potx（大小写不敏感），老格式与 csv 不认", () => {
		expect(isOfficeFile("报告.DOCX")).toBe(true);
		expect(isOfficeFile("表.xlsx")).toBe(true);
		expect(isOfficeFile("宏.xlsm")).toBe(true);
		expect(isOfficeFile("汇报.PPTX")).toBe(true);
		expect(isOfficeFile("宏.pptm")).toBe(true);
		expect(isOfficeFile("放映.ppsx")).toBe(true);
		expect(isOfficeFile("模板.potx")).toBe(true);
		expect(isOfficeFile("老.doc")).toBe(false);
		expect(isOfficeFile("老.xls")).toBe(false);
		expect(isOfficeFile("老.ppt")).toBe(false);
		expect(isOfficeFile("a.csv")).toBe(false);
		expect(isOfficeFile("a.txt")).toBe(false);
	});
});

describe("parseDocxParagraphs", () => {
	it("段落 + 实体解码", () => {
		const paras = parseDocxParagraphs(makeZip([{ name: "word/document.xml", data: DOC_XML }]));
		expect(paras[0]).toBe("你好，世界");
		expect(paras[1]).toBe("A&B");
	});
	it("缺 document.xml 抛错（调用方回落二进制分支）", () => {
		expect(() => parseDocxParagraphs(makeZip([{ name: "other.xml", data: "x" }]))).toThrow();
	});
});

describe("parseXlsxSheets", () => {
	const ss =
		'<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
		"<si><t>姓名</t></si><si><t>年龄</t></si></sst>";
	const sheet =
		'<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' +
		'<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>' +
		'<row r="2"><c r="A2" t="inlineStr"><is><t>张三</t></is></c><c r="B2"><v>30</v></c></row>' +
		"</sheetData></worksheet>";
	it.each(["worksheets/sheet1.xml", "/xl/worksheets/sheet1.xml"])("Target=%s 都能定位 sheet", (target) => {
		const wb =
			'<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
			'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' +
			'<sheet name="人员" sheetId="1" r:id="rId1"/></sheets></workbook>';
		const rels =
			'<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
			`<Relationship Id="rId1" Type="x" Target="${target}"/></Relationships>`;
		const sheets = parseXlsxSheets(
			makeZip([
				{ name: "xl/workbook.xml", data: wb },
				{ name: "xl/_rels/workbook.xml.rels", data: rels },
				{ name: "xl/sharedStrings.xml", data: ss },
				{ name: "xl/worksheets/sheet1.xml", data: sheet },
			]),
		);
		expect(sheets[0].name).toBe("人员");
		expect(sheets[0].rows).toEqual([
			["姓名", "年龄"],
			["张三", "30"],
		]);
	});
	it("无 workbook 回落 Sheet1 + stored 压缩", () => {
		const sheets = parseXlsxSheets(makeZip([{ name: "xl/worksheets/sheet1.xml", data: sheet, method: 0 }]));
		expect(sheets[0].name).toBe("Sheet1");
		expect(sheets[0].rows[1][0]).toBe("张三");
	});
});

describe("listZipEntries", () => {
	it("快速提取中央目录文件名，不解压内容", () => {
		const zipBuf = makeZip([
			{ name: "a.txt", data: "hello" },
			{ name: "ppt/slides/slide1.xml", data: "<xml/>" },
		]);
		const entries = listZipEntries(zipBuf);
		expect(entries).toEqual(["a.txt", "ppt/slides/slide1.xml"]);
	});
});

describe("parsePptxSlides", () => {
	it("严格遵循 presentation.xml 中的幻灯片排序（重排场景）", () => {
		const presXml =
			'<?xml version="1.0"?><p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" ' +
			'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
			'<p:sldIdLst><p:sldId id="257" r:id="rId2"/><p:sldId id="256" r:id="rId1"/></p:sldIdLst></p:presentation>';
		const relsXml =
			'<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
			'<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>' +
			'<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide2.xml"/>' +
			"</Relationships>";
		const slide1Xml =
			'<?xml version="1.0"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" ' +
			'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree>' +
			'<p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>第一页</a:t></a:r></a:p></p:txBody></p:sp>' +
			"</p:spTree></p:cSld></p:sld>";
		const slide2Xml =
			'<?xml version="1.0"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" ' +
			'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree>' +
			'<p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>第二页</a:t></a:r></a:p></p:txBody></p:sp>' +
			"</p:spTree></p:cSld></p:sld>";

		const zipBuf = makeZip([
			{ name: "ppt/presentation.xml", data: presXml },
			{ name: "ppt/_rels/presentation.xml.rels", data: relsXml },
			{ name: "ppt/slides/slide1.xml", data: slide1Xml },
			{ name: "ppt/slides/slide2.xml", data: slide2Xml },
		]);

		const slides = parsePptxSlides(zipBuf);
		expect(slides).toHaveLength(2);
		expect(slides[0].title).toBe("第二页");
		expect(slides[1].title).toBe("第一页");
	});

	it("无 presentation.xml 时回落扫描中央目录中的幻灯片文件", () => {
		const slideXml =
			'<?xml version="1.0"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" ' +
			'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree>' +
			"<p:sp><p:txBody><a:p><a:r><a:t>独立页内容</a:t></a:r></a:p></p:txBody></p:sp>" +
			"</p:spTree></p:cSld></p:sld>";
		const zipBuf = makeZip([{ name: "ppt/slides/slide1.xml", data: slideXml }]);
		const slides = parsePptxSlides(zipBuf);
		expect(slides).toHaveLength(1);
		expect(slides[0].title).toBe("独立页内容");
	});

	it("层级项目符号 (lvl) 自动缩进与实体解码", () => {
		const slideXml =
			'<?xml version="1.0"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" ' +
			'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree>' +
			'<p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>功能要点</a:t></a:r></a:p></p:txBody></p:sp>' +
			"<p:sp><p:txBody>" +
			'<a:p><a:pPr lvl="0"><a:buChar char="•"/></a:pPr><a:r><a:t>&lt;一级条目&gt;</a:t></a:r></a:p>' +
			'<a:p><a:pPr lvl="1"/><a:r><a:t>二级子条目 &amp; 详情</a:t></a:r></a:p>' +
			'<a:p><a:pPr lvl="2"/><a:r><a:t>三级细项</a:t></a:r></a:p>' +
			"</p:txBody></p:sp>" +
			"</p:spTree></p:cSld></p:sld>";

		const zipBuf = makeZip([
			{
				name: "ppt/presentation.xml",
				data: '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="1" r:id="r1"/></p:sldIdLst></p:presentation>',
			},
			{
				name: "ppt/_rels/presentation.xml.rels",
				data: '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/></Relationships>',
			},
			{ name: "ppt/slides/slide1.xml", data: slideXml },
		]);

		const slides = parsePptxSlides(zipBuf);
		expect(slides[0].paragraphs).toEqual(["- <一级条目>", "  - 二级子条目 & 详情", "    - 三级细项"]);
	});

	it("空幻灯片与无幻灯片抛错", () => {
		const emptySlide =
			'<?xml version="1.0"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree></p:spTree></p:cSld></p:sld>';
		const zipBuf = makeZip([
			{
				name: "ppt/presentation.xml",
				data: '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="1" r:id="r1"/></p:sldIdLst></p:presentation>',
			},
			{
				name: "ppt/_rels/presentation.xml.rels",
				data: '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/></Relationships>',
			},
			{ name: "ppt/slides/slide1.xml", data: emptySlide },
		]);
		const slides = parsePptxSlides(zipBuf);
		expect(slides).toHaveLength(1);
		expect(slides[0].title).toBe("");
		expect(slides[0].paragraphs).toHaveLength(0);

		expect(() => parsePptxSlides(makeZip([{ name: "other.xml", data: "x" }]))).toThrow(/未找到幻灯片内容/);
	});
});

describe("extractOfficeText", () => {
	it("非 office 扩展名回 null", () => {
		expect(extractOfficeText("a.txt", Buffer.from("hi"))).toBeNull();
		expect(extractOfficeText("a.csv", Buffer.from("a,b"))).toBeNull();
	});
	it("docx 出段落文本", () => {
		const r = extractOfficeText("报告.docx", makeZip([{ name: "word/document.xml", data: DOC_XML }]));
		expect(r?.text).toContain("你好，世界");
		expect(r?.truncated).toBe(false);
	});
	it("xlsx 出 Markdown 表格", () => {
		const sheet =
			'<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' +
			'<row r="1"><c r="A1" t="inlineStr"><is><t>品</t></is></c></row>' +
			'<row r="2"><c r="A2"><v>10</v></c></row></sheetData></worksheet>';
		const r = extractOfficeText("表.xlsx", makeZip([{ name: "xl/worksheets/sheet1.xml", data: sheet }]));
		expect(r?.text).toContain("| A |");
		expect(r?.text).toContain("| 品 |");
		expect(r?.text).toContain("| --- |");
	});
	it("pptx 出 Markdown 幻灯片、表格与演讲者备注", () => {
		const presXml =
			'<?xml version="1.0"?><p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" ' +
			'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
			'<p:sldIdLst><p:sldId id="256" r:id="rId1"/><p:sldId id="257" r:id="rId2"/></p:sldIdLst></p:presentation>';
		const relsXml =
			'<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
			'<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>' +
			'<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide2.xml"/>' +
			"</Relationships>";
		const slide1Xml =
			'<?xml version="1.0"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" ' +
			'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree>' +
			'<p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>架构设计汇报</a:t></a:r></a:p></p:txBody></p:sp>' +
			'<p:sp><p:nvSpPr><p:nvPr><p:ph type="subTitle"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>2025 规划</a:t></a:r></a:p></p:txBody></p:sp>' +
			'<p:sp><p:nvSpPr><p:nvPr><p:ph type="body"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:pPr lvl="0"/><a:r><a:t>效能提升 50%</a:t></a:r></a:p></p:txBody></p:sp>' +
			"</p:spTree></p:cSld></p:sld>";
		const slide2Xml =
			'<?xml version="1.0"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" ' +
			'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree>' +
			'<p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>数据统计</a:t></a:r></a:p></p:txBody></p:sp>' +
			"<p:graphicFrame><a:graphic><a:graphicData><a:tbl>" +
			"<a:tr><a:tc><a:txBody><a:p><a:r><a:t>季度</a:t></a:r></a:p></a:txBody></a:tc><a:tc><a:txBody><a:p><a:r><a:t>营收</a:t></a:r></a:p></a:txBody></a:tc></a:tr>" +
			"<a:tr><a:tc><a:txBody><a:p><a:r><a:t>Q1</a:t></a:r></a:p></a:txBody></a:tc><a:tc><a:txBody><a:p><a:r><a:t>1000万</a:t></a:r></a:p></a:txBody></a:tc></a:tr>" +
			"</a:tbl></a:graphicData></a:graphic></p:graphicFrame>" +
			"</p:spTree></p:cSld></p:sld>";
		const slide2Rels =
			'<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
			'<Relationship Id="rIdN" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide2.xml"/>' +
			"</Relationships>";
		const notes2Xml =
			'<?xml version="1.0"?><p:notes xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" ' +
			'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree>' +
			'<p:sp><p:nvSpPr><p:nvPr><p:ph type="body"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>重点说明 Q1 增幅</a:t></a:r></a:p></p:txBody></p:sp>' +
			"</p:spTree></p:cSld></p:notes>";

		const zipBuf = makeZip([
			{ name: "ppt/presentation.xml", data: presXml },
			{ name: "ppt/_rels/presentation.xml.rels", data: relsXml },
			{ name: "ppt/slides/slide1.xml", data: slide1Xml },
			{ name: "ppt/slides/slide2.xml", data: slide2Xml },
			{ name: "ppt/slides/_rels/slide2.xml.rels", data: slide2Rels },
			{ name: "ppt/notesSlides/notesSlide2.xml", data: notes2Xml },
		]);

		const res = extractOfficeText("规划.pptx", zipBuf);
		expect(res?.text).toContain("## 幻灯片 1：架构设计汇报");
		expect(res?.text).toContain("2025 规划");
		expect(res?.text).toContain("- 效能提升 50%");
		expect(res?.text).toContain("---");
		expect(res?.text).toContain("## 幻灯片 2：数据统计");
		expect(res?.text).toContain("| 季度 | 营收 |");
		expect(res?.text).toContain("| Q1 | 1000万 |");
		expect(res?.text).toContain("> 💡 **备注**：重点说明 Q1 增幅");
		expect(res?.truncated).toBe(false);

		expect(res?.slides).toHaveLength(2);
		expect(res?.slides?.[0].title).toBe("架构设计汇报");
		expect(res?.slides?.[0].subtitle).toBe("2025 规划");
		expect(res?.slides?.[1].tables?.[0]?.[1]?.[0]).toBe("Q1");
		expect(res?.slides?.[1].notes).toBe("重点说明 Q1 增幅");
	});
	it("坏 zip 抛错", () => {
		expect(() => extractOfficeText("坏.xlsx", Buffer.from("not a zip"))).toThrow();
	});
});
