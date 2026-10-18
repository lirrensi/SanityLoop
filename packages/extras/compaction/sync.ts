// Sync reduction: shake + prune. Both mutate messages IN PLACE — shrinking
// text the model already sent — so they commute with a running turn and are
// safe to call from anywhere: a tool, a REPL slash, a filter, a threshold
// pre-pass. No rebuild, no wake, no loop interaction. Rule:
//
//   in-place (shake/prune) → call directly, sync-safe, idempotent
//   rebuild  (soft/handoff/remote) → schedule via requestCompactInput, landing only
//
// Region model mirrors OMP's shake/prune split:
// - prune blanks WHOLE tool results ([Output truncated], superseded notices),
//   with undo() to restore when persistence fails.
// - shake elides heavy REGIONS inside text: full tool-result text →
//   placeholder, large fenced/XML blocks → one-liners. Kept text stays live.

import { answerText as coreAnswerText } from "@sanityloop/core";
import type { Message } from "@sanityloop/core";

export type ProtectedToolMatcher = string | ((toolName: string, toolCallId: string) => boolean);

/** A located eligible region. The entry index pins it across pure helpers. */
export interface ShakeRegion {
  /** Index into agent.messages. */
  entryIndex: number;
  /** Character span inside the answer text (full-text when start=0/end=len). */
  start: number;
  end: number;
  tokens: number;
  label: string;
}

export interface ShakeOptions {
  /** Keep the most recent context tokens intact (tail walk). */
  protectTokens?: number;
  /** Skip the pass unless estimated savings reach this. Manual calls: 0. */
  minSavings?: number;
  /** Tool results never touched. Default: skill reads. */
  protectedTools?: ProtectedToolMatcher[];
  /** Minimum token size for a fenced/XML block to be eligible. */
  fenceMinTokens?: number;
}

export interface PruneOptions {
  /** Keep the most recent tool-output tokens intact. */
  protectTokens?: number;
  /** Skip unless estimated savings reach this. Manual calls: 0. */
  minimumSavings?: number;
  /** Tool results never blanked. */
  protectedTools?: ProtectedToolMatcher[];
}

export interface PruneResult {
  prunedCount: number;
  tokensSaved: number;
  /** Restore every blanked result — call when persistence of the shrunk history fails. */
  undo(): void;
}

export const DEFAULT_SHAKE_OPTIONS: Required<ShakeOptions> = {
  protectTokens: 16_000,
  minSavings: 4_000,
  protectedTools: ["skill"],
  fenceMinTokens: 400,
};

/** Manual `/shake` equivalent — aggressive reach, no savings gate. */
export const AGGRESSIVE_SHAKE_OPTIONS: Required<ShakeOptions> = {
  protectTokens: 4_000,
  minSavings: 0,
  protectedTools: ["skill"],
  fenceMinTokens: 400,
};

/** Dead-end rescue — protectTokens 0 so even the newest blocker can drop. */
export const RESCUE_SHAKE_OPTIONS: Required<ShakeOptions> = {
  protectTokens: 0,
  minSavings: 0,
  protectedTools: ["skill"],
  fenceMinTokens: 400,
};

export const DEFAULT_PRUNE_OPTIONS: Required<PruneOptions> = {
  protectTokens: 40_000,
  minimumSavings: 20_000,
  protectedTools: ["skill"],
};

/** Rough token estimate — char/4, matches the estimator the loop uses. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function toolNameOf(m: Message): string {
  if (m.type !== "toolResult") return "";
  const rec = m as unknown as { toolName?: unknown };
  return typeof rec.toolName === "string" ? rec.toolName : "";
}

function toolCallIdOf(m: Message): string {
  if (m.type !== "toolResult") return "";
  const rec = m as unknown as { toolCallId?: unknown };
  return typeof rec.toolCallId === "string" ? rec.toolCallId : "";
}

function isProtected(toolName: string, toolCallId: string, matchers: ProtectedToolMatcher[]): boolean {
  for (const p of matchers) {
    if (typeof p === "string" ? toolName === p || toolName.startsWith(`${p}:`) : p(toolName, toolCallId)) return true;
  }
  return false;
}

/** Answer text of a toolResult, or undefined for catastrophic (null-content) results. */
function answerText(m: Message): string | undefined {
  if (m.type !== "toolResult" || m.content === null) return undefined;
  const c = m.content;
  if (typeof c === "object" && "answer" in c) return coreAnswerText((c as { answer: unknown }).answer);
  return undefined;
}

function setAnswerText(m: Message, text: string): void {
  if (m.type !== "toolResult" || m.content === null) return;
  const c = m.content;
  // block answers elide to a single text block (never a raw string — the
  // union shape survives the round-trip, and undo restores the original)
  if (typeof c === "object" && "answer" in c) {
    const face = c as { answer: unknown };
    face.answer = Array.isArray(face.answer) ? [{ type: "text", content: text }] : text;
  }
}
const OPENING_XML = /^<([a-z_-]+)(?:\s+[^>]*)?>$/;
const CLOSING_XML = /^<\/([a-z_-]+)>$/;

/**
 * Fenced-code + top-level XML spans inside text → [start,end) ranges covering
 * the full block. Conservative: unterminated fences/tags yield no range, XML
 * detection suppressed inside fences. Mirrors OMP's shake region detection.
 */
export function findBlockRanges(text: string): Array<{ start: number; end: number }> {
  const lines = text.split("\n");
  const offsets: number[] = [0];
  for (const l of lines) offsets.push(offsets[offsets.length - 1] + l.length + 1);
  const ranges: Array<{ start: number; end: number }> = [];
  let fence: { fence: string; start: number } | undefined;
  let xml: { tag: string; start: number } | undefined;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (fence) {
      if (line.startsWith(fence.fence)) {
        ranges.push({ start: fence.start, end: offsets[i + 1] - 1 });
        fence = undefined;
      }
      continue;
    }
    if (/^(`{3,}|~{3,})/.test(line)) {
      const m = /^(`{3,}|~{3,})/.exec(line);
      if (m) fence = { fence: m[1], start: offsets[i] };
      continue;
    }
    if (xml) {
      const close = CLOSING_XML.exec(line);
      if (close && close[1] === xml.tag) {
        ranges.push({ start: xml.start, end: offsets[i + 1] - 1 });
        xml = undefined;
      }
      continue;
    }
    const open = OPENING_XML.exec(line);
    if (open) xml = { tag: open[1], start: offsets[i] };
  }
  return ranges;
}

interface WalkState {
  protectedTools: ProtectedToolMatcher[];
  fenceMinTokens: number;
  budget: number;
  regions: ShakeRegion[];
}

/** Tail walk: newest entries consume the protect budget first, then elision applies. */
function collectRegions(messages: Message[], opts: Required<ShakeOptions>): ShakeRegion[] {
  const st: WalkState = { protectedTools: opts.protectedTools, fenceMinTokens: opts.fenceMinTokens, budget: opts.protectTokens, regions: [] };
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.type !== "toolResult") continue;
    const text = answerText(m);
    if (text === undefined) continue;
    // own placeholders are terminal — re-shaking them eats the marker and
    // lies about the count (and double-counts tokensSaved on re-shake)
    if (text.startsWith("[shaken — ") && text.endsWith("elided]")) continue;
    const tokens = estimateTokens(text);
    if (st.budget > 0) {
      st.budget -= tokens;
      if (st.budget >= 0) continue;
    }
    const toolName = toolNameOf(m);
    const toolCallId = toolCallIdOf(m);
    if (isProtected(toolName, toolCallId, st.protectedTools)) continue;
    const full: ShakeRegion = { entryIndex: i, start: 0, end: text.length, tokens, label: toolName || "toolResult" };
    const blocks = findBlockRanges(text).filter((r) => estimateTokens(text.slice(r.start, r.end)) >= st.fenceMinTokens);
    if (blocks.length > 0 && estimateTokens(text) > st.fenceMinTokens * 2) {
      for (const b of blocks) {
        st.regions.push({
          entryIndex: i,
          start: b.start,
          end: b.end,
          tokens: estimateTokens(text.slice(b.start, b.end)),
          label: `${full.label}:block`,
        });
      }
    } else {
      st.regions.push(full);
    }
  }
  return st.regions;
}

/**
 * Elide heavy regions in place. Full-text regions blank the answer to a
 * placeholder; block regions collapse to a one-liner. Returns estimated
 * tokens saved. Idempotent — own placeholders are never re-shaken, so a
 * repeat call finds no eligible regions (partial-collapse remainders ARE
 * eligible: re-shake = shake harder, converging on the full placeholder).
 */
export function shakeNow(messages: Message[], opts: ShakeOptions = {}): { regions: number; tokensSaved: number } {
  const o: Required<ShakeOptions> = { ...DEFAULT_SHAKE_OPTIONS, ...opts };
  const regions = collectRegions(messages, o);
  const saved = regions.reduce((n, r) => n + r.tokens, 0);
  if (regions.length === 0 || saved < o.minSavings) return { regions: 0, tokensSaved: 0 };
  // Back-to-front per entry so earlier spans keep their offsets.
  const order = [...regions].sort((a, b) => b.entryIndex - a.entryIndex || b.start - a.start);
  let cursor = -1;
  let pending: ShakeRegion[] = [];
  const flush = () => {
    if (cursor < 0 || pending.length === 0) return;
    const target = messages[cursor];
    const current = answerText(target);
    if (current === undefined) return;
    if (pending.some((r) => r.start === 0 && r.end === current.length)) {
      const label = pending[0].label.replace(/:block$/, "");
      setAnswerText(target, `[shaken — ${estimateTokens(current)} tokens of ${label} output elided]`);
      return;
    }
    let out = current;
    for (const r of pending) {
      const bytes = r.end - r.start;
      out = `${out.slice(0, r.start)}[… ${estimateTokens(out.slice(r.start, r.end))} tokens / ${bytes} chars elided]${out.slice(r.end)}`;
    }
    setAnswerText(target, out);
  };
  for (const r of order) {
    if (r.entryIndex !== cursor) {
      flush();
      cursor = r.entryIndex;
      pending = [];
    }
    pending.push(r);
  }
  flush();
  return { regions: regions.length, tokensSaved: saved };
}

/**
 * Blank whole stale tool results in place. Newest-first tail walk: entries
 * inside protectTokens survive; protected tools always survive. Returns
 * counts + undo() restoring every blanked answer.
 */
export function pruneNow(messages: Message[], opts: PruneOptions = {}): PruneResult {
  const o: Required<PruneOptions> = { ...DEFAULT_PRUNE_OPTIONS, ...opts };
  let budget = o.protectTokens;
  // prev keeps the ORIGINAL answer value (string OR blocks) — undo restores
  // verbatim. The flattened text is only for budgeting/savings math.
  const blanked: Array<{ m: Message; prev: unknown; text: string }> = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.type !== "toolResult") continue;
    const text = answerText(m);
    if (text === undefined) continue;
    // own placeholder is terminal — never re-blank (honest prunedCount)
    if (text === "[pruned — output blanked to reclaim context]") continue;
    const tokens = estimateTokens(text);
    if (budget > 0) {
      budget -= tokens;
      if (budget >= 0) continue;
    }
    const toolName = toolNameOf(m);
    const toolCallId = toolCallIdOf(m);
    if (isProtected(toolName, toolCallId, o.protectedTools)) continue;
    blanked.push({ m, prev: (m.content as { answer: unknown }).answer, text });
  }
  const saved = blanked.reduce((n, b) => n + estimateTokens(b.text), 0);
  if (blanked.length === 0 || saved < o.minimumSavings) {
    return { prunedCount: 0, tokensSaved: 0, undo: () => {} };
  }
  for (const b of blanked) setAnswerText(b.m, "[pruned — output blanked to reclaim context]");
  return {
    prunedCount: blanked.length,
    tokensSaved: saved,
    undo: () => {
      for (const b of blanked) {
        if (b.m.content !== null && typeof b.m.content === "object") {
          (b.m.content as { answer: unknown }).answer = b.prev;
        }
      }
    },
  };
}
