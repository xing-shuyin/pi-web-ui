/**
 * 密码 CSV 导入的**纯逻辑**：分隔符解析 → 表头映射 → URL 归一 → 与库里条目去重合并。
 *
 * 三条边界（和 TOTP / 密码库同一条口径）：
 * - **明文只在主进程里走一趟**：宿主自己开原生选文件对话框读盘（`passwords.import`），
 *   渲染层拿到的只有条数统计——它从来不需要看到这份 CSV 的正文。
 * - **表头是猜的，但只认同义词白名单**：Chrome / Edge / Bitwarden / 1Password / LastPass 导出的列名
 *   都在 `COLUMNS` 里；认不出表头就按 `名称,网址,账号,密码` 的位置取值，认不出的列直接丢。
 * - **不认识的行走 `skipped`，绝不半条入库**：网址不是 http(s)、或缺密码的整行都算跳过，
 *   统计里如实报数——静默丢数据比导入失败更难查。
 */
import { randomUUID } from "node:crypto";
import type { PasswordEntry } from "../storage/index.js";
import { isWebUrl, webOrigin } from "./urls.js";

/** 单次导入的行数上限：再多就不是「导出文件」，而是有人选错了文件。 */
export const CSV_MAX_ROWS = 5000;

export interface ImportedCredential {
	name: string;
	url: string;
	username: string;
	password: string;
}

export interface CsvParseResult {
	rows: ImportedCredential[];
	/** 认不出 / 缺字段 / 网址非法的行数（不含表头与空行）。 */
	skipped: number;
}

export interface MergeResult {
	entries: PasswordEntry[];
	/** 新加的条目数。 */
	imported: number;
	/** 同站点同账号、但密码不同的条目数（已用文件里的密码覆盖）。 */
	updated: number;
	/** 库里已经有同一站点同一账号的条目（含库里本就重复的那些），因此没动 / 被合并的条数。 */
	duplicate: number;
}

/** 表头同义词：第一个出现的列名生效，后面的同义词忽略。 */
const COLUMNS = {
	name: ["name", "title", "名称", "标题"],
	url: ["url", "login_uri", "login_url", "website", "uri", "网址", "链接"],
	username: ["username", "login", "login_username", "account", "email", "账号", "用户名", "账户"],
	password: ["password", "login_password", "pass", "pwd", "密码"],
} as const;

type ColumnKey = keyof typeof COLUMNS;

/** 位置兜底：没有可识别表头时按这个顺序取（`名称,网址,账号,密码`）。 */
const POSITIONS: Record<ColumnKey, number> = { name: 0, url: 1, username: 2, password: 3 };

/** 一行拆成单元格的规则：引号内不切分、`""` 转义成一个引号、`"` 只在字段开头才当引号。 */
export function parseDelimitedRows(text: string, delimiter = ","): string[][] {
	const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
	const rows: string[][] = [];
	let cells: string[] = [];
	let field = "";
	let quoted = false;
	for (let index = 0; index < input.length; index += 1) {
		const char = input[index];
		if (quoted) {
			if (char !== '"') {
				field += char;
				continue;
			}
			if (input[index + 1] === '"') {
				field += '"';
				index += 1;
				continue;
			}
			quoted = false;
			continue;
		}
		if (char === '"' && field === "") {
			quoted = true;
			continue;
		}
		if (char === delimiter) {
			cells.push(field);
			field = "";
			continue;
		}
		if (char === "\r" || char === "\n") {
			cells.push(field);
			rows.push(cells);
			cells = [];
			field = "";
			if (char === "\r" && input[index + 1] === "\n") index += 1;
			continue;
		}
		field += char;
	}
	cells.push(field);
	rows.push(cells);
	// 空行（含文件末的换行）不算数据行
	return rows.filter((row) => row.some((cell) => cell.trim() !== ""));
}

/** 分隔符按第一行「制表符多还是逗号多」定：Excel 存的 .txt / .tsv 也能进。 */
function detectDelimiter(text: string): string {
	const line = text.split(/\r?\n/, 1)[0] ?? "";
	return (line.match(/\t/g)?.length ?? 0) > (line.match(/,/g)?.length ?? 0) ? "\t" : ",";
}

function headerIndex(row: string[]): Record<ColumnKey, number> | null {
	const lower = row.map((cell) => cell.trim().toLowerCase());
	const found: Partial<Record<ColumnKey, number>> = {};
	for (const key of Object.keys(COLUMNS) as ColumnKey[]) {
		const index = lower.findIndex((cell) => (COLUMNS[key] as readonly string[]).includes(cell));
		if (index >= 0) found[key] = index;
	}
	// 认得出「网址」或「密码」列才当表头，否则第一行本身是数据
	if (found.url === undefined && found.password === undefined) return null;
	return found as Record<ColumnKey, number>;
}

/**
 * 网址归一：缺协议按 `https://` 补（导出文件里常见 `example.com/login`），
 * `host:port` 不能被误当成协议名，补完仍不是 http(s) 的一律当非法行。
 */
export function credentialUrl(value: string): string | null {
	const text = value.trim();
	if (!text || /[\u0000-\u0020\u007f]/.test(text)) return null;
	const hostWithPort = /^[a-z\d.-]+:\d+(?:[/?#]|$)/i.test(text);
	const candidate = !hostWithPort && /^[a-z][a-z\d+.-]*:/i.test(text) ? text : `https://${text}`;
	if (!isWebUrl(candidate)) return null;
	return new URL(candidate).href;
}

/** 解析一份 CSV 导出：能落库的行 + 跳过的行数。表头不认识就按位置取。 */
export function parseCredentialCsv(text: string): CsvParseResult {
	const table = parseDelimitedRows(text, detectDelimiter(text));
	if (table.length === 0) return { rows: [], skipped: 0 };
	const header = headerIndex(table[0]);
	const body = header ? table.slice(1) : table;
	const rows: ImportedCredential[] = [];
	let skipped = 0;
	for (const cells of body.slice(0, CSV_MAX_ROWS)) {
		const value = (key: ColumnKey): string => {
			const index = header ? header[key] : POSITIONS[key];
			return index === undefined ? "" : (cells[index] ?? "").trim();
		};
		const url = credentialUrl(value("url"));
		const password = value("password");
		// 没有密码的「凭据」填不出东西，导入进来只会让列表里多几条点不动的行
		if (!url || !password) {
			skipped += 1;
			continue;
		}
		rows.push({
			name: value("name") || new URL(url).hostname,
			url,
			username: value("username"),
			password,
		});
	}
	return { rows, skipped };
}

/**
 * 「同一条凭据」的key：**origin + 账号**（大小写不敏感）。
 *
 * 不能拿完整 URL 当 key——同一个站点的 `/login` 与 `/my-account` 是两条导出记录，
 * 用户眼里却是同一个密码；按站点算才能把它们并成一条。账号为空时也按「空账号」算一条。
 */
const keyOf = (url: string, username: string): string =>
	`${webOrigin(url) || url.toLowerCase()}\n${username.trim().toLowerCase()}`;

/**
 * 把解析结果并进现有条目：**同站点同账号就是同一条**，密码不同视为「文件里的更新」，
 * 完全一致则不动；库里本来就重复的条目（早期按完整 URL 去重留下的）也顺手并成一条。
 */
export function mergeCredentials(existing: PasswordEntry[], rows: ImportedCredential[]): MergeResult {
	const entries: PasswordEntry[] = [];
	const index = new Map<string, PasswordEntry>();
	const result: MergeResult = { entries, imported: 0, updated: 0, duplicate: 0 };
	for (const entry of existing) {
		const key = keyOf(entry.url, entry.username);
		if (index.has(key)) {
			result.duplicate += 1;
			continue;
		}
		const copy = { ...entry };
		index.set(key, copy);
		entries.push(copy);
	}
	for (const row of rows) {
		const key = keyOf(row.url, row.username);
		const current = index.get(key);
		if (!current) {
			const entry: PasswordEntry = {
				id: randomUUID(),
				name: row.name,
				url: row.url,
				username: row.username,
				password: row.password,
				createdAt: new Date().toISOString(),
			};
			entries.push(entry);
			index.set(key, entry);
			result.imported += 1;
			continue;
		}
		if (current.password === row.password) {
			result.duplicate += 1;
			continue;
		}
		current.password = row.password;
		result.updated += 1;
	}
	return result;
}
