// Raincheck wind page: station-by-station wind forecast vs. measurement (data from wind.py).

const $ = (s) => document.querySelector(s);
const SVGNS = "http://www.w3.org/2000/svg";
const HEL = (o) => new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Helsinki", ...o });
const fmtDay = HEL({ weekday: "short", day: "numeric", month: "numeric" });
const fmtHM = HEL({ hour: "2-digit", minute: "2-digit" });
const fmtWd = HEL({ weekday: "short" });
const PERIODS = { "7d": "Last 7 days", "30d": "Last 30 days", all: "Since the start" };
const SETS = { water: "On the water", all: "All stations" };
const ZOOMS = {
  all: ["All Finland", [0, 0, 425, 673]],
  south: ["South coast", [60, 470, 280, 140]],
  bothnia: ["Gulf of Bothnia", [55, 250, 230, 290]],
  lakes: ["Lakes", [165, 360, 240, 230]],
  north: ["Lapland", [40, 0, 360, 300]],
};
const MODES = { hour: "This hour", typical: "Typical, 2 weeks" };
// speed error (forecast − measured), m/s: too weak (blue) … too strong (red)
const ERR_STEPS = [-4, -2, -1, 1, 2, 4];
const ERR_COLORS = ["#2166ac", "#67a9cf", "#d1e5f0", "#efefef", "#fddbc7", "#ef8a62", "#b2182b"];
const ERR_LABELS = ["4+ too weak", "2–4", "1–2", "±1 m/s", "1–2", "2–4", "4+ too strong"];
const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];

let IDX, SUM, C, F;
const state = { i: 0, b: 0, src: "official", set: "water", thr: 11, period: "7d", zoom: "all", mode: "hour", arrows: true, station: null };
const hourCache = new Map();
let hoursChart, leadChart, stationChart, timer = null, token = 0;

const tagDate = (t) => new Date(Date.UTC(+t.slice(0, 4), +t.slice(4, 6) - 1, +t.slice(6, 8), +t.slice(9, 11)));
const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const bucketLabel = ([lo, hi]) => `${lo}–${hi} h ahead`;
const ms = (v, d = 1) => (v == null || isNaN(v) ? "–" : `${v.toFixed(d)} m/s`);
const signed = (v) => (v == null || isNaN(v) ? "–" : `${v > 0 ? "+" : v < 0 ? "−" : "±"}${Math.abs(v).toFixed(1)} m/s`);
const pct = (v) => (v == null || isNaN(v) ? "–" : `${Math.round(v * 100)} %`);
const compass = (d) => (d == null || isNaN(d) ? "" : COMPASS[Math.round(((d % 360) + 360) % 360 / 45) % 8]);
const errColor = (e) => ERR_COLORS[ERR_STEPS.findIndex((s) => e < s) === -1 ? ERR_STEPS.length : ERR_STEPS.findIndex((s) => e < s)];
const srcColor = (s) => css(s === "official" ? "--s1" : "--s2");

// score vector -> readable numbers
function stats(v) {
  if (!v) return null;
  const g = (k) => v[F[k]];
  const n = g("n"), t = state.thr;
  const hit = g(`hit${t}`), miss = g(`miss${t}`), fa = g(`fa${t}`);
  return {
    n, mae: n ? g("abs") / n : NaN, bias: n ? g("err") / n : NaN, near: n ? g("near") / n : NaN,
    dir: g("n_dir") ? g("abs_dir") / g("n_dir") : NaN,
    gust: g("n_gust") ? g("abs_gust") / g("n_gust") : NaN,
    pod: hit + miss ? hit / (hit + miss) : NaN, far: hit + fa ? fa / (hit + fa) : NaN, windy: hit + miss,
  };
}
const hourStats = (h, src = state.src, b = state.b) => stats(h.s[src] && h.s[src][b] && h.s[src][b][state.set]);
const visible = (fid) => state.set === "all" || IDX.stations[fid].water;

async function hourData(t) {
  if (!hourCache.has(t)) {
    hourCache.set(t, fetch(`wind/h/${t}.json`).then((r) => r.json()));
    if (hourCache.size > 60) hourCache.delete(hourCache.keys().next().value);
  }
  return hourCache.get(t);
}

// ------------------------------------------------------------------ map

function svg(tag, attrs, parent) {
  const el = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  if (parent) parent.appendChild(el);
  return el;
}

function setupMap() {
  const map = $("#map");
  svg("rect", { x: 0, y: 0, width: C.width, height: C.height, fill: "#fff" }, map);
  svg("image", { href: "map.svg", x: 0, y: 0, width: C.width, height: C.height }, map);
  svg("g", { id: "arrows-g" }, map);
  svg("g", { id: "dots-g" }, map);
  map.addEventListener("pointerleave", () => ($("#tip").hidden = true));
}

function applyZoom() {
  const [x, y, w, h] = ZOOMS[state.zoom][1];
  const map = $("#map");
  map.setAttribute("viewBox", `${x} ${y} ${w} ${h}`);
  map.style.aspectRatio = `${w} / ${h}`;
}

function arrow(g, x, y, dir, speed, color, width, scale) {
  if (speed == null || dir == null || speed < 0.5) return;
  const len = Math.min(speed, 20) * 1.6 * scale, a = ((dir + 180) * Math.PI) / 180; // points downwind
  const dx = Math.sin(a) * len, dy = -Math.cos(a) * len;
  const x2 = x + dx, y2 = y + dy, hs = Math.max(len * 0.3, 2.2 * scale);
  const back = Math.atan2(-dy, -dx);
  const p1 = [x2 + hs * Math.cos(back + 0.45), y2 + hs * Math.sin(back + 0.45)];
  const p2 = [x2 + hs * Math.cos(back - 0.45), y2 + hs * Math.sin(back - 0.45)];
  svg("path", {
    d: `M${x},${y}L${x2},${y2}M${p1}L${x2},${y2}L${p2}`, stroke: color, "stroke-width": width,
    fill: "none", "stroke-linecap": "round", "stroke-linejoin": "round",
  }, g);
}

async function drawMap(h) {
  const my = ++token;
  const data = await hourData(h.t);
  if (my !== token) return;
  const fc = data.fc[state.src] && data.fc[state.src][state.b];
  const typical = IDX.stats[state.src][state.b];
  const scale = ZOOMS[state.zoom][1][2] / 425;
  const dots = $("#dots-g"), arrows = $("#arrows-g");
  dots.replaceChildren(); arrows.replaceChildren();
  const ink = css("--ink"), fcCol = srcColor(state.src);

  for (const [fid, st] of Object.entries(IDX.stations)) {
    if (!visible(fid)) continue;
    const o = data.obs[fid], f = fc && fc[fid];
    let err = null;
    if (state.mode === "hour") err = o && f ? f[0] - o[0] : null;
    else if (typical[fid] && typical[fid][0] >= 3) err = typical[fid][2] / typical[fid][0];
    if (state.arrows && state.mode === "hour") {
      if (f) arrow(arrows, st.px, st.py, f[1], f[0], fcCol, 1.6 * scale, scale);
      if (o) arrow(arrows, st.px, st.py, o[1], o[0], ink, 1.1 * scale, scale);
    }
    const c = svg("circle", {
      cx: st.px, cy: st.py, r: (st.water ? 3.6 : 2.9) * scale,
      fill: err == null ? "#bdbdbd" : errColor(err), stroke: "#333", "stroke-width": 0.6 * scale,
      tabindex: 0, role: "button", "aria-label": st.name,
    }, dots);
    if (fid === state.station) c.setAttribute("stroke-width", 2 * scale);
    const show = (ev) => showTip(ev, fid, o, f, typical[fid]);
    c.addEventListener("pointerenter", show);
    c.addEventListener("pointermove", show);
    c.addEventListener("click", () => selectStation(fid));
    c.addEventListener("keydown", (e) => { if (e.key === "Enter") selectStation(fid); });
  }
}

function windText(v, gustLabel) {
  if (!v) return "no data";
  const g = v[2] != null ? `, ${gustLabel} ${v[2].toFixed(1)}` : "";
  return `${v[0].toFixed(1)} m/s ${compass(v[1]) ? "from " + compass(v[1]) : ""}${g}`;
}

function showTip(ev, fid, o, f, typ) {
  const tip = $("#tip"), st = IDX.stations[fid];
  let html = `<b>${st.name}</b>${st.water ? " · on the water" : ""}<br>`;
  if (state.mode === "hour") {
    html += `Measured: ${windText(o, "gusts")}<br>Forecast: ${windText(f, "gusts")}`;
    if (o && f) {
      const e = f[0] - o[0];
      html += `<br><b>${Math.abs(e) < 0.05 ? "spot on" : `${Math.abs(e).toFixed(1)} m/s too ${e > 0 ? "strong" : "weak"}`}</b>`;
    }
  } else if (typ) {
    html += `Last 2 weeks (${typ[0]} h): typically ${(typ[1] / typ[0]).toFixed(1)} m/s off, on average ${signed(typ[2] / typ[0])}`;
  } else html += "Not enough data yet";
  tip.innerHTML = html;
  const box = $(".wind-map").getBoundingClientRect();
  const x = ev.clientX - box.left, y = ev.clientY - box.top;
  tip.hidden = false;
  tip.style.left = `${Math.min(x + 12, box.width - tip.offsetWidth - 4)}px`;
  tip.style.top = `${y + 14 + tip.offsetHeight > box.height ? y - tip.offsetHeight - 10 : y + 14}px`;
}

// ------------------------------------------------------------------ hour view

async function draw() {
  const h = IDX.hours[state.i];
  const end = tagDate(h.t);
  $("#hour-title").textContent = `Wind ${fmtDay.format(end)} at ${fmtHM.format(end)} (Finnish time)`;
  $("#hour").value = state.i;
  const s = hourStats(h);
  $("#t-mae").textContent = s ? ms(s.mae) : "–";
  $("#t-bias").textContent = s ? (isNaN(s.bias) ? "–" : `${signed(s.bias)}`) : "–";
  $("#t-near").textContent = s ? pct(s.near) : "–";
  $("#t-dir").textContent = s && !isNaN(s.dir) ? `${Math.round(s.dir)}°` : "–";
  $("#t-gust").textContent = s ? ms(s.gust) : "–";
  $("#t-windy").textContent = s ? (s.windy ? pct(s.pod) : "none windy") : "–";
  $("#t-windy-k").textContent = `windy (≥ ${state.thr} m/s) stations forecast windy`;
  const lead = h.leads[state.src] && h.leads[state.src][state.b];
  $("#fc-key-label").textContent = lead
    ? `${C.sources[state.src]}, made ${lead} h before`
    : `no ${C.sources[state.src]} made ${bucketLabel(C.buckets[state.b])} for this hour`;
  $("#fc-key").style.background = srcColor(state.src);
  await drawMap(h);
  if (hoursChart) hoursChart.update();
}

function errLegend() {
  $("#err-legend").innerHTML = `<span class="label">${state.mode === "hour" ? "Forecast speed was" : "Typically"}</span>` +
    ERR_COLORS.map((c, i) => `<span><i style="background:${c};border:1px solid #888"></i>${ERR_LABELS[i]}</span>`).join("") +
    `<span><i style="background:#bdbdbd;border:1px solid #888"></i>no data</span>`;
}

// ------------------------------------------------------------------ station panel

async function selectStation(fid) {
  state.station = fid;
  const st = IDX.stations[fid];
  $("#st-name").textContent = st.name;
  $("#st-note").textContent = `Wind speed measured vs. forecast ${bucketLabel(C.buckets[state.b])}, last two weeks. ${st.water ? "Station on the water." : "Land station."}`;
  $("#st-chart-wrap").hidden = false;
  const d = await fetch(`wind/st/${fid}.json`).then((r) => r.json());
  if (state.station !== fid) return;
  const labels = d.t.map((t) => { const x = tagDate(t); return `${fmtWd.format(x)} ${fmtHM.format(x)}`; });
  const ds = [
    { label: "Measured", data: d.obs, borderColor: css("--ink"), backgroundColor: css("--ink"), borderWidth: 2 },
    ...Object.keys(C.sources).map((s) => ({
      label: C.sources[s], data: d.fc[s][state.b], borderColor: srcColor(s), backgroundColor: srcColor(s),
      borderWidth: s === state.src ? 2 : 1.5, borderDash: s === state.src ? [] : [4, 3],
    })),
  ].map((x) => ({ ...x, pointRadius: 0, pointHitRadius: 6, spanGaps: false, tension: 0.2 }));
  if (stationChart) stationChart.destroy();
  stationChart = new Chart($("#ch-station"), {
    type: "line",
    data: { labels, datasets: ds },
    options: {
      maintainAspectRatio: false, animation: false,
      interaction: { mode: "index", intersect: false },
      scales: { y: { min: 0, title: { display: true, text: "m/s" } }, x: { ticks: { maxRotation: 0, autoSkipPadding: 16 }, grid: { display: false } } },
      plugins: {
        legend: { position: "bottom", labels: { boxWidth: 12, boxHeight: 2 } },
        tooltip: { callbacks: { label: (it) => `${it.dataset.label}: ${ms(it.raw)}` } },
      },
    },
  });
  const rows = Object.keys(C.sources).map((s) => {
    const v = IDX.stats[s][state.b][fid];
    return `<tr><td>${C.sources[s]}</td><td>${v ? v[0] : 0}</td><td>${v ? ms(v[1] / v[0]) : "–"}</td><td>${v ? signed(v[2] / v[0]) : "–"}</td></tr>`;
  });
  $("#st-table").innerHTML = `<tr><th>Last 2 weeks</th><th>Hours</th><th>Typical error</th><th>On average</th></tr>${rows.join("")}`;
  draw();
}

// ------------------------------------------------------------------ charts

function chartDefaults() {
  Chart.defaults.color = css("--muted");
  Chart.defaults.borderColor = css("--grid");
  Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
}

function buildHoursChart() {
  const labels = IDX.hours.map((h) => { const t = tagDate(h.t); return `${fmtWd.format(t)} ${fmtHM.format(t)}`; });
  const datasets = Object.keys(C.sources).map((s) => ({
    label: C.sources[s],
    data: IDX.hours.map((h) => { const x = hourStats(h, s); return x && x.n ? x.mae : null; }),
    borderColor: srcColor(s), backgroundColor: srcColor(s), borderWidth: 2, spanGaps: false,
    pointRadius: (ctx) => (ctx.dataIndex === state.i ? 5 : 1.5), pointHitRadius: 8,
  }));
  if (hoursChart) { hoursChart.data.datasets = datasets; hoursChart.update(); return; }
  hoursChart = new Chart($("#ch-hours"), {
    type: "line",
    data: { labels, datasets },
    options: {
      maintainAspectRatio: false, animation: false,
      interaction: { mode: "index", intersect: false },
      scales: { y: { min: 0, title: { display: true, text: "typical error, m/s" } }, x: { ticks: { maxRotation: 0, autoSkipPadding: 18 }, grid: { display: false } } },
      plugins: {
        legend: { position: "bottom", labels: { boxWidth: 12, boxHeight: 2 } },
        tooltip: { callbacks: { label: (it) => `${it.dataset.label}: ${ms(it.raw)}` } },
      },
      onClick: (e, els, chart) => {
        const p = chart.getElementsAtEventForMode(e, "index", { intersect: false }, false);
        if (p.length) { state.i = p[0].index; stop(); draw(); }
      },
    },
  });
}

function buildLeadChart() {
  const p = SUM[state.period];
  const per = Object.keys(C.sources).map((s) => C.buckets.map((_, b) => stats(p.sums[s][b][state.set])));
  $("#period-note").textContent = p.since
    ? `${PERIODS[state.period]} (data from ${fmtDay.format(tagDate(p.since))}), ${SETS[state.set].toLowerCase()}. Bars: typical wind speed error, lower is better.`
    : "No verified hours yet.";
  const datasets = Object.keys(C.sources).map((s, i) => ({
    label: C.sources[s], data: per[i].map((x) => (x && x.n ? x.mae : null)),
    backgroundColor: srcColor(s), borderRadius: 4, maxBarThickness: 40,
  }));
  if (leadChart) { leadChart.data.datasets = datasets; leadChart.update(); }
  else {
    leadChart = new Chart($("#ch-lead"), {
      type: "bar",
      data: { labels: C.buckets.map(bucketLabel), datasets },
      options: {
        maintainAspectRatio: false, animation: false,
        scales: { y: { min: 0, title: { display: true, text: "typical error, m/s" } }, x: { grid: { display: false } } },
        plugins: { legend: { position: "bottom", labels: { boxWidth: 12 } }, tooltip: { callbacks: { label: (it) => `${it.dataset.label}: ${ms(it.raw)}` } } },
      },
    });
  }
  const t = state.thr;
  let html = `<tr><th>Forecast made</th><th>Forecast</th><th>Station-hours</th><th>Typical error</th><th>On average</th>` +
    `<th>Within ±2</th><th>Direction</th><th>Gusts</th><th>Windy ≥ ${t} caught</th><th>False windy</th></tr>`;
  C.buckets.forEach((bk, b) => Object.keys(C.sources).forEach((s, i) => {
    const x = per[i][b];
    html += `<tr><td>${i === 0 ? bucketLabel(bk) : ""}</td><td><i class="sw" style="background:${srcColor(s)}"></i>${C.sources[s]}</td>` +
      (x && x.n ? `<td>${x.n}</td><td>${ms(x.mae)}</td><td>${signed(x.bias)}</td><td>${pct(x.near)}</td>` +
        `<td>${isNaN(x.dir) ? "–" : Math.round(x.dir) + "°"}</td><td>${ms(x.gust)}</td><td>${x.windy ? pct(x.pod) : "–"}</td><td>${pct(x.far)}</td>`
        : `<td>0</td>${"<td>–</td>".repeat(7)}`) + "</tr>";
  }));
  $("#lead-table").innerHTML = html;
}

function buildRanking() {
  const typ = IDX.stats[state.src][state.b];
  const rows = Object.entries(typ).filter(([fid, v]) => visible(fid) && v[0] >= 6)
    .map(([fid, v]) => ({ fid, n: v[0], mae: v[1] / v[0], bias: v[2] / v[0] }))
    .sort((a, b) => b.mae - a.mae).slice(0, 12);
  $("#rank-note").textContent = `${C.sources[state.src]}, made ${bucketLabel(C.buckets[state.b])}, ${SETS[state.set].toLowerCase()}: ` +
    "stations with the biggest typical speed error over the last two weeks (at least 6 hours of data). Click a name to see it.";
  $("#rank-table").innerHTML = rows.length
    ? `<tr><th>Station</th><th>Hours</th><th>Typical error</th><th>On average</th></tr>` +
      rows.map((r) => `<tr><td><a href="#" data-fid="${r.fid}">${IDX.stations[r.fid].name}</a></td><td>${r.n}</td><td>${ms(r.mae)}</td>` +
        `<td>${signed(r.bias)} ${r.bias > 0.5 ? "(too strong)" : r.bias < -0.5 ? "(too weak)" : ""}</td></tr>`).join("")
    : "<tr><td>Not enough data yet.</td></tr>";
  $("#rank-table").querySelectorAll("a").forEach((a) => (a.onclick = (e) => {
    e.preventDefault(); selectStation(a.dataset.fid);
    $("#station").scrollIntoView({ behavior: "smooth", block: "nearest" });
  }));
}

// ------------------------------------------------------------------ controls

function segmented(el, items, get, set) {
  el.innerHTML = "";
  for (const [value, text] of items) {
    const b = document.createElement("button");
    b.textContent = text; b.setAttribute("role", "radio");
    b.onclick = () => { set(value); update(); };
    el.appendChild(b);
  }
  const update = () => [...el.children].forEach((b, i) => b.setAttribute("aria-checked", items[i][0] === get()));
  update();
}

function stop() { if (timer) { clearInterval(timer); timer = null; $("#play").textContent = "▶"; } }
function step(d) { state.i = (state.i + d + IDX.hours.length) % IDX.hours.length; draw(); }
function refresh() { buildHoursChart(); buildLeadChart(); buildRanking(); if (state.station) selectStation(state.station); else draw(); }

function setupControls() {
  const slider = $("#hour");
  slider.max = IDX.hours.length - 1;
  slider.oninput = () => { stop(); state.i = +slider.value; draw(); };
  $("#prev").onclick = () => { stop(); step(-1); };
  $("#next").onclick = () => { stop(); step(1); };
  $("#latest").onclick = () => { stop(); state.i = IDX.hours.length - 1; draw(); };
  $("#play").onclick = () => {
    if (timer) return stop();
    $("#play").textContent = "❚❚";
    timer = setInterval(() => step(1), 900);
  };
  document.addEventListener("keydown", (e) => {
    if (["SELECT", "INPUT"].includes(e.target.tagName) && e.target.type !== "range") return;
    if (e.key === "ArrowLeft") { stop(); step(-1); }
    if (e.key === "ArrowRight") { stop(); step(1); }
  });
  segmented($("#source"), Object.entries(C.sources).map(([k, v]) => [k, v.replace(" forecast", "").replace(" weather model", "")]),
    () => state.src, (v) => { state.src = v; refresh(); });
  segmented($("#bucket"), C.buckets.map((b, i) => [i, `${b[0]}–${b[1]} h`]), () => state.b, (v) => { state.b = v; refresh(); });
  segmented($("#set"), Object.entries(SETS), () => state.set, (v) => { state.set = v; refresh(); });
  segmented($("#period"), Object.entries(PERIODS), () => state.period, (v) => { state.period = v; buildLeadChart(); });
  segmented($("#zoom"), Object.entries(ZOOMS).map(([k, v]) => [k, v[0]]), () => state.zoom, (v) => { state.zoom = v; applyZoom(); draw(); });
  segmented($("#mode"), Object.entries(MODES), () => state.mode, (v) => { state.mode = v; errLegend(); draw(); });
  $("#arrows").onchange = (e) => { state.arrows = e.target.checked; draw(); };
  const thr = $("#thr");
  thr.innerHTML = C.thresholds.map((t) => `<option value="${t}" ${t === state.thr ? "selected" : ""}>≥ ${t} m/s</option>`).join("");
  thr.onchange = () => { state.thr = +thr.value; refresh(); };
}

async function main() {
  try {
    [IDX, SUM] = await Promise.all(["wind/index.json", "wind/summary.json"].map((u) => fetch(u, { cache: "no-cache" }).then((r) => r.json())));
  } catch (e) {
    $("#updated").textContent = "No wind data yet: the first hourly run hasn't finished.";
    return;
  }
  C = IDX.config;
  F = Object.fromEntries(C.fields.map((k, i) => [k, i]));
  const upd = new Date(IDX.updated);
  const nWater = Object.values(IDX.stations).filter((s) => s.water).length;
  $("#updated").textContent = `Last updated ${fmtDay.format(upd)} ${fmtHM.format(upd)} Finnish time · ` +
    `${Object.keys(IDX.stations).length} stations, ${nWater} on the water · ${IDX.hours.length} hours in the last two weeks`;
  if (!IDX.hours.length) return;
  state.i = IDX.hours.length - 1;
  // start with the source/age that has data for the latest hour
  const last = IDX.hours[state.i];
  if (!(last.leads.official || []).some(Boolean)) state.src = "meps";
  const firstB = (last.leads[state.src] || []).findIndex(Boolean);
  state.b = firstB >= 0 ? firstB : 0;
  chartDefaults();
  setupMap();
  setupControls();
  applyZoom();
  errLegend();
  refresh();
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { chartDefaults(); refresh(); });
}

main();
