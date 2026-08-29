// ============================================================================
// tui/index.ts — @sanityloop/tui — light terminal UI kit for extensions.
// ============================================================================
// What lives here: a battle-tested key parser (vendored from pi), a
// state-driven bottom input block (bordered editor + autocomplete popup +
// status bar row). What does NOT live here: any knowledge about agents,
// loops, or SanityLoop itself. Pure Lego.
// ============================================================================

export {
	matchesKey,
	parseKey,
	decodePrintableKey,
	setKittyProtocolActive,
	isKittyProtocolActive,
	Key,
	type KeyId,
} from "./keys.ts";

export {
	createInputBlock,
	type InputBlockOptions,
	type Suggestion,
} from "./input-block.ts";

export { formatStatusBar, type StatusBarParts } from "./status-bar.ts";
