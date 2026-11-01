import { agentLoop } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import type { GroupHistoryMessage, GroupTaskContext } from "../../server/device-center/group-context.js";
import type { PlannedGroupTaskContext } from "../../server/device-center/group-context-delta.js";
import {
	GROUP_CONTEXT_CUSTOM_TYPE,
	groupContextMessage,
	repairGroupContextRequest,
} from "../../server/device-center/group-context-message.js";

function row(id: string, text = id): GroupHistoryMessage {
	return {
		id,
		text,
		sender: { type: "human", id: "human", name: "Human" },
		createdAt: 1,
		textStart: 0,
		textEnd: text.length,
		fullTextLength: text.length,
	};
}
function context(ids: string[], overrides: Partial<GroupTaskContext> = {}): GroupTaskContext {
	return {
		roomId: "room",
		roomName: "Room",
		members: [{ id: "bot", name: "Bot" }],
		messages: ids.map((id) => row(id)),
		throughMessageId: ids.at(-1) ?? null,
		nextBefore: null,
		truncated: false,
		retentionLimit: 500,
		...overrides,
	};
}
function custom(value: unknown) {
	return { role: "custom", customType: GROUP_CONTEXT_CUSTOM_TYPE, content: JSON.stringify(value) };
}
function planned(current: GroupTaskContext, messages: readonly unknown[] = []): PlannedGroupTaskContext {
	return JSON.parse(groupContextMessage(current, messages).content);
}
function deliver(manager: SessionManager, current: GroupTaskContext) {
	const message = groupContextMessage(current, manager.buildSessionProjection().messages);
	return manager.appendCustomMessageEntry(message.customType, message.content, message.display);
}

describe("final request group-context repair", () => {
	function delivered(current: GroupTaskContext) {
		return { role: "custom" as const, ...groupContextMessage(current, [], "bot"), timestamp: 1 };
	}

	it("repairs only missing exact chunks despite an obsolete anchor, without mutation", () => {
		const current = context(["a", "b"]);
		const messages = [delivered(context(["a"], { throughMessageId: "evicted" }))];
		const before = structuredClone(messages);
		const repaired = repairGroupContextRequest(current, messages, "bot");
		expect(messages).toEqual(before);
		expect(repaired).not.toBe(messages);
		expect(JSON.parse(repaired.at(-1)!.content)).toMatchObject({ ...current, messages: [row("b")] });
	});

	it("skips intact coverage and current metadata even when a later delivery has an obsolete anchor", () => {
		const current = context(["a", "b"]);
		const messages = [delivered(current), delivered(context(["a"], { throughMessageId: "evicted" }))];
		expect(repairGroupContextRequest(current, messages, "bot")).toBe(messages);
	});

	it("updates only metadata when all chunks survive but no current metadata does", () => {
		const current = context(["a"], { roomName: "Renamed", primaryBotId: "bot" });
		const repaired = repairGroupContextRequest(current, [delivered(context(["a"]))], "bot");
		expect(JSON.parse(repaired.at(-1)!.content)).toMatchObject({ ...current, messages: [] });
	});

	it("does not treat summaries, wrong provenance or ephemeral repairs as durable coverage", () => {
		const current = context(["a"]);
		const repair = repairGroupContextRequest(current, [], "bot");
		expect(repairGroupContextRequest(current, repair, "bot")).toBe(repair);
		expect(JSON.parse(repair.at(-1)!.content).delivery.mode).toBe("snapshot");
		for (const messages of [
			repair,
			[{ ...delivered(current), details: { version: 1, botId: "other" } }],
			[{ role: "user", content: JSON.stringify(current) }],
		]) {
			expect(JSON.parse(groupContextMessage(current, messages, "bot").content).messages).toEqual(current.messages);
			expect(
				JSON.parse(repairGroupContextRequest(current, messages, "bot").at(-1)!.content as string).messages,
			).toEqual(current.messages);
		}
	});

	it("revalidates actual agent-core requests after preparation compaction and again on tool continuation", async () => {
		const current = context(["a", "b"]);
		const startDelivery = delivered(current);
		const requests: unknown[][] = [];
		const persistedViews: unknown[][] = [];
		const model = { api: "openai-completions", provider: "openai", id: "fixture" } as any;
		let prepares = 0;
		const loop = agentLoop(
			[{ role: "user", content: "task", timestamp: 1 }],
			{ messages: [startDelivery] },
			{
				model,
				// AgentSession performs virtual routing and compaction at this boundary.
				prepareRequest: ({ context: active }: any) => {
					prepares++;
					const messages = active.messages.filter((message: any) => message.customType !== GROUP_CONTEXT_CUSTOM_TYPE);
					return { context: { ...active, messages }, model };
				},
				transformContext: (messages: any[]) => {
					persistedViews.push(structuredClone(messages));
					const before = structuredClone(messages);
					const result = repairGroupContextRequest(current, messages, "bot");
					expect(messages).toEqual(before);
					return result;
				},
				convertToLlm: (messages: any[]) => messages,
			} as any,
			undefined,
			(_model, request) => {
				requests.push(structuredClone(request.messages));
				const stream = createAssistantMessageEventStream();
				const continuation = requests.length === 1;
				stream.push({
					type: "done",
					reason: continuation ? "toolUse" : "stop",
					message: {
						role: "assistant",
						content: continuation
							? [{ type: "toolCall", id: "call", name: "missing-tool", arguments: {} }]
							: [{ type: "text", text: "done" }],
						api: model.api,
						provider: model.provider,
						model: model.id,
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: continuation ? "toolUse" : "stop",
						timestamp: 2,
					},
				});
				return stream;
			},
		);
		for await (const _event of loop) {
			/* drain SDK loop */
		}
		expect(prepares).toBe(2);
		expect(requests).toHaveLength(2);
		for (const request of requests) {
			const repair = request.at(-1) as { content: string };
			expect(JSON.parse(repair.content)).toMatchObject(current);
		}
		expect((persistedViews[1] as any[]).some((message) => message.role === "toolResult")).toBe(true);
		expect(((await loop.result()) as any[]).some((message) => message.details?.requestOnly)).toBe(false);
	});
});

describe("Bot group-context custom messages", () => {
	it("delivers a hidden complete snapshot on a fresh session", () => {
		const current = context(["a"]);
		const message = groupContextMessage(current, []);
		expect(message).toMatchObject({
			customType: "device-group-context",
			content: JSON.stringify({ ...current, delivery: { mode: "snapshot" } }),
			display: false,
		});
	});

	it("delivers only new chunks and keeps current metadata", () => {
		const current = context(["a", "b"], { roomName: "Renamed", primaryBotId: "bot", truncated: true });
		expect(planned(current, [custom(context(["a"]))])).toEqual({
			...current,
			messages: [row("b")],
			delivery: { mode: "delta", previousThroughMessageId: "a" },
		});
	});

	it("aggregates retained snapshots and multiple deltas using the newest anchor", () => {
		const manager = SessionManager.inMemory();
		deliver(manager, context(["a"]));
		deliver(manager, context(["a", "b"]));
		deliver(manager, context(["a", "b", "c"]));
		const result = planned(context(["a", "b", "c", "d"]), manager.buildSessionProjection().messages);
		expect(result.messages).toEqual([row("d")]);
		expect(result.delivery).toEqual({ mode: "delta", previousThroughMessageId: "c" });
	});

	it("resends a snapshot when compaction leaves only a summary containing the old payload", () => {
		const manager = SessionManager.inMemory();
		const current = context(["a"]);
		deliver(manager, current);
		manager.appendCompaction(JSON.stringify(custom(current)), null, 1000);
		expect(planned(current, manager.buildSessionProjection().messages)).toEqual({
			...current,
			delivery: { mode: "snapshot" },
		});
	});

	it("uses only chunks retained after compaction, even if an older snapshot is still on disk", () => {
		const manager = SessionManager.inMemory();
		deliver(manager, context(["a"]));
		const kept = deliver(manager, context(["a", "b"]));
		manager.appendCompaction("Earlier group context delivered", kept, 1000);
		const result = planned(context(["a", "b", "c"]), manager.buildSessionProjection().messages);
		expect(result.messages).toEqual([row("a"), row("c")]);
		expect(result.delivery).toEqual({ mode: "delta", previousThroughMessageId: "b" });
	});

	it("uses edited content and ignores details and removed context entries", () => {
		const manager = SessionManager.inMemory();
		const entry = deliver(manager, context(["a"]));
		manager.appendContextEdit(entry, { content: JSON.stringify(context(["b"])) });
		expect(planned(context(["a", "b"]), manager.buildSessionProjection().messages).messages).toEqual([row("a")]);
		manager.appendContextEdit(entry, null);
		expect(planned(context(["a", "b"]), manager.buildSessionProjection().messages).delivery.mode).toBe("snapshot");
		expect(planned(context(["a"]), [{ ...custom({}), details: context(["a"]) }]).delivery.mode).toBe("snapshot");
	});

	it("ignores malformed payloads without throwing or manufacturing prior evidence", () => {
		const current = context(["a"]);
		const invalid = [
			null,
			{},
			{ ...current, messages: [{}] },
			{ ...current, throughMessageId: 9 },
			{ ...current, members: [null] },
			{ ...current, messages: [{ ...row("a"), textEnd: 99 }] },
		];
		for (const value of invalid) {
			expect(planned(current, [custom(value)]).delivery.mode).toBe("snapshot");
		}
		for (const content of ["{", undefined, [{ type: "image", data: "abc" }]]) {
			expect(planned(current, [{ ...custom(current), content }]).delivery.mode).toBe("snapshot");
		}
	});

	it("ignores spoofed user/tool messages, summaries and similar custom types", () => {
		const current = context(["a"]);
		const messages = ["user", "toolResult", "assistant", "compactionSummary", "branchSummary"].map((role) => ({
			...custom(current),
			role,
		}));
		messages.push({ ...custom(current), customType: "device-group-context-spoof" });
		expect(planned(current, messages).delivery.mode).toBe("snapshot");
	});

	it("ignores other rooms and uses the newest same-room anchor even across interleaving", () => {
		const messages = [custom(context(["a"])), custom(context(["z"], { roomId: "other" }))];
		expect(planned(context(["a", "b"]), messages).messages).toEqual([row("b")]);
		expect(planned(context(["a"]), [messages[1]]).delivery.mode).toBe("snapshot");
		expect(planned(context(["b"]), messages).delivery).toEqual({
			mode: "snapshot",
			previousThroughMessageId: "a",
			gap: true,
		});
	});

	it("supports actual text-block content and resends changed chunks", () => {
		const previous = context(["a"]);
		const current = context(["a"], { messages: [row("a", "edited")] });
		const message = { ...custom(previous), content: [{ type: "text", text: JSON.stringify(previous) }] };
		expect(planned(current, [message]).messages).toEqual(current.messages);
	});

	it("checks Bot provenance in details but takes chunk evidence exclusively from content", () => {
		const current = context(["a"]);
		const message = groupContextMessage(current, [], "bot");
		expect(message.details).toMatchObject({ version: 1, botId: "bot" });
		const projected = { ...message, role: "custom" };
		expect(JSON.parse(groupContextMessage(current, [projected], "bot").content).messages).toEqual([]);
		for (const details of [undefined, { version: 1, botId: "other" }, { version: 2, botId: "bot" }]) {
			expect(JSON.parse(groupContextMessage(current, [{ ...projected, details }], "bot").content).delivery.mode).toBe(
				"snapshot",
			);
		}
		expect(
			JSON.parse(groupContextMessage(current, [{ ...projected, content: "{}" }], "bot").content).delivery.mode,
		).toBe("snapshot");
	});

	it("does not mutate frozen current context or prior messages", () => {
		const current = context(["a", "b"]);
		const messages = [custom(context(["a"]))];
		const before = structuredClone({ current, messages });
		Object.freeze(current.messages);
		Object.freeze(current);
		Object.freeze(messages[0]);
		Object.freeze(messages);
		groupContextMessage(current, messages);
		expect({ current, messages }).toEqual(before);
	});
});
