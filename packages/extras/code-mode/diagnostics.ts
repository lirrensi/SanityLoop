// ============================================================================
// packages/extras/code-mode/diagnostics.ts — InvalidToolInput message format.
// ============================================================================
// Authority split: the HOST is the only validator. After it returns
// invalid_arguments, the host enriches with pointers/hints. Host error
// strings pass through verbatim, in order.
//
// Message shape (stable, capped at 1200 chars):
//   Invalid arguments for read: property "offset" must be integer
//   Signature: read(path, offset?, limit?)
//   Hint: ...
// ============================================================================

import type { ToolShape } from "./shapes.ts";

export function suggestKey(shape: ToolShape, key: string): string | undefined {
    const q = key.toLowerCase();
    let best: string | undefined;
    let bestDist = 3;
    for (const f of shape.fields) {
        if (f.name.toLowerCase() === q) return f.name;
        const d = levenshtein(q, f.name.toLowerCase());
        if (d < bestDist) {
            bestDist = d;
            best = f.name;
        }
    }
    return bestDist <= 2 ? best : undefined;
}

function levenshtein(a: string, b: string): number {
    if (a === b) return 0;
    const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
        let diag = prev[0]!;
        prev[0] = i;
        for (let j = 1; j <= b.length; j++) {
            const tmp = prev[j]!;
            prev[j] = Math.min(prev[j]! + 1, prev[j - 1]! + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
            diag = tmp;
        }
    }
    return prev[b.length]!;
}

/** Enrich a host invalid_arguments failure. `hostAnswer` is the verbatim
 * line 1 (prefix included). At most 2 hints, dropped first over the cap. */
export function formatInvalidToolInput(
    tool: string,
    signature: string,
    hostAnswer: string,
    hostErrors: string[],
    shape: ToolShape | undefined,
): string {
    const hints: string[] = [];
    if (shape !== undefined && !shape.hasCustomValidate) {
        for (const err of hostErrors) {
            if (hints.length >= 2) break;
            const hint = hintFor(shape, err);
            if (hint !== undefined) hints.push(hint);
        }
    }
    if (hints.length === 0) hints.push(`call tools.help("${tool}") for the full contract.`);
    const lines = [hostAnswer, `Signature: ${signature}`, ...hints.slice(0, 2).map((h) => `Hint: ${h}`)];
    let out = lines.join("\n");
    if (out.length > 1200) {
        // Drop hints first, keep the host answer + signature.
        out = [hostAnswer, `Signature: ${signature}`].join("\n");
        if (out.length > 1200) out = `${out.slice(0, 1197)}...`;
    }
    return out;
}

function hintFor(shape: ToolShape, hostError: string): string | undefined {
    // unknown property "offest" → did-you-mean.
    const unknown = /^unknown property "([^"]+)"$/.exec(hostError);
    if (unknown) {
        const suggestion = suggestKey(shape, unknown[1]!);
        const accepted = shape.fields.map((f) => f.name).join(", ");
        return suggestion !== undefined
            ? `did you mean "${suggestion}"? accepted: ${accepted}.`
            : `accepted: ${accepted}.`;
    }
    // missing required property "path" → required list.
    const missing = /^missing required property "([^"]+)"$/.exec(hostError);
    if (missing) return `required: ${missing[1]}.`;
    // property "mode" must be one of ... → allowed list (already in the error;
    // surface the signature-adjacent short form).
    const oneOf = /^property "([^"]+)" must be one of (.+)$/.exec(hostError);
    if (oneOf) return `allowed: ${oneOf[2]}.`;
    return undefined;
}

/** Unknown tool: same grammar the loop uses, plus a suggestion. */
export function formatUnknownTool(name: string, suggestion: string | undefined): string {
    const hint = suggestion !== undefined
        ? `did you mean "${suggestion}"? use tools.search("${name}") to browse.`
        : `use tools.search("${name}") to browse.`;
    return [`Unknown tool: ${name}`, "Signature: (no such tool)", `Hint: ${hint}`].join("\n");
}
