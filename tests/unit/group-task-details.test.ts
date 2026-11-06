// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GroupTaskDetails } from "../../web/src/components/GroupTaskDetails";
import type { DeviceTaskDetails } from "../../server/protocol";

vi.mock("../../web/src/i18n", () => ({ useI18n: () => ({ locale: "en" }), isZhLocale: () => false }));

const details: DeviceTaskDetails = {
	task: {
		id: "source-task",
		accountId: "account",
		roomId: "room",
		deviceId: "device",
		botId: "bot",
		text: "Implement feature",
		status: "completed",
		attemptId: "attempt",
		createdAt: 1,
		updatedAt: 2,
	},
	interactionCount: 0,
	interactions: [],
	deliveries: [
		{
			id: "artifact-delivery",
			summary: "Feature delivered",
			passed: false,
			reportedCheckCount: 0,
			artifactRef: {
				artifactTaskId: "source-task",
				attemptId: "attempt",
				artifactId: "artifact",
				artifactDigest: "artifact-digest",
				contractId: "contract",
				contractRevision: 1,
				contractDigest: "contract-digest",
				manifestDigest: "manifest",
				baselineCommit: "a".repeat(40),
				repositoryId: "repo",
				inputTree: "input-tree",
				outputTree: "output-tree",
			},
		},
		{
			id: "legacy-delivery",
			summary: "Legacy delivered",
			passed: true,
			reportedCheckCount: 1,
			commit: "b".repeat(40),
			branch: "feature/legacy",
		},
	],
};
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
	localStorage.clear();
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
});
afterEach(() => {
	act(() => root.unmount());
	host.remove();
	vi.unstubAllGlobals();
});

async function render(data = details) {
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string) => ({
			ok: true,
			json: async () => (url.includes("/journal?") ? { items: [], hasMore: false } : data),
		})),
	);
	await act(async () =>
		root.render(createElement(GroupTaskDetails, { roomId: "room", taskId: "source-task", onClose: vi.fn() })),
	);
}

describe("GroupTaskDetails delivery subjects", () => {
	it.each([
		{ reportedCheckCount: 0, passed: false, label: "No reported checks" },
		{ reportedCheckCount: 1, passed: true, label: "Reported checks passed" },
		{ reportedCheckCount: 1, passed: false, label: "Reported checks not passed" },
		{ reportedCheckCount: undefined, passed: true, label: "Reported checks passed" },
	])("labels $reportedCheckCount reported checks as $label", async ({ label, ...reported }) => {
		await render({ ...details, deliveries: [{ ...details.deliveries[0], ...reported }] });
		const item = host.querySelector(".gtd-delivery-item")!;
		expect(item.querySelector('.gtd-delivery-header span[class^="gtd-badge"]')!.textContent).toBe(label);
		if (reported.reportedCheckCount === 0) expect(item.querySelector(".gtd-badge-completed")).toBeNull();
	});

	it("renders artifact delivery identity, source and tree without a commit while preserving legacy commit display", async () => {
		await render();
		expect(host.querySelector('[role="alert"]')).toBeNull();
		const deliveries = host.querySelectorAll(".gtd-delivery-item");
		expect(deliveries).toHaveLength(2);
		for (const identity of ["artifact-delivery", "artifact-digest", "source-task", "output-tree", "Feature delivered"])
			expect(deliveries[0].textContent).toContain(identity);
		expect(deliveries[0].querySelector(".gtd-commit-sha")).toBeNull();
		expect(deliveries[1].querySelector(".gtd-commit-sha")!.textContent).toBe("bbbbbbbb");
		expect(deliveries[1].textContent).toContain("feature/legacy");
	});
});
