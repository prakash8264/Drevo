import { createOpenAI } from "@ai-sdk/openai";
import type { ResolvedImproveModel } from "./gemini";

export const SPARK_MODEL_ID = "muse-spark-1.3-contributor-free";
// Zen base WITHOUT the trailing /responses: the provider appends
// path "/responses" itself, so passing the full endpoint URL would double
// it (.../responses/responses). Verified in @ai-sdk/openai dist.
export const SPARK_BASE_URL = "https://opencode.ai/zen/v1";

export const SPARK_NOT_CONFIGURED = "SPARK_NOT_CONFIGURED";

export function resolveSparkModel(): ResolvedImproveModel {
  const key = process.env.OPENCODE_ZEN_API_KEY?.trim();
  if (!key) throw new Error(SPARK_NOT_CONFIGURED);
  return {
    short: "Spark",
    label: `Spark (${SPARK_MODEL_ID})`,
    // Responses API ONLY — Zen answers /chat/completions for this model
    // with a misleading 500. The .responses() interface targets the
    // correct endpoint (see SPARK_BASE_URL note above).
    model: createOpenAI({ baseURL: SPARK_BASE_URL, apiKey: key }).responses(
      SPARK_MODEL_ID
    ),
  };
}
