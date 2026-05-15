"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { RequestQueue } = require("../src/queue");

test("RequestQueue runs with max concurrency 1", async () => {
  const queue = new RequestQueue({
    maxConcurrent: 1,
    maxQueueSize: 10,
    maxQueueAgeMs: 1000
  }, () => {});
  let active = 0;
  let maxActive = 0;

  const tasks = [1, 2, 3].map((id) => queue.enqueue({ eventId: `e${id}` }, async () => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 10));
    active--;
    return id;
  }));

  assert.deepEqual(await Promise.all(tasks), [1, 2, 3]);
  assert.equal(maxActive, 1);
  assert.equal(queue.stats().completed, 3);
});

test("RequestQueue rejects full queues", async () => {
  const queue = new RequestQueue({
    maxConcurrent: 1,
    maxQueueSize: 1,
    maxQueueAgeMs: 1000
  }, () => {});

  const first = queue.enqueue({ eventId: "slow" }, async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  const second = queue.enqueue({ eventId: "queued" }, async () => {});

  await assert.rejects(
    () => queue.enqueue({ eventId: "full" }, async () => {}),
    /queue is full/
  );

  await Promise.all([first, second]);
});
