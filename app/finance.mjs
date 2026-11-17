// Finance logic: the data file format, money and month parsing, metrics, and
// CSV import and export. No DOM here, so `node --test` covers it.
//
// Money is stored as whole cents (integers): hundredths of the currency set
// in settings. Months are "YYYY-MM" strings.

export const VERSION = 15;

export const KINDS = Object.freeze(["expenses", "income"]);

// What an account holds. Only invested accounts are the portfolio: the FI
// number, Time to FI and the forecast count them alone. Net worth counts
// them all, debts (what is still owed) taken off.
export const ACCOUNT_KINDS = Object.freeze(["invested", "cash", "property", "pension", "debt"]);

// How numbers are shown, named by how they write a million.
export const NUMBER_FORMATS = Object.freeze(["1.000.000,00", "1,000,000.00"]);

export const DEFAULT_SETTINGS = Object.freeze({
  withdrawalRate: 4,
  bufferPercent: 10,
  currency: "EUR",
  numberFormat: NUMBER_FORMATS[0],
  expectedReturn: 8, // a year, before inflation
  inflation: 3,
  birthYear: null, // not set until entered; the forecast needs it
  retirementAge: 67,
  emergencyMonths: 6, // the emergency fund to keep in cash, in months of expenses
  // What is paid in a month from now on, in cents, for the investment rate
  // and every projection; null: the average pay-in of the last 12 months.
  // Planned changes (store.payInChanges) take over from their month on.
  futurePayIn: null,
  // Whether projections raise pay-ins by the inflation, like expenses: off,
  // every pay-in stays the same amount of money for good.
  payInsRiseWithInflation: false,
  // What the Forecast's Coast plan still pays in a month once Coast FI is
  // reached, in cents: 0 stops paying in. It stays the same amount of
  // money, also with rising pay-ins.
  coastPayIn: 0,
});

// What the birth year and the retirement age may be.
export const BIRTH_YEARS = Object.freeze({ min: 1900, max: 2100 });
export const RETIREMENT_AGES = Object.freeze({ min: 30, max: 80 });
// What the emergency fund target may be, in months of expenses.
export const EMERGENCY_MONTHS = Object.freeze({ min: 0, max: 60 });
// What the age an expense or income starts or ends at may be.
export const AGES = Object.freeze({ min: 0, max: 120 });

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
    events: [],
    payInChanges: [],
  };
}

// ---------------------------------------------------------------- file format

const STORE_KEYS = ["version", "settings", "categories", "expenses", "income", "accounts", "records", "events", "payInChanges"];
const SETTINGS_KEYS = ["withdrawalRate", "bufferPercent", "currency", "numberFormat", "expectedReturn", "inflation", "birthYear", "retirementAge", "emergencyMonths", "futurePayIn", "payInsRiseWithInflation", "coastPayIn"];
const ITEM_KEYS = ["id", "name", "category", "amount", "everyMonths", "from", "until"];
const EXPENSE_KEYS = [...ITEM_KEYS, "active", "essential"];
const ACCOUNT_KEYS = ["id", "name", "kind"];
const RECORD_KEYS = ["month", "account", "value", "payIn", "oneOff"];
const EVENT_KEYS = ["id", "name", "month", "amount"];
const PAY_IN_CHANGE_KEYS = ["id", "from", "amount"];
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

function isWholeIn(value, { min, max }) {
  return Number.isInteger(value) && value >= min && value <= max;
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

// Version 4 had no expected return, so no time to FI. Upgraded files get
// the default of then: 5 % after inflation (version 7 makes it 8 % before).
function upgradeFromVersion4(value) {
  checkKeys(value.settings, ["withdrawalRate", "bufferPercent", "currency", "numberFormat"], "settings");
  return { ...value, version: 5, settings: { ...value.settings, expectedReturn: 5 } };
}

// Version 5 had no birth year and no retirement age, which the forecast
// uses. Upgraded files get no birth year and the default age.
function upgradeFromVersion5(value) {
  checkKeys(value.settings, ["withdrawalRate", "bufferPercent", "currency", "numberFormat", "expectedReturn"], "settings");
  return { ...value, version: 6, settings: { ...value.settings, birthYear: null, retirementAge: DEFAULT_SETTINGS.retirementAge } };
}

// Up to version 6 the expected return was after inflation and every
// projection was in today's money. Now it is before inflation, and
// projections are in the money of each year: expenses and the FI number
// rise by the inflation. Upgraded files get the default inflation, and that
// much more expected return, so the return after inflation stays about the
// same: 5 % becomes 8 %.
function upgradeFromVersion6(value) {
  checkKeys(value.settings, ["withdrawalRate", "bufferPercent", "currency", "numberFormat", "expectedReturn", "birthYear", "retirementAge"], "settings");
  const { expectedReturn } = value.settings;
  const inflation = DEFAULT_SETTINGS.inflation;
  const settings = { ...value.settings, inflation };
  if (typeof expectedReturn === "number") settings.expectedReturn = Math.min(100, Math.round((expectedReturn + inflation) * 100) / 100);
  return { ...value, version: 7, settings };
}

// Version 7 could not mark expenses as essential, for Lean FI: upgraded
// expenses are not.
function upgradeFromVersion7(value) {
  const next = { ...value, version: 8 };
  if (Array.isArray(value.expenses)) {
    next.expenses = value.expenses.map((item) => (isObject(item) ? { ...item, essential: false } : item));
  }
  return next;
}

// Version 8 had no start or end for expenses and income: every one counted
// all the time. Upgraded expenses still do. Upgraded income ends at
// retirement, as it was never counted after it: income was not in the
// forecast.
function upgradeFromVersion8(value) {
  const next = { ...value, version: 9 };
  for (const kind of KINDS) {
    if (!Array.isArray(value[kind])) continue;
    const until = kind === "income" ? { at: "retirement" } : null;
    next[kind] = value[kind].map((item) => (isObject(item) ? { ...item, from: null, until } : item));
  }
  return next;
}

// Version 9 had no one-off amounts: every pay-in was regular, and no
// one-off was planned.
function upgradeFromVersion9(value) {
  const next = { ...value, version: 10, events: [] };
  if (Array.isArray(value.records)) next.records = value.records.map((record) => (isObject(record) ? { ...record, oneOff: 0 } : record));
  return next;
}

// Version 11 had no emergency fund target: upgraded files get the default.
function upgradeFromVersion11(value) {
  const next = { ...value, version: 12 };
  if (isObject(value.settings)) {
    checkKeys(value.settings, SETTINGS_KEYS.filter((key) => !["emergencyMonths", "futurePayIn", "payInsRiseWithInflation", "coastPayIn"].includes(key)), "settings");
    next.settings = { ...value.settings, emergencyMonths: DEFAULT_SETTINGS.emergencyMonths };
  }
  return next;
}

// Version 12 had no future pay-in: projections go on with the average.
function upgradeFromVersion12(value) {
  const next = { ...value, version: 13 };
  if (isObject(value.settings)) {
    checkKeys(value.settings, SETTINGS_KEYS.filter((key) => !["futurePayIn", "payInsRiseWithInflation", "coastPayIn"].includes(key)), "settings");
    next.settings = { ...value.settings, futurePayIn: DEFAULT_SETTINGS.futurePayIn };
  }
  return next;
}

// Version 13 had one future pay-in for good, the same amount of money every
// month: no changes are planned, and pay-ins don't rise with inflation.
function upgradeFromVersion13(value) {
  if (isObject(value) && "payInChanges" in value) throw new Error('The file has unknown field "payInChanges"');
  const next = { ...value, version: 14, payInChanges: [] };
  if (isObject(value.settings)) {
    checkKeys(value.settings, SETTINGS_KEYS.filter((key) => key !== "payInsRiseWithInflation" && key !== "coastPayIn"), "settings");
    next.settings = { ...value.settings, payInsRiseWithInflation: DEFAULT_SETTINGS.payInsRiseWithInflation };
  }
  return next;
}

// Version 14 kept the amount the Coast plan pays in after Coast FI on the
// Forecast page only, for as long as the page was open: it starts at 0.
function upgradeFromVersion14(value) {
  const next = { ...value, version: 15 };
  if (isObject(value.settings)) {
    checkKeys(value.settings, SETTINGS_KEYS.filter((key) => key !== "coastPayIn"), "settings");
    next.settings = { ...value.settings, coastPayIn: DEFAULT_SETTINGS.coastPayIn };
  }
  return next;
}

// Version 10 had broker accounts only: every account is invested.
function upgradeFromVersion10(value) {
  const next = { ...value, version: 11 };
  if (Array.isArray(value.accounts)) next.accounts = value.accounts.map((account) => (isObject(account) ? { ...account, kind: "invested" } : account));
  return next;
}

// A start or end of an expense or income: null (always), { at: "retirement" },
// { age: whole years } (January of the year of that age) or { month:
// "YYYY-MM" } (a start's first month, an end's last month).
function isBound(value) {
  if (value === null) return true;
  if (!isObject(value)) return false;
  const keys = Object.keys(value);
  if (keys.length !== 1) return false;
  if (keys[0] === "at") return value.at === "retirement";
  if (keys[0] === "age") return isWholeIn(value.age, AGES);
  if (keys[0] === "month") return isMonth(value.month);
  return false;
}

// When a planned pay-in change starts: { month: "YYYY-MM" } or { age: whole
// years } (January of the year of that age), as a start of an expense.
function isPayInStart(value) {
  return isBound(value) && value !== null && !("at" in value);
}

// Checks a parsed data file. Returns { ok: true, store } or { ok: false, error }.
// `null` (no file yet) is an empty store. Older versions are upgraded.
export function parseStore(value) {
  if (value === null) return { ok: true, store: emptyStore() };
  try {
    if (isObject(value) && value.version === 1) value = upgradeFromVersion1(value);
    if (isObject(value) && value.version === 2) value = upgradeFromVersion2(value);
    if (isObject(value) && value.version === 3) value = upgradeFromVersion3(value);
    if (isObject(value) && value.version === 4) value = upgradeFromVersion4(value);
    if (isObject(value) && value.version === 5) value = upgradeFromVersion5(value);
    if (isObject(value) && value.version === 6) value = upgradeFromVersion6(value);
    if (isObject(value) && value.version === 7) value = upgradeFromVersion7(value);
    if (isObject(value) && value.version === 8) value = upgradeFromVersion8(value);
    if (isObject(value) && value.version === 9) value = upgradeFromVersion9(value);
    if (isObject(value) && value.version === 10) value = upgradeFromVersion10(value);
    if (isObject(value) && value.version === 11) value = upgradeFromVersion11(value);
    if (isObject(value) && value.version === 12) value = upgradeFromVersion12(value);
    if (isObject(value) && value.version === 13) value = upgradeFromVersion13(value);
    if (isObject(value) && value.version === 14) value = upgradeFromVersion14(value);
    checkKeys(value, STORE_KEYS, "The file");
    if (Number.isInteger(value.version) && value.version > VERSION) {
      throw new Error(`it was saved by a newer version of Finance (file version ${value.version}); reload the page or update Finance`);
    }
    if (value.version !== VERSION) throw new Error(`unsupported version ${JSON.stringify(value.version)}`);

    checkKeys(value.settings, SETTINGS_KEYS, "settings");
    const { withdrawalRate, bufferPercent, currency, numberFormat, expectedReturn, inflation, birthYear, retirementAge, emergencyMonths, futurePayIn, payInsRiseWithInflation, coastPayIn } = value.settings;
    if (typeof withdrawalRate !== "number" || !(withdrawalRate > 0 && withdrawalRate <= 100)) {
      throw new Error("settings.withdrawalRate must be above 0 and at most 100");
    }
    if (typeof bufferPercent !== "number" || !(bufferPercent >= 0 && bufferPercent <= 100)) {
      throw new Error("settings.bufferPercent must be between 0 and 100");
    }
    if (typeof expectedReturn !== "number" || !(expectedReturn >= 0 && expectedReturn <= 100)) {
      throw new Error("settings.expectedReturn must be between 0 and 100");
    }
    if (typeof inflation !== "number" || !(inflation >= 0 && inflation <= 100)) {
      throw new Error("settings.inflation must be between 0 and 100");
    }
    if (!isCurrency(currency)) throw new Error("settings.currency must be a three-letter code such as EUR");
    if (!NUMBER_FORMATS.includes(numberFormat)) {
      throw new Error(`settings.numberFormat must be ${NUMBER_FORMATS.map((f) => JSON.stringify(f)).join(" or ")}`);
    }
    if (birthYear !== null && !isWholeIn(birthYear, BIRTH_YEARS)) {
      throw new Error(`settings.birthYear must be null or a year from ${BIRTH_YEARS.min} to ${BIRTH_YEARS.max}`);
    }
    if (!isWholeIn(retirementAge, RETIREMENT_AGES)) {
      throw new Error(`settings.retirementAge must be a whole number from ${RETIREMENT_AGES.min} to ${RETIREMENT_AGES.max}`);
    }
    if (!isWholeIn(emergencyMonths, EMERGENCY_MONTHS)) {
      throw new Error(`settings.emergencyMonths must be a whole number from ${EMERGENCY_MONTHS.min} to ${EMERGENCY_MONTHS.max}`);
    }
    if (futurePayIn !== null && !isCents(futurePayIn, { min: 0 })) {
      throw new Error("settings.futurePayIn must be null or a number of cents, not negative");
    }
    if (typeof payInsRiseWithInflation !== "boolean") throw new Error("settings.payInsRiseWithInflation must be true or false");
    if (!isCents(coastPayIn, { min: 0 })) throw new Error("settings.coastPayIn must be a number of cents, not negative");

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
        if (!isBound(item.from)) throw new Error(`${where} from must be null, a month, an age or retirement`);
        if (!isBound(item.until)) throw new Error(`${where} until must be null, a month, an age or retirement`);
        if (kind === "expenses" && typeof item.active !== "boolean") throw new Error(`${where} active must be true or false`);
        if (kind === "expenses" && typeof item.essential !== "boolean") throw new Error(`${where} essential must be true or false`);
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
      if (!ACCOUNT_KINDS.includes(account.kind)) throw new Error(`${where} kind must be ${ACCOUNT_KINDS.join(", ")}`);
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
      if (!isCents(record.oneOff)) throw new Error(`${where} oneOff must be a number of cents`);
    });

    if (!Array.isArray(value.events)) throw new Error("events is not a list");
    const eventIds = new Set();
    value.events.forEach((event, i) => {
      const where = `events[${i}]`;
      checkKeys(event, EVENT_KEYS, where);
      if (!isText(event.id) || event.id === "" || eventIds.has(event.id)) throw new Error(`${where} has a missing or repeated id`);
      eventIds.add(event.id);
      if (!isText(event.name) || event.name === "") throw new Error(`${where} has no name`);
      if (!isMonth(event.month)) throw new Error(`${where} has an invalid month`);
      if (!isCents(event.amount) || event.amount === 0) throw new Error(`${where} amount must be a number of cents other than 0`);
    });

    if (!Array.isArray(value.payInChanges)) throw new Error("payInChanges is not a list");
    const changeIds = new Set();
    const starts = new Set();
    value.payInChanges.forEach((change, i) => {
      const where = `payInChanges[${i}]`;
      checkKeys(change, PAY_IN_CHANGE_KEYS, where);
      if (!isText(change.id) || change.id === "" || changeIds.has(change.id)) throw new Error(`${where} has a missing or repeated id`);
      changeIds.add(change.id);
      if (!isPayInStart(change.from)) throw new Error(`${where} from must be a month or an age`);
      const start = JSON.stringify(change.from);
      if (starts.has(start)) throw new Error(`${where} starts when another change does`);
      starts.add(start);
      if (change.amount !== null && !isCents(change.amount, { min: 0 })) {
        throw new Error(`${where} amount must be null (the average) or a number of cents, not negative`);
      }
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
// Returns { ok: true, cents } or { ok: false, error }. The error never
// repeats the text, which may be an amount hidden on screen.
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
  if (!/^[0-9.,]+$/.test(s) || !/[0-9]/.test(s)) return { ok: false, error: "Not an amount" };

  const lastDot = s.lastIndexOf(".");
  const lastComma = s.lastIndexOf(",");
  let whole = s;
  let fraction = "";

  if (lastDot !== -1 && lastComma !== -1) {
    const decimal = lastDot > lastComma ? "." : ",";
    const at = s.lastIndexOf(decimal);
    whole = s.slice(0, at);
    fraction = s.slice(at + 1);
    if (whole.includes(decimal)) return { ok: false, error: "Not an amount" };
    whole = groupedWhole(whole, decimal === "." ? "," : ".");
    if (whole === null) return { ok: false, error: "Misplaced thousands separators" };
  } else if (lastDot !== -1 || lastComma !== -1) {
    const sep = lastDot !== -1 ? "." : ",";
    const parts = s.split(sep);
    if (parts.length > 2) {
      whole = groupedWhole(s, sep);
      if (whole === null) return { ok: false, error: "Misplaced thousands separators" };
    } else if (parts[1].length === 3) {
      if (/^0*$/.test(parts[0])) return { ok: false, error: "More than two decimals" };
      whole = groupedWhole(s, sep);
      if (whole === null) return { ok: false, error: "Misplaced thousands separators" };
    } else {
      whole = parts[0];
      fraction = parts[1];
    }
  }

  if (whole === "") whole = "0";
  if (!/^[0-9]+$/.test(whole) || !/^[0-9]{0,2}$/.test(fraction)) {
    return { ok: false, error: fraction.length > 2 ? "More than two decimals" : "Not an amount" };
  }
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(cents) || cents >= MAX_CENTS) return { ok: false, error: "Too large" };
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

// ---------------------------------------------------------------- budget
// What counts in a month: the one rule for which expenses and income count
// when, and for the buffer. Pages read budget(); the projections loop over
// needIn, its fast form.

export function monthlyAmount(item) {
  return item.amount / item.everyMonths;
}

// The month index retirement starts in: January of the year of the
// retirement age. Infinity without a year of birth.
export function retirementIndex({ birthYear, retirementAge }) {
  return birthYear == null ? Infinity : (birthYear + retirementAge) * 12;
}

// The month index a start or end falls on, where `retirement` is the month
// index retirement starts in. A start is the first month that counts; an
// end the first month that no longer does (the month after an end month).
// An age without a year of birth is never reached.
function boundIndex(bound, end, birthYear, retirement) {
  if (bound === null) return end ? Infinity : -Infinity;
  if (bound.at === "retirement") return retirement;
  if ("age" in bound) return birthYear == null ? Infinity : (birthYear + bound.age) * 12;
  return monthIndex(bound.month) + (end ? 1 : 0);
}

// The months an expense or income counts in, as month indexes: from (the
// first) and until (the first after the last); -Infinity and Infinity when
// open.
export function itemWindow(item, birthYear, retirement) {
  return {
    from: boundIndex(item.from ?? null, false, birthYear, retirement),
    until: boundIndex(item.until ?? null, true, birthYear, retirement),
  };
}

// Where an expense or income stands in the month of `index` when retirement
// starts in the month of `retirement`: "now" (it counts), "later" (it
// starts after), "ended", or "inactive" (an expense switched off, which
// counts nowhere).
function statusIn(item, index, birthYear, retirement) {
  if (item.active === false) return "inactive";
  const { from, until } = itemWindow(item, birthYear, retirement);
  if (from <= index && index < until) return "now";
  return from > index ? "later" : "ended";
}

const countsIn = (item, index, birthYear, retirement) => statusIn(item, index, birthYear, retirement) === "now";

// The buffer on `amount` of expenses.
const bufferOn = (amount, settings) => (amount * settings.bufferPercent) / 100;

// The budget of the month of `index` when retirement starts in the month of
// `retirement` (by default when the settings say). Amounts are a month, in
// today's money, and may carry fractions of a cent.
// Returns {
//   expenses: { now, later, ended, inactive: the expenses by where they
//     stand (statusIn), in the store's order; monthly: those that count,
//     without the buffer; buffer; total: with it; essential: { monthly,
//     total } for the essential ones },
//   income: { now, later, ended, inactive (always empty), monthly },
//   need: what the portfolio pays when retired then: the total less the
//     income, never below 0,
//   essentialNeed: the same for the essential expenses only (Lean FI),
// }
export function budget(store, index, retirement = retirementIndex(store.settings)) {
  const { settings } = store;
  const sorted = (items) => {
    const lists = { now: [], later: [], ended: [], inactive: [] };
    for (const item of items) lists[statusIn(item, index, settings.birthYear, retirement)].push(item);
    return lists;
  };
  const expenses = sorted(store.expenses);
  const income = sorted(store.income);
  const monthly = sum(expenses.now.map(monthlyAmount));
  const essential = sum(expenses.now.filter((item) => item.essential).map(monthlyAmount));
  const total = monthly + bufferOn(monthly, settings);
  const essentialTotal = essential + bufferOn(essential, settings);
  const incomeMonthly = sum(income.now.map(monthlyAmount));
  return {
    expenses: { ...expenses, monthly, buffer: bufferOn(monthly, settings), total, essential: { monthly: essential, total: essentialTotal } },
    income: { ...income, monthly: incomeMonthly },
    need: Math.max(0, total - incomeMonthly),
    essentialNeed: Math.max(0, essentialTotal - incomeMonthly),
  };
}

// budget(store, index, retirement).need, or .essentialNeed with essential,
// without the lists: the projections ask for it month after month.
export function needIn(store, index, retirement, { essential = false } = {}) {
  const { birthYear } = store.settings;
  const counts = (item) => countsIn(item, index, birthYear, retirement);
  const expenses = sum(store.expenses.filter((item) => counts(item) && (!essential || item.essential)).map(monthlyAmount));
  const income = sum(store.income.filter(counts).map(monthlyAmount));
  return Math.max(0, expenses + bufferOn(expenses, store.settings) - income);
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

// ---------------------------------------------------------------- metrics

// One entry per month from the first to the last recorded month, gaps
// included. An account without a value in a month keeps its last value.
// payIn counts only that month's regular pay-ins, oneOff its one-off ones
// (an inheritance in, a house deposit out): those count as paid in, but not
// for the average pay-in. invested is the running total of what went into
// the accounts: each account's value in its first month (what it held when
// tracking began), then its pay-ins and one-offs. value - invested is the
// gain since tracking began.
// Only invested accounts count; see netWorthSeries for all of them.
export function portfolioSeries(store) {
  const portfolio = new Set(store.accounts.filter((a) => (a.kind ?? "invested") === "invested").map((a) => a.id));
  const records = store.records.filter((record) => portfolio.has(record.account));
  if (records.length === 0) return [];
  const byMonth = new Map();
  for (const record of records) {
    const index = monthIndex(record.month);
    if (!byMonth.has(index)) byMonth.set(index, []);
    byMonth.get(index).push(record);
  }
  const indexes = [...byMonth.keys()];
  const first = Math.min(...indexes);
  const last = Math.max(...indexes);
  const latest = new Map(); // account id -> last known value
  const series = [];
  let invested = 0;
  for (let index = first; index <= last; index++) {
    let payIn = 0;
    let oneOff = 0;
    for (const record of byMonth.get(index) ?? []) {
      // The first value already holds that month's pay-in.
      invested += latest.has(record.account) ? record.payIn + (record.oneOff ?? 0) : record.value;
      latest.set(record.account, record.value);
      payIn += record.payIn;
      oneOff += record.oneOff ?? 0;
    }
    series.push({ month: monthFromIndex(index), value: sum([...latest.values()]), payIn, oneOff, invested });
  }
  return series;
}

// Net worth by month, from the first to the last month with a value of any
// account: each account with its last value, as in portfolioSeries.
// Returns [{ month, total, kinds: { invested, cash, property, pension, debt
// } }], total being all of them less the debts.
export function netWorthSeries(store) {
  if (store.records.length === 0) return [];
  const kindOf = new Map(store.accounts.map((a) => [a.id, a.kind ?? "invested"]));
  const byMonth = new Map();
  for (const record of store.records) {
    const index = monthIndex(record.month);
    if (!byMonth.has(index)) byMonth.set(index, []);
    byMonth.get(index).push(record);
  }
  const indexes = [...byMonth.keys()];
  const latest = new Map();
  const series = [];
  for (let index = Math.min(...indexes); index <= Math.max(...indexes); index++) {
    for (const record of byMonth.get(index) ?? []) latest.set(record.account, record.value);
    const kinds = Object.fromEntries(ACCOUNT_KINDS.map((kind) => [kind, 0]));
    for (const [account, value] of latest) kinds[kindOf.get(account)] += value;
    series.push({ month: monthFromIndex(index), total: kinds.invested + kinds.cash + kinds.property + kinds.pension - kinds.debt, kinds });
  }
  return series;
}

// How long `cash` pays `expenses` (a month): { cash, months (null without
// expenses), target (months), short (what is missing to the target, 0 when
// none) }.
export function emergencyFund(cash, expenses, target) {
  return { cash, months: expenses > 0 ? cash / expenses : null, target, short: Math.max(0, target * expenses - cash) };
}

// Average monthly pay-in over the last 12 months of the series (fewer when
// the history is shorter). Returns { average, months } or null.
export function averagePayIn(series, window = 12) {
  if (series.length === 0) return null;
  const recent = series.slice(-window);
  return { average: sum(recent.map((m) => m.payIn)) / recent.length, months: recent.length };
}

// What is paid in a month from the latest month on, for the investment
// rate and every projection: the amount set in Settings, or else the
// average pay-in of the portfolioSeries `series`. Returns { amount, months }
// where months is how many months the average is of, null for the amount
// set; null without either.
export function futurePayIn(settings, series) {
  return payInAmount(settings.futurePayIn, series);
}

// An amount of cents, or null for the average pay-in of `series`, as
// futurePayIn returns it.
function payInAmount(amount, series) {
  if (amount !== null) return { amount, months: null };
  const average = averagePayIn(series);
  return average && { amount: average.average, months: average.months };
}

// The month index a planned pay-in change starts in: its month, or January
// of the year of its age (never without a year of birth).
export function payInChangeIndex(change, birthYear) {
  return boundIndex(change.from, false, birthYear, Infinity);
}

// What is paid in month by month after `start` (the latest month with
// values): the future pay-in (futurePayIn) until the first planned change,
// then each change's amount (the average pay-in for null) from its month
// on, until the next one. A change from the month after `start` or before
// is what is paid in from the start. Amounts are as typed, the same every
// month; projections raise them by the inflation when the settings say.
// Returns {
//   now: what is paid in the month after `start`: { amount, months (of
//     the average; null for an amount of your own), change (the planned
//     change it comes from, or null) }, or null with no pay-ins yet;
//   changes: the planned changes after that, in order, each { change,
//     index (its first month), amount, months } as now, the amount null
//     when it is the average and there are no pay-ins yet;
//   at(index): what is paid in the month of `index` after `start`, in
//     whole cents, never below 0: a withdrawal counts as nothing paid in.
// }
export function payInPlan(store, series, start) {
  const next = monthIndex(start) + 1;
  const steps = store.payInChanges
    .map((change) => ({ change, index: payInChangeIndex(change, store.settings.birthYear), ...(payInAmount(change.amount, series) ?? { amount: null, months: null }) }))
    .filter((step) => Number.isFinite(step.index))
    .sort((a, b) => a.index - b.index);
  const started = steps.filter((step) => step.index <= next).at(-1);
  const base = futurePayIn(store.settings, series);
  const now = started ? (started.amount === null ? null : { amount: started.amount, months: started.months, change: started.change }) : base && { ...base, change: null };
  const changes = steps.filter((step) => step.index > next);
  const paid = (amount) => Math.max(0, Math.round(amount ?? 0));
  const first = paid(now?.amount);
  return {
    now,
    changes,
    at(index) {
      let amount = first;
      for (const step of changes) {
        if (step.index > index) break;
        amount = paid(step.amount);
      }
      return amount;
    },
  };
}

// The longest projection: 100 years.
export const MAX_PROJECTION_MONTHS = 1200;

// A yearly rate in percent as a monthly one that compounds to it: 12 % a
// year is about 0.95 % a month, not 1 %.
export function monthlyRate(percent) {
  return (1 + percent / 100) ** (1 / 12) - 1;
}

// Projections are in the money of each month. Pay-ins stay as they are:
// the average they may come from rises on its own when they do. Expenses and
// the FI number rise by the inflation: `amount` (today's) `months` from now.
export function inflated(amount, inflation, months) {
  return amount * (1 + monthlyRate(inflation)) ** months;
}

// An amount `months` after a start in the money of that start: what it
// would buy then, with `inflation` percent a year taken out.
export function deflated(amount, inflation, months) {
  return amount / (1 + monthlyRate(inflation)) ** months;
}

// ---------------------------------------------------------------- returns

// The portfolioSeries of one account: its values, pay-ins and one-offs.
// With `until` (a month), it goes on to that month with its last value, as
// the portfolio counts it, so its returns cover the same months.
export function accountSeries(store, accountId, until = null) {
  const series = portfolioSeries({
    ...store,
    accounts: store.accounts.filter((a) => a.id === accountId).map((a) => ({ ...a, kind: "invested" })),
    records: store.records.filter((r) => r.account === accountId),
  });
  while (until !== null && series.length > 0 && series.at(-1).month < until) {
    const last = series.at(-1);
    series.push({ month: addMonths(last.month, 1), value: last.value, payIn: 0, oneOff: 0, invested: last.invested });
  }
  return series;
}

// Each month's return of a portfolioSeries after its first month (Modified
// Dietz): the change in value less what went in, ÷ the value at the start
// of the month plus half of what went in (paid in during the month). What
// went in is the change in `invested`: pay-ins, one-offs, and what an
// account held in its first month. A month with nothing in the account and
// nothing going in is 0; rate is null only when the value changed without
// anything invested. Returns [{ month, rate }].
export function monthlyReturns(series) {
  const returns = [];
  for (let i = 1; i < series.length; i++) {
    const start = series[i - 1].value;
    const flow = series[i].invested - series[i - 1].invested;
    const base = start + flow / 2;
    const gain = series[i].value - start - flow;
    returns.push({ month: series[i].month, rate: base > 0 ? gain / base : gain === 0 ? 0 : null });
  }
  return returns;
}

// The time-weighted return of the last `months` of monthly returns (all
// with null), chained: what the investments did, whenever money went in or
// out. A year a year when `annual` and over 12 months or more. null when
// there are fewer months, or one has no rate.
export function timeWeighted(returns, months = null, { annual = false } = {}) {
  const window = months === null ? returns : returns.slice(-months);
  if (window.length === 0 || (months !== null && window.length < months) || window.some((r) => r.rate === null)) return null;
  const total = window.reduce((product, r) => product * (1 + r.rate), 1);
  return annual && window.length >= 12 ? total ** (12 / window.length) - 1 : total - 1;
}

// The time-weighted return of this year so far: the months of the latest
// month's year. null without one.
export function yearToDate(returns) {
  if (returns.length === 0) return null;
  const year = returns.at(-1).month.slice(0, 4);
  return timeWeighted(returns, returns.filter((r) => r.month.startsWith(year)).length || null);
}

// The money-weighted return of a portfolioSeries, a year (an internal rate
// of return): the rate at which what went in, from what was there in the
// first month on, grows to the latest value. What went in during a month
// counts from its middle. Found as a monthly rate, from -99,99 % to
// +1000 % a month, so short histories with large moves have one too; a year
// from 12 months on, over the whole time before, as timeWeighted. null
// with less than two months or no rate.
export function moneyWeighted(series) {
  if (series.length < 2) return null;
  const flows = [{ at: 0, amount: -series[0].value }];
  for (let i = 1; i < series.length; i++) flows.push({ at: i - 0.5, amount: -(series[i].invested - series[i - 1].invested) });
  flows.push({ at: series.length - 1, amount: series.at(-1).value });
  // The sign of the flows' present value at a monthly growth of e^g - 1.
  // Each flow is discounted by e^(-g × at); all are scaled by the largest
  // of those, which leaves the sign alone and keeps every term finite over
  // long histories.
  const npvSign = (g) => {
    const exponents = flows.map((f) => -g * f.at);
    const top = Math.max(...exponents);
    return Math.sign(flows.reduce((total, f, i) => total + f.amount * Math.exp(exponents[i] - top), 0));
  };
  let low = Math.log(1e-4);
  let high = Math.log(11);
  if (npvSign(low) === npvSign(high)) return null;
  for (let i = 0; i < 200; i++) {
    const mid = (low + high) / 2;
    if (npvSign(mid) === npvSign(low)) low = mid;
    else high = mid;
  }
  const months = series.length - 1;
  return Math.exp(((low + high) / 2) * (months >= 12 ? 12 : months)) - 1;
}

// What the portfolioSeries `series` returned: this year, the last 1, 3 and
// 5 years (3 and 5 a year), since its first month (a year from 12 months
// on), and money-weighted since then. Fractions; null where too short.
export function returnsOf(series) {
  const returns = monthlyReturns(series);
  return {
    since: series[0]?.month ?? null,
    months: returns.length,
    ytd: yearToDate(returns),
    year: timeWeighted(returns, 12),
    three: timeWeighted(returns, 36, { annual: true }),
    five: timeWeighted(returns, 60, { annual: true }),
    all: timeWeighted(returns, null, { annual: true }),
    moneyWeighted: moneyWeighted(series),
  };
}

// What the portfolio gained over the last `window` months besides pay-ins:
// the change in value minus what was paid in, from the month before the
// window (the first month when there are fewer). rate is a Modified Dietz
// return: the gain ÷ (that first value + each pay-in weighted by the part of
// the time it was invested, from the middle of its month). Returns
// { gain, months, rate } (rate null when nothing was invested), or null
// with less than two months.
export function gains(series, window = 12) {
  if (series.length < 2) return null;
  const months = Math.min(window, series.length - 1);
  const start = series.at(-1 - months);
  const recent = series.slice(-months);
  const paid = (m) => m.payIn + (m.oneOff ?? 0);
  const gain = series.at(-1).value - start.value - sum(recent.map(paid));
  const invested = start.value + sum(recent.map((m, i) => (paid(m) * (months - i - 0.5)) / months));
  return { gain, months, rate: invested > 0 ? gain / invested : null };
}

// The months after `latest` up to last month: values are entered once a
// month is over, so this month never counts. Returns { from, to, count },
// or null when last month has values, or no month has.
export function missingMonths(latest, now = currentMonth()) {
  const to = addMonths(now, -1);
  if (!latest || latest >= to) return null;
  const from = addMonths(latest, 1);
  return { from, to, count: monthIndex(to) - monthIndex(from) + 1 };
}

// Percentage points below and above the expected return for the low and
// high projection on the chart.
export const RETURN_SPREAD = 2;

// The months after `retirement` (indexes) in which what the portfolio pays
// can change: where an expense or income starts or ends.
function changesAfter(store, retirement) {
  const { birthYear } = store.settings;
  const changes = new Set();
  for (const item of [...store.expenses, ...store.income]) {
    if (item.active === false) continue;
    const { from, until } = itemWindow(item, birthYear, retirement);
    for (const at of [from, until]) if (Number.isFinite(at) && at > retirement) changes.add(at);
  }
  return [...changes].sort((a, b) => a - b);
}

// The planned one-offs of the month of `index`, added up: what is paid in
// (or out, below 0) once, in today's money.
export function oneOffsIn(store, index) {
  return sum(store.events.filter((event) => monthIndex(event.month) === index).map((event) => event.amount));
}

// The FI number if retirement starts in the month of `index`, in today's
// money, and how it comes about. What the portfolio pays from the last
// change on (when the last expense or income starts or ends; the month of
// `index` without changes) is `long`, a month; it needs that × 12 × the
// multiple of the withdrawal rate. Until then it pays `extra` on top: each
// month's amount above `long`, added up, such as a bridge until a pension
// starts. Never more than paying the highest monthly amount for good.
// essential: Lean FI's.
// Returns { fiNumber, long, extra, from (the month index of the last
// change, or `index`) }.
export function fiNumberParts(store, index, { essential = false } = {}) {
  const cache = fiCache(store);
  const key = `${index} ${essential}`;
  if (cache.has(key)) return cache.get(key);
  const months = 12 * (100 / store.settings.withdrawalRate);
  const need = (at) => needIn(store, at, index, { essential });
  const changes = changesAfter(store, index);
  const from = changes.at(-1) ?? index;
  const long = need(from);
  let extra = 0;
  let most = long;
  let start = index;
  for (const end of changes) {
    const paid = need(start);
    most = Math.max(most, paid);
    extra += Math.max(0, paid - long) * (end - start);
    start = end;
  }
  const fiNumber = Math.min(long * months + extra, most * months);
  const parts = { fiNumber, long, extra: fiNumber - long * months, from };
  cache.set(key, parts);
  return parts;
}

export function fiNumberIn(store, index, options) {
  return fiNumberParts(store, index, options).fiNumber;
}

// FI numbers once worked out, per store: projections ask for the same months
// again and again. Stores are never changed, only replaced.
const fiCaches = new WeakMap();
function fiCache(store) {
  if (!fiCaches.has(store)) fiCaches.set(store, new Map());
  return fiCaches.get(store);
}

// ---------------------------------------------------------------- Germany

// The state pension (gesetzliche Rente) a month: Rentenpunkte × the value of
// a point (aktueller Rentenwert), 0.3 % less for each month it starts before
// the regular age (at most 48 months) and 0.5 % more for each month after
// it, less what pensioners pay for health and care insurance (percent).
// Amounts in cents. Returns { gross, change (a fraction, -0.144 to …),
// net }.
export function statePension({ points, pointValue, startAge, regularAge, deductions }) {
  const months = (startAge - regularAge) * 12;
  const change = months < 0 ? Math.max(months, -48) * 0.003 : months * 0.005;
  const gross = points * pointValue * (1 + change);
  return { gross, change, net: gross * (1 - deductions / 100) };
}

// Health and care insurance a month as a voluntary member of a statutory
// insurer (freiwillig gesetzlich versichert) without other income: the
// minimum assessment base × the rates (percent). Amounts in cents.
export function healthInsurance({ base, rates }) {
  return (base * sum(rates)) / 100;
}

// Defaults for the helpers, as of 2026: the value of a point from July 2026,
// the minimum assessment base, the reduced general rate (no sick pay), the
// average Zusatzbeitrag, care insurance with and without children, and
// what pensioners pay of it (half the general rate and Zusatzbeitrag, all
// of the care rate).
export const GERMANY_2026 = Object.freeze({
  pointValue: 4252,
  minimumBase: 131833,
  generalRate: 14,
  extraRate: 2.9,
  careRate: 3.6,
  careRateChildless: 4.2,
  pensionerRate: 7.3,
});

// Current numbers for the dashboard, for the month `now`. Amounts are in
// cents and may carry fractions of a cent; round when displaying. Ratios
// are fractions (0.25). Income and expenses are the ones that count now;
// the FI number is for retiring now: the expenses that would count then,
// less the income that would. When the portfolio gets there: fiOutlook.
export function metrics(store, now = currentMonth()) {
  const { withdrawalRate } = store.settings;
  const nowIndex = monthIndex(now);
  const working = budget(store, nowIndex);
  // Retiring now: what counts then.
  const retired = budget(store, nowIndex, nowIndex);
  const income = working.income.monthly;
  const expenses = working.expenses.total;
  const multiple = 100 / withdrawalRate;
  const series = portfolioSeries(store);
  const worth = netWorthSeries(store);
  const last = series.at(-1) ?? null;
  // What is paid in this month, like the income: the plan from the month
  // before on, also when the latest values are older.
  const payIn = payInPlan(store, series, addMonths(now, -1)).now;
  const fiNumber = fiNumberIn(store, nowIndex);
  return {
    // What counts this month (budget).
    budget: working,
    income,
    baseExpenses: working.expenses.monthly,
    buffer: working.expenses.buffer,
    expenses,
    multiple,
    fiNumber,
    // What the portfolio pays a month when retiring now, with the buffer,
    // and how the FI number comes about (fiNumberParts).
    retiredNeed: retired.need,
    fiParts: fiNumberParts(store, nowIndex),
    series,
    // Net worth in the latest month with any value, and the month before.
    netWorth: worth.slice(-2),
    // The emergency fund: the cash accounts' latest values, in months of
    // this month's expenses, and how much is missing to the target. null
    // without a cash account.
    emergency: store.accounts.some((a) => a.kind === "cash")
      ? emergencyFund(worth.at(-1)?.kinds.cash ?? 0, expenses, store.settings.emergencyMonths)
      : null,
    latestMonth: last ? last.month : null,
    portfolio: last ? last.value : null,
    // What is paid in a month from now on (payInPlan's now).
    payIn,
    investmentRate: payIn && income > 0 ? payIn.amount / income : null,
    fiProgress: last && fiNumber > 0 ? last.value / fiNumber : null,
    gains: gains(series),
    // Whole months of expenses the portfolio pays for.
    coveredMonths: last && expenses > 0 ? Math.floor(last.value / expenses) : null,
  };
}

// Where the monthly income goes: expenses with the buffer, the future
// pay-in (withdrawals count as nothing invested), and what is left over. over: how much more than the income those two take. null without
// income.
export function incomeSplit(m) {
  if (!(m.income > 0)) return null;
  const invested = Math.max(0, m.payIn?.amount ?? 0);
  const rest = m.income - m.expenses - invested;
  return { expenses: m.expenses, invested, leftOver: Math.max(0, rest), over: Math.max(0, -rest) };
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

// ---------------------------------------------------------------- forecast
// Every amount in the forecast is in the money of its month: growth is
// before inflation, expenses and the FI number rise by the inflation, and
// what is paid in stays the same.

// The yearly growth rates the forecast compares, in percent: the expected
// return, and RETURN_SPREAD points less and more, as on the dashboard.
export function growthRates(expectedReturn) {
  return { low: expectedReturn - RETURN_SPREAD, mid: expectedReturn, high: expectedReturn + RETURN_SPREAD };
}
export const GROWTHS = Object.freeze(["low", "mid", "high"]);
// The forecast is shown up to the end of the year of this age…
export const SHOWN_AGE = 95;
// …and a plan lasts when money is still left at the end of the year of this
// age.
export const LASTS_AGE = 150;

// keep: pay in until retirement.
// coast: pay in until Coast FI, then the smaller amount until retirement.
// fi: pay in until FI, then live off the portfolio.
// From retirement on, every plan lives off the portfolio: it withdraws the
// monthly expenses of that month.
export const PLANS = Object.freeze(["keep", "coast", "fi"]);

// The age someone born in birthYear has in a month's year.
export function ageIn(month, birthYear) {
  return Number(month.slice(0, 4)) - birthYear;
}

// Month by month, from the value at the end of month `start` on, for the
// three plans. Retirement starts in January of the year of the retirement
// age; without a year of birth (birthYear null) never: every plan pays in
// for good, shown for MAX_PROJECTION_MONTHS, and there is no Coast FI.
// Coast FI is reached in the first month from which paying in only
// `coastContribution` a month makes the portfolio reach the FI number when
// retirement starts. A milestone counts only before retirement.
//
// params: { start (month), value, expenses (a month), fiNumber, birthYear,
// retirementAge, growth (percent a year, before inflation), inflation
// (percent a year), contribution (a month), coastContribution (a month),
// need(index, retirement), goal(index) }. contribution may also be a
// function of the month index: what is paid in that month, in the money of
// then (payInPlan). Amounts in cents; expenses and
// fiNumber in the money of `start`, and rising by the inflation from then
// on. need and goal, when given, replace them month by month: need is what
// the portfolio pays in the month of `index` when retirement starts in the
// month of `retirement` (needIn), goal the FI number for retiring in the
// month of `index` (fiNumberIn), both in today's money. A plan's retirement
// starts with the retirement age, or for Retire early the month after FI.
// oneOffs(index), when given, is what is paid in once in the month of
// `index` (oneOffsIn), in today's money: every plan gets it in its month.
// Coast FI sets aside the money still to go out before retirement, but never
// counts on money still to come in: that only makes it come sooner, once it
// is there.
//
// Returns { months: shown months from start on, retirement: its first
// month (null without), goal: the FI number of each shown month,
// fiAtRetirement: the FI number when retirement starts (null if it has
// already, or without), coastNumber (see the return), plans: { keep,
// coast, fi } } where each plan is { values: one per shown
// month, coastMonth, fiMonth (when reached, or null), atRetirement (value
// when retirement starts, or null if it has already), runsOut (the first
// month with nothing left, or null if it lasts) }.
export function forecast(params) {
  const { start, value, expenses, fiNumber, birthYear, retirementAge, growth, inflation = 0, contribution, coastContribution } = params;
  const need = params.need ?? (() => expenses);
  const goal = params.goal ?? (() => fiNumber);
  const paidIn = typeof contribution === "function" ? contribution : () => contribution;
  const oneOffs = params.oneOffs ?? (() => 0);
  const rate = monthlyRate(growth);
  const first = monthIndex(start);
  const retires = birthYear != null;
  const retirement = retirementIndex({ birthYear, retirementAge });
  const lastShown = retires ? Math.max((birthYear + SHOWN_AGE) * 12 + 11, first + 120) : first + MAX_PROJECTION_MONTHS;
  const lastChecked = retires ? Math.max((birthYear + LASTS_AGE) * 12 + 11, lastShown) : lastShown;
  // What the portfolio pays in the month of `index`, retired from the month
  // of `from`, the FI number of that month, and its one-offs, in the money
  // of then.
  const expensesAt = (index, from) => inflated(need(index, from), inflation, index - first);
  const goalAt = (index) => inflated(goal(index), inflation, index - first);
  const onceAt = (index) => inflated(oneOffs(index), inflation, index - first);
  // The value at the end of the month before retirement is what has to
  // reach the FI number of retiring then.
  const fiAtRetirement = retires ? inflated(goal(retirement), inflation, retirement - 1 - first) : null;

  // The one-offs taken out after `index` until retirement, each grown to
  // when retirement starts (0 or less). Those paid in are left out: like
  // pay-ins, they don't lower what Coast FI needs.
  const outAhead = [];
  for (let index = retires ? retirement - 1 : -Infinity, total = 0; index >= first; index--) {
    outAhead[index - first] = total;
    total += Math.min(0, onceAt(index)) * (1 + rate) ** (retirement - 1 - index);
  }
  // What a month-end value grows to when retirement starts, with `monthly`
  // paid in every month until then, less the one-offs taken out.
  const grown = (v, index, monthly) => {
    const n = retirement - 1 - index;
    const factor = (1 + rate) ** n;
    return v * factor + monthly * (rate === 0 ? n : (factor - 1) / rate) + (outAhead[index - first] ?? 0);
  };

  const months = [];
  const goals = [];
  for (let index = first; index <= lastShown; index++) {
    months.push(monthFromIndex(index));
    goals.push(goalAt(index));
  }

  const run = (plan) => {
    let v = value;
    let phase = "full"; // "full", "coast" (the smaller amount), or "out" (withdrawing)
    let coastMonth = null;
    let fiMonth = null;
    let runsOut = null;
    let retiredFrom = retirement; // Retire early's is the month after FI
    let atRetirement = first === retirement - 1 ? v : null;
    const values = [v];
    // Milestones are checked on month-end values, and change what is paid
    // from the next month on. FI is reached when the value at the end of a
    // month reaches the FI number of retiring the month after, in the
    // money of that month-end.
    const check = (index) => {
      if (index >= retirement) return;
      if (retires && coastMonth === null && grown(v, index, coastContribution) >= fiAtRetirement) {
        coastMonth = monthFromIndex(index);
        if (plan === "coast" && phase === "full") phase = "coast";
      }
      if (fiMonth === null && v >= inflated(goal(index + 1), inflation, index - first)) {
        fiMonth = monthFromIndex(index);
        if (plan === "fi") {
          phase = "out";
          retiredFrom = index + 1;
        }
      }
    };
    check(first);
    for (let index = first + 1; index <= lastChecked; index++) {
      const out = phase === "out" || index >= retirement;
      v = v * (1 + rate) + (out ? -expensesAt(index, retiredFrom) : phase === "coast" ? coastContribution : paidIn(index)) + onceAt(index);
      if (v <= 0) {
        v = 0;
        if (out) runsOut ??= monthFromIndex(index);
      }
      if (index === retirement - 1) atRetirement = v;
      if (index <= lastShown) values.push(v);
      else if (runsOut !== null) break;
      check(index);
    }
    return { values, coastMonth, fiMonth, atRetirement, runsOut };
  };

  const ahead = retires && first < retirement;
  return {
    months,
    retirement: retires ? monthFromIndex(retirement) : null,
    goal: goals,
    fiAtRetirement: ahead ? fiAtRetirement : null,
    // What the portfolio needs at the end of `start` for Coast FI then:
    // grown to when retirement starts, with coastContribution and less the
    // one-offs taken out, it reaches fiAtRetirement. 0 when coastContribution
    // reaches it on its own; null if retirement has started, or without one.
    coastNumber: ahead ? Math.max(0, (fiAtRetirement - grown(0, first, coastContribution)) / (1 + rate) ** (retirement - 1 - first)) : null,
    plans: Object.fromEntries(PLANS.map((plan) => [plan, run(plan)])),
  };
}

// A forecast with every amount in the money of its first month (today's
// money): values, the FI number, and those when retirement starts.
function inTodaysMoney(result, inflation) {
  const first = monthIndex(result.months[0]);
  const before = result.retirement === null ? 0 : monthIndex(result.retirement) - 1 - first; // when retirement starts
  const at = (value, months) => (value === null ? null : deflated(value, inflation, months));
  return {
    ...result,
    goal: result.goal.map(at),
    fiAtRetirement: at(result.fiAtRetirement, before),
    plans: Object.fromEntries(Object.entries(result.plans).map(([name, plan]) =>
      [name, { ...plan, values: plan.values.map(at), atRetirement: at(plan.atRetirement, before) }])),
  };
}

// ---------------------------------------------------------------- FI outlook
// Every FI date the app shows, from one projection: the dashboard's
// milestones, the Path to FI chart and the Forecast page's plans. Each is
// forecast() from the latest month on (this month without one), with:
// - the portfolio then, 0 without one;
// - what is paid in each month (payInPlan) in whole cents, 0 when the
//   average is a withdrawal, raised by the inflation from `start` on when
//   payInsRiseWithInflation is set;
// - the planned one-offs, and the FI number of retiring in each month
//   (never one before `now`);
// - FI at the end of the month in which the portfolio reaches the FI number
//   of retiring the month after;
// - only before retirement, or within MAX_PROJECTION_MONTHS without a year
//   of birth.
//
// Returns {
//   start (month), value, known (whether there is a portfolio value),
//   payIn: { amount, months, change: payInPlan's now (null without
//     pay-ins), invested: what is paid in the month after `start`,
//     withdrawal: that amount is below 0, changes: the planned changes
//     after that, each { month, amount: what is paid in from then on
//     (whole cents, never below 0), average: whether it is the average },
//     rises: whether pay-ins rise with inflation },
//   rates: growthRates, retirement: its first month (null without a year
//     of birth), retired: whether it has started by `start`,
//   fiNumber: for retiring the month after `start`, in today's money,
//   milestones(), path(money), forecast(options): see below.
// }
export function fiOutlook(store, now = currentMonth()) {
  const { birthYear, retirementAge, expectedReturn, inflation } = store.settings;
  const nowIndex = monthIndex(now);
  const series = portfolioSeries(store);
  const last = series.at(-1) ?? null;
  const start = last ? last.month : now;
  const first = monthIndex(start);
  const plan = payInPlan(store, series, start);
  const payIn = plan.now;
  const rises = store.settings.payInsRiseWithInflation;
  const paidIn = (index) => (rises ? inflated(plan.at(index), inflation, index - first) : plan.at(index));
  const value = last ? last.value : 0;
  const known = last !== null;
  const invested = plan.at(first + 1);
  const rates = growthRates(expectedReturn);
  const retirement = retirementIndex(store.settings);
  const retired = first >= retirement;
  const goal = (essential) => (index) => fiNumberIn(store, Math.max(index, nowIndex), { essential });
  const fiNumber = goal(false)(first + 1);

  // forecast() runs, once each.
  const runs = new Map();
  const run = ({ essential = false, growth = "mid", coastContribution = 0 } = {}) => {
    const key = `${essential} ${growth} ${coastContribution}`;
    if (!runs.has(key)) {
      runs.set(key, forecast({
        start, value, birthYear, retirementAge, inflation, coastContribution,
        contribution: paidIn,
        growth: rates[growth],
        need: (index, from) => needIn(store, index, from),
        goal: goal(essential),
        oneOffs: (index) => oneOffsIn(store, index),
      }));
    }
    return runs.get(key);
  };
  // The month FI is reached: Retire early's. Retired already, only `start`,
  // when the portfolio is there.
  const fiMonth = (result, number) => (retired ? (value >= number ? start : null) : result.plans.fi.fiMonth);
  const inMoney = (result, kind) => (kind === "today" ? inTodaysMoney(result, inflation) : result);

  return {
    start,
    value,
    known,
    payIn: {
      amount: payIn?.amount ?? null,
      months: payIn?.months ?? null,
      change: payIn?.change ?? null,
      invested,
      withdrawal: (payIn?.amount ?? 0) < 0,
      changes: plan.changes.map((step) => ({ month: monthFromIndex(step.index), amount: plan.at(step.index), average: step.change.amount === null })),
      rises,
    },
    rates,
    retirement: Number.isFinite(retirement) ? monthFromIndex(retirement) : null,
    retired,
    fiNumber,

    // At the expected return: { coast, lean, fi }. Coast FI is null
    // without a year of birth, once retired, or without an FI number; Lean
    // FI without essential expenses. Each is { fiNumber, progress: the
    // portfolio ÷ that, month: when it is reached (null if not before
    // retirement, or within MAX_PROJECTION_MONTHS), months: from start (0:
    // reached) }; progress, month and months are null without a portfolio,
    // or with an FI number of 0 (nothing to reach). Coast FI's fiNumber is
    // what the portfolio needs at start (forecast's coastNumber, which no
    // pay-in lowers, planned or one-off), and it has fiAtRetirement, the FI
    // number it grows to.
    milestones() {
      const main = run();
      const milestone = (number, result) => {
        const month = known && number > 0 ? fiMonth(result, number) : null;
        return {
          fiNumber: number,
          progress: known && number > 0 ? value / number : null,
          month,
          months: month === null ? null : monthIndex(month) - first,
        };
      };
      const coast = (number, month) => ({
        fiNumber: number,
        progress: known ? (number > 0 ? value / number : 1) : null,
        month: known ? month : null,
        months: known && month !== null ? monthIndex(month) - first : null,
        fiAtRetirement: main.fiAtRetirement,
      });
      const essential = store.expenses.some((item) => item.active !== false && item.essential);
      return {
        coast: main.coastNumber === null || !(fiNumber > 0) ? null : coast(main.coastNumber, main.plans.coast.coastMonth),
        lean: essential ? milestone(goal(true)(first + 1), run({ essential: true })) : null,
        fi: milestone(fiNumber, main),
      };
    },

    // The Path to FI chart, in "nominal" money (of each month) or "today"'s:
    // the portfolio at the expected return and RETURN_SPREAD points less
    // and more, paying in until retirement. null without an FI number.
    // Otherwise { rates, reach: { low, mid, high }, when each reaches FI
    // (as milestones()), points: [{ month, low, mid, high, goal }] }, goal
    // being what FI needs at the end of that month: the FI number of
    // retiring the month after. The points are the months after start the
    // chart shows: until the low
    // one reaches FI (or 1.5 times as long as the mid one, or else the high
    // one) and a little after, at least a year, never from retirement on.
    // None when the portfolio is at FI already.
    path(kind = "nominal") {
      if (!(fiNumber > 0)) return null;
      const results = Object.fromEntries(GROWTHS.map((g) => [g, run({ growth: g })]));
      const reach = Object.fromEntries(GROWTHS.map((g) => [g, fiMonth(results[g], fiNumber)]));
      const after = (month) => (month === null ? null : monthIndex(month) - first);
      let shown = MAX_PROJECTION_MONTHS;
      if (reach.low !== null) shown = after(reach.low);
      else if (reach.mid !== null) shown = after(reach.mid) * 1.5;
      else if (reach.high !== null) shown = after(reach.high) * 1.5;
      const count = reach.mid === start ? 0
        : Math.min(MAX_PROJECTION_MONTHS, Math.max(12, Math.ceil(shown * 1.1)), retirement - 1 - first, results.mid.months.length - 1);
      const lines = Object.fromEntries(GROWTHS.map((g) => [g, inMoney(results[g], kind)]));
      const target = (k) => (kind === "today" ? goal(false)(first + k + 1) : inflated(goal(false)(first + k + 1), inflation, k));
      const points = [];
      for (let k = 1; k <= count; k++) {
        points.push({ month: monthFromIndex(first + k), low: lines.low.plans.keep.values[k], mid: lines.mid.plans.keep.values[k], high: lines.high.plans.keep.values[k], goal: target(k) });
      }
      return { rates, reach, points };
    },

    // The Forecast page's plans: forecast() at `growth` ("low", "mid" or
    // "high"), investing `coastContribution` a month after Coast FI (the
    // coast pay-in from Settings unless given), in "nominal" money or
    // "today"'s.
    forecast({ growth = "mid", coastContribution = store.settings.coastPayIn, money: kind = "nominal" } = {}) {
      return inMoney(run({ growth, coastContribution }), kind);
    },
  };
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

// Adds an expense or income item, or changes the one with its id. Checks the
// item as parseStore does, and that it does not start and end at retirement.
// Returns { ok: true, store } or { ok: false, error }.
export function saveItem(store, kind, item) {
  const error = itemError(store, kind, item);
  if (error) return { ok: false, error };
  const next = structuredClone(store);
  const at = next[kind].findIndex((existing) => existing.id === item.id);
  if (at === -1) next[kind].push({ ...item });
  else next[kind][at] = { ...item };
  return { ok: true, store: next };
}

function itemError(store, kind, item) {
  if (!isText(item.name) || item.name === "") return "Enter a name";
  if (item.category !== "" && !store.categories[kind].includes(item.category)) return `Category "${item.category}" no longer exists`;
  if (!isCents(item.amount, { min: 1 })) return item.amount >= MAX_CENTS ? "Amount is too large" : "Amount must be more than 0";
  if (!Number.isInteger(item.everyMonths) || item.everyMonths < 1 || item.everyMonths > 120) return "Paid every must be whole months from 1 to 120";
  if (!isBound(item.from)) return "Choose when it starts";
  if (!isBound(item.until)) return "Choose when it ends";
  if (item.from?.at === "retirement" && item.until?.at === "retirement") return "It cannot start and end at retirement";
  if (kind === "expenses" && (typeof item.active !== "boolean" || typeof item.essential !== "boolean")) return "Active and essential must be true or false";
  return null;
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
// Adds an account (id null), of `kind` (invested when left out), or renames
// one; with a kind, changes its kind too.
export function saveAccount(store, id, name, kind) {
  const clean = name.trim();
  if (clean === "") return { ok: false, error: "Enter a name" };
  if (kind !== undefined && !ACCOUNT_KINDS.includes(kind)) return { ok: false, error: "Choose what the account holds" };
  const other = findAccount(store, clean);
  if (other && other.id !== id) return { ok: false, error: `"${clean}" already exists` };
  const next = structuredClone(store);
  const account = next.accounts.find((a) => a.id === id);
  if (account) {
    account.name = clean;
    if (kind !== undefined) account.kind = kind;
  } else {
    next.accounts.push({ id: id ?? newId(), name: clean, kind: kind ?? "invested" });
  }
  return { ok: true, store: next };
}

export function deleteAccount(store, id) {
  const next = structuredClone(store);
  next.accounts = next.accounts.filter((a) => a.id !== id);
  next.records = next.records.filter((r) => r.account !== id);
  return next;
}

// entries: [{ account, value, payIn, oneOff }] where value null removes
// that account's record for the month; oneOff is 0 when left out.
export function saveMonth(store, month, entries) {
  const next = structuredClone(store);
  const changed = new Set(entries.map((e) => e.account));
  const records = next.records.filter((r) => !(r.month === month && changed.has(r.account)));
  for (const entry of entries) {
    if (entry.value === null) continue;
    records.push({ month, account: entry.account, value: entry.value, payIn: entry.payIn, oneOff: entry.oneOff ?? 0 });
  }
  next.records = sortRecords(next, records);
  return next;
}

// Adds a planned pay-in change (id null) or changes one: { id, from: { month }
// or { age }, amount: cents, or null for the average }. Returns { ok, store }
// or { ok: false, error }.
export function savePayInChange(store, change) {
  if (!isPayInStart(change.from)) return { ok: false, error: "Choose a month or an age it starts at" };
  if (change.amount !== null && !isCents(change.amount, { min: 0 })) return { ok: false, error: "Enter an amount of 0 or more" };
  const id = change.id ?? newId();
  const same = JSON.stringify(change.from);
  if (store.payInChanges.some((other) => other.id !== id && JSON.stringify(other.from) === same)) {
    return { ok: false, error: "Another change starts then: edit that one" };
  }
  const next = structuredClone(store);
  const saved = { id, from: { ...change.from }, amount: change.amount };
  const at = next.payInChanges.findIndex((c) => c.id === id);
  if (at === -1) next.payInChanges.push(saved);
  else next.payInChanges[at] = saved;
  return { ok: true, store: next };
}

export function deletePayInChange(store, id) {
  const next = structuredClone(store);
  next.payInChanges = next.payInChanges.filter((c) => c.id !== id);
  return next;
}

// Adds a planned one-off (id null) or changes one. Returns { ok, store } or
// { ok: false, error }.
export function saveEvent(store, event) {
  const name = String(event.name ?? "").trim();
  if (name === "") return { ok: false, error: "Enter a name" };
  if (!isMonth(event.month)) return { ok: false, error: "Choose a month" };
  if (!isCents(event.amount) || event.amount === 0) return { ok: false, error: "Enter an amount other than 0" };
  const next = structuredClone(store);
  const saved = { id: event.id ?? newId(), name, month: event.month, amount: event.amount };
  const at = next.events.findIndex((e) => e.id === saved.id);
  if (at === -1) next.events.push(saved);
  else next.events[at] = saved;
  next.events.sort((a, b) => a.month.localeCompare(b.month) || a.name.localeCompare(b.name));
  return { ok: true, store: next };
}

export function deleteEvent(store, id) {
  const next = structuredClone(store);
  next.events = next.events.filter((e) => e.id !== id);
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
  oneOff: ["oneoff", "oneoffs"],
  kind: ["kind"],
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
// pay_in, one_off and kind. A row counts for the month of its date. kind
// is what a new account holds (invested when empty); an account that
// exists keeps its own. Returns { errors, entries, newAccounts, kinds (new
// account name in lower case -> kind), added, replaced }; import only when
// errors is empty.
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
    const oneOffText = column.oneOff === undefined ? "" : fields[column.oneOff].trim();
    const oneOff = oneOffText === "" ? { ok: true, cents: 0 } : parseMoney(oneOffText);
    const kind = column.kind === undefined ? "" : fields[column.kind].trim().toLowerCase();
    if (!month) errors.push({ line, message: `"${fields[column.date].trim()}" is not a date (use 2026-10-31, 2026.10.31 or 31.10.2026)` });
    if (accountName === "") errors.push({ line, message: "The account is empty" });
    if (!value.ok) errors.push({ line, message: `Value: ${value.error}` });
    else if (value.cents < 0) errors.push({ line, message: "Value: must not be negative" });
    if (!payIn.ok) errors.push({ line, message: `Pay-in: ${payIn.error}` });
    if (!oneOff.ok) errors.push({ line, message: `One-off: ${oneOff.error}` });
    const kindOk = kind === "" || ACCOUNT_KINDS.includes(kind);
    if (!kindOk) errors.push({ line, message: `Kind: "${kind}" is not ${ACCOUNT_KINDS.join(", ")}` });
    if (!month || accountName === "" || !value.ok || value.cents < 0 || !payIn.ok || !oneOff.ok || !kindOk) continue;

    const key = `${month} ${accountName.toLowerCase()}`;
    if (seen.has(key)) {
      errors.push({ line, message: `${accountName} in ${month} is already on line ${seen.get(key)}` });
      continue;
    }
    seen.set(key, line);
    entries.push({ line, month, accountName, value: value.cents, payIn: payIn.cents, oneOff: oneOff.cents, kind });
  }

  const newAccounts = [];
  const kinds = {};
  let replaced = 0;
  for (const entry of entries) {
    const account = findAccount(store, entry.accountName);
    const key = entry.accountName.toLowerCase();
    if (!account) {
      if (!newAccounts.some((n) => n.toLowerCase() === key)) newAccounts.push(entry.accountName);
      if (entry.kind !== "") {
        if (kinds[key] !== undefined && kinds[key] !== entry.kind) errors.push({ line: entry.line, message: `${entry.accountName} is ${kinds[key]} on an earlier line` });
        kinds[key] ??= entry.kind;
      }
    } else if (store.records.some((r) => r.month === entry.month && r.account === account.id)) {
      replaced++;
    }
  }
  return { errors, entries, newAccounts, kinds, added: entries.length - replaced, replaced };
}

export function applyImport(store, plan) {
  if (plan.errors.length > 0) throw new Error("Cannot import a file with errors");
  let next = store;
  for (const name of plan.newAccounts) next = saveAccount(next, null, name, plan.kinds?.[name.toLowerCase()] ?? "invested").store;
  const byMonth = new Map();
  for (const entry of plan.entries) {
    const account = findAccount(next, entry.accountName);
    if (!byMonth.has(entry.month)) byMonth.set(entry.month, []);
    byMonth.get(entry.month).push({ account: account.id, value: entry.value, payIn: entry.payIn, oneOff: entry.oneOff });
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
  const kinds = new Map(store.accounts.map((a) => [a.id, a.kind]));
  const lines = [["date", "account", "value", "pay_in", "one_off", "kind"].join(delimiter)];
  for (const r of sortRecords(store, [...store.records])) {
    lines.push([`${r.month}-${daysInMonth(r.month)}`, field(names.get(r.account)), amount(r.value), amount(r.payIn), amount(r.oneOff), kinds.get(r.account)].join(delimiter));
  }
  return lines.join("\n") + "\n";
}
