import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePanes, parsePs, parseSwap, sumTrees } from "./sampler.js";

test("parsePs / parseSwap / parsePanes", () => {
  assert.deepEqual(parsePs("  10     1  12.5  2048\nbasura\n 11 10 0.0 1024\n"), [
    { pid: 10, ppid: 1, cpu: 12.5, rssKb: 2048 },
    { pid: 11, ppid: 10, cpu: 0, rssKb: 1024 },
  ]);
  assert.deepEqual(parseSwap("total = 31744.00M  used = 30679.50M  free = 1064.50M  (encrypted)"), { totalMb: 31744, usedMb: 30679.5 });
  assert.equal(parseSwap("nada"), null);
  assert.deepEqual([...parsePanes("cowork-a\t100\ncowork-a\t200\ncowork-b\t300\nmal\n")], [["cowork-a", [100, 200]], ["cowork-b", [300]]]);
});

test("sumTrees: suma descendientes, cada pid una vez, raíces muertas no cuentan", () => {
  const procs = parsePs(["100 1 10 1024", "101 100 50 2048", "102 101 40 1024", "200 1 5 1024", "300 1 99 99999"].join("\n"));
  const r = sumTrees(procs, new Map([["a", [100, 102]], ["b", [200, 999]], ["c", [101]]]));
  assert.deepEqual(r.a, { cpu: 100, rssMb: 4 });
  assert.deepEqual(r.b, { cpu: 5, rssMb: 1 });
  assert.deepEqual(r.c, { cpu: 0, rssMb: 0 }); // 101 ya lo reclamó «a»
});
