// Raincheck page: shows per-hour forecast vs. radar maps produced by raincheck.py.
// Map images store rain *classes* as grey values (class * step); colours are applied here.

const $ = (s) => document.querySelector(s);
const RAIN = ["#ffffff", "#c6dbef", "#9ecae1", "#6baed6", "#4292c6", "#2171b5", "#08519c", "#08306b", "#041a3d"];
// stronger colours for rain drawn on top of the grey satellite picture
const RAIN_SAT = ["#ffffff", "#8fe3ff", "#4cc6ff", "#1ea2ff", "#1670f0", "#3a4fd8", "#6a2fc0", "#9a159e", "#c8007a"];
const CAT = { dry: "#ffffff", hit: "#009E73", miss: "#0072B2", fa: "#E69F00", nodata: "#e2e2e2" };
const WIND_GROUND = "#1d1d1f", WIND_GROUND_DARK = "#ffffff";   // measured at stations
const WIND_UPPER = "#e8590c", WIND_UPPER_DARK = "#ffa94d";     // model, ~3 km up
const PERIODS = { "7d": "Last 7 days", "30d": "Last 30 days", all: "Since the start" };
const HEL = (opts) => new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Helsinki", ...opts });
const fmtDay = HEL({ weekday: "short", day: "numeric", month: "numeric" });
const fmtHM = HEL({ hour: "2-digit", minute: "2-digit" });
const fmtShort = HEL({ weekday: "short", hour: "2-digit" });

let IDX, SUM, C;
const state = { i: 0, b: 0, thr: null, tol: 0, period: "7d", sat: false, wind: false };
try {
  state.sat = localStorage.getItem("raincheck.sat") === "1";
  state.wind = localStorage.getItem("raincheck.wind") === "1";
} catch (e) { /* storage blocked */ }
const urlParams = new URLSearchParams(location.search);
if (urlParams.has("sat")) state.sat = urlParams.get("sat") === "1";
if (urlParams.has("wind")) state.wind = urlParams.get("wind") === "1";
const classCache = new Map();
let hoursChart, leadChart, timer = null, drawToken = 0;

const tagDate = (t) => new Date(Date.UTC(+t.slice(0, 4), +t.slice(4, 6) - 1, +t.slice(6, 8), +t.slice(9, 11)));
const bucketLabel = ([lo, hi]) => `${lo}–${hi} h ahead`;
const pct = (v) => (v == null || isNaN(v) ? "–" : `${Math.round(v * 100)} %`);
const num = (v) => (v == null || isNaN(v) ? "–" : v.toFixed(2));
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function skill(v) {
  if (!v) return null;
  const [H, M, F, nf, no] = v;
  return {
    csi: H + M + F ? H / (H + M + F) : NaN,
    pod: H + M ? H / (H + M) : NaN,
    far: H + F ? F / (H + F) : NaN,
    bias: no ? nf / no : NaN,
  };
}
const combo = () => `${state.thr}|${state.tol}`;

// ------------------------------------------------------------------ image decoding

async function classesOf(url) {
  if (classCache.has(url)) return classCache.get(url);
  const p = (async () => {
    const img = new Image();
    img.src = url;
    await img.decode();
    const cv = document.createElement("canvas");
    cv.width = C.width; cv.height = C.height;
    const ctx = cv.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, C.width, C.height).data;
    const out = new Uint8Array(C.width * C.height);
    for (let i = 0; i < out.length; i++) out[i] = Math.round(d[i * 4] / C.step);
    return out;
  })();
  classCache.set(url, p);
  if (classCache.size > 80) classCache.delete(classCache.keys().next().value);
  return p;
}

// ------------------------------------------------------------------ verification (same rule as raincheck.py)

function dt1d(f, n, d, v, z) {
  let k = 0;
  v[0] = 0; z[0] = -Infinity; z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    let r = v[k];
    let s = (f[q] + q * q - (f[r] + r * r)) / (2 * q - 2 * r);
    while (s <= z[k]) {
      k--; r = v[k];
      s = (f[q] + q * q - (f[r] + r * r)) / (2 * q - 2 * r);
    }
    k++; v[k] = q; z[k] = s; z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
  }
}

// pixels within r (pixels) of any set pixel: exact Euclidean distance transform
function near(mask, r) {
  if (r <= 0 || !mask.includes(1)) return mask;
  const w = C.width, h = C.height, n = Math.max(w, h), BIG = 1e12;
  const g = new Float64Array(w * h);
  for (let i = 0; i < g.length; i++) g[i] = mask[i] ? 0 : BIG;
  const f = new Float64Array(n), d = new Float64Array(n), v = new Int32Array(n), z = new Float64Array(n + 1);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = g[y * w + x];
    dt1d(f, h, d, v, z);
    for (let y = 0; y < h; y++) g[y * w + x] = d[y];
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) f[x] = g[y * w + x];
    dt1d(f, w, d, v, z);
    for (let x = 0; x < w; x++) g[y * w + x] = d[x];
  }
  const out = new Uint8Array(w * h), r2 = r * r;
  for (let i = 0; i < out.length; i++) out[i] = g[i] <= r2 ? 1 : 0;
  return out;
}

function categorise(fc, obs) {
  const k = C.edges.indexOf(state.thr) + 1, N = fc.length;
  const valid = new Uint8Array(N), f = new Uint8Array(N), o = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    valid[i] = fc[i] !== C.nodata && obs[i] !== C.nodata ? 1 : 0;
    f[i] = valid[i] && fc[i] >= k ? 1 : 0;
    o[i] = valid[i] && obs[i] >= k ? 1 : 0;
  }
  const r = state.tol / C.pixel_km;
  const oNear = near(o, r), fNear = near(f, r);
  const cat = new Uint8Array(N); // 0 dry, 1 hit, 2 miss, 3 false alarm, 4 no data
  let H = 0, M = 0, F = 0, nf = 0, no = 0;
  for (let i = 0; i < N; i++) {
    if (!valid[i]) { cat[i] = 4; continue; }
    nf += f[i]; no += o[i];
    if ((f[i] && oNear[i]) || (o[i] && fNear[i])) { cat[i] = 1; H++; }
    else if (o[i]) { cat[i] = 2; M++; }
    else if (f[i]) { cat[i] = 3; F++; }
  }
  return { cat, s: skill([H, M, F, nf, no]) };
}

// ------------------------------------------------------------------ drawing

const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const RAIN_RGB = RAIN.map(rgb), RAIN_SAT_RGB = RAIN_SAT.map(rgb), NODATA_RGB = rgb(CAT.nodata);
const CAT_RGB = [CAT.dry, CAT.hit, CAT.miss, CAT.fa, CAT.nodata].map(rgb);

// colorOf returns [r,g,b] or [r,g,b,alpha]; with a satellite picture, values are drawn over it
function paint(canvas, values, colorOf, under = null) {
  canvas.width = C.width; canvas.height = C.height;
  const ctx = canvas.getContext("2d");
  let img;
  if (under) {
    ctx.drawImage(under, 0, 0, C.width, C.height);
    img = ctx.getImageData(0, 0, C.width, C.height);
  } else {
    img = ctx.createImageData(C.width, C.height);
  }
  const d = img.data;
  for (let i = 0; i < values.length; i++) {
    const c = colorOf(values[i]);
    const a = c.length > 3 ? c[3] : 1, j = i * 4;
    if (a === 0) continue;
    d[j] = d[j] * (1 - a) + c[0] * a; d[j + 1] = d[j + 1] * (1 - a) + c[1] * a;
    d[j + 2] = d[j + 2] * (1 - a) + c[2] * a; d[j + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
}
const rainColor = (k) => (k === C.nodata ? NODATA_RGB : RAIN_RGB[Math.min(k, RAIN_RGB.length - 1)]);
const SHADE = [0, 0, 0, 0.35], CLEAR = [0, 0, 0, 0];
const rainOverSat = (k) => (k === C.nodata ? SHADE : k === 0 ? CLEAR : RAIN_SAT_RGB[Math.min(k, RAIN_SAT_RGB.length - 1)]);

const satCache = new Map();
function satImage(h) {
  if (!satCache.has(h.t)) {
    const img = new Image();
    img.src = `h/${h.t}/sat.jpg`;
    satCache.set(h.t, img.decode().then(() => img).catch(() => null));
    if (satCache.size > 40) satCache.delete(satCache.keys().next().value);
  }
  return satCache.get(h.t);
}
const blank = (canvas) => paint(canvas, new Uint8Array(C.width * C.height), () => NODATA_RGB);

async function draw() {
  const token = ++drawToken;
  const h = IDX.hours[state.i];
  const end = tagDate(h.t), start = new Date(end - 3600e3);
  $("#hour-title").textContent = `Rain ${fmtDay.format(start)} ${fmtHM.format(start)}–${fmtHM.format(end)} (Finnish time)`;
  $("#hour").value = state.i;

  const lead = h.leads[state.b];
  const obs = await classesOf(`h/${h.t}/obs.png`);
  const fc = lead ? await classesOf(`h/${h.t}/b${state.b}.png`) : null;
  const sat = state.sat && h.sat ? await satImage(h) : null;
  const wind = state.wind ? await windAt(h.t) : null;
  if (token !== drawToken) return;
  drawWind(wind, !!sat);

  const rain = sat ? rainOverSat : rainColor;
  document.querySelectorAll(".map .bg").forEach((el, i) => {
    const src = sat && (i === 0 || (i === 1 && fc)) ? "map-dark.svg" : "map.svg";
    if (!el.src.endsWith(src)) el.src = src;
  });
  const extras = [];
  if (sat) extras.push(`clouds at ${fmtHM.format(new Date(h.sat))}`);
  else if (state.sat) extras.push("no satellite picture for this hour");
  if (wind) extras.push(`wind at ${fmtHM.format(end)}`);
  else if (state.wind) extras.push("no wind data for this hour");
  $("#obs-caption").textContent = `What actually fell (radar)${extras.length ? ", " + extras.join(", ") : ""}`;
  paint($("#c-obs"), obs, rain, sat);
  if (fc) {
    const origin = new Date(h.origins[state.b]);
    $("#fc-caption").textContent = `Forecast from the ${fmtHM.format(origin)} model run, ${lead} h before`;
    paint($("#c-fc"), fc, rain, sat);
    const { cat, s } = categorise(fc, obs);
    paint($("#c-cat"), cat, (c) => CAT_RGB[c]);
    const noRain = isNaN(s.csi);
    $("#t-csi").textContent = noRain ? "no rain" : num(s.csi);
    $("#t-pod").textContent = pct(s.pod);
    $("#t-far").textContent = pct(s.far);
    $("#t-bias").textContent = isNaN(s.bias) ? "–" : `×${s.bias.toFixed(2)}`;
  } else {
    $("#fc-caption").textContent = `No stored forecast made ${bucketLabel(C.buckets[state.b])} for this hour`;
    blank($("#c-fc")); blank($("#c-cat"));
    ["#t-csi", "#t-pod", "#t-far", "#t-bias"].forEach((s) => ($(s).textContent = "–"));
  }
  highlightHour();
}

// ------------------------------------------------------------------ charts

function chartDefaults() {
  Chart.defaults.color = css("--muted");
  Chart.defaults.borderColor = css("--grid");
  Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
}

function buildHoursChart() {
  const labels = IDX.hours.map((h) => { const t = tagDate(h.t); return `${fmtShort.format(t).split(",")[0]} ${fmtHM.format(t)}`; });
  const datasets = C.buckets.map((b, bi) => ({
    label: bucketLabel(b),
    data: IDX.hours.map((h) => { const s = skill(h.s[bi] && h.s[bi][combo()]); return s && !isNaN(s.csi) ? s.csi : null; }),
    spanGaps: false, tension: 0, pointHitRadius: 8,
  }));
  if (hoursChart) {
    hoursChart.data.datasets.forEach((d, i) => (d.data = datasets[i].data));
  } else {
    hoursChart = new Chart($("#ch-hours"), {
      type: "line",
      data: { labels, datasets },
      options: {
        maintainAspectRatio: false, animation: false,
        interaction: { mode: "nearest", axis: "x", intersect: false },
        scales: {
          y: { min: 0, max: 1, title: { display: true, text: "CSI (1 = perfect)" } },
          x: { ticks: { maxRotation: 0, autoSkipPadding: 18 }, grid: { display: false } },
        },
        plugins: {
          legend: { position: "bottom", labels: { boxWidth: 12, boxHeight: 2 } },
          tooltip: {
            callbacks: {
              title: (items) => { const t = tagDate(IDX.hours[items[0].dataIndex].t); return `${fmtDay.format(t)} ${fmtHM.format(new Date(t - 3600e3))}–${fmtHM.format(t)}`; },
              label: (it) => `${it.dataset.label}: CSI ${num(it.raw)}`,
            },
          },
        },
        onClick: (e, els, chart) => {
          const pts = chart.getElementsAtEventForMode(e, "nearest", { axis: "x", intersect: false }, false);
          if (pts.length) { state.i = pts[0].index; stop(); draw(); }
        },
      },
    });
  }
  styleHoursChart();
}

function styleHoursChart() {
  hoursChart.data.datasets.forEach((d, i) => {
    const on = i === state.b;
    d.borderColor = on ? css("--accent") : css("--other");
    d.backgroundColor = d.borderColor;
    d.borderWidth = on ? 2 : 1;
    d.order = on ? 0 : 1;
    d.pointRadius = (ctx) => (on && ctx.dataIndex === state.i ? 5 : on ? 1.5 : 0);
  });
  hoursChart.update();
}
const highlightHour = () => hoursChart && hoursChart.update();

function buildLeadChart() {
  const p = SUM[state.period];
  const rows = C.buckets.map((b, i) => ({ b, n: p.hours[i], s: skill(p.sums[i][combo()]) }));
  const since = p.since ? fmtDay.format(tagDate(p.since)) : null;
  $("#period-note").textContent = since
    ? `${PERIODS[state.period]} (data from ${since}). Each bar adds up every verified hour for that forecast age.`
    : "No verified hours yet.";
  const data = rows.map((r) => (r.s && !isNaN(r.s.csi) ? r.s.csi : null));
  if (leadChart) {
    leadChart.data.datasets[0].data = data;
    leadChart.data.datasets[0].backgroundColor = css("--accent");
    leadChart.update();
  } else {
    leadChart = new Chart($("#ch-lead"), {
      type: "bar",
      data: { labels: C.buckets.map(bucketLabel), datasets: [{ label: "CSI", data, backgroundColor: css("--accent"), borderRadius: 4, maxBarThickness: 56 }] },
      options: {
        maintainAspectRatio: false, animation: false,
        scales: { y: { min: 0, max: 1, title: { display: true, text: "CSI (1 = perfect)" } }, x: { grid: { display: false } } },
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: (it) => `CSI ${num(it.raw)}` } },
        },
      },
    });
  }
  $("#lead-table").innerHTML =
    "<tr><th>Forecast made</th><th>Hours</th><th>CSI</th><th>Rain forecast</th><th>False alarms</th><th>Area ×</th></tr>" +
    rows.map((r) => `<tr><td>${bucketLabel(r.b)}</td><td>${r.n}</td><td>${num(r.s && r.s.csi)}</td>` +
      `<td>${pct(r.s && r.s.pod)}</td><td>${pct(r.s && r.s.far)}</td><td>${num(r.s && r.s.bias)}</td></tr>`).join("");
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
    if (e.target.tagName === "SELECT") return;
    if (e.key === "ArrowLeft") { stop(); step(-1); }
    if (e.key === "ArrowRight") { stop(); step(1); }
  });

  segmented($("#bucket"), C.buckets.map((b, i) => [i, `${b[0]}–${b[1]} h`]), () => state.b,
    (v) => { state.b = v; styleHoursChart(); draw(); });
  segmented($("#period"), Object.entries(PERIODS), () => state.period, (v) => { state.period = v; buildLeadChart(); });

  const thr = $("#thr");
  thr.innerHTML = C.thresholds.map((t) => `<option value="${t}">≥ ${t} mm/h</option>`).join("");
  thr.onchange = () => { state.thr = +thr.value; refresh(); };
  const tol = $("#tol");
  tol.innerHTML = C.tolerances_km.map((t) => `<option value="${t}">${t ? `${t} km` : "none (exact)"}</option>`).join("");
  tol.onchange = () => { state.tol = +tol.value; refresh(); };
  const sat = $("#sat");
  sat.checked = state.sat;
  sat.onchange = () => {
    state.sat = sat.checked;
    try { localStorage.setItem("raincheck.sat", state.sat ? "1" : "0"); } catch (e) { /* storage blocked */ }
    rainLegend(); draw();
  };
  const wind = $("#wind");
  wind.checked = state.wind;
  wind.onchange = () => {
    state.wind = wind.checked;
    try { localStorage.setItem("raincheck.wind", state.wind ? "1" : "0"); } catch (e) { /* storage blocked */ }
    $("#wind-legend").hidden = !state.wind;
    draw();
  };
  $("#wind-legend").hidden = !state.wind;
}

function refresh() { buildHoursChart(); buildLeadChart(); draw(); }

// ------------------------------------------------------------------ measured wind arrows (from the wind tab's data)

let windIndex = null;
const windHours = new Map();
const getJSON = (u) => fetch(u).then((r) => (r.ok ? r.json() : null)).catch(() => null);

// measured ground wind (stations) and model wind at ~3 km (lattice) for the hour ending at t
async function windAt(t) {
  if (!windIndex) windIndex = getJSON("wind/index.json");
  const idx = await windIndex;
  if (!idx) return null;
  if (!windHours.has(t)) {
    windHours.set(t, Promise.all([getJSON(`wind/h/${t}.json`), getJSON(`wind/upper/${t}.json`)]));
    if (windHours.size > 60) windHours.delete(windHours.keys().next().value);
  }
  const [ground, upper] = await windHours.get(t);
  if (!ground && !upper) return null;
  return {
    ground: ground ? Object.entries(idx.stations).map(([fid, st]) => [st.px, st.py, ground.obs[fid]]) : [],
    upper: upper && idx.upper ? idx.upper.points.map(([x, y], i) => [x, y, upper.v[i]]) : [],
  };
}

function arrowPaths(list) {
  let d = "";
  for (const [x1, y1, v] of list) {
    if (!v || v[0] == null || v[1] == null || v[0] < 0.5) continue;
    const len = Math.min(v[0], 20) * 1.6, a = ((v[1] + 180) * Math.PI) / 180;  // points downwind
    const x2 = x1 + Math.sin(a) * len, y2 = y1 - Math.cos(a) * len;
    const back = Math.atan2(y1 - y2, x1 - x2), hs = Math.max(len * 0.3, 2.4);
    const p1 = `${x2 + hs * Math.cos(back + 0.45)},${y2 + hs * Math.sin(back + 0.45)}`;
    const p2 = `${x2 + hs * Math.cos(back - 0.45)},${y2 + hs * Math.sin(back - 0.45)}`;
    d += `M${x1},${y1}L${x2},${y2}M${p1}L${x2},${y2}L${p2}`;
  }
  return d;
}

// arrows point where the wind blows to; length grows with speed
function drawWind(wind, dark) {
  const svg = $("#obs-wind");
  svg.replaceChildren();
  if (!wind) return;
  const halo = dark ? "rgba(0,0,0,0.65)" : "rgba(255,255,255,0.9)";
  const layer = (d, color, w) => d ? `<path d="${d}" stroke="${halo}" stroke-width="${w + 1.8}" fill="none" stroke-linecap="round" stroke-linejoin="round"/>` +
    `<path d="${d}" stroke="${color}" stroke-width="${w}" fill="none" stroke-linecap="round" stroke-linejoin="round"/>` : "";
  svg.innerHTML = layer(arrowPaths(wind.ground), dark ? WIND_GROUND_DARK : WIND_GROUND, 1.1) +
    layer(arrowPaths(wind.upper), dark ? WIND_UPPER_DARK : WIND_UPPER, 1.8);
}

function rainLegend() {
  const labels = ["", ...C.edges.map(String)];
  const colors = (state.sat ? RAIN_SAT : RAIN).slice(1);
  $("#rain-legend .ramp")?.remove();
  $("#rain-legend").insertAdjacentHTML("beforeend",
    `<span class="ramp">${colors.map((c, i) => `<span><i style="background:${c}"></i>${labels[i + 1]}</span>`).join("")}</span>`);
  $("#sat-legend").hidden = !state.sat;
}

async function main() {
  try {
    [IDX, SUM] = await Promise.all(["index.json", "summary.json"].map((u) => fetch(u, { cache: "no-cache" }).then((r) => r.json())));
  } catch (e) {
    $("#updated").textContent = "No data yet: the first hourly run hasn't finished.";
    return;
  }
  C = IDX.config;
  state.thr = C.thresholds[0];
  const upd = new Date(IDX.updated);
  $("#updated").textContent = `Last updated ${fmtDay.format(upd)} ${fmtHM.format(upd)} Finnish time · ${IDX.hours.length} hours in the last two weeks`;
  if (!IDX.hours.length) return;
  state.i = IDX.hours.length - 1;
  chartDefaults();
  setupControls();
  rainLegend();
  refresh();
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { chartDefaults(); styleHoursChart(); buildLeadChart(); });
}

main();
