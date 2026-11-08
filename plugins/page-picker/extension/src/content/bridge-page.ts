/// <reference lib="dom" />

export interface BridgePageApi {
	version: number;
	self: string;
	peers: string[];
	on(op: string, handler: (args: unknown, ctx: { from: string }) => unknown): () => void;
	off(op: string): void;
	call(req: { op: string; args?: unknown; to?: string; timeoutMs?: number }): Promise<unknown>;
}

interface BridgePageInternal extends BridgePageApi {
	token: string;
	__builtin?: Record<string, (args: Record<string, unknown>) => unknown>;
	__invoke(op: unknown, args: unknown, from: unknown, builtin?: unknown): Promise<Record<string, unknown>>;
	__destroy(): void;
}

export interface BridgePageInstallResult {
	ok: boolean;
	reason?: "no-token" | "no-window";
	version?: number;
}

export function installBridgePage(options?: {
	peers?: unknown;
	self?: unknown;
	control?: unknown;
}): BridgePageInstallResult {
	const g = globalThis as unknown as Record<string, unknown>;
	const doc = (g as { document?: { documentElement?: { getAttribute?(name: string): string | null } } }).document;
	const el = doc?.documentElement;
	if (!el || typeof el.getAttribute !== "function") return { ok: false, reason: "no-window" };
	const token = el.getAttribute("data-pi-bridge") ?? "";
	if (!token) return { ok: false, reason: "no-token" };

	const VERSION = 1;
	const location = (g as { location?: { origin?: string } }).location;
	const self = typeof options?.self === "string" ? options.self : (location?.origin ?? "");
	const peers = Array.isArray(options?.peers)
		? (options?.peers as unknown[]).filter((x): x is string => typeof x === "string")
		: [];
	const control = options?.control === true;

	const existing = g.__piBridge as Partial<BridgePageInternal> | undefined;
	if (
		existing &&
		existing.version === VERSION &&
		typeof existing.__destroy === "function" &&
		(existing.__builtin !== undefined) === control
	) {
		existing.token = token;
		existing.peers = peers.slice();
		existing.self = self;
		return { ok: true, version: VERSION };
	}
	if (existing && typeof existing.__destroy === "function") {
		try {
			existing.__destroy();
		} catch {}
	}

	const handlers = new Map<string, (args: unknown, ctx: { from: string }) => unknown>();

	const docAny = (g as { document?: Document }).document;
	const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

	const num = (v: unknown, dflt: number, min: number, max: number): number => {
		const n = typeof v === "number" && isFinite(v) ? Math.round(v) : dflt;
		return Math.min(max, Math.max(min, n));
	};

	const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

	const cut = (text: string, max: number): string =>
		text.length > max ? `${text.slice(0, max)}\n…（已截断，原文 ${text.length} 字）` : text;

	const textOf = (node: Element | null): string => {
		if (!node) return "";
		const raw = (node as HTMLElement).innerText ?? node.textContent ?? "";
		return String(raw).replace(/\r/g, "").trim();
	};

	/** 口令框的值一律不出页面：查询/点击/取 HTML 都按同一口径脱敏（与桌面原生 `browser/automation/page-operation.ts` 对齐）。 */
	const isPassword = (node: Element): boolean =>
		node.tagName.toLowerCase() === "input" && (node as HTMLInputElement).type.toLowerCase() === "password";

	/** 取 HTML 前先克隆并清空口令框的 value，避免 `<input type=password value="...">` 被带出去。 */
	const outerHtmlMasked = (node: Element | null): string => {
		if (!node) return "";
		const clone = node.cloneNode(true) as Element;
		const passwords = [...clone.querySelectorAll('input[type="password" i]')];
		if (isPassword(clone)) passwords.push(clone);
		for (const input of passwords) {
			input.removeAttribute("value");
			(input as HTMLInputElement).value = "";
			input.textContent = "";
		}
		return clone.outerHTML;
	};

	const brief = (node: Element, index: number): Record<string, unknown> => {
		const rect = node.getBoundingClientRect();
		const classes = node.classList ? [...node.classList].slice(0, 6) : [];
		const tag = node.tagName.toLowerCase();
		return {
			index,
			tag,
			...(node.id ? { id: node.id } : {}),
			...(classes.length > 0 ? { classes } : {}),
			text: isPassword(node) ? "" : cut(textOf(node).replace(/\s+/g, " "), 160),
			...(tag === "a" ? { href: (node as HTMLAnchorElement).href } : {}),
			...(tag === "input" || tag === "textarea"
				? {
						...((node as HTMLInputElement).type ? { type: (node as HTMLInputElement).type } : {}),
						...(!isPassword(node) ? { value: (node as HTMLInputElement).value } : {}),
						...((node as HTMLInputElement).placeholder ? { placeholder: (node as HTMLInputElement).placeholder } : {}),
					}
				: {}),
			rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
		};
	};

	const find = (args: Record<string, unknown>): Element | null => {
		const selector = str(args.selector);
		if (!selector || !docAny) return null;
		const all = [...docAny.querySelectorAll(selector)];
		const index = num(args.index, 0, 0, Math.max(0, all.length - 1));
		return all[index] ?? null;
	};

	const setValue = (node: Element, text: string): void => {
		const tag = node.tagName.toLowerCase();
		if (tag === "input" || tag === "textarea") {
			const target = node as HTMLInputElement | HTMLTextAreaElement;
			const proto = tag === "textarea" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
			const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
			if (setter) setter.call(target, text);
			else target.value = text;
		} else {
			(node as HTMLElement).textContent = text;
		}
		node.dispatchEvent(new Event("input", { bubbles: true }));
		node.dispatchEvent(new Event("change", { bubbles: true }));
	};

	const actions: Record<string, (args: Record<string, unknown>) => unknown> = {};

	actions["pages"] = () => ({ pages: peers.slice(), self });

	actions["metrics"] = () => {
		const win = g as unknown as {
			devicePixelRatio?: number;
			innerWidth?: number;
			innerHeight?: number;
			scrollX?: number;
			scrollY?: number;
		};
		return {
			dpr: win.devicePixelRatio ?? 1,
			vw: win.innerWidth ?? 0,
			vh: win.innerHeight ?? 0,
			sx: win.scrollX ?? 0,
			sy: win.scrollY ?? 0,
		};
	};

	actions["read"] = (args) => {
		const what = str(args.what) || "text";
		if (what === "title") return { title: docAny?.title ?? "" };
		if (what === "url") return { url: String((g as { location?: { href?: string } }).location?.href ?? "") };
		const selector = str(args.selector);
		if (what === "query") {
			if (!selector) return { error: "read what=query 需要 selector" };
			const all = [...(docAny?.querySelectorAll(selector) ?? [])];
			const limit = num(args.limit, 20, 1, 100);
			const picked = (args.all === false ? all.slice(0, 1) : all).slice(0, limit);
			return {
				selector,
				count: all.length,
				shown: picked.length,
				items: picked.map((node, i) => brief(node, i)),
			};
		}
		if (what === "html") {
			const node = selector ? (docAny?.querySelector(selector) ?? null) : (docAny?.documentElement ?? null);
			if (selector && !node) return { error: `选择器没匹上：${selector}` };
			return { html: cut(outerHtmlMasked(node), 20000), selector: selector || null };
		}
		const node = selector ? (docAny?.querySelector(selector) ?? null) : (docAny?.body ?? null);
		if (selector && !node) return { error: `选择器没匹上：${selector}` };
		return { text: node && isPassword(node) ? "" : cut(textOf(node), 12000), selector: selector || null };
	};

	actions["click"] = (args) => {
		const selector = str(args.selector);
		if (!selector) return { error: "click 需要 selector" };
		const node = find(args);
		if (!node) return { error: `选择器没匹上：${selector}` };
		try {
			node.scrollIntoView({ block: "center", inline: "center" });
		} catch {}
		const asButton = node as HTMLElement;
		if (typeof asButton.click === "function") asButton.click();
		else node.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: g as unknown as Window }));
		return { clicked: true, selector, ...brief(node, 0) };
	};

	actions["type"] = (args) => {
		const selector = str(args.selector);
		if (!selector) return { error: "type 需要 selector" };
		const node = find(args);
		if (!node) return { error: `选择器没匹上：${selector}` };
		const text = typeof args.text === "string" ? args.text : "";
		const asInput = node as HTMLElement;
		try {
			asInput.focus();
		} catch {}
		setValue(node, args.clear === false ? `${(node as HTMLInputElement).value ?? ""}${text}` : text);
		if (args.submit === true) {
			for (const type of ["keydown", "keypress", "keyup"]) {
				node.dispatchEvent(
					new KeyboardEvent(type, {
						key: "Enter",
						code: "Enter",
						keyCode: 13,
						which: 13,
						bubbles: true,
						cancelable: true,
					}),
				);
			}
		}
		return {
			typed: true,
			selector,
			...(!isPassword(node) ? { value: (node as HTMLInputElement).value ?? textOf(node) } : {}),
			submitted: args.submit === true,
		};
	};

	actions["scroll"] = (args) => {
		const selector = str(args.selector);
		const win = g as unknown as {
			scrollTo: (x: number, y: number) => void;
			scrollBy: (x: number, y: number) => void;
			scrollX: number;
			scrollY: number;
		};
		if (selector) {
			const node = docAny?.querySelector(selector) ?? null;
			if (!node) return { error: `选择器没匹上：${selector}` };
			try {
				node.scrollIntoView({ block: "center", inline: "nearest" });
			} catch {}
		} else if (args.to && typeof args.to === "object") {
			const to = args.to as { x?: unknown; y?: unknown };
			win.scrollTo(num(to.x, win.scrollX, -1e9, 1e9), num(to.y, win.scrollY, -1e9, 1e9));
		} else if (args.by && typeof args.by === "object") {
			const by = args.by as { x?: unknown; y?: unknown };
			win.scrollBy(num(by.x, 0, -1e9, 1e9), num(by.y, 0, -1e9, 1e9));
		} else {
			return { error: "scroll 需要 selector / to / by 之一" };
		}
		return { scrolled: true, x: Math.round(win.scrollX), y: Math.round(win.scrollY) };
	};

	actions["goto"] = (args) => {
		const url = str(args.url);
		if (!url) return { error: "goto 需要 url" };
		setTimeout(() => {
			try {
				(g as { location?: { href?: string } }).location!.href = url;
			} catch {}
		}, 80);
		return { navigating: true, url };
	};

	actions["wait"] = async (args) => {
		const selector = str(args.selector);
		const text = typeof args.text === "string" ? args.text : "";
		if (!selector && !text) return { error: "wait 需要 selector 或 text" };
		const timeout = num(args.timeoutMs, 5000, 1, 30000);
		const started = Date.now();
		for (;;) {
			if (selector && docAny?.querySelector(selector)) {
				return { found: "selector", selector, waitedMs: Date.now() - started };
			}
			if (text && (docAny?.body ? textOf(docAny.body) : "").includes(text)) {
				return { found: "text", text, waitedMs: Date.now() - started };
			}
			if (Date.now() - started >= timeout) {
				return {
					found: null,
					waitedMs: Date.now() - started,
					note: `等了 ${timeout}ms 还是没出现（selector/text 可能不对，或者这一步需要先点/先输入）`,
				};
			}
			await sleep(100);
		}
	};

	actions["eval"] = async (args) => {
		const code = typeof args.code === "string" ? args.code : "";
		if (!code.trim()) return { error: "eval 需要 code" };
		try {
			const value = await (0, eval)(code);
			return { value: plain(value) };
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return {
				error: `${message}${
					/eval|unsafe-eval|Content Security Policy/i.test(message)
						? "（这个页面通过 CSP 禁了 eval —— 换用 read/click/type 这些动作）"
						: ""
				}`,
			};
		}
	};

	const plain = (value: unknown): unknown => {
		if (value === undefined) return undefined;
		try {
			return JSON.parse(JSON.stringify(value));
		} catch {
			return String(value);
		}
	};

	let badgeHost: HTMLElement | null = null;
	let badgeTimer: ReturnType<typeof setTimeout> | undefined;
	const flashAction = (label: string): void => {
		const root0 = docAny?.documentElement;
		if (!root0) return;
		try {
			if (!badgeHost || !badgeHost.isConnected) {
				docAny?.getElementById("pi-ai-control-badge")?.remove();
				badgeHost = docAny!.createElement("div");
				badgeHost.id = "pi-ai-control-badge";
				badgeHost.style.cssText =
					"position:fixed;right:14px;bottom:14px;z-index:2147483647;pointer-events:none;" +
					"opacity:0;transition:opacity .25s ease";
				const shadow = badgeHost.attachShadow({ mode: "open" });
				const style = docAny!.createElement("style");
				style.textContent =
					".box{font:12px/1.5 -apple-system,'Segoe UI','Microsoft YaHei',sans-serif;" +
					"background:rgba(17,24,39,.94);color:#e5e7eb;padding:7px 11px;border-radius:8px;" +
					"border-left:3px solid #6366f1;box-shadow:0 6px 20px rgba(0,0,0,.35);" +
					"max-width:min(360px,80vw);word-break:break-all}" +
					".t{color:#a5b4fc;font-weight:600;margin-right:6px}" +
					".d{color:#cbd5e1}";
				const box = docAny!.createElement("div");
				box.className = "box";
				const who = docAny!.createElement("span");
				who.className = "t";
				who.textContent = "AI 正在操作本页";
				const detail = docAny!.createElement("span");
				detail.className = "d";
				box.append(who, detail);
				shadow.append(style, box);
				root0.append(badgeHost);
			}
			const detail = badgeHost.shadowRoot?.querySelector<HTMLElement>(".d");
			if (detail) detail.textContent = label;
			badgeHost.style.opacity = "1";
			if (badgeTimer) clearTimeout(badgeTimer);
			badgeTimer = setTimeout(() => {
				if (badgeHost) badgeHost.style.opacity = "0";
			}, 2200);
		} catch {}
	};

	const builtinOps: Record<string, (args: Record<string, unknown>) => unknown> | undefined = control
		? actions
		: undefined;
	let pending = new Map<
		string,
		{ resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
	>();
	let seq = 0;

	let api: BridgePageInternal;
	const onMessage = (e: { data?: unknown }): void => {
		const data = e?.data;
		if (!data || typeof data !== "object") return;
		const msg = data as Record<string, unknown>;
		if (!api || msg.__piBridge !== api.token) return;
		if (msg.kind !== "result") return;
		const id = String(msg.id);
		const entry = pending.get(id);
		if (!entry) return;
		pending.delete(id);
		clearTimeout(entry.timer);
		if (msg.ok === true) entry.resolve(msg.value);
		else entry.reject(new Error(typeof msg.error === "string" && msg.error ? msg.error : "对端调用失败"));
	};

	const listeners = g as {
		addEventListener?(type: string, cb: unknown): void;
		removeEventListener?(type: string, cb: unknown): void;
	};
	listeners.addEventListener?.call(g, "message", onMessage);

	const call = (req: unknown): Promise<unknown> =>
		new Promise((resolve, reject) => {
			const r = (req && typeof req === "object" ? req : {}) as Record<string, unknown>;
			const op = typeof r.op === "string" ? r.op.trim() : "";
			if (!op) {
				reject(new Error("call({ op }) 要带一个操作名"));
				return;
			}
			const rawTimeout = typeof r.timeoutMs === "number" && Number.isFinite(r.timeoutMs) ? r.timeoutMs : 5000;
			const timeout = Math.min(30000, Math.max(1, Math.round(rawTimeout)));
			const id = `c${++seq}`;
			const timer = setTimeout(() => {
				pending.delete(id);
				reject(new Error(`对端在 ${timeout}ms 内没回（op: ${op}）`));
			}, timeout);
			pending.set(id, { resolve, reject, timer });
			try {
				const to = typeof r.to === "string" && r.to.trim() ? r.to.trim() : undefined;
				(g.postMessage as (message: unknown, targetOrigin: string) => void).call(
					g,
					{
						__piBridge: api.token,
						kind: "call",
						id,
						op,
						...(r.args === undefined ? {} : { args: r.args }),
						...(to ? { to } : {}),
						timeoutMs: timeout,
					},
					"*",
				);
			} catch (err) {
				pending.delete(id);
				clearTimeout(timer);
				reject(new Error(`参数发不出去：${err instanceof Error ? err.message : String(err)}（只能传普通数据）`));
			}
		});

	const invoke = async (
		op: unknown,
		args: unknown,
		from: unknown,
		builtin?: unknown,
	): Promise<Record<string, unknown>> => {
		const name = typeof op === "string" ? op.trim() : "";
		if (!name) return { ok: false, error: "缺少操作名（op）", code: "bad-op" };
		if (builtin === true) {
			const fn = builtinOps?.[name];
			if (!fn) {
				return {
					ok: false,
					code: "no-handler",
					error: `不支持的动作 "${name}"（支持：${Object.keys(actions).join("、")}）`,
				};
			}
			const a = (args ?? {}) as Record<string, unknown>;
			const hint = str(a.selector) || str(a.what) || str(a.url) || str(a.text);
			flashAction(hint ? `${name} · ${cut(hint, 60)}` : name);
			try {
				const out = await fn((args ?? {}) as Record<string, unknown>);
				if (out && typeof out === "object" && "error" in (out as Record<string, unknown>)) {
					const err = (out as Record<string, unknown>).error;
					return { ok: false, code: "op-failed", error: typeof err === "string" ? err : "动作失败" };
				}
				return out === undefined ? { ok: true } : { ok: true, value: plain(out) };
			} catch (err) {
				return {
					ok: false,
					code: "op-failed",
					error: `动作 ${name} 抛错：${err instanceof Error ? err.message : String(err)}`,
				};
			}
		}
		const handler = handlers.get(name);
		if (!handler) {
			const known = [...handlers.keys()];
			return {
				ok: false,
				code: "no-handler",
				error: `对端页面没注册 "${name}"${known.length > 0 ? ` —— 它注册了：${known.join("、")}` : " —— 它一个操作都还没注册"}`,
			};
		}
		let value: unknown;
		try {
			value = await handler(args, { from: typeof from === "string" ? from : "" });
		} catch (err) {
			return { ok: false, error: `对端的 "${name}" 抛错：${err instanceof Error ? err.message : String(err)}` };
		}
		if (value !== undefined) {
			try {
				JSON.stringify(value);
			} catch (err) {
				return {
					ok: false,
					error: `"${name}" 的返回值传不回来：${err instanceof Error ? err.message : String(err)}（只能返回普通数据）`,
				};
			}
		}
		return value === undefined ? { ok: true } : { ok: true, value };
	};

	const destroy = (): void => {
		listeners.removeEventListener?.call(g, "message", onMessage);
		try {
			badgeHost?.remove();
			badgeHost = null;
		} catch {}
		const held = pending;
		pending = new Map();
		for (const entry of held.values()) {
			clearTimeout(entry.timer);
			entry.reject(new Error("页面桥已被卸载"));
		}
		handlers.clear();
		if (g.__piBridge === api) delete g.__piBridge;
	};

	api = {
		version: VERSION,
		self,
		peers: peers.slice(),
		token,
		...(builtinOps ? { __builtin: builtinOps } : {}),
		on(op, handler) {
			if (typeof op !== "string" || !op.trim() || typeof handler !== "function") {
				throw new Error("on(op, handler)：op 要是非空字符串、handler 要是函数");
			}
			const name = op.trim();
			handlers.set(name, handler);
			return () => {
				handlers.delete(name);
			};
		},
		off(op) {
			handlers.delete(String(op).trim());
		},
		call,
		__invoke: invoke,
		__destroy: destroy,
	};
	g.__piBridge = api;
	return { ok: true, version: VERSION };
}

export async function invokeBridgeHandler(req?: {
	op?: unknown;
	args?: unknown;
	from?: unknown;
	builtin?: unknown;
}): Promise<{ ok: boolean; value?: unknown; error?: string; code?: string }> {
	const g = globalThis as unknown as Record<string, unknown>;
	const api = g.__piBridge as Partial<BridgePageInternal> | undefined;
	if (!api || typeof api.__invoke !== "function") {
		return { ok: false, code: "no-bridge", error: "对端页面还没装上页面桥（它可能刚导航过）—— 刷新那个页面再试" };
	}
	if (req?.builtin === true && !api.__builtin) {
		return {
			ok: false,
			code: "no-control",
			error: "这个页面没被授权给 AI 操作 —— 在扩展选项页「AI 操作页面」里授权它",
		};
	}
	try {
		const res = (await api.__invoke(req?.op, req?.args, req?.from, req?.builtin)) as
			Record<string, unknown> | undefined;
		if (!res || typeof res !== "object") return { ok: false, error: "对端页面桥返回了意外结果" };
		if (res.ok === true) return res.value === undefined ? { ok: true } : { ok: true, value: res.value };
		return {
			ok: false,
			error: typeof res.error === "string" && res.error ? res.error : "对端调用失败",
			...(typeof res.code === "string" ? { code: res.code } : {}),
		};
	} catch (err) {
		return { ok: false, error: `对端页面桥异常：${err instanceof Error ? err.message : String(err)}` };
	}
}

export function uninstallBridgePage(): { ok: boolean } {
	const g = globalThis as unknown as Record<string, unknown>;
	const api = g.__piBridge as { __destroy?: () => void } | undefined;
	if (api && typeof api.__destroy === "function") {
		try {
			api.__destroy();
		} catch {}
	}
	const doc = (g as { document?: { documentElement?: { removeAttribute?(name: string): void } } }).document;
	try {
		doc?.documentElement?.removeAttribute?.call(doc.documentElement, "data-pi-bridge");
	} catch {}
	return { ok: true };
}
