import { resolve } from "node:path";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { existsSync } from "node:fs";
import { resolveRuntimeBase } from "./runtime-root.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

if (!process.env.PI_WEB_DSH_RUNTIME_BASE) {
	try {
		const detected = await resolveRuntimeBase();
		if (detected) process.env.PI_WEB_DSH_RUNTIME_BASE = detected;
	} catch {}
}

async function loadDshModule(pkgName) {
	const rt = process.env.PI_WEB_DSH_RUNTIME_BASE;
	if (rt) {
		const candidate = join(rt, pkgName, "lib", "index.js");
		if (existsSync(candidate)) {
			return import(pathToFileURL(candidate).href);
		}
	}
	let cur = HERE;
	for (let i = 0; i < 6; i++) {
		const candidate = join(cur, "node_modules", pkgName, "lib", "index.js");
		if (existsSync(candidate)) {
			return import(pathToFileURL(candidate).href);
		}
		cur = dirname(cur);
	}
	return import(pkgName);
}

const { JsonRpcLineTransport } = await loadDshModule("@deepseek-ai/dsh-sdk-protocol");
const { defineTool } = await loadDshModule("@deepseek-ai/dsh-tools");

function findOfficialEntry() {
	if (process.env.PI_WEB_DSH_RUNTIME_BASE) {
		const candidate = join(
			process.env.PI_WEB_DSH_RUNTIME_BASE,
			"@deepseek-ai",
			"dsh-sdk-jsonrpc-server",
			"lib",
			"index.js",
		);
		if (existsSync(candidate)) return candidate;
	}
	if (process.env.PI_WEB_DSH_JSONRPC_ENTRY) return resolve(process.env.PI_WEB_DSH_JSONRPC_ENTRY);
	let cur = HERE;
	for (let i = 0; i < 6; i++) {
		const candidate = join(cur, "node_modules", "@deepseek-ai", "dsh-sdk-jsonrpc-server", "lib", "index.js");
		if (existsSync(candidate)) return candidate;
		cur = dirname(cur);
	}
	return join(
		resolve(HERE, "..", "..", ".."),
		"node_modules",
		"@deepseek-ai",
		"dsh-sdk-jsonrpc-server",
		"lib",
		"index.js",
	);
}

const officialEntry = findOfficialEntry();

const official = await import(pathToFileURL(officialEntry).href);
const { HarnessSdkJsonRpcServer, Config } = official;

const QUESTION_TIMEOUT_MS = Number(process.env.PI_WEB_DSH_QUESTION_TIMEOUT_MS) || 10 * 60_000;

const TOOL_TIMEOUT_MS = Number(process.env.PI_WEB_DSH_TOOL_TIMEOUT_MS) || 10 * 60_000;

export function filterSkillCatalogMessage(message, disabled) {
	if (!message || message?.source?.kind !== "skill-catalog") return message;
	const entries = Array.isArray(message.source?.entries) ? message.source.entries : [];
	const kept = entries.filter((e) => e && !disabled.has(e.name));
	if (kept.length === entries.length) return message;
	const original =
		(Array.isArray(message.content) ? message.content.find((b) => b?.type === "text")?.text : undefined) ?? "";
	const text = rebuildCatalogText(original, kept);
	return {
		...message,
		source: { ...message.source, entries: kept },
		content: [{ type: "text", text }],
	};
}

function rebuildCatalogText(original, entries) {
	const startTag = "<available_skills>";
	const endTag = "</available_skills>";
	const si = original.indexOf(startTag);
	const ei = original.indexOf(endTag);
	if (si < 0 || ei < 0) return original;
	const body = entries.length
		? entries.map((e) => `- \`${e.name}\`: ${escapeTextSimple(e.description ?? "")}`).join("\n")
		: "（本会话无可启用技能）";
	return `${original.slice(0, si + startTag.length)}\n${body}\n${original.slice(ei)}`;
}

function escapeTextSimple(s) {
	return String(s).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

const DSH_VALID_TYPES = new Set(["string", "number", "integer", "boolean", "null", "array", "object", "json"]);

/**
 * 把任意 JSON Schema 节点规整为 DSH schema compiler 支持的纯净 value schema。
 * @param {unknown} def 原始属性定义
 * @param {boolean} [allowRequired=false] 是否允许 required 字段（仅顶层 property-map 允许）
 */
function normalizeDshNode(def, allowRequired = false) {
	if (!def || typeof def !== "object" || Array.isArray(def)) {
		return { type: "string" };
	}

	const out = {};

	if (typeof def.description === "string") out.description = def.description;
	if (typeof def.title === "string") out.title = def.title;
	if (def.default !== undefined) out.default = def.default;
	if (Array.isArray(def.examples)) out.examples = def.examples;
	if (allowRequired && def.required === true) out.required = true;

	const unionCandidates = Array.isArray(def.oneOf) ? def.oneOf : Array.isArray(def.anyOf) ? def.anyOf : null;

	if (unionCandidates) {
		const branches = unionCandidates.map((branch) => normalizeDshNode(branch, false)).filter(Boolean);
		if (branches.length >= 2) {
			out.oneOf = branches;
			return out;
		}
		if (branches.length === 1) {
			return { ...branches[0], ...out };
		}
	}

	let rawType = def.type;
	if (Array.isArray(rawType)) {
		const types = rawType
			.map((t) => (typeof t === "string" ? t.toLowerCase().trim() : ""))
			.filter((t) => DSH_VALID_TYPES.has(t));
		if (types.length >= 2) {
			out.oneOf = types.map((t) => {
				const branch = { type: t };
				if (t === "object") branch.additionalProperties = true;
				return branch;
			});
			return out;
		}
		rawType = types[0];
	}

	let type = typeof rawType === "string" ? rawType.toLowerCase().trim() : undefined;
	if (type === "float") type = "number";
	else if (type === "int") type = "integer";
	else if (type === "bool") type = "boolean";

	if (!type) {
		if (def.properties && typeof def.properties === "object") type = "object";
		else if (def.items) type = "array";
		else type = "string";
	}

	if (!DSH_VALID_TYPES.has(type)) {
		type = "string";
	}

	out.type = type;

	switch (type) {
		case "object": {
			out.additionalProperties = typeof def.additionalProperties === "boolean" ? def.additionalProperties : true;
			if (def.properties && typeof def.properties === "object" && !Array.isArray(def.properties)) {
				const nestedProps = {};
				const reqList = Array.isArray(def.required) ? def.required : [];
				for (const [pKey, pDef] of Object.entries(def.properties)) {
					const pNode = normalizeDshNode(pDef, true);
					if (reqList.includes(pKey)) pNode.required = true;
					nestedProps[pKey] = pNode;
				}
				out.properties = nestedProps;
			}
			break;
		}
		case "array": {
			if (def.items && typeof def.items === "object" && !Array.isArray(def.items)) {
				out.items = normalizeDshNode(def.items, false);
			}
			break;
		}
		case "string":
		case "number":
		case "integer":
		case "boolean":
		case "null": {
			if (Array.isArray(def.enum) && def.enum.length > 0) {
				out.enum = def.enum;
			}
			if (def.const !== undefined) {
				out.const = def.const;
			}
			break;
		}
		case "json":
			break;
	}

	return out;
}

export function piParamsToDshSpec(parameters) {
	if (!parameters || typeof parameters !== "object" || Array.isArray(parameters)) return {};
	let propSource;
	let requiredList = [];
	if (parameters.properties && typeof parameters.properties === "object" && !Array.isArray(parameters.properties)) {
		propSource = parameters.properties;
		if (Array.isArray(parameters.required)) requiredList = parameters.required;
	} else if (parameters.type === "object") {
		return {};
	} else {
		propSource = parameters;
		if (Array.isArray(parameters.required)) requiredList = parameters.required;
	}
	const propMap = {};
	for (const [key, def] of Object.entries(propSource)) {
		const node = normalizeDshNode(def, true);
		if (requiredList.includes(key)) node.required = true;
		propMap[key] = node;
	}
	return propMap;
}

function viewPayload(view) {
	if (!view || view.id === undefined) return { goal: null, activation: null };
	return {
		goal: {
			id: view.id,
			revision: view.revision,
			objective: view.objective,
			phase: view.phase,
			maxGoalRounds: view.maxGoalRounds,
			...(view.blockedReason === void 0 ? {} : { blockedReason: view.blockedReason }),
			roundsStarted: view.roundsStarted ?? 0,
		},
		activation: view.activation ?? null,
	};
}

function agentOf(server, sessionId) {
	return server.getOrCreateSession(sessionId).then((rec) => rec.handle.agent);
}

class DshGoalJsonRpcServer extends HarnessSdkJsonRpcServer {
	/**
	 * 官方构造器订阅 session.event / session.status / subagent.*；这里再加**直播流**：
	 * 新版 DSH 运行时（0.1.1-rc.2 之后）把逐 chunk 的模型输出发成 agent scope 的
	 * `agent/assistant-stream` 帧（持久的 `assistant/chunk` 事件已取消），host 侧的
	 * jsonrpc 面收不到 → pi-web-ui 既没有 streamingMessage / 实时速率，也拿不到
	 * 逐次调用 usage（底栏上下文占用 / 缓存命中）。
	 *
	 * 转成 `assistant.stream` 通知：`{ sessionId, frame }`，frame 是运行时的
	 * start / chunk / end 三态；chunk 形状与旧 `assistant/chunk.data.chunk` 同构。
	 *
	 * `{ global: true }` 是必需的：该事件在 agent scope 派发，host 上注册的观察者
	 * 不加 global 永远收不到（同 dsh-api-session-controller 的写法）。
	 */
	constructor(ctx, transport, options) {
		super(ctx, transport, options);
		this.disposers.push(
			ctx.on(
				"agent/assistant-stream",
				({ agent, frame }) => {
					this.transport.notify("assistant.stream", {
						sessionId: String(agent.session.id),
						frame,
					});
				},
				{ global: true },
			),
		);
	}

	async goalSet(params) {
		if (typeof params?.sessionId !== "string") throw new TypeError("goal/set requires sessionId");
		if (typeof params?.objective !== "string" || !params.objective.trim()) {
			throw new TypeError("goal/set requires a non-empty objective");
		}
		const agent = await agentOf(this, params.sessionId);
		const request = { objective: params.objective.trim() };
		if (Number.isSafeInteger(params.maxGoalRounds) && params.maxGoalRounds > 0) {
			request.maxGoalRounds = params.maxGoalRounds;
		}
		return viewPayload(this.ctx.goals.create(agent, request));
	}

	async goalGet(params) {
		if (typeof params?.sessionId !== "string") throw new TypeError("goal/get requires sessionId");
		const agent = await agentOf(this, params.sessionId);
		return viewPayload(this.ctx.goals.get(agent));
	}

	async goalClear(params) {
		if (typeof params?.sessionId !== "string") throw new TypeError("goal/clear requires sessionId");
		const agent = await agentOf(this, params.sessionId);
		const view = this.ctx.goals.get(agent);
		if (view === void 0 || view.id === void 0) return { cleared: false };
		this.ctx.goals.clear(agent, { id: view.id, revision: view.revision });
		return { cleared: true };
	}

	async goalResume(params) {
		if (typeof params?.sessionId !== "string") throw new TypeError("goal/resume requires sessionId");
		const agent = await agentOf(this, params.sessionId);
		const view = this.ctx.goals.get(agent);
		if (view === void 0 || view.id === void 0) throw new Error("no current goal to resume");
		return viewPayload(this.ctx.goals.resume(agent, { id: view.id, revision: view.revision }));
	}

	async goalEdit(params) {
		if (typeof params?.sessionId !== "string") throw new TypeError("goal/edit requires sessionId");
		const agent = await agentOf(this, params.sessionId);
		const view = this.ctx.goals.get(agent);
		if (view === void 0 || view.id === void 0) throw new Error("no current goal to edit");
		const request = {};
		if (typeof params?.objective === "string" && params.objective.trim()) {
			request.objective = params.objective.trim();
		}
		if (Number.isSafeInteger(params?.maxGoalRounds) && params.maxGoalRounds > 0) {
			request.maxGoalRounds = params.maxGoalRounds;
		}
		if (request.objective === undefined && request.maxGoalRounds === undefined) {
			throw new TypeError("goal/edit requires objective and/or maxGoalRounds");
		}
		return viewPayload(this.ctx.goals.edit(agent, { id: view.id, revision: view.revision }, request));
	}

	pendingPresets = new Map();
	minimalAgents = new Set();
	inventorySessionId = "pi-webui-inventory";

	presetRoster() {
		try {
			return this.ctx.get("agentPresets") ?? undefined;
		} catch {
			return undefined;
		}
	}

	async resolvePresetId(requested) {
		const roster = this.presetRoster();
		if (!roster) return undefined;
		try {
			return (await roster.resolve(requested)).id;
		} catch {
			try {
				return (await roster.resolve()).id;
			} catch {
				return undefined;
			}
		}
	}

	async listPresets() {
		const roster = this.presetRoster();
		if (!roster) return { presets: [], defaultPreset: "standard", authorable: false, unavailable: true };
		try {
			const items = await roster.list();
			let defaultId = "standard";
			try {
				defaultId = roster.defaultId ?? defaultId;
			} catch {}
			let authorable = false;
			try {
				authorable = !!roster.authorable;
			} catch {}
			return {
				presets: (Array.isArray(items) ? items : []).map((p) => ({
					id: p.id,
					trust: p.trust,
					isDefault: p.id === defaultId,
					...(p.name ? { name: p.name } : {}),
					...(p.description ? { description: p.description } : {}),
					...(Number.isSafeInteger(p.order) ? { order: p.order } : {}),
					...(p.broken ? { broken: p.broken } : {}),
				})),
				defaultPreset: defaultId,
				authorable,
			};
		} catch (err) {
			return {
				presets: [],
				defaultPreset: "standard",
				authorable: false,
				unavailable: true,
				error: err?.message ?? String(err),
			};
		}
	}

	async assignPreset(params) {
		if (typeof params?.sessionId !== "string") throw new TypeError("preset/assign requires sessionId");
		if (typeof params?.preset !== "string" || !params.preset) throw new TypeError("preset/assign requires preset");
		this.pendingPresets.set(params.sessionId, params.preset);
		return { ok: true };
	}

	liveAgent(rec, sessionId) {
		if (!rec || this.ctx.agents.get(rec.handle.agent.id) !== rec.handle.agent) {
			throw new Error(`session agent was disposed outside the server: ${sessionId}`);
		}
		return rec.handle.agent;
	}

	async selectPreset(params) {
		if (typeof params?.sessionId !== "string") throw new TypeError("preset/select requires sessionId");
		if (typeof params?.preset !== "string" || !params.preset) throw new TypeError("preset/select requires preset");
		const roster = this.presetRoster();
		if (!roster)
			return { ok: false, code: "agent-preset/unavailable", message: "agent presets unavailable (legacy runtime)" };
		try {
			const rec = await this.getOrCreateSession(params.sessionId);
			const agent = this.liveAgent(rec, params.sessionId);
			const id = await roster.select(agent, params.preset);
			this.pendingPresets.delete(params.sessionId);
			if (id === "minimal") this.minimalAgents.add(agent.id);
			else this.minimalAgents.delete(agent.id);
			return { ok: true, preset: id };
		} catch (err) {
			return { ok: false, code: err?.code ?? "agent-preset/error", message: err?.message ?? String(err) };
		}
	}

	async getPermission(params) {
		if (typeof params?.sessionId !== "string") throw new TypeError("permission/get requires sessionId");
		const rec = await this.getOrCreateSession(params.sessionId);
		const agent = this.liveAgent(rec, params.sessionId);
		const permission = this.ctx.permissionPresets;
		if (!permission) throw new Error("permission/get: permission service unavailable");
		if (typeof permission.selectFor === "function") {
			return permission.selectFor(permission.permissionState(agent.session));
		}
		const cat = typeof permission.catalog === "function" ? permission.catalog() : {};
		const cur = typeof permission.current === "function" ? permission.current(agent.session) : undefined;
		return { ...cat, currentValue: cur };
	}

	async setPermission(params) {
		if (typeof params?.sessionId !== "string") throw new TypeError("permission/set requires sessionId");
		if (typeof params?.preset !== "string" || !params.preset) throw new TypeError("permission/set requires preset");
		const permission = this.ctx.permissionPresets;
		if (!permission) throw new Error("permission/set: permission service unavailable");
		if (!permission.names.includes(params.preset)) {
			return {
				ok: false,
				code: "permission/unknown-preset",
				message: `unknown preset "${params.preset}" (known: ${permission.names.join(", ")})`,
			};
		}
		try {
			const rec = await this.getOrCreateSession(params.sessionId);
			const agent = this.liveAgent(rec, params.sessionId);
			permission.apply(agent.session, params.preset, (policy) => this.ctx.approval.setPolicy(agent, policy));
			const snapshot =
				typeof permission.selectFor === "function"
					? permission.selectFor(permission.permissionState(agent.session))
					: {
							...(typeof permission.catalog === "function" ? permission.catalog() : {}),
							currentValue:
								typeof permission.current === "function" ? permission.current(agent.session) : params.preset,
						};
			return {
				ok: true,
				preset: params.preset,
				...snapshot,
			};
		} catch (err) {
			return { ok: false, code: "permission/error", message: err?.message ?? String(err) };
		}
	}

	async presetTools(params) {
		if (process.env.PI_WEB_DSH_DEBUG !== "1") {
			throw new Error("preset/tools 仅调试可用（服务端需设 PI_WEB_DSH_DEBUG=1）");
		}
		if (typeof params?.sessionId !== "string") throw new TypeError("preset/tools requires sessionId");
		const rec = await this.getOrCreateSession(params.sessionId);
		const agent = this.liveAgent(rec, params.sessionId);
		const schemas = this.ctx.tools.schemas(agent);
		return { tools: schemas.map((s) => s.name).sort() };
	}

	async promptInspect(params) {
		let context = {};
		if (typeof params?.sessionId === "string" && params.sessionId) {
			try {
				const rec = await this.getOrCreateSession(params.sessionId);
				const agent = this.liveAgent(rec, params.sessionId);
				context = { agent, scope: agent };
			} catch {}
		}
		if (!context.agent) {
			try {
				const agent = await this.ensureInventoryAgent();
				context = { agent, scope: agent };
			} catch {}
		}
		const contexts = context.agent
			? [{ agent: context.agent, scope: context.agent }, { scope: context.agent }, { scope: context.agent.ctx }, {}]
			: [{}];
		let asm = null;
		let lastErr = null;
		for (const ctx of contexts) {
			try {
				asm = await this.ctx.systemPrompt.assemble(ctx);
				if (asm) break;
			} catch (err) {
				lastErr = err;
			}
		}
		if (!asm) {
			return {
				prompt: "",
				sections: [],
				contexts: [],
				tools: [],
				error: String(lastErr?.message ?? lastErr ?? "assembly failed"),
			};
		}
		const sections = Array.isArray(asm.sections)
			? asm.sections.map((s) => ({
					name: s.name,
					text: typeof s.text === "string" ? s.text : String(s.text ?? ""),
					chars: String(s.text ?? "").length,
				}))
			: [];
		const promptContexts = Array.isArray(asm.contexts)
			? asm.contexts.map((c) => ({
					name: c.name,
					text: typeof c.text === "string" ? c.text : String(c.text ?? ""),
					chars: String(c.text ?? "").length,
				}))
			: [];
		const tools = Array.isArray(asm.tools)
			? asm.tools.map((t) => ({
					name: t.name,
					description: t.description,
					parameters: t.parameters,
				}))
			: [];
		const sectionTexts = sections.map((s) => s.text).filter(Boolean);
		let fullPrompt = sectionTexts.join("\n\n");
		if (promptContexts.length > 0) {
			const ctxBody = promptContexts
				.map((c) => c.text)
				.filter(Boolean)
				.join("\n\n");
			if (ctxBody) {
				fullPrompt +=
					(fullPrompt ? "\n\n" : "") +
					`Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\n${ctxBody}`;
			}
		}
		return {
			prompt: fullPrompt,
			sections,
			contexts: promptContexts,
			tools,
		};
	}

	async debugAssemble(params) {
		if (process.env.PI_WEB_DSH_DEBUG !== "1") {
			throw new Error("debug/assemble 仅调试可用（服务端需设 PI_WEB_DSH_DEBUG=1）");
		}
		if (typeof params?.sessionId !== "string") throw new TypeError("debug/assemble requires sessionId");
		const rec = await this.getOrCreateSession(params.sessionId);
		const agent = this.liveAgent(rec, params.sessionId);
		const contexts = [{ agent, scope: agent }, { scope: agent }, { scope: agent.ctx }];
		let lastErr = null;
		for (const context of contexts) {
			try {
				const asm = await this.ctx.systemPrompt.assemble(context);
				if (asm && Array.isArray(asm.sections)) {
					return { sections: asm.sections.map((s) => ({ name: s.name, chars: String(s.text ?? "").length })) };
				}
			} catch (err) {
				lastErr = err;
			}
		}
		throw new Error(`debug/assemble: assembly failed (${lastErr?.message ?? lastErr})`);
	}

	async createSession(sessionId, preset) {
		const requested = preset ?? this.pendingPresets.get(sessionId);
		this.pendingPresets.delete(sessionId);
		const resolved = await this.resolvePresetId(requested);
		const agentOptions = {
			provider: this.provider,
			model: this.model,
			...(this.reasoningEffort === void 0 ? {} : { reasoningEffort: this.reasoningEffort }),
			...(this.maxTokens === void 0 ? {} : { maxTokens: this.maxTokens }),
		};
		const setup = async (agentCtx, agent) => this.agentSetup(agentCtx, agent, resolved);
		let handle;
		try {
			handle = await this.ctx.agents.create({
				sessionId,
				meta: { cwd: this.cwd, ...(resolved ? { agentPreset: resolved } : {}) },
				agentOptions,
				setup,
			});
		} catch (err) {
			if (typeof err?.message === "string" && err.message.includes(`session "${sessionId}" already exists`)) {
				process.stderr.write(`[pi-web-ui-dsh] 会话 ${sessionId} 已在磁盘，resume 恢复\n`);
				handle = await this.ctx.agents.resume({ resumeSessionId: sessionId, agentOptions, setup });
			} else {
				throw err;
			}
		}
		const rec = { handle };
		this.sessions.set(sessionId, rec);
		return rec;
	}

	async getOrCreateSession(sessionId, preset) {
		if (this.shuttingDown) throw new Error("SDK server is shutting down");
		const existing = this.sessions.get(sessionId);
		if (existing) return existing;
		const pending = this.sessionCreations.get(sessionId);
		if (pending) return pending;
		const creation = this.createSession(sessionId, preset);
		this.sessionCreations.set(sessionId, creation);
		creation.then(
			() => {
				this.sessionCreations.delete(sessionId);
			},
			() => {
				this.sessionCreations.delete(sessionId);
			},
		);
		return creation;
	}

	async agentSetup(agentCtx, agent, presetId) {
		const roster = this.presetRoster();
		let effective = presetId;
		if (roster) {
			try {
				const prior = this.ctx.sessionProjections.stateOf(agent.session, "agentPreset");
				if (typeof prior === "string" && prior) effective = prior;
			} catch {}
		}
		if (roster && effective) {
			try {
				await roster.mount(agentCtx, effective);
				if (effective === "minimal") this.minimalAgents.add(agent.id);
			} catch (err) {
				process.stderr.write(
					`[pi-web-ui-dsh] preset "${effective}" mount 失败，转 host 直连: ${err?.message ?? err}\n`,
				);
			}
		}
		agentCtx.on("user-questions/request", (request, _next) => this.answerScopedQuestion(agent, request));
		// eslint-disable-next-line no-empty-pattern -- only next is needed
		agentCtx.on("agent/pre-step", async ({}, next) => {
			const decision = await next();
			if (this.disabledSkills.size && decision?.kind === "enter" && Array.isArray(decision.messages)) {
				if (decision.messages.some((m) => m?.source?.kind === "skill-catalog")) {
					decision.messages = decision.messages.map((m) => filterSkillCatalogMessage(m, this.disabledSkills));
				}
			}
			return decision;
		});
	}

	async answerScopedQuestion(agent, request) {
		if (this.minimalAgents.has(agent?.id)) {
			throw new Error(
				"ask_user_question is unavailable under the minimal preset; use the shell instead " +
					"（极简模式下不可提问，请直接用 shell 命令推进）",
			);
		}
		if (request?.signal?.aborted) throw new Error("ask_user_question aborted（提问已中止）");
		return this.askUser(request ?? {});
	}

	async ensureInventoryAgent() {
		const rec = await this.getOrCreateSession(this.inventorySessionId);
		return this.liveAgent(rec, this.inventorySessionId);
	}

	async handleRequest(method, params) {
		switch (method) {
			case "goal/set":
				return this.goalSet(params);
			case "goal/get":
				return this.goalGet(params);
			case "goal/clear":
				return this.goalClear(params);
			case "goal/resume":
				return this.goalResume(params);
			case "goal/edit":
				return this.goalEdit(params);
			case "attachment/save":
				return this.attachmentSave(params);
			case "attachment/read":
				return this.attachmentRead(params);
			case "question/answer":
				return this.answerQuestion(params);
			case "model/list":
				return this.listModels(params);
			case "tools/sync":
				return this.syncTools(params);
			case "tools/list":
				return this.listTools();
			case "tools/call-result":
				return this.toolsCallResult(params);
			case "tools/invoke":
				return this.toolsInvoke(params);
			case "skills/list":
				return this.listSkills();
			case "skills/set-disabled":
				return this.setDisabledSkills(params);
			case "skills/register":
				return this.registerSkill(params);
			case "skills/get":
				return this.getSkill(params);
			case "preset/list":
				return this.listPresets();
			case "preset/assign":
				return this.assignPreset(params);
			case "preset/select":
				return this.selectPreset(params);
			case "permission/get":
				return this.getPermission(params);
			case "permission/set":
				return this.setPermission(params);
			case "preset/tools":
				return this.presetTools(params);
			case "prompt/inspect":
				return this.promptInspect(params);
			case "debug/assemble":
				return this.debugAssemble(params);
			default:
				return super.handleRequest(method, params);
		}
	}

	async listModels(params) {
		try {
			const providerId = params?.provider ?? "deepseek-official";
			const models = await this.ctx.llm.listModels?.(providerId);
			if (!Array.isArray(models)) return { models: [] };
			return {
				models: models.map((m) => ({
					id: m.id,
					...(m.name ? { name: m.name } : {}),
					...(Array.isArray(m.inputModalities)
						? { inputModalities: m.inputModalities }
						: Array.isArray(m.input)
							? { inputModalities: m.input }
							: {}),
				})),
			};
		} catch (err) {
			return { models: [], error: err?.message ?? String(err) };
		}
	}

	questionBridge = { pending: null, queue: [] };

	toolsPending = new Map();
	toolUnregisters = [];

	async syncTools(params) {
		const tools = Array.isArray(params?.tools) ? params.tools : [];
		for (const off of this.toolUnregisters) {
			try {
				off();
			} catch {}
		}
		this.toolUnregisters = [];
		const registered = [];
		for (const t of tools) {
			if (!t || typeof t.name !== "string" || typeof t.description !== "string") continue;
			try {
				const tool = defineTool({
					name: t.name,
					description: t.description,
					parameters: piParamsToDshSpec(t.parameters),
					output: {
						schema: { type: "string" },
						render: (_args, value) => [{ type: "text", text: String(value ?? "") }],
					},
					execute: (args, exec) => this.invokeBridgedTool(exec, t.name, args),
				});
				const off = this.ctx.tools.register(tool);
				this.toolUnregisters.push(off);
				registered.push(t.name);
			} catch (err) {
				console.warn(`[dsh] 工具 ${t.name} 注册跳过:`, err?.message ?? err);
			}
		}
		return { registered, count: registered.length };
	}

	async listTools() {
		const schemas = this.ctx.tools.schemas();
		return {
			tools: schemas.map((s) => ({
				name: s.name,
				description: s.description,
				parameters: s.parameters,
			})),
		};
	}

	invokeBridgedTool(exec, name, args) {
		const agentId = exec?.agent?.id;
		if (agentId !== undefined && this.minimalAgents.has(agentId)) {
			return Promise.reject(
				new Error(
					`工具 ${name} unavailable under the minimal preset; use the shell instead ` +
						`（极简模式下该插件工具不可用，请用 shell 命令推进）`,
				),
			);
		}
		const id = `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
		const sessionId =
			exec?.agent?.session?.id && typeof exec.agent.session.id === "string" ? String(exec.agent.session.id) : undefined;
		return new Promise((resolve, reject) => {
			let done = false;
			const cleanup = () => {
				if (exec?.signal) exec.signal.removeEventListener("abort", onAbort);
			};
			const settle = (err, result) => {
				if (done) return;
				done = true;
				cleanup();
				clearTimeout(timer);
				if (err) reject(err);
				else resolve(result);
			};
			const onAbort = () => {
				this.toolsPending.delete(id);
				settle(new Error(`工具 ${name} 已中止`));
			};
			const timer = setTimeout(() => {
				this.toolsPending.delete(id);
				settle(new Error(`工具 ${name} 执行超时（等待服务端响应）`));
			}, TOOL_TIMEOUT_MS);
			timer.unref?.();
			this.toolsPending.set(id, {
				resolve: (result) => settle(null, result),
				reject: (err) => settle(err),
			});
			exec?.signal?.addEventListener("abort", onAbort, { once: true });
			this.transport.notify("tools.call.request", {
				id,
				name,
				args,
				...(sessionId ? { sessionId } : {}),
			});
		});
	}

	async toolsInvoke(params) {
		if (process.env.PI_WEB_DSH_DEBUG !== "1") {
			throw new Error("tools/invoke 仅调试可用（服务端需设 PI_WEB_DSH_DEBUG=1）");
		}
		const name = params?.name;
		if (typeof name !== "string") return { ok: false, error: "tools/invoke requires name" };
		const tool = this.ctx.tools.get(name);
		if (!tool) return { ok: false, error: `tools/invoke: 工具未注册 ${name}` };
		const exec = { signal: new AbortController().signal };
		try {
			const value = await tool.execute(params?.args ?? {}, exec);
			return { ok: true, value };
		} catch (err) {
			return { ok: false, error: err?.message ?? String(err) };
		}
	}

	async toolsCallResult(params) {
		const id = params?.id;
		if (typeof id !== "string") throw new TypeError("tools/call-result requires id");
		const pending = this.toolsPending.get(id);
		if (!pending) throw new Error(`tools/call-result 无匹配 id=${id}`);
		this.toolsPending.delete(id);
		if (params?.isError) pending.reject(new Error(params?.result ?? "工具执行失败"));
		else pending.resolve(params?.result ?? "");
		return { ok: true };
	}

	disabledSkills = new Set();

	async listSkills() {
		const roster = this.presetRoster();
		if (roster) {
			try {
				const agent = await this.ensureInventoryAgent();
				const skills = await this.ctx.skills.list({ scope: agent, cwd: this.cwd });
				if (Array.isArray(skills)) {
					return {
						skills: skills.map((s) => ({
							name: s.name,
							description: s.description ?? "",
							...(s.invocation ? { invocation: s.invocation } : {}),
						})),
					};
				}
			} catch (err) {
				return { skills: [], error: err?.message ?? String(err) };
			}
			return { skills: [] };
		}
		try {
			const skills = await this.ctx.skills.list();
			if (!Array.isArray(skills)) return { skills: [] };
			return {
				skills: skills.map((s) => ({
					name: s.name,
					description: s.description ?? "",
					...(s.invocation ? { invocation: s.invocation } : {}),
				})),
			};
		} catch (err) {
			return { skills: [], error: err?.message ?? String(err) };
		}
	}

	async getSkill(params) {
		if (typeof params?.name !== "string") throw new TypeError("skills/get requires name");
		const skill = await this.ctx.skills.get(params.name);
		return { skill: skill ?? null };
	}

	async setDisabledSkills(params) {
		const names = Array.isArray(params?.skills) ? params.skills : [];
		this.disabledSkills = new Set(names.map((n) => String(n)));
		return { disabled: [...this.disabledSkills] };
	}

	async registerSkill(params) {
		if (process.env.PI_WEB_DSH_DEBUG !== "1") throw new Error("skills/register 仅调试可用");
		if (typeof params?.name !== "string" || !params.name.trim()) {
			throw new TypeError("skills/register requires name");
		}
		const reg = this.ctx.skills.register({
			name: params.name.trim(),
			description: typeof params?.description === "string" ? params.description : "",
			invocation: { modelInvocable: true, userInvocable: false },
			source: "runtime",
			content: typeof params?.content === "string" ? params.content : "(test skill)",
		});
		return { ok: true, unregister: typeof reg === "function" };
	}

	dispatchNextQuestion() {
		if (this.questionBridge.pending) return;
		const next = this.questionBridge.queue.shift();
		if (!next) return;
		this.transport.notify("question.pending", {
			id: next.qid,
			questions: next.questions,
			deadline: next.deadline,
		});
		this.questionBridge.pending = { qid: next.qid, resolve: next.resolve, reject: next.reject };
	}

	async askUser(request) {
		const questions = (request?.questions ?? []).map((q) => ({
			id: q.id,
			question: q.question,
			...(q.detail ? { detail: q.detail } : {}),
			...(q.header ? { header: q.header } : {}),
			...(q.options ? { options: q.options } : {}),
			...(q.multiSelect ? { multiSelect: q.multiSelect } : {}),
		}));
		if (questions.length === 0) throw new Error("ask_user_question requires at least one question");
		const qid = `q-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
		const deadline = Date.now() + QUESTION_TIMEOUT_MS;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				const queued = this.questionBridge.queue.findIndex((q) => q.qid === qid);
				if (queued >= 0) {
					this.questionBridge.queue.splice(queued, 1);
					reject(new Error("提问超时（等待回答过久）"));
					return;
				}
				if (this.questionBridge.pending?.qid === qid) {
					this.questionBridge.pending = null;
					reject(new Error("提问超时（等待回答过久）"));
					this.dispatchNextQuestion();
				}
			}, QUESTION_TIMEOUT_MS);
			timer.unref?.();
			const entry = {
				qid,
				questions,
				deadline,
				resolve: (answers) => {
					clearTimeout(timer);
					resolve(answers);
				},
				reject: (err) => {
					clearTimeout(timer);
					reject(err);
				},
			};
			if (this.questionBridge.pending || this.questionBridge.queue.length > 0) {
				if (this.questionBridge.queue.length >= 3) {
					clearTimeout(timer);
					reject(new Error("提问排队已满（最多 3 个），请先回答当前提问"));
					return;
				}
				this.questionBridge.queue.push(entry);
			} else {
				this.transport.notify("question.pending", { id: qid, questions, deadline });
				this.questionBridge.pending = { qid, resolve: entry.resolve, reject: entry.reject };
			}
		});
	}

	async answerQuestion(params) {
		const pending = this.questionBridge.pending;
		if (!pending || pending.qid !== params?.id) {
			throw new Error(`question/answer 不匹配（id=${params?.id}）`);
		}
		this.questionBridge.pending = null;
		if (params?.cancelled) {
			const reason =
				typeof params?.cancelReason === "string" && params.cancelReason.trim()
					? `（附言：${params.cancelReason.trim()}）`
					: "";
			pending.reject(new Error(`用户取消了提问${reason}`));
		} else {
			const answers = Array.isArray(params?.answers) ? params.answers : [];
			pending.resolve({ answers });
		}
		this.dispatchNextQuestion();
		return { ok: true };
	}

	async attachmentSave(params) {
		const mediaType = params?.mediaType;
		if (typeof mediaType !== "string" || !/^image\/(png|jpeg|webp|gif)$/u.test(mediaType)) {
			throw new TypeError("attachment/save requires mediaType (image/png|jpeg|webp|gif)");
		}
		if (typeof params?.data !== "string" || !params.data) {
			throw new TypeError("attachment/save requires base64 data");
		}
		const bytes = new Uint8Array(Buffer.from(params.data, "base64"));
		if (bytes.length === 0) throw new TypeError("attachment/save: empty image data");
		const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
		if (bytes.length > MAX_ATTACHMENT_BYTES) {
			throw new RangeError(`attachment/save: image data exceeds 20MB limit (${bytes.length} bytes)`);
		}
		const ref = await this.ctx.attachments.saveImage({
			data: bytes,
			mediaType,
			...(typeof params?.name === "string" && params.name ? { name: params.name } : {}),
		});
		return { ref };
	}

	async attachmentRead(params) {
		const ref = params?.ref;
		if (!ref || typeof ref?.attachmentId !== "string" || typeof ref?.mediaType !== "string") {
			throw new TypeError("attachment/read requires ref (attachmentId + mediaType)");
		}
		const stored = await this.ctx.attachments.readImage(ref);
		return {
			mediaType: stored.ref?.mediaType ?? ref.mediaType,
			data: Buffer.from(stored.data).toString("base64"),
		};
	}
}

function apply(ctx, config) {
	const resolvedConfig = config;
	const rootFiber = ctx.root.fiber;
	/* v8 ignore next -- production stdio wiring */
	const input = config.input ?? process.stdin;
	/* v8 ignore next -- production stdio wiring */
	const output = config.output ?? process.stdout;
	/* v8 ignore next -- production exit wiring */
	const exit =
		config.exit ??
		((code) => {
			process.exit(code);
		});
	const transport = new JsonRpcLineTransport(input, output);
	const server = new DshGoalJsonRpcServer(ctx, transport, {
		maxTokensAsSuccess: resolvedConfig.maxTokensAsSuccess,
	});
	let exitTask;
	const disposeAndExit = () => {
		exitTask ??= (async () => {
			await Promise.allSettled([Promise.resolve().then(() => transport.flush())]);
			await Promise.allSettled([Promise.resolve().then(() => rootFiber.dispose())]);
			exit(0);
		})();
		return exitTask;
	};
	transport.onRequest(async (method, params) => {
		if (method === "initialize") await ctx.get("loader")?.await();
		const result = await server.handleRequest(method, params);
		if (method === "shutdown")
			setImmediate(() => {
				disposeAndExit();
			});
		return result;
	});
	ctx.effect(() => {
		transport.start();
		return async () => {
			await server.shutdown();
			transport.close();
		};
	}, "jsonrpc.serve");
}

const name = "sdk-jsonrpc-server";
const inject = [
	"agents",
	"goals",
	"attachments",
	"userQuestions",
	"llm",
	"tools",
	"skills",
	"systemPrompt",
	"permissionPresets",
	"approval",
];

export { Config, apply, inject, name };
