import { describe, expect, it } from "vitest";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";
import { resolveRuntimeBaseWithDetails } from "../../server/dsh/runtime/runtime-root.mjs";

let defineTool: any;
const { base: rtBase } = await resolveRuntimeBaseWithDetails();
if (rtBase) {
	const tools = await import(pathToFileURL(join(rtBase, "@deepseek-ai", "dsh-tools", "lib", "index.js")).href);
	defineTool = tools.defineTool;
} else {
	const tools = await import(/* @vite-ignore */ "@deepseek-ai/dsh-tools" as any);
	defineTool = tools.defineTool;
}

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const GOAL_RPC_URL = pathToFileURL(join(ROOT, "server", "dsh", "runtime", "goal-rpc.mjs")).href;

const { piParamsToDshSpec } = (await import(GOAL_RPC_URL)) as {
	piParamsToDshSpec: (params: unknown) => Record<string, unknown>;
};

describe("DSH 工具 Schema 规整器 (piParamsToDshSpec)", () => {
	it("将 type 数组 (如 [string, null]) 规整为 DSH 支持的 oneOf 分支", () => {
		const raw = {
			type: "object",
			properties: {
				password: {
					type: ["string", "null"],
					description: "save: password or null clears it",
				},
				privateKey: {
					type: ["string", "null"],
					description: "save: inline key or null clears it",
				},
			},
			required: ["password"],
		};

		const dshSpec = piParamsToDshSpec(raw);

		expect(dshSpec).toEqual({
			password: {
				description: "save: password or null clears it",
				oneOf: [{ type: "string" }, { type: "null" }],
				required: true,
			},
			privateKey: {
				description: "save: inline key or null clears it",
				oneOf: [{ type: "string" }, { type: "null" }],
			},
		});

		expect(() =>
			defineTool({
				name: "sftp_test",
				description: "test sftp tool",
				parameters: dshSpec as any,
				output: { schema: { type: "string" }, render: () => [] },
				execute: async () => "",
			}),
		).not.toThrow();
	});

	it("单元素 type 数组解构为标量 type", () => {
		const raw = {
			type: "object",
			properties: {
				name: { type: ["string"] },
			},
		};
		const dshSpec = piParamsToDshSpec(raw);
		expect(dshSpec).toEqual({
			name: { type: "string" },
		});
	});

	it("将 DSH 不支持的 anyOf 映射为 oneOf，且不留 type", () => {
		const raw = {
			type: "object",
			properties: {
				target: {
					description: "target host or ip",
					anyOf: [{ type: "string" }, { type: "number" }],
				},
			},
		};
		const dshSpec = piParamsToDshSpec(raw);
		expect(dshSpec).toEqual({
			target: {
				description: "target host or ip",
				oneOf: [{ type: "string" }, { type: "number" }],
			},
		});

		expect(() =>
			defineTool({
				name: "anyof_test",
				description: "test anyOf mapping",
				parameters: dshSpec as any,
				output: { schema: { type: "string" }, render: () => [] },
				execute: async () => "",
			}),
		).not.toThrow();
	});

	it("为 object 类型自动补齐显式 additionalProperties 布尔值", () => {
		const raw = {
			type: "object",
			properties: {
				resize: {
					type: "object",
					description: "image resize options",
					properties: {
						width: { type: "number" },
						height: { type: "number" },
					},
				},
				strictObj: {
					type: "object",
					additionalProperties: false,
					properties: {
						key: { type: "string" },
					},
				},
			},
		};
		const dshSpec = piParamsToDshSpec(raw);

		expect(dshSpec.resize).toEqual({
			type: "object",
			description: "image resize options",
			additionalProperties: true,
			properties: {
				width: { type: "number" },
				height: { type: "number" },
			},
		});

		expect(dshSpec.strictObj).toEqual({
			type: "object",
			additionalProperties: false,
			properties: {
				key: { type: "string" },
			},
		});

		expect(() =>
			defineTool({
				name: "obj_test",
				description: "test object additionalProperties",
				parameters: dshSpec as any,
				output: { schema: { type: "string" }, render: () => [] },
				execute: async () => "",
			}),
		).not.toThrow();
	});

	it("过滤 DSH schema compiler 不支持的 DSL 关键字 (如 format / pattern / minimum)", () => {
		const raw = {
			type: "object",
			properties: {
				email: {
					type: "string",
					format: "email",
					description: "user email",
				},
				count: {
					type: "integer",
					minimum: 1,
					maximum: 100,
				},
			},
		};
		const dshSpec = piParamsToDshSpec(raw);
		expect(dshSpec).toEqual({
			email: {
				type: "string",
				description: "user email",
			},
			count: {
				type: "integer",
			},
		});

		expect(() =>
			defineTool({
				name: "dsl_test",
				description: "test unsupported keywords strip",
				parameters: dshSpec as any,
				output: { schema: { type: "string" }, render: () => [] },
				execute: async () => "",
			}),
		).not.toThrow();
	});

	it("兼容无参数对象以及直接传递 property-map 的各种边界情况", () => {
		expect(piParamsToDshSpec(null)).toEqual({});
		expect(piParamsToDshSpec(undefined)).toEqual({});
		expect(piParamsToDshSpec({})).toEqual({});
		expect(piParamsToDshSpec({ type: "object" })).toEqual({});
		expect(piParamsToDshSpec({ type: "object", properties: {} })).toEqual({});

		const directMap = {
			token: { type: "string", description: "auth token" },
		};
		expect(piParamsToDshSpec(directMap)).toEqual({
			token: { type: "string", description: "auth token" },
		});
	});
});
