import type { ServerMessage, UiActionSuggestion, UiMarkerInfo } from "./protocol.js";
import type { ClientStateStore, MarkerSettings } from "./client-state.js";
import { pick, type ServerLang } from "./i18n.js";
import {
	ensureMarkersRegistered,
	parseMarkers,
	getMarker,
	allMarkers,
	collectGuidance,
	listMarkerNames,
} from "./markers/index.js";
import { loadStateFromBranch, appendSnapshot } from "./markers/store.js";
import { ACTION_NAMESPACE, type ActionState, initActionState } from "./markers/builtins/action.js";
import type { MarkerContext } from "./markers/marker.js";

ensureMarkersRegistered();

const _DEFAULT_MARKERS: MarkerSettings = {
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
	refreshMarkers: () => void;
	onActionsChange?: (conversationId: string) => void;
	lang?: () => ServerLang;
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
		if (name === "suggest" && this.settings.disabledMarkers.includes("action")) return false;
		return !this.settings.disabledMarkers.includes(name);
	}

	private lang(): ServerLang {
		return this.host.lang?.() ?? "en";
	}

	buildGuidance(): string {
		if (!this.settings.markersEnabled) return "";
		const disabled = new Set(this.settings.disabledMarkers);
		const lines = collectGuidance(disabled, "en");
		if (lines.length === 0) return "";
		const linesText = lines.join("\n");
		return (
			"\n\n────────── Inline Markers ──────────\n" +
			"Use inline markers in reply text for status actions (never call tools for them). Markers are executed and stripped before display.\n\n" +
			linesText +
			"\n──────────\n"
		);
	}

	setEnabled(enabled: boolean): void {
		this.settings.markersEnabled = !!enabled;
		this.host.stateStore.saveMarkerSettings(this.host.clientId, this.settings);
	}

	toggleMarker(name: string, enabled: boolean): void {
		const set = new Set(this.settings.disabledMarkers);
		if (enabled) {
			set.delete(name);
			if (name === "action") set.delete("suggest");
		} else {
			set.add(name);
			if (name === "action") set.add("suggest");
		}
		this.settings.disabledMarkers = [...set];
		this.host.stateStore.saveMarkerSettings(this.host.clientId, this.settings);
	}

	setAll(settings: Partial<MarkerSettings>): void {
		if (settings.markersEnabled !== undefined) this.settings.markersEnabled = !!settings.markersEnabled;
		if (settings.disabledMarkers !== undefined) {
			this.settings.disabledMarkers = [...new Set(settings.disabledMarkers)];
		} else {
			this.host.stateStore.saveMarkerSettings(this.host.clientId, this.settings);
			return;
		}
		this.host.stateStore.saveMarkerSettings(this.host.clientId, this.settings);
	}

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

	private chains = new Map<string, Promise<void>>();

	handleAssistantText(conversationId: string, text: string): Promise<void> {
		const prev = this.chains.get(conversationId) ?? Promise.resolve();
		const next = prev
			.then(() => this.processAssistantText(conversationId, text))
			.catch((e) => {
				console.error("[markers] handleAssistantText failed:", e);
			})
			.finally(() => {
				if (this.chains.get(conversationId) === next) {
					this.chains.delete(conversationId);
				}
			});
		this.chains.set(conversationId, next);
		return next;
	}

	clearConversation(conversationId: string): void {
		this.chains.delete(conversationId);
	}

	private async processAssistantText(conversationId: string, text: string): Promise<void> {
		if (!text || !this.settings.markersEnabled) return;
		const tokens = parseMarkers(text);
		if (tokens.length === 0) return;

		const disabled = new Set(this.settings.disabledMarkers);
		const states = new Map<string, unknown>();
		const getOrInit = (ns: string): unknown => {
			const canonicalNs = ns === "suggest" ? ACTION_NAMESPACE : ns;
			let st = states.get(canonicalNs);
			if (st !== undefined) return st;
			if (canonicalNs === ACTION_NAMESPACE) st = this.getState(conversationId, canonicalNs, initActionState);
			else {
				const marker = getMarker(canonicalNs);
				st = this.getState(conversationId, canonicalNs, () => (marker?.init ? (marker.init() as unknown) : {}));
			}
			states.set(canonicalNs, st);
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
				result = await marker.apply(token, ctx, state, this.lang());
			} catch (e) {
				const errMsg = (e as Error)?.message ?? String(e);
				result = {
					applied: false,
					error: pick(
						this.lang(),
						`执行异常: ${errMsg}`,
						`Execution failed: ${errMsg}`,
						"markers.service.execution.failed",
						{ errMsg: errMsg },
					),
				};
			}
			if (result.applied) {
				const canonicalTool = token.tool === "suggest" ? ACTION_NAMESPACE : token.tool;
				if (canonicalTool !== "notify" && canonicalTool !== "conv") {
					dirty.add(canonicalTool);
				}
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
		if (dirty.has(ACTION_NAMESPACE)) {
			this.host.onActionsChange?.(conversationId);
		}
	}

	pushOverlay(conversationId: string): void {
		const lines = this.overlayLines(conversationId);
		const key = `markers:${conversationId}`;
		const prev = this.overlayCache.get(key);
		const next = lines.length ? lines : [];
		if (prev && prev.join("\n") === next.join("\n")) return;
		this.overlayCache.set(key, next);
		this.host.refreshMarkers();
	}

	overlayLines(conversationId: string): string[] {
		const lines: string[] = [];
		for (const m of allMarkers()) {
			if (m.isAlias || m.name === "suggest") continue;
			if (this.settings.disabledMarkers.includes(m.name)) continue;
			if (!m.overlay) continue;
			let state: unknown;
			if (m.name === ACTION_NAMESPACE) state = this.getState(conversationId, m.name, initActionState);
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
		return lines;
	}

	getRawState(conversationId: string, namespace: string): unknown {
		if (namespace === ACTION_NAMESPACE || namespace === "suggest")
			return this.getState(conversationId, ACTION_NAMESPACE, initActionState);
		const m = getMarker(namespace);
		return this.getState(conversationId, namespace, () => (m?.init?.() as unknown) ?? {});
	}

	getActionSuggestions(conversationId: string): UiActionSuggestion[] | null {
		if (!this.isMarkerEnabled("action")) return null;
		const st = this.getState<ActionState>(conversationId, ACTION_NAMESPACE, initActionState);
		if (!st || !st.actions || st.actions.length === 0) return null;
		return st.actions.map((a) => ({ id: a.id, label: a.label, prompt: a.prompt }));
	}

	clearActions(conversationId: string): void {
		const st = this.getState<ActionState>(conversationId, ACTION_NAMESPACE, initActionState);
		if (st && st.actions && st.actions.length > 0) {
			st.actions = [];
			this.saveState(conversationId, ACTION_NAMESPACE, st);
			this.pushOverlay(conversationId);
			this.host.onActionsChange?.(conversationId);
		}
	}

	listForUi(): Array<UiMarkerInfo> {
		const seen = new Set<string>();
		const out: Array<UiMarkerInfo> = [];
		for (const m of allMarkers()) {
			if (m.isAlias || m.name === "suggest") continue;
			if (seen.has(m.name)) continue;
			seen.add(m.name);
			out.push({
				name: m.name,
				label: m.label,
				pluginId: m.pluginId,
				enabled: this.isMarkerEnabled(m.name),
				guidance: m.getGuidance?.(this.lang()) ?? m.guidance,
			});
		}
		return out;
	}
}
