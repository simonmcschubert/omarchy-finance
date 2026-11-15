// Portfolio chart: one inline SVG with the portfolio value, the running total
// of pay-ins, and the FI number as a goal line. Scaled up to the FI number,
// it also projects the value until it gets there. One y-axis in money. A
// crosshair tooltip follows the pointer or the arrow keys.

const SVG = "http://www.w3.org/2000/svg";
const HEIGHT = 280;
const MARGIN = { top: 16, right: 20, bottom: 30, left: 72 };

function svg(tag, attrs = {}) {
  const el = document.createElementNS(SVG, tag);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, String(value));
  return el;
}

function niceStep(rough) {
  const power = 10 ** Math.floor(Math.log10(rough));
  const fraction = rough / power;
  const nice = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 2.5 ? 2.5 : fraction <= 5 ? 5 : 10;
  return nice * power;
}

// Ticks from min to max (both rounded outwards) in 3-6 even steps.
export function niceTicks(min, max) {
  if (max <= min) max = min + 1;
  const step = niceStep((max - min) / 4);
  const ticks = [];
  for (let v = Math.floor(min / step) * step; v < max + step / 2; v += step) ticks.push(Math.round(v));
  if (ticks.at(-1) < max) ticks.push(ticks.at(-1) + step);
  return ticks;
}

// Every n-th month gets a label so that at most 8 fit.
function labelEvery(count) {
  return [1, 3, 6, 12, 24, 60, 120].find((n) => count / n <= 8) ?? 240;
}

// The FI line shows when the scale reaches up to it, or when the data
// already does.
export function goalVisible(series, fiNumber, scale) {
  return fiNumber > 0 && (scale === "goal" || series.some((m) => m.value >= fiNumber || m.paidIn >= fiNumber));
}

// The projection shows only when the chart is scaled up to the FI number,
// and only when it gets there.
export function projectionVisible(projection, scale) {
  return scale === "goal" && Boolean(projection?.length);
}

// options: { series, projection: [{ month, value }] or null, fiNumber,
// scale: "goal" | "data", format, formatAxis, formatMonth, monthNumber }
export function renderChart(root, options) {
  const { series, fiNumber, scale, format, formatAxis, formatMonth, monthNumber } = options;
  root.replaceChildren();
  const width = Math.max(320, Math.round(root.clientWidth || 640));
  const plotW = width - MARGIN.left - MARGIN.right;
  const plotH = HEIGHT - MARGIN.top - MARGIN.bottom;

  // The months after the series, when the projection shows.
  const ahead = projectionVisible(options.projection, scale) ? options.projection : [];
  const points = [...series, ...ahead];
  const values = [...series.flatMap((m) => [m.value, m.paidIn]), ...ahead.map((m) => m.value)];
  const showGoal = goalVisible(series, fiNumber, scale);
  const top = Math.max(...values, showGoal ? fiNumber : 0, 10000);
  const ticks = niceTicks(Math.min(0, ...values), top);
  const yMin = ticks[0];
  const yMax = ticks.at(-1);
  const x = (i) => MARGIN.left + (points.length === 1 ? plotW / 2 : (i * plotW) / (points.length - 1));
  const y = (v) => MARGIN.top + plotH - ((v - yMin) / (yMax - yMin)) * plotH;

  const chart = svg("svg", {
    viewBox: `0 0 ${width} ${HEIGHT}`,
    width,
    height: HEIGHT,
    class: "chart",
    role: "img",
    tabindex: 0,
    "aria-label": `Portfolio value and total paid in, by month${ahead.length ? ", and the projected value until it reaches the FI number" : ""}. Use the arrow keys to read each month.`,
  });

  for (const tick of ticks) {
    chart.append(svg("line", { class: "grid", x1: MARGIN.left, x2: width - MARGIN.right, y1: y(tick), y2: y(tick) }));
    const label = svg("text", { class: "axis", x: MARGIN.left - 8, y: y(tick), "text-anchor": "end", "dominant-baseline": "middle" });
    label.textContent = formatAxis(tick);
    chart.append(label);
  }

  const every = labelEvery(points.length);
  points.forEach((m, i) => {
    if (monthNumber(m.month) % every !== 0 && points.length > 1) return;
    const label = svg("text", { class: "axis", x: x(i), y: HEIGHT - 8, "text-anchor": "middle" });
    label.textContent = formatMonth(m.month, every >= 12);
    chart.append(label);
  });

  if (showGoal) {
    chart.append(svg("line", { class: "goal", x1: MARGIN.left, x2: width - MARGIN.right, y1: y(fiNumber), y2: y(fiNumber) }));
    const label = svg("text", { class: "goal-label", x: width - MARGIN.right, y: y(fiNumber) - 6, "text-anchor": "end" });
    label.textContent = `FI number ${format(fiNumber)}`;
    chart.append(label);
  }

  const path = (key, from = 0, to = series.length) =>
    points.slice(from, to).map((m, i) => `${i === 0 ? "M" : "L"}${x(from + i).toFixed(1)},${y(m[key]).toFixed(1)}`).join(" ");
  const last = series.length - 1;
  // From the latest month, so that it continues the value line.
  if (ahead.length) chart.append(svg("path", { class: "line projection", d: path("value", last, points.length) }));
  chart.append(svg("path", { class: "line paid", d: path("paidIn") }));
  chart.append(svg("path", { class: "line value", d: path("value") }));
  chart.append(svg("circle", { class: "end value", cx: x(last), cy: y(series[last].value), r: 4 }));

  // Hover layer: crosshair, two dots, and an HTML tooltip.
  const cross = svg("line", { class: "cross", y1: MARGIN.top, y2: MARGIN.top + plotH, visibility: "hidden" });
  const dotValue = svg("circle", { class: "dot value", r: 4, visibility: "hidden" });
  const dotPaid = svg("circle", { class: "dot paid", r: 4, visibility: "hidden" });
  const hit = svg("rect", { class: "hit", x: MARGIN.left - 12, y: 0, width: plotW + 24, height: HEIGHT });
  chart.append(cross, dotPaid, dotValue, hit);

  const tip = document.createElement("div");
  tip.className = "tip";
  tip.hidden = true;
  root.append(chart, tip);

  let current = -1;
  function show(i) {
    current = Math.max(0, Math.min(points.length - 1, i));
    const m = points[current];
    const projected = current > last;
    for (const el of [cross, dotValue]) el.setAttribute("visibility", "visible");
    dotPaid.setAttribute("visibility", projected ? "hidden" : "visible");
    cross.setAttribute("x1", x(current));
    cross.setAttribute("x2", x(current));
    dotValue.setAttribute("cx", x(current));
    dotValue.setAttribute("cy", y(m.value));
    if (!projected) {
      dotPaid.setAttribute("cx", x(current));
      dotPaid.setAttribute("cy", y(m.paidIn));
    }

    const rows = projected
      ? [["projection", format(m.value), "Projected value"]]
      : [
          ["value", format(m.value), "Portfolio value"],
          ["paid", format(m.paidIn), "Paid in, total"],
        ];
    const title = document.createElement("div");
    title.className = "tip-title";
    title.textContent = formatMonth(m.month, false);
    tip.replaceChildren(title);
    for (const [kind, amount, name] of rows) {
      const row = document.createElement("div");
      row.className = "tip-row";
      const key = document.createElement("span");
      key.className = `key ${kind}`;
      const strong = document.createElement("strong");
      strong.textContent = amount;
      const label = document.createElement("span");
      label.textContent = name;
      row.append(key, strong, label);
      tip.append(row);
    }
    tip.hidden = false;
    const px = (x(current) / width) * chart.getBoundingClientRect().width;
    const flip = px > root.clientWidth / 2;
    tip.style.left = flip ? "" : `${px + 12}px`;
    tip.style.right = flip ? `${root.clientWidth - px + 12}px` : "";
  }
  function hide() {
    for (const el of [cross, dotValue, dotPaid]) el.setAttribute("visibility", "hidden");
    tip.hidden = true;
    current = -1;
  }
  function nearest(event) {
    const box = chart.getBoundingClientRect();
    const px = ((event.clientX - box.left) / box.width) * width;
    return points.length === 1 ? 0 : Math.round(((px - MARGIN.left) / plotW) * (points.length - 1));
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
