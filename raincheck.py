#!/usr/bin/env python3
"""
raincheck - how well did the rain forecasts come true?

Run hourly (GitHub Actions does this). Each run:
  1. stores any new FMI MEPS forecast runs (only the newest ~2 runs are ever
     online, so old forecasts must be saved while they exist),
  2. compares every stored forecast with the FMI radar for each finished hour,
  3. writes small per-hour images + scores that the static web page in web/ shows.

Usage:
  raincheck.py update               # collect + verify + prune  (the hourly job)
  raincheck.py build-site _site     # combine web/ and the data into a deployable site

Data (default ./data, or $RAINCHECK_DATA):
  forecasts/meps_<origin>.npz   raw forecasts, deleted once fully verified
  scores/<YYYY-MM>.json         per-hour results, kept forever
  site/                         what gets published (images for the last 14 days, json)
"""

import datetime as dt
import json
import os
import re
import shutil
import sys
import time
import warnings
from pathlib import Path

warnings.filterwarnings("ignore", message="urllib3 v2")

import numpy as np
import requests
import rasterio
from PIL import Image
from rasterio.transform import from_bounds
from rasterio.warp import Resampling, reproject, transform, transform_geom
from scipy import ndimage

UTC = dt.timezone.utc
ROOT = Path(__file__).resolve().parent
DATA = Path(os.environ.get("RAINCHECK_DATA", ROOT / "data"))
FC_DIR = DATA / "forecasts"
SCORES_DIR = DATA / "scores"
SITE = DATA / "site"
WEB = ROOT / "web"

WFS = "https://opendata.fmi.fi/wfs"
RADAR_WMS = "https://openwms.fmi.fi/geoserver/Radar/wms"
BORDERS_URL = ("https://raw.githubusercontent.com/nvkelso/natural-earth-vector/"
               "master/geojson/ne_50m_admin_0_countries.geojson")

# Verification grid: FMI radar composite extent in ETRS-TM35FIN, ~2.3 km pixels
# (close to the 2.5 km resolution of the MEPS model).
CRS = "EPSG:3067"
BOUNDS = (-118331.366, 6335621.167, 875567.732, 7907751.537)  # left, bottom, right, top
WIDTH, HEIGHT = 425, 673
TRANSFORM = from_bounds(*BOUNDS, WIDTH, HEIGHT)
PIXEL_KM = (BOUNDS[2] - BOUNDS[0]) / WIDTH / 1000

# Rain is stored as intensity classes; class k means "at least EDGES[k-1] mm in the hour".
# The page decodes these, so keep EDGES / NODATA_CLASS / CLASS_STEP in sync with web/app.js.
EDGES = [0.1, 0.3, 0.5, 1, 2, 5, 10, 30]
NODATA_CLASS = 15
CLASS_STEP = 16                     # png grey value = class * CLASS_STEP
THRESHOLDS = [0.1, 0.5, 2]          # mm/h counted as rain; each must be in EDGES
TOLERANCES_KM = [0, 10, 25]         # forgive position errors up to this distance
BUCKETS = [(1, 3), (4, 6), (7, 12), (13, 24), (25, 48)]  # forecast age groups, hours

MAX_LEAD = 48           # hours of each forecast run that are kept
LOOKBACK_HOURS = 48     # hours checked on each run (covers missed hourly runs)
REDO_HOURS = 8          # recent hours are redone when a late-published forecast run appears
KEEP_IMAGE_DAYS = 14    # map images on the site; scores are kept forever

RADAR_NODATA = 65535
RADAR_SCALE = 0.01      # radar GeoTIFF values are 0.01 mm


def log(*a):
    print(*a, flush=True)


def iso(t):
    return t.strftime("%Y-%m-%dT%H:%M:%SZ")


def tag(t):
    return t.strftime("%Y%m%dT%H%MZ")


def from_tag(s):
    return dt.datetime.strptime(s, "%Y%m%dT%H%MZ").replace(tzinfo=UTC)


def floor_hour(t):
    return t.replace(minute=0, second=0, microsecond=0)


def http_get(url, params=None, timeout=180, tries=3):
    for i in range(tries):
        try:
            r = requests.get(url, params=params, timeout=timeout)
            r.raise_for_status()
            return r.content
        except requests.RequestException:
            if i == tries - 1:
                raise
            time.sleep(5 * (i + 1))


# ---------------------------------------------------------------------------- forecasts

def available_runs():
    """{origintime: download url} for the MEPS runs FMI has online right now."""
    xml = http_get(WFS, {
        "service": "WFS", "version": "2.0.0", "request": "getFeature",
        "storedquery_id": "fmi::forecast::meps::surface::grid",
        "parameters": "Precipitation1h", "bbox": "18,58.5,33,71",
    }).decode()
    runs = {}
    for ref in re.findall(r"<gml:fileReference>([^<]+)</gml:fileReference>", xml):
        url = ref.replace("&amp;", "&")
        m = re.search(r"origintime=(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ)", url)
        if m:
            origin = dt.datetime.strptime(m.group(1), "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=UTC)
            runs[origin] = url
    return runs


def fc_path(origin):
    return FC_DIR / f"meps_{tag(origin)}.npz"


def fetch_run(origin, url):
    """Download one run (GeoTIFF, one band per hour) onto the verification grid."""
    url = re.sub(r"format=[^&]+", "format=geotiff", url)
    url = re.sub(r"starttime=[^&]+", "starttime=" + iso(origin + dt.timedelta(hours=1)), url)
    url = re.sub(r"endtime=[^&]+", "endtime=" + iso(origin + dt.timedelta(hours=MAX_LEAD)), url)
    raw = http_get(url, timeout=600)
    valid, fields, mm = [], [], []
    with rasterio.MemoryFile(raw) as mf, mf.open() as src:
        for band in range(1, src.count + 1):
            t = dt.datetime.strptime(src.tags(band)["TIME"], "%Y%m%dT%H%M%S").replace(tzinfo=UTC)
            a = src.read(band).astype(np.float32)
            a[a == src.nodata] = np.nan
            a *= 3600.0  # kg m-2 s-1 -> mm per hour
            dst = np.full((HEIGHT, WIDTH), np.nan, np.float32)
            reproject(a, dst, src_transform=src.transform, src_crs=src.crs,
                      dst_transform=TRANSFORM, dst_crs=CRS, src_nodata=np.nan,
                      dst_nodata=np.nan, resampling=Resampling.bilinear)
            valid.append(int(t.timestamp()))
            mm.append(dst)
            fields.append(np.where(np.isnan(dst), RADAR_NODATA,
                                   np.clip(np.round(dst / RADAR_SCALE), 0, 65000)).astype(np.uint16))
    FC_DIR.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(fc_path(origin), valid=np.array(valid), rr=np.stack(fields))
    import archive
    archive.rain_run(origin, valid, np.stack(mm))
    return len(valid)


def collect(runs):
    for origin in sorted(runs):
        if fc_path(origin).exists():
            continue
        try:
            n = fetch_run(origin, runs[origin])
            log(f"stored forecast run {iso(origin)} ({n} h)")
        except Exception as e:
            log(f"forecast run {iso(origin)} failed: {e}")


def stored_runs():
    return sorted(from_tag(p.stem[5:]) for p in FC_DIR.glob("meps_*.npz"))


def forecasts_for(t, runs, cache):
    """{lead hours: (mm field, origin)} of all stored forecasts valid at hour t."""
    out = {}
    for origin in runs:
        lead = int((t - origin).total_seconds() // 3600)
        if not 1 <= lead <= MAX_LEAD:
            continue
        if origin not in cache:
            z = np.load(fc_path(origin))
            cache[origin] = (list(z["valid"]), z["rr"])
        valid, rr = cache[origin]
        ts = int(t.timestamp())
        if ts in valid:
            raw = rr[valid.index(ts)]
            mm = raw.astype(np.float32) * RADAR_SCALE
            mm[raw == RADAR_NODATA] = np.nan
            out[lead] = (mm, origin)
    return out


# ---------------------------------------------------------------------------- radar

def fetch_obs(t):
    """Radar 1 h precipitation (mm) for the hour ending at t; NaN outside coverage."""
    raw = http_get(RADAR_WMS, {
        "service": "WMS", "version": "1.3.0", "request": "GetMap",
        "layers": "Radar:suomi_rr1h_eureffin", "styles": "raster",
        "bbox": ",".join(map(str, BOUNDS)), "crs": CRS,
        "format": "image/geotiff", "time": iso(t), "width": WIDTH, "height": HEIGHT,
    })
    if not raw.startswith((b"II*", b"MM\0*")):
        raise RuntimeError("radar not available yet")
    with rasterio.MemoryFile(raw) as mf, mf.open() as src:
        a = src.read(1)
    if (a != RADAR_NODATA).sum() == 0:
        raise RuntimeError("radar image empty")
    mm = a.astype(np.float32) * RADAR_SCALE
    mm[a == RADAR_NODATA] = np.nan
    return mm


# ---------------------------------------------------------------------------- satellite

SAT_WMS = "https://view.eumetsat.int/geoserver/ows"
SAT_LAYER = "mtg_fd:ir105_hrfi"   # Meteosat Third Generation, infrared 10.5 µm, every 10 min
CTH_LAYER = "msg_fes:cth"         # Meteosat cloud top height, every 15 min, used for parallax
# The cloud top height layer is only available as a coloured picture; its colour scale is read
# from the layer's legend image, where the 320 m and 16000 m ticks sit at these x positions.
CTH_LEGEND_ROW, CTH_LEGEND_X0, CTH_LEGEND_X1 = 25, 150, 628
CTH_TICK_320, CTH_TICK_16000 = 148.5, 634.5
SAT_ORBIT_KM = 35786.0 + 6371.0   # geostationary satellite at 0° longitude, from Earth centre
EARTH_KM = 6371.0
_sat_geometry = None


def sat_wms(layer, t, fmt="image/geotiff"):
    return http_get(SAT_WMS, {
        "service": "WMS", "version": "1.3.0", "request": "GetMap", "layers": layer, "styles": "",
        "crs": CRS, "bbox": ",".join(map(str, BOUNDS)), "width": WIDTH, "height": HEIGHT,
        "format": fmt, "time": iso(t),
    })


def cloud_top_height_km(t):
    """Cloud top height (km) per grid pixel, 0 where the sky is clear."""
    legend_path = DATA / "cth_legend.png"
    if not legend_path.exists():
        DATA.mkdir(parents=True, exist_ok=True)
        legend_path.write_bytes(http_get(SAT_WMS, {
            "service": "WMS", "version": "1.3.0", "request": "GetLegendGraphic",
            "format": "image/png", "width": 640, "height": 80, "layer": CTH_LAYER}))
    legend = np.asarray(Image.open(legend_path).convert("RGBA"))[..., :3].astype(int)
    xs = np.arange(CTH_LEGEND_X0, CTH_LEGEND_X1)
    colors = legend[CTH_LEGEND_ROW, xs]
    heights = 0.32 + (xs - CTH_TICK_320) * (16.0 - 0.32) / (CTH_TICK_16000 - CTH_TICK_320)

    with rasterio.MemoryFile(sat_wms(CTH_LAYER, t)) as mf, mf.open() as src:
        rgb = np.moveaxis(src.read(), 0, -1).reshape(-1, 3).astype(int)
    uniq, inv = np.unique(rgb, axis=0, return_inverse=True)
    dist = ((uniq[:, None, :] - colors[None, :, :]) ** 2).sum(-1)
    h = heights[dist.argmin(1)]
    h[(uniq == 255).all(1)] = 0.0   # white = no cloud
    return h[inv.ravel()].reshape(HEIGHT, WIDTH)


def sat_geometry():
    """Grid pixel centres as 3-D points on a spherical Earth (km), computed once."""
    global _sat_geometry
    if _sat_geometry is None:
        xs = BOUNDS[0] + (np.arange(WIDTH) + 0.5) * (BOUNDS[2] - BOUNDS[0]) / WIDTH
        ys = BOUNDS[3] - (np.arange(HEIGHT) + 0.5) * (BOUNDS[3] - BOUNDS[1]) / HEIGHT
        X, Y = np.meshgrid(xs, ys)
        lon, lat = transform(CRS, "EPSG:4326", X.ravel(), Y.ravel())
        lon, lat = np.radians(lon), np.radians(lat)
        P = EARTH_KM * np.stack([np.cos(lat) * np.cos(lon), np.cos(lat) * np.sin(lon), np.sin(lat)], 1)
        _sat_geometry = P
    return _sat_geometry


def parallax_correct(img, h_km):
    """Move each cloud pixel to where the cloud really is.

    The satellite sees a cloud top along its line of sight, so on the map the cloud
    appears where that line meets the ground: seen from the equator, a 10 km high
    cloud over Finland shows up ~35 km too far north. For each pixel we find where
    the line of sight crosses the cloud-top height and put the pixel below that point.
    Higher clouds are drawn last (they hide what is below); uncovered gaps are filled
    from the nearest pixel.
    """
    P = sat_geometry()
    S = np.array([SAT_ORBIT_KM, 0.0, 0.0])
    D = P - S
    h = h_km.ravel()
    a = (D * D).sum(1)
    b = 2 * (D @ S)
    c = S @ S - (EARTH_KM + h) ** 2
    t = (-b - np.sqrt(np.maximum(b * b - 4 * a * c, 0))) / (2 * a)   # first crossing from the satellite
    C = S + t[:, None] * D
    lat = np.degrees(np.arcsin(C[:, 2] / np.linalg.norm(C, axis=1)))
    lon = np.degrees(np.arctan2(C[:, 1], C[:, 0]))
    x, y = transform("EPSG:4326", CRS, lon, lat)
    col = np.floor((np.asarray(x) - BOUNDS[0]) / (BOUNDS[2] - BOUNDS[0]) * WIDTH).astype(int)
    row = np.floor((BOUNDS[3] - np.asarray(y)) / (BOUNDS[3] - BOUNDS[1]) * HEIGHT).astype(int)
    inside = (col >= 0) & (col < WIDTH) & (row >= 0) & (row < HEIGHT)

    src = np.flatnonzero(inside)
    src = src[np.argsort(h[src], kind="stable")]           # low clouds first, high ones last
    dst = row[src] * WIDTH + col[src]
    last = len(dst) - 1 - np.unique(dst[::-1], return_index=True)[1]   # keep the highest per target
    out = np.full(HEIGHT * WIDTH, -1, np.int32)
    out[dst[last]] = img.ravel()[src[last]]
    out = out.reshape(HEIGHT, WIDTH)
    holes = out < 0
    if holes.any():
        iy, ix = ndimage.distance_transform_edt(holes, return_distances=False, return_indices=True)
        out = out[iy, ix]
    return out.astype(img.dtype)


def save_satellite(t, path):
    """Parallax-corrected infrared picture from the middle of the hour ending at t."""
    when = t - dt.timedelta(minutes=30)
    with rasterio.MemoryFile(sat_wms(SAT_LAYER, when)) as mf, mf.open() as src:
        counts = src.read(1)
    if (counts > 0).mean() < 0.5:
        raise RuntimeError("satellite image not available")
    corrected = parallax_correct(counts, cloud_top_height_km(when))
    # counts rise with temperature: warm ground dark grey, cold (high) cloud tops white
    g = np.clip((236.0 - corrected) / (236.0 - 150.0), 0, 1)
    Image.fromarray((40 + g * 215).astype(np.uint8)).save(path, quality=82, optimize=True)
    return iso(when)


# ---------------------------------------------------------------------------- scoring

def classify(mm):
    cls = np.searchsorted(EDGES, np.nan_to_num(mm), side="right").astype(np.uint8)
    cls[np.isnan(mm)] = NODATA_CLASS
    return cls


def save_classes(cls, path):
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray((cls * CLASS_STEP).astype(np.uint8)).save(path, optimize=True)


def near(mask, r_px):
    """Pixels within r_px of any True pixel (same rule as web/app.js)."""
    if r_px <= 0 or not mask.any():
        return mask
    return ndimage.distance_transform_edt(~mask) <= r_px


def scores(fc_cls, obs_cls):
    """{"thr|tol": [hits, misses, false alarms, forecast rain px, observed rain px]}."""
    valid = (fc_cls != NODATA_CLASS) & (obs_cls != NODATA_CLASS)
    out = {}
    for thr in THRESHOLDS:
        k = EDGES.index(thr) + 1
        f = (fc_cls >= k) & valid
        o = (obs_cls >= k) & valid
        for tol in TOLERANCES_KM:
            r = tol / PIXEL_KM
            o_near, f_near = near(o, r), near(f, r)
            hit = (f & o_near) | (o & f_near)
            out[f"{thr}|{tol}"] = [int(hit.sum()), int((o & ~f_near).sum()),
                                   int((f & ~o_near).sum()), int(f.sum()), int(o.sum())]
    return out


# ---------------------------------------------------------------------------- results store

def load_metas():
    metas = {}
    for p in sorted(SCORES_DIR.glob("*.json")):
        metas.update(json.loads(p.read_text()))
    return metas


def save_metas(metas):
    months = {}
    for k, m in metas.items():
        months.setdefault(k[:4] + "-" + k[4:6], {})[k] = m
    SCORES_DIR.mkdir(parents=True, exist_ok=True)
    for month, ms in months.items():
        (SCORES_DIR / f"{month}.json").write_text(json.dumps(dict(sorted(ms.items())),
                                                             separators=(",", ":")))


def pick_leads(fcs):
    """Youngest forecast in each age bucket (None if that bucket has none)."""
    out = []
    for lo, hi in BUCKETS:
        ls = [l for l in fcs if lo <= l <= hi]
        out.append(min(ls) if ls else None)
    return out


def verify(now):
    runs = stored_runs()
    metas = load_metas()
    cache = {}
    latest = floor_hour(now - dt.timedelta(minutes=15))
    for i in range(LOOKBACK_HOURS - 1, -1, -1):
        t = latest - dt.timedelta(hours=i)
        key = tag(t)
        fcs = forecasts_for(t, runs, cache)
        leads = pick_leads(fcs)
        if not any(leads):
            continue
        old = metas.get(key)
        if old and (old["leads"] == leads or i > REDO_HOURS):
            continue
        try:
            obs = fetch_obs(t)
        except Exception as e:
            log(f"{iso(t)}: radar: {e}")
            continue
        import archive
        archive.rain_obs(t, obs)
        obs_cls = classify(obs)
        hour_dir = SITE / "h" / key
        save_classes(obs_cls, hour_dir / "obs.png")
        meta = {"leads": leads, "origins": [], "obs_mm": round(float(np.nanmean(obs)), 3), "s": [],
                "sat": old.get("sat") if old else None}
        for b, lead in enumerate(leads):
            if lead is None:
                meta["origins"].append(None)
                meta["s"].append(None)
                (hour_dir / f"b{b}.png").unlink(missing_ok=True)
                continue
            mm, origin = fcs[lead]
            fc_cls = classify(mm)
            save_classes(fc_cls, hour_dir / f"b{b}.png")
            meta["origins"].append(iso(origin))
            meta["s"].append(scores(fc_cls, obs_cls))
        metas[key] = meta
        log(f"{iso(t)}: verified, forecast ages {[l for l in leads if l]} h")

    # satellite picture for each verified hour (also fills in hours where it failed before)
    for i in range(LOOKBACK_HOURS):
        t = latest - dt.timedelta(hours=i)
        meta = metas.get(tag(t))
        hour_dir = SITE / "h" / tag(t)
        if meta and not meta.get("sat") and (hour_dir / "obs.png").exists():
            try:
                meta["sat"] = save_satellite(t, hour_dir / "sat.jpg")
            except Exception as e:
                log(f"{iso(t)}: satellite: {e}")
    save_metas(metas)
    return metas


def prune(now, metas):
    for origin in stored_runs():
        if origin + dt.timedelta(hours=MAX_LEAD + REDO_HOURS + 2) < now:
            fc_path(origin).unlink()
            log(f"removed verified forecast run {iso(origin)}")
    cutoff = now - dt.timedelta(days=KEEP_IMAGE_DAYS)
    for d in (SITE / "h").glob("*"):
        if from_tag(d.name) < cutoff:
            shutil.rmtree(d)


def write_site_json(now, metas):
    SITE.mkdir(parents=True, exist_ok=True)
    cutoff = now - dt.timedelta(days=KEEP_IMAGE_DAYS)
    hours = [{"t": k, **m} for k, m in sorted(metas.items())
             if from_tag(k) >= cutoff and (SITE / "h" / k / "obs.png").exists()]
    config = {"edges": EDGES, "nodata": NODATA_CLASS, "step": CLASS_STEP,
              "thresholds": THRESHOLDS, "tolerances_km": TOLERANCES_KM,
              "buckets": BUCKETS, "pixel_km": PIXEL_KM, "width": WIDTH, "height": HEIGHT}
    (SITE / "index.json").write_text(json.dumps(
        {"updated": iso(now), "config": config, "hours": hours}, separators=(",", ":")))

    # long-term totals per forecast age, for several look-back periods
    periods = {"7d": now - dt.timedelta(days=7), "30d": now - dt.timedelta(days=30),
               "all": dt.datetime(1970, 1, 1, tzinfo=UTC)}
    summary = {}
    for name, since in periods.items():
        sums = [dict() for _ in BUCKETS]
        n = [0] * len(BUCKETS)
        first = None
        for k, m in metas.items():
            if from_tag(k) < since:
                continue
            first = min(first or k, k)
            for b, s in enumerate(m["s"]):
                if s is None:
                    continue
                n[b] += 1
                for combo, v in s.items():
                    acc = sums[b].setdefault(combo, [0] * len(v))
                    for j, x in enumerate(v):
                        acc[j] += x
        summary[name] = {"hours": n, "sums": sums, "since": first}
    (SITE / "summary.json").write_text(json.dumps(summary, separators=(",", ":")))


def write_map_svg():
    """Map overlay (country borders, a few towns) in grid pixel coordinates.

    map.svg is for the normal light maps, map-dark.svg for maps over the satellite picture.
    """
    if (SITE / "map-dark.svg").exists():
        return
    res_x = (BOUNDS[2] - BOUNDS[0]) / WIDTH
    res_y = (BOUNDS[3] - BOUNDS[1]) / HEIGHT

    def px(x, y):
        return (x - BOUNDS[0]) / res_x, (BOUNDS[3] - y) / res_y

    gj = json.loads(http_get(BORDERS_URL, timeout=120))
    paths = []
    for feat in gj["features"]:
        if feat["properties"].get("ISO_A3") not in ("FIN", "SWE", "NOR", "EST", "RUS", "LVA"):
            continue
        g = transform_geom("EPSG:4326", CRS, feat["geometry"])
        polys = g["coordinates"] if g["type"] == "MultiPolygon" else [g["coordinates"]]
        for poly in polys:
            for ring in poly:
                pts = [px(x, y) for x, y in ring]
                if not any(-50 < a < WIDTH + 50 and -50 < b < HEIGHT + 50 for a, b in pts):
                    continue
                paths.append("M" + "L".join(f"{a:.1f},{b:.1f}" for a, b in pts) + "Z")
    towns = {"Helsinki": (24.94, 60.17), "Turku": (22.27, 60.45), "Tampere": (23.76, 61.50),
             "Pori": (21.80, 61.48), "Vaasa": (21.62, 63.10), "Oulu": (25.47, 65.01),
             "Rovaniemi": (25.73, 66.50), "Jyväskylä": (25.75, 62.24), "Kuopio": (27.68, 62.89),
             "Joensuu": (29.76, 62.60), "Lappeenranta": (28.19, 61.06), "Kajaani": (27.73, 64.23),
             "Ivalo": (27.54, 68.66)}
    xs, ys = transform("EPSG:4326", CRS, [v[0] for v in towns.values()], [v[1] for v in towns.values()])
    marks = []
    for name, x, y in zip(towns, xs, ys):
        a, b = px(x, y)
        marks.append(f'<circle cx="{a:.1f}" cy="{b:.1f}" r="1.6"/>'
                     f'<text x="{a + 3:.1f}" y="{b + 3:.1f}">{name}</text>')
    for name, line, text, halo in (("map.svg", "#444", "#222", "#fff"),
                                   ("map-dark.svg", "#f2f2f2", "#fff", "#000")):
        (SITE / name).write_text(
            f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {WIDTH} {HEIGHT}">'
            f'<path d="{"".join(paths)}" fill="none" stroke="{line}" stroke-width="0.6" '
            f'stroke-opacity="0.85" stroke-linejoin="round"/>'
            f'<g fill="{text}" font-family="system-ui,sans-serif" font-size="9" '
            f'paint-order="stroke" stroke="{halo}" stroke-width="2">{"".join(marks)}</g></svg>')


# ---------------------------------------------------------------------------- commands

def cmd_update():
    now = dt.datetime.now(UTC)
    try:
        runs = available_runs()
    except Exception as e:
        log(f"forecast list unavailable: {e}")
        runs = {}
    collect(runs)
    metas = verify(now)
    prune(now, metas)
    write_site_json(now, metas)
    try:
        write_map_svg()
    except Exception as e:
        log(f"map background failed (retried next run): {e}")

    import wind  # the wind part must never stop the rain part from publishing
    try:
        wind.update(now)
    except Exception as e:
        log(f"wind update failed: {e!r}")

    import archive
    archive.pack(now)


def cmd_build_site(out):
    out = Path(out)
    if out.exists():
        shutil.rmtree(out)
    shutil.copytree(WEB, out)
    if SITE.exists():
        shutil.copytree(SITE, out, dirs_exist_ok=True)
    # give scripts and styles a content-based version so browsers never mix old and new files
    import hashlib
    assets = [f for f in WEB.iterdir() if f.suffix in (".js", ".css")]
    for page in out.glob("*.html"):
        html = page.read_text()
        for f in assets:
            version = hashlib.sha1(f.read_bytes()).hexdigest()[:10]
            html = html.replace(f'"{f.name}"', f'"{f.name}?v={version}"')
        page.write_text(html)
    log(f"site written to {out}")


def main():
    if len(sys.argv) >= 2 and sys.argv[1] == "update":
        cmd_update()
    elif len(sys.argv) == 3 and sys.argv[1] == "build-site":
        cmd_build_site(sys.argv[2])
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main()
