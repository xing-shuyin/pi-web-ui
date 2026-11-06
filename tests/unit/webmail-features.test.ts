import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";

const PLUGIN = pathToFileURL(join(process.cwd(), "plugins/webmail/index.mjs")).href;

process.env.npm_config_offline = "true";
process.env.npm_config_registry = "http://127.0.0.1:9/";
process.env.npm_config_audit = "false";
process.env.npm_config_fund = "false";

const sentMailOptions: Array<Record<string, unknown>> = [];

vi.mock("nodemailer", () => ({
	createTransport: () => ({
		sendMail: async (opts: Record<string, unknown>) => {
			sentMailOptions.push(opts);
			return { messageId: "msg-id-" + Date.now(), accepted: [opts.to] };
		},
	}),
}));

vi.mock("imapflow", () => ({
	ImapFlow: class {
		usable = true;
		connect() {
			return Promise.resolve();
		}
		close() {}
	},
}));

vi.mock("mailparser", () => ({
	simpleParser: async () => ({ text: "parsed text" }),
}));

interface RegisteredTool {
	name: string;
	description: string;
	promptSnippet: string;
	promptGuidelines?: string[];
	parameters: {
		properties: Record<string, { type?: string; description?: string }>;
		required?: string[];
	};
	execute: (id: string, args: Record<string, unknown>) => Promise<string>;
}

interface PluginBroadcast {
	kind?: string;
	uid?: number;
	ok?: boolean;
	translatedSubject?: string;
	translatedText?: string;
	targetLang?: string;
	error?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const dirs: string[] = [];
function tempDir(): string {
	const d = mkdtempSync(join(tmpdir(), "webmail-feat-"));
	dirs.push(d);
	return d;
}

afterAll(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe("webmail 特性测试 (Issue #582 与邮件翻译)", () => {
	it("AI 工具注册成功，包含 html 参数，且准确实现 multipart/alternative 发信与纯文本降级", async () => {
		const dir = tempDir();
		const registeredTools: RegisteredTool[] = [];
		const broadcasts: PluginBroadcast[] = [];
		let messageHandler: ((msg: Record<string, unknown>, from?: string) => void) | null = null;

		const mod = (await import(PLUGIN)) as {
			default: { activate: (host: unknown) => () => void };
		};

		const host = {
			dir,
			log: () => {},
			notify: () => {},
			broadcast: (p: PluginBroadcast) => broadcasts.push(p),
			sendTo: (_to: string, p: PluginBroadcast) => broadcasts.push(p),
			onMessage: (h: (msg: Record<string, unknown>, from?: string) => void) => {
				messageHandler = h;
				return () => {};
			},
			onToolEvent: () => () => {},
			onAttach: () => () => {},
			onCwdChange: () => () => {},
			registerAgentTool: (tool: RegisteredTool) => {
				registeredTools.push(tool);
				return () => {};
			},
			registerBackgroundTask: () => ({ unregister() {} }),
			storage: { get: () => undefined, set() {}, delete() {}, all: () => ({}) },
			secrets: {
				set: () => {},
				get: () => undefined,
				has: () => false,
				delete: () => {},
				list: () => [],
			},
		};

		const dispose = mod.default.activate(host);
		await sleep(150);

		try {
			const sendMsg = messageHandler as ((msg: Record<string, unknown>, from?: string) => void) | null;
			sendMsg?.({
				action: "save_config",
				config: {
					imap: { host: "imap.example.com", port: 993, user: "u@example.com", pass: "p" },
					smtp: { host: "smtp.example.com", port: 465, user: "u@example.com", pass: "p", from: "me@example.com" },
				},
			});
			await sleep(100);

			const mailTool = registeredTools.find((t) => t.name === "mail");
			expect(mailTool).toBeDefined();
			expect(mailTool?.description).toContain("optionally with an HTML alternative");
			expect(mailTool?.parameters.properties.html).toBeDefined();
			expect(mailTool?.parameters.properties.html.description).toContain("HTML body");

			sentMailOptions.length = 0;
			const missingRes = await mailTool!.execute("call_1", { action: "send", to: "test@example.com" });
			expect(missingRes).toContain("发信需要");
			expect(sentMailOptions.length).toBe(0);

			sentMailOptions.length = 0;
			const plainRes = await mailTool!.execute("call_2", {
				action: "send",
				to: "test@example.com",
				subject: "Hello",
				body: "Plain content",
			});
			expect(plainRes).toContain("已发送至 test@example.com");
			expect(sentMailOptions.length).toBe(1);
			expect(sentMailOptions[0].text).toBe("Plain content");
			expect(sentMailOptions[0].html).toBeUndefined();

			sentMailOptions.length = 0;
			const htmlOnlyRes = await mailTool!.execute("call_3", {
				action: "send",
				to: "recipient@example.com",
				subject: "Weekly Report",
				html: "<table><tr><td>Metric</td><td>100</td></tr></table>",
			});
			expect(htmlOnlyRes).toContain("已发送至 recipient@example.com");
			expect(sentMailOptions.length).toBe(1);
			expect(sentMailOptions[0].text).toContain("Metric");
			expect(sentMailOptions[0].text).toContain("100");
			expect(sentMailOptions[0].text).not.toContain("<table>");
			expect(sentMailOptions[0].html).toBe("<table><tr><td>Metric</td><td>100</td></tr></table>");

			sentMailOptions.length = 0;
			await mailTool!.execute("call_4", {
				action: "send",
				to: "test@example.com",
				subject: "Combined",
				body: "Fallback plain text",
				html: "<h1>Heading</h1><p>Paragraph</p>",
			});
			expect(sentMailOptions.length).toBe(1);
			expect(sentMailOptions[0].text).toBe("Fallback plain text");
			expect(sentMailOptions[0].html).toBe("<h1>Heading</h1><p>Paragraph</p>");

			sentMailOptions.length = 0;
			await mailTool!.execute("call_5", {
				action: "send",
				to: "test@example.com",
				html: '<script>alert(1)</script><p>Clean</p><a href="javascript:alert(1)">Click</a>',
			});
			expect(sentMailOptions.length).toBe(1);
			expect(sentMailOptions[0].html).not.toContain("<script>");
			expect(sentMailOptions[0].html).not.toContain("javascript:");
			expect(sentMailOptions[0].html).toContain("Clean");

			sentMailOptions.length = 0;
			const hugeHtml = "a".repeat(260 * 1024);
			await expect(
				mailTool!.execute("call_6", {
					action: "send",
					to: "test@example.com",
					html: hugeHtml,
				}),
			).rejects.toThrow("超出大小上限");
		} finally {
			dispose();
		}
	});

	it("测试邮件一键翻译协议 (action: 'translate' -> kind: 'translated')", async () => {
		const dir = tempDir();
		const broadcasts: PluginBroadcast[] = [];
		let messageHandler: ((msg: Record<string, unknown>, from?: string) => void) | null = null;

		const mod = (await import(PLUGIN)) as {
			default: { activate: (host: unknown) => () => void };
		};

		const host = {
			dir,
			log: () => {},
			notify: () => {},
			broadcast: (p: PluginBroadcast) => broadcasts.push(p),
			sendTo: (_to: string, p: PluginBroadcast) => broadcasts.push(p),
			onMessage: (h: (msg: Record<string, unknown>, from?: string) => void) => {
				messageHandler = h;
				return () => {};
			},
			onToolEvent: () => () => {},
			onAttach: () => () => {},
			onCwdChange: () => () => {},
			registerAgentTool: () => () => {},
			registerBackgroundTask: () => ({ unregister() {} }),
			storage: { get: () => undefined, set() {}, delete() {}, all: () => ({}) },
			models: {
				list: () => [{ id: "openai/gpt-4o", provider: "openai", vision: true }],
			},
			llm: {
				complete: async (req: { prompt: string; model?: string }) => {
					if (req.model === "fail-model") {
						return { ok: false, error: "Token quota exceeded" };
					}
					return {
						ok: true,
						text: "<<SUBJECT>>\n健康检查\n<</SUBJECT>>\n<<BODY>>\n系统运行一切正常\n<</BODY>>",
						model: req.model || "openai/gpt-4o",
					};
				},
			},
			secrets: {
				set: () => {},
				get: () => undefined,
				has: () => false,
				delete: () => {},
				list: () => [],
			},
		};

		const dispose = mod.default.activate(host);
		await sleep(100);

		try {
			broadcasts.length = 0;
			const handler = messageHandler as unknown as (msg: Record<string, unknown>, from?: string) => void;
			handler({
				action: "translate",
				uid: 201,
				subject: "Health check",
				text: "System is normal",
				model: "openai/gpt-4o",
			});
			await sleep(120);

			const llmTrans = broadcasts.find((b) => b.kind === "translated" && b.uid === 201);
			expect(llmTrans).toBeDefined();
			expect(llmTrans?.ok).toBe(true);
			expect((llmTrans as any)?.engine).toBe("llm");
			expect((llmTrans as any)?.model).toBe("openai/gpt-4o");
			expect(llmTrans?.translatedSubject).toBe("健康检查");
			expect(llmTrans?.translatedText).toBe("系统运行一切正常");

			const originalFetch = globalThis.fetch;
			globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
				if (String(url).includes("translate.googleapis.com")) {
					return {
						ok: true,
						json: async () => [[["回退系统正常", "System normal fallback"]]],
					};
				}
				return { ok: false, status: 500 };
			}) as unknown as typeof fetch;

			try {
				broadcasts.length = 0;
				handler({
					action: "translate",
					uid: 202,
					subject: "Notice",
					text: "System normal fallback",
					model: "fail-model",
				});
				await sleep(120);

				const fallbackTrans = broadcasts.find((b) => b.kind === "translated" && b.uid === 202);
				expect(fallbackTrans).toBeDefined();
				expect(fallbackTrans?.ok).toBe(true);
				expect((fallbackTrans as any)?.engine).toBe("fast");
				expect(fallbackTrans?.translatedText).toBe("回退系统正常");
			} finally {
				globalThis.fetch = originalFetch;
			}
		} finally {
			dispose();
		}
	});

	it("客户端 entry.mjs 语法合法且正确导出 mount 函数", async () => {
		const clientEntry = pathToFileURL(join(process.cwd(), "plugins/webmail/client/entry.mjs")).href;
		const clientMod = (await import(clientEntry)) as { default?: { mount?: unknown } };
		expect(clientMod.default).toBeDefined();
		expect(typeof clientMod.default?.mount).toBe("function");
	});
});
