// sandboxed-agent.ts — a normal agent that can optionally run INSIDE a docker
// micro-sandbox. The agent code (main) is byte-identical on host or in-container;
// only the launch differs. This is the single-file / Pattern #1 dream: one file,
// opt into isolation with an env var, no tool changes anywhere.
//
//   node --experimental-strip-types templates/sandboxed-agent.ts            # host
//   SANDBOX=docker node --experimental-strip-types templates/sandboxed-agent.ts
//
// The docker path bind-mounts the project root read-only into /work and gives
// the container a tmpfs at /tmp — so the agent can read the repo but cannot
// touch anything else on the host, and writes only survive in /tmp.
import { Agent, SimpleModel, EVENTS } from "@sanityloop/core";
import { createDefaultInputs } from "@sanityloop/inputs";
import { jsonlSession } from "@sanityloop/base-storage";
import { runInSandbox } from "@sanityloop/sandbox";
import { createDockerSandbox } from "@sanityloop/sandbox-docker";
import { fileURLToPath } from "node:url";
import { dirname, relative } from "node:path";

const here = fileURLToPath(import.meta.url);
const projectRoot = dirname(dirname(here)); // templates/ -> repo root
const relPath = relative(projectRoot, here); // "templates/sandboxed-agent.ts"

export function main() {
  const model = new SimpleModel({
    modelId: "gpt-4o-mini",
    apiKey: process.env.OPENAI_API_KEY ?? "",
    stream: true,
  });
  const session = jsonlSession("sessions/sandboxed-agent");
  const agent = new Agent({ model, agentId: "sandboxed-agent", tools: [] });
  agent.install(session.plugin);
  agent.install(createDefaultInputs());
  agent.addFilter({
    event: EVENTS.textDelta,
    id: "out",
    priority: 0,
    fn: async (_a, raw) => {
      const sd = (raw as { streamDelta?: { type?: string; delta?: string } })?.streamDelta;
      if (sd?.type === "textDelta") process.stdout.write(sd.delta ?? "");
    },
  });
  agent.run();
  agent.input({ type: "input_followup", text: process.argv[2] ?? "hello cutie" });
}

// Launch shim: only relaunch inside docker when opted in. main() below still
// runs on the host (no SANDBOX) AND inside the container (SANDBOX not forwarded).
if (process.env.SANDBOX === "docker") {
  await runInSandbox({
    target: createDockerSandbox({
      image: "node:22",
      mount: projectRoot, // bind-mount project root read-only into /work
      readOnly: true,
      tmpfs: "/tmp",
    }),
    runPath: relPath, // entry already lives inside the mounted root
    run: main,
    env: { OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? "" },
    ports: [8080],
  });
  // runInSandbox exits the host process once the container finishes.
}

main();
