import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CellClock, MAX_TIMEOUT_MS, MIN_TIMEOUT_MS, resolveCellTimeoutMs } from "../clock.ts";

describe("resolveCellTimeoutMs", () => {
    it("defaults to 60 s", () => {
        assert.equal(resolveCellTimeoutMs(undefined), 60_000);
    });
    it("converts seconds to ms", () => {
        assert.equal(resolveCellTimeoutMs(5), 5_000);
        assert.equal(resolveCellTimeoutMs(0.5), 1_000); // sub-second clamps to the floor
    });
    it("clamps to 1–3600 (0/negatives clamp, never disable)", () => {
        assert.equal(resolveCellTimeoutMs(0), MIN_TIMEOUT_MS);
        assert.equal(resolveCellTimeoutMs(-3), MIN_TIMEOUT_MS);
        assert.equal(resolveCellTimeoutMs(9999), MAX_TIMEOUT_MS);
    });
    it("rejects non-numbers as error results", () => {
        assert.deepEqual(resolveCellTimeoutMs("60"), { error: `code: invalid timeout '60' — must be a number of seconds (1–3600)` });
        assert.deepEqual(resolveCellTimeoutMs(Number.NaN), { error: `code: invalid timeout 'NaN' — must be a number of seconds (1–3600)` });
    });
});

describe("CellClock", () => {
    it("remaining() excludes paused time", () => {
        let now = 1000;
        const clock = new CellClock(60_000, 1000, () => now);
        now = 21_000; // 20 s compute
        assert.equal(clock.remaining(), 40_000);
        clock.pause();
        now = 100_000; // 79 s paused (host work)
        assert.equal(clock.remaining(), 40_000);
        clock.resume();
        now = 110_000; // 10 s more compute
        assert.equal(clock.remaining(), 30_000);
        assert.equal(clock.activeMs, 30_000);
    });
    it("pause is ref-counted", () => {
        let now = 0;
        const clock = new CellClock(10_000, 0, () => now);
        clock.pause();
        clock.pause();
        now = 5_000;
        clock.resume();
        assert.equal(clock.paused, true);
        assert.equal(clock.remaining(), 10_000);
        clock.resume();
        assert.equal(clock.paused, false);
        now = 6_000;
        assert.equal(clock.remaining(), 9_000);
    });
    it("resume without pause is a no-op", () => {
        const clock = new CellClock(10_000, 0, () => 100);
        clock.resume();
        assert.equal(clock.paused, false);
        assert.equal(clock.remaining(), 9_900); // 100ms active time accrued, resume changed nothing
    });
    it("ceilingRemaining never pauses", () => {
        let now = 0;
        const clock = new CellClock(60_000, 0, () => now);
        clock.pause();
        now = 3_000_000;
        assert.equal(clock.ceilingRemaining(3_600_000), 600_000);
        assert.equal(clock.remaining(), 60_000);
    });
    it("remaining floors at zero", () => {
        let now = 0;
        const clock = new CellClock(1_000, 0, () => now);
        now = 5_000;
        assert.equal(clock.remaining(), 0);
        assert.equal(clock.activeMs, 5_000);
    });
});
