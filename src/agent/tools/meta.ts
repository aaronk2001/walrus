import type { Tool } from "../types";

export const skillTool: Tool = {
  name: "skill",
  description: "Load a skill's full instructions by name (see the skills list in the system prompt). Follow them.",
  parameters: {
    type: "object",
    properties: { name: { type: "string", description: "Skill name" } },
    required: ["name"],
  },
  execute({ name }, ctx) {
    return ctx.readSkill?.(String(name)) ?? `error: no enabled skill named "${name}"`;
  },
};

export const agentTool: Tool = {
  name: "agent",
  description:
    "Hand a self-contained task to a specialist subagent. It works alone with its own tools and returns a report. Give it all the context it needs.",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "Agent name (see list below)" },
      task: { type: "string", description: "Complete task description" },
    },
    required: ["name", "task"],
  },
  async execute({ name, task }, ctx) {
    if (!ctx.runSubagent) return "error: subagents cannot start other agents";
    return ctx.runSubagent(String(name), String(task));
  },
};
