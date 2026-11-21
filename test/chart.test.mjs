import { test } from "node:test";
import assert from "node:assert/strict";
import { ageTicks, fitText, forecastTop, goalVisible, niceTicks, placeLabels } from "../app/chart.mjs";

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

test("forecastTop: the highest value, but at most twice the highest before the last phase", () => {
  assert.equal(Math.round(forecastTop([1e6, 5e6, 3e6, 4e6], 3)), 5.5e6, "all of it, with room");
  assert.equal(Math.round(forecastTop([1e6, 5e6, 3e7, 9e8], 1)), 1.1e7, "late growth leaves the top");
  assert.equal(forecastTop([0, 0], 1), 10000, "a floor for an empty portfolio");
});

test("ageTicks: January of every n-th age, as many as fit", () => {
  // Born 1990, from October 2026 to the end of 120.
  const months = [];
  for (let y = 2026, m = 10; y < 2111; m === 12 ? (y++, m = 1) : m++) months.push(`${y}-${String(m).padStart(2, "0")}`);
  const ageOf = (month) => Number(month.slice(0, 4)) - 1990;
  const ages = (width) => ageTicks(months, ageOf, width).map((i) => ageOf(months[i]));
  assert.deepEqual(ages(800), [40, 45, 50, 55, 60, 65, 70, 75, 80, 85, 90, 95, 100, 105, 110, 115, 120]);
  assert.deepEqual(ages(300), [40, 50, 60, 70, 80, 90, 100, 110, 120]);
  assert.ok(ageTicks(months, ageOf, 800).every((i) => months[i].endsWith("-01")));
});

test("fitText: the first text that fits, or none", () => {
  const texts = ["+1.400 € → 2.000 €/month", "+1.400 € → 2.000 €", "+1.400 €"];
  assert.equal(fitText(texts, 300), texts[0]);
  assert.equal(fitText(texts, 150), texts[1]);
  assert.equal(fitText(texts, 80), texts[2]);
  assert.equal(fitText(texts, 40), "");
});

test("placeLabels: texts under the bar stay clear of each other and inside it", () => {
  // 10 pixels a character, a bar 400 wide, the first line at 62.
  const place = (texts) => placeLabels(texts, 400, 62, 10).map((l) => [l.text, l.x, l.y, l.anchor ?? "start"]);
  // Health insurance ends at 66, the pension starts at 67: the pension goes
  // a line lower. A change late in life ends at the right edge, here on the
  // second line, clear of the pension.
  assert.deepEqual(place([
    { x: 100, text: "Health insurance ends" },
    { x: 112, text: "+ Pension" },
    { x: 350, text: "Care starts" },
  ]), [
    ["Health insurance ends", 100, 62, "start"],
    ["+ Pension", 112, 76, "start"],
    ["Care starts", 396, 76, "end"],
  ]);
  // Where the money runs out may end at the right edge instead of going
  // lower; a cause goes lower.
  assert.deepEqual(place([{ x: 10, text: "Rent ends" }, { x: 20, text: "Empty at 70", edge: true }]), [
    ["Rent ends", 10, 62, "start"],
    ["Empty at 70", 396, 62, "end"],
  ]);
  assert.deepEqual(place([{ x: 10, text: "Rent ends" }, { x: 20, text: "+ Pension" }]), [
    ["Rent ends", 10, 62, "start"],
    ["+ Pension", 20, 76, "start"],
  ]);
});
