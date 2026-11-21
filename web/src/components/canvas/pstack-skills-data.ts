import {
	PSTACK_SKILLS_CONTENT,
	type PstackCategory,
	type PstackSkillContent,
} from "../../../../server/canvas/pstack-skills-content.js";
import type { Translate } from "../../i18n";

export type { PstackCategory };

export interface PstackSkillItem extends PstackSkillContent {
	name: string;
}

type MessageKey = Parameters<Translate>[0];

export function getPstackCategories(t: Translate): Record<PstackCategory, string> {
	return {
		core: t("canvas.pstack.category.core"),
		architecture: t("canvas.pstack.category.architecture"),
		principles: t("canvas.pstack.category.principles"),
		quality: t("canvas.pstack.category.quality"),
		verification: t("canvas.pstack.category.verification"),
		communication: t("canvas.pstack.category.communication"),
	};
}

/** 技能名的 i18n 键，键与 `PSTACK_SKILLS_CONTENT[].id` 一一对应。 */
const PSTACK_NAME_KEYS: Record<string, MessageKey> = {
	architect: "canvas.pstack.skill.architect.name",
	arena: "canvas.pstack.skill.arena.name",
	"automate-me": "canvas.pstack.skill.automate-me.name",
	"benchmark-checklist": "canvas.pstack.skill.benchmark-checklist.name",
	"blast-radius": "canvas.pstack.skill.blast-radius.name",
	bro: "canvas.pstack.skill.bro.name",
	correct: "canvas.pstack.skill.correct.name",
	"create-formal-verification-skill": "canvas.pstack.skill.create-formal-verification-skill.name",
	"create-verification-skill": "canvas.pstack.skill.create-verification-skill.name",
	"figure-it-out": "canvas.pstack.skill.figure-it-out.name",
	how: "canvas.pstack.skill.how.name",
	"in-your-own-words": "canvas.pstack.skill.in-your-own-words.name",
	interrogate: "canvas.pstack.skill.interrogate.name",
	"ketchup-video": "canvas.pstack.skill.ketchup-video.name",
	ketchup: "canvas.pstack.skill.ketchup.name",
	"maintain-formal-verification-skill": "canvas.pstack.skill.maintain-formal-verification-skill.name",
	"maintain-verification-skill": "canvas.pstack.skill.maintain-verification-skill.name",
	"make-bot-ui": "canvas.pstack.skill.make-bot-ui.name",
	"no-comments": "canvas.pstack.skill.no-comments.name",
	"poteto-help": "canvas.pstack.skill.poteto-help.name",
	"poteto-mode": "canvas.pstack.skill.poteto-mode.name",
	"principle-attack-the-premise": "canvas.pstack.skill.principle-attack-the-premise.name",
	"principle-boundary-discipline": "canvas.pstack.skill.principle-boundary-discipline.name",
	"principle-build-the-lever": "canvas.pstack.skill.principle-build-the-lever.name",
	"principle-encode-lessons-in-structure": "canvas.pstack.skill.principle-encode-lessons-in-structure.name",
	"principle-exhaust-the-design-space": "canvas.pstack.skill.principle-exhaust-the-design-space.name",
	"principle-experience-first": "canvas.pstack.skill.principle-experience-first.name",
	"principle-explain-the-number": "canvas.pstack.skill.principle-explain-the-number.name",
	"principle-fix-root-causes": "canvas.pstack.skill.principle-fix-root-causes.name",
	"principle-foundational-thinking": "canvas.pstack.skill.principle-foundational-thinking.name",
	"principle-guard-the-context-window": "canvas.pstack.skill.principle-guard-the-context-window.name",
	"principle-laziness-protocol": "canvas.pstack.skill.principle-laziness-protocol.name",
	"principle-make-operations-idempotent": "canvas.pstack.skill.principle-make-operations-idempotent.name",
	"principle-migrate-callers-then-delete-legacy-apis":
		"canvas.pstack.skill.principle-migrate-callers-then-delete-legacy-apis.name",
	"principle-minimize-reader-load": "canvas.pstack.skill.principle-minimize-reader-load.name",
	"principle-model-the-domain": "canvas.pstack.skill.principle-model-the-domain.name",
	"principle-never-block-on-the-human": "canvas.pstack.skill.principle-never-block-on-the-human.name",
	"principle-outcome-oriented-execution": "canvas.pstack.skill.principle-outcome-oriented-execution.name",
	"principle-prove-it-works": "canvas.pstack.skill.principle-prove-it-works.name",
	"principle-redesign-from-first-principles": "canvas.pstack.skill.principle-redesign-from-first-principles.name",
	"principle-separate-before-serializing-shared-state":
		"canvas.pstack.skill.principle-separate-before-serializing-shared-state.name",
	"principle-sequence-verifiable-units": "canvas.pstack.skill.principle-sequence-verifiable-units.name",
	"principle-subtract-before-you-add": "canvas.pstack.skill.principle-subtract-before-you-add.name",
	"principle-test-behavior-not-implementation": "canvas.pstack.skill.principle-test-behavior-not-implementation.name",
	"principle-type-system-discipline": "canvas.pstack.skill.principle-type-system-discipline.name",
	recall: "canvas.pstack.skill.recall.name",
	reflect: "canvas.pstack.skill.reflect.name",
	"setup-pstack": "canvas.pstack.skill.setup-pstack.name",
	sharpen: "canvas.pstack.skill.sharpen.name",
	"show-me-your-work": "canvas.pstack.skill.show-me-your-work.name",
	statechart: "canvas.pstack.skill.statechart.name",
	swarm: "canvas.pstack.skill.swarm.name",
	tdd: "canvas.pstack.skill.tdd.name",
	teach: "canvas.pstack.skill.teach.name",
	"technical-writing": "canvas.pstack.skill.technical-writing.name",
	"typescript-best-practices": "canvas.pstack.skill.typescript-best-practices.name",
	unslop: "canvas.pstack.skill.unslop.name",
	why: "canvas.pstack.skill.why.name",
};

export function getPstackSkills(t: Translate): PstackSkillItem[] {
	return PSTACK_SKILLS_CONTENT.map((skill) => ({
		...skill,
		name: t(PSTACK_NAME_KEYS[skill.id]),
	}));
}

export function getPstackSkillsMap(t: Translate): Record<string, PstackSkillItem> {
	return Object.fromEntries(getPstackSkills(t).map((s) => [s.id, s]));
}
