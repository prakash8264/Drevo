import { createHash } from "node:crypto";
import { applyPatch, createPatch } from "diff";
import { z } from "zod";
import { isSafeFilePath } from "@/lib/validation";

export const MAX_PATCH_DEPTH = 4; // checkpoint plus at most four patches
export const VERSION_FORMAT = 1;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFile(value: unknown): value is Record<string, unknown> & { code: string } {
  return isRecord(value) && typeof value.code === "string";
}

function projectFiles(value: unknown): Record<string, Record<string, unknown> & { code: string }> | null {
  if (!isRecord(value) || !isRecord(value.files) ||
      !Object.entries(value.files).every(([path, file]) => isSafeFilePath(path) && isFile(file))) return null;
  return value.files as Record<string, Record<string, unknown> & { code: string }>;
}

// Sort object keys recursively; preserve arrays, code bytes, extra metadata,
// and JSON's omission of undefined properties just like the persisted payload.
export function canonicalVersionJson(value: unknown): string {
  const json = JSON.stringify(value, (_key, item) => isRecord(item)
    ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item);
  if (json === undefined) throw new Error("Invalid version payload");
  return json;
}

export function versionHash(value: unknown): string {
  return createHash("sha256").update(canonicalVersionJson(value)).digest("hex");
}

export function versionFileCount(value: unknown): number {
  return isRecord(value) && isRecord(value.files) ? Object.keys(value.files).length : 0;
}

const DeltaSchema = z.object({
  baseHash: z.string().regex(/^[a-f0-9]{64}$/),
  files: z.record(z.string().refine(isSafeFilePath), z.discriminatedUnion("op", [
    z.object({ op: z.literal("delete") }).strict(),
    z.object({ op: z.literal("replace"), value: z.unknown().refine(isFile) }).strict(),
    z.object({ op: z.literal("patch"), patch: z.string() }).strict(),
  ])),
  // All non-file metadata, including dependency removals and absent titles.
  metadata: z.record(z.string(), z.unknown()).refine((m) => !Object.hasOwn(m, "files")),
}).strict();

type Delta = z.infer<typeof DeltaSchema>;
export interface VersionPayload {
  kind: "snapshot" | "delta";
  fileData: unknown;
  delta: Delta | null;
  contentHash: string;
  fileCount: number;
  chainDepth: number;
  formatVersion: number;
}

export function applyVersionDelta(base: unknown, rawDelta: unknown, expectedHash: string): unknown {
  const delta = DeltaSchema.parse(rawDelta);
  if (versionHash(base) !== delta.baseHash) throw new Error("Version base checksum mismatch");
  const baseFiles = projectFiles(base);
  if (!baseFiles) throw new Error("Invalid version base files");
  const files: Record<string, unknown> = Object.assign(Object.create(null), baseFiles);
  for (const [path, change] of Object.entries(delta.files)) {
    if (change.op === "replace") files[path] = change.value;
    else {
      if (!Object.hasOwn(files, path) || !isFile(files[path])) throw new Error("Version file is missing");
      if (change.op === "delete") delete files[path];
      else {
        const code = applyPatch(files[path].code, change.patch, { fuzzFactor: 0, autoConvertLineEndings: false });
        if (code === false) throw new Error("Version text patch cannot be applied");
        files[path] = { ...files[path], code };
      }
    }
  }
  const result = { ...delta.metadata, files };
  if (versionHash(result) !== expectedHash) throw new Error("Version result checksum mismatch");
  return result;
}

export function buildVersionPayload(target: unknown, base?: { fileData: unknown; chainDepth: number }): VersionPayload {
  const json = canonicalVersionJson(target);
  const normalized: unknown = JSON.parse(json);
  const snapshot: VersionPayload = {
    kind: "snapshot", fileData: normalized, delta: null, contentHash: versionHash(normalized),
    fileCount: versionFileCount(normalized), chainDepth: 0, formatVersion: VERSION_FORMAT,
  };
  if (!base || base.chainDepth >= MAX_PATCH_DEPTH) return snapshot;
  const before = projectFiles(base.fileData), after = projectFiles(normalized);
  if (!before || !after || !isRecord(normalized)) return snapshot;
  const changes: Delta["files"] = Object.create(null);
  const deadline = Date.now() + 250;
  for (const path of Object.keys(before)) if (!Object.hasOwn(after, path)) changes[path] = { op: "delete" };
  for (const [path, file] of Object.entries(after)) {
    if (Object.hasOwn(before, path) && canonicalVersionJson(before[path]) === canonicalVersionJson(file)) continue;
    changes[path] = { op: "replace", value: file };
    if (!Object.hasOwn(before, path) || Date.now() >= deadline) continue;
    const oldMetadata = { ...before[path], code: undefined }, newMetadata = { ...file, code: undefined };
    if (canonicalVersionJson(oldMetadata) !== canonicalVersionJson(newMetadata)) continue;
    const patch = createPatch("file", before[path].code, file.code, undefined, undefined, {
      context: 3, timeout: 50, maxEditLength: 1000,
    });
    if (patch === undefined) continue;
    const textChange = { op: "patch" as const, patch };
    if (Buffer.byteLength(JSON.stringify(textChange)) < Buffer.byteLength(JSON.stringify(changes[path])) &&
        applyPatch(before[path].code, patch, { fuzzFactor: 0, autoConvertLineEndings: false }) === file.code) {
      changes[path] = textChange;
    }
  }
  const delta: Delta = {
    baseHash: versionHash(base.fileData), files: changes,
    metadata: Object.fromEntries(Object.entries(normalized).filter(([key]) => key !== "files")),
  };
  // Small projects/large rewrites shouldn't pay more for patches than snapshots.
  if (Buffer.byteLength(JSON.stringify(delta)) + 128 >= Buffer.byteLength(json)) return snapshot;
  applyVersionDelta(base.fileData, delta, snapshot.contentHash); // verify before persisting
  return { ...snapshot, kind: "delta", fileData: null, delta, chainDepth: base.chainDepth + 1 };
}
