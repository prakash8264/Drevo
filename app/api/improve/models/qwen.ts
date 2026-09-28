import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { ResolvedImproveModel } from "./gemini";

export const QWEN_MODEL_ID = "qwen/qwen3.8-27b:free";

export const QWEN_NOT_CONFIGURED = "QWEN_NOT_CONFIGURED";

export function resolveQwenModel(): ResolvedImproveModel {
  const key = process.env.OPENROUTER_API_KEY?.trim();
  if (!key) throw new Error(QWEN_NOT_CONFIGURED);
  return {
    short: "Qwen",
    label: `Qwen (${QWEN_MODEL_ID})`,
    model: createOpenRouter({ apiKey: key })(QWEN_MODEL_ID),
  };
}
