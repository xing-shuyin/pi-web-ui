export function stripJsonComments(src: string): string {
	let out = "";
	let inString = false;
	let i = 0;
	while (i < src.length) {
		const c = src[i];
		const next = src[i + 1];
		if (inString) {
			out += c;
			if (c === "\\") {
				out += next ?? "";
				i += 2;
				continue;
			}
			if (c === '"') inString = false;
			i++;
			continue;
		}
		if (c === '"') {
			inString = true;
			out += c;
			i++;
			continue;
		}
		if (c === "/" && next === "/") {
			while (i < src.length && src[i] !== "\n") i++;
			continue;
		}
		if (c === "/" && next === "*") {
			i += 2;
			while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
			i += 2;
			continue;
		}
		out += c;
		i++;
	}
	return out;
}

export function parseJsonWithComments<T = unknown>(src: string): T {
	return JSON.parse(stripJsonComments(src)) as T;
}
