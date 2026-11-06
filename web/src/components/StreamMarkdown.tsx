import { memo, useEffect, useMemo, useRef, useState } from "react";
import { segmentStream, stepSmoothStream } from "../stream-markdown";
import { MarkdownBody } from "./Markdown";

const SMOOTH_PACE_MS = 22;
const FINISHING_PACE_MS = 14;

const isDocumentHidden = () => typeof document !== "undefined" && document.hidden;

export function useSmoothStreamText(text: string, active = true, finishing = false, onSettled?: () => void): string {
	const [displayedLen, setDisplayedLen] = useState<number>(() =>
		!active || isDocumentHidden() || text.length > 1500 ? text.length : 0,
	);
	const targetRef = useRef(text);
	targetRef.current = text;
	const lenRef = useRef(displayedLen);
	lenRef.current = displayedLen;
	const activeRef = useRef(active);
	activeRef.current = active;
	const finishingRef = useRef(finishing);
	finishingRef.current = finishing;
	const onSettledRef = useRef(onSettled);
	onSettledRef.current = onSettled;
	const rafIdRef = useRef(0);
	const lastTickTimeRef = useRef(0);

	useEffect(() => {
		if (typeof document === "undefined") return;
		const handleVisibility = () => {
			if (document.hidden) {
				if (rafIdRef.current) {
					cancelAnimationFrame(rafIdRef.current);
					rafIdRef.current = 0;
				}
				lenRef.current = targetRef.current.length;
				setDisplayedLen(targetRef.current.length);
				if (finishingRef.current || !activeRef.current) {
					onSettledRef.current?.();
				}
			} else {
				if (rafIdRef.current) {
					cancelAnimationFrame(rafIdRef.current);
					rafIdRef.current = 0;
				}
				lenRef.current = targetRef.current.length;
				setDisplayedLen(targetRef.current.length);
				if (finishingRef.current || !activeRef.current) {
					onSettledRef.current?.();
				}
			}
		};
		document.addEventListener("visibilitychange", handleVisibility);
		return () => document.removeEventListener("visibilitychange", handleVisibility);
	}, []);

	useEffect(() => {
		if (!active) {
			if (rafIdRef.current) {
				cancelAnimationFrame(rafIdRef.current);
				rafIdRef.current = 0;
			}
			if (lenRef.current !== text.length) {
				lenRef.current = text.length;
				setDisplayedLen(text.length);
			}
			return;
		}
		if (isDocumentHidden()) {
			if (rafIdRef.current) {
				cancelAnimationFrame(rafIdRef.current);
				rafIdRef.current = 0;
			}
			if (lenRef.current !== text.length) {
				lenRef.current = text.length;
				setDisplayedLen(text.length);
			}
			if (finishing || lenRef.current >= text.length) {
				onSettledRef.current?.();
			}
			return;
		}
		if (text.length < lenRef.current) {
			if (rafIdRef.current) {
				cancelAnimationFrame(rafIdRef.current);
				rafIdRef.current = 0;
			}
			lenRef.current = text.length;
			setDisplayedLen(text.length);
			onSettledRef.current?.();
			return;
		}
		if (lenRef.current >= text.length) {
			if (!rafIdRef.current) {
				onSettledRef.current?.();
			}
			return;
		}

		if (rafIdRef.current) return;

		const tick = (now: number) => {
			rafIdRef.current = 0;
			if (!activeRef.current) return;
			const paceMs = finishingRef.current ? FINISHING_PACE_MS : SMOOTH_PACE_MS;
			if (lastTickTimeRef.current > 0 && now - lastTickTimeRef.current < paceMs) {
				rafIdRef.current = requestAnimationFrame(tick);
				return;
			}
			lastTickTimeRef.current = now;
			const target = targetRef.current;
			const next = stepSmoothStream(target, lenRef.current, finishingRef.current);
			if (next !== lenRef.current) {
				lenRef.current = next;
				setDisplayedLen(next);
			}
			if (next < targetRef.current.length) {
				rafIdRef.current = requestAnimationFrame(tick);
			} else {
				onSettledRef.current?.();
			}
		};
		rafIdRef.current = requestAnimationFrame(tick);
	}, [text, active, finishing]);

	useEffect(() => {
		return () => {
			if (rafIdRef.current) {
				cancelAnimationFrame(rafIdRef.current);
				rafIdRef.current = 0;
			}
		};
	}, []);

	if (!active || displayedLen >= text.length) return text;
	return text.slice(0, displayedLen);
}

const LONG_TAIL_THRESHOLD = 600;
const LONG_TAIL_INTERVAL_MS = 32;

const Segment = memo(function Segment({ text, active, inFence }: { text: string; active: boolean; inFence: boolean }) {
	const isLong = active && !inFence && text.length >= LONG_TAIL_THRESHOLD;
	const [rendered, setRendered] = useState(text);
	const lastRef = useRef(0);
	const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	useEffect(() => {
		if (!isLong) return;
		const elapsed = Date.now() - lastRef.current;
		const flush = () => {
			lastRef.current = Date.now();
			setRendered(text);
		};
		if (elapsed >= LONG_TAIL_INTERVAL_MS) {
			flush();
			return;
		}
		timerRef.current = setTimeout(flush, LONG_TAIL_INTERVAL_MS - elapsed);
		return () => {
			if (timerRef.current) clearTimeout(timerRef.current);
		};
	}, [text, isLong]);

	if (active && inFence) {
		return (
			<div className="codeblock">
				<pre>
					<code>{text}</code>
				</pre>
			</div>
		);
	}
	return <MarkdownBody text={isLong ? rendered : text} />;
});

export const StreamMarkdown = memo(function StreamMarkdown({
	text,
	finishing = false,
	onSettled,
}: {
	text: string;
	finishing?: boolean;
	onSettled?: () => void;
}) {
	const smoothed = useSmoothStreamText(text, true, finishing, onSettled);
	const { frozen, active, inFence } = useMemo(() => segmentStream(smoothed), [smoothed]);
	return (
		<div className="md">
			{[...frozen, ...(active.length > 0 ? [active] : [])].map((seg, i) => (
				<Segment key={i} text={seg} active={i === frozen.length} inFence={i === frozen.length && inFence} />
			))}
		</div>
	);
});
