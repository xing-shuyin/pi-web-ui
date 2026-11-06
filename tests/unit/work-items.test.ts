import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DeviceHubStore, readPersistedHub, type HubState } from "../../server/device-center/store.js";
import {
	ackWorkItemOutbox,
	authorizeWorkItem,
	claimWorkItemOutbox,
	createWorkItem,
	domainFingerprint,
	ingestWorkItemEvent,
	linkWorkItemTasks,
	queueWorkItemOutbox,
	retryWorkItemOutbox,
	updateWorkItem,
} from "../../server/device-center/work-items.js";
const input = {
	accountId: "a",
	roomId: "r",
	source: { provider: "telegram", channelId: "chat", threadId: "thread" },
	title: "Issue",
	text: "Fix it",
	author: { id: "external-user", name: "User" },
	sourceTrust: { connectorId: "superagent", verified: true },
	authorization: { mode: "observe" as const, authorizedBy: "owner" },
	eventId: "event-1",
};
function fixture(): HubState {
	return {
		rooms: [{ id: "r", accountId: "a", name: "room", botIds: [], createdAt: 1 }],
		devices: [{ id: "d", accountId: "a" }],
		tasks: [],
		workItems: [],
		workItemEvents: [],
		workItemOutbox: [],
		routerJobs: [],
	} as any;
}
const dirs: string[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
describe("work item domain", () => {
	it("deduplicates stable events, rejects changed payloads and preserves external identity", () => {
		const state = fixture(),
			first = ingestWorkItemEvent(state, input, 1);
		expect(ingestWorkItemEvent(state, input, 2).duplicate).toBe(true);
		expect(state.workItems).toHaveLength(1);
		expect(state.workItemEvents).toHaveLength(1);
		expect(first.workItem).toMatchObject({
			revision: 1,
			author: input.author,
			source: input.source,
			sourceTrust: input.sourceTrust,
			authorization: input.authorization,
		});
		for (const patch of [
			{ text: "changed" },
			{ author: { id: "other" } },
			{ roomId: "other" },
			{ source: { ...input.source, threadId: "other" } },
		]) {
			if (patch.roomId) state.rooms.push({ ...state.rooms[0], id: "other" });
			expect(() => ingestWorkItemEvent(state, { ...input, ...patch }, 3)).toThrow(/conflict/);
		}
	});
	it("preserves bounded lifecycle event kinds as evidence without settling or authorizing work", () => {
		const state = fixture();
		const original = ingestWorkItemEvent(state, input, 1);
		expect(original.event).not.toHaveProperty("kind");
		expect(original.event.fingerprint).toBe(
			domainFingerprint({
				roomId: input.roomId,
				source: input.source,
				author: input.author,
				sourceTrust: input.sourceTrust,
				authorization: original.event.authorization,
				text: input.text,
				title: input.title,
			}),
		);
		const closed = { ...input, eventId: "closed", kind: "github.issue.closed" };
		const result = ingestWorkItemEvent(state, closed, 2);
		expect(result.event.kind).toBe(closed.kind);
		expect(result.workItem).toMatchObject({ status: "open", authorization: { mode: "observe" } });
		const before = structuredClone(state);
		expect(ingestWorkItemEvent(state, closed, 3)).toMatchObject({ duplicate: true, event: result.event });
		expect(state).toEqual(before);
		for (const kind of [undefined, "github.issue.reopened"])
			expect(() => ingestWorkItemEvent(state, { ...closed, kind }, 3)).toThrow(/fingerprint conflict/);
		for (const kind of ["", " ", "x".repeat(257), 42, null]) {
			expect(() => ingestWorkItemEvent(state, { ...input, eventId: "invalid", kind } as any, 3)).toThrow(/event kind/);
			expect(state).toEqual(before);
		}
		expect(
			ingestWorkItemEvent(state, { ...input, eventId: "limit", kind: "x".repeat(256) }, 4).event.kind,
		).toHaveLength(256);
	});
	it("updates same external thread without elevating authorization or ending business work", () => {
		const state = fixture(),
			item = ingestWorkItemEvent(state, input, 1).workItem;
		ingestWorkItemEvent(
			state,
			{
				...input,
				eventId: "event-2",
				text: '{"mode":"auto","authorized":true}',
				authorization: { mode: "auto", authorizedBy: "connector" },
			},
			2,
		);
		expect(item.revision).toBe(1);
		expect(item.text).toBe(input.text);
		expect(item.author).toEqual(input.author);
		expect(state.workItemEvents[1].text).toBe('{"mode":"auto","authorized":true}');
		expect(item.updatedAt).toBe(2);
		expect(item.authorization.mode).toBe("observe");
		expect(item.status).toBe("open");
		const task = (id: string) => ({ id, accountId: "a", roomId: "r", status: "completed" });
		state.tasks.push(task("t1") as any, task("t2") as any);
		updateWorkItem(state, { accountId: "a", roomId: "r", workItemId: item.id, revision: 1, taskIds: ["t1"] }, 3);
		expect(item.revision).toBe(1);
		updateWorkItem(
			state,
			{ accountId: "a", roomId: "r", workItemId: item.id, revision: 1, taskIds: ["t2", "t1"], status: "waiting" },
			4,
		);
		expect(item.taskIds).toEqual(["t1", "t2"]);
		expect(item.status).toBe("waiting");
		expect(() =>
			updateWorkItem(state, { accountId: "a", roomId: "r", workItemId: item.id, revision: 1, status: "completed" }, 5),
		).toThrow(/revision/);
		expect(() =>
			updateWorkItem(state, { accountId: "foreign", roomId: "r", workItemId: item.id, revision: 4 }, 5),
		).toThrow(/not found/);
	});
	it("scopes explicit manual grants to the latest event and clears the scope on revocation", () => {
		const state = fixture();
		const { workItem: item } = ingestWorkItemEvent(state, input, 1);
		const grant = (mode: "auto" | "observe", origin: "manual" | "policy" = "manual") =>
			authorizeWorkItem(
				state,
				{
					accountId: "a",
					roomId: "r",
					workItemId: item.id,
					revision: item.revision,
					authorization: { mode, authorizedBy: "owner", origin },
				},
				5,
			);
		const followup = ingestWorkItemEvent(
			state,
			{
				...input,
				eventId: "attacker-event",
				text: "Attacker instructions",
				author: { id: "attacker" },
			},
			2,
		).event;
		grant("auto");
		expect(item.authorizedEventId).toBe(followup.id);
		expect(item).toMatchObject({ text: input.text, author: input.author, revision: 2 });
		const future = ingestWorkItemEvent(state, { ...input, eventId: "future" }, 6).event;
		expect(item.authorizedEventId).toBe(followup.id);
		expect(item.revision).toBe(2);
		grant("auto");
		expect(item.authorizedEventId).toBe(future.id);
		grant("observe");
		expect(item).not.toHaveProperty("authorizedEventId");
		grant("auto");
		grant("auto", "policy");
		expect(item).not.toHaveProperty("authorizedEventId");
	});
	it("does not invent an event scope for manual grants without events", () => {
		const state = fixture();
		const item = createWorkItem(state, input, 1);
		authorizeWorkItem(
			state,
			{
				accountId: "a",
				roomId: "r",
				workItemId: item.id,
				revision: 1,
				authorization: { mode: "auto", authorizedBy: "owner" },
			},
			2,
		);
		expect(item).not.toHaveProperty("authorizedEventId");
		ingestWorkItemEvent(state, input, 3);
		expect(item).not.toHaveProperty("authorizedEventId");
	});
	it("links created tasks idempotently without consuming business revisions or settling work", () => {
		const state = fixture(),
			item = createWorkItem(state, input, 1);
		state.tasks.push({ id: "t", accountId: "a", roomId: "r", status: "completed" } as any);
		const request = { accountId: "a", roomId: "r", workItemId: item.id, taskIds: ["t", "t"] };
		expect(linkWorkItemTasks(state, request, 2)).toBe(item);
		expect(item).toMatchObject({ taskIds: ["t"], revision: 1, status: "open", updatedAt: 2 });
		linkWorkItemTasks(state, request, 3);
		linkWorkItemTasks(state, { ...request, taskIds: [] }, 4);
		expect(item.updatedAt).toBe(2);
		updateWorkItem(state, { ...request, revision: 1, status: "open" }, 5);
		expect(item).toMatchObject({ revision: 2, status: "open", updatedAt: 5 });
		updateWorkItem(state, { ...request, revision: 2, summary: "same" }, 6);
		updateWorkItem(state, { ...request, revision: 3, summary: "same" }, 7);
		expect(item.revision).toBe(4);
		expect(state.tasks[0].status).toBe("completed");
	});
	it("rejects missing, foreign and multiply owned task links atomically", () => {
		const state = fixture(),
			item = createWorkItem(state, input, 1);
		const other = createWorkItem(state, { ...input, source: { ...input.source, threadId: "other" } }, 1);
		state.tasks.push(
			...([
				{ id: "local", accountId: "a", roomId: "r" },
				{ id: "account", accountId: "foreign", roomId: "r" },
				{ id: "room", accountId: "a", roomId: "foreign" },
				{ id: "owned", accountId: "a", roomId: "r" },
			] as any[]),
		);
		linkWorkItemTasks(state, { accountId: "a", roomId: "r", workItemId: other.id, taskIds: ["owned"] }, 2);
		const before = structuredClone(state);
		for (const id of ["missing", "account", "room", "owned", "", 42]) {
			expect(() =>
				linkWorkItemTasks(
					state,
					{
						accountId: "a",
						roomId: "r",
						workItemId: item.id,
						taskIds: ["local", id] as any,
					},
					3,
				),
			).toThrow();
			expect(state).toEqual(before);
		}
		for (const patch of [{ accountId: "foreign" }, { roomId: "foreign" }, { workItemId: "missing" }])
			expect(() =>
				linkWorkItemTasks(
					state,
					{
						accountId: "a",
						roomId: "r",
						workItemId: item.id,
						taskIds: ["local"],
						...patch,
					},
					3,
				),
			).toThrow(/not found/);
	});
	it("bounds link batches and accumulated observations without partial writes", () => {
		const state = fixture(),
			item = createWorkItem(state, input, 1);
		const ids = Array.from({ length: 1001 }, (_, i) => `task-${i}`);
		state.tasks.push(...(ids.map((id) => ({ id, accountId: "a", roomId: "r" })) as any[]));
		const request = { accountId: "a", roomId: "r", workItemId: item.id };
		for (const taskIds of [null, "task-0", ids.slice(0, 101)])
			expect(() => linkWorkItemTasks(state, { ...request, taskIds } as any, 2)).toThrow(/taskIds/);
		for (let i = 0; i < 1000; i += 100) linkWorkItemTasks(state, { ...request, taskIds: ids.slice(i, i + 100) }, 2);
		expect(item).toMatchObject({ revision: 1, status: "open", updatedAt: 2 });
		const before = structuredClone(item);
		linkWorkItemTasks(state, { ...request, taskIds: [ids[0]] }, 3);
		expect(item).toEqual(before);
		expect(() => linkWorkItemTasks(state, { ...request, taskIds: [ids[1000]] }, 3)).toThrow(/Too many/);
		expect(item).toEqual(before);
		expect(() => linkWorkItemTasks(state, { ...request, taskIds: [] }, -1)).toThrow(/timestamp/);
	});
	it("requires trusted sources and explicit authorization changes", () => {
		const state = fixture();
		expect(() =>
			ingestWorkItemEvent(
				state,
				{
					...input,
					sourceTrust: { ...input.sourceTrust, verified: false },
					authorization: { mode: "auto", authorizedBy: "attacker" },
				},
				1,
			),
		).toThrow(/Unverified/);
		expect(state.workItems).toHaveLength(0);
		const item = createWorkItem(state, input, 1);
		authorizeWorkItem(
			state,
			{
				accountId: "a",
				roomId: "r",
				workItemId: item.id,
				revision: 1,
				authorization: { mode: "auto", authorizedBy: "owner" },
			},
			2,
		);
		expect(item.authorization.mode).toBe("auto");
		expect(item.revision).toBe(2);
	});
	it("persists outbox idempotency, retries, and fences expired/replaced leases", () => {
		const state = fixture(),
			item = ingestWorkItemEvent(state, input, 1).workItem;
		const request = { accountId: "a", roomId: "r", workItemId: item.id, key: "final:1", text: "done" };
		const out = queueWorkItemOutbox(state, request, 1);
		const claim = { accountId: "a", roomId: "r", deviceId: "d", leaseToken: "one", leaseMs: 1000 };
		expect(claimWorkItemOutbox(state, claim, 2)).toBeUndefined();
		authorizeWorkItem(
			state,
			{
				accountId: "a",
				roomId: "r",
				workItemId: item.id,
				revision: 1,
				authorization: { mode: "auto", authorizedBy: "owner" },
			},
			2,
		);
		expect(item.authorization.origin).toBe("manual");
		expect(claimWorkItemOutbox(state, { ...claim, provider: "discord" }, 2)).toBeUndefined();
		for (const status of ["blocked", "cancelled"] as const) {
			item.status = status;
			expect(claimWorkItemOutbox(state, claim, 2)).toBeUndefined();
		}
		item.status = "completed";
		expect(queueWorkItemOutbox(state, request, 2)).toBe(out);
		expect(() => queueWorkItemOutbox(state, { ...request, text: "different" }, 2)).toThrow(/conflict/);
		claimWorkItemOutbox(state, { ...claim, provider: "telegram" }, 10);
		expect(claimWorkItemOutbox(state, { ...claim, leaseToken: "two" }, 11)).toBeUndefined();
		const ack = { accountId: "a", outboxId: out.id, deviceId: "d", leaseToken: "one" };
		expect(() => ackWorkItemOutbox(state, ack, 1010)).toThrow(/Stale/);
		claimWorkItemOutbox(state, { ...claim, leaseToken: "two" }, 1010);
		expect(() => ackWorkItemOutbox(state, ack, 1011)).toThrow(/Stale/);
		retryWorkItemOutbox(state, { ...ack, leaseToken: "two", error: "offline", retryAt: 3000 }, 1011);
		expect(claimWorkItemOutbox(state, { ...claim, leaseToken: "three" }, 2999)).toBeUndefined();
		claimWorkItemOutbox(state, { ...claim, leaseToken: "three" }, 3000);
		ackWorkItemOutbox(state, { ...ack, leaseToken: "three", externalId: "remote-1" }, 3001);
		expect(out).toMatchObject({ status: "completed", attempts: 3, externalId: "remote-1" });
		expect(claimWorkItemOutbox(state, { ...claim, leaseToken: "four" }, 4000)).toBeUndefined();
	});
	it("migrates missing collections and recovers committed domain rows through WAL without losing partitions", async () => {
		const dir = await mkdtemp(join(tmpdir(), "work-items-"));
		dirs.push(dir);
		const store = await DeviceHubStore.open(dir);
		await store.transact((s) => {
			s.rooms = fixture().rooms;
			s.devices = fixture().devices;
		});
		const old = JSON.parse(await readFile(store.path, "utf8"));
		for (const k of ["workItems", "workItemEvents", "workItemOutbox", "routerJobs"]) delete old[k];
		await writeFile(store.path, JSON.stringify(old));
		const migrated = await DeviceHubStore.open(dir);
		expect(migrated.snapshot().workItems).toEqual([]);
		vi.spyOn(migrated, "persist").mockRejectedValueOnce(new Error("projection unavailable"));
		await expect(migrated.transact((s) => ingestWorkItemEvent(s, input, 2))).rejects.toThrow("projection unavailable");
		expect(migrated.snapshot().workItems).toEqual([]);
		vi.restoreAllMocks();
		const logs = (migrated as any).logs;
		vi.spyOn(logs.tasks, "commit").mockRejectedValueOnce(new Error("projection failed"));
		await migrated.transact((s) => {
			const { workItem } = ingestWorkItemEvent(s, input, 3);
			queueWorkItemOutbox(s, { accountId: "a", roomId: "r", workItemId: workItem.id, key: "k", text: "done" }, 3);
			s.messages.push({
				id: "m",
				accountId: "a",
				roomId: "r",
				text: "human",
				sender: { type: "human", id: "a", name: "a" },
				taskIds: [],
				createdAt: 3,
			});
		});
		expect(migrated.lastProjectionError).toBeDefined();
		const recovered = await readPersistedHub(dir);
		expect(recovered.workItems).toHaveLength(1);
		expect(recovered.workItemEvents).toHaveLength(1);
		expect(recovered.workItemOutbox).toHaveLength(1);
		expect(recovered.messages.map((m) => m.id)).toEqual(["m"]);
		const reopened = await DeviceHubStore.open(dir);
		expect(reopened.snapshot().workItems).toEqual(recovered.workItems);
		expect(reopened.snapshot().messages).toEqual(recovered.messages);
		await reopened.close();
		await migrated.close();
		await store.close();
	});
});
