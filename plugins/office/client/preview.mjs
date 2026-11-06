export function detectRemoteViewer(viewerUrl, pageUrl) {
	try {
		if (typeof viewerUrl !== "string" || typeof pageUrl !== "string") return true;
		const viewer = new URL(viewerUrl);
		const page = new URL(pageUrl);
		const loopback = (host) => ["localhost", "127.0.0.1", "[::1]"].includes(host);
		return (
			!loopback(viewer.hostname) ||
			!loopback(page.hostname) ||
			viewer.protocol !== "http:" ||
			page.protocol !== "http:" ||
			viewer.hostname !== page.hostname ||
			!viewer.port ||
			!!viewer.username ||
			!!viewer["pass" + "word"] ||
			viewer.origin === page.origin
		);
	} catch {
		return true;
	}
}

const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const limit = (value, fallback, max) => (Number.isSafeInteger(value) && value > 0 ? Math.min(value, max) : fallback);

export function inspectionToText(inspection, options = {}) {
	const maxChars = limit(options?.maxChars, 32_000, 64_000);
	const unavailable = (message = "Preview unavailable.") => message.slice(0, maxChars);
	const maxItems = limit(options?.maxItems, 200, 500);
	const maxRows = limit(options?.maxRows, 100, 200);
	const maxColumns = limit(options?.maxColumns, 30, 100);
	const lines = [];
	let length = 0;
	let truncated = false;
	const text = (value) => {
		if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") return "";
		return String(value)
			.slice(0, maxChars)
			.replace(/\r\n?/g, "\n")
			.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, "");
	};
	const add = (value) => {
		if (length >= maxChars) {
			truncated = true;
			return;
		}
		const line = text(value);
		const room = maxChars - length - (lines.length ? 1 : 0);
		if (line.length > room) truncated = true;
		lines.push(line.slice(0, Math.max(0, room)));
		length += Math.min(line.length, Math.max(0, room)) + (lines.length > 1 ? 1 : 0);
	};
	const each = (items, count, callback) => {
		if (!Array.isArray(items)) return;
		if (items.length > count) truncated = true;
		for (let i = 0; i < Math.min(items.length, count) && length < maxChars; i++) callback(items[i], i);
	};
	let data = inspection;
	for (let i = 0; i < 3 && record(data) && !data.kind; i++) {
		if (data.ok === false || data.error) return unavailable();
		if (Object.hasOwn(data, "result")) data = data.result;
		else if (Object.hasOwn(data, "value")) data = data.value;
		else break;
	}
	if (!record(data)) return unavailable();
	add(text(data.title || data.name) || "Office preview");
	switch (data.kind) {
		case "workbook":
		case "worksheet":
			each(data.worksheets, maxItems, (sheet, index) => {
				if (!record(sheet)) return;
				add(`Sheet ${index + 1}: ${text(sheet.name)}`);
				if (Number.isSafeInteger(sheet.rowCount) && Number.isSafeInteger(sheet.columnCount))
					add(`${sheet.rowCount} rows × ${sheet.columnCount} columns`);
				each(sheet.valueUsedRanges, 20, (range) => add(`Range: ${text(range)}`));
			});
			break;
		case "document":
		case "paragraph":
			each(data.paragraphs, maxItems, (paragraph) => {
				if (record(paragraph)) add(paragraph.text ?? paragraph.textPreview);
			});
			break;
		case "presentation":
		case "slide":
			each(data.slides, maxItems, (slide, index) => {
				if (!record(slide)) return;
				add(`Slide ${index + 1}: ${text(slide.name)}`);
				if (slide.textPreview) add(slide.textPreview);
				each(slide.elements, maxItems, (element) => {
					if (record(element)) add(record(element.text) ? element.text.text : element.text);
				});
			});
			break;
		case "worksheet-range":
			each(data.ranges, 20, (range) => {
				if (!record(range)) return;
				add(`${text(range.worksheet?.name)} ${text(range.resolvedRange)}`);
				each(range.displayValues, maxRows, (row) => {
					if (!Array.isArray(row)) return;
					if (row.length > maxColumns) truncated = true;
					add(
						row
							.slice(0, maxColumns)
							.map((cell) => text(cell).replace(/[\t\n]/g, " "))
							.join("\t"),
					);
				});
			});
			break;
		default:
			return unavailable("Preview unavailable: unsupported inspection format.");
	}
	const output = lines.join("\n");
	const marker = "\n[Preview truncated]";
	return truncated ? output.slice(0, Math.max(0, maxChars - marker.length)) + marker.slice(-maxChars) : output;
}
