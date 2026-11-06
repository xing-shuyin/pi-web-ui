export function extractConciseParamHint(prop: unknown): string {
	if (!prop || typeof prop !== "object") return "";
	const p = prop as { description?: string; type?: string };
	const desc = (p.description || "").trim();
	if (desc) {
		const cleaned = desc.replace(/\([^)]*\)/g, "").trim();
		const clause = cleaned.split(/[,.;:—\n]/)[0]?.trim() || "";
		const stripped = clause.replace(/^(the|optional|a|an)\s+/i, "").trim();
		const words = stripped.split(/\s+/).filter(Boolean);
		const picked: string[] = [];
		let len = 0;
		for (const w of words) {
			if (picked.length >= 2) break;
			const nextLen = len === 0 ? w.length : len + 1 + w.length;
			if (nextLen > 20) {
				if (picked.length === 0) picked.push(w.slice(0, 20));
				break;
			}
			picked.push(w);
			len = nextLen;
		}
		if (picked.length > 0) return picked.join(" ");
	}
	if (p.type && typeof p.type === "string") {
		return p.type;
	}
	return "";
}

export function formatCompactSignature(parameters: unknown): string {
	if (!parameters || typeof parameters !== "object") return "";
	const schema = parameters as { properties?: Record<string, unknown>; required?: unknown };
	const props = schema.properties;
	if (!props || typeof props !== "object" || Object.keys(props).length === 0) {
		return "";
	}
	const required = new Set(Array.isArray(schema.required) ? schema.required : []);
	const entries = Object.entries(props);
	const visibleEntries = entries.slice(0, 6);
	const formatted = visibleEntries.map(([key, val]) => {
		const isReq = required.has(key);
		const hint = extractConciseParamHint(val);
		return `${key}${isReq ? "" : "?"}${hint ? `: ${hint}` : ""}`;
	});
	if (entries.length > visibleEntries.length) {
		formatted.push("...");
	}
	return `(${formatted.join(", ")})`;
}

export function createShallowSchema(parameters: unknown): Record<string, unknown> | undefined {
	if (!parameters || typeof parameters !== "object") return undefined;
	const schema = parameters as {
		type?: string;
		properties?: Record<string, unknown>;
		required?: unknown;
	};
	const props = schema.properties;
	if (!props || typeof props !== "object") {
		return { type: schema.type || "object" };
	}
	const shallowProps: Record<string, unknown> = {};
	for (const [key, val] of Object.entries(props)) {
		if (!val || typeof val !== "object") continue;
		const p = val as { type?: string };
		const hint = extractConciseParamHint(val);
		shallowProps[key] = {
			type: p.type || "string",
			...(hint ? { description: hint } : {}),
		};
	}
	const req = Array.isArray(schema.required) ? schema.required : undefined;
	return {
		type: "object",
		properties: shallowProps,
		...(req && req.length > 0 ? { required: req } : {}),
	};
}
