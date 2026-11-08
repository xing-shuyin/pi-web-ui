import { homedir } from "node:os";
import { formatBadge, formatHint, providerFromModel, resolveActiveProvider } from "./badge.mjs";
import { collectActive, isBalanceSource, toText } from "./providers/index.mjs";

const CACHE_DEFAULT_MINUTES = 5;
/**
 * 余额型来源的缓存时长：60 秒。
 *
 * 订阅窗口是「5 小时 / 每周」量级的数字，5 分钟缓存完全够用；余额是「每发一次请求就变」的现金流，
 * 5 分钟太钝 —— 用户看到的就是「更新太不及时」。分档而不是一律调短：订阅型接口有频控，没必要跟着出网。
 */
const BALANCE_TTL_MS = 60_000;
const SUMMARY_PATH = "/summary";
/** 缓存预热节拍：cron 每分钟叫一次，但只有缓存过期才真出网（底栏由客户端按同一份缓存渲染）。 */
const REFRESH_CRON = "* * * * *";

/**
 * @param {Record<string, unknown>} settings
 */
function cacheMinutes(settings) {
	const raw = Number(settings?.refreshMinutes);
	if (!Number.isFinite(raw) || raw <= 0) return CACHE_DEFAULT_MINUTES;
	return Math.min(120, Math.max(1, raw));
}

/**
 * @param {unknown} snap
 */
function modelOf(snap) {
	const record = /** @type {any} */ (snap);
	if (!record || typeof record !== "object") return "";
	return String(record.model ?? record.modelId ?? "");
}

/** 空快照：认不出当前供应商时既不出网，也不显示。 */
function emptySnapshot() {
	return { providers: [], updatedAt: new Date().toISOString() };
}

export default {
	activate(host) {
		const state = {
			/** @type {any} */
			snapshot: null,
			cachedAt: 0,
			/** 这份快照属于哪家供应商 —— 换模型就必须重取，不能拿别家的数字糊弄。 */
			cachedId: "",
			/**
			 * 上次**成功**读到的供应商记录（{ id, at, provider }）。
			 * 查询失败时拿它把余额/窗口补回来并标记 stale：宁可标「这是旧的」，也不要抹掉数字让人以为余额清零。
			 * @type {{ id: string, at: string, provider: any } | null}
			 */
			lastGood: null,
			/** @type {{ id: string, promise: Promise<any> } | null} */
			inflight: null,
			model: "",
		};

		const settings = () => host.getSettings?.() ?? {};
		const isZh = () => {
			try {
				const lang = (host.getSettings?.() ?? {}).lang ?? process.env.LANG ?? "";
				return /^zh/i.test(String(lang)) || !lang;
			} catch {
				return true;
			}
		};

		/** 从宿主读一次当前会话的模型（只在初始 / 切对话时用，别在每个请求里覆写）。 */
		const readModel = () => {
			try {
				return modelOf(host.getActiveConversation?.());
			} catch {
				return "";
			}
		};

		/** 当前供应商 id（空 = 这个模型没有对应的额度来源）。 */
		const activeId = () => {
			// 只在「还没有模型」时回读宿主：已知的模型以 onClientModelChanged 的广播为准，
			// 不能用 getActiveConversation() 去覆写它——那个快照可能晚一拍，会把刚切的模型改回去
			if (!state.model) state.model = readModel();
			return providerFromModel(state.model);
		};

		/**
		 * 当前供应商的缓存时长：余额型 60 秒（可短）、订阅型按设置里的分钟数。
		 * @param {string} id
		 */
		const ttlMsFor = (id) => (isBalanceSource(id) ? BALANCE_TTL_MS : cacheMinutes(settings()) * 60_000);

		/**
		 * 失败时把「上次成功读到的数字」带回来，并且只带数字 —— 状态仍是失败，
		 * 所以底栏徽标不会伪造一个健康的数，卡片则可以诚实地说「上次成功 X 前」。
		 * @param {any} snapshot
		 * @param {string} id
		 */
		function withLastGood(snapshot, id) {
			const provider = Array.isArray(snapshot?.providers) ? snapshot.providers[0] : null;
			if (!provider) return snapshot;
			const healthy = provider.status === "ok" || provider.status === "empty" || provider.status === "signed-out";
			if (healthy) {
				state.lastGood = { id, at: String(snapshot.updatedAt ?? ""), provider };
				return snapshot;
			}
			const good = state.lastGood && state.lastGood.id === id ? state.lastGood : null;
			if (!good) return snapshot;
			const carried = {
				...provider,
				plan: provider.plan || good.provider.plan,
				account: provider.account || good.provider.account,
				balance: provider.balance ?? good.provider.balance ?? null,
				windows: provider.windows?.length ? provider.windows : (good.provider.windows ?? []),
				extra: provider.extra?.length ? provider.extra : (good.provider.extra ?? []),
				stale: true,
				staleSince: good.at,
			};
			return { ...snapshot, providers: [carried] };
		}

		/**
		 * 取一份「当前供应商」的快照。换供应商 / 缓存过期 / force 才真出网。
		 * @param {boolean} force
		 */
		function load(force = false) {
			const id = activeId();
			if (!id) return Promise.resolve(emptySnapshot());
			const ttl = ttlMsFor(id);
			if (!force && state.snapshot && state.cachedId === id && Date.now() - state.cachedAt < ttl) {
				return Promise.resolve(state.snapshot);
			}
			if (state.inflight && state.inflight.id === id) return state.inflight.promise;
			const promise = collectActive({ host, settings: settings(), home: homedir(), id })
				.then((snapshot) => {
					const merged = withLastGood(snapshot, id);
					state.snapshot = merged;
					state.cachedId = id;
					state.cachedAt = Date.now();
					return merged;
				})
				.finally(() => {
					if (state.inflight?.promise === promise) state.inflight = null;
				});
			state.inflight = { id, promise };
			return promise;
		}

		/**
		 * 底栏那段文本（由客户端通过 `host.setFooterStatus` 交给宿主内置条目 `host:quota`）。
		 * 服务端只算文本，不碰 UI —— 位置与样式归宿主。
		 * 认不出当前供应商时 text 为空，客户端据此把槽清掉（底栏不留残片）。
		 * @returns {{ text: string, tip: string }}
		 */
		function footerPayload(snapshot, id) {
			const zh = isZh();
			const { label, badge } = formatBadge(snapshot, id, zh);
			return { text: `${label} ${badge}`.trim(), tip: formatHint(snapshot, id, zh) };
		}

		/**
		 * 拉一次数据（客户端轮询 / 打开看板时走同一份缓存）。
		 * @param {boolean} force
		 */
		function refresh(force) {
			return load(force).catch((error) => {
				host.log?.("warn", "[quota-watch] 刷新失败：", error instanceof Error ? error.message : String(error));
			});
		}

		/**
		 * `/summary` 的完整载荷：一份快照 + 「它有多旧」的元数据。
		 * 客户端拿这一份同时画底栏与浮层 —— 两个视图不会各持一个时间戳。
		 * @param {any} snapshot
		 */
		function buildPayload(snapshot) {
			const activeProvider = resolveActiveProvider(state.model, snapshot);
			const updatedAt = String(snapshot?.updatedAt ?? "");
			const parsed = Date.parse(updatedAt);
			const ttlMs = activeProvider ? ttlMsFor(activeProvider) : BALANCE_TTL_MS;
			return {
				ok: true,
				...snapshot,
				activeProvider,
				activeModel: state.model,
				updatedAt,
				staleMs: Number.isFinite(parsed) ? Math.max(0, Date.now() - parsed) : 0,
				ttlMs,
				refreshSeconds: Math.round(ttlMs / 1000),
				lastGoodAt: state.lastGood?.id === activeProvider ? state.lastGood.at : "",
				footer: footerPayload(snapshot, activeProvider),
			};
		}

		const offRoute = host.route("GET", SUMMARY_PATH, (req, res) => {
			const force = String(req?.query?.force ?? "") === "1";
			void load(force)
				.then((snapshot) => {
					// activeProvider 从「正在渲染的这份快照 + 当前模型」现算：
					// 模型刚换、快照还是上一家的那一瞬，宁可空着也不冒充
					res.json(buildPayload(snapshot));
				})
				.catch((error) => {
					host.log?.("error", "[quota-watch] 采集失败：", error instanceof Error ? error.message : String(error));
					res.status(502).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
				});
		});

		/** 模型变了 → 按新供应商重取（同一家的不同型号共用一份缓存，不为了型号名多打一次厂商接口）。 */
		const offModel =
			host.onClientModelChanged?.((snap) => {
				const model = modelOf(snap);
				if (!model) return;
				const before = activeId();
				state.model = model;
				void refresh(providerFromModel(model) !== before);
			}) ?? (() => {});

		const offConversation =
			host.onConversationChanged?.(() => {
				// 切对话可能换了供应商；这里才是重新读宿主的时机（读到的已是新对话的快照）
				const before = providerFromModel(state.model);
				const model = readModel();
				if (model) state.model = model;
				if (providerFromModel(state.model) !== before) void refresh(true);
			}) ?? (() => {});

		const offSettings = host.onSettingsChanged?.(() => {
			state.snapshot = null;
			state.cachedAt = 0;
			state.cachedId = "";
			void refresh(true);
		});

		const offCron = host.schedule?.(REFRESH_CRON, () => void refresh(false)) ?? (() => {});

		const offTool = host.registerAgentTool?.({
			name: "quota_status",
			label: "订阅额度",
			description:
				"Report the remaining quota of the provider serving the user's current model (Claude Code, " +
				"Codex or DeepSeek): per-window remaining percentage, reset time and account balance, read from local CLI " +
				"logins. Only that one provider is queried — other subscriptions on this machine are intentionally ignored. " +
				"Use it before starting long autonomous runs or when the user asks how much quota is left.",
			promptSnippet: "check the remaining quota of the current model's provider",
			promptGuidelines: [
				"Call action=status when the user asks about remaining quota, rate limits or reset times",
				"Do not echo credentials or account emails back unless the user explicitly asks for the account",
				"A window showing 100% remaining is unspent, not an error; a status of signed-out means that platform is simply not logged in",
				"Only the provider behind the current model is covered; say so if the user asks about other subscriptions",
			],
			parameters: {
				type: "object",
				properties: {
					action: { type: "string", enum: ["status"], description: "Only 'status' is supported." },
					refresh: { type: "boolean", description: "Bypass the cache and query the vendor again." },
				},
				required: ["action"],
			},
			async execute(_toolCallId, params) {
				const force = params && typeof params === "object" ? params.refresh === true : false;
				const snapshot = await load(force);
				return toText(snapshot);
			},
		});

		// 预热缓存：先拿一次当前模型，再按当前供应商取一次数据（成功则客户端一挂载就能拿到 footer 文本）
		state.model = readModel();
		void refresh(false);
		host.log?.("info", "[quota-watch] 额度看板已激活（只查当前供应商，底栏走宿主内置槽 host:quota）");

		return () => {
			offRoute?.();
			offModel?.();
			offConversation?.();
			offSettings?.();
			offCron?.();
			offTool?.();
		};
	},
};
