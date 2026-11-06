const name = "pi-webui-custom-prompt";
const inject = ["systemPrompt"];

function apply(ctx) {
	const text = (process.env.PI_WEB_DSH_CUSTOM_PROMPT ?? "").trim();
	if (!text) return;
	const order = ctx.systemPrompt.getSectionOrder("DEPLOYMENT_PERSONA_SUFFIX") + 50;
	ctx.effect(
		() =>
			ctx.systemPrompt.section({
				name: "pi-webui:custom-prompt",
				order,
				text,
			}),
		"pi-webui-custom-prompt.section()",
	);
}

export { apply, inject, name };
