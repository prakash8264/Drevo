import { db } from "@/lib/prisma";
import { CREDIT_COST_PER_GENERATION } from "@/lib/constants";
import { pruneVersions } from "@/actions/versions";
import type { FileData, Message } from "@/types/workspace";

// Moved here from route.ts so the finish path lives with the agent code.
// (gen-ai-code keeps its own identical copy on purpose — sharing it would
// touch that route, which is out of scope for the improve split.)
export async function validateDependencies(
  deps: Record<string, string>
): Promise<Record<string, string>> {
  const valid: Record<string, string> = {};
  await Promise.all(
    Object.entries(deps).map(async ([pkg, version]) => {
      try {
        const res = await fetch(`https://registry.npmjs.org/${pkg}/latest`, {
          signal: AbortSignal.timeout(1500),
        });
        if (res.ok) valid[pkg] = version;
      } catch {
        // silently skip hallucinated packages
      }
    })
  );
  return valid;
}

// Which files actually changed vs what the run started with?
// (covers edited paths and newly added ones)
export function diffPaths(
  current: Record<string, { code: string }>,
  base: Record<string, { code: string }>
): string[] {
  return Object.keys(current).filter((p) => current[p]?.code !== base[p]?.code);
}

export interface FinishRunArgs {
  workspaceId: string;
  userId: string;
  userRequest: string;
  imageUrl?: string;
  messages?: Message[];
  baseFileData: FileData;
  userCredits: number;
  getState: () => {
    files: Record<string, { code: string }>;
    dependencies: Record<string, string>;
  };
  enqueueDone: (payload: {
    fileData: FileData;
    summary: string;
    partial: boolean;
    creditsRemaining: number;
  }) => void;
}

// Shared finish: validate deps + save messages/fileData + emit done.
// Used by both the success path and the partial-save path. Both deduct
// 1 credit — kept work always costs one, per project billing rules.
export function createFinishRun(args: FinishRunArgs) {
  const buildMessagesWithImage = (): Message[] => {
    const baseMessages: Message[] =
      args.messages && args.messages.length > 0
        ? args.messages
        : [
            {
              role: "user",
              content: args.userRequest,
              ...(args.imageUrl ? { imageUrl: args.imageUrl } : {}),
            } as Message,
          ];
    // Ensure the user message carries the imageUrl for /projects + reloads
    return baseMessages.map((m, i) =>
      i === baseMessages.length - 1 && m.role === "user" && args.imageUrl
        ? { ...m, imageUrl: args.imageUrl }
        : m
    );
  };

  return async (summary: string, partial: boolean): Promise<void> => {
    const state = args.getState();
    const validatedDeps = await validateDependencies(state.dependencies);
    const newFileData: FileData = {
      files: state.files,
      dependencies: validatedDeps,
      title: args.baseFileData.title,
    };
    const updatedMessages: Message[] = [
      ...buildMessagesWithImage(),
      { role: "assistant", content: summary },
    ];

    await db.$transaction([
      db.workspace.update({
        where: { id: args.workspaceId, userId: args.userId },
        data: {
          messages: updatedMessages as never,
          fileData: newFileData as never,
        },
      }),
      // Snapshot the pre-run files so the edit stays restorable.
      db.workspaceVersion.create({
        data: {
          workspaceId: args.workspaceId,
          fileData: args.baseFileData as never,
          summary: args.userRequest.slice(0, 120),
        },
      }),
      db.user.update({
        where: { id: args.userId },
        data: { credits: { decrement: CREDIT_COST_PER_GENERATION } },
      }),
    ]);

    await pruneVersions(args.workspaceId);

    const updatedUser = await db.user.findUnique({
      where: { id: args.userId },
      select: { credits: true },
    });

    args.enqueueDone({
      fileData: newFileData,
      summary,
      partial,
      creditsRemaining:
        updatedUser?.credits ?? args.userCredits - CREDIT_COST_PER_GENERATION,
    });
  };
}
