import { test } from "node:test";
import assert from "node:assert/strict";
import * as F from "../app/finance.mjs";

const EUR = 100; // cents

function store(parts = {}) {
  return { ...F.emptyStore(), ...parts };
}

test("parseMoney reads German and English amounts", () => {
  const cases = {
    "12": 1200,
    "12,5": 1250,
    "12.50": 1250,
    "1.234": 123400,
    "1,234": 123400,
    "1.234,56": 123456,
    "1,234.56": 123456,
    "1 234,56 €": 123456,
    "€1,234,567.89": 123456789,
    "12.345.678": 1234567800,
    "-50": -5000,
    "−50,25": -5025,
    "+7": 700,
    ",5": 50,
    "EUR 3": 300,
    "12 usd": 1200,
    "CHF 1.234,50": 123450,
    "$-3": -300,
    "EUR -50": -5000,
    "eur+50": 5000,
    "USD −50,25": -5025,
    "£ 4": 400,
    "0": 0,
  };
  for (const [text, cents] of Object.entries(cases)) {
    assert.deepEqual(F.parseMoney(text), { ok: true, cents }, text);
  }
});

test("parseMoney rejects what it cannot read safely", () => {
  for (const text of ["", "abc", "1,2,3", "0.123", "1.23456", "12.3.4", "1.234.56,7", "1,234,5", "--5", "12a", "1abc", "abc 5"]) {
    assert.equal(F.parseMoney(text).ok, false, text);
  }
});

test("parsePercent", () => {
  assert.deepEqual(F.parsePercent("3,5"), { ok: true, value: 3.5 });
  assert.deepEqual(F.parsePercent("4 %"), { ok: true, value: 4 });
  assert.equal(F.parsePercent("x").ok, false);
  assert.equal(F.parsePercent("").ok, false);
  assert.equal(F.parsePercent("3.125").ok, false);
});

test("parsePercent takes up to the given number of decimals", () => {
  const six = { decimals: 6 };
  assert.deepEqual(F.parsePercent("3.333333", six), { ok: true, value: 3.333333 });
  assert.deepEqual(F.parsePercent("3,141593 %", six), { ok: true, value: 3.141593 });
  assert.deepEqual(F.parsePercent("0.000001", six), { ok: true, value: 0.000001 });
  // Three decimals are decimals, not a thousands separator as in money.
  assert.deepEqual(F.parsePercent("3.500", six), { ok: true, value: 3.5 });
  assert.deepEqual(F.parsePercent(",5", six), { ok: true, value: 0.5 });
  assert.match(F.parsePercent("3.1234567", six).error, /more than 6 decimals/);
  assert.equal(F.parsePercent("1.000,5", six).ok, false);
  assert.equal(F.parsePercent(".", six).ok, false);
});

test("parseDate reads YYYY-MM-DD, YYYY.MM.DD and DD.MM.YYYY", () => {
  const cases = {
    "2026-10-31": "2026-10-31",
    "2026.10.31": "2026-10-31",
    "31.10.2026": "2026-10-31",
    " 2026-1-5 ": "2026-01-05",
    "1.3.2025": "2025-03-01",
    "29.02.2024": "2024-02-29",
  };
  for (const [text, date] of Object.entries(cases)) assert.equal(F.parseDate(text), date, text);
  const wrong = [
    "2026-10", "10.2026", "10/2026", // a month without a day
    "2026/10/31", "10/31/2026", "31-10-2026", "2026-10.31", "Oct 31 2026", "", "2026",
    "2026-13-01", "32.10.2026", "31.11.2026", "29.02.2026", "0.10.2026", "31.10.1899",
  ];
  for (const text of wrong) assert.equal(F.parseDate(text), null, text);
});

test("daysInMonth", () => {
  assert.equal(F.daysInMonth("2026-01"), 31);
  assert.equal(F.daysInMonth("2026-02"), 28);
  assert.equal(F.daysInMonth("2024-02"), 29);
  assert.equal(F.daysInMonth("2026-11"), 30);
});

test("month arithmetic", () => {
  assert.equal(F.addMonths("2026-11", 2), "2027-01");
  assert.equal(F.addMonths("2026-01", -1), "2025-12");
  assert.equal(F.currentMonth(new Date(2026, 10, 15)), "2026-11");
});

test("metrics: income, expenses with buffer, FI number", () => {
  const s = store({
    settings: { withdrawalRate: 4, bufferPercent: 10 },
    income: [
      { id: "i1", name: "Salary", category: "Work", amount: 3000 * EUR, everyMonths: 1 },
      { id: "i2", name: "Bonus", category: "Work", amount: 1200 * EUR, everyMonths: 12 },
    ],
    expenses: [
      { id: "e1", name: "Rent", category: "Housing", amount: 1000 * EUR, everyMonths: 1 },
      { id: "e2", name: "Insurance", category: "Insurance", amount: 300 * EUR, everyMonths: 3 },
      { id: "e3", name: "Car tax", category: "Car", amount: 1200 * EUR, everyMonths: 12 },
    ],
  });
  const m = F.metrics(s);
  assert.equal(m.income, 3100 * EUR);
  assert.equal(m.baseExpenses, 1200 * EUR);
  assert.equal(m.buffer, 120 * EUR);
  assert.equal(m.expenses, 1320 * EUR);
  assert.equal(m.multiple, 25);
  assert.equal(m.fiNumber, 1320 * 12 * 25 * EUR);
  assert.equal(m.portfolio, null);
  assert.equal(m.investmentRate, null);
  assert.equal(m.fiProgress, null);
});

test("inactive expenses count nowhere until they are active again", () => {
  const rent = { id: "e1", name: "Rent", category: "Housing", amount: 1000 * EUR, everyMonths: 1, active: true };
  const gym = { id: "e2", name: "Gym", category: "Leisure", amount: 600 * EUR, everyMonths: 12, active: false };
  const s = store({
    settings: { ...F.DEFAULT_SETTINGS },
    expenses: [rent, gym],
    accounts: [{ id: "a", name: "A" }],
    records: [{ month: "2026-10", account: "a", value: 33000 * EUR, payIn: 0 }],
  });
  const m = F.metrics(s);
  assert.equal(m.baseExpenses, 1000 * EUR);
  assert.equal(m.buffer, 100 * EUR);
  assert.equal(m.fiNumber, 1100 * 12 * 25 * EUR);
  assert.equal(m.fiProgress, 33000 / 330000);
  assert.deepEqual(F.counted(s.expenses), [rent]);
  assert.deepEqual(F.counted(s.income), []);
  assert.equal(F.parseStore(JSON.parse(JSON.stringify(s))).ok, true);

  const again = F.saveItem(s, "expenses", { ...gym, active: true });
  assert.equal(F.metrics(again).baseExpenses, 1050 * EUR);
  assert.equal(s.expenses[1].active, false, "the original is untouched");
});

test("portfolio: accounts keep their last value through gaps", () => {
  const s = store({
    accounts: [{ id: "a", name: "A" }, { id: "b", name: "B" }],
    records: [
      { month: "2026-01", account: "a", value: 1000, payIn: 100 },
      { month: "2026-01", account: "b", value: 500, payIn: 0 },
      { month: "2026-03", account: "a", value: 1300, payIn: 100 },
    ],
  });
  assert.deepEqual(F.portfolioSeries(s), [
    { month: "2026-01", value: 1500, payIn: 100, invested: 1500 },
    { month: "2026-02", value: 1500, payIn: 0, invested: 1500 },
    { month: "2026-03", value: 1800, payIn: 100, invested: 1600 },
  ]);
});

test("portfolio: what an account held in its first month counts as paid in", () => {
  // B is tracked from February on and already held 2,000 then, 300 of them
  // paid in that month. Only the 100 the value rose by beyond pay-ins is gain.
  const s = store({
    accounts: [{ id: "a", name: "A" }, { id: "b", name: "B" }],
    records: [
      { month: "2026-01", account: "a", value: 1000, payIn: 1000 },
      { month: "2026-02", account: "a", value: 1100, payIn: 50 },
      { month: "2026-02", account: "b", value: 2000, payIn: 300 },
    ],
  });
  const series = F.portfolioSeries(s);
  assert.deepEqual(series.map((m) => [m.value, m.payIn, m.invested]), [[1000, 1000, 1000], [3100, 350, 3050]]);
  assert.deepEqual(F.metrics(s).payIn, { average: 675, months: 2 }, "the pay-in average still counts only pay-ins");
});

test("investment rate uses the average pay-in of the last 12 months", () => {
  const records = [];
  // 14 months: 2025-01 .. 2026-02. The first two months pay in 10,000 each
  // and must not count; the last 12 pay in 500 each, except one with 1,100.
  for (let i = 0; i < 14; i++) {
    const month = F.addMonths("2025-01", i);
    const payIn = i < 2 ? 10000 * EUR : month === "2025-12" ? 1100 * EUR : 500 * EUR;
    records.push({ month, account: "a", value: (i + 1) * 1000 * EUR, payIn });
  }
  const s = store({
    accounts: [{ id: "a", name: "A" }],
    records,
    income: [{ id: "i", name: "Salary", category: "", amount: 2000 * EUR, everyMonths: 1 }],
    expenses: [{ id: "e", name: "Rent", category: "", amount: 1000 * EUR, everyMonths: 1 }],
    settings: { withdrawalRate: 4, bufferPercent: 0 },
  });
  const m = F.metrics(s);
  assert.deepEqual(m.payIn, { average: 550 * EUR, months: 12 });
  assert.equal(m.investmentRate, 550 / 2000);
  assert.equal(m.portfolio, 14000 * EUR);
  assert.equal(m.latestMonth, "2026-02");
  assert.equal(m.fiNumber, 300000 * EUR);
  assert.equal(m.fiProgress, 14000 / 300000);
});

test("with less than 12 months of history the average uses the months there are", () => {
  const s = store({
    accounts: [{ id: "a", name: "A" }],
    records: [
      { month: "2026-09", account: "a", value: 0, payIn: 300 },
      { month: "2026-11", account: "a", value: 0, payIn: 600 },
    ],
  });
  // Sep, Oct (nothing paid in), Nov
  assert.deepEqual(F.metrics(s).payIn, { average: 300, months: 3 });
});

test("incomeSplit: expenses with the buffer, the average pay-in, and the rest", () => {
  const s = store({
    settings: { ...F.DEFAULT_SETTINGS, bufferPercent: 10 },
    income: [{ id: "i", name: "Salary", category: "", amount: 3000 * EUR, everyMonths: 1 }],
    expenses: [{ id: "e", name: "Rent", category: "", amount: 1800 * EUR, everyMonths: 1, active: true }],
    accounts: [{ id: "a", name: "A" }],
    records: [
      { month: "2026-09", account: "a", value: 1000 * EUR, payIn: 400 * EUR },
      { month: "2026-10", account: "a", value: 2000 * EUR, payIn: 800 * EUR },
    ],
  });
  // 3,000 income: 1,980 expenses with the buffer, 600 paid in on average.
  assert.deepEqual(F.incomeSplit(F.metrics(s)), { expenses: 1980 * EUR, invested: 600 * EUR, leftOver: 420 * EUR, over: 0 });

  const more = F.saveMonth(s, "2026-10", [{ account: "a", value: 2000 * EUR, payIn: 2000 * EUR }]);
  assert.deepEqual(F.incomeSplit(F.metrics(more)), { expenses: 1980 * EUR, invested: 1200 * EUR, leftOver: 0, over: 180 * EUR });

  const out = F.saveMonth(s, "2026-10", [{ account: "a", value: 2000 * EUR, payIn: -1000 * EUR }]);
  assert.deepEqual(F.incomeSplit(F.metrics(out)), { expenses: 1980 * EUR, invested: 0, leftOver: 1020 * EUR, over: 0 }, "withdrawals invest nothing");

  assert.deepEqual(F.incomeSplit(F.metrics({ ...s, records: [] })), { expenses: 1980 * EUR, invested: 0, leftOver: 1020 * EUR, over: 0 });
  assert.equal(F.incomeSplit(F.metrics({ ...s, income: [] })), null);
});

test("gains: the change in value minus pay-ins, with a Modified Dietz return", () => {
  const series = [
    { month: "2026-08", value: 1000, payIn: 1000 },
    { month: "2026-09", value: 1100, payIn: 0 },
    { month: "2026-10", value: 1300, payIn: 100 },
  ];
  // From August's 1,000: 300 more, 100 of it paid in, in the middle of the
  // second of two months, so invested for a quarter of the time.
  assert.deepEqual(F.gains(series), { gain: 200, months: 2, rate: 200 / 1025 });
  assert.deepEqual(F.gains(series, 1), { gain: 100, months: 1, rate: 100 / 1150 });
  assert.equal(F.gains(series.slice(0, 1)), null);
  assert.deepEqual(F.gains([{ value: 0, payIn: 0 }, { value: 0, payIn: 0 }]), { gain: 0, months: 1, rate: null });
});

test("metrics: gains over the last 12 months, expenses covered", () => {
  const records = [];
  // 14 months, 2025-01 .. 2026-02: 1,000 more each month, 500 of it paid in.
  for (let i = 0; i < 14; i++) records.push({ month: F.addMonths("2025-01", i), account: "a", value: (i + 1) * 1000 * EUR, payIn: 500 * EUR });
  const s = store({
    settings: { ...F.DEFAULT_SETTINGS, bufferPercent: 0 },
    accounts: [{ id: "a", name: "A" }],
    records,
    expenses: [{ id: "e", name: "Rent", category: "", amount: 1000 * EUR, everyMonths: 1, active: true }],
  });
  const m = F.metrics(s);
  // From 2025-02 (2,000) to 2026-02 (14,000): 12,000 more, 6,000 paid in.
  assert.equal(m.gains.months, 12);
  assert.equal(m.gains.gain, 6000 * EUR);
  // Each pay-in invested for (12 - i - 0.5) / 12 of the time: 3,000 in all.
  assert.ok(Math.abs(m.gains.rate - 6000 / (2000 + 3000)) < 1e-12, String(m.gains.rate));
  assert.equal(m.coveredMonths, 14);
  assert.equal(F.metrics({ ...s, expenses: [] }).coveredMonths, null);
  assert.equal(F.metrics({ ...s, records: [] }).coveredMonths, null);
  assert.equal(F.metrics({ ...s, records: [] }).gains, null);
});

test("missingMonths: after the latest month up to last month", () => {
  assert.equal(F.missingMonths("2026-10", "2026-11"), null, "last month has values");
  assert.equal(F.missingMonths("2026-11", "2026-11"), null, "this month has values already");
  assert.equal(F.missingMonths(null, "2026-11"), null, "no values at all");
  assert.deepEqual(F.missingMonths("2026-09", "2026-11"), { from: "2026-10", to: "2026-10", count: 1 });
  assert.deepEqual(F.missingMonths("2025-11", "2026-02"), { from: "2025-12", to: "2026-01", count: 2 });
});

test("fiProjection: growth at the expected return plus the average pay-in", () => {
  // At 0 % a year, 100 a month reaches 1,200 after 12 months.
  const flat = F.fiProjection({ month: "2026-10", start: 0, payIn: 100, goal: 1200, rate: 0 });
  assert.deepEqual(flat.rates, { low: -2, mid: 0, high: 2 });
  assert.equal(flat.reach.mid, "2027-10");
  assert.equal(flat.reach.high, "2027-10", "in the 12th month at 2 % too, a bit above 1,200");
  assert.equal(flat.reach.low, "2027-11");
  assert.deepEqual(flat.points[0], { month: "2026-11", low: 100, mid: 100, high: flat.points[0].high });

  // The mid projection counts as Time to FI does.
  const start = 50000 * EUR;
  const payIn = 1250 * EUR;
  const goal = 675000 * EUR;
  const p = F.fiProjection({ month: "2026-10", start, payIn, goal, rate: 5 });
  const months = F.projectToGoal(start, payIn, 5, goal).length;
  assert.equal(p.reach.mid, F.addMonths("2026-10", months));
  assert.ok(months > 20 * 12 && months < 22 * 12, `${months} months`);
  assert.equal(p.reach.high, F.addMonths("2026-10", F.projectToGoal(start, payIn, 7, goal).length));
  assert.equal(p.reach.low, F.addMonths("2026-10", F.projectToGoal(start, payIn, 3, goal).length));
  const shown = F.monthIndex(p.reach.low) - F.monthIndex("2026-10");
  assert.equal(p.points.length, Math.ceil(shown * 1.1), "until a little after the low projection gets there");
  assert.equal(p.points.at(-1).month, F.addMonths("2026-10", p.points.length));
  for (const point of p.points) assert.ok(point.low <= point.mid && point.mid <= point.high);
});

test("fiProjection: no goal, at the goal already, out of reach, close by", () => {
  assert.equal(F.fiProjection({ month: "2026-10", start: 100, payIn: 10, goal: 0, rate: 5 }), null);

  const there = F.fiProjection({ month: "2026-10", start: 1000, payIn: 10, goal: 1000, rate: 5 });
  assert.deepEqual(there.reach, { low: "2026-10", mid: "2026-10", high: "2026-10" });
  assert.deepEqual(there.points, []);

  const never = F.fiProjection({ month: "2026-10", start: 100, payIn: 0, goal: 1e9, rate: 1 });
  assert.deepEqual(never.reach, { low: null, mid: null, high: null });
  assert.equal(never.points.length, F.MAX_PROJECTION_MONTHS);

  // Only the high return gets there: 1.02^35 is 2.0, so in 35 years; the
  // mid one at 0 % never does. The chart runs to 1.5 times that, and a bit.
  const high = F.fiProjection({ month: "2026-10", start: 1000, payIn: 0, goal: 2000, rate: 0 });
  assert.equal(high.reach.mid, null);
  assert.equal(high.reach.high, "2061-11");
  assert.equal(high.points.length, Math.ceil(421 * 1.5 * 1.1));

  // A month away: the chart still shows a year.
  const soon = F.fiProjection({ month: "2026-10", start: 990, payIn: 10, goal: 1000, rate: 5 });
  assert.equal(soon.reach.mid, "2026-11");
  assert.equal(soon.points.length, 12);

  // Withdrawals: the value does not go below zero.
  const down = F.fiProjection({ month: "2026-10", start: 1000, payIn: -500, goal: 5000, rate: 5 });
  assert.equal(down.points.at(-1).mid, 0);
});

test("byCategory groups and sorts by monthly total", () => {
  const items = [
    { id: "1", name: "Rent", category: "Housing", amount: 900, everyMonths: 1 },
    { id: "2", name: "Power", category: "Housing", amount: 300, everyMonths: 3 },
    { id: "3", name: "Phone", category: "", amount: 2000, everyMonths: 1 },
  ];
  const groups = F.byCategory(items);
  assert.deepEqual(groups.map((g) => [g.category, g.monthly]), [["", 2000], ["Housing", 1000]]);
  assert.deepEqual(groups[1].items.map((i) => i.name), ["Rent", "Power"]);
});

test("parseStore accepts what the app writes and refuses unknown fields", () => {
  let s = F.emptyStore();
  s = F.saveItem(s, "expenses", { id: "e", name: "Rent", category: "Housing", amount: 100, everyMonths: 1, active: true });
  s = F.saveItem(s, "income", { id: "i", name: "Salary", category: "Work", amount: 100, everyMonths: 1 });
  s = F.saveAccount(s, null, "Broker").store;
  s = F.saveMonth(s, "2026-10", [{ account: s.accounts[0].id, value: 5, payIn: -2 }]);
  const roundTrip = JSON.parse(JSON.stringify(s));
  assert.deepEqual(F.parseStore(roundTrip), { ok: true, store: s });
  assert.deepEqual(F.parseStore(null), { ok: true, store: F.emptyStore() });

  const broken = [
    [{ ...roundTrip, extra: 1 }, /unknown field "extra"/],
    [{ ...roundTrip, version: F.VERSION + 1 }, /newer version of Finance/],
    [{ ...roundTrip, version: "2" }, /unsupported version/],
    [{ ...roundTrip, settings: { ...roundTrip.settings, withdrawalRate: 0 } }, /withdrawalRate/],
    [{ ...roundTrip, settings: { ...roundTrip.settings, currency: "eur" } }, /currency/],
    [{ ...roundTrip, settings: { withdrawalRate: 4, bufferPercent: 10, numberFormat: "1.000.000,00" } }, /missing "currency"/],
    [{ ...roundTrip, settings: { withdrawalRate: 4, bufferPercent: 10, currency: "EUR" } }, /missing "numberFormat"/],
    [{ ...roundTrip, settings: { ...roundTrip.settings, numberFormat: "1 000 000,00" } }, /numberFormat must be "1.000.000,00" or "1,000,000.00"/],
    [{ ...roundTrip, settings: { withdrawalRate: 4, bufferPercent: 10, currency: "EUR", numberFormat: "1.000.000,00" } }, /missing "expectedReturn"/],
    [{ ...roundTrip, settings: { ...roundTrip.settings, expectedReturn: -1 } }, /expectedReturn must be between 0 and 100/],
    [{ ...roundTrip, settings: { ...roundTrip.settings, expectedReturn: "5" } }, /expectedReturn must be between 0 and 100/],
    [{ ...roundTrip, settings: { ...roundTrip.settings, birthYear: "1990" } }, /birthYear must be null or a year/],
    [{ ...roundTrip, settings: { ...roundTrip.settings, birthYear: 1899 } }, /birthYear must be null or a year from 1900 to 2100/],
    [{ ...roundTrip, settings: { ...roundTrip.settings, retirementAge: 66.5 } }, /retirementAge must be a whole number from 30 to 80/],
    [{ ...roundTrip, settings: { ...roundTrip.settings, retirementAge: null } }, /retirementAge/],
    [{ ...roundTrip, settings: { ...F.DEFAULT_SETTINGS, retirementAge: undefined } }, /retirementAge/],
    [{ ...roundTrip, categories: { ...roundTrip.categories, expenses: ["Food", "food"] } }, /repeats the name/],
    [{ ...roundTrip, categories: { ...roundTrip.categories, income: [""] } }, /not a name/],
    [{ ...roundTrip, expenses: [{ ...roundTrip.expenses[0], category: "Nope" }] }, /not in categories.expenses/],
    [{ ...roundTrip, expenses: [{ ...roundTrip.expenses[0], amount: 1.5 }] }, /amount/],
    [{ ...roundTrip, expenses: [{ ...roundTrip.expenses[0], note: "x" }] }, /unknown field "note"/],
    [{ ...roundTrip, expenses: [{ ...roundTrip.expenses[0], active: "yes" }] }, /active must be true or false/],
    [{ ...roundTrip, expenses: [{ id: "e", name: "Rent", category: "", amount: 100, everyMonths: 1 }] }, /missing "active"/],
    [{ ...roundTrip, income: [{ ...roundTrip.income[0], active: false }] }, /unknown field "active"/],
    [{ ...roundTrip, records: [{ ...roundTrip.records[0], account: "nope" }] }, /unknown account/],
    [{ ...roundTrip, records: [roundTrip.records[0], roundTrip.records[0]] }, /repeats a month/],
    [{ ...roundTrip, records: [{ ...roundTrip.records[0], value: -1 }] }, /value/],
    [{ ...roundTrip, accounts: [...roundTrip.accounts, { id: "x", name: "broker" }] }, /repeats the name/],
    [[], /not an object/],
  ];
  for (const [value, pattern] of broken) {
    const result = F.parseStore(value);
    assert.equal(result.ok, false);
    assert.match(result.error, pattern);
  }
});

test("store changes leave the original untouched", () => {
  const s = F.saveAccount(F.emptyStore(), null, "A").store;
  const id = s.accounts[0].id;
  const withMonth = F.saveMonth(s, "2026-10", [{ account: id, value: 1, payIn: 0 }]);
  assert.equal(s.records.length, 0);
  assert.equal(withMonth.records.length, 1);

  // A blank value removes that account's record for the month.
  assert.equal(F.saveMonth(withMonth, "2026-10", [{ account: id, value: null, payIn: 0 }]).records.length, 0);
  assert.equal(F.deleteMonth(withMonth, "2026-10").records.length, 0);
  const gone = F.deleteAccount(withMonth, id);
  assert.equal(gone.accounts.length, 0);
  assert.equal(gone.records.length, 0);

  assert.equal(F.saveAccount(s, null, " a ").ok, false, "names are unique, ignoring case");
  assert.equal(F.saveAccount(s, id, "a").ok, true, "renaming to a different case is fine");
});

test("parseCsv handles delimiters and quotes", () => {
  assert.deepEqual(F.parseCsv('date;account;value\n2026-10-31;"A; B";"1.234,56"\r\n\n').rows, [
    { line: 1, fields: ["date", "account", "value"] },
    { line: 2, fields: ["2026-10-31", "A; B", "1.234,56"] },
  ]);
  assert.equal(F.parseCsv("a\tb\tc\n1\t2\t3").delimiter, "\t");
  assert.deepEqual(F.parseCsv('a,b\n"say ""hi""",2').rows[1].fields, ['say "hi"', "2"]);
});

test("planImport and applyImport: German semicolon file", () => {
  let s = F.saveAccount(F.emptyStore(), null, "Trade Republic").store;
  const tr = s.accounts[0].id;
  s = F.saveMonth(s, "2026-01", [{ account: tr, value: 1, payIn: 0 }]);

  const csv = [
    "Date;Account;Value;Pay-in",
    "31.01.2026;trade republic;12.345,67;500",
    "2026.02.01;Trade Republic;13.000;500,00",
    "2026-02-28;ING;8.000;",
  ].join("\n");
  const plan = F.planImport(s, csv);
  assert.deepEqual(plan.errors, []);
  assert.deepEqual(plan.newAccounts, ["ING"]);
  assert.equal(plan.replaced, 1);
  assert.equal(plan.added, 2);

  const next = F.applyImport(s, plan);
  const ing = F.findAccount(next, "ING").id;
  assert.deepEqual(next.records, [
    { month: "2026-01", account: tr, value: 1234567, payIn: 50000 },
    { month: "2026-02", account: tr, value: 1300000, payIn: 50000 },
    { month: "2026-02", account: ing, value: 800000, payIn: 0 },
  ]);
  assert.equal(F.parseStore(JSON.parse(JSON.stringify(next))).ok, true);
});

test("planImport reports every problem with its line", () => {
  const csv = [
    "date,account,value,pay_in",
    "31.02.2026,A,1,0",
    "2026-10-31,,1,0",
    "2026-10-31,A,x,0",
    "2026-10-31,A,-5,0",
    "2026-10-31,A,1,0",
    "2026-10-15,a,2,0",
    "2026-11-30,A,1,234,56,0",
    "2026-12,A,1,0",
  ].join("\n");
  const { errors } = F.planImport(F.emptyStore(), csv);
  assert.deepEqual(errors.map((e) => e.line), [2, 3, 4, 5, 7, 8, 9]);
  assert.match(errors[0].message, /"31.02.2026" is not a date/);
  assert.match(errors[4].message, /already on line 6/);
  assert.match(errors[5].message, /decimal comma/);
  assert.match(errors[6].message, /"2026-12" is not a date/);

  assert.match(F.planImport(F.emptyStore(), "date,broker\n2026-10-31,A").errors[0].message, /missing: value/);
  const old = F.planImport(F.emptyStore(), "month,account,value\n2026-10,A,1").errors[0].message;
  assert.match(old, /missing: date/);
  assert.match(old, /month column is now date/);
  assert.match(F.planImport(F.emptyStore(), "").errors[0].message, /empty/);
  assert.throws(() => F.applyImport(F.emptyStore(), F.planImport(F.emptyStore(), csv)));
});

test("a version 1 file is upgraded: euros, and the categories its items use", () => {
  const v1 = {
    version: 1,
    settings: { withdrawalRate: 3.5, bufferPercent: 5 },
    expenses: [
      { id: "e1", name: "Rent", category: "Housing", amount: 100, everyMonths: 1 },
      { id: "e2", name: "Power", category: "housing", amount: 50, everyMonths: 1 },
      { id: "e3", name: "Gym", category: "", amount: 30, everyMonths: 1 },
      { id: "e4", name: "Car", category: "Car", amount: 30, everyMonths: 12 },
    ],
    income: [{ id: "i1", name: "Salary", category: "Work", amount: 300, everyMonths: 1 }],
    accounts: [{ id: "a", name: "Broker" }],
    records: [{ month: "2026-10", account: "a", value: 5, payIn: 1 }],
  };
  const result = F.parseStore(v1);
  assert.equal(result.ok, true, result.error);
  const s = result.store;
  assert.equal(s.version, F.VERSION);
  assert.deepEqual(s.settings, { withdrawalRate: 3.5, bufferPercent: 5, currency: "EUR", numberFormat: "1.000.000,00", expectedReturn: 5, birthYear: null, retirementAge: 67 });
  assert.deepEqual(s.categories, { expenses: ["Car", "Housing"], income: ["Work"] });
  assert.deepEqual(s.expenses.map((e) => e.category), ["Housing", "Housing", "", "Car"]);
  assert.deepEqual(s.expenses.map((e) => e.active), [true, true, true, true], "every expense was active");
  assert.equal("active" in s.income[0], false);
  assert.deepEqual(s.records, v1.records);
  assert.deepEqual(Object.keys(s), ["version", "settings", "categories", "expenses", "income", "accounts", "records"]);
  assert.equal(v1.expenses[1].category, "housing", "the parsed value is left alone");

  assert.match(F.parseStore({ ...v1, extra: 1 }).error, /unknown field "extra"/);
  assert.match(F.parseStore({ ...v1, settings: { ...v1.settings, currency: "EUR" } }).error, /unknown field "currency"/);
});

test("a version 2 file is upgraded: every expense is active", () => {
  const v2 = {
    version: 2,
    settings: { withdrawalRate: 4, bufferPercent: 10, currency: "USD" },
    categories: { expenses: ["Housing"], income: ["Work"] },
    expenses: [
      { id: "e1", name: "Rent", category: "Housing", amount: 100, everyMonths: 1 },
      { id: "e2", name: "Gym", category: "", amount: 30, everyMonths: 12 },
    ],
    income: [{ id: "i1", name: "Salary", category: "Work", amount: 300, everyMonths: 1 }],
    accounts: [],
    records: [],
  };
  const result = F.parseStore(v2);
  assert.equal(result.ok, true, result.error);
  const s = result.store;
  assert.equal(s.version, F.VERSION);
  assert.deepEqual(s.settings, { ...v2.settings, numberFormat: "1.000.000,00", expectedReturn: 5, birthYear: null, retirementAge: 67 });
  assert.deepEqual(s.expenses, v2.expenses.map((e) => ({ ...e, active: true })));
  assert.deepEqual(s.income, v2.income);
  assert.deepEqual(Object.keys(s), ["version", "settings", "categories", "expenses", "income", "accounts", "records"]);
  assert.equal("active" in v2.expenses[0], false, "the parsed value is left alone");
  assert.equal(F.metrics(s).baseExpenses, 100 + 30 / 12);

  assert.match(F.parseStore({ ...v2, extra: 1 }).error, /unknown field "extra"/);
  assert.match(F.parseStore({ ...v2, expenses: [{ ...v2.expenses[0], note: "x" }] }).error, /unknown field "note"/);
});

test("a version 3 file is upgraded: the default number format", () => {
  const v3 = {
    version: 3,
    settings: { withdrawalRate: 3.5, bufferPercent: 5, currency: "USD" },
    categories: { expenses: ["Housing"], income: [] },
    expenses: [{ id: "e1", name: "Rent", category: "Housing", amount: 100, everyMonths: 1, active: false }],
    income: [],
    accounts: [{ id: "a", name: "Broker" }],
    records: [{ month: "2026-10", account: "a", value: 5, payIn: 1 }],
  };
  const result = F.parseStore(v3);
  assert.equal(result.ok, true, result.error);
  const s = result.store;
  assert.equal(s.version, F.VERSION);
  assert.deepEqual(s.settings, { withdrawalRate: 3.5, bufferPercent: 5, currency: "USD", numberFormat: "1.000.000,00", expectedReturn: 5, birthYear: null, retirementAge: 67 });
  assert.deepEqual({ ...s, version: 3, settings: v3.settings }, v3, "nothing else changes");
  assert.equal("numberFormat" in v3.settings, false, "the parsed value is left alone");

  assert.match(F.parseStore({ ...v3, extra: 1 }).error, /unknown field "extra"/);
  assert.match(F.parseStore({ ...v3, settings: { ...v3.settings, numberFormat: "1,000,000.00" } }).error, /unknown field "numberFormat"/);
});

test("a version 4 file is upgraded: the default expected return", () => {
  const v4 = {
    version: 4,
    settings: { withdrawalRate: 3.5, bufferPercent: 5, currency: "USD", numberFormat: "1,000,000.00" },
    categories: { expenses: ["Housing"], income: [] },
    expenses: [{ id: "e1", name: "Rent", category: "Housing", amount: 100, everyMonths: 1, active: true }],
    income: [],
    accounts: [{ id: "a", name: "Broker" }],
    records: [{ month: "2026-10", account: "a", value: 5, payIn: 1 }],
  };
  const result = F.parseStore(v4);
  assert.equal(result.ok, true, result.error);
  const s = result.store;
  assert.equal(s.version, F.VERSION);
  assert.deepEqual(s.settings, { ...v4.settings, expectedReturn: 5, birthYear: null, retirementAge: 67 });
  assert.deepEqual({ ...s, version: 4, settings: v4.settings }, v4, "nothing else changes");
  assert.equal("expectedReturn" in v4.settings, false, "the parsed value is left alone");

  assert.match(F.parseStore({ ...v4, extra: 1 }).error, /unknown field "extra"/);
  assert.match(F.parseStore({ ...v4, settings: { ...v4.settings, expectedReturn: 5 } }).error, /unknown field "expectedReturn"/);
});

test("projectToGoal: monthly values until the goal", () => {
  // No return: only pay-ins, 100 a month from 250 to 1000 takes 8 months.
  assert.deepEqual(F.projectToGoal(250, 100, 0, 1000), [350, 450, 550, 650, 750, 850, 950, 1050]);
  assert.deepEqual(F.projectToGoal(1000, 100, 0, 1000), [], "already there");
  assert.equal(F.projectToGoal(0, 0, 0, 1000), null, "never");
  assert.equal(F.projectToGoal(1000, -100, 5, 2000), null, "withdrawals faster than growth");
  assert.equal(F.projectToGoal(1, 0, 1, 1e6), null, "more than 100 years");

  // 12 % a year compounds monthly to 12 % a year, not 12.68 %.
  const year = F.projectToGoal(100000, 0, 12, 112001);
  assert.equal(year.length, 13);
  assert.ok(Math.abs(year[11] - 112000) < 0.001, String(year[11]));
});

test("metrics: time to FI from the latest month with the average pay-in", () => {
  const s = store({
    settings: { ...F.DEFAULT_SETTINGS, bufferPercent: 0, expectedReturn: 0 },
    expenses: [{ id: "e", name: "Rent", category: "", amount: 100 * EUR, everyMonths: 1, active: true }],
    accounts: [{ id: "a", name: "A" }],
    records: [
      { month: "2026-09", account: "a", value: 27000 * EUR, payIn: 500 * EUR },
      { month: "2026-10", account: "a", value: 28000 * EUR, payIn: 1500 * EUR },
    ],
  });
  // FI number 100 × 12 × 25 = 30,000: 2,000 to go at 1,000 a month.
  const m = F.metrics(s);
  assert.equal(m.fiNumber, 30000 * EUR);
  assert.equal(m.fiMonths, 2);
  assert.deepEqual(m.projection, [
    { month: "2026-11", value: 29000 * EUR },
    { month: "2026-12", value: 30000 * EUR },
  ]);

  const grown = F.metrics(F.saveSettings(s, { expectedReturn: 5 }));
  assert.equal(grown.fiMonths, 2, "the return makes it no later");
  assert.ok(grown.projection[0].value > 29000 * EUR);

  const reached = F.metrics(F.saveMonth(s, "2026-11", [{ account: "a", value: 30000 * EUR, payIn: 0 }]));
  assert.equal(reached.fiMonths, 0);
  assert.deepEqual(reached.projection, []);

  const never = F.metrics(F.saveMonth(s, "2026-11", [{ account: "a", value: 28000 * EUR, payIn: -2000 * EUR }]));
  assert.equal(never.fiMonths, null, "the average pay-in is 0");
  assert.equal(never.projection, null);

  const none = F.metrics(store());
  assert.equal(none.fiMonths, null);
  assert.equal(none.projection, null);
});

test("a version 5 file is upgraded: no birth year, retirement at 67", () => {
  const v5 = {
    version: 5,
    settings: { withdrawalRate: 3.5, bufferPercent: 5, currency: "USD", numberFormat: "1,000,000.00", expectedReturn: 6 },
    categories: { expenses: ["Housing"], income: [] },
    expenses: [{ id: "e1", name: "Rent", category: "Housing", amount: 100, everyMonths: 1, active: true }],
    income: [],
    accounts: [{ id: "a", name: "Broker" }],
    records: [{ month: "2026-10", account: "a", value: 5, payIn: 1 }],
  };
  const result = F.parseStore(v5);
  assert.equal(result.ok, true, result.error);
  const s = result.store;
  assert.equal(s.version, F.VERSION);
  assert.deepEqual(s.settings, { ...v5.settings, birthYear: null, retirementAge: 67 });
  assert.deepEqual({ ...s, version: 5, settings: v5.settings }, v5, "nothing else changes");
  assert.equal("birthYear" in v5.settings, false, "the parsed value is left alone");

  assert.match(F.parseStore({ ...v5, settings: { ...v5.settings, retirementAge: 65 } }).error, /unknown field "retirementAge"/);
  assert.equal(F.parseStore({ ...s, settings: { ...s.settings, birthYear: 1990, retirementAge: 65 } }).ok, true);
});

test("a new store starts with a few categories", () => {
  const s = F.emptyStore();
  assert.ok(s.categories.expenses.includes("Housing"));
  assert.ok(s.categories.income.includes("Work"));
  assert.equal(s.settings.currency, "EUR");
  assert.equal(s.settings.numberFormat, "1.000.000,00");
  assert.equal(F.parseStore(s).ok, true);
});

test("categories: add, rename with their items, delete", () => {
  let s = { ...F.emptyStore(), categories: { expenses: ["Housing"], income: ["Work"] } };
  s = F.saveItem(s, "expenses", { id: "e", name: "Rent", category: "Housing", amount: 100, everyMonths: 1, active: true });
  s = F.saveItem(s, "income", { id: "i", name: "Salary", category: "Work", amount: 100, everyMonths: 1 });

  const added = F.saveCategory(s, "expenses", null, "  Car ");
  assert.equal(added.ok, true);
  assert.deepEqual(added.store.categories.expenses, ["Car", "Housing"]);
  assert.deepEqual(s.categories.expenses, ["Housing"], "the original is untouched");

  assert.deepEqual(F.saveCategory(s, "expenses", null, "housing"), { ok: false, error: '"Housing" already exists' });
  assert.deepEqual(F.saveCategory(s, "expenses", null, " "), { ok: false, error: "Enter a name" });
  assert.equal(F.saveCategory(s, "income", null, "Housing").ok, true, "expenses and income have their own lists");
  assert.equal(F.saveCategory(s, "expenses", "Gone", "X").ok, false);

  const renamed = F.saveCategory(s, "expenses", "Housing", "Home").store;
  assert.deepEqual(renamed.categories.expenses, ["Home"]);
  assert.equal(renamed.expenses[0].category, "Home");
  assert.equal(renamed.income[0].category, "Work");
  assert.equal(F.saveCategory(s, "expenses", "Housing", "HOUSING").ok, true, "changing the case is fine");
  assert.equal(F.categoryUse(renamed, "expenses", "Home"), 1);

  const deleted = F.deleteCategory(renamed, "expenses", "Home");
  assert.deepEqual(deleted.categories.expenses, []);
  assert.equal(deleted.expenses[0].category, "");
  for (const store of [added.store, renamed, deleted]) assert.equal(F.parseStore(JSON.parse(JSON.stringify(store))).ok, true);
});

test("exportCsv writes what planImport reads", () => {
  let s = F.emptyStore();
  s = F.saveAccount(s, null, "Trade Republic").store;
  s = F.saveAccount(s, null, 'ING; "Extra"').store;
  const [tr, ing] = s.accounts.map((a) => a.id);
  s = F.saveMonth(s, "2026-02", [{ account: tr, value: 123456789, payIn: -5005 }]);
  s = F.saveMonth(s, "2026-01", [{ account: ing, value: 7, payIn: 0 }, { account: tr, value: 100000, payIn: 50000 }]);

  assert.equal(F.exportCsv(s), [
    "date,account,value,pay_in",
    "2026-01-31,Trade Republic,1000.00,500.00",
    '2026-01-31,"ING; ""Extra""",0.07,0.00',
    "2026-02-28,Trade Republic,1234567.89,-50.05",
    "",
  ].join("\n"));
  assert.equal(F.exportCsv(s, { decimal: "," }).split("\n")[3], "2026-02-28;Trade Republic;1234567,89;-50,05");
  assert.equal(F.exportCsv(F.emptyStore()), "date,account,value,pay_in\n");

  for (const decimal of [".", ","]) {
    const plan = F.planImport(s, F.exportCsv(s, { decimal }));
    assert.deepEqual(plan.errors, [], decimal);
    assert.equal(plan.replaced, 3);
    assert.deepEqual(F.applyImport(s, plan), s, "importing an export changes nothing");
    const fresh = F.applyImport(F.emptyStore(), F.planImport(F.emptyStore(), F.exportCsv(s, { decimal })));
    assert.deepEqual(F.portfolioSeries(fresh), F.portfolioSeries(s));
  }
});

// ---------------------------------------------------------------- forecast

// Born 1990, retires in January 2057. FI number: 2.000 € a month × 12 × 25.
function plan(changes = {}) {
  return {
    start: "2026-10",
    value: 50000 * EUR,
    expenses: 2000 * EUR,
    fiNumber: 600000 * EUR,
    birthYear: 1990,
    retirementAge: 67,
    growth: 5,
    contribution: 1000 * EUR,
    coastContribution: 0,
    ...changes,
  };
}
const monthly = (growth) => (1 + growth / 100) ** (1 / 12) - 1;
const close = (actual, expected, what) => assert.ok(Math.abs(actual - expected) < 1e-6 * Math.max(1, Math.abs(expected)), `${what}: ${actual} is not ${expected}`);

test("forecast: the growth rates are the expected return and 2 points less and more", () => {
  assert.deepEqual(F.growthRates(5), { low: 3, mid: 5, high: 7 });
  assert.deepEqual(F.growthRates(1.5), { low: -0.5, mid: 1.5, high: 3.5 });
  // Below 0 too: the portfolio then shrinks, and the target is above the FI number.
  const f = F.forecast(plan({ growth: -0.5, contribution: 0 }));
  assert.ok(f.plans.keep.values[12] < 50000 * EUR);
  assert.ok(f.target[0] > 600000 * EUR);
});

test("forecast: months from the start to age 95, retirement in January of the year of the age", () => {
  const f = F.forecast(plan());
  assert.equal(f.months[0], "2026-10");
  assert.equal(f.months.at(-1), "2085-12");
  assert.equal(f.retirement, "2057-01");
  for (const p of F.PLANS) assert.equal(f.plans[p].values.length, f.months.length);
  assert.equal(F.ageIn("2057-01", 1990), 67);
});

test("forecast: keep going pays in every month until retirement, then takes out expenses", () => {
  const r = monthly(5);
  const keep = F.forecast(plan()).plans.keep;
  assert.equal(keep.values[0], 50000 * EUR);
  close(keep.values[1], 50000 * EUR * (1 + r) + 1000 * EUR, "after a month");
  close(keep.values[12], 50000 * EUR * 1.05 + 1000 * EUR * (0.05 / r), "after a year");
  // 2026-10 to 2056-12: 362 months of paying in.
  const n = 362;
  close(keep.atRetirement, 50000 * EUR * (1 + r) ** n + 1000 * EUR * (((1 + r) ** n - 1) / r), "at retirement");
  const at = F.monthIndex("2057-01") - F.monthIndex("2026-10");
  close(keep.values[at], keep.atRetirement * (1 + r) - 2000 * EUR, "first month of retirement");
  assert.equal(keep.runsOut, null);
  assert.ok(keep.fiMonth > "2026-10" && keep.fiMonth < "2057-01");
});

test("forecast: Coast FI is the first month from which the portfolio reaches the FI number on its own", () => {
  const r = monthly(5);
  const f = F.forecast(plan());
  const coast = f.plans.coast;
  const i = F.monthIndex(coast.coastMonth) - F.monthIndex("2026-10");
  const left = (index) => F.monthIndex("2056-12") - (F.monthIndex("2026-10") + index);
  assert.ok(coast.values[i] * (1 + r) ** left(i) >= 600000 * EUR);
  assert.ok(coast.values[i - 1] * (1 + r) ** left(i - 1) < 600000 * EUR);
  close(f.target[i], (600000 * EUR) / (1 + r) ** left(i), "target");
  assert.equal(f.target[F.monthIndex("2057-01") - F.monthIndex("2026-10")], null, "no target from retirement on");
  // Then nothing is paid in, and the portfolio grows to the FI number.
  close(coast.values[i + 1], coast.values[i] * (1 + r), "after Coast FI");
  assert.ok(coast.atRetirement >= 600000 * EUR && coast.atRetirement < 600000 * EUR * 1.01);
  assert.equal(coast.fiMonth, "2056-12", "in the last month before retirement");
  // Until then the plans are the same.
  assert.deepEqual(coast.values.slice(0, i + 1), f.plans.keep.values.slice(0, i + 1));
  assert.equal(f.plans.keep.coastMonth, coast.coastMonth);

  // With 200 € a month after Coast FI, it comes sooner, and the money still
  // reaches the FI number.
  const smaller = F.forecast(plan({ coastContribution: 200 * EUR })).plans.coast;
  assert.ok(smaller.coastMonth < coast.coastMonth);
  assert.ok(smaller.atRetirement >= 600000 * EUR);
  const j = F.monthIndex(smaller.coastMonth) - F.monthIndex("2026-10");
  close(smaller.values[j + 1], smaller.values[j] * (1 + r) + 200 * EUR, "after Coast FI, the smaller amount");
});

test("forecast: retire at FI takes out expenses from the month after FI", () => {
  const r = monthly(5);
  const f = F.forecast(plan());
  const fi = f.plans.fi;
  assert.equal(fi.fiMonth, f.plans.keep.fiMonth);
  const i = F.monthIndex(fi.fiMonth) - F.monthIndex("2026-10");
  assert.ok(fi.values[i] >= 600000 * EUR && fi.values[i - 1] < 600000 * EUR);
  close(fi.values[i + 1], fi.values[i] * (1 + r) - 2000 * EUR, "after FI");
  // 4 % taken out with 5 % growth: it lasts.
  assert.equal(fi.runsOut, null);
  assert.ok(fi.atRetirement < f.plans.keep.atRetirement);

  // With 3 % growth it runs out about 47 years after FI, and stays empty.
  const slow = F.forecast(plan({ growth: 3, value: 600000 * EUR })).plans.fi;
  assert.equal(slow.fiMonth, "2026-10");
  const years = F.ageIn(slow.runsOut, 1990) - 2026 + 1990;
  assert.ok(years >= 45 && years <= 49, `runs out ${years} years after FI`);
  const k = F.monthIndex(slow.runsOut) - F.monthIndex("2026-10");
  assert.ok(slow.values[k - 1] > 0);
  assert.ok(slow.values.slice(k).every((v) => v === 0));
});

test("forecast: a plan lasts only when money is left at age 150", () => {
  // Already at 30 × yearly expenses at 36, living off it at 3 % growth:
  // that lasts about 78 years, past what is shown but not to 150.
  const f = F.forecast(plan({ value: 2000 * EUR * 12 * 30, growth: 3 }));
  const fi = f.plans.fi;
  assert.equal(fi.fiMonth, "2026-10");
  const age = F.ageIn(fi.runsOut, 1990);
  assert.ok(age > F.SHOWN_AGE && age < F.LASTS_AGE, `runs out at ${age}`);
  assert.ok(fi.values.at(-1) > 0, "still money at 95");
});

test("forecast: past Coast FI and FI at the start", () => {
  const r = monthly(5);
  const f = F.forecast(plan({ value: 700000 * EUR }));
  for (const p of F.PLANS) {
    assert.equal(f.plans[p].coastMonth, "2026-10");
    assert.equal(f.plans[p].fiMonth, "2026-10");
  }
  close(f.plans.fi.values[1], 700000 * EUR * (1 + r) - 2000 * EUR, "fi");
  close(f.plans.coast.values[1], 700000 * EUR * (1 + r), "coast");
  close(f.plans.keep.values[1], 700000 * EUR * (1 + r) + 1000 * EUR, "keep");
});

test("forecast: past the retirement age every plan lives off the portfolio", () => {
  const r = monthly(5);
  const f = F.forecast(plan({ birthYear: 1950 }));
  assert.equal(f.retirement, "2017-01");
  assert.equal(f.months.at(-1), "2045-12", "until 95");
  assert.ok(f.target.every((v) => v === null));
  for (const p of F.PLANS) {
    const { values, coastMonth, fiMonth, atRetirement } = f.plans[p];
    assert.deepEqual([coastMonth, fiMonth, atRetirement], [null, null, null]);
    close(values[1], 50000 * EUR * (1 + r) - 2000 * EUR, p);
  }
  // At least ten years are shown, also past 95.
  assert.equal(F.forecast(plan({ birthYear: 1925 })).months.at(-1), "2036-10");
});
