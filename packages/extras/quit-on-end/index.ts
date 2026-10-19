// sanity/src/extras/quit-on-end.ts — the process dies naturally when the agent is done.
//
// The Viola loop's own timer (`await sleep(10)`) is a ref'd Node handle — that
// is what keeps the process breathing forever. THIS plugin is the explicit
// kill switch: on `agentEnd` (the loop's own end signal, fired at every
// landing and at terminal teardown) it quits — mode "exit" calls process.exit;
// modes "terminate"/"destroy" stop only THIS agent's heart (run() resolves),
// safe when the process hosts other agents too.
//
// TERMINAL SPLIT — exit code answers "did the process FAIL?" Only `errored`
// says yes:
//   - terminated → quit immediately, canQuit bypassed, exit 0 (deliberate
//     death, clean — exiting 1 here lied to supervisors: PM2 sees "crash",
//     may restart what you asked to die).
//   - aborted then parked → LANDING path (built-ins + canQuit consulted),
//     exit 0 if clear; stand down + warn if vetoed.
//   - errored → log loudly, then gate: canQuit consulted, exit 1 if clear;
//     stand down + warn if vetoed.
//
// MODES — how the quit happens:
//   - "exit" (default): process.exit — the classic one-daemon-per-process kill.
//   - "terminate": agent.terminate() — MULTI-AGENT-SAFE: only THIS agent's
//     heart stops, run() resolves, the host process lives on for everyone
//     else. No exit codes here — the host reads loopState after run() settles.
//   - "destroy": agent.destroy() — like "terminate", plus zero leak: the husk
//     is stripped (plugins uninstalled, guts nulled). The one-shot-pool mode.
//
// UNIFIED CONTRACT — the landing path stands down while work is owed or a
// rebuild is in flight:
//   - a follow-up inserted at the landing (state.inputFollowUp drained at
//     stop) means a new turn is about to run — `agent.hasWork` is true;
//   - a compaction rebuild is in flight (state.compacting) — the machine will
//     wake and continue after the rebuild;
//   - `canQuit` vetoes — YOUR predicate says something out-of-band is still
//     alive (background bash jobs, a server you started, ...). Veto = warn
//     loudly + stand down. Consulted on the landing path AND the errored
//     path; bypassed only by terminated (deliberate death).
// So "done" means the machine says done AND nothing is mid-flight.
import { EVENTS } from "@sanityloop/core";
import type { GodObject, Plugin } from "@sanityloop/core";
import { emitLog, removeFiltersByPrefix } from "@sanityloop/util";

export interface QuitOnEndOptions {
	/** Exit code on graceful completion. Default: 0. */
	code?: number;
	/** Exit code on errored (the ONLY terminal state that fails). Default: 1. */
	errorCode?: number;
	/** HOW to quit.
	 *  - "exit" (default): process.exit — the classic one-daemon-per-process kill.
	 *  - "terminate": agent.terminate() — MULTI-AGENT-SAFE: only THIS agent's
	 *    heart stops, run() resolves, the host process lives on for everyone
	 *    else. No exit codes here — the host reads loopState after run() settles.
	 *  - "destroy": agent.destroy() — like "terminate", plus zero leak: the
	 *    husk is stripped (plugins uninstalled, guts nulled). The one-shot-pool
	 *    mode. */
	mode?: "exit" | "terminate" | "destroy";
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
					// TERMINAL SPLIT — exit code answers "did the process FAIL?"
					// Only `errored` says yes.
					const s = agent.loopState;
					if (s === "terminated") {
						// DELIBERATE DEATH — quit immediately, canQuit bypassed,
						// exit 0 (terminated exiting 1 was a lie to supervisors:
						// PM2 sees "crash", may restart what you asked to die).
						if (mode === "destroy") {
							void agent.destroy(`quit-on-end:${s}`);
							return;
						}
						if (mode === "terminate") {
							void agent.terminate(`quit-on-end:${s}`);
							return;
						}
						process.exit(code);
					}
					if (s === "errored") {
						// ERRORED — log loudly, then gate: canQuit consulted,
						// exit 1 if clear; stand down + warn if vetoed.
						const msg = `quit-on-end: agent errored — quitting with exit ${errorCode}`;
						console.error(`[sanity] ${msg}`);
						emitLog(agent, "error", "quit-on-end", msg, { loopState: s, errorCode });
						if (await gateClear(agent, canQuit)) {
							if (mode === "destroy") {
								void agent.destroy(`quit-on-end:${s}`);
								return;
							}
							if (mode === "terminate") {
								void agent.terminate(`quit-on-end:${s}`);
								return;
							}
							process.exit(errorCode);
						}
						return;
					}
					// LANDING PATH — graceful completion AND aborted-then-parked.
					// An aborted agent keeps ticking silently (parked, not dead),
					// so the quit decision goes through the normal gate and the
					// exit is clean 0 — the abort filter already killed the jobs
					// on the abort channel.
					// Built-ins first: owed work or a compaction rebuild in
					// flight means the machine will keep going — stand down.
					if (agent.hasWork) return;
					if (agent.state.compacting) return;
					// YOUR gate last — out-of-band work the loop can't see.
					if (!(await gateClear(agent, canQuit))) return;
					if (mode === "destroy") {
						void agent.destroy("quit-on-end:done");
						return;
					}
					if (mode === "terminate") {
						// heart-stop lane — idempotent, safe even mid-teardown
						void agent.terminate("quit-on-end:done");
						return;
					}
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

/** Run the canQuit gate. True = clear to quit. False = veto/throw: warn + stand down. */
async function gateClear(agent: GodObject, canQuit: QuitOnEndOptions["canQuit"]): Promise<boolean> {
	if (!canQuit) return true;
	let allowed: boolean;
	try {
		allowed = canQuit(agent);
	} catch (err) {
		// fail-closed: a predicate bug must never kill live work
		console.error("[sanity] quit-on-end: canQuit threw — standing down:", err);
		emitLog(agent, "error", "quit-on-end", "canQuit threw — standing down", {
			error: err instanceof Error ? err.message : String(err),
		});
		return false;
	}
	if (!allowed) {
		const msg = "quit-on-end: canQuit vetoed — out-of-band work still alive, keeping the process breathing";
		console.warn(`[sanity] ${msg}`);
		emitLog(agent, "warn", "quit-on-end", msg);
		return false;
	}
	return true;
}
