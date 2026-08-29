export {
	HASH_LEN,
	ANCHOR_LEN,
	HASH_SEP,
	HASH_CLASS,
	HASH_SPACE,
	HASH_PROBE_STRIDE,
	MAX_HASH_LINES,
	lineHashes,
	_lineHashesPure,
	initHasher,
	canon,
} from "./hash.ts";

export {
	parseHashRef,
	parseText,
	type Anchor,
} from "./parse.ts";

export {
	type HEdit,
	type RHEdit,
	type HTEdit,
	type NEdit,
	type BDup,
	type AutoFix,
	resEdit,
	valEdit,
	stripBarePrefixes,
	stripDiffPrefixes,
	swapReversedRanges,
	findNewEdge,
	assertRangeServed,
	RangeStaleError,
	AnchorMismatchError,
} from "./resolve.ts";

export {
	buildIdx,
	applyEdit,
	fmtRegion,
	changedRange,
} from "./apply.ts";
