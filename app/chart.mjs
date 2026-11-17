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

const FORECAST_HEIGHT = 300;
// Room above the plot for the retirement marker's label.
const FORECAST_MARGIN = { top: 28, right: 20, bottom: 44, left: 72 };

// The y-axis reaches up to the highest value until retirement (and at least
// a bit above the FI number then). Lines that grow beyond it after
// retirement leave the top of the chart; the tooltip still shows their
// values. goal: the FI number of each month.
export function forecastTop(lines, goal, retirementIndex) {
  const until = retirementIndex >= 0 ? retirementIndex : Infinity;
  let top = 0;
  goal.forEach((v, i) => { if (i <= until && v * 1.2 > top) top = v * 1.2; });
  for (const line of lines) line.values.forEach((v, i) => { if (i <= until && v > top) top = v; });
  return Math.max(top, 10000);
}

// Where a label of `width` goes next to a dot at (cx, cy): above left, above
// right, below right or below left, whichever first stays inside `bounds`
// and clear of the boxes in `taken`; when none does, the same moved sideways
// into `bounds`. Returns { x, y, box }, x and y for a label anchored at its
// start.
export function placeLabel(cx, cy, width, bounds, taken) {
  const height = 12;
  const spot = ([dx, dy], inside) => {
    let left = dx < 0 ? cx - 8 - width : cx + 8;
    if (inside) left = Math.max(bounds.left, Math.min(left, bounds.right - width));
    const top = dy < 0 ? cy - 8 - height : cy + 8;
    return { x: left, y: top + height - 2, box: { left, top, right: left + width, bottom: top + height } };
  };
  const sides = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
  const spots = [false, true].flatMap((inside) => sides.map((side) => spot(side, inside)));
  const overlaps = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
  const fits = (box) => box.left >= bounds.left && box.right <= bounds.right && box.top >= bounds.top && box.bottom <= bounds.bottom;
  return spots.find((s) => fits(s.box) && !taken.some((t) => overlaps(s.box, t))) ?? spots[sides.length];
}

// options: { months, lines: [{ key, label, values, mark (index or -1),
// markLabel }], goal (the FI number of each month), retirementIndex (or
// -1), format, formatAxis, formatMonth, ageOf(month) }. Lines are drawn in
// order, so the last one is on top where they overlap.
export function renderForecastChart(root, options) {
  const { months, lines, goal, retirementIndex, format, formatAxis, formatMonth, ageOf } = options;
  root.replaceChildren();
  const width = Math.max(320, Math.round(root.clientWidth || 640));
  const height = FORECAST_HEIGHT;
  const margin = FORECAST_MARGIN;
  const plotW = width - margin.left - margin.right;
  const plotH = height - margin.top - margin.bottom;
  const last = months.length - 1;

  const ticks = niceTicks(0, forecastTop(lines, goal, retirementIndex));
  const yMax = ticks.at(-1);
  const x = (i) => margin.left + (last === 0 ? plotW / 2 : (i * plotW) / last);
  const y = (v) => margin.top + plotH - (v / yMax) * plotH;
  // Dots stay on the chart; lines above the top leave it (clipped).
  const yDot = (v) => y(Math.min(v, yMax));

  const chart = svg("svg", {
    viewBox: `0 0 ${width} ${height}`,
    width,
    height,
    class: "chart",
    role: "img",
    tabindex: 0,
    "aria-label": "Forecast of the portfolio for each plan, by year. Use the arrow keys to read each year.",
  });
  const clipId = `chart-clip-${++ids}`;
  const clip = svg("clipPath", { id: clipId });
  clip.append(svg("rect", { x: margin.left - 4, y: margin.top - 4, width: plotW + 8, height: plotH + 8 }));
  const defs = svg("defs");
  defs.append(clip);
  chart.append(defs);
  const inPlot = `url(#${clipId})`;

  for (const tick of ticks) {
    chart.append(svg("line", { class: "grid", x1: margin.left, x2: width - margin.right, y1: y(tick), y2: y(tick) }));
    chart.append(text({ class: "axis", x: margin.left - 8, y: y(tick), "text-anchor": "end", "dominant-baseline": "middle" }, formatAxis(tick)));
  }

  // A label every 1, 2, 5, 10 or 20 years, at January of years whose age
  // divides by that, so that the labels have room.
  const years = months.length / 12;
  const room = Math.max(2, Math.floor(plotW / 64));
  const every = [1, 2, 5, 10, 20].find((n) => years / n <= room) ?? 50;
  months.forEach((month, i) => {
    if (!month.endsWith("-01") || ageOf(month) % every !== 0) return;
    chart.append(text({ class: "axis strong", x: x(i), y: height - 22, "text-anchor": "middle" }, `${ageOf(month)}`));
    chart.append(text({ class: "axis", x: x(i), y: height - 8, "text-anchor": "middle" }, month.slice(0, 4)));
  });
  chart.append(text({ class: "axis", x: margin.left - 8, y: height - 22, "text-anchor": "end" }, "Age"));

  // Retirement: a line through the plot, labeled above it.
  if (retirementIndex >= 0 && retirementIndex <= last) {
    const rx = x(retirementIndex);
    chart.append(svg("line", { class: "marker", x1: rx, x2: rx, y1: margin.top - 4, y2: margin.top + plotH }));
    const right = rx > margin.left + plotW * 0.75;
    chart.append(text({ class: "marker-label", x: right ? rx - 6 : rx + 6, y: margin.top - 10, "text-anchor": right ? "end" : "start" }, `Retirement at ${ageOf(months[retirementIndex])}`));
  }

  // The FI number rises with inflation; its label says today's, above the
  // line all along the label.
  const points = (values) => values.map((v, i) => [x(i), y(v)]);
  chart.append(svg("path", { class: "goal", d: linePath(points(goal)), "clip-path": inPlot }));
  const goalText = `FI number ${format(goal[0])}`;
  const goalWidth = goalText.length * CHAR_WIDTH;
  let above = y(goal[0]);
  for (let i = 0; i <= last && x(i) <= margin.left + 6 + goalWidth; i++) above = Math.min(above, y(goal[i]));
  chart.append(text({ class: "goal-label", x: margin.left + 6, y: above - 6 }, goalText));

  for (const line of lines) chart.append(svg("path", { class: `line plan-${line.key}`, d: linePath(points(line.values)), "clip-path": inPlot }));

  // A dot where a plan changes course, with what happens there, clear of
  // the FI number's label and of each other.
  const taken = [{ left: margin.left + 6, right: margin.left + 6 + goalWidth, top: above - 18, bottom: above - 2 }];
  const bounds = { left: margin.left, right: width - margin.right, top: margin.top, bottom: margin.top + plotH };
  for (const line of lines) {
    if (line.mark < 0 || line.mark > last) continue;
    const cx = x(line.mark);
    const cy = yDot(line.values[line.mark]);
    chart.append(svg("circle", { class: `mark plan-${line.key}`, cx, cy, r: 4.5 }));
    if (!line.markLabel) continue;
    const spot = placeLabel(cx, cy, line.markLabel.length * CHAR_WIDTH, bounds, taken);
    taken.push(spot.box);
    chart.append(text({ class: "mark-label", x: spot.x, y: spot.y }, line.markLabel));
  }

  // Hover layer: a crosshair and one dot per line, a year at a time.
  const cross = svg("line", { class: "cross", y1: margin.top, y2: margin.top + plotH, visibility: "hidden" });
  const dots = lines.map((line) => svg("circle", { class: `dot plan-${line.key}`, r: 4, visibility: "hidden" }));
  const hit = svg("rect", { class: "hit", x: margin.left - 12, y: 0, width: plotW + 24, height });
  chart.append(cross, ...dots, hit);

  const tip = document.createElement("div");
  tip.className = "tip";
  tip.hidden = true;
  root.append(chart, tip);

  let current = -1;
  function show(i) {
    current = Math.max(0, Math.min(last, i));
    for (const el of [cross, ...dots]) el.setAttribute("visibility", "visible");
    cross.setAttribute("x1", x(current));
    cross.setAttribute("x2", x(current));
    lines.forEach((line, n) => {
      dots[n].setAttribute("cx", x(current));
      dots[n].setAttribute("cy", yDot(line.values[current]));
    });

    const title = document.createElement("div");
    title.className = "tip-title";
    title.textContent = `${formatMonth(months[current])} · age ${ageOf(months[current])}`;
    tip.replaceChildren(title);
    const rows = [...lines].reverse().map((line) => [`plan-${line.key}`, line.values[current], line.label]);
    rows.push(["goal", goal[current], "FI number"]);
    for (const [kind, value, name] of rows) {
      const row = document.createElement("div");
      row.className = "tip-row";
      const key = document.createElement("span");
      key.className = `key ${kind}`;
      const strong = document.createElement("strong");
      strong.textContent = format(value);
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
    for (const el of [cross, ...dots]) el.setAttribute("visibility", "hidden");
    tip.hidden = true;
    current = -1;
  }
  // Whole years from the start, and the last month.
  const snap = (i) => Math.min(last, Math.round(i / 12) * 12);
  function nearest(event) {
    const box = chart.getBoundingClientRect();
    const px = ((event.clientX - box.left) / box.width) * width;
    return last === 0 ? 0 : snap(((px - margin.left) / plotW) * last);
  }

  hit.addEventListener("pointermove", (event) => show(nearest(event)));
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
