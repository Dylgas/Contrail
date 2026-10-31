"""Build Contrail's route data from U.S. DOT / BTS on-time performance records.

Downloads the most recent ~14 months of the BTS on-time files (public domain),
collapses every individual flight into a weekly "pattern" per airline flight
number, and writes small per-airport JSON files that the website reads.

Usage:
  python pipeline/build.py --out site/data              # download from BTS
  python pipeline/build.py --out site/data --local DIR  # use zips already in DIR
"""
import argparse, csv, datetime as dt, io, json, os, sys, time, zipfile
from collections import Counter, defaultdict

import pandas as pd
import requests

MKT_URL = "https://transtats.bts.gov/PREZIP/On_Time_Marketing_Carrier_On_Time_Performance_Beginning_January_2018_{y}_{m}.zip"
REP_URL = "https://transtats.bts.gov/PREZIP/On_Time_Reporting_Carrier_On_Time_Performance_1987_present_{y}_{m}.zip"
UA = {"User-Agent": "Mozilla/5.0 (contrail data build; public BTS download)"}
MONTHS_WANTED = 14
OFFLINE = False

# When only the reporting-carrier file is available, regional operators are
# mapped to the brand they most often fly for.
REGIONAL_BRAND = {"OH": "AA", "MQ": "AA", "PT": "AA", "9E": "DL", "QX": "AS", "ZW": "UA", "C5": "UA", "G7": "UA"}

COLS = {
    "date": ["FlightDate"],
    "dow": ["DayOfWeek"],
    "mkt": ["IATA_Code_Marketing_Airline", "Marketing_Airline_Network"],
    "mkt_fn": ["Flight_Number_Marketing_Airline"],
    "op": ["IATA_Code_Operating_Airline", "Operating_Airline", "Operating_Airline ", "IATA_CODE_Reporting_Airline", "Reporting_Airline"],
    "op_fn": ["Flight_Number_Operating_Airline", "Flight_Number_Reporting_Airline"],
    "o": ["Origin"], "d": ["Dest"],
    "dep": ["CRSDepTime"], "arr": ["CRSArrTime"], "el": ["CRSElapsedTime"],
    "del15": ["ArrDel15"], "adel": ["ArrDelayMinutes", "ArrDelay"], "cx": ["Cancelled"], "dist": ["Distance"],
}


def log(*a):
    print(*a, flush=True)


def fetch(url, dest):
    if os.path.exists(dest) and os.path.getsize(dest) > 1000:
        return True
    if OFFLINE:
        return False
    for attempt in range(4):
        for verify in (True, False):
            try:
                with requests.get(url, headers=UA, timeout=180, stream=True, verify=verify) as r:
                    if r.status_code == 404:
                        return False
                    r.raise_for_status()
                    ctype = r.headers.get("content-type", "")
                    if "html" in ctype:
                        return False
                    tmp = dest + ".part"
                    with open(tmp, "wb") as f:
                        for chunk in r.iter_content(1 << 20):
                            f.write(chunk)
                    if not zipfile.is_zipfile(tmp):
                        os.remove(tmp)
                        return False
                    os.replace(tmp, dest)
                    return True
            except requests.exceptions.SSLError:
                continue
            except Exception as e:  # network hiccup: retry
                log(f"  retry {attempt + 1}: {e}")
                time.sleep(5 * (attempt + 1))
                break
    return False


def month_file(cache, y, m):
    """Return (path, kind) for month y/m, preferring the marketing-carrier table."""
    for kind, url in (("mkt", MKT_URL), ("rep", REP_URL)):
        p = os.path.join(cache, f"{kind}_{y}_{m}.zip")
        if fetch(url.format(y=y, m=m), p):
            return p, kind
    return None, None


def pick(df_cols, names):
    for n in names:
        if n in df_cols:
            return n
    return None


def read_month(path):
    with zipfile.ZipFile(path) as z:
        name = next(n for n in z.namelist() if n.lower().endswith(".csv"))
        with z.open(name) as f:
            head = pd.read_csv(f, nrows=0)
        cols = [c.strip() for c in head.columns]
        use = {k: pick(head.columns, v) or pick(cols, v) for k, v in COLS.items()}
        need = ["date", "dow", "op", "op_fn", "o", "d", "dep", "arr"]
        missing = [k for k in need if not use[k]]
        if missing:
            raise RuntimeError(f"{path}: missing columns {missing}")
        with z.open(name) as f:
            df = pd.read_csv(f, usecols=[c for c in use.values() if c], dtype=str, low_memory=False)
    df = df.rename(columns={v: k for k, v in use.items() if v})
    if "mkt" not in df or df["mkt"].isna().all():
        df["mkt"] = df["op"].map(lambda c: REGIONAL_BRAND.get(c, c))
        df["mkt_fn"] = df["op_fn"]
    df["mkt"] = df["mkt"].fillna(df["op"])
    df["mkt_fn"] = df.get("mkt_fn", df["op_fn"]).fillna(df["op_fn"])
    return df


def hhmm(v):
    try:
        n = int(float(v))
    except (TypeError, ValueError):
        return None
    if n == 2400:
        n = 0
    return f"{n // 100:02d}{n % 100:02d}"


def mode(counter):
    return counter.most_common(1)[0][0] if counter else None


def build(months, cache, out):
    """months: list of (y, m) oldest -> newest that have files."""
    keys = [f"{y}-{m:02d}" for y, m in months]
    pat = {}  # (mkt, fn, o, d) -> stats
    for mi, (y, m) in enumerate(months):
        path, kind = month_file(cache, y, m)
        log(f"Reading {y}-{m:02d} ({kind}) ...")
        df = read_month(path)
        days_seen = set()
        for r in df.itertuples(index=False):
            k = (r.mkt, str(r.mkt_fn).split(".")[0], r.o, r.d)
            s = pat.get(k)
            if s is None:
                s = pat[k] = {"op": Counter(), "dep": Counter(), "arr": Counter(), "el": Counter(), "dist": 0,
                              "days": defaultdict(set), "n": 0, "late": 0, "cx": 0, "delay": 0.0}
            dow = int(r.dow) - 1  # BTS: 1=Mon .. 7=Sun -> 0..6
            s["days"][mi * 7 + dow].add(int(str(r.date)[8:10]))
            if r.op and r.op != r.mkt:
                s["op"][r.op] += 1
            dep, arr = hhmm(r.dep), hhmm(r.arr)
            if dep:
                s["dep"][dep] += 1
            if arr:
                s["arr"][arr] += 1
            el = getattr(r, "el", None)
            try:
                s["el"][int(float(el))] += 1
            except (TypeError, ValueError):
                pass
            try:
                s["dist"] = int(float(getattr(r, "dist", 0) or 0)) or s["dist"]
            except ValueError:
                pass
            s["n"] += 1
            if str(getattr(r, "cx", "0")).startswith("1"):
                s["cx"] += 1
            elif str(getattr(r, "del15", "0")).startswith("1"):
                s["late"] += 1
                try:
                    s["delay"] += float(getattr(r, "adel", 0) or 0)
                except ValueError:
                    pass
        del df

    out_by, in_by = defaultdict(dict), defaultdict(dict)
    airports_used = set()
    for (mkt, fn, o, d), s in pat.items():
        if s["n"] < 2 or not s["dep"]:
            continue
        grid = "".join(str(min(9, len(s["days"].get(i, ())))) for i in range(len(months) * 7))
        flown = s["n"] - s["cx"]
        row = [mkt, fn, mode(s["op"]) or "", mode(s["dep"]), mode(s["arr"]) or "", mode(s["el"]) or 0, s["dist"],
               round(100 * (flown - s["late"]) / flown) if flown else None,
               round(100 * s["cx"] / s["n"], 1),
               round(s["delay"] / s["late"]) if s["late"] else 0,
               grid]
        out_by[o].setdefault(d, []).append(row)
        in_by[d].setdefault(o, []).append(row)
        airports_used.update((o, d))

    for kind, table in (("out", out_by), ("in", in_by)):
        os.makedirs(os.path.join(out, kind), exist_ok=True)
        for ap, rows in table.items():
            for lst in rows.values():
                lst.sort(key=lambda r: r[3])
            with open(os.path.join(out, kind, f"{ap}.json"), "w") as f:
                json.dump(rows, f, separators=(",", ":"))

    write_airports(out, airports_used, out_by)
    meta = {"months": keys, "generated": dt.date.today().isoformat(), "source": "U.S. DOT Bureau of Transportation Statistics",
            "fields": ["carrier", "flight", "operator", "dep", "arr", "minutes", "miles", "ontime_pct", "cancel_pct", "avg_delay", "weekday_grid"]}
    with open(os.path.join(out, "meta.json"), "w") as f:
        json.dump(meta, f, separators=(",", ":"))
    log(f"Wrote {len(pat):,} flight patterns across {len(airports_used)} airports for {keys[0]} to {keys[-1]}")


def write_airports(out, used, out_by):
    here = os.path.dirname(__file__)
    res = {}
    with open(os.path.join(here, "airports.dat"), encoding="utf-8") as f:
        for r in csv.reader(f):
            if len(r) > 11 and r[4] in used:
                res[r[4]] = {"n": r[1].replace(" International Airport", " Intl").replace(" Airport", ""), "c": r[2],
                             "la": round(float(r[6]), 3), "lo": round(float(r[7]), 3), "tz": r[11]}
    for code in used - res.keys():
        res[code] = {"n": code, "c": code, "la": None, "lo": None, "tz": None}
    for code, v in res.items():
        v["d"] = sum(len(x) for x in out_by.get(code, {}).values())  # weekly departures (rough size)
    with open(os.path.join(out, "airports.json"), "w") as f:
        json.dump(res, f, separators=(",", ":"))


def recent_months(n, today=None):
    today = today or dt.date.today()
    y, m = today.year, today.month
    res = []
    for _ in range(n):
        res.append((y, m))
        m -= 1
        if m == 0:
            y, m = y - 1, 12
    return res


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--cache", default="cache")
    ap.add_argument("--local", help="folder of already-downloaded zips named mkt_YYYY_M.zip / rep_YYYY_M.zip")
    a = ap.parse_args()
    global OFFLINE
    OFFLINE = bool(a.local)
    cache = a.local or a.cache
    os.makedirs(cache, exist_ok=True)

    # BTS publishes with a ~2-3 month lag. Walk back from today to find the newest month.
    have = []
    for y, m in recent_months(MONTHS_WANTED + 6):
        p, kind = month_file(cache, y, m)
        if p:
            have.append((y, m))
            log(f"Found {y}-{m:02d} ({kind})")
        elif have:
            log(f"Missing {y}-{m:02d}; stopping")
            break
        if len(have) == MONTHS_WANTED:
            break
    if len(have) < 2:
        sys.exit("Could not get BTS data. Leaving the current site data unchanged.")
    build(sorted(have), cache, a.out)


if __name__ == "__main__":
    main()
