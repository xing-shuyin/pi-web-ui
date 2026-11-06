import type { SVGProps } from "react";

export function HalfRingSpinner({ className, width = "1em", height = "1em", ...props }: SVGProps<SVGSVGElement>) {
	const cls = ["half-ring-spin", className].filter(Boolean).join(" ");
	return (
		<svg
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2.5"
			strokeLinecap="round"
			width={width}
			height={height}
			className={cls}
			aria-hidden="true"
			{...props}
		>
			<path d="M 12 2 A 10 10 0 0 1 12 22" />
		</svg>
	);
}
