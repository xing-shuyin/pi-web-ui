import { useEffect, useState, type ReactNode } from "react";
import { useT } from "../i18n";
import { questionWaitTime } from "../question-queue";
import { selectPending } from "../pending-queue";

interface PendingQueueProps<T> {
	items: T[];
	itemKey: (item: T) => string;
	title: string;
	summary: (item: T) => ReactNode;
	canAutoOpen: (item: T) => boolean;
	createdAt: (item: T) => number;
	onNavigate?: (item: T) => void;
	canNavigate?: (item: T) => boolean;
	children: (item: T, defer: () => void) => ReactNode;
}

export function PendingQueue<T>({
	items,
	itemKey,
	title,
	summary,
	canAutoOpen,
	createdAt,
	onNavigate,
	canNavigate,
	children,
}: PendingQueueProps<T>) {
	const t = useT();
	const [deferred, setDeferred] = useState<Set<string>>(() => new Set());
	const [opened, setOpened] = useState<string | null>(null);
	const [now, setNow] = useState(Date.now);
	const selected = selectPending(items, itemKey, opened, deferred, canAutoOpen);
	const selectedKey = selected ? itemKey(selected) : null;
	useEffect(() => {
		setOpened(selectedKey);
	}, [selectedKey]);
	const hasTimedItems = items.some((item) => createdAt(item) > 0);
	useEffect(() => {
		if (!hasTimedItems) return;
		setNow(Date.now());
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, [hasTimedItems]);
	if (!items.length) return null;
	const queuedItems = items.filter((item) => item !== selected);
	return (
		<section className="question-queue" aria-label={title}>
			{queuedItems.length > 0 && (
				<div className="question-queue-list">
					<div>
						{title} · {items.length}
					</div>
					{queuedItems.map((item) => (
						<div className="question-queue-item" key={itemKey(item)}>
							<div className="question-queue-summary">{summary(item)}</div>
							{questionWaitTime(createdAt(item), now) && (
								<span className="question-queue-wait">⏱ {questionWaitTime(createdAt(item), now)}</span>
							)}
							<div className="question-queue-actions">
								<button type="button" className="btn" onClick={() => setOpened(itemKey(item))}>
									{t("questionQueueOpen")}
								</button>
								{onNavigate && canNavigate?.(item) && (
									<button type="button" className="btn" onClick={() => onNavigate(item)}>
										{t("questionQueueNavigate")}
									</button>
								)}
							</div>
						</div>
					))}
				</div>
			)}
			{selected && (
				<div className="question-queue-dialog" key={selectedKey}>
					{children(selected, () => {
						setDeferred((prev) => new Set(prev).add(itemKey(selected)));
						setOpened(null);
					})}
				</div>
			)}
		</section>
	);
}
