import {
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
	type CSSProperties,
	type MouseEvent as ReactMouseEvent,
	type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { FiMaximize, FiMinimize } from "react-icons/fi";
import { useEscapeKey } from "../shortcut-stack";
import { useT } from "../i18n";

let bodyScrollLockCount = 0;
let previousBodyOverflow = "";

function lockBodyScroll() {
	if (typeof document === "undefined") return;
	if (bodyScrollLockCount === 0) {
		previousBodyOverflow = document.body.style.overflow;
		document.body.style.overflow = "hidden";
	}
	bodyScrollLockCount++;
}

function unlockBodyScroll() {
	if (typeof document === "undefined") return;
	bodyScrollLockCount = Math.max(0, bodyScrollLockCount - 1);
	if (bodyScrollLockCount === 0) {
		document.body.style.overflow = previousBodyOverflow;
	}
}

export interface ModalProps {
	open?: boolean;
	onClose: () => void;
	title?: ReactNode;
	icon?: ReactNode;
	headerActions?: ReactNode;
	children?: ReactNode;
	className?: string;
	backdropClassName?: string;
	style?: CSSProperties;
	closeOnBackdropClick?: boolean;
	closeOnEscape?: boolean;
	showCloseButton?: boolean;
	allowFullscreen?: boolean;
	fullscreen?: boolean;
	onFullscreenChange?: (fullscreen: boolean) => void;
	ariaLabel?: string;
	lockScroll?: boolean;
}

export function Modal({
	open = true,
	onClose,
	title,
	icon,
	headerActions,
	allowFullscreen = false,
	fullscreen: controlledFullscreen,
	onFullscreenChange,
	children,
	className = "",
	backdropClassName = "",
	style,
	closeOnBackdropClick = true,
	closeOnEscape = true,
	showCloseButton = true,
	ariaLabel,
	lockScroll = true,
}: ModalProps) {
	const t = useT();
	const onCloseRef = useRef(onClose);
	useLayoutEffect(() => {
		onCloseRef.current = onClose;
	});

	const isControlled = controlledFullscreen !== undefined;
	const [uncontrolledFullscreen, setUncontrolledFullscreen] = useState(false);
	const isFullscreen = allowFullscreen ? (isControlled ? controlledFullscreen : uncontrolledFullscreen) : false;

	const handleToggleFullscreen = () => {
		const next = !isFullscreen;
		if (!isControlled) {
			setUncontrolledFullscreen(next);
		}
		onFullscreenChange?.(next);
	};

	useEscapeKey(() => {
		if (allowFullscreen && isFullscreen) {
			if (!isControlled) {
				setUncontrolledFullscreen(false);
			}
			onFullscreenChange?.(false);
			return true;
		}
		if (closeOnEscape) {
			onCloseRef.current();
			return true;
		}
		return false;
	}, open);

	useEffect(() => {
		if (!open || !lockScroll) return;
		lockBodyScroll();
		return () => {
			unlockBodyScroll();
		};
	}, [open, lockScroll]);

	if (!open) return null;

	const handleBackdropClick = (e: ReactMouseEvent) => {
		if (e.target === e.currentTarget && closeOnBackdropClick) {
			onCloseRef.current();
		}
	};

	const computedAriaLabel = ariaLabel ?? (typeof title === "string" ? title : undefined);
	const backdropClasses = `modal-backdrop ${backdropClassName} ${isFullscreen ? "fullscreen" : ""}`.trim();
	const modalClasses =
		`modal ${className} ${allowFullscreen ? "has-fullscreen-toggle" : ""} ${isFullscreen ? "fullscreen" : ""}`.trim();

	return createPortal(
		<div className={backdropClasses} onClick={handleBackdropClick} role="presentation">
			<div
				className={modalClasses}
				role="dialog"
				aria-modal="true"
				aria-label={computedAriaLabel}
				style={style}
				onClick={(e) => e.stopPropagation()}
			>
				{allowFullscreen && (
					<button
						type="button"
						className={`modal-fullscreen-btn ${isFullscreen ? "active" : ""}`}
						aria-label={t(isFullscreen ? "exitFullscreen" : "fullscreen")}
						title={t(isFullscreen ? "exitFullscreen" : "fullscreen")}
						onClick={handleToggleFullscreen}
					>
						{isFullscreen ? <FiMinimize /> : <FiMaximize />}
					</button>
				)}
				{showCloseButton && (
					<button type="button" className="modal-close" aria-label={t("close")} onClick={() => onCloseRef.current()}>
						✕
					</button>
				)}
				{title ? (
					<div
						className="modal-head"
						onDoubleClick={(e) => {
							if (!allowFullscreen) return;
							const target = e.target as HTMLElement | null;
							if (target && !target.closest("button, a, input, textarea, select")) {
								handleToggleFullscreen();
							}
						}}
					>
						{icon ? (
							<span className="modal-head-icon" aria-hidden>
								{icon}
							</span>
						) : null}
						<span className="modal-head-title">{title}</span>
						{headerActions ? <div className="modal-head-actions">{headerActions}</div> : null}
					</div>
				) : null}
				{children}
			</div>
		</div>,
		document.body,
	);
}
