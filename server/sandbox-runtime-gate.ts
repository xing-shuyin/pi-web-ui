import type { SandboxInfo } from "./protocol.js";
import { evaluateSandboxJail } from "./sandbox-service.js";

const HOST_CAPABILITIES = new Set(["read", "write", "edit", "edit_soft", "patch", "present_files", "sandbox"]);

type Definition = { name: string; execute: unknown };
type Session = { getToolDefinition(name: string): Definition | undefined };

export function createSandboxRuntimeGate(getSandbox: () => SandboxInfo | undefined, cwd: string) {
	const trusted = new Map<string, { definition: Definition; execute: unknown }>();
	let session: Session | undefined;
	return {
		seal(hostSession: Session, hostDefinitions: readonly Definition[]) {
			if (session) throw new Error("Sandbox runtime provenance is already sealed");
			session = hostSession;
			for (const definition of hostDefinitions) {
				if (HOST_CAPABILITIES.has(definition.name) && hostSession.getToolDefinition(definition.name) === definition) {
					trusted.set(definition.name, { definition, execute: definition.execute });
				}
			}
		},
		check(event: { toolName: string; input: Record<string, unknown> }) {
			try {
				const sandbox = getSandbox();
				if (!sandbox) return;
				const sealed = trusted.get(event.toolName);
				const current = session?.getToolDefinition(event.toolName);
				const denial = evaluateSandboxJail(sandbox, event.toolName, event.input, cwd, {
					trustedTool: Boolean(sealed && current === sealed.definition && current.execute === sealed.execute),
				});
				if (denial) return { block: true as const, reason: denial.reasonEn };
			} catch {
				return { block: true as const, reason: "Sandbox identity or tool provenance could not be verified." };
			}
		},
	};
}

export function sandboxExtensionOptions(sandbox: boolean) {
	return sandbox ? { noExtensions: true, additionalExtensionPaths: [] as string[] } : {};
}
