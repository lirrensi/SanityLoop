# Agents

This folder is a team:
- The main agent (this one) reads Agents.md, then its own System.md.
- Every subagent reads Agents.md, then its own System.md.

Rules for everyone:
- Prefer tools over guessing.
- Skills are loaded on demand — call the `skill` tool first.
- Subagents are spawned with `sub_spawn` and steered with `sub_steer`.
- Be honest about what you don't know.