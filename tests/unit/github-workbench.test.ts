import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import plugin, {
	createGhRunner,
	createGitHubService,
	registerRoutes,
	validateRepo,
} from "../../plugins/github-workbench/index.mjs";

const issue = {
	number: 42,
	title: "Fix Windows path",
	state: "open",
	user: { login: "alice" },
	repository_url: "https://api.github.com/repos/acme/project",
	updated_at: "2026-01-01T12:00:00Z",
	labels: [{ name: "bug" }],
	comments: 0,
	body: "Reproduction steps",
	assignees: [],
};

function serviceWith(handler: (args: string[], opts?: any) => unknown) {
	const run = vi.fn(async (args: string[], opts?: any) => handler(args, opts));
	return { run, service: createGitHubService(run, () => "E:/project") };
}

function fakeChild() {
	const child = Object.assign(new EventEmitter(), {
		stdout: new PassThrough(),
		stderr: new PassThrough(),
		stdin: new Writable({
			write(_chunk, _encoding, callback) {
				callback();
			},
		}),
		kill: vi.fn(),
	});
	return child as any;
}

afterEach(() => {
	vi.useRealTimers();
});

describe("GitHub workbench input boundaries", () => {
	it("rejects repository traversal, URLs and option injection", () => {
		for (const repo of ["--help", "acme/../other", "acme/..", "https://github.com/acme/repo", "a/b?x=y", ["a/b"], ""]) {
			expect(() => validateRepo(repo)).toThrow();
		}
		expect(validateRepo("acme/project.name_1-2")).toBe("acme/project.name_1-2");
	});
	it("validates state, comment, number, pagination and filter before running gh", async () => {
		const { service, run } = serviceWith(() => ({}));
		await expect(service.comment({ repo: "acme/project", number: 42, body: " " })).rejects.toThrow();
		await expect(service.comment({ repo: "acme/project", number: 42, body: "a".repeat(60001) })).rejects.toThrow();
		await expect(service.state({ repo: "acme/project", number: 42, state: "merged" })).rejects.toThrow();
		await expect(service.detail({ repo: "acme/project", number: "1/../../user" })).rejects.toThrow();
		await expect(service.items({ filter: "repository" })).rejects.toThrow();
		await expect(service.items({ filter: "oops" })).rejects.toThrow();
		await expect(service.items({ filter: "custom", q: "bug", page: 21 })).rejects.toThrow();
		await expect(service.items({ filter: "custom", q: ["bug"] })).rejects.toThrow();
		await expect(service.items({ filter: "custom", q: "" })).rejects.toThrow();
		expect(run).not.toHaveBeenCalled();
	});
});

describe("GitHub daily inbox", () => {
	it("works outside a repository while retaining authenticated personal inboxes", async () => {
		const { service, run } = serviceWith((args) => {
			if (args[0] === "repo") throw new Error("not a git repository");
			return { login: "bob" };
		});
		await expect(service.status()).resolves.toEqual({ login: "bob", repo: "" });
		expect(run.mock.calls[1][1]).toEqual({ cwd: "E:/project" });
	});
	it("normalizes PRs and issues and resolves personal search against the authenticated login", async () => {
		const { service, run } = serviceWith((args) => {
			if (args[args.length - 1] === "user") return { login: "bob" };
			return { total_count: 161, incomplete_results: true, items: [issue, { ...issue, number: 43, pull_request: {} }] };
		});
		const result = await service.items({ filter: "review-requested", repo: "acme/project", q: "label:bug", page: "2" });
		const args = run.mock.calls[1][0];
		const url = new URL(`https://api.github.com/${args[args.length - 1]}`);
		expect(url.searchParams.get("q")).toBe("is:open is:pr review-requested:bob repo:acme/project label:bug");
		expect(url.searchParams.get("page")).toBe("2");
		expect(result).toMatchObject({ hasMore: true, total: 161, incomplete: true, page: 2 });
		expect(result.items[0]).toMatchObject({
			repo: "acme/project",
			number: 42,
			kind: "issue",
			labels: ["bug"],
			commentCount: 0,
		});
		expect(result.items[1]).toMatchObject({ kind: "pr", url: "https://github.com/acme/project/pull/43" });
	});
	it("caps pagination at GitHub's search limit", async () => {
		const { service } = serviceWith(() => ({ total_count: 5000, items: [] }));
		await expect(service.items({ filter: "custom", q: "is:open", page: 20 })).resolves.toMatchObject({
			hasMore: false,
			total: 1000,
		});
	});
	it("loads bounded recent discussions and useful PR metadata", async () => {
		const { service, run } = serviceWith((args) => {
			const endpoint = args[args.length - 1];
			if (endpoint.includes("/comments?"))
				return [{ user: { login: "reviewer" }, body: "Needs testing", created_at: "today" }];
			if (endpoint.includes("/pulls/"))
				return {
					draft: false,
					merged: false,
					head: { ref: "fix" },
					base: { ref: "main" },
					requested_reviewers: [{ login: "reviewer" }],
					changed_files: 3,
					additions: 8,
					deletions: 2,
				};
			return { ...issue, pull_request: {}, comments: 31, body: "x".repeat(18000) };
		});
		const { item } = await service.detail({ repo: "acme/project", number: 42 });
		expect(item.body.length).toBeLessThan(17000);
		expect(item.body).toContain("截断");
		expect(item.commentsTruncated).toBe(true);
		expect(item.comments[0]).toMatchObject({ author: "reviewer", body: "Needs testing" });
		expect((item as any).pr).toMatchObject({ head: "fix", base: "main", reviewers: ["reviewer"], changedFiles: 3 });
		expect(run.mock.calls[1][0].at(-1)).toBe("repos/acme/project/issues/42/comments?per_page=30&page=2");
	});
	it("sends comment text as JSON stdin and state changes only to the captured target", async () => {
		const { service, run } = serviceWith(() => ({}));
		const body = '`literal` $(do not run) "quotes"\n中文评论';
		await service.comment({ repo: "acme/project", number: 42, body });
		const [args, options] = run.mock.calls[0];
		expect(args).toContain("POST");
		expect(args).toContain("repos/acme/project/issues/42/comments");
		expect(args.slice(-2)).toEqual(["--input", "-"]);
		expect(args).not.toContain(body);
		expect(options.input).toEqual({ body });
		await service.state({ repo: "other/repo", number: 7, state: "closed" });
		expect(run.mock.calls[1][0]).toContain("repos/other/repo/issues/7");
		expect(run.mock.calls[1][1].input).toEqual({ state: "closed" });
	});
});

describe("GitHub subprocess lifetime", () => {
	it("uses no shell, disables prompts and pipes exact JSON input", async () => {
		const child = fakeChild();
		const end = vi.spyOn(child.stdin, "end");
		const spawnImpl = vi.fn(() => child);
		const runner = createGhRunner({ spawnImpl });
		const result = runner.run(["api", "user"], { input: { body: "a\nb" } });
		child.stdout.write('{"login":"bob"}');
		child.emit("close", 0);
		await expect(result).resolves.toEqual({ login: "bob" });
		expect(spawnImpl.mock.calls[0]).toEqual([
			"gh",
			["api", "user"],
			expect.objectContaining({
				shell: false,
				windowsHide: true,
				env: expect.objectContaining({ GH_PROMPT_DISABLED: "1", GH_HOST: "github.com" }),
			}),
		]);
		expect(end).toHaveBeenCalledWith('{"body":"a\\nb"}');
		runner.dispose();
	});
	it("kills and rejects timed out requests", async () => {
		vi.useFakeTimers();
		const child = fakeChild();
		const runner = createGhRunner({ spawnImpl: () => child, timeoutMs: 50 });
		const assertion = expect(runner.run([])).rejects.toThrow("超时");
		await vi.advanceTimersByTimeAsync(51);
		await assertion;
		expect(child.kill).toHaveBeenCalled();
		runner.dispose();
	});
	it("rejects missing CLI, redacts credentials and bounds output", async () => {
		const child = fakeChild();
		const runner = createGhRunner({ spawnImpl: () => child });
		const result = runner.run([]);
		child.emit("error", Object.assign(new Error("missing"), { code: "ENOENT" }));
		await expect(result).rejects.toThrow("gh auth login");
		const child2 = fakeChild();
		const runner2 = createGhRunner({ spawnImpl: () => child2 });
		const failed = runner2.run([]);
		child2.stderr.write("bad token ghp_secret123");
		child2.emit("close", 1);
		await expect(failed).rejects.toThrow("[redacted]");
		const child3 = fakeChild();
		const runner3 = createGhRunner({ spawnImpl: () => child3 });
		const large = runner3.run([]);
		child3.stdout.write("x".repeat(4 * 1024 * 1024 + 1));
		await expect(large).rejects.toThrow("内容过大");
		expect(child3.kill).toHaveBeenCalled();
		runner.dispose();
		runner2.dispose();
		runner3.dispose();
	});
	it("kills active children and prevents requests after unload", async () => {
		const child = fakeChild();
		const runner = createGhRunner({ spawnImpl: () => child });
		const pending = runner.run([]);
		runner.dispose();
		expect(child.kill).toHaveBeenCalled();
		child.emit("close", null);
		await expect(pending).rejects.toThrow();
		await expect(runner.run([])).rejects.toThrow("已卸载");
	});
});

it("registers authenticated plugin routes, reports validation errors and cleans up", async () => {
	const handlers = new Map<string, any>();
	const off = vi.fn();
	const host = {
		route: vi.fn((method, path, fn) => {
			handlers.set(`${method} ${path}`, fn);
			return off;
		}),
	};
	const { service } = serviceWith(() => ({}));
	const cleanup = registerRoutes(host, service);
	expect([...handlers.keys()]).toEqual(["GET /status", "GET /items", "GET /detail", "POST /comment", "POST /state"]);
	const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
	handlers.get("POST /comment")({ body: { repo: "acme/project", number: 42, body: "" } }, res);
	await vi.waitFor(() => expect(res.json).toHaveBeenCalled());
	expect(res.status).toHaveBeenCalledWith(400);
	expect(res.json.mock.calls[0][0]).toMatchObject({ ok: false });
	cleanup();
	expect(off).toHaveBeenCalledTimes(5);
	expect(plugin.activate).toBeTypeOf("function");
});
