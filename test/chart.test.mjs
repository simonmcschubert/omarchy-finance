import { test } from "node:test";
import assert from "node:assert/strict";
import { forecastTop, goalVisible, niceTicks } from "../app/chart.mjs";

test("niceTicks: even steps around the data, the top tick close above it", () => {
  assert.deepEqual(niceTicks(0, 5003500), [0, 2000000, 4000000, 6000000]);
  // An FI number of 676,701 €: up to 700,000 €, not 800,000 €.
  assert.equal(niceTicks(0, 67670100).at(-1), 70000000);
  for (const [min, max] of [[0, 10000], [0, 73083708], [-50000, 3000000], [0, 123456789012]]) {
    const ticks = niceTicks(min, max);
    assert.ok(ticks[0] <= min && ticks.at(-1) >= max, `${min}..${max}: ${ticks}`);
    assert.ok(ticks.length >= 3 && ticks.length <= 9, `${min}..${max}: ${ticks}`);
    const step = ticks[1] - ticks[0];
    assert.ok(ticks.every((t, i) => i === 0 || t - ticks[i - 1] === step), `${min}..${max}: ${ticks}`);
  }
});

test("goalVisible: the history view shows the FI number once the data reaches it", () => {
  const series = [{ value: 900, invested: 800 }, { value: 1100, invested: 900 }];
  assert.equal(goalVisible(series, 1000), true);
  assert.equal(goalVisible(series, 2000), false);
  assert.equal(goalVisible(series, 0), false);
  assert.equal(goalVisible([{ value: 900, invested: 1000 }], 1000), true);
});

test("forecastTop: room for the rising FI number until retirement, not after", () => {
  const goal = [1000000, 1500000, 2000000, 9000000];
  const lines = [{ values: [500000, 900000, 1300000, 50000000] }];
  const target = [800000, 700000, null, null];
  assert.equal(forecastTop(lines, goal, target, 2), 2400000, "1.2 × the FI number when retirement starts");
  assert.equal(forecastTop([{ values: [500000, 3000000, 0, 0] }], goal, target, 2), 3000000, "a plan above it");
  assert.equal(forecastTop(lines, goal, target, -1), 50000000, "retired already: everything counts");
});
