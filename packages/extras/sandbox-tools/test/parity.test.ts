// Metadata parity: sandboxed tools mirror the host factories exactly
// (name/description/inputSchema/promptSnippet/promptGuidelines/executionMode).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createBasicTools } from "@sanityloop/basic-fs-tools";
import { createBashTool } from "@sanityloop/shell-tool";
import { createSandboxedTools } from "../tools.ts";
import type { ExecResult } from "../exec.ts";

const stubExec = async (): Promise<ExecResult> => ({ code: 0, stdout: '{"ok":true,"result":{"answer":"x","stored":{}}}', stderr: "" });

test("parity: sandboxed read/edit/write match createBasicTools metadata", () => {
  const host = createBasicTools();
  const sbx = createSandboxedTools({ container: "c", exec: stubExec });
  for (const name of ["read", "edit", "write"] as const) {
    const h = host[name] as unknown as Record<string, unknown>;
    const s = sbx[name] as unknown as Record<string, unknown>;
    for (const k of ["name", "description", "inputSchema", "promptSnippet", "promptGuidelines", "executionMode"]) {
      assert.deepEqual(s[k], h[k], `${name}.${k} differs from host`);
    }
  }
});

test("parity: sandboxed bash matches createBashTool metadata", () => {
  const host = createBashTool();
  const sbx = createSandboxedTools({ container: "c", exec: stubExec });
  const h = host as unknown as Record<string, unknown>;
  const s = sbx.bash as unknown as Record<string, unknown>;
  for (const k of ["name", "description", "inputSchema", "promptSnippet", "promptGuidelines", "executionMode"]) {
    assert.deepEqual(s[k], h[k], `bash.${k} differs from host`);
  }
});
