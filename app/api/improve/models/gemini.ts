import { createGoogleGenerativeAI } from "@ai-sdk/google";
import type { LanguageModel } from "ai";

export const GEMINI_MODEL_ID = "gemini-3.5-flash";

// Everything a run needs from a model: display names plus a resolver that
// builds the provider-bound LanguageModel. Resolvers throw a sentinel
// `<NAME>_NOT_CONFIGURED` Error on missing keys — the route answers those
// with a clean free 400, never a stack trace.
export interface ResolvedImproveModel {
  short: "Gemini" | "Qwen" | "Spark";
  label: string;
  model: LanguageModel;
}

export const GEMINI_NOT_CONFIGURED = "GEMINI_NOT_CONFIGURED";

export function resolveGeminiModel(
  modelId: string = GEMINI_MODEL_ID
): ResolvedImproveModel {
  const key = process.env.GEMINI_API_KEY?.trim();
  if (!key) throw new Error(GEMINI_NOT_CONFIGURED);
  return {
    short: "Gemini",
    label: `Gemini (${modelId})`,
    model: createGoogleGenerativeAI({ apiKey: key })(modelId),
  };
}
