export function appPath(ctx, path, moduleUrl = import.meta.url) {
	if (typeof ctx.appUrl === "function") return ctx.appUrl(path);
	const url = new URL(moduleUrl);
	const marker = url.pathname.indexOf("/plugins/remote-workbench/");
	return `${marker < 0 ? "" : url.pathname.slice(0, marker)}${path}`;
}
export function decodeBytes(b64) {
	return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}
export function encodeInput(text) {
	return btoa(Array.from(new TextEncoder().encode(text), (b) => String.fromCharCode(b)).join(""));
}
export function shellQuote(value) {
	return `'${String(value).replace(/'/g, "'\\''")}'`;
}
export function expandSnippet(template, values) {
	return template.replace(/\{\{([a-zA-Z_][a-zA-Z0-9_]*)\}\}/g, (_, key) => {
		if (!Object.hasOwn(values, key)) throw new Error(`缺少参数: ${key}`);
		return shellQuote(values[key]);
	});
}
export function findBuffer(term, query, previous = -1, backwards = false) {
	if (!query) return -1;
	const buffer = term.buffer.active;
	for (let step = 1; step <= buffer.length; step++) {
		const row = (((previous + (backwards ? -step : step)) % buffer.length) + buffer.length) % buffer.length;
		const text = buffer.getLine(row)?.translateToString(true) || "";
		const col = text.toLowerCase().indexOf(query.toLowerCase());
		if (col >= 0) {
			term.scrollToLine(row);
			const line = buffer.getLine(row);
			if (line?.getCell) {
				let chars = 0,
					start = -1,
					end = -1;
				for (let cellIndex = 0; cellIndex < line.length; cellIndex++) {
					const cell = line.getCell(cellIndex);
					if (!cell || cell.getWidth() === 0) continue;
					const count = (cell.getChars() || " ").length;
					if (start < 0 && chars + count > col) start = cellIndex;
					chars += count;
					if (chars >= col + query.length) {
						end = cellIndex + cell.getWidth();
						break;
					}
				}
				if (start >= 0 && end > start) term.select(start, row, end - start);
			} else if (/^[\x00-\x7f]*$/.test(text)) term.select(col, row, query.length);
			return row;
		}
	}
	return -1;
}
export function readSessions(storage, key) {
	try {
		const values = JSON.parse(storage.getItem(key) || "[]");
		return Array.isArray(values)
			? values
					.filter(
						(v) =>
							(typeof v.resumeToken === "string" || (v.tmux && typeof v.tmuxSession === "string")) &&
							typeof v.host === "string",
					)
					.slice(0, 32)
			: [];
	} catch {
		return [];
	}
}
export function saveSessions(storage, key, shells) {
	try {
		storage.setItem(
			key,
			JSON.stringify(
				shells
					.filter((s) => (s.resumeToken || (s.tmux && s.tmuxSession)) && !s.closed)
					.map((s) => ({
						resumeToken: s.resumeToken,
						host: s.host,
						username: s.username,
						port: s.port,
						remotePath: s.remotePath,
						title: s.title,
						tmux: s.tmux,
						tmuxSession: s.tmuxSession,
					})),
			),
		);
	} catch {}
}
export function matchesHost(host, keyword, group = "", environment = "") {
	return (
		(!group || host.group === group) &&
		(!environment || host.environment === environment) &&
		[host.name, host.host, host.username, host.description, host.group, host.environment].some((v) =>
			String(v || "")
				.toLowerCase()
				.includes(keyword.toLowerCase()),
		)
	);
}
export function importableHosts(items) {
	return items.filter((item) => !item.imported && item.importable !== false);
}
