import type { FileData } from "./workspace";

export interface VersionSummary {
  id: string;
  summary: string | null;
  fileCount: number;
  createdAt: Date;
}

export interface VersionDetail extends VersionSummary {
  fileData: FileData;
}
