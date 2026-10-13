import type { Plugin } from "unified";
import type {} from "remark-parse";
import type { Construct, State, Token, Tokenizer } from "micromark-util-types";
import type { Extension as FromMarkdownExtension } from "mdast-util-from-markdown";
import type { InlineMath, Math } from "mdast-util-math";

declare module "micromark-util-types" {
	interface TokenTypeMap {
		backslashMathInline: "backslashMathInline";
		backslashMathDisplay: "backslashMathDisplay";
		backslashMathBlock: "backslashMathBlock";
		backslashMathData: "backslashMathData";
	}
}

/** Recognize TeX delimiters before CommonMark consumes them as escapes.
 * Code spans, fenced/indented code, links and HTML retain their normal parsing.
 * Only complete pairs become math; incomplete streaming input stays literal.
 */
const remarkBackslashMath: Plugin = function () {
	const data = this.data();
	(data.micromarkExtensions ??= []).push({
		flow: { 92: construct(true) },
		text: { 92: construct(false) },
	});
	const fromMarkdown: FromMarkdownExtension = {
		enter: {
			backslashMathInline: enter,
			backslashMathDisplay: enter,
			backslashMathBlock: enter,
		},
		exit: {
			backslashMathInline: exit,
			backslashMathDisplay: exit,
			backslashMathBlock: exit,
		},
	};
	(data.fromMarkdownExtensions ??= []).push(fromMarkdown);
};

function construct(block: boolean): Construct {
	const tokenize: Tokenizer = function (effects, ok, nok) {
		const self = this;
		let close = 93;
		let type: "backslashMathInline" | "backslashMathDisplay" | "backslashMathBlock" = block
			? "backslashMathBlock"
			: "backslashMathDisplay";
		let token: Token;
		return start;
		function start(code: Parameters<State>[0]): ReturnType<State> {
			if (code !== 92) return nok(code);
			token = effects.enter(type);
			effects.consume(code);
			return openingBracket;
		}
		function openingBracket(code: Parameters<State>[0]): ReturnType<State> {
			if (code !== 91 && (block || code !== 40)) return nok(code);
			close = code === 91 ? 93 : 41;
			if (!block && code === 40) token.type = type = "backslashMathInline";
			effects.consume(code);
			return body;
		}
		function body(code: Parameters<State>[0]): ReturnType<State> {
			// A display block may continue only while its list/quote container
			// continues. Otherwise an unclosed opener could consume later prose
			// or literal code outside that container while searching for a closer.
			if (code === null || (block && self.parser.lazy[self.now().line])) return nok(code);
			if (code === -5 || code === -4 || code === -3) {
				effects.enter("lineEnding");
				effects.consume(code);
				effects.exit("lineEnding");
				return body;
			}
			consumeData(code);
			return code === 92 ? afterSlash : body;
		}
		function afterSlash(code: Parameters<State>[0]): ReturnType<State> {
			if (code === close) {
				consumeData(code);
				effects.exit(type);
				return block ? endLine : ok;
			}
			// Consume an escaped character as a pair, including TeX row breaks.
			if (code === null) return nok(code);
			if (code === -5 || code === -4 || code === -3) return body(code);
			consumeData(code);
			return body;
		}
		function consumeData(code: Exclude<Parameters<State>[0], null>): void {
			effects.enter("backslashMathData");
			effects.consume(code);
			effects.exit("backslashMathData");
		}
		function endLine(code: Parameters<State>[0]): ReturnType<State> {
			if (code === null || code === -5 || code === -4 || code === -3) return ok(code);
			if (code === 32 || code === -2 || code === -1) {
				effects.enter("whitespace");
				effects.consume(code);
				effects.exit("whitespace");
				return endLine;
			}
			return nok(code);
		}
	};
	return { tokenize, concrete: block, name: block ? "backslashMathBlock" : "backslashMathText" };
}

const enter: NonNullable<FromMarkdownExtension["enter"]>[string] = function (token) {
	const block = token.type === "backslashMathBlock";
	const display = token.type !== "backslashMathInline";
	const value = this.sliceSerialize(token).slice(2, -2).trim();
	const code = {
		type: "element" as const,
		tagName: "code",
		properties: { className: ["language-math", display ? "math-display" : "math-inline"] },
		children: [{ type: "text" as const, value }],
	};
	const node: Math | InlineMath = block
		? { type: "math", meta: null, value, data: { hName: "pre", hChildren: [code] } }
		: {
				type: "inlineMath",
				value,
				data: { hName: "code", hProperties: code.properties, hChildren: code.children },
			};
	this.enter(node, token);
};
const exit: NonNullable<FromMarkdownExtension["exit"]>[string] = function (token) {
	this.exit(token);
};

export default remarkBackslashMath;
