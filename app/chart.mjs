// Portfolio chart: one inline SVG with one y-axis in money, in two views.
//
// History: the portfolio value and what went in (finance.mjs
// portfolioSeries, `invested`), with the gap between them shaded green for a
// gain and red for a loss. The FI number shows once the data reaches it.
// Path to FI: the portfolio value, then the projection to the FI number
// (finance.mjs fiOutlook().path): a dashed line at the expected return, a band
// from the low to the high return, both ending at the FI number, and a dot
// where the line reaches it. The FI number is today's over the history, and
// rises with inflation over the projection.
//
// A crosshair tooltip follows the pointer or the arrow keys.

const SVG = "http://www.w3.org/2000/svg";
const HEIGHT = 280;
const MARGIN = { top: 20, right: 20, bottom: 30, left: 72 };
// Labels use the app's monospace font at 11px: about this wide per character.
const CHAR_WIDTH = 6.7;
// Headroom above the FI number on the path view, for its labels.
const GOAL_HEADROOM = 1.08;

let ids = 0; // clip path ids, unique on the page

function svg(tag, attrs = {}) {
  const el = document.createElementNS(SVG, tag);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, String(value));
  return el;
}

function text(attrs, content) {
  const el = svg("text", attrs);
  el.textContent = content;
  return el;
}

function niceStep(rough) {
  const power = 10 ** Math.floor(Math.log10(rough));
  const fraction = rough / power;
  const nice = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 2.5 ? 2.5 : fraction <= 5 ? 5 : 10;
  return nice * power;
}

// Ticks from min to max, both rounded outwards to a nice step, in about 3 to
// 7 steps: the step whose top tick is closest above max, and of those the one
// with the fewest ticks. So a goal of 677,000 gets 0 to 700,000, not 800,000.
export function niceTicks(min, max) {
  if (max <= min) max = min + 1;
  let best = null;
  for (let n = 3; n <= 7; n++) {
    const step = niceStep((max - min) / n);
    const ticks = [];
    for (let v = Math.floor(min / step) * step; v < max + step / 2; v += step) ticks.push(Math.round(v));
    if (ticks.at(-1) < max) ticks.push(Math.round(ticks.at(-1) + step));
    if (!best || ticks.at(-1) < best.at(-1) || (ticks.at(-1) === best.at(-1) && ticks.length < best.length)) best = ticks;
  }
  return best;
}

// Every n-th month gets a label so that at most 8 fit.
function labelEvery(count) {
  return [1, 3, 6, 12, 24, 60, 120].find((n) => count / n <= 8) ?? 240;
}

// The history view shows the FI number once the data reaches it.
export function goalVisible(series, fiNumber) {
  return fiNumber > 0 && series.some((m) => m.value >= fiNumber || m.invested >= fiNumber);
}

const linePath = (points) => points.map(([px, py], i) => `${i === 0 ? "M" : "L"}${px.toFixed(1)},${py.toFixed(1)}`).join(" ");
// The area between two lines over the same x positions.
const areaPath = (upper, lower) => `${linePath(upper)} ${linePath([...lower].reverse()).replace(/^M/, "L")} Z`;

// options:
// - view: "history" | "path"
// - series: portfolioSeries
// - fiNumber: 0 for none
// - projection: fiOutlook().path, for the path view
// - format(cents), formatSigned(cents), formatPercent(fraction),
//   formatSignedPercent(fraction), formatRate(percent), formatAxis(cents),
//   formatMonth(month, yearOnly), monthNumber(month)
export function renderChart(root, options) {
  const { series, fiNumber, format, formatSigned, formatPercent, formatSignedPercent, formatRate, formatAxis, formatMonth, monthNumber } = options;
  const path = options.view === "path" && fiNumber > 0 && options.projection;
  const projection = path ? options.projection.points : [];
  const rates = path ? options.projection.rates : null;
  root.replaceChildren();

  const width = Math.max(320, Math.round(root.clientWidth || 640));
  const plotW = width - MARGIN.left - MARGIN.right;
  const plotH = HEIGHT - MARGIN.top - MARGIN.bottom;
  const plotTop = MARGIN.top;
  const plotBottom = MARGIN.top + plotH;

  // One entry per x position: the history, then the projected months.
  const months = [...series.map((m) => m.month), ...projection.map((p) => p.month)];
  const count = months.length;
  const last = series.length - 1; // the latest month, where a projection starts
  const latest = series[last];

  const showGoal = path ? true : goalVisible(series, fiNumber);
  // The FI number at x position i.
  const goalAt = (i) => (i > last ? projection[i - last - 1].goal : fiNumber);
  const values = path ? series.map((m) => m.value) : series.flatMap((m) => [m.value, m.invested]);
  // The FI number can fall over the projection (a pension coming closer),
  // so the highest one sets the top.
  const highestGoal = path ? Math.max(fiNumber, ...projection.map((p) => p.goal)) * GOAL_HEADROOM : fiNumber;
  const top = Math.max(...values, showGoal ? highestGoal : 0, 10000);
  const ticks = niceTicks(Math.min(0, ...values), top);
  const yMin = ticks[0];
  const yMax = ticks.at(-1);
  const x = (i) => MARGIN.left + (count === 1 ? plotW / 2 : (i * plotW) / (count - 1));
  const y = (v) => plotTop + plotH - ((v - yMin) / (yMax - yMin)) * plotH;

  const chart = svg("svg", {
    viewBox: `0 0 ${width} ${HEIGHT}`,
    width,
    height: HEIGHT,
    class: "chart",
    role: "img",
    tabindex: 0,
    "aria-label": path
      ? "Portfolio value by month, and its projection until it reaches the FI number. Use the arrow keys to read each month."
      : "Portfolio value and what was paid in, by month. Use the arrow keys to read each month.",
  });
  const defs = svg("defs");
  chart.append(defs);
  // A clip path of one shape; returns the clip-path value.
  const clip = (shape) => {
    const id = `chart-clip-${++ids}`;
    const el = svg("clipPath", { id });
    el.append(shape);
    defs.append(el);
    return `url(#${id})`;
  };

  for (const tick of ticks) {
    chart.append(svg("line", { class: "grid", x1: MARGIN.left, x2: width - MARGIN.right, y1: y(tick), y2: y(tick) }));
    chart.append(text({ class: "axis", x: MARGIN.left - 8, y: y(tick), "text-anchor": "end", "dominant-baseline": "middle" }, formatAxis(tick)));
  }

  const every = labelEvery(count);
  months.forEach((month, i) => {
    if (monthNumber(month) % every !== 0 && count > 1) return;
    chart.append(text({ class: "axis", x: x(i), y: HEIGHT - 8, "text-anchor": "middle" }, formatMonth(month, every >= 12)));
  });

  const valuePoints = series.map((m, i) => [x(i), y(m.value)]);
  if (path) {
    // The projection starts at the latest value and ends at the FI number:
    // what goes beyond it is cut off.
    const at = (key) => [[x(last), y(latest.value)], ...projection.map((p, k) => [x(last + 1 + k), y(p[key])])];
    if (projection.length) {
      const goalLine = [[x(last), y(fiNumber)], ...projection.map((p, k) => [x(last + 1 + k), y(p.goal)])];
      const belowGoal = clip(svg("path", { d: `${linePath(goalLine)} L${x(count - 1).toFixed(1)},${plotBottom} L${x(last).toFixed(1)},${plotBottom} Z` }));
      chart.append(svg("path", { class: "band", d: areaPath(at("high"), at("low")), "clip-path": belowGoal }));
      chart.append(svg("path", { class: "line projection", d: linePath(at("mid")), "clip-path": belowGoal }));
    }
  } else {
    // The gap between the lines: green where the value is above what went
    // in, red where below. One area, clipped to either side of the paid-in line.
    const investedPoints = series.map((m, i) => [x(i), y(m.invested)]);
    if (series.length > 1) {
      const gap = areaPath(valuePoints, investedPoints);
      const ends = (edge) => ` L${x(last).toFixed(1)},${edge} L${x(0).toFixed(1)},${edge} Z`;
      chart.append(svg("path", { class: "area gain", d: gap, "clip-path": clip(svg("path", { d: linePath(investedPoints) + ends(0) })) }));
      chart.append(svg("path", { class: "area loss", d: gap, "clip-path": clip(svg("path", { d: linePath(investedPoints) + ends(HEIGHT) })) }));
    }
    chart.append(svg("path", { class: "line paid", d: linePath(investedPoints) }));
  }
  chart.append(svg("path", { class: "line value", d: linePath(valuePoints) }));

  // The FI number, and on the path view where the projection reaches it.
  // Its label goes on the left, above the line, where it is today's FI
  // number and the portfolio is still far below it; below the line when
  // the reach label would run into it.
  if (showGoal) {
    if (path) {
      const goalPoints = [[x(0), y(fiNumber)], [x(last), y(fiNumber)], ...projection.map((p, k) => [x(last + 1 + k), y(p.goal)])];
      chart.append(svg("path", { class: "goal", d: linePath(goalPoints) }));
    } else {
      chart.append(svg("line", { class: "goal", x1: MARGIN.left, x2: width - MARGIN.right, y1: y(fiNumber), y2: y(fiNumber) }));
    }
    const goalText = `FI number ${format(fiNumber)}`;
    const goalWidth = goalText.length * CHAR_WIDTH;
    const reachIndex = path && options.projection.reach.mid ? months.indexOf(options.projection.reach.mid) : -1;
    let below = false;
    if (reachIndex > last) {
      const rx = x(reachIndex);
      const ry = y(goalAt(reachIndex));
      const reachText = `FI ≈ ${formatMonth(months[reachIndex], true)}`;
      const reachWidth = reachText.length * CHAR_WIDTH;
      const right = rx > MARGIN.left + plotW / 2;
      chart.append(svg("circle", { class: "reach", cx: rx, cy: ry, r: 4 }));
      chart.append(text({ class: "reach-label", x: right ? rx - 8 : rx + 8, y: ry - 7, "text-anchor": right ? "end" : "start" }, reachText));
      const from = right ? rx - 8 - reachWidth : rx - 8;
      const to = right ? rx + 8 : rx + 8 + reachWidth;
      below = from < MARGIN.left + 4 + goalWidth + 8 && to > MARGIN.left && Math.abs(ry - y(fiNumber)) < 16;
    }
    // Above the line all along the label, as the line rises after the history.
    let above = y(fiNumber);
    for (let i = 0; i < count && x(i) <= MARGIN.left + 4 + goalWidth; i++) above = Math.min(above, y(goalAt(i)));
    chart.append(text({ class: "goal-label", x: MARGIN.left + 4, y: below ? y(fiNumber) + 15 : above - 7 }, goalText));
  }

  // The latest value, at the end of its line: above it, or below when the
  // paid-in line runs above it.
  const ex = x(last);
  const ey = y(latest.value);
  chart.append(svg("circle", { class: "end value", cx: ex, cy: ey, r: 4 }));
  chart.append(text({
    class: "end-label",
    x: ex,
    y: !path && latest.invested > latest.value ? ey + 18 : ey - 10,
    "text-anchor": ex > MARGIN.left + plotW / 2 ? "end" : "start",
  }, format(latest.value)));

  // ---- hover layer: crosshair, dots, and an HTML tooltip

  const cross = svg("line", { class: "cross", y1: plotTop, y2: plotBottom, visibility: "hidden" });
  const dots = svg("g");
  const hit = svg("rect", { class: "hit", x: MARGIN.left - 12, y: 0, width: plotW + 24, height: HEIGHT });
  chart.append(cross, dots, hit);

  const tip = document.createElement("div");
  tip.className = "tip";
  tip.hidden = true;
  root.append(chart, tip);

  // What one x position shows: dots as [class, value], and tooltip rows as
  // [key class or null, amount, label], plus a note line.
  function describe(i) {
    if (i > last) {
      const p = projection[i - last - 1];
      return {
        title: `${formatMonth(p.month, false)}, projected`,
        dots: [["projection", p.mid]],
        rows: [
          ["projection", format(p.mid), `at ${formatRate(rates.mid)}`],
          ["band", `${format(p.low)} – ${format(p.high)}`, `at ${formatRate(rates.low)} to ${formatRate(rates.high)}`],
          ["goal", format(p.goal), "FI number"],
          [null, formatPercent(p.mid / p.goal), "of the FI number"],
        ],
      };
    }
    const m = series[i];
    if (path) {
      return {
        title: formatMonth(m.month, false),
        dots: [["value", m.value]],
        rows: [["value", format(m.value), "Portfolio value"], [null, formatPercent(m.value / fiNumber), "of the FI number"]],
      };
    }
    const gain = m.value - m.invested;
    const rows = [
      ["value", format(m.value), "Portfolio value"],
      ["paid", format(m.invested), "Paid in"],
      [gain < 0 ? "loss" : "gain", m.invested > 0 ? `${formatSigned(gain)} · ${formatSignedPercent(gain / m.invested)}` : formatSigned(gain), gain < 0 ? "Loss" : "Gain"],
    ];
    let note = null;
    if (i > 0) {
      const before = series[i - 1];
      const paid = m.invested - before.invested;
      rows.push([null, formatSigned(m.value - before.value), "this month"]);
      note = `${format(paid)} paid in, ${formatSigned(m.value - before.value - paid)} market`;
    }
    return { title: formatMonth(m.month, false), dots: [["paid", m.invested], ["value", m.value]], rows, note };
  }

  // The values drawn at x position i, for keeping the tooltip off the lines.
  const drawn = (i) => (i > last ? [projection[i - last - 1].mid] : path ? [series[i].value] : [series[i].value, series[i].invested]);

  let current = -1;
  function show(i) {
    current = Math.max(0, Math.min(count - 1, i));
    const info = describe(current);
    cross.setAttribute("visibility", "visible");
    cross.setAttribute("x1", x(current));
    cross.setAttribute("x2", x(current));
    dots.replaceChildren(...info.dots.map(([kind, v]) => svg("circle", { class: `dot ${kind}`, cx: x(current), cy: Math.max(plotTop, y(v)), r: 4 })));

    const title = document.createElement("div");
    title.className = "tip-title";
    title.textContent = info.title;
    tip.replaceChildren(title);
    for (const [kind, amount, name] of info.rows) {
      const row = document.createElement("div");
      row.className = "tip-row";
      const key = document.createElement("span");
      key.className = kind ? `key ${kind}` : "";
      const strong = document.createElement("strong");
      strong.textContent = amount;
      const label = document.createElement("span");
      label.textContent = name;
      row.append(key, strong, label);
      tip.append(row);
    }
    if (info.note) {
      const note = document.createElement("div");
      note.className = "tip-note";
      note.textContent = info.note;
      tip.append(note);
    }
    tip.hidden = false;

    // Beside the crosshair, on the side with more room, and inside the chart
    // (over the crosshair when the chart is too narrow); at the top unless
    // less of the lines runs through the bottom.
    tip.style.left = "0px";
    const scale = chart.getBoundingClientRect().width / width;
    const px = x(current) * scale;
    const left = Math.max(0, Math.min(px > root.clientWidth / 2 ? px - 12 - tip.offsetWidth : px + 12, root.clientWidth - tip.offsetWidth));
    tip.style.left = `${left}px`;
    const tipW = tip.offsetWidth / scale;
    const tipH = tip.offsetHeight / scale;
    const from = left / scale;
    const covered = [];
    for (let j = 0; j < count; j++) {
      if (x(j) >= from && x(j) <= from + tipW) covered.push(...drawn(j).map(y));
    }
    const hits = (y1, y2) => covered.filter((v) => v >= y1 && v <= y2).length;
    const topY = 8;
    const bottomY = plotBottom - 4 - tipH;
    const below = hits(bottomY, bottomY + tipH) < hits(topY, topY + tipH);
    tip.style.top = `${(below ? bottomY : topY) * scale}px`;
  }
  function hide() {
    cross.setAttribute("visibility", "hidden");
    dots.replaceChildren();
    tip.hidden = true;
    current = -1;
  }
  function nearest(event) {
    const box = chart.getBoundingClientRect();
    const px = ((event.clientX - box.left) / box.width) * width;
    return count === 1 ? 0 : Math.round(((px - MARGIN.left) / plotW) * (count - 1));
  }

  hit.addEventListener("pointermove", (event) => show(nearest(event)));
  hit.addEventListener("pointerleave", hide);
  chart.addEventListener("focus", () => show(last));
  chart.addEventListener("blur", hide);
  chart.addEventListener("keydown", (event) => {
    const step = { ArrowLeft: -1, ArrowRight: 1, Home: -Infinity, End: Infinity }[event.key];
    if (step === undefined) return;
    event.preventDefault();
    show(current === -1 ? last : current + step);
  });
}

// ---------------------------------------------------------------- forecast
// The picked plan as a bar, and its chart under it on the same age line
// (finance.mjs fiOutlook().plans).

const PLAN_ROW = 70; // the bar's row: values above it, causes below
const PLAN_BAR = 28;
const PLAN_CHART = 280;
const PLAN_MARGIN = { right: 20, top: 16, bottom: 40 };
// Bar texts use 12px: about this wide per character.
const BAR_CHAR = 7.3;

// The y-axis's top: the highest value, but never more than twice the
// highest before the last phase, so that growth late in life doesn't
// squeeze the years that decide. Lines above it leave the chart; the
// tooltip still shows them.
export function forecastTop(values, lastFrom) {
  let all = 0;
  let before = 0;
  values.forEach((v, i) => {
    if (v > all) all = v;
    if (i <= lastFrom && v > before) before = v;
  });
  return Math.max(Math.min(all, 2 * before) * 1.1, 10000);
}

// The month indexes to label on an age axis: January of every n-th age,
// n the first of 1, 2, 5, 10, 20 for which the labels get `room` pixels
// each.
export function ageTicks(months, ageOf, width, room = 34) {
  const years = months.length / 12;
  const every = [1, 2, 5, 10, 20].find((n) => (years / n) * room <= width) ?? 50;
  const ticks = [];
  months.forEach((month, i) => { if (month.endsWith("-01") && ageOf(month) % every === 0) ticks.push(i); });
  return ticks;
}

// The first text that fits in `width` pixels, or "".
export function fitText(texts, width, charWidth = BAR_CHAR) {
  return texts.find((t) => t && t.length * charWidth + 14 <= width) ?? "";
}

// A status icon: lasts (a check), runs out at the low growth (a warning
// triangle) or at the expected one (a cross).
function statusIcon(level, cx, cy) {
  const g = svg("g", { class: `status-icon ${level}`, "aria-hidden": "true" });
  if (level === "risk") {
    g.append(svg("path", { class: "shape", d: `M${cx} ${cy - 7.5}l7.5 13.5h-15z` }));
    g.append(svg("path", { class: "sign", d: `M${cx} ${cy - 2.5}v4.2M${cx} ${cy + 3.6}v.4` }));
  } else {
    g.append(svg("circle", { class: "shape", cx, cy, r: 7.5 }));
    g.append(svg("path", { class: "sign", d: level === "ok" ? `M${cx - 3.4} ${cy + 0.2}l2.3 2.4l4.6-5` : `M${cx - 3} ${cy - 3}l6 6M${cx + 3} ${cy - 3}l-6 6` }));
  }
  return g;
}

// The status icon on its own, 16 pixels square, for HTML.
export function statusBadge(level) {
  const icon = svg("svg", { class: "status-badge", width: 16, height: 16, viewBox: "0 0 16 16", "aria-hidden": "true" });
  icon.append(statusIcon(level, 8, 8.5));
  return icon;
}

// options:
// - months: the shown months; ageOf(month)
// - row: the plan's bar, { name, title (whether it lasts, in words),
//   segments: [{ kind ("invest", "coast" or "retired"), from, to (indexes;
//   to excluded), texts (the amount a month, longest first), share
//   (retired: the portfolio's part, 0 to 1), end (the value at its end, or
//   null), step (it splits a phase), cause: { text, income } or null }],
//   out: { from, text } or null }
// - chart: { values: { low, mid, high }, rates: { low, high } (labels),
//   phases: [{ kind, from, to }], marks: [indexes], steps: [indexes],
//   outs: [indexes] }
// - format(cents), formatShort(cents), formatAxis(cents), formatMonth(month)
export function renderForecast(root, options) {
  const { months, row, chart: plot, ageOf, format, formatShort, formatAxis, formatMonth } = options;
  root.replaceChildren();
  const width = Math.max(320, Math.round(root.clientWidth || 640));
  const left = width >= 720 ? 84 : 72; // the money axis
  const plotW = width - left - PLAN_MARGIN.right;
  const last = months.length - 1;
  const x = (i) => left + (last === 0 ? plotW / 2 : (Math.min(i, last) * plotW) / last);
  const ticks = ageTicks(months, ageOf, plotW);
  const id = ++ids;

  // ---- the bar
  const bars = svg("svg", { width, class: "chart plan-bars", role: "img", "aria-label": `${row.name}: ${row.title}` });
  const defs = svg("defs");
  const hatch = svg("pattern", { id: `coast-${id}`, width: 7, height: 7, patternUnits: "userSpaceOnUse", patternTransform: "rotate(45)" });
  hatch.append(svg("rect", { class: "hatch-bg", width: 7, height: 7 }), svg("line", { class: "hatch-line", x1: 0, y1: 0, x2: 0, y2: 7 }));
  const red = svg("pattern", { id: `out-${id}`, width: 6, height: 6, patternUnits: "userSpaceOnUse", patternTransform: "rotate(-45)" });
  red.append(svg("rect", { class: "out-bg", width: 6, height: 6 }), svg("line", { class: "out-line", x1: 0, y1: 0, x2: 0, y2: 6 }));
  defs.append(hatch, red);
  bars.append(defs);

  const labels = []; // texts under the bar
  const by = 20;
  const g = svg("g");
  let valueLeft = Infinity; // values above the bar, from the right, clear of each other
  const ends = [];
  for (const seg of row.segments) {
    const x0 = x(seg.from);
    const x1 = x(seg.to);
    const w = Math.max(2, x1 - x0 - 2);
    if (seg.kind === "retired") {
      const own = PLAN_BAR * seg.share;
      if (seg.share < 0.999) g.append(svg("rect", { class: "plan-bar other", x: x0 + 1, y: by, width: w, height: PLAN_BAR - own }));
      g.append(svg("rect", { class: "plan-bar retired", x: x0 + 1, y: by + PLAN_BAR - own, width: w, height: own }));
    } else {
      g.append(svg("rect", { class: `plan-bar ${seg.kind}`, x: x0 + 1, y: by, width: w, height: PLAN_BAR, rx: 3, ...(seg.kind === "coast" ? { fill: `url(#coast-${id})` } : {}) }));
    }
    if (seg.step) g.append(svg("line", { class: "notch", x1: x0, x2: x0, y1: by - 3, y2: by + PLAN_BAR + 3 }));
    const t = fitText(seg.texts, x1 - x0);
    if (t) g.append(text({ class: `plan-bar-text ${seg.kind}`, x: x0 + 8, y: by + PLAN_BAR / 2 + 4.5 }, t));
    if (seg.end !== null) ends.push([x1, seg.end]);
    if (seg.cause) labels.push({ x: x0 + 4, y: by + PLAN_BAR + 14, text: seg.cause.text, class: seg.cause.income ? "plan-cause income" : "plan-cause" });
  }
  for (const [x1, value] of ends.reverse()) {
    const label = formatShort(value);
    const right = Math.min(x1 - 4, width - 4);
    if (right > valueLeft - 8) continue;
    g.append(text({ class: "plan-value", x: right, y: by - 6, "text-anchor": "end" }, label));
    valueLeft = right - label.length * CHAR_WIDTH;
  }
  if (row.out) {
    // Only the portfolio's part runs out: other income goes on.
    for (const seg of row.segments) {
      if (seg.kind !== "retired" || seg.to <= row.out.from) continue;
      const x0 = x(Math.max(seg.from, row.out.from));
      const own = PLAN_BAR * seg.share;
      g.append(svg("rect", { class: "plan-bar out", x: x0, y: by + PLAN_BAR - own, width: Math.max(2, x(seg.to) - x0 - 1), height: own, fill: `url(#out-${id})` }));
    }
    // Where it runs out, under the bar: clear of the causes there, else
    // at the right end, else a line lower.
    const ox = x(row.out.from);
    const line = by + PLAN_BAR + 14;
    const span = (l) => {
      const w = l.text.length * CHAR_WIDTH;
      return l.anchor === "end" ? [l.x - w, l.x] : [l.x, l.x + w];
    };
    const clear = (l) => labels.every((o) => o.y !== l.y || span(o)[1] + 8 <= span(l)[0] || span(l)[1] + 8 <= span(o)[0]);
    const fits = ox + row.out.text.length * CHAR_WIDTH <= width - 4;
    const at = (y) => (fits ? { x: ox, y } : { x: width - 4, y, anchor: "end" });
    const places = [at(line), { x: width - 4, y: line, anchor: "end" }, at(line + 14)].map((l) => ({ ...l, text: row.out.text, class: "plan-out-label" }));
    labels.push(places.find(clear) ?? places.at(-1));
  }
  bars.append(g);
  for (const l of labels) bars.append(text({ class: l.class, x: l.x, y: l.y, ...(l.anchor ? { "text-anchor": l.anchor } : {}) }, l.text));
  const barsH = Math.max(PLAN_ROW, ...labels.map((l) => l.y + 6));
  bars.setAttribute("viewBox", `0 0 ${width} ${barsH}`);
  bars.setAttribute("height", barsH);

  // ---- its chart
  const box = document.createElement("div");
  box.className = "chart-box";
  root.append(bars, box);
  const height = PLAN_CHART;
  const plotTop = PLAN_MARGIN.top;
  const plotH = height - plotTop - PLAN_MARGIN.bottom;
  const { low, mid, high } = plot.values;
  const lastPhase = plot.phases.at(-1);
  const axisTicks = niceTicks(0, forecastTop(mid, lastPhase ? lastPhase.from : last));
  const yMax = axisTicks.at(-1);
  const y = (v) => plotTop + plotH - (Math.min(v, yMax * 1.5) / yMax) * plotH;
  const chart = svg("svg", {
    viewBox: `0 0 ${width} ${height}`, width, height, class: "chart plan-chart", role: "img", tabindex: 0,
    "aria-label": "The plan's portfolio by year, at the expected return with a band for less and more growth. Use the arrow keys to read each year.",
  });
  const clip = svg("clipPath", { id: `plan-clip-${id}` });
  clip.append(svg("rect", { x: left, y: plotTop - 2, width: plotW, height: plotH + 4 }));
  const chartDefs = svg("defs");
  chartDefs.append(clip);
  chart.append(chartDefs);
  for (const phase of plot.phases) {
    chart.append(svg("rect", { class: `phase ${phase.kind}`, x: x(phase.from), y: plotTop, width: Math.max(0, x(phase.to) - x(phase.from)), height: plotH }));
    if (phase.from > 0) chart.append(svg("line", { class: "phase-edge", x1: x(phase.from), x2: x(phase.from), y1: plotTop, y2: plotTop + plotH }));
  }
  for (const tick of axisTicks) {
    chart.append(svg("line", { class: "grid", x1: left, x2: width - PLAN_MARGIN.right, y1: y(tick), y2: y(tick) }));
    chart.append(text({ class: "axis", x: left - 8, y: y(tick), "text-anchor": "end", "dominant-baseline": "middle" }, formatAxis(tick)));
  }
  for (const i of ticks) {
    chart.append(text({ class: "axis strong", x: x(i), y: height - 22, "text-anchor": "middle" }, `${ageOf(months[i])}`));
    chart.append(text({ class: "axis", x: x(i), y: height - 8, "text-anchor": "middle" }, months[i].slice(0, 4)));
  }
  chart.append(text({ class: "axis", x: left - 8, y: height - 22, "text-anchor": "end" }, "Age"));
  const inPlot = `url(#plan-clip-${id})`;
  const points = (values) => values.map((v, i) => [x(i), y(v)]);
  chart.append(svg("path", { class: "band", d: areaPath(points(high), points(low)), "clip-path": inPlot }));
  chart.append(svg("path", { class: "band-edge", d: linePath(points(low)), "clip-path": inPlot }));
  for (const phase of plot.phases) {
    const from = Math.max(0, phase.from - 1);
    chart.append(svg("path", { class: `line ${phase.kind}`, d: linePath(points(mid.slice(from, phase.to + 1)).map(([, py], k) => [x(from + k), py])), "clip-path": inPlot }));
  }
  // The band's edges, named where they part.
  const first = plot.phases[0];
  const at = Math.max(12, Math.round((first && plot.phases.length > 1 ? first.to : last) * 0.8));
  if (at < last && high[at] - low[at] > yMax * 0.08) {
    chart.append(text({ class: "band-label", x: x(at), y: Math.max(plotTop + 10, y(high[at]) - 6), "text-anchor": "middle" }, plot.rates.high));
    chart.append(text({ class: "band-label", x: x(at), y: Math.min(plotTop + plotH - 4, y(low[at]) + 15), "text-anchor": "middle" }, plot.rates.low));
  }
  for (const i of plot.steps) chart.append(svg("line", { class: "step-line", x1: x(i), x2: x(i), y1: plotTop, y2: plotTop + plotH }));
  for (const i of plot.marks) {
    if (mid[i] > yMax) continue;
    const kind = plot.steps.includes(i + 1) ? "step" : plot.phases.find((p) => i >= p.from && i < p.to)?.kind ?? "retired";
    chart.append(svg("circle", { class: `mark ${kind}`, cx: x(i), cy: y(mid[i]), r: 4.5 }));
  }
  for (const i of plot.outs) chart.append(svg("circle", { class: "mark out", cx: x(i), cy: y(0), r: 5 }));

  // Hover: a crosshair, a dot on each line, a year at a time.
  const cross = svg("line", { class: "cross", y1: plotTop, y2: plotTop + plotH, visibility: "hidden" });
  const lines = [["high", high, plot.rates.high], ["mid", mid, plot.rates.mid], ["low", low, plot.rates.low]];
  const dots = lines.map(([kind]) => svg("circle", { class: `dot ${kind}`, r: 4, visibility: "hidden" }));
  const hit = svg("rect", { class: "hit", x: left - 12, y: 0, width: plotW + 24, height });
  chart.append(cross, ...dots, hit);
  const tip = document.createElement("div");
  tip.className = "tip";
  tip.hidden = true;
  box.append(chart, tip);

  let current = -1;
  function show(i) {
    current = Math.max(0, Math.min(last, i));
    for (const el of [cross, ...dots]) el.setAttribute("visibility", "visible");
    cross.setAttribute("x1", x(current));
    cross.setAttribute("x2", x(current));
    lines.forEach(([, values], n) => {
      dots[n].setAttribute("cx", x(current));
      dots[n].setAttribute("cy", y(Math.min(values[current], yMax)));
    });
    const title = document.createElement("div");
    title.className = "tip-title";
    title.textContent = `${formatMonth(months[current])} · age ${ageOf(months[current])}`;
    tip.replaceChildren(title);
    for (const [kind, values, rate] of lines) {
      const row = document.createElement("div");
      row.className = "tip-row";
      const key = document.createElement("span");
      key.className = `key growth-${kind}`;
      const strong = document.createElement("strong");
      strong.textContent = format(values[current]);
      const label = document.createElement("span");
      label.textContent = rate;
      row.append(key, strong, label);
      tip.append(row);
    }
    tip.hidden = false;
    const px = (x(current) / width) * chart.getBoundingClientRect().width;
    const flip = px > box.clientWidth / 2;
    tip.style.left = flip ? "" : `${px + 12}px`;
    tip.style.right = flip ? `${box.clientWidth - px + 12}px` : "";
  }
  function hide() {
    for (const el of [cross, ...dots]) el.setAttribute("visibility", "hidden");
    tip.hidden = true;
    current = -1;
  }
  const snap = (i) => Math.min(last, Math.round(i / 12) * 12);
  hit.addEventListener("pointermove", (event) => {
    const rect = chart.getBoundingClientRect();
    const px = ((event.clientX - rect.left) / rect.width) * width;
    show(last === 0 ? 0 : snap(((px - left) / plotW) * last));
  });
  hit.addEventListener("pointerleave", hide);
  chart.addEventListener("focus", () => show(0));
  chart.addEventListener("blur", hide);
  chart.addEventListener("keydown", (event) => {
    const step = { ArrowLeft: -12, ArrowRight: 12, Home: -Infinity, End: Infinity }[event.key];
    if (step === undefined) return;
    event.preventDefault();
    show(current === -1 ? 0 : snap(current + step));
  });
}
