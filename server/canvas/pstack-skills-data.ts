/**
 * 画布 Pstack 技能目录（服务端视图）。
 *
 * 内容只在 `pstack-skills-content.ts` 存一份，这里补中文名——服务端渲染画布节点标题、
 * 拼中文提示词时用它，不参与前端 i18n。前端视图见
 * `web/src/components/canvas/pstack-skills-data.ts`。
 */
import { PSTACK_SKILLS_CONTENT, type PstackCategory, type PstackSkillContent } from "./pstack-skills-content.js";

export type { PstackCategory };

export interface PstackSkillItem extends PstackSkillContent {
	nameZh: string;
}

export const PSTACK_CATEGORIES: Record<PstackCategory, { zh: string; en: string }> = {
	core: {
		zh: "核心调度与剧本",
		en: "Core & Playbooks",
	},
	architecture: {
		zh: "架构设计与方案探索",
		en: "Architecture & Exploration",
	},
	principles: {
		zh: "核心工程原则（直击根因）",
		en: "Engineering Principles",
	},
	quality: {
		zh: "代码品质与去 AI 味",
		en: "Code Quality & Unslop",
	},
	verification: {
		zh: "实证验证与审计",
		en: "Verification & Audit",
	},
	communication: {
		zh: "协作沟通与复盘",
		en: "Collaboration & Review",
	},
};

/** 每个技能的中文显示名，键与 `PSTACK_SKILLS_CONTENT[].id` 一一对应。 */
const PSTACK_NAMES_ZH: Record<string, string> = {
	architect: "架构规约与模块先行",
	arena: "方案竞斗与杂交优胜",
	"automate-me": "个人工作流自动化提炼",
	"benchmark-checklist": "性能基准自检清单",
	"blast-radius": "爆炸半径实证分析",
	bro: "同行极简直白沟通风",
	correct: "行为与逻辑严格正确性求证",
	"create-formal-verification-skill": "形式化验证技能编写",
	"create-verification-skill": "创建可复现验证技能",
	"figure-it-out": "自主攻坚排查（破除僵局）",
	how: "多方案权衡与选型决断",
	"in-your-own-words": "深入浅出复述复杂概念",
	interrogate: "多模型对抗交叉质询",
	"ketchup-video": "视频多媒体追赶提要",
	ketchup: "工作进展追赶与对齐",
	"maintain-formal-verification-skill": "形式化验证技能维护",
	"maintain-verification-skill": "维护既有验证技能",
	"make-bot-ui": "Bot 界面设计与交互规范",
	"no-comments": "清理多余废话注释",
	"poteto-help": "Pstack 导航助手",
	"poteto-mode": "Poteto 严谨总指挥",
	"principle-attack-the-premise": "审视问题前提（破除局部假设）",
	"principle-boundary-discipline": "严守契约与模块边界",
	"principle-build-the-lever": "构建自动化杠杆（磨刀不误砍柴工）",
	"principle-encode-lessons-in-structure": "将历史教训沉淀入架构",
	"principle-exhaust-the-design-space": "穷尽设计空间（防局部最优）",
	"principle-experience-first": "第一开发者体验优先",
	"principle-explain-the-number": "深究指标背后物理事实",
	"principle-fix-root-causes": "直击根因（严禁表象修补）",
	"principle-foundational-thinking": "第一性原理底层思考",
	"principle-guard-the-context-window": "守护上下文窗口（防令牌爆炸）",
	"principle-laziness-protocol": "最小必要变更（克制无谓改动）",
	"principle-make-operations-idempotent": "保证操作幂等（抵御重试并发）",
	"principle-migrate-callers-then-delete-legacy-apis": "迁移调用方后彻底删旧接口",
	"principle-minimize-reader-load": "极简阅读负担（代码自解释）",
	"principle-model-the-domain": "领域模型先行（确立数据形状）",
	"principle-never-block-on-the-human": "绝不阻塞等待人类（自主验证推进）",
	"principle-outcome-oriented-execution": "结果导向交付（紧盯最终验收）",
	"principle-prove-it-works": "运行时实证（拿证据说话）",
	"principle-redesign-from-first-principles": "第一性原理彻底重构",
	"principle-separate-before-serializing-shared-state": "分离共享状态后再序列化",
	"principle-sequence-verifiable-units": "拆解为可独立验证单元",
	"principle-subtract-before-you-add": "能删绝不加（精简多余抽象）",
	"principle-test-behavior-not-implementation": "测试外部行为（不锁实现细节）",
	"principle-type-system-discipline": "类型严苛纪律（消灭 any 隐式丢失）",
	recall: "唤醒历史决策脉络",
	reflect: "深度反思与复盘提炼",
	"setup-pstack": "Pstack 环境模型配置",
	sharpen: "雕琢精炼（去除粗糙毛刺）",
	"show-me-your-work": "决策脉络与实证审计轨迹",
	statechart: "状态机建模与防御迁移",
	swarm: "矩阵式并行探索与测试",
	tdd: "测试驱动开发（红绿重构循环）",
	teach: "启发式技术指导与教学",
	"technical-writing": "高水准技术写作与 PR 描述",
	"typescript-best-practices": "TypeScript 工业级最佳实践",
	unslop: "去 AI 味与虚浮套话",
	why: "设计意图与历史决策溯源",
};

export const PSTACK_SKILLS: PstackSkillItem[] = PSTACK_SKILLS_CONTENT.map((skill) => ({
	...skill,
	nameZh: PSTACK_NAMES_ZH[skill.id] ?? skill.id,
}));

export const PSTACK_SKILLS_MAP: Record<string, PstackSkillItem> = Object.fromEntries(
	PSTACK_SKILLS.map((s) => [s.id, s]),
);
