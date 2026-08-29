// sanity/src/extras/inputs.ts — the base input package (default loop control).
//
// THE EXTRA that gives the canonical input vocabulary its meaning. The CORE is
// type-blind: it provides `agent.input()` (the door) + the sync/async queues +
// events, and has no idea what any input MEANS. THIS module is the default
// input handler — wired by the CONSUMER like any other extra.
//
// Vocabulary (the canon — there is NO prompt type; followup replaced it):
//   input_abort    → agent.abort()   — holds everything immediately
//   input_stop     → agent.stop()    — graceful stop
//   input_steer    → real message. Received instantly, stored in
//                    `state.inputSteer`, INSERTED after the current tool batch
//                    (interrupts remaining tools — pi's Enter)
//   input_followup → real message. Received instantly, stored in
//                    `state.inputFollowUp`, INSERTED when the loop lands
//                    (pi's Alt+Enter; inserted immediately when idle)
//
// RECEIPT ≠ INSERTION. The core receives the input the moment it arrives (the
// master key — processed on top of the queue). The pending queues are STATE —
// observable by a UI (render like React) and cancellable by mutating state or
// sending another event.
//
// steer/followup are REAL MESSAGES — stored in history by default (`store`
// undefined = store). Set `store: false` to opt out.
//
// BACKTICK EXPANSION (backticksCommand: true) — steer/followup accept an
// optional `backticksCommand` flag. When present, every `cmd` span in the text
// is evaluated AT INSERTION MOMENT — the instant the input becomes a real
// history message — with util/expandBackticks' rules (execSync, 5-min timeout,
// "(no output)" / "(error: ...)" never throwing). Source-blind: repl, loops,
// http, swarm workers — any channel that calls agent.input() gets it.
//
//   RECEIPT stores INTENT (the raw template sits in the observable pending
//   queue), INSERTION produces REALITY (the expanded text enters history).
//   Both stages are truthful about themselves — and a loop armed an hour ago
//   reads the world as-it-is-now, because evaluation happens when the message
//   is born, not when it was sent.
//
// Unknown types are ignored here — other filters wear their own hats.
import { randomUUID } from "node:crypto";
import { EVENTS, emptySessionStats } from "@sanityloop/core";
import type { Filter, GodObject, Input, Message, Plugin } from "@sanityloop/core";
import { expandBackticks, removeFiltersByPrefix } from "@sanityloop/util";

export const InputTypes = {
  abort: "input_abort",
  stop: "input_stop",
  steer: "input_steer",
  followup: "input_followup",
  clear: "request_clear",
  reset: "request_reset",
} as const;

export type InputType = (typeof InputTypes)[keyof typeof InputTypes];

/** A steering message — real user text, delivered after the current tool batch. */
export interface SteerInput extends Input {
  type: typeof InputTypes.steer;
  text: string;
  /** Evaluate `cmd` spans at insertion moment (see header — intent vs reality). */
  backticksCommand?: boolean;
}

/** A follow-up message — real user text, delivered when the agent finishes. */
export interface ClearInput extends Input {
  type: typeof InputTypes.clear;
}

export interface ResetInput extends Input {
  type: typeof InputTypes.reset;
}

export interface FollowupInput extends Input {
  type: typeof InputTypes.followup;
  text: string;
  /** Evaluate `cmd` spans at insertion moment (see header — intent vs reality). */
  backticksCommand?: boolean;
}

/**
 * Insertion-moment materialization: the queue stores INTENT (raw template),
 * history receives REALITY (expanded text). Without the flag the text passes
 * through byte-for-byte — nothing executes unless explicitly requested.
 */
function materialize(input: unknown): string {
  const box = (input ?? {}) as { text?: unknown; backticksCommand?: boolean };
  const raw = typeof box.text === "string" ? box.text : "";
  return box.backticksCommand === true ? expandBackticks(raw) : raw;
}


/** The pending queue for a state key — lazily created, observable, cancellable. */
function stateQueue(agent: GodObject, key: string): Input[] {
  const slot = agent.state[key];
  if (!Array.isArray(slot)) agent.state[key] = [];
  return agent.state[key] as Input[];
}

/** Build the default input handler: the hats + the insert-when-ready drains. */
/** Reset the session to its starting state: keep ONLY the leading run of
 * consecutive system messages (the original identity block, from index 0 up to
 * the first non-system message), drop everything else — including any
 * mid-conversation "service" system messages. Fresh state, zeroed stats,
 * lastResponse repointed. Never called mid-turn (the reset-run filter waits for
 * the landing). Keeps the process + loop alive. */
function resetSession(agent: GodObject): void {
  const kept: typeof agent.messages = [];
  for (const m of agent.messages) {
    if (m.type === "system") kept.push(m);
    else break;
  }
  agent.messages = kept;
  agent.lastResponse = kept.length - 1;
  agent.state = {};
  agent.stats = emptySessionStats();
}

export function createDefaultInputs(): Plugin {
  function addUserMessage(agent: GodObject, text: string): void {
    const msg: Message = {
      id: `input-${randomUUID().slice(0, 8)}`,
      enabled: true,
      type: "user",
      committedAt: Date.now(),
      content: [{ type: "text", content: text }],
    };
    agent.messages.push(msg);
  }

  const umbrella: Filter = {
    event: EVENTS.inputReceived,
    id: "inputs/default-input",
    priority: 0,
    fn: async (agent) => {
      const input = agent.currentInput;
      if (!input) return;
      switch (input.type) {
        case InputTypes.abort:
          agent.abort();
          return;
        case InputTypes.stop:
          agent.stop();
          return;
        case InputTypes.steer:
          // mid-turn → store it, insert after the current tools; idle → now
          if (agent.inTurn) {
            stateQueue(agent, "inputSteer").push(input);
          } else if (input.store !== false && typeof input.text === "string") {
            addUserMessage(agent, materialize(input));
          }
          return;
        case InputTypes.followup:
          // mid-turn → store it, insert at the landing; idle → now
          if (agent.inTurn) {
            stateQueue(agent, "inputFollowUp").push(input);
          } else if (input.store !== false && typeof input.text === "string") {
            addUserMessage(agent, materialize(input));
          }
          return;
        case InputTypes.clear:
          // hide the conversation from the context window; history stays (enabled=false)
          for (const m of agent.messages) {
            if (m.type !== "system" && m.enabled) m.enabled = false;
          }
          return;
        case InputTypes.reset:
          // wipe the session back to start; land first if a turn is running
          if (agent.loopState === "running") {
            agent.state.resetting = true;
            agent.stop();
          } else {
            resetSession(agent);
          }
          return;
        default:
          return; // open types — other filters wear their own hats
      }
    },
  };

  /** Steer delivery: at cycleEnd (after the tool batch settles), insert one pending steer.
   * The cycle is the model round-trip unit — steer interrupts BETWEEN cycles. */
  const insertSteers: Filter = {
    event: EVENTS.cycleEnd,
    id: "inputs/steer-insert",
    priority: 100,
    fn: async (agent) => {
      const pending = agent.state.inputSteer;
      if (!Array.isArray(pending) || pending.length === 0) return;
      const input = pending.shift()!;
      if (input.store !== false && typeof input.text === "string") {
        addUserMessage(agent, materialize(input));
      }
    },
  };

  /** Follow-up delivery: at the landing (cycle fully ended), insert + continue. */
  const drainFollowups: Filter = {
    event: EVENTS.stop,
    id: "inputs/followup-drain",
    priority: 100,
    fn: async (agent) => {
      const pending = agent.state.inputFollowUp;
      if (!Array.isArray(pending) || pending.length === 0) return;
      const input = pending.shift()!;
      if (input.store !== false && typeof input.text === "string") {
        addUserMessage(agent, materialize(input));
        // wake AFTER the landing completes — never touch anything mid-landing.
        // wake() is a pure signal (wakeRequested flag); the heartbeat notices
        // next tick, then the provider call sees the follow-up message.
        setTimeout(() => agent.wake(), 0);
      }
    },
  };

  /** Reset delivery: run the wipe at the landing (never splice mid-turn). */
  const runReset: Filter = {
    event: EVENTS.stop,
    id: "inputs/reset-run",
    priority: 0,
    fn: async (agent) => {
      if (agent.state.resetting) resetSession(agent);
    },
  };

  return {
    id: "inputs",
    install(agent) {
      agent.addFilter(umbrella);
      agent.addFilter(insertSteers);
      agent.addFilter(drainFollowups);
      agent.addFilter(runReset);
      agent.addDeclaredCapability({ id: "inputs", description: "input vocabulary (abort/stop/steer/followup/clear/reset)" });
      agent.addDeclaredInput({ id: "clear-request", schema: null, description: "hide the conversation from the context window (history preserved)" });
      agent.addDeclaredInput({ id: "reset-request", schema: null, description: "reset the session to its starting state (process kept alive)" });
      agent.addDeclaredInput({ id: "steer", schema: null, description: "real message inserted after the current tool batch; optional backticksCommand evaluates `cmd` spans at insertion" });
      agent.addDeclaredInput({ id: "followup", schema: null, description: "real message inserted at the landing; optional backticksCommand evaluates `cmd` spans at insertion" });
    },
    uninstall(agent) {
      removeFiltersByPrefix(agent, "inputs/");
      agent.removeDeclaredCapability("inputs");
      agent.removeDeclaredInput("clear-request");
      agent.removeDeclaredInput("reset-request");
      agent.removeDeclaredInput("steer");
      agent.removeDeclaredInput("followup");
    },
  };
}
