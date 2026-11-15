// Finance logic: the data file format, money and month parsing, metrics, and
// CSV import and export. No DOM here, so `node --test` covers it.
//
// Money is stored as whole cents (integers): hundredths of the currency set
// in settings. Months are "YYYY-MM" strings.

export const VERSION = 4;

export const KINDS = Object.freeze(["expenses", "income"]);

// How numbers are shown, named by how they write a million.
export const NUMBER_FORMATS = Object.freeze(["1.000.000,00", "1,000,000.00"]);

export const DEFAULT_SETTINGS = Object.freeze({ withdrawalRate: 4, bufferPercent: 10, currency: "EUR", numberFormat: NUMBER_FORMATS[0] });

// What a new data file starts with; categories can be changed in Settings.
export const STARTER_CATEGORIES = Object.freeze({
  expenses: Object.freeze(["Food", "Health", "Housing", "Insurance", "Leisure", "Subscriptions", "Transport"]),
  income: Object.freeze(["Side income", "Work"]),
});

export function emptyStore() {
  return {
    version: VERSION,
    settings: { ...DEFAULT_SETTINGS },
    categories: { expenses: [...STARTER_CATEGORIES.expenses], income: [...STARTER_CATEGORIES.income] },
    expenses: [],
    income: [],
    accounts: [],
    records: [],
  };
}

// ---------------------------------------------------------------- file format

const STORE_KEYS = ["version", "settings", "categories", "expenses", "income", "accounts", "records"];
const SETTINGS_KEYS = ["withdrawalRate", "bufferPercent", "currency", "numberFormat"];
const ITEM_KEYS = ["id", "name", "category", "amount", "everyMonths"];
const EXPENSE_KEYS = [...ITEM_KEYS, "active"];
const ACCOUNT_KEYS = ["id", "name"];
const RECORD_KEYS = ["month", "account", "value", "payIn"];
const MAX_CENTS = 1e13; // 100 billion; anything bigger is a typo

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// A key this version does not know would be dropped on the next save, so a
// file with one is refused instead of being quietly rewritten.
function checkKeys(value, allowed, where) {
  if (!isObject(value)) throw new Error(`${where} is not an object`);
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`${where} has unknown field "${key}"`);
  }
  for (const key of allowed) {
    if (!(key in value)) throw new Error(`${where} is missing "${key}"`);
  }
}

function isCents(value, { min = -MAX_CENTS } = {}) {
  return Number.isSafeInteger(value) && value >= min && value < MAX_CENTS;
}

function isText(value) {
  return typeof value === "string" && value.trim() === value;
}

// An ISO 4217 code such as "EUR" or "USD".
export function isCurrency(value) {
  return typeof value === "string" && /^[A-Z]{3}$/.test(value);
}

const compareNames = (a, b) => a.localeCompare(b);

// Version 1 had no currency (always euros) and no list of categories: each
// item had free text. The categories the items use become the list; the
// same name in different case becomes one category, spelled as first seen.
function upgradeFromVersion1(value) {
  checkKeys(value, ["version", "settings", "expenses", "income", "accounts", "records"], "The file");
  checkKeys(value.settings, ["withdrawalRate", "bufferPercent"], "settings");
  const categories = {};
  const items = {};
  for (const kind of KINDS) {
    if (!Array.isArray(value[kind])) throw new Error(`${kind} is not a list`);
    const names = new Map(); // lower case -> spelling
    items[kind] = value[kind].map((item) => {
      if (!isObject(item) || !isText(item.category) || item.category === "") return item;
      const key = item.category.toLowerCase();
      if (!names.has(key)) names.set(key, item.category);
      return { ...item, category: names.get(key) };
    });
    categories[kind] = [...names.values()].sort(compareNames);
  }
  return {
    version: 2,
    settings: { ...value.settings, currency: "EUR" },
    categories,
    expenses: items.expenses,
    income: items.income,
    accounts: value.accounts,
    records: value.records,
  };
}

// Version 2 could not set an expense inactive: every expense was active.
function upgradeFromVersion2(value) {
  const next = { ...value, version: 3 };
  if (Array.isArray(value.expenses)) {
    next.expenses = value.expenses.map((item) => (isObject(item) ? { ...item, active: true } : item));
  }
  return next;
}

// Version 3 had no number format: numbers were shown as the system language
// writes them. Upgraded files get the default.
function upgradeFromVersion3(value) {
  checkKeys(value.settings, ["withdrawalRate", "bufferPercent", "currency"], "settings");
  return { ...value, version: 4, settings: { ...value.settings, numberFormat: DEFAULT_SETTINGS.numberFormat } };
}

// Checks a parsed data file. Returns { ok: true, store } or { ok: false, error }.
// `null` (no file yet) is an empty store. Older versions are upgraded.
export function parseStore(value) {
  if (value === null) return { ok: true, store: emptyStore() };
  try {
    if (isObject(value) && value.version === 1) value = upgradeFromVersion1(value);
    if (isObject(value) && value.version === 2) value = upgradeFromVersion2(value);
    if (isObject(value) && value.version === 3) value = upgradeFromVersion3(value);
    checkKeys(value, STORE_KEYS, "The file");
    if (Number.isInteger(value.version) && value.version > VERSION) {
      throw new Error(`it was saved by a newer version of Finance (file version ${value.version}); reload the page or update Finance`);
    }
    if (value.version !== VERSION) throw new Error(`unsupported version ${JSON.stringify(value.version)}`);

    checkKeys(value.settings, SETTINGS_KEYS, "settings");
    const { withdrawalRate, bufferPercent, currency, numberFormat } = value.settings;
    if (typeof withdrawalRate !== "number" || !(withdrawalRate > 0 && withdrawalRate <= 100)) {
      throw new Error("settings.withdrawalRate must be above 0 and at most 100");
    }
    if (typeof bufferPercent !== "number" || !(bufferPercent >= 0 && bufferPercent <= 100)) {
      throw new Error("settings.bufferPercent must be between 0 and 100");
    }
    if (!isCurrency(currency)) throw new Error("settings.currency must be a three-letter code such as EUR");
    if (!NUMBER_FORMATS.includes(numberFormat)) {
      throw new Error(`settings.numberFormat must be ${NUMBER_FORMATS.map((f) => JSON.stringify(f)).join(" or ")}`);
    }

    checkKeys(value.categories, KINDS, "categories");
    for (const kind of KINDS) {
      const list = value.categories[kind];
      if (!Array.isArray(list)) throw new Error(`categories.${kind} is not a list`);
      const seen = new Set();
      list.forEach((name, i) => {
        const where = `categories.${kind}[${i}]`;
        if (!isText(name) || name === "") throw new Error(`${where} is not a name`);
        if (seen.has(name.toLowerCase())) throw new Error(`${where} repeats the name "${name}"`);
        seen.add(name.toLowerCase());
      });
    }

    const ids = new Set();
    for (const kind of KINDS) {
      if (!Array.isArray(value[kind])) throw new Error(`${kind} is not a list`);
      value[kind].forEach((item, i) => {
        const where = `${kind}[${i}]`;
        checkKeys(item, kind === "expenses" ? EXPENSE_KEYS : ITEM_KEYS, where);
        if (!isText(item.id) || item.id === "" || ids.has(item.id)) throw new Error(`${where} has a missing or repeated id`);
        ids.add(item.id);
        if (!isText(item.name) || item.name === "") throw new Error(`${where} has no name`);
        if (item.category !== "" && !value.categories[kind].includes(item.category)) {
          throw new Error(`${where} has a category that is not in categories.${kind}`);
        }
        if (!isCents(item.amount, { min: 1 })) throw new Error(`${where} amount must be a positive number of cents`);
        if (!Number.isInteger(item.everyMonths) || item.everyMonths < 1 || item.everyMonths > 120) {
          throw new Error(`${where} everyMonths must be a whole number from 1 to 120`);
        }
        if (kind === "expenses" && typeof item.active !== "boolean") throw new Error(`${where} active must be true or false`);
      });
    }

    if (!Array.isArray(value.accounts)) throw new Error("accounts is not a list");
    const accountIds = new Set();
    const accountNames = new Set();
    value.accounts.forEach((account, i) => {
      const where = `accounts[${i}]`;
      checkKeys(account, ACCOUNT_KEYS, where);
      if (!isText(account.id) || account.id === "" || accountIds.has(account.id)) throw new Error(`${where} has a missing or repeated id`);
      if (!isText(account.name) || account.name === "") throw new Error(`${where} has no name`);
      const key = account.name.toLowerCase();
      if (accountNames.has(key)) throw new Error(`${where} repeats the name "${account.name}"`);
      accountIds.add(account.id);
      accountNames.add(key);
    });

    if (!Array.isArray(value.records)) throw new Error("records is not a list");
    const seen = new Set();
    value.records.forEach((record, i) => {
      const where = `records[${i}]`;
      checkKeys(record, RECORD_KEYS, where);
      if (!isMonth(record.month)) throw new Error(`${where} has an invalid month`);
      if (!accountIds.has(record.account)) throw new Error(`${where} names an unknown account`);
      const key = `${record.month} ${record.account}`;
      if (seen.has(key)) throw new Error(`${where} repeats a month for the same account`);
      seen.add(key);
      if (!isCents(record.value, { min: 0 })) throw new Error(`${where} value must be zero or more cents`);
      if (!isCents(record.payIn)) throw new Error(`${where} payIn must be a number of cents`);
    });
  } catch (error) {
    return { ok: false, error: error.message };
  }
  return { ok: true, store: structuredClone(value) };
}

// ---------------------------------------------------------------- numbers

// ISO 4217 codes such as EUR or USD, from the JavaScript engine.
const CURRENCY_CODES = new Set(Intl.supportedValuesOf("currency"));

// Reads an amount typed or pasted in either German or English style:
// "1.234,56", "1,234.56", "1234,5", "€ 12", "USD 12", "-50". A single
// separator followed by exactly three digits is a thousands separator
// ("1.234" is 1234), because money never has three decimals. Currency signs
// and a three-letter code before or after the number are left out.
// Returns { ok: true, cents } or { ok: false, error }.
export function parseMoney(text) {
  let s = String(text ?? "")
    .replace(/[\s\u00a0\u202f']/g, "")
    .replace(/\p{Sc}/gu, "")
    .replace(/^([-−+]?)([a-z]{3})(?=[-−+]?[0-9.,])|(?<=[0-9.,])([a-z]{3})$/i, (match, sign, before, after) =>
      CURRENCY_CODES.has((before ?? after).toUpperCase()) ? (sign ?? "") : match);
  let sign = 1;
  if (/^[-−]/.test(s)) {
    sign = -1;
    s = s.slice(1);
  } else if (s.startsWith("+")) {
    s = s.slice(1);
  }
  if (s === "") return { ok: false, error: "Enter an amount" };
  if (!/^[0-9.,]+$/.test(s) || !/[0-9]/.test(s)) return { ok: false, error: `"${text}" is not an amount` };

  const lastDot = s.lastIndexOf(".");
  const lastComma = s.lastIndexOf(",");
  let whole = s;
  let fraction = "";

  if (lastDot !== -1 && lastComma !== -1) {
    const decimal = lastDot > lastComma ? "." : ",";
    const at = s.lastIndexOf(decimal);
    whole = s.slice(0, at);
    fraction = s.slice(at + 1);
    if (whole.includes(decimal)) return { ok: false, error: `"${text}" is not an amount` };
    whole = groupedWhole(whole, decimal === "." ? "," : ".");
    if (whole === null) return { ok: false, error: `"${text}" has misplaced thousands separators` };
  } else if (lastDot !== -1 || lastComma !== -1) {
    const sep = lastDot !== -1 ? "." : ",";
    const parts = s.split(sep);
    if (parts.length > 2) {
      whole = groupedWhole(s, sep);
      if (whole === null) return { ok: false, error: `"${text}" has misplaced thousands separators` };
    } else if (parts[1].length === 3) {
      if (/^0*$/.test(parts[0])) return { ok: false, error: `"${text}" has more than two decimals` };
      whole = groupedWhole(s, sep);
      if (whole === null) return { ok: false, error: `"${text}" has misplaced thousands separators` };
    } else {
      whole = parts[0];
      fraction = parts[1];
    }
  }

  if (whole === "") whole = "0";
  if (!/^[0-9]+$/.test(whole) || !/^[0-9]{0,2}$/.test(fraction)) {
    return { ok: false, error: fraction.length > 2 ? `"${text}" has more than two decimals` : `"${text}" is not an amount` };
  }
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(cents) || cents >= MAX_CENTS) return { ok: false, error: `"${text}" is too large` };
  return { ok: true, cents: sign * cents || 0 };
}

// "1.234.567" with sep "." -> "1234567"; null when the groups are not 1-3
// digits followed by groups of exactly 3.
function groupedWhole(s, sep) {
  if (!s.includes(sep)) return s;
  const groups = s.split(sep);
  if (!/^[0-9]{1,3}$/.test(groups[0])) return null;
  if (!groups.slice(1).every((g) => /^[0-9]{3}$/.test(g))) return null;
  return groups.join("");
}

// A percentage such as "3,5", "4 %" or "3.333333", with at most `decimals`
// decimals. "." and "," are both read as the decimal sign: unlike money, a
// percentage has no thousands, so "3.500" is 3.5. Returns { ok, value } or
// { ok, error }.
export function parsePercent(text, { decimals = 2 } = {}) {
  const s = String(text ?? "").replace(/[\s  %]/g, "");
  if (s === "") return { ok: false, error: "Enter a percentage" };
  const m = /^([0-9]*)(?:[.,]([0-9]*))?$/.exec(s);
  if (!m || !/[0-9]/.test(s)) return { ok: false, error: `"${text}" is not a percentage` };
  const fraction = m[2] ?? "";
  if (fraction.length > decimals) return { ok: false, error: `"${text}" has more than ${decimals} decimals` };
  return { ok: true, value: Number(`${m[1] || "0"}.${fraction || "0"}`) };
}

// ---------------------------------------------------------------- months

export function isMonth(value) {
  return typeof value === "string" && /^[0-9]{4}-(0[1-9]|1[0-2])$/.test(value);
}

export function monthIndex(month) {
  return Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1;
}

export function monthFromIndex(index) {
  const year = Math.floor(index / 12);
  const month = (index % 12) + 1;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}`;
}

export function addMonths(month, n) {
  return monthFromIndex(monthIndex(month) + n);
}

export function currentMonth(date = new Date()) {
  return monthFromIndex(date.getFullYear() * 12 + date.getMonth());
}

export function daysInMonth(month) {
  return new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();
}

// Reads a date as "2026-10-31", "2026.10.31" or "31.10.2026" (day and
// month may have one digit). Returns "YYYY-MM-DD", or null for any other
// format or a day the month does not have.
export function parseDate(text) {
  const s = String(text ?? "").trim();
  let year;
  let month;
  let day;
  let m;
  if ((m = /^([0-9]{4})([-.])([0-9]{1,2})\2([0-9]{1,2})$/.exec(s))) {
    [year, month, day] = [m[1], m[3], m[4]];
  } else if ((m = /^([0-9]{1,2})\.([0-9]{1,2})\.([0-9]{4})$/.exec(s))) {
    [day, month, year] = [m[1], m[2], m[3]];
  } else {
    return null;
  }
  const y = Number(year);
  const mo = Number(month);
  const d = Number(day);
  if (mo < 1 || mo > 12 || y < 1900 || y > 2200) return null;
  const ym = `${year}-${String(mo).padStart(2, "0")}`;
  if (d < 1 || d > daysInMonth(ym)) return null;
  return `${ym}-${String(d).padStart(2, "0")}`;
}

// ---------------------------------------------------------------- metrics

export function monthlyAmount(item) {
  return item.amount / item.everyMonths;
}

// The items that count. An inactive expense stays in the list but counts
// nowhere: not in totals, the FI number or the charts. Income has no
// inactive items.
export function counted(items) {
  return items.filter((item) => item.active !== false);
}

function sum(values) {
  return values.reduce((total, v) => total + v, 0);
}

// One entry per month from the first to the last recorded month, gaps
// included. An account without a value in a month keeps its last value.
// payIn counts only that month's pay-ins; paidIn is the running total.
export function portfolioSeries(store) {
  if (store.records.length === 0) return [];
  const byMonth = new Map();
  for (const record of store.records) {
    const index = monthIndex(record.month);
    if (!byMonth.has(index)) byMonth.set(index, []);
    byMonth.get(index).push(record);
  }
  const indexes = [...byMonth.keys()];
  const first = Math.min(...indexes);
  const last = Math.max(...indexes);
  const latest = new Map(); // account id -> last known value
  const series = [];
  let paidIn = 0;
  for (let index = first; index <= last; index++) {
    let payIn = 0;
    for (const record of byMonth.get(index) ?? []) {
      latest.set(record.account, record.value);
      payIn += record.payIn;
    }
    paidIn += payIn;
    series.push({ month: monthFromIndex(index), value: sum([...latest.values()]), payIn, paidIn });
  }
  return series;
}

// Average monthly pay-in over the last 12 months of the series (fewer when
// the history is shorter). Returns { average, months } or null.
export function averagePayIn(series, window = 12) {
  if (series.length === 0) return null;
  const recent = series.slice(-window);
  return { average: sum(recent.map((m) => m.payIn)) / recent.length, months: recent.length };
}

// Current numbers for the dashboard. Amounts are in cents and may carry
// fractions of a cent; round when displaying. Ratios are fractions (0.25).
export function metrics(store) {
  const { withdrawalRate, bufferPercent } = store.settings;
  const income = sum(store.income.map(monthlyAmount));
  const baseExpenses = sum(counted(store.expenses).map(monthlyAmount));
  const buffer = (baseExpenses * bufferPercent) / 100;
  const expenses = baseExpenses + buffer;
  const multiple = 100 / withdrawalRate;
  const fiNumber = expenses * 12 * multiple;
  const series = portfolioSeries(store);
  const last = series.at(-1) ?? null;
  const payIn = averagePayIn(series);
  return {
    income,
    baseExpenses,
    buffer,
    expenses,
    multiple,
    fiNumber,
    series,
    latestMonth: last ? last.month : null,
    portfolio: last ? last.value : null,
    payIn,
    investmentRate: payIn && income > 0 ? payIn.average / income : null,
    fiProgress: last && fiNumber > 0 ? last.value / fiNumber : null,
  };
}

// Groups expenses or income by category, largest monthly total first.
export function byCategory(items) {
  const groups = new Map();
  for (const item of items) {
    const key = item.category;
    if (!groups.has(key)) groups.set(key, { category: key, monthly: 0, items: [] });
    const group = groups.get(key);
    group.monthly += monthlyAmount(item);
    group.items.push(item);
  }
  const list = [...groups.values()];
  for (const group of list) {
    group.items.sort((a, b) => monthlyAmount(b) - monthlyAmount(a) || a.name.localeCompare(b.name));
  }
  return list.sort((a, b) => b.monthly - a.monthly || a.category.localeCompare(b.category));
}

export function categoryUse(store, kind, name) {
  return store[kind].filter((item) => item.category === name).length;
}

// ---------------------------------------------------------------- changes
// Each returns a new store and leaves the old one untouched.

export function newId() {
  return globalThis.crypto.randomUUID();
}

function sortRecords(store, records) {
  const order = new Map(store.accounts.map((a, i) => [a.id, i]));
  return records.sort((a, b) => a.month.localeCompare(b.month) || order.get(a.account) - order.get(b.account));
}

export function saveItem(store, kind, item) {
  const next = structuredClone(store);
  const at = next[kind].findIndex((existing) => existing.id === item.id);
  if (at === -1) next[kind].push({ ...item });
  else next[kind][at] = { ...item };
  return next;
}

export function deleteItem(store, kind, id) {
  const next = structuredClone(store);
  next[kind] = next[kind].filter((item) => item.id !== id);
  return next;
}

export function findAccount(store, name) {
  const key = name.trim().toLowerCase();
  return store.accounts.find((a) => a.name.toLowerCase() === key) ?? null;
}

// Returns { ok: true, store } or { ok: false, error }.
export function saveAccount(store, id, name) {
  const clean = name.trim();
  if (clean === "") return { ok: false, error: "Enter a name" };
  const other = findAccount(store, clean);
  if (other && other.id !== id) return { ok: false, error: `"${clean}" already exists` };
  const next = structuredClone(store);
  const account = next.accounts.find((a) => a.id === id);
  if (account) account.name = clean;
  else next.accounts.push({ id: id ?? newId(), name: clean });
  return { ok: true, store: next };
}

export function deleteAccount(store, id) {
  const next = structuredClone(store);
  next.accounts = next.accounts.filter((a) => a.id !== id);
  next.records = next.records.filter((r) => r.account !== id);
  return next;
}

// entries: [{ account, value, payIn }] where value null removes that
// account's record for the month.
export function saveMonth(store, month, entries) {
  const next = structuredClone(store);
  const changed = new Set(entries.map((e) => e.account));
  const records = next.records.filter((r) => !(r.month === month && changed.has(r.account)));
  for (const entry of entries) {
    if (entry.value === null) continue;
    records.push({ month, account: entry.account, value: entry.value, payIn: entry.payIn });
  }
  next.records = sortRecords(next, records);
  return next;
}

export function deleteMonth(store, month) {
  const next = structuredClone(store);
  next.records = next.records.filter((r) => r.month !== month);
  return next;
}

export function saveSettings(store, settings) {
  const next = structuredClone(store);
  next.settings = { ...next.settings, ...settings };
  return next;
}

// Adds a category (oldName null) or renames one, and with it every expense
// or income that has it. Names are unique, ignoring case.
// Returns { ok: true, store } or { ok: false, error }.
export function saveCategory(store, kind, oldName, name) {
  const clean = String(name ?? "").trim();
  if (clean === "") return { ok: false, error: "Enter a name" };
  const list = store.categories[kind];
  if (oldName !== null && !list.includes(oldName)) return { ok: false, error: `"${oldName}" no longer exists` };
  const other = list.find((c) => c.toLowerCase() === clean.toLowerCase());
  if (other !== undefined && other !== oldName) return { ok: false, error: `"${other}" already exists` };
  const next = structuredClone(store);
  if (oldName === null) {
    next.categories[kind].push(clean);
  } else {
    next.categories[kind] = next.categories[kind].map((c) => (c === oldName ? clean : c));
    for (const item of next[kind]) if (item.category === oldName) item.category = clean;
  }
  next.categories[kind].sort(compareNames);
  return { ok: true, store: next };
}

// Removes a category; what had it is left without one.
export function deleteCategory(store, kind, name) {
  const next = structuredClone(store);
  next.categories[kind] = next.categories[kind].filter((c) => c !== name);
  for (const item of next[kind]) if (item.category === name) item.category = "";
  return next;
}

// ---------------------------------------------------------------- CSV import

const COLUMN_NAMES = {
  date: ["date"],
  account: ["account", "broker"],
  value: ["value"],
  payIn: ["payin", "payins", "deposit", "deposits"],
};

// Splits CSV text into rows of fields. Handles quotes ("a ""b""") and
// picks the delimiter (; tab ,) that the first line uses most.
export function parseCsv(text) {
  const source = String(text).replace(/^﻿/, "");
  const firstLine = source.split(/\r?\n/).find((line) => line.trim() !== "") ?? "";
  const unquoted = firstLine.replace(/"[^"]*"/g, "");
  const counts = [";", "\t", ","].map((d) => [d, unquoted.split(d).length - 1]);
  counts.sort((a, b) => b[1] - a[1]);
  const delimiter = counts[0][1] > 0 ? counts[0][0] : ",";

  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  let line = 1;
  let rowLine = 1;
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (quoted) {
      if (c === '"' && source[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') {
        quoted = false;
      } else {
        if (c === "\n") line++;
        field += c;
      }
    } else if (c === '"' && field === "") {
      quoted = true;
    } else if (c === delimiter) {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && source[i + 1] === "\n") i++;
      row.push(field);
      rows.push({ line: rowLine, fields: row });
      row = [];
      field = "";
      line++;
      rowLine = line;
    } else {
      field += c;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push({ line: rowLine, fields: row });
  }
  return { delimiter, rows: rows.filter((r) => r.fields.some((f) => f.trim() !== "")) };
}

// Checks CSV text with the columns date, account, value and (optional)
// pay_in. A row counts for the month of its date. Returns { errors, entries, newAccounts, added, replaced }; import
// only when errors is empty.
export function planImport(store, text) {
  const errors = [];
  const { rows, delimiter } = parseCsv(text);
  if (rows.length === 0) return { errors: [{ line: null, message: "The file is empty" }], entries: [], newAccounts: [], added: 0, replaced: 0 };

  const header = rows[0].fields.map((f) => f.trim().toLowerCase().replace(/[^a-z]/g, ""));
  const column = {};
  for (const [key, names] of Object.entries(COLUMN_NAMES)) {
    const at = header.findIndex((h) => names.includes(h));
    if (at !== -1) column[key] = at;
  }
  const missing = ["date", "account", "value"].filter((key) => !(key in column));
  if (missing.length > 0) {
    let message = `The first line must name the columns date, account, value and pay_in (missing: ${missing.join(", ")})`;
    if (missing.includes("date") && header.includes("month")) message += ". The month column is now date, with a whole date such as 2026-10-31";
    return { errors: [{ line: rows[0].line, message }], entries: [], newAccounts: [], added: 0, replaced: 0 };
  }

  const entries = [];
  const seen = new Map();
  for (const { line, fields } of rows.slice(1)) {
    const extra = fields.slice(header.length);
    if (fields.length < header.length || extra.some((f) => f.trim() !== "")) {
      let message = `Expected ${header.length} columns, found ${fields.length}`;
      if (delimiter === ",") message += ". Put amounts with a decimal comma in quotes, or use semicolons between columns";
      errors.push({ line, message });
      continue;
    }
    const date = parseDate(fields[column.date]);
    const month = date?.slice(0, 7);
    const accountName = fields[column.account].trim();
    const value = parseMoney(fields[column.value]);
    const payInText = column.payIn === undefined ? "" : fields[column.payIn].trim();
    const payIn = payInText === "" ? { ok: true, cents: 0 } : parseMoney(payInText);
    if (!month) errors.push({ line, message: `"${fields[column.date].trim()}" is not a date (use 2026-10-31, 2026.10.31 or 31.10.2026)` });
    if (accountName === "") errors.push({ line, message: "The account is empty" });
    if (!value.ok) errors.push({ line, message: `Value: ${value.error}` });
    else if (value.cents < 0) errors.push({ line, message: "Value: must not be negative" });
    if (!payIn.ok) errors.push({ line, message: `Pay-in: ${payIn.error}` });
    if (!month || accountName === "" || !value.ok || value.cents < 0 || !payIn.ok) continue;

    const key = `${month} ${accountName.toLowerCase()}`;
    if (seen.has(key)) {
      errors.push({ line, message: `${accountName} in ${month} is already on line ${seen.get(key)}` });
      continue;
    }
    seen.set(key, line);
    entries.push({ line, month, accountName, value: value.cents, payIn: payIn.cents });
  }

  const newAccounts = [];
  let replaced = 0;
  for (const entry of entries) {
    const account = findAccount(store, entry.accountName);
    if (!account) {
      if (!newAccounts.some((n) => n.toLowerCase() === entry.accountName.toLowerCase())) newAccounts.push(entry.accountName);
    } else if (store.records.some((r) => r.month === entry.month && r.account === account.id)) {
      replaced++;
    }
  }
  return { errors, entries, newAccounts, added: entries.length - replaced, replaced };
}

export function applyImport(store, plan) {
  if (plan.errors.length > 0) throw new Error("Cannot import a file with errors");
  let next = store;
  for (const name of plan.newAccounts) next = saveAccount(next, null, name).store;
  const byMonth = new Map();
  for (const entry of plan.entries) {
    const account = findAccount(next, entry.accountName);
    if (!byMonth.has(entry.month)) byMonth.set(entry.month, []);
    byMonth.get(entry.month).push({ account: account.id, value: entry.value, payIn: entry.payIn });
  }
  for (const [month, entries] of byMonth) next = saveMonth(next, month, entries);
  return next;
}

// ---------------------------------------------------------------- CSV export

// Every monthly value as CSV in the format planImport reads, so an export
// can be imported again. The date is the last day of the month. Amounts have two decimals and no thousands
// separators. With decimal "," the columns are separated by semicolons, as
// spreadsheets with a decimal comma expect.
export function exportCsv(store, { decimal = "." } = {}) {
  const delimiter = decimal === "," ? ";" : ",";
  const names = new Map(store.accounts.map((a) => [a.id, a.name]));
  const amount = (cents) => {
    const abs = Math.abs(cents);
    return `${cents < 0 ? "-" : ""}${Math.floor(abs / 100)}${decimal}${String(abs % 100).padStart(2, "0")}`;
  };
  const field = (text) => (/[";,\t\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text);
  const lines = [["date", "account", "value", "pay_in"].join(delimiter)];
  for (const r of sortRecords(store, [...store.records])) {
    lines.push([`${r.month}-${daysInMonth(r.month)}`, field(names.get(r.account)), amount(r.value), amount(r.payIn)].join(delimiter));
  }
  return lines.join("\n") + "\n";
}
