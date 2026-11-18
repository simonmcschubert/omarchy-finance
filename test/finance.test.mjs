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

// A store for fiOutlook with an FI number of `goal` for good (one expense,
// no buffer, 4 %) and a portfolio of `value` in October 2026, after
// `payIn` a month for a year; `rate` is the expected return.
function outlookStore({ value = 0, payIn = 0, goal = 0, rate = 0, inflation = 0, settings = {}, events = [], changes = [] } = {}) {
  return store({
    settings: { ...F.DEFAULT_SETTINGS, bufferPercent: 0, withdrawalRate: 4, expectedReturn: rate, inflation, ...settings },
    expenses: goal ? [{ id: "e", name: "E", category: "", amount: goal / 300, everyMonths: 1, active: true, essential: false }] : [],
    accounts: [{ id: "a", name: "A" }],
    records: Array.from({ length: 12 }, (_, k) => ({ month: F.addMonths("2025-11", k), account: "a", value, payIn })),
    events,
    payInChanges: changes,
  });
}
// Its outlook in November 2026.
const outlook = (parts) => F.fiOutlook(outlookStore(parts), "2026-11");

// The months until `start`, with `payIn` a month at `rate` % a year,
// reaches `goal`, which rises by `inflation` % a year; null after
// MAX_PROJECTION_MONTHS. Worked out by hand, to check the outlook with.
function monthsTo(start, payIn, rate, goal, inflation = 0) {
  let value = start;
  for (let n = 0; n <= F.MAX_PROJECTION_MONTHS; n++) {
    if (n > 0) value = Math.max(0, value * (1 + monthly(rate)) + payIn);
    if (value >= F.inflated(goal, inflation, n)) return n;
  }
  return null;
}

// The same, with paid(n) paid in the nth month after `start`.
function monthsWith(start, paid, rate, goal, inflation = 0) {
  let value = start;
  for (let n = 0; n <= F.MAX_PROJECTION_MONTHS; n++) {
    if (n > 0) value = Math.max(0, value * (1 + monthly(rate)) + paid(n));
    if (value >= F.inflated(goal, inflation, n)) return n;
  }
  return null;
}

// Settings as versions 7 to 11 had them: without the emergency fund and
// the future pay-in; as version 12 had them, without the future pay-in;
// as version 13 had them, without the choice to raise pay-ins; and as
// version 14 had them, without the coast pay-in.
const SETTINGS_V14 = (({ coastPayIn, ...rest }) => rest)(F.DEFAULT_SETTINGS);
const SETTINGS_V13 = (({ payInsRiseWithInflation, ...rest }) => rest)(SETTINGS_V14);
const SETTINGS_V12 = (({ futurePayIn, ...rest }) => rest)(SETTINGS_V13);
const SETTINGS_V11 = (({ emergencyMonths, ...rest }) => rest)(SETTINGS_V12);
// An empty store as versions 10 to 13 had it: without planned pay-in changes.
const EMPTY_V13 = (({ payInChanges, ...rest }) => rest)(F.emptyStore());

// An upgraded store without what versions after 7 added, to compare with
// the file it came from.
function withoutLater({ events, payInChanges, ...s }) {
  const plain = ({ from, until, ...item }) => item;
  return {
    ...s,
    settings: (({ emergencyMonths, futurePayIn, payInsRiseWithInflation, coastPayIn, ...rest }) => rest)(s.settings),
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

test("parseMoney errors leave out the typed amount, which hide amounts would show", () => {
  for (const text of ["1.234,567", "12.34.567", "98765abc", "123456789012345678"]) {
    const { ok, error } = F.parseMoney(text);
    assert.equal(ok, false, text);
    assert.doesNotMatch(error, /[0-9]/, `${text}: ${error}`);
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

test("parseMonth reads the month's number, then a four-digit year; or year first with a separator", () => {
  const cases = {
    "12027": "2027-01", // typed 1 2 0 2 7
    "122027": "2027-12",
    "012027": "2027-01",
    "1 2027": "2027-01",
    "01/2027": "2027-01",
    "1.2027": "2027-01",
    "1-2027": "2027-01",
    " 11 / 2026 ": "2026-11",
    "2027-01": "2027-01",
    "2027-1": "2027-01",
    "2027.12": "2027-12",
    "12 1899": "1899-12", // any four-digit year, as stored months have
    "1 2201": "2201-01",
  };
  for (const [text, month] of Object.entries(cases)) assert.equal(F.parseMonth(text), month, text);
  const wrong = [
    "", "2027", "1", "12", "1202", // no year yet
    "0 2027", "13 2027", "132027", "002027", "2027-13", "2027-0", // no such month
    "1 27", "1/27", "1 20270", "202701", // a year of four digits, after the month without a separator
    "Jan 2027", "1/2027/1", "1 2027 x", "1,2027",
  ];
  for (const text of wrong) assert.equal(F.parseMonth(text), null, text);
  for (const month of ["2027-01", "2026-11", "1990-12"]) assert.equal(F.parseMonth(F.monthToText(month)), month, month);
  assert.equal(F.monthToText("2027-01"), "01/2027");
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
    settings: { ...F.DEFAULT_SETTINGS, bufferPercent: 10 },
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

  const again = F.saveItem(s, "expenses", { ...gym, active: true }).store;
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
  assert.deepEqual(F.metrics(s).payIn, { amount: 675, months: 2, change: null }, "the pay-in average still counts only pay-ins");
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
    settings: { ...F.DEFAULT_SETTINGS, bufferPercent: 0 },
  });
  const m = F.metrics(s);
  assert.deepEqual(m.payIn, { amount: 550 * EUR, months: 12, change: null });
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
  assert.deepEqual(F.metrics(s).payIn, { amount: 300, months: 3, change: null });
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
  assert.deepEqual(F.gains(series), { gain: 200, months: 2, paid: 100, rate: 200 / 1025 });
  assert.deepEqual(F.gains(series, 1), { gain: 100, months: 1, paid: 100, rate: 100 / 1150 });
  assert.equal(F.gains(series.slice(0, 1)), null);
  assert.deepEqual(F.gains([{ value: 0, payIn: 0 }, { value: 0, payIn: 0 }]), { gain: 0, months: 1, paid: 0, rate: null });
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
  assert.equal(m.gains.paid, 6000 * EUR);
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

test("FI outlook: the Path to FI chart at the expected return and 2 points less and more", () => {
  // At 0 % a year, 100 a month reaches 1,200 after 12 months.
  const flat = outlook({ value: 0, payIn: 100, goal: 1200 }).path();
  assert.deepEqual(flat.rates, { low: -2, mid: 0, high: 2 });
  assert.equal(flat.reach.mid, "2027-10");
  assert.equal(flat.reach.high, "2027-10", "in the 12th month at 2 % too, a bit above 1,200");
  assert.equal(flat.reach.low, "2027-11");
  assert.deepEqual(flat.points[0], { month: "2026-11", low: 100, mid: 100, high: flat.points[0].high, goal: 1200 });

  const start = 50000 * EUR;
  const payIn = 1250 * EUR;
  const goal = 675000 * EUR;
  const p = outlook({ value: start, payIn, goal, rate: 5 }).path();
  const months = monthsTo(start, payIn, 5, goal);
  assert.equal(p.reach.mid, F.addMonths("2026-10", months));
  assert.ok(months > 20 * 12 && months < 22 * 12, `${months} months`);
  assert.equal(p.reach.high, F.addMonths("2026-10", monthsTo(start, payIn, 7, goal)));
  assert.equal(p.reach.low, F.addMonths("2026-10", monthsTo(start, payIn, 3, goal)));
  const shown = F.monthIndex(p.reach.low) - F.monthIndex("2026-10");
  assert.equal(p.points.length, Math.ceil(shown * 1.1), "until a little after the low projection gets there");
  assert.equal(p.points.at(-1).month, F.addMonths("2026-10", p.points.length));
  for (const point of p.points) assert.ok(point.low <= point.mid && point.mid <= point.high);
});

test("FI outlook: the FI number rises by the inflation", () => {
  const start = 50000 * EUR;
  const payIn = 1250 * EUR;
  const goal = 675000 * EUR;
  const p = outlook({ value: start, payIn, goal, rate: 8, inflation: 3 }).path();
  assert.deepEqual(p.rates, { low: 6, mid: 8, high: 10 });
  close(p.points[11].goal, goal * 1.03, "a year on");
  for (const k of ["low", "mid", "high"]) {
    assert.equal(p.reach[k], F.addMonths("2026-10", monthsTo(start, payIn, p.rates[k], goal, 3)), k);
  }
  const n = F.monthIndex(p.reach.mid) - F.monthIndex("2026-10");
  assert.ok(p.points[n - 1].mid >= p.points[n - 1].goal && p.points[n - 2].mid < p.points[n - 2].goal);
  // Later than without inflation, with the same pay-ins.
  assert.ok(p.reach.mid > outlook({ value: start, payIn, goal, rate: 8 }).path().reach.mid);
  // With nothing paid in, it comes in the same month as today's FI number
  // at the return after inflation.
  const real = (1.08 / 1.03 - 1) * 100;
  const months = monthsTo(100000 * EUR, 0, 8, 675000 * EUR, 3);
  assert.equal(months, monthsTo(100000 * EUR, 0, real, 675000 * EUR));
  assert.equal(outlook({ value: 100000 * EUR, goal: 675000 * EUR, rate: 8, inflation: 3 }).milestones().fi.months, months);
});

test("FI outlook: no goal, at the goal already, out of reach, close by", () => {
  assert.equal(outlook({ value: 100, payIn: 10, rate: 5 }).path(), null, "no expenses, no FI number");

  const there = outlook({ value: 1200, payIn: 10, goal: 1200, rate: 5 }).path();
  assert.deepEqual(there.reach, { low: "2026-10", mid: "2026-10", high: "2026-10" });
  assert.deepEqual(there.points, []);

  const never = outlook({ value: 100, payIn: 0, goal: 999999900, rate: 1 }).path();
  assert.deepEqual(never.reach, { low: null, mid: null, high: null });
  assert.equal(never.points.length, F.MAX_PROJECTION_MONTHS);

  // Only the high return gets there: 1.02^35 is 2.0, so in 35 years; the
  // mid one at 0 % never does. The chart runs to 1.5 times that, and a bit.
  const high = outlook({ value: 1200, payIn: 0, goal: 2400, rate: 0 }).path();
  assert.equal(high.reach.mid, null);
  assert.equal(high.reach.high, "2061-11");
  assert.equal(high.points.length, Math.ceil(421 * 1.5 * 1.1));

  // A month away: the chart still shows a year.
  const soon = outlook({ value: 1190, payIn: 10, goal: 1200, rate: 5 }).path();
  assert.equal(soon.reach.mid, "2026-11");
  assert.equal(soon.points.length, 12);
});

test("FI outlook: a withdrawal on average counts as nothing paid in", () => {
  const o = outlook({ value: 1000 * EUR, payIn: -500 * EUR, goal: 5000 * EUR, rate: 5 });
  assert.deepEqual(o.payIn, { amount: -500 * EUR, months: 12, change: null, invested: 0, withdrawal: true, changes: [], rises: false });
  const zero = outlook({ value: 1000 * EUR, payIn: 0, goal: 5000 * EUR, rate: 5 });
  assert.deepEqual(o.path(), zero.path(), "the chart");
  assert.deepEqual(o.milestones(), zero.milestones(), "the milestones");
  assert.deepEqual(o.forecast(), zero.forecast(), "the Forecast");
  assert.equal(outlook({ payIn: 1234.4 }).payIn.invested, 1234, "in whole cents");
  assert.deepEqual(F.fiOutlook(store(), "2026-11").payIn, { amount: null, months: null, change: null, invested: 0, withdrawal: false, changes: [], rises: false });
  // An own future pay-in is never a withdrawal.
  const own = F.fiOutlook(F.saveSettings(outlookStore({ value: 1000 * EUR, payIn: -500 * EUR, goal: 5000 * EUR }), { futurePayIn: 200 * EUR }), "2026-11");
  assert.deepEqual(own.payIn, { amount: 200 * EUR, months: null, change: null, invested: 200 * EUR, withdrawal: false, changes: [], rises: false });
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
  s = F.saveItem(s, "expenses", { id: "e", name: "Rent", category: "Housing", amount: 100, everyMonths: 1, from: null, until: null, active: true, essential: true }).store;
  s = F.saveItem(s, "income", { id: "i", name: "Salary", category: "Work", amount: 100, everyMonths: 1, from: null, until: { at: "retirement" } }).store;
  s = F.saveAccount(s, null, "Broker").store;
  s = F.saveMonth(s, "2026-10", [{ account: s.accounts[0].id, value: 5, payIn: -2 }]);
  s = F.savePayInChange(s, { id: null, from: { month: "2027-04" }, amount: 190000 }).store;
  s = F.savePayInChange(s, { id: null, from: { age: 45 }, amount: null }).store;
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
    [{ ...roundTrip, settings: (({ futurePayIn, ...rest }) => rest)(roundTrip.settings) }, /missing "futurePayIn"/],
    [{ ...roundTrip, settings: { ...roundTrip.settings, futurePayIn: -100 } }, /futurePayIn must be null or a number of cents, not negative/],
    [{ ...roundTrip, settings: { ...roundTrip.settings, futurePayIn: 12.5 } }, /futurePayIn/],
    [{ ...roundTrip, settings: { ...roundTrip.settings, futurePayIn: "1000" } }, /futurePayIn/],
    [{ ...roundTrip, settings: (({ payInsRiseWithInflation, ...rest }) => rest)(roundTrip.settings) }, /missing "payInsRiseWithInflation"/],
    [{ ...roundTrip, settings: { ...roundTrip.settings, payInsRiseWithInflation: "yes" } }, /payInsRiseWithInflation must be true or false/],
    [{ ...roundTrip, settings: (({ coastPayIn, ...rest }) => rest)(roundTrip.settings) }, /missing "coastPayIn"/],
    [{ ...roundTrip, settings: { ...roundTrip.settings, coastPayIn: -100 } }, /coastPayIn must be a number of cents, not negative/],
    [{ ...roundTrip, settings: { ...roundTrip.settings, coastPayIn: null } }, /coastPayIn/],
    [{ ...roundTrip, settings: { ...roundTrip.settings, coastPayIn: 12.5 } }, /coastPayIn/],
    [(({ payInChanges, ...rest }) => rest)(roundTrip), /missing "payInChanges"/],
    [{ ...roundTrip, payInChanges: {} }, /payInChanges is not a list/],
    [{ ...roundTrip, payInChanges: [{ id: "c", from: { at: "retirement" }, amount: 100 }] }, /payInChanges\[0\] from must be a month or an age/],
    [{ ...roundTrip, payInChanges: [{ id: "c", from: null, amount: 100 }] }, /from must be a month or an age/],
    [{ ...roundTrip, payInChanges: [{ id: "c", from: { month: "2027-13" }, amount: 100 }] }, /from must be a month or an age/],
    [{ ...roundTrip, payInChanges: [{ id: "c", from: { month: "2027-04" }, amount: -1 }] }, /amount must be null \(the average\) or a number of cents, not negative/],
    [{ ...roundTrip, payInChanges: [{ id: "c", from: { month: "2027-04" }, amount: 1.5 }] }, /amount must be null/],
    [{ ...roundTrip, payInChanges: [{ id: "c", from: { month: "2027-04" }, amount: 1 }, { id: "d", from: { month: "2027-04" }, amount: 2 }] }, /payInChanges\[1\] starts when another change does/],
    [{ ...roundTrip, payInChanges: [{ id: "c", from: { month: "2027-04" }, amount: 1 }, { id: "c", from: { age: 40 }, amount: 2 }] }, /repeated id/],
    [{ ...roundTrip, payInChanges: [{ id: "c", from: { month: "2027-04" }, amount: 1, name: "Raise" }] }, /unknown field "name"/],
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
  assert.equal(errors[2].message, "Value: Not an amount");
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
  assert.deepEqual(s.settings, { withdrawalRate: 3.5, bufferPercent: 5, currency: "EUR", numberFormat: "1.000.000,00", expectedReturn: 8, inflation: 3, birthYear: null, retirementAge: 67, emergencyMonths: 6, futurePayIn: null, payInsRiseWithInflation: false, coastPayIn: 0 });
  assert.deepEqual(s.categories, { expenses: ["Car", "Housing"], income: ["Work"] });
  assert.deepEqual(s.expenses.map((e) => e.category), ["Housing", "Housing", "", "Car"]);
  assert.deepEqual(s.expenses.map((e) => e.active), [true, true, true, true], "every expense was active");
  assert.equal("active" in s.income[0], false);
  assert.deepEqual(s.records, v1.records.map((r) => ({ ...r, oneOff: 0 })));
  assert.deepEqual(Object.keys(s), ["version", "settings", "categories", "expenses", "income", "accounts", "records", "events", "payInChanges"]);
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
  assert.deepEqual(s.settings, { ...v2.settings, numberFormat: "1.000.000,00", expectedReturn: 8, inflation: 3, birthYear: null, retirementAge: 67, emergencyMonths: 6, futurePayIn: null, payInsRiseWithInflation: false, coastPayIn: 0 });
  assert.deepEqual(s.expenses, v2.expenses.map((e) => ({ ...e, active: true, essential: false, from: null, until: null })));
  assert.deepEqual(s.income, v2.income.map((i) => ({ ...i, from: null, until: { at: "retirement" } })));
  assert.deepEqual(Object.keys(s), ["version", "settings", "categories", "expenses", "income", "accounts", "records", "events", "payInChanges"]);
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
  assert.deepEqual(s.settings, { withdrawalRate: 3.5, bufferPercent: 5, currency: "USD", numberFormat: "1.000.000,00", expectedReturn: 8, inflation: 3, birthYear: null, retirementAge: 67, emergencyMonths: 6, futurePayIn: null, payInsRiseWithInflation: false, coastPayIn: 0 });
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
  assert.deepEqual(s.settings, { ...v4.settings, expectedReturn: 8, inflation: 3, birthYear: null, retirementAge: 67, emergencyMonths: 6, futurePayIn: null, payInsRiseWithInflation: false, coastPayIn: 0 });
  assert.deepEqual({ ...withoutLater(s), version: 4, settings: v4.settings }, v4, "nothing else changes");
  assert.equal("expectedReturn" in v4.settings, false, "the parsed value is left alone");

  assert.match(F.parseStore({ ...v4, extra: 1 }).error, /unknown field "extra"/);
  assert.match(F.parseStore({ ...v4, settings: { ...v4.settings, expectedReturn: 5 } }).error, /unknown field "expectedReturn"/);
});

test("FI outlook: time to FI from the latest month with the average pay-in", () => {
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
  const o = F.fiOutlook(s, "2026-11");
  assert.equal(o.fiNumber, 30000 * EUR);
  assert.equal(o.start, "2026-10");
  assert.deepEqual(o.milestones().fi, { fiNumber: 30000 * EUR, progress: 28 / 30, month: "2026-12", months: 2 });
  assert.deepEqual(o.path().points.slice(0, 2).map((p) => [p.month, p.mid]), [["2026-11", 29000 * EUR], ["2026-12", 30000 * EUR]]);

  const grown = F.fiOutlook(F.saveSettings(s, { expectedReturn: 5 }), "2026-11");
  assert.equal(grown.milestones().fi.months, 2, "the return makes it no later");
  assert.ok(grown.path().points[0].mid > 29000 * EUR);

  // At 12 % inflation the FI number is 30,000 × 1.12^(1/6) ≈ 30,573 two
  // months on, so it takes a third month.
  const pricier = F.fiOutlook(F.saveSettings(s, { inflation: 12 }), "2026-11");
  assert.equal(pricier.fiNumber, 30000 * EUR, "today's FI number stays");
  assert.equal(pricier.milestones().fi.months, 3);

  const reached = F.fiOutlook(F.saveMonth(s, "2026-11", [{ account: "a", value: 30000 * EUR, payIn: 0 }]), "2026-11");
  assert.equal(reached.milestones().fi.months, 0);
  assert.equal(reached.path().reach.mid, "2026-11");
  assert.deepEqual(reached.path().points, []);

  const never = F.fiOutlook(F.saveMonth(s, "2026-11", [{ account: "a", value: 28000 * EUR, payIn: -2000 * EUR }]), "2026-11");
  assert.equal(never.payIn.invested, 0, "the average pay-in is 0");
  assert.equal(never.milestones().fi.month, null, "not within 100 years");
  assert.equal(never.milestones().fi.months, null);

  const none = F.fiOutlook(store(), "2026-11").milestones();
  assert.deepEqual(none.fi, { fiNumber: 0, progress: null, month: null, months: null });
  assert.equal(none.coast, null);
  assert.equal(none.lean, null);
});

test("FI outlook: FI counts at a month's end against the FI number of retiring the month after", () => {
  // A Kita until February 2030 is a bridge: the FI number for retiring in
  // a month before is 30,000 for the rent for good, plus 100 for each
  // month of Kita left. 900 a month without growth, from nothing.
  const item = (name, until) => ({ id: name, name, category: "", amount: 100 * EUR, everyMonths: 1, from: null, until, active: true, essential: false });
  const s = store({
    settings: { ...F.DEFAULT_SETTINGS, bufferPercent: 0, expectedReturn: 0, inflation: 0 },
    expenses: [item("Rent", null), item("Kita", { month: "2030-02" })],
    accounts: [{ id: "a", name: "A" }],
    records: [{ month: "2026-10", account: "a", value: 0, payIn: 900 * EUR }],
  });
  const first = F.monthIndex("2026-10");
  // At the end of August 2029, 34 months on, the portfolio has 30,600:
  // the FI number for retiring in September, though not yet August's.
  assert.equal(F.fiNumberIn(s, first + 35), 30600 * EUR);
  assert.equal(F.fiNumberIn(s, first + 34), 30700 * EUR);
  const o = F.fiOutlook(s, "2026-11");
  assert.equal(o.milestones().fi.month, "2029-08");
  assert.equal(o.path().reach.mid, "2029-08");
  assert.equal(o.forecast().plans.fi.fiMonth, "2029-08");
  // The chart's FI number is what FI needs at each month's end, so the line
  // reaches it in August 2029 too.
  const points = o.path().points;
  for (const k of [0, 12, 33, 34, points.length - 1]) assert.equal(points[k].goal, F.fiNumberIn(s, first + k + 2), `month ${k + 1}`);
  assert.equal(points[33].month, "2029-08");
  assert.ok(points[33].mid >= points[33].goal && points[32].mid < points[32].goal);
});

test("FI outlook: FI only counts before retirement", () => {
  // 1,000 a month without growth to 300,000 takes 300 months: October 2051.
  const parts = { value: 0, payIn: 1000 * EUR, goal: 300000 * EUR };
  const unborn = outlook(parts);
  assert.equal(unborn.retirement, null);
  assert.equal(unborn.milestones().fi.month, "2051-10");
  assert.equal(unborn.milestones().coast, null, "Coast FI needs a year of birth");

  // Born in 1980, retiring at 67 in January 2047: not before then, as the
  // Forecast says, and the chart stops there.
  const born = outlook({ ...parts, settings: { birthYear: 1980 } });
  assert.equal(born.retirement, "2047-01");
  assert.deepEqual([born.milestones().fi.month, born.milestones().fi.months], [null, null]);
  assert.equal(born.forecast().plans.fi.fiMonth, null);
  assert.equal(born.path().reach.mid, null);
  assert.equal(born.path().points.at(-1).month, "2046-12");
  assert.equal(born.milestones().coast.month, null, "no Coast FI either");

  // Retired already: FI now, if the portfolio is there.
  const retired = outlook({ value: 400000 * EUR, goal: 300000 * EUR, settings: { birthYear: 1950 } });
  assert.equal(retired.retired, true);
  assert.equal(retired.milestones().fi.months, 0);
  assert.equal(retired.milestones().coast, null);
  assert.equal(outlook({ value: 200000 * EUR, goal: 300000 * EUR, settings: { birthYear: 1950 } }).milestones().fi.months, null);
});

test("FI outlook: the milestones, the chart and the Forecast agree", () => {
  // Retirement in 2057; health insurance from retirement until 67, a Kita
  // until 2031, a pension from 67, an inheritance and a house deposit.
  const item = (name, amount, from, until, extra = {}) => ({ id: name, name, category: "", amount: amount * EUR, everyMonths: 1, from, until, ...extra });
  const s = (payIn) => store({
    settings: { ...F.DEFAULT_SETTINGS, birthYear: 1990, expectedReturn: 7, inflation: 2.5 },
    expenses: [
      item("Rent", 1200, null, null, { active: true, essential: true }),
      item("Kita", 400, null, { month: "2031-07" }, { active: true, essential: false }),
      item("Health insurance", 300, { at: "retirement" }, { age: 67 }, { active: true, essential: true }),
      item("Travel", 300, null, null, { active: true, essential: false }),
    ],
    income: [item("Salary", 4000, null, { at: "retirement" }), item("State pension", 1100, { age: 67 }, null)],
    accounts: [{ id: "a", name: "A" }],
    records: [
      { month: "2026-09", account: "a", value: 80000 * EUR, payIn },
      { month: "2026-10", account: "a", value: 82000 * EUR, payIn },
    ],
    events: [{ id: "i", name: "Inheritance", month: "2034-03", amount: 50000 * EUR }, { id: "d", name: "Deposit", month: "2029-05", amount: -30000 * EUR }],
  });
  for (const payIn of [1500 * EUR, -800 * EUR]) {
    const o = F.fiOutlook(s(payIn), "2026-11");
    const { coast, lean, fi } = o.milestones();
    const plans = o.forecast().plans;
    assert.ok(fi.month && lean.month && coast.month, `all reached, paying in ${payIn}`);
    assert.equal(fi.month, plans.fi.fiMonth, "FI: the milestone and Retire early");
    assert.equal(o.path().reach.mid, fi.month, "FI: the milestone and the chart");
    assert.equal(coast.month, plans.coast.coastMonth, "Coast FI: the milestone and the Coast plan");
    close(coast.fiNumber, o.forecast().coastNumber, "the Coast FI number");
    assert.ok(coast.month <= lean.month && lean.month <= fi.month, "in that order");
  }
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
  assert.deepEqual(s.settings, { ...v5.settings, expectedReturn: 9, inflation: 3, birthYear: null, retirementAge: 67, emergencyMonths: 6, futurePayIn: null, payInsRiseWithInflation: false, coastPayIn: 0 });
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
  assert.deepEqual(s.settings, { ...v6.settings, expectedReturn: 7.25, inflation: 3, emergencyMonths: 6, futurePayIn: null, payInsRiseWithInflation: false, coastPayIn: 0 });
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
  assert.equal(F.fiOutlook(result.store).milestones().lean, null);
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
    settings: { ...v8.settings, emergencyMonths: 6, futurePayIn: null, payInsRiseWithInflation: false, coastPayIn: 0 },
    expenses: [{ ...v8.expenses[0], from: null, until: null }],
    income: [{ ...v8.income[0], from: null, until: { at: "retirement" } }],
    accounts: [],
    events: [],
    payInChanges: [],
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
  assert.equal(F.gains(series).paid, 51000);
  const m = F.metrics({ ...s, settings: { ...F.DEFAULT_SETTINGS } });
  assert.equal(m.investmentRate, null);
  assert.equal(m.payIn.amount, 1000 / 3);
});

test("expenses and income: saved and checked", () => {
  const s = F.emptyStore();
  const rent = { id: "e", name: "Rent", category: "Housing", amount: 1000 * EUR, everyMonths: 1, from: null, until: null, active: true, essential: true };
  const saved = F.saveItem(s, "expenses", rent);
  assert.equal(saved.ok, true);
  assert.deepEqual(saved.store.expenses, [rent]);
  assert.equal(F.parseStore(JSON.parse(JSON.stringify(saved.store))).ok, true);
  assert.deepEqual(s.expenses, [], "the original is untouched");
  const pension = { id: "i", name: "State pension", category: "", amount: 0, everyMonths: 1, from: { age: 67 }, until: null };
  assert.deepEqual(F.saveItem(s, "income", pension), { ok: false, error: "Amount must be more than 0" });
  assert.deepEqual(F.saveItem(s, "income", { ...pension, amount: 1e13 }), { ok: false, error: "Amount is too large" });
  assert.equal(F.saveItem(s, "income", { ...pension, amount: 1e13 - 1 }).ok, true);
  assert.deepEqual(F.saveItem(s, "expenses", { ...rent, everyMonths: 0 }), { ok: false, error: "Paid every must be whole months from 1 to 120" });
  assert.equal(F.saveItem(s, "expenses", { ...rent, everyMonths: 121 }).ok, false);
  assert.equal(F.saveItem(s, "expenses", { ...rent, everyMonths: 1.5 }).ok, false);
  assert.deepEqual(F.saveItem(s, "expenses", { ...rent, name: "" }), { ok: false, error: "Enter a name" });
  assert.deepEqual(F.saveItem(s, "expenses", { ...rent, category: "Gone" }), { ok: false, error: 'Category "Gone" no longer exists' });
  assert.deepEqual(F.saveItem(s, "expenses", { ...rent, from: { age: 200 } }), { ok: false, error: "Choose when it starts" });
  assert.deepEqual(F.saveItem(s, "expenses", { ...rent, from: { at: "retirement" }, until: { at: "retirement" } }),
    { ok: false, error: "It cannot start and end at retirement" });
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

  // 1,000 a month without growth to 60,000: an inheritance of 20,000 after
  // 10 months saves 20 months.
  const once = (month, amount) => [{ id: "x", name: "X", month, amount }];
  assert.equal(outlook({ payIn: 1000, goal: 60000 }).milestones().fi.months, 60);
  assert.equal(outlook({ payIn: 1000, goal: 60000, events: once("2027-08", 20000) }).milestones().fi.months, 40);
  const p = outlook({ payIn: 1000, goal: 60000, rate: 2, events: once("2026-11", 59000) }).path();
  assert.equal(p.points[0].mid, 60000);
});

test("a version 10 file is upgraded: every account is invested", () => {
  const v10 = { ...EMPTY_V13, version: 10, settings: { ...SETTINGS_V11 }, accounts: [{ id: "a", name: "A" }] };
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
  const v11 = { ...EMPTY_V13, version: 11, settings: { ...SETTINGS_V11, bufferPercent: 5 } };
  const result = F.parseStore(v11);
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(result.store, { ...v11, version: F.VERSION, settings: { ...v11.settings, emergencyMonths: 6, futurePayIn: null, payInsRiseWithInflation: false, coastPayIn: 0 }, payInChanges: [] });
  assert.match(F.parseStore({ ...v11, settings: { ...v11.settings, emergencyMonths: 3 } }).error, /unknown field "emergencyMonths"/);
});

test("a version 12 file is upgraded: projections go on with the average pay-in", () => {
  const v12 = { ...EMPTY_V13, version: 12, settings: { ...SETTINGS_V12, bufferPercent: 5 } };
  const result = F.parseStore(v12);
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(result.store, { ...v12, version: F.VERSION, settings: { ...v12.settings, futurePayIn: null, payInsRiseWithInflation: false, coastPayIn: 0 }, payInChanges: [] });
  assert.match(F.parseStore({ ...v12, settings: { ...v12.settings, futurePayIn: 100 } }).error, /unknown field "futurePayIn"/);
  const own = F.saveSettings(result.store, { futurePayIn: 150000 });
  assert.deepEqual(F.parseStore(JSON.parse(JSON.stringify(own))), { ok: true, store: own });
});

test("a version 13 file is upgraded: no planned pay-in changes, and pay-ins stay the same", () => {
  const v13 = { ...EMPTY_V13, version: 13, settings: { ...SETTINGS_V13, futurePayIn: 150000 } };
  const result = F.parseStore(v13);
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(result.store, { ...v13, version: F.VERSION, settings: { ...v13.settings, payInsRiseWithInflation: false, coastPayIn: 0 }, payInChanges: [] });
  assert.match(F.parseStore({ ...v13, settings: { ...v13.settings, payInsRiseWithInflation: true } }).error, /unknown field "payInsRiseWithInflation"/);
  assert.match(F.parseStore({ ...v13, payInChanges: [] }).error, /unknown field "payInChanges"/);
});

test("a version 14 file is upgraded: the Coast plan pays in nothing after Coast FI", () => {
  const v14 = { ...F.emptyStore(), version: 14, settings: { ...SETTINGS_V14, futurePayIn: 150000, payInsRiseWithInflation: true } };
  const result = F.parseStore(v14);
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(result.store, { ...v14, version: F.VERSION, settings: { ...v14.settings, coastPayIn: 0 } });
  assert.match(F.parseStore({ ...v14, settings: { ...v14.settings, coastPayIn: 0 } }).error, /unknown field "coastPayIn"/);
  const coast = F.saveSettings(result.store, { coastPayIn: 20000 });
  assert.deepEqual(F.parseStore(JSON.parse(JSON.stringify(coast))), { ok: true, store: coast });
});

test("the coast pay-in from Settings is what the Forecast's Coast plan pays in after Coast FI", () => {
  const parts = { value: 100000 * EUR, payIn: 1000 * EUR, goal: 600000 * EUR, rate: 6, settings: { birthYear: 1990 } };
  const none = outlook(parts);
  const some = outlook({ ...parts, settings: { birthYear: 1990, coastPayIn: 300 * EUR } });
  assert.deepEqual(none.forecast(), none.forecast({ coastContribution: 0 }), "0 by default");
  assert.deepEqual(some.forecast(), some.forecast({ coastContribution: 300 * EUR }), "the setting, unless given");
  assert.ok(some.forecast().plans.coast.coastMonth < none.forecast().plans.coast.coastMonth, "paying in after Coast FI gets there sooner");
  // The milestone stays Coast FI without another pay-in.
  assert.deepEqual(some.milestones().coast, none.milestones().coast);
});

test("planned pay-in changes: each holds from its month or age until the next", () => {
  // 1.000 a month on average; born 1990, so 40 is January 2030.
  const changes = [
    { id: "b", from: { age: 40 }, amount: 500 * EUR },
    { id: "a", from: { month: "2027-04" }, amount: 1900 * EUR },
    { id: "c", from: { month: "2032-01" }, amount: null },
  ];
  const s = outlookStore({ value: 10000 * EUR, payIn: 1000 * EUR, goal: 600000 * EUR, rate: 5, settings: { birthYear: 1990 }, changes });
  const series = F.portfolioSeries(s);
  const plan = F.payInPlan(s, series, "2026-10");
  assert.deepEqual(plan.now, { amount: 1000 * EUR, months: 12, change: null });
  assert.deepEqual(plan.changes.map((step) => [F.monthFromIndex(step.index), step.amount, step.change.id]),
    [["2027-04", 1900 * EUR, "a"], ["2030-01", 500 * EUR, "b"], ["2032-01", 1000 * EUR, "c"]], "in order, the last one the average");
  const at = (month) => plan.at(F.monthIndex(month));
  assert.deepEqual(["2026-11", "2027-03", "2027-04", "2029-12", "2030-01", "2031-12", "2032-01", "2050-01"].map(at),
    [1000, 1000, 1900, 1900, 500, 500, 1000, 1000].map((amount) => amount * EUR));

  // Every FI date invests them.
  const o = F.fiOutlook(s, "2026-11");
  assert.deepEqual(o.payIn.changes, [
    { month: "2027-04", amount: 1900 * EUR, average: false },
    { month: "2030-01", amount: 500 * EUR, average: false },
    { month: "2032-01", amount: 1000 * EUR, average: true },
  ]);
  assert.equal(o.payIn.invested, 1000 * EUR, "until the first change, the average");
  const paid = (n) => at(F.addMonths("2026-10", n));
  const { fi } = o.milestones();
  assert.equal(fi.months, monthsWith(10000 * EUR, paid, 5, 600000 * EUR));
  assert.notEqual(fi.months, monthsTo(10000 * EUR, 1000 * EUR, 5, 600000 * EUR), "the changes move FI");
  const keep = o.forecast().plans.keep.values;
  close(keep[6] - keep[5] * (1 + monthly(5)), 1900 * EUR, "April 2027 pays in the raise");
  close(keep[5] - keep[4] * (1 + monthly(5)), 1000 * EUR, "March 2027 does not yet");
  assert.equal(o.path().reach.mid, fi.month);

  // Without a year of birth an age is never reached.
  const unborn = F.payInPlan({ ...s, settings: { ...s.settings, birthYear: null } }, series, "2026-10");
  assert.deepEqual(unborn.changes.map((step) => step.change.id), ["a", "c"]);
  // The average without pay-ins yet is nothing.
  const fresh = F.payInPlan({ ...s, records: [] }, [], "2026-10");
  assert.equal(fresh.now, null);
  assert.equal(fresh.at(F.monthIndex("2032-01")), 0);
  assert.equal(fresh.at(F.monthIndex("2027-04")), 1900 * EUR);
});

test("a planned pay-in change that has started is what is paid in now", () => {
  const s = store({
    settings: { ...F.DEFAULT_SETTINGS, bufferPercent: 0, futurePayIn: 800 * EUR },
    income: [{ id: "i", name: "Salary", category: "", amount: 4000 * EUR, everyMonths: 1 }],
    accounts: [{ id: "a", name: "A" }],
    records: [{ month: "2026-10", account: "a", value: 50000 * EUR, payIn: 1000 * EUR }],
  });
  const raise = { id: "r", from: { month: "2026-11" }, amount: 1500 * EUR };
  const later = { ...s, payInChanges: [raise] };
  const m = F.metrics(later, "2026-11");
  assert.deepEqual(m.payIn, { amount: 1500 * EUR, months: null, change: raise }, "it replaces the own amount");
  assert.equal(m.investmentRate, 1500 / 4000);
  const o = F.fiOutlook(later, "2026-11");
  assert.equal(o.payIn.invested, 1500 * EUR);
  assert.equal(o.payIn.change, raise);
  assert.deepEqual(o.payIn.changes, []);

  // The latest one that has started counts; back to the average is the
  // average.
  const back = { id: "b", from: { month: "2026-06" }, amount: null };
  const earlier = { id: "e", from: { month: "2026-01" }, amount: 300 * EUR };
  const both = { ...s, payInChanges: [back, earlier] };
  assert.deepEqual(F.metrics(both, "2026-11").payIn, { amount: 1000 * EUR, months: 1, change: back });
  assert.deepEqual(F.metrics({ ...s, payInChanges: [earlier] }, "2026-11").payIn, { amount: 300 * EUR, months: null, change: earlier });

  // The dashboard counts this month's, like the income, also when the
  // latest values are older.
  const december = { id: "d", from: { month: "2026-12" }, amount: 2000 * EUR };
  const lagging = F.metrics({ ...s, payInChanges: [december] }, "2027-01");
  assert.deepEqual(lagging.payIn, { amount: 2000 * EUR, months: null, change: december });
  assert.equal(lagging.investmentRate, 2000 / 4000);
});

test("pay-ins rise with inflation only when the settings say so", () => {
  const parts = { value: 10000 * EUR, payIn: 1000 * EUR, goal: 600000 * EUR, rate: 8, inflation: 3, changes: [{ id: "a", from: { month: "2028-01" }, amount: 1500 * EUR }] };
  const flat = F.fiOutlook(outlookStore(parts), "2026-11");
  assert.equal(flat.payIn.rises, false);
  const flatPaid = (n) => (n < 15 ? 1000 * EUR : 1500 * EUR); // January 2028 is 15 months after October 2026
  assert.equal(flat.milestones().fi.months, monthsWith(10000 * EUR, flatPaid, 8, 600000 * EUR, 3));
  const flatValues = flat.forecast().plans.keep.values;
  close(flatValues[20] - flatValues[19] * (1 + monthly(8)), 1500 * EUR, "the same amount of money for good");

  const rising = F.fiOutlook(outlookStore({ ...parts, settings: { payInsRiseWithInflation: true } }), "2026-11");
  assert.equal(rising.payIn.rises, true);
  assert.equal(rising.payIn.invested, 1000 * EUR, "shown as typed, in today's money");
  const risingPaid = (n) => F.inflated(flatPaid(n), 3, n);
  assert.equal(rising.milestones().fi.months, monthsWith(10000 * EUR, risingPaid, 8, 600000 * EUR, 3));
  assert.ok(rising.milestones().fi.months < flat.milestones().fi.months, "FI comes sooner");
  const values = rising.forecast().plans.keep.values;
  close(values[1] - values[0] * (1 + monthly(8)), F.inflated(1000 * EUR, 3, 1), "the first month");
  close(values[20] - values[19] * (1 + monthly(8)), F.inflated(1500 * EUR, 3, 20), "the planned amount rises too");
  // In today's money, what is paid in stays as typed.
  const today = rising.forecast({ money: "today" }).plans.keep.values;
  const real = (1 + monthly(8)) / (1 + monthly(3)) - 1;
  close(today[20] - today[19] * (1 + real), 1500 * EUR, "today's money");
});

test("savePayInChange checks when it starts and its amount", () => {
  const s = F.emptyStore();
  const added = F.savePayInChange(s, { id: null, from: { month: "2027-04" }, amount: 1900 * EUR });
  assert.equal(added.ok, true);
  const [change] = added.store.payInChanges;
  assert.deepEqual({ ...change, id: "x" }, { id: "x", from: { month: "2027-04" }, amount: 1900 * EUR });
  assert.equal(s.payInChanges.length, 0, "the old store is left alone");
  const edited = F.savePayInChange(added.store, { ...change, amount: null });
  assert.deepEqual(edited.store.payInChanges, [{ ...change, amount: null }], "the same id changes it");
  assert.deepEqual(F.savePayInChange(added.store, { id: null, from: { month: "2027-04" }, amount: 0 }), { ok: false, error: "Another change starts then: edit that one" });
  assert.equal(F.savePayInChange(added.store, { id: null, from: { age: 40 }, amount: 0 }).ok, true, "an age may fall on the same month");
  assert.deepEqual(F.savePayInChange(s, { id: null, from: { at: "retirement" }, amount: 0 }), { ok: false, error: "Choose a month or an age it starts at" });
  assert.deepEqual(F.savePayInChange(s, { id: null, from: null, amount: 0 }), { ok: false, error: "Choose a month or an age it starts at" });
  assert.deepEqual(F.savePayInChange(s, { id: null, from: { month: "2027-04" }, amount: -1 }), { ok: false, error: "Enter an amount of 0 or more" });
  assert.deepEqual(F.deletePayInChange(edited.store, change.id).payInChanges, []);
  assert.deepEqual(F.parseStore(JSON.parse(JSON.stringify(edited.store))), { ok: true, store: edited.store });
});

test("an own future pay-in replaces the average everywhere: investment rate, milestones, forecast", () => {
  const s = store({
    settings: { ...F.DEFAULT_SETTINGS, bufferPercent: 0, birthYear: 1990 },
    income: [{ id: "i", name: "Salary", category: "", amount: 4000 * EUR, everyMonths: 1 }],
    expenses: [{ id: "e", name: "Rent", category: "", amount: 2000 * EUR, everyMonths: 1, active: true, essential: true }],
    accounts: [{ id: "a", name: "A" }],
    records: [
      { month: "2026-09", account: "a", value: 50000 * EUR, payIn: 1000 * EUR },
      { month: "2026-10", account: "a", value: 51000 * EUR, payIn: -3000 * EUR },
    ],
  });
  const average = F.metrics(s, "2026-11");
  assert.deepEqual(average.payIn, { amount: -1000 * EUR, months: 2, change: null });
  assert.equal(F.fiOutlook(s, "2026-11").payIn.invested, 0, "a withdrawal on average invests nothing");

  const own = F.saveSettings(s, { futurePayIn: 1500 * EUR });
  const m = F.metrics(own, "2026-11");
  assert.deepEqual(m.payIn, { amount: 1500 * EUR, months: null, change: null });
  assert.deepEqual(F.averagePayIn(m.series), { average: -1000 * EUR, months: 2 }, "the history is left alone");
  assert.equal(m.investmentRate, 1500 / 4000);
  assert.deepEqual(F.incomeSplit(m), { expenses: 2000 * EUR, invested: 1500 * EUR, leftOver: 500 * EUR, over: 0 });
  // Time to FI and Lean FI: as projected with 1,500 a month, to an FI
  // number of 600,000 (the salary ends at retirement).
  const o = F.fiOutlook(own, "2026-11");
  assert.deepEqual(o.payIn, { amount: 1500 * EUR, months: null, change: null, invested: 1500 * EUR, withdrawal: false, changes: [], rises: false });
  const { coast, lean, fi } = o.milestones();
  assert.equal(fi.months, monthsTo(51000 * EUR, 1500 * EUR, 8, 600000 * EUR, 3));
  assert.equal(lean.months, fi.months, "every expense is essential");
  assert.ok(fi.months < F.fiOutlook({ ...own, settings: { ...own.settings, futurePayIn: 1000 * EUR } }, "2026-11").milestones().fi.months, "paying in more reaches FI sooner");
  // The forecast and Coast FI invest it too.
  const f = o.forecast();
  close(f.plans.keep.values[1], 51000 * EUR * (1 + monthly(8)) + 1500 * EUR, "a month of growth and the pay-in");
  assert.equal(f.plans.fi.fiMonth, fi.month);
  assert.equal(coast.month, f.plans.coast.coastMonth);

  // Without any pay-ins yet, the own amount still counts.
  const fresh = F.saveSettings(store({ income: s.income, expenses: s.expenses }), { futurePayIn: 800 * EUR });
  const none = F.metrics(fresh, "2026-11");
  assert.deepEqual(none.payIn, { amount: 800 * EUR, months: null, change: null });
  assert.equal(none.investmentRate, 800 / 4000);
  assert.equal(F.fiOutlook(fresh, "2026-11").milestones().fi.months, null, "no portfolio to project from");
});

test("emergency fund: the cash accounts in months of expenses, and what is missing", () => {
  assert.deepEqual(F.emergencyFund(6000, 2000, 6), { cash: 6000, months: 3, target: 6, short: 6000 });
  assert.deepEqual(F.emergencyFund(15000, 2000, 6), { cash: 15000, months: 7.5, target: 6, short: 0 });
  assert.equal(F.emergencyFund(5000, 0, 6).months, null);

  let s = F.emptyStore();
  s = F.saveItem(s, "expenses", { id: "e", name: "Rent", category: "", amount: 2000 * EUR, everyMonths: 1, from: null, until: null, active: true, essential: false }).store;
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
  // Long histories too: 1 % a month for 82 and 360 months.
  for (const months of [82, 360]) {
    const long = Array.from({ length: months + 1 }, (_, i) => ({ month: F.addMonths("1990-01", i), value: 1000 * 1.01 ** i, payIn: 0, oneOff: 0, invested: 1000 }));
    close(F.moneyWeighted(long), 1.01 ** 12 - 1, `${months} months`);
  }
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

test("budget: where each expense and income stands in a month", () => {
  const birthYear = 1990;
  const retirement = (1990 + 67) * 12; // January 2057
  const at = (month) => F.monthIndex(month);
  const item = (from, until, active) => ({ id: "x", name: "X", category: "", amount: 100 * EUR, everyMonths: 1, from, until, ...(active === undefined ? {} : { active }) });
  // The list of the budget the item is in, as an expense and as income.
  const status = (i, month, retire = retirement, born = birthYear) => {
    const lists = (kind) => {
      const b = F.budget(store({ settings: { ...F.DEFAULT_SETTINGS, birthYear: born }, [kind]: [i] }), at(month), retire)[kind];
      return ["now", "later", "ended", "inactive"].filter((list) => b[list].some((x) => x.id === i.id));
    };
    const [expense, income] = [lists("expenses"), lists("income")];
    if (i.active === undefined) assert.deepEqual(income, expense, "income stands where an expense would");
    assert.equal(expense.length, 1, "in one list");
    return expense[0];
  };

  assert.equal(status(item(null, null), "1900-01"), "now");
  assert.equal(status(item(null, null, false), "2026-11"), "inactive", "inactive never counts");
  // A month start is its first month; a month end its last.
  const kita = item({ month: "2027-08" }, { month: "2031-07" });
  assert.deepEqual(["2027-07", "2027-08", "2031-07", "2031-08"].map((m) => status(kita, m)), ["later", "now", "now", "ended"]);
  // Retirement and ages are January of their year.
  const salary = item(null, { at: "retirement" });
  assert.deepEqual(["2056-12", "2057-01"].map((m) => status(salary, m)), ["now", "ended"]);
  assert.equal(status(salary, "2056-12", at("2040-05")), "ended", "retiring early ends it early");
  const pension = item({ age: 67 }, null);
  assert.deepEqual(["2056-12", "2057-01"].map((m) => status(pension, m)), ["later", "now"]);
  const bridge = item({ at: "retirement" }, { age: 67 });
  assert.deepEqual(["2049-12", "2050-01", "2056-12", "2057-01"].map((m) => status(bridge, m, at("2050-01"))), ["later", "now", "now", "ended"]);
  // Without a year of birth, ages and retirement are never reached.
  assert.equal(status(pension, "2090-01", Infinity, null), "later");
  assert.equal(status(item(null, { age: 30 }), "2090-01", Infinity, null), "now");
  assert.equal(F.retirementIndex({ birthYear: null, retirementAge: 67 }), Infinity);
  assert.equal(F.retirementIndex({ birthYear: 1990, retirementAge: 67 }), retirement);
});

test("budget: the month's totals with the buffer, and what the portfolio pays", () => {
  const item = (name, amount, from, until, extra = {}) => ({ id: name, name, category: "", amount: amount * EUR, everyMonths: 1, from, until, ...extra });
  const rent = item("Rent", 1000, null, null, { active: true, essential: true });
  const insurance = item("Insurance", 300, null, null, { everyMonths: 3, active: true, essential: false });
  const health = item("Health insurance", 300, { at: "retirement" }, { age: 67 }, { active: true, essential: true });
  const kita = item("Kita", 400, null, { month: "2026-10" }, { active: true, essential: false });
  const gym = item("Gym", 50, null, null, { active: false, essential: true });
  const salary = item("Salary", 3000, null, { at: "retirement" });
  const flat = item("Rent from a flat", 200, null, null);
  const pension = item("State pension", 1000, { age: 67 }, null);
  const s = store({
    settings: { ...F.DEFAULT_SETTINGS, birthYear: 1990, bufferPercent: 10 },
    expenses: [rent, insurance, health, kita, gym],
    income: [salary, flat, pension],
  });
  const now = F.monthIndex("2026-11");

  const working = F.budget(s, now);
  assert.deepEqual(
    { now: working.expenses.now, later: working.expenses.later, ended: working.expenses.ended, inactive: working.expenses.inactive },
    { now: [rent, insurance], later: [health], ended: [kita], inactive: [gym] });
  assert.deepEqual([working.income.now, working.income.later, working.income.ended], [[salary, flat], [pension], []]);
  assert.equal(working.expenses.monthly, 1100 * EUR, "a quarterly 300 is 100 a month");
  assert.equal(working.expenses.buffer, 110 * EUR);
  assert.equal(working.expenses.total, 1210 * EUR);
  assert.deepEqual(working.expenses.essential, { monthly: 1000 * EUR, total: 1100 * EUR });
  assert.equal(working.income.monthly, 3200 * EUR);
  assert.equal(working.need, 0, "the income pays it all");
  assert.equal(working.essentialNeed, 0);

  // Retiring now: health insurance starts, the salary ends.
  const retired = F.budget(s, now, now);
  assert.deepEqual(retired.expenses.now, [rent, insurance, health]);
  assert.equal(retired.expenses.total, 1540 * EUR);
  assert.equal(retired.income.monthly, 200 * EUR);
  assert.equal(retired.need, 1340 * EUR);
  assert.equal(retired.essentialNeed, 1230 * EUR, "rent and health insurance with the buffer, less the flat");

  // The dashboard reads this month's budget.
  const m = F.metrics(s, "2026-11");
  assert.deepEqual(m.budget, working);
  assert.equal(m.expenses, working.expenses.total);
  assert.equal(m.retiredNeed, retired.need);

  // needIn is the same rule without the lists, for the projections.
  for (const retire of [now, F.monthIndex("2050-01"), F.retirementIndex(s.settings)]) {
    for (let index = now; index <= F.monthIndex("2060-12"); index += 7) {
      const b = F.budget(s, index, retire);
      assert.equal(F.needIn(s, index, retire), b.need);
      assert.equal(F.needIn(s, index, retire, { essential: true }), b.essentialNeed);
    }
  }
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
  assert.equal(F.fiNumberIn(s, F.monthIndex("2026-11"), { essential: true }), 1100 * 12 * 25 * EUR, "Lean FI: both essential expenses, less the income");
  // From 2057 the pension pays the health insurance's part and more.
  assert.equal(F.fiNumberIn(s, F.monthIndex("2057-01")), 0);
  assert.equal(F.needIn(s, F.monthIndex("2056-12"), F.monthIndex("2056-12")), 1100 * EUR);
  // The outlook's is the FI number for retiring the month after the latest.
  assert.equal(F.fiOutlook(s, "2026-11").fiNumber, m.fiNumber);
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

test("Lean FI: the FI number and time to FI for the essential expenses only", () => {
  const item = (id, amount, essential, active = true) => ({ id, name: id, category: "", amount: amount * EUR, everyMonths: 1, active, essential });
  const s = store({
    settings: { ...F.DEFAULT_SETTINGS, expectedReturn: 0, inflation: 0 },
    expenses: [item("rent", 1000, true), item("food", 400, true), item("travel", 600, false), item("car", 300, true, false)],
    accounts: [{ id: "a", name: "A" }],
    records: [{ month: "2026-10", account: "a", value: 154000 * EUR, payIn: 1000 * EUR }],
  });
  const now = F.monthIndex("2026-11");
  const { lean, fi } = F.fiOutlook(s, "2026-11").milestones();
  // Essential and active: 1,400 a month, plus the 10 % buffer.
  close(F.budget(s, now, now).essentialNeed, 1540 * EUR, "lean expenses");
  close(lean.fiNumber, 1540 * 12 * 25 * EUR, "Lean FI number");
  close(fi.fiNumber, 2200 * 12 * 25 * EUR, "the FI number counts every active expense");
  close(lean.progress, 154000 / 462000, "progress");
  // 308,000 to go at 1,000 a month without growth.
  assert.equal(lean.months, 308);
  assert.equal(fi.months, 506);

  const reached = F.fiOutlook({ ...s, records: [{ ...s.records[0], value: 500000 * EUR }] }, "2026-11").milestones();
  assert.equal(reached.lean.months, 0);
  assert.ok(reached.lean.progress > 1);
  assert.equal(F.fiOutlook({ ...s, records: [] }, "2026-11").milestones().lean.progress, null, "no portfolio, no progress");
  assert.equal(F.fiOutlook({ ...s, expenses: s.expenses.map((e) => ({ ...e, essential: false })) }, "2026-11").milestones().lean, null);
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
  s = F.saveItem(s, "expenses", { id: "e", name: "Rent", category: "Housing", amount: 100, everyMonths: 1, from: null, until: null, active: true, essential: true }).store;
  s = F.saveItem(s, "income", { id: "i", name: "Salary", category: "Work", amount: 100, everyMonths: 1, from: null, until: { at: "retirement" } }).store;

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

test("forecast: planned one-offs go into every plan, and Coast FI counts only those taken out ahead", () => {
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
  // more is needed to reach 600,000. With the deposit to pay, it needs
  // 620,000 until then. The inheritance doesn't count before it comes, but
  // once it is there the portfolio has enough: 300,000 + 13 years of 1,000
  // - 20,000 + 300,000 in January 2040, not 2051.
  const coast = F.forecast({ ...plan({ growth: 0, value: 300000 * EUR }), oneOffs }).plans.coast;
  const without = F.forecast(plan({ growth: 0, value: 300000 * EUR })).plans.coast;
  assert.equal(coast.coastMonth, "2040-01");
  assert.equal(without.coastMonth, "2051-10");
  // From 640,000 the deposit is covered: Coast FI at the start.
  assert.equal(F.forecast({ ...plan({ growth: 0, value: 640000 * EUR }), oneOffs }).plans.coast.coastMonth, "2026-10");
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
  const o = outlook({ value: 50000 * EUR, goal: 600000 * EUR, rate: 3, inflation: 3, settings: { birthYear: 1990 } });
  const nominal = o.forecast();
  const real = o.forecast({ money: "today" });
  for (const index of [0, 12, 360]) {
    close(real.plans.keep.values[index], 50000 * EUR, `value after ${index} months`);
    close(real.goal[index], 600000 * EUR, `FI number after ${index} months`);
  }
  close(real.fiAtRetirement, 600000 * EUR, "the FI number when retirement starts");
  close(real.plans.keep.atRetirement, 50000 * EUR, "the value when retirement starts");
  assert.equal(real.plans.keep.runsOut, nominal.plans.keep.runsOut, "milestones stay");
  assert.equal(nominal.plans.keep.values[12] > 50000 * EUR, true, "the original is untouched");

  const today = outlook({ value: 1200, goal: 2400, rate: 3, inflation: 3 }).path("today");
  close(today.points[11].mid, 1200, "the mid line, a year on");
  close(today.points[11].goal, 2400, "the goal, a year on");
  assert.equal(outlook({ value: 1200 }).path("today"), null);
});

test("forecast: the growth rates are the expected return and 2 points less and more", () => {
  assert.deepEqual(F.growthRates(5), { low: 3, mid: 5, high: 7 });
  assert.deepEqual(F.growthRates(1.5), { low: -0.5, mid: 1.5, high: 3.5 });
  // Below 0 too: the portfolio then shrinks, and never coasts to the FI number.
  const f = F.forecast(plan({ growth: -0.5, contribution: 0 }));
  assert.ok(f.plans.keep.values[12] < 50000 * EUR);
  assert.equal(f.plans.coast.coastMonth, null);
});

test("forecast: months from the start to age 120, retirement in January of the year of the age", () => {
  const f = F.forecast(plan());
  assert.equal(f.months[0], "2026-10");
  assert.equal(f.months.at(-1), "2110-12");
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

test("forecast: the Coast FI number is what the portfolio needs at the start for Coast FI then", () => {
  const r = monthly(5);
  const months = F.monthIndex("2056-12") - F.monthIndex("2026-10");
  const f = F.forecast(plan());
  close(f.coastNumber, (600000 * EUR) / (1 + r) ** months, "grown to the end of 2056, it is the FI number");
  // Coast FI is at the start from that value on, and not a little below it.
  assert.equal(F.forecast(plan({ value: f.coastNumber })).plans.coast.coastMonth, "2026-10");
  assert.ok(F.forecast(plan({ value: f.coastNumber * 0.999 })).plans.coast.coastMonth > "2026-10");
  // What is paid in after Coast FI lowers it, and one-offs to take out
  // raise it. One-offs to come in leave it as it is: they only make the
  // portfolio reach it sooner.
  assert.ok(F.forecast(plan({ coastContribution: 200 * EUR })).coastNumber < f.coastNumber);
  const oneOffs = (index) => (index === F.monthIndex("2040-01") ? 300000 * EUR : index === F.monthIndex("2028-01") ? -20000 * EUR : 0);
  close(F.forecast({ ...plan({ growth: 0 }), oneOffs }).coastNumber, 620000 * EUR, "600,000 plus the deposit, not less the inheritance");
  close(F.forecast({ ...plan(), oneOffs: () => 700000 * EUR }).coastNumber, f.coastNumber, "one-offs to come in");
  close(F.forecast({ ...plan(), oneOffs: (index) => (index === F.monthIndex("2028-01") ? -20000 * EUR : 0) }).coastNumber,
    f.coastNumber + (20000 * EUR) / (1 + r) ** 15, "a deposit 15 months on needs what grows to it by then");
  assert.equal(F.forecast(plan({ birthYear: 1950 })).coastNumber, null, "retired already");
});

test("Coast FI on the dashboard: the Forecast page's Coast plan at the expected return", () => {
  const s = store({
    settings: { ...F.DEFAULT_SETTINGS, bufferPercent: 0, expectedReturn: 5, inflation: 0, birthYear: 1990 },
    expenses: [{ id: "rent", name: "Rent", category: "", amount: 2000 * EUR, everyMonths: 1, active: true }],
    accounts: [{ id: "a", name: "A" }],
    records: [{ month: "2026-10", account: "a", value: 50000 * EUR, payIn: 1000 * EUR }],
  });
  const o = F.fiOutlook(s, "2026-11");
  const { coast } = o.milestones();
  // The same as plan(): 50,000 in October 2026, 1,000 a month, 5 %, FI at
  // 600,000, born 1990, retiring at 67, and nothing after Coast FI.
  const f = F.forecast(plan());
  assert.equal(coast.month, f.plans.coast.coastMonth);
  assert.equal(coast.months, F.monthIndex(f.plans.coast.coastMonth) - F.monthIndex("2026-10"));
  close(coast.fiNumber, f.coastNumber, "Coast FI number");
  close(coast.progress, (50000 * EUR) / f.coastNumber, "progress");
  close(coast.fiAtRetirement, 600000 * EUR, "the FI number when retirement starts");
  assert.equal(o.payIn.invested, 1000 * EUR);
  assert.equal(o.start, "2026-10");

  const at = (changed) => F.fiOutlook(changed, "2026-11").milestones().coast;
  const now = at({ ...s, records: [{ ...s.records[0], value: 200000 * EUR }] });
  assert.equal(now.months, 0);
  assert.ok(now.progress > 1);

  // A planned inheritance doesn't lower what Coast FI needs, as it doesn't
  // lower the FI number: the portfolio only gets there sooner, once the
  // money is in.
  const inheritance = at({ ...s, events: [{ id: "i", name: "Inheritance", month: "2030-01", amount: 200000 * EUR }] });
  close(inheritance.fiNumber, coast.fiNumber, "the Coast FI number with an inheritance to come");
  assert.ok(coast.month > "2030-01");
  assert.equal(inheritance.month, "2030-01");
  // Nor when a deposit is taken out the same month: Coast FI still sets it
  // aside, as without the inheritance.
  const deposit = { id: "d", name: "Deposit", month: "2030-01", amount: -20000 * EUR };
  close(at({ ...s, events: [deposit, { id: "i", name: "Inheritance", month: "2030-01", amount: 200000 * EUR }] }).fiNumber,
    at({ ...s, events: [deposit] }).fiNumber, "the Coast FI number with a deposit and an inheritance the same month");
  assert.ok(at({ ...s, events: [deposit] }).fiNumber > coast.fiNumber);

  const none = at({ ...s, records: [] });
  assert.ok(none.fiNumber > 0, "what it needs, without a portfolio too");
  assert.deepEqual([none.progress, none.month, none.months], [null, null, null]);

  assert.equal(at({ ...s, settings: { ...s.settings, birthYear: null } }), null, "without a year of birth");
  assert.equal(at({ ...s, settings: { ...s.settings, birthYear: 1950 } }), null, "past the retirement age");
  assert.equal(at({ ...s, expenses: [] }), null, "without an FI number");
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

test("forecast: a plan lasts only when money is left at age 120", () => {
  // Already at 30 × yearly expenses at 36, living off it at 3 % growth:
  // that lasts about 74 years, past 95 but not to 120.
  const f = F.forecast(plan({ value: 2000 * EUR * 12 * 30, growth: 3 }));
  const fi = f.plans.fi;
  assert.equal(fi.fiMonth, "2026-10");
  const age = F.ageIn(fi.runsOut, 1990);
  assert.ok(age > 95 && age <= F.SHOWN_AGE, `runs out at ${age}`);
  assert.equal(fi.values.at(-1), 0);
  // 40 × at 3 %: taking out 2.5 % a year, it lasts.
  const lasting = F.forecast(plan({ value: 2000 * EUR * 12 * 40, growth: 3 })).plans.fi;
  assert.equal(lasting.runsOut, null);
  assert.ok(lasting.values.at(-1) > 0, "still money at 120");
});

test("forecast: fixed dates run the plans of the expected return at another growth", () => {
  const mid = F.forecast(plan());
  const fixed = { coast: mid.plans.coast.coastMonth, fi: mid.plans.fi.fiMonth };
  const low = F.forecast({ ...plan({ growth: 3 }), fixed });
  assert.equal(low.plans.fi.fiMonth, fixed.fi);
  assert.equal(low.plans.coast.coastMonth, fixed.coast);
  assert.ok(F.forecast(plan({ growth: 3 })).plans.fi.fiMonth > fixed.fi, "3 % reaches FI later on its own");
  const r = monthly(3);
  const i = F.monthIndex(fixed.fi) - F.monthIndex("2026-10");
  close(low.plans.fi.values[i + 1], low.plans.fi.values[i] * (1 + r) - 2000 * EUR, "retired from the month after");
  const j = F.monthIndex(fixed.coast) - F.monthIndex("2026-10");
  close(low.plans.coast.values[j + 1], low.plans.coast.values[j] * (1 + r), "coasting from the month after");
  // Without FI or Coast FI by retirement, both are Keep investing.
  const never = F.forecast({ ...plan({ growth: 3 }), fixed: { coast: null, fi: null } });
  assert.deepEqual(never.plans.fi.values, never.plans.keep.values);
  assert.deepEqual(never.plans.coast.values, never.plans.keep.values);
  assert.deepEqual([never.plans.fi.fiMonth, never.plans.coast.coastMonth], [null, null]);
});

test("fiOutlook plans: each plan's phases, with a pension as a step while retired", () => {
  const s = store({
    settings: { ...F.DEFAULT_SETTINGS, bufferPercent: 0, withdrawalRate: 4, expectedReturn: 5, inflation: 0, birthYear: 1990, futurePayIn: 1000 * EUR },
    expenses: [
      { id: "rent", name: "Rent", category: "", amount: 2000 * EUR, everyMonths: 1, active: true, essential: false },
      { id: "health", name: "Health", category: "", amount: 300 * EUR, everyMonths: 1, active: true, essential: true, from: { at: "retirement" }, until: { age: 67 } },
    ],
    income: [
      { id: "salary", name: "Salary", category: "", amount: 4000 * EUR, everyMonths: 1 },
      { id: "pension", name: "Pension", category: "", amount: 1500 * EUR, everyMonths: 1, from: { age: 67 }, until: null },
    ],
    accounts: [{ id: "a", name: "A" }],
    records: [{ month: "2026-10", account: "a", value: 200000 * EUR, payIn: 1000 * EUR }],
    payInChanges: [{ id: "c", from: { age: 45 }, amount: 1500 * EUR }],
  });
  const o = F.fiOutlook(s, "2026-11");
  const result = o.plans("nominal");
  assert.deepEqual([result.months[0], result.months.at(-1), result.retirement], ["2026-10", "2110-12", "2057-01"]);
  assert.deepEqual(result.plans.map((p) => p.key), ["fi", "coast", "keep", "safe"]);
  const [fi, coast, keep, safe] = result.plans;
  const at = (month) => F.monthIndex(month) - F.monthIndex("2026-10");
  const end = result.months.length;

  // Retire early, at the expected return as forecast() runs it: investing
  // as planned, then retired, with a step when the pension starts and the
  // health insurance ends.
  const main = o.forecast();
  assert.deepEqual(fi.values.mid, main.plans.fi.values);
  assert.equal(fi.stopInvesting, main.plans.fi.fiMonth);
  assert.equal(fi.retires, F.addMonths(main.plans.fi.fiMonth, 1));
  assert.ok(fi.retires > "2035-01" && fi.retires < "2057-01", fi.retires);
  assert.deepEqual(fi.phases.map((p) => [p.kind, p.from, p.to]), [["invest", 0, at(fi.retires)], ["retired", at(fi.retires), end]]);
  assert.deepEqual(fi.phases[0].steps.map((st) => [st.from, st.to, st.amount]), [[0, at("2035-01"), 1000 * EUR], [at("2035-01"), at(fi.retires), 1500 * EUR]]);
  const [bridge, pension] = fi.phases[1].steps;
  assert.deepEqual([bridge.from, bridge.to, bridge.amount, bridge.share], [at(fi.retires), at("2057-01"), 2300 * EUR, 1]);
  assert.deepEqual([pension.from, pension.to, pension.amount, pension.share], [at("2057-01"), end, 500 * EUR, 0.25]);
  assert.deepEqual(pension.changes, [{ name: "Health", kind: "expenses", starts: false }, { name: "Pension", kind: "income", starts: true }]);
  assert.deepEqual(bridge.changes, [{ name: "Health", kind: "expenses", starts: true }, { name: "Salary", kind: "income", starts: false }]);

  // At 3 % it keeps the 5 % plan's dates: retired from the same month.
  const r = monthly(3);
  const k = at(fi.stopInvesting);
  close(fi.values.low[k + 1], fi.values.low[k] * (1 + r) - 2300 * EUR, "at 3 %, retired when 5 % says");
  assert.ok(o.forecast({ growth: "low" }).plans.fi.fiMonth > fi.stopInvesting, "3 % on its own reaches FI later");
  assert.equal(fi.runsOut.mid, main.plans.fi.runsOut);

  // Coast from now: nothing paid in until retirement.
  assert.equal(coast.stopInvesting, null);
  assert.equal(coast.retires, "2057-01");
  assert.deepEqual(coast.phases.map((p) => [p.kind, p.from, p.to]), [["coast", 0, at("2057-01")], ["retired", at("2057-01"), end]]);
  assert.deepEqual(coast.phases[0].steps.map((st) => st.amount), [0]);
  assert.deepEqual(coast.phases[1].steps.map((st) => [st.amount, st.share]), [[500 * EUR, 0.25]]);
  assert.ok(coast.phases[1].steps[0].changes.some((c) => c.name === "Pension" && c.starts), "the pension starts with retirement");

  // Keep investing until retirement.
  assert.deepEqual([keep.stopInvesting, keep.retires], ["2056-12", "2057-01"]);
  assert.deepEqual(keep.phases.map((p) => p.kind), ["invest", "retired"]);
  assert.deepEqual(keep.values.mid, main.plans.keep.values);

  // Retire early runs out at 3 %: the safe plan stops at the first age, in
  // January, from which it lasts even then.
  assert.notEqual(fi.runsOut.low, null);
  assert.ok(safe.retires.endsWith("-01") && safe.retires > fi.retires && safe.retires < "2057-01", safe.retires);
  assert.equal(safe.stopInvesting, F.addMonths(safe.retires, -1));
  assert.deepEqual(safe.runsOut, { low: null, mid: null, high: null });
  assert.deepEqual(safe.phases.map((p) => [p.kind, p.from, p.to]), [["invest", 0, at(safe.retires)], ["retired", at(safe.retires), end]]);
  assert.deepEqual(safe.phases[1].steps.map((st) => st.from), [at(safe.retires), at("2057-01")]);
  // As forecast() runs it at 3 %: a year sooner runs out.
  const stopAfter = (last) => F.forecast({
    start: "2026-10", value: 200000 * EUR, birthYear: 1990, retirementAge: 67, inflation: 0, growth: 3, coastContribution: 0,
    contribution: (i) => (i >= F.monthIndex("2035-01") ? 1500 : 1000) * EUR, need: (i, from) => F.needIn(s, i, from), goal: () => 0,
    fixed: { coast: null, fi: last },
  }).plans.fi;
  assert.deepEqual(stopAfter(safe.stopInvesting).values, safe.values.low);
  assert.notEqual(stopAfter(F.addMonths(safe.stopInvesting, -12)).runsOut, null, "a year sooner runs out at 3 %");

  // Today's money: the values without the inflation since the start.
  const prices = F.fiOutlook({ ...s, settings: { ...s.settings, inflation: 2 } }, "2026-11");
  const nominal = prices.plans("nominal").plans[2].values.mid;
  const today = prices.plans("today").plans[2].values.mid;
  close(today[120], F.deflated(nominal[120], 2, 120), "today's money");
});

test("fiOutlook plans: a step while retired when the share changes, even if the amount doesn't", () => {
  // At 80 care costs 1,000 more and an annuity of 1,000 starts: the
  // portfolio still pays 2,000, but now only two thirds of the spending.
  const s = store({
    settings: { ...F.DEFAULT_SETTINGS, bufferPercent: 0, expectedReturn: 5, inflation: 0, birthYear: 1990 },
    expenses: [
      { id: "rent", name: "Rent", category: "", amount: 2000 * EUR, everyMonths: 1, active: true, essential: false },
      { id: "care", name: "Care", category: "", amount: 1000 * EUR, everyMonths: 1, active: true, essential: false, from: { age: 80 } },
    ],
    income: [{ id: "annuity", name: "Annuity", category: "", amount: 1000 * EUR, everyMonths: 1, from: { age: 80 }, until: null }],
    accounts: [{ id: "a", name: "A" }],
    records: [{ month: "2026-10", account: "a", value: 100000 * EUR, payIn: 1000 * EUR }],
  });
  const result = F.fiOutlook(s, "2026-11").plans("nominal");
  const keep = result.plans.find((p) => p.key === "keep");
  const steps = keep.phases.find((p) => p.kind === "retired").steps;
  const at = (month) => F.monthIndex(month) - F.monthIndex("2026-10");
  assert.deepEqual(steps.map((st) => [st.from, st.amount]), [[at("2057-01"), 2000 * EUR], [at("2070-01"), 2000 * EUR]]);
  close(steps[1].share, 2 / 3, "the portfolio's share from 80");
  assert.deepEqual(steps[1].changes, [{ name: "Care", kind: "expenses", starts: true }, { name: "Annuity", kind: "income", starts: true }]);
});

test("fiOutlook plans: retired already, plans that don't happen, and without a year of birth", () => {
  const retired = F.fiOutlook(outlookStore({ value: 100000 * EUR, goal: 600000 * EUR, rate: 5, settings: { birthYear: 1950 } }), "2026-11").plans("nominal");
  assert.deepEqual(retired.plans.map((p) => [p.key, p.stopInvesting, p.retires]), [["keep", null, "2026-10"]]);
  assert.deepEqual(retired.plans[0].phases.map((p) => [p.kind, p.from]), [["retired", 0]]);
  assert.ok(retired.plans[0].runsOut.mid < "2032-01", "2,000 a month from 100,000 runs out within 5 years");
  // No FI and no Coast FI before retirement: only Keep investing happens.
  const far = F.fiOutlook(outlookStore({ value: 1000 * EUR, payIn: 100 * EUR, goal: 2000000 * EUR, rate: 5, settings: { birthYear: 1990 } }), "2026-11").plans("nominal");
  assert.deepEqual(far.plans.map((p) => [p.key, p.retires]), [["fi", null], ["coast", null], ["keep", "2057-01"]]);
  assert.deepEqual([far.plans[0].phases, far.plans[1].phases], [[], []]);
  assert.equal(F.fiOutlook(outlookStore({ goal: 600000 * EUR, rate: 5 }), "2026-11").plans(), null);
});

test("fiOutlook plans: a safe plan only when stopping at FI runs out at the low growth", () => {
  // FI now, and it lasts at 3 % too: no safe plan.
  const rich = outlook({ value: 1000000 * EUR, goal: 600000 * EUR, rate: 5, settings: { birthYear: 1990 } }).plans("nominal");
  assert.deepEqual(rich.plans.map((p) => [p.key, p.runsOut.low]), [["fi", null], ["coast", null], ["keep", null]]);
  // FI at 66, and at 3 % no age before 67 lasts, nor does working to 67.
  const late = outlook({ value: 50000 * EUR, payIn: 500 * EUR, goal: 600000 * EUR, rate: 5, settings: { birthYear: 1990 } }).plans("nominal");
  const plans = Object.fromEntries(late.plans.map((p) => [p.key, p]));
  assert.ok(plans.fi.retires !== null && plans.fi.runsOut.low !== null, "FI happens and runs out at 3 %");
  assert.deepEqual([plans.safe.stopInvesting, plans.safe.retires, plans.safe.phases], [null, null, []]);
  assert.notEqual(plans.keep.runsOut.low, null);
});

test("fiOutlook plans: FI in the last month before retirement doesn't happen before it", () => {
  // Retirement in January 2027; 596,000 reaches 600,000 at the end of
  // December 2026, not November.
  const o = outlook({ value: 596000 * EUR, payIn: 1000 * EUR, goal: 600000 * EUR, rate: 5, settings: { birthYear: 1960 } });
  assert.equal(o.forecast().plans.fi.fiMonth, "2026-12");
  const plans = o.plans("nominal").plans;
  assert.deepEqual(plans.map((p) => [p.key, p.retires]), [["fi", null], ["coast", "2027-01"], ["keep", "2027-01"]]);
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
  assert.equal(f.months.at(-1), "2070-12", "until 120");
  for (const p of F.PLANS) {
    const { values, coastMonth, fiMonth, atRetirement } = f.plans[p];
    assert.deepEqual([coastMonth, fiMonth, atRetirement], [null, null, null]);
    close(values[1], 50000 * EUR * (1 + r) - 2000 * EUR, p);
  }
  // At least ten years are shown, also past 120.
  assert.equal(F.forecast(plan({ birthYear: 1900 })).months.at(-1), "2036-10");
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
