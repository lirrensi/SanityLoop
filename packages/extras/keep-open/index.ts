// sanity/src/extras/keep-open.ts — the session. The OPPOSITE of quit-on-end.
//
// The Viola loop never returns on its own, so a process stays alive by default.
// The two plugins decide what "done" means for YOUR consumer:
//
//   createQuitOnEndPlugin()  → a WORKER: the process dies when the work is done
//   createKeepOpenPlugin()   → a SESSION: the loop stays open, and onReady()
//                              fires at every graceful landing — the signal
//                              that the channel should open for the next input
//
// They are mutually exclusive — pick the behavior you want. A repl installs
// keep-open (its onReady re-prompts); a batch worker installs quit-on-end.
//
// "Ready" = a graceful completion (loopState idle after stop). A PARKED
// landing (awaiting — waiting for a specific answer, e.g. a permission gate)
// is NOT ready: the same input channel must not re-prompt for a new message
// while an old one is still parked.
import { EVENTS } from "@sanityloop/core";
import type { Plugin } from "@sanityloop/core";
import { removeFiltersByPrefix } from "@sanityloop/util";

export interface KeepOpenOptions {
	/** Fired at every graceful landing — the channel opens for the next input. */
	onReady?: () => void;
}

export function createKeepOpenPlugin(opts: KeepOpenOptions = {}): Plugin {
	return {
		id: "keep-open",
		install(agent) {
			agent.addFilter({
				event: EVENTS.stop,
				id: "keep-open/ready",
				priority: 0,
				fn: async (agent) => {
					// graceful completion only — never while parked awaiting
					if (agent.loopState === "idle" && opts.onReady) opts.onReady();
				},
			});
			agent.addDeclaredCapability({ id: "keep-open", description: "session stays open (re-prompts on landing)" });
		},
		uninstall(agent) {
			removeFiltersByPrefix(agent, "keep-open/");
			agent.removeDeclaredCapability("keep-open");
		},
	};
}
