"""
Wind part of raincheck: how well did the wind forecasts come true at FMI weather stations?

Wind has no radar, so the truth is what the stations measured. Each hourly run:
  1. stores the newest FMI official (edited) forecast and any new MEPS model run at every
     wind station (both services only keep their latest forecasts online),
  2. compares stored forecasts with the station observations for each finished hour,
  3. writes per-hour station values, scores and per-station series for web/wind.html.

Called from `raincheck.py update`.
"""

import datetime as dt
import json
import re
import shutil

import numpy as np
from PIL import Image
from rasterio import features
from rasterio.transform import from_bounds
from rasterio.warp import Resampling, reproject, transform

import raincheck as rc
from raincheck import UTC, from_tag, http_get, iso, log, tag

WIND = rc.DATA / "wind"
STATIONS_FILE = WIND / "stations.json"
SCORES_DIR = WIND / "scores"
SITE = rc.SITE / "wind"

SOURCES = {"official": "FMI official forecast", "meps": "MEPS weather model"}
BUCKETS = rc.BUCKETS
THRESHOLDS = [8, 11, 14]      # mean wind (m/s) that counts as "windy" for hit/miss counts
NEAR_MS = 2.0                 # forecast "about right" if within this many m/s
DIR_MIN_MS = 3.0              # direction is only compared when both winds are at least this
STATION_SETS = ["sea", "all"]
SEA_SCALE = 2                 # sea mask is drawn at twice the rain grid resolution (~1.2 km)
SEA_STATION_KM = 3.0          # a "sea" station is on water and within this distance of open sea
LAND_URLS = ["https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_land.geojson",
             "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_minor_islands.geojson"]
OBS_BBOX = "19,59.4,32,70.2"
STATION_REFRESH_DAYS = 7

# Score vector per hour, forecast age and station set; the page reads these names.
FIELDS = ["n", "abs", "err", "near", "n_dir", "abs_dir", "n_gust", "abs_gust", "err_gust"] + \
    [f"{k}{t}" for t in THRESHOLDS for k in ("hit", "miss", "fa")]


def fc_file(source, origin):
    return rc.FC_DIR / f"wind_{source}_{tag(origin)}.npz"


def stored(source):
    return sorted(from_tag(p.stem.split("_")[-1]) for p in rc.FC_DIR.glob(f"wind_{source}_*.npz"))


# ---------------------------------------------------------------------------- FMI xml

def parse_multipoint(xml):
    """FMI multipointcoverage response -> ({(lat, lon): fmisid or None}, [((lat, lon), epoch, values)])."""
    ids = {}
    for m in re.finditer(r'<gml:Point gml:id="point-(\d+)"[^>]*>.*?<gml:pos>([^<]+)</gml:pos>', xml, re.S):
        lat, lon = map(float, m.group(2).split()[:2])
        ids[(round(lat, 3), round(lon, 3))] = m.group(1)
    names = {}
    for m in re.finditer(r'stationcode/fmisid">(\d+)<.*?locationcode/name">([^<]+)<', xml, re.S):
        names[m.group(1)] = m.group(2)
    pos = re.search(r"<gmlcov:positions>(.*?)</gmlcov:positions>", xml, re.S)
    vals = re.search(r"<gml:doubleOrNilReasonTupleList>(.*?)</gml:doubleOrNilReasonTupleList>", xml, re.S)
    if not pos or not vals:
        return ids, names, []
    p = pos.group(1).split()
    rows = [l.split() for l in vals.group(1).strip().splitlines()]
    out = []
    for i, r in enumerate(rows):
        key = (round(float(p[3 * i]), 3), round(float(p[3 * i + 1]), 3))
        out.append((key, int(p[3 * i + 2]), [float(v) for v in r]))
    return ids, names, out


# ---------------------------------------------------------------------------- stations

def load_stations():
    return json.loads(STATIONS_FILE.read_text()) if STATIONS_FILE.exists() else {}


def save_stations(st):
    WIND.mkdir(parents=True, exist_ok=True)
    STATIONS_FILE.write_text(json.dumps(st, ensure_ascii=False, indent=0))


def grid_px(lat, lon):
    x, y = transform("EPSG:4326", rc.CRS, [lon], [lat])
    return (round((x[0] - rc.BOUNDS[0]) / (rc.BOUNDS[2] - rc.BOUNDS[0]) * rc.WIDTH, 1),
            round((rc.BOUNDS[3] - y[0]) / (rc.BOUNDS[3] - rc.BOUNDS[1]) * rc.HEIGHT, 1))


def ensure_stations(now):
    st = load_stations()
    fresh = STATIONS_FILE.exists() and \
        dt.datetime.fromtimestamp(STATIONS_FILE.stat().st_mtime, UTC) > now - dt.timedelta(days=STATION_REFRESH_DAYS)
    if st and fresh:
        return st
    xml = http_get(rc.WFS, {
        "service": "WFS", "version": "2.0.0", "request": "getFeature",
        "storedquery_id": "fmi::observations::weather::multipointcoverage", "bbox": OBS_BBOX,
        "parameters": "windspeedms", "timestep": 60,
        "starttime": iso(now - dt.timedelta(hours=3)), "endtime": iso(now)}).decode()
    ids, names, rows = parse_multipoint(xml)
    has_wind = {k for k, _, v in rows if not np.isnan(v[0])}
    for key, fid in ids.items():
        if key not in has_wind or fid in st:
            continue
        px, py = grid_px(*key)
        st[fid] = {"name": names.get(fid, fid), "lat": key[0], "lon": key[1], "px": px, "py": py, "water": None}
    save_stations(st)
    log(f"wind stations: {len(st)}")
    return st


def sea_mask():
    """Boolean sea mask on the (SEA_SCALE x finer) map grid; lakes count as land."""
    path = WIND / "sea.png"
    if not path.exists():
        # rasterise Natural Earth land in lon/lat first (its polygons span whole continents),
        # then reproject onto the map grid
        lon0, lat0, lon1, lat1, step = 15.0, 57.5, 35.0, 71.5, 0.005
        w, h = int((lon1 - lon0) / step), int((lat1 - lat0) / step)
        ll = from_bounds(lon0, lat0, lon1, lat1, w, h)
        land = np.zeros((h, w), np.uint8)
        for url in LAND_URLS:
            gj = json.loads(http_get(url, timeout=300))
            shapes = [(f["geometry"], 1) for f in gj["features"] if f["geometry"]]
            land |= features.rasterize(shapes, out_shape=(h, w), transform=ll, dtype=np.uint8)
        W, H = rc.WIDTH * SEA_SCALE, rc.HEIGHT * SEA_SCALE
        dst = np.zeros((H, W), np.uint8)
        reproject(land, dst, src_transform=ll, src_crs="EPSG:4326",
                  dst_transform=from_bounds(*rc.BOUNDS, W, H), dst_crs=rc.CRS,
                  resampling=Resampling.nearest)
        WIND.mkdir(parents=True, exist_ok=True)
        Image.fromarray(np.where(dst == 0, 255, 0).astype(np.uint8)).save(path, optimize=True)
        log("built sea mask")
    return np.asarray(Image.open(path)) > 127


def station_sets(stations, sea):
    r = int(round(SEA_STATION_KM / (rc.PIXEL_KM / SEA_SCALE)))
    H, W = sea.shape

    def at_sea(st):
        if not st.get("water"):
            return False
        x, y = int(st["px"] * SEA_SCALE), int(st["py"] * SEA_SCALE)
        return bool(sea[max(y - r, 0):min(y + r + 1, H), max(x - r, 0):min(x + r + 1, W)].any())

    return {"all": sorted(stations), "sea": sorted(i for i, s in stations.items() if at_sea(s))}


# ---------------------------------------------------------------------------- forecasts

def save_fc(source, origin, valid, ws, wd, gust, station_ids):
    rc.FC_DIR.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(fc_file(source, origin), valid=np.array(valid), ids=np.array(station_ids, dtype=np.int64),
                        ws=np.asarray(ws, np.float32), wd=np.asarray(wd, np.float32), gust=np.asarray(gust, np.float32))


POINT_QUERIES = {   # source: (stored query, parameters: speed, direction, gust[, land-sea mask])
    "official": ("fmi::forecast::edited::weather::scandinavia::point::multipointcoverage",
                 "WindSpeedMS,WindDirection,HourlyMaximumGust"),
    "meps": ("fmi::forecast::meps::surface::point::multipointcoverage",
             "WindSpeedMS,WindDirection,WindGust,LandSeaMask"),
}


def collect(source, stations, now):
    """Store the newest forecast of a source at every station.

    "official" is FMI's edited forecast (what ilmatieteenlaitos.fi and veneilysää show),
    "meps" the raw MEPS model. Only the newest version of each is online, so this has
    to run at least every few hours to keep every version.
    """
    query, params = POINT_QUERIES[source]
    ids = sorted(stations)
    base = [("service", "WFS"), ("version", "2.0.0"), ("request", "getFeature"),
            ("storedquery_id", query), ("parameters", params), ("timestep", "60"),
            ("starttime", iso(rc.floor_hour(now) - dt.timedelta(hours=6))),
            ("endtime", iso(rc.floor_hour(now) + dt.timedelta(hours=rc.MAX_LEAD)))]
    origin, rows = None, []
    for k in range(0, len(ids), 90):   # the service takes at most 99 points per request
        xml = http_get(rc.WFS, base + [("latlon", f"{stations[i]['lat']},{stations[i]['lon']}")
                                       for i in ids[k:k + 90]]).decode()
        m = re.search(r'analysis-time[^>]*>\s*<gml:timePosition>([^<]+)<', xml)
        if not m:
            raise RuntimeError("no analysis time in forecast")
        t = dt.datetime.strptime(m.group(1), "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=UTC)
        if origin is not None and t != origin:
            raise RuntimeError("forecast changed while downloading, retried next run")
        origin = t
        if fc_file(source, origin).exists():
            return
        rows += parse_multipoint(xml)[2]

    col = {(stations[i]["lat"], stations[i]["lon"]): j for j, i in enumerate(ids)}
    times = sorted({e for _, e, _ in rows if 0 < e - origin.timestamp() <= rc.MAX_LEAD * 3600 + 3599})
    trow = {e: k for k, e in enumerate(times)}
    vals = np.full((3, len(times), len(ids)), np.nan)
    changed = False
    for key, e, v in rows:
        if key not in col:
            continue
        if e in trow:
            vals[:, trow[e], col[key]] = v[:3]
        if len(v) > 3 and not np.isnan(v[3]):   # land-sea mask: below 0.5 = sea or lake
            st = stations[ids[col[key]]]
            if st.get("water") != bool(v[3] < 0.5):
                st["water"] = bool(v[3] < 0.5)
                changed = True
    if changed:
        save_stations(stations)
    save_fc(source, origin, times, vals[0], vals[1], vals[2], [int(i) for i in ids])
    log(f"stored {source} wind forecast {iso(origin)} ({len(times)} h)")


def forecasts_for(t, source, cache):
    """{lead: ({fmisid: (ws, wd, gust)}, origin)} for the stored forecasts valid at t."""
    out = {}
    e = int(t.timestamp())
    for origin in stored(source):
        lead = int((t - origin).total_seconds() // 3600)
        if not 1 <= lead <= rc.MAX_LEAD:
            continue
        key = (source, origin)
        if key not in cache:
            z = np.load(fc_file(source, origin))
            cache[key] = ({int(v): k for k, v in enumerate(z["valid"])}, z["ids"], z["ws"], z["wd"], z["gust"])
        valid, ids, ws, wd, gust = cache[key]
        if e not in valid:
            continue
        k = valid[e]
        out[lead] = ({str(i): (ws[k, j], wd[k, j], gust[k, j]) for j, i in enumerate(ids)
                      if not np.isnan(ws[k, j])}, origin)
    return out


# ---------------------------------------------------------------------------- wind aloft

UPPER_PRESSURE = 700          # hPa, about 3 km up: roughly the level that steers rain clouds
UPPER_STEP_PX = 36            # lattice spacing in map pixels (~85 km)
UPPER_MAX_KM = 110            # only lattice points this close to some station (i.e. over/near Finland)


def upper_points(stations):
    path = WIND / "upper_points.json"
    if path.exists():
        return json.loads(path.read_text())
    st = np.array([[s["px"], s["py"]] for s in stations.values()])
    max_px = UPPER_MAX_KM / rc.PIXEL_KM
    pts = []
    for py in np.arange(UPPER_STEP_PX / 2, rc.HEIGHT, UPPER_STEP_PX):
        for px in np.arange(UPPER_STEP_PX / 2, rc.WIDTH, UPPER_STEP_PX):
            if np.hypot(st[:, 0] - px, st[:, 1] - py).min() > max_px:
                continue
            x = rc.BOUNDS[0] + px / rc.WIDTH * (rc.BOUNDS[2] - rc.BOUNDS[0])
            y = rc.BOUNDS[3] - py / rc.HEIGHT * (rc.BOUNDS[3] - rc.BOUNDS[1])
            lon, lat = transform(rc.CRS, "EPSG:4326", [x], [y])
            pts.append({"px": float(px), "py": float(py), "lat": round(lat[0], 3), "lon": round(lon[0], 3)})
    path.write_text(json.dumps(pts))
    return pts


def collect_upper(now, stations):
    """MEPS wind at 700 hPa for the recent hours, kept per hour (newest model run wins)."""
    pts = upper_points(stations)
    end = rc.floor_hour(now)
    base = [("service", "WFS"), ("version", "2.0.0"), ("request", "getFeature"),
            ("storedquery_id", "fmi::forecast::meps::pressure::point::multipointcoverage"),
            ("parameters", "WindSpeedMS,WindDirection"), ("pressure", str(UPPER_PRESSURE)),
            ("timestep", "60"), ("starttime", iso(end - dt.timedelta(hours=8))), ("endtime", iso(end))]
    origin, rows = None, []
    for k in range(0, len(pts), 90):
        xml = http_get(rc.WFS, base + [("latlon", f"{p['lat']},{p['lon']}") for p in pts[k:k + 90]]).decode()
        m = re.search(r'analysis-time[^>]*>\s*<gml:timePosition>([^<]+)<', xml)
        if not m:
            raise RuntimeError("no analysis time in 3 km wind")
        origin = m.group(1)
        rows += parse_multipoint(xml)[2]
    col = {(p["lat"], p["lon"]): j for j, p in enumerate(pts)}
    hours = {}
    for key, e, v in rows:
        if key in col:
            hours.setdefault(e, [None] * len(pts))[col[key]] = [r1(v[0]), r1(v[1])]
    out = SITE / "upper"
    out.mkdir(parents=True, exist_ok=True)
    for e, vals in hours.items():
        if not any(v and v[0] is not None for v in vals):   # before the model run started
            continue
        path = out / f"{tag(dt.datetime.fromtimestamp(e, UTC))}.json"
        if path.exists() and json.loads(path.read_text())["origin"] >= origin:
            continue
        path.write_text(json.dumps({"origin": origin, "v": vals}, separators=(",", ":")))


# ---------------------------------------------------------------------------- observations

def fetch_obs(start, end):
    """{hour epoch: {fmisid: (ws, wd, max gust in the hour)}} for whole hours in (start, end]."""
    out = {}
    t0 = start
    while t0 < end:
        t1 = min(t0 + dt.timedelta(hours=24), end)
        xml = http_get(rc.WFS, {
            "service": "WFS", "version": "2.0.0", "request": "getFeature",
            "storedquery_id": "fmi::observations::weather::multipointcoverage", "bbox": OBS_BBOX,
            "parameters": "windspeedms,winddirection,windgust", "timestep": 10,
            "starttime": iso(t0 + dt.timedelta(minutes=10)), "endtime": iso(t1)}).decode()
        ids, _, rows = parse_multipoint(xml)
        gusts = {}
        for key, e, (ws, wd, g) in rows:
            fid = ids.get(key)
            if fid is None:
                continue
            hour = e if e % 3600 == 0 else e - e % 3600 + 3600
            if not np.isnan(g):
                gusts[(hour, fid)] = max(gusts.get((hour, fid), 0.0), g)
            if e % 3600 == 0 and not np.isnan(ws):
                out.setdefault(e, {})[fid] = [ws, wd, np.nan]
        for (hour, fid), g in gusts.items():
            if fid in out.get(hour, {}):
                out[hour][fid][2] = g
        t0 = t1
    return out


# ---------------------------------------------------------------------------- scoring

def dir_diff(a, b):
    return abs((a - b + 180) % 360 - 180)


def score(obs, fc, station_ids):
    v = dict.fromkeys(FIELDS, 0.0)
    nan = lambda xs: [np.nan if x is None else float(x) for x in xs]
    for fid in station_ids:
        if fid not in obs or fid not in fc:
            continue
        ow, od, og = nan(obs[fid])
        fw, fd, fg = nan(fc[fid])
        if np.isnan(ow) or np.isnan(fw):
            continue
        e = fw - ow
        v["n"] += 1
        v["abs"] += abs(e)
        v["err"] += e
        v["near"] += abs(e) <= NEAR_MS
        if ow >= DIR_MIN_MS and fw >= DIR_MIN_MS and not (np.isnan(od) or np.isnan(fd)):
            v["n_dir"] += 1
            v["abs_dir"] += dir_diff(fd, od)
        if not (np.isnan(og) or np.isnan(fg)):
            v["n_gust"] += 1
            v["abs_gust"] += abs(fg - og)
            v["err_gust"] += fg - og
        for t in THRESHOLDS:
            o, f = ow >= t, fw >= t
            v[f"hit{t}"] += o and f
            v[f"miss{t}"] += o and not f
            v[f"fa{t}"] += f and not o
    return [round(float(v[k]), 2) for k in FIELDS]


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
        (SCORES_DIR / f"{month}.json").write_text(json.dumps(dict(sorted(ms.items())), separators=(",", ":")))


def r1(x):
    return None if x is None or np.isnan(x) else round(float(x), 1)


def rescore(metas, sets):
    """Score kept hours again for station sets they were not scored for (e.g. a new set)."""
    for p in sorted((SITE / "h").glob("*.json")):
        m = metas.get(p.stem)
        if not m or all(v is None or set(sets) <= set(v) for vs in m["s"].values() for v in vs):
            continue
        h = json.loads(p.read_text())
        for s, vs in m["s"].items():
            for b, v in enumerate(vs):
                if v is not None:
                    fc = h["fc"][s][b]
                    vs[b] = {k: score(h["obs"], fc, ids) for k, ids in sets.items()}


def verify(now, stations, sets):
    metas = load_metas()
    cache = {}
    latest = rc.floor_hour(now - dt.timedelta(minutes=15))

    todo = []
    for i in range(rc.LOOKBACK_HOURS - 1, -1, -1):
        t = latest - dt.timedelta(hours=i)
        fcs = {s: forecasts_for(t, s, cache) for s in SOURCES}
        leads = {s: rc.pick_leads(fcs[s]) for s in SOURCES}
        if not any(any(l) for l in leads.values()):
            continue
        old = metas.get(tag(t))
        if old and (old["leads"] == leads or i > rc.REDO_HOURS):
            continue
        todo.append((t, fcs, leads))
    if not todo:
        rescore(metas, sets)
        save_metas(metas)
        return metas

    try:
        obs_all = fetch_obs(todo[0][0] - dt.timedelta(hours=1), todo[-1][0])
    except Exception as e:
        log(f"wind observations unavailable: {e}")
        return metas

    for t, fcs, leads in todo:
        obs = obs_all.get(int(t.timestamp()))
        if not obs or len(obs) < 20:
            log(f"{iso(t)}: wind observations not complete yet")
            continue
        meta = {"leads": leads, "origins": {}, "s": {}}
        hour = {"obs": {fid: [r1(v[0]), r1(v[1]), r1(v[2])] for fid, v in obs.items()}, "fc": {}}
        for s in SOURCES:
            meta["origins"][s], meta["s"][s], hour["fc"][s] = [], [], []
            for lead in leads[s]:
                if lead is None:
                    meta["origins"][s].append(None)
                    meta["s"][s].append(None)
                    hour["fc"][s].append(None)
                    continue
                fc, origin = fcs[s][lead]
                meta["origins"][s].append(iso(origin))
                meta["s"][s].append({k: score(obs, fc, ids) for k, ids in sets.items()})
                hour["fc"][s].append({fid: [r1(v[0]), r1(v[1]), r1(v[2])] for fid, v in fc.items()})
        metas[tag(t)] = meta
        (SITE / "h").mkdir(parents=True, exist_ok=True)
        (SITE / "h" / f"{tag(t)}.json").write_text(json.dumps(hour, separators=(",", ":")))
        log(f"{iso(t)}: wind verified at {len(obs)} stations")
    rescore(metas, sets)
    save_metas(metas)
    return metas


# ---------------------------------------------------------------------------- site files

def write_site(now, metas, stations, sets):
    cutoff = now - dt.timedelta(days=rc.KEEP_IMAGE_DAYS)
    for p in [*(SITE / "h").glob("*.json"), *(SITE / "upper").glob("*.json")]:
        if from_tag(p.stem) < cutoff:
            p.unlink()
    hour_files = sorted((SITE / "h").glob("*.json"))
    keys = [p.stem for p in hour_files]

    config = {"sources": SOURCES, "buckets": BUCKETS, "thresholds": THRESHOLDS, "fields": FIELDS,
              "near_ms": NEAR_MS, "dir_min_ms": DIR_MIN_MS, "width": rc.WIDTH, "height": rc.HEIGHT,
              "sea_scale": SEA_SCALE, "pixel_km": rc.PIXEL_KM}
    sea_ids = set(sets["sea"])
    st = {i: {"name": s["name"], "px": s["px"], "py": s["py"], "sea": i in sea_ids,
              "lake": bool(s.get("water")) and i not in sea_ids} for i, s in stations.items()}
    SITE.mkdir(parents=True, exist_ok=True)
    shutil.copy(WIND / "sea.png", SITE / "sea.png")

    # long-term totals
    periods = {"7d": now - dt.timedelta(days=7), "30d": now - dt.timedelta(days=30),
               "all": dt.datetime(1970, 1, 1, tzinfo=UTC)}
    summary = {}
    for name, since in periods.items():
        sums = {s: [{k: [0.0] * len(FIELDS) for k in STATION_SETS} for _ in BUCKETS] for s in SOURCES}
        first = None
        for k, m in metas.items():
            if from_tag(k) < since:
                continue
            first = min(first or k, k)
            for s in SOURCES:
                for b, v in enumerate(m["s"].get(s, [])):
                    if v is None:
                        continue
                    for setname in STATION_SETS:
                        acc = sums[s][b][setname]
                        for j, x in enumerate(v[setname]):
                            acc[j] += x
        summary[name] = {"since": first, "sums": sums}
    (SITE / "summary.json").write_text(json.dumps(summary, separators=(",", ":")))

    # per-station series for the last two weeks (loaded when a station is clicked)
    series = {fid: {"obs": [], "fc": {s: [[] for _ in BUCKETS] for s in SOURCES}} for fid in stations}
    stats = {s: [{} for _ in BUCKETS] for s in SOURCES}   # fmisid: [n, sum |error|, sum error]
    for p in hour_files:
        h = json.loads(p.read_text())
        for fid, ser in series.items():
            o = h["obs"].get(fid)
            ser["obs"].append(o[0] if o else None)
            for s in SOURCES:
                for b in range(len(BUCKETS)):
                    f = h["fc"].get(s, [None] * len(BUCKETS))[b]
                    v = f.get(fid) if f else None
                    ser["fc"][s][b].append(v[0] if v else None)
                    if v and o and v[0] is not None and o[0] is not None:
                        acc = stats[s][b].setdefault(fid, [0, 0.0, 0.0])
                        acc[0] += 1
                        acc[1] += abs(v[0] - o[0])
                        acc[2] += v[0] - o[0]
    out = SITE / "st"
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)
    for fid, ser in series.items():
        (out / f"{fid}.json").write_text(json.dumps({"t": keys, **ser}, separators=(",", ":")))
    for per_bucket in stats.values():
        for d in per_bucket:
            for v in d.values():
                v[1], v[2] = round(v[1], 1), round(v[2], 1)

    hours = [{"t": k, **metas[k]} for k in keys if k in metas]
    (SITE / "index.json").write_text(json.dumps(
        {"updated": iso(now), "config": config, "stations": st, "hours": hours, "stats": stats,
         "upper": {"pressure_hpa": UPPER_PRESSURE,
                   "points": [[p["px"], p["py"]] for p in upper_points(stations)]}},
        ensure_ascii=False, separators=(",", ":")))


def prune(now):
    for s in SOURCES:
        for origin in stored(s):
            if origin + dt.timedelta(hours=rc.MAX_LEAD + rc.REDO_HOURS + 2) < now:
                fc_file(s, origin).unlink()


def update(now):
    stations = ensure_stations(now)
    for source in SOURCES:
        try:
            collect(source, stations, now)
        except Exception as e:
            log(f"{source} wind forecast failed: {e}")
    try:
        collect_upper(now, stations)
    except Exception as e:
        log(f"3 km wind failed: {e}")
    sets = station_sets(stations, sea_mask())
    metas = verify(now, stations, sets)
    prune(now)
    write_site(now, metas, stations, sets)
