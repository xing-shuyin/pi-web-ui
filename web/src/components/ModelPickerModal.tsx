import { memo, useEffect } from "react";
import { FiX } from "react-icons/fi";
import type { ModelInfo, ProviderKeyInfo } from "../types";
import { useT } from "../i18n";
import { appSend } from "../app-globals";
import { UniversalModelPicker, matchesModelId } from "./UniversalModelPicker";

export interface ModelPickerModalProps {
	open?: boolean;
	currentModelId?: string | null;
	models: ModelInfo[];
	modelsLoading?: boolean;
	providerKeys?: Record<string, ProviderKeyInfo[]>;
	defaultModel?: string | null;
	onManageModels?: () => void;
	onSelect: (modelId: string, model?: ModelInfo) => void;
	onClose: () => void;
	title?: string;
}

export const ModelPickerModal = memo(function ModelPickerModal({
	open = true,
	currentModelId,
	models,
	modelsLoading = false,
	providerKeys = {},
	defaultModel,
	onManageModels,
	onSelect,
	onClose,
	title,
}: ModelPickerModalProps) {
	const t = useT();

	useEffect(() => {
		if (!open) return;
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.preventDefault();
				onClose();
			}
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [open, onClose]);

	if (!open) return null;

	return (
		<div
			className="modal-backdrop"
			style={{ zIndex: 1200, display: "flex", alignItems: "center", justifyContent: "center" }}
			onClick={(e) => {
				if (e.target === e.currentTarget) onClose();
			}}
		>
			<div
				className="modal dd-menu dd-menu-model"
				style={{
					position: "relative",
					top: "auto",
					bottom: "auto",
					left: "auto",
					right: "auto",
					transform: "none",
					width: "min(92vw, 680px)",
					maxWidth: "680px",
					height: "min(84vh, 640px)",
					maxHeight: "86vh",
					padding: 0,
					gap: 0,
					display: "flex",
					flexDirection: "column",
					overflow: "hidden",
					boxShadow: "0 24px 64px rgba(0, 0, 0, 0.55)",
					background: "var(--bg-elev2, #1b1b24)",
					borderRadius: "12px",
					border: "1px solid var(--border)",
				}}
			>
				<div
					className="dd-header dd-header-flex"
					style={{ padding: "10px 14px", borderBottom: "1px solid var(--border, #333)" }}
				>
					<span className="dd-header-title" style={{ fontWeight: 600 }}>
						{title || t("availableModels")}
					</span>
					<div className="dd-header-actions" style={{ marginLeft: "auto" }}>
						<button
							type="button"
							className="ghost dd-header-btn"
							style={{ border: 0, cursor: "pointer", fontSize: 16 }}
							onClick={onClose}
							title="关闭"
						>
							<FiX />
						</button>
					</div>
				</div>

				<UniversalModelPicker
					models={models}
					modelsLoading={modelsLoading}
					providerKeys={providerKeys}
					defaultModel={defaultModel}
					currentModelId={currentModelId}
					active={open}
					onEnsureModels={() => {
						if (models.length === 0 && !modelsLoading) {
							appSend({ type: "list_models" });
						}
					}}
					onRefresh={() => appSend({ type: "list_models" })}
					onManageModels={onManageModels}
					onPickModel={(m) => {
						onSelect(m.id, m);
						onClose();
					}}
					isRowActive={(m) => matchesModelId(m, currentModelId)}
					autoFocusSearch
					hideTitle
					bodyStyle={{ flex: 1, minHeight: 0 }}
					scrollStyle={{ flex: "1 1 auto", minHeight: 0, minWidth: 0, maxHeight: "none", overflowY: "auto" }}
				/>
			</div>
		</div>
	);
});
