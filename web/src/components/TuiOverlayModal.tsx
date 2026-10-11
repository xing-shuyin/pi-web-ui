import { useEffect, useRef, useCallback } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { Modal } from "./Modal";
import { useT } from "../i18n";
import { appSend } from "../app-globals";
import { buildTermTheme } from "../theme";
import { subscribeTuiOverlayRender } from "../tui-overlay-bridge";
import { FiTerminal } from "react-icons/fi";

export interface TuiOverlayModalProps {
	overlay: {
		id: number;
		title?: string;
		cols: number;
		rows: number;
		initialAnsi?: string;
	};
}

export function TuiOverlayModal({ overlay }: TuiOverlayModalProps) {
	const t = useT();
	const containerRef = useRef<HTMLDivElement>(null);
	const termRef = useRef<{ term: Terminal; fit: FitAddon } | null>(null);

	const handleClose = useCallback(() => {
		appSend({ type: "tui_overlay_cancel", id: overlay.id });
	}, [overlay.id]);

	useEffect(() => {
		const container = containerRef.current;
		if (!container) return;

		const term = new Terminal({
			theme: buildTermTheme(),
			fontFamily: '"SF Mono", "JetBrains Mono", ui-monospace, Menlo, Consolas, monospace',
			fontSize: 13,
			cursorBlink: true,
			scrollback: 1000,
			cols: overlay.cols || 80,
			rows: overlay.rows || 24,
		});

		const fit = new FitAddon();
		term.loadAddon(fit);
		term.open(container);
		termRef.current = { term, fit };

		// Initial ANSI content
		if (overlay.initialAnsi) {
			term.write(overlay.initialAnsi);
		}

		// Forward terminal input keystrokes to server
		const dataSub = term.onData((data) => {
			appSend({ type: "tui_overlay_input", id: overlay.id, data });
		});

		// Listen to live render updates from server
		const renderSub = subscribeTuiOverlayRender((id, ansi) => {
			if (id === overlay.id) {
				term.write(ansi);
			}
		});

		// Try fitting container size
		try {
			fit.fit();
			if (term.cols !== overlay.cols || term.rows !== overlay.rows) {
				appSend({
					type: "tui_overlay_resize",
					id: overlay.id,
					cols: term.cols,
					rows: term.rows,
				});
			}
		} catch {
			// ignore fit error before layout settles
		}

		// Resize observer
		const ro = new ResizeObserver(() => {
			try {
				fit.fit();
				if (term.cols && term.rows) {
					appSend({
						type: "tui_overlay_resize",
						id: overlay.id,
						cols: term.cols,
						rows: term.rows,
					});
				}
			} catch {
				// ignore
			}
		});
		ro.observe(container);

		// Auto-focus after open
		const timer = setTimeout(() => {
			term.focus();
		}, 50);

		return () => {
			clearTimeout(timer);
			ro.disconnect();
			dataSub.dispose();
			renderSub();
			term.dispose();
			termRef.current = null;
		};
	}, [overlay.id, overlay.cols, overlay.rows, overlay.initialAnsi]);

	const titleText = overlay.title || t("tuiOverlayTitle");

	return (
		<Modal
			open={true}
			onClose={handleClose}
			title={titleText}
			icon={<FiTerminal />}
			className="tui-overlay-modal"
			closeOnBackdropClick={false}
			closeOnEscape={true}
		>
			<div className="tui-overlay-body">
				<div className="tui-overlay-xterm" ref={containerRef} />
			</div>
		</Modal>
	);
}
