import type { ReactNode } from "react";
import { HintTip } from "../HintTip";

/** 设置项行布局：左侧标签（可选提示）+ 右侧控件。 */
export function FieldRow({
	label,
	tip,
	htmlFor,
	children,
}: {
	label: string;
	tip?: string;
	htmlFor?: string;
	children: ReactNode;
}) {
	return (
		<div className="set-row set-field-row">
			<label className="set-row-name" htmlFor={htmlFor}>
				{label}
				{tip && <HintTip text={tip} />}
			</label>
			{children}
		</div>
	);
}
