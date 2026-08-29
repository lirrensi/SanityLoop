// ============================================================================
// token-estimate — heuristic token counting for providers that don't report usage
// ============================================================================
// llama.cpp and some other local providers don't include `usage` in the
// chat completion response. Without it, our stats would be all zeros — useless
// for monitoring. This module provides a lightweight fallback estimate:
//
//   1 token ≈ 4 characters (the OpenAI rule of thumb — good enough for fallback)
//
// We estimate from the message content we sent (input) and the text we
// received (output). The provider-reported value always wins when present;
// this is the SAFETY NET, not the primary path.
// ============================================================================

import type { Message } from "./types.ts";

/** Estimate tokens for a single message — sums character counts of text/tool content, divides by 4. */
export function estimateMessageTokens(message: Message): number {
	const c = message.content as unknown;
	let chars = 0;
	if (typeof c === "string") {
		chars = c.length;
	} else if (Array.isArray(c)) {
		for (const block of c as {
			type?: string;
			text?: string;
			content?: string;
		}[]) {
			if (typeof block?.text === "string") chars += block.text.length;
			else if (typeof block?.content === "string")
				chars += block.content.length;
		}
	} else if (c && typeof c === "object") {
		const obj = c as { answer?: string; stored?: unknown };
		if (typeof obj.answer === "string") chars += obj.answer.length;
		if (obj.stored !== undefined) chars += JSON.stringify(obj.stored).length;
	}
	return Math.ceil(chars / 4);
}

/** Estimate input tokens across a message list (sums per-message, with a 10% overhead for prompt framing). */
export function estimateInputTokens(messages: Message[]): number {
	const sum = messages.reduce((acc, m) => acc + estimateMessageTokens(m), 0);
	return Math.ceil(sum * 1.1); // +10% for system prompt framing + formatting overhead
}

/** Estimate output tokens from a text string. */
export function estimateOutputTokens(text: string): number {
	return Math.ceil(text.length / 4);
}
