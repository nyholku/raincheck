// Raincheck wind page: station-by-station wind forecast vs. measurement (data from wind.py).

const $ = (s) => document.querySelector(s);
const SVGNS = "http://www.w3.org/2000/svg";
const HEL = (o) => new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Helsinki", ...o });
const fmtDay = HEL({ weekday: "short", day: "numeric", month: "numeric" });
const fmtHM = HEL({ hour: "2-digit", minute: "2-digit" });
const fmtWd = HEL({ weekday: "short" });
const PERIODS = { "7d": "Last 7 days", "30d": "Last 30 days", all: "Since the start" };
const SETS = { sea: "At sea", all: "All stations" };
const ZOOMS = {
  coast: ["Whole coast", [40, 225, 300, 390]],
  south: ["South coast", [60, 470, 280, 140]],
  bothnia: ["Gulf of Bothnia", [55, 250, 230, 290]],
  all: ["All Finland", [0, 0, 425, 673]],
};
const MODES = { hour: "This hour", typical: "Typical, 2 weeks" };
// speed error (forecast − measured, m/s): too weak = red, about right = green, too strong = blue
const ERR_STOPS = [
  [-4, [150, 16, 32]], [-2.6, [214, 58, 42]], [-1.5, [240, 140, 60]], [-0.7, [178, 206, 92]],
  [0, [72, 168, 84]], [0.7, [96, 186, 160]], [1.5, [82, 160, 214]], [2.6, [52, 104, 196]], [4, [30, 52, 140]],
];
const FIELD_SIGMA_KM = 30;           // how far one station's value spreads
const FIELD_FULL_KM = 30, FIELD_FADE_KM = 80;  // colour fades out this far from the station network
const LINK_KM = 150;                 // neighbouring stations closer than this are linked into the network
const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];

let IDX, SUM, C, F;
const state = { i: 0, b: 0, src: "official", set: "sea", thr: 11, period: "7d", zoom: "coast", mode: "hour", arrows: true, station: null };
const hourCache = new Map();
let hoursChart, leadChart, stationChart, timer = null, token = 0;

const tagDate = (t) => new Date(Date.UTC(+t.slice(0, 4), +t.slice(4, 6) - 1, +t.slice(6, 8), +t.slice(9, 11)));
const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const bucketLabel = ([lo, hi]) => `${lo}–${hi} h ahead`;
const ms = (v, d = 1) => (v == null || isNaN(v) ? "–" : `${v.toFixed(d)} m/s`);
const signed = (v) => (v == null || isNaN(v) ? "–" : Math.abs(v) < 0.05 ? "±0.0 m/s" : `${v > 0 ? "+" : "−"}${Math.abs(v).toFixed(1)} m/s`);
const pct = (v) => (v == null || isNaN(v) ? "–" : `${Math.round(v * 100)} %`);
const compass = (d) => (d == null || isNaN(d) ? "" : COMPASS[Math.round(((d % 360) + 360) % 360 / 45) % 8]);
function ramp(stops, e) {
  if (e <= stops[0][0]) return stops[0][1];
  for (let k = 1; k < stops.length; k++) {
    const [e1, c1] = stops[k];
    if (e <= e1) {
      const [e0, c0] = stops[k - 1], f = (e - e0) / (e1 - e0);
      return [0, 1, 2].map((j) => Math.round(c0[j] + (c1[j] - c0[j]) * f));
    }
  }
  return stops[stops.length - 1][1];
}
const errRGB = (e) => ramp(ERR_STOPS, e);
const errColor = (e) => `rgb(${errRGB(e).join(",")})`;
const errWords = (e) => (Math.abs(e) < 0.05 ? "spot on" : `${Math.abs(e).toFixed(1)} m/s too ${e > 0 ? "strong" : "weak"}`);
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
const visible = (fid) => state.set === "all" || IDX.stations[fid].sea;

async function hourData(t) {
  if (!hourCache.has(t)) {
    hourCache.set(t, fetch(`wind/h/${t}.json`).then((r) => r.json()));
    if (hourCache.size > 60) hourCache.delete(hourCache.keys().next().value);
  }
  return hourCache.get(t);
}

// ------------------------------------------------------------------ maps

const PANELS = ["obs", "fc", "err"];
// wind speed (m/s): green (calm) → yellow → orange → red → dark red (storm)
const WS_STOPS = [[0, [116, 196, 118]], [4, [168, 214, 92]], [7, [236, 224, 78]], [10, [246, 164, 58]], [14, [222, 70, 44]], [20, [140, 20, 40]]];
const wsRGB = (v) => ramp(WS_STOPS, v);
const wsColor = (v) => `rgb(${wsRGB(v).join(",")})`;

function svg(tag, attrs, parent) {
  const el = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  if (parent) parent.appendChild(el);
  return el;
}

function setupMaps() {
  for (const p of PANELS) {
    const map = $(`#map-${p}`);
    svg("rect", { x: 0, y: 0, width: C.width, height: C.height, fill: "#fff" }, map);
    svg("image", { id: `field-${p}`, x: 0, y: 0, width: C.width, height: C.height, preserveAspectRatio: "none" }, map);
    svg("image", { href: "map.svg", x: 0, y: 0, width: C.width, height: C.height }, map);
    svg("g", { id: `arrows-${p}` }, map);
    svg("g", { id: `dots-${p}` }, map);
    map.addEventListener("pointerleave", () => ($("#tip").hidden = true));
    map.addEventListener("pointermove", (ev) => {
      if (ev.target.tagName === "circle") return;
      const f = FIELD[p];
      if (!f) return;
      const pt = new DOMPoint(ev.clientX, ev.clientY).matrixTransform(map.getScreenCTM().inverse());
      const x = Math.floor(pt.x), y = Math.floor(pt.y);
      const v = x >= 0 && y >= 0 && x < C.width && y < C.height ? f[y * C.width + x] : NaN;
      if (isNaN(v)) { $("#tip").hidden = true; return; }
      const text = p === "err" ? `forecast about ${errWords(v)}` : `${p === "obs" ? "measured" : "forecast"} about ${v.toFixed(1)} m/s`;
      tipAt(ev, `<b>Sea</b>, estimated from nearby stations:<br>${text}`);
    });
  }
}

function applyZoom() {
  const [x, y, w, h] = ZOOMS[state.zoom][1];
  for (const p of PANELS) {
    const map = $(`#map-${p}`);
    map.setAttribute("viewBox", `${x} ${y} ${w} ${h}`);
    map.style.aspectRatio = `${w} / ${h}`;
  }
}

// ------------------------------------------------------------------ continuous fields over the sea

const FIELD = { mask: null, cells: null, url: {} };

async function loadSea() {
  const img = new Image();
  img.src = "wind/sea.png";
  await img.decode();
  const W = C.width * C.sea_scale, H = C.height * C.sea_scale;
  const cv = Object.assign(document.createElement("canvas"), { width: W, height: H });
  const ctx = cv.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const d = ctx.getImageData(0, 0, W, H).data;
  FIELD.mask = new Uint8Array(W * H);
  for (let i = 0; i < FIELD.mask.length; i++) FIELD.mask[i] = d[i * 4] > 127 ? 1 : 0;
  // coarse cells (rain-grid pixels) that contain some sea: fields are computed for these only
  const cells = [], k = C.sea_scale;
  for (let y = 0; y < C.height; y++) for (let x = 0; x < C.width; x++) {
    let sea = false;
    for (let j = 0; j < k && !sea; j++) for (let i = 0; i < k; i++) if (FIELD.mask[(y * k + j) * W + x * k + i]) { sea = true; break; }
    if (sea) cells.push(y * C.width + x);
  }
  FIELD.cells = Int32Array.from(cells);
}

// Links between neighbouring stations (each to its 3 nearest within LINK_KM), so the colour
// stays solid along the coast between stations and only fades towards the open sea.
function links(points) {
  const max = LINK_KM / C.pixel_km, segs = [], seen = new Set();
  points.forEach((p, i) => {
    points.map((q, j) => [Math.hypot(p.x - q.x, p.y - q.y), j]).filter(([d, j]) => j !== i && d <= max)
      .sort((a, b) => a[0] - b[0]).slice(0, 3).forEach(([, j]) => {
        const key = i < j ? `${i}-${j}` : `${j}-${i}`;
        if (!seen.has(key)) { seen.add(key); segs.push([p, points[j]]); }
      });
  });
  return segs;
}

function distToSegment(x, y, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / l2)) : 0;
  return Math.hypot(x - a.x - t * dx, y - a.y - t * dy);
}

// Blend station values over the sea: Gaussian-weighted mean of nearby stations, fading out
// with distance from the station network. points: [{x, y, v}] in grid pixels.
function blend(points) {
  const W = C.width, km = C.pixel_km;
  const values = new Float32Array(W * C.height).fill(NaN), alpha = new Float32Array(W * C.height);
  if (!FIELD.cells || !points.length) return { values, alpha };
  const s2 = 2 * (FIELD_SIGMA_KM / km) ** 2, full = FIELD_FULL_KM / km, fade = FIELD_FADE_KM / km;
  const segs = links(points);
  for (const c of FIELD.cells) {
    const cx = (c % W) + 0.5, cy = Math.floor(c / W) + 0.5;
    let sw = 0, sv = 0, near = Infinity;
    for (const p of points) {
      const d2 = (p.x - cx) ** 2 + (p.y - cy) ** 2;
      const w = Math.exp(-d2 / s2) + 1e-12 / (1 + d2);   // tiny term keeps far cells defined
      sw += w; sv += w * p.v;
      if (d2 < near) near = d2;
    }
    near = Math.sqrt(near);
    for (const [a, b] of segs) if (near > full) near = Math.min(near, distToSegment(cx, cy, a, b));
    if (near > fade) continue;
    values[c] = sv / sw;
    alpha[c] = near <= full ? 1 : 1 - (near - full) / (fade - full);
  }
  return { values, alpha };
}

async function paintField(p, { values, alpha }, colorOf) {
  FIELD[p] = values;
  const el = document.getElementById(`field-${p}`);
  if (!FIELD.mask) return;
  const W = C.width, k = C.sea_scale;
  const cv = Object.assign(document.createElement("canvas"), { width: W * k, height: C.height * k });
  const ctx = cv.getContext("2d");
  const img = ctx.createImageData(W * k, C.height * k), d = img.data;
  for (let y = 0; y < C.height * k; y++) for (let x = 0; x < W * k; x++) {
    const i = y * W * k + x;
    if (!FIELD.mask[i]) continue;
    const c = Math.floor(y / k) * W + Math.floor(x / k);
    if (isNaN(values[c])) continue;
    const rgb = colorOf(values[c]);
    d[i * 4] = rgb[0]; d[i * 4 + 1] = rgb[1]; d[i * 4 + 2] = rgb[2]; d[i * 4 + 3] = Math.round(230 * alpha[c]);
  }
  ctx.putImageData(img, 0, 0);
  const blob = await new Promise((r) => cv.toBlob(r));
  if (FIELD.url[p]) URL.revokeObjectURL(FIELD.url[p]);
  FIELD.url[p] = URL.createObjectURL(blob);
  el.setAttribute("href", FIELD.url[p]);
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

const ok = (v) => v && v[0] != null;

async function drawMaps(h) {
  const my = ++token;
  const data = await hourData(h.t);
  if (my !== token) return;
  const fc = data.fc[state.src] && data.fc[state.src][state.b];
  const typical = IDX.stats[state.src][state.b];
  const scale = ZOOMS[state.zoom][1][2] / 425;
  const ink = css("--ink");
  const pts = { obs: [], fc: [], err: [] };
  for (const p of PANELS) { $(`#dots-${p}`).replaceChildren(); $(`#arrows-${p}`).replaceChildren(); }

  for (const [fid, st] of Object.entries(IDX.stations)) {
    const o = data.obs[fid], f = fc && fc[fid];
    let err = null;
    if (state.mode === "hour") err = ok(o) && ok(f) ? f[0] - o[0] : null;
    else if (typical[fid] && typical[fid][0] >= 3) err = typical[fid][2] / typical[fid][0];
    if (st.sea) {
      if (ok(o)) pts.obs.push({ x: st.px, y: st.py, v: o[0] });
      if (ok(f)) pts.fc.push({ x: st.px, y: st.py, v: f[0] });
      if (err != null) pts.err.push({ x: st.px, y: st.py, v: err });
    }
    if (!visible(fid)) continue;
    const per = {
      obs: [ok(o) ? wsColor(o[0]) : null, o],
      fc: [ok(f) ? wsColor(f[0]) : null, f],
      err: [err == null ? null : errColor(err), null],
    };
    for (const p of PANELS) {
      const [fill, wind] = per[p];
      if (state.arrows && wind && ok(wind)) arrow($(`#arrows-${p}`), st.px, st.py, wind[1], wind[0], ink, 1.3 * scale, scale);
      const c = svg("circle", {
        cx: st.px, cy: st.py, r: (st.sea ? 3.2 : 2.6) * scale, fill: fill || "#bdbdbd",
        stroke: "#333", "stroke-width": (fid === state.station ? 2 : 0.6) * scale,
        tabindex: 0, role: "button", "aria-label": st.name,
      }, $(`#dots-${p}`));
      const show = (ev) => showTip(ev, fid, o, f, typical[fid]);
      c.addEventListener("pointerenter", show);
      c.addEventListener("pointermove", show);
      c.addEventListener("click", () => selectStation(fid));
      c.addEventListener("keydown", (e) => { if (e.key === "Enter") selectStation(fid); });
    }
  }
  await Promise.all([
    paintField("obs", blend(pts.obs), wsRGB),
    paintField("fc", blend(pts.fc), wsRGB),
    paintField("err", blend(pts.err), errRGB),
  ]);
}

function windText(v, gustLabel) {
  if (!ok(v)) return "no data";
  const g = v[2] != null ? `, ${gustLabel} ${v[2].toFixed(1)}` : "";
  return `${v[0].toFixed(1)} m/s ${compass(v[1]) ? "from " + compass(v[1]) : ""}${g}`;
}

function tipAt(ev, html) {
  const tip = $("#tip");
  tip.innerHTML = html;
  tip.hidden = false;
  const x = ev.clientX, y = ev.clientY;
  tip.style.left = `${Math.max(4, Math.min(x + 12, innerWidth - tip.offsetWidth - 8))}px`;
  tip.style.top = `${y + 14 + tip.offsetHeight > innerHeight ? y - tip.offsetHeight - 10 : y + 14}px`;
}

function showTip(ev, fid, o, f, typ) {
  const st = IDX.stations[fid];
  let html = `<b>${st.name}</b>${st.sea ? " · at sea" : st.lake ? " · lake" : ""}<br>` +
    `Measured: ${windText(o, "gusts")}<br>Forecast: ${windText(f, "gusts")}`;
  if (ok(o) && ok(f)) html += `<br><b>${errWords(f[0] - o[0])}</b>`;
  if (state.mode === "typical" && typ) html += `<br>Last 2 weeks (${typ[0]} h): typically ${(typ[1] / typ[0]).toFixed(1)} m/s off, on average ${signed(typ[2] / typ[0])}`;
  tipAt(ev, html);
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
  const origin = lead && h.origins[state.src][state.b];
  $("#cap-obs").textContent = `Measured wind at ${fmtHM.format(end)}`;
  $("#cap-fc").textContent = lead
    ? `${C.sources[state.src]} from ${fmtHM.format(new Date(origin))}, ${lead} h before`
    : `No ${C.sources[state.src]} made ${bucketLabel(C.buckets[state.b])} for this hour`;
  $("#cap-err").textContent = state.mode === "hour" ? "Right or wrong?" : "Typical error, last 2 weeks";
  await drawMaps(h);
  if (hoursChart) hoursChart.update();
}

function errLegend() {
  const grad = (stops, lo, hi) => stops.map(([e, c]) => `rgb(${c.join(",")}) ${((e - lo) / (hi - lo)) * 100}%`).join(",");
  $("#ws-legend").innerHTML = `<span class="label">Wind speed</span>` +
    `<span class="err-scale"><span class="bar" style="background:linear-gradient(90deg,${grad(WS_STOPS, 0, 20)})"></span>` +
    `<span class="ticks ws">${[0, 4, 8, 11, 14, 20].map((v) => `<span style="left:${(v / 20) * 100}%">${v}${v === 20 ? "+" : ""}</span>`).join("")}</span></span>` +
    `<span class="muted">m/s</span>`;
  $("#err-legend").innerHTML =
    `<span class="label">${state.mode === "hour" ? "Forecast wind was" : "Forecast wind is typically"}</span>` +
    `<span class="err-scale"><span class="bar" style="background:linear-gradient(90deg,${grad(ERR_STOPS, -4, 4)})"></span>` +
    `<span class="ticks ws">${[-4, -2, 0, 2, 4].map((v) => `<span style="left:${((v + 4) / 8) * 100}%">${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v)}</span>`).join("")}</span>` +
    `<span class="ticks"><span>too weak</span><span>about right</span><span>too strong</span></span></span>` +
    `<span class="muted">m/s</span>`;
}

// ------------------------------------------------------------------ station panel

async function selectStation(fid) {
  state.station = fid;
  const st = IDX.stations[fid];
  $("#st-name").textContent = st.name;
  $("#st-note").textContent = `Wind speed measured vs. forecast ${bucketLabel(C.buckets[state.b])}, last two weeks. ${st.sea ? "Sea station." : st.lake ? "Lake station." : "Land station."}`;
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
  const q = new URLSearchParams(location.search);
  if (ZOOMS[q.get("zoom")]) state.zoom = q.get("zoom");
  C = IDX.config;
  F = Object.fromEntries(C.fields.map((k, i) => [k, i]));
  const upd = new Date(IDX.updated);
  const nSea = Object.values(IDX.stations).filter((s) => s.sea).length;
  $("#updated").textContent = `Last updated ${fmtDay.format(upd)} ${fmtHM.format(upd)} Finnish time · ` +
    `${Object.keys(IDX.stations).length} stations, ${nSea} at sea · ${IDX.hours.length} hours in the last two weeks`;
  if (!IDX.hours.length) return;
  state.i = IDX.hours.length - 1;
  // start with the source/age that has data for the latest hour
  const last = IDX.hours[state.i];
  if (!(last.leads.official || []).some(Boolean)) state.src = "meps";
  const firstB = (last.leads[state.src] || []).findIndex(Boolean);
  state.b = firstB >= 0 ? firstB : 0;
  chartDefaults();
  setupMaps();
  await loadSea().catch(() => {});
  setupControls();
  applyZoom();
  errLegend();
  refresh();
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { chartDefaults(); refresh(); });
}

main();
