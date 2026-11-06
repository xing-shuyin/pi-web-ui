import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
	label: string;
	slot?: string;
	entryId?: string;
	children: ReactNode;
}

interface State {
	message: string | null;
}

export class SlotErrorBoundary extends Component<Props, State> {
	state: State = { message: null };

	static getDerivedStateFromError(err: unknown): State {
		return { message: err instanceof Error ? err.message : String(err) };
	}

	componentDidCatch(err: unknown, info: ErrorInfo): void {
		console.error(
			`[ui-slot] entry "${this.props.entryId ?? this.props.label}" in slot "${this.props.slot ?? "?"}" crashed:`,
			err,
			info.componentStack,
		);
	}

	render(): ReactNode {
		if (this.state.message === null) return this.props.children;
		const tip = `slot=${this.props.slot ?? "?"} entry=${this.props.entryId ?? this.props.label}: ${this.state.message}`;
		return (
			<button
				type="button"
				className="slot-error"
				title={tip}
				aria-label={this.props.label}
				onClick={() => console.error(`[ui-slot] ${tip}`)}
			>
				<span aria-hidden>⚠</span>
				<span>{this.props.label}</span>
			</button>
		);
	}
}
