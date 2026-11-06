import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";

type ClickOutsideTarget = RefObject<HTMLElement | null> | HTMLElement | null | undefined;

interface UseClickOutsideOptions {
	enabled?: boolean;
	ignore?: ClickOutsideTarget | ClickOutsideTarget[];
}

export function useClickOutside(
	targetRef: RefObject<HTMLElement | null>,
	onClickOutside: (e: MouseEvent | TouchEvent) => void,
	options: UseClickOutsideOptions = {},
): void {
	const { enabled = true, ignore } = options;

	const callbackRef = useRef(onClickOutside);
	useLayoutEffect(() => {
		callbackRef.current = onClickOutside;
	});

	useEffect(() => {
		if (!enabled) return;

		const isTargetOrChild = (target: Node, elementOrRef: ClickOutsideTarget): boolean => {
			if (!elementOrRef) return false;
			const el = "current" in elementOrRef ? elementOrRef.current : elementOrRef;
			return el ? el.contains(target) : false;
		};

		const handleEvent = (e: MouseEvent | TouchEvent) => {
			const target = e.target;
			if (!(target instanceof Node)) return;

			if (targetRef.current?.contains(target)) return;

			if (ignore) {
				const ignores = Array.isArray(ignore) ? ignore : [ignore];
				if (ignores.some((ig) => isTargetOrChild(target, ig))) {
					return;
				}
			}

			callbackRef.current(e);
		};

		document.addEventListener("mousedown", handleEvent);
		document.addEventListener("touchstart", handleEvent);

		return () => {
			document.removeEventListener("mousedown", handleEvent);
			document.removeEventListener("touchstart", handleEvent);
		};
	}, [enabled, targetRef, ignore]);
}
