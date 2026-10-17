import { describe, expect, it } from "vitest";
import { contentFingerprint } from "../../server/agent-formatters.js";

type Msg = Parameters<typeof contentFingerprint>[0];
const msg = (content: unknown[]): Msg => ({ role: "assistant", content }) as unknown as Msg;

describe("contentFingerprint thinking-first collision (w12)", () => {
	it("empty thinking no longer collides with empty text (was txt:45h:0)", () => {
		const thk = contentFingerprint(msg([{ type: "thinking", thinking: "" }]));
		const txt = contentFingerprint(msg([{ type: "text", text: "" }]));
		expect(thk).not.toBe(txt);
		expect(thk).toMatch(/^thk:[0-9a-z]+:0$/);
		expect(txt).toBe("txt:45h:0");
	});

	it("same words in thinking vs text get distinct keys", () => {
		expect(contentFingerprint(msg([{ type: "thinking", thinking: "hello" }]))).not.toBe(
			contentFingerprint(msg([{ type: "text", text: "hello" }])),
		);
	});

	it("different thinking content differs; identical thinking is stable", () => {
		const a = contentFingerprint(msg([{ type: "thinking", thinking: "reason one" }]));
		const b = contentFingerprint(msg([{ type: "thinking", thinking: "reason two!" }]));
		expect(a).not.toBe(b);
		expect(contentFingerprint(msg([{ type: "thinking", thinking: "reason one" }]))).toBe(a);
	});

	it("toolCall-first keys by call id, apart from thinking/text", () => {
		const t1 = contentFingerprint(msg([{ type: "toolCall", id: "call-1", name: "read", arguments: {} }]));
		const t2 = contentFingerprint(msg([{ type: "toolCall", id: "call-2", name: "read", arguments: {} }]));
		expect(t1).toBe("tc:call-1");
		expect(t2).not.toBe(t1);
		expect(t1).not.toBe(contentFingerprint(msg([{ type: "thinking", thinking: "" }])));
		expect(t1).not.toBe(contentFingerprint(msg([{ type: "text", text: "" }])));
	});

	it("text/image/empty paths keep prior format", () => {
		expect(contentFingerprint(msg([{ type: "text", text: "abcd" }]))).toMatch(/^txt:[0-9a-z]+:4$/);
		expect(contentFingerprint(msg([{ type: "image", data: "abc" }]))).toBe("img:3");
		expect(contentFingerprint(msg([]))).toBe("empty");
	});
});
