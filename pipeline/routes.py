"""Static route pages (for example /routes/BWI-MCO/) so search engines can find popular routes.

Each page summarizes the latest month of real flight records for one route and links into the
forecast tool. Pages are rebuilt every month with the data.
"""
import calendar, html, os, datetime as dt

AIRLINE = {"AA": "American", "DL": "Delta", "UA": "United", "WN": "Southwest", "B6": "JetBlue", "AS": "Alaska",
           "HA": "Hawaiian", "NK": "Spirit", "F9": "Frontier", "G4": "Allegiant", "SY": "Sun Country", "MX": "Breeze", "XP": "Avelo"}
MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]
TOP_ROUTES = 400


def clock(hhmm):
    h, m = int(hhmm[:2]), int(hhmm[2:])
    return f"{h % 12 or 12}:{m:02d} {'AM' if h < 12 else 'PM'}"


def hm(minutes):
    return f"{minutes // 60}h {minutes % 60:02d}m"


def summarize(rows, n_months, days_in_last):
    """Flights that flew in the latest month, with daily frequency."""
    last = (n_months - 1) * 7
    active = []
    for r in rows:
        flown = sum(int(c) for c in r[10][last:last + 7])
        if flown:
            active.append((r, flown))
    weekly_total = sum(f for _, f in active)
    return active, weekly_total / days_in_last  # flights per day


CSS = """
:root{--ink:#0a0a0a;--paper:#fff;--mist:#f4f5f6;--hair:#e6e7e9;--soft:#6b6f75;--good:#1f7a4d;--f:"Inter Tight","Helvetica Neue",Arial,sans-serif;color-scheme:light}
*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font-family:var(--f);font-size:17px;line-height:1.55;-webkit-font-smoothing:antialiased}
.in{max-width:1000px;margin:0 auto;padding-left:max(20px,env(safe-area-inset-left,0px));padding-right:max(20px,env(safe-area-inset-right,0px))}
header{background:var(--ink);color:#fff}header .in{display:flex;justify-content:space-between;align-items:center;padding-block:20px}
header a{color:#fff;text-decoration:none}.mark{letter-spacing:.14em;font-weight:500}
.btn{display:inline-flex;border-radius:999px;padding:12px 22px;font-weight:500;text-decoration:none;background:var(--ink);color:#fff}
.btn-w{background:#fff;color:var(--ink);padding:9px 16px;font-size:15px}
.hero{background:var(--ink);color:#fff;padding-block:48px 64px}
h1{font-weight:400;font-size:clamp(34px,5vw,54px);letter-spacing:-.025em;line-height:1.08;margin:0;text-wrap:balance}
.hero p{color:#d6d8db;font-size:19px;max-width:60ch;margin:16px 0 28px}
main .in{padding-block:56px 72px}h2{font-weight:400;font-size:30px;letter-spacing:-.015em;margin:48px 0 14px}
.facts{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:0 24px;list-style:none;padding:0;margin:0}
.facts li{border-top:1px solid var(--hair);padding:14px 0}.facts b{display:block;font-weight:500;font-size:22px;font-variant-numeric:tabular-nums}.facts span{color:var(--soft);font-size:14px}
.tw{overflow-x:auto}table{width:100%;border-collapse:collapse;font-size:16px}th,td{text-align:left;padding:12px 10px;border-bottom:1px solid var(--hair);white-space:nowrap}
th{font-weight:500;font-size:13px;color:var(--soft)}td.n{font-variant-numeric:tabular-nums}
.note{color:var(--soft);font-size:14px}.links{display:flex;flex-wrap:wrap;gap:8px;padding:0;list-style:none}
.links a{display:inline-block;border:1px solid var(--hair);border-radius:999px;padding:7px 14px;color:var(--ink);text-decoration:none;font-size:15px}
footer{border-top:1px solid var(--hair);color:var(--soft);font-size:13px}footer .in{padding-block:24px 40px}footer a{color:inherit}
@media (max-width:700px){.facts{grid-template-columns:1fr 1fr}}
"""


def page(o, d, A, active, per_day, rows_all, month_label, site_url, related, days_in=30):
    oc, dc = A[o]["c"], A[d]["c"]
    title = f"{oc} ({o}) to {dc} ({d}) flights: schedule and on-time record"
    by_air = {}
    for r, flown in active:
        by_air.setdefault(r[0], []).append((r, flown))
    ot_vals = [(r[7], flown) for r, flown in active if r[7] is not None]
    ot = round(sum(v * w for v, w in ot_vals) / sum(w for _, w in ot_vals)) if ot_vals else None
    durs = sorted(r[5] for r, _ in active if r[5])
    deps = sorted(r[3] for r, _ in active)
    airlines = ", ".join(AIRLINE.get(c, c) for c in sorted(by_air, key=lambda c: -len(by_air[c])))
    nd = round(per_day)
    desc = (f"About {nd} nonstop flight{'' if nd == 1 else 's'} a day from {oc} to {dc} on {airlines}, "
            f"based on {month_label} U.S. DOT flight records. See likely flights for your date.")
    rows_html = "".join(
        f"<tr><td class='n'>{clock(r[3])}</td><td>{html.escape(AIRLINE.get(r[0], r[0]))} {r[0]} {r[1]}</td>"
        f"<td class='n'>{hm(r[5]) if r[5] else '—'}</td><td class='n'>{str(r[7]) + '%' if r[7] is not None else '—'}</td>"
        f"<td class='n'>{flown} of {days_in}</td></tr>"
        for r, flown in sorted([a for a in active if a[1] >= 4] or active, key=lambda x: x[0][3])[:40])
    air_rows = "".join(
        f"<tr><td>{html.escape(AIRLINE.get(c, c))}</td><td class='n'>{len(v)}</td>"
        f"<td class='n'>{clock(min(x[0][3] for x in v))} – {clock(max(x[0][3] for x in v))}</td></tr>"
        for c, v in sorted(by_air.items(), key=lambda kv: -len(kv[1])))
    rel = "".join(f"<li><a href='../{a}-{b}/'>{a} → {b}</a></li>" for a, b in related)
    canonical = f"{site_url}routes/{o}-{d}/"
    return f"""<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>{html.escape(title)} | Contrail</title>
<meta name="description" content="{html.escape(desc)}">
<link rel="canonical" href="{canonical}">
<meta property="og:title" content="{html.escape(title)}"><meta property="og:description" content="{html.escape(desc)}"><meta property="og:url" content="{canonical}">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter+Tight:wght@400;500&display=swap">
<style>{CSS}</style></head><body>
<header><div class="in"><a class="mark" href="../../">CONTRAIL</a><a class="btn btn-w" href="../../#{o}-{d}">Search dates</a></div></header>
<section class="hero"><div class="in">
<h1>{html.escape(oc)} to {html.escape(dc)} flights</h1>
<p>{html.escape(desc)}</p>
<a class="btn btn-w" href="../../#{o}-{d}">See likely flights and live prices</a>
</div></section>
<main><div class="in">
<ul class="facts">
<li><b>{round(per_day)}</b><span>Nonstop flights a day</span></li>
<li><b>{len(by_air)}</b><span>Airlines</span></li>
<li><b>{hm(durs[len(durs) // 2]) if durs else '—'}</b><span>Typical flight time</span></li>
<li><b>{str(ot) + '%' if ot is not None else '—'}</b><span>Arrived on time</span></li>
</ul>
<h2>Airlines on this route</h2>
<div class="tw"><table><thead><tr><th>Airline</th><th>Flight numbers</th><th>Departures</th></tr></thead><tbody>{air_rows}</tbody></table></div>
<h2>Flights in {month_label}</h2>
<p class="note">Regular departures from {o} in local time (flights that flew at least 4 days that month), with each flight's on-time record and how many days of {month_label} it flew. First flight {clock(deps[0])}, last flight {clock(deps[-1])}.</p>
<div class="tw"><table><thead><tr><th>Departs</th><th>Flight</th><th>Time</th><th>On time</th><th>Days flown</th></tr></thead><tbody>{rows_html}</tbody></table></div>
<p style="margin-top:28px"><a class="btn" href="../../#{o}-{d}">Predict flights for your date</a></p>
{f"<h2>More routes</h2><ul class='links'>{rel}</ul>" if rel else ""}
</div></main>
<footer><div class="in">Based on U.S. DOT Bureau of Transportation Statistics on-time records for {month_label}. Schedules change, so confirm with the airline before you travel. <a href="../../privacy.html">Privacy</a> · <a href="../../terms.html">Terms</a></div></footer>
</body></html>"""


def write_route_pages(site_dir, out_by, A, month_keys, site_url):
    y, m = map(int, month_keys[-1].split("-"))
    days = calendar.monthrange(y, m)[1]
    month_label = f"{MONTHS[m - 1]} {y}"
    n = len(month_keys)
    scored = []
    for o, dests in out_by.items():
        for d, rows in dests.items():
            if o not in A or d not in A or A[o].get("la") is None or A[d].get("la") is None:
                continue
            active, per_day = summarize(rows, n, days)
            if per_day >= 1:
                scored.append((per_day, o, d, active))
    scored.sort(reverse=True)
    top = scored[:TOP_ROUTES]
    chosen = {(o, d) for _, o, d, _ in top}
    root = os.path.join(site_dir, "routes")
    os.makedirs(root, exist_ok=True)
    urls = [site_url]
    for per_day, o, d, active in top:
        related = [(a, b) for (a, b) in sorted(chosen) if (a == o or b == d) and (a, b) != (o, d)][:12]
        p = os.path.join(root, f"{o}-{d}")
        os.makedirs(p, exist_ok=True)
        with open(os.path.join(p, "index.html"), "w", encoding="utf-8") as f:
            f.write(page(o, d, A, active, per_day, out_by[o][d], month_label, site_url, related, days))
        urls.append(f"{site_url}routes/{o}-{d}/")
    # Index of all route pages, so crawlers and people can browse them.
    links = "".join(f"<li><a href='{o}-{d}/'>{A[o]['c']} ({o}) → {A[d]['c']} ({d})</a></li>" for _, o, d, _ in sorted(top, key=lambda x: (x[1], x[2])))
    with open(os.path.join(root, "index.html"), "w", encoding="utf-8") as f:
        f.write(f"""<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Popular U.S. flight routes | Contrail</title><meta name="description" content="Schedules and on-time records for the {len(top)} busiest U.S. domestic routes.">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter+Tight:wght@400;500&display=swap"><style>{CSS}</style></head><body>
<header><div class="in"><a class="mark" href="../">CONTRAIL</a><a class="btn btn-w" href="../#top-search">Search</a></div></header>
<main><div class="in"><h1 style="margin-bottom:24px">Popular routes</h1><ul class="links">{links}</ul></div></main></body></html>""")
    urls.append(f"{site_url}routes/")
    today = dt.date.today().isoformat()
    with open(os.path.join(site_dir, "sitemap.xml"), "w") as f:
        f.write('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n')
        f.write("".join(f"<url><loc>{u}</loc><lastmod>{today}</lastmod></url>\n" for u in urls))
        f.write("</urlset>\n")
    with open(os.path.join(site_dir, "robots.txt"), "w") as f:
        f.write(f"User-agent: *\nAllow: /\nSitemap: {site_url}sitemap.xml\n")
    return len(top)
