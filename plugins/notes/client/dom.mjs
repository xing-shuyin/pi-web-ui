/**
 * @param {string} tag
 * @param {Record<string, unknown>} [props]  `class` / `text` / `style` / `dataset` /
 *   `onXxx`（事件）/ 其余按 DOM 属性或属性值写入（`value`/`checked`/`type` 这类直接赋值）
 * @param {...unknown} children
 */
export function el(tag, props, ...children) {
	const node = document.createElement(tag);
	for (const [k, v] of Object.entries(props ?? {})) {
		if (v === undefined || v === null || v === false) continue;
		if (k === "class") node.className = String(v);
		else if (k === "text") node.textContent = String(v);
		else if (k === "style") node.setAttribute("style", String(v));
		else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2).toLowerCase(), v);
		else if (k === "dataset") Object.assign(node.dataset, v);
		else if (k in node) node[k] = v;
		else node.setAttribute(k, String(v));
	}
	for (const child of children.flat()) {
		if (child === undefined || child === null || child === false) continue;
		node.append(child instanceof Node ? child : document.createTextNode(String(child)));
	}
	return node;
}
