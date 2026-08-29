// ============================================================================
// sanity/src/packages/swarm/src/index.ts — the package's main surface.
// The join extension (what agents import) + the shared protocol. The daemon
// lives under ./server — import it explicitly when you want to RUN a swarm,
// because a daemon is a deployment decision, not an import.
// ============================================================================
export * from "./protocol.ts";
export { createSwarmJoin, wireSwarm } from "./join/index.ts";
export type { SwarmJoinOptions, WireSwarmOptions } from "./join/index.ts";
