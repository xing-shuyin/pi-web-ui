import { describe, expect, it, vi } from "vitest";
import { SlashCommandsService, parseSlash } from "../../server/slash-commands.js";

const host = (over: Record<string, unknown> = {}) => ({
	emit: vi.fn(),
	cwd: () => "/tmp",
	getSession: () => ({}) as never,
	newChat: vi.fn(async () => {}),
	setModel: vi.fn(async () => {}),
	setCwd: vi.fn(async () => {}),
	setThinking: vi.fn(),
	...over,
});

describe("parseSlash", () => {
	it("splits /new args", () => {
		expect(parseSlash("/new hello world")).toEqual({ name: "new", args: "hello world" });
		expect(parseSlash("/new")).toEqual({ name: "new", args: "" });
	});
});

describe("/new <prompt>", () => {
	it("bare /new opens a chat and sends nothing", async () => {
		const h = host();
		const svc = new SlashCommandsService(h as never);
		expect(await svc.exec("new", "")).toBe(true);
		expect(h.newChat).toHaveBeenCalledTimes(1);
		expect((h as { prompt?: unknown }).prompt).toBeUndefined();
	});
	it("sends the args as the first prompt after the switch", async () => {
		const prompt = vi.fn(async (_t: string) => {});
		const h = host({ prompt });
		const svc = new SlashCommandsService(h as never);
		expect(await svc.exec("new", "hello world")).toBe(true);
		expect(h.newChat).toHaveBeenCalledTimes(1);
		expect(prompt).toHaveBeenCalledTimes(1);
		expect(prompt).toHaveBeenCalledWith("hello world");
	});
	it("does not send when the switch bailed (cap reached / create failed)", async () => {
		const prompt = vi.fn(async (_t: string) => {});
		const h = host({ prompt, newChat: vi.fn(async () => false) });
		const svc = new SlashCommandsService(h as never);
		expect(await svc.exec("new", "hello world")).toBe(true);
		expect(h.newChat).toHaveBeenCalledTimes(1);
		expect(prompt).not.toHaveBeenCalled();
	});
	it("sends when the host reports nothing (void = legacy success)", async () => {
		const prompt = vi.fn(async (_t: string) => {});
		const h = host({ prompt, newChat: vi.fn(async () => {}) });
		const svc = new SlashCommandsService(h as never);
		await svc.exec("new", "hi");
		expect(prompt).toHaveBeenCalledWith("hi");
	});
});
