import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { StageSpec } from "./types.ts";

// Copy-in-at-startup primitive. Host side only — runs before the target exists.
export async function stageFiles(files: StageSpec[], root: string): Promise<void> {
  for (const f of files) {
    const dest = join(root, f.to);
    mkdirSync(dirname(dest), { recursive: true });
    if ("content" in f) writeFileSync(dest, f.content);
    else copyFileSync(f.from, dest);
  }
}
