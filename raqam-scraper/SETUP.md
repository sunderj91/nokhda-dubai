# RAQAM Live Data Pipeline — Setup Guide

Complete setup: Supabase DB + Bayut scraper + RAQAM frontend integration.
Estimated time: ~30 minutes.

---

## Step 1 — Create Supabase Project

1. Go to **https://supabase.com** → Sign up / Log in
2. Click **"New project"**
   - Organization: create one or use default
   - **Project name**: `raqam-dubai`
   - **Database password**: generate a strong one, save it
   - **Region**: `ap-southeast-1` (Singapore — closest to Dubai with good latency)
3. Wait ~2 minutes for the project to spin up

---

## Step 2 — Run the Database Schema

1. In your Supabase project → **SQL Editor** (left sidebar)
2. Click **"New query"**
3. Open the file `supabase_schema.sql` from this folder
4. Paste the entire contents into the SQL editor
5. Click **"Run"** (or Cmd+Enter)

You should see: *"Success. No rows returned."*

This creates:
- `projects` — main projects table with spatial indexing
- `developers` — developer master data
- `project_images` — image gallery per project
- `unit_types` — bedroom/unit mix breakdown
- `price_history` — daily PSF snapshots for trend charts
- `construction_updates` — construction milestone log
- `scraper_runs` — audit log of scraper activity
- `projects_full` — view joining all tables for fast reads

---

## Step 3 — Create Image Storage Bucket

1. In Supabase → **Storage** (left sidebar)
2. Click **"New bucket"**
   - **Name**: `project-images`
   - **Public bucket**: ✅ YES (images need to be publicly accessible)
   - File size limit: `10485760` (10MB)
3. Click **Save**

---

## Step 4 — Get Your API Keys

1. In Supabase → **Settings** (gear icon) → **API**
2. Copy and save:
   - **Project URL** — e.g. `https://abcdefgh.supabase.co`
   - **anon / public** key — for the frontend (browser-safe)
   - **service_role** key — for the scraper (keep private, never expose in browser)

---

## Step 5 — Configure the Scraper

```bash
# In the raqam-scraper folder:
cp .env.example .env
```

Edit `.env` and fill in:
```
SUPABASE_URL=https://YOUR_PROJECT_ID.supabase.co
SUPABASE_SERVICE_KEY=eyJhbGci...YOUR_SERVICE_KEY
SUPABASE_ANON_KEY=eyJhbGci...YOUR_ANON_KEY
```

---

## Step 6 — Install & Test

```bash
cd raqam-scraper
npm install

# First, do a dry run to verify scraping works (no DB writes)
npm run scrape:dry
```

Expected output:
```
[08:12:34] 🚀 RAQAM Scraper starting...
[08:12:34] Mode: DRY RUN
[08:12:35] [Bayut] Dubai Marina page 1: 18 projects found
[08:12:37] [Bayut] Business Bay page 1: 22 projects found
...
[08:14:12] Total unique projects: 347 (from 381 raw)
=== DRY RUN SAMPLE (first 5) ===
  Emaar Beachfront Residences | Emaar | Dubai Harbour | AED 2,800,000 | bayut
  Creek Gate Tower | DAMAC | Dubai Creek Harbour | AED 1,450,000 | bayut
  ...
Would save 347 projects to Supabase
```

---

## Step 7 — Live Scrape

```bash
# Run the full scrape (writes to Supabase)
npm run scrape
```

First run scrapes ~500-800 projects across 30 Dubai areas.
Takes approximately 25-45 minutes (polite rate limiting).

---

## Step 8 — Connect RAQAM Frontend

1. Open `supabase-client.js`
2. Replace the placeholders at the top:
   ```js
   const SUPABASE_URL = 'https://YOUR_PROJECT_ID.supabase.co';
   const SUPABASE_ANON_KEY = 'YOUR_ANON_KEY';   // use anon key, NOT service key
   ```

3. In `index.html`, add before the closing `</body>` tag:
   ```html
   <script type="module" src="supabase-client.js"></script>
   ```

4. Then in the Projects tab JavaScript, replace:
   ```js
   // OLD: const PROJECTS = [...hardcoded array...]
   
   // NEW: load from DB
   async function loadProjectsFromDB() {
     const { projects } = await window.RAQAM_DB.getProjects({ featuredFirst: true });
     window.PROJECTS = projects.map(window.RAQAM_DB.toMapProject);
     addProjectDots();
     renderProjectList();
   }
   loadProjectsFromDB();
   ```

---

## Step 9 — Schedule Daily Scraping

### Option A: Local machine (simple)
```bash
npm run schedule   # runs in foreground
# Or with PM2 (keeps running):
npm install -g pm2
pm2 start scheduler.js --name raqam-scraper
pm2 save
pm2 startup
```

### Option B: GitHub Actions (free, cloud)

Create `.github/workflows/scrape.yml` in your repo:

```yaml
name: RAQAM Daily Scrape
on:
  schedule:
    - cron: '0 23 * * *'   # 3am Dubai time
  workflow_dispatch:         # manual trigger

jobs:
  scrape:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: '20'
      - name: Install dependencies
        run: cd raqam-scraper && npm install
      - name: Run scraper
        env:
          SUPABASE_URL: ${{ secrets.SUPABASE_URL }}
          SUPABASE_SERVICE_KEY: ${{ secrets.SUPABASE_SERVICE_KEY }}
        run: cd raqam-scraper && npm run scrape
```

Then in GitHub → Settings → Secrets, add `SUPABASE_URL` and `SUPABASE_SERVICE_KEY`.

**This is the recommended approach — completely free, runs in the cloud, no server needed.**

---

## What Gets Scraped

| Field | Source | Notes |
|-------|--------|-------|
| Project name | Bayut / PF | |
| Developer | Bayut / PF | |
| Area | Bayut / PF | |
| Lat/Lng | Bayut detail page | For map placement |
| Price range (AED) | Bayut / PF | |
| PSF (per sqft) | Bayut / PF | Tracked daily for trends |
| Completion date | Bayut / PF | |
| Unit types & mix | Bayut detail page | |
| Down payment % | Bayut detail page | |
| Images | Bayut CDN → Supabase Storage | Up to 8 per project |
| Description | Bayut detail page | |
| Amenities | Bayut detail page | |

---

## Monitoring

- **Supabase Table Editor** → `scraper_runs` table shows every run with stats
- **Supabase Logs** → real-time query monitoring
- To check your project count: Supabase → Table Editor → `projects` → count rows

---

## Troubleshooting

**Bayut returns empty listings?**
→ They may be blocking your IP. Use a residential proxy or VPN with Dubai IP.
→ Add to `.env`: `PROXY_URL=http://user:pass@proxy:8080`

**Images not uploading?**
→ Check Storage bucket exists and is set to Public.
→ Check service role key has storage permissions.

**Scraper too slow?**
→ Reduce `CONFIG.delayMs` to 800ms (risk: more likely to get rate-limited)
→ Increase `CONFIG.concurrency` to 5

**Missing lat/lng for projects?**
→ Expected for ~30% of listings. RAQAM falls back to area centroid coords.
→ You can manually update via Supabase Table Editor.
