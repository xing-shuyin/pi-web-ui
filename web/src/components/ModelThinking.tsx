import { memo, useEffect, useRef, useState } from "react";
import { FiCpu, FiZap } from "react-icons/fi";
import type { ModelInfo, ProviderKeyInfo, UiState } from "../types";
import { Dropdown, DropdownItem } from "./Dropdown";
import { useT } from "../i18n";
import { THINKING_VALUES, formatThinkingLevelText } from "../thinking-levels";
import { appSend } from "../app-globals";
import { UniversalModelPicker } from "./UniversalModelPicker";

interface Props {
	state: Pick<UiState, "model" | "thinkingLevel" | "availableThinkingLevels"> | null;
	models: ModelInfo[];
	modelsLoading?: boolean;
	onManageModels?: () => void;
	providerKeys?: Record<string, ProviderKeyInfo[]>;
	defaultModel?: string | null;
	compact?: boolean;
	only?: "model" | "thinking";
	onSelectModel?: (model: ModelInfo) => void;
	onSelectThinking?: (level: string) => void;
	direction?: "up" | "down";
}

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
	const currentModelId = model ? (model.id.includes("/") ? model.id : `${model.provider}/${model.id}`) : null;
	const [modelOpen, setModelOpen] = useState(false);
	const [thinkingOpen, setThinkingOpen] = useState(false);
	const modelScrollRef = useRef<HTMLDivElement>(null);
	const menuRef = useRef<HTMLDivElement>(null);
	const [menuWidth, setMenuWidth] = useState<number | null>(null);
	useEffect(() => {
		if (!modelOpen) {
			setMenuWidth(null);
			return;
		}
		if (models.length === 0) return;
		const id = requestAnimationFrame(() => {
			const el = menuRef.current;
			if (!el) return;
			setMenuWidth(el.offsetWidth);
		});
		return () => cancelAnimationFrame(id);
	}, [modelOpen, models.length]);

	const [reqLoading, setReqLoading] = useState(false);

	const modelIdLower = (model?.id ?? "").toLowerCase();
	const isTokenBudget =
		modelIdLower.includes("claude") ||
		modelIdLower.includes("gemini") ||
		modelIdLower.includes("sonnet") ||
		model?.provider === "anthropic" ||
		model?.provider === "google";

	const isFixedReasoning =
		modelIdLower.includes("r1") || modelIdLower.includes("reasoner") || modelIdLower.includes("qwq");

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

	const requestedRef = useRef(false);
	useEffect(() => {
		if (!modelOpen) {
			requestedRef.current = false;
		}
	}, [modelOpen]);
	useEffect(() => {
		setReqLoading(false);
	}, [models]);

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
