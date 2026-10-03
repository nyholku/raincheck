# Raincheck

How well did the rain forecasts for Finland come true? Every hour a GitHub Actions job
stores the newest FMI MEPS precipitation forecast runs, compares each stored forecast with
the FMI radar for the finished hours, and publishes the result to GitHub Pages:

**https://nyholku.github.io/raincheck/**

- `raincheck.py update` – collect forecasts, verify against radar, prune (the hourly job)
- `raincheck.py build-site _site` – combine `web/` with the data into the static site
- `web/` – the page (plain HTML/JS; scoring with threshold and position tolerance runs in the browser)
- `.github/workflows/hourly.yml` – the schedule; data is kept in the `data` branch
  (one commit, replaced every run)

Run locally:

    python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
    .venv/bin/python raincheck.py update && .venv/bin/python raincheck.py build-site _site
    cd _site && python3 -m http.server

Data: Finnish Meteorological Institute open data, CC BY 4.0.
