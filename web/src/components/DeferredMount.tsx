import { Suspense, useRef, type ReactNode } from "react";

export function DeferredMount({ active, children }: { active: boolean; children: ReactNode }) {
	const visited = useRef(false);
	if (active) visited.current = true;
	return visited.current ? <Suspense fallback={null}>{children}</Suspense> : null;
}
