import { tool } from "ai";
import { z } from "zod";

// Mutable per-run accumulation, owned by the route (finishRun, getChangedPaths
// and the NO_OP check all read these same objects, so the factory mutates in
// place rather than returning copies).
export interface ImprovePatchState {
  files: Record<string, { code: string }>;
  dependencies: Record<string, string>;
  setSummary: (summary: string) => void;
}

export function createImproveTools(
  state: ImprovePatchState,
  emitFilePatch: (path: string, code: string, reason: string) => void
) {
  // Tool 1: update_file — the agent calls this once per file it wants to
  // change. We immediately emit a file_patch SSE event so Sandpack updates
  // live in the browser as each file is patched.
  const updateFileTool = tool({
    description:
      "Update or rewrite a file in the React sandbox. Call once per file you need to change.",
    inputSchema: z.object({
      path: z
        .string()
        .describe("File path exactly as it appears, e.g. /App.js"),
      code: z.string().describe("Complete new contents of the file"),
      reason: z
        .string()
        .describe("One sentence explaining what you changed and why"),
    }),
    execute: async ({ path, code, reason }) => {
      state.files[path] = { code };
      // Emit live patch — client applies it to Sandpack immediately
      emitFilePatch(path, code, reason);
      return `Updated ${path}: ${reason}`;
    },
  });

  // Tool 2: add_dependency — lets the agent add an npm package when the edit
  // needs one (e.g. framer-motion). Validated against npm registry in
  // finishRun before anything is saved.
  const addDependencyTool = tool({
    description:
      "Add an npm package the edited code needs. Only use packages that exist on npm.",
    inputSchema: z.object({
      package: z.string().describe("npm package name, e.g. framer-motion"),
      version: z
        .string()
        .default("latest")
        .describe("Version range, default latest"),
    }),
    execute: async ({ package: pkg, version }) => {
      state.dependencies[pkg] = version || "latest";
      return `Added dependency ${pkg}@${version || "latest"}`;
    },
  });

  // Tool 3: done_improving — the agent calls this when all files are updated.
  // The hasToolCall stop condition ends the loop right after it runs.
  const doneImprovingTool = tool({
    description: "Call this when you have finished making all changes.",
    inputSchema: z.object({
      summary: z
        .string()
        .describe(
          "A short friendly summary of all the changes you made (1-3 sentences)"
        ),
    }),
    execute: async ({ summary }) => {
      state.setSummary(summary);
      return "Done.";
    },
  });

  return { updateFileTool, addDependencyTool, doneImprovingTool };
}

export type ImproveTools = ReturnType<typeof createImproveTools>;
