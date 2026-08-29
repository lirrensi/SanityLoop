// ============================================================================
// packages/test-kit/tmp.ts — temp dirs under os.tmpdir(), always cleaned up.
// ============================================================================

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Make a unique temp dir and register cleanup on the test context.
 * `t.after` supports async — the rm is awaited by the runner.
 */
export async function makeTempDir(
    t: { after: (fn: () => unknown | Promise<unknown>) => unknown },
    prefix = "sanityloop-test-",
): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), prefix));
    t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
    return dir;
}
