# @sanityloop/a2a-client

Client-only [A2A](https://a2a-protocol.org/) — call remote A2A agents as
tools from a SanityLoop agent, with full multi-turn conversation
continuation (`taskId` + `contextId` threading). Nothing listens: no
AgentCard endpoint, no inbound routes, no server.

## Config

```ts
import { createA2aClient } from "@sanityloop/a2a-client";

agent.install(createA2aClient({
  agents: {
    coder: { url: "https://coder.example.com", bearer: process.env.CODER_TOKEN },
    researcher: { url: "https://research.example.net" },
  },
}));
```

Each entry needs a `url`; `bearer` is optional and sent as
`Authorization: Bearer …` on that agent's calls.

## Tools

Every configured agent `<key>` gets two tools:

- `a2a_<key>_send` — send a message. Optional `contextTaskId` continues
  an existing task; optional `contextId` continues the same conversation
  as a new task. Each send uses a fresh `messageId`; the answer names the
  resulting `taskId`, `contextId`, and task state.
- `a2a_<key>_cancel` — cancel a running task by `taskId`.

Blocking `sendMessage` waits until the task reaches a terminal state;
`input-required` / `auth-required` come back as task states to continue.

Conversation state lives in `state.a2a`, and each answer also carries
verbatim `stored` metadata (`{ agent, taskId, contextId, taskState,
artifacts }`) for the next turn.

## Deliberately NOT supported

- No server side: no AgentCard endpoint, no inbound routes.
- No OAuth/OIDC login flows yet (bearer tokens only) — later.
- No `getTask` polling helper: blocking send already waits for terminal.
