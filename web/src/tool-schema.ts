export interface SchemaRow {
	name: string;
	type: string;
	required: boolean;
	description?: string;
	hint?: string;
	depth: number;
}

interface SchemaRowsOptions {
	maxDepth?: number;
	maxRows?: number;
}

const DEFAULT_MAX_DEPTH = 3;
const DEFAULT_MAX_ROWS = 200;

function isObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
	if (typeof v !== "string") return undefined;
	const s = v.trim();
	return s ? s : undefined;
}

function unionLabel(list: unknown[], depth: number): string {
	const parts: string[] = [];
	for (const item of list) {
		const label = typeLabel(item, depth);
		if (!parts.includes(label)) parts.push(label);
		if (parts.length >= 4) {
			parts.push("…");
			break;
		}
	}
	return parts.join(" | ") || "any";
}

function enumHint(values: unknown[]): string | undefined {
	const shown = values.slice(0, 6).map((v) => (typeof v === "string" ? v : (JSON.stringify(v) ?? String(v))));
	if (shown.length === 0) return undefined;
	return `enum: ${shown.join(" | ")}${values.length > shown.length ? " | …" : ""}`;
}

export function typeLabel(schema: unknown, depth = 0): string {
	if (depth > 6) return "any";
	if (!isObject(schema)) return "any";
	if (str(schema.$ref)) return "ref";
	const type = str(schema.type);
	if (type === "array") {
		const items = schema.items;
		const inner = items === undefined ? "any" : typeLabel(items, depth + 1);
		return `array<${inner}>`;
	}
	if (type) {
		return type;
	}
	for (const key of ["anyOf", "oneOf", "allOf"] as const) {
		const list = schema[key];
		if (Array.isArray(list) && list.length > 0) return unionLabel(list, depth + 1);
	}
	if (isObject(schema.properties)) return "object";
	if (isObject(schema.additionalProperties)) return `record<${typeLabel(schema.additionalProperties, depth + 1)}>`;
	return "any";
}

function rowHint(schema: Record<string, unknown>): string | undefined {
	const bits: string[] = [];
	const enums = schema.enum;
	if (Array.isArray(enums) && enums.length > 0) {
		const hint = enumHint(enums);
		if (hint) bits.push(hint);
	}
	if (schema.const !== undefined) bits.push(`const: ${JSON.stringify(schema.const)}`);
	if (schema.default !== undefined) bits.push(`default: ${JSON.stringify(schema.default)}`);
	return bits.length > 0 ? bits.join(" · ") : undefined;
}

export function schemaRows(schema: unknown, opts: SchemaRowsOptions = {}): SchemaRow[] {
	const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;
	const maxRows = opts.maxRows ?? DEFAULT_MAX_ROWS;
	const root = schema;
	if (!isObject(root)) return [];
	const rootProps = root.properties;
	if (!isObject(rootProps)) return [];

	const rows: SchemaRow[] = [];
	const required = new Set(
		(Array.isArray(root.required) ? root.required : []).filter((r): r is string => typeof r === "string"),
	);

	const walk = (props: Record<string, unknown>, prefix: string, depth: number, requiredSet: Set<string>): void => {
		if (rows.length >= maxRows) return;
		for (const [key, raw] of Object.entries(props)) {
			if (rows.length >= maxRows) return;
			const node = isObject(raw) ? raw : {};
			const name = prefix ? `${prefix}.${key}` : key;
			const row: SchemaRow = {
				name,
				type: typeLabel(node, depth),
				required: requiredSet.has(key),
				depth,
			};
			const description = str(node.description);
			if (description) row.description = description;
			const hint = rowHint(node);
			if (hint) row.hint = hint;
			rows.push(row);

			if (depth + 1 < maxDepth && isObject(node.properties)) {
				const childRequired = new Set(
					(Array.isArray(node.required) ? node.required : []).filter((r): r is string => typeof r === "string"),
				);
				walk(node.properties, name, depth + 1, childRequired);
			}
		}
	};

	walk(rootProps, "", 0, required);
	return rows;
}

export function hasSchemaRows(schema: unknown): boolean {
	return schemaRows(schema, { maxRows: 1 }).length > 0;
}
