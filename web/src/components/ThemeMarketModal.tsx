import { FiSun, FiX } from "react-icons/fi";
import { useT } from "../i18n";
import { useOverlayZIndex } from "../overlay-stack";
import type { ThemeInfo } from "../theme";
import { CommunityThemesSection } from "./CommunityThemesSection";

export interface ThemeMarketModalProps {
	themes: ThemeInfo[];
	currentTheme: string | null;
	onThemeChange: (id: string | null) => void;
	onReloadThemes: () => void;
	onClose: () => void;
}

export function ThemeMarketModal({
	themes,
	currentTheme,
	onThemeChange,
	onReloadThemes,
	onClose,
}: ThemeMarketModalProps) {
	const t = useT();
	const zIndex = useOverlayZIndex();

	return (
		<div className="modal-backdrop" style={{ zIndex }} onClick={onClose}>
			<div
				className="bg-task-modal"
				style={{ maxWidth: 740, width: "92vw", maxHeight: "84vh", display: "flex", flexDirection: "column" }}
				onClick={(e) => e.stopPropagation()}
			>
				<div className="bg-task-head">
					<span className="bg-task-title">
						<FiSun /> {t("themeMarketTitle")}
					</span>
					<button type="button" className="btn" title={t("close")} onClick={onClose}>
						<FiX />
					</button>
				</div>
				<div style={{ overflowY: "auto", padding: "0 16px 16px", flex: 1 }}>
					<CommunityThemesSection
						themes={themes}
						currentTheme={currentTheme}
						onThemeChange={onThemeChange}
						onReloadThemes={onReloadThemes}
					/>
				</div>
			</div>
		</div>
	);
}
