// sanity/src/extras/quit-on-end.ts — the process dies naturally when the agent is done.
//
// The Viola loop's own timer (`await sleep(10)`) is a ref'd Node handle — that
// is what keeps the process breathing forever. THIS plugin is the explicit
// kill switch: on `agentEnd` (the loop's own end signal, fired at every
// landing and at terminal teardown) it quits — mode "exit" calls process.exit
// (0 on graceful completion, 1 on terminal aborted/errored/terminated);
// mode "terminate" calls agent.terminate() so ONLY this agent's heart stops
// and run() resolves — safe when the process hosts other agents too.
//
// UNIFIED CONTRACT — both modes stand down while work is owed or a rebuild
// is in flight; terminal states (aborted/errored/terminated) always quit
// immediately, work or no:
//   - terminal first: the agent is dead — work will never be done;
//   - a follow-up inserted at the landing (state.inputFollowUp drained at
//     stop) means a new turn is about to run — `agent.hasWork` is true;
//   - a compaction rebuild is in flight (state.compacting) — the machine will
//     wake and continue after the rebuild;
//   - `canQuit` vetoes — YOUR predicate says something out-of-band is still
//     alive (background bash jobs, a server you started, ...). Veto = warn
//     loudly + stand down. The predicate is consulted on the NON-terminal
//     path only; terminal states bypass it (the agent is dead — the abort
//     filter already killed the jobs).
// So "done" means the machine says done AND nothing is mid-flight.
//
// ⚠ BARE QUIT-ON-END + BACKGROUND JOBS = ORPHANS. A backgrounded `sleep 300`
// keeps NO loop work owed — without `canQuit` the process exits at the first
// landing and the child is orphaned (POSIX) or dies with the process. ALWAYS
// wire `canQuit` when background is on: `canQuit: () => !bash.jobs.hasRunningJobs()`.
//
// EXTRA = optional, import-or-not. A consumer that wants a one-shot daemon
// wires it: agent.install(createQuitOnEndPlugin()).
import { EVENTS } from "@sanityloop/core";
import type { GodObject, Plugin } from "@sanityloop/core";
import { emitLog, removeFiltersByPrefix } from "@sanityloop/util";

export interface QuitOnEndOptions {
	/** Exit code on graceful completion. Default: 0. */
	code?: number;
	/** Exit code on terminal (aborted/errored/terminated). Default: 1. */
	errorCode?: number;
	/** HOW to quit.
	 *  - "exit" (default): process.exit — the classic one-daemon-per-process kill.
	 *  - "terminate": agent.terminate() — MULTI-AGENT-SAFE: only THIS agent's
	 *    heart stops, run() resolves, the host process lives on for everyone
	 *    else. No exit codes here — the host reads loopState after run() settles. */
	mode?: "exit" | "terminate";
	/** Extra quit gate — consulted on the NON-terminal path only, after the
	 * built-ins pass. Return false to VETO the quit (warn + stand down).
	 * Sync, fail-closed: a throw logs an error and stands down (never kill
	 * out-of-band work on a predicate bug). The template case:
	 * `canQuit: () => !bash.jobs.hasRunningJobs()`. */
	canQuit?: (agent: GodObject) => boolean;
}
export function createQuitOnEndPlugin(opts: QuitOnEndOptions = {}): Plugin {
	const code = opts.code ?? 0;
	const errorCode = opts.errorCode ?? 1;
	const mode = opts.mode ?? "exit";
	const canQuit = opts.canQuit;
	return {
		id: "quit-on-end",
		install(agent) {
			agent.addFilter({
				event: EVENTS.agentEnd,
				id: "quit-on-end/exit",
				priority: 0,
				fn: async (agent) => {
					// terminal first: the agent is dead — work will never be done
					const terminal =
						agent.loopState === "aborted" ||
						agent.loopState === "errored" ||
						agent.loopState === "terminated";
					if (!terminal) {
						// not done yet — a follow-up was just inserted at the landing, or a
						// compaction rebuild is in flight: the machine will keep going
						if (agent.hasWork) return;
						if (agent.state.compacting) return;
						// YOUR gate last — out-of-band work the loop can't see
						if (canQuit) {
							let allowed: boolean;
							try {
								allowed = canQuit(agent);
							} catch (err) {
								// fail-closed: a predicate bug must never kill live work
								console.error("[sanity] quit-on-end: canQuit threw — standing down:", err);
								emitLog(agent, "error", "quit-on-end", "canQuit threw — standing down", {
									error: err instanceof Error ? err.message : String(err),
								});
								return;
							}
							if (!allowed) {
								const msg = "quit-on-end: canQuit vetoed — out-of-band work still alive, keeping the process breathing";
								console.warn(`[sanity] ${msg}`);
								emitLog(agent, "warn", "quit-on-end", msg);
								return;
							}
						}
					}
					if (mode === "terminate") {
						// heart-stop lane — idempotent, safe even mid-teardown
						void agent.terminate(terminal ? `quit-on-end:${agent.loopState}` : "quit-on-end:done");
						return;
					}
					if (terminal) process.exit(errorCode);
					process.exit(code);
				},
			});
			agent.addDeclaredCapability({ id: "quit-on-end", description: "worker exits when the work is done" });
		},
		uninstall(agent) {
			removeFiltersByPrefix(agent, "quit-on-end/");
			agent.removeDeclaredCapability("quit-on-end");
		},
	};
}
