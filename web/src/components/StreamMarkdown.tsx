import { memo, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { segmentStream } from "../stream-markdown";
import {
	MarkdownBody,
	PreWithCopy,
	rehypePlugins,
	remarkPlugins,
} from "./Markdown";

/**
 * Prefix-cached streaming markdown renderer (see stream-markdown.ts for the
 * segmentation rules). Replaces the naive `<Markdown text={growingString}>`
 * during streaming, which re-parsed the whole document per delta — O(n²)
 * cumulative parse + highlight work that janks long code-heavy replies.
 *
 * Structure:
 *  - frozen[] segments: append-only complete blocks. Each is its own memoized
 *    <ReactMarkdown> keyed by stable index → parsed exactly ONCE ever; React
 *    reuses their DOM subtrees across frames (copy buttons don't remount).
 *  - active tail inside an unclosed fence: rendered as PLAIN code — no
 *    highlighting a growing block (that would be O(n²) within the block).
 *  - active tail otherwise: full markdown, throttled to ~200ms with a
 *    trailing-edge timer so the last text always renders.
 *
 * The parent switches to the authoritative one-shot <Markdown> at message end,
 * correcting any segmentation imperfection (setext headings, forward link
 * reference definitions) in the final render.
 */

/** One frozen segment: immutable input → parses exactly once thanks to memo. */
const FrozenSegment = memo(function FrozenSegment({ text }: { text: string }) {
	return (
		<ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={{ pre: PreWithCopy }}>
			{text}
		</ReactMarkdown>
	);
});

const TAIL_INTERVAL_MS = 200;

/** Active (still-growing) tail: re-parse at most every TAIL_INTERVAL_MS,
 *  with a trailing timer so nothing is left unrendered. */
function ActiveTail({ text, inFence }: { text: string; inFence: boolean }) {
	const [rendered, setRendered] = useState(text);
	const lastRef = useRef(0);
	const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	useEffect(() => {
		if (inFence) {
			// Plain code path renders directly — no throttle needed.
			return;
		}
		const elapsed = Date.now() - lastRef.current;
		const flush = () => {
			lastRef.current = Date.now();
			setRendered(text);
		};
		if (elapsed >= TAIL_INTERVAL_MS) {
			flush();
			return;
		}
		timerRef.current = setTimeout(flush, TAIL_INTERVAL_MS - elapsed);
		return () => {
			if (timerRef.current) clearTimeout(timerRef.current);
		};
	}, [text, inFence]);

	if (inFence) {
		// Growing fenced code: plain <pre>, zero highlight cost while typing.
		return (
			<div className="codeblock">
				<pre>
					<code>{text}</code>
				</pre>
			</div>
		);
	}
	return <MarkdownBody text={rendered} />;
}

export const StreamMarkdown = memo(function StreamMarkdown({
	text,
}: {
	text: string;
}) {
	const { frozen, active, inFence } = useMemo(
		() => segmentStream(text),
		[text],
	);
	return (
		<div className="md">
			{frozen.map((seg, i) => (
				<FrozenSegment key={i} text={seg} />
			))}
			{/* key restarts the throttle whenever a block freezes — the fresh tail
			    renders immediately instead of waiting out the previous interval. */}
			{active.length > 0 && (
				<ActiveTail key={frozen.length} text={active} inFence={inFence} />
			)}
		</div>
	);
});
