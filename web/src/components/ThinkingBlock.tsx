import { useState } from "react";
import { FiChevronDown, FiChevronRight, FiCpu } from "react-icons/fi";
import { useT } from "../i18n";

interface ThinkingBlockProps {
	thinking: string;
	/** True while the assistant is still streaming this thinking block. */
	streaming?: boolean;
	/** 设置面板「完整显示思考」开关：true（开）→ 思考始终完整展开并自动换行
	 *  （流式推理过程也实时可见）；false（关）→ 折叠成一行摘要，流式中一行
	 *  实时显示最新文本。 */
	wrap?: boolean;
	/** 会话内搜索打开时强制展开（折叠内容不在 DOM，搜索索引搜到的词会
	 *  “展开后看不到”）。不改变用户的 open 状态，关闭搜索自动恢复。 */
	forceOpen?: boolean;
}

export function ThinkingBlock({ thinking, streaming, wrap = true, forceOpen = false }: ThinkingBlockProps) {
	const t = useT();
	// null = 未手动点过 → 跟随开关：wrap=true（开）→ 完整展开；wrap=false（关）→ 折叠。
	// 流式与结束后行为一致——不再出现「流式折叠、结束后又自动展开」的跳动。
	const [open, setOpen] = useState<boolean | null>(null);
	const expanded = open ?? wrap;
	// 搜索期间 forceOpen 只是“视口展开”，用户 open 状态不受影响
	const shown = expanded || forceOpen;
	// 折叠预览：流式中取最新文本（实时尾巴），结束后取开头一行。
	const preview = streaming ? thinking.trimEnd().slice(-80) : thinking.split("\n")[0].slice(0, 80);

	return (
		<div className={`thinking ${shown ? "open" : ""} ${streaming ? "live" : ""}`}>
			<button type="button" className="thinking-toggle" onClick={() => setOpen(!expanded)}>
				{shown ? <FiChevronDown /> : <FiChevronRight />}
				<FiCpu className="thinking-icon" />
				<span className="thinking-label">
					{streaming && shown ? (
						<span className="thinking-live-label">
							{t("thinkingNow")}
							<span className="dots" />
						</span>
					) : shown ? (
						t("thinking")
					) : (
						t("thinkingPreview", { preview })
					)}
				</span>
			</button>
			{shown && <div className="thinking-body">{thinking}</div>}
		</div>
	);
}
