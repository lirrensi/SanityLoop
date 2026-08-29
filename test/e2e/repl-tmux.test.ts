// ============================================================================
// test/e2e/repl-tmux.test.ts — THE INTERACTIVE SURFACE, ALIVE IN A REAL TTY.
// ============================================================================
// Per AGENTS.md law: the REPL is tested inside an ISOLATED tmux session —
// never from our own shell. We derive the repl-agent composition with a stub
// model (take template, change something), boot it in tmux, type at it, and
// require: banner → prompt → reply → RE-PROMPT (the loop stays alive) →
// /exit leaves the REPL. Skips cleanly when tmux is absent.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { deriveAgent, STUB_REPL_SOURCE } from "./helpers/derive.ts";
import { sleep } from "@sanityloop/test-kit";

const SESSION = `sanity-e2e-repl-${Date.now().toString(36)}`;

function tmuxOk(): boolean {
    try {
        return spawnSync("tmux", ["-V"], { windowsHide: true }).status === 0;
    } catch {
        return false;
    }
}

function tmux(...args: string[]): string {
    try {
        return execFileSync("tmux", args, { encoding: "utf8", windowsHide: true });
    } catch {
        return "";
    }
}

function capture(): string {
    const raw = tmux("capture-pane", "-t", SESSION, "-p");
    // The micro-TUI paints with ANSI — strip escapes so markers match cleanly.
    return raw.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
}

function sessionAlive(): boolean {
    const list = tmux("list-sessions", "-F", "#S");
    return list.split("\n").includes(SESSION);
}

test("repl: prompt → reply → re-prompt → /exit, inside isolated tmux", async (t) => {
    if (!tmuxOk()) return t.skip("tmux not available");

    const { file } = await deriveAgent(t, "stub-repl.ts", STUB_REPL_SOURCE);
    const scriptPath = file.replaceAll("\\", "/");
    t.after(() => {
        tmux("kill-session", "-t", SESSION);
    });

    // Boot in a detached 120x40 pane (the house shape).
    tmux("new-session", "-d", "-x", "120", "-y", "40", "-s", SESSION);
    await sleep(800); // let the shell settle before typing at it
    tmux(
        "send-keys",
        "-t",
        SESSION,
        `node --experimental-strip-types --experimental-transform-types "${scriptPath}"`,
        "Enter",
    );

    // Banner + first prompt.
    let pane = "";
    const bootDeadline = Date.now() + 20_000;
    while (Date.now() < bootDeadline) {
        pane = capture();
        if (pane.includes("sanity repl") && pane.includes("you>")) break;
        await sleep(300);
    }
    assert.ok(pane.includes("sanity repl"), `no banner\npane:\n${pane}`);
    assert.ok(pane.includes("you>"), `no prompt\npane:\n${pane}`);

    // Type a real prompt; require the REPLY TEXT to actually paint. This is
    // the regression guard for the stream-delivery fix: deltas dispatch via
    // the registry lane + seam flush, so even a non-streaming stub's reply
    // renders before the landing. Markdown-inert text (no underscores).
    tmux("send-keys", "-t", SESSION, "hello stub", "Enter");
    const replyDeadline = Date.now() + 15_000;
    while (Date.now() < replyDeadline) {
        pane = capture();
        if (pane.includes("STUB REPLY 1 OK")) break;
        await sleep(300);
    }
    assert.ok(
        pane.includes("STUB REPLY 1 OK"),
        `reply never painted\npane:\n${pane}`,
    );

    // THE re-prompt — the loop landed and the session stayed open. The prompt
    // redraws ~10ms after landing (setTimeout), so POLL for it after the reply
    // instead of asserting from the same snapshot that first saw the reply.
    const replyAt = pane.indexOf("STUB REPLY 1 OK");
    let rePromptAt = -1;
    const promptDeadline = Date.now() + 5_000;
    while (Date.now() < promptDeadline) {
        pane = capture();
        rePromptAt = pane.indexOf("you>", replyAt + 1);
        if (rePromptAt > replyAt) break;
        await sleep(150);
    }
    assert.ok(rePromptAt > replyAt, `no re-prompt after reply\npane:\n${pane}`);

    // /exit must leave the REPL. A dead pane KEEPS its last pixels (the old
    // "you>" lingers above whatever comes next), so "prompt gone" proves
    // nothing. Decisive signals: the repl's "bye!" farewell with a FRESH pwsh
    // prompt below it — or the tmux session itself gone.
    tmux("send-keys", "-t", SESSION, "/exit", "Enter");
    const exitDeadline = Date.now() + 10_000;
    let leftRepl = false;
    while (Date.now() < exitDeadline) {
        if (!sessionAlive()) {
            leftRepl = true;
            break;
        }
        pane = capture();
        const byeAt = pane.lastIndexOf("bye!");
        if (byeAt !== -1 && pane.indexOf("PS ", byeAt) > byeAt) {
            leftRepl = true;
            break;
        }
        await sleep(300);
    }
    assert.ok(leftRepl, `still sitting at the REPL after /exit\npane:\n${pane}`);
});
