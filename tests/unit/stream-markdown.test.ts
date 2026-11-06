import { describe, expect, it } from "vitest";
import { segmentStream, stepSmoothStream } from "../../web/src/stream-markdown.js";

describe("segmentStream", () => {
	it("空文本 → 无 frozen、无 active", () => {
		const s = segmentStream("");
		expect(s.frozen).toEqual([]);
		expect(s.active).toBe("");
		expect(s.inFence).toBe(false);
	});

	it("单个未完结段落全部留在 active", () => {
		const s = segmentStream("这是第一行\n第二行还在写");
		expect(s.frozen).toEqual([]);
		expect(s.active).toBe("这是第一行\n第二行还在写");
	});

	it("空行分隔的完整段落冻结，尾部留 active", () => {
		const text = "第一段。\n\n第二段完整了。\n\n第三段写到一半";
		const s = segmentStream(text);
		expect(s.frozen).toEqual(["第一段。", "第二段完整了。"]);
		expect(s.active).toBe("第三段写到一半");
	});

	it("frozen 段落在追加后保持不变（append-only 稳定性）", () => {
		const before = segmentStream("段落一。\n\n段落二。");
		const after = segmentStream("段落一。\n\n段落二。\n\n段落三。");
		expect(after.frozen.slice(0, before.frozen.length)).toEqual(before.frozen);
		expect(before.active).toBe("段落二。");
		expect(after.frozen).toContain("段落二。");
	});

	it("未闭合代码围栏：围栏及之后内容留在 active 且 inFence=true", () => {
		const text = "看这个：\n\n```python\ndef foo():\n    return 1";
		const s = segmentStream(text);
		expect(s.frozen).toEqual(["看这个："]);
		expect(s.active).toBe("```python\ndef foo():\n    return 1");
		expect(s.inFence).toBe(true);
	});

	it("闭合代码围栏正常冻结（含代码块整体）", () => {
		const text = "说明。\n\n```js\nconsole.log(1);\n```\n\n下一段";
		const s = segmentStream(text);
		expect(s.frozen).toEqual(["说明。", "```js\nconsole.log(1);\n```"]);
		expect(s.active).toBe("下一段");
		expect(s.inFence).toBe(false);
	});

	it("波浪线围栏同样识别；短闭合线不结束长开线", () => {
		let s = segmentStream("~~~js\nx = `~~`;\n~");
		expect(s.inFence).toBe(true);
		s = segmentStream("~~~js\nx = 1;\n~~~\n\n后文");
		expect(s.inFence).toBe(false);
		expect(s.frozen[0]).toContain("x = 1;");
	});

	it("空行 + 列表标记不切分（loose list 保持编号连续）", () => {
		const text = "1. 第一项\n\n2. 第二项\n\n3. 第三项";
		const s = segmentStream(text);
		expect(s.frozen).toEqual([]);
		expect(s.active).toBe(text);
	});

	it("无序列表同理不切分", () => {
		const text = "- a\n\n- b";
		const s = segmentStream(text);
		expect(s.frozen).toEqual([]);
		expect(s.active).toBe(text);
	});

	it("列表结束后继续普通段落可正常冻结", () => {
		const text = "1. a\n\n2. b\n\n总结：完了。\n\n新的开头";
		const s = segmentStream(text);
		expect(s.frozen).toEqual(["1. a\n\n2. b", "总结：完了。"]);
		expect(s.active).toBe("新的开头");
	});

	it("围栏内出现类似 ``` 的内容不会误判为边界", () => {
		const text = '```bash\necho "```"\nmore\n```\n\n后文';
		const s = segmentStream(text);
		expect(s.frozen[0]).toContain('echo "```"');
		expect(s.inFence).toBe(false);
	});
});

describe("stepSmoothStream — 自适应平滑流式步进（大段接收、逐字细腻丝滑渲染）", () => {
	it("中小积压（backlog <= 32）时每步严格推进 1 个字符（逐字打字机感）", () => {
		const target = "你好世界，这是一段测试文本，用来验证单字细腻吐出区间";
		expect(stepSmoothStream(target, 5)).toBe(6);
		expect(stepSmoothStream(target, 12)).toBe(13);
	});

	it("大段脉冲到达（如一次收到 140 字符）时拆分为细腻多步平滑推进，绝不一次性蹦出整段", () => {
		const target = "A".repeat(140);
		const next = stepSmoothStream(target, 0);
		expect(next).toBe(5);
		let cur = 0;
		let frames = 0;
		while (cur < target.length) {
			cur = stepSmoothStream(target, cur);
			frames++;
		}
		expect(cur).toBe(140);
		expect(frames).toBeGreaterThan(45);
	});

	it("UTF-16 代理对（Emoji）边界安全：绝不把双码元字符劈成两半", () => {
		const target = "Hi🚀!后续文字";
		expect(stepSmoothStream(target, 2)).toBe(4);
		expect(target.slice(0, stepSmoothStream(target, 2))).toBe("Hi🚀");
	});
});
