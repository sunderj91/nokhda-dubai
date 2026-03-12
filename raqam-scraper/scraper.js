/**
 * RAQAM Dubai Project Scraper v3
 * Source: Property Finder /en/new-projects (embeds full JSON in page scripts)
 * - No API key needed, no auth, public page, accessible from cloud IPs
 * - ~2,600 projects across UAE → filter to Dubai
 * - 109 pages × 24 projects/page
 */

import axios from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';

// Auto-use proxy if set (works in GitHub Actions and Claude environments)
const _proxyUrl = process.env.https_proxy || process.env.HTTPS_PROXY;
const httpsAgent = _proxyUrl ? new HttpsProxyAgent(_proxyUrl) : undefined;
import * as cheerio from 'cheerio';
import { createClient } from '@supabase/supabase-js';
import pLimit from 'p-limit';
import 'dotenv/config';

const DRY_RUN     = process.argv.includes('--dry-run');
const MODE        = process.argv.find(a => a.startsWith('--mode='))?.split('=')[1] || 'full';

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const PF_BASE    = 'https://www.propertyfinder.ae';
const PF_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

const DUBAI_KEYWORDS = [
  'dubai', 'jvc', 'jumeirah', 'marina', 'deira', 'bur dubai',
  'downtown', 'business bay', 'palm', 'creek', 'meydan',
  'sports city', 'motor city', 'arabian ranches', 'al furjan',
  'dubai hills', 'damac', 'sobha', 'al jaddaf', 'bluewaters', 'emaar', 'akoya'
];

function log(msg) {
  console.log(`[${new Date().toISOString().split('T')[1].split('.')[0]}] ${msg}`);
}

// ── Property Finder Scraper ───────────────────────────────────────────────────

async function fetchPage(pageNum, retries = 3) {
  const url = `${PF_BASE}/en/new-projects?page=${pageNum}`;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await axios.get(url, { headers: PF_HEADERS, timeout: 30000, ...(httpsAgent && { httpsAgent, proxy: false }) });
      const $ = cheerio.load(res.data);
      let nextData = null;
      $('script').each((_, el) => {
        const text = $(el).html() || '';
        if (text.includes('pageProps') && text.includes('"projects"')) {
          try {
            const start = text.indexOf('{');
            if (start >= 0) nextData = JSON.parse(text.slice(start));
          } catch {}
        }
      });
      if (!nextData) throw new Error('No page data found');
      const sr = nextData?.props?.pageProps?.searchResult;
      if (!sr) throw new Error('No searchResult');
      return {
        projects: sr.data?.projects || [],
        totalPages: sr.meta?.pagination?.total || 1,
        totalProjects: sr.meta?.count?.total || 0,
      };
    } catch (err) {
      if (attempt === retries) throw err;
      log(`  Page ${pageNum} attempt ${attempt} failed: ${err.message}, retrying...`);
      await new Promise(r => setTimeout(r, 2000 * attempt));
    }
  }
}

function isDubaiProject(pf) {
  const loc = (pf.location?.fullName || '').toLowerCase();
  if (loc.includes('dubai')) return true;
  return DUBAI_KEYWORDS.some(kw => loc.includes(kw));
}

function normaliseProject(pf) {
  // Location: "Dubai, Downtown Dubai, Tower Name" → area = "Downtown Dubai"
  const locParts = (pf.location?.fullName || '').split(',').map(s => s.trim());
  const area = locParts.length >= 2 ? locParts[1] : locParts[0] || 'Dubai';
  
  // Completion date
  let completionDate = null;
  if (pf.deliveryDate) { try { completionDate = pf.deliveryDate.split('T')[0]; } catch {} }
  
  // Payment plan parsing
  let downPayment = null, duringConstruction = null, onCompletion = null;
  if (pf.paymentPlans?.length > 0) {
    const pl = pf.paymentPlans[0];
    downPayment       = pl.downPayment || null;
    duringConstruction = pl.duringConstruction || null;
    onCompletion      = pl.onHandover || null;
  }
  if (pf.downPaymentPercentage) downPayment = pf.downPaymentPercentage;
  
  // Status
  const statusMap = { under_construction: 'under-construction', off_plan: 'off-plan', completed: 'ready', ready: 'ready' };
  const status = statusMap[pf.constructionPhase] || 'off-plan';
  
  // Bedrooms array
  const beds = (pf.bedrooms || [])
    .map(b => b === 'studio' ? 0 : parseInt(b))
    .filter(n => isFinite(n));
  
  // Slug
  const slug = (pf.title || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    + '-' + (pf.id || '').split('-')[0];
  
  return {
    // Table columns (matching actual schema)
    external_id:          `pf-${pf.id}`,
    source:               'scraped',
    name:                 pf.title || 'Unknown Project',
    slug,
    developer_name:       pf.developer?.name || 'Unknown Developer',
    area,
    location:             pf.location?.fullName || area,
    lat:                  pf.location?.coordinates?.lat || null,
    lng:                  pf.location?.coordinates?.lng || pf.location?.coordinates?.lon || null,
    price_min:            pf.startingPrice || null,
    price_max:            pf.minResalePrice || pf.startingPrice || null,
    status,
    construction_progress: pf.constructionProgress ? Math.round(pf.constructionProgress) : null,
    completion_date:      completionDate,
    bedrooms_available:   beds.length > 0 ? beds : null,
    down_payment:         downPayment,
    during_construction:  duringConstruction,
    on_completion:        onCompletion,
    amenities:            pf.amenities?.map(a => a.name) || null,
    cover_image:          pf.images?.[0] || null,
    source_url:           pf.shareUrl ? `${PF_BASE}${pf.shareUrl}` : null,
    last_scraped_at:      new Date().toISOString(),
    
    // Private (not in table, used for related tables)
    _dev_logo:   pf.developer?.logoUrl || null,
    _images:     pf.images || [],
    _hotness:    pf.hotnessLevel || null,
    _dev_id_ext: pf.developer?.id || null,
  };
}

// ── Supabase ──────────────────────────────────────────────────────────────────

let sb = null;
function getSupabase() {
  if (!sb) {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) throw new Error('Missing Supabase env vars');
    sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  }
  return sb;
}

const devCache = new Map();
async function upsertDeveloper(name, logoUrl) {
  if (devCache.has(name)) return devCache.get(name);
  const supabase = getSupabase();
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  let { data, error } = await supabase
    .from('developers').upsert({ name, slug, logo_url: logoUrl }, { onConflict: 'name' })
    .select('id').single();
  if (error) {
    const { data: ex } = await supabase.from('developers').select('id').eq('name', name).single();
    data = ex;
  }
  devCache.set(name, data?.id || null);
  return data?.id || null;
}

async function upsertProject(p, devId, runId) {
  const supabase = getSupabase();
  const rec = {
    external_id:          p.external_id,
    source:               p.source,
    name:                 p.name,
    slug:                 p.slug,
    developer_id:         devId,
    developer_name:       p.developer_name,
    area:                 p.area,
    location:             p.location,
    price_min:            p.price_min,
    price_max:            p.price_max,
    status:               p.status,
    construction_progress: p.construction_progress,
    completion_date:      p.completion_date,
    bedrooms_available:   p.bedrooms_available,
    down_payment:         p.down_payment,
    during_construction:  p.during_construction,
    on_completion:        p.on_completion,
    amenities:            p.amenities,
    cover_image:          p.cover_image,
    source_url:           p.source_url,
    last_scraped_at:      p.last_scraped_at,
  };
  if (p.lat && p.lng) { rec.lat = p.lat; rec.lng = p.lng; }
  
  const { data, error } = await supabase.from('projects')
    .upsert(rec, { onConflict: 'external_id' }).select('id').single();
  if (error) { log(`  Upsert error ${p.name}: ${error.message}`); return null; }
  return data?.id || null;
}

async function upsertImages(projectId, images) {
  if (!images?.length) return;
  const supabase = getSupabase();
  const recs = images.slice(0, 10).map((url, i) => ({
    project_id: projectId, url, sort_order: i,
  }));
  // Insert ignoring duplicates (no unique constraint on sort_order, just insert new)
  await supabase.from('project_images').insert(recs, { ignoreDuplicates: true });
}

async function recordPrice(projectId, price) {
  if (!projectId || !price) return;
  const today = new Date().toISOString().split('T')[0];
  await getSupabase().from('price_history').upsert(
    { project_id: projectId, recorded_date: today, price_min: price, source: 'pf-html' },
    { onConflict: 'project_id,recorded_date', ignoreDuplicates: true }
  );
}

async function createRun() {
  const { data } = await getSupabase().from('scraper_runs')
    .insert({ source: 'pf-html', status: 'running', started_at: new Date().toISOString() })
    .select('id').single();
  return data?.id || null;
}

async function finaliseRun(runId, stats) {
  await getSupabase().from('scraper_runs').update({
    status: 'completed', completed_at: new Date().toISOString(),
    projects_found: stats.found, projects_new: stats.created,
    projects_updated: stats.updated, errors: stats.errors,
  }).eq('id', runId);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  log(`RAQAM Scraper v3 | mode=${MODE} dry_run=${DRY_RUN}`);

  let runId = null;
  if (!DRY_RUN) runId = await createRun();
  if (runId) log(`Run ID: ${runId}`);

  const stats = { found: 0, dubai: 0, created: 0, updated: 0, errors: 0 };

  log('Fetching page 1 to get totals...');
  const first = await fetchPage(1);
  const { totalPages, totalProjects } = first;
  log(`Total: ${totalProjects} projects, ${totalPages} pages`);

  let allProjects = [...first.projects];

  if (MODE !== 'price-refresh') {
    const limit = pLimit(3);
    const pages = Array.from({ length: totalPages - 1 }, (_, i) => i + 2);
    log(`Fetching ${pages.length} more pages (3 concurrent)...`);

    const results = await Promise.allSettled(
      pages.map(n => limit(async () => {
        const r = await fetchPage(n);
        if (n % 20 === 0) log(`  Progress: page ${n}/${totalPages}`);
        return r.projects;
      }))
    );

    for (const r of results) {
      if (r.status === 'fulfilled') allProjects = allProjects.concat(r.value);
      else { stats.errors++; log(`  Page error: ${r.reason?.message}`); }
    }
  }

  const dubaiProjects = allProjects.filter(isDubaiProject);
  stats.found = allProjects.length;
  stats.dubai = dubaiProjects.length;
  log(`Found ${stats.found} total, ${stats.dubai} in Dubai`);

  if (DRY_RUN) {
    log('DRY RUN — first 5 Dubai projects:');
    dubaiProjects.slice(0, 5).forEach(p =>
      log(`  ${p.title} | ${p.location?.fullName} | AED ${p.startingPrice?.toLocaleString() || 'N/A'}`)
    );
    log(`Would upsert ${stats.dubai} projects`);
    return;
  }

  log('Upserting to Supabase...');
  const upsertLimit = pLimit(5);

  await Promise.all(
    dubaiProjects.map(pfProject => upsertLimit(async () => {
      try {
        const n = normaliseProject(pfProject);
        const devId = await upsertDeveloper(n.developer_name, n._dev_logo);

        const { data: existing } = await getSupabase()
          .from('projects').select('id').eq('external_id', n.external_id).single();

        const projectId = await upsertProject(n, devId, runId);
        if (!projectId) { stats.errors++; return; }

        if (existing) stats.updated++; else stats.created++;

        if (MODE !== 'price-refresh') await upsertImages(projectId, n._images);
        if (n.price_min) await recordPrice(projectId, n.price_min);

      } catch (err) {
        stats.errors++;
        log(`  Error on ${pfProject.title}: ${err.message}`);
      }
    }))
  );

  log(`Done — created=${stats.created} updated=${stats.updated} errors=${stats.errors}`);
  if (runId) await finaliseRun(runId, stats);
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
