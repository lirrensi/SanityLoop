// sanity/src/extras/basic/atomic.ts — tiny atomic file write (temp + rename).
import { writeFile, rename, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";

/** Write a file atomically: temp file + rename, falls back to plain write. */
export async function writeAtomic(p: string, content: string): Promise<void> {
  const dir = dirname(p);
  await mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.tmp-${randomUUID()}`);
  await writeFile(tmp, content, "utf8");
  try {
    await rename(tmp, p);
  } catch {
    await writeFile(p, content, "utf8");
    await rm(tmp, { force: true }).catch(() => undefined);
  }
}
