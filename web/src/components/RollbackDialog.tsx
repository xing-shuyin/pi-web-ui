import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FiAlertTriangle, FiCheck, FiX } from "react-icons/fi";
import { useT } from "../i18n";
import { useEscapeKey } from "../shortcut-stack";
import { closeRollbackDialog, confirmRollback, useRollbackState } from "../rollback-state";

export function RollbackDialog() {
	const t = useT();
	const req = useRollbackState();
	const [restoreWorkspace, setRestoreWorkspace] = useState(true);
	const dialogRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (req) {
			setRestoreWorkspace(true);
		}
	}, [req]);

	useEscapeKey(() => {
		if (req) closeRollbackDialog();
	}, Boolean(req));

	useEffect(() => {
		if (!req) return;
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key !== "Enter" || e.shiftKey || e.ctrlKey || e.metaKey) return;
			const target = e.target as Node | null;
			const inDialog = !target || target === document.body || dialogRef.current?.contains(target);
			if (!inDialog) return;
			e.preventDefault();
			confirmRollback(restoreWorkspace);
		};
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, [req, restoreWorkspace]);

	if (!req) return null;

	return createPortal(
		<div className="modal-backdrop" onClick={closeRollbackDialog}>
			<div
				ref={dialogRef}
				className="tool-info-modal rollback-modal"
				role="dialog"
				aria-modal="true"
				aria-label={t("rollbackSession")}
				onClick={(e) => e.stopPropagation()}
				style={{ maxWidth: 520 }}
			>
				<div className="tool-info-head">
					<span className="tool-info-title" style={{ color: "var(--amber, #f59e0b)" }}>
						<FiAlertTriangle />
						{t("rollbackSession")}
					</span>
					<button type="button" className="btn" title={t("cancel")} onClick={closeRollbackDialog}>
						<FiX />
					</button>
				</div>

				<div className="tool-info-body" style={{ padding: "16px 20px" }}>
					<p style={{ margin: "0 0 16px 0", fontSize: 14, lineHeight: 1.6 }}>{t("rollbackConfirm")}</p>

					<label
						style={{
							display: "flex",
							alignItems: "flex-start",
							gap: 10,
							padding: "12px 14px",
							borderRadius: 8,
							backgroundColor: "var(--bg-elev, rgba(255, 255, 255, 0.04))",
							border: "1px solid var(--border-subtle, rgba(255, 255, 255, 0.1))",
							cursor: "pointer",
							marginBottom: 20,
						}}
						title={t("rollbackRestoreWorkspaceTip")}
					>
						<input
							type="checkbox"
							checked={restoreWorkspace}
							onChange={(e) => setRestoreWorkspace(e.target.checked)}
							style={{ marginTop: 3, cursor: "pointer" }}
						/>
						<div>
							<div style={{ fontWeight: 600, fontSize: 13, color: "var(--text, #e2e8f0)" }}>
								{t("rollbackRestoreWorkspace")}
							</div>
							<div style={{ fontSize: 12, color: "var(--text-dim, #9aa1b4)", marginTop: 2 }}>
								{t("rollbackRestoreWorkspaceTip")}
							</div>
						</div>
					</label>

					<div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
						<button type="button" className="btn" onClick={closeRollbackDialog}>
							{t("cancel")}
						</button>
						<button
							type="button"
							className="btn btn-primary"
							style={{
								display: "inline-flex",
								alignItems: "center",
								gap: 6,
								backgroundColor: "var(--amber, #f59e0b)",
								borderColor: "var(--amber, #f59e0b)",
								color: "#000",
								fontWeight: 600,
							}}
							onClick={() => confirmRollback(restoreWorkspace)}
						>
							<FiCheck />
							{t("confirm")}
						</button>
					</div>
				</div>
			</div>
		</div>,
		document.body,
	);
}
