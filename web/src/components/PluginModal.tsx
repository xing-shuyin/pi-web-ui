import type { UiSlotEntry } from "../ui-slots";
import type { LoadedPluginView } from "../plugin-loader";
import { PluginView } from "./PluginView";
import { Modal } from "./Modal";
import { useT } from "../i18n";

interface PluginModalProps {
	entry: UiSlotEntry;
	pluginView?: LoadedPluginView;
	onUiAction?: (item: UiSlotEntry, value?: string) => void;
	onClose: () => void;
}

export function PluginModal({ entry, pluginView, onUiAction, onClose }: PluginModalProps) {
	const t = useT();
	const label = entry.label || entry.id;
	const isView = entry.kind === "view";

	return (
		<Modal className="plugin-modal" title={label} icon={entry.icon} onClose={onClose}>
			<div className="modal-body plugin-modal-body">
				{isView ? (
					pluginView ? (
						<PluginView entry={pluginView} />
					) : (
						<div className="plugin-modal-loading">{t("loading")}</div>
					)
				) : entry.kind === "divider" ? (
					<hr className="plugin-modal-divider" />
				) : (
					<button type="button" className="btn primary plugin-modal-action" onClick={() => onUiAction?.(entry)}>
						{entry.badge ?? label}
					</button>
				)}
			</div>
		</Modal>
	);
}
