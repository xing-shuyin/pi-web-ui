/**
 * 极简「只看真实代码」扫描器：把注释、字符串、模板文本与正则字面量的内容替换成空格（保留换行与字符索引），
 * 后续的正则与括号匹配就不会被「注释里写了 spawn(...)」「字符串里有括号」这类假目标骗到。
 *
 * 单源：各类「禁用某 API」的守卫单测都走这里（见 sync-child-process-guard / windows-hide-guard）。
 */
const REGEX_PRECEDER_CHARS = "([{,;:=!&|?+-*%<>^~";
const REGEX_PRECEDER_WORDS = /(?:^|[^\w$])(?:return|typeof|case|in|of|delete|void|instanceof|new|do|else|yield|await)$/;

export function blankNonCode(src: string): string {
	// 必须按 UTF-16 码元切分（与 `src[i]` 的索引一致）：`[...src]` 按码点切分，遇到
	// emoji 之类的增补平面字符会让下标错位，后面的注释/字符串判定整体崩掉。
	const chars = src.split("");
	const n = chars.length;
	const blank = (from: number, to: number) => {
		for (let i = from; i < to && i < n; i++) if (chars[i] !== "\n") chars[i] = " ";
	};
	type Frame = { kind: "template" } | { kind: "expr"; depth: number };
	const stack: Frame[] = [];
	let i = 0;
	let prevSignificant = "";

	while (i < n) {
		const frame = stack[stack.length - 1];

		if (frame?.kind === "template") {
			const c = src[i];
			if (c === "\\") {
				blank(i, i + 2);
				i += 2;
				continue;
			}
			if (c === "`") {
				stack.pop();
				prevSignificant = "`";
				i++;
				continue;
			}
			if (c === "$" && src[i + 1] === "{") {
				stack.push({ kind: "expr", depth: 0 });
				blank(i, i + 2);
				i += 2;
				continue;
			}
			blank(i, i + 1);
			i++;
			continue;
		}

		const c = src[i];
		const next = src[i + 1];

		if (c === "/" && next === "/") {
			let j = i;
			while (j < n && src[j] !== "\n") j++;
			blank(i, j);
			i = j;
			continue;
		}

		if (c === "/" && next === "*") {
			let j = i + 2;
			while (j < n && !(src[j] === "*" && src[j + 1] === "/")) j++;
			blank(i, Math.min(j + 2, n));
			i = j + 2;
			continue;
		}

		if (c === '"' || c === "'") {
			let j = i + 1;
			while (j < n) {
				if (src[j] === "\\") {
					j += 2;
					continue;
				}
				if (src[j] === c || src[j] === "\n") break;
				j++;
			}
			blank(i + 1, Math.max(i + 1, j));
			i = j + 1;
			prevSignificant = c;
			continue;
		}

		if (c === "`") {
			stack.push({ kind: "template" });
			i++;
			continue;
		}

		if (c === "/") {
			const wordBefore = /[\w$]+$/.exec(chars.slice(Math.max(0, i - 32), i).join(""));
			const startsRegex =
				!prevSignificant ||
				REGEX_PRECEDER_CHARS.includes(prevSignificant) ||
				(!!wordBefore && REGEX_PRECEDER_WORDS.test(wordBefore[0]));
			if (startsRegex) {
				let j = i + 1;
				let inClass = false;
				while (j < n) {
					const ch = src[j];
					if (ch === "\\") {
						j += 2;
						continue;
					}
					if (ch === "\n") break;
					if (inClass) {
						if (ch === "]") inClass = false;
					} else if (ch === "[") inClass = true;
					else if (ch === "/") {
						j++;
						break;
					}
					j++;
				}
				blank(i + 1, Math.max(i + 1, j - 1));
				i = j;
				prevSignificant = "/";
				continue;
			}
		}

		if (frame?.kind === "expr") {
			if (c === "}") {
				if (frame.depth === 0) {
					stack.pop();
					blank(i, i + 1);
					i++;
					prevSignificant = "}";
					continue;
				}
				frame.depth--;
			} else if (c === "{") {
				frame.depth++;
			}
		}

		if (!/\s/.test(c)) prevSignificant = c;
		i++;
	}

	return chars.join("");
}
