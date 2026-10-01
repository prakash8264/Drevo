import { saveAiWorkspace } from "@/lib/workspace-save";
import { validateApp } from "@/lib/ai-request";
import type { FileData, Message } from "@/types/workspace";

export async function validateDependencies(deps: Record<string, string>): Promise<Record<string, string>> {
  const valid: Record<string, string> = {};
  await Promise.all(Object.entries(deps).map(async ([pkg, version]) => {
    try {
      const res = await fetch(`https://registry.npmjs.org/${pkg}/latest`, { signal: AbortSignal.timeout(1500) });
      if (res.ok) valid[pkg] = version;
    } catch { /* Skip unknown packages. */ }
  }));
  return valid;
}

export function diffPaths(current: Record<string, { code: string }>, base: Record<string, { code: string }>): string[] {
  return Object.keys(current).filter((p) => current[p]?.code !== base[p]?.code);
}

export interface FinishRunArgs {
  workspaceId: string; revision: number; orgId: string; userId: string; signal: AbortSignal;
  userRequest: string; imageUrl?: string; messages?: Message[]; baseFileData: FileData;
  getState: () => { files: Record<string, { code: string }>; dependencies: Record<string, string> };
  enqueueDone: (payload: { fileData: FileData; summary: string; partial: boolean; creditsRemaining: number; revision: number }) => void;
}

export function createFinishRun(args: FinishRunArgs) {
  return async (summary: string, partial: boolean): Promise<void> => {
    args.signal.throwIfAborted();
    const state = args.getState();
    validateApp({ ...state, title: args.baseFileData.title });
    const validatedDeps = await validateDependencies(state.dependencies);
    args.signal.throwIfAborted();
    const fileData: FileData = { files: state.files, dependencies: validatedDeps, title: args.baseFileData.title };
    const messages: Message[] = (args.messages?.length ? args.messages : [{ role: "user" as const, content: args.userRequest }]).map((m, i, all) =>
      i === all.length - 1 && m.role === "user" && args.imageUrl ? { ...m, imageUrl: args.imageUrl } : m
    );
    const saved = await saveAiWorkspace({ ...args, fileData, summary, messages: [...messages, { role: "assistant", content: summary }] });
    args.enqueueDone({ fileData, summary, partial, creditsRemaining: saved.creditsRemaining, revision: saved.revision });
  };
}
