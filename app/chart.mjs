// Portfolio chart: one inline SVG with one y-axis in money, in two views.
//
// History: the portfolio value and what went in (finance.mjs
// portfolioSeries, `invested`), with the gap between them shaded green for a
// gain and red for a loss. The FI number shows once the data reaches it.
// Path to FI: the portfolio value, then the projection to the FI number
// (finance.mjs fiProjection): a dashed line at the expected return, a band
// from the low to the high return, and a dot where the line reaches the FI
// number.
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
// - projection: fiProjection, for the path view
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
  const values = path ? series.map((m) => m.value) : series.flatMap((m) => [m.value, m.invested]);
  const top = Math.max(...values, showGoal ? fiNumber * (path ? GOAL_HEADROOM : 1) : 0, 10000);
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
    // The projection starts at the latest value and is cut off at the top.
    const inPlot = clip(svg("rect", { x: MARGIN.left, y: plotTop, width: plotW, height: plotH }));
    const at = (key) => [[x(last), y(latest.value)], ...projection.map((p, k) => [x(last + 1 + k), y(p[key])])];
    if (projection.length) {
      chart.append(svg("path", { class: "band", d: areaPath(at("high"), at("low")), "clip-path": inPlot }));
      chart.append(svg("path", { class: "line projection", d: linePath(at("mid")), "clip-path": inPlot }));
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
  // Its label goes on the left, above the line, where the portfolio is
  // still far below it; on the right when the reach label is on the left;
  // below the line when the two would run into each other.
  if (showGoal) {
    chart.append(svg("line", { class: "goal", x1: MARGIN.left, x2: width - MARGIN.right, y1: y(fiNumber), y2: y(fiNumber) }));
    const goalText = `FI number ${format(fiNumber)}`;
    const reachIndex = path && options.projection.reach.mid ? months.indexOf(options.projection.reach.mid) : -1;
    let side = "left";
    if (reachIndex > last) {
      const rx = x(reachIndex);
      const reachText = `FI ≈ ${formatMonth(months[reachIndex], true)}`;
      const right = rx > MARGIN.left + plotW / 2;
      chart.append(svg("circle", { class: "reach", cx: rx, cy: y(fiNumber), r: 4 }));
      chart.append(text({ class: "reach-label", x: right ? rx - 8 : rx + 8, y: y(fiNumber) - 7, "text-anchor": right ? "end" : "start" }, reachText));
      const reachWidth = reachText.length * CHAR_WIDTH;
      const free = right ? rx - 8 - reachWidth - MARGIN.left : width - MARGIN.right - (rx + 8 + reachWidth);
      side = free < goalText.length * CHAR_WIDTH + 16 ? "below" : right ? "left" : "right";
    }
    chart.append(text({
      class: "goal-label",
      x: side === "right" ? width - MARGIN.right : MARGIN.left + 4,
      y: side === "below" ? y(fiNumber) + 15 : y(fiNumber) - 7,
      "text-anchor": side === "right" ? "end" : "start",
    }, goalText));
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
          [null, formatPercent(p.mid / fiNumber), "of the FI number"],
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
