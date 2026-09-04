/**
 * marker-service.ts — 标记服务（内置版 pi-marker-tools）。
 */

import type { ServerMessage } from "./protocol.js";
import type { ClientStateStore, MarkerSettings } from "./client-state.js";
import {
	ensureMarkersRegistered,
	parseMarkers,
	getMarker,
	allMarkers,
	collectGuidance,
	listMarkerNames,
} from "./markers/index.js";
import { loadStateFromBranch, appendSnapshot } from "./markers/store.js";
import { TODO_NAMESPACE, type TodoState, initTodoState, describeTodos } from "./markers/builtins/todo.js";
import { SVC_NAMESPACE, type ServiceState, initServiceState, describeServices } from "./markers/builtins/services.js";
import type { MarkerContext } from "./markers/marker.js";

ensureMarkersRegistered();

const DEFAULT_MARKERS: MarkerSettings = {
	markersEnabled: true,
	disabledMarkers: [],
};

export interface MarkerHost {
	clientId: string;
	stateStore: ClientStateStore;
	emit: (msg: ServerMessage) => void;
	isDisposed: () => boolean;
	getActiveConversationId: () => string;
	getSessionManager: (
		conversationId: string,
	) => { getBranch: () => unknown[]; appendCustomEntry?: (t: string, d: unknown) => unknown } | undefined;
	renameConversation: (conversationId: string, title: string) => void;
}

export class MarkerService {
	private settings: MarkerSettings;
	private memStore = new Map<string, Map<string, unknown>>();
	private overlayCache = new Map<string, string[]>();

	constructor(private readonly host: MarkerHost) {
		this.settings = this.host.stateStore.getMarkerSettings(this.host.clientId);
	}

	get current(): MarkerSettings {
		return { ...this.settings, disabledMarkers: [...this.settings.disabledMarkers] };
	}

	get allMarkerNames(): string[] {
		return listMarkerNames();
	}

	isGlobalEnabled(): boolean {
		return this.settings.markersEnabled;
	}

	isMarkerEnabled(name: string): boolean {
		if (!this.settings.markersEnabled) return false;
		if ((name === "rename" || name === "title") && this.settings.disabledMarkers.includes("conv")) return false;
		if (
			name === "conv" &&
			(this.settings.disabledMarkers.includes("rename") || this.settings.disabledMarkers.includes("title"))
		)
			return false;
		return !this.settings.disabledMarkers.includes(name);
	}

	buildGuidance(): string {
		if (!this.settings.markersEnabled) return "";
		const disabled = new Set(this.settings.disabledMarkers);
		const lines = collectGuidance(disabled);
		if (lines.length === 0) return "";
		return (
			"\n\n────────── 内联标记工具（重要）──────────\n" +
			"状态类操作（任务、标记位、通知）请直接写在回答正文里，采用内联标记语法，而不要调用对应工具。\n" +
			"插件会替你执行并把标记从展示文本中移除，不会中断你的回答。\n\n" +
			lines.join("\n") +
			"\n──────────\n"
		);
	}

	setEnabled(enabled: boolean): void {
		this.settings.markersEnabled = !!enabled;
		this.host.stateStore.saveMarkerSettings(this.host.clientId, this.settings);
	}

	toggleMarker(name: string, enabled: boolean): void {
		const set = new Set(this.settings.disabledMarkers);
		const group = name === "conv" || name === "rename" || name === "title" ? ["conv", "rename", "title"] : [name];
		for (const n of group) {
			if (enabled) set.delete(n);
			else set.add(n);
		}
		this.settings.disabledMarkers = [...set];
		this.host.stateStore.saveMarkerSettings(this.host.clientId, this.settings);
	}

	setAll(settings: Partial<MarkerSettings>): void {
		if (settings.markersEnabled !== undefined) this.settings.markersEnabled = !!settings.markersEnabled;
		if (settings.disabledMarkers !== undefined) {
			// 归一化 rename 别名：若 conv 被禁用则同步禁用别名
			const s = new Set(settings.disabledMarkers);
			if (s.has("conv") || s.has("rename") || s.has("title")) {
				s.add("conv");
				s.add("rename");
				s.add("title");
			}
			this.settings.disabledMarkers = [...s];
		} else {
			this.host.stateStore.saveMarkerSettings(this.host.clientId, this.settings);
			return;
		}
		this.host.stateStore.saveMarkerSettings(this.host.clientId, this.settings);
	}

	// -- state helpers --
	private memFor(convId: string, ns: string): unknown | undefined {
		return this.memStore.get(convId)?.get(ns);
	}

	private setMem(convId: string, ns: string, state: unknown): void {
		let m = this.memStore.get(convId);
		if (!m) {
			m = new Map();
			this.memStore.set(convId, m);
		}
		m.set(ns, state);
	}

	private getState<T>(convId: string, namespace: string, init: () => T): T {
		const mgr = this.host.getSessionManager(convId);
		if (mgr?.getBranch) {
			try {
				const branch = mgr.getBranch();
				const fromBranch = loadStateFromBranch(branch, namespace) as T | undefined;
				if (fromBranch !== undefined) {
					this.setMem(convId, namespace, fromBranch);
					return structuredClone(fromBranch);
				}
			} catch {}
		}
		const mem = this.memFor(convId, namespace) as T | undefined;
		if (mem !== undefined) return structuredClone(mem);
		return init();
	}

	private saveState(convId: string, namespace: string, state: unknown): void {
		this.setMem(convId, namespace, structuredClone(state));
		const mgr = this.host.getSessionManager(convId);
		appendSnapshot(
			mgr as unknown as { appendCustomEntry?: (t: string, d: unknown) => unknown; getBranch?: () => unknown[] },
			namespace,
			state,
		);
	}

	// -- parse & execute --
	async handleAssistantText(conversationId: string, text: string): Promise<void> {
		if (!text || !this.settings.markersEnabled) return;
		const tokens = parseMarkers(text);
		if (tokens.length === 0) return;

		const disabled = new Set(this.settings.disabledMarkers);
		const states = new Map<string, unknown>();
		const getOrInit = (ns: string): unknown => {
			let st = states.get(ns);
			if (st !== undefined) return st;
			if (ns === TODO_NAMESPACE) st = this.getState(conversationId, ns, initTodoState);
			else if (ns === SVC_NAMESPACE) st = this.getState(conversationId, ns, initServiceState);
			else {
				const marker = getMarker(ns);
				st = marker?.init ? (marker.init() as unknown) : {};
			}
			states.set(ns, st);
			return st;
		};

		const dirty = new Set<string>();

		for (const token of tokens) {
			if (disabled.has(token.tool)) continue;
			const marker = getMarker(token.tool);
			if (!marker) continue;
			const state = getOrInit(token.tool) as never;
			const ctx: MarkerContext = {
				conversationId,
				notify: (msg, level, msgEn) => {
					this.host.emit({ type: "notice", level: level ?? "info", text: msg, textEn: msgEn });
				},
				renameConversation: (title: string) => {
					this.host.renameConversation(conversationId, title);
				},
			};
			let result;
			try {
				result = await marker.apply(token, ctx, state);
			} catch (e) {
				result = { applied: false, error: `执行异常: ${(e as Error)?.message ?? String(e)}` };
			}
			if (result.applied) {
				if (token.tool !== "notify" && token.tool !== "conv" && token.tool !== "rename" && token.tool !== "title") {
					dirty.add(token.tool);
				} else if (token.tool === "conv" || token.tool === "rename" || token.tool === "title") {
					// rename 不落库，已直接重命名
				} else if (token.tool === "notify") {
					// 通知不落库
				}
				if (token.tool === "todo" || token.tool === "svc") dirty.add(token.tool);
			} else if (result.error) {
				this.host.emit({
					type: "notice",
					level: "warning",
					text: `[${token.tool}] ${result.error}`,
					textEn: `[${token.tool}] ${result.error}`,
				});
			}
		}

		for (const ns of dirty) {
			const mutated = states.get(ns);
			if (mutated !== undefined) this.saveState(conversationId, ns, mutated);
		}

		this.pushOverlay(conversationId);
	}

	pushOverlay(conversationId: string): void {
		const lines: string[] = [];
		for (const m of allMarkers()) {
			if (this.settings.disabledMarkers.includes(m.name)) continue;
			if (!m.overlay) continue;
			let state: unknown;
			if (m.name === TODO_NAMESPACE) state = this.getState(conversationId, m.name, initTodoState);
			else if (m.name === SVC_NAMESPACE) state = this.getState(conversationId, m.name, initServiceState);
			else {
				state = this.getState(conversationId, m.name, () => (m.init?.() as unknown) ?? {});
				if (state === undefined) continue;
			}
			const ctx: MarkerContext = {
				conversationId,
				notify: () => {},
				renameConversation: (t) => this.host.renameConversation(conversationId, t),
			};
			const ov = m.overlay(state as never, ctx);
			if (!ov) continue;
			lines.push(`[${ov.tool}]`);
			lines.push(...ov.lines.map((l) => `  ${l}`));
		}
		const key = `markers:${conversationId}`;
		const prev = this.overlayCache.get(key);
		const next = lines.length ? lines : [];
		if (prev && prev.join("\n") === next.join("\n")) return;
		this.overlayCache.set(key, next);
		if (lines.length > 0) {
			this.host.emit({ type: "widgets", widgets: [{ key: "markers", lines }] });
		} else {
			this.host.emit({ type: "widgets", widgets: [] });
		}
	}

	describe(conversationId: string, tool: string, includeDeleted = false): string {
		if (tool === "svc") {
			const st = this.getState<ServiceState>(conversationId, SVC_NAMESPACE, initServiceState);
			return describeServices(st);
		}
		const st = this.getState<TodoState>(conversationId, TODO_NAMESPACE, initTodoState);
		const visible = st.tasks.filter((t) => includeDeleted || t.status !== "deleted");
		if (visible.length === 0) return "No todos";
		return visible.map((t) => `[${t.status}] #${t.id}: ${t.subject}`).join("\n");
	}

	getRawState(conversationId: string, namespace: string): unknown {
		if (namespace === TODO_NAMESPACE) return this.getState(conversationId, namespace, initTodoState);
		if (namespace === SVC_NAMESPACE) return this.getState(conversationId, namespace, initServiceState);
		const m = getMarker(namespace);
		return this.getState(conversationId, namespace, () => (m?.init?.() as unknown) ?? {});
	}

	/** 供设置面板展示的 marker 目录（含启用状态）。 */
	/** UI 过滤：rename/title 是 conv 的别名，不单独展示。 */
	listForUi(): Array<{ name: string; enabled: boolean; guidance: string[] }> {
		const seen = new Set<string>();
		const out: Array<{ name: string; enabled: boolean; guidance: string[] }> = [];
		for (const m of allMarkers()) {
			if (m.name === "rename" || m.name === "title") continue;
			if (seen.has(m.name)) continue;
			seen.add(m.name);
			out.push({ name: m.name, enabled: this.isMarkerEnabled(m.name), guidance: m.guidance });
		}
		return out;
	}
}
