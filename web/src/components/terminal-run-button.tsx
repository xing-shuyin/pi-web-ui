import { memo, useCallback, useEffect, useRef, useState } from "react";
import { FiCheck, FiTerminal } from "react-icons/fi";
import { useT } from "../i18n";
import { runInTerminal } from "../terminal-run";

interface RunInTerminalButtonProps {
	code: string;
	title?: string;
}

export const RunInTerminalButton = memo(function RunInTerminalButton({ code, title }: RunInTerminalButtonProps) {
	const t = useT();
	const [executed, setExecuted] = useState(false);
	const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	useEffect(() => {
		return () => {
			if (timerRef.current) clearTimeout(timerRef.current);
		};
	}, []);

	const handleRun = useCallback(() => {
		const ok = runInTerminal(code, title);
		if (ok) {
			setExecuted(true);
			if (timerRef.current) clearTimeout(timerRef.current);
			timerRef.current = setTimeout(() => {
				setExecuted(false);
				timerRef.current = null;
			}, 1200);
		}
	}, [code, title]);

	if (!code || !code.trim()) return null;

	return (
		<button
			type="button"
			className="term-run-btn"
			title={executed ? t("executedInTerminal") : t("runInTerminal")}
			aria-label={t("runInTerminal")}
			onClick={handleRun}
		>
			{executed ? <FiCheck /> : <FiTerminal />}
		</button>
	);
});
