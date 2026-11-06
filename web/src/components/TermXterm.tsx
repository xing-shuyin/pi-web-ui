import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type { CommandDef } from "../types";
import { buildTermTheme, THEME_CHANGE_EVENT } from "../theme";
import { shouldStartTouchScroll, touchWheelDeltaY } from "../term-touch";
import { useI18n } from "../i18n";
import { appSend } from "../app-globals";
import type { TerminalOwnerKind } from "../terminal-bridge";

function stripExitBanner(data: string): { clean: string; exitCode: number | null } {
	let exitCode: number | null = null;
	const clean = data
		.replace(/\r?\n?\[pi-term-exit:(-?\d+)\]\r?\n?/g, (_, c: string) => {
			exitCode = Number(c);
			return "\r\n";
		})
		.replace(/\r?\n?\x1b\[90m\[(?:进程已退出，退出码 |Process exited with code )-?\d+\]\x1b\[0m\r?\n?/g, "\r\n");
	return { clean, exitCode };
}

export interface TermXtermHandle {
	focus(): void;
}

interface TermXtermProps {
	conversationId: string;
	terminalId: string;
	command?: CommandDef;
	cwd: string;
	title?: string;
	agentBash?: boolean;
	ownerKind?: TerminalOwnerKind;
	active: boolean;
	onReady?: (handle: TermXtermHandle | null) => void;
	running?: boolean;
	exitCode?: number | null;
	register: (
		conversationId: string,
		id: string,
		writer: { write(data: string): void; dispose(): void; reset?(): void },
		ownerKind?: TerminalOwnerKind,
	) => () => void;
}

export function TermXterm({
	conversationId,
	terminalId,
	ownerKind = "client",
	active,
	running,
	exitCode,
	register,
	onReady,
}: TermXtermProps) {
	const containerRef = useRef<HTMLDivElement>(null);
	const termRef = useRef<{ term: Terminal; fit: FitAddon } | null>(null);
	const onReadyRef = useRef(onReady);
	onReadyRef.current = onReady;
	const routeConversationId = ownerKind === "conversation" ? conversationId : "";

	useEffect(() => {
		const container = containerRef.current;
		if (!container) return;

		const term = new Terminal({
			theme: buildTermTheme(),
			fontFamily: '"SF Mono", "JetBrains Mono", ui-monospace, Menlo, Consolas, monospace',
			fontSize: 13,
			cursorBlink: true,
			scrollback: 8000,
		});
		const fit = new FitAddon();
		term.loadAddon(fit);
		term.open(container);
		termRef.current = { term, fit };
		onReadyRef.current?.({ focus: () => term.focus() });
		if (active) term.focus();

		const onThemeChange = () => {
			term.options.theme = buildTermTheme();
		};
		window.addEventListener(THEME_CHANGE_EVENT, onThemeChange);

		term.attachCustomKeyEventHandler((event) => {
			if (event.type !== "keydown") return true;
			const key = event.key?.toLowerCase();
			if ((event.ctrlKey || event.metaKey) && key === "v") {
				return false;
			}
			if (event.ctrlKey && !event.shiftKey && !event.altKey && key === "c") {
				if (term.hasSelection()) {
					const ta = term.textarea;
					if (ta) {
						ta.value = term.getSelection();
						ta.select();
					}
					return false;
				}
			}
			return true;
		});

		let displayDisposed = false;
		let disposeTimer: ReturnType<typeof setTimeout> | undefined;

		const unregister = register(
			conversationId,
			terminalId,
			{
				write: (data) => term.write(stripExitBanner(data).clean),
				reset: () => term.write("", () => term.reset()),
				dispose: () => disposeDisplay(),
			},
			typeof ownerKind === "undefined" ? "client" : ownerKind,
		);

		const disposeDisplay = () => {
			if (displayDisposed) return;
			displayDisposed = true;
			clearTimeout(disposeTimer);
			term.dispose();
			if (termRef.current?.term === term) termRef.current = null;
		};

		const sendDims = () => {
			try {
				fit.fit();
				appSend({
					type: "terminal_resize",
					terminalId,
					conversationId: routeConversationId,
					ownerKind,
					cols: term.cols,
					rows: term.rows,
				});
			} catch {}
		};

		const raf = requestAnimationFrame(() => {
			try {
				fit.fit();
			} catch {}
			appSend({
				type: "terminal_attach",
				terminalId,
				conversationId: routeConversationId,
				ownerKind,
				cols: term.cols,
				rows: term.rows,
			});
		});

		const onData = term.onData((data) => {
			appSend({ type: "terminal_input", terminalId, conversationId: routeConversationId, ownerKind, data });
		});

		const termEl = term.element;
		let touchId: number | null = null;
		let touchStartX = 0;
		let touchStartY = 0;
		let touchLastY = 0;
		let touchScrolling = false;
		const onTouchStart = (e: TouchEvent) => {
			if (e.touches.length !== 1) {
				touchId = null;
				touchScrolling = false;
				return;
			}
			const t = e.touches[0];
			touchId = t.identifier;
			touchStartX = t.clientX;
			touchStartY = t.clientY;
			touchLastY = t.clientY;
			touchScrolling = false;
		};
		const onTouchMove = (e: TouchEvent) => {
			if (touchId === null || e.touches.length !== 1) return;
			const t = e.touches[0];
			if (t.identifier !== touchId) return;
			if (!touchScrolling) {
				if (!shouldStartTouchScroll(t.clientX - touchStartX, t.clientY - touchStartY)) return;
				touchScrolling = true;
			}
			e.preventDefault();
			const deltaY = touchWheelDeltaY(touchLastY, t.clientY);
			touchLastY = t.clientY;
			if (deltaY === 0) return;
			if (typeof WheelEvent === "undefined") return;
			const wheelTarget = container.querySelector(".xterm-viewport") ?? termEl;
			wheelTarget?.dispatchEvent(
				new WheelEvent("wheel", {
					bubbles: true,
					cancelable: true,
					deltaY,
					deltaMode: 0,
					clientX: t.clientX,
					clientY: t.clientY,
				}),
			);
		};
		const onTouchEnd = (e: TouchEvent) => {
			if (touchId === null) return;
			if (e.touches.length > 0) {
				touchId = null;
				touchScrolling = false;
				return;
			}
			touchId = null;
			touchScrolling = false;
		};
		termEl?.addEventListener("touchstart", onTouchStart, { passive: true });
		termEl?.addEventListener("touchmove", onTouchMove, { passive: false });
		termEl?.addEventListener("touchend", onTouchEnd);
		termEl?.addEventListener("touchcancel", onTouchEnd);

		let ro: ResizeObserver | null = null;
		if (typeof ResizeObserver !== "undefined") {
			ro = new ResizeObserver(() => {
				if (container.offsetWidth > 0 && container.offsetHeight > 0) {
					sendDims();
				}
			});
			ro.observe(container);
		}

		return () => {
			onReadyRef.current?.(null);
			cancelAnimationFrame(raf);
			onData.dispose();
			termEl?.removeEventListener("touchstart", onTouchStart);
			termEl?.removeEventListener("touchmove", onTouchMove);
			termEl?.removeEventListener("touchend", onTouchEnd);
			termEl?.removeEventListener("touchcancel", onTouchEnd);
			window.removeEventListener(THEME_CHANGE_EVENT, onThemeChange);
			ro?.disconnect();
			unregister();
			term.write("", disposeDisplay);
			disposeTimer = setTimeout(disposeDisplay, 5000);
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [routeConversationId, ownerKind, terminalId, register]);

	useEffect(() => {
		if (!active) return;
		const raf = requestAnimationFrame(() => {
			const inst = termRef.current;
			if (!inst) return;
			try {
				inst.fit.fit();
				appSend({
					type: "terminal_resize",
					terminalId,
					conversationId: routeConversationId,
					ownerKind,
					cols: inst.term.cols,
					rows: inst.term.rows,
				});
			} catch {}
			inst.term.focus();
		});
		return () => cancelAnimationFrame(raf);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [active]);

	const { t } = useI18n();
	const lastRunning = useRef<boolean | undefined>(undefined);
	useEffect(() => {
		if (running === lastRunning.current) return;
		lastRunning.current = running;
		if (running !== false) return;
		const inst = termRef.current;
		if (!inst) return;
		inst.term.write(`\r\n\x1b[90m${t("exitBanner", { code: exitCode ?? "" })}\x1b[0m\r\n`);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [running, terminalId, exitCode]);

	return <div ref={containerRef} className={`term-xterm ${active ? "" : "hidden"}`} />;
}
