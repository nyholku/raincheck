"""
Permanent archive of everything raincheck collects (forecasts are not kept by FMI, so
whatever is not archived is lost for good).

During the day, items are written to data/archive/pending/<YYYYMMDD>/ (in the data branch).
When a day is complete (12 h after it ended, so late model runs and redone hours are in),
it is packed into data/archive/outbox/raincheck-<YYYYMMDD>.zip; the workflow uploads that
as an asset of the GitHub release "archive-<YYYY-MM>" and deletes it.

Day file contents (all times UTC, grid = rain map grid, see raincheck.py):
  rain/obs_<YYYYmmddTHHMMZ>.npz.xz   radar 1 h rain ending at that time: code[H, W]
  rain/meps_<origin>.npz.xz          MEPS run: valid[epoch], code[lead, H, W] for leads 1-12 h,
                                     valid_coarse, code_coarse[lead, H/2, W/2] for 13-48 h
                                     (2 x 2 pixel averages, ~4.6 km)
  wind/obs_<YYYYmmddTHHMMZ>.json     station measurements {fmisid: [speed, dir, max gust]}
  wind/<source>_<origin>.npz.xz      forecast at stations: valid, ids, ws, gust (0.1 m/s), wd (deg)
                                     as int16 [lead, station]; -1 = missing
  wind/upper_<YYYYmmddTHHMMZ>.json   MEPS 700 hPa wind on the lattice in meta.json
  meta.json                          grid, stations, lattice, code scale
*.npz.xz files are numpy .npz files compressed with xz/LZMA: use load() below.
Rain codes: 0 = under 0.05 mm, 255 = no data, otherwise mm = 0.05 * STEP**(code - 1),
i.e. 12 % steps (fine enough for forecasts). Use decode_rain() to get millimetres back.
"""

import datetime as dt
import io
import json
import lzma
import shutil
import zipfile

import numpy as np

import raincheck as rc
from raincheck import UTC, log, tag

ARCH = rc.DATA / "archive"
PENDING = ARCH / "pending"
OUTBOX = ARCH / "outbox"

RAIN_MIN_MM = 0.05
STEP = 1.12
NODATA = 255
FINE_LEADS = 12        # forecast hours kept at full resolution; later ones at half resolution
PACK_DELAY = dt.timedelta(hours=12)   # pack day D once D+1 12:00 UTC has passed (late runs, redone hours)


def encode_rain(mm):
    mm = np.asarray(mm, np.float32)
    with np.errstate(divide="ignore", invalid="ignore"):
        k = np.round(np.log(np.maximum(mm, RAIN_MIN_MM) / RAIN_MIN_MM) / np.log(STEP)) + 1
    code = np.clip(np.nan_to_num(k, nan=1), 1, 254).astype(np.uint8)
    code[mm < RAIN_MIN_MM] = 0
    code[np.isnan(mm)] = NODATA
    return code


def decode_rain(code):
    code = np.asarray(code)
    mm = RAIN_MIN_MM * STEP ** (code.astype(np.float32) - 1)
    mm[code == 0] = 0.0
    mm[code == NODATA] = np.nan
    return mm


def save(path, **arrays):
    buf = io.BytesIO()
    np.savez(buf, **arrays)
    path.write_bytes(lzma.compress(buf.getvalue(), preset=9))


def load(path_or_bytes):
    """Read an archived .npz.xz (a path, or bytes read from the day zip)."""
    raw = path_or_bytes if isinstance(path_or_bytes, bytes) else open(path_or_bytes, "rb").read()
    return dict(np.load(io.BytesIO(lzma.decompress(raw))))


def halve(mm):
    """2 x 2 block mean (NaN-aware) over the last two axes."""
    h, w = mm.shape[-2:]
    mm = np.pad(mm, [(0, 0)] * (mm.ndim - 2) + [(0, h % 2), (0, w % 2)], constant_values=np.nan)
    blocks = mm.reshape(*mm.shape[:-2], mm.shape[-2] // 2, 2, mm.shape[-1] // 2, 2)
    with np.errstate(invalid="ignore"), __import__("warnings").catch_warnings():
        __import__("warnings").simplefilter("ignore", RuntimeWarning)
        return np.nanmean(blocks, axis=(-3, -1))


def _dir(t):
    d = PENDING / t.strftime("%Y%m%d")
    (d / "rain").mkdir(parents=True, exist_ok=True)
    (d / "wind").mkdir(parents=True, exist_ok=True)
    return d


def _safe(fn):
    """Archiving must never break the hourly job."""
    def wrapper(*a, **k):
        try:
            fn(*a, **k)
        except Exception as e:
            log(f"archive: {fn.__name__} failed: {e!r}")
    return wrapper


@_safe
def rain_obs(t, mm):
    save(_dir(t) / "rain" / f"obs_{tag(t)}.npz.xz", code=encode_rain(mm))


@_safe
def rain_run(origin, valid_epochs, mm_stack):
    valid = np.asarray(valid_epochs)
    fine = (valid - int(origin.timestamp())) <= FINE_LEADS * 3600
    save(_dir(origin) / "rain" / f"meps_{tag(origin)}.npz.xz",
         valid=valid[fine], code=encode_rain(mm_stack[fine]),
         valid_coarse=valid[~fine], code_coarse=encode_rain(halve(mm_stack[~fine])))


@_safe
def wind_obs(t, obs):
    (_dir(t) / "wind" / f"obs_{tag(t)}.json").write_text(json.dumps(obs, separators=(",", ":")))


@_safe
def wind_run(source, origin, path):
    z = np.load(path)
    i16 = lambda a, scale: np.where(np.isnan(a), -1, np.round(a * scale)).astype(np.int16)
    save(_dir(origin) / "wind" / f"{source}_{tag(origin)}.npz.xz", valid=z["valid"], ids=z["ids"],
         ws=i16(z["ws"], 10), gust=i16(z["gust"], 10), wd=i16(z["wd"], 1))


@_safe
def wind_upper(t, data):
    (_dir(t) / "wind" / f"upper_{tag(t)}.json").write_text(json.dumps(data, separators=(",", ":")))


def meta():
    import wind
    m = {"crs": rc.CRS, "bounds": rc.BOUNDS, "width": rc.WIDTH, "height": rc.HEIGHT,
         "rain_code": {"min_mm": RAIN_MIN_MM, "step": STEP, "zero": 0, "nodata": NODATA,
                       "fine_leads_h": FINE_LEADS},
         "upper_pressure_hpa": wind.UPPER_PRESSURE}
    if wind.STATIONS_FILE.exists():
        m["stations"] = json.loads(wind.STATIONS_FILE.read_text())
    up = wind.WIND / "upper_points.json"
    if up.exists():
        m["upper_points"] = json.loads(up.read_text())
    return m


@_safe
def catch_up(now):
    """Archive anything still in working storage that the archive is missing (e.g. after a
    failed run), for days that have not been packed yet."""
    import wind
    open_day = lambda t: now < t.replace(hour=0, minute=0, second=0) + dt.timedelta(days=1) + PACK_DELAY
    has = lambda t, sub, name: (PENDING / t.strftime("%Y%m%d") / sub / name).exists()
    for origin in rc.stored_runs():
        if open_day(origin) and not has(origin, "rain", f"meps_{tag(origin)}.npz.xz"):
            z = np.load(rc.fc_path(origin))
            mm = z["rr"].astype(np.float32) * rc.RADAR_SCALE
            mm[z["rr"] == rc.RADAR_NODATA] = np.nan
            rain_run(origin, z["valid"], mm)
    for source in wind.SOURCES:
        for origin in wind.stored(source):
            if open_day(origin) and not has(origin, "wind", f"{source}_{tag(origin)}.npz.xz"):
                wind_run(source, origin, wind.fc_file(source, origin))
    for p in sorted((rc.SITE / "h").glob("*")):
        t = rc.from_tag(p.name)
        if open_day(t) and not has(t, "rain", f"obs_{p.name}.npz.xz"):
            try:
                rain_obs(t, rc.fetch_obs(t))
            except Exception as e:
                log(f"archive: radar {p.name}: {e}")
    for sub, prefix in (("h", "obs"), ("upper", "upper")):
        for p in sorted((wind.SITE / sub).glob("*.json")):
            t = rc.from_tag(p.stem)
            if open_day(t) and not has(t, "wind", f"{prefix}_{p.stem}.json"):
                d = json.loads(p.read_text())
                (wind_obs if prefix == "obs" else wind_upper)(t, d["obs"] if prefix == "obs" else d)


@_safe
def pack(now):
    """Zip every complete day into the outbox (uploaded to GitHub releases by the workflow)."""
    for d in sorted(PENDING.glob("*")):
        day = dt.datetime.strptime(d.name, "%Y%m%d").replace(tzinfo=UTC)
        if now < day + dt.timedelta(days=1) + PACK_DELAY:
            continue
        OUTBOX.mkdir(parents=True, exist_ok=True)
        out = OUTBOX / f"raincheck-{d.name}.zip"
        with zipfile.ZipFile(out, "w", zipfile.ZIP_STORED) as z:   # contents already compressed
            z.writestr("meta.json", json.dumps(meta(), ensure_ascii=False))
            z.writestr("README.txt", __doc__)
            for f in sorted(d.rglob("*")):
                if f.is_file():
                    z.write(f, f.relative_to(d).as_posix())
        shutil.rmtree(d)
        log(f"archive: packed {out.name} ({out.stat().st_size / 1e6:.1f} MB)")
