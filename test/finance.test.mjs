import { test } from "node:test";
import assert from "node:assert/strict";
import * as F from "../app/finance.mjs";

const EUR = 100; // cents
const monthly = (growth) => (1 + growth / 100) ** (1 / 12) - 1;
const close = (actual, expected, what) => assert.ok(Math.abs(actual - expected) < 1e-6 * Math.max(1, Math.abs(expected)), `${what}: ${actual} is not ${expected}`);

// A store with the given parts. Expenses and income without a start or end
// get none, except that income ends at retirement, as in the app.
function store(parts = {}) {
  const s = { ...F.emptyStore(), ...parts };
  s.expenses = s.expenses.map((item) => ({ from: null, until: null, ...item }));
  s.income = s.income.map((item) => ({ from: null, until: { at: "retirement" }, ...item }));
  s.records = s.records.map((record) => ({ oneOff: 0, ...record }));
  s.accounts = s.accounts.map((account) => ({ kind: "invested", ...account }));
  return s;
}

// Settings as versions 7 to 11 had them: without the emergency fund.
const SETTINGS_V11 = (({ emergencyMonths, ...rest }) => rest)(F.DEFAULT_SETTINGS);

// An upgraded store without what versions after 7 added, to compare with
// the file it came from.
function withoutLater({ events, ...s }) {
  const plain = ({ from, until, ...item }) => item;
  return {
    ...s,
    settings: (({ emergencyMonths, ...rest }) => rest)(s.settings),
    expenses: s.expenses.map(({ essential, ...item }) => plain(item)),
    income: s.income.map(plain),
    records: s.records.map(({ oneOff, ...record }) => record),
    accounts: s.accounts.map(({ kind, ...account }) => account),
  };
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
  const rent = { id: "e1", name: "Rent", category: "Housing", amount: 1000 * EUR, everyMonths: 1, from: null, until: null, active: true, essential: false };
  const gym = { id: "e2", name: "Gym", category: "Leisure", amount: 600 * EUR, everyMonths: 12, from: null, until: null, active: false, essential: false };
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
    { month: "2026-01", value: 1500, payIn: 100, oneOff: 0, invested: 1500 },
    { month: "2026-02", value: 1500, payIn: 0, oneOff: 0, invested: 1500 },
    { month: "2026-03", value: 1800, payIn: 100, oneOff: 0, invested: 1600 },
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
  assert.deepEqual(flat.points[0], { month: "2026-11", low: 100, mid: 100, high: flat.points[0].high, goal: 1200 });

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

test("fiProjection: the FI number rises by the inflation", () => {
  const start = 50000 * EUR;
  const payIn = 1250 * EUR;
  const goal = 675000 * EUR;
  const p = F.fiProjection({ month: "2026-10", start, payIn, goal, rate: 8, inflation: 3 });
  assert.deepEqual(p.rates, { low: 6, mid: 8, high: 10 });
  close(p.points[11].goal, goal * 1.03, "a year on");
  for (const k of ["low", "mid", "high"]) {
    assert.equal(p.reach[k], F.addMonths("2026-10", F.projectToGoal(start, payIn, p.rates[k], goal, 3).length), k);
  }
  const n = F.monthIndex(p.reach.mid) - F.monthIndex("2026-10");
  assert.ok(p.points[n - 1].mid >= p.points[n - 1].goal && p.points[n - 2].mid < p.points[n - 2].goal);
  // Later than without inflation, with the same pay-ins.
  assert.ok(p.reach.mid > F.fiProjection({ month: "2026-10", start, payIn, goal, rate: 8 }).reach.mid);
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
  s = F.saveItem(s, "expenses", { id: "e", name: "Rent", category: "Housing", amount: 100, everyMonths: 1, from: null, until: null, active: true, essential: true });
  s = F.saveItem(s, "income", { id: "i", name: "Salary", category: "Work", amount: 100, everyMonths: 1, from: null, until: { at: "retirement" } });
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
    [{ ...roundTrip, settings: (({ inflation, ...rest }) => rest)(roundTrip.settings) }, /missing "inflation"/],
    [{ ...roundTrip, settings: { ...roundTrip.settings, inflation: -1 } }, /inflation must be between 0 and 100/],
    [{ ...roundTrip, settings: { ...roundTrip.settings, inflation: "3" } }, /inflation must be between 0 and 100/],
    [{ ...roundTrip, settings: { ...roundTrip.settings, birthYear: "1990" } }, /birthYear must be null or a year/],
    [{ ...roundTrip, settings: { ...roundTrip.settings, birthYear: 1899 } }, /birthYear must be null or a year from 1900 to 2100/],
    [{ ...roundTrip, settings: { ...roundTrip.settings, retirementAge: 66.5 } }, /retirementAge must be a whole number from 30 to 80/],
    [{ ...roundTrip, settings: { ...roundTrip.settings, retirementAge: null } }, /retirementAge/],
    [{ ...roundTrip, settings: { ...roundTrip.settings, emergencyMonths: 2.5 } }, /emergencyMonths must be a whole number from 0 to 60/],
    [{ ...roundTrip, settings: { ...roundTrip.settings, emergencyMonths: 61 } }, /emergencyMonths/],
    [{ ...roundTrip, settings: { ...F.DEFAULT_SETTINGS, retirementAge: undefined } }, /retirementAge/],
    [{ ...roundTrip, categories: { ...roundTrip.categories, expenses: ["Food", "food"] } }, /repeats the name/],
    [{ ...roundTrip, categories: { ...roundTrip.categories, income: [""] } }, /not a name/],
    [{ ...roundTrip, expenses: [{ ...roundTrip.expenses[0], category: "Nope" }] }, /not in categories.expenses/],
    [{ ...roundTrip, expenses: [{ ...roundTrip.expenses[0], amount: 1.5 }] }, /amount/],
    [{ ...roundTrip, expenses: [{ ...roundTrip.expenses[0], note: "x" }] }, /unknown field "note"/],
    [{ ...roundTrip, expenses: [{ ...roundTrip.expenses[0], active: "yes" }] }, /active must be true or false/],
    [{ ...roundTrip, expenses: [{ id: "e", name: "Rent", category: "", amount: 100, everyMonths: 1, from: null, until: null, essential: true }] }, /missing "active"/],
    [{ ...roundTrip, expenses: [(({ until, ...rest }) => rest)(roundTrip.expenses[0])] }, /missing "until"/],
    [{ ...roundTrip, expenses: [{ ...roundTrip.expenses[0], from: "retirement" }] }, /from must be null, a month, an age or retirement/],
    [{ ...roundTrip, expenses: [{ ...roundTrip.expenses[0], from: { at: "pension" } }] }, /from must be/],
    [{ ...roundTrip, expenses: [{ ...roundTrip.expenses[0], from: { age: 67.5 } }] }, /from must be/],
    [{ ...roundTrip, expenses: [{ ...roundTrip.expenses[0], from: { age: 121 } }] }, /from must be/],
    [{ ...roundTrip, expenses: [{ ...roundTrip.expenses[0], until: { month: "2031-13" } }] }, /until must be/],
    [{ ...roundTrip, expenses: [{ ...roundTrip.expenses[0], until: { month: "2031-12", age: 60 } }] }, /until must be/],
    [{ ...roundTrip, income: [{ ...roundTrip.income[0], until: {} }] }, /until must be/],
    [{ ...roundTrip, expenses: [{ ...roundTrip.expenses[0], essential: "yes" }] }, /essential must be true or false/],
    [{ ...roundTrip, expenses: [(({ essential, ...rest }) => rest)(roundTrip.expenses[0])] }, /missing "essential"/],
    [{ ...roundTrip, income: [{ ...roundTrip.income[0], essential: true }] }, /unknown field "essential"/],
    [{ ...roundTrip, income: [{ ...roundTrip.income[0], active: false }] }, /unknown field "active"/],
    [{ ...roundTrip, records: [{ ...roundTrip.records[0], account: "nope" }] }, /unknown account/],
    [{ ...roundTrip, records: [roundTrip.records[0], roundTrip.records[0]] }, /repeats a month/],
    [{ ...roundTrip, records: [{ ...roundTrip.records[0], value: -1 }] }, /value/],
    [{ ...roundTrip, records: [{ ...roundTrip.records[0], oneOff: 1.5 }] }, /oneOff must be a number of cents/],
    [{ ...roundTrip, records: [(({ oneOff, ...rest }) => rest)(roundTrip.records[0])] }, /missing "oneOff"/],
    [(({ events, ...rest }) => rest)(roundTrip), /missing "events"/],
    [{ ...roundTrip, events: [{ id: "e", name: "Inheritance", month: "2031-13", amount: 100 }] }, /events\[0\] has an invalid month/],
    [{ ...roundTrip, events: [{ id: "e", name: "Inheritance", month: "2031-01", amount: 0 }] }, /other than 0/],
    [{ ...roundTrip, events: [{ id: "e", name: "", month: "2031-01", amount: 100 }] }, /has no name/],
    [{ ...roundTrip, events: [{ id: "e", name: "A", month: "2031-01", amount: 1 }, { id: "e", name: "B", month: "2031-01", amount: 1 }] }, /repeated id/],
    [{ ...roundTrip, accounts: [...roundTrip.accounts, { id: "x", name: "broker", kind: "cash" }] }, /repeats the name/],
    [{ ...roundTrip, accounts: [{ ...roundTrip.accounts[0], kind: "crypto" }] }, /kind must be invested, cash, property, pension, debt/],
    [{ ...roundTrip, accounts: [(({ kind, ...rest }) => rest)(roundTrip.accounts[0])] }, /missing "kind"/],
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
    { month: "2026-01", account: tr, value: 1234567, payIn: 50000, oneOff: 0 },
    { month: "2026-02", account: tr, value: 1300000, payIn: 50000, oneOff: 0 },
    { month: "2026-02", account: ing, value: 800000, payIn: 0, oneOff: 0 },
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
  assert.deepEqual(s.settings, { withdrawalRate: 3.5, bufferPercent: 5, currency: "EUR", numberFormat: "1.000.000,00", expectedReturn: 8, inflation: 3, birthYear: null, retirementAge: 67, emergencyMonths: 6 });
  assert.deepEqual(s.categories, { expenses: ["Car", "Housing"], income: ["Work"] });
  assert.deepEqual(s.expenses.map((e) => e.category), ["Housing", "Housing", "", "Car"]);
  assert.deepEqual(s.expenses.map((e) => e.active), [true, true, true, true], "every expense was active");
  assert.equal("active" in s.income[0], false);
  assert.deepEqual(s.records, v1.records.map((r) => ({ ...r, oneOff: 0 })));
  assert.deepEqual(Object.keys(s), ["version", "settings", "categories", "expenses", "income", "accounts", "records", "events"]);
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
  assert.deepEqual(s.settings, { ...v2.settings, numberFormat: "1.000.000,00", expectedReturn: 8, inflation: 3, birthYear: null, retirementAge: 67, emergencyMonths: 6 });
  assert.deepEqual(s.expenses, v2.expenses.map((e) => ({ ...e, active: true, essential: false, from: null, until: null })));
  assert.deepEqual(s.income, v2.income.map((i) => ({ ...i, from: null, until: { at: "retirement" } })));
  assert.deepEqual(Object.keys(s), ["version", "settings", "categories", "expenses", "income", "accounts", "records", "events"]);
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
  assert.deepEqual(s.settings, { withdrawalRate: 3.5, bufferPercent: 5, currency: "USD", numberFormat: "1.000.000,00", expectedReturn: 8, inflation: 3, birthYear: null, retirementAge: 67, emergencyMonths: 6 });
  assert.deepEqual({ ...withoutLater(s), version: 3, settings: v3.settings }, v3, "nothing else changes");
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
  // 5 % after inflation then, so 8 % before 3 % inflation now.
  assert.deepEqual(s.settings, { ...v4.settings, expectedReturn: 8, inflation: 3, birthYear: null, retirementAge: 67, emergencyMonths: 6 });
  assert.deepEqual({ ...withoutLater(s), version: 4, settings: v4.settings }, v4, "nothing else changes");
  assert.equal("expectedReturn" in v4.settings, false, "the parsed value is left alone");

  assert.match(F.parseStore({ ...v4, extra: 1 }).error, /unknown field "extra"/);
  assert.match(F.parseStore({ ...v4, settings: { ...v4.settings, expectedReturn: 5 } }).error, /unknown field "expectedReturn"/);
});

test("projectToGoal: the goal rises by the inflation", () => {
  // 1,000 at 12 % a year is 1,078 after 8 months and 1,089 after 9.
  assert.deepEqual(F.projectToGoal(250, 100, 0, 1000, 12), [350, 450, 550, 650, 750, 850, 950, 1050, 1150]);
  assert.equal(F.projectToGoal(0, 100, 0, 1000, 200), null, "prices rise faster than the pay-ins");
  close(F.inflated(1000, 12, 12), 1120, "a year");
  close(F.inflated(1000, 3, 0), 1000, "now");

  // With nothing paid in, the FI number is reached in the same month as
  // when today's FI number is reached at the return after inflation.
  const real = (1.08 / 1.03 - 1) * 100;
  const months = F.projectToGoal(100000 * EUR, 0, 8, 675000 * EUR, 3).length;
  assert.equal(months, F.projectToGoal(100000 * EUR, 0, real, 675000 * EUR).length);
  assert.ok(months > 39 * 12 && months < 41 * 12, `${months} months`);
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
    settings: { ...F.DEFAULT_SETTINGS, bufferPercent: 0, expectedReturn: 0, inflation: 0 },
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

  // At 12 % inflation the FI number is 30,000 × 1.12^(1/6) ≈ 30,573 two
  // months on, so it takes a third month.
  const pricier = F.metrics(F.saveSettings(s, { inflation: 12 }));
  assert.equal(pricier.fiNumber, 30000 * EUR, "today's FI number stays");
  assert.equal(pricier.fiMonths, 3);

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
  assert.deepEqual(s.settings, { ...v5.settings, expectedReturn: 9, inflation: 3, birthYear: null, retirementAge: 67, emergencyMonths: 6 });
  assert.deepEqual({ ...withoutLater(s), version: 5, settings: v5.settings }, v5, "nothing else changes");
  assert.equal("birthYear" in v5.settings, false, "the parsed value is left alone");

  assert.match(F.parseStore({ ...v5, settings: { ...v5.settings, retirementAge: 65 } }).error, /unknown field "retirementAge"/);
  assert.equal(F.parseStore({ ...s, settings: { ...s.settings, birthYear: 1990, retirementAge: 65 } }).ok, true);
});

test("a version 6 file is upgraded: the expected return before inflation, and 3 % inflation", () => {
  const v6 = {
    version: 6,
    settings: { withdrawalRate: 3.5, bufferPercent: 5, currency: "USD", numberFormat: "1,000,000.00", expectedReturn: 4.25, birthYear: 1990, retirementAge: 65 },
    categories: { expenses: ["Housing"], income: [] },
    expenses: [{ id: "e1", name: "Rent", category: "Housing", amount: 100, everyMonths: 1, active: true }],
    income: [],
    accounts: [{ id: "a", name: "Broker" }],
    records: [{ month: "2026-10", account: "a", value: 5, payIn: 1 }],
  };
  const result = F.parseStore(v6);
  assert.equal(result.ok, true, result.error);
  const s = result.store;
  assert.equal(s.version, F.VERSION);
  assert.deepEqual(s.settings, { ...v6.settings, expectedReturn: 7.25, inflation: 3, emergencyMonths: 6 });
  assert.deepEqual({ ...withoutLater(s), version: 6, settings: v6.settings }, v6, "nothing else changes");
  assert.equal(v6.settings.expectedReturn, 4.25, "the parsed value is left alone");

  assert.equal(F.parseStore({ ...v6, settings: { ...v6.settings, expectedReturn: 99 } }).store.settings.expectedReturn, 100);
  assert.equal(F.parseStore({ ...v6, settings: { ...v6.settings, expectedReturn: 0.1 } }).store.settings.expectedReturn, 3.1);
  assert.match(F.parseStore({ ...v6, settings: { ...v6.settings, inflation: 2 } }).error, /unknown field "inflation"/);
  assert.match(F.parseStore({ ...v6, settings: { ...v6.settings, expectedReturn: "5" } }).error, /expectedReturn must be between 0 and 100/);
});

test("a version 7 file is upgraded: no expense is essential", () => {
  const v7 = {
    version: 7,
    settings: { ...SETTINGS_V11 },
    categories: { expenses: ["Housing"], income: [] },
    expenses: [
      { id: "e1", name: "Rent", category: "Housing", amount: 100, everyMonths: 1, active: true },
      { id: "e2", name: "Gym", category: "", amount: 30, everyMonths: 1, active: false },
    ],
    income: [{ id: "i1", name: "Salary", category: "", amount: 300, everyMonths: 1 }],
    accounts: [],
    records: [],
  };
  const result = F.parseStore(v7);
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(withoutLater(result.store), { ...v7, version: F.VERSION });
  assert.deepEqual(result.store.expenses.map((e) => e.essential), [false, false]);
  assert.equal("essential" in v7.expenses[0], false, "the parsed value is left alone");
  assert.equal(F.metrics(result.store).lean, null);
});

test("a version 8 file is upgraded: expenses always count, income until retirement", () => {
  const v8 = {
    version: 8,
    settings: { ...SETTINGS_V11, birthYear: 1990 },
    categories: { expenses: [], income: [] },
    expenses: [{ id: "e1", name: "Rent", category: "", amount: 100, everyMonths: 1, active: true, essential: true }],
    income: [{ id: "i1", name: "Salary", category: "", amount: 300, everyMonths: 1 }],
    accounts: [],
    records: [],
  };
  const result = F.parseStore(v8);
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(result.store, {
    ...v8,
    version: F.VERSION,
    settings: { ...v8.settings, emergencyMonths: 6 },
    expenses: [{ ...v8.expenses[0], from: null, until: null }],
    income: [{ ...v8.income[0], from: null, until: { at: "retirement" } }],
    accounts: [],
    events: [],
  });
  assert.equal("from" in v8.expenses[0], false, "the parsed value is left alone");
  // As before: the salary does not lower the FI number.
  const m = F.metrics(result.store, "2026-11");
  assert.equal(m.income, 300);
  assert.equal(m.fiNumber, 110 * 12 * 25);
});

test("a version 9 file is upgraded: no one-offs", () => {
  const v9 = {
    version: 9,
    settings: { ...SETTINGS_V11 },
    categories: { expenses: [], income: [] },
    expenses: [],
    income: [],
    accounts: [{ id: "a", name: "A" }],
    records: [{ month: "2026-10", account: "a", value: 500, payIn: 100 }],
  };
  const result = F.parseStore(v9);
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(withoutLater(result.store), { ...v9, version: F.VERSION });
  assert.deepEqual(result.store.records[0].oneOff, 0);
  assert.deepEqual(result.store.events, []);
  assert.equal("oneOff" in v9.records[0], false, "the parsed value is left alone");
});

test("one-offs count as paid in, but not for the average pay-in", () => {
  // 500 a month, and an inheritance of 50,000 in March.
  const s = store({
    accounts: [{ id: "a", name: "A" }],
    records: [
      { month: "2026-01", account: "a", value: 10000, payIn: 0 },
      { month: "2026-02", account: "a", value: 10600, payIn: 500 },
      { month: "2026-03", account: "a", value: 61200, payIn: 500, oneOff: 50000 },
    ],
  });
  const series = F.portfolioSeries(s);
  assert.deepEqual(series.at(-1), { month: "2026-03", value: 61200, payIn: 500, oneOff: 50000, invested: 61000 });
  assert.deepEqual(F.averagePayIn(series), { average: 1000 / 3, months: 3 });
  // The gain leaves the inheritance out: 61,200 - 10,000 - 1,000 - 50,000.
  assert.equal(F.gains(series).gain, 200);
  const m = F.metrics({ ...s, settings: { ...F.DEFAULT_SETTINGS } });
  assert.equal(m.investmentRate, null);
  assert.equal(m.payIn.average, 1000 / 3);
});

test("planned one-offs: saved, checked, and in the month they come", () => {
  let s = F.emptyStore();
  const added = F.saveEvent(s, { id: null, name: " House deposit ", month: "2028-04", amount: -6000000 });
  assert.equal(added.ok, true);
  s = added.store;
  s = F.saveEvent(s, { id: null, name: "Inheritance", month: "2027-01", amount: 5000000 }).store;
  assert.deepEqual(s.events.map((e) => [e.month, e.name]), [["2027-01", "Inheritance"], ["2028-04", "House deposit"]]);
  assert.deepEqual(F.saveEvent(s, { id: null, name: "", month: "2027-01", amount: 1 }), { ok: false, error: "Enter a name" });
  assert.deepEqual(F.saveEvent(s, { id: null, name: "X", month: "2027", amount: 1 }), { ok: false, error: "Choose a month" });
  assert.deepEqual(F.saveEvent(s, { id: null, name: "X", month: "2027-01", amount: 0 }), { ok: false, error: "Enter an amount other than 0" });
  const changed = F.saveEvent(s, { ...s.events[1], amount: -7000000 }).store;
  assert.equal(changed.events.length, 2);
  assert.equal(F.oneOffsIn(changed, F.monthIndex("2028-04")), -7000000);
  assert.equal(F.oneOffsIn(changed, F.monthIndex("2028-05")), 0);
  assert.equal(F.deleteEvent(changed, s.events[0].id).events.length, 1);
  assert.equal(F.parseStore(JSON.parse(JSON.stringify(changed))).ok, true);
  assert.equal(s.events[1].amount, -6000000, "the original is untouched");

  // 1,000 a month without growth to 50,000: an inheritance of 20,000 after
  // 10 months saves 20 months.
  assert.equal(F.projectToGoal(0, 1000, 0, 50000).length, 50);
  assert.equal(F.projectToGoal(0, 1000, 0, 50000, 0, (n) => (n === 10 ? 20000 : 0)).length, 30);
  const p = F.fiProjection({ month: "2026-10", start: 0, payIn: 1000, goal: 50000, rate: 2, oneOffs: (n) => (n === 1 ? 49000 : 0) });
  assert.equal(p.points[0].mid, 50000);
});

test("a version 10 file is upgraded: every account is invested", () => {
  const v10 = { ...F.emptyStore(), version: 10, settings: { ...SETTINGS_V11 }, accounts: [{ id: "a", name: "A" }] };
  const result = F.parseStore(v10);
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(withoutLater(result.store), { ...withoutLater(v10), version: F.VERSION });
  assert.equal(result.store.accounts[0].kind, "invested");
  assert.equal("kind" in v10.accounts[0], false, "the parsed value is left alone");
});

test("net worth: every kind of account, debts taken off; the portfolio is the invested ones", () => {
  let s = F.emptyStore();
  for (const [name, kind] of [["Broker", "invested"], ["Tagesgeld", "cash"], ["Flat", "property"], ["Rürup", "pension"], ["Mortgage", "debt"]]) {
    s = F.saveAccount(s, null, name, kind).store;
  }
  const id = Object.fromEntries(s.accounts.map((a) => [a.name, a.id]));
  s = F.saveMonth(s, "2026-09", [
    { account: id.Broker, value: 50000, payIn: 0 },
    { account: id.Tagesgeld, value: 10000, payIn: 0 },
    { account: id.Flat, value: 300000, payIn: 0 },
    { account: id.Mortgage, value: 200000, payIn: 0 },
  ]);
  s = F.saveMonth(s, "2026-10", [
    { account: id.Broker, value: 52000, payIn: 1000 },
    { account: id.Rürup, value: 8000, payIn: 0 },
    { account: id.Mortgage, value: 199000, payIn: 1000 },
  ]);
  assert.deepEqual(F.netWorthSeries(s), [
    { month: "2026-09", total: 160000, kinds: { invested: 50000, cash: 10000, property: 300000, pension: 0, debt: 200000 } },
    { month: "2026-10", total: 171000, kinds: { invested: 52000, cash: 10000, property: 300000, pension: 8000, debt: 199000 } },
  ]);
  // The portfolio, its pay-ins and the FI progress are the broker's alone.
  assert.deepEqual(F.portfolioSeries(s).map((m) => [m.value, m.payIn]), [[50000, 0], [52000, 1000]]);
  const m = F.metrics({ ...s, settings: { ...F.DEFAULT_SETTINGS } });
  assert.equal(m.portfolio, 52000);
  assert.deepEqual(m.netWorth.map((n) => n.total), [160000, 171000]);
  assert.equal(F.parseStore(JSON.parse(JSON.stringify(s))).ok, true);

  // Changing the kind moves an account between portfolio and the rest.
  const moved = F.saveAccount(s, id.Tagesgeld, "Tagesgeld", "invested").store;
  assert.equal(F.metrics({ ...moved, settings: { ...F.DEFAULT_SETTINGS } }).portfolio, 62000);
  assert.equal(F.saveAccount(s, id.Broker, "Broker").store.accounts[0].kind, "invested", "renaming keeps the kind");
  assert.deepEqual(F.saveAccount(s, null, "X", "gold"), { ok: false, error: "Choose what the account holds" });
  assert.equal(F.saveAccount(F.emptyStore(), null, "New").store.accounts[0].kind, "invested");
});

test("a version 11 file is upgraded: an emergency fund of 6 months", () => {
  const v11 = { ...F.emptyStore(), version: 11, settings: { ...SETTINGS_V11, bufferPercent: 5 } };
  const result = F.parseStore(v11);
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(result.store, { ...v11, version: F.VERSION, settings: { ...v11.settings, emergencyMonths: 6 } });
  assert.match(F.parseStore({ ...v11, settings: { ...v11.settings, emergencyMonths: 3 } }).error, /unknown field "emergencyMonths"/);
});

test("emergency fund: the cash accounts in months of expenses, and what is missing", () => {
  assert.deepEqual(F.emergencyFund(6000, 2000, 6), { cash: 6000, months: 3, target: 6, short: 6000 });
  assert.deepEqual(F.emergencyFund(15000, 2000, 6), { cash: 15000, months: 7.5, target: 6, short: 0 });
  assert.equal(F.emergencyFund(5000, 0, 6).months, null);

  let s = F.emptyStore();
  s = F.saveItem(s, "expenses", { id: "e", name: "Rent", category: "", amount: 2000 * EUR, everyMonths: 1, from: null, until: null, active: true, essential: false });
  s = F.saveAccount(s, null, "Broker", "invested").store;
  assert.equal(F.metrics(s).emergency, null, "no cash account");
  s = F.saveAccount(s, null, "Tagesgeld", "cash").store;
  s = F.saveAccount(s, null, "Savings", "cash").store;
  const [broker, tagesgeld, savings] = s.accounts.map((a) => a.id);
  s = F.saveMonth(s, "2026-09", [{ account: broker, value: 50000 * EUR, payIn: 0 }, { account: tagesgeld, value: 4000 * EUR, payIn: 0 }]);
  s = F.saveMonth(s, "2026-10", [{ account: savings, value: 7000 * EUR, payIn: 0 }]);
  // 11,000 in cash, 2,200 a month with the buffer: 5 months of 6.
  const e = F.metrics(s).emergency;
  assert.equal(e.cash, 11000 * EUR);
  close(e.months, 5, "months");
  close(e.short, 2200 * EUR, "short");
  assert.equal(F.metrics({ ...s, settings: { ...s.settings, emergencyMonths: 3 } }).emergency.short, 0);
});

test("returns: time-weighted months chained, and money-weighted", () => {
  // 10 % up, then 10 % down: -1 % time-weighted, whatever was paid in.
  const series = [
    { month: "2025-12", value: 1000, payIn: 0, oneOff: 0, invested: 1000 },
    { month: "2026-01", value: 1100, payIn: 0, oneOff: 0, invested: 1000 },
    { month: "2026-02", value: 990, payIn: 0, oneOff: 0, invested: 1000 },
  ];
  const r = F.monthlyReturns(series);
  close(r[0].rate, 0.1, "January");
  close(r[1].rate, -0.1, "February");
  close(F.timeWeighted(r), -0.01, "chained");
  close(F.yearToDate(r), -0.01, "this year");
  assert.equal(F.timeWeighted(r, 12), null, "not 12 months yet");

  // Paid in mid-month counts from the middle: 1000 + 100 in, worth 1155.
  const flow = F.monthlyReturns([
    { month: "2026-01", value: 1000, payIn: 0, oneOff: 0, invested: 1000 },
    { month: "2026-02", value: 1155, payIn: 100, oneOff: 0, invested: 1100 },
  ]);
  close(flow[0].rate, 55 / 1050, "Modified Dietz");
  // A new account's first value goes in, it is no gain.
  const added = F.monthlyReturns([
    { month: "2026-01", value: 1000, payIn: 0, oneOff: 0, invested: 1000 },
    { month: "2026-02", value: 6000, payIn: 0, oneOff: 0, invested: 6000 },
  ]);
  close(added[0].rate, 0, "new account");

  // 1 % a month for 24 months: 12,68 % a year, both ways when nothing is paid in.
  const steady = Array.from({ length: 25 }, (_, i) => ({ month: F.addMonths("2024-10", i), value: 1000 * 1.01 ** i, payIn: 0, oneOff: 0, invested: 1000 }));
  const all = F.returnsOf(steady);
  close(all.all, 1.01 ** 12 - 1, "since the start, a year");
  close(all.year, 1.01 ** 12 - 1, "last year");
  close(all.moneyWeighted, 1.01 ** 12 - 1, "money-weighted");
  close(all.ytd, 1.01 ** 10 - 1, "January to October");
  assert.equal(all.three, null);
  assert.equal(all.since, "2024-10");
  assert.equal(F.moneyWeighted(steady.slice(0, 1)), null);
  // Large moves over a short history have a rate too: over the whole time,
  // as the time-weighted one, before 12 months.
  const month = (value) => [{ month: "2026-01", value: 1000, payIn: 0, oneOff: 0, invested: 1000 }, { month: "2026-02", value, payIn: 0, oneOff: 0, invested: 1000 }];
  close(F.moneyWeighted(month(1300)), 0.3, "30 % in a month");
  close(F.moneyWeighted(month(500)), -0.5, "half in a month");
  close(F.returnsOf(month(1300)).all, 0.3, "time-weighted, the same");
  // An empty month with nothing going in is no return, not a gap.
  const emptied = F.monthlyReturns([
    { month: "2026-01", value: 0, payIn: 0, oneOff: 0, invested: 0 },
    { month: "2026-02", value: 0, payIn: 0, oneOff: 0, invested: 0 },
    { month: "2026-03", value: 1100, payIn: 1000, oneOff: 0, invested: 1000 },
  ]);
  assert.deepEqual(emptied.map((r) => r.rate), [0, 0.2]);

  // Paying in before a fall weighs it more with money than with time.
  const timing = [
    { month: "2026-01", value: 1000, payIn: 0, oneOff: 0, invested: 1000 },
    { month: "2026-02", value: 2200, payIn: 1000, oneOff: 0, invested: 2000 },
    { month: "2026-03", value: 1100, payIn: 0, oneOff: 0, invested: 2000 },
  ];
  const t = F.returnsOf(timing);
  close(t.all, (1 + 200 / 1500) * 0.5 - 1, "two months, time-weighted");
  // Both over the two months.
  const perMonth = { time: (1 + t.all) ** (1 / 2) - 1, money: (1 + t.moneyWeighted) ** (1 / 2) - 1 };
  assert.ok(perMonth.money < perMonth.time - 0.03, `money-weighted ${perMonth.money} is worse than time-weighted ${perMonth.time}`);
});

test("accountSeries: one account's values, pay-ins and one-offs", () => {
  let s = F.emptyStore();
  s = F.saveAccount(s, null, "A").store;
  s = F.saveAccount(s, null, "B", "cash").store;
  const [a, b] = s.accounts.map((x) => x.id);
  s = F.saveMonth(s, "2026-01", [{ account: a, value: 1000, payIn: 0 }, { account: b, value: 500, payIn: 0 }]);
  s = F.saveMonth(s, "2026-02", [{ account: a, value: 1200, payIn: 100, oneOff: 50 }]);
  assert.deepEqual(F.accountSeries(s, a), [
    { month: "2026-01", value: 1000, payIn: 0, oneOff: 0, invested: 1000 },
    { month: "2026-02", value: 1200, payIn: 100, oneOff: 50, invested: 1150 },
  ]);
  assert.equal(F.accountSeries(s, b).length, 1, "any kind of account");
  // Until a later month: its last value carries on, nothing paid in.
  assert.deepEqual(F.accountSeries(s, b, "2026-03").map((m) => [m.month, m.value, m.payIn, m.invested]),
    [["2026-01", 500, 0, 500], ["2026-02", 500, 0, 500], ["2026-03", 500, 0, 500]]);
  assert.equal(F.accountSeries(s, a, "2026-02").length, 2, "already there");
});

test("countsIn: from its first month until before its end", () => {
  const birthYear = 1990;
  const retirement = (1990 + 67) * 12; // January 2057
  const at = (month) => F.monthIndex(month);
  const item = (from, until, active) => ({ from, until, ...(active === undefined ? {} : { active }) });
  const counts = (i, month, retire = retirement, born = birthYear) => F.countsIn(i, at(month), born, retire);

  assert.equal(counts(item(null, null), "1900-01"), true);
  assert.equal(counts(item(null, null, false), "2026-11"), false, "inactive never counts");
  // A month start is its first month; a month end its last.
  const kita = item({ month: "2027-08" }, { month: "2031-07" });
  assert.deepEqual(["2027-07", "2027-08", "2031-07", "2031-08"].map((m) => counts(kita, m)), [false, true, true, false]);
  // Retirement and ages are January of their year.
  const salary = item(null, { at: "retirement" });
  assert.deepEqual(["2056-12", "2057-01"].map((m) => counts(salary, m)), [true, false]);
  assert.equal(counts(salary, "2056-12", at("2040-05")), false, "retiring early ends it early");
  const pension = item({ age: 67 }, null);
  assert.deepEqual(["2056-12", "2057-01"].map((m) => counts(pension, m)), [false, true]);
  const bridge = item({ at: "retirement" }, { age: 67 });
  assert.deepEqual(["2049-12", "2050-01", "2056-12", "2057-01"].map((m) => counts(bridge, m, at("2050-01"))), [false, true, true, false]);
  // Without a year of birth, ages and retirement are never reached.
  assert.equal(counts(pension, "2090-01", Infinity, null), false);
  assert.equal(counts(item(null, { age: 30 }), "2090-01", Infinity, null), true);
  assert.equal(F.retirementIndex({ birthYear: null, retirementAge: 67 }), Infinity);
  assert.equal(F.retirementIndex({ birthYear: 1990, retirementAge: 67 }), retirement);
});

test("metrics: what counts now, and the FI number for retiring now", () => {
  const item = (name, amount, from, until, extra = {}) => ({ id: name, name, category: "", amount: amount * EUR, everyMonths: 1, from, until, ...extra });
  const s = store({
    settings: { ...F.DEFAULT_SETTINGS, birthYear: 1990, bufferPercent: 0, expectedReturn: 0, inflation: 0 },
    expenses: [
      item("Rent", 1000, null, null, { active: true, essential: true }),
      item("Commute", 100, null, { at: "retirement" }, { active: true, essential: false }),
      item("Health insurance", 300, { at: "retirement" }, { age: 67 }, { active: true, essential: true }),
      item("Kita", 400, null, { month: "2026-10" }, { active: true, essential: false }),
    ],
    income: [
      item("Salary", 3000, null, { at: "retirement" }),
      item("Rent from a flat", 200, null, null),
      item("State pension", 1000, { age: 67 }, null),
    ],
    accounts: [{ id: "a", name: "A" }],
    records: [{ month: "2026-10", account: "a", value: 100000 * EUR, payIn: 1000 * EUR }],
  });
  const m = F.metrics(s, "2026-11");
  // Now: rent and commute (Kita has ended), salary and the flat.
  assert.equal(m.baseExpenses, 1100 * EUR);
  assert.equal(m.income, 3200 * EUR);
  // Retiring now: rent and health insurance, less the flat's rent.
  assert.equal(m.retiredNeed, 1100 * EUR);
  assert.equal(m.fiNumber, 1100 * 12 * 25 * EUR);
  assert.equal(m.lean.fiNumber, 1100 * 12 * 25 * EUR, "both essential expenses, less the income");
  // From 2057 the pension pays the health insurance's part and more.
  assert.equal(F.fiNumberIn(s, F.monthIndex("2057-01")), 0);
  assert.equal(F.needIn(s, F.monthIndex("2056-12"), F.monthIndex("2056-12")), 1100 * EUR);
  // The goal of each month is the FI number for retiring then.
  assert.equal(m.goal(0), m.fiNumber);
  assert.equal(m.goal(F.monthIndex("2057-01") - F.monthIndex("2026-10")), 0);
});

test("fiNumberParts: a bridge until income starts or expenses end, then the multiple", () => {
  const item = (name, amount, from, until, extra = {}) => ({ id: name, name, category: "", amount: amount * EUR, everyMonths: 1, from, until, ...extra });
  const rent = item("Rent", 2000, null, null, { active: true, essential: true });
  const health = item("Health", 300, { at: "retirement" }, { age: 67 }, { active: true, essential: false });
  const pension = item("Pension", 1200, { age: 67 }, null);
  const s = (expenses, income = []) => store({ settings: { ...F.DEFAULT_SETTINGS, birthYear: 1990, bufferPercent: 0 }, expenses, income });
  const at50 = F.monthIndex("2040-01");
  const bridge = F.monthIndex("2057-01") - at50; // 204 months until 67

  // Nothing changes later: the multiple, as before.
  assert.deepEqual(F.fiNumberParts(s([rent]), at50), { fiNumber: 2000 * 300 * EUR, long: 2000 * EUR, extra: 0, from: at50 });
  // A pension from 67: 800 a month for good, and 1,200 more until then.
  const withPension = F.fiNumberParts(s([rent], [pension]), at50);
  assert.equal(withPension.long, 800 * EUR);
  assert.equal(withPension.extra, 1200 * bridge * EUR);
  assert.equal(withPension.fiNumber, (800 * 300 + 1200 * bridge) * EUR);
  assert.equal(withPension.from, F.monthIndex("2057-01"));
  // Health insurance from retirement until 67 adds to the bridge.
  assert.equal(F.fiNumberIn(s([rent, health], [pension]), at50), (800 * 300 + 1500 * bridge) * EUR);
  // Lean FI: the essential expenses only.
  assert.equal(F.fiNumberIn(s([rent, health], [pension]), at50, { essential: true }), (800 * 300 + 1200 * bridge) * EUR);
  // Retiring at 67 there is no bridge.
  assert.equal(F.fiNumberIn(s([rent, health], [pension]), F.monthIndex("2057-01")), 800 * 300 * EUR);
  // Never more than paying the most for good: an expense until 100.
  const long = item("Loan", 1000, null, { age: 100 }, { active: true, essential: false });
  assert.equal(F.fiNumberIn(s([long]), at50), 1000 * 300 * EUR);
  // Costs that come later count for good from the start.
  const care = item("Care", 500, { age: 80 }, null, { active: true, essential: false });
  assert.equal(F.fiNumberIn(s([rent, care]), at50), 2500 * 300 * EUR);
  // Inactive ones change nothing.
  assert.equal(F.fiNumberIn(s([rent, { ...care, active: false }]), at50), 2000 * 300 * EUR);
});

test("statePension: points × their value, less for starting early, more for late", () => {
  const base = { points: 30, pointValue: 4252, regularAge: 67, deductions: 12.35 };
  const at67 = F.statePension({ ...base, startAge: 67 });
  assert.equal(at67.gross, 127560);
  assert.equal(at67.change, 0);
  close(at67.net, 127560 * 0.8765, "net");
  const at63 = F.statePension({ ...base, startAge: 63 });
  close(at63.change, -0.144, "4 years early");
  close(at63.gross, 127560 * 0.856, "gross at 63");
  close(F.statePension({ ...base, startAge: 60 }).change, -0.144, "at most 48 months early");
  close(F.statePension({ ...base, startAge: 70 }).change, 0.18, "3 years late");
});

test("healthInsurance: the minimum base × the rates", () => {
  const g = F.GERMANY_2026;
  close(F.healthInsurance({ base: g.minimumBase, rates: [g.generalRate, g.extraRate, g.careRateChildless] }), 131833 * 0.211, "childless");
  close(F.healthInsurance({ base: g.minimumBase, rates: [g.generalRate, g.extraRate, g.careRate] }), 131833 * 0.205, "with children");
});

test("projectToGoal and fiProjection take a goal that changes", () => {
  // 1,000 a month without growth; the goal drops from 50,000 to 20,000
  // after 12 months.
  const goal = (n) => (n < 12 ? 50000 : 20000);
  assert.equal(F.projectToGoal(0, 1000, 0, goal).length, 20);
  const p = F.fiProjection({ month: "2026-10", start: 0, payIn: 1000, goal, rate: 2 });
  assert.equal(p.points[0].goal, 50000);
  assert.equal(p.points[12].goal, 20000);
  assert.equal(F.fiProjection({ month: "2026-10", start: 0, payIn: 1000, goal: () => 0, rate: 2 }), null);
});

test("Lean FI: the FI number and time to FI for the essential expenses only", () => {
  const item = (id, amount, essential, active = true) => ({ id, name: id, category: "", amount: amount * EUR, everyMonths: 1, active, essential });
  const s = store({
    settings: { ...F.DEFAULT_SETTINGS, expectedReturn: 0, inflation: 0 },
    expenses: [item("rent", 1000, true), item("food", 400, true), item("travel", 600, false), item("car", 300, true, false)],
    accounts: [{ id: "a", name: "A" }],
    records: [{ month: "2026-10", account: "a", value: 154000 * EUR, payIn: 1000 * EUR }],
  });
  const m = F.metrics(s);
  // Essential and active: 1,400 a month, plus the 10 % buffer.
  close(m.lean.expenses, 1540 * EUR, "lean expenses");
  close(m.lean.fiNumber, 1540 * 12 * 25 * EUR, "Lean FI number");
  close(m.fiNumber, 2200 * 12 * 25 * EUR, "the FI number counts every active expense");
  close(m.lean.progress, 154000 / 462000, "progress");
  // 308,000 to go at 1,000 a month without growth.
  assert.equal(m.lean.months, 308);
  assert.equal(m.fiMonths, 506);

  const reached = F.metrics({ ...s, records: [{ ...s.records[0], value: 500000 * EUR }] });
  assert.equal(reached.lean.months, 0);
  assert.ok(reached.lean.progress > 1);
  assert.equal(F.metrics({ ...s, records: [] }).lean.progress, null, "no portfolio, no progress");
  assert.equal(F.metrics({ ...s, expenses: s.expenses.map((e) => ({ ...e, essential: false })) }).lean, null);
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
  s = F.saveItem(s, "expenses", { id: "e", name: "Rent", category: "Housing", amount: 100, everyMonths: 1, from: null, until: null, active: true, essential: true });
  s = F.saveItem(s, "income", { id: "i", name: "Salary", category: "Work", amount: 100, everyMonths: 1, from: null, until: { at: "retirement" } });

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
  s = F.saveAccount(s, null, 'ING; "Extra"', "cash").store;
  const [tr, ing] = s.accounts.map((a) => a.id);
  s = F.saveMonth(s, "2026-02", [{ account: tr, value: 123456789, payIn: -5005, oneOff: 25000000 }]);
  s = F.saveMonth(s, "2026-01", [{ account: ing, value: 7, payIn: 0 }, { account: tr, value: 100000, payIn: 50000 }]);

  assert.equal(F.exportCsv(s), [
    "date,account,value,pay_in,one_off,kind",
    "2026-01-31,Trade Republic,1000.00,500.00,0.00,invested",
    '2026-01-31,"ING; ""Extra""",0.07,0.00,0.00,cash',
    "2026-02-28,Trade Republic,1234567.89,-50.05,250000.00,invested",
    "",
  ].join("\n"));
  assert.equal(F.exportCsv(s, { decimal: "," }).split("\n")[3], "2026-02-28;Trade Republic;1234567,89;-50,05;250000,00;invested");
  assert.equal(F.exportCsv(F.emptyStore()), "date,account,value,pay_in,one_off,kind\n");

  for (const decimal of [".", ","]) {
    const plan = F.planImport(s, F.exportCsv(s, { decimal }));
    assert.deepEqual(plan.errors, [], decimal);
    assert.equal(plan.replaced, 3);
    assert.deepEqual(F.applyImport(s, plan), s, "importing an export changes nothing");
    const fresh = F.applyImport(F.emptyStore(), F.planImport(F.emptyStore(), F.exportCsv(s, { decimal })));
    assert.deepEqual(F.portfolioSeries(fresh), F.portfolioSeries(s));
  }
  // Files without one_off import as before.
  const old = F.planImport(F.emptyStore(), "date;account;value;pay_in\n31.01.2026;TR;100;10\n");
  assert.equal(old.entries[0].oneOff, 0);
  const bad = F.planImport(F.emptyStore(), "date;account;value;pay_in;one_off\n31.01.2026;TR;100;10;x\n");
  assert.match(bad.errors[0].message, /One-off/);
  // kind: what new accounts hold; accounts that exist keep theirs.
  const kinds = F.planImport(s, "date;account;value;kind\n31.01.2026;Flat;300000;Property\n31.01.2026;Trade Republic;1;cash\n31.01.2026;New;1;\n");
  assert.deepEqual(kinds.errors, []);
  const imported = F.applyImport(s, kinds);
  assert.deepEqual(imported.accounts.map((a) => [a.name, a.kind]), [["Trade Republic", "invested"], ['ING; "Extra"', "cash"], ["Flat", "property"], ["New", "invested"]]);
  assert.match(F.planImport(s, "date;account;value;kind\n31.01.2026;X;1;gold\n").errors[0].message, /Kind: "gold"/);
  assert.match(F.planImport(s, "date;account;value;kind\n31.01.2026;X;1;cash\n28.02.2026;X;1;debt\n").errors[0].message, /X is cash on an earlier line/);
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

test("forecast: what the portfolio pays follows the expenses and income of each month", () => {
  // Retirement in January 2057. A bridge expense from retirement until
  // 67 and a salary until retirement: for Retire early, both follow its
  // own retirement, the month after FI.
  const s = store({
    settings: { ...F.DEFAULT_SETTINGS, birthYear: 1990, bufferPercent: 0 },
    expenses: [
      { id: "r", name: "Rent", category: "", amount: 1000 * EUR, everyMonths: 1, from: null, until: null, active: true, essential: false },
      { id: "h", name: "Health", category: "", amount: 500 * EUR, everyMonths: 1, from: { at: "retirement" }, until: { age: 67 }, active: true, essential: false },
    ],
    income: [{ id: "p", name: "Pension", category: "", amount: 800 * EUR, everyMonths: 1, from: { age: 67 }, until: null }],
  });
  const params = plan({
    value: 600000 * EUR,
    growth: 0,
    contribution: 0,
    need: (index, retirement) => F.needIn(s, index, retirement),
    goal: (index) => F.fiNumberIn(s, index),
  });
  const f = F.forecast(params);
  const at = (month) => F.monthIndex(month) - F.monthIndex("2026-10");
  // Retiring now needs 1,500 a month: the FI number is 450,000.
  assert.equal(f.goal[0], 1500 * 12 * 25 * EUR);
  assert.equal(f.goal[at("2057-01")], 200 * 12 * 25 * EUR, "from 67 the pension pays most of the rent");
  const fi = f.plans.fi;
  assert.equal(fi.fiMonth, "2026-10");
  // 1,500 a month from November 2026 until December 2056, then 200.
  assert.equal(fi.values[1], 600000 * EUR - 1500 * EUR);
  assert.equal(fi.values[at("2056-12")] - fi.values[at("2057-01")], 200 * EUR);
  // Keep investing retires in 2057: it never pays the health insurance.
  const keep = f.plans.keep;
  assert.equal(keep.values[at("2056-12")], 600000 * EUR);
  assert.equal(keep.values[at("2056-12")] - keep.values[at("2057-01")], 200 * EUR);
  // Without need and goal, the expenses and FI number of today, every month.
  const plain = F.forecast(plan({ growth: 0, contribution: 0 }));
  assert.equal(plain.goal.at(-1), 600000 * EUR);
});

test("forecast: Retire early needs the FI number of the month it retires in", () => {
  // 300,000 in November covers 1,000 a month; from December another 1,000
  // starts, so retiring then needs 600,000.
  const s = store({
    settings: { ...F.DEFAULT_SETTINGS, birthYear: 1990, bufferPercent: 0, inflation: 0 },
    expenses: [
      { id: "r", name: "Rent", category: "", amount: 1000 * EUR, everyMonths: 1, from: null, until: null, active: true, essential: false },
      { id: "c", name: "Care", category: "", amount: 1000 * EUR, everyMonths: 1, from: { month: "2026-12" }, until: null, active: true, essential: false },
    ],
  });
  const f = F.forecast(plan({
    start: "2026-11",
    value: 300000 * EUR,
    growth: 0,
    contribution: 1000 * EUR,
    need: (index, retirement) => F.needIn(s, index, retirement),
    goal: (index) => F.fiNumberIn(s, index),
  }));
  // 300 months of 1,000 more: November 2051.
  assert.equal(f.plans.fi.fiMonth, "2051-11");
});

test("forecast: planned one-offs go into every plan, and Coast FI counts on them", () => {
  const at = (month) => F.monthIndex(month) - F.monthIndex("2026-10");
  const inheritance = F.monthIndex("2040-01");
  const deposit = F.monthIndex("2028-01");
  const oneOffs = (index) => (index === inheritance ? 300000 * EUR : index === deposit ? -20000 * EUR : 0);
  const base = plan({ growth: 0, contribution: 0, value: 50000 * EUR });
  const f = F.forecast({ ...base, oneOffs });
  for (const name of F.PLANS) {
    const values = f.plans[name].values;
    assert.equal(values[at("2028-01")] - values[at("2027-12")], -20000 * EUR, name);
  }
  assert.equal(f.plans.keep.values[at("2040-01")], 330000 * EUR);
  // Without growth, from 300,000 and 1,000 a month: Coast FI when nothing
  // more is needed to reach 600,000. With the inheritance to come and the
  // deposit to pay, 20,000 more are enough: after 20 months.
  const coast = F.forecast({ ...plan({ growth: 0, value: 300000 * EUR }), oneOffs }).plans.coast;
  const without = F.forecast(plan({ growth: 0, value: 300000 * EUR })).plans.coast;
  assert.equal(coast.coastMonth, "2028-06");
  assert.equal(without.coastMonth, "2051-10");
  // A one-off bigger than the portfolio leaves nothing, not a debt.
  const broke = F.forecast({ ...base, oneOffs: (index) => (index === deposit ? -100000 * EUR : 0) });
  assert.equal(broke.plans.keep.values[at("2028-01")], 0);
  assert.equal(broke.plans.keep.runsOut, "2057-01", "it runs out when it pays expenses from nothing");
});

test("today's money: every amount with the inflation since the start taken out", () => {
  close(F.deflated(F.inflated(1000, 3, 120), 3, 120), 1000, "inflated and back");
  close(F.deflated(1030, 3, 12), 1000, "a year at 3 %");
  // With growth equal to the inflation, the portfolio stays the same in
  // today's money, and so does the FI number.
  const nominal = F.forecast(plan({ growth: 3, inflation: 3, contribution: 0 }));
  const real = F.forecastInTodaysMoney(nominal, 3);
  for (const index of [0, 12, 360]) {
    close(real.plans.keep.values[index], 50000 * EUR, `value after ${index} months`);
    close(real.goal[index], 600000 * EUR, `FI number after ${index} months`);
  }
  close(real.fiAtRetirement, 600000 * EUR, "the FI number when retirement starts");
  close(real.plans.keep.atRetirement, 50000 * EUR, "the value when retirement starts");
  assert.equal(real.plans.keep.runsOut, nominal.plans.keep.runsOut, "milestones stay");
  assert.equal(nominal.plans.keep.values[12] > 50000 * EUR, true, "the original is untouched");

  const p = F.fiProjection({ month: "2026-10", start: 1000, payIn: 0, goal: 2000, rate: 3, inflation: 3 });
  const today = F.projectionInTodaysMoney(p, 3);
  close(today.points[11].mid, 1000, "the mid line, a year on");
  close(today.points[11].goal, 2000, "the goal, a year on");
  assert.equal(F.projectionInTodaysMoney(null, 3), null);
});

test("forecast: the growth rates are the expected return and 2 points less and more", () => {
  assert.deepEqual(F.growthRates(5), { low: 3, mid: 5, high: 7 });
  assert.deepEqual(F.growthRates(1.5), { low: -0.5, mid: 1.5, high: 3.5 });
  // Below 0 too: the portfolio then shrinks, and never coasts to the FI number.
  const f = F.forecast(plan({ growth: -0.5, contribution: 0 }));
  assert.ok(f.plans.keep.values[12] < 50000 * EUR);
  assert.equal(f.plans.coast.coastMonth, null);
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
  for (const p of F.PLANS) {
    const { values, coastMonth, fiMonth, atRetirement } = f.plans[p];
    assert.deepEqual([coastMonth, fiMonth, atRetirement], [null, null, null]);
    close(values[1], 50000 * EUR * (1 + r) - 2000 * EUR, p);
  }
  // At least ten years are shown, also past 95.
  assert.equal(F.forecast(plan({ birthYear: 1925 })).months.at(-1), "2036-10");
});

test("forecast: with inflation, expenses and the FI number rise and pay-ins stay", () => {
  const r = monthly(8);
  const f = F.forecast(plan({ growth: 8, inflation: 3 }));
  const rise = (months) => 1.03 ** (months / 12);
  close(f.goal[0], 600000 * EUR, "today");
  close(f.goal[12], 600000 * EUR * 1.03, "a year on");
  assert.equal(f.goal.length, f.months.length);
  // The FI number at the end of December 2056, 362 months on.
  close(f.fiAtRetirement, 600000 * EUR * rise(362), "when retirement starts");

  const keep = f.plans.keep;
  close(keep.values[1], 50000 * EUR * (1 + r) + 1000 * EUR, "the same pay-in after a month");
  close(keep.values[13] - keep.values[12] * (1 + r), 1000 * EUR, "and after a year");
  const at = F.monthIndex("2057-01") - F.monthIndex("2026-10");
  close(keep.values[at], keep.atRetirement * (1 + r) - 2000 * EUR * rise(at), "expenses of that month");
  const i = F.monthIndex(keep.fiMonth) - F.monthIndex("2026-10");
  assert.ok(keep.values[i] >= f.goal[i] && keep.values[i - 1] < f.goal[i - 1], "FI is the FI number of that month");

  // Coast FI: enough to reach the FI number when retirement starts.
  const coast = f.plans.coast;
  assert.ok(coast.atRetirement >= f.fiAtRetirement && coast.atRetirement < f.fiAtRetirement * 1.01);
  const j = F.monthIndex(coast.coastMonth) - F.monthIndex("2026-10");
  assert.ok(coast.values[j] * (1 + r) ** (362 - j) >= f.fiAtRetirement, "grows to the FI number of then");
  assert.ok(coast.values[j - 1] * (1 + r) ** (363 - j) < f.fiAtRetirement, "not a month earlier");

  // Retire at FI takes out the expenses of each month.
  const fi = f.plans.fi;
  const k = F.monthIndex(fi.fiMonth) - F.monthIndex("2026-10");
  close(fi.values[k + 1], fi.values[k] * (1 + r) - 2000 * EUR * rise(k + 1), "after FI");

  assert.equal(F.forecast(plan({ birthYear: 1950, inflation: 3 })).fiAtRetirement, null, "retired already");
});

test("forecast: with nothing paid in, inflation moves no milestone", () => {
  // 8 % before 3 % inflation is about 4.85 % after: the same months as
  // growing at that against today's expenses, with every value that many
  // times more in the money of its month.
  const real = (1.08 / 1.03 - 1) * 100;
  const shared = { value: 300000 * EUR, contribution: 0, birthYear: 1980 };
  const nominal = F.forecast(plan({ ...shared, growth: 8, inflation: 3 }));
  const today = F.forecast(plan({ ...shared, growth: real }));
  for (const p of F.PLANS) {
    const a = nominal.plans[p];
    const b = today.plans[p];
    assert.deepEqual([a.coastMonth, a.fiMonth, a.runsOut], [b.coastMonth, b.fiMonth, b.runsOut], p);
    close(a.values[120], b.values[120] * 1.03 ** 10, `${p} after ten years`);
  }
  assert.ok(nominal.plans.fi.fiMonth !== null && nominal.plans.coast.coastMonth !== null);
});
