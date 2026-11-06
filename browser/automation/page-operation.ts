/// <reference lib="dom" />

export async function runPageOperation(op: string, args: Record<string, unknown>): Promise<unknown> {
	const str = (value: unknown): string => (typeof value === "string" ? value.trim() : "");
	const num = (value: unknown, fallback: number, min: number, max: number): number =>
		Math.min(max, Math.max(min, typeof value === "number" && Number.isFinite(value) ? Math.round(value) : fallback));
	const cut = (text: string, max: number): string =>
		text.length > max ? `${text.slice(0, max)}\n…（已截断，原文 ${text.length} 字）` : text;
	const textOf = (node: Element | null): string =>
		String((node as HTMLElement | null)?.innerText ?? node?.textContent ?? "")
			.replace(/\r/g, "")
			.trim();
	const isPassword = (node: Element): boolean =>
		node.tagName.toLowerCase() === "input" && (node as HTMLInputElement).type === "password";
	const brief = (node: Element, index: number): Record<string, unknown> => {
		const rect = node.getBoundingClientRect();
		const tag = node.tagName.toLowerCase();
		return {
			index,
			tag,
			...(node.id ? { id: node.id } : {}),
			...(node.classList.length ? { classes: [...node.classList].slice(0, 6) } : {}),
			text: isPassword(node) ? "" : cut(textOf(node).replace(/\s+/g, " "), 160),
			...(tag === "a" ? { href: (node as HTMLAnchorElement).href } : {}),
			...(tag === "input" || tag === "textarea"
				? {
						type: (node as HTMLInputElement).type,
						...(!isPassword(node) ? { value: (node as HTMLInputElement).value } : {}),
						...((node as HTMLInputElement).placeholder ? { placeholder: (node as HTMLInputElement).placeholder } : {}),
					}
				: {}),
			rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
		};
	};
	const selector = str(args.selector);
	const find = (): Element | null => {
		if (!selector) return null;
		return document.querySelectorAll(selector)[num(args.index, 0, 0, 10000)] ?? null;
	};

	if (op === "read") {
		const what = str(args.what) || "text";
		if (what === "title") return { title: document.title };
		if (what === "url") return { url: location.href };
		if (what === "query") {
			if (!selector) throw new Error("read what=query requires selector");
			const all = [...document.querySelectorAll(selector)];
			const picked = (args.all === false ? all.slice(0, 1) : all).slice(0, num(args.limit, 20, 1, 100));
			return { selector, count: all.length, shown: picked.length, items: picked.map(brief) };
		}
		const node = selector
			? document.querySelector(selector)
			: what === "html"
				? document.documentElement
				: document.body;
		if (!node) throw new Error(`Selector did not match: ${selector}`);
		if (what === "html") {
			const clone = node.cloneNode(true) as Element;
			const passwords = [...clone.querySelectorAll('input[type="password" i]')];
			if (isPassword(clone)) passwords.push(clone);
			for (const input of passwords) {
				input.removeAttribute("value");
				(input as HTMLInputElement).value = "";
				input.textContent = "";
			}
			return { html: cut(clone.outerHTML, 20000), selector: selector || null };
		}
		return { text: isPassword(node) ? "" : cut(textOf(node), 12000), selector: selector || null };
	}
	if (op === "snapshot") {
		const nodes = [
			...document.querySelectorAll(
				'a,button,input,textarea,select,[role="button"],[contenteditable="true"],[tabindex]',
			),
		].filter((node) => {
			const style = getComputedStyle(node);
			return style.display !== "none" && style.visibility !== "hidden" && (node as HTMLInputElement).type !== "hidden";
		});
		const selectorOf = (node: Element): string => {
			const parts: string[] = [];
			for (let current: Element | null = node; current; current = current.parentElement) {
				const tag = current.tagName.toLowerCase();
				const siblings: Element[] = current.parentElement
					? [...current.parentElement.children].filter((s) => s.tagName === current!.tagName)
					: [current];
				parts.unshift(`${tag}:nth-of-type(${siblings.indexOf(current) + 1})`);
			}
			return parts.join(" > ");
		};
		const items = nodes
			.slice(0, num(args.limit, 100, 1, 100))
			.map((node, index) => ({ ...brief(node, index), selector: selectorOf(node) }));
		return { title: document.title, url: location.href, count: nodes.length, shown: items.length, items };
	}
	if (op === "wait") {
		const text = typeof args.text === "string" ? args.text : "";
		if (!selector && !text) throw new Error("wait requires selector or text");
		const timeout = num(args.timeoutMs, 5000, 1, 30000);
		const start = Date.now();
		for (;;) {
			if (selector && document.querySelector(selector))
				return { found: "selector", selector, waitedMs: Date.now() - start };
			if (text && textOf(document.body).includes(text)) return { found: "text", text, waitedMs: Date.now() - start };
			if (Date.now() - start >= timeout)
				return {
					found: null,
					waitedMs: Date.now() - start,
					note: `Timed out after ${timeout}ms waiting for selector/text`,
				};
			await new Promise<void>((resolve) => setTimeout(resolve, Math.min(100, timeout - (Date.now() - start))));
		}
	}
	if (op === "metrics") {
		const node = selector ? document.querySelector(selector) : null;
		if (selector && !node) throw new Error(`Selector did not match: ${selector}`);
		const rect = node?.getBoundingClientRect();
		return {
			vw: innerWidth,
			vh: innerHeight,
			sx: scrollX,
			sy: scrollY,
			dpr: devicePixelRatio || 1,
			...(rect ? { rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height } } : {}),
		};
	}
	if (op === "scroll") {
		if (selector) {
			const node = document.querySelector(selector);
			if (!node) throw new Error(`Selector did not match: ${selector}`);
			node.scrollIntoView({ block: "center", inline: "nearest" });
		} else if (args.to && typeof args.to === "object") {
			const to = args.to as { x?: unknown; y?: unknown };
			window.scrollTo(num(to.x, scrollX, -1e9, 1e9), num(to.y, scrollY, -1e9, 1e9));
		} else if (args.by && typeof args.by === "object") {
			const by = args.by as { x?: unknown; y?: unknown };
			window.scrollBy(num(by.x, 0, -1e9, 1e9), num(by.y, 0, -1e9, 1e9));
		} else throw new Error("scroll requires selector / to / by");
		return { scrolled: true, x: Math.round(scrollX), y: Math.round(scrollY) };
	}
	if (op === "click" || op === "type") {
		if (!selector) throw new Error(`${op} requires selector`);
		const node = find();
		if (!node) throw new Error(`Selector did not match: ${selector}`);
		if (op === "click") {
			node.scrollIntoView?.({ block: "center", inline: "center" });
			if (typeof (node as HTMLElement).click === "function") (node as HTMLElement).click();
			else node.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
			return { clicked: true, selector, ...brief(node, 0) };
		}
		const text = typeof args.text === "string" ? args.text : "";
		(node as HTMLElement).focus();
		const tag = node.tagName.toLowerCase();
		if (tag === "input" || tag === "textarea" || tag === "select") {
			const proto =
				tag === "textarea"
					? HTMLTextAreaElement.prototype
					: tag === "select"
						? HTMLSelectElement.prototype
						: HTMLInputElement.prototype;
			Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(node, text);
		} else if ((node as HTMLElement).isContentEditable) node.textContent = text;
		else throw new Error("type requires an input, textarea, select or contenteditable element");
		node.dispatchEvent(new Event("input", { bubbles: true }));
		node.dispatchEvent(new Event("change", { bubbles: true }));
		return {
			typed: true,
			selector,
			...(!isPassword(node) ? { value: (node as HTMLInputElement).value ?? textOf(node) } : {}),
			submitted: false,
		};
	}
	throw new Error(`Unsupported page operation: ${op}`);
}
