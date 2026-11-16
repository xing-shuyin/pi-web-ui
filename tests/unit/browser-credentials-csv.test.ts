import { describe, expect, it } from "vitest";
import {
	credentialUrl,
	mergeCredentials,
	parseCredentialCsv,
	parseDelimitedRows,
} from "../../browser/runtime/credentials-csv.js";
import type { PasswordEntry } from "../../browser/storage/index.js";

const entry = (overrides: Partial<PasswordEntry>): PasswordEntry => ({
	id: "fixture",
	name: "Fixture",
	url: "https://example.com/login",
	username: "fixture-user",
	password: "fixture-value",
	createdAt: new Date(0).toISOString(),
	...overrides,
});

describe("CSV tokenizer", () => {
	it("keeps quoted commas, escaped quotes and CRLF in one cell", () => {
		expect(parseDelimitedRows('a,"b,1","say ""hi"""\r\nc,d,e\r\n')).toEqual([
			["a", "b,1", 'say "hi"'],
			["c", "d", "e"],
		]);
	});
	it("strips the UTF-8 BOM and drops blank lines", () => {
		expect(parseDelimitedRows("\ufeffname,url\n\nx,y\n")).toEqual([
			["name", "url"],
			["x", "y"],
		]);
	});
	it("only treats a quote at the start of a field as quoting", () => {
		expect(parseDelimitedRows('x,12"34\n')).toEqual([["x", '12"34']]);
	});
});

describe("credential URL normalization", () => {
	it("adds https when the scheme is missing and keeps host:port intact", () => {
		expect(credentialUrl("example.com/login")).toBe("https://example.com/login");
		expect(credentialUrl("127.0.0.1:9000/admin")).toBe("https://127.0.0.1:9000/admin");
		expect(credentialUrl("http://192.168.1.1/")).toBe("http://192.168.1.1/");
	});
	it.each(["", "javascript:alert(1)", "file:///tmp/a.html", "https://user:pw@example.com/", "not a url"])(
		"rejects %s",
		(value) => expect(credentialUrl(value)).toBeNull(),
	);
});

describe("password CSV import", () => {
	const header = "name,url,username,password,note";
	it("maps the exported header and falls back to the hostname for a blank name", () => {
		const parsed = parseCredentialCsv(
			`${header}\nMail,https://mail.example.com/inbox,ann,secret,\n,https://bare.example.com/,bob,pw,x`,
		);
		expect(parsed.rows).toEqual([
			{ name: "Mail", url: "https://mail.example.com/inbox", username: "ann", password: "secret" },
			{ name: "bare.example.com", url: "https://bare.example.com/", username: "bob", password: "pw" },
		]);
		expect(parsed.skipped).toBe(0);
	});
	it("reads other exporters' column names and skips rows without a password or a usable URL", () => {
		const parsed = parseCredentialCsv(
			[
				"folder,favorite,type,name,notes,login_uri,login_username,login_password",
				"Work,0,login,Bank,,https://bank.example.com/,ann,pw",
				"Work,0,login,NoPassword,,https://bank.example.com/,ann,",
				"Work,0,login,BadUrl,,javascript:alert(1),ann,pw",
			].join("\n"),
		);
		expect(parsed.rows).toEqual([{ name: "Bank", url: "https://bank.example.com/", username: "ann", password: "pw" }]);
		expect(parsed.skipped).toBe(2);
	});
	it("falls back to positional columns when the first row is data, and accepts tab-separated files", () => {
		expect(parseCredentialCsv("Site\thttps://site.example/\tann\tpw").rows).toEqual([
			{ name: "Site", url: "https://site.example/", username: "ann", password: "pw" },
		]);
		expect(parseCredentialCsv("Site,https://site.example/,ann,pw").rows[0]).toMatchObject({
			username: "ann",
			password: "pw",
		});
	});
	it("reports an empty result rather than throwing on a file with no credentials", () => {
		expect(parseCredentialCsv("")).toEqual({ rows: [], skipped: 0 });
		expect(parseCredentialCsv(header)).toEqual({ rows: [], skipped: 0 });
	});
});

describe("merging an import into the vault", () => {
	const row = { name: "Bank", url: "https://bank.example.com/", username: "Ann", password: "pw" };

	it("adds new credentials with a fresh id and keeps the existing ones", () => {
		const existing = [entry({})];
		const result = mergeCredentials(existing, [row]);
		expect(result.imported).toBe(1);
		expect(result.updated).toBe(0);
		expect(result.duplicate).toBe(0);
		expect(result.entries).toHaveLength(2);
		expect(result.entries[1]).toMatchObject({ name: "Bank", url: row.url, username: "Ann", password: "pw" });
		expect(result.entries[1]?.id).not.toBe("");
		expect(existing).toHaveLength(1);
	});
	it("treats the same site and account as one credential regardless of case", () => {
		const existing = [entry({ url: row.url, username: "ann", password: "pw" })];
		expect(mergeCredentials(existing, [row])).toMatchObject({ imported: 0, updated: 0, duplicate: 1 });
	});
	it("refreshes the password when the file disagrees, keeping the saved name and id", () => {
		const existing = [entry({ url: row.url, username: "ann", password: "old", name: "My bank" })];
		const result = mergeCredentials(existing, [row]);
		expect(result).toMatchObject({ imported: 0, updated: 1, duplicate: 0 });
		expect(result.entries).toHaveLength(1);
		expect(result.entries[0]).toMatchObject({ id: "fixture", name: "My bank", password: "pw" });
	});
	it("collapses duplicate rows inside one file instead of storing them twice", () => {
		const result = mergeCredentials([], [row, { ...row, password: "pw" }]);
		expect(result).toMatchObject({ imported: 1, duplicate: 1 });
		expect(result.entries).toHaveLength(1);
	});
	it("treats two paths of the same site as one credential, like the vault shows it", () => {
		// 导出文件里 /login 与 /my-account 是两行，用户眼里是同一个密码
		const result = mergeCredentials(
			[entry({ url: "https://bank.example.com/login", username: "Ann", password: "old" })],
			[{ ...row, url: "https://bank.example.com/my-account" }],
		);
		expect(result).toMatchObject({ imported: 0, updated: 1, duplicate: 0 });
		expect(result.entries).toHaveLength(1);
		expect(result.entries[0]).toMatchObject({ url: "https://bank.example.com/login", password: "pw" });
	});
	it("merges duplicates that are already in the vault and stops mutating the input", () => {
		const existing = [
			entry({ id: "a", url: "https://bank.example.com/login", username: "Ann", password: "pw" }),
			entry({ id: "b", url: "https://bank.example.com/my-account", username: "ann", password: "pw" }),
		];
		const result = mergeCredentials(existing, [{ ...row, username: "ann" }]);
		expect(result.entries).toHaveLength(1);
		expect(result.entries[0]?.id).toBe("a");
		expect(result).toMatchObject({ imported: 0, updated: 0, duplicate: 2 });
		// 库里原本的两条不动（纯函数不应改调用方的数据）
		expect(existing).toHaveLength(2);
	});
	it("keeps different accounts on one site apart", () => {
		const result = mergeCredentials([entry({ url: row.url, username: "other", password: "pw" })], [row]);
		expect(result).toMatchObject({ imported: 1, updated: 0 });
		expect(result.entries).toHaveLength(2);
	});
});
