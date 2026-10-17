// packages/extras/shell-tool/test/job-manager.test.ts — manager lifecycle without processes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { waitUntil } from "@sanityloop/test-kit";
import { JobManager, type Job, type JobOutcome } from "../job-manager.ts";

/** ES2022-safe deferred (no Promise.withResolvers at this target). */
function deferred<T = string>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** The manager's settle runs on the run's completion — awaiting it guarantees settle ran. */
async function settled(manager: JobManager, id: string, completion: Promise<unknown>): Promise<Job> {
  await completion.catch(() => {});
  await waitUntil(() => {
    const job = manager.get(id);
    return job !== undefined && job.status !== "running";
  }, { what: `job ${id} to settle` });
  return manager.get(id)!;
}
test("register → completion settles + delivers via onSettle", async () => {
  const seen: Job[] = [];
  const manager = new JobManager({ onSettle: (j) => seen.push(j), retentionMs: 60_000 });
  const run = deferred<string>();
  const id = manager.register({ completion: run.promise, cancel: () => {}, label: "echo hi" });
  assert.equal(id, "bg_1");
  assert.equal(manager.hasRunning(), true);
  assert.equal(manager.list().length, 1);
  run.resolve("hi\n");
  const job = await settled(manager, id, run.promise);
  assert.equal(job.status, "completed");
  assert.equal(job.resultText, "hi\n");
  assert.equal(seen.length, 1);
  assert.equal(seen[0].id, id);
  assert.equal(manager.hasRunning(), false);
  manager.dispose();
});

test("rejection settles failed + delivers the message", async () => {
  const seen: Job[] = [];
  const manager = new JobManager({ onSettle: (j) => seen.push(j), retentionMs: 60_000 });
  const run = deferred<string>();
  const id = manager.register({ completion: run.promise, cancel: () => {} });
  run.reject(new Error("boom"));
  const job = await settled(manager, id, run.promise);
  assert.equal(job.status, "failed");
  assert.equal(job.resultText, "boom");
  assert.equal(seen.length, 1);
  manager.dispose();
});

test("cancel kills the run, records cancelled, never delivers", async () => {
  const seen: Job[] = [];
  let cancelCalls = 0;
  const manager = new JobManager({ onSettle: (j) => seen.push(j), retentionMs: 60_000 });
  const run = deferred<string>();
  const id = manager.register({
    completion: run.promise,
    cancel: () => {
      cancelCalls++;
      run.reject(new Error("aborted"));
    },
  });
  assert.equal(manager.cancel(id), true);
  assert.equal(manager.cancel(id), false); // second cancel is a no-op
  const job = await settled(manager, id, run.promise);
  assert.equal(job.status, "cancelled");
  assert.equal(cancelCalls, 1);
  assert.equal(seen.length, 0);
  manager.dispose();
});

test("foreground rows hide until backgroundJob promotes them", async () => {
  const manager = new JobManager({ retentionMs: 60_000 });
  const run = deferred<string>();
  const id = manager.register({ completion: run.promise, cancel: () => {} }, { foreground: true });
  assert.equal(manager.get(id), undefined);
  assert.equal(manager.list().length, 0);
  assert.equal(manager.hasRunning(), true); // hidden but still counts
  assert.equal(manager.backgroundJob(id), true);
  assert.ok(manager.get(id));
  assert.equal(manager.list().length, 1);
  run.resolve("done");
  await settled(manager, id, run.promise);
  manager.dispose();
});

test("releaseForegroundJob discards silently — settle never delivers, row gone", async () => {
  const seen: Job[] = [];
  const manager = new JobManager({ onSettle: (j) => seen.push(j), retentionMs: 60_000 });
  const run = deferred<string>();
  const id = manager.register({ completion: run.promise, cancel: () => run.reject(new Error("aborted")) }, { foreground: true });
  manager.releaseForegroundJob(id);
  assert.equal(manager.get(id), undefined);
  run.resolve("late");
  await run.promise.catch(() => {}); // released-while-running cancels first — rejection expected
  assert.equal(seen.length, 0);
  assert.equal(manager.list().length, 0);
  manager.dispose();
});

test("capacity cap throws; ids are monotonic and never recycled", async () => {
  const manager = new JobManager({ maxJobs: 1, retentionMs: 10 });
  const run1 = deferred<string>();
  const id1 = manager.register({ completion: run1.promise, cancel: () => {} });
  assert.equal(manager.atCapacity, true);
  assert.throws(() => manager.register({ completion: Promise.resolve("x"), cancel: () => {} }), /limit reached/);
  run1.resolve("one");
  await settled(manager, id1, run1.promise);
  // Exception: retention eviction IS the real timer behavior under test —
  // waitUntil polls the condition (no fixed sleep), the 10ms timer is the code's own.
  await waitUntil(() => manager.get(id1) === undefined, { what: "retention to evict the row" });
  const run2 = deferred<string>();
  const id2 = manager.register({ completion: run2.promise, cancel: () => {} });
  assert.equal(id2, "bg_2"); // monotonic — evicted ids never recycled
  run2.resolve("two");
  await settled(manager, id2, run2.promise);
  manager.dispose();
});
test("JobOutcome object stamps status + metadata on the row", async () => {
  const manager = new JobManager({ retentionMs: 60_000 });
  const run = deferred<string | JobOutcome>();
  const id = manager.register({ completion: run.promise, cancel: () => {} });
  run.resolve({ text: "partial output", failed: true, timedOut: true, fullOutputPath: "/tmp/full.log" });
  const job = await settled(manager, id, run.promise);
  assert.equal(job.status, "failed");
  assert.equal(job.resultText, "partial output");
  assert.equal(job.timedOut, true);
  assert.equal(job.fullOutputPath, "/tmp/full.log");
  const snap = manager.snapshot(job);
  assert.equal(snap.timedOut, true);
  assert.deepEqual(Object.keys(snap).sort(), ["endTime", "id", "label", "startTime", "status", "timedOut"]);
  manager.dispose();
});
test("dispose cancels running + clears everything", async () => {
  let cancelCalls = 0;
  const manager = new JobManager({ retentionMs: 60_000 });
  const run = deferred<string>();
  manager.register({ completion: run.promise, cancel: () => { cancelCalls++; run.reject(new Error("aborted")); } });
  manager.dispose();
  assert.equal(cancelCalls, 1);
  assert.equal(manager.list().length, 0);
  assert.equal(manager.hasRunning(), false);
  assert.throws(() => manager.register({ completion: Promise.resolve("x"), cancel: () => {} }), /disposed/);
  await run.promise.catch(() => {}); // swallow the rejection dispose caused
});
