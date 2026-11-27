import { randomBytes } from "node:crypto";
import type { Request, Response } from "express";
import { INTERNAL_MCP_SERVER_NAME } from "./engine-mcp.js";

export interface InternalMcpToolDef {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
	execute: (args: Record<string, unknown>) => Promise<{ output?: string; error?: string }>;
}

export interface InternalMcpContext {
	clientId: string;
	conversationId: string;
	cwd: string;
	listTools: () => InternalMcpToolDef[];
}

export interface JsonRpcResponse {
	jsonrpc: "2.0";
	id: string | number | null;
	result?: unknown;
	error?: { code: number; message: string; data?: unknown };
}

const MCP_PROTOCOL_VERSION = "2024-11-05";

/**
 * Explicit exclusion list for the host internal MCP bridge:
 * - Native CLI core tools (`read`, `write`, `edit`, `bash`) already provided by external engines.
 * - Pi SDK kernel-only tools (`compact_context`, `load_tools`, `tool_search`, `codemode`).
 * - Engine-native session/subagent orchestration (`conversation`, `communicate`, `delegate_task`)
 *   and `mcp_manage` (external CLIs receive pi-web-ui MCP servers directly via `engine-mcp.ts`).
 */
export const INTERNAL_MCP_EXCLUDED_TOOLS: ReadonlySet<string> = new Set([
	"read",
	"write",
	"edit",
	"bash",
	"compact_context",
	"load_tools",
	"tool_search",
	"codemode",
	"conversation",
	"communicate",
	"delegate_task",
	"mcp_manage",
]);

/** Returns true when a host or plugin tool should be exposed over the internal MCP bridge. */
export function isInternalMcpToolEligible(name: string): boolean {
	if (!name || INTERNAL_MCP_EXCLUDED_TOOLS.has(name)) return false;
	// External MCP servers (`mcp__*`) are already forwarded directly by `engine-mcp.ts`.
	if (name.startsWith("mcp__")) return false;
	return true;
}

/**
 * Strips the `mcp__pi_host__` namespace prefix emitted by external CLI engines (such as Claude Code
 * or Codex) so the UI renders internal host tools with native tool cards instead of raw MCP JSON.
 */
export function unwrapInternalMcpToolName(toolName: string): string {
	const claudePrefix = `mcp__${INTERNAL_MCP_SERVER_NAME}__`;
	if (toolName.startsWith(claudePrefix)) return toolName.slice(claudePrefix.length);
	const slashPrefix = `${INTERNAL_MCP_SERVER_NAME}/`;
	if (toolName.startsWith(slashPrefix)) return toolName.slice(slashPrefix.length);
	return toolName;
}

/**
 * In-process JSON-RPC 2.0 MCP endpoint registry for external CLI engines.
 * Each active session registers a short-lived bearer token bound to its `clientId`, `conversationId`,
 * and `cwd` so tool calls from spawned CLI subprocesses route back to the exact session.
 */
export class InternalMcpRegistry {
	private readonly contexts = new Map<string, InternalMcpContext>();

	register(ctx: InternalMcpContext): string {
		const token = randomBytes(24).toString("hex");
		this.contexts.set(token, ctx);
		return token;
	}

	unregister(token: string | null | undefined): void {
		if (!token) return;
		this.contexts.delete(token);
	}

	getContext(token: string | null | undefined): InternalMcpContext | undefined {
		if (!token) return undefined;
		return this.contexts.get(token);
	}

	async handleJsonRpc(
		token: string | null | undefined,
		payload: unknown,
	): Promise<{ status: number; body?: JsonRpcResponse }> {
		const ctx = this.getContext(token);
		if (!ctx) {
			return { status: 401 };
		}
		if (!payload || typeof payload !== "object") {
			return {
				status: 400,
				body: { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } },
			};
		}

		const req = payload as { id?: string | number | null; method?: unknown; params?: Record<string, unknown> };
		const hasId = req.id !== undefined && req.id !== null;
		const id = req.id ?? null;
		const method = typeof req.method === "string" ? req.method : "";

		if (!hasId) {
			// JSON-RPC notifications (e.g. `notifications/initialized`, `notifications/cancelled`)
			return { status: 202 };
		}

		if (method === "initialize") {
			return {
				status: 200,
				body: {
					jsonrpc: "2.0",
					id,
					result: {
						protocolVersion: MCP_PROTOCOL_VERSION,
						capabilities: { tools: { listChanged: false } },
						serverInfo: { name: INTERNAL_MCP_SERVER_NAME, version: "1.0.0" },
					},
				},
			};
		}

		if (method === "ping") {
			return { status: 200, body: { jsonrpc: "2.0", id, result: {} } };
		}

		if (method === "tools/list") {
			const tools = ctx.listTools().map((t) => ({
				name: t.name,
				description: t.description,
				inputSchema: t.inputSchema,
			}));
			return { status: 200, body: { jsonrpc: "2.0", id, result: { tools } } };
		}

		if (method === "tools/call") {
			const params = req.params ?? {};
			const name = typeof params.name === "string" ? params.name : "";
			const args =
				params.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments)
					? (params.arguments as Record<string, unknown>)
					: {};
			const tool = ctx.listTools().find((t) => t.name === name);
			if (!tool) {
				return {
					status: 200,
					body: {
						jsonrpc: "2.0",
						id,
						error: { code: -32602, message: `Unknown tool: ${name}` },
					},
				};
			}
			try {
				const res = await tool.execute(args);
				return {
					status: 200,
					body: {
						jsonrpc: "2.0",
						id,
						result: {
							content: [{ type: "text", text: res.error ?? res.output ?? "" }],
							isError: Boolean(res.error),
						},
					},
				};
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : String(err);
				return {
					status: 200,
					body: {
						jsonrpc: "2.0",
						id,
						result: {
							content: [{ type: "text", text: msg }],
							isError: true,
						},
					},
				};
			}
		}

		return {
			status: 200,
			body: {
				jsonrpc: "2.0",
				id,
				error: { code: -32601, message: `Method not found: ${method}` },
			},
		};
	}

	async handleHttp(req: Request, res: Response): Promise<void> {
		const auth = typeof req.headers.authorization === "string" ? req.headers.authorization : "";
		const token = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : "";
		const outcome = await this.handleJsonRpc(token, req.body);
		if (outcome.body) {
			res.status(outcome.status).json(outcome.body);
		} else {
			res.status(outcome.status).end();
		}
	}
}

export const internalMcpRegistry = new InternalMcpRegistry();
