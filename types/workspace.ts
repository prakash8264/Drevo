// ─── Workspace & Chat Types ───────────────────────────────────────────────────

// Edit-model toggle for follow-up improve runs. Generation (first prompt)
// is always Gemini; only the agent patch path offers a choice.
export type EditModelId = "gemini" | "qwen" | "atria";

export type MessageRole = "user" | "assistant";

export interface Message {
  role: MessageRole;
  content: string;
  imageUrl?: string;
}

export interface FileData {
  files: Record<string, { code: string }>;
  dependencies: Record<string, string>;
  title?: string;
}

export interface StatusStep {
  label: string;
  status: "running" | "done";
}

export interface WorkspaceData {
  id: string;
  revision: number;
  title: string | null;
  messages: unknown;
  fileData: unknown;
  githubRepoUrl: string | null;
  githubRepoFullName: string | null;
  githubBranch: string | null;
  lastPushedAt: string | null;
}

export interface WorkspaceUser {
  id: string;
  orgId: string;
  orgName: string;
  credits: number; // organization shared balance (display only; DB truth is Organization.credits)
  plan: string; // organization plan
  role: "OWNER" | "ADMIN" | "MEMBER";
  githubConnected: boolean;
  githubUsername: string | null;
}
