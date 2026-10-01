import type { EditModelId } from "@/types/workspace";
import type { ResolvedImproveModel } from "./gemini";
import { resolveGeminiModel, GEMINI_NOT_CONFIGURED } from "./gemini";
import { resolveNemotronModel, NEMOTRON_NOT_CONFIGURED } from "./nemotron";
import { resolveAtriaModel, ATRIA_NOT_CONFIGURED } from "./atria";

export {
  GEMINI_NOT_CONFIGURED,
  NEMOTRON_NOT_CONFIGURED,
  ATRIA_NOT_CONFIGURED,
  resolveGeminiModel,
};
export type { ResolvedImproveModel };

// Generation (gen-ai-code) is always Gemini. Only improve() offers a choice,
// toggled per prompt in the chat panel and validated to this allowlist — a
// raw client model string is never passed to any provider. EditModelId lives
// in @/types/workspace (shared with the client); request validation rejects
// unknown values, and an omitted selection defaults to Gemini.
export function resolveImproveModel(
  selection: EditModelId
): ResolvedImproveModel {
  if (selection === "nemotron") return resolveNemotronModel();
  if (selection === "atria") return resolveAtriaModel();
  return resolveGeminiModel();
}

// Sentinel payloads the route answers with a clean free 400 (pre-stream,
// so no credit is ever touched by a misconfigured path).
export function notConfiguredResponse(selection: EditModelId): {
  message: string;
  code: string;
} {
  if (selection === "nemotron") {
    return {
      message:
        "Nemotron edits aren't configured on this server yet. Switch back to Gemini or ask the owner to add an OpenRouter key.",
      code: NEMOTRON_NOT_CONFIGURED,
    };
  }
  if (selection === "atria") {
    return {
      message:
        "Atria edits aren't configured on this server yet. Switch back to Gemini or ask the owner to add an ATRIA_API_KEY.",
      code: ATRIA_NOT_CONFIGURED,
    };
  }
  return {
    message:
      "Gemini edits aren't configured on this server yet. Check the server's GEMINI_API_KEY.",
    code: GEMINI_NOT_CONFIGURED,
  };
}
