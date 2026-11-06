// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import manifest from "../../plugins/github-workbench/manifest.json";
import { buildReference, createWorkbench, resolveApiBase } from "../../plugins/github-workbench/client/entry.mjs";
import {
	composeToComposer,
	registerAttachmentSink,
	registerDraftSink,
	resetComposerSinks,
} from "../../web/src/composer-bridge.js";
import { appendDraftAttachments, type DraftAttachment } from "../../web/src/composer-draft.js";
import { sanitizeIconSvg } from "../../web/src/plugin-icon.js";

const item = {
	repo: "acme/project",
	number: 42,
	kind: "issue",
	title: "Fix Windows paths <script>bad()</script>",
	state: "open",
	author: "alice",
	url: "https://github.com/acme/project/issues/42",
	labels: ["bug"],
	updatedAt: "2026-01-01T12:00:00Z",
	commentCount: 1,
	body: "A reproduction\n<img src=x onerror=bad()>",
	comments: [{ author: "bob", body: "Needs regression testing", createdAt: "today" }],
	commentsTruncated: false,
};

let view: ReturnType<typeof createWorkbench>;
let cleanup: (() => void) | undefined;
let container: HTMLDivElement;
let root: ShadowRoot;
let fetchMock: ReturnType<typeof vi.fn<(url: string, options?: any) => Promise<any>>>;
let bridge: {
	compose: ReturnType<typeof vi.fn>;
	setView: ReturnType<typeof vi.fn>;
	startChat: ReturnType<typeof vi.fn>;
};
const ok = (body: object) => ({ ok: true, json: async () => ({ ok: true, ...body }) });

beforeEach(() => {
	view = createWorkbench();
	resetComposerSinks();
	container = document.createElement("div");
	document.body.append(container);
	bridge = { compose: vi.fn(() => true), setView: vi.fn(), startChat: vi.fn(() => true) };
	(window as any).__piWebUiHost = bridge;
	fetchMock = vi.fn(async (url: string) => {
		if (url.endsWith("/status")) return ok({ login: "bob", repo: "acme/project" });
		if (url.includes("/items?"))
			return ok({
				items: [item, { ...item, number: 43, title: "Second issue", url: "https://github.com/acme/project/issues/43" }],
				page: 1,
				total: 2,
				hasMore: false,
			});
		if (url.includes("/detail?")) return ok({ item: { ...item, number: url.includes("number=43") ? 43 : 42 } });
		return ok({});
	});
	vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
	cleanup?.();
	cleanup = undefined;
	container.remove();
	delete (window as any).__piWebUiHost;
	resetComposerSinks();
	vi.unstubAllGlobals();
});

async function mount() {
	cleanup = view.mount(container);
	root = container.shadowRoot!;
	await vi.waitFor(() => expect(root.querySelectorAll(".row")).toHaveLength(2));
}
async function select(index = 0) {
	root.querySelectorAll<HTMLButtonElement>(".row")[index].click();
	await vi.waitFor(() => expect(root.querySelector(".comment-form")).not.toBeNull());
}
function action(name: string) {
	root.querySelector<HTMLButtonElement>(`[data-action="${name}"]`)!.click();
}

it("retains the application base path in plugin API URLs", () => {
	expect(resolveApiBase("https://host.example/workspace/plugins/github-workbench/client/entry.mjs?e=7")).toBe(
		"https://host.example/workspace/plugins-api/github-workbench",
	);
});

it.each([
	["issue", 42, "Issue", "issues"],
	["pr", 749, "PR", "pull"],
])("creates a compact %s reference containing only identity and URL", (kind, number, label, route) => {
	const url = `https://github.com/acme/project/${route}/${number}`;
	expect(buildReference({ ...item, kind, number, url, body: "a".repeat(40000) })).toEqual({
		path: "",
		name: `${label} #${number}`,
		mode: "quote",
		key: `github:acme/project#${number}`,
		quote: {
			text: `${label} #${number} · acme/project\n${url}`,
			messageId: `github:acme/project#${number}`,
			role: "github",
		},
	});
});

it("contributes a GitHub workbench tab beside Files", () => {
	expect(manifest.ui).not.toHaveProperty("topbar");
	expect(manifest.view).toBe(false);
	const tab = manifest.ui["rightpanel.tabs"].find((entry) => entry.id === "workbench")!;
	expect(tab).toMatchObject({ label: "工作台", kind: "page" });
	const icon = tab.iconSvg;
	expect(icon).toBe(manifest.iconSvg);
	const element = new DOMParser().parseFromString(sanitizeIconSvg(icon)!, "image/svg+xml").documentElement;
	expect(element.getAttribute("viewBox")).toBe("0 0 24 24");
	expect(element.getAttribute("stroke")).toBe("currentColor");
	expect(element.querySelector("path")?.getAttribute("d")).toBeTruthy();
});

describe("GitHub workbench view", () => {
	it("escapes remote HTML and adds a compact reference attachment to the current composer", async () => {
		await mount();
		await select();
		expect(root.querySelector(".detail script")).toBeNull();
		expect(root.querySelector(".detail img")).toBeNull();
		expect(root.querySelector(".content")!.textContent).toContain("<img");
		action("quote");
		expect(bridge.compose).toHaveBeenCalledWith({ attachments: [buildReference(item)] });
		expect(bridge.setView).toHaveBeenCalledWith("chat");
	});
	it("adds the AI reference without sending a task or altering the user's draft, and deduplicates repeats", async () => {
		let draft = "请先帮我看看这个问题";
		const draftSink = vi.fn((text: string) => {
			draft = text;
		});
		let attachments: DraftAttachment[] = [{ path: "notes.md", name: "notes.md", mode: "reference" }];
		registerDraftSink(draftSink);
		registerAttachmentSink((incoming) => {
			attachments = appendDraftAttachments(attachments, incoming);
		});
		bridge.compose.mockImplementation(composeToComposer);
		await mount();
		await select();
		action("process");
		action("process");
		expect(attachments).toEqual([{ path: "notes.md", name: "notes.md", mode: "reference" }, buildReference(item)]);
		expect(draftSink).not.toHaveBeenCalled();
		expect(bridge.startChat).not.toHaveBeenCalled();
		expect(bridge.setView).toHaveBeenCalledWith("chat");
		expect(draft).toBe("请先帮我看看这个问题");
	});
	it.each(["quote", "process"])("handles an unavailable composer for %s without sending a task", async (name) => {
		await mount();
		await select();
		bridge.compose.mockReturnValue(false);
		action(name);
		expect(root.querySelector(".status")!.textContent).toContain("没有可用的对话输入框");
		expect(bridge.startChat).not.toHaveBeenCalled();
		expect(bridge.setView).not.toHaveBeenCalled();
	});
	it("posts to the selected target and clears the draft only after successful publication", async () => {
		await mount();
		await select();
		const textarea = root.querySelector<HTMLTextAreaElement>("textarea")!;
		textarea.value = "A literal comment\n中文";
		textarea.dispatchEvent(new Event("input", { bubbles: true }));
		root.querySelector(".comment-form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
		await vi.waitFor(() => expect(fetchMock.mock.calls.some(([url]) => url.endsWith("/comment"))).toBe(true));
		const [, opts] = (fetchMock.mock.calls as any[]).find(([url]) => url.endsWith("/comment"));
		expect(JSON.parse(opts.body)).toEqual({ repo: "acme/project", number: 42, body: "A literal comment\n中文" });
		await vi.waitFor(() => expect(root.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe(""));
	});
	it("retains failed comments and keeps drafts separate when changing the selection", async () => {
		await mount();
		await select();
		const originalFetch = fetchMock.getMockImplementation()!;
		fetchMock.mockImplementation(async (url: string, ...args: any[]) => {
			if (url.endsWith("/comment")) return { ok: false, json: async () => ({ ok: false, error: "permission denied" }) };
			return (originalFetch as any)(url, ...args);
		});
		const input = root.querySelector<HTMLTextAreaElement>("textarea")!;
		input.value = "Keep this draft";
		input.dispatchEvent(new Event("input", { bubbles: true }));
		root.querySelector(".comment-form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
		await vi.waitFor(() => expect(root.querySelector(".status")!.textContent).toContain("permission denied"));
		expect(input.value).toBe("Keep this draft");
		await select(1);
		expect(root.querySelector<HTMLTextAreaElement>("textarea")!.value).toBe("");
		await select(0);
		expect(root.querySelector<HTMLTextAreaElement>("textarea")!.value).toBe("Keep this draft");
	});
	it("ignores stale detail responses when users rapidly select different items", async () => {
		await mount();
		let resolveFirst: (value: unknown) => void = () => {};
		const originalFetch = fetchMock.getMockImplementation()!;
		fetchMock.mockImplementation(async (url: string) => {
			if (url.includes("/detail?") && url.includes("number=42"))
				return new Promise((resolve) => {
					resolveFirst = resolve;
				});
			return originalFetch(url);
		});
		root.querySelector<HTMLButtonElement>(".row")!.click();
		await select(1);
		resolveFirst(ok({ item }));
		await new Promise((resolve) => setTimeout(resolve, 0));
		action("quote");
		expect(bridge.compose.mock.calls[0][0].attachments[0].quote.messageId).toBe("github:acme/project#43");
	});
	it("does not submit twice while a comment is pending or apply its response to another selection", async () => {
		await mount();
		await select();
		let resolveComment: (value: unknown) => void = () => {};
		const originalFetch = fetchMock.getMockImplementation()!;
		fetchMock.mockImplementation(async (url: string) =>
			url.endsWith("/comment")
				? new Promise((resolve) => {
						resolveComment = resolve;
					})
				: originalFetch(url),
		);
		const input = root.querySelector<HTMLTextAreaElement>("textarea")!;
		input.value = "Post once";
		input.dispatchEvent(new Event("input", { bubbles: true }));
		const form = root.querySelector(".comment-form")!;
		form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
		form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
		expect(fetchMock.mock.calls.filter(([url]) => url.endsWith("/comment"))).toHaveLength(1);
		await select(1);
		resolveComment(ok({}));
		await vi.waitFor(() => expect(root.querySelector(".status")!.textContent).toBe("评论已发布"));
		action("quote");
		expect(bridge.compose.mock.calls[0][0].attachments[0].quote.messageId).toBe("github:acme/project#43");
	});
	it("restores filters, selected details and per-item drafts after a sidebar tab remount", async () => {
		await mount();
		action("search");
		root.querySelector<HTMLInputElement>('[name="q"]')!.value = "label:bug";
		root.querySelector<HTMLButtonElement>('[data-kind="pr"]')!.click();
		await vi.waitFor(() =>
			expect(fetchMock.mock.calls.some(([url]) => url.includes("q=label%3Abug+is%3Apr"))).toBe(true),
		);
		await select();
		const input = root.querySelector<HTMLTextAreaElement>("textarea")!;
		input.value = "Preserve this draft across tabs";
		input.dispatchEvent(new Event("input", { bubbles: true }));
		cleanup!();
		container.remove();
		container = document.createElement("div");
		document.body.append(container);
		await mount();
		expect(root.querySelector(".app")!.getAttribute("data-view")).toBe("detail");
		expect(root.querySelector<HTMLInputElement>('[name="q"]')!.value).toBe("label:bug");
		expect(root.querySelector('[data-kind="pr"]')!.getAttribute("aria-pressed")).toBe("true");
		expect(root.querySelector<HTMLElement>(".search-field")!.hidden).toBe(false);
		expect(root.querySelector<HTMLTextAreaElement>("textarea")!.value).toBe("Preserve this draft across tabs");
		action("back");
		expect(root.querySelector(".app")!.getAttribute("data-view")).toBe("list");
		await select(1);
		expect(root.querySelector<HTMLTextAreaElement>("textarea")!.value).toBe("");
		await select(0);
		expect(root.querySelector<HTMLTextAreaElement>("textarea")!.value).toBe("Preserve this draft across tabs");
	});
	it.each([true, false])(
		"settles a pending comment across tab switches without aborting or submitting twice (success: %s)",
		async (succeeded) => {
			await mount();
			await select();
			let resolveComment: (value: unknown) => void = () => {};
			let signal: AbortSignal | undefined;
			const originalFetch = fetchMock.getMockImplementation()!;
			fetchMock.mockImplementation(async (url: string, opts: any) => {
				if (url.endsWith("/comment")) {
					signal = opts.signal;
					return new Promise((resolve) => {
						resolveComment = resolve;
					});
				}
				return originalFetch(url, opts);
			});
			root.querySelector<HTMLTextAreaElement>("textarea")!.value = "Publish exactly once";
			root.querySelector(".comment-form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
			cleanup!();
			expect(signal!.aborted).toBe(false);
			await mount();
			expect(root.querySelector<HTMLTextAreaElement>("textarea")!.disabled).toBe(true);
			root.querySelector(".comment-form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
			expect(fetchMock.mock.calls.filter(([url]) => url.endsWith("/comment"))).toHaveLength(1);
			resolveComment(succeeded ? ok({}) : { ok: false, json: async () => ({ ok: false, error: "permission denied" }) });
			await vi.waitFor(() => {
				expect(root.querySelector<HTMLTextAreaElement>("textarea")!.value).toBe(
					succeeded ? "" : "Publish exactly once",
				);
				expect(root.querySelector<HTMLTextAreaElement>("textarea")!.disabled).toBe(false);
				expect(root.querySelector(".status")!.textContent).toContain(succeeded ? "评论已发布" : "permission denied");
			});
			expect(fetchMock.mock.calls.filter(([url]) => url.includes("/detail?"))).toHaveLength(2);
		},
	);
	it.each([false, true])(
		"does not restore a published comment after returning to the list (remount: %s)",
		async (remount) => {
			await mount();
			await select();
			let resolveComment: (value: unknown) => void = () => {};
			const originalFetch = fetchMock.getMockImplementation()!;
			fetchMock.mockImplementation(async (url: string, opts: any) =>
				url.endsWith("/comment")
					? new Promise((resolve) => {
							resolveComment = resolve;
						})
					: originalFetch(url, opts),
			);
			root.querySelector<HTMLTextAreaElement>("textarea")!.value = "Already published";
			root.querySelector(".comment-form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
			action("back");
			resolveComment(ok({}));
			await vi.waitFor(() => expect(root.querySelector(".status")!.textContent).toBe("评论已发布"));
			if (remount) {
				cleanup!();
				await mount();
			}
			await select();
			expect(root.querySelector<HTMLTextAreaElement>("textarea")!.value).toBe("");
			expect(fetchMock.mock.calls.filter(([url]) => url.endsWith("/comment"))).toHaveLength(1);
		},
	);
	it("restores the requested first page when switched away during a filter change from a later page", async () => {
		const originalFetch = fetchMock.getMockImplementation()!;
		let deferAssigned = true;
		fetchMock.mockImplementation(async (url: string, opts: any) => {
			if (!url.includes("/items?")) return originalFetch(url, opts);
			const query = new URL(url, "http://test.local").searchParams;
			if (query.get("filter") === "assigned" && deferAssigned) {
				deferAssigned = false;
				return new Promise((_resolve, reject) =>
					opts.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {
						once: true,
					}),
				);
			}
			return ok({ items: [item, { ...item, number: 43 }], page: Number(query.get("page")), total: 250, hasMore: true });
		});
		await mount();
		for (let page = 2; page <= 5; page++) {
			action("next");
			await vi.waitFor(() => expect(root.querySelector(".page")!.textContent).toContain(`第 ${page} 页`));
		}
		const filter = root.querySelector<HTMLSelectElement>('[name="filter"]')!;
		filter.value = "assigned";
		filter.dispatchEvent(new Event("change", { bubbles: true }));
		cleanup!();
		await mount();
		expect(root.querySelector(".page")!.textContent).toContain("第 1 页");
		const assignedQueries = fetchMock.mock.calls.filter(
			([url]) => url.includes("/items?") && url.includes("filter=assigned"),
		);
		expect(assignedQueries).toHaveLength(2);
		for (const [url] of assignedQueries) expect(new URL(url, "http://test.local").searchParams.get("page")).toBe("1");
	});
	it("refreshes selected details while preserving the draft and scroll", async () => {
		await mount();
		await select();
		const input = root.querySelector<HTMLTextAreaElement>("textarea")!;
		input.value = "A draft during refresh";
		input.dispatchEvent(new Event("input", { bubbles: true }));
		root.querySelector(".detail")!.scrollTop = 88;
		const originalFetch = fetchMock.getMockImplementation()!;
		fetchMock.mockImplementation(async (url: string, opts: any) =>
			url.includes("/detail?") ? ok({ item: { ...item, body: "Fresh detail body" } }) : originalFetch(url, opts),
		);
		action("refresh");
		await vi.waitFor(() => expect(root.querySelector(".detail .content")!.textContent).toBe("Fresh detail body"));
		expect(root.querySelector<HTMLTextAreaElement>("textarea")!.value).toBe("A draft during refresh");
		expect(root.querySelector(".detail")!.scrollTop).toBe(88);
	});
	it("can return to the list while a detail request is pending", async () => {
		await mount();
		let resolveDetail: (value: unknown) => void = () => {};
		fetchMock.mockImplementation(
			() =>
				new Promise((resolve) => {
					resolveDetail = resolve;
				}),
		);
		root.querySelector<HTMLButtonElement>(".row")!.click();
		action("back");
		resolveDetail(ok({ item }));
		await Promise.resolve();
		expect(root.querySelector(".app")!.getAttribute("data-view")).toBe("list");
		cleanup!();
		cleanup = view.mount(container);
		expect(root.querySelector(".app")!.getAttribute("data-view")).toBe("list");
	});
	it("detects the repository if switched away before the initial connection finishes", async () => {
		fetchMock.mockImplementationOnce(() => new Promise(() => {}));
		cleanup = view.mount(container);
		cleanup!();
		await mount();
		expect(root.querySelector<HTMLInputElement>('[name="repo"]')!.value).toBe("acme/project");
	});
	it("shows actionable login guidance and aborts in-flight requests on unmount", async () => {
		fetchMock.mockResolvedValue({ ok: false, json: async () => ({ ok: false, error: "gh auth login" }) });
		cleanup = view.mount(container);
		root = container.shadowRoot!;
		await vi.waitFor(() => expect(root.querySelector(".help")!.textContent).toContain("gh auth login"));
		cleanup!();
		cleanup = undefined;
		let signal: AbortSignal | undefined;
		fetchMock.mockImplementation((_url: string, opts: any) => {
			signal = opts.signal;
			return new Promise(() => {});
		});
		cleanup = view.mount(container);
		expect(signal!.aborted).toBe(false);
		cleanup!();
		cleanup = undefined;
		expect(signal!.aborted).toBe(true);
	});
});
