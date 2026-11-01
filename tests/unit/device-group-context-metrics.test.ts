import { describe, expect, it } from "vitest";
import type { GroupTaskContext } from "../../server/device-center/group-context.js";
import {
	extractGroupContextMetrics,
	getGroupContextMetrics,
	groupContextMessage,
	recordGroupContextMetrics,
	repairGroupContextRequest,
} from "../../server/device-center/group-context-message.js";

function context(texts = ["你好🙂", "ASCII"]): GroupTaskContext {
	return {
		roomId: "room",
		roomName: "Room",
		members: [],
		throughMessageId: "1",
		nextBefore: null,
		truncated: false,
		retentionLimit: 500,
		messages: texts.map((text, i) => ({
			id: String(i),
			text,
			sender: { type: "human", id: "human", name: "Human" },
			createdAt: 1,
			textStart: 0,
			textEnd: text.length,
			fullTextLength: text.length,
		})),
	};
}
function durable(current = context()) {
	return { role: "custom" as const, ...groupContextMessage(current, [], "bot"), timestamp: 1 };
}

describe("group context metrics", () => {
	it("measures UTF8 text separately from exact JSON payload without mutating input", () => {
		const current = context();
		const before = structuredClone(current);
		const message = groupContextMessage(current, [], "bot");
		expect(message.details.metrics).toEqual({
			version: 1,
			sourceMessages: 2,
			sourceBytes: 15,
			deliveredMessages: 2,
			deliveredBytes: 15,
			omittedDuplicateMessages: 0,
			omittedDuplicateBytes: 0,
			payloadBytes: Buffer.byteLength(message.content),
			mode: "snapshot",
			requestOnly: false,
			repairMessages: 0,
			repairBytes: 0,
		});
		expect(message.details).toMatchObject({ version: 1, botId: "bot" });
		expect(message.content).not.toContain('"metrics"');
		expect(current).toEqual(before);
	});

	it("counts exact retained chunks and measures delta metadata even with no new rows", () => {
		const current = context();
		const previous = durable({ ...current, messages: current.messages.slice(0, 1), throughMessageId: "0" });
		const delta = groupContextMessage(current, [previous], "bot");
		expect(delta.details.metrics).toMatchObject({
			sourceBytes: 15,
			deliveredMessages: 1,
			deliveredBytes: 5,
			omittedDuplicateMessages: 1,
			omittedDuplicateBytes: 10,
			mode: "delta",
		});
		const covered = groupContextMessage(current, [durable(current)], "bot");
		expect(covered.details.metrics).toMatchObject({
			deliveredMessages: 0,
			deliveredBytes: 0,
			omittedDuplicateMessages: 2,
			omittedDuplicateBytes: 15,
			mode: "delta",
		});
		expect(covered.details.metrics.payloadBytes).toBeGreaterThan(0);
	});

	it("preserves snapshot gap semantics and counts chunks sharing a message ID", () => {
		const current = context(["甲", "乙"]);
		current.messages[1].id = current.messages[0].id;
		const message = groupContextMessage(current, [durable({ ...context(), throughMessageId: "evicted" })], "bot");
		expect(message.details.metrics).toMatchObject({
			sourceMessages: 2,
			sourceBytes: 6,
			deliveredMessages: 2,
			deliveredBytes: 6,
			mode: "snapshot",
			omittedDuplicateMessages: 0,
		});
		expect(JSON.parse(message.content).delivery.gap).toBe(true);
	});

	it("measures full and metadata-only ephemeral repairs without modifying transcripts", () => {
		const current = context();
		const full = repairGroupContextRequest(current, [], "bot").at(-1)!;
		expect(full.details).toMatchObject({
			version: 1,
			botId: "bot",
			requestOnly: true,
			metrics: { requestOnly: true, mode: "snapshot", repairMessages: 2, deliveredBytes: 15 },
		});
		expect(full.details.metrics.repairBytes).toBe(Buffer.byteLength(full.content));
		const messages = [durable(current)];
		const before = structuredClone(messages);
		const repaired = repairGroupContextRequest({ ...current, roomName: "Renamed" }, messages, "bot");
		const metadata = repaired.at(-1)!;
		expect(metadata.details.metrics).toMatchObject({
			requestOnly: true,
			mode: "delta",
			repairMessages: 0,
			deliveredBytes: 0,
			omittedDuplicateMessages: 2,
		});
		expect(metadata.details.metrics.repairBytes).toBeGreaterThan(0);
		expect(messages).toEqual(before);
		expect(repairGroupContextRequest(current, messages, "bot")).toBe(messages);
		expect(extractGroupContextMetrics(current, [], "", "none", true)).toMatchObject({
			mode: "none",
			payloadBytes: 0,
			repairBytes: 0,
			repairMessages: 0,
		});
	});

	it("stores only numeric metrics and enum/boolean fields, never raw text or extra properties", () => {
		const current = context(["secret-credential"]);
		const metrics = extractGroupContextMetrics(current, current.messages, "{}", "snapshot");
		recordGroupContextMetrics("privacy", { ...metrics, rawText: "secret-credential" } as typeof metrics);
		const snapshot = getGroupContextMetrics("privacy");
		expect(JSON.stringify(snapshot)).not.toContain("secret-credential");
		expect(snapshot.lastSample).toEqual(metrics);
		expect(
			Object.values(metrics).every(
				(value) => typeof value === "number" || typeof value === "boolean" || value === "snapshot",
			),
		).toBe(true);
		snapshot.samples[0].sourceBytes = 999;
		snapshot.lastSample!.sourceBytes = 999;
		expect(getGroupContextMetrics("privacy").lastSample).toEqual(metrics);
	});

	it("bounds samples and sessions and isolates inspection snapshots", () => {
		const metrics = extractGroupContextMetrics(context(), [], "", "none", true);
		for (let i = 0; i < 105; i++) recordGroupContextMetrics("bounded", { ...metrics, sourceMessages: i });
		const snapshot = getGroupContextMetrics("bounded");
		expect(snapshot).toMatchObject({
			version: 1,
			processLocal: true,
			sampleLimit: 100,
			sampleCount: 100,
			durableDeliveries: 0,
			requests: 100,
		});
		expect(snapshot.samples).toHaveLength(10);
		expect(snapshot.samples[0].sourceMessages).toBe(95);
		expect(snapshot.lastSample?.sourceMessages).toBe(104);
		for (let i = 0; i < 50; i++) recordGroupContextMetrics(`eviction-${i}`, metrics);
		expect(getGroupContextMetrics("bounded").sampleCount).toBe(0);
		expect(getGroupContextMetrics("eviction-49").sampleCount).toBe(1);
		expect(getGroupContextMetrics("unknown").lastSample).toBeNull();
	});
});
