// ============================================================================
// packages/test-kit/core.ts — "./core" subpath: fixtures that speak core.
// ============================================================================
// These subclass/drive @sanityloop/core directly, so the kit declares core as
// a PEER dependency: every consumer already has its own core and plugs it in.
// Generic fixtures (waits, temp dirs) stay on the "." entry, dependency-free.

export * from "./stub-model.ts";
export * from "./harness.ts";
