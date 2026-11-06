#!/usr/bin/env node
import { performance } from "node:perf_hooks";
import assert from "node:assert/strict";
import { filterForkedParentSessions } from "../server/session-parser.ts";
import { serializeMessage, serializeStreamingMessage } from "../server/serialize.ts";

function medianRun(fn, rounds = 7) {
	fn();
	const samples = [];
	for (let i = 0; i < rounds; i++) {
		const start = performance.now();
		fn();
		samples.push(performance.now() - start);
	}
	return Number(samples.sort((a, b) => a - b)[Math.floor(samples.length / 2)].toFixed(3));
}

function previousForkPropagation(infos) {
	const children = new Map();
	for (const info of infos) if (info.parentSessionPath) children.set(info.parentSessionPath, info.path);
	const reachable = new Set(infos.filter((x) => !children.has(x.path)).map((x) => x.path));
	let changed = true;
	while (changed) {
		changed = false;
		for (const [parent, child] of children) {
			if (!reachable.has(parent) && reachable.has(child)) {
				reachable.add(parent);
				changed = true;
			}
		}
	}
	return infos.filter((x) => !children.has(x.path) || !reachable.has(x.path));
}

const forkResults = [512, 2048, 8192].map((size) => {
	const infos = Array.from({ length: size }, (_, i) => ({
		path: `/benchmark/${i}`,
		...(i ? { parentSessionPath: `/benchmark/${i - 1}` } : {}),
	}));
	assert.deepEqual(filterForkedParentSessions(infos), previousForkPropagation(infos));
	return {
		nodes: size,
		previousMs: medianRun(() => previousForkPropagation(infos), 3),
		optimizedMs: medianRun(() => filterForkedParentSessions(infos)),
	};
});

const message = {
	role: "assistant",
	timestamp: 123,
	model: "benchmark",
	provider: "benchmark",
	content: [
		{ type: "text", text: "Streaming answer. ".repeat(4000) },
		{ type: "thinking", thinking: "Reasoning. ".repeat(4000) },
		{ type: "toolCall", id: "benchmark", name: "bash", arguments: { command: "x".repeat(150000) } },
	],
};
const iterations = 100;
const previousStream = () => {
	const first = serializeMessage(message, 0);
	return { ...first, id: "stream-123", content: serializeMessage(message, 0).content };
};
assert.deepEqual(serializeStreamingMessage(message), previousStream());
const streamResults = {
	iterations,
	previousMs: medianRun(() => {
		for (let i = 0; i < iterations; i++) previousStream();
	}),
	optimizedMs: medianRun(() => {
		for (let i = 0; i < iterations; i++) serializeStreamingMessage(message);
	}),
};
console.log(
	JSON.stringify({ kind: "synthetic CPU microbenchmark", node: process.version, forkResults, streamResults }, null, 2),
);
