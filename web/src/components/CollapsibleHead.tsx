import type { KeyboardEvent, MouseEventHandler, ReactNode } from "react";
import { FiChevronDown, FiChevronRight } from "react-icons/fi";

export function CollapsibleHead({
	open,
	onToggle,
	headClassName,
	titleText,
	icon,
	iconClassName,
	titleClassName,
	toggleClassName,
	toggle,
	onHeadContextMenu,
	children,
	after,
}: {
	open: boolean;
	onToggle: () => void;
	headClassName: string;
	titleText: string;
	icon: ReactNode;
	iconClassName?: string;
	titleClassName?: string;
	toggleClassName?: string;
	toggle?: ReactNode;
	onHeadContextMenu?: MouseEventHandler<HTMLDivElement>;
	children: ReactNode;
	after?: ReactNode;
}) {
	return (
		<div
			className={`chead ${headClassName}`}
			role="button"
			tabIndex={0}
			aria-expanded={open}
			title={titleText}
			onClick={onToggle}
			onContextMenu={onHeadContextMenu}
			onKeyDown={(e: KeyboardEvent<HTMLDivElement>) => {
				if (e.target !== e.currentTarget) return;
				if (e.key === "Enter" || e.key === " ") {
					e.preventDefault();
					onToggle();
				}
			}}
		>
			{toggle === undefined ? (
				<button
					type="button"
					className={toggleClassName ? `chead-toggle ${toggleClassName}` : "chead-toggle"}
					title={titleText}
					aria-label={titleText}
					aria-expanded={open}
					onClick={(e) => {
						e.stopPropagation();
						onToggle();
					}}
				>
					{open ? <FiChevronDown /> : <FiChevronRight />}
				</button>
			) : (
				toggle
			)}
			<span className={iconClassName ? `chead-icon ${iconClassName}` : "chead-icon"}>{icon}</span>
			<span className={titleClassName ? `chead-title ${titleClassName}` : "chead-title"}>{children}</span>
			{after}
		</div>
	);
}
