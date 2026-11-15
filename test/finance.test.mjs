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
    "0": 0,
  };
  for (const [text, cents] of Object.entries(cases)) {
    assert.deepEqual(F.parseMoney(text), { ok: true, cents }, text);
  }
});

test("parseMoney rejects what it cannot read safely", () => {
  for (const text of ["", "abc", "1,2,3", "0.123", "1.23456", "12.3.4", "1.234.56,7", "1,234,5", "--5", "12a"]) {
    assert.equal(F.parseMoney(text).ok, false, text);
  }
});

test("parsePercent", () => {
  assert.deepEqual(F.parsePercent("3,5"), { ok: true, value: 3.5 });
  assert.deepEqual(F.parsePercent("4 %"), { ok: true, value: 4 });
  assert.equal(F.parsePercent("x").ok, false);
});

test("parseMonth reads common month and date formats", () => {
  const cases = {
    "2026-10": "2026-10",
    "2026-1": "2026-01",
    "2026-10-31": "2026-10",
    "2026/10": "2026-10",
    "10/2026": "2026-10",
    "10.2026": "2026-10",
    "31.10.2026": "2026-10",
    "1.3.2025": "2025-03",
  };
  for (const [text, month] of Object.entries(cases)) assert.equal(F.parseMonth(text), month, text);
  for (const text of ["2026-13", "13/2026", "10/31/2026", "Oct 2026", "", "2026"]) assert.equal(F.parseMonth(text), null, text);
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
    { month: "2026-01", value: 1500, payIn: 100, paidIn: 100 },
    { month: "2026-02", value: 1500, payIn: 0, paidIn: 100 },
    { month: "2026-03", value: 1800, payIn: 100, paidIn: 200 },
  ]);
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
  s = F.saveItem(s, "expenses", { id: "e", name: "Rent", category: "Housing", amount: 100, everyMonths: 1 });
  s = F.saveAccount(s, null, "Broker").store;
  s = F.saveMonth(s, "2026-10", [{ account: s.accounts[0].id, value: 5, payIn: -2 }]);
  const roundTrip = JSON.parse(JSON.stringify(s));
  assert.deepEqual(F.parseStore(roundTrip), { ok: true, store: s });
  assert.deepEqual(F.parseStore(null), { ok: true, store: F.emptyStore() });

  const broken = [
    [{ ...roundTrip, extra: 1 }, /unknown field "extra"/],
    [{ ...roundTrip, version: 2 }, /unsupported version/],
    [{ ...roundTrip, settings: { withdrawalRate: 0, bufferPercent: 10 } }, /withdrawalRate/],
    [{ ...roundTrip, expenses: [{ ...roundTrip.expenses[0], amount: 1.5 }] }, /amount/],
    [{ ...roundTrip, expenses: [{ ...roundTrip.expenses[0], note: "x" }] }, /unknown field "note"/],
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
  assert.deepEqual(F.parseCsv('month;account;value\n2026-10;"A; B";"1.234,56"\r\n\n').rows, [
    { line: 1, fields: ["month", "account", "value"] },
    { line: 2, fields: ["2026-10", "A; B", "1.234,56"] },
  ]);
  assert.equal(F.parseCsv("a\tb\tc\n1\t2\t3").delimiter, "\t");
  assert.deepEqual(F.parseCsv('a,b\n"say ""hi""",2').rows[1].fields, ['say "hi"', "2"]);
});

test("planImport and applyImport: German semicolon file", () => {
  let s = F.saveAccount(F.emptyStore(), null, "Trade Republic").store;
  const tr = s.accounts[0].id;
  s = F.saveMonth(s, "2026-01", [{ account: tr, value: 1, payIn: 0 }]);

  const csv = [
    "Month;Account;Value;Pay-in",
    "2026-01;trade republic;12.345,67;500",
    "01.02.2026;Trade Republic;13.000;500,00",
    "2026-02;ING;8.000;",
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
    "month,account,value,pay_in",
    "2026-13,A,1,0",
    "2026-10,,1,0",
    "2026-10,A,x,0",
    "2026-10,A,-5,0",
    "2026-10,A,1,0",
    "2026-10,a,2,0",
    "2026-11,A,1,234,56,0",
  ].join("\n");
  const { errors } = F.planImport(F.emptyStore(), csv);
  assert.deepEqual(errors.map((e) => e.line), [2, 3, 4, 5, 7, 8]);
  assert.match(errors[4].message, /already on line 6/);
  assert.match(errors[5].message, /decimal comma/);

  assert.match(F.planImport(F.emptyStore(), "date,broker\n2026-10,A").errors[0].message, /missing: value/);
  assert.match(F.planImport(F.emptyStore(), "").errors[0].message, /empty/);
  assert.throws(() => F.applyImport(F.emptyStore(), F.planImport(F.emptyStore(), csv)));
});
