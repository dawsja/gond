import assert from "node:assert/strict";
import { test } from "node:test";
import { cgroupMemory, createHomeSizes, parseDu, parseProcStatus, rssByUid } from "../stats.mjs";

const status = (uid, rss) => `Name:\tnode\nState:\tS (sleeping)\nUid:\t${uid}\t${uid}\t${uid}\t${uid}\nGid:\t${uid}\t${uid}\t${uid}\t${uid}\n${rss === null ? "" : `VmRSS:\t   ${rss} kB\n`}Threads:\t1\n`;

test("a process's status gives its real uid and resident bytes", () => {
  assert.deepEqual(parseProcStatus(status(2001, 1500)), { uid: 2001, rss: 1500 * 1024 });
  // A kernel thread has no VmRSS.
  assert.deepEqual(parseProcStatus(status(0, null)), { uid: 0, rss: 0 });
  assert.equal(parseProcStatus("garbage"), null);
});

test("resident memory adds up per uid", () => {
  const sums = rssByUid([status(2001, 100), status(2001, 50), status(2002, 10), "nonsense"]);
  assert.equal(sums.get(2001), 150 * 1024);
  assert.equal(sums.get(2002), 10 * 1024);
  assert.equal(sums.size, 2);
});

test("cgroup memory reads the limit, or the machine's total when there is none", () => {
  assert.deepEqual(cgroupMemory("max\n", "1048576\n", 8_000_000), { total: 8_000_000, used: 1_048_576 });
  assert.deepEqual(cgroupMemory("4194304\n", "1048576\n", 8_000_000), { total: 4_194_304, used: 1_048_576 });
  assert.equal(cgroupMemory(null, "1", 8), null);
  assert.equal(cgroupMemory("max", "", 8), null);
  assert.equal(cgroupMemory("lots", "1", 8), null);
});

test("du's total is the first number it prints", () => {
  assert.equal(parseDu("123456\t/home/ada\n"), 123456);
  assert.equal(parseDu("du: cannot read directory\n"), null);
  assert.equal(parseDu(""), null);
});

test("a home's size is measured in the background and kept until it's old", async () => {
  let measured = 0;
  let release;
  const sizes = createHomeSizes({
    keepMs: 50,
    measure: () => {
      measured += 1;
      return new Promise((resolve) => {
        release = () => resolve(1000 * measured);
      });
    },
  });
  assert.deepEqual(sizes.of("/home/ada"), { bytes: null, at: null });
  assert.deepEqual(sizes.of("/home/ada"), { bytes: null, at: null });
  assert.equal(measured, 1);
  release();
  await new Promise((resolve) => setTimeout(resolve, 5));
  const first = sizes.of("/home/ada");
  assert.equal(first.bytes, 1000);
  assert.ok(first.at);
  await new Promise((resolve) => setTimeout(resolve, 60));
  // Old: the last size answers while a new measure runs.
  assert.equal(sizes.of("/home/ada").bytes, 1000);
  assert.equal(measured, 2);
  release();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(sizes.of("/home/ada").bytes, 2000);
});

test("the box's stats have the shape the API reads", async () => {
  const { stats } = await import("../server.mjs");
  const out = stats();
  assert.deepEqual(Object.keys(out).sort(), ["cpus", "disk", "diskAt", "load", "memory", "people"]);
  assert.ok(out.disk.total > 0 && out.disk.free >= 0);
  assert.ok(out.memory.total > 0 && out.memory.used > 0);
  assert.equal(out.load.length, 3);
  assert.ok(out.cpus >= 1);
  assert.ok(Array.isArray(out.people));
});
