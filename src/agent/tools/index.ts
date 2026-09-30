import type { Tool, ToolSchema } from "../types";
import { readFile, writeFile, editFile, listDir, grep } from "./fs";
import { bash } from "./shell";
import { webFetch, webSearch } from "./web";
import { todoWrite } from "./todo";
import { skillTool, agentTool } from "./meta";

export const ALL_TOOLS: Tool[] = [
  readFile,
  writeFile,
  editFile,
  listDir,
  grep,
  bash,
  webFetch,
  webSearch,
  todoWrite,
  skillTool,
  agentTool,
];

export const toSchema = (t: Tool, description = t.description): ToolSchema => ({
  type: "function",
  function: { name: t.name, description, parameters: t.parameters },
});
