import { memo, useEffect, useRef, useState } from "react";
import { FiCpu, FiZap } from "react-icons/fi";
import type { ModelInfo, ProviderKeyInfo, UiState } from "../types";
import { Dropdown, DropdownItem } from "./Dropdown";
import { useT } from "../i18n";
import { THINKING_VALUES, formatThinkingLevelText } from "../thinking-levels";
import { appSend } from "../app-globals";
import { UniversalModelPicker } from "./UniversalModelPicker";

/* 档位清单在 ../thinking-levels.ts（与设置面板「子代理模板」共用一份）。 */

/** Props are deliberately NARROW (no whole-ChatState object): every field is
 *  stable while tokens stream in, so the shallow-compared memo() below keeps
 *  both toolbars idle during streaming. */
interface Props {
	state: Pick<UiState, "model" | "thinkingLevel" | "availableThinkingLevels"> | null;
	models: ModelInfo[];
	modelsLoading?: boolean;
	/** Opens the custom-model config modal (App-level state). */
	onManageModels?: () => void;
	/** Stored API keys per built-in provider (masked) — a provider with several
	 *  keys renders its model list once per key so clicking a model under a key
	 *  switches the active key on the fly (no static model-list copy). */
	providerKeys?: Record<string, ProviderKeyInfo[]>;
	/** 全局默认模型（"provider/id"，null = 未设置，undefined = 功能隐藏
	 *  —— DSH 引擎无此概念，App 侧按 engine 传）。 */
	defaultModel?: string | null;
	/** Compact triggers for narrow toolbars (mobile input row). */
	compact?: boolean;
	/** 只画其中一个 picker（输入框槽位化后模型/思考独立控制显隐；缺省两个都画）。 */
	only?: "model" | "thinking";
	/** 自定义模型选择回调（受控模式：若传则调用，不发送全局 set_model） */
	onSelectModel?: (model: ModelInfo) => void;
	/** 自定义思考档位选择回调（受控模式：若传则调用，不发送全局 set_thinking） */
	onSelectThinking?: (level: string) => void;
	/** 下拉菜单弹出方向（默认 upward，在卡片等上方空间不足时传 "down"） */
	direction?: "up" | "down";
}

/** Model picker + thinking-level picker. Rendered in the composer toolbar
 * inside the input box (ChatInput .composer-tools). Menus open upward because
 * the input bar sits at the bottom of the window. */
export const ModelThinking = memo(function ModelThinking({
	state,
	models,
	modelsLoading,
	onManageModels,
	providerKeys = {},
	defaultModel,
	compact = false,
	only,
	onSelectModel,
	onSelectThinking,
	direction = "up",
}: Props) {
	const t = useT();
	const model = state?.model;
	// snapshot model.id is the bare id; list ids are "provider/id".
	const currentModelId = model ? (model.id.includes("/") ? model.id : `${model.provider}/${model.id}`) : null;
	const [modelOpen, setModelOpen] = useState(false);
	const [thinkingOpen, setThinkingOpen] = useState(false);
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

	// Local loading flag for the model dropdown (list arrives via props.models).
	const [reqLoading, setReqLoading] = useState(false);

	// 判断当前模型是否为 Token 预算型（Claude / Gemini / vLLM）
	const modelIdLower = (model?.id ?? "").toLowerCase();
	const isTokenBudget =
		modelIdLower.includes("claude") ||
		modelIdLower.includes("gemini") ||
		modelIdLower.includes("sonnet") ||
		model?.provider === "anthropic" ||
		model?.provider === "google";

	const isFixedReasoning =
		modelIdLower.includes("r1") || modelIdLower.includes("reasoner") || modelIdLower.includes("qwq");

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
		label: formatThinkingLevelText(v, t(`thinking.${v}`), undefined, isTokenBudget),
		supported: supportedThinking ? supportedThinking.has(v) : true,
	}));

	const [customBudgetInput, setCustomBudgetInput] = useState("");
	const [activeCustomBudget, setActiveCustomBudget] = useState<number | null>(null);

	const handleApplyCustomBudget = () => {
		const num = parseInt(customBudgetInput.trim(), 10);
		if (!Number.isFinite(num) || num <= 0) return;
		setActiveCustomBudget(num);
		const targets: { lvl: string; budget: number }[] = [
			{ lvl: "minimal", budget: 1024 },
			{ lvl: "low", budget: 2048 },
			{ lvl: "medium", budget: 8192 },
			{ lvl: "high", budget: 16384 },
			{ lvl: "xhigh", budget: 32000 },
			{ lvl: "max", budget: 64000 },
		];
		const available = targets.filter((tg) => !supportedThinking || supportedThinking.has(tg.lvl));
		let best = available[0]?.lvl ?? "medium";
		let minDiff = Infinity;
		for (const tg of available) {
			const diff = Math.abs(tg.budget - num);
			if (diff < minDiff) {
				minDiff = diff;
				best = tg.lvl;
			}
		}
		if (onSelectThinking) {
			onSelectThinking(best);
		} else {
			appSend({ type: "set_thinking", level: best });
		}
		setThinkingOpen(false);
	};

	const thinkingLabel = (level: string): string => {
		if (activeCustomBudget && level !== "off") {
			return `${t("thinkingCustomized")} (${activeCustomBudget.toLocaleString()} tokens)`;
		}
		return thinkingLevels.find((l) => l.value === level)?.label ?? level;
	};

	// Lazily fetch the model list when the dropdown opens for the first time.
	// 审查 #4：发不出去（未连接/未装配发送器）立即复位 reqLoading，否则下拉永远
	// 转圈；requestedRef 每次打开只尝试一次 —— 空列表应答到达后靠下方 effect 复位
	// 显示「暂无可用模型」，而不是再次自动重发形成请求循环。
	const requestedRef = useRef(false);
	// 列表获取下沉到 UniversalModelPicker（active 切换时回调 onEnsureModels），
	// 这里只在关闭时复位发送保护，下次打开可再拉取。
	useEffect(() => {
		if (!modelOpen) {
			requestedRef.current = false;
		}
	}, [modelOpen]);
	// 审查 #4 兜底：models 更新到达（哪怕空列表，如 list_models 失败应答）就复位
	// reqLoading，不复位会把「加载中」永久挂住。
	useEffect(() => {
		setReqLoading(false);
	}, [models]);

	// 打开时自动把当前选择的模型滚入可视区域（聚焦选择中的模型）。列表可能
	// 在打开后才到达（首次 list_models 尚未返回），故也监听 models.length。
	useEffect(() => {
		if (!modelOpen) return;
		const el = modelScrollRef.current?.querySelector<HTMLElement>(".dd-item.active");
		el?.scrollIntoView({ block: "nearest" });
	}, [modelOpen, currentModelId, models.length]);

	const modelMenuContent = (
		<UniversalModelPicker
			models={models}
			modelsLoading={modelsLoading}
			providerKeys={providerKeys}
			defaultModel={defaultModel}
			currentModelId={currentModelId}
			active={modelOpen}
			onEnsureModels={() => {
				if (requestedRef.current || models.length > 0 || modelsLoading) return;
				requestedRef.current = true;
				setReqLoading(true);
				if (!appSend({ type: "list_models" })) setReqLoading(false);
			}}
			loading={reqLoading}
			onRefresh={() => {
				setReqLoading(true);
				appSend({ type: "list_models" });
			}}
			onManageModels={
				onManageModels
					? () => {
							setModelOpen(false);
							onManageModels();
						}
					: undefined
			}
			onPickModel={(m, key) => {
				if (onSelectModel) {
					onSelectModel(m);
					setModelOpen(false);
					return;
				}
				// Clicking a model under a non-active key switches to it first,
				// then selects the model (no static model-list copy — the
				// provider's default system catalog is reused as-is).
				if (key && !key.active) {
					appSend({ type: "activate_provider_key", provider: m.provider, keyName: key.name });
				}
				if (currentModelId !== m.id && model?.id !== m.id) {
					appSend({ type: "set_model", modelId: m.id });
				}
				setModelOpen(false);
			}}
			onToggleDefault={(m, isDefault) => {
				if (isDefault) {
					appSend({ type: "clear_default_model" });
				} else {
					appSend({ type: "set_default_model", modelId: m.id });
				}
			}}
			isRowActive={(m, key) =>
				(currentModelId === m.id || model?.id === m.id || `${m.provider}/${m.id}` === currentModelId) &&
				(!key || key.active)
			}
			listRef={modelScrollRef}
		/>
	);

	const thinkingMenuContent = (
		<>
			<div className="dd-header">{t("thinkingLevel")}</div>
			{isFixedReasoning && (
				<div className="dd-item-notice" style={{ padding: "4px 10px", fontSize: "11px", opacity: 0.7 }}>
					🧠 {t("thinkingFixedNotice")}
				</div>
			)}
			{thinkingLevels
				.filter((l) => l.supported)
				.map((l) => (
					<DropdownItem
						key={l.value}
						active={state?.thinkingLevel === l.value && !activeCustomBudget}
						onClick={() => {
							setActiveCustomBudget(null);
							if (onSelectThinking) {
								onSelectThinking(l.value);
								setThinkingOpen(false);
								return;
							}
							if (state?.thinkingLevel !== l.value) {
								appSend({ type: "set_thinking", level: l.value });
							}
							setThinkingOpen(false);
						}}
					>
						{l.label}
					</DropdownItem>
				))}
			{!isFixedReasoning && (
				<div className="dd-custom-token-row">
					<div className="dd-custom-token-label">
						<span>{t("thinkingCustomBudgetTitle")}</span>
					</div>
					<div className="dd-custom-token-group">
						<input
							type="number"
							className="dd-custom-token-input"
							placeholder={t("thinkingCustomBudgetPlaceholder")}
							value={customBudgetInput}
							onChange={(e) => setCustomBudgetInput(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter") {
									handleApplyCustomBudget();
								}
							}}
						/>
						<button type="button" className="dd-custom-token-btn" onClick={handleApplyCustomBudget}>
							{t("thinkingCustomBudgetBtn")}
						</button>
					</div>
				</div>
			)}
		</>
	);

	const modelPicker = (
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
			align="left"
			portal={true}
			menuClassName="dd-menu-model"
			menuRef={menuRef}
			menuStyle={menuWidth != null ? { width: menuWidth } : undefined}
			direction={direction}
		>
			{modelMenuContent}
		</Dropdown>
	);
	const thinkingPicker = (
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
			tip={t("thinkingLevel")}
			open={thinkingOpen}
			onOpenChange={setThinkingOpen}
			align="left"
			portal={true}
			direction={direction}
		>
			{thinkingMenuContent}
		</Dropdown>
	);
	if (only === "model") return modelPicker;
	if (only === "thinking") return thinkingPicker;

	const isThinkingOn = state?.thinkingLevel && state.thinkingLevel !== "off";

	return (
		<div className="model-thinking-capsule">
			<Dropdown
				className="capsule-dropdown capsule-model-dropdown"
				trigger={
					<>
						<FiCpu />
						<span className="capsule-model-name">{model ? model.name : t("selectModel")}</span>
						{!compact && model?.vision && (
							<span className="chip-vision" title={t("vision")}>
								🖼
							</span>
						)}
					</>
				}
				triggerClassName="capsule-segment capsule-model"
				open={modelOpen}
				onOpenChange={setModelOpen}
				align="left"
				portal={true}
				menuClassName="dd-menu-model"
				menuRef={menuRef}
				menuStyle={menuWidth != null ? { width: menuWidth } : undefined}
				direction={direction}
			>
				{modelMenuContent}
			</Dropdown>
			<div className="capsule-divider" />
			<Dropdown
				className="capsule-dropdown capsule-thinking-dropdown"
				trigger={
					<>
						<span className={`thinking-pulse-dot ${isThinkingOn ? "on" : ""}`} />
						<span className="capsule-thinking-text">{state ? thinkingLabel(state.thinkingLevel) : "—"}</span>
					</>
				}
				triggerClassName="capsule-segment capsule-thinking"
				open={thinkingOpen}
				onOpenChange={setThinkingOpen}
				align="left"
				portal={true}
				direction={direction}
			>
				{thinkingMenuContent}
			</Dropdown>
		</div>
	);
});
