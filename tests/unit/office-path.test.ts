import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import office from "../../plugins/office/index.mjs";

function lexicalResolver(roots: string[]) {
	return vi.fn((input: string) => {
		const target = resolve(roots[0], input);
		if (
			!roots.some((root) => {
				const rel = relative(root, target);
				return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
			})
		)
			throw Object.assign(new Error("Outside workspace"), { statusCode: 403 });
		return target;
	});
}

const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

async function fixture() {
	const temp = realpathSync(mkdtempSync(join(tmpdir(), "office-route-path-")));
	cleanups.push(() => rmSync(temp, { recursive: true, force: true }));
	const cwd = join(temp, "workspace");
	const extra = join(temp, "extra");
	const outside = join(temp, "outside");
	for (const dir of [cwd, extra, outside]) mkdirSync(dir);
	const routes = new Map<string, Function>();
	const resolveInWorkspace = lexicalResolver([cwd, extra]);
	const ensure = vi.fn(async () => {
		throw new Error("Gateway installation must not run");
	});
	const cleanup = await office.activate({
		cwd,
		resolveInWorkspace,
		log() {},
		registerTool() {},
		route(method: string, path: string, handler: Function) {
			routes.set(`${method} ${path}`, handler);
		},
		assets: { ensure },
	});
	cleanups.push(cleanup);
	async function inspect(path: string) {
		let status = 200;
		let body: any;
		const res = {
			status(value: number) {
				status = value;
				return this;
			},
			json(value: any) {
				body = value;
				return this;
			},
		};
		await routes.get("POST /inspect")!({ body: { path } }, res);
		expect(ensure).not.toHaveBeenCalled();
		return { status, body };
	}
	return { cwd, extra, outside, inspect, resolveInWorkspace };
}

function linkOrSkip(target: string, path: string, type: "file" | "dir", context: { skip: (note?: string) => never }) {
	try {
		symlinkSync(target, path, type);
	} catch (error: any) {
		if (process.platform === "win32" && ["EPERM", "EACCES", "ENOTSUP"].includes(error.code))
			context.skip("Windows symlink privilege is unavailable");
		throw error;
	}
}

describe("Office route canonical path admission with a lexical host", () => {
	it("rejects an existing document symlink outside the authorized roots before gateway access", async (context) => {
		const f = await fixture();
		const target = join(f.outside, "secret.xlsx");
		writeFileSync(target, "outside document");
		linkOrSkip(target, join(f.cwd, "linked.xlsx"), "file", context);
		const response = await f.inspect("linked.xlsx");
		expect(response.status).toBe(403);
		expect(response.body.ok).toBe(false);
	});

	it("rejects an existing file below a symlinked outside directory", async (context) => {
		const f = await fixture();
		writeFileSync(join(f.outside, "secret.xlsx"), "outside document");
		linkOrSkip(f.outside, join(f.cwd, "linked"), "dir", context);
		expect((await f.inspect("linked/secret.xlsx")).status).toBe(403);
	});

	it("rejects missing descendants below an outside symlink instead of treating them as safe missing files", async (context) => {
		const f = await fixture();
		linkOrSkip(f.outside, join(f.cwd, "linked"), "dir", context);
		expect((await f.inspect("linked/missing/new.xlsx")).status).toBe(403);
	});

	it("rejects dangling symlinks without traversing to a missing suffix", async (context) => {
		const f = await fixture();
		linkOrSkip(join(f.outside, "missing.xlsx"), join(f.cwd, "dangling.xlsx"), "file", context);
		const response = await f.inspect("dangling.xlsx");
		expect(response.body.ok).toBe(false);
		expect(response.status).toBeGreaterThanOrEqual(400);
	});

	it("preserves explicit extra-root authorization after resolving an in-workspace symlink", async (context) => {
		const f = await fixture();
		linkOrSkip(f.extra, join(f.cwd, "authorized"), "dir", context);
		expect((await f.inspect("authorized/missing.xlsx")).status).toBe(404);
		expect(f.resolveInWorkspace).toHaveBeenCalledWith(join(f.extra, "missing.xlsx"));
	});

	it("accepts missing suffixes within an authorized root and rejects direct traversal", async () => {
		const f = await fixture();
		expect((await f.inspect(join(f.extra, "missing", "book.xlsx"))).status).toBe(404);
		expect((await f.inspect(join(f.outside, "book.xlsx"))).status).toBe(403);
	});
});
