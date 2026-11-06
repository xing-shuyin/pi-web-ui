/// <reference path="../chrome.d.ts" />
/// <reference lib="dom" />

const FLAG = "__piBridgeContent";
const ATTR = "data-pi-bridge";
const ARM = "page-picker:bridge-arm";
const CALL = "page-picker:bridge-call";

interface ContentRuntime {
	token: string;
}

interface BridgeCallResult {
	ok: boolean;
	value?: unknown;
	error?: string;
}

const g = globalThis as unknown as Record<string, unknown>;
const existing = g[FLAG] as ContentRuntime | undefined;
const runtime: ContentRuntime = existing ?? { token: "" };
g[FLAG] = runtime;

function makeToken(): string {
	try {
		const bytes = new Uint8Array(16);
		crypto.getRandomValues(bytes);
		return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
	} catch {
		return `t${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
	}
}

function arm(): string {
	runtime.token = makeToken();
	try {
		document.documentElement?.setAttribute(ATTR, runtime.token);
	} catch {}
	return runtime.token;
}

async function forward(data: Record<string, unknown>): Promise<BridgeCallResult> {
	try {
		const res = (await chrome.runtime.sendMessage({
			type: CALL,
			op: data.op,
			args: data.args,
			to: data.to,
			timeoutMs: data.timeoutMs,
		})) as BridgeCallResult | undefined;
		if (!res || typeof res !== "object") {
			return { ok: false, error: chrome.i18n.getMessage("bridge_emptyResult") };
		}
		return res;
	} catch (err) {
		return {
			ok: false,
			error: chrome.i18n.getMessage("bridge_noResponse", [err instanceof Error ? err.message : String(err)]),
		};
	}
}

function reply(id: unknown, result: BridgeCallResult): void {
	try {
		window.postMessage(
			result.ok
				? { __piBridge: runtime.token, kind: "result", id, ok: true, value: result.value }
				: {
						__piBridge: runtime.token,
						kind: "result",
						id,
						ok: false,
						error: result.error ?? chrome.i18n.getMessage("bridge_peerCallFailed"),
					},
			"*",
		);
	} catch (err) {
		try {
			window.postMessage(
				{
					__piBridge: runtime.token,
					kind: "result",
					id,
					ok: false,
					error: chrome.i18n.getMessage("bridge_resultNotClonable", [err instanceof Error ? err.message : String(err)]),
				},
				"*",
			);
		} catch {}
	}
}

function onWindowMessage(e: MessageEvent): void {
	if (e.source !== window) return;
	const data = e.data as Record<string, unknown> | null | undefined;
	if (!data || typeof data !== "object") return;
	if (data.__piBridge !== runtime.token) return;
	if (data.kind !== "call") return;
	const id = data.id;
	void forward(data).then((res) => reply(id, res));
}

if (!existing) {
	chrome.runtime.onMessage.addListener((raw, _sender, respond) => {
		const msg = raw as { type?: string } | undefined;
		if (!msg || msg.type !== ARM) return undefined;
		respond({ ok: true, token: arm() });
		return undefined;
	});
	window.addEventListener("message", onWindowMessage);
	arm();
}
