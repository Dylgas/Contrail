"""Copy bookings credited to Contrail from Travelpayouts into the staff database (Supabase).

Runs daily from GitHub Actions. Needs three repository secrets:
  TRAVELPAYOUTS_TOKEN   Travelpayouts: Profile -> API token
  SUPABASE_URL          Supabase: Project Settings -> API -> Project URL
  SUPABASE_SERVICE_KEY  Supabase: Project Settings -> API -> service_role key (secret, never put on the website)
"""
import datetime as dt, json, os, sys
import requests

TP = "https://api.travelpayouts.com/statistics/v1"
PARTNERS = {"100": "Aviasales"}        # program ids from the Travelpayouts program page URL; others are named below
DAYS_BACK = 400
STATE = {"paid": "Paid", "processing": "Pending", "canceled": "Cancelled", "cancelled": "Cancelled", "confirmed": "Confirmed"}


def need(name):
    v = os.environ.get(name, "").strip()
    if not v:
        print(f"{name} is not set; skipping the bookings sync.")
        sys.exit(0)
    return v


def main():
    token, url, key = need("TRAVELPAYOUTS_TOKEN"), need("SUPABASE_URL").rstrip("/"), need("SUPABASE_SERVICE_KEY")
    h = {"X-Access-Token": token, "Content-Type": "application/json"}

    # Field names carry the account currency (price_usd, paid_profit_eur, ...): read what this account offers.
    r = requests.get(f"{TP}/get_fields_list", headers=h, timeout=60)
    r.raise_for_status()
    body = r.json()
    items = body.get("fields", body) if isinstance(body, dict) else body
    names = {f["name"] if isinstance(f, dict) else str(f) for f in items}
    cur = "usd" if "price_usd" in names else "eur" if "price_eur" in names else None
    if not cur:
        sys.exit(f"Couldn't find a price field. Available fields: {sorted(names)[:60]}")
    fields = [f for f in ["action_id", "campaign_id", "campaign_name", "date", "state", f"price_{cur}",
                          f"paid_profit_{cur}", f"processing_profit_{cur}", f"profit_{cur}"] if f in names]

    since = (dt.date.today() - dt.timedelta(days=DAYS_BACK)).isoformat()
    rows, offset = [], 0
    while True:
        q = {"fields": fields,
             "filters": [{"field": "date", "op": "ge", "value": since}, {"field": "type", "op": "eq", "value": "action"}],
             "sort": [{"field": "date", "order": "desc"}], "offset": offset, "limit": 1000}
        r = requests.post(f"{TP}/execute_query", headers=h, data=json.dumps(q), timeout=120)
        r.raise_for_status()
        res = r.json()
        batch = res.get("results") or res.get("data") or res.get("rows") or []
        rows += batch
        if len(batch) < 1000:
            break
        offset += 1000

    out = []
    for b in rows:
        if not b.get("action_id"):
            continue
        profit = b.get(f"paid_profit_{cur}") or b.get(f"processing_profit_{cur}") or b.get(f"profit_{cur}")
        cid = str(b.get("campaign_id", ""))
        out.append({
            "id": str(b["action_id"]),
            "booked_on": str(b.get("date") or "")[:10] or None,
            "partner": PARTNERS.get(cid) or b.get("campaign_name") or (f"Program {cid}" if cid else None),
            "fare_usd": round(float(b[f"price_{cur}"]), 2) if cur == "usd" and b.get(f"price_{cur}") is not None else None,
            "commission_usd": round(float(profit), 2) if cur == "usd" and profit is not None else None,
            "status": STATE.get(str(b.get("state", "")).lower(), str(b.get("state") or "Pending").title()),
            "synced_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        })
    if cur != "usd":
        print("Your Travelpayouts account reports in", cur.upper(), "- amounts were left blank. Switch the account currency to USD to fill them.")

    if out:
        r = requests.post(f"{url}/rest/v1/bookings", timeout=120, data=json.dumps(out),
                          headers={"apikey": key, "Authorization": f"Bearer {key}", "Content-Type": "application/json",
                                   "Prefer": "resolution=merge-duplicates,return=minimal"})
        if r.status_code >= 300:
            sys.exit(f"Supabase refused the bookings ({r.status_code}): {r.text[:300]}")
    print(f"Synced {len(out)} bookings since {since}.")


if __name__ == "__main__":
    main()
