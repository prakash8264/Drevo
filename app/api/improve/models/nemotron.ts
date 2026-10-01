import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { ResolvedImproveModel } from "./gemini";

export const NEMOTRON_MODEL_ID = "nvidia/nemotron-3-ultra-550b-a55b:free";

export const NEMOTRON_NOT_CONFIGURED = "NEMOTRON_NOT_CONFIGURED";

export function resolveNemotronModel(): ResolvedImproveModel {
  const key = process.env.OPENROUTER_API_KEY?.trim();
  if (!key) throw new Error(NEMOTRON_NOT_CONFIGURED);
  return {
    short: "Nemotron",
    label: `Nemotron (${NEMOTRON_MODEL_ID})`,
    model: createOpenRouter({ apiKey: key })(NEMOTRON_MODEL_ID),
  };
}
