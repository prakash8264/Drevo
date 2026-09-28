import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { ResolvedImproveModel } from "./gemini";

export const ATRIA_MODEL_ID = "Atria-Dawn-Preview";
// Atria exposes standard Chat Completions (OpenAI-compatible) — unlike the
// parked Muse Spark path, no Responses-only adaptation is needed. Exact
// capitalization of the model ID matters.
export const ATRIA_BASE_URL = "https://api.atria-asi.ai/v1";

export const ATRIA_NOT_CONFIGURED = "ATRIA_NOT_CONFIGURED";

export function resolveAtriaModel(): ResolvedImproveModel {
  const key = process.env.ATRIA_API_KEY?.trim();
  if (!key) throw new Error(ATRIA_NOT_CONFIGURED);
  return {
    short: "Atria",
    label: `Atria (${ATRIA_MODEL_ID})`,
    model: createOpenAICompatible({
      name: "Atria",
      baseURL: ATRIA_BASE_URL,
      apiKey: key,
    })(ATRIA_MODEL_ID),
  };
}
