import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeviceHubStore, readPersistedHub, type HubState } from "../../server/device-center/store.js";
import {
	claimRouterJob,
	completeRouterJob,
	failRouterJob,
	markRouterActionApplied,
	nextRouterAction,
	prepareRouterActions,
	queueRouterJob,
	renewRouterJobLease,
	retryRouterJob,
	routerActionKey,
	updateGroupRouterConfig,
	validateGroupRouterConfig,
	validateRouterActions,
	type RouterAction,
} from "../../server/device-center/group-router.js";
import {
	authorizeWorkItem,
	ingestWorkItemEvent,
	linkWorkItemTasks,
	updateWorkItem,
} from "../../server/device-center/work-items.js";
function fixture(): HubState {
	return {
		rooms: [{ id: "r", accountId: "a", name: "room", botIds: ["b"], primaryBotId: "b", createdAt: 1 }],
		devices: [
			{ id: "d", accountId: "a" },
			{ id: "d2", accountId: "a" },
		],
		bots: [{ id: "b", accountId: "a", deviceId: "d", enabled: true }],
		messages: [
			{
				id: "m",
				accountId: "a",
				roomId: "r",
				text: "help",
				sender: { type: "human", id: "a", name: "Owner" },
				createdAt: 1,
				taskIds: [],
			},
		],
		tasks: [],
		routerJobs: [],
		workItems: [],
		workItemEvents: [],
		workItemOutbox: [],
	} as any;
}
const config = {
	enabled: true,
	deviceId: "d",
	model: "provider/model",
	thinkingLevel: "high",
	tools: ["reply", "dispatch", "work_items"] as ("reply" | "dispatch" | "work_items")[],
};
const queue = {
	accountId: "a",
	roomId: "r",
	eventKey: "message:m",
	trigger: { type: "human_message" as const, messageId: "m" },
	text: "help",
};
const claim = { accountId: "a", roomId: "r", deviceId: "d", leaseToken: "one", leaseMs: 1000 };
function setup() {
	const state = fixture();
	updateGroupRouterConfig(state, { accountId: "a", roomId: "r", config }, 1);
	const job = queueRouterJob(state, queue, 2)!;
	claimRouterJob(state, claim, 3);
	const lease = { accountId: "a", jobId: job.id, deviceId: "d", leaseToken: "one" };
	return { state, job, lease };
}
function seedWorkItem(state: HubState, threadId = "thread") {
	return ingestWorkItemEvent(
		state,
		{
			accountId: "a",
			roomId: "r",
			source: { provider: "tg", channelId: "c", threadId },
			eventId: `event:${threadId}`,
			title: "Issue",
			text: "Execute",
			author: { id: "external" },
			sourceTrust: { connectorId: "connector", verified: true },
			authorization: { mode: "auto", authorizedBy: "owner" },
		},
		1,
	);
}
function setupOrigin(type: "work_item" | "task_result") {
	const state = fixture();
	updateGroupRouterConfig(state, { accountId: "a", roomId: "r", config }, 1);
	const { workItem: item, event } = seedWorkItem(state);
	state.tasks.push({ id: "origin-task", accountId: "a", roomId: "r", status: "completed" } as any);
	linkWorkItemTasks(state, { accountId: "a", roomId: "r", workItemId: item.id, taskIds: ["origin-task"] }, 2);
	const trigger =
		type === "work_item" ? { type, workItemId: item.id, eventId: event.id } : { type, taskId: "origin-task" };
	const job = queueRouterJob(state, { accountId: "a", roomId: "r", eventKey: "origin", trigger }, 2)!;
	claimRouterJob(state, claim, 3);
	return { state, item, job, lease: { accountId: "a", jobId: job.id, deviceId: "d", leaseToken: "one" } };
}
const dirs: string[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
describe("group router domain", () => {
	it("keeps legacy primaryBotId disabled by default and validates independent config", () => {
		const state = fixture();
		expect(queueRouterJob(state, queue, 1)).toBeUndefined();
		expect(state.rooms[0].primaryBotId).toBe("b");
		for (const c of [
			{ ...config, enabled: "yes" },
			{ ...config, tools: ["bash"] },
			{ ...config, tools: ["reply", "reply"] },
			{ ...config, model: "" },
		])
			expect(() => validateGroupRouterConfig(c)).toThrow();
		expect(() =>
			updateGroupRouterConfig(state, { accountId: "a", roomId: "r", config: { ...config, deviceId: "foreign" } }, 1),
		).toThrow(/not found/);
		updateGroupRouterConfig(state, { accountId: "a", roomId: "r", config }, 1);
		expect(state.rooms[0].routerRevision).toBe(1);
		expect(state.rooms[0].primaryBotId).toBe("b");
	});
	it.each([true, false])("binds manual authorization to one disallowed followup (verified=%s)", (verified) => {
		const state = fixture();
		updateGroupRouterConfig(state, { accountId: "a", roomId: "r", config }, 1);
		const { workItem: item, event: original } = seedWorkItem(state);
		const request = (eventId: string) => ({
			accountId: "a",
			roomId: "r",
			eventKey: `work-item:${eventId}`,
			trigger: { type: "work_item" as const, workItemId: item.id, eventId },
		});
		const originalJob = queueRouterJob(state, request(original.id), 2)!;
		expect(originalJob).toBeDefined();
		claimRouterJob(state, claim, 3);
		completeRouterJob(
			state,
			{ accountId: "a", jobId: originalJob.id, deviceId: "d", leaseToken: "one", actions: [] },
			4,
		);
		const followup = (eventId: string, mode: "auto" | "observe", trusted = verified) =>
			ingestWorkItemEvent(
				state,
				{
					accountId: "a",
					roomId: "r",
					source: original.source,
					title: "Issue",
					text: `Instructions from ${eventId}`,
					author: { id: mode === "auto" ? "allowed-author" : "disallowed-author" },
					sourceTrust: { connectorId: "connector", verified: trusted },
					authorization: { mode, authorizedBy: "connector-allowAuthors" },
					eventId,
				},
				5,
			).event;
		const denied = followup("disallowed", "observe");
		expect(item.authorization.mode).toBe("auto");
		expect(item).toMatchObject({ text: "Execute", author: { id: "external" }, revision: 1 });
		expect(queueRouterJob(state, request(denied.id), 6)).toBeUndefined();
		expect(state.routerJobs).toHaveLength(1);
		authorizeWorkItem(
			state,
			{
				accountId: "a",
				roomId: "r",
				workItemId: item.id,
				revision: item.revision,
				authorization: { mode: "auto", authorizedBy: "owner" },
			},
			7,
		);
		expect(item.authorizedEventId).toBe(denied.id);
		const manualJob = queueRouterJob(state, request(denied.id), 8)!;
		expect(manualJob).toBeDefined();
		claimRouterJob(state, { ...claim, leaseToken: "manual" }, 9);
		const lease = { accountId: "a", jobId: manualJob.id, deviceId: "d", leaseToken: "manual" };
		const actions: RouterAction[] = [
			{ type: "dispatch", botId: "b", text: "Approved instructions" },
			{ type: "work_item_update", workItemId: item.id, revision: item.revision, status: "running" },
		];
		prepareRouterActions(state, { ...lease, actions }, 10);
		expect(nextRouterAction(state, lease, 11)?.action).toMatchObject({ type: "dispatch", workItemId: item.id });
		const future = followup("disallowed-future", "observe");
		expect(queueRouterJob(state, request(future.id), 12)).toBeUndefined();
		expect(nextRouterAction(state, lease, 13)?.action.type).toBe("dispatch");
		const allowed = followup("allowed-future", "auto", true);
		expect(queueRouterJob(state, request(allowed.id), 14)).toBeDefined();
		authorizeWorkItem(
			state,
			{
				accountId: "a",
				roomId: "r",
				workItemId: item.id,
				revision: item.revision,
				authorization: { mode: "observe", authorizedBy: "owner" },
			},
			15,
		);
		expect(queueRouterJob(state, request(denied.id), 16)).toBeUndefined();
		expect(queueRouterJob(state, request(allowed.id), 16)).toBeUndefined();
		expect(() => prepareRouterActions(state, { ...lease, actions }, 17)).toThrow(/authorize/);
		expect(() => nextRouterAction(state, lease, 17)).toThrow(/authorize/);
	});
	it("rechecks the event of an existing frozen job, including legacy manual authorizations", () => {
		const { state, item, job, lease } = setupOrigin("work_item");
		const actions: RouterAction[] = [{ type: "reply", text: "Execute instructions" }];
		prepareRouterActions(state, { ...lease, actions }, 4);
		state.workItemEvents[0].authorization.mode = "observe";
		item.authorization.origin = "manual";
		expect(item.authorizedEventId).toBeUndefined();
		expect(
			queueRouterJob(
				state,
				{
					accountId: "a",
					roomId: "r",
					eventKey: job.eventKey,
					trigger: job.trigger,
				},
				5,
			),
		).toBeUndefined();
		expect(() => prepareRouterActions(state, { ...lease, actions }, 5)).toThrow(/authorize/);
		expect(() => nextRouterAction(state, lease, 5)).toThrow(/authorize/);
		delete job.actions;
		expect(() => prepareRouterActions(state, { ...lease, actions }, 5)).toThrow(/authorize/);
		const grant = () =>
			authorizeWorkItem(
				state,
				{
					accountId: "a",
					roomId: "r",
					workItemId: item.id,
					revision: item.revision,
					authorization: { mode: "auto", authorizedBy: "owner" },
				},
				6,
			);
		grant();
		prepareRouterActions(state, { ...lease, actions }, 7);
		expect(nextRouterAction(state, lease, 7)?.action.type).toBe("reply");
		ingestWorkItemEvent(
			state,
			{
				accountId: "a",
				roomId: "r",
				source: item.source,
				title: item.title,
				text: "New request",
				author: { id: "other" },
				sourceTrust: item.sourceTrust,
				authorization: { mode: "observe", authorizedBy: "policy" },
				eventId: "new-request",
			},
			8,
		);
		grant();
		expect(() => prepareRouterActions(state, { ...lease, actions }, 9)).toThrow(/authorize/);
		expect(() => nextRouterAction(state, lease, 9)).toThrow(/authorize/);
	});
	it("requires verified trust for policy-auto events even in already frozen jobs", () => {
		const { state, lease } = setupOrigin("work_item");
		const actions: RouterAction[] = [{ type: "reply", text: "Policy event" }];
		prepareRouterActions(state, { ...lease, actions }, 4);
		state.workItemEvents[0].sourceTrust.verified = false;
		expect(() => prepareRouterActions(state, { ...lease, actions }, 5)).toThrow(/authorize/);
		expect(() => nextRouterAction(state, lease, 5)).toThrow(/authorize/);
	});
	it("keeps task results under item authorization after observe followups and rejects revocation", () => {
		const { state, item, job, lease } = setupOrigin("task_result");
		const original = state.workItemEvents[0];
		ingestWorkItemEvent(
			state,
			{
				accountId: "a",
				roomId: "r",
				source: original.source,
				title: "Issue",
				text: "Disallowed followup",
				author: { id: "attacker" },
				sourceTrust: original.sourceTrust,
				authorization: { mode: "observe", authorizedBy: "policy" },
				eventId: "attacker",
			},
			4,
		);
		const actions: RouterAction[] = [{ type: "reply", text: "Task result" }];
		prepareRouterActions(state, { ...lease, actions }, 5);
		expect(nextRouterAction(state, lease, 6)?.action.type).toBe("reply");
		authorizeWorkItem(
			state,
			{
				accountId: "a",
				roomId: "r",
				workItemId: item.id,
				revision: item.revision,
				authorization: { mode: "observe", authorizedBy: "owner" },
			},
			7,
		);
		expect(
			queueRouterJob(state, { accountId: "a", roomId: "r", eventKey: job.eventKey, trigger: job.trigger }, 8),
		).toBeUndefined();
		expect(() => prepareRouterActions(state, { ...lease, actions }, 8)).toThrow(/authorize/);
		expect(() => nextRouterAction(state, lease, 8)).toThrow(/authorize/);
	});
	it("deduplicates events and never routes bot/router replies", () => {
		const { state, job } = setup();
		expect(queueRouterJob(state, queue, 4)).toBe(job);
		expect(queueRouterJob(state, { ...queue, eventKey: "wrong-new-key" }, 4)).toBe(job);
		expect(() => queueRouterJob(state, { ...queue, text: "tampered" }, 4)).toThrow(/fingerprint/);
		state.messages.push(
			{ ...state.messages[0], id: "bot", sender: { type: "bot", id: "b", name: "bot" } },
			{ ...state.messages[0], id: "router", routerJobId: job.id },
		);
		for (const id of ["bot", "router"])
			expect(
				queueRouterJob(state, { ...queue, eventKey: id, trigger: { type: "human_message", messageId: id } }, 4),
			).toBeUndefined();
		expect(state.routerJobs).toHaveLength(1);
	});
	it("serializes each room and fences replaced, expired, revoked and config-stale workers", () => {
		const { state, job, lease } = setup();
		state.messages.push({ ...state.messages[0], id: "m2" });
		queueRouterJob(state, { ...queue, eventKey: "message:m2", trigger: { type: "human_message", messageId: "m2" } }, 4);
		expect(claimRouterJob(state, { ...claim, leaseToken: "two" }, 4)).toBeUndefined();
		expect(() => completeRouterJob(state, { ...lease, actions: [] }, 1003)).toThrow(/Stale/);
		const reclaimed = claimRouterJob(state, { ...claim, leaseToken: "two" }, 1003)!;
		expect(reclaimed.id).toBe(job.id);
		expect(reclaimed.attempts).toBe(2);
		expect(() => prepareRouterActions(state, { ...lease, actions: [] }, 1004)).toThrow(/Stale/);
		const current = { ...lease, leaseToken: "two" };
		renewRouterJobLease(state, { ...current, leaseMs: 2000 }, 1004);
		expect(job.leaseExpiresAt).toBe(3004);
		updateGroupRouterConfig(
			state,
			{ accountId: "a", roomId: "r", config: { ...config, model: "new/model" }, revision: 1 },
			1005,
		);
		expect(() => completeRouterJob(state, { ...current, actions: [] }, 1006)).toThrow(/config/);
		expect(claimRouterJob(state, { ...claim, leaseToken: "three" }, 1006)).toBeUndefined();
		expect(claimRouterJob(state, { ...claim, leaseToken: "three" }, 3004)).toBeUndefined();
		expect(state.routerJobs.every((j) => j.status === "failed")).toBe(true);
		const fresh = setup();
		fresh.state.devices = [];
		expect(() => prepareRouterActions(fresh.state, { ...fresh.lease, actions: [] }, 4)).toThrow(/Stale/);
	});
	it("freezes bounded authorized actions, resumes remaining work, and requires ordered progress", () => {
		const { state, job, lease } = setup();
		expect(() =>
			prepareRouterActions(state, { ...lease, actions: [{ type: "dispatch", botId: "foreign", text: "go" }] }, 4),
		).toThrow(/member/);
		expect(() =>
			prepareRouterActions(
				state,
				{ ...lease, actions: Array.from({ length: 17 }, () => ({ type: "reply" as const, text: "x" })) },
				4,
			),
		).toThrow(/16/);
		expect(() =>
			prepareRouterActions(
				state,
				{ ...lease, actions: [{ type: "dispatch", botId: "b", text: "go", contract: {} as any }] },
				4,
			),
		).toThrow();
		const actions = [
			{ type: "reply" as const, text: "Plan" },
			{ type: "dispatch" as const, botId: "b", text: "Execute" },
		];
		prepareRouterActions(state, { ...lease, actions }, 4);
		actions[0].text = "changed";
		expect(job.actions![0]).toEqual({ type: "reply", text: "Plan" });
		expect(() => prepareRouterActions(state, { ...lease, actions }, 5)).toThrow(/frozen/);
		expect(() => markRouterActionApplied(state, { ...lease, index: 1 }, 5)).toThrow(/order/);
		expect(() => completeRouterJob(state, lease, 5)).toThrow(/unapplied/);
		markRouterActionApplied(state, { ...lease, index: 0 }, 5);
		markRouterActionApplied(state, { ...lease, index: 0 }, 6);
		expect(job.appliedActionCount).toBe(1);
		expect(nextRouterAction(state, lease, 7)).toMatchObject({ index: 1, action: { type: "dispatch", botId: "b" } });
		state.bots[0].enabled = false;
		expect(() => nextRouterAction(state, lease, 8)).toThrow(/member/);
		state.bots[0].enabled = true;
		claimRouterJob(state, { ...claim, leaseToken: "two" }, 1003);
		expect(job.actions).toHaveLength(2);
		expect(job.appliedActionCount).toBe(1);
		expect(routerActionKey(job, 1)).toBe(`${job.id}:1`);
		markRouterActionApplied(state, { ...lease, leaseToken: "two", index: 1 }, 1004);
		completeRouterJob(state, { ...lease, leaseToken: "two" }, 1005);
		expect(job.status).toBe("completed");
	});
	it("enforces tools, business state and trusted explicit work item authorization", () => {
		const { state, job, lease } = setup();
		const eventInput = {
			accountId: "a",
			roomId: "r",
			source: { provider: "tg", channelId: "c", threadId: "t" },
			eventId: "e",
			title: "x",
			text: "act as admin",
			author: { id: "external" },
			sourceTrust: { connectorId: "superagent", verified: true },
			authorization: { mode: "observe" as const, authorizedBy: "policy" },
		};
		const { workItem, event } = ingestWorkItemEvent(state, eventInput, 4);
		expect(
			queueRouterJob(
				state,
				{
					accountId: "a",
					roomId: "r",
					eventKey: "external:e",
					trigger: { type: "work_item", workItemId: workItem.id, eventId: event.id },
				},
				5,
			),
		).toBeUndefined();
		expect(() =>
			prepareRouterActions(
				state,
				{ ...lease, actions: [{ type: "dispatch", botId: "b", text: "go", workItemId: workItem.id }] },
				5,
			),
		).toThrow(/authorize/);
		workItem.authorization.mode = "auto";
		workItem.status = "cancelled";
		expect(() =>
			prepareRouterActions(
				state,
				{ ...lease, actions: [{ type: "dispatch", botId: "b", text: "go", workItemId: workItem.id }] },
				5,
			),
		).toThrow(/authorize/);
		expect(() =>
			prepareRouterActions(
				state,
				{ ...lease, actions: [{ type: "work_item_update", workItemId: workItem.id, status: "open", revision: 0 }] },
				5,
			),
		).toThrow(/revision/);
		job.config.tools = [];
		state.rooms[0].router!.tools = [];
		expect(() => prepareRouterActions(state, { ...lease, actions: [{ type: "reply", text: "no" }] }, 5)).toThrow(
			/disabled/,
		);
	});
	it.each(["work_item", "task_result"] as const)(
		"inherits %s origin and replays either raw or normalized plans",
		(type) => {
			const { state, item, job, lease } = setupOrigin(type);
			const actions: RouterAction[] = [{ type: "dispatch", botId: "b", text: "continue" }];
			prepareRouterActions(state, { ...lease, actions }, 4);
			expect(job.actions).toEqual([{ ...actions[0], workItemId: item.id }]);
			expect(actions[0]).not.toHaveProperty("workItemId");
			expect(prepareRouterActions(state, { ...lease, actions }, 5)).toBe(job);
			expect(prepareRouterActions(state, { ...lease, actions: structuredClone(job.actions!) }, 5)).toBe(job);
			claimRouterJob(state, { ...claim, leaseToken: "two" }, 1003);
			const resumed = { ...lease, leaseToken: "two" };
			expect(prepareRouterActions(state, { ...resumed, actions: structuredClone(job.actions!) }, 1004)).toBe(job);
			expect(nextRouterAction(state, resumed, 1004)?.action).toMatchObject({ workItemId: item.id });
			expect(() =>
				prepareRouterActions(state, { ...resumed, actions: [{ type: "dispatch", botId: "b", text: "changed" }] }, 1004),
			).toThrow(/frozen/);
		},
	);
	it.each(["work_item", "task_result"] as const)(
		"prevents %s origin from targeting another authorized work item",
		(type) => {
			const { state, item, job } = setupOrigin(type);
			const other = seedWorkItem(state, "other").workItem;
			for (const workItemId of [item.id, other.id]) {
				const actions: RouterAction[] = [
					{ type: "dispatch", botId: "b", text: "go", workItemId },
					{ type: "work_item_update", workItemId, status: "running", revision: 1 },
				];
				for (const action of actions) {
					if (workItemId === item.id) expect(validateRouterActions(state, job, [action])).toEqual([action]);
					else expect(() => validateRouterActions(state, job, [action])).toThrow(/differs from source/);
				}
			}
		},
	);
	it.each(["observe", "unverified", "blocked", "cancelled", "completed"] as const)(
		"blocks task-result execution after origin becomes %s",
		(reason) => {
			const { state, item, lease } = setupOrigin("task_result");
			const revoke = () => {
				if (reason === "observe") item.authorization.mode = "observe";
				else if (reason === "unverified") item.sourceTrust.verified = false;
				else item.status = reason;
			};
			const actions: RouterAction[] = [{ type: "dispatch", botId: "b", text: "continue" }];
			revoke();
			expect(() => prepareRouterActions(state, { ...lease, actions }, 4)).toThrow(/authorize/);
			expect(state.routerJobs[0].actions).toBeUndefined();
			item.authorization.mode = "auto";
			item.sourceTrust.verified = true;
			item.status = "open";
			prepareRouterActions(state, { ...lease, actions }, 5);
			revoke();
			expect(() => nextRouterAction(state, lease, 6)).toThrow(/authorize/);
		},
	);
	it("lets human jobs explicitly use authorized items in their own room and rejects revoked updates", () => {
		const { state, job, lease } = setup();
		const item = seedWorkItem(state).workItem;
		const actions: RouterAction[] = [
			{ type: "dispatch", botId: "b", text: "go", workItemId: item.id },
			{ type: "work_item_update", workItemId: item.id, status: "running", revision: 1 },
		];
		expect(validateRouterActions(state, job, actions)).toEqual(actions);
		for (const patch of [{ roomId: "other" }, { accountId: "other" }]) {
			Object.assign(item, patch);
			for (const action of actions) expect(() => validateRouterActions(state, job, [action])).toThrow(/not found/);
			Object.assign(item, { accountId: "a", roomId: "r" });
		}
		prepareRouterActions(state, { ...lease, actions: [actions[1]] }, 4);
		item.authorization.mode = "observe";
		expect(() => nextRouterAction(state, lease, 5)).toThrow(/authorize/);
		expect(() => validateRouterActions(state, job, [actions[1]])).toThrow(/authorize/);
	});
	it("rejects ambiguous task provenance without choosing an authorized origin", () => {
		const { state, job } = setupOrigin("task_result");
		seedWorkItem(state, "other").workItem.taskIds.push("origin-task");
		expect(() => validateRouterActions(state, job, [{ type: "dispatch", botId: "b", text: "go" }])).toThrow(
			/Ambiguous/,
		);
	});
	it("prepares ordered revisions without changing items and applies dispatch links before business updates", () => {
		const { state, item, lease } = setupOrigin("work_item");
		const actions: RouterAction[] = [
			{ type: "dispatch", botId: "b", text: "go" },
			{ type: "work_item_update", workItemId: item.id, status: "running", revision: 1 },
			{ type: "work_item_update", workItemId: item.id, status: "running", revision: 2 },
			{ type: "work_item_update", workItemId: item.id, status: "completed", revision: 3 },
		];
		const before = structuredClone(state.workItems);
		prepareRouterActions(state, { ...lease, actions }, 4);
		expect(state.workItems).toEqual(before);
		expect(nextRouterAction(state, lease, 5)?.action).toMatchObject({ type: "dispatch", workItemId: item.id });
		state.tasks.push({ id: "spawned", accountId: "a", roomId: "r", status: "completed" } as any);
		linkWorkItemTasks(state, { accountId: "a", roomId: "r", workItemId: item.id, taskIds: ["spawned"] }, 5);
		expect(item).toMatchObject({ revision: 1, status: "open" });
		markRouterActionApplied(state, { ...lease, index: 0 }, 5);
		for (let index = 1; index < actions.length; index++) {
			const next = nextRouterAction(state, lease, 6 + index)!;
			expect(next).toMatchObject({ index, action: actions[index] });
			if (next.action.type !== "work_item_update") throw new Error("Expected work item update");
			updateWorkItem(state, { accountId: "a", roomId: "r", ...next.action }, 6 + index);
			markRouterActionApplied(state, { ...lease, index }, 6 + index);
		}
		expect(item).toMatchObject({ revision: 4, status: "completed", taskIds: ["origin-task", "spawned"] });
		completeRouterJob(state, lease, 10);
	});
	it("checks current revisions only when an update is next and rejects malformed revision values", () => {
		const { state, item, job, lease } = setupOrigin("work_item");
		const action: RouterAction = { type: "work_item_update", workItemId: item.id, status: "running", revision: 99 };
		for (const revision of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1, "1", undefined])
			expect(() => validateRouterActions(state, job, [{ ...action, revision }])).toThrow(/revision/);
		prepareRouterActions(state, { ...lease, actions: [action] }, 4);
		expect(item.revision).toBe(1);
		expect(() => nextRouterAction(state, lease, 5)).toThrow(/revision conflict/);
	});
	it("recovers failed jobs explicitly with the frozen plan, progress and a fresh lease", () => {
		const { state, job, lease } = setup();
		const actions: RouterAction[] = [
			{ type: "reply", text: "Plan" },
			{ type: "dispatch", botId: "b", text: "go" },
		];
		prepareRouterActions(state, { ...lease, actions }, 4);
		markRouterActionApplied(state, { ...lease, index: 0 }, 5);
		failRouterJob(state, { ...lease, error: "temporary outage" }, 6);
		expect(claimRouterJob(state, { ...claim, leaseToken: "two" }, 7)).toBeUndefined();
		const frozen = structuredClone(job.actions);
		const fingerprint = job.actionsInputFingerprint;
		expect(retryRouterJob(state, { accountId: "a", roomId: "r", jobId: job.id }, 8)).toBe(job);
		expect(job).toMatchObject({
			status: "queued",
			actions: frozen,
			actionsInputFingerprint: fingerprint,
			appliedActionCount: 1,
			attempts: 1,
			updatedAt: 8,
		});
		for (const key of ["deviceId", "leaseToken", "leaseExpiresAt", "error"]) expect(job).not.toHaveProperty(key);
		expect(() => nextRouterAction(state, lease, 9)).toThrow(/Stale/);
		expect(claimRouterJob(state, { ...claim, leaseToken: "two" }, 9)).toBe(job);
		const resumed = { ...lease, leaseToken: "two" };
		expect(nextRouterAction(state, resumed, 10)).toMatchObject({ index: 1, action: frozen![1] });
		markRouterActionApplied(state, { ...resumed, index: 1 }, 10);
		completeRouterJob(state, resumed, 11);
		expect(job).toMatchObject({ status: "completed", attempts: 2 });
	});
	it("rejects retry across scope, nonfailed status or router configuration revisions without mutation", () => {
		const { state, job, lease } = setup();
		const request = { accountId: "a", roomId: "r", jobId: job.id };
		for (const status of ["queued", "running", "completed"] as const) {
			job.status = status;
			const before = structuredClone(state);
			expect(() => retryRouterJob(state, request, 4)).toThrow(/Only failed/);
			expect(state).toEqual(before);
		}
		job.status = "running";
		failRouterJob(state, { ...lease, error: "outage" }, 4);
		for (const patch of [{ accountId: "foreign" }, { roomId: "foreign" }, { jobId: "missing" }])
			expect(() => retryRouterJob(state, { ...request, ...patch }, 5)).toThrow(/not found/);
		updateGroupRouterConfig(state, { accountId: "a", roomId: "r", config, revision: 1 }, 5);
		const before = structuredClone(state);
		expect(() => retryRouterJob(state, request, 6)).toThrow(/configuration changed; start a new/);
		expect(state).toEqual(before);
	});
	it("queues incoming webhook messages only from permitted hooks, preserving legacy permission defaults", () => {
		for (const patch of [
			{},
			{ enabled: true, allowBotTrigger: true },
			{ enabled: false },
			{ allowBotTrigger: false },
			{ type: "outgoing" },
			{ id: "other" },
		]) {
			const state = fixture();
			updateGroupRouterConfig(state, { accountId: "a", roomId: "r", config }, 1);
			state.messages[0].sender = { type: "webhook", id: "hook", name: "Incoming" };
			state.rooms[0].webhooks = [{ id: "hook", type: "incoming", ...patch } as any];
			const trigger = { type: "webhook_message" as const, messageId: "m" };
			const job = queueRouterJob(state, { ...queue, trigger }, 2);
			if (Object.keys(patch).length === 0 || patch.enabled === true) expect(job?.trigger).toEqual(trigger);
			else expect(job).toBeUndefined();
		}
		for (const sender of ["human", "bot"] as const) {
			const state = fixture();
			updateGroupRouterConfig(state, { accountId: "a", roomId: "r", config }, 1);
			state.messages[0].sender.type = sender;
			state.rooms[0].webhooks = [{ id: "a", type: "incoming" } as any];
			expect(
				queueRouterJob(state, { ...queue, trigger: { type: "webhook_message", messageId: "m" } }, 2),
			).toBeUndefined();
		}
	});
	it("rechecks webhook permissions before any prepared effect after a channel is revoked", () => {
		for (const patch of [{ enabled: false }, { allowBotTrigger: false }, { type: "outgoing" }, { id: "removed" }]) {
			const state = fixture();
			updateGroupRouterConfig(state, { accountId: "a", roomId: "r", config }, 1);
			state.messages[0].sender = { type: "webhook", id: "hook", name: "Incoming" };
			const hook = { id: "hook", type: "incoming" } as any;
			state.rooms[0].webhooks = [hook];
			const job = queueRouterJob(state, { ...queue, trigger: { type: "webhook_message", messageId: "m" } }, 2)!;
			claimRouterJob(state, claim, 3);
			const lease = { accountId: "a", jobId: job.id, deviceId: "d", leaseToken: "one" };
			prepareRouterActions(
				state,
				{
					...lease,
					actions: [
						{ type: "reply", text: "reply" },
						{ type: "dispatch", botId: "b", text: "go" },
					],
				},
				4,
			);
			Object.assign(hook, patch);
			expect(() => nextRouterAction(state, lease, 5)).toThrow(/Webhook no longer authorizes/);
			expect(job.appliedActionCount).toBe(0);
		}
	});
	it("settles exactly one durable execution result trigger and persists failure", () => {
		const { state } = setup();
		state.tasks.push({ id: "t", roomId: "r", accountId: "a", status: "running" } as any);
		const result = {
			accountId: "a",
			roomId: "r",
			eventKey: "result:t",
			trigger: { type: "task_result" as const, taskId: "t" },
		};
		expect(() => queueRouterJob(state, result, 4)).toThrow(/settled/);
		state.tasks[0].status = "completed";
		const job = queueRouterJob(state, result, 5)!;
		expect(queueRouterJob(state, result, 6)).toBe(job);
		const first = state.routerJobs[0];
		failRouterJob(
			state,
			{ accountId: "a", jobId: first.id, deviceId: "d", leaseToken: "one", error: "model unavailable" },
			7,
		);
		expect(claimRouterJob(state, { ...claim, leaseToken: "two" }, 8)?.id).toBe(job.id);
		expect(first.status).toBe("failed");
	});
	it("recovers prepared plan and active lease from the WAL after projection failure", async () => {
		const dir = await mkdtemp(join(tmpdir(), "router-core-"));
		dirs.push(dir);
		const store = await DeviceHubStore.open(dir);
		await store.transact((s) => {
			const f = fixture();
			s.rooms = f.rooms;
			s.devices = f.devices;
			s.bots = f.bots;
			s.messages = f.messages;
			updateGroupRouterConfig(s, { accountId: "a", roomId: "r", config }, 1);
		});
		vi.spyOn((store as any).logs.tasks, "commit").mockRejectedValueOnce(new Error("projection failed"));
		const job = await store.transact((s) => {
			const j = queueRouterJob(s, queue, 2)!;
			claimRouterJob(s, claim, 3);
			prepareRouterActions(
				s,
				{
					accountId: "a",
					jobId: j.id,
					deviceId: "d",
					leaseToken: "one",
					actions: [{ type: "reply", text: "durable" }],
				},
				4,
			);
			return j;
		});
		expect(store.lastProjectionError).toBeDefined();
		const durable = await readPersistedHub(dir);
		expect(durable.routerJobs[0]).toEqual(job);
		const reopened = await DeviceHubStore.open(dir);
		expect(reopened.snapshot().routerJobs[0]).toEqual(job);
		expect(await reopened.transact((s) => claimRouterJob(s, { ...claim, leaseToken: "two" }, 1002))).toBeUndefined();
		const resumed = await reopened.transact((s) => claimRouterJob(s, { ...claim, leaseToken: "two" }, 1003));
		expect(resumed).toMatchObject({
			id: job.id,
			appliedActionCount: 0,
			actions: [{ type: "reply", text: "durable" }],
			attempts: 2,
		});
		await reopened.close();
		await store.close();
	});
});
