import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { ResolvedImproveModel } from "./gemini";

export const GLM_MODEL_ID = "z-ai/glm-5.3-flash";
export const NVIDIA_BASE_URL = "https://integrate.api.nvidia.com/v1";

export const GLM_NOT_CONFIGURED = "GLM_NOT_CONFIGURED";

export function resolveGlmModel(): ResolvedImproveModel {
  const key = process.env.NVIDIA_API_KEY?.trim();
  if (!key) throw new Error(GLM_NOT_CONFIGURED);
  return {
    short: "GLM",
    label: `GLM-5.3-Flash (NVIDIA: ${GLM_MODEL_ID})`,
    model: createOpenAICompatible({
      name: "NVIDIA",
      baseURL: NVIDIA_BASE_URL,
      apiKey: key,
      // NVIDIA defaults to a 1,024-token output and maximum reasoning budget.
      // Leave room for complete file tool arguments and use low reasoning for
      // interactive edits. NVIDIA recommends clear_thinking for chat scenarios.
      transformRequestBody: (body) => ({
        ...body,
        max_tokens: body.max_tokens ?? 16384,
        reasoning_effort: "low",
        chat_template_kwargs: { clear_thinking: true },
      }),
    })(GLM_MODEL_ID),
  };
}
