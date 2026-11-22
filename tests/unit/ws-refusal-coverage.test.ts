import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ClientMessage } from "../../server/protocol.js";
import { REQUEST_REPLIES, refuse } from "../../server/ws-refusal.js";

/**
 * 接线类型校验：`server/index.ts` 的 `msg` 就是 `ClientMessage`，必须能直接喂给 `refuse()`
 * （不需要 `as` 转型）。不满足时下面两行会编译报错。
 */
type RefusableClientMessage = ClientMessage extends { type: string; [field: string]: unknown } ? true : false;
const refusableClientMessage: RefusableClientMessage = true;

/**
 * 契约单源守卫（issue #980）：
 *
 * `REQUEST_REPLIES` 是「请求型消息失败回包」的唯一展开处。这里从 `server/protocol.ts` 现场推导
 * 请求型消息集合（带 `reqId` / `requestId`、且自身不是 `*_result` 应答消息），断言：
 *
 * 1. 每个请求型消息都登记了回包（新增请求却忘了登记 → 红）；
 * 2. 注册表里没有协议里不存在的键（删请求没清注册表 → 红）；
 * 3. 每个回包都是协议里真实存在的结果类型，并带上该请求的关联字段；
 * 4. 所有「有 ok 字段」的回包都是 `ok: false`（回包只表达失败，成功路径归各自的真实 handler）。
 *
 * 第 4 条顺带挡住第二种「只发 notice」的写法：任何人想再手搓一条失败回包，都要先过这张表。
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PROTOCOL = readFileSync(join(ROOT, "server/protocol.ts"), "utf8");

function unionMembers(typeName: string, nextMarker: string): string[] {
	const start = PROTOCOL.indexOf(`export type ${typeName} =`);
	expect(start, `protocol.ts 缺少 union ${typeName}`).toBeGreaterThan(-1);
	const end = PROTOCOL.indexOf(nextMarker, start);
	expect(end, `protocol.ts 里找不到 ${typeName} 之后的分界 ${nextMarker}`).toBeGreaterThan(start);
	// 每个成员以行首一个制表符 + `| ` 开头；成员内部的嵌套层级缩进更深，不会被切开。
	return PROTOCOL.slice(start, end)
		.split(/\n\t\| /)
		.slice(1);
}

const CLIENT_MEMBERS = unionMembers("ClientMessage", "export type RemoteSshAuth =");
const SERVER_TYPES = new Set(
	Array.from(unionMembers("ServerMessage", "export interface DeviceExecutionSettings")).flatMap((member) =>
		Array.from(member.matchAll(/type: "([a-z0-9_]+)"/g), (m) => m[1]!),
	),
);

interface ClientMember {
	type: string;
	reqId: boolean;
	reqIdKind: "number" | "string" | null;
	requestId: boolean;
}

function idKindOf(member: string, field: "reqId" | "requestId"): "number" | "string" | null {
	const found = member.match(new RegExp(`\\b${field}\\??:\\s*(number|string)`));
	return found ? (found[1] as "number" | "string") : null;
}

const CLIENT_TYPES: ClientMember[] = CLIENT_MEMBERS.map((member) => ({
	type: member.match(/type: "([a-z0-9_]+)"/)![1]!,
	reqId: /\breqId\??\s*:/.test(member),
	reqIdKind: idKindOf(member, "reqId"),
	requestId: /\brequestId\??\s*:/.test(member),
}));

/** 请求型消息 = 等回包的消息。以 `_result` 结尾的是客户端应答（如 remote_ssh_trust_host_result），不算。 */
const REQUEST_TYPES = CLIENT_TYPES.filter(
	(member) => (member.reqId || member.requestId) && !member.type.endsWith("_result"),
).map((member) => member.type);

const byType = new Map(CLIENT_TYPES.map((member) => [member.type, member]));

/** 关联字段一般在顶层；`sandbox_diff` 把它放在 `diff` 里（协议现状），所以再看一层对象。 */
function carriesCorrelation(message: { type: string }, field: string, value: unknown): boolean {
	const record = message as Record<string, unknown>;
	if (record[field] === value) return true;
	return Object.values(record).some(
		(nested) => nested !== null && typeof nested === "object" && (nested as Record<string, unknown>)[field] === value,
	);
}

describe("REQUEST_REPLIES 覆盖 protocol.ts 的请求型消息", () => {
	it("ClientMessage 可以直接喂给 refuse()（接线不需要转型）", () => {
		expect(refusableClientMessage).toBe(true);
	});

	it("推导出的请求型消息集合非空（否则这条守卫自己失效了）", () => {
		expect(REQUEST_TYPES.length).toBeGreaterThanOrEqual(30);
	});

	it("每个请求型消息都登记了失败回包（新增请求不登记 → 红）", () => {
		const missing = REQUEST_TYPES.filter((type) => !Object.hasOwn(REQUEST_REPLIES, type));
		expect(missing, `这些请求型消息没有回包，拒绝时会永久 loading：${missing.join(", ")}`).toEqual([]);
	});

	it("注册表没有多余键（协议里删了请求，注册表要一起收）", () => {
		const requestSet = new Set(REQUEST_TYPES);
		expect(Object.keys(REQUEST_REPLIES).filter((type) => !requestSet.has(type))).toEqual([]);
	});

	it("每个回包都是协议里真实存在的结果类型，并带回该请求的关联字段", () => {
		for (const [type, entry] of Object.entries(REQUEST_REPLIES)) {
			const member = byType.get(type);
			expect(member, `注册表键 ${type} 不在 ClientMessage 里`).toBeDefined();
			const correlation = entry.correlation;
			expect(member![correlation], `${type} 的 ${correlation} 字段约定与协议不符`).toBe(true);
			// 关联 id 的类型也要跟协议一致（`reqId` 有的是 number、有的是 string）。
			if (correlation === "reqId") {
				expect(entry.idKind, `${type} 的 reqId 类型与协议不符`).toBe(member!.reqIdKind);
			} else {
				expect(entry.idKind).toBe("string");
			}

			const reqId = member!.reqIdKind === "string" ? "req-7-string" : 7;
			const requestId = "req-7";
			const sent = refuse(
				{ type, reqId, requestId, query: "q", path: "/tmp/x", dryRun: true, tools: ["rg"] },
				{ text: "拒绝", textEn: "refused", error: "denied" },
				() => {},
			);
			const reply = sent.find((message) => message.type !== "notice");
			expect(reply, `${type} 没有产出结果包`).toBeDefined();
			expect(SERVER_TYPES.has(reply!.type), `${type} 的回包类型 ${reply!.type} 不在 ServerMessage 里`).toBe(true);
			expect(
				carriesCorrelation(reply!, correlation, correlation === "reqId" ? reqId : requestId),
				`${type} 的回包没带回 ${correlation}`,
			).toBe(true);
			// 回包只表达失败：有 ok 字段就必须是 false。
			if ("ok" in (reply as Record<string, unknown>)) {
				expect((reply as { ok: boolean }).ok, `${type} 的回包 ok 必须是 false`).toBe(false);
			}
		}
	});

	it("未知类型/非请求型不进注册表：不许命中原型链", async () => {
		const { requestReplyFor } = await import("../../server/ws-refusal.js");
		expect(requestReplyFor("toString")).toBeUndefined();
		expect(requestReplyFor("constructor")).toBeUndefined();
		expect(requestReplyFor("hello")).toBeUndefined();
	});
});
