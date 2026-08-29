// ============================================================================
// packages/test-kit/index.ts — "." entry: generic, dependency-free fixtures.
// ============================================================================
// Core-coupled fixtures (scripted StubModel, agent harness) live behind the
// "./core" subpath so packages that don't drive the loop never touch it.

export * from "./wait.ts";
export * from "./tmp.ts";
