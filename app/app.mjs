// Finance UI: loads the data from the local server, renders one view at a
// time, and saves every change straight away.

import * as F from "./finance.mjs";
import { goalVisible, renderChart } from "./chart.mjs";

// ---------------------------------------------------------------- formatting

const locale = navigator.language || "de-DE";
const percent = new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 1 });
const plain = new Intl.NumberFormat(locale, { maximumFractionDigits: 2, useGrouping: false });
// Only "," or ".", the two the CSV import reads.
const decimalSign = plain.formatToParts(1.5).find((part) => part.type === "decimal")?.value === "," ? "," : ".";

// Money formats for the currency in settings; render() switches them.
let currency = null;
let whole;
let exact;
let axis;
function useCurrency(code) {
  if (code === currency) return;
  currency = code;
  whole = new Intl.NumberFormat(locale, { style: "currency", currency: code, maximumFractionDigits: 0 });
  // Two decimals for every currency, since amounts are stored in hundredths.
  exact = new Intl.NumberFormat(locale, { style: "currency", currency: code, minimumFractionDigits: 2, maximumFractionDigits: 2 });
  axis = new Intl.NumberFormat(locale, { style: "currency", currency: code, notation: "compact", maximumFractionDigits: 1 });
}
useCurrency(F.DEFAULT_SETTINGS.currency);

const money = (cents) => whole.format(Math.round(cents / 100));
const moneyExact = (cents) => exact.format(cents / 100);
const signedMoney = (cents) => (cents > 0 ? "+" : "") + money(cents);
const inputMoney = (cents) => plain.format(cents / 100);

let currencyNames = null;
try {
  currencyNames = new Intl.DisplayNames([locale], { type: "currency" });
} catch {
  // codes only
}
const currencyName = (code) => currencyNames?.of(code) ?? code;

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

const KINDS = {
  expenses: { title: "Expenses", one: "expense", noun: "Regular expenses" },
  income: { title: "Income", one: "income", noun: "Net income" },
};

// In this order on Ctrl+1 to Ctrl+5.
const VIEWS = [
  ["dashboard", "Dashboard"],
  ["expenses", "Expenses"],
  ["income", "Income"],
  ["portfolio", "Portfolio"],
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

const state = {
  store: null,
  revision: null,
  file: "",
  blocked: null, // why nothing can be saved, e.g. an unreadable data file
  notice: null, // { kind: "error" | "info", text }
  view: "dashboard",
  editing: { expenses: null, income: null }, // item id being edited
  renaming: null, // { list: "accounts" | "expenses" | "income", key: account id or category name }
  month: null,
  importText: "",
  importPlan: null,
  chartScale: "goal",
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

// Ctrl+1 to Ctrl+5 open the views. Matched by key position, not by the
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
  if (state.store) useCurrency(state.store.settings.currency);
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
    const views = { dashboard: viewDashboard, expenses: () => viewItems("expenses"), income: () => viewItems("income"), portfolio: viewPortfolio, settings: viewSettings };
    content.push(views[state.view]());
  }
  main.replaceChildren(...content);

  if (state.view === "dashboard" && state.store) drawChart();
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
  const { withdrawalRate, bufferPercent } = store.settings;
  const empty = store.income.length === 0 && store.expenses.length === 0 && store.records.length === 0;

  const progress = m.fiProgress === null ? null : h("div", { class: "meter", role: "presentation" }, h("div", { class: "meter-fill" }));

  const tiles = h("div", { class: "tiles" },
    tile("Monthly income", store.income.length ? money(m.income) : "–",
      store.income.length ? `net, ${money(m.income * 12)} a year` : h("a", { href: "#income" }, "Add income")),
    tile("Monthly expenses", store.expenses.length ? money(m.expenses) : "–",
      store.expenses.length ? `incl. ${plain.format(bufferPercent)} % buffer (${money(m.buffer)})` : h("a", { href: "#expenses" }, "Add expenses")),
    tile("Investment rate", m.investmentRate === null ? "–" : percent.format(m.investmentRate),
      m.payIn === null
        ? h("a", { href: "#portfolio" }, "Add pay-ins")
        : `${money(m.payIn.average)} a month paid in, average of ${m.payIn.months === 12 ? "the last 12 months" : m.payIn.months === 1 ? "1 month" : `${m.payIn.months} months`}`),
    tile("Portfolio", m.portfolio === null ? "–" : money(m.portfolio),
      m.latestMonth ? `as of ${monthLabel(m.latestMonth)}` : h("a", { href: "#portfolio" }, "Add broker values")),
    tile("FI number", store.expenses.length ? money(m.fiNumber) : "–",
      `${plain.format(m.multiple)} × yearly expenses (${plain.format(withdrawalRate)} % withdrawal rate)`),
    tile("FI reached", m.fiProgress === null ? "–" : percent.format(m.fiProgress),
      m.fiProgress === null ? "needs expenses and a portfolio value" : m.fiProgress >= 1 ? "Financially independent" : `${money(m.fiNumber - m.portfolio)} to go`,
      progress),
  );
  if (progress) progress.firstChild.style.width = `${Math.min(100, m.fiProgress * 100)}%`;

  const parts = [tiles];
  if (empty) {
    parts.push(card("Get started",
      h("p", null, "Add your regular ", h("a", { href: "#income" }, "income"), " and ", h("a", { href: "#expenses" }, "expenses"),
        ", then your ", h("a", { href: "#settings" }, "broker accounts"), " and their ", h("a", { href: "#portfolio" }, "monthly values and pay-ins"), "."),
      h("p", { class: "muted" }, "Currency and categories are in ", h("a", { href: "#settings" }, "Settings"), ".")));
  }

  if (m.series.length > 0) {
    const scaleButton = (scale, label) =>
      h("button", { type: "button", class: state.chartScale === scale ? "seg active" : "seg", "aria-pressed": String(state.chartScale === scale),
        onclick: () => { state.chartScale = scale; render(); } }, label);
    parts.push(h("section", { class: "card" },
      h("div", { class: "card-head" },
        h("h2", null, "Portfolio"),
        h("div", { class: "legend" },
          h("span", null, h("span", { class: "key value" }), "Portfolio value"),
          h("span", null, h("span", { class: "key paid" }), "Paid in, total"),
          goalVisible(m.series, chartGoal(m), state.chartScale) ? h("span", null, h("span", { class: "key goal" }), "FI number") : null),
        h("div", { class: "segmented", role: "group", "aria-label": "Chart scale" }, scaleButton("goal", "Up to FI number"), scaleButton("data", "Fit to data"))),
      h("div", { id: "chart", class: "chart-box" })));
  }

  const breakdown = (kind, total) => {
    const groups = F.byCategory(store[kind]);
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
  const columns = [breakdown("expenses", m.baseExpenses), breakdown("income", m.income)].filter(Boolean);
  if (columns.length) parts.push(h("div", { class: "columns" }, columns));
  return h("div", null, parts);
}

// No expenses, no FI number: the chart then has no goal line.
const chartGoal = (m) => (state.store.expenses.length ? m.fiNumber : 0);

let resizeObserver = null;
function drawChart() {
  const box = document.getElementById("chart");
  if (!box) return;
  const m = F.metrics(state.store);
  const draw = () =>
    renderChart(box, {
      series: m.series,
      fiNumber: chartGoal(m),
      scale: state.chartScale,
      format: money,
      formatAxis: (cents) => axis.format(cents / 100),
      formatMonth: monthLabel,
      monthNumber: F.monthIndex,
    });
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

function viewItems(kind) {
  const store = state.store;
  const info = KINDS[kind];
  const items = store[kind];
  const editing = items.find((item) => item.id === state.editing[kind]) ?? null;
  const monthlyTotal = items.reduce((t, item) => t + F.monthlyAmount(item), 0);

  let summary;
  if (kind === "expenses") {
    const buffer = (monthlyTotal * store.settings.bufferPercent) / 100;
    summary = h("dl", { class: "summary" },
      h("div", null, h("dt", null, "Regular expenses"), h("dd", { class: "num" }, `${money(monthlyTotal)} / month`)),
      h("div", null, h("dt", null, `Buffer, ${plain.format(store.settings.bufferPercent)} %`), h("dd", { class: "num" }, `${money(buffer)} / month`)),
      h("div", null, h("dt", null, "Total"), h("dd", { class: "num strong" }, `${money(monthlyTotal + buffer)} / month · ${money((monthlyTotal + buffer) * 12)} / year`)));
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
      if (error) return showError(event.currentTarget, error);
      const item = { id: editing?.id ?? F.newId(), name, category, amount: amount.cents, everyMonths };
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
    h("label", null, kind === "income" ? "Amount (net)" : "Amount", h("input", { name: "amount", inputmode: "decimal", autocomplete: "off", required: true, value: editing ? inputMoney(editing.amount) : "", placeholder: "0,00" })),
    h("label", null, "Paid every … months",
      h("input", { name: "everyMonths", type: "number", min: 1, max: 120, step: 1, required: true, list: "intervals", value: String(editing?.everyMonths ?? 1) })),
    h("datalist", { id: "intervals" }, INTERVALS.map(([v, label]) => h("option", { value: String(v), label }))),
    h("div", { class: "form-actions" },
      h("button", { type: "submit", class: "primary" }, editing ? "Save" : "Add"),
      editing ? h("button", { type: "button", onclick: () => { state.editing[kind] = null; render(); } }, "Cancel") : null),
  );

  const rows = [];
  for (const group of F.byCategory(items)) {
    rows.push(h("tr", { class: "group" }, h("th", { colspan: 3, scope: "rowgroup" }, group.category || "No category"), h("td", { class: "num" }, money(group.monthly)), h("td")));
    for (const item of group.items) {
      rows.push(h("tr", { class: item.id === state.editing[kind] ? "editing" : null },
        h("td", null, item.name),
        h("td", { class: "num" }, moneyExact(item.amount)),
        h("td", null, intervalLabel(item.everyMonths)),
        h("td", { class: "num" }, money(F.monthlyAmount(item))),
        h("td", { class: "actions" },
          h("button", { type: "button", class: "link", onclick: () => { state.editing[kind] = item.id; state.focus = "#item-name"; render(); } }, "Edit"),
          h("button", { type: "button", class: "link danger", onclick: () => {
            if (!confirm(`Delete ${item.name}?`)) return;
            if (state.editing[kind] === item.id) state.editing[kind] = null;
            commit(F.deleteItem(store, kind, item.id), `Deleted ${item.name}.`);
          } }, "Delete"))));
    }
  }

  return h("div", null,
    card(info.title, summary,
      h("p", { class: "muted" },
        kind === "income" ? "Enter amounts after tax. A yearly bonus counts as one twelfth per month. " : "Regular payments only. Pay-ins to broker accounts go under Portfolio, not here. ",
        categories.length ? "Categories are set in " : "There are no categories yet: add them in ",
        h("a", { href: "#settings" }, "Settings"), "."),
      h("h3", null, editing ? `Edit ${editing.name}` : `Add ${info.one === "income" ? "income" : "an expense"}`),
      form),
    items.length
      ? card(null, h("div", { class: "table-wrap" }, h("table", null,
          h("thead", null, h("tr", null, h("th", null, "Name"), h("th", { class: "num" }, "Amount"), h("th", null, "Paid"), h("th", { class: "num" }, "Per month"), h("th"))),
          h("tbody", null, rows))))
      : null);
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
        if (valueText === "" && payInText === "") {
          entries.push({ account: account.id, value: null, payIn: 0 });
          continue;
        }
        const value = F.parseMoney(valueText);
        const payIn = payInText === "" ? { ok: true, cents: 0 } : F.parseMoney(payInText);
        if (valueText === "") errors.push(`${account.name}: enter the value too.`);
        else if (!value.ok) errors.push(`${account.name} value: ${value.error}.`);
        else if (value.cents < 0) errors.push(`${account.name} value: must not be negative.`);
        if (!payIn.ok) errors.push(`${account.name} pay-in: ${payIn.error}.`);
        if (valueText !== "" && value.ok && value.cents >= 0 && payIn.ok) entries.push({ account: account.id, value: value.cents, payIn: payIn.cents });
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
      ? h("p", { class: "muted" }, "Add your broker accounts in ", h("a", { href: "#settings" }, "Settings"), " first, or import past months from a CSV file there.")
      : h("div", { class: "table-wrap" }, h("table", { class: "entry" },
          h("thead", null, h("tr", null, h("th", null, "Account"), h("th", null, "Value at month end"), h("th", null, "Paid in this month"))),
          h("tbody", null, store.accounts.map((account) => {
            const record = monthRecords.get(account.id);
            const before = lastValueBefore(store, account.id, month);
            return h("tr", null,
              h("th", { scope: "row" }, account.name),
              h("td", null, h("input", { name: `value-${account.id}`, inputmode: "decimal", autocomplete: "off", "aria-label": `${account.name} value`,
                value: record ? inputMoney(record.value) : "", placeholder: before ? `last: ${inputMoney(before.value)}` : "0,00" })),
              h("td", null, h("input", { name: `payin-${account.id}`, inputmode: "decimal", autocomplete: "off", "aria-label": `${account.name} pay-in`,
                value: record && record.payIn !== 0 ? inputMoney(record.payIn) : "", placeholder: "0,00" })));
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

  // ---- history
  const series = F.portfolioSeries(store);
  const byMonth = new Map();
  for (const r of store.records) {
    if (!byMonth.has(r.month)) byMonth.set(r.month, new Map());
    byMonth.get(r.month).set(r.account, r);
  }
  const history = series.length === 0 ? null : card("History",
    h("p", { class: "muted" }, "An account without a value in a month counts with its last value. Click a month to change it."),
    h("div", { class: "table-wrap" }, h("table", { class: "history" },
      h("thead", null, h("tr", null, h("th", null, "Month"), store.accounts.map((a) => h("th", { class: "num" }, a.name)), h("th", { class: "num" }, "Total"), h("th", { class: "num" }, "Paid in"))),
      h("tbody", null, [...series].reverse().map((m) => {
        const records = byMonth.get(m.month);
        return h("tr", { class: m.month === month ? "editing" : null },
          h("th", { scope: "row" }, h("button", { type: "button", class: "link", onclick: () => { state.month = m.month; render(); scrollTo(0, 0); } }, monthLabel(m.month))),
          store.accounts.map((a) => {
            const r = records?.get(a.id);
            return h("td", { class: "num" }, r ? money(r.value) : h("span", { class: "muted" }, "–"),
              r && r.payIn !== 0 ? h("div", { class: "sub" }, signedMoney(r.payIn)) : null);
          }),
          h("td", { class: "num strong" }, money(m.value)),
          h("td", { class: "num" }, m.payIn !== 0 ? signedMoney(m.payIn) : h("span", { class: "muted" }, "–")));
      })))));

  return h("div", null,
    card("Monthly values", monthForm,
      h("p", { class: "muted" }, "Broker accounts, CSV import and export are in ", h("a", { href: "#settings" }, "Settings"), ".")),
    history);
}

// ---------------------------------------------------------------- settings

function viewSettings() {
  const store = state.store;
  return h("div", null,
    card("General", settingsForm(store)),
    card("Categories",
      h("p", { class: "muted" }, "Expenses and income each have their own. Renaming a category renames it everywhere; deleting one leaves what had it without a category."),
      h("div", { class: "columns" }, F.KINDS.map((kind) => h("div", null, h("h3", null, KINDS[kind].title), categoryList(store, kind))))),
    card("Broker accounts", accountList(store)),
    importCard(store),
    exportCard(store),
    card("Data file", h("p", null, "Everything is saved in one file on this computer:"), h("p", null, h("code", null, state.file)),
      h("p", { class: "muted" }, "No account and no sync. Copy the file to back it up.")));
}

function settingsForm(store) {
  const { withdrawalRate, bufferPercent, currency: code } = store.settings;
  const codes = Intl.supportedValuesOf("currency");
  if (!codes.includes(code)) codes.push(code);
  return h("form", { class: "settings-form", onsubmit: (event) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const chosen = String(data.get("currency"));
    const rate = F.parsePercent(data.get("withdrawalRate"));
    const buffer = F.parsePercent(data.get("bufferPercent"));
    let error = null;
    if (!F.isCurrency(chosen)) error = "Currency: choose one from the list.";
    else if (!rate.ok || !(rate.value > 0 && rate.value <= 100)) error = "Withdrawal rate: enter a percentage above 0 and at most 100.";
    else if (!buffer.ok || !(buffer.value >= 0 && buffer.value <= 100)) error = "Buffer: enter a percentage from 0 to 100.";
    if (error) return showError(event.currentTarget, error);
    commit(F.saveSettings(store, { currency: chosen, withdrawalRate: rate.value, bufferPercent: buffer.value }), "Settings saved.");
  } },
    h("label", null, "Currency",
      h("select", { name: "currency", value: code }, codes.sort().map((c) => h("option", { value: c }, `${c} – ${currencyName(c)}`)))),
    h("p", { class: "muted" }, "How amounts are shown. Changing it does not convert amounts already entered."),
    h("label", null, "Safe withdrawal rate (%)", h("input", { name: "withdrawalRate", inputmode: "decimal", value: plain.format(withdrawalRate), required: true })),
    h("p", { class: "muted" }, "The share of the portfolio you plan to spend each year once financially independent. FI number = yearly expenses ÷ this rate: at 4 % that is 25 × yearly expenses. Many use 3 to 3.5 % for longer retirements or to allow for taxes."),
    h("label", null, "Buffer on expenses (%)", h("input", { name: "bufferPercent", inputmode: "decimal", value: plain.format(bufferPercent), required: true })),
    h("p", { class: "muted" }, "Added on top of regular expenses for irregular costs such as holidays and repairs."),
    h("div", { class: "form-actions" }, h("button", { type: "submit", class: "primary" }, "Save")));
}

// A list of names, each with Rename and Delete, and a field to add one.
// `list` tells this list apart in state.renaming. rows: [{ key, name,
// detail }]; save(key or null to add, name) returns { ok, store, error };
// remove(row) asks and deletes.
function nameList({ list, rows, placeholder, addLabel, save, remove }) {
  const renaming = state.renaming?.list === list ? state.renaming.key : null;
  const items = rows.map((row) => {
    if (row.key === renaming) {
      return h("li", null, h("form", { class: "inline", onsubmit: (event) => {
        event.preventDefault();
        const result = save(row.key, new FormData(event.currentTarget).get("name"));
        if (!result.ok) return showError(event.currentTarget, `${result.error}.`);
        state.renaming = null;
        commit(result.store, "Renamed.");
      } },
        h("input", { id: `rename-${list}`, name: "name", value: row.name, "aria-label": `New name for ${row.name}`, autocomplete: "off" }),
        h("button", { type: "submit", class: "primary" }, "Save"),
        h("button", { type: "button", onclick: () => { state.renaming = null; render(); } }, "Cancel")));
    }
    return h("li", null,
      h("span", { class: "grow" }, row.name), h("span", { class: "muted" }, row.detail),
      h("button", { type: "button", class: "link", "aria-label": `Rename ${row.name}`,
        onclick: () => { state.renaming = { list, key: row.key }; state.focus = `#rename-${list}`; render(); } }, "Rename"),
      h("button", { type: "button", class: "link danger", "aria-label": `Delete ${row.name}`, onclick: () => remove(row) }, "Delete"));
  });
  return [
    items.length ? h("ul", { class: "name-list" }, items) : null,
    h("form", { class: "inline", onsubmit: (event) => {
      event.preventDefault();
      const name = String(new FormData(event.currentTarget).get("name")).trim();
      const result = save(null, name);
      if (!result.ok) return showError(event.currentTarget, `${result.error}.`);
      state.focus = `#new-${list}`;
      commit(result.store, `Added ${name}.`);
    } },
      h("input", { id: `new-${list}`, name: "name", placeholder, "aria-label": placeholder, autocomplete: "off" }),
      h("button", { type: "submit" }, addLabel)),
  ];
}

function accountList(store) {
  return nameList({
    list: "accounts",
    rows: store.accounts.map((account) => {
      const count = store.records.filter((r) => r.account === account.id).length;
      return { key: account.id, name: account.name, count, detail: count === 1 ? "1 month" : `${count} months` };
    }),
    placeholder: "Broker account, e.g. Trade Republic",
    addLabel: "Add account",
    save: (id, name) => F.saveAccount(store, id, name),
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
    placeholder: "month;account;value;pay_in\n2025-01;Trade Republic;12.345,67;500\n2025-01;ING;8.000;0",
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
      h("p", null, "One row per account and month, with the columns ", h("code", null, "month"), ", ", h("code", null, "account"), ", ",
        h("code", null, "value"), " and ", h("code", null, "pay_in"), ". Semicolons, commas or tabs work, and so do amounts like 1.234,56 or 1,234.56. ",
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
    h("p", null, "Every monthly value with the columns ", h("code", null, "month"), ", ", h("code", null, "account"), ", ",
      h("code", null, "value"), " and ", h("code", null, "pay_in"), ": opens in a spreadsheet, and the import above reads it back."),
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
load();
