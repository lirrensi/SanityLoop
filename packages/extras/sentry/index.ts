// packages/extras/sentry — Sentry error monitoring for SanityLoop.
// ============================================================================
// One install line gives full Sentry error monitoring across all four error
// lanes: fatal `error`, filter-crash `handlerError`, tool-failure `toolEnd`,
// log-channel `log`.
//
//   import { createSentryPlugin } from "@sanityloop/sentry";
//   agent.install(createSentryPlugin({ dsn: process.env.SENTRY_DSN }));
//
// DEFAULTS: `error` + `handlerError` lanes → issues; tool/log lanes OFF unless
// opted in. Breadcrumbs are ALWAYS on: a bounded ring (cap 100) collects tool
// outcomes + log lines even when those lanes send no issues, so every fatal
// arrives with its trail.
//
// WIRE: minimal Sentry envelope client over `fetch`, zero deps. Pluggable via
// `transport` (power users forward into `@sentry/node` or a file). Network is
// fire-and-forget, never awaited in the filter chain; `flush()` settles it.
// ============================================================================
import { EVENTS } from "@sanityloop/core";
import type { EventPayload, GodObject, Plugin } from "@sanityloop/core";
import { LOG_CHANNEL, removeFiltersByPrefix } from "@sanityloop/util";
import type { LogEntry } from "@sanityloop/util";

/** This brick's SDK identity on the wire. */
export const SENTRY_SDK_NAME = "sanityloop.sentry";
export const SENTRY_SDK_VERSION = "0.1.0";
/** Breadcrumb ring cap — oldest evicted past this. */
export const CRUMB_CAP = 100;
/** Per-crumb truncation budgets (chars). */
export const CRUMB_MESSAGE_MAX = 200;
export const CRUMB_DATA_MAX = 500;

// ============================================================================
// Options
// ============================================================================

/** Per-tool selector for the tool lane. */
export interface SentryToolGate {
  /** Lane OFF unless this is true. Default false. */
  enabled?: boolean;
  /** Only these tool names can become issues (absent = all). */
  include?: string[];
  /** These tool names never become issues. */
  exclude?: string[];
  /**
   * Escalate ANY result to an issue when this returns true — including
   * returned/noise/success results. Wrapped: throw = treated as false.
   */
  match?: (call: { name: string; parameters: Record<string, unknown> }, result: { answer: string; error?: boolean; errorMessage?: string }) => boolean;
}

/** Source/level selector for the log lane. */
export interface SentryLogGate {
  /** Lane OFF unless this is true. Default false. */
  enabled?: boolean;
  /** Levels at/above this become issues. Default "error". */
  minLevel?: string;
  /** Only these log sources can become issues (absent = all). */
  include?: string[];
  /** These log sources never become issues. */
  exclude?: string[];
}

export interface SentryPluginOptions {
  /** Sentry DSN. Falls back to `SENTRY_DSN` env. Malformed → throws at factory time. */
  dsn?: string;
  /** Sentry environment tag. */
  environment?: string;
  /** Release tag. */
  release?: string;
  /** Tool lane gate. Default: off. */
  tools?: SentryToolGate;
  /** Log lane gate. Default: off. */
  logs?: SentryLogGate;
  /**
   * Pluggable transport. Receives the raw envelope bytes + headers.
   * Default: `fetch` POST. Throw/reject = swallowed (never feeds back).
   */
  transport?: (envelope: string, headers: { auth: string; contentType: string }) => void | Promise<void>;
  /**
   * Inspect/mutate/drop an event before send. Return null/undefined to drop.
   * May be async — the send path (not the filter chain) awaits it.
   */
  beforeSend?: (event: SentryEvent) => SentryEvent | null | undefined | Promise<SentryEvent | null | undefined>;
}

export type SentryPlugin = Plugin & { flush: () => Promise<void> };

// ============================================================================
// Wire types (the Sentry event shape we build — minimal, documented subset)
// ============================================================================

export interface SentryFrame {
  filename: string;
  function: string;
  lineno?: number;
  colno?: number;
}

export interface SentryException {
  type: string;
  value: string;
  stacktrace?: { frames: SentryFrame[] };
  mechanism: { type: string; handled: boolean };
}

export interface SentryBreadcrumb {
  timestamp: number;
  message?: string;
  category?: string;
  level?: string;
  type?: string;
  data?: unknown;
}

export interface SentryEvent {
  event_id: string;
  timestamp: number;
  platform: string;
  level?: string;
  logger?: string;
  environment?: string;
  release?: string;
  tags?: Record<string, string>;
  extra?: Record<string, unknown>;
  sdk?: { name: string; version: string };
  exception?: { values: SentryException[] };
  breadcrumbs?: { values: SentryBreadcrumb[] };
}

// ============================================================================
// Pure fns — DSN
// ============================================================================

export interface ParsedDsn {
  protocol: string;
  host: string;
  port?: string;
  path: string;
  projectId: string;
  publicKey: string;
  secret?: string;
}

/** Parse a DSN or throw a clear error. `{PROTOCOL}://{PUBLIC}[:SECRET]@{HOST}[:PORT]{PATH}/{PROJECT_ID}` */
export function parseDsn(dsn: string): ParsedDsn {
  const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/([^@\/]+)@([^\/]+?)(\/.*?)?\/([^\/]+)$/.exec(dsn.trim());
  if (!m) throw new Error(`[sanity] sentry: malformed DSN ${JSON.stringify(dsn)} — expected {PROTOCOL}://{PUBLIC_KEY}[:SECRET]@{HOST}[:PORT]{PATH}/{PROJECT_ID}`);
  const [, protocol, userinfo, hostport, path = "", projectId] = m;
  if (protocol !== "http" && protocol !== "https") {
    throw new Error(`[sanity] sentry: malformed DSN — protocol must be http(s), got ${JSON.stringify(protocol)}`);
  }
  const [publicKey, secret] = userinfo.split(":");
  if (!publicKey) throw new Error("[sanity] sentry: malformed DSN — missing public key");
  const colon = hostport.lastIndexOf(":");
  // IPv6 hosts contain colons but arrive bracketed ([::1]:9000); a bare extra
  // colon pair is ambiguous, so only split a trailing :port.
  let host = hostport;
  let port: string | undefined;
  if (!hostport.startsWith("[") && colon !== -1) {
    host = hostport.slice(0, colon);
    port = hostport.slice(colon + 1);
  } else if (hostport.startsWith("[")) {
    const close = hostport.indexOf("]");
    if (close !== -1 && hostport[close + 1] === ":") {
      host = hostport.slice(0, close + 1);
      port = hostport.slice(close + 2);
    }
  }
  if (!host) throw new Error("[sanity] sentry: malformed DSN — missing host");
  if (!projectId) throw new Error("[sanity] sentry: malformed DSN — missing project id");
  return { protocol, host, ...(port ? { port } : {}), path, projectId, publicKey, ...(secret ? { secret } : {}) };
}

/** `POST {BASE}/api/{PROJECT_ID}/envelope/` (`/store/` deprecated). */
export function envelopeUrl(d: ParsedDsn): string {
  const port = d.port ? `:${d.port}` : "";
  return `${d.protocol}://${d.host}${port}${d.path}/api/${d.projectId}/envelope/`;
}

/** `X-Sentry-Auth: Sentry sentry_version=7, ...` */
export function authHeader(d: ParsedDsn): string {
  const parts = [
    "Sentry sentry_version=7",
    `sentry_client=${SENTRY_SDK_NAME}/${SENTRY_SDK_VERSION}`,
    `sentry_key=${d.publicKey}`,
  ];
  if (d.secret) parts.push(`sentry_secret=${d.secret}`);
  return parts.join(", ");
}

// ============================================================================
// Pure fns — V8 stack parser
// ============================================================================

/**
 * Parse a V8 stack string into Sentry frames, OLDEST→newest (Sentry order =
 * reverse of V8's newest-first). Each frame keeps at least filename+function.
 * Unparseable lines are skipped; a fully unparseable stack yields [].
 */
export function parseStackTrace(stack: string): SentryFrame[] {
  const frames: SentryFrame[] = [];
  for (const line of stack.split("\n")) {
    const t = line.trim();
    // "at fn (file:line:col)" / "at file:line:col" / "at async fn (file:line:col)"
    let m = /^\bat\s+(?:async\s+)?(.+?)\s+\((.+?):(\d+)(?::(\d+))?\)$/.exec(t);
    if (m) {
      frames.push({
        filename: m[2],
        function: m[1],
        ...(m[3] ? { lineno: Number(m[3]) } : {}),
        ...(m[4] ? { colno: Number(m[4]) } : {}),
      });
      continue;
    }
    m = /^\bat\s+(.+?):(\d+)(?::(\d+))?$/.exec(t);
    if (m) {
      frames.push({
        filename: m[1],
        function: "<anonymous>",
        ...(m[2] ? { lineno: Number(m[2]) } : {}),
        ...(m[3] ? { colno: Number(m[3]) } : {}),
      });
    }
  }
  return frames.reverse();
}

// ============================================================================
// Pure fns — envelope
// ============================================================================

/** 32 lowercase hex chars, no dashes. */
export function newEventId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Serialize one event into envelope bytes: `{header}⏎{item}⏎{event}⏎` —
 * exactly one `event` item per envelope; header `event_id` matches payload.
 */
export function buildEnvelope(event: SentryEvent): string {
  const itemLen = Buffer.byteLength(JSON.stringify(event), "utf8");
  const header = JSON.stringify({ event_id: event.event_id, sent_at: new Date(event.timestamp * 1000).toISOString() });
  const item = JSON.stringify({ type: "event", content_type: "application/json", length: itemLen });
  return `${header}\n${item}\n${JSON.stringify(event)}\n`;
}

export function truncateCrumbMessage(msg: string): string {
  return msg.length > CRUMB_MESSAGE_MAX ? `${msg.slice(0, CRUMB_MESSAGE_MAX)}…` : msg;
}

export function pushCrumb(ring: SentryBreadcrumb[], crumb: SentryBreadcrumb): void {
  ring.push(crumb);
  while (ring.length > CRUMB_CAP) ring.shift();
}

const LOG_RANK: Record<string, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export function logRank(level: string): number {
  return LOG_RANK[level] ?? -1;
}

export function isSelected(name: string, include?: string[], exclude?: string[]): boolean {
  if (include && !include.includes(name)) return false;
  if (exclude && exclude.includes(name)) return false;
  return true;
}

/** Thrown = the `executeOne` catch shape (`stored.trace` present). */
export function isThrownResult(result: { error?: boolean; stored?: unknown }): boolean {
  if (!result.error) return false;
  const s = result.stored;
  return typeof s === "object" && s !== null && typeof (s as Record<string, unknown>).trace === "string";
}

/** Model-noise: bad args, unknown/disabled tool — breadcrumb, never an issue. */
export function isNoiseResult(result: { answer: string; error?: boolean; errorMessage?: string }): boolean {
  if (!result.error) return false;
  if (result.errorMessage === "invalid_arguments") return true;
  return result.answer.startsWith("Unknown tool:") || result.answer.includes("currently disabled:");
}

// ============================================================================
// Factory
// ============================================================================

export function createSentryPlugin(opts: SentryPluginOptions = {}): SentryPlugin {
  const rawDsn = opts.dsn ?? process.env.SENTRY_DSN;
  if (!rawDsn) {
    throw new Error("[sanity] sentry: no DSN — pass `dsn` or set SENTRY_DSN");
  }
  const dsn = parseDsn(rawDsn);
  const url = envelopeUrl(dsn);
  const auth = authHeader(dsn);
  const environment = opts.environment;
  const release = opts.release;
  const toolGate = opts.tools ?? {};
  const logGate = opts.logs ?? {};
  const logMinRank = logRank(logGate.minLevel ?? "error");
  const userTransport = opts.transport;
  const beforeSend = opts.beforeSend;

  const ring: SentryBreadcrumb[] = [];
  const inflight = new Set<Promise<void>>();

  function baseEvent(level: string, tags: Record<string, string>): SentryEvent {
    return {
      event_id: newEventId(),
      timestamp: Date.now() / 1000,
      platform: "node",
      level,
      environment,
      release,
      tags,
      sdk: { name: SENTRY_SDK_NAME, version: SENTRY_SDK_VERSION },
      breadcrumbs: { values: [...ring] },
    };
  }

  function exceptionFrom(err: unknown, mechanism: string, handled: boolean): SentryException {
    const type = err instanceof Error && err.name && err.name !== "Error" ? err.name : "Error";
    const value = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error && typeof err.stack === "string" ? err.stack : undefined;
    const frames = stack ? parseStackTrace(stack) : [];
    return {
      type,
      value,
      ...(frames.length > 0 ? { stacktrace: { frames } } : {}),
      mechanism: { type: mechanism, handled },
    };
  }

  /** The send path — async, fire-and-forget from filters, self-guarded. */
  async function send(event: SentryEvent): Promise<void> {
    try {
      let out: SentryEvent | null | undefined = event;
      if (beforeSend) out = await beforeSend(event);
      if (!out) return;
      const bytes = buildEnvelope(out);
      if (userTransport) {
        await userTransport(bytes, { auth, contentType: "application/x-sentry-envelope" });
        return;
      }
      await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-sentry-envelope", "X-Sentry-Auth": auth },
        body: bytes,
      }).then(
        () => undefined,
        () => undefined,
      );
    } catch {
      // Self-guard: transport/beforeSend bugs never feed back into the loop.
    }
  }

  /** Fire-and-forget — never awaited in the filter chain; flush() settles it. */
  function capture(event: SentryEvent): void {
    const p = send(event);
    inflight.add(p);
    void p.then(() => {
      inflight.delete(p);
    });
  }
  function crumbFromTool(callName: string, result: { answer: string; error?: boolean }): void {
    try {
      pushCrumb(ring, {
        timestamp: Date.now() / 1000,
        message: truncateCrumbMessage(`tool ${callName}: ${result.error ? "failed" : "ok"} — ${result.answer}`),
        category: "tool",
        level: result.error ? "error" : "info",
        type: "default",
        data: { tool: callName, error: result.error ?? false },
      });
    } catch {
      // Truncation/push never throws, but the ring must never break the loop.
    }
  }

  function crumbFromLog(entry: LogEntry): void {
    try {
      const data = entry.data === undefined ? undefined : truncateData(entry.data);
      pushCrumb(ring, {
        timestamp: (entry.ts ?? Date.now()) / 1000,
        message: truncateCrumbMessage(entry.message),
        category: `log.${entry.source}`,
        level: LOG_RANK[entry.level] !== undefined ? entry.level : "info",
        type: "default",
        ...(data === undefined ? {} : { data }),
      });
    } catch {
      // Same guarantee as above.
    }
  }

  function truncateData(data: unknown): unknown {
    try {
      const s = JSON.stringify(data);
      return s.length > CRUMB_DATA_MAX ? `${s.slice(0, CRUMB_DATA_MAX)}…` : JSON.parse(s);
    } catch {
      return undefined;
    }
  }

  return {
    id: "sentry",
    install(agent: GodObject) {
      // ---- lane 1: fatal `error` → issue (handled:false — the turn died) ----
      agent.addFilter({
        event: EVENTS.error,
        id: "sentry/error",
        priority: 0,
        fn: async (_agent, event) => {
          try {
            const e = (event ?? {}) as EventPayload & { error?: unknown; message?: string; source?: string; name?: string };
            const extra: Record<string, unknown> = {};
            for (const [k, v] of Object.entries(e)) {
              if (k !== "type" && k !== "error" && k !== "message") extra[k] = v;
            }
            const err = e.error ?? new Error(e.message ?? "unknown error");
            const evt = baseEvent("fatal", { lane: "error", source: typeof e.source === "string" ? e.source : "loop" });
            evt.exception = { values: [exceptionFrom(err, "auto.sanity.error", false)] };
            if (Object.keys(extra).length > 0) evt.extra = extra;
            capture(evt);
          } catch {
            // Self-guard: mapping bugs never break the error lane.
          }
        },
      });

      // ---- lane 2: filter-crash `handlerError` → issue (bus isolated it) ----
      agent.addFilter({
        event: EVENTS.handlerError,
        id: "sentry/handler-error",
        priority: 0,
        fn: async (_agent, event) => {
          try {
            const e = (event ?? {}) as EventPayload & { error?: unknown; filterId?: unknown; event?: unknown };
            // Self-guard: our own filters' crashes must not report (no feedback loop).
            if (typeof e.filterId === "string" && e.filterId.startsWith("sentry/")) return;
            const err = e.error ?? new Error("handler error");
            const evt = baseEvent("error", {
              lane: "handlerError",
              ...(typeof e.filterId === "string" ? { filter: e.filterId } : {}),
              ...(typeof e.event === "string" ? { on: e.event } : {}),
            });
            evt.exception = { values: [exceptionFrom(err, "auto.sanity.filter", true)] };
            capture(evt);
          } catch {
            // Self-guard.
          }
        },
      });

      // ---- lane 3: tool outcomes → always a crumb; thrown → issue when on ----
      agent.addFilter({
        event: EVENTS.toolEnd,
        id: "sentry/tool",
        priority: 0,
        fn: async (_agent, event) => {
          try {
            const e = (event ?? {}) as EventPayload & {
              call?: { name?: unknown; parameters?: unknown };
              result?: { answer?: unknown; error?: unknown; errorMessage?: unknown; stored?: unknown };
            };
            const callName = typeof e.call?.name === "string" ? e.call.name : "unknown";
            const result = {
              answer: typeof e.result?.answer === "string" ? e.result.answer : "",
              error: e.result?.error === true,
              errorMessage: typeof e.result?.errorMessage === "string" ? e.result.errorMessage : undefined,
              stored: e.result?.stored,
            };
            crumbFromTool(callName, result);
            if (!toolGate.enabled) return;
            if (!isSelected(callName, toolGate.include, toolGate.exclude)) return;
            const params = (e.call?.parameters as Record<string, unknown> | undefined) ?? {};
            let escalated = false;
            if (toolGate.match) {
              try {
                escalated = toolGate.match({ name: callName, parameters: params }, result) === true;
              } catch {
                escalated = false;
              }
            }
            if (!escalated && !isThrownResult(result)) return; // returned/noise/success → crumb only
            const err = result.stored !== undefined && typeof (result.stored as Record<string, unknown>)?.trace === "string"
              ? Object.assign(new Error(result.errorMessage ?? result.answer), { stack: (result.stored as Record<string, unknown>).trace as string })
              : new Error(result.errorMessage ?? result.answer);
            const evt = baseEvent("error", { lane: "tool", tool: callName });
            evt.exception = { values: [exceptionFrom(err, "auto.sanity.tool", true)] };
            evt.extra = { parameters: params };
            capture(evt);
          } catch {
            // Self-guard.
          }
        },
      });

      // ---- lane 4: log lines → always a crumb; error+ → issue when on ----
      agent.addFilter({
        event: LOG_CHANNEL,
        id: "sentry/log",
        priority: 0,
        fn: async (_agent, event) => {
          try {
            const e = (event ?? {}) as unknown as LogEntry;
            if (typeof e.message !== "string" || typeof e.source !== "string") return;
            crumbFromLog(e);
            if (!logGate.enabled) return;
            if (!isSelected(e.source, logGate.include, logGate.exclude)) return;
            if (logRank(e.level) < logMinRank) return; // warn and below → crumb only
            const evt = baseEvent("error", { lane: "log", source: e.source });
            evt.logger = e.source;
            evt.exception = {
              values: [{ type: "Error", value: e.message, mechanism: { type: "auto.sanity.log", handled: true } }],
            };
            if (e.data !== undefined) evt.extra = { data: e.data };
            capture(evt);
          } catch {
            // Self-guard.
          }
        },
      });
      agent.addDeclaredCapability({ id: "sentry", description: "Sentry error monitoring across all four error lanes" });
    },
    uninstall(agent: GodObject) {
      removeFiltersByPrefix(agent, "sentry/");
      agent.removeDeclaredCapability("sentry");
    },
    async flush(): Promise<void> {
      await Promise.allSettled([...inflight]);
    },
  };
}
