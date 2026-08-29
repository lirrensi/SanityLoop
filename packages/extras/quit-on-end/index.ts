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
// It does NOT exit while the agent is still owed work:
//   - a follow-up inserted at the landing (state.inputFollowUp drained at
//     stop) means a new turn is about to run — `agent.hasWork` is true;
//   - a compaction rebuild is in flight (state.compacting) — the machine will
//     wake and continue after the rebuild.
// So "done" means the machine says done AND nothing is mid-flight.
//
// EXTRA = optional, import-or-not. A consumer that wants a one-shot daemon
// wires it: agent.install(createQuitOnEndPlugin()).
import { EVENTS } from "@sanityloop/core";
import type { Plugin } from "@sanityloop/core";
import { removeFiltersByPrefix } from "@sanityloop/util";

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
}

export function createQuitOnEndPlugin(opts: QuitOnEndOptions = {}): Plugin {
	const code = opts.code ?? 0;
	const errorCode = opts.errorCode ?? 1;
	const mode = opts.mode ?? "exit";
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
					if (mode === "terminate") {
						// heart-stop lane — idempotent, safe even mid-teardown
						void agent.terminate(terminal ? `quit-on-end:${agent.loopState}` : "quit-on-end:done");
						return;
					}
					if (terminal) process.exit(errorCode);
					// not done yet — a follow-up was just inserted at the landing, or a
					// compaction rebuild is in flight: the machine will keep going
					if (agent.hasWork) return;
					if ((agent.state as { compacting?: boolean }).compacting) return;
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
