// sanity/src/index.ts — the CURRENT major alias.
// Points at the newest core version. Consumers who want a specific old major
// import it directly: `sanity/core/v1`, `sanity/core/v2`, ... forever.
export * from "./core/v1/index.ts";
