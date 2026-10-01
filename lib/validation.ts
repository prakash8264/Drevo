export function requireId(value: unknown, label = "ID"): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.length > 100) {
    throw Object.assign(new Error(`Invalid ${label}`), { status: 400 });
  }
}

export function isSafeFilePath(path: string): boolean {
  const relative = path.startsWith("/") ? path.slice(1) : path;
  return relative.length > 0 && relative.length <= 250 &&
    !/[\\\x00-\x1f:\x7f]/.test(relative) &&
    relative.split("/").every((part) => part !== "" && part !== "." && part !== ".." && part.toLowerCase() !== ".git");
}
