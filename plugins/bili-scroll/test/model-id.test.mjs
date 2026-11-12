import assert from "node:assert/strict";
import test from "node:test";

import { normalizeModelId } from "../lib/model-id.mjs";

test("模型 id：重复 provider 前缀收敛成一份", () => {
	assert.equal(normalizeModelId("opencode-go/opencode-go/longcat-2.5-free"), "opencode-go/longcat-2.5-free");
	assert.equal(normalizeModelId("deepseek/deepseek/deepseek-flash"), "deepseek/deepseek-flash");
});

test("模型 id：正常 id、空值、非重复前缀都不动", () => {
	assert.equal(normalizeModelId("opencode-go/longcat-2.5-free"), "opencode-go/longcat-2.5-free");
	assert.equal(normalizeModelId("claude-sonnet-5"), "claude-sonnet-5");
	assert.equal(normalizeModelId(""), "");
	assert.equal(normalizeModelId(undefined), "");
	assert.equal(normalizeModelId("  opencode-go/beam-free  "), "opencode-go/beam-free");
	// 两段但前缀不同，不是重复拼接
	assert.equal(normalizeModelId("opencode-go/deepseek-v4.1-flash"), "opencode-go/deepseek-v4.1-flash");
});
