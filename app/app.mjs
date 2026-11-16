// Finance UI: loads the data from the local server, renders one view at a
// time, and saves every change straight away.

import * as F from "./finance.mjs";
import { goalVisible, renderChart, renderForecastChart } from "./chart.mjs";
import { startUpdates } from "./update.mjs";

// ---------------------------------------------------------------- formatting

// Dates and currency names follow the system language. Numbers follow the
// number format in settings, written as German or US English write them,
// currency and percent signs included: "1.234,56 €" or "€1,234.56".
const locale = navigator.language || "de-DE";
const NUMBER_LOCALES = { "1.000.000,00": "de-DE", "1,000,000.00": "en-US" };
// The withdrawal rate takes more decimals than other numbers, e.g. 3.333333.
const RATE_DECIMALS = 6;
// The CSV export writes numbers the way spreadsheets on this system read
// them, so it follows the system language, not the number format. Only ","
// or ".", the two the CSV import reads.
const decimalSign = new Intl.NumberFormat(locale).formatToParts(1.5).find((part) => part.type === "decimal")?.value === "," ? "," : ".";

// Number formats for the currency and number format in settings; render()
// switches them.
let formatsFor = null;
let percent;
let percentUnit;
let plain;
let plainRate;
let zero;
let whole;
let exact;
let axis;
function useFormats({ currency: code, numberFormat }) {
  if (formatsFor === `${code} ${numberFormat}`) return;
  formatsFor = `${code} ${numberFormat}`;
  const numbers = NUMBER_LOCALES[numberFormat];
  percent = new Intl.NumberFormat(numbers, { style: "percent", maximumFractionDigits: 1 });
  // For settings that are in percent already: 4 is "4 %" or "4%".
  percentUnit = new Intl.NumberFormat(numbers, { style: "unit", unit: "percent", maximumFractionDigits: RATE_DECIMALS });
  plain = new Intl.NumberFormat(numbers, { maximumFractionDigits: 2, useGrouping: false });
  plainRate = new Intl.NumberFormat(numbers, { maximumFractionDigits: RATE_DECIMALS, useGrouping: false });
  zero = new Intl.NumberFormat(numbers, { minimumFractionDigits: 2 }).format(0);
  whole = new Intl.NumberFormat(numbers, { style: "currency", currency: code, maximumFractionDigits: 0 });
  // Two decimals for every currency, since amounts are stored in hundredths.
  exact = new Intl.NumberFormat(numbers, { style: "currency", currency: code, minimumFractionDigits: 2, maximumFractionDigits: 2 });
  axis = new Intl.NumberFormat(numbers, { style: "currency", currency: code, notation: "compact", maximumFractionDigits: 1 });
}
useFormats(F.DEFAULT_SETTINGS);

const money = (cents) => whole.format(Math.round(cents / 100));
const moneyExact = (cents) => exact.format(cents / 100);
const signedMoney = (cents) => (cents > 0 ? "+" : "") + money(cents);
const signedPercent = (fraction) => (fraction > 0 ? "+" : "") + percent.format(fraction);
const inputMoney = (cents) => plain.format(cents / 100);

let currencyNames = null;
try {
  currencyNames = new Intl.DisplayNames([locale], { type: "currency" });
} catch {
  // codes only
}
const currencyName = (code) => currencyNames?.of(code) ?? code;

// A span of time: months under two years, whole years after that.
function duration(months) {
  if (months < 24) return months === 1 ? "1 month" : `${months} months`;
  return `${Math.round(months / 12)} years`;
}

function monthLabel(month, yearOnly = false) {
  const date = new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1, 1);
  const options = yearOnly ? { year: "numeric" } : { month: "short", year: "numeric" };
  return new Intl.DateTimeFormat(locale, options).format(date);
}

const INTERVALS = [
  [1, "Monthly"],
  [2, "Every 2 months"],
  [3, "Quarterly"],
  [6, "Every 6 months"],
  [12, "Yearly"],
  [24, "Every 2 years"],
];
const intervalLabel = (n) => INTERVALS.find(([v]) => v === n)?.[1] ?? `Every ${n} months`;

// The month index of this month, for what counts now.
const thisMonth = () => F.monthIndex(F.currentMonth());

// Expenses or income that count this month.
const countingNow = (kind) => F.countingIn(state.store[kind], thisMonth(), state.store.settings);

// When an expense or income starts and ends, in words: "From age 67",
// "Until retirement", "From Jan. 2027 until Dec. 2031". null when always.
function windowText(item) {
  const part = (bound, end) => {
    if (bound === null) return null;
    const word = end ? "until" : "from";
    if (bound.at === "retirement") return `${word} retirement`;
    if ("age" in bound) return `${word} age ${bound.age}`;
    return `${word} ${monthLabel(bound.month)}`;
  };
  const text = [part(item.from, false), part(item.until, true)].filter(Boolean).join(" ");
  return text ? text[0].toUpperCase() + text.slice(1) : null;
}

const KINDS = {
  expenses: { title: "Expenses", one: "expense", noun: "Regular expenses" },
  income: { title: "Income", one: "income", noun: "Net income" },
};

// What an account holds, in words: in the order of F.ACCOUNT_KINDS.
const ACCOUNT_KIND_LABELS = {
  invested: "Invested (portfolio)",
  cash: "Cash",
  property: "Property",
  pension: "Pension assets",
  debt: "Debt",
};
const kindLabel = (kind) => ACCOUNT_KIND_LABELS[kind] ?? kind;
const isInvested = (account) => account.kind === "invested";

// In this order on Ctrl+1 to Ctrl+6.
const VIEWS = [
  ["dashboard", "Dashboard"],
  ["expenses", "Expenses"],
  ["income", "Income"],
  ["portfolio", "Portfolio"],
  ["forecast", "Forecast"],
  ["settings", "Settings"],
];

// ---------------------------------------------------------------- DOM helper

function h(tag, props, ...children) {
  const el = document.createElement(tag);
  let value;
  for (const [key, v] of Object.entries(props ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (key === "class") el.className = v;
    else if (key === "value") value = v;
    else if (key.startsWith("on")) el.addEventListener(key.slice(2), v);
    else el.setAttribute(key, v === true ? "" : String(v));
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  if (value !== undefined) el.value = value;
  return el;
}

// ---------------------------------------------------------------- state

// The chart view is remembered in this browser only; it is not data.
const CHART_VIEW_KEY = "finance.chartView";
function savedChartView() {
  try {
    return localStorage.getItem(CHART_VIEW_KEY) === "path" ? "path" : "history";
  } catch {
    return "history";
  }
}
function setChartView(view) {
  state.chartView = view;
  try {
    localStorage.setItem(CHART_VIEW_KEY, view);
  } catch {
    // remembered until the window closes
  }
  render();
}

const state = {
  store: null,
  revision: null,
  file: "",
  backups: "", // the directory with the daily copies of the file
  blocked: null, // why nothing can be saved, e.g. an unreadable data file
  notice: null, // { kind: "error" | "info", text }
  view: "dashboard",
  editing: { expenses: null, income: null }, // item id being edited
  editingEvent: null, // planned one-off being edited
  renaming: null, // { list: "accounts" | "expenses" | "income", key: account id or category name }
  month: null,
  importText: "",
  importPlan: null,
  chartView: savedChartView(), // "history" | "path"
  // On the forecast page. contribution null: the average pay-in. growth:
  // "low", "mid" or "high", the expected return and RETURN_SPREAD around it.
  forecast: { contribution: null, coastContribution: 0, growth: "mid" },
  focus: null, // selector to focus after the next render
};

let pending = null; // newest store waiting to be saved
let inFlight = false;
let saves = 0; // successful saves, so a slower reload cannot undo one

async function request(method, body) {
  const response = await fetch("/api/data", {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await response.json();
  } catch {
    // handled below
  }
  return { status: response.status, json };
}

// Takes what the server returned for GET (or a 409) as the current data.
function adopt(json) {
  state.revision = json.revision;
  if (json.file) state.file = json.file;
  if (json.backups) state.backups = json.backups;
  if (json.error) {
    state.blocked = `${json.error}. Nothing is saved until the file at ${state.file} is fixed or moved away.`;
    state.store = null;
    return;
  }
  const result = F.parseStore(json.data);
  if (!result.ok) {
    state.blocked = `Can't read ${state.file}: ${result.error}. Nothing is saved until the file is fixed or moved away.`;
    state.store = null;
    return;
  }
  state.blocked = null;
  state.store = result.store;
}

async function load() {
  try {
    const { status, json } = await request("GET");
    if (status !== 200 || !json) throw new Error(json?.error ?? `HTTP ${status}`);
    adopt(json);
  } catch (error) {
    state.notice = { kind: "error", text: `Can't reach the Finance server (${error.message}). Is the omarchy-finance service running?` };
  }
  render();
}

function commit(next, message) {
  if (state.blocked) return;
  // Never write a file that the next load would refuse.
  const check = F.parseStore(next);
  if (!check.ok) {
    state.notice = { kind: "error", text: `Not saved: ${check.error}.` };
    render();
    return;
  }
  state.store = next;
  pending = next;
  state.notice = message ? { kind: "info", text: message } : null;
  render();
  pump();
}

async function pump() {
  if (inFlight || !pending) return;
  inFlight = true;
  const store = pending;
  pending = null;
  try {
    const { status, json } = await request("PUT", { revision: state.revision, data: store });
    if (status === 200) {
      state.revision = json.revision;
      saves++;
    } else if (status === 409) {
      pending = null;
      adopt(json);
      state.notice = { kind: "error", text: "Another window saved first. This shows the latest data now; please redo your last change." };
      render();
    } else {
      throw new Error(json?.error ?? `HTTP ${status}`);
    }
  } catch (error) {
    pending = null;
    state.notice = { kind: "error", text: `Not saved: ${error.message}. Reload to see what is stored.` };
    render();
  } finally {
    inFlight = false;
    if (pending) pump();
  }
}

// When the window comes back into focus: pick up the theme and any change
// saved from another window.
async function refresh() {
  // Load the theme into a second link and drop the old one once it has
  // loaded, so the colors never flash back to the defaults.
  const old = document.getElementById("theme");
  const theme = old.cloneNode();
  theme.href = `/theme.css?t=${Date.now()}`;
  theme.addEventListener("load", () => {
    old.remove();
    theme.id = "theme";
  });
  theme.addEventListener("error", () => theme.remove());
  theme.removeAttribute("id");
  old.after(theme);

  if (inFlight || pending) return;
  const savesBefore = saves;
  try {
    const { status, json } = await request("GET");
    if (inFlight || pending || saves !== savesBefore) return;
    if (status === 200 && json && json.revision !== state.revision) {
      adopt(json);
      render();
    }
  } catch {
    // the next save reports it
  }
}

addEventListener("focus", refresh);
addEventListener("beforeunload", (event) => {
  if (inFlight || pending) event.preventDefault();
});
addEventListener("hashchange", () => {
  state.view = viewFromHash();
  state.notice = null;
  state.renaming = null;
  render();
  scrollTo(0, 0);
});

// Ctrl+1 to Ctrl+6 open the views. Matched by key position, not by the
// character, so it works the same on every keyboard layout.
addEventListener("keydown", (event) => {
  const digit = /^(?:Digit|Numpad)([1-9])$/.exec(event.code);
  if (!digit || !event.ctrlKey || event.altKey || event.shiftKey || event.metaKey) return;
  const view = VIEWS[Number(digit[1]) - 1];
  if (!view) return;
  event.preventDefault();
  location.hash = view[0];
});

function viewFromHash() {
  const name = location.hash.slice(1);
  return VIEWS.some(([v]) => v === name) ? name : "dashboard";
}

// ---------------------------------------------------------------- render

function render() {
  resizeObserver?.disconnect();
  if (state.store) useFormats(state.store.settings);
  const nav = document.getElementById("nav");
  nav.replaceChildren(
    ...VIEWS.map(([view, label], i) => h("a", {
      href: `#${view}`,
      class: view === state.view ? "active" : null,
      "aria-current": view === state.view ? "page" : null,
      title: `${label} (Ctrl+${i + 1})`,
      "aria-keyshortcuts": `Control+${i + 1}`,
    }, label)),
  );

  const main = document.getElementById("main");
  const content = [];
  if (state.notice) {
    content.push(
      h("div", { class: `notice ${state.notice.kind}`, role: state.notice.kind === "error" ? "alert" : "status" },
        h("span", null, state.notice.text),
        h("button", { class: "link", type: "button", "aria-label": "Dismiss", onclick: () => { state.notice = null; render(); } }, "×")),
    );
  }
  if (state.blocked) {
    content.push(h("div", { class: "notice error", role: "alert" }, h("span", null, state.blocked), h("button", { type: "button", onclick: load }, "Reload")));
  } else if (state.store) {
    const views = {
      dashboard: viewDashboard,
      expenses: () => viewItems("expenses"),
      income: () => viewItems("income"),
      portfolio: viewPortfolio,
      forecast: viewForecast,
      settings: viewSettings,
    };
    content.push(views[state.view]());
  }
  main.replaceChildren(...content);

  if (state.view === "dashboard" && state.store) drawChart();
  if (state.view === "forecast" && state.store) drawForecast();
  if (state.focus) {
    main.querySelector(state.focus)?.focus();
    state.focus = null;
  }
}

function card(title, ...children) {
  return h("section", { class: "card" }, title ? h("h2", null, title) : null, ...children);
}

// Shows a validation message under a form without re-rendering, so nothing
// typed into the form is lost. The next render clears it.
function showError(form, text) {
  let p = form.nextElementSibling;
  if (!p?.classList.contains("form-error")) {
    p = h("p", { class: "form-error", role: "alert" });
    form.after(p);
  }
  p.textContent = text;
}

// ---------------------------------------------------------------- dashboard

function tile(label, value, detail, extra) {
  return h("div", { class: "tile" }, h("div", { class: "tile-label" }, label), h("div", { class: "tile-value" }, value), extra ?? null, h("div", { class: "tile-detail" }, detail));
}

function viewDashboard() {
  const store = state.store;
  const m = F.metrics(store);
  const { withdrawalRate, bufferPercent, expectedReturn } = store.settings;
  const empty = store.income.length === 0 && store.expenses.length === 0 && store.records.length === 0;
  const expenses = F.counted(store.expenses);

  const progress = m.fiProgress === null ? null : h("div", { class: "meter", role: "presentation" }, h("div", { class: "meter-fill" }));
  // Opens the portfolio on the first month without values.
  const missing = F.missingMonths(m.latestMonth);
  const nudge = missing && h("a", { class: "tile-nudge", href: "#portfolio", onclick: () => { state.month = missing.from; } },
    missing.count === 1 ? `${monthLabel(missing.from)} not entered yet` : `${missing.count} months not entered yet`);

  const tiles = h("div", { class: "tiles" },
    tile("Monthly income", store.income.length ? money(m.income) : "–",
      store.income.length ? `net, ${money(m.income * 12)} a year` : h("a", { href: "#income" }, "Add income")),
    tile("Monthly expenses", expenses.length ? money(m.expenses) : "–",
      expenses.length
        ? `incl. ${percentUnit.format(bufferPercent)} buffer (${money(m.buffer)})`
        : h("a", { href: "#expenses" }, store.expenses.length ? "All expenses are inactive" : "Add expenses")),
    tile("Investment rate", m.investmentRate === null ? "–" : percent.format(m.investmentRate),
      m.payIn === null
        ? h("a", { href: "#portfolio" }, "Add pay-ins")
        : `${money(m.payIn.average)} a month paid in, average of ${m.payIn.months === 12 ? "the last 12 months" : m.payIn.months === 1 ? "1 month" : `${m.payIn.months} months`}`),
    tile("Portfolio", m.portfolio === null ? "–" : money(m.portfolio),
      m.series.length >= 2
        ? `${signedMoney(m.portfolio - m.series.at(-2).value)} in ${monthLabel(m.latestMonth)} (${money(m.series.at(-1).payIn)} paid in${m.series.at(-1).oneOff ? `, ${signedMoney(m.series.at(-1).oneOff)} one-off` : ""})`
        : m.latestMonth ? `as of ${monthLabel(m.latestMonth)}` : h("a", { href: "#portfolio" }, "Add broker values"),
      nudge),
    tile(`Gains, last ${m.gains === null || m.gains.months === 12 ? "12 months" : m.gains.months === 1 ? "month" : `${m.gains.months} months`}`,
      m.gains === null ? "–" : signedMoney(m.gains.gain),
      m.gains === null ? "needs values for two months" : m.gains.rate === null ? "change in value minus pay-ins" : `a return of ${percent.format(m.gains.rate)}, not counting pay-ins`),
    tile("Expenses covered", m.coveredMonths === null ? "–" : duration(m.coveredMonths),
      m.coveredMonths === null ? "needs expenses and a portfolio value" : `by the portfolio, at ${money(m.expenses)} a month`),
    tile("FI number", expenses.length ? money(m.fiNumber) : "–",
      [`${plain.format(m.multiple)} × yearly expenses (${percentUnit.format(withdrawalRate)} withdrawal rate)`,
        m.fiParts.extra >= 100
          ? h("div", null, `Retiring now: ${plain.format(m.multiple)} × ${money(m.fiParts.long * 12)} a year from ${monthLabel(F.monthFromIndex(m.fiParts.from), true)} on, `,
              `plus ${money(m.fiParts.extra)} to bridge the years until then`)
          : Math.abs(m.retiredNeed - m.expenses) >= 100
            ? h("div", null, `Retiring now, the portfolio would pay ${money(m.retiredNeed)} a month: the expenses and income that count after retirement`)
            : null,
        m.lean ? h("div", null, `Lean FI: ${money(m.lean.fiNumber)}, for the essential expenses only`) : null]),
    tile("FI reached", m.fiProgress === null ? "–" : percent.format(m.fiProgress),
      [m.fiProgress === null ? "needs expenses and a portfolio value" : m.fiProgress >= 1 ? "Financially independent" : `${money(m.fiNumber - m.portfolio)} to go`,
        m.lean?.progress != null && m.fiProgress < 1
          ? h("div", null, m.lean.progress >= 1 ? "Lean FI reached" : `Lean FI ${percent.format(m.lean.progress)} reached, ${money(m.lean.fiNumber - m.portfolio)} to go`)
          : null],
      progress),
    tile("Time to FI",
      m.fiProgress === null ? "–" : m.fiMonths === 0 ? "Now" : m.fiMonths === null ? "Over 100 years" : duration(m.fiMonths),
      m.fiProgress === null
        ? "needs expenses and a portfolio value"
        : m.fiMonths === 0
          ? `as of ${monthLabel(m.latestMonth)}`
          : [`${m.fiMonths === null ? "" : `around ${monthLabel(m.projection.at(-1).month, m.fiMonths >= 24)}, `}at ${percentUnit.format(expectedReturn)} return and ${money(m.payIn.average)} a month`,
              m.lean?.progress != null && m.lean.progress < 1
                ? h("div", null, `Lean FI: ${m.lean.months === null ? "over 100 years" : `in ${duration(m.lean.months)}`}`)
                : null]),
  );
  if (progress) {
    progress.firstChild.style.width = `${Math.min(100, m.fiProgress * 100)}%`;
    // Where Lean FI is on the way to FI.
    if (m.lean && m.lean.fiNumber < m.fiNumber) {
      const mark = h("div", { class: "meter-mark", title: `Lean FI, ${money(m.lean.fiNumber)}` });
      mark.style.left = `${(m.lean.fiNumber / m.fiNumber) * 100}%`;
      progress.append(mark);
    }
  }

  const parts = [tiles];
  if (empty) {
    parts.push(card("Get started",
      h("p", null, "Add your regular ", h("a", { href: "#income" }, "income"), " and ", h("a", { href: "#expenses" }, "expenses"),
        ", then your ", h("a", { href: "#settings" }, "broker accounts"), " and their ", h("a", { href: "#portfolio" }, "monthly values and pay-ins"), "."),
      h("p", { class: "muted" }, "Currency and categories are in ", h("a", { href: "#settings" }, "Settings"), ".")));
  }

  if (m.series.length > 0) parts.push(portfolioCard(m));

  const breakdown = (kind, total) => {
    const groups = F.byCategory(countingNow(kind));
    if (groups.length === 0) return null;
    const max = groups[0].monthly;
    return card(`${KINDS[kind].title} by category`,
      h("ul", { class: "bars" }, groups.map((g) => {
        const fill = h("div", { class: "bar-fill" });
        fill.style.width = `${(g.monthly / max) * 100}%`;
        return h("li", null,
          h("div", { class: "bar-text" }, h("span", null, g.category || "No category"), h("span", { class: "num" }, `${money(g.monthly)} · ${percent.format(g.monthly / total)}`)),
          h("div", { class: "bar" }, fill));
      })));
  };
  const columns = [incomeCard(m), netWorthCard(m), breakdown("expenses", m.baseExpenses)].filter(Boolean);
  if (columns.length) parts.push(h("div", { class: "columns" }, columns));
  return h("div", null, parts);
}

// A thin bar of the income's parts, and a list with each part's amount and
// share of the income.
function incomeCard(m) {
  const split = F.incomeSplit(m);
  if (!split) return null;
  const { bufferPercent } = state.store.settings;
  const months = m.payIn?.months;
  const parts = [
    ["expenses", "Expenses", `incl. ${percentUnit.format(bufferPercent)} buffer`, split.expenses],
    ["invested", "Invested", m.payIn ? `average pay-in of ${months === 12 ? "the last 12 months" : months === 1 ? "1 month" : `${months} months`}` : null, m.payIn ? split.invested : null],
    ["left", "Left over", null, split.over > 0 ? null : split.leftOver],
  ];
  const bar = h("div", { class: "split", "aria-hidden": "true" });
  for (const [kind, , , amount] of parts) {
    if (!(amount > 0)) continue;
    const part = h("span", { class: `part ${kind}` });
    part.style.flexGrow = String(amount);
    bar.append(part);
  }
  const rows = parts.map(([kind, name, detail, amount]) => {
    if (kind === "left" && amount === null) return null;
    return h("li", null,
      h("span", { class: `swatch ${kind}` }),
      h("span", null, name, detail ? h("span", { class: "sub" }, detail) : null),
      h("span", { class: "num" }, amount === null ? h("a", { href: "#portfolio" }, "Add pay-ins") : `${money(amount)} · ${percent.format(amount / m.income)}`));
  });
  return card("Where the income goes", bar, h("ul", { class: "split-list" }, rows),
    split.over > 0 ? h("p", { class: "muted" }, `Expenses and pay-ins are ${money(split.over)} a month more than the income.`) : null);
}

// Whether an account has its first value in `month`.
function firstEntered(month) {
  const first = new Map();
  for (const r of state.store.records) if (!first.has(r.account) || r.month < first.get(r.account)) first.set(r.account, r.month);
  return [...first.values()].includes(month);
}

// Net worth: every kind of account, debts taken off, with each kind's share.
// Only with other accounts than invested ones: otherwise it is the portfolio.
function netWorthCard(m) {
  if (!state.store.accounts.some((a) => !isInvested(a)) || m.netWorth.length === 0) return null;
  const [before, now] = m.netWorth.length === 2 ? m.netWorth : [null, m.netWorth[0]];
  const largest = Math.max(...F.ACCOUNT_KINDS.map((kind) => now.kinds[kind]));
  const rows = F.ACCOUNT_KINDS.filter((kind) => now.kinds[kind] !== 0 || state.store.accounts.some((a) => a.kind === kind)).map((kind) => {
    const fill = h("div", { class: `bar-fill${kind === "debt" ? " debt" : ""}` });
    fill.style.width = `${largest > 0 ? (now.kinds[kind] / largest) * 100 : 0}%`;
    return h("li", null,
      h("div", { class: "bar-text" }, h("span", null, kindLabel(kind)), h("span", { class: "num" }, money(kind === "debt" ? -now.kinds[kind] || 0 : now.kinds[kind]))),
      h("div", { class: "bar" }, fill));
  });
  return card("Net worth",
    h("div", { class: "big num" }, money(now.total)),
    // An account entered for the first time is no change since the month before.
    h("p", { class: "muted" }, before && !firstEntered(now.month)
      ? `${signedMoney(now.total - before.total)} since ${monthLabel(before.month)}, as of ${monthLabel(now.month)}`
      : `as of ${monthLabel(now.month)}`),
    h("ul", { class: "bars" }, rows));
}

// No active expenses, no FI number: the chart then has no goal line and no
// path to FI.
const chartGoal = (m) => (F.counted(state.store.expenses).length ? m.fiNumber : 0);

function chartView(m) {
  return state.chartView === "path" && chartGoal(m) > 0 ? "path" : "history";
}

function projection(m) {
  const { expectedReturn, inflation } = state.store.settings;
  return F.fiProjection({ month: m.latestMonth, start: m.portfolio, payIn: m.payIn.average, goal: chartGoal(m) > 0 ? m.goal : 0, rate: expectedReturn, inflation, oneOffs: m.oneOffs });
}

function portfolioCard(m) {
  const view = chartView(m);
  const key = (kind, label) => h("span", null, h("span", { class: `key ${kind}` }), label);
  const viewButton = (name, label) =>
    h("button", { type: "button", class: view === name ? "seg active" : "seg", "aria-pressed": String(view === name), onclick: () => setChartView(name) }, label);

  let legend;
  let note;
  if (view === "path") {
    const p = projection(m);
    legend = [key("value", "Portfolio value"),
      p.points.length ? key("projection", `At ${percentUnit.format(p.rates.mid)} a year (${percentUnit.format(p.rates.low)} to ${percentUnit.format(p.rates.high)})`) : null,
      key("goal", "FI number")];
    note = pathSummary(m, p);
  } else {
    legend = [key("value", "Portfolio value"), key("paid", "Paid in"), key("gain", "Gain"),
      m.series.some((s) => s.value < s.invested) ? key("loss", "Loss") : null,
      goalVisible(m.series, chartGoal(m)) ? key("goal", "FI number") : null];
    note = "Paid in starts with what each account held in its first month, so the shading is the gain or loss since then.";
  }

  return h("section", { class: "card" },
    h("div", { class: "card-head" },
      h("h2", null, "Portfolio"),
      h("div", { class: "legend" }, legend),
      chartGoal(m) > 0
        ? h("div", { class: "segmented", role: "group", "aria-label": "Chart" }, viewButton("history", "History"), viewButton("path", "Path to FI"))
        : null),
    h("div", { id: "chart", class: "chart-box" }),
    h("p", { class: "chart-note muted" }, note));
}

// When the projection reaches the FI number, in words.
function pathSummary(m, p) {
  if (p.points.length === 0) return "The portfolio has reached the FI number.";
  const rate = (k) => percentUnit.format(p.rates[k]);
  const year = (k) => monthLabel(p.reach[k], true);
  const limit = `within ${F.MAX_PROJECTION_MONTHS / 12} years`;
  let outcome;
  if (p.reach.mid) {
    const months = F.monthIndex(p.reach.mid) - F.monthIndex(m.latestMonth);
    const low = p.reach.low ? `${year("low")} at ${rate("low")}` : `not ${limit} at ${rate("low")}`;
    outcome = `the portfolio reaches the FI number around ${year("mid")}, in ${duration(months)}: ${year("high")} at ${rate("high")}, ${low}. ` +
      `By then the FI number is ${money(p.points[months - 1].goal)}, as it rises with ${percentUnit.format(state.store.settings.inflation)} inflation a year.`;
  } else if (p.reach.high) {
    outcome = `the portfolio does not reach the FI number ${limit}; at ${rate("high")} it would around ${year("high")}.`;
  } else {
    outcome = `the portfolio does not reach the FI number ${limit}, not even at ${rate("high")}.`;
  }
  return [`At ${rate("mid")} growth a year and ${money(m.payIn.average)} paid in a month, ${outcome} The expected return and inflation are set in `,
    h("a", { href: "#settings" }, "Settings"), "."];
}

function drawChart() {
  const box = document.getElementById("chart");
  if (!box) return;
  const m = F.metrics(state.store);
  const view = chartView(m);
  const options = {
    view,
    series: m.series,
    fiNumber: chartGoal(m),
    projection: view === "path" ? projection(m) : null,
    format: money,
    formatSigned: signedMoney,
    formatPercent: (fraction) => percent.format(fraction),
    formatSignedPercent: signedPercent,
    formatRate: (rate) => percentUnit.format(rate),
    formatAxis: (cents) => axis.format(cents / 100),
    formatMonth: monthLabel,
    monthNumber: F.monthIndex,
  };
  drawResizing(box, () => renderChart(box, options));
}

// Draws a chart, and again whenever its box changes width.
let resizeObserver = null;
function drawResizing(box, draw) {
  draw();
  resizeObserver?.disconnect();
  let width = box.clientWidth;
  resizeObserver = new ResizeObserver(() => {
    if (Math.abs(box.clientWidth - width) < 2) return;
    width = box.clientWidth;
    draw();
  });
  resizeObserver.observe(box);
}

// ---------------------------------------------------------------- expenses and income

// When an expense or income starts or ends: a choice, and a field for the
// age or month when that is chosen. choices: [[value, label]], with "none"
// (always), "retirement", "age" and "month". A field not chosen is also
// disabled, so a value left in it cannot stop the form.
function boundField(name, label, bound, choices) {
  const kind = bound === null ? "none" : bound.at === "retirement" ? "retirement" : "age" in bound ? "age" : "month";
  const age = h("input", { name: `${name}-age`, type: "number", min: F.AGES.min, max: F.AGES.max, step: 1, inputmode: "numeric", placeholder: "67",
    "aria-label": `${label}: age`, value: kind === "age" ? String(bound.age) : "", hidden: kind !== "age", disabled: kind !== "age" });
  const month = h("input", { name: `${name}-month`, type: "month", "aria-label": `${label}: month`, value: kind === "month" ? bound.month : "",
    hidden: kind !== "month", disabled: kind !== "month" });
  const select = h("select", { name, value: kind, "aria-label": label, onchange: (event) => {
    age.hidden = age.disabled = event.target.value !== "age";
    month.hidden = month.disabled = event.target.value !== "month";
  } }, choices.map(([value, text]) => h("option", { value }, text)));
  return h("div", { class: `field bound ${name}` }, h("span", null, label), h("div", { class: "bound-row" }, select, age, month));
}

// Reads a boundField. Returns { bound } or { error }.
function readBound(data, name, label) {
  const kind = data.get(name);
  if (kind === "retirement") return { bound: { at: "retirement" } };
  if (kind === "age") {
    const text = String(data.get(`${name}-age`) ?? "").trim();
    const age = Number(text);
    if (!/^[0-9]+$/.test(text) || age < F.AGES.min || age > F.AGES.max) return { error: `${label}: enter an age in whole years, up to ${F.AGES.max}.` };
    if (state.store.settings.birthYear === null) return { error: `${label}: an age needs your year of birth, in Settings.` };
    return { bound: { age } };
  }
  if (kind === "month") {
    const month = String(data.get(`${name}-month`) ?? "");
    return F.isMonth(month) ? { bound: { month } } : { error: `${label}: choose a month.` };
  }
  return { bound: null };
}

// What the helpers below name the items they add, and find them by.
const PENSION_NAME = "State pension";
const HEALTH_NAME = "Health and care insurance";

// A decimal number such as "25,5" or "2.9"; null when it is none.
function readNumber(text, decimals = 4) {
  const result = F.parsePercent(text, { decimals });
  return result.ok ? result.value : null;
}

// Germany: Rentenpunkte to a state pension a month, added as income from
// the age it starts.
function pensionCard() {
  const store = state.store;
  const g = F.GERMANY_2026;
  const regularAge = store.settings.retirementAge;
  const existing = store.income.find((item) => item.name === PENSION_NAME) ?? null;
  const result = h("p", { class: "helper-result", "aria-live": "polite" });
  const read = (form) => {
    const data = new FormData(form);
    const points = readNumber(data.get("points"));
    const more = readNumber(data.get("more"));
    const pointValue = F.parseMoney(data.get("pointValue"));
    const ageText = String(data.get("startAge")).trim();
    const startAge = Number(ageText);
    const deductions = readNumber(data.get("deductions"), 2);
    if (points === null) return { error: "Rentenpunkte so far: enter a number, such as 25,5." };
    if (more === null) return { error: "More points: enter a number, or 0." };
    if (!pointValue.ok || pointValue.cents <= 0) return { error: "Value of a point: enter an amount." };
    if (!/^[0-9]+$/.test(ageText) || startAge < regularAge - 4 || startAge > F.AGES.max) return { error: `Starts at age: from ${regularAge - 4} on.` };
    if (deductions === null || deductions >= 100) return { error: "Health and care insurance: enter a percentage." };
    return { startAge, ...F.statePension({ points: points + more, pointValue: pointValue.cents, startAge, regularAge, deductions }) };
  };
  const show = (form) => {
    const r = read(form);
    if (r.error) {
      result.textContent = String(new FormData(form).get("points")).trim() === "" ? "" : r.error;
      return;
    }
    const change = r.change === 0 ? "" : ` (${signedPercent(r.change)} for starting ${r.change < 0 ? "early" : "late"})`;
    result.textContent = `${money(r.gross)} a month before deductions${change}, ${money(r.net)} after health and care insurance, from age ${r.startAge}, in today's money.`;
  };
  const form = h("form", {
    class: "helper-form",
    oninput: (event) => show(event.currentTarget),
    onsubmit: (event) => {
      event.preventDefault();
      const r = read(event.currentTarget);
      if (r.error) return showError(event.currentTarget, r.error);
      if (store.settings.birthYear === null) return showError(event.currentTarget, "The pension starts at an age, which needs your year of birth, in Settings.");
      const item = { id: existing?.id ?? F.newId(), name: PENSION_NAME, category: existing?.category ?? "", amount: Math.round(r.net), everyMonths: 1, from: { age: r.startAge }, until: null };
      commit(F.saveItem(store, "income", item), `${existing ? "Updated" : "Added"} ${PENSION_NAME}: ${money(item.amount)} a month from age ${r.startAge}.`);
    },
  },
    h("label", null, "Rentenpunkte so far", h("input", { name: "points", inputmode: "decimal", autocomplete: "off", placeholder: "25,5", required: true })),
    h("label", null, "More points until you stop working", h("input", { name: "more", inputmode: "decimal", autocomplete: "off", value: "0" })),
    h("label", null, "Value of a point", h("input", { name: "pointValue", inputmode: "decimal", autocomplete: "off", value: inputMoney(g.pointValue) })),
    h("label", null, "Starts at age", h("input", { name: "startAge", inputmode: "numeric", autocomplete: "off", value: String(existing?.from?.age ?? regularAge) })),
    h("label", null, "Health and care insurance (%)",
      h("input", { name: "deductions", inputmode: "decimal", autocomplete: "off", value: plain.format(g.pensionerRate + g.extraRate / 2 + g.careRateChildless) })),
    h("div", { class: "form-actions" }, h("button", { type: "submit", class: "primary" }, existing ? `Update ${PENSION_NAME}` : "Add as income")));
  queueMicrotask(() => show(form));
  return h("section", { class: "card" },
    h("details", null,
      h("summary", null, h("h2", null, "State pension (Germany)")),
      h("p", null, "Your Renteninformation lists the Rentenpunkte (Entgeltpunkte) you have so far; its pension at ", regularAge,
        " assumes you pay in until then. Enter only what you have, and add the points for the years you still plan to work: about 1 a year at the average wage, 51.944 € in 2026."),
      h("p", { class: "muted" }, "A point is worth 42,52 € from July 2026. Starting before the regular age, your retirement age in Settings (", regularAge,
        "), costs 0,3 % a month, at most 4 years early (63 with 35 years of contributions); later adds 0,5 % a month. Pensioners pay half the general and the extra health rate (7,3 % + about 1,45 %) and the whole care rate (3,6 %, 4,2 % without children). ",
        "Income tax is left out. Income rises with inflation in the forecast, as pensions about do."),
      form, result));
}

// Germany: health and care insurance at the minimum, as a voluntary member,
// from retirement until the pension starts.
function healthCard() {
  const store = state.store;
  const g = F.GERMANY_2026;
  const existing = store.expenses.find((item) => item.name === HEALTH_NAME) ?? null;
  const result = h("p", { class: "helper-result", "aria-live": "polite" });
  const read = (form) => {
    const data = new FormData(form);
    const base = F.parseMoney(data.get("base"));
    const extra = readNumber(data.get("extra"), 2);
    const care = data.get("childless") === "on" ? g.careRateChildless : g.careRate;
    const ageText = String(data.get("untilAge")).trim();
    const untilAge = Number(ageText);
    if (!base.ok || base.cents <= 0) return { error: "Minimum base: enter an amount." };
    if (extra === null || extra >= 100) return { error: "Zusatzbeitrag: enter a percentage." };
    if (!/^[0-9]+$/.test(ageText) || untilAge > F.AGES.max) return { error: "Until age: enter whole years." };
    const rates = [g.generalRate, extra, care];
    return { untilAge, rates, base: base.cents, amount: F.healthInsurance({ base: base.cents, rates }) };
  };
  const show = (form) => {
    const r = read(form);
    result.textContent = r.error ?? `${money(r.amount)} a month: ${r.rates.map((rate) => percentUnit.format(rate)).join(" + ")} of ${moneyExact(r.base)}, from retirement until age ${r.untilAge}.`;
  };
  const form = h("form", {
    class: "helper-form",
    oninput: (event) => show(event.currentTarget),
    onsubmit: (event) => {
      event.preventDefault();
      const r = read(event.currentTarget);
      if (r.error) return showError(event.currentTarget, r.error);
      if (store.settings.birthYear === null) return showError(event.currentTarget, "It ends at an age, which needs your year of birth, in Settings.");
      const category = existing?.category ?? (store.categories.expenses.includes("Insurance") ? "Insurance" : "");
      const item = { id: existing?.id ?? F.newId(), name: HEALTH_NAME, category, amount: Math.round(r.amount), everyMonths: 1,
        from: { at: "retirement" }, until: { age: r.untilAge }, active: existing?.active ?? true, essential: true };
      commit(F.saveItem(store, "expenses", item), `${existing ? "Updated" : "Added"} ${HEALTH_NAME}: ${money(item.amount)} a month from retirement until age ${r.untilAge}.`);
    },
  },
    h("label", null, "Minimum base a month", h("input", { name: "base", inputmode: "decimal", autocomplete: "off", value: inputMoney(g.minimumBase) })),
    h("label", null, "Zusatzbeitrag (%)", h("input", { name: "extra", inputmode: "decimal", autocomplete: "off", value: plain.format(g.extraRate) })),
    h("label", null, "Until age (the pension starts)",
      h("input", { name: "untilAge", inputmode: "numeric", autocomplete: "off", value: String(existing?.until?.age ?? store.settings.retirementAge) })),
    h("label", { class: "check" }, h("input", { type: "checkbox", name: "childless", checked: true }), "No children (care insurance 4,2 % instead of 3,6 %)"),
    h("div", { class: "form-actions" }, h("button", { type: "submit", class: "primary" }, existing ? `Update ${HEALTH_NAME}` : "Add as expense")));
  queueMicrotask(() => show(form));
  return h("section", { class: "card" },
    h("details", null,
      h("summary", null, h("h2", null, "Health and care insurance after you stop working (Germany)")),
      h("p", null, "While you work, health and care insurance come out of your pay, so they are in none of your expenses. ",
        "Once you live off the portfolio before the pension, you insure yourself, as a voluntary member of a statutory insurer, and pay at least on the minimum base: about 280 € a month in 2026."),
      h("p", { class: "muted" }, "The rates: 14 % (without sick pay), your insurer's Zusatzbeitrag (2,9 % on average in 2026), and care insurance. ",
        "Gains and dividends count as income too: above the minimum base, you pay on them. From the pension on, insured as a pensioner (KVdR, after 9/10 of the second half of your working life insured), only the pension counts; this is in the pension helper under Income. ",
        "Added from retirement until the age the pension starts, as an essential expense."),
      form, result));
}

function viewItems(kind) {
  const store = state.store;
  const info = KINDS[kind];
  const items = store[kind];
  const { birthYear } = store.settings;
  const retirement = F.retirementIndex(store.settings);
  const now = thisMonth();
  // Active items that count this month; the others start later or have
  // ended.
  const active = F.countingIn(items, now, store.settings);
  const later = F.counted(items).filter((item) => !active.includes(item) && F.itemWindow(item, birthYear, retirement).from > now);
  const ended = F.counted(items).filter((item) => !active.includes(item) && !later.includes(item));
  const inactive = items.filter((item) => item.active === false);
  const essential = active.filter((item) => item.essential);
  const editing = items.find((item) => item.id === state.editing[kind]) ?? null;
  const monthly = (list) => list.reduce((t, item) => t + F.monthlyAmount(item), 0);
  const monthlyTotal = monthly(active);

  let summary;
  if (kind === "expenses") {
    const buffer = (monthlyTotal * store.settings.bufferPercent) / 100;
    summary = h("dl", { class: "summary" },
      h("div", null, h("dt", null, "Regular expenses"), h("dd", { class: "num" }, `${money(monthlyTotal)} / month`)),
      h("div", null, h("dt", null, `Buffer, ${percentUnit.format(store.settings.bufferPercent)}`), h("dd", { class: "num" }, `${money(buffer)} / month`)),
      h("div", null, h("dt", null, "Total"), h("dd", { class: "num strong" }, `${money(monthlyTotal + buffer)} / month · ${money((monthlyTotal + buffer) * 12)} / year`)),
      essential.length
        ? h("div", null, h("dt", null, "Essential, for Lean FI"), h("dd", { class: "num" }, `${money(monthly(essential))} / month · ${money(monthly(essential) * (1 + store.settings.bufferPercent / 100))} with buffer`))
        : null,
      inactive.length
        ? h("div", null, h("dt", null, "Inactive, not counted"), h("dd", { class: "num muted" }, `${money(monthly(inactive))} / month`))
        : null);
  } else {
    summary = h("dl", { class: "summary" },
      h("div", null, h("dt", null, "Net income"), h("dd", { class: "num strong" }, `${money(monthlyTotal)} / month · ${money(monthlyTotal * 12)} / year`)));
  }

  const categories = store.categories[kind];
  const form = h("form", {
    class: "item-form",
    onsubmit: (event) => {
      event.preventDefault();
      const data = new FormData(event.currentTarget);
      const name = String(data.get("name")).trim();
      const category = String(data.get("category")).trim();
      const amount = F.parseMoney(data.get("amount"));
      const everyMonths = Number(data.get("everyMonths"));
      let error = null;
      if (name === "") error = "Enter a name.";
      else if (category !== "" && !categories.includes(category)) error = `Category: "${category}" no longer exists.`;
      else if (!amount.ok) error = `Amount: ${amount.error}.`;
      else if (amount.cents <= 0) error = "Amount: must be more than zero.";
      else if (!Number.isInteger(everyMonths) || everyMonths < 1 || everyMonths > 120) error = "Paid every: enter whole months from 1 to 120.";
      const from = readBound(data, "from", "Starts");
      const until = readBound(data, "until", "Ends");
      if (!error) error = from.error ?? until.error ?? null;
      if (!error) {
        // Retirement moves (Retire early starts it at FI), so only fixed
        // starts and ends can be compared.
        const atRetirement = (bound) => bound?.at === "retirement";
        const window = F.itemWindow({ from: from.bound, until: until.bound }, birthYear, retirement);
        if (atRetirement(from.bound) && atRetirement(until.bound)) error = "It cannot start and end at retirement.";
        else if (!atRetirement(from.bound) && !atRetirement(until.bound) && window.from >= window.until) error = "It ends before it starts: change when it starts or ends.";
      }
      if (error) return showError(event.currentTarget, error);
      const item = { id: editing?.id ?? F.newId(), name, category, amount: amount.cents, everyMonths, from: from.bound, until: until.bound };
      if (kind === "expenses") {
        item.active = editing?.active ?? true;
        item.essential = data.get("essential") === "on";
      }
      state.editing[kind] = null;
      state.focus = "#item-name";
      commit(F.saveItem(store, kind, item), editing ? `Saved ${name}.` : `Added ${name}.`);
    },
  },
    h("label", null, "Name", h("input", { id: "item-name", name: "name", required: true, autocomplete: "off", value: editing?.name ?? "", placeholder: kind === "expenses" ? "Rent" : "Salary" })),
    h("label", null, "Category",
      h("select", { name: "category", value: editing?.category ?? "" },
        h("option", { value: "" }, "No category"),
        categories.map((c) => h("option", { value: c }, c)))),
    h("label", null, kind === "income" ? "Amount (net)" : "Amount", h("input", { name: "amount", inputmode: "decimal", autocomplete: "off", required: true, value: editing ? inputMoney(editing.amount) : "", placeholder: zero })),
    h("label", null, "Paid every … months",
      h("input", { name: "everyMonths", type: "number", min: 1, max: 120, step: 1, required: true, list: "intervals", value: String(editing?.everyMonths ?? 1) })),
    h("datalist", { id: "intervals" }, INTERVALS.map(([v, label]) => h("option", { value: String(v), label }))),
    boundField("from", "Starts", editing ? editing.from : null,
      [["none", "Now"], ["retirement", "At retirement"], ["age", "At age"], ["month", "In month"]]),
    boundField("until", "Ends", editing ? editing.until : kind === "income" ? { at: "retirement" } : null,
      [["none", "Never"], ["retirement", "At retirement"], ["age", "At age"], ["month", "After month"]]),
    kind === "expenses"
      ? h("label", { class: "check" }, h("input", { type: "checkbox", name: "essential", checked: editing?.essential ?? false }),
          "Essential: needed even on the leanest budget, so it counts for Lean FI")
      : null,
    h("div", { class: "form-actions" },
      h("button", { type: "submit", class: "primary" }, editing ? "Save" : "Add"),
      editing ? h("button", { type: "button", onclick: () => { state.editing[kind] = null; render(); } }, "Cancel") : null),
  );

  const row = (item) => h("tr", { class: [item.id === state.editing[kind] && "editing", item.active === false && "inactive"].filter(Boolean).join(" ") || null },
    h("td", null, item.name, item.essential ? h("span", { class: "badge", title: "Counts for Lean FI" }, "Essential") : null,
      windowText(item) ? h("div", { class: "sub" }, windowText(item)) : null,
      // Listed apart from their category, so they show it here.
      !active.includes(item) && item.category ? h("div", { class: "sub" }, item.category) : null),
    h("td", { class: "num" }, moneyExact(item.amount)),
    h("td", null, intervalLabel(item.everyMonths)),
    h("td", { class: "num" }, money(F.monthlyAmount(item))),
    h("td", { class: "actions" },
      h("button", { type: "button", class: "link", onclick: () => { state.editing[kind] = item.id; state.focus = "#item-name"; render(); } }, "Edit"),
      kind === "expenses"
        ? h("button", { type: "button", class: "link",
            title: item.active ? "Keep it in the list, but leave it out of every total and chart" : "Count it again",
            onclick: () => commit(F.saveItem(store, kind, { ...item, active: !item.active }),
              item.active ? `${item.name} is inactive: it no longer counts.` : `${item.name} is active again.`) },
          item.active ? "Deactivate" : "Activate")
        : null,
      h("button", { type: "button", class: "link danger", onclick: () => {
        if (!confirm(`Delete ${item.name}?`)) return;
        if (state.editing[kind] === item.id) state.editing[kind] = null;
        commit(F.deleteItem(store, kind, item.id), `Deleted ${item.name}.`);
      } }, "Delete")));

  const rows = [];
  for (const group of F.byCategory(active)) {
    rows.push(h("tr", { class: "group" }, h("th", { colspan: 3, scope: "rowgroup" }, group.category || "No category"), h("td", { class: "num" }, money(group.monthly)), h("td")));
    rows.push(group.items.map(row));
  }
  const apart = (title, list, note) => {
    if (list.length === 0) return;
    rows.push(h("tr", { class: "group" }, h("th", { colspan: 3, scope: "rowgroup" }, title), h("td", { class: "num" }, h("span", { class: "muted" }, note)), h("td")));
    rows.push([...list].sort((a, b) => F.monthlyAmount(b) - F.monthlyAmount(a) || a.name.localeCompare(b.name)).map(row));
  };
  apart("Later", later, "not counted yet");
  apart("Ended", ended, "no longer counted");
  apart("Inactive", inactive, "not counted");

  return h("div", null,
    card(info.title, summary,
      h("p", { class: "muted" },
        kind === "income" ? "Enter amounts after tax. A yearly bonus counts as one twelfth per month. " : "Regular payments only. Pay-ins to broker accounts go under Portfolio, not here. ",
        categories.length ? "Categories are set in " : "There are no categories yet: add them in ",
        h("a", { href: "#settings" }, "Settings"), ". ",
        kind === "income"
          ? "Income that goes on after retirement, such as a pension or rent, lowers what the portfolio has to pay: let it end never, or at an age. "
          : "Expenses that start at retirement, such as health insurance, raise it; ones that end, such as a loan, lower it. ",
        "Ages and retirement start in January of their year."),
      h("h3", null, editing ? `Edit ${editing.name}` : `Add ${info.one === "income" ? "income" : "an expense"}`),
      form),
    items.length
      ? card(null, h("div", { class: "table-wrap" }, h("table", null,
          h("thead", null, h("tr", null, h("th", null, "Name"), h("th", { class: "num" }, "Amount"), h("th", null, "Paid"), h("th", { class: "num" }, "Per month"), h("th"))),
          h("tbody", null, rows))))
      : null,
    kind === "income" ? pensionCard() : healthCard());
}

// ---------------------------------------------------------------- portfolio

function defaultMonth(store) {
  const now = F.currentMonth();
  if (store.records.length === 0) return now;
  const latest = store.records.reduce((a, r) => (r.month > a ? r.month : a), store.records[0].month);
  const next = F.addMonths(latest, 1);
  return next > now ? now : next;
}

function lastValueBefore(store, account, month) {
  let best = null;
  for (const r of store.records) {
    if (r.account === account && r.month < month && (!best || r.month > best.month)) best = r;
  }
  return best;
}

function viewPortfolio() {
  const store = state.store;
  if (!state.month) state.month = defaultMonth(store);
  const month = state.month;
  const monthRecords = new Map(store.records.filter((r) => r.month === month).map((r) => [r.account, r]));

  // ---- one month's values
  const monthForm = h("form", {
    class: "month-form",
    onsubmit: (event) => {
      event.preventDefault();
      const data = new FormData(event.currentTarget);
      const entries = [];
      const errors = [];
      for (const account of store.accounts) {
        const valueText = String(data.get(`value-${account.id}`) ?? "").trim();
        const payInText = String(data.get(`payin-${account.id}`) ?? "").trim();
        const oneOffText = String(data.get(`oneoff-${account.id}`) ?? "").trim();
        if (valueText === "" && payInText === "" && oneOffText === "") {
          entries.push({ account: account.id, value: null, payIn: 0, oneOff: 0 });
          continue;
        }
        const value = F.parseMoney(valueText);
        const payIn = payInText === "" ? { ok: true, cents: 0 } : F.parseMoney(payInText);
        const oneOff = oneOffText === "" ? { ok: true, cents: 0 } : F.parseMoney(oneOffText);
        if (valueText === "") errors.push(`${account.name}: enter the value too.`);
        else if (!value.ok) errors.push(`${account.name} value: ${value.error}.`);
        else if (value.cents < 0) errors.push(`${account.name} value: must not be negative.`);
        if (!payIn.ok) errors.push(`${account.name} pay-in: ${payIn.error}.`);
        if (!oneOff.ok) errors.push(`${account.name} one-off: ${oneOff.error}.`);
        if (valueText !== "" && value.ok && value.cents >= 0 && payIn.ok && oneOff.ok) entries.push({ account: account.id, value: value.cents, payIn: payIn.cents, oneOff: oneOff.cents });
      }
      if (errors.length === 0 && entries.every((e) => e.value === null) && monthRecords.size === 0) errors.push("Enter at least one value.");
      if (errors.length) return showError(event.currentTarget, errors.join(" "));
      commit(F.saveMonth(store, month, entries), `Saved ${monthLabel(month)}.`);
    },
  },
    h("label", { class: "month-pick" }, "Month",
      h("input", { type: "month", name: "month", required: true, value: month, onchange: (event) => {
        if (F.isMonth(event.target.value)) {
          state.month = event.target.value;
          render();
        }
      } })),
    store.accounts.length === 0
      ? h("p", { class: "muted" }, "Add your accounts in ", h("a", { href: "#settings" }, "Settings"), " first, or import past months from a CSV file there.")
      : h("div", { class: "table-wrap" }, h("table", { class: "entry" },
          h("thead", null, h("tr", null, h("th", null, "Account"), h("th", null, "Value at month end"), h("th", null, "Paid in this month"),
            h("th", { title: "An inheritance in, a house deposit out: counts as paid in, but not for the average pay-in" }, "One-off this month"))),
          h("tbody", null, store.accounts.map((account) => {
            const record = monthRecords.get(account.id);
            const before = lastValueBefore(store, account.id, month);
            // Pay-ins count for the portfolio only: other accounts have a value.
            const invested = isInvested(account);
            return h("tr", null,
              h("th", { scope: "row" }, account.name, invested ? null : h("div", { class: "sub" }, kindLabel(account.kind))),
              h("td", null, h("input", { name: `value-${account.id}`, inputmode: "decimal", autocomplete: "off",
                "aria-label": `${account.name} ${account.kind === "debt" ? "still owed" : "value"}`,
                value: record ? inputMoney(record.value) : "", placeholder: before ? `last: ${inputMoney(before.value)}` : zero })),
              invested
                ? h("td", null, h("input", { name: `payin-${account.id}`, inputmode: "decimal", autocomplete: "off", "aria-label": `${account.name} pay-in`,
                    value: record && record.payIn !== 0 ? inputMoney(record.payIn) : "", placeholder: zero }))
                : h("td", { class: "muted" }, "–"),
              invested
                ? h("td", null, h("input", { name: `oneoff-${account.id}`, inputmode: "decimal", autocomplete: "off", "aria-label": `${account.name} one-off`,
                    value: record && record.oneOff !== 0 ? inputMoney(record.oneOff) : "", placeholder: zero }))
                : h("td", { class: "muted" }, "–"));
          })))),
    store.accounts.length
      ? h("div", { class: "form-actions" },
          h("button", { type: "submit", class: "primary" }, `Save ${monthLabel(month)}`),
          monthRecords.size ? h("button", { type: "button", class: "danger", onclick: () => {
            if (!confirm(`Delete all values for ${monthLabel(month)}?`)) return;
            commit(F.deleteMonth(store, month), `Deleted ${monthLabel(month)}.`);
          } }, "Delete month") : null)
      : null,
  );

  // ---- history: every month with a value of any account; the portfolio
  // of the invested ones, and with other accounts the net worth.
  const series = new Map(F.portfolioSeries(store).map((m) => [m.month, m]));
  const firstInvested = series.keys().next().value;
  const worth = F.netWorthSeries(store);
  const others = store.accounts.some((a) => !isInvested(a));
  const byMonth = new Map();
  for (const r of store.records) {
    if (!byMonth.has(r.month)) byMonth.set(r.month, new Map());
    byMonth.get(r.month).set(r.account, r);
  }
  const none = () => h("span", { class: "muted" }, "–");
  const history = worth.length === 0 ? null : card("History",
    h("p", { class: "muted" }, "An account without a value in a month counts with its last value. Click a month to change it."),
    h("div", { class: "table-wrap" }, h("table", { class: "history" },
      h("thead", null, h("tr", null, h("th", null, "Month"),
        store.accounts.map((a) => h("th", { class: "num" }, a.name, isInvested(a) ? null : h("div", { class: "sub" }, kindLabel(a.kind)))),
        h("th", { class: "num" }, others ? "Portfolio" : "Total"), h("th", { class: "num" }, "Paid in"), others ? h("th", { class: "num" }, "Net worth") : null)),
      h("tbody", null, [...worth].reverse().map((w) => {
        // Invested accounts keep their last values through months with
        // values of other accounts only, as in the net worth.
        const m = series.get(w.month) ?? { month: w.month, payIn: 0, oneOff: 0 };
        const portfolio = firstInvested !== undefined && w.month >= firstInvested ? w.kinds.invested : null;
        const records = byMonth.get(m.month);
        return h("tr", { class: m.month === month ? "editing" : null },
          h("th", { scope: "row" }, h("button", { type: "button", class: "link", onclick: () => { state.month = m.month; render(); scrollTo(0, 0); } }, monthLabel(m.month))),
          store.accounts.map((a) => {
            const r = records?.get(a.id);
            return h("td", { class: "num" }, r ? (a.kind === "debt" ? money(-r.value || 0) : money(r.value)) : h("span", { class: "muted" }, "–"),
              r && r.payIn !== 0 ? h("div", { class: "sub" }, signedMoney(r.payIn)) : null,
              r && r.oneOff !== 0 ? h("div", { class: "sub" }, `${signedMoney(r.oneOff)} one-off`) : null);
          }),
          h("td", { class: "num strong" }, portfolio === null ? none() : money(portfolio)),
          h("td", { class: "num" }, m.payIn !== 0 ? signedMoney(m.payIn) : h("span", { class: "muted" }, "–"),
            m.oneOff !== 0 ? h("div", { class: "sub" }, `${signedMoney(m.oneOff)} one-off`) : null),
          others ? h("td", { class: "num strong" }, money(w.total)) : null);
      })))));

  return h("div", null,
    card("Monthly values", monthForm,
      h("p", { class: "muted" }, "Paid in: your regular pay-ins, such as savings plans, negative for withdrawals; their average of the last 12 months is what Time to FI and the forecast go on with. ",
        "One-off: a lump sum in or out, such as an inheritance or a house deposit; it counts as paid in, but not for that average. ",
        "Planned one-offs go on the ", h("a", { href: "#forecast" }, "Forecast"), " page."),
      h("p", { class: "muted" }, "For cash, property, pension assets and debts, enter only what they are worth, or still owed, at month end. ",
        "Accounts, CSV import and export are in ", h("a", { href: "#settings" }, "Settings"), ".")),
    history);
}

// ---------------------------------------------------------------- forecast

// The plans' names, on the chart and on their tiles.
const PLAN_LABELS = { keep: "Keep investing", coast: "Coast", fi: "Retire early" };

// What the forecast starts from, and what is paid in.
function forecastBase(store) {
  const m = F.metrics(store);
  const { birthYear, retirementAge, inflation } = store.settings;
  // The average pay-in, as the dashboard's time to FI uses it, in whole
  // cents and never a withdrawal.
  const average = m.payIn ? Math.max(0, Math.round(m.payIn.average)) : 0;
  return {
    m,
    average,
    params: {
      start: m.latestMonth ?? F.currentMonth(),
      value: m.portfolio ?? 0,
      expenses: m.expenses,
      fiNumber: m.fiNumber,
      // Month by month, with the expenses and income that count then.
      need: (index, retirement) => F.needIn(store, index, retirement),
      goal: (index) => F.fiNumberIn(store, Math.max(index, thisMonth())),
      oneOffs: (index) => F.oneOffsIn(store, index),
      birthYear,
      retirementAge,
      inflation,
      contribution: state.forecast.contribution ?? average,
      coastContribution: state.forecast.coastContribution,
    },
  };
}

// Retired already: every plan lives off the portfolio from the start, so
// they are one.
const retiredAt = (params) => F.monthIndex(params.start) >= (params.birthYear + params.retirementAge) * 12;

function viewForecast() {
  const store = state.store;
  const { birthYear, retirementAge } = store.settings;
  const missing = [];
  if (birthYear === null) missing.push(h("li", null, "your year of birth, in ", h("a", { href: "#settings" }, "Settings")));
  if (F.counted(store.expenses).length === 0) missing.push(h("li", null, "your ", h("a", { href: "#expenses" }, "expenses"), ", for the FI number"));
  if (missing.length) {
    return h("div", null, card("Forecast",
      h("p", null, "How your portfolio could grow until you retire, and whether it lasts after. The forecast needs:"),
      h("ul", null, missing)));
  }

  const { m, average, params } = forecastBase(store);
  const rates = F.growthRates(store.settings.expectedReturn);
  const inflation = percentUnit.format(params.inflation);
  const retirementYear = birthYear + retirementAge;
  const retired = retiredAt(params);
  // What the portfolio pays when retirement starts, in today's money and
  // with inflation by then.
  const retirementIndex = retirementYear * 12;
  const paysThen = F.needIn(store, retirementIndex, retirementIndex);
  const paysNow = F.needIn(store, thisMonth(), Math.min(retirementIndex, thisMonth()));
  const then = (amount) => money(F.inflated(amount, params.inflation, retirementIndex - 1 - F.monthIndex(params.start)));
  const read = (event) => {
    event.preventDefault();
    readForecastForm(event.currentTarget, average);
  };
  const months = m.payIn?.months === 12 ? "the last 12 months" : m.payIn?.months === 1 ? "1 month" : `${m.payIn?.months} months`;

  // The growth buttons stay when the results redraw, and change in place: a
  // click on one that starts while a field's change redraws the results
  // still lands.
  const growth = state.forecast.growth;
  const growthButton = (g) =>
    h("button", { type: "button", class: g === growth ? "seg active" : "seg", "aria-pressed": String(g === growth), "data-growth": g,
      onclick: () => { state.forecast.growth = g; updateForecast(); } }, percentUnit.format(rates[g]));
  const growthField = h("div", { class: "field" },
    h("span", { id: "forecast-growth" }, "Growth a year"),
    h("div", { class: "segmented", role: "group", "aria-labelledby": "forecast-growth" }, F.GROWTHS.map(growthButton)));

  return h("div", null,
    card("Forecast",
      retired
        ? h("p", null, `You have reached your retirement age, ${retirementAge}, so the portfolio pays your expenses from now on, less the income that goes on: `,
            `${money(paysNow)} a month with buffer, rising by ${inflation} a year.`)
        : h("p", null, `How your portfolio could grow until you retire in ${retirementYear}, the year you turn ${retirementAge}, and whether it lasts after. `,
            `From then on it pays your expenses, less the income that goes on: ${money(paysThen)} a month with buffer in today's money, ${then(paysThen)} by then with ${inflation} inflation a year.`),
      retired
        ? h("div", { class: "forecast-controls" }, growthField)
        : h("form", { class: "forecast-controls", onsubmit: read, onchange: read },
            h("div", { class: "forecast-form" },
              h("label", null, "Invested per month",
                h("input", { id: "forecast-contribution", name: "contribution", inputmode: "decimal", autocomplete: "off", value: inputMoney(params.contribution) })),
              h("label", null, "After Coast FI, per month",
                h("input", { id: "forecast-coast", name: "coastContribution", inputmode: "decimal", autocomplete: "off", value: inputMoney(params.coastContribution) })),
              h("button", { type: "submit" }, "Show")),
            growthField),
      retired ? null : h("p", { class: "muted" },
        !m.payIn ? "There are no pay-ins yet to start from."
          : m.payIn.average < 0 ? `Your average of ${months} is a withdrawal of ${money(-m.payIn.average)} a month, so invested per month starts at 0.`
          : `Invested per month starts as your average pay-in of ${months}, ${money(average)}.`)),
    h("div", { id: "forecast-results", class: "stack" }, forecastResults()),
    eventsCard(params.start));
}

// Planned one-offs: an inheritance, a house deposit, a sabbatical. Saved,
// unlike the amounts at the top.
function eventsCard(start) {
  const store = state.store;
  const editing = store.events.find((e) => e.id === state.editingEvent) ?? null;
  const form = h("form", { class: "event-form", onsubmit: (event) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const amount = F.parseMoney(data.get("amount"));
    if (!amount.ok) return showError(event.currentTarget, `Amount: ${amount.error}.`);
    const result = F.saveEvent(store, { id: editing?.id ?? null, name: data.get("name"), month: String(data.get("month")), amount: amount.cents });
    if (!result.ok) return showError(event.currentTarget, `${result.error}.`);
    state.editingEvent = null;
    state.focus = "#event-name";
    commit(result.store, `${editing ? "Saved" : "Added"} ${String(data.get("name")).trim()}.`);
  } },
    h("label", null, "Name", h("input", { id: "event-name", name: "name", autocomplete: "off", required: true, value: editing?.name ?? "", placeholder: "Inheritance" })),
    h("label", null, "Month", h("input", { name: "month", type: "month", required: true, value: editing?.month ?? "" })),
    h("label", null, "Amount (negative: taken out)", h("input", { name: "amount", inputmode: "decimal", autocomplete: "off", required: true,
      value: editing ? inputMoney(editing.amount) : "", placeholder: inputMoney(-2000000) })),
    h("div", { class: "form-actions" },
      h("button", { type: "submit", class: "primary" }, editing ? "Save" : "Add"),
      editing ? h("button", { type: "button", onclick: () => { state.editingEvent = null; render(); } }, "Cancel") : null));
  const rows = store.events.map((event) => {
    const past = event.month <= start;
    return h("tr", { class: event.id === state.editingEvent ? "editing" : null },
      h("td", null, monthLabel(event.month)),
      h("td", null, event.name, past ? h("div", { class: "sub" }, "Before the forecast starts: enter it under Portfolio as a one-off") : null),
      h("td", { class: "num" }, signedMoney(event.amount)),
      h("td", { class: "actions" },
        h("button", { type: "button", class: "link", onclick: () => { state.editingEvent = event.id; state.focus = "#event-name"; render(); } }, "Edit"),
        h("button", { type: "button", class: "link danger", onclick: () => {
          if (!confirm(`Delete ${event.name}?`)) return;
          if (state.editingEvent === event.id) state.editingEvent = null;
          commit(F.deleteEvent(store, event.id), `Deleted ${event.name}.`);
        } }, "Delete")));
  });
  return card("Planned one-offs",
    h("p", { class: "muted" }, "Money that comes in or goes out once: an inheritance, a house deposit, a car, a sabbatical (what you live on, and the pay-ins you skip). ",
      "Every plan gets it in its month, as do Time to FI and the Path to FI chart. Amounts are in today's money and rise with inflation, like expenses."),
    rows.length ? h("div", { class: "table-wrap" }, h("table", null,
      h("thead", null, h("tr", null, h("th", null, "Month"), h("th", null, "Name"), h("th", { class: "num" }, "Amount"), h("th"))),
      h("tbody", null, rows))) : null,
    form);
}

function readForecastForm(form, average) {
  const data = new FormData(form);
  const contribution = F.parseMoney(data.get("contribution"));
  const coast = F.parseMoney(data.get("coastContribution"));
  let error = null;
  if (!contribution.ok) error = `Invested per month: ${contribution.error}.`;
  else if (contribution.cents < 0) error = "Invested per month: must not be negative.";
  else if (!coast.ok) error = `After Coast FI: ${coast.error}.`;
  else if (coast.cents < 0) error = "After Coast FI: must not be negative.";
  if (error) return showError(form, error);
  if (form.nextElementSibling?.classList.contains("form-error")) form.nextElementSibling.remove();
  // The average stays the average when new months come in.
  state.forecast.contribution = contribution.cents === average ? null : contribution.cents;
  state.forecast.coastContribution = coast.cents;
  updateForecast();
}

// Redraws the results only, so the form keeps what is typed and its focus.
function updateForecast() {
  const box = document.getElementById("forecast-results");
  if (!box) return render();
  box.replaceChildren(...forecastResults());
  const growth = state.forecast.growth;
  for (const button of document.querySelectorAll("[data-growth]")) {
    button.classList.toggle("active", button.dataset.growth === growth);
    button.setAttribute("aria-pressed", String(button.dataset.growth === growth));
  }
  drawForecast();
}

// At the chosen growth: a tile per plan with its answer, the chart, and
// notes.
function forecastResults() {
  const store = state.store;
  const { birthYear, retirementAge, expectedReturn, inflation, withdrawalRate } = store.settings;
  const { params } = forecastBase(store);
  const rates = F.growthRates(expectedReturn);
  const growth = state.forecast.growth;
  const result = F.forecast({ ...params, growth: rates[growth] });
  // A plan that lasts here may run out at the lowest growth: the tile says so.
  const low = growth === "low" ? result : F.forecast({ ...params, growth: rates.low });
  const retired = retiredAt(params);
  const age = (month) => F.ageIn(month, birthYear);
  const when = (month) => (month === params.start ? "Now" : `At ${age(month)}, in ${month.slice(0, 4)}`);
  const goalIn = (month) => result.goal[F.monthIndex(month) - F.monthIndex(params.start)];

  const planTile = (plan, label, value, detail) => {
    const { runsOut } = result.plans[plan];
    const lowRunsOut = low.plans[plan].runsOut;
    return h("div", { class: "tile plan" },
      h("div", { class: "tile-label" }, h("span", { class: `key plan-${plan}` }), label),
      h("div", { class: "tile-value" }, value),
      h("div", { class: "tile-detail" }, detail),
      runsOut === null ? h("div", { class: "status" }, "Money lasts") : h("div", { class: "status bad" }, `Money runs out at ${age(runsOut)}`),
      runsOut === null && lowRunsOut !== null
        ? h("div", { class: "status-note" }, `At ${percentUnit.format(rates.low)} growth, it runs out at ${age(lowRunsOut)}.`)
        : null);
  };

  let tiles;
  if (retired) {
    tiles = [planTile("keep", "Living off the portfolio", money(params.value),
      `now, taking out ${money(F.needIn(store, F.monthIndex(params.start) + 1, F.retirementIndex(store.settings)))} a month, rising by ${percentUnit.format(inflation)} a year.`)];
  } else {
    const { coastMonth } = result.plans.coast;
    const { fiMonth } = result.plans.fi;
    const fiThen = money(result.fiAtRetirement);
    const coasting = params.coastContribution > 0 ? `invest only ${money(params.coastContribution)} a month` : "stop investing";
    tiles = [
      planTile("keep", PLAN_LABELS.keep, money(result.plans.keep.atRetirement),
        `at ${retirementAge}, investing ${money(params.contribution)} a month until then.`),
      planTile("coast", PLAN_LABELS.coast, coastMonth === null ? `Not before ${retirementAge}` : when(coastMonth),
        coastMonth === null
          ? `the portfolio does not reach the FI number by ${retirementAge}, even investing until then.`
          : `you can ${coasting}: the portfolio still grows to the FI number by ${retirementAge}, ${fiThen} by then.`),
      planTile("fi", PLAN_LABELS.fi, fiMonth === null ? `Not before ${retirementAge}` : when(fiMonth),
        fiMonth === null
          ? `the portfolio does not reach the FI number before then.`
          : fiMonth === params.start
            ? `you can stop working: the portfolio is above the FI number, ${money(params.fiNumber)}, and pays your expenses from now on.`
            : `you can stop working: the portfolio reaches the FI number, ${money(goalIn(fiMonth))} by then, and pays your expenses from then on.`),
    ];
  }

  const key = (kind, label) => h("span", null, h("span", { class: `key ${kind}` }), label);
  const chartCard = h("section", { class: "card" },
    h("div", { class: "card-head" },
      h("h2", null, `At ${percentUnit.format(rates[growth])} growth a year`),
      h("div", { class: "legend" },
        retired ? key("plan-keep", "Portfolio") : F.PLANS.map((plan) => key(`plan-${plan}`, PLAN_LABELS[plan])),
        key("goal", "FI number"))),
    h("div", { id: "forecast-chart", class: "chart-box" }));

  const notes = card(null,
    h("ul", { class: "notes muted" },
      h("li", null, "Growth is before inflation: the expected return set in ", h("a", { href: "#settings" }, "Settings"),
        `, or ${F.RETURN_SPREAD} points less or more. Real markets do not grow the same every year, and bad years right after you start living off the portfolio hurt most.`),
      h("li", null, `Amounts are in the money of each year: expenses and the FI number rise by ${percentUnit.format(inflation)} a year. What is invested stays the same.`),
      h("li", null, store.records.length
        ? `It starts from the portfolio in ${monthLabel(params.start)}, ${money(params.value)}.`
        : "It starts from 0, as there are no broker values yet."),
      h("li", null, "Expenses and income with a start or an end count only in their months; for Retire early, retirement starts the month after FI. ",
        "Income that goes on after retirement, such as a pension, lowers what the portfolio pays: the FI number is what it pays for good once nothing changes any more, ",
        `× ${plain.format(100 / withdrawalRate)}, plus what it pays on top until then, such as bridging the years until the pension. `,
        "The ", h("a", { href: "#income" }, "Income"), " and ", h("a", { href: "#expenses" }, "Expenses"), " pages help with the state pension and health insurance."),
      h("li", null, `Money lasts when some is still left at age ${F.LASTS_AGE}. Taxes are left out.`)));

  return [h("div", { class: "tiles plan-tiles" }, tiles), chartCard, notes];
}

function drawForecast() {
  const box = document.getElementById("forecast-chart");
  if (!box) return;
  const { birthYear } = state.store.settings;
  const { params } = forecastBase(state.store);
  const result = F.forecast({ ...params, growth: F.growthRates(state.store.settings.expectedReturn)[state.forecast.growth] });
  const first = F.monthIndex(result.months[0]);
  const index = (month) => (month === null ? -1 : F.monthIndex(month) - first);
  const age = (month) => F.ageIn(month, birthYear);
  const { coastMonth } = result.plans.coast;
  const { fiMonth } = result.plans.fi;
  const line = (plan, label, mark, markLabel) => ({ key: plan, label, values: result.plans[plan].values, mark: index(mark), markLabel });
  // Keep investing last, on top: until the others change course, they
  // share its line.
  const lines = retiredAt(params)
    ? [line("keep", "Portfolio", null)]
    : [
        line("fi", PLAN_LABELS.fi, fiMonth, fiMonth && `Retire at ${age(fiMonth)}`),
        line("coast", PLAN_LABELS.coast, coastMonth,
          coastMonth && `${params.coastContribution > 0 ? "Invest less" : "Stop investing"} at ${age(coastMonth)}`),
        line("keep", PLAN_LABELS.keep, null),
      ];
  drawResizing(box, () =>
    renderForecastChart(box, {
      months: result.months,
      lines,
      goal: result.goal,
      retirementIndex: index(result.retirement),
      format: money,
      formatAxis: (cents) => axis.format(cents / 100),
      formatMonth: monthLabel,
      ageOf: age,
    }));
}

// ---------------------------------------------------------------- settings

function viewSettings() {
  const store = state.store;
  return h("div", null,
    card("General", settingsForm(store)),
    card("Categories",
      h("p", { class: "muted" }, "Expenses and income each have their own. Renaming a category renames it everywhere; deleting one leaves what had it without a category."),
      h("div", { class: "columns" }, F.KINDS.map((kind) => h("div", null, h("h3", null, KINDS[kind].title), categoryList(store, kind))))),
    card("Accounts",
      h("p", { class: "muted" }, "Invested accounts (brokers, ETF savings plans) are the portfolio: the FI number, Time to FI and the forecast count them alone. ",
        "Cash (Tagesgeld, the emergency fund), property, pension assets (Riester, Rürup, company pension: locked until retirement) and debts (what is still owed, such as a mortgage) count for the net worth."),
      accountList(store)),
    importCard(store),
    exportCard(store),
    card("Data file", h("p", null, "Everything is saved in one file on this computer:"), h("p", null, h("code", null, state.file)),
      h("p", { class: "muted" }, "No account and no sync. Copy the file to back it up."),
      h("p", null, "Before the first change of each day, Finance keeps a copy of the file as it was. The copies of the last 30 days with changes are in:"),
      h("p", null, h("code", null, state.backups)),
      h("p", { class: "muted" }, "To go back to a day, copy its file over the data file; open windows show it once they get focus.")),
    card("Updates", updates.channelSettings()));
}

function settingsForm(store) {
  const { withdrawalRate, bufferPercent, currency: code, numberFormat, expectedReturn, inflation, birthYear, retirementAge } = store.settings;
  const codes = Intl.supportedValuesOf("currency");
  if (!codes.includes(code)) codes.push(code);
  return h("form", { class: "settings-form", onsubmit: (event) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const chosen = String(data.get("currency"));
    const format = String(data.get("numberFormat"));
    const rate = F.parsePercent(data.get("withdrawalRate"), { decimals: RATE_DECIMALS });
    const buffer = F.parsePercent(data.get("bufferPercent"));
    const growth = F.parsePercent(data.get("expectedReturn"));
    const prices = F.parsePercent(data.get("inflation"));
    const birthText = String(data.get("birthYear")).trim();
    const ageText = String(data.get("retirementAge")).trim();
    const born = birthText === "" ? null : Number(birthText);
    const age = Number(ageText);
    const thisYear = new Date().getFullYear();
    const { min: firstYear } = F.BIRTH_YEARS;
    const ages = F.RETIREMENT_AGES;
    let error = null;
    if (!F.isCurrency(chosen)) error = "Currency: choose one from the list.";
    else if (!F.NUMBER_FORMATS.includes(format)) error = "Number format: choose one from the list.";
    else if (!rate.ok || !(rate.value > 0 && rate.value <= 100)) error = `Withdrawal rate: enter a percentage above 0 and at most 100, with up to ${RATE_DECIMALS} decimals.`;
    else if (!buffer.ok || !(buffer.value >= 0 && buffer.value <= 100)) error = "Buffer: enter a percentage from 0 to 100.";
    else if (!growth.ok || !(growth.value >= 0 && growth.value <= 100)) error = "Expected return: enter a percentage from 0 to 100.";
    else if (!prices.ok || !(prices.value >= 0 && prices.value <= 100)) error = "Inflation: enter a percentage from 0 to 100.";
    else if (born !== null && !(/^[0-9]{4}$/.test(birthText) && born >= firstYear && born <= thisYear)) error = `Year of birth: enter a year from ${firstYear} to ${thisYear}, or leave it empty.`;
    else if (!/^[0-9]+$/.test(ageText) || age < ages.min || age > ages.max) error = `Retirement age: enter whole years from ${ages.min} to ${ages.max}.`;
    if (error) return showError(event.currentTarget, error);
    commit(F.saveSettings(store, {
      currency: chosen,
      numberFormat: format,
      withdrawalRate: rate.value,
      bufferPercent: buffer.value,
      expectedReturn: growth.value,
      inflation: prices.value,
      birthYear: born,
      retirementAge: age,
    }), "Settings saved.");
  } },
    h("label", null, "Currency",
      h("select", { name: "currency", value: code }, codes.sort().map((c) => h("option", { value: c }, `${c} – ${currencyName(c)}`)))),
    h("p", { class: "muted" }, "How amounts are shown. Changing it does not convert amounts already entered."),
    h("label", null, "Number format",
      h("select", { name: "numberFormat", value: numberFormat }, F.NUMBER_FORMATS.map((f) => h("option", { value: f }, f)))),
    h("p", { class: "muted" }, "How amounts and percentages are shown. Amounts can be typed either way."),
    h("label", null, "Safe withdrawal rate (%)", h("input", { name: "withdrawalRate", inputmode: "decimal", value: plainRate.format(withdrawalRate), required: true })),
    h("p", { class: "muted" }, "The share of the portfolio you plan to spend each year once financially independent. FI number = yearly expenses ÷ this rate: at 4 % that is 25 × yearly expenses. Many use 3 to 3.5 % for longer retirements or to allow for taxes."),
    h("label", null, "Buffer on expenses (%)", h("input", { name: "bufferPercent", inputmode: "decimal", value: plain.format(bufferPercent), required: true })),
    h("p", { class: "muted" }, "Added on top of regular expenses for irregular costs such as holidays and repairs."),
    h("label", null, "Expected return (%)", h("input", { name: "expectedReturn", inputmode: "decimal", value: plain.format(expectedReturn), required: true })),
    h("p", { class: "muted" }, `The portfolio's yearly return before inflation, for Time to FI and the Path to FI chart on the dashboard, and the forecast; both also show ${F.RETURN_SPREAD} points less and more. World stocks have returned about 8 % a year over the long run, about 5 % after inflation, with many years far above or below that.`),
    h("label", null, "Inflation (%)", h("input", { name: "inflation", inputmode: "decimal", value: plain.format(inflation), required: true })),
    h("p", { class: "muted" }, "How much prices rise a year. Time to FI, the Path to FI chart and the forecast raise your expenses and the FI number by it, so their amounts are in the money of each year. What is paid in stays the same: when your pay-ins rise, so does their average."),
    h("label", null, "Year of birth", h("input", { name: "birthYear", inputmode: "numeric", autocomplete: "off", value: birthYear === null ? "" : String(birthYear), placeholder: "1990" })),
    h("label", null, "Retirement age", h("input", { name: "retirementAge", inputmode: "numeric", autocomplete: "off", value: String(retirementAge), required: true })),
    h("p", { class: "muted" }, "For the ", h("a", { href: "#forecast" }, "forecast"), ": the official retirement age, 67 in Germany for everyone born in 1964 or later. ",
      "Retirement starts in January of the year you reach it."),
    h("div", { class: "form-actions" }, h("button", { type: "submit", class: "primary" }, "Save")));
}

// A list of names, each with Rename and Delete, and a field to add one.
// `list` tells this list apart in state.renaming. rows: [{ key, name,
// detail }]; save(key or null to add, name, form data) returns { ok,
// store, error }; remove(row) asks and deletes. control(row) and
// addControl(), when given, add a field to each row and to the add form.
function nameList({ list, rows, placeholder, addLabel, save, remove, control, addControl }) {
  const renaming = state.renaming?.list === list ? state.renaming.key : null;
  const items = rows.map((row) => {
    if (row.key === renaming) {
      return h("li", null, h("form", { class: "inline", onsubmit: (event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        const result = save(row.key, data.get("name"), data);
        if (!result.ok) return showError(event.currentTarget, `${result.error}.`);
        state.renaming = null;
        commit(result.store, "Renamed.");
      } },
        h("input", { id: `rename-${list}`, name: "name", value: row.name, "aria-label": `New name for ${row.name}`, autocomplete: "off" }),
        h("button", { type: "submit", class: "primary" }, "Save"),
        h("button", { type: "button", onclick: () => { state.renaming = null; render(); } }, "Cancel")));
    }
    return h("li", null,
      h("span", { class: "grow" }, row.name), control ? control(row) : null, h("span", { class: "muted" }, row.detail),
      h("button", { type: "button", class: "link", "aria-label": `Rename ${row.name}`,
        onclick: () => { state.renaming = { list, key: row.key }; state.focus = `#rename-${list}`; render(); } }, "Rename"),
      h("button", { type: "button", class: "link danger", "aria-label": `Delete ${row.name}`, onclick: () => remove(row) }, "Delete"));
  });
  return [
    items.length ? h("ul", { class: "name-list" }, items) : null,
    h("form", { class: "inline", onsubmit: (event) => {
      event.preventDefault();
      const data = new FormData(event.currentTarget);
      const name = String(data.get("name")).trim();
      const result = save(null, name, data);
      if (!result.ok) return showError(event.currentTarget, `${result.error}.`);
      state.focus = `#new-${list}`;
      commit(result.store, `Added ${name}.`);
    } },
      h("input", { id: `new-${list}`, name: "name", placeholder, "aria-label": placeholder, autocomplete: "off" }),
      addControl ? addControl() : null,
      h("button", { type: "submit" }, addLabel)),
  ];
}

function accountList(store) {
  const kindSelect = (props) => h("select", props, F.ACCOUNT_KINDS.map((kind) => h("option", { value: kind }, kindLabel(kind))));
  return nameList({
    list: "accounts",
    rows: store.accounts.map((account) => {
      const count = store.records.filter((r) => r.account === account.id).length;
      return { key: account.id, name: account.name, kind: account.kind, count, detail: count === 1 ? "1 month" : `${count} months` };
    }),
    placeholder: "Account, e.g. Trade Republic",
    addLabel: "Add account",
    control: (row) => kindSelect({ value: row.kind, "aria-label": `What ${row.name} holds`, onchange: (event) => {
      const result = F.saveAccount(store, row.key, row.name, event.target.value);
      if (result.ok) commit(result.store, `${row.name}: ${kindLabel(event.target.value)}.`);
    } }),
    addControl: () => kindSelect({ name: "kind", value: "invested", "aria-label": "What it holds" }),
    save: (id, name, data) => F.saveAccount(store, id, name, data?.get("kind") ?? undefined),
    remove: ({ key, name, count }) => {
      if (!confirm(count ? `Delete ${name} and its ${count} monthly values?` : `Delete ${name}?`)) return;
      commit(F.deleteAccount(store, key), `Deleted ${name}.`);
    },
  });
}

function categoryList(store, kind) {
  const entries = (n) => (n === 1 ? "1 entry" : `${n} entries`);
  return nameList({
    list: kind,
    rows: store.categories[kind].map((name) => {
      const count = F.categoryUse(store, kind, name);
      return { key: name, name, count, detail: count ? entries(count) : "not used" };
    }),
    placeholder: kind === "expenses" ? "New expense category" : "New income category",
    addLabel: "Add",
    save: (oldName, name) => F.saveCategory(store, kind, oldName, name),
    remove: ({ name, count }) => {
      if (!confirm(count ? `Delete ${name}? ${entries(count)} will have no category.` : `Delete ${name}?`)) return;
      commit(F.deleteCategory(store, kind, name), `Deleted ${name}.`);
    },
  });
}

function importCard(store) {
  const plan = state.importPlan;
  const textarea = h("textarea", { id: "import-text", rows: 8, spellcheck: "false", "aria-label": "CSV text",
    placeholder: "date;account;value;pay_in\n31.01.2025;Trade Republic;12.345,67;500\n31.01.2025;ING;8.000;0",
    oninput: (event) => {
      // The checked rows no longer match the text: take back the Import button.
      state.importText = event.target.value;
      state.importPlan = null;
      document.getElementById("import-go")?.remove();
      document.getElementById("import-result")?.remove();
    } });
  textarea.value = state.importText;
  return h("section", { class: "card" },
    h("details", { open: state.importText !== "" || null },
      h("summary", null, h("h2", null, "Import past months from CSV")),
      h("p", null, "One row per account and month, with the columns ", h("code", null, "date"), ", ", h("code", null, "account"), ", ",
        h("code", null, "value"), ", ", h("code", null, "pay_in"), ", ", h("code", null, "one_off"), " and ", h("code", null, "kind"),
        " (the last three optional; kind is what a new account holds: invested, cash, property, pension or debt). Dates as 2025-01-31, 2025.01.31 or 31.01.2025: a row counts for the month of its date. ",
        "Semicolons, commas or tabs work, and so do amounts like 1.234,56 or 1,234.56. ",
        "Rows for a month and account that already exist replace the old values. New account names become new accounts."),
      h("div", { class: "form-actions" },
        h("label", { class: "file" }, "Choose a file…", h("input", { type: "file", accept: ".csv,.tsv,.txt,text/csv,text/plain", onchange: async (event) => {
          const file = event.target.files[0];
          if (!file) return;
          state.importText = await file.text();
          state.importPlan = F.planImport(state.store, state.importText);
          render();
        } })),
        h("span", { class: "muted" }, "or paste rows from a spreadsheet:")),
      textarea,
      h("div", { class: "form-actions" },
        h("button", { type: "button", onclick: () => { state.importPlan = F.planImport(store, state.importText); render(); } }, "Check"),
        plan && plan.errors.length === 0 && plan.entries.length > 0
          ? h("button", { id: "import-go", type: "button", class: "primary", onclick: () => {
              // Accounts may have changed since Check: check again against
              // the current data, and show the new result instead of
              // importing if it differs from what is on screen.
              const fresh = F.planImport(state.store, state.importText);
              if (JSON.stringify(fresh) !== JSON.stringify(plan)) {
                state.importPlan = fresh;
                return render();
              }
              const count = fresh.entries.length;
              const next = F.applyImport(state.store, fresh);
              state.importText = "";
              state.importPlan = null;
              commit(next, `Imported ${count} ${count === 1 ? "row" : "rows"}.`);
            } }, `Import ${plan.entries.length} ${plan.entries.length === 1 ? "row" : "rows"}`)
          : null),
      plan ? importResult(plan) : null));
}

function exportCard(store) {
  const rows = store.records.length;
  const months = new Set(store.records.map((r) => r.month)).size;
  return card("Export portfolio to CSV",
    h("p", null, "Every monthly value with the columns ", h("code", null, "date"), " (the last day of the month), ", h("code", null, "account"), ", ",
      h("code", null, "value"), ", ", h("code", null, "pay_in"), ", ", h("code", null, "one_off"), " and ", h("code", null, "kind"), ": opens in a spreadsheet, and the import above reads it back."),
    h("div", { class: "form-actions" },
      h("button", { type: "button", disabled: rows === 0, onclick: () => {
        const d = new Date();
        const date = [d.getFullYear(), d.getMonth() + 1, d.getDate()].map((n) => String(n).padStart(2, "0")).join("-");
        // The byte order mark tells spreadsheets the file is UTF-8.
        download(`finance-portfolio-${date}.csv`, `\ufeff${F.exportCsv(state.store, { decimal: decimalSign })}`, "text/csv;charset=utf-8");
      } }, "Export CSV"),
      h("span", { class: "muted" }, rows === 0 ? "Nothing to export yet." : `${rows} ${rows === 1 ? "row" : "rows"} for ${months} ${months === 1 ? "month" : "months"}`)));
}

function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = h("a", { href: url, download: name, hidden: true });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

function importResult(plan) {
  if (plan.errors.length > 0) {
    return h("div", { id: "import-result", class: "import-result error", role: "alert" },
      h("p", null, `Nothing imported. Fix ${plan.errors.length === 1 ? "this line" : `these ${plan.errors.length} problems`} and check again:`),
      h("ul", null, plan.errors.slice(0, 50).map((e) => h("li", null, e.line ? `Line ${e.line}: ${e.message}` : e.message))),
      plan.errors.length > 50 ? h("p", null, `…and ${plan.errors.length - 50} more.`) : null);
  }
  if (plan.entries.length === 0) return h("div", { id: "import-result", class: "import-result error", role: "alert" }, h("p", null, "There are no rows below the column names."));
  const months = new Set(plan.entries.map((e) => e.month));
  const sorted = [...months].sort();
  return h("div", { id: "import-result", class: "import-result" },
    h("p", null, `${plan.entries.length} rows for ${months.size} ${months.size === 1 ? "month" : "months"} (${monthLabel(sorted[0])} to ${monthLabel(sorted.at(-1))}): `,
      `${plan.added} new`, plan.replaced ? `, ${plan.replaced} replace existing values` : "", "."),
    plan.newAccounts.length ? h("p", null, `New accounts: ${plan.newAccounts.join(", ")}.`) : null);
}

// ---------------------------------------------------------------- start

state.view = viewFromHash();
const updates = startUpdates(document.getElementById("update"), { saving: () => inFlight || pending !== null });
load();
