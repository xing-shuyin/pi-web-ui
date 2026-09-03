import { memo, useEffect, useMemo, useRef, useState } from "react";
import { FiCpu, FiSearch, FiZap } from "react-icons/fi";
import type { ModelInfo, ProviderKeyInfo, UiState } from "../types";
import { Dropdown, DropdownItem } from "./Dropdown";
import { useT } from "../i18n";
import { loadModelUsage, sortByUsage } from "../model-usage";

/** Messages this component sends (a subset shared by TopBar and ChatInput). */
export type ModelThinkingMsg =
	| { type: "list_models" }
	| { type: "set_model"; modelId: string }
	| { type: "set_thinking"; level: string }
	| { type: "activate_provider_key"; provider: string; keyName: string };

const THINKING_VALUES = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** Props are deliberately NARROW (no whole-ChatState object): every field is
 *  stable while tokens stream in, so the shallow-compared memo() below keeps
 *  both toolbars idle during streaming. */
interface Props {
	state: Pick<UiState, "model" | "thinkingLevel" | "availableThinkingLevels"> | null;
	models: ModelInfo[];
	modelsLoading: boolean;
	send: (msg: ModelThinkingMsg) => boolean;
	/** Opens the custom-model config modal (App-level state). */
	onManageModels: () => void;
	/** Stored API keys per built-in provider (masked) — a provider with several
	 *  keys renders its model list once per key so clicking a model under a key
	 *  switches the active key on the fly (no static model-list copy). */
	providerKeys: Record<string, ProviderKeyInfo[]>;
	/** Compact triggers for narrow toolbars (mobile input row). */
	compact?: boolean;
}

/** Model picker + thinking-level picker. Rendered in the composer toolbar
 * inside the input box (ChatInput .composer-tools). Menus open upward because
 * the input bar sits at the bottom of the window. */
export const ModelThinking = memo(function ModelThinking({
	state,
	models,
	modelsLoading,
	send,
	onManageModels,
	providerKeys,
	compact = false,
}: Props) {
	const t = useT();
	const model = state?.model;
	// snapshot model.id is the bare id; list ids are "provider/id".
	const currentModelId = model ? `${model.provider}/${model.id}` : null;
	const [modelOpen, setModelOpen] = useState(false);
	const [thinkingOpen, setThinkingOpen] = useState(false);
	// Model dropdown filter — the list can be long (all providers × models),
	// so a type-to-filter box sits above it, plus a provider sidebar on the
	// left that narrows the list to one service. Reset both when the dropdown
	// closes.
	const [modelFilter, setModelFilter] = useState("");
	const [providerFilter, setProviderFilter] = useState<{ provider: string; keyName: string | null } | null>(null);
	// 使用次数（模型下拉按此排序）：每次打开时重新读取 localStorage，保证最新。
	const [usage, setUsage] = useState<Record<string, number>>({});
	// 模型列表滚动容器（打开时自动聚焦当前选择的模型）。
	const modelScrollRef = useRef<HTMLDivElement>(null);
	// 弹窗宽度锁定：打开时测量一次内容自然宽度（最宽需要），之后搜索/筛选
	// 内容变窄也不再回缩，避免弹窗来回变化。关闭时复位，下次打开重新测量。
	const menuRef = useRef<HTMLDivElement>(null);
	const [menuWidth, setMenuWidth] = useState<number | null>(null);
	useEffect(() => {
		if (!modelOpen) {
			setMenuWidth(null);
			return;
		}
		// 列表未就绪时先不锁定（保持自然宽度），等列表到达后再测量锁定。
		if (models.length === 0) return;
		const id = requestAnimationFrame(() => {
			const el = menuRef.current;
			if (!el) return;
			setMenuWidth(el.offsetWidth);
		});
		return () => cancelAnimationFrame(id);
	}, [modelOpen, models.length]);
	useEffect(() => {
		if (modelOpen) setUsage(loadModelUsage());
	}, [modelOpen]);
	useEffect(() => {
		if (!modelOpen) {
			setModelFilter("");
			setProviderFilter(null);
		}
	}, [modelOpen]);
	// Sidebar filter entries (sorted by provider name). A provider with several
	// stored keys yields ONE entry per key (shown as the provider name with the key
	// name under it), so picking an entry narrows to that provider AND that key;
	// a single-key/keyless provider yields one plain entry. `count` is the provider's
	// model count (keys never change the catalog, so every key entry shows the same).
	const providerEntries = useMemo(() => {
		const counts = new Map<string, number>();
		for (const m of models) counts.set(m.provider, (counts.get(m.provider) ?? 0) + 1);
		const entries: { provider: string; keyName: string | null; count: number }[] = [];
		for (const [name, count] of [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
			const keys = providerKeys[name];
			if (keys && keys.length > 1) {
				for (const k of keys) entries.push({ provider: name, keyName: k.name, count });
			} else {
				entries.push({ provider: name, keyName: null, count });
			}
		}
		return entries;
	}, [models, providerKeys]);
	// 按使用次数降序（次数相同保持原有顺序，不重排未用过的模型）。
	const sortedModels = useMemo(() => sortByUsage(models, usage), [models, usage]);
	const filteredModels = useMemo(() => {
		let list = sortedModels;
		if (providerFilter) list = list.filter((m) => m.provider === providerFilter.provider);
		const q = modelFilter.trim().toLowerCase();
		if (!q) return list;
		return list.filter(
			(m) => m.name.toLowerCase().includes(q) || m.provider.toLowerCase().includes(q) || m.id.toLowerCase().includes(q),
		);
	}, [sortedModels, modelFilter, providerFilter]);
	// Each model renders ONCE. A multi-key provider is shown under whichever key
	// entry is selected in the sidebar (or, in the "all"/single-key views, under the
	// provider's ACTIVE key) so a click routes through exactly one key — no per-key
	// duplication of the model list. The model entries are the SAME (provider's
	// default system catalog); the key only drives which credential is used.
	const displayRows = useMemo(() => {
		const rows: { model: ModelInfo; key: ProviderKeyInfo | null }[] = [];
		for (const m of filteredModels) {
			const keys = providerKeys[m.provider];
			if (!keys || keys.length <= 1) {
				rows.push({ model: m, key: null });
				continue;
			}
			// Narrowed key (if this provider's specific key entry is selected),
			// else the provider's currently-active key.
			let key = keys.find((k) => k.active) ?? keys[0];
			if (providerFilter?.provider === m.provider && providerFilter.keyName) {
				const sel = keys.find((k) => k.name === providerFilter.keyName);
				if (sel) key = sel;
			}
			rows.push({ model: m, key });
		}
		return rows;
	}, [filteredModels, providerKeys, providerFilter]);
	// Local loading flag for the model dropdown (list arrives via props.models).
	const [reqLoading, setReqLoading] = useState(false);

	// Model-supported thinking levels (snapshot). The SDK clamps any request
	// outside this set — unsupported levels must be disabled, not silently
	// snapped (that's what made the level look "impossible to change").
	// Empty/absent → unknown, keep everything enabled.
	const supportedThinking =
		state?.availableThinkingLevels && state.availableThinkingLevels.length > 0
			? new Set(state.availableThinkingLevels)
			: null;
	const thinkingLevels: {
		value: string;
		label: string;
		supported: boolean;
	}[] = THINKING_VALUES.map((v) => ({
		value: v,
		label: t(`thinking.${v}`),
		supported: supportedThinking ? supportedThinking.has(v) : true,
	}));
	const thinkingLabel = (level: string): string => thinkingLevels.find((l) => l.value === level)?.label ?? level;

	// Lazily fetch the model list when the dropdown opens for the first time.
	useEffect(() => {
		if (modelOpen && models.length === 0 && !reqLoading && !modelsLoading) {
			setReqLoading(true);
			send({ type: "list_models" });
		}
	}, [modelOpen, models.length, reqLoading, modelsLoading, send]);
	useEffect(() => {
		if (models.length > 0) setReqLoading(false);
	}, [models.length]);

	// 打开时自动把当前选择的模型滚入可视区域（聚焦选择中的模型）。列表可能
	// 在打开后才到达（首次 list_models 尚未返回），故也监听 models.length。
	useEffect(() => {
		if (!modelOpen) return;
		const el = modelScrollRef.current?.querySelector<HTMLElement>(".dd-item.active");
		el?.scrollIntoView({ block: "nearest" });
	}, [modelOpen, currentModelId, models.length]);

	return (
		<>
			<Dropdown
				trigger={
					<>
						<FiCpu />
						<span className="chip-model">{model ? model.name : t("selectModel")}</span>
						{!compact && model?.vision && (
							<span className="chip-vision" title={t("vision")}>
								🖼
							</span>
						)}
						{!compact && model && <span className="chip-sub">{model.provider}</span>}
					</>
				}
				open={modelOpen}
				onOpenChange={setModelOpen}
				menuClassName="dd-menu-model"
				menuRef={menuRef}
				menuStyle={menuWidth != null ? { width: menuWidth } : undefined}
				direction="up"
			>
				<div className="dd-header">{t("availableModels")}</div>
				<div className="dd-search-row">
					<FiSearch />
					<input
						className="dd-search"
						type="text"
						placeholder={t("searchModels")}
						value={modelFilter}
						onChange={(e) => setModelFilter(e.target.value)}
					/>
				</div>
				{/* Scrollable middle band — provider sidebar (left) + model list
				    (right). The header/search above and footer below stay fixed. */}
				<div className="dd-model-body">
					{providerEntries.length > 1 && (
						<div className="dd-provider-col">
							<div className="dd-provider-head">{t("providers")}</div>
							<button
								type="button"
								className={`dd-provider-item ${providerFilter === null ? "active" : ""}`}
								onClick={() => setProviderFilter(null)}
							>
								<span>{t("allProviders")}</span>
							</button>
							{providerEntries.map((entry) => {
								const active = providerFilter?.provider === entry.provider && providerFilter?.keyName === entry.keyName;
								return (
									<button
										type="button"
										key={entry.keyName ? `${entry.provider}::${entry.keyName}` : entry.provider}
										className={`dd-provider-item ${active ? "active" : ""}`}
										onClick={() =>
											setProviderFilter(active ? null : { provider: entry.provider, keyName: entry.keyName })
										}
										title={
											entry.keyName ? `${entry.provider} · ${entry.keyName}` : `${entry.provider} · ${entry.count}`
										}
									>
										<span className="dd-provider-txt">
											<span className="dd-provider-name">{entry.provider}</span>
											{entry.keyName && <span className="dd-provider-key">{entry.keyName}</span>}
										</span>
										<span className="dd-provider-count">{entry.count}</span>
									</button>
								);
							})}
						</div>
					)}
					<div className="dd-model-scroll" ref={modelScrollRef}>
						{(reqLoading || modelsLoading) && <div className="dd-loading">{t("loading")}</div>}
						{models.length === 0 && !reqLoading && !modelsLoading && <div className="dd-loading">{t("noModels")}</div>}
						{filteredModels.length === 0 && models.length > 0 && (
							<div className="dd-loading">{t("noModelMatches")}</div>
						)}
						{displayRows.map((row) => {
							const m = row.model;
							const isActive = currentModelId === m.id && (!row.key || row.key.active);
							return (
								<DropdownItem
									key={row.key ? `${m.id}::${row.key.name}` : m.id}
									active={isActive}
									onClick={() => {
										// Clicking a model under a non-active key switches to it first,
										// then selects the model (no static model-list copy — the
										// provider's default system catalog is reused as-is).
										if (row.key && !row.key.active) {
											send({ type: "activate_provider_key", provider: m.provider, keyName: row.key.name });
										}
										if (currentModelId !== m.id) {
											send({ type: "set_model", modelId: m.id });
										}
										setModelOpen(false);
									}}
								>
									<span className="dd-model-cell">
										<span className="dd-model-name">{m.name}</span>
										<span className="dd-model-meta">
											<span className="dd-model-provider">{m.provider}</span>
											{row.key && (
												<span className={`dd-model-key ${row.key.active ? "active" : ""}`}>
													{row.key.active ? "●" : "○"} {row.key.name}
												</span>
											)}
											{(usage[m.id] ?? 0) > 0 && (
												<span className="dd-model-usage">{t("modelUsedCount", { n: usage[m.id] })}</span>
											)}
											{(m.reasoning || m.vision) && (
												<span className="dd-model-badges">
													{m.reasoning && <span className="dd-model-badge">{t("reasoning")}</span>}
													{m.vision && <span className="dd-model-badge">{t("vision")}</span>}
												</span>
											)}
										</span>
									</span>
								</DropdownItem>
							);
						})}
					</div>
				</div>
				{/* Fixed footer — refresh / manage never scroll away. */}
				<div className="dd-footer">
					<button type="button" className="dd-refresh" onClick={() => send({ type: "list_models" })}>
						{t("refreshModels")}
					</button>
					<button
						type="button"
						className="dd-refresh"
						onClick={() => {
							setModelOpen(false);
							onManageModels();
						}}
					>
						{t("manageModels")}
					</button>
				</div>
			</Dropdown>

			<Dropdown
				trigger={
					<>
						<FiZap />
						<span className="chip-sub">
							{t("thinkingChip", {
								level: state ? thinkingLabel(state.thinkingLevel) : "—",
							})}
						</span>
					</>
				}
				open={thinkingOpen}
				onOpenChange={setThinkingOpen}
				direction="up"
			>
				<div className="dd-header">{t("thinkingLevel")}</div>
				{thinkingLevels.map((l) => (
					<DropdownItem
						key={l.value}
						active={state?.thinkingLevel === l.value}
						disabled={!l.supported}
						title={l.supported ? undefined : t("thinkingUnsupported")}
						onClick={() => {
							if (state?.thinkingLevel !== l.value) {
								send({ type: "set_thinking", level: l.value });
							}
							setThinkingOpen(false);
						}}
					>
						{l.label}
					</DropdownItem>
				))}
			</Dropdown>
		</>
	);
});
