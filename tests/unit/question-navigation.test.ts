import { describe, expect, it, vi } from "vitest";
import { AgentService } from "../../server/agent-service-daemon.js";
import { fakeAgentService } from "../helpers/fake-session.js";

function setup() {
	const target = {
		cwd: "/project",
		getQuestionNavigation: vi.fn(),
		switchConversation: vi.fn().mockResolvedValue(undefined),
		sendNotice: vi.fn(),
	};
	const source = { getQuestionNavigation: vi.fn() };
	const service = fakeAgentService() as any;
	service.clients = new Map([
		["target", target],
		["source", source],
	]);
	service.takeOverConversation = vi.fn().mockResolvedValue(undefined);
	return { service, target, source };
}
describe("question source navigation", () => {
	it("opens a local source without transferring a conversation", async () => {
		const { service, target } = setup();
		target.getQuestionNavigation.mockReturnValue({
			conversationId: "child",
			rootConversationId: "root",
			cwd: "/project",
		});
		await service.navigateQuestion("target", "request");
		expect(target.switchConversation).toHaveBeenCalledWith("child");
		expect(service.takeOverConversation).not.toHaveBeenCalled();
	});
	it("transfers the root then resolves the child's potentially remapped identity", async () => {
		const { service, target, source } = setup();
		source.getQuestionNavigation.mockReturnValue({
			conversationId: "old-child",
			rootConversationId: "old-root",
			cwd: "/project",
		});
		target.getQuestionNavigation
			.mockReturnValueOnce(null)
			.mockReturnValue({ conversationId: "new-child", rootConversationId: "new-root", cwd: "/project" });
		await service.navigateQuestion("target", "request");
		expect(service.takeOverConversation).toHaveBeenCalledWith("target", "source", "old-root");
		expect(target.switchConversation).toHaveBeenCalledWith("new-child");
	});
	it("does not navigate requests from a different project", async () => {
		const { service, target, source } = setup();
		source.getQuestionNavigation.mockReturnValue({
			conversationId: "secret",
			rootConversationId: "root",
			cwd: "/other",
		});
		await service.navigateQuestion("target", "request");
		expect(service.takeOverConversation).not.toHaveBeenCalled();
		expect(target.switchConversation).not.toHaveBeenCalled();
		expect(target.sendNotice).toHaveBeenCalled();
	});
	it("does not switch to an untransferred source after takeover fails", async () => {
		const { service, target, source } = setup();
		source.getQuestionNavigation.mockReturnValue({
			conversationId: "child",
			rootConversationId: "root",
			cwd: "/project",
		});
		await service.navigateQuestion("target", "request");
		expect(target.switchConversation).not.toHaveBeenCalled();
	});
});
