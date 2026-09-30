import { createStore } from "zustand/vanilla";
import type { Tool } from "../types";

export interface Todo {
  content: string;
  status: "pending" | "in_progress" | "completed";
}

export const todoStore = createStore<{ todos: Todo[] }>(() => ({ todos: [] }));

const STATUSES = ["pending", "in_progress", "completed"] as const;

export const todoWrite: Tool = {
  name: "todo_write",
  description:
    "Track a multi-step task. Send the FULL list every time; mark one item in_progress while working on it.",
  parameters: {
    type: "object",
    properties: {
      todos: {
        type: "array",
        items: {
          type: "object",
          properties: {
            content: { type: "string" },
            status: { type: "string", enum: [...STATUSES] },
          },
          required: ["content", "status"],
        },
      },
    },
    required: ["todos"],
  },
  execute({ todos }) {
    if (!Array.isArray(todos)) return "error: todos must be an array";
    const list = (todos as Array<Partial<Todo>>).map((t) => ({
      content: String(t.content ?? ""),
      status: STATUSES.includes(t.status as Todo["status"]) ? (t.status as Todo["status"]) : "pending",
    }));
    todoStore.setState({ todos: list });
    const done = list.filter((t) => t.status === "completed").length;
    return `todos updated (${done}/${list.length} done)`;
  },
};
