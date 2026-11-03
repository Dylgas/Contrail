# Contrail

Contrail predicts future airline flights between U.S. airports using a year of real flight records.

## How it works

The U.S. Department of Transportation's Bureau of Transportation Statistics (BTS) publishes every domestic flight flown by major U.S. airlines: airline, flight number, route, scheduled times, delays and cancellations. That data is public domain.

Once a month, a GitHub Action:

1. Downloads the latest ~14 months of BTS on-time records.
2. Groups each airline flight number into a weekly pattern: which weekdays it flew in each month, its usual times, and its on-time and cancellation rates.
3. Writes small per-airport data files and publishes the site on GitHub Pages.

The site predicts a flight on a future date when it flew on that weekday in the same month last year and is still flying in the latest months. Connections are built from two predicted flights on the same airline with 40 minutes to 5 hours between them.

## Features

- Predicted nonstop and one-stop flights with real flight numbers, times and operating airlines.
- Each flight's on-time rate, cancellation rate and average delay.
- A month calendar of likely flights per day and the best time of day to fly.
- On-sale dates, with a calendar reminder for trips more than about 11 months away.
- Shareable links, such as `#BWI-MCO-20261204`.
- Live prices from Kiwi.com and partner links through Travelpayouts (partner ID 799756).
- Route pages for the 400 busiest routes at `/routes/`, plus `sitemap.xml`, rebuilt monthly.
- A "Request a call back" form that saves to the staff database, and Privacy and Terms pages.

## Staff site

`/staff/` is a sign-in site for Contrail staff: call requests, a shared calendar, bookings and the team list. It runs on Supabase (free plan).

1. Create a Supabase project. In **SQL Editor**, run `supabase/setup.sql`.
2. In **Authentication → Sign In / Providers**, turn off **Allow new users to sign up**, so only invited people get in.
3. In **Authentication → URL Configuration**, set the Site URL to `https://dylgas.github.io/Contrail/staff/`.
4. Put the Project URL and the `anon` public key in `site/config.js`.
5. Invite staff in **Authentication → Users → Add user → Send invitation**. Make the owner an admin with the line at the end of `setup.sql`.
6. For the daily bookings sync, add repository secrets `TRAVELPAYOUTS_TOKEN`, `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` (the `service_role` key; never put it in the site).

## Limits

- U.S. domestic flights by major airlines and their regional partners only.
- BTS data runs about 2 to 3 months behind.
- No ticket prices. The site links to Google Flights for prices.

## Setup

1. In the repository, open **Settings → Pages** and set **Source** to **GitHub Actions**.
2. Open **Actions → Update flight data and publish site → Run workflow**.
3. The first run takes about 15–30 minutes. The site then appears at the address shown in Settings → Pages.

The data refreshes automatically every month.

## Run locally

```bash
pip install -r pipeline/requirements.txt
python pipeline/build.py --out site/data
cd site && python -m http.server 8000
```

Test without downloading anything:

```bash
python tests/make_fixture.py /tmp/fx
python pipeline/build.py --out site/data --local /tmp/fx
```

## Credits

- Flight records: U.S. DOT Bureau of Transportation Statistics (public domain).
- Airport locations: [OpenFlights](https://openflights.org/data.html), Open Database License.

Built by Echo Vance.
