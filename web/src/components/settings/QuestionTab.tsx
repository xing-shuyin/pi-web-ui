import { FiHelpCircle } from "react-icons/fi";
import { useT } from "../../i18n";
import { ToggleRow } from "./ToggleRow";

/** 设置页「交互式问卷」Tab。 */
export function QuestionTab({
	questionnaireEnabled,
	onToggle,
}: {
	questionnaireEnabled: boolean;
	onToggle: () => void;
}) {
	const t = useT();
	return (
		<div className="set-section">
			<div className="set-section-title">
				<FiHelpCircle className="set-section-icon" />
				{t("settingsQuestionnaire")}
			</div>
			<ToggleRow
				title={t("questionnaireEnabled")}
				tip={`${t("questionnaireEnabledDesc")}\n${t("questionnaireOffHint")}`}
				enabled={questionnaireEnabled}
				onToggle={onToggle}
			/>
		</div>
	);
}
