// Finance UI: loads the data from the local server, renders one view at a
// time, and saves every change straight away.

import * as F from "./finance.mjs";
import { goalVisible, renderChart, renderForecast, statusBadge } from "./chart.mjs";
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
let tenths;
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
  tenths = new Intl.NumberFormat(numbers, { maximumFractionDigits: 1, useGrouping: false });
  zero = new Intl.NumberFormat(numbers, { minimumFractionDigits: 2 }).format(0);
  whole = new Intl.NumberFormat(numbers, { style: "currency", currency: code, maximumFractionDigits: 0 });
  // Two decimals for every currency, since amounts are stored in hundredths.
  exact = new Intl.NumberFormat(numbers, { style: "currency", currency: code, minimumFractionDigits: 2, maximumFractionDigits: 2 });
  axis = new Intl.NumberFormat(numbers, { style: "currency", currency: code, notation: "compact", maximumFractionDigits: 1 });
}
useFormats(F.DEFAULT_SETTINGS);

// With amounts hidden (for sharing the screen), every amount shows as
// dots with the currency sign; percentages stay.
const hidden = () => state.hideAmounts;
const masked = (format) => format.format(0).replace(/[0-9]+([.,][0-9]+)?/, "•••");
const money = (cents) => (hidden() ? masked(whole) : whole.format(Math.round(cents / 100)));
const moneyExact = (cents) => (hidden() ? masked(exact) : exact.format(cents / 100));
const signedMoney = (cents) => (hidden() ? money(cents) : (cents > 0 ? "+" : "") + money(cents));
const axisMoney = (cents) => (hidden() ? masked(axis) : axis.format(cents / 100));
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

// A span of time in tenths of a year, so that spans worked out from the
// same months add up as shown; and a span in words ("1 year", "2,4 years").
const yearTenths = (months) => Math.round(months / 1.2);
const tenthsText = (t) => (t === 10 ? "1 year" : `${tenths.format(t / 10)} years`);
const monthsText = (months) => (months === 1 ? "1 month" : `${months} months`);

// The months the average pay-in is of, in words.
const payInMonths = (months) => (months === 12 ? "the last 12 months" : months === 1 ? "1 month" : `${months} months`);
// Where the future pay-in (metrics' payIn) comes from, in words.
const payInSource = (payIn) => (payIn.months === null ? "your own pay-in from Settings" : `the average pay-in of ${payInMonths(payIn.months)}`);
// The planned pay-in changes ahead and whether pay-ins rise with inflation
// (the FI outlook's payIn), in words for the notes; null when neither.
function payInPlanText(payIn) {
  const parts = [];
  if (payIn.changes.length) {
    const changes = payIn.changes.map((c) => `${c.average ? "the average, " : ""}${money(c.amount)} from ${monthLabel(c.month)}`);
    parts.push(`Then as planned in Settings: ${changes.join("; ")}.`);
  }
  if (payIn.rises) parts.push("Pay-ins rise with inflation.");
  return parts.length ? parts.join(" ") : null;
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

// The FI outlook of a store this month, kept while the store is the same:
// the milestones, the Path to FI chart and the Forecast share its
// projections.
const outlooks = new WeakMap();
function outlook(store) {
  const month = F.currentMonth();
  if (outlooks.get(store)?.month !== month) outlooks.set(store, { month, outlook: F.fiOutlook(store, month) });
  return outlooks.get(store).outlook;
}

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
  emergency: "Emergency fund",
  property: "Property",
  pension: "Pension assets",
  debt: "Debt",
};
const kindLabel = (kind) => ACCOUNT_KIND_LABELS[kind] ?? kind;
const isInvested = (account) => account.kind === "invested";

// In this order on Ctrl+1 to Ctrl+6.
const VIEWS = [
  ["dashboard", "Dashboard"],
  ["forecast", "Forecast"],
  ["portfolio", "Portfolio"],
  ["expenses", "Expenses"],
  ["income", "Income"],
  ["settings", "Settings"],
];

// The tabs of Settings, each at #settings/<tab>; #settings opens the first.
const SETTINGS_TABS = [
  ["data", "Data"],
  ["general", "General"],
  ["export", "Export/Import"],
];
// A link to a tab of Settings, with its text.
const settingsLink = (tab, text = "Settings") => h("a", { href: `#settings/${tab}` }, text);

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

// An ⓘ button that opens an explanation next to it, for what the page does
// not say itself: what a term means, how a number is worked out, what is
// assumed. A native popover: a click or Enter opens it, Esc or a click
// elsewhere closes it. `about` names it for screen readers.
let infoCount = 0;
function info(about, ...content) {
  const id = `info-${++infoCount}`;
  const button = h("button", { type: "button", class: "info-button", popovertarget: id, "aria-label": `About ${about}` }, "i");
  const pop = h("div", { id, popover: "auto", class: "info-pop" },
    content.map((part) => (typeof part === "string" || Array.isArray(part) ? h("p", null, part) : part)));
  // Through the CSSOM: the page's CSP blocks style attributes.
  button.style.setProperty("anchor-name", `--${id}`);
  pop.style.setProperty("position-anchor", `--${id}`);
  return h("span", { class: "info" }, button, pop);
}

// A form field: its label over the control, and an ⓘ when there is more to
// say. The label is a <label> of its own, so the ⓘ is not part of it.
let fieldCount = 0;
function field(text, control, ...help) {
  // A control of several parts, such as a month field, is labelled by its input.
  const target = control.labels === undefined ? control.querySelector("input") : control;
  if (!target.id) target.id = `field-${++fieldCount}`;
  return h("div", { class: "field" },
    h("span", { class: "field-label" }, h("label", { for: target.id }, text), help.length ? info(text, ...help) : null),
    control);
}

// A month field. Typed as the month's number and the year, "1 2027" or just
// 1 2 0 2 7 (F.parseMonth), and shown as "01/2027". ↑ and ↓ step a month,
// Page Up and Page Down a year. Its button, or Alt+↓, opens a picker: the
// twelve months of a year, with ‹ › for the year before and after, and the
// year to switch to a choice of years. Arrow keys move in it, Enter picks.
// A fieldset, so that hiding and disabling it does both for its input and
// buttons. onpick(month, left), for a field that switches what the page
// shows: called when a month is typed or picked; Enter in the field then
// picks instead of submitting the form. `left` is true when the month was
// typed and the field left (Tab or a click elsewhere, not into its picker):
// onpick then runs once the focus has moved on and a click is done, and
// not when that click drew the page again.
const CALENDAR = ["M5 5h14a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z", "M4 10h16", "M8 3v4", "M16 3v4"];
let monthNames = null;
const monthName = (i) => (monthNames ??= Array.from({ length: 12 }, (_, k) => new Intl.DateTimeFormat(locale, { month: "short" }).format(new Date(2026, k, 1))))[i];
const monthLong = (month) => new Intl.DateTimeFormat(locale, { month: "long", year: "numeric" }).format(new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1, 1));
const MONTH_HINT = "the month's number and the year, such as 1 2027";
const MONTH_ERROR = `Enter ${MONTH_HINT}.`;
// Whether a mouse button or a finger is down, for a month field left by a
// click: runs `then` once it is up and the click is done.
let pointerDown = false;
addEventListener("pointerdown", () => { pointerDown = true; }, true);
for (const type of ["pointerup", "pointercancel"]) addEventListener(type, () => { pointerDown = false; }, true);
function afterClick(then) {
  if (!pointerDown) return setTimeout(then);
  const done = () => {
    removeEventListener("pointerup", done, true);
    removeEventListener("pointercancel", done, true);
    setTimeout(then);
  };
  addEventListener("pointerup", done, true);
  addEventListener("pointercancel", done, true);
}
let monthFieldCount = 0;
function monthField({ id = null, name, value = "", label = null, required = false, onpick = null }) {
  const popId = `month-pop-${++monthFieldCount}`;
  const input = h("input", { id, name, class: "month-text", inputmode: "numeric", autocomplete: "off", spellcheck: "false", placeholder: "MM/YYYY",
    required, "aria-label": label, value: F.isMonth(value) ? F.monthToText(value) : "" });
  // Out of the Tab order, so Tab goes from the month to the next field.
  const open = h("button", { type: "button", class: "month-open", popovertarget: popId, tabindex: "-1", title: "Choose a month (Alt+↓)", "aria-label": "Choose a month" }, icon(CALENDAR));
  const pop = h("div", { id: popId, popover: "auto", class: "month-pop", role: "dialog", "aria-label": "Choose a month" });
  const wrap = h("fieldset", { class: "month-field" }, input, open, pop);
  // Through the CSSOM: the page's CSP blocks style attributes.
  wrap.style.setProperty("anchor-name", `--${popId}`);
  pop.style.setProperty("position-anchor", `--${popId}`);

  // Text that is no month stops the form, with how to type one.
  const check = () => input.setCustomValidity(input.value.trim() === "" || F.parseMonth(input.value) ? "" : MONTH_ERROR);
  let last = F.parseMonth(input.value);
  // Shows the month as 01/2027; onpick hears of a new one.
  const pick = (month, left = false) => {
    input.value = F.monthToText(month);
    check();
    if (month === last) return;
    last = month;
    onpick?.(month, left);
  };
  const typed = () => F.parseMonth(input.value);
  // From an empty field, ↑ or ↓ goes to this month; never past year 9999.
  const step = (n) => {
    const month = typed() ? F.addMonths(typed(), n) : F.currentMonth();
    if (F.parseMonth(F.monthToText(month))) pick(month);
  };

  input.addEventListener("input", check);
  // Left, the month shows as 01/2027.
  input.addEventListener("change", () => {
    if (!onpick && typed()) pick(typed());
  });
  // The picker draws its buttons anew as it moves, which moves the focus out
  // for a moment: what counts is where the focus is after that.
  wrap.addEventListener("focusout", (event) => {
    if (!onpick || wrap.contains(event.relatedTarget)) return;
    afterClick(() => {
      if (input.isConnected && !wrap.contains(document.activeElement) && typed()) pick(typed(), true);
    });
  });
  // All of it is selected on focus, so typing replaces it.
  input.addEventListener("focus", () => input.select());
  input.addEventListener("mousedown", (event) => {
    if (document.activeElement === input) return;
    event.preventDefault();
    input.focus();
  });
  input.addEventListener("keydown", (event) => {
    if (event.altKey && event.key === "ArrowDown") {
      event.preventDefault();
      if (!pop.matches(":popover-open")) pop.showPopover();
    } else if (event.key === "Enter" && onpick) {
      event.preventDefault();
      const month = typed();
      if (month) pick(month);
      else input.reportValidity();
    } else if (["ArrowUp", "ArrowDown", "PageUp", "PageDown"].includes(event.key) && !event.altKey && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      const n = event.key.startsWith("Page") || event.shiftKey ? 12 : 1;
      step(event.key === "ArrowUp" || event.key === "PageUp" ? n : -n);
    }
  });

  // The picker: the months of `shown.year`, or with shown.years the twelve
  // years from shown.from.
  const today = F.currentMonth();
  let shown = null;
  const yearOf = (month) => Number(month.slice(0, 4));
  const monthOf = (year, i) => `${String(year).padStart(4, "0")}-${String(i + 1).padStart(2, "0")}`;
  const head = (title, unit, n, ontitle) => h("div", { class: "month-head" },
    h("button", { type: "button", class: "month-step", "data-step": "-1", "aria-label": `Previous ${unit}`, onclick: () => move(-n) }, "‹"),
    ontitle
      ? h("button", { type: "button", class: "month-title", "aria-label": `${title}: choose a year`, onclick: ontitle }, title)
      : h("span", { class: "month-title" }, title),
    h("button", { type: "button", class: "month-step", "data-step": "1", "aria-label": `Next ${unit}`, onclick: () => move(n) }, "›"));
  const choose = (month) => {
    pop.hidePopover();
    pick(month);
    if (input.isConnected) input.focus();
  };
  function draw(focus = null) {
    const selected = typed();
    if (shown.years) {
      const years = Array.from({ length: 12 }, (_, i) => shown.from + i);
      pop.replaceChildren(
        head(`${years[0]}–${years.at(-1)}`, "years", 12, null),
        h("div", { class: "month-grid" }, years.map((year) => h("button", {
          type: "button", class: "month-cell year-cell", "data-year": year,
          "aria-pressed": String(selected !== null && yearOf(selected) === year), "aria-current": yearOf(today) === year ? "date" : null,
          onclick: () => { shown = { year }; draw(selected && yearOf(selected) === year ? selected : monthOf(year, 0)); },
        }, h("span", { class: "month-num" }, String(year))))));
    } else {
      pop.replaceChildren(
        head(String(shown.year), "year", 12, () => { shown = { years: true, from: shown.year - 5, year: shown.year }; draw(shown.year); }),
        h("div", { class: "month-grid" }, Array.from({ length: 12 }, (_, i) => {
          const month = monthOf(shown.year, i);
          return h("button", {
            type: "button", class: "month-cell", "data-month": month, "aria-label": monthLong(month),
            "aria-pressed": String(month === selected), "aria-current": month === today ? "date" : null, onclick: () => choose(month),
          }, h("span", { class: "month-num" }, String(i + 1)), h("span", { class: "month-name" }, monthName(i)));
        })),
        h("div", { class: "month-foot" }, h("button", { type: "button", class: "link", onclick: () => choose(today) }, "This month")));
    }
    if (focus !== null) pop.querySelector(shown.years ? `[data-year="${focus}"]` : `[data-month="${focus}"]`)?.focus();
  }
  // ‹ and ›: a year back or on, or twelve years in the choice of years.
  // The button pressed keeps the focus.
  function move(n) {
    if (shown.years) shown.from += n;
    else shown.year += n / 12;
    const again = pop.contains(document.activeElement) ? document.activeElement.dataset.step : undefined;
    draw();
    if (again) pop.querySelector(`[data-step="${again}"]`)?.focus();
  }
  pop.addEventListener("beforetoggle", (event) => {
    if (event.newState !== "open") return;
    shown = { year: yearOf(typed() ?? today) };
    draw();
  });
  pop.addEventListener("toggle", (event) => {
    // Closed, it holds no buttons.
    if (event.newState !== "open") return pop.replaceChildren();
    const selected = typed();
    pop.querySelector(`[data-month="${selected ?? today}"]`)?.focus();
  });
  // Arrow keys move a month (a year in the choice of years), ↑ and ↓ a
  // row; past the first or last, on into the year or years before or after.
  // Page Up and Page Down go a year (twelve years) back or on.
  pop.addEventListener("keydown", (event) => {
    const cell = event.target.closest?.(".month-cell");
    const moves = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -4, ArrowDown: 4, PageUp: -12, PageDown: 12 };
    if (!cell || !(event.key in moves)) return;
    event.preventDefault();
    const n = moves[event.key];
    if (shown.years) {
      const year = Number(cell.dataset.year) + n;
      if (year < shown.from || year >= shown.from + 12) shown.from += Math.sign(n) * 12;
      draw(year);
    } else {
      const month = F.addMonths(cell.dataset.month, n);
      shown.year = yearOf(month);
      draw(month);
    }
  });
  return wrap;
}

// ---------------------------------------------------------------- state

// Whether projections show the money of each year or today's money:
// remembered in this browser only; it is not data.
const MONEY_KEY = "finance.money";
function savedMoney() {
  try {
    return localStorage.getItem(MONEY_KEY) === "nominal" ? "nominal" : "today";
  } catch {
    return "today";
  }
}
function setMoney(money) {
  state.money = money;
  try {
    localStorage.setItem(MONEY_KEY, money);
  } catch {
    // remembered until the window closes
  }
}
const inTodaysMoney = () => state.money === "today";

// The plan picked on the forecast page, remembered in this browser.
const PLAN_KEY = "finance.forecastPlan";
function savedPlan() {
  try {
    return localStorage.getItem(PLAN_KEY) ?? "fi";
  } catch {
    return "fi";
  }
}
function setPlan(plan) {
  state.forecast.plan = plan;
  try {
    localStorage.setItem(PLAN_KEY, plan);
  } catch {
    // remembered until the window closes
  }
}

const HIDE_KEY = "finance.hideAmounts";
function savedHidden() {
  try {
    return localStorage.getItem(HIDE_KEY) === "1";
  } catch {
    return false;
  }
}
function toggleHidden() {
  state.hideAmounts = !state.hideAmounts;
  try {
    localStorage.setItem(HIDE_KEY, state.hideAmounts ? "1" : "0");
  } catch {
    // remembered until the window closes
  }
  // A notice may name an amount: it goes.
  state.notice = null;
  // The page is drawn again with every amount.
  keepingDrafts();
}

// Draws the page again with `draw` (render, or a commit that renders):
// what is typed into its forms and not saved yet stays, and so does the
// focus.
function keepingDrafts(draw = render) {
  const forms = () => [...document.querySelectorAll("#main form")];
  const drafts = forms().map((form) => [...form.elements].filter((el) => el.name).map((el) => [el.name, el.type === "checkbox" ? el.checked : el.value]));
  const active = document.activeElement;
  const focused = active?.form ? [forms().indexOf(active.form), active.name] : null;
  draw();
  forms().forEach((form, i) => {
    for (const [name, value] of drafts[i] ?? []) {
      const el = form.elements.namedItem(name);
      if (!el || el instanceof RadioNodeList) continue;
      if (el.type === "checkbox") el.checked = value;
      else el.value = value;
      // A choice shows its field: a start or end, the future pay-in.
      if (el.tagName === "SELECT" && el.closest(".bound")) el.dispatchEvent(new Event("change"));
    }
  });
  if (focused && focused[0] >= 0) forms()[focused[0]]?.elements.namedItem(focused[1])?.focus?.();
}

// Buttons to switch between the money of each year and today's money;
// onswitch redraws what shows amounts.
function moneySwitch(onswitch) {
  const button = (money, label) => h("button", { type: "button", class: state.money === money ? "seg active" : "seg", "aria-pressed": String(state.money === money), "data-money": money,
    title: money === "today" ? "What the amounts would buy today, with the inflation taken out" : "Amounts as they will be then, with the inflation",
    onclick: () => { setMoney(money); onswitch(); } }, label);
  return h("div", { class: "segmented", role: "group", "aria-label": "Amounts" }, button("nominal", "Money of each year"), button("today", "Today's money"));
}

const state = {
  store: null,
  revision: null,
  file: "",
  backups: "", // the directory with the daily copies of the file
  setup: "", // the setup script, which installs what the lock needs
  blocked: null, // why nothing can be saved, e.g. an unreadable data file
  notice: null, // { kind: "error" | "info", text, retry }; retry: goes once the server answers
  view: "dashboard",
  editing: { expenses: null, income: null }, // item id being edited
  editingEvent: null, // planned one-off being edited
  editingPayIn: null, // "now" or the id of a planned pay-in change being edited
  flatOpen: false, // whether the Buying a flat card on Expenses is open
  renaming: null, // { list: "accounts" | "expenses" | "income", key: account id or category name }
  month: null,
  importText: "",
  importPlan: null,
  money: savedMoney(), // "nominal" (the money of each year) | "today"
  hideAmounts: savedHidden(), // amounts as dots, for sharing the screen
  settingsTab: "data", // the tab of Settings on show: a key of SETTINGS_TABS
  // On the forecast page: the plan picked, "fi", "coast" or "keep".
  forecast: { plan: savedPlan() },
  focus: null, // selector to focus after the next render
  // The lock (server.py, Lock). asking: what waits for the server, "unlock",
  // "on" or "off". lost: a change was refused because Finance had locked.
  lock: { available: false, enabled: false, locked: false, idleMinutes: 20, asking: false, error: "", lost: false },
};

let pending = null; // newest store waiting to be saved, also after a save failed
let inFlight = false;
let saves = 0; // successful saves, so a slower reload cannot undo one
let locks = 0; // times Finance locked: a save sent before a lock is forgotten

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
  if (state.notice?.retry) state.notice = null;
  state.revision = json.revision;
  if (json.file) state.file = json.file;
  if (json.backups) state.backups = json.backups;
  if (json.setup) state.setup = json.setup;
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
    if (status === 401 && json?.locked) return showLocked();
    if (status !== 200 || !json) throw new Error(json?.error ?? `HTTP ${status}`);
    adopt(json);
  } catch (error) {
    state.notice = { kind: "error", text: `Can't reach the Finance server (${error.message}). Is the omarchy-finance service running?`, retry: true };
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
  const locksBefore = locks;
  pending = null;
  let retry = true; // no answer: the server is down or restarting
  try {
    const { status, json } = await request("PUT", { revision: state.revision, data: store });
    retry = status >= 500;
    if (locks !== locksBefore) {
      // Finance locked while this was on its way: the page forgot the data,
      // so it never tries this again, and unlocking says it was not saved.
      if (status !== 200) changeLost();
    } else if (status === 200) {
      state.revision = json.revision;
      saves++;
      if (state.notice?.retry) {
        // Only the notice goes: a render would rebuild the forms and lose
        // what is being typed.
        state.notice = null;
        document.querySelector("#main > .notice")?.remove();
      }
    } else if (status === 401 && json?.locked) {
      state.lock.lost = true;
      showLocked();
    } else if (status === 409) {
      pending = null;
      adopt(json);
      state.notice = { kind: "error", text: "Another window saved first. This shows the latest data now; please redo your last change." };
      render();
    } else {
      throw new Error(json?.error ?? `HTTP ${status}`);
    }
  } catch (error) {
    if (locks !== locksBefore) changeLost();
    else if (retry) {
      // Keep it unsaved, unless a newer change came meanwhile: it goes on
      // focus, with the next change, or before an update restart.
      pending ??= store;
      const text = `Not saved yet (${error.message}). Finance tries again.`;
      if (state.notice?.text !== text) {
        state.notice = { kind: "error", text, retry: true };
        render();
      }
    } else {
      pending = null;
      state.notice = { kind: "error", text: `Not saved: ${error.message}. Reload to see what is stored.` };
      render();
    }
  } finally {
    inFlight = false;
    if (pending && !retry) pump(); // no loop on a server that is down
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

  if (state.lock.locked) return;
  if (pending) pump(); // a save that failed: try again
  if (inFlight || pending) return;
  const savesBefore = saves;
  try {
    const { status, json } = await request("GET");
    if (inFlight || pending || saves !== savesBefore) return;
    if (status === 401 && json?.locked) showLocked();
    else if (status === 200 && json && json.revision !== state.revision) {
      adopt(json);
      render();
    }
  } catch {
    // the next save reports it
  }
}

// ---------------------------------------------------------------- lock

// With the lock on, the server gives the data only to a window that was
// unlocked: the system confirms it's you in Omarchy's own dialog, with the
// fingerprint or the password. Finance locks again after a while without
// use, after the computer slept, and with Ctrl+L; the page then forgets the
// data until it is unlocked again.
const LOCK_POLL = 5 * 1000; // ms between asks whether it locked or unlocked
const USE_EVERY = 60 * 1000; // ms: tell the server about use at most this often

async function lockCall(body) {
  try {
    const response = await fetch("/api/lock", {
      method: body ? "POST" : "GET",
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    return { ok: response.ok, json: await response.json() };
  } catch {
    return { ok: false, json: null };
  }
}

function adoptLock(json) {
  Object.assign(state.lock, { available: Boolean(json.available), enabled: Boolean(json.enabled), idleMinutes: json.idleMinutes ?? state.lock.idleMinutes });
}

// Finance locked: forget the data, and whatever was typed from it. A change
// still waiting to be saved goes too, and unlocking says so.
function showLocked() {
  locks++;
  if (pending) state.lock.lost = true;
  Object.assign(state.lock, { locked: true, enabled: true, available: true });
  state.store = null;
  state.revision = null;
  pending = null;
  state.notice = null;
  state.importText = "";
  state.importPlan = null;
  state.editing = { expenses: null, income: null };
  state.editingEvent = null;
  state.editingPayIn = null;
  state.renaming = null;
  state.focus = "#unlock";
  render();
}

async function unlock() {
  if (state.lock.asking) return;
  Object.assign(state.lock, { asking: "unlock", error: "" });
  render();
  const { ok, json } = await lockCall({ action: "unlock" });
  state.lock.asking = false;
  if (ok && !json.locked) {
    adoptLock(json);
    return reopen();
  }
  state.lock.error = json ? (json.error ?? "") : "the Finance server does not answer";
  state.focus = "#unlock";
  render();
}

// Unlocked, here or in another window: the data again, and a word about a
// change that was not saved.
async function reopen() {
  Object.assign(state.lock, { locked: false, error: "" });
  await load();
  if (state.lock.lost) changeLost();
}

// A change the lock kept from being saved. Said once the data is back: now,
// if it is, or after the next unlock (a load that failed, or a lock
// meanwhile, keeps it until then).
function changeLost() {
  state.lock.lost = true;
  if (state.lock.locked || !state.store) return;
  state.lock.lost = false;
  state.notice = { kind: "error", text: "Finance locked before your last change was saved. Please make it again." };
  render();
}

async function lockNow() {
  await lockCall({ action: "lock" });
  showLocked();
}

// Turns the lock on or off in Settings; off needs the system's dialog too.
async function setLock(on) {
  if (state.lock.asking) return;
  Object.assign(state.lock, { asking: on ? "on" : "off", error: "" });
  renderLockChoice();
  const { ok, json } = await lockCall({ action: on ? "on" : "off" });
  state.lock.asking = false;
  if (ok) adoptLock(json);
  else if (json?.locked) return showLocked();
  else state.lock.error = json ? (json.error ?? "") : "the Finance server does not answer";
  renderLockChoice();
  renderLockButton();
}

// Picks up a lock from the idle time or sleep, an unlock in another window,
// the lock turned on or off elsewhere, and setup installing it.
async function checkLock() {
  if (state.lock.asking) return;
  const { ok, json } = await lockCall();
  if (!ok || state.lock.asking) return;
  const was = { ...state.lock };
  adoptLock(json);
  if (json.locked && !state.lock.locked) showLocked();
  else if (!json.locked && state.lock.locked) reopen();
  else if (state.lock.enabled !== was.enabled || state.lock.available !== was.available) {
    renderLockButton();
    renderLockChoice();
  }
}

// Keys, clicks and scrolling are use: the idle time starts again.
let lastUse = 0;
function used() {
  if (!state.lock.enabled || state.lock.locked || Date.now() - lastUse < USE_EVERY) return;
  lastUse = Date.now();
  lockCall({ action: "use" }).then(({ ok, json }) => {
    if (ok && json.locked && !state.lock.locked) showLocked();
  });
}
for (const type of ["keydown", "pointerdown", "wheel"]) addEventListener(type, used, { capture: true, passive: true });
addEventListener("focus", checkLock);
setInterval(() => {
  if (!document.hidden) checkLock();
}, LOCK_POLL);

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
  // Ctrl+L locks Finance, when the lock is on, and unlocks it again. A held
  // key repeats: that neither unlocks what it just locked nor locks again.
  if (event.code === "KeyL" && event.ctrlKey && !event.shiftKey && !event.altKey && !event.metaKey && state.lock.enabled) {
    event.preventDefault();
    if (event.repeat) return;
    if (state.lock.locked) unlock();
    else lockNow();
    return;
  }
  // Ctrl+Shift+H hides or shows the amounts.
  if (event.code === "KeyH" && event.ctrlKey && event.shiftKey && !event.altKey && !event.metaKey) {
    event.preventDefault();
    toggleHidden();
    return;
  }
  const digit = /^(?:Digit|Numpad)([1-9])$/.exec(event.code);
  if (!digit || !event.ctrlKey || event.altKey || event.shiftKey || event.metaKey) return;
  const view = VIEWS[Number(digit[1]) - 1];
  if (!view) return;
  event.preventDefault();
  location.hash = view[0];
});

// The view and, in Settings, the tab the address names.
function viewFromHash() {
  const [name, tab] = location.hash.slice(1).split("/");
  state.settingsTab = SETTINGS_TABS.some(([t]) => t === tab) ? tab : SETTINGS_TABS[0][0];
  return VIEWS.some(([v]) => v === name) ? name : "dashboard";
}

// ---------------------------------------------------------------- render

// A 24×24 icon from paths, drawn with the stroke of its CSS.
function icon(paths, className) {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  if (className) svg.setAttribute("class", className);
  for (const d of paths) {
    const path = document.createElementNS(ns, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}

// The button that hides or shows the amounts, in the header.
const EYE = ["M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z", "M12 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6"];
const EYE_OFF = [...EYE, "M4 4l16 16"];
function renderPrivacy() {
  const root = document.getElementById("privacy");
  if (!root) return;
  const svg = icon(state.hideAmounts ? EYE_OFF : EYE);
  const label = state.hideAmounts ? "Show amounts (Ctrl+Shift+H)" : "Hide amounts, for sharing the screen (Ctrl+Shift+H)";
  const button = h("button", { type: "button", class: "update-button", title: label, "aria-label": label, "aria-pressed": String(state.hideAmounts),
    "aria-keyshortcuts": "Control+Shift+H", onclick: toggleHidden }, svg);
  const hadFocus = root.contains(document.activeElement);
  root.replaceChildren(button);
  if (hadFocus) button.focus();
}

// The lock button, at the right end of the header when the lock is on.
const PADLOCK = ["M7 11h10a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1z", "M8 11V8a4 4 0 0 1 8 0v3"];
function renderLockButton() {
  const root = document.getElementById("lock");
  if (!root) return;
  if (!state.lock.enabled || state.lock.locked) return root.replaceChildren();
  root.replaceChildren(h("button", { type: "button", class: "update-button", title: "Lock (Ctrl+L)", "aria-label": "Lock (Ctrl+L)",
    "aria-keyshortcuts": "Control+L", onclick: lockNow }, icon(PADLOCK)));
}

const sentence = (text) => {
  const trimmed = String(text).trim().replace(/\.$/, "");
  return trimmed ? `${trimmed.charAt(0).toUpperCase()}${trimmed.slice(1)}.` : "";
};

// All the page shows while Finance is locked. Opening Finance asks straight
// away; after that, Unlock (Enter, or Ctrl+L as anywhere) asks.
function viewLocked() {
  const { asking, error } = state.lock;
  return h("div", { class: "lock-view" },
    h("section", { class: "card lock-card" },
      icon(PADLOCK, "lock-icon"),
      h("h2", null, "Finance is locked"),
      h("button", { type: "button", class: "primary", id: "unlock", disabled: Boolean(asking), title: "Unlock (Ctrl+L)", "aria-keyshortcuts": "Control+L", onclick: unlock },
        asking ? "Unlocking…" : "Unlock"),
      h("p", { class: error ? "lock-error" : "muted", role: "status" }, error ? sentence(error) : asking ? "Confirm in the dialog." : "")));
}

function render() {
  resizeObserver?.disconnect();
  if (state.store) useFormats(state.store.settings);
  document.body.classList.toggle("hide-amounts", state.hideAmounts);
  document.body.classList.toggle("locked", state.lock.locked);
  renderPrivacy();
  renderLockButton();
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
  if (state.lock.locked) {
    content.push(viewLocked());
  } else if (state.blocked) {
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

  if (state.view === "dashboard" && state.store) drawCharts();
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
  const { bufferPercent } = store.settings;
  const empty = store.income.length === 0 && store.expenses.length === 0 && store.records.length === 0;
  const expenses = F.counted(store.expenses);

  // Opens the portfolio on the first month without values.
  const missing = F.missingMonths(m.latestMonth);
  const nudge = missing && h("a", { class: "tile-nudge", href: "#portfolio", onclick: () => { state.month = missing.from; } },
    missing.count === 1 ? `${monthLabel(missing.from)} not entered yet` : `${missing.count} months not entered yet`);

  const gainsMonths = m.gains === null || m.gains.months === 12 ? "12 months" : m.gains.months === 1 ? "month" : `${m.gains.months} months`;
  const tiles = h("div", { class: "tiles" },
    tile("Monthly income", store.income.length ? money(m.income) : "–",
      store.income.length ? `net, ${money(m.income * 12)} a year` : h("a", { href: "#income" }, "Add income")),
    tile("Monthly expenses", expenses.length ? money(m.expenses) : "–",
      expenses.length
        ? `incl. ${percentUnit.format(bufferPercent)} buffer (${money(m.buffer)})`
        : h("a", { href: "#expenses" }, store.expenses.length ? "All expenses are inactive" : "Add expenses")),
    tile(["Investment rate", m.investmentRate === null ? null
      : info("the investment rate", `The share of your net income you invest: ${payInSource(m.payIn)}, ${money(m.payIn.amount)} a month, of ${money(m.income)}. One-offs do not count.`)],
      m.investmentRate === null ? "–" : percent.format(m.investmentRate),
      m.payIn === null ? h("a", { href: "#portfolio" }, "Add pay-ins") : `${money(m.payIn.amount)} a month ${m.payIn.months === null ? "planned" : "paid in"}`),
    tile("Portfolio", m.portfolio === null ? "–" : money(m.portfolio),
      m.series.length >= 2
        ? `${signedMoney(m.portfolio - m.series.at(-2).value)} in ${monthLabel(m.latestMonth)} (${money(m.series.at(-1).payIn)} paid in${m.series.at(-1).oneOff ? `, ${signedMoney(m.series.at(-1).oneOff)} one-off` : ""})`
        : m.latestMonth ? `as of ${monthLabel(m.latestMonth)}` : h("a", { href: "#portfolio" }, "Add broker values"),
      nudge),
    tile([`Gains, last ${gainsMonths}`, m.gains === null ? null
      : info("the gains", `How much the portfolio grew in the last ${gainsMonths} besides what was paid in: the change in value minus the pay-ins and one-offs.`)],
      m.gains === null ? "–" : signedMoney(m.gains.gain),
      m.gains === null ? "needs values for two months"
        : m.gains.paid > 0 ? `besides ${money(m.gains.paid)} paid in`
          : m.gains.paid < 0 ? `besides ${money(-m.gains.paid)} taken out` : "with nothing paid in"),
    tile(["Expenses covered", m.coveredMonths === null ? null
      : info("expenses covered", `How long the portfolio alone would pay your expenses, ${money(m.expenses)} a month with buffer.`)],
      m.coveredMonths === null ? "–" : duration(m.coveredMonths),
      m.coveredMonths === null ? "needs expenses and a portfolio value" : "by the portfolio"),
  );

  const parts = [tiles];
  if (empty) {
    parts.push(card("Get started",
      h("p", null, "Add your regular ", h("a", { href: "#income" }, "income"), " and ", h("a", { href: "#expenses" }, "expenses"),
        ", then your ", h("a", { href: "#settings" }, "broker accounts"), " and their ", h("a", { href: "#portfolio" }, "monthly values and pay-ins"), "."),
      h("p", { class: "muted" }, "The ", settingsLink("general", "currency"), " and the ", settingsLink("data", "categories"), " are in Settings.")));
  } else {
    parts.push(milestonesCard(m));
  }

  if (m.series.length > 0) {
    if (hasPath(m)) parts.push(pathCard());
    parts.push(historyCard(m));
  }
  const returns = returnsCard(store);
  if (returns) parts.push(returns);

  const breakdown = (kind, total) => {
    const groups = F.byCategory(m.budget[kind].now);
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

// The milestones on the way to FI, a row each, in the order the portfolio
// reaches them: Coast FI (with a year of birth, before retirement), Lean FI
// (with essential expenses) and FI. Each says what the portfolio needs, how
// much of it it has, and when it gets there, as the Forecast counts.
function milestonesCard(m) {
  const store = state.store;
  const { withdrawalRate, expectedReturn, birthYear, retirementAge } = store.settings;
  const expenses = F.counted(store.expenses);
  const o = outlook(store);
  const known = o.known;
  const head = h("div", { class: "card-head" }, h("h2", null, "Milestones"),
    expenses.length && known ? h("span", { class: "muted" }, `at ${percentUnit.format(expectedReturn)} return and ${money(o.payIn.invested)} a month${o.payIn.changes.length ? " for now" : ""}`) : null);
  if (expenses.length === 0) {
    return h("section", { class: "card milestones" }, head,
      h("p", { class: "muted" }, h("a", { href: "#expenses" }, store.expenses.length ? "All expenses are inactive" : "Add expenses"), ", for the FI number."));
  }

  const { coast, lean, fi } = o.milestones();
  // Not reached before retirement, or within 100 years without one.
  const never = o.retirement ? `Not before ${retirementAge}` : "Over 100 years";
  const multiple = plain.format(m.multiple);
  const rate = percentUnit.format(withdrawalRate);
  const rateIn = ["The withdrawal rate is set in ", h("a", { href: "#settings" }, "Settings"), "."];
  const rows = [
    coast && { name: "Coast FI", what: `stop investing, FI at ${retirementAge}`, number: coast.fiNumber, progress: coast.progress, months: coast.months, never,
      about: [`Once the portfolio has this much, you can stop investing: it still grows to the FI number by ${retirementAge}, ${money(coast.fiAtRetirement)} by then.`,
        store.settings.coastPayIn > 0
          ? ["The ", h("a", { href: "#forecast" }, "Forecast"), `'s Stop investing pays in ${money(store.settings.coastPayIn)} a month after it, as set in `, settingsLink("data"), "."]
          : ["As the ", h("a", { href: "#forecast" }, "Forecast"), "'s Stop investing counts it."]] },
    lean && { name: "Lean FI", what: "essential expenses only", number: lean.fiNumber, progress: lean.progress, months: lean.months, never,
      about: ["FI on the leanest budget: the FI number, worked out the same way, with only the expenses marked Essential.",
        ["Mark them on the ", h("a", { href: "#expenses" }, "Expenses"), " page."]] },
    { name: "FI", what: "all expenses", number: fi.fiNumber, progress: fi.progress, months: fi.months, never,
      about: [`The FI number: what the portfolio needs to pay your expenses for good, ${multiple} × yearly expenses at a ${rate} withdrawal rate.`,
        m.fiParts.extra >= 100
          ? `Retiring now: ${multiple} × ${money(m.fiParts.long * 12)} a year from ${monthLabel(F.monthFromIndex(m.fiParts.from), true)} on, plus ${money(m.fiParts.extra)} to bridge the years until then.`
          : Math.abs(m.retiredNeed - m.expenses) >= 100
            ? `Retiring now, the portfolio would pay ${money(m.retiredNeed)} a month: the expenses and income that count after retirement.`
            : null,
        rateIn].filter(Boolean) },
  ].filter(Boolean);
  // Sorted by when, those that never come last; stable, so without a
  // portfolio in the order above.
  rows.sort((a, b) => (a.months ?? Infinity) - (b.months ?? Infinity));

  const row = (r) => {
    const reached = r.progress !== null && r.progress >= 1;
    const meter = h("div", { class: "meter", role: "presentation" }, h("div", { class: "meter-fill" }));
    meter.firstChild.style.width = `${Math.min(100, (r.progress ?? 0) * 100)}%`;
    const month = r.months > 0 ? F.addMonths(o.start, r.months) : null;
    // How long from this month, which can be after the latest recorded one.
    const ahead = month ? F.monthIndex(month) - thisMonth() : 0;
    return h("tr", { class: reached ? "reached" : null },
      h("th", { scope: "row" }, r.name, info(r.name, ...r.about), h("div", { class: "sub" }, r.what)),
      h("td", { class: "num" }, money(r.number),
        r.progress === null ? null : h("div", { class: "sub" }, reached ? "reached" : `${money(r.number - m.portfolio)} to go`)),
      h("td", { class: "reach" },
        h("div", { class: "reach-row" }, meter, h("span", { class: "num" }, r.progress === null ? "–" : `${reached ? "✓ " : ""}${percent.format(r.progress)}`))),
      h("td", null,
        r.progress === null ? "–" : r.months === 0 ? "Now" : r.months === null ? r.never : ahead > 0 ? `in ${duration(ahead)}` : "About now",
        month
          ? h("div", { class: "sub" }, `around ${monthLabel(month, ahead >= 24)}${birthYear === null ? "" : `, at ${F.ageIn(month, birthYear)}`}`)
          : r.months === 0 ? h("div", { class: "sub" }, `as of ${monthLabel(o.start)}`) : null));
  };

  // Only what is missing, with where to add it.
  const notes = [
    coast === null && birthYear === null ? h("li", null, "Coast FI needs your year of birth, in ", settingsLink("general"), ".") : null,
    known ? null : h("li", null, h("a", { href: "#portfolio" }, "Add broker values"), " to see how far the portfolio is."),
    known && o.payIn.withdrawal ? h("li", null, `Your average pay-in is a withdrawal of ${money(-o.payIn.amount)} a month, so these count 0.`) : null,
  ].filter(Boolean);
  return h("section", { class: "card milestones" }, head,
    h("div", { class: "table-wrap" }, h("table", null,
      h("thead", null, h("tr", null, h("th", null, "Milestone"), h("th", { class: "num" }, "Needs"), h("th", null, "Reached"), h("th", null, "When"))),
      h("tbody", null, rows.map(row)))),
    notes.length ? h("ul", { class: "notes muted" }, notes) : null);
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
    ["invested", "Invested", m.payIn ? (months === null ? "planned" : months === 1 ? "last month's pay-in" : `${months}-month average`) : null, m.payIn ? split.invested : null],
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
    h("ul", { class: "bars" }, rows),
    emergencyFund(m));
}

// The emergency fund, at the foot of Net worth: how long the emergency-fund
// accounts' latest values pay this month's expenses, with a bar for how much
// of the months set in Settings that is. Only with an emergency-fund account
// and expenses.
function emergencyFund(m) {
  const e = m.emergency;
  if (e === null || e.months === null) return null;
  let target = null;
  if (e.target > 0) {
    const share = e.months / e.target;
    const meter = h("div", { class: "meter", role: "presentation" }, h("div", { class: "meter-fill" }));
    meter.firstChild.style.width = `${Math.min(100, share * 100)}%`;
    target = h("div", { class: "reach-row" }, meter,
      h("span", { class: "num" }, e.short === 0 ? `✓ ${e.target} months` : `${percent.format(share)} of ${e.target} months`));
  }
  return h("div", { class: e.target > 0 && e.short === 0 ? "emergency reached" : "emergency" },
    h("div", { class: "bar-text" },
      h("span", null, "Emergency fund", info("the emergency fund",
        `How long your emergency-fund accounts alone would pay your expenses, ${money(m.expenses)} a month with buffer. Cash accounts don't count.`,
        ["The months you aim for are set in ", settingsLink("data"), "; 0 sets none."])),
      h("span", { class: "num" }, e.months >= 1 ? duration(Math.floor(e.months)) : "Less than a month")),
    target,
    e.short > 0 ? h("p", { class: "short" }, `${money(e.short)} short`) : null);
}

// No active expenses, no FI number: the history then has no goal line, and
// there is no path to FI.
const chartGoal = (m) => (F.counted(state.store.expenses).length ? m.fiNumber : 0);
const hasPath = (m) => chartGoal(m) > 0 && outlook(state.store).fiNumber > 0;

// The Path to FI chart's projection, in the money the switch says.
const projection = () => outlook(state.store).path(inTodaysMoney() ? "today" : "nominal");

const chartKey = (kind, label) => h("span", null, h("span", { class: `key ${kind}` }), label);

// The portfolio's value, then its projection up to the FI number.
function pathCard() {
  const p = projection();
  const { note, about } = pathSummary(p);
  return h("section", { class: "card" },
    h("div", { class: "card-head" },
      h("h2", null, "Path to FI", info("the path to FI", ...about)),
      h("div", { class: "legend" },
        chartKey("value", "Portfolio value"),
        p.points.length ? chartKey("projection", `At ${percentUnit.format(p.rates.mid)} a year (${percentUnit.format(p.rates.low)} to ${percentUnit.format(p.rates.high)})`) : null,
        chartKey("goal", "FI number")),
      moneySwitch(render)),
    h("div", { id: "chart-path", class: "chart-box" }),
    note ? h("p", { class: "chart-note muted" }, note) : null);
}

// The portfolio's value and what was paid in, month by month.
function historyCard(m) {
  return h("section", { class: "card" },
    h("div", { class: "card-head" },
      h("h2", null, "Portfolio history", info("the portfolio history",
        "Paid in starts with what each account held in its first month, so the shading is the gain or loss since then.")),
      h("div", { class: "legend" },
        chartKey("value", "Portfolio value"), chartKey("paid", "Paid in"), chartKey("gain", "Gain"),
        m.series.some((s) => s.value < s.invested) ? chartKey("loss", "Loss") : null,
        goalVisible(m.series, chartGoal(m)) ? chartKey("goal", "FI number") : null)),
    h("div", { id: "chart-history", class: "chart-box" }));
}

// When the projection reaches the FI number: a short line under the chart,
// and what it assumes for the ⓘ.
function pathSummary(p) {
  const { inflation, retirementAge } = state.store.settings;
  const o = outlook(state.store);
  const rate = (k) => percentUnit.format(p.rates[k]);
  const year = (k) => monthLabel(p.reach[k], true);
  const limit = o.retirement ? `before ${retirementAge}` : `within ${F.MAX_PROJECTION_MONTHS / 12} years`;
  const settings = ["The expected return and inflation are set in ", h("a", { href: "#settings" }, "Settings"), "."];
  if (p.reach.mid === o.start) return { note: "The portfolio has reached the FI number.", about: [settings] };
  const about = [`At ${rate("mid")} growth a year and ${money(o.payIn.invested)} paid in a month${o.retirement ? `, until ${retirementAge}` : ""}: ${o.payIn.withdrawal
    ? `your average of ${payInMonths(o.payIn.months)} is a withdrawal of ${money(-o.payIn.amount)} a month, which counts as 0`
    : payInSource(o.payIn)}.${payInPlanText(o.payIn) ? ` ${payInPlanText(o.payIn)}` : ""}`];
  let note;
  if (p.reach.mid) {
    const months = F.monthIndex(p.reach.mid) - F.monthIndex(o.start);
    // How long from this month, which can be after the latest recorded one.
    const ahead = F.monthIndex(p.reach.mid) - thisMonth();
    const low = p.reach.low ? `${year("low")} at ${rate("low")}` : `not ${limit} at ${rate("low")}`;
    note = `FI around ${year("mid")}${ahead > 0 ? `, in ${duration(ahead)}` : ""}: ${year("high")} at ${rate("high")}, ${low}.`;
    about.push(inTodaysMoney()
      ? `In today's money, with ${percentUnit.format(inflation)} inflation a year taken out: by then the FI number is ${money(p.points[months - 1].goal)}.`
      : `By then the FI number is ${money(p.points[months - 1].goal)}, as it rises with ${percentUnit.format(inflation)} inflation a year.`);
  } else if (p.reach.high) {
    note = `Not FI ${limit} at ${rate("mid")}; at ${rate("high")} around ${year("high")}.`;
  } else {
    note = `Not FI ${limit}, not even at ${rate("high")}.`;
  }
  return { note, about: [...about, settings] };
}

// The dashboard's charts: the path to FI, when there is one, and the
// history.
function drawCharts() {
  const m = F.metrics(state.store);
  const options = {
    series: m.series,
    format: money,
    formatSigned: signedMoney,
    formatPercent: (fraction) => percent.format(fraction),
    formatSignedPercent: signedPercent,
    formatRate: (rate) => percentUnit.format(rate),
    formatAxis: axisMoney,
    formatMonth: monthLabel,
    monthNumber: F.monthIndex,
  };
  const charts = [];
  const path = document.getElementById("chart-path");
  if (path) {
    // What FI needs at the latest month's end, as the projection's goals.
    const pathOptions = { ...options, view: "path", fiNumber: outlook(state.store).fiNumber, projection: projection() };
    charts.push([path, () => renderChart(path, pathOptions)]);
  }
  const history = document.getElementById("chart-history");
  if (history) {
    const historyOptions = { ...options, view: "history", fiNumber: chartGoal(m), projection: null };
    charts.push([history, () => renderChart(history, historyOptions)]);
  }
  if (charts.length) drawResizing(...charts);
}

// Draws charts, given as [box, draw], and each again whenever its box
// changes width. Replaces the charts drawn before.
let resizeObserver = null;
function drawResizing(...charts) {
  resizeObserver?.disconnect();
  const drawn = new Map();
  for (const [box, draw] of charts) {
    draw();
    drawn.set(box, { width: box.clientWidth, draw });
  }
  resizeObserver = new ResizeObserver((entries) => {
    for (const { target } of entries) {
      const chart = drawn.get(target);
      if (Math.abs(target.clientWidth - chart.width) < 2) continue;
      chart.width = target.clientWidth;
      chart.draw();
    }
  });
  for (const box of drawn.keys()) resizeObserver.observe(box);
}

// ---------------------------------------------------------------- expenses and income

// When an expense or income starts or ends: a choice, and a field for the
// age or month when that is chosen. choices: [[value, label]], with "none"
// (always), "retirement", "age" and "month". A field not chosen is also
// disabled, so a value left in it cannot stop the form.
function boundField(name, label, bound, choices, help = null) {
  const kind = bound === null ? "none" : bound.at === "retirement" ? "retirement" : "age" in bound ? "age" : "month";
  const age = h("input", { name: `${name}-age`, type: "number", min: F.AGES.min, max: F.AGES.max, step: 1, inputmode: "numeric", placeholder: "67",
    "aria-label": `${label}: age`, value: kind === "age" ? String(bound.age) : "", hidden: kind !== "age", disabled: kind !== "age" });
  const month = monthField({ name: `${name}-month`, label: `${label}: month`, value: kind === "month" ? bound.month : "" });
  month.hidden = month.disabled = kind !== "month";
  const select = h("select", { name, value: kind, "aria-label": label, onchange: (event) => {
    age.hidden = age.disabled = event.target.value !== "age";
    month.hidden = month.disabled = event.target.value !== "month";
  } }, choices.map(([value, text]) => h("option", { value }, text)));
  return h("div", { class: `field bound ${name}` },
    h("span", { class: "field-label" }, h("span", null, label), help ? info(label, ...help) : null),
    h("div", { class: "bound-row" }, select, age, month));
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
    const month = F.parseMonth(data.get(`${name}-month`));
    return month ? { bound: { month } } : { error: `${label}: enter ${MONTH_HINT}.` };
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
  const existing = store.income.find((item) => item.name === PENSION_NAME) ?? null;
  const result = h("p", { class: "helper-result", "aria-live": "polite" });
  const read = (form) => {
    const data = new FormData(form);
    const points = readNumber(data.get("points"));
    const more = readNumber(data.get("more"));
    const pointValue = F.parseMoney(data.get("pointValue"));
    const ageText = String(data.get("startAge")).trim();
    const startAge = Number(ageText);
    const regularText = String(data.get("regularAge")).trim();
    const regularAge = Number(regularText);
    const deductions = readNumber(data.get("deductions"), 2);
    if (points === null) return { error: "Rentenpunkte so far: enter a number, such as 25,5." };
    if (more === null) return { error: "More points: enter a number, or 0." };
    if (!pointValue.ok || pointValue.cents <= 0) return { error: "Value of a point: enter an amount." };
    if (!/^[0-9]+$/.test(regularText) || regularAge < F.RETIREMENT_AGES.min || regularAge > F.RETIREMENT_AGES.max) return { error: `Regular age: enter whole years from ${F.RETIREMENT_AGES.min} to ${F.RETIREMENT_AGES.max}.` };
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
      const saved = F.saveItem(store, "income", item);
      if (!saved.ok) return showError(event.currentTarget, `Can't add ${money(item.amount)} a month. ${saved.error}.`);
      commit(saved.store, `${existing ? "Updated" : "Added"} ${PENSION_NAME}: ${money(item.amount)} a month from age ${r.startAge}.`);
    },
  },
    field("Rentenpunkte so far", h("input", { name: "points", inputmode: "decimal", autocomplete: "off", placeholder: "25,5", required: true })),
    field("More points until you stop working", h("input", { name: "more", inputmode: "decimal", autocomplete: "off", value: "0" }),
      "About 1 a year at the average wage, 51.944 € in 2026."),
    field("Value of a point", h("input", { name: "pointValue", class: "amount", inputmode: "decimal", autocomplete: "off", value: inputMoney(g.pointValue) }),
      "42,52 € from July 2026. In the forecast, the pension rises with inflation, as pensions about do."),
    field("Regular age", h("input", { name: "regularAge", inputmode: "numeric", autocomplete: "off", value: String(g.regularAge) }),
      `When the pension starts without deductions: ${g.regularAge} for everyone born in 1964 or later.`),
    field("Starts at age", h("input", { name: "startAge", inputmode: "numeric", autocomplete: "off", value: String(existing?.from?.age ?? g.regularAge) }),
      "Each month before the regular age costs 0,3 %, at most 4 years early (63 with 35 years of contributions); each month after it adds 0,5 %."),
    field("Health and care insurance (%)",
      h("input", { name: "deductions", inputmode: "decimal", autocomplete: "off", value: plain.format(g.pensionerRate + g.extraRate / 2 + g.careRateChildless) }),
      "Pensioners pay half the general and the extra health rate (7,3 % + about 1,45 %) and the whole care rate (3,6 %, 4,2 % without children).",
      "Income tax is left out."),
    h("div", { class: "form-actions" }, h("button", { type: "submit", class: "primary" }, existing ? `Update ${PENSION_NAME}` : "Add as income")));
  queueMicrotask(() => show(form));
  return h("section", { class: "card" },
    h("details", null,
      h("summary", null, h("h2", null, "State pension (Germany)")),
      h("p", null, "From your Renteninformation, enter the Rentenpunkte (Entgeltpunkte) you have so far, not its pension at the regular age: that assumes you pay in until then."),
      form, result));
}

// When the state pension starts: as entered with the pension helper, or the
// regular age.
const pensionAge = (store) => store.income.find((item) => item.name === PENSION_NAME)?.from?.age ?? F.GERMANY_2026.regularAge;

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
      const saved = F.saveItem(store, "expenses", item);
      if (!saved.ok) return showError(event.currentTarget, `Can't add ${money(item.amount)} a month. ${saved.error}.`);
      commit(saved.store, `${existing ? "Updated" : "Added"} ${HEALTH_NAME}: ${money(item.amount)} a month from retirement until age ${r.untilAge}.`);
    },
  },
    field("Minimum base a month", h("input", { name: "base", class: "amount", inputmode: "decimal", autocomplete: "off", value: inputMoney(g.minimumBase) }),
      "Gains and dividends count as income too: above the minimum base, you pay on them."),
    field("Zusatzbeitrag (%)", h("input", { name: "extra", inputmode: "decimal", autocomplete: "off", value: plain.format(g.extraRate) }),
      "Your insurer's extra rate, 2,9 % on average in 2026, on top of the general rate of 14 % (without sick pay) and care insurance."),
    field("Until age (the pension starts)",
      h("input", { name: "untilAge", inputmode: "numeric", autocomplete: "off", value: String(existing?.until?.age ?? pensionAge(store)) }),
      "From the pension on, insured as a pensioner (KVdR, after 9/10 of the second half of your working life insured), only the pension counts; that is in the pension helper under Income."),
    h("label", { class: "check" }, h("input", { type: "checkbox", name: "childless", checked: true }), "No children (care insurance 4,2 % instead of 3,6 %)"),
    h("div", { class: "form-actions" }, h("button", { type: "submit", class: "primary" }, existing ? `Update ${HEALTH_NAME}` : "Add as expense")));
  queueMicrotask(() => show(form));
  return h("section", { class: "card" },
    h("details", null,
      h("summary", null, h("h2", null, "Health and care insurance after you stop working (Germany)")),
      h("p", null, "While you work, health and care insurance come out of your pay. Living off the portfolio before the pension, you insure yourself as a voluntary member of a statutory insurer, ",
        "and pay at least on the minimum base: about 280 € a month in 2026. Added as an essential expense."),
      form, result));
}

// ---- Buying a flat: a what-if. It compares the plan as it is (renting)
// with the plan and the flat, as F.flatWhatIf counts it, and never changes
// the plan: Save keeps the fields in the data file (store.flat), for next
// time.
function flatCard() {
  const store = state.store;
  const saved = store.flat;
  const { birthYear, retirementAge, expectedReturn } = store.settings;
  // The expenses the flat can end: those that count now or later (but not
  // from retirement, which each plan reaches at its own time), the largest
  // first, and any ended already that it ends.
  const lists = F.budget(store, thisMonth()).expenses;
  const open = [...lists.now, ...lists.later];
  const endable = [...open, ...store.expenses.filter((item) => saved?.stops.includes(item.id) && !open.includes(item))]
    .filter((item) => !(item.from && "at" in item.from))
    .sort((a, b) => F.monthlyAmount(b) - F.monthlyAmount(a) || a.name.localeCompare(b.name));
  const result = h("div", { class: "helper-result flat-result", "aria-live": "polite" });

  const percentText = (value) => (value == null ? "" : plain.format(value));
  const read = (form) => {
    const data = new FormData(form);
    const text = (name) => String(data.get(name) ?? "").trim();
    const month = F.parseMonth(text("month"));
    const price = F.parseMoney(text("price"));
    const costs = F.parsePercent(text("costsPercent"));
    const own = F.parseMoney(text("ownMoney"));
    const interest = F.parsePercent(text("interest"));
    const years = Number(text("fixedYears"));
    const after = text("interestAfter") === "" ? { ok: true, value: null } : F.parsePercent(text("interestAfter"));
    const byAmount = data.get("repaymentKind") === "amount";
    const repayment = byAmount ? F.parseMoney(text("repayment")) : F.parsePercent(text("repayment"));
    const optional = (name) => (text(name) === "" ? { ok: true, cents: 0 } : F.parseMoney(text(name)));
    const running = optional("running");
    const subletting = optional("subletting");
    const L = F.FLAT_LIMITS;
    if (!month) return { error: `Buy in: enter ${MONTH_HINT}.` };
    if (month <= F.currentMonth()) return { error: "Buy in: a month to come." };
    if (!price.ok || price.cents <= 0) return { error: "Price: enter an amount." };
    if (!costs.ok || costs.value > L.costsPercent) return { error: `Purchase costs: enter a percentage up to ${L.costsPercent}.` };
    if (!own.ok || own.cents < 0) return { error: "Own money: enter an amount, or 0." };
    const total = price.cents + F.flatCosts({ price: price.cents, costsPercent: costs.value });
    if (own.cents > total) return { error: `Own money: at most the price and the costs, ${moneyExact(total)}.` };
    if (!interest.ok || interest.value > L.interest) return { error: `Interest: enter a percentage up to ${L.interest}.` };
    if (!/^[0-9]+$/.test(text("fixedYears")) || years < L.fixedYears.min || years > L.fixedYears.max) return { error: `Fixed for: whole years from ${L.fixedYears.min} to ${L.fixedYears.max}.` };
    if (!after.ok || after.value > L.interest) return { error: `Then: enter a percentage up to ${L.interest}, or leave it empty for the same.` };
    if (byAmount ? !repayment.ok || repayment.cents <= 0 : !repayment.ok || repayment.value <= 0 || repayment.value > L.repayment) {
      return { error: byAmount ? "Repayment: enter the amount you pay a month." : `Repayment: enter a percentage above 0, up to ${L.repayment}.` };
    }
    if (!running.ok || running.cents < 0) return { error: "Hausgeld and Grundsteuer: enter an amount, or leave it empty." };
    if (!subletting.ok || subletting.cents < 0) return { error: "Subletting: enter an amount, or leave it empty." };
    return {
      flat: {
        month, price: price.cents, costsPercent: costs.value, ownMoney: own.cents,
        interest: interest.value, fixedYears: years, interestAfter: after.value,
        repayment: byAmount ? { amount: repayment.cents } : { percent: repayment.value },
        running: running.cents, subletting: subletting.cents, stops: data.getAll("stops").map(String),
      },
    };
  };

  // The age a plan stops at: "at 54", or "54" after "instead of".
  const ageAt = (month, bare = false) => (month === null ? `not before ${retirementAge}` : `${bare ? "" : "at "}${F.ageIn(month, birthYear)}`);
  // How much sooner or later `month` is than `than`, in brackets.
  const shift = (month, than) => {
    if (month === null || than === null) return "";
    const months = F.monthIndex(month) - F.monthIndex(than);
    if (months === 0) return " (the same)";
    const by = Math.abs(months) < 12 ? monthsText(Math.abs(months)) : tenthsText(yearTenths(Math.abs(months)));
    return ` (${by} ${months < 0 ? "sooner" : "later"})`;
  };
  const lines = (flat) => {
    const r = F.flatWhatIf(store, flat);
    const s = r.schedule;
    const out = [];
    if (r.loan === 0) out.push("No loan: the own money pays the price and the costs.");
    else if (s.months === null) {
      const payment = s.payments.at(-1).amount;
      const late = s.payments.length > 1 || payment > (r.loan * flat.interest) / 1200;
      out.push(`Loan ${money(r.loan)} · ${money(payment)} a month doesn't cover the interest${late ? ` of ${percentUnit.format(flat.interestAfter ?? flat.interest)} after the fixed years` : ""}: it's never paid off.`);
    } else {
      const [first, ...later] = s.payments;
      const changes = later.map((p) => `, ${money(p.amount)} from ${monthLabel(p.month)}`).join("");
      const at = birthYear === null ? "" : `, at ${F.ageIn(s.paidOff, birthYear)}`;
      out.push(`Loan ${money(r.loan)} · ${money(first.amount)} a month${changes} · paid off ${monthLabel(s.paidOff)}${at} · ${money(s.interest)} interest`);
    }
    const c = r.cash;
    const parts = [c.fromCash > 0 ? `${money(c.fromCash)} from cash` : null, c.fromPortfolio > 0 ? `${money(c.fromPortfolio)} from the portfolio` : null].filter(Boolean);
    if (parts.length) {
      const more = c.fromPortfolio > c.portfolio ? ", more than it has now" : "";
      out.push(`Own money: ${parts.join(", ")}${more}${c.accounts ? " · the emergency fund stays" : ""}`);
    }
    const sublet = flat.subletting > 0 ? ", after subletting" : "";
    out.push([`${monthLabel(flat.month)}: housing ${money(r.housing.before)} → ${money(r.housing.during)} a month${sublet} · pays in ${money(r.payIn.during)} instead of ${money(r.payIn.before)}`,
      info("the housing cost",
        `In the money of ${monthLabel(flat.month)}: the expenses that stop, Hausgeld and subletting rise with inflation until then; the loan's payment doesn't.`,
        "From then on, what you pay in changes each month by what housing costs more than the expenses that stop (or less: then you pay in more). Once the loan is paid off, only the Hausgeld, subletting and those expenses count. Never below 0.")]);
    if (r.renting && r.buying) {
      const low = F.growthRates(expectedReturn).low;
      out.push(`Stop working ${ageAt(r.buying.work)} instead of ${ageAt(r.renting.work, true)}${shift(r.buying.work, r.renting.work)} · `
        + `even at ${percentUnit.format(low)}: ${ageAt(r.buying.low)} instead of ${ageAt(r.renting.low, true)}${shift(r.buying.low, r.renting.low)}`);
    } else if (s.months !== null && birthYear === null) {
      out.push(["When you could stop working needs your year of birth, in ", settingsLink("general"), "."]);
    }
    if (r.fiNumber) out.push(`Once it's paid off, the FI number is ${money(r.fiNumber.buying)} instead of ${money(r.fiNumber.renting)}, in today's money.`);
    return out;
  };

  let timer = null;
  const show = (form) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const r = read(form);
      const started = ["month", "price"].some((name) => String(new FormData(form).get(name)).trim() !== "");
      result.replaceChildren(...(r.error ? (started ? [h("p", null, r.error)] : []) : lines(r.flat).map((line) => h("p", null, line))));
    }, 120);
  };

  const repaymentKind = h("select", { name: "repaymentKind", "aria-label": "Repayment as" },
    h("option", { value: "percent", selected: !("amount" in (saved?.repayment ?? {})) || null }, "% at first"),
    h("option", { value: "amount", selected: "amount" in (saved?.repayment ?? {}) || null }, `${whole.formatToParts(0).find((part) => part.type === "currency")?.value ?? store.settings.currency} a month`));
  const repaymentValue = saved ? ("amount" in saved.repayment ? inputMoney(saved.repayment.amount) : plain.format(saved.repayment.percent)) : "";
  const input = (name, value, props = {}) => h("input", { name, inputmode: "decimal", autocomplete: "off", value, ...props });
  const form = h("form", {
    class: "helper-form flat-form",
    oninput: (event) => {
      // An amount a month is hidden with the other amounts; a percentage isn't.
      if (event.target === repaymentKind) event.currentTarget.elements.repayment.classList.toggle("amount", repaymentKind.value === "amount");
      show(event.currentTarget);
    },
    onsubmit: (event) => {
      event.preventDefault();
      const r = read(event.currentTarget);
      if (r.error) return showError(event.currentTarget, r.error);
      const done = F.saveFlat(store, r.flat);
      if (!done.ok) return showError(event.currentTarget, `${done.error}.`);
      commit(done.store, "Saved the flat. Your plan doesn't count it: the Dashboard and the Forecast stay as they are.");
    },
  },
    h("h3", null, "The flat"),
    field("Buy in", monthField({ name: "month", required: true, value: saved?.month ?? "", onpick: () => show(form) }),
      "The month you pay for it and move in: the expenses below stop the month before."),
    field("Price", input("price", saved ? inputMoney(saved.price) : "", { class: "amount", required: true, placeholder: inputMoney(35000000) })),
    field("Purchase costs (%)", input("costsPercent", percentText(saved?.costsPercent ?? 10), { required: true }),
      "Grunderwerbsteuer 3,5 to 6,5 % by state, notary and land registry about 2 %, an agent up to 3,57 %."),
    field("Own money", input("ownMoney", saved ? inputMoney(saved.ownMoney) : "", { class: "amount", required: true, placeholder: inputMoney(10500000) }),
      "What you pay without the loan, costs included. It comes from your cash accounts first, then out of the portfolio, never from the emergency fund.",
      "The loan is the price and the costs, less the own money."),
    h("h3", null, "The loan"),
    field("Interest a year (%)", input("interest", percentText(saved?.interest), { required: true, placeholder: plain.format(3.8) })),
    field("Fixed for, years", input("fixedYears", saved ? String(saved.fixedYears) : "10", { inputmode: "numeric", required: true }),
      "The Zinsbindung: how long the interest stays the same."),
    field("Then, a year (%)", input("interestAfter", percentText(saved?.interestAfter), { placeholder: "the same" }),
      "The interest after the fixed years, to see what a higher one does. Empty: the same."),
    field("Repayment", h("div", { class: "flat-repayment" }, input("repayment", repaymentValue, { required: true, placeholder: "2", class: saved && "amount" in saved.repayment ? "amount" : null }), repaymentKind),
      "% at first: the anfängliche Tilgung, a year. The payment is the loan × (interest + repayment) ÷ 12; when the fixed years end, it's worked out again for what is left, at the new interest.",
      "An amount a month: the whole payment, interest included, the same until the loan is paid off.",
      "Either way the payment stays the same amount of money: it doesn't rise with inflation."),
    h("h3", null, "Each month"),
    field("Hausgeld and Grundsteuer", input("running", saved?.running ? inputMoney(saved.running) : "", { class: "amount", placeholder: inputMoney(45000) }),
      "What you pay as the owner, in today's money: it rises with inflation like your expenses."),
    field("Subletting, after tax", input("subletting", saved?.subletting ? inputMoney(saved.subletting) : "", { class: "amount", placeholder: inputMoney(0) }),
      "Rent you take in, such as for a room, after tax. It counts from the month you buy, for good, and rises with inflation like income."),
    endable.length ? h("fieldset", { class: "flat-stops" },
      h("legend", null, "Stops then"),
      endable.map((item) => h("label", { class: "check" },
        h("input", { type: "checkbox", name: "stops", value: item.id, checked: saved?.stops.includes(item.id) || null }),
        `${item.name} (${money(F.monthlyAmount(item))})`))) : null,
    h("div", { class: "form-actions" },
      h("button", { type: "submit", class: "primary" }, saved ? "Save" : "Save the flat"),
      saved ? h("button", { type: "button", class: "link danger", onclick: () => {
        if (!confirm("Delete the flat?")) return;
        commit(F.deleteFlat(store), "Deleted the flat.");
      } }, "Delete") : null));
  queueMicrotask(() => show(form));
  const details = h("details", { open: state.flatOpen || null, ontoggle: (event) => { state.flatOpen = event.currentTarget.open; } },
    h("summary", null, h("h2", null, "Buying a flat (Germany)")),
    h("p", null, "What if you bought a flat? This compares your plan as it is with the same plan and the flat: the loan, the rent that stops, and what you pay in. ",
      "Your plan doesn't count it: the Dashboard and the Forecast stay as they are."),
    form, result);
  return h("section", { class: "card" }, details);
}

function viewItems(kind) {
  const store = state.store;
  const names = KINDS[kind];
  const items = store[kind];
  const { birthYear } = store.settings;
  const retirement = F.retirementIndex(store.settings);
  // This month's: what counts, what starts later or has ended, and the
  // inactive expenses.
  const b = F.budget(store, thisMonth());
  const { now: active, later, ended, inactive } = b[kind];
  const editing = items.find((item) => item.id === state.editing[kind]) ?? null;

  let summary;
  if (kind === "expenses") {
    const { monthly, buffer, total, essential } = b.expenses;
    const off = inactive.reduce((t, item) => t + F.monthlyAmount(item), 0);
    summary = h("dl", { class: "summary" },
      h("div", null, h("dt", null, "Regular expenses"), h("dd", { class: "num" }, `${money(monthly)} / month`)),
      h("div", null, h("dt", null, `Buffer, ${percentUnit.format(store.settings.bufferPercent)}`), h("dd", { class: "num" }, `${money(buffer)} / month`)),
      h("div", null, h("dt", null, "Total"), h("dd", { class: "num strong" }, `${money(total)} / month · ${money(total * 12)} / year`)),
      active.some((item) => item.essential)
        ? h("div", null, h("dt", null, "Essential, for Lean FI"), h("dd", { class: "num" }, `${money(essential.monthly)} / month · ${money(essential.total)} with buffer`))
        : null,
      inactive.length
        ? h("div", null, h("dt", null, "Inactive, not counted"), h("dd", { class: "num muted" }, `${money(off)} / month`))
        : null);
  } else {
    const { monthly } = b.income;
    summary = h("dl", { class: "summary" },
      h("div", null, h("dt", null, "Net income"), h("dd", { class: "num strong" }, `${money(monthly)} / month · ${money(monthly * 12)} / year`)));
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
        // Retirement moves (Retire at FI starts it at FI), so only fixed
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
      const saved = F.saveItem(store, kind, item);
      if (!saved.ok) return showError(event.currentTarget, `${saved.error}.`);
      state.editing[kind] = null;
      state.focus = "#item-name";
      commit(saved.store, editing ? `Saved ${name}.` : `Added ${name}.`);
    },
  },
    h("label", null, "Name", h("input", { id: "item-name", name: "name", required: true, autocomplete: "off", value: editing?.name ?? "", placeholder: kind === "expenses" ? "Rent" : "Salary" })),
    h("div", { class: "field" },
      h("span", { class: "field-label" }, h("label", { for: "item-category" }, "Category"),
        h("a", { class: "label-link", href: "#settings" }, categories.length ? "Edit" : "Add categories")),
      h("select", { id: "item-category", name: "category", value: editing?.category ?? "" },
        h("option", { value: "" }, "No category"),
        categories.map((c) => h("option", { value: c }, c)))),
    h("label", null, kind === "income" ? "Amount (net)" : "Amount", h("input", { name: "amount", class: "amount", inputmode: "decimal", autocomplete: "off", required: true, value: editing ? inputMoney(editing.amount) : "", placeholder: zero })),
    h("label", null, "Paid every … months",
      h("input", { name: "everyMonths", type: "number", min: 1, max: 120, step: 1, required: true, list: "intervals", value: String(editing?.everyMonths ?? 1) })),
    h("datalist", { id: "intervals" }, INTERVALS.map(([v, label]) => h("option", { value: String(v), label }))),
    boundField("from", "Starts", editing ? editing.from : null,
      [["none", "Now"], ["retirement", "At retirement"], ["age", "At age"], ["month", "In month"]],
      kind === "expenses"
        ? ["An expense that starts at retirement, such as health insurance, raises what the portfolio pays from then; one that ends, such as a loan, lowers it.",
            "Ages and retirement start in January of their year."]
        : null),
    boundField("until", "Ends", editing ? editing.until : kind === "income" ? { at: "retirement" } : null,
      [["none", "Never"], ["retirement", "At retirement"], ["age", "At age"], ["month", "After month"]],
      kind === "income"
        ? ["Income that goes on after retirement, such as a pension or rent, lowers what the portfolio pays: let it end never, or at an age.",
            "Ages and retirement start in January of their year."]
        : null),
    kind === "expenses"
      ? h("div", { class: "check-row" },
          h("label", { class: "check" }, h("input", { type: "checkbox", name: "essential", checked: editing?.essential ?? false }), "Essential"),
          info("Essential", "Needed even on the leanest budget, such as rent, food and insurance.", "Essential expenses make up Lean FI on the dashboard."))
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
            onclick: () => {
              const saved = F.saveItem(store, kind, { ...item, active: !item.active });
              if (!saved.ok) {
                state.notice = { kind: "error", text: `Not saved: ${saved.error}.` };
                return render();
              }
              commit(saved.store, item.active ? `${item.name} is inactive: it no longer counts.` : `${item.name} is active again.`);
            } },
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
    card([names.title, kind === "income"
      ? info("income", "Regular income after tax, such as a salary, rent or a pension. A yearly bonus counts as one twelfth a month.")
      : info("expenses", "Regular payments only, such as rent, insurance and subscriptions. A yearly one counts as one twelfth a month.",
          ["Pay-ins to broker accounts go under ", h("a", { href: "#portfolio" }, "Portfolio"), ", not here."])],
      summary,
      h("h3", null, editing ? `Edit ${editing.name}` : `Add ${names.one === "income" ? "income" : "an expense"}`),
      form),
    items.length
      ? card(null, h("div", { class: "table-wrap" }, h("table", null,
          h("thead", null, h("tr", null, h("th", null, "Name"), h("th", { class: "num" }, "Amount"), h("th", null, "Paid"), h("th", { class: "num" }, "Per month"), h("th"))),
          h("tbody", null, rows))))
      : null,
    kind === "income" ? pensionCard() : [healthCard(), flatCard()]);
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
      // A month typed and not switched to yet: Save shows that month first,
      // and saves nothing, so values never go to a month the field no
      // longer shows.
      const typed = F.parseMonth(data.get("month"));
      if (typed && typed !== month) {
        state.month = typed;
        state.focus = "#month-pick";
        return render();
      }
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
    h("div", { class: "month-pick" }, field("Month", monthField({ id: "month-pick", name: "month", required: true, value: month, onpick: (picked, left) => {
      state.month = picked;
      if (!left) {
        state.focus = "#month-pick";
        return render();
      }
      // Left: the focus goes on where it went, in the page for the month:
      // the control of the same name or label (an ⓘ), or else the one in
      // the same place, with the explanation it opened.
      const to = document.activeElement;
      const opened = to?.popoverTargetElement?.matches(":popover-open");
      const key = to?.name ? ["name", to.name] : to?.hasAttribute("aria-label") ? ["aria-label", to.getAttribute("aria-label")] : null;
      const controls = () => [...document.querySelectorAll("#main :is(a, button, input, select, textarea)")];
      const at = controls().indexOf(to);
      render();
      const same = key ? document.querySelector(`#main [${key[0]}="${CSS.escape(key[1])}"]`) : null;
      const next = same ?? controls()[at];
      next?.focus();
      if (opened) next?.popoverTargetElement?.showPopover();
    } }))),
    store.accounts.length === 0
      ? h("p", { class: "muted" }, "Add your ", settingsLink("data", "accounts"), " in Settings first, or ", settingsLink("export", "import past months"), " from a CSV file.")
      : h("div", { class: "table-wrap" }, h("table", { class: "entry" },
          h("thead", null, h("tr", null, h("th", null, "Account"),
            h("th", null, "Value at month end",
              info("the value at month end", "What each account is worth on the last day of the month. For a debt, what is still owed.",
                "Cash, the emergency fund, property, pension assets and debts take a value only: pay-ins are for the portfolio.")),
            h("th", null, "Paid in this month",
              info("paid in", "Your regular pay-ins, such as a savings plan; negative for a withdrawal.",
                ["Their average of the last 12 months is what the milestones and the forecast go on with, unless you plan your own under Future pay-ins in ", h("a", { href: "#settings" }, "Settings"), "."])),
            h("th", null, "One-off this month",
              info("one-offs", "A lump sum in or out, such as an inheritance or a house deposit. It counts as paid in, but not for the average pay-in.",
                ["Plan future ones in ", settingsLink("data"), "."])))),
          h("tbody", null, store.accounts.map((account) => {
            const record = monthRecords.get(account.id);
            const before = lastValueBefore(store, account.id, month);
            // Pay-ins count for the portfolio only: other accounts have a value.
            const invested = isInvested(account);
            return h("tr", null,
              h("th", { scope: "row" }, account.name, invested ? null : h("div", { class: "sub" }, kindLabel(account.kind))),
              h("td", null, h("input", { name: `value-${account.id}`, class: "amount", inputmode: "decimal", autocomplete: "off",
                "aria-label": `${account.name} ${account.kind === "debt" ? "still owed" : "value"}`,
                value: record ? inputMoney(record.value) : "", placeholder: before ? `last: ${hidden() ? "•••" : inputMoney(before.value)}` : zero })),
              invested
                ? h("td", null, h("input", { name: `payin-${account.id}`, class: "amount", inputmode: "decimal", autocomplete: "off", "aria-label": `${account.name} pay-in`,
                    value: record && record.payIn !== 0 ? inputMoney(record.payIn) : "", placeholder: zero }))
                : h("td", { class: "muted" }, "–"),
              invested
                ? h("td", null, h("input", { name: `oneoff-${account.id}`, class: "amount", inputmode: "decimal", autocomplete: "off", "aria-label": `${account.name} one-off`,
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
  const history = worth.length === 0 ? null : card(["History", info("the history", "An account without a value in a month counts with its last value.")],
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
    h("section", { class: "card" },
      h("div", { class: "card-head" }, h("h2", null, "Portfolio"),
        store.accounts.length
          ? h("span", null, h("a", { class: "label-link", href: "#settings/data" }, "Accounts"), h("a", { class: "label-link", href: "#settings/export" }, "CSV import"))
          : null),
      portfolioSummary(store),
      h("h3", null, "Monthly values"),
      monthForm),
    history);
}

// The few numbers at the top of the Portfolio page, as on Expenses and
// Income: the portfolio in its latest month and that month's change, the
// average pay-in, and the net worth with other kinds of accounts. The rest
// is on the dashboard. null before any value.
function portfolioSummary(store) {
  const m = F.metrics(store);
  const item = (term, value, strong) => h("div", null, h("dt", null, term), h("dd", { class: strong ? "num strong" : "num" }, value));
  const items = [];
  const [before, last] = m.series.length >= 2 ? m.series.slice(-2) : [null, m.series.at(-1)];
  if (last) {
    items.push(item(`Portfolio, ${monthLabel(last.month)}`, money(last.value), true));
    if (before) {
      items.push(item(`Change in ${monthLabel(last.month)}`,
        `${signedMoney(last.value - before.value)} · ${money(last.payIn)} paid in${last.oneOff ? `, ${signedMoney(last.oneOff)} one-off` : ""}`));
    }
    const average = F.averagePayIn(m.series);
    items.push(item(`Average pay-in, ${average.months === 1 ? "1 month" : `${average.months} months`}`, `${money(average.average)} / month`));
  }
  const worth = m.netWorth.at(-1);
  if (worth && store.accounts.some((a) => !isInvested(a))) {
    items.push(item(worth.month === last?.month ? "Net worth" : `Net worth, ${monthLabel(worth.month)}`, money(worth.total), !last));
  }
  return items.length ? h("dl", { class: "summary" }, items) : null;
}

// What the portfolio and each invested account returned, time-weighted
// over several periods and money-weighted since the start, on the
// dashboard under the chart. A period no row has yet is left out.
function returnsCard(store) {
  const series = F.portfolioSeries(store);
  if (series.length < 2) return null;
  const invested = store.accounts.filter(isInvested);
  const rows = [["Portfolio", F.returnsOf(series)]];
  if (invested.length > 1) {
    for (const account of invested) {
      // Up to the portfolio's latest month, so every row covers the same months.
      const own = F.accountSeries(store, account.id, series.at(-1).month);
      if (own.length >= 2) rows.push([account.name, F.returnsOf(own)]);
    }
  }
  const cell = (rate) => h("td", { class: "num" }, rate === null ? h("span", { class: "muted" }, "–") : signedPercent(rate));
  const latestYear = series.at(-1).month.slice(0, 4);
  const columns = [["ytd", latestYear], ["year", "1 year"], ["three", "3 years, a year"], ["five", "5 years, a year"],
    ["all", "Since the start"], ["moneyWeighted", "Your money, since the start"]]
    .filter(([key]) => rows.some(([, r]) => r[key] !== null));
  if (columns.length === 0) return null;
  return card(["Returns", info("the returns",
      "All but Your money are time-weighted: what the investments did, month by month chained, whatever was paid in or out. Compare them with an index or a fund.",
      "Your money is money-weighted: what your money earned, given when you paid it in. Paying in before a rise makes it higher, before a fall lower.",
      "Since the start, both are a year once there are 12 months or more, and the whole time before that. Pay-ins and one-offs count from the middle of their month; – means the history is shorter.")],
    h("div", { class: "table-wrap" }, h("table", null,
      h("thead", null, h("tr", null, h("th", null, ""), columns.map(([, label]) => h("th", { class: "num" }, label)))),
      h("tbody", null, rows.map(([name, r]) => h("tr", null,
        h("th", { scope: "row" }, name, h("div", { class: "sub" }, `since ${monthLabel(r.since)}`)),
        columns.map(([key]) => cell(r[key]))))))));
}

// ---------------------------------------------------------------- forecast

// The phases, as the key names them.
const PHASE_NAMES = { invest: "Investing", coast: "Coasting", retired: "Retired", other: "Other income" };
const phaseKey = (kind) => h("span", { class: `phase-key ${kind}` }, PHASE_NAMES[kind]);

// The plans, as the page shows them: the answers to "When can you stop?",
// each a plan, and the picked plan's bar. null without a year of birth.
// Otherwise { result, o, cards, rows }: cards in the order shown, each {
// key, question, answer ("now", an age, or null when the plan doesn't
// happen before retirement), level, label (whether the money lasts, or
// that it doesn't happen), title (longer) }; rows: the bar of
// each plan that happens, by key, with its name and phases' segments, and
// need: when it runs out, what would make it last even at the low growth
// ({ text, more }), else null.
function forecastPlans(store) {
  const { birthYear, retirementAge } = store.settings;
  const o = outlook(store);
  const result = o.plans(inTodaysMoney() ? "today" : "nominal");
  if (!result) return null;
  const { months } = result;
  const index = (month) => F.monthIndex(month) - F.monthIndex(months[0]);
  const age = (month) => F.ageIn(month, birthYear);
  const low = percentUnit.format(o.rates.low);
  const perMonth = (cents, sign) => `${sign}${money(cents)}/month`;
  const plans = Object.fromEntries(result.plans.map((plan) => [plan.key, plan]));
  // The first month without pay-ins: the month after the last one.
  const coastsFrom = (plan) => (plan.stopInvesting === null ? months[1] : F.addMonths(plan.stopInvesting, 1));
  const when = (month) => (month === months[1] ? "now" : String(age(month)));

  const name = (plan) => {
    if (o.retired) return "Retired";
    if (plan.key === "coast") return plan.stopInvesting === null ? "Stop investing now" : `Stop investing at ${age(coastsFrom(plan))}`;
    if (plan.key === "keep") return `Stop working at ${retirementAge}`;
    return plan.retires === months[1] ? "Stop working now" : `Stop working at ${age(plan.retires)}`;
  };
  // Lasts to SHOWN_AGE, even at the low growth; runs out at the low
  // growth only; or at the expected return too.
  const status = (plan) => {
    const { low: atLow, mid: atMid } = plan.runsOut;
    if (atMid !== null) return { level: "bad", title: `Runs out at ${age(atMid)}`, out: { from: index(atMid), text: `Empty at ${age(atMid)}` } };
    if (atLow !== null) return { level: "risk", title: `Runs out at ${age(atLow)} if growth is ${low}`, out: { from: index(atLow), text: `${low}: empty at ${age(atLow)}` } };
    return { level: "ok", title: `Lasts to ${F.SHOWN_AGE}, even at ${low} growth`, out: null };
  };
  // What starts a step while retired: an income that starts (a pension),
  // or later also an expense or income that starts or ends.
  const cause = (step, first) => {
    const income = step.changes.find((c) => c.kind === "income" && c.starts);
    if (income) return { text: `+ ${income.name}`, income: true };
    const other = first ? null : step.changes[0];
    return other ? { text: `${other.name} ${other.starts ? "starts" : "ends"}`, income: false } : null;
  };
  // A part of the bar for each amount a month: what the portfolio pays
  // while retired, what is paid in while investing (a planned pay-in change
  // starts a part of its own). Hovering a part shows its amount and ages.
  const ages = (from, to) => `${age(months[from])}–${age(months[Math.min(to, months.length) - 1])}`;
  const tip = (kind, from, to, text) => `${PHASE_NAMES[kind]}, ${text}, ${ages(from, to)}`;
  const segments = (plan) => plan.phases.flatMap((phase) => {
    if (phase.kind === "retired") {
      return phase.steps.map((step, k) => {
        const texts = [step.amount > 0 ? perMonth(step.amount, "−") : perMonth(0, ""), step.amount > 0 ? `−${money(step.amount)}` : money(0)];
        return {
          kind: "retired", from: step.from, to: step.to, share: step.share, step: k > 0, cause: cause(step, k === 0), texts,
          tip: tip("retired", step.from, step.to, texts[0]),
          end: plan.values.mid[Math.min(step.to, months.length) - 1],
        };
      });
    }
    const sign = (cents) => (cents > 0 ? "+" : "");
    return phase.steps.map((step, k) => {
      const texts = [perMonth(step.amount, sign(step.amount)), `${sign(step.amount)}${money(step.amount)}`];
      return {
        kind: phase.kind, from: step.from, to: step.to, share: 1, step: k > 0, cause: null, texts,
        tip: tip(phase.kind, step.from, step.to, texts[0]),
        end: k === phase.steps.length - 1 ? plan.values.mid[phase.to - 1] : null,
      };
    });
  });
  // What the portfolio would need at the plan's turn to last even at the
  // low growth: the next whole thousand above what it has to be more than.
  // And how much more that is than it has then at the low growth, which
  // is more for every plan that runs out then; what it has at the expected
  // return may not be, when the slower growth before the turn is what
  // falls short.
  const up = (cents) => Math.ceil(cents / 100000) * 100000;
  const need = (plan) => {
    const value = (Math.floor(plan.lastsWith.low / 100000) + 1) * 100000;
    const more = up(value - plan.values.low[plan.stopInvesting === null ? 0 : index(plan.stopInvesting)]);
    const at = when(coastsFrom(plan));
    return { text: `Lasts even at ${low} with ${money(value)} ${at === "now" ? "now" : `at ${at}`}`, more: more > 0 ? `(${signedMoney(more)})` : null };
  };
  const rows = {};
  for (const plan of result.plans) {
    if (plan.retires === null) continue;
    const s = status(plan);
    rows[plan.key] = { name: name(plan), level: s.level, title: s.title, label: s.out ? s.out.text : `Lasts to ${F.SHOWN_AGE}`, out: s.out, segments: segments(plan), need: s.out ? need(plan) : null, plan };
  }

  // A plan that doesn't happen before retirement says so instead.
  const card = (key, question, answer) => {
    const row = rows[key];
    return row
      ? { key, question, answer, level: row.level, label: row.label, title: row.title }
      : { key, question, answer: null, level: null, label: `Not before ${retirementAge}`, title: null };
  };
  let cards;
  if (o.retired) {
    cards = [card("keep", "Retired", "now")];
  } else {
    const { coast, fi, safe } = plans;
    cards = [
      card("coast", "Stop investing", coast.retires && when(coastsFrom(coast))),
      card("fi", "Stop working", fi.retires && when(fi.retires)),
      safe ? card("safe", `Even at ${low}`, safe.retires && String(age(safe.retires))) : null,
      card("keep", "At the latest", String(retirementAge)),
    ].filter(Boolean);
  }
  return { result, o, cards, rows };
}

function viewForecast() {
  const store = state.store;
  const missing = [];
  if (store.settings.birthYear === null) missing.push(h("li", null, "your year of birth, in ", settingsLink("general")));
  if (F.counted(store.expenses).length === 0) missing.push(h("li", null, "your ", h("a", { href: "#expenses" }, "expenses"), ", for the FI number"));
  if (missing.length) {
    return h("div", null, card("Forecast",
      h("p", null, "How your portfolio could grow until you retire, and whether it lasts after. The forecast needs:"),
      h("ul", null, missing)));
  }
  const { o } = forecastPlans(store);
  const { inflation, coastPayIn, retirementAge } = store.settings;
  const rate = (g) => percentUnit.format(o.rates[g]);
  const about = info("when you can stop",
    h("ul", null,
      h("li", null, `Stop investing: from then on, ${coastPayIn > 0 ? `paying in ${money(coastPayIn)} a month` : "without paying in"}, the portfolio still reaches the FI number by ${retirementAge} (Coast FI).`),
      h("li", null, "Stop working: as soon as the portfolio reaches the FI number."),
      h("li", null, `Even at ${rate("low")}: the first age, from January, at which stopping work lasts to ${F.SHOWN_AGE} with only ${rate("low")} growth. Shown when stopping at FI runs out then.`),
      h("li", null, "At the latest: the retirement age, set in ", settingsLink("general"), "."),
      h("li", null, `Lasts even at ${rate("low")} with: what a plan that runs out at ${rate("low")} would need when it stops investing or working, to last to ${F.SHOWN_AGE} with only ${rate("low")} growth from then on. In brackets, how much more that is than it would have then at ${rate("low")}.`),
      h("li", null, `Each plan at the expected return, ${rate("mid")} a year before inflation. The band and the ${rate("low")} result keep the same dates, with ${rate("low")} to ${rate("high")} growth.`),
      h("li", null, "Growth is the same every year. Real markets are not, and bad years right after you stop working hurt most."),
      h("li", null, `Amounts a month are as you entered them: pay-ins as in `, settingsLink("data"), ", and what the portfolio pays in today's money, the expenses with buffer less the income that counts then."),
      h("li", null, `Expenses rise by ${percentUnit.format(inflation)} inflation a year. Today's money takes it out of the portfolio's values again: what they would buy now.`),
      h("li", null, store.records.length ? `It starts from the portfolio in ${monthLabel(o.start)}, ${money(o.value)}.` : "It starts from 0, as there are no broker values yet."),
      h("li", null, `Planned one-offs count in their month. A plan lasts when money is left at ${F.SHOWN_AGE}. Taxes are left out.`)));
  return h("div", null,
    h("div", { class: "answers-head" }, h("h2", null, "When can you stop?", about), moneySwitch(drawForecast)),
    h("div", { id: "forecast-answers", class: "answers", role: "radiogroup", "aria-label": "When can you stop?" }),
    h("section", { class: "card forecast" },
      h("div", { class: "card-head" },
        h("div", { class: "plan-head" },
          h("h2", { id: "forecast-title", class: "plan-title" }),
          h("p", { id: "forecast-need", class: "plan-need", hidden: true })),
        h("div", { id: "forecast-keys", class: "phase-keys" })),
      h("div", { id: "forecast-chart", class: "forecast-box" })),
    payInCard(store));
}

// Draws the answers, and the picked one's bar and chart; with focus,
// focuses the picked answer (after a pick by keyboard or click).
function drawForecast(focus = false) {
  const box = document.getElementById("forecast-chart");
  if (!box) return;
  for (const button of document.querySelectorAll("[data-money]")) {
    button.classList.toggle("active", button.dataset.money === state.money);
    button.setAttribute("aria-pressed", String(button.dataset.money === state.money));
  }
  const store = state.store;
  const plans = forecastPlans(store);
  if (!plans) return;
  const { result, cards, rows, o } = plans;
  const open = cards.filter((c) => c.answer !== null);
  const picked = open.find((c) => c.key === state.forecast.plan) ?? open.find((c) => c.key === "fi") ?? open[0];
  const pick = (key) => { setPlan(key); drawForecast(true); };

  // The answers: a radio group, the arrow keys move between them.
  const buttons = cards.map((c) => {
    const on = c === picked;
    return h("button", { type: "button", class: `tile answer${on ? " on" : ""}`, role: "radio", "aria-checked": String(on), tabindex: on ? "0" : "-1",
      disabled: c.answer === null, title: c.title, "data-key": c.key, onclick: () => { if (!on) pick(c.key); } },
      h("span", { class: "tile-label" }, c.question),
      h("span", { class: "tile-value" }, c.answer ?? "–"),
      h("span", { class: `answer-status ${c.level ?? "none"}` }, c.label));
  });
  const enabled = buttons.filter((b) => !b.disabled);
  for (const b of enabled) {
    b.addEventListener("keydown", (event) => {
      const k = enabled.indexOf(b);
      const next = { ArrowDown: k + 1, ArrowRight: k + 1, ArrowUp: k - 1, ArrowLeft: k - 1 }[event.key];
      if (next === undefined) return;
      event.preventDefault();
      pick(enabled[(next + enabled.length) % enabled.length].dataset.key);
    });
  }
  const list = document.getElementById("forecast-answers");
  list.replaceChildren(...buttons);
  if (focus) list.querySelector("[aria-checked='true']")?.focus();

  // The picked plan: its name, the key to its phases, its bar and chart.
  const row = rows[picked.key];
  const { plan } = row;
  document.getElementById("forecast-title").replaceChildren(statusBadge(row.level), row.name);
  const need = document.getElementById("forecast-need");
  need.hidden = row.need === null;
  need.className = `plan-need ${row.level}`;
  need.replaceChildren(...(row.need ? [row.need.text, row.need.more && " ", row.need.more && h("span", { class: "plan-need-more" }, row.need.more)].filter(Boolean) : []));
  const kinds = new Set(plan.phases.map((phase) => phase.kind));
  const other = plan.phases.some((phase) => phase.steps.some((step) => step.share !== undefined && step.share < 0.999));
  document.getElementById("forecast-keys").replaceChildren(...["invest", "coast", "retired"].filter((k) => kinds.has(k)).map(phaseKey), ...(other ? [phaseKey("other")] : []));
  const index = (month) => F.monthIndex(month) - F.monthIndex(result.months[0]);
  const last = result.months.length - 1;
  // Steps while retired (a pension starts) get a line and a dot; pay-in
  // changes stay inside their phase, as on the bar.
  const steps = plan.phases.filter((phase) => phase.kind === "retired").flatMap((phase) => phase.steps.slice(1).map((step) => step.from));
  const marks = [...plan.phases.map((phase) => Math.min(phase.to, last + 1) - 1), ...steps.map((i) => i - 1)];
  const outs = [plan.runsOut.low, plan.runsOut.mid].filter((month) => month !== null).map(index);
  const rate = (g) => percentUnit.format(o.rates[g]);
  const short = (cents) => axisMoney(Math.abs(cents) >= 100000000 ? cents : Math.round(cents / 100000) * 100000);
  drawResizing([box, () =>
    renderForecast(box, {
      months: result.months,
      row,
      chart: { values: plan.values, rates: { low: rate("low"), mid: rate("mid"), high: rate("high") }, phases: plan.phases, marks, steps, outs },
      ageOf: (month) => F.ageIn(month, store.settings.birthYear),
      format: money,
      formatShort: short,
      formatAxis: axisMoney,
      formatMonth: monthLabel,
    })]);
}

// Pay in more or less: a bar for each amount a month, from now to when you
// could stop working (fiOutlook's payIns), with how long that is from now
// and your age then, on a line of years from now (with the ages along it)
// that ends at the retirement age, and how much sooner or later that is than
// with the average pay-in. Your plan from Settings is a row of its own when
// it isn't the average every month. null when there is nothing to compare.
function payInCard(store) {
  const o = outlook(store);
  const scenarios = o.payIns();
  if (!scenarios) return null;
  const { birthYear, retirementAge } = store.settings;
  const first = F.monthIndex(o.start);
  const end = F.monthIndex(o.retirement);
  const span = end - first;
  const at = (index) => String((index - first) / span); // along the line, 0 to 1
  const average = scenarios.rows.find((row) => row.average);
  const never = `Not before ${retirementAge}`;

  // Months from this month, which can be after the latest recorded month
  // the bars start at, to a row's stop (0 once it has come); and that in
  // tenths of a year, as the bar ends show it.
  const today = thisMonth();
  const ahead = (row) => Math.max(0, F.monthIndex(row.retires) - today);
  const tenthsAhead = (row) => yearTenths(ahead(row));
  const length = (row) => {
    const months = ahead(row);
    if (months === 0) return "now";
    if (months < 12) return [String(months), " ", h("span", { class: "payin-unit" }, months === 1 ? "month" : "months")];
    const t = tenthsAhead(row);
    return [tenths.format(t / 10), " ", h("span", { class: "payin-unit" }, t === 10 ? "year" : "years")];
  };
  // How long, then the age at the stop, without a unit.
  const ending = (row) => [length(row), " ", h("span", { class: "payin-age" }, String(F.ageIn(row.retires, birthYear)))];

  // Sooner or later than with the average: months under a year, else the
  // difference of the tenths the bars end with, so the numbers add up.
  const change = (row) => {
    if (row.retires === null) return never;
    if (row.average) return "–";
    if (average.retires === null) return "";
    const months = ahead(row) - ahead(average);
    if (months === 0) return "same";
    const by = Math.abs(months) < 12 ? monthsText(Math.abs(months)) : tenthsText(Math.abs(tenthsAhead(row) - tenthsAhead(average)));
    return `${by} ${months < 0 ? "sooner" : "later"}`;
  };

  const { payIn } = o;
  const planInfo = () => info("your plan",
    h("p", null, "What you pay in as planned in ", settingsLink("data"), ", as the plans above count it:"),
    h("ul", null,
      h("li", null, `Now: ${money(payIn.invested)} a month`),
      payIn.changes.map((c) => h("li", null, `From ${monthLabel(c.month)}, at ${F.ageIn(c.month, birthYear)}: ${c.average ? "the average, " : ""}${money(c.amount)}`))),
    payIn.rises ? "Rising with inflation." : null);
  // An average that would show as one of the steps shows its cents.
  const looksLikeStep = (cents) => !F.PAY_IN_STEPS.includes(cents) && F.PAY_IN_STEPS.includes(Math.round(cents / 100) * 100);
  const label = (row) => {
    if (row.plan) return ["Plan", planInfo()];
    if (!row.average) return money(row.amount);
    return [looksLikeStep(row.amount) ? moneyExact(row.amount) : money(row.amount), h("span", { class: "sub" }, " average")];
  };

  // Sooner first; a tie keeps this order, the plan before the average.
  const rows = scenarios.rows.flatMap((row) => (row.average && scenarios.plan ? [{ ...scenarios.plan, plan: true }, row] : [row]));
  const when = (row) => (row.retires === null ? Infinity : F.monthIndex(row.retires));
  rows.sort((a, b) => when(a) - when(b));

  // After the bar, how long from now and the age then; hovering the bar or
  // that shows the month and the age.
  const line = (row) => {
    const tip = row.retires === null ? never : `Stop working in ${monthLabel(row.retires)}, at ${F.ageIn(row.retires, birthYear)}`;
    const bar = h("span", { class: `payin-bar${row.retires === null ? " never" : ""}`, title: tip });
    bar.style.setProperty("--at", row.retires === null ? "1" : at(F.monthIndex(row.retires)));
    const time = row.retires === null ? null : h("span", { class: "payin-time", title: tip }, ending(row));
    time?.style.setProperty("--at", bar.style.getPropertyValue("--at"));
    return h("div", { class: `payin-row${row.average ? " average" : ""}`, role: "listitem" },
      h("span", { class: "payin-label" }, label(row)),
      h("span", { class: "payin-track" }, bar, time),
      h("span", { class: "payin-change" }, change(row)));
  };

  // Under the bars, every 5 (or 1, 2, 10) years from now, with the age
  // then under it, and the retirement age at the end.
  const years = span / 12;
  const every = [1, 2, 5, 10].find((n) => years / n <= 7) ?? 20;
  const ticks = [];
  for (let n = every; today + n * 12 < end; n += every) {
    const index = today + n * 12;
    if (end - index >= every * 12 * 0.6) ticks.push([String(n), F.ageIn(F.monthFromIndex(index), birthYear), index]);
  }
  ticks.push(["", retirementAge, end]);
  const axis = h("div", { class: "payin-row payin-axis", "aria-hidden": "true" },
    h("span", { class: "payin-label" }, h("span", null, "Years"), h("span", null, "Age")),
    h("span", { class: "payin-track" }, ticks.map(([n, age, index]) => {
      const tick = h("span", { class: "payin-tick" }, h("span", null, n), h("span", { class: "payin-tick-age" }, String(age)));
      tick.style.setProperty("--at", at(index));
      return tick;
    })),
    h("span", { class: "payin-change" }));

  const about = info("pay in more or less",
    `When you could stop working if you paid in the same amount every month from now on, at the expected return of ${percentUnit.format(o.rates.mid)}: the month after FI, as Stop working counts it.`,
    `From ${money(F.PAY_IN_STEPS[0])} to ${money(F.PAY_IN_STEPS.at(-1))} a month, in steps of ${money(F.PAY_IN_STEPS[1])}.`,
    `Average: what you paid in a month over ${scenarios.months ? payInMonths(scenarios.months) : "the months so far"}.`,
    payIn.rises ? "Like your pay-ins, they rise with inflation." : null,
    scenarios.plan ? ["Plan: what you pay in as set in ", settingsLink("data"), ", with its changes."] : null,
    "After each bar, how long from now and your age then; under the line, your age along the way. Times are in months under a year, else in years to a tenth.",
    "Planned one-offs count in every row.");
  return h("section", { class: "card payins" },
    h("div", { class: "card-head" }, h("h2", null, "Pay in more or less", about)),
    h("div", { class: "payin-rows", role: "list", "aria-label": "Pay in more or less" }, rows.map(line), axis));
}

// ---------------------------------------------------------------- settings

function viewSettings() {
  const store = state.store;
  const tab = state.settingsTab;
  const tabs = h("nav", { class: "tabs", "aria-label": "Settings" },
    SETTINGS_TABS.map(([key, label]) => h("a", { href: `#settings/${key}`, class: key === tab ? "active" : null, "aria-current": key === tab ? "page" : null }, label)));
  const pages = {
    data: () => [
      card("Assumptions", assumptionsForm(store)),
      payInsCard(store),
      eventsCard(store),
      card("Categories",
        h("div", { class: "columns" }, F.KINDS.map((kind) => h("div", null, h("h3", null, KINDS[kind].title), categoryList(store, kind))))),
      card(["Accounts", info("accounts",
          "Invested accounts (brokers, ETF savings plans) are the portfolio: the milestones and the forecast count them alone.",
          "Cash (money you may spend, such as savings for a flat), the emergency fund (Tagesgeld you keep for emergencies), property, pension assets (Riester, Rürup, company pension: locked until retirement) and debts (what is still owed, such as a mortgage) count for the net worth.")],
        accountList(store)),
    ],
    general: () => [
      card("General", generalForm(store)),
      lockCard(),
      card(["Data file", info("the data file",
          "Everything is saved in one file on this computer. No account and no sync: copy the file to back it up.",
          "Before the first change of each day, Finance keeps a copy of the file as it was, for the last 30 days with changes. To go back to a day, copy its file over the data file; open windows show it once they get focus.")],
        h("dl", { class: "paths" },
          h("dt", null, "Your data"), h("dd", null, h("code", null, state.file)),
          h("dt", null, "Daily copies"), h("dd", null, h("code", null, state.backups)))),
      card(["Updates", info("updates",
          "Stable offers releases, with release notes on GitHub. Preview offers every change as soon as its tests pass, before it is released: new features first, and now and then a new bug.",
          "Back on Stable, Finance keeps the version it has until a release is newer, so it never goes back to an older one.")],
        updates.channelSettings()),
    ],
    export: () => [importCard(store), exportCard(store)],
  };
  return h("div", null, tabs, ...pages[tab]());
}

// The lock's switch, updated in place so the rest of Settings stays as typed.
let lockChoice = null;
function lockCard() {
  const box = h("input", { type: "checkbox", id: "lock-switch", onchange: (event) => setLock(event.currentTarget.checked) });
  const note = h("p", { role: "status" });
  lockChoice = { box, note };
  renderLockChoice();
  return card(["Lock", info("the lock",
      `Finance asks for your fingerprint, or your password, when it opens. It locks again after ${state.lock.idleMinutes} minutes without use, when the computer sleeps, and with Ctrl+L, which also unlocks it.`,
      "While it is locked it shows nothing, and other programs on this computer can't read the data through it either.")],
    h("div", { class: "check-row" }, h("label", { class: "check" }, box, "Lock Finance")),
    note);
}

function renderLockChoice() {
  if (!lockChoice) return;
  const { available, enabled, asking, error } = state.lock;
  // While the server is asked, it shows what was clicked.
  lockChoice.box.checked = asking === "on" ? true : asking === "off" ? false : enabled;
  lockChoice.box.disabled = !available || Boolean(asking);
  // Without the polkit action the box can't change: the line says what
  // installs it, as the next step rather than a remark.
  lockChoice.note.className = error ? "lock-error" : available ? "muted" : "";
  lockChoice.note.replaceChildren(...(error ? [sentence(error)]
    : !available ? ["Not installed yet: run ", h("code", null, state.setup || "setup"), " once in a terminal. It asks for sudo."]
    : asking === "off" ? ["Confirm in the dialog."]
    : []));
}

// What seldom changes: how amounts are shown, and the year of birth and the
// retirement age.
function generalForm(store) {
  const { currency: code, numberFormat, birthYear, retirementAge } = store.settings;
  const codes = Intl.supportedValuesOf("currency");
  if (!codes.includes(code)) codes.push(code);
  return h("form", { class: "settings-form", onsubmit: (event) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const chosen = String(data.get("currency"));
    const format = String(data.get("numberFormat"));
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
    else if (born !== null && !(/^[0-9]{4}$/.test(birthText) && born >= firstYear && born <= thisYear)) error = `Year of birth: enter a year from ${firstYear} to ${thisYear}, or leave it empty.`;
    else if (!/^[0-9]+$/.test(ageText) || age < ages.min || age > ages.max) error = `Retirement age: enter whole years from ${ages.min} to ${ages.max}.`;
    if (error) return showError(event.currentTarget, error);
    commit(F.saveSettings(store, { currency: chosen, numberFormat: format, birthYear: born, retirementAge: age }), "Settings saved.");
  } },
    field("Currency",
      h("select", { name: "currency", value: code }, codes.sort().map((c) => h("option", { value: c }, `${c} – ${currencyName(c)}`))),
      "How amounts are shown. Changing it does not convert amounts already entered."),
    field("Number format",
      h("select", { name: "numberFormat", value: numberFormat }, F.NUMBER_FORMATS.map((f) => h("option", { value: f }, f))),
      "How amounts and percentages are shown. Amounts can be typed either way."),
    field("Year of birth", h("input", { name: "birthYear", inputmode: "numeric", autocomplete: "off", value: birthYear === null ? "" : String(birthYear), placeholder: "1990" })),
    field("Retirement age", h("input", { name: "retirementAge", inputmode: "numeric", autocomplete: "off", value: String(retirementAge), required: true }),
      "The age you stop working at the latest. For employees usually when the state pension starts without deductions: 67 in Germany for everyone born in 1964 or later. The forecast works out when you could stop sooner.",
      "Retirement starts in January of the year you reach it."),
    h("div", { class: "form-actions" }, h("button", { type: "submit", class: "primary" }, "Save")));
}

// What the FI number and the projections assume, and the emergency fund
// to aim for.
function assumptionsForm(store) {
  const { withdrawalRate, bufferPercent, expectedReturn, inflation, emergencyMonths } = store.settings;
  return h("form", { class: "settings-form", onsubmit: (event) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const rate = F.parsePercent(data.get("withdrawalRate"), { decimals: RATE_DECIMALS });
    const buffer = F.parsePercent(data.get("bufferPercent"));
    const growth = F.parsePercent(data.get("expectedReturn"));
    const prices = F.parsePercent(data.get("inflation"));
    const emergencyText = String(data.get("emergencyMonths")).trim();
    const emergency = Number(emergencyText);
    let error = null;
    if (!rate.ok || !(rate.value > 0 && rate.value <= 100)) error = `Withdrawal rate: enter a percentage above 0 and at most 100, with up to ${RATE_DECIMALS} decimals.`;
    else if (!buffer.ok || !(buffer.value >= 0 && buffer.value <= 100)) error = "Buffer: enter a percentage from 0 to 100.";
    else if (!growth.ok || !(growth.value >= 0 && growth.value <= 100)) error = "Expected return: enter a percentage from 0 to 100.";
    else if (!prices.ok || !(prices.value >= 0 && prices.value <= 100)) error = "Inflation: enter a percentage from 0 to 100.";
    else if (!/^[0-9]+$/.test(emergencyText) || emergency < F.EMERGENCY_MONTHS.min || emergency > F.EMERGENCY_MONTHS.max) error = `Emergency fund: enter whole months from ${F.EMERGENCY_MONTHS.min} to ${F.EMERGENCY_MONTHS.max}.`;
    if (error) return showError(event.currentTarget, error);
    commit(F.saveSettings(store, {
      withdrawalRate: rate.value,
      bufferPercent: buffer.value,
      expectedReturn: growth.value,
      inflation: prices.value,
      emergencyMonths: emergency,
    }), "Settings saved.");
  } },
    field("Safe withdrawal rate (%)", h("input", { name: "withdrawalRate", inputmode: "decimal", value: plainRate.format(withdrawalRate), required: true }),
      "The share of the portfolio you plan to spend each year once financially independent.",
      "FI number = yearly expenses ÷ this rate: at 4 % that is 25 × yearly expenses. Many use 3 to 3.5 % for longer retirements or to allow for taxes."),
    field("Buffer on expenses (%)", h("input", { name: "bufferPercent", inputmode: "decimal", value: plain.format(bufferPercent), required: true }),
      "Added on top of regular expenses for irregular costs such as holidays and repairs."),
    field("Expected return, before inflation (%)", h("input", { name: "expectedReturn", inputmode: "decimal", value: plain.format(expectedReturn), required: true }),
      `The portfolio's yearly return, for the milestones, the Path to FI chart and the forecast; the chart and the forecast also show ${F.RETURN_SPREAD} points less and more.`,
      "World stocks have returned about 8 % a year over the long run, about 5 % after inflation, with many years far above or below that."),
    field("Inflation (%)", h("input", { name: "inflation", inputmode: "decimal", value: plain.format(inflation), required: true }),
      "How much prices rise a year. The milestones, the Path to FI chart and the forecast raise your expenses and the FI number by it.",
      "Pay-ins rise by it only if you choose so under Future pay-ins."),
    field("Emergency fund (months of expenses)", h("input", { name: "emergencyMonths", inputmode: "numeric", value: String(emergencyMonths), required: true }),
      "How many months of expenses you want to keep in emergency-fund accounts, apart from the portfolio: 3 to 6 are common. 0 sets no target.",
      "The dashboard says how far your emergency fund goes, at the foot of Net worth."),
    h("div", { class: "form-actions" }, h("button", { type: "submit", class: "primary" }, "Save")));
}

// The amount of a pay-in a month: the average pay-in of the last 12 months
// (amount null), or an amount of your own (undefined: none typed yet). The
// amount shows only for your own; it is disabled otherwise, so a value left
// in it cannot stop the form. Your own starts as the average, so switching
// keeps the projections where they are.
function payInAmountField(name, label, amount, average) {
  const input = h("input", { name: `${name}-amount`, class: "amount", inputmode: "decimal", autocomplete: "off", "aria-label": `${label}: own amount`,
    value: amount === undefined ? "" : inputMoney(amount ?? Math.max(0, Math.round(average?.average ?? 0))), hidden: amount === null, disabled: amount === null });
  const select = h("select", { id: name, name, value: amount === null ? "average" : "own", onchange: (event) => {
    input.hidden = input.disabled = event.target.value !== "own";
  } },
    h("option", { value: "average" }, average ? `Average of ${payInMonths(average.months)}: ${money(average.average)}` : "Average of the last 12 months"),
    h("option", { value: "own" }, "Own amount"));
  return h("div", { class: "field bound" },
    h("span", { class: "field-label" }, h("label", { for: select.id }, label)),
    h("div", { class: "bound-row" }, select, input));
}

// Reads a payInAmountField. Returns { amount } (null: the average) or
// { error }.
function readPayInAmount(data, name, label) {
  if (data.get(name) !== "own") return { amount: null };
  const own = F.parseMoney(data.get(`${name}-amount`));
  if (!own.ok) return { error: `${label}: ${own.error}.` };
  if (own.cents < 0) return { error: `${label}: enter an amount of 0 or more.` };
  return { amount: own.cents };
}

// What is paid in a month from now on: Now (the average, or an amount of
// your own) and the planned changes, each from a month or an age on until
// the next, in the order they start; and whether the projections raise
// pay-ins by the inflation.
function payInsCard(store) {
  const { birthYear, futurePayIn, payInsRiseWithInflation, coastPayIn } = store.settings;
  const series = F.portfolioSeries(store);
  const average = F.averagePayIn(series);
  const now = thisMonth(); // as the dashboard counts it
  const retirement = F.retirementIndex(store.settings);
  // In the order they start (payInPlan's), an age without a year of birth
  // last; the latest one that has started is what is paid in this month.
  const changes = store.payInChanges.map((change) => ({ change, index: F.payInChangeIndex(change, birthYear) }))
    .sort((a, b) => (a.index === b.index ? 0 : a.index < b.index ? -1 : 1));
  const current = changes.filter((c) => c.index <= now).at(-1)?.change ?? null;
  const editing = state.editingPayIn === "now" ? "now" : store.payInChanges.find((c) => c.id === state.editingPayIn) ?? null;

  const amountText = (amount) => (amount !== null ? money(amount) : average ? `Average · ${money(average.average)}` : "Average");
  const startText = ({ from }) => ("month" in from ? monthLabel(from.month) : `Age ${from.age}${birthYear === null ? "" : ` · ${birthYear + from.age}`}`);
  const sub = (text) => (text ? h("div", { class: "sub" }, text) : null);
  const editButton = (key) => h("button", { type: "button", class: "link", onclick: () => { state.editingPayIn = key; state.focus = "#payin-amount"; render(); } }, "Edit");
  const rows = [
    h("tr", { class: editing === "now" ? "editing" : null },
      h("td", null, "Now", sub(current && "A change has started: it counts instead")),
      h("td", { class: "num" }, amountText(futurePayIn)),
      h("td", { class: "actions" }, editButton("now"))),
    ...changes.map(({ change, index }) => {
      let note = null;
      if (!Number.isFinite(index)) note = "Needs your year of birth";
      else if (index >= retirement) note = "After retirement: nothing is paid in then";
      else if (change === current) note = `Paid in now${change.amount !== null && average ? `; your average: ${money(average.average)}` : ""}`;
      else if (index <= now) note = "A later change counts instead";
      return h("tr", { class: change === editing ? "editing" : null },
        h("td", null, startText(change), sub(note)),
        h("td", { class: "num" }, amountText(change.amount)),
        h("td", { class: "actions" },
          editButton(change.id),
          h("button", { type: "button", class: "link danger", onclick: () => {
            if (!confirm(`Delete the change from ${startText(change)}?`)) return;
            if (state.editingPayIn === change.id) state.editingPayIn = null;
            commit(F.deletePayInChange(store, change.id), `Deleted the change from ${startText(change)}.`);
          } }, "Delete")));
    }),
  ];

  const form = h("form", { class: "payin-form", onsubmit: (event) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const from = editing === "now" ? null : readBound(data, "payin-from", "Starts");
    if (from?.error) return showError(event.currentTarget, from.error);
    const amount = readPayInAmount(data, "payin-amount", "A month");
    if (amount.error) return showError(event.currentTarget, amount.error);
    if (editing === "now") {
      state.editingPayIn = null;
      return commit(F.saveSettings(store, { futurePayIn: amount.amount }), "Saved what you pay in now.");
    }
    const result = F.savePayInChange(store, { id: editing?.id ?? null, from: from.bound, amount: amount.amount });
    if (!result.ok) return showError(event.currentTarget, `${result.error}.`);
    state.editingPayIn = null;
    commit(result.store, `${editing ? "Saved" : "Added"} the change from ${startText({ from: from.bound })}.`);
  } },
    editing === "now"
      ? h("div", { class: "field" }, h("span", { class: "field-label" }, h("span", null, "Starts")), h("div", { class: "field-static" }, "Now"))
      : boundField("payin-from", "Starts", editing?.from ?? { month: "" }, [["month", "In a month"], ["age", "At an age"]]),
    payInAmountField("payin-amount", "A month", editing === "now" ? futurePayIn : editing ? editing.amount : undefined, average),
    h("div", { class: "form-actions" },
      h("button", { type: "submit", class: "primary" }, editing ? "Save" : "Add change"),
      editing ? h("button", { type: "button", onclick: () => { state.editingPayIn = null; render(); } }, "Cancel") : null));

  // Saved on a click, so what is typed elsewhere on the page stays.
  const rise = h("input", { type: "checkbox", id: "payins-rise", checked: payInsRiseWithInflation, onchange: (event) => {
    const on = event.currentTarget.checked;
    state.focus = "#payins-rise";
    keepingDrafts(() => commit(F.saveSettings(state.store, { payInsRiseWithInflation: on }), on ? "Pay-ins now rise with inflation." : "Pay-ins now stay the same."));
  } });

  // What Stop investing (Coast) still pays in after Coast FI: the Forecast shows it.
  const coastForm = h("form", { class: "coast-form", onsubmit: (event) => {
    event.preventDefault();
    const amount = F.parseMoney(new FormData(event.currentTarget).get("coastPayIn"));
    if (!amount.ok) return showError(event.currentTarget, `After Coast FI: ${amount.error}.`);
    if (amount.cents < 0) return showError(event.currentTarget, "After Coast FI: enter an amount of 0 or more.");
    commit(F.saveSettings(state.store, { coastPayIn: amount.cents }), "Saved what is paid in after Coast FI.");
  } },
    field("After Coast FI, per month",
      h("input", { id: "coast-payin", name: "coastPayIn", class: "amount", inputmode: "decimal", autocomplete: "off", required: true, value: inputMoney(coastPayIn) }),
      ["What the ", h("a", { href: "#forecast" }, "Forecast"), "'s Stop investing still pays in a month once Coast FI is reached: 0 stops paying in."],
      "It stays the same amount of money, also when pay-ins rise with inflation."),
    h("button", { type: "submit" }, "Save"));

  return card(["Future pay-ins", info("future pay-ins",
      "What you pay in a month from now on, for the investment rate, the milestones, the Path to FI chart and the forecast.",
      "Now is the average of your pay-ins under Portfolio, or an amount of your own. Add the changes you know of, such as a raise, a sabbatical or part-time: each holds until the next one. Pay-ins stop at retirement, or at FI when you retire then.",
      "A change that has started is what you pay in now, until you delete it.")],
    h("div", { class: "table-wrap" }, h("table", null,
      h("thead", null, h("tr", null, h("th", null, "From"), h("th", { class: "num" }, "A month"), h("th"))),
      h("tbody", null, rows))),
    form,
    h("div", { class: "check-row payins-rise" },
      h("label", { class: "check" }, rise, "Rise with inflation"),
      info("rising pay-ins",
        "Off, every pay-in stays the same amount of money for good, as typed.",
        "On, the amounts are in today's money, like your expenses: the projections raise them by the inflation set under Assumptions, as if you raised your savings plan with prices.")),
    coastForm);
}

// Planned one-offs: an inheritance, a house deposit, a sabbatical. Each
// counts in its month from where the forecast starts on.
function eventsCard(store) {
  const { start } = outlook(store);
  const editing = store.events.find((e) => e.id === state.editingEvent) ?? null;
  const form = h("form", { class: "event-form", onsubmit: (event) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const month = F.parseMonth(data.get("month"));
    if (!month) return showError(event.currentTarget, `Month: enter ${MONTH_HINT}.`);
    const amount = F.parseMoney(data.get("amount"));
    if (!amount.ok) return showError(event.currentTarget, `Amount: ${amount.error}.`);
    const result = F.saveEvent(store, { id: editing?.id ?? null, name: data.get("name"), month, amount: amount.cents });
    if (!result.ok) return showError(event.currentTarget, `${result.error}.`);
    state.editingEvent = null;
    state.focus = "#event-name";
    commit(result.store, `${editing ? "Saved" : "Added"} ${String(data.get("name")).trim()}.`);
  } },
    h("label", null, "Name", h("input", { id: "event-name", name: "name", autocomplete: "off", required: true, value: editing?.name ?? "", placeholder: "Inheritance" })),
    field("Month", monthField({ name: "month", required: true, value: editing?.month ?? "" })),
    h("label", null, "Amount (negative: taken out)", h("input", { name: "amount", class: "amount", inputmode: "decimal", autocomplete: "off", required: true,
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
  return card(["Planned one-offs", info("planned one-offs",
      "Money that comes in or goes out once: an inheritance, a house deposit, a car, a sabbatical (what you live on, and the pay-ins you skip).",
      "Every plan gets it in its month, as do the milestones and the Path to FI chart. Amounts are in today's money and rise with inflation, like expenses.")],
    rows.length ? h("div", { class: "table-wrap" }, h("table", null,
      h("thead", null, h("tr", null, h("th", null, "Month"), h("th", null, "Name"), h("th", { class: "num" }, "Amount"), h("th"))),
      h("tbody", null, rows))) : null,
    form);
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
  const textarea = h("textarea", { id: "import-text", class: "amount", rows: 8, spellcheck: "false", "aria-label": "CSV text",
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
        " (the last three optional; kind is what a new account holds: invested, cash, emergency, property, pension or debt). Dates as 2025-01-31, 2025.01.31 or 31.01.2025: a row counts for the month of its date. ",
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
  return card(["Export portfolio to CSV", info("the export",
      ["Every monthly value with the columns ", h("code", null, "date"), " (the last day of the month), ", h("code", null, "account"), ", ",
        h("code", null, "value"), ", ", h("code", null, "pay_in"), ", ", h("code", null, "one_off"), " and ", h("code", null, "kind"), "."],
      "It opens in a spreadsheet, and the import above reads it back.")],
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

// Opening Finance with the lock on asks for the fingerprint straight away.
async function start() {
  const { ok, json } = await lockCall();
  if (ok) adoptLock(json);
  if (ok && json.locked) {
    state.lock.locked = true;
    render();
    unlock();
  } else {
    load();
  }
}

state.view = viewFromHash();
// A restart waits for saving(), which it asks every 100 ms. The server
// answers by then, so this also tries a failed save again, at most every
// few seconds, so a server that keeps failing is not flooded.
let retried = 0;
function saving() {
  if (pending && !inFlight && Date.now() - retried >= 5000) {
    retried = Date.now();
    pump();
  }
  return inFlight || pending !== null;
}
const updates = startUpdates(document.getElementById("update"), { saving });
start();
