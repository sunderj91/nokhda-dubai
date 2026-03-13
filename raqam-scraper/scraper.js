/**
 * RAQAM Dubai Project Scraper v4
 * Source: Property Finder /en/new-projects (list pages + detail enrichment)
 *
 * v4 changes vs v3:
 * - PSF computed from unit data on detail page (startingPrice / areaFrom)
 * - Description scraped from detail page (HTML stripped to plain text)
 * - units_total, floors, completion_quarter captured
 * - --mode=enrich  → only fetch detail pages for projects missing psf/description
 * - --mode=full    → scrape all list pages + enrich all Dubai projects
 * - --mode=price-refresh → update prices only (no detail fetch)
 */

import axios from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';

const _proxyUrl = process.env.https_proxy || process.env.HTTPS_PROXY;
const httpsAgent = _proxyUrl ? new HttpsProxyAgent(_proxyUrl) : undefined;
const axCfg = httpsAgent ? { httpsAgent, proxy: false } : {};

import * as cheerio from 'cheerio';
import { createClient } from '@supabase/supabase-js';
import pLimit from 'p-limit';
import 'dotenv/config';

const DRY_RUN = process.argv.includes('--dry-run');
const MODE    = process.argv.find(a => a.startsWith('--mode='))?.split('=')[1] || 'full';

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

function stripHtml(html) {
  if (!html) return null;
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, 1000) || null;
}

function computePsf(units) {
  const psfs = [];
  for (const building of (units || [])) {
    for (const propType of (building?.units || [])) {
      for (const unit of (propType?.list || [])) {
        if (unit.startingPrice && unit.areaFrom && unit.areaFrom > 0) {
          psfs.push(Math.round(unit.startingPrice / unit.areaFrom));
        }
      }
    }
  }
  if (!psfs.length) return { psf_min: null, psf_max: null, psf_avg: null };
  const sorted = [...psfs].sort((a, b) => a - b);
  return {
    psf_min: sorted[0],
    psf_max: sorted[sorted.length - 1],
    psf_avg: Math.round(psfs.reduce((a, b) => a + b, 0) / psfs.length),
  };
}

function computeUnitsTotal(units) {
  let total = 0;
  for (const building of (units || [])) {
    for (const propType of (building?.units || [])) {
      for (const unit of (propType?.list || [])) {
        total += unit.totalUnits || 0;
      }
    }
  }
  return total || null;
}

async function fetchPage(pageNum, retries = 3) {
  const url = `${PF_BASE}/en/new-projects?page=${pageNum}`;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await axios.get(url, { headers: PF_HEADERS, timeout: 30000, ...axCfg });
      const $ = cheerio.load(res.data);
      let nextData = null;
      $('script').each((_, el) => {
        const text = $(el).html() || '';
        if (text.includes('pageProps') && text.includes('"projects"')) {
          try { const s = text.indexOf('{'); if (s >= 0) nextData = JSON.parse(text.slice(s)); } catch {}
        }
      });
      if (!nextData) throw new Error('No page data');
      const sr = nextData?.props?.pageProps?.searchResult;
      if (!sr) throw new Error('No searchResult');
      return { projects: sr.data?.projects || [], totalPages: sr.meta?.pagination?.total || 1, totalProjects: sr.meta?.count?.total || 0 };
    } catch (err) {
      if (attempt === retries) throw err;
      log(`  Page ${pageNum} attempt ${attempt} failed: ${err.message}`);
      await new Promise(r => setTimeout(r, 2000 * attempt));
    }
  }
}

async function fetchDetail(slug, retries = 3) {
  const url = `${PF_BASE}/en/new-projects/${slug}`;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await axios.get(url, { headers: PF_HEADERS, timeout: 30000, ...axCfg });
      const $ = cheerio.load(res.data);
      let nd = null;
      $('script').each((_, el) => {
        const t = $(el).html() || '';
        if (t.includes('detailResult') && t.length > 500) {
          try { nd = JSON.parse(t.slice(t.indexOf('{'))); } catch {}
        }
      });
      return nd?.props?.pageProps?.detailResult || null;
    } catch (err) {
      if (attempt === retries) return null;
      await new Promise(r => setTimeout(r, 1500 * attempt));
    }
  }
  return null;
}

function isDubaiProject(pf) {
  const loc = (pf.location?.fullName || '').toLowerCase();
  if (loc.includes('dubai')) return true;
  return DUBAI_KEYWORDS.some(kw => loc.includes(kw));
}

function normaliseProject(pf) {
  const locParts = (pf.location?.fullName || '').split(',').map(s => s.trim());
  const area = locParts.length >= 2 ? locParts[1] : locParts[0] || 'Dubai';
  let completionDate = null, completionQuarter = null;
  if (pf.deliveryDate) {
    try {
      completionDate = pf.deliveryDate.split('T')[0];
      const d = new Date(pf.deliveryDate);
      completionQuarter = `Q${Math.ceil((d.getMonth()+1)/3)} ${d.getFullYear()}`;
    } catch {}
  }
  let downPayment = null, duringConstruction = null, onCompletion = null, paymentYears = null;
  if (pf.paymentPlans?.length > 0) {
    const pl = pf.paymentPlans[0];
    downPayment = pl.downPayment || null;
    duringConstruction = pl.duringConstruction || null;
    onCompletion = pl.onHandover || null;
    paymentYears = pl.years || null;
  }
  if (pf.downPaymentPercentage) downPayment = pf.downPaymentPercentage;
  const statusMap = { under_construction:'under-construction', off_plan:'off-plan', completed:'ready', ready:'ready' };
  const status = statusMap[pf.constructionPhase] || 'off-plan';
  const beds = (pf.bedrooms || []).map(b => b === 'studio' ? 0 : parseInt(b)).filter(n => isFinite(n));
  const slug = (pf.title||'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'') + '-' + (pf.id||'').split('-')[0];
  const pfSlug = pf.shareUrl?.replace('/en/new-projects/','') || null;
  return {
    external_id: `pf-${pf.id}`, source: 'scraped', name: pf.title || 'Unknown', slug,
    developer_name: pf.developer?.name || 'Unknown', area, location: pf.location?.fullName || area,
    lat: pf.location?.coordinates?.lat || null, lng: pf.location?.coordinates?.lng || pf.location?.coordinates?.lon || null,
    price_min: pf.startingPrice || null, price_max: pf.minResalePrice || pf.startingPrice || null,
    status, construction_progress: pf.constructionProgress ? Math.round(pf.constructionProgress) : null,
    completion_date: completionDate, completion_quarter: completionQuarter,
    bedrooms_available: beds.length > 0 ? beds : null,
    down_payment: downPayment, during_construction: duringConstruction, on_completion: onCompletion, payment_years: paymentYears,
    amenities: pf.amenities?.map(a => a.name) || null,
    cover_image: pf.images?.[0] || null, source_url: pf.shareUrl ? `${PF_BASE}${pf.shareUrl}` : null,
    last_scraped_at: new Date().toISOString(),
    psf_min: null, psf_max: null, psf_avg: null, description: null, units_total: null, floors: null,
    _dev_logo: pf.developer?.logoUrl || null, _images: pf.images || [], _pf_slug: pfSlug,
  };
}

function enrichFromDetail(n, dr) {
  if (!dr) return n;
  const psf = computePsf(dr.units);
  const desc = stripHtml(dr.description);
  const units = computeUnitsTotal(dr.units);
  let floors = null;
  for (const b of (dr.units || [])) { if (b?.buildingInfo?.floors) { floors = b.buildingInfo.floors; break; } }
  return { ...n, psf_min: psf.psf_min, psf_max: psf.psf_max, psf_avg: psf.psf_avg,
    description: desc, units_total: units, floors, price_max: dr.minResalePrice || n.price_max };
}

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
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
  let { data, error } = await supabase.from('developers').upsert({ name, slug, logo_url: logoUrl }, { onConflict: 'name' }).select('id').single();
  if (error) { const { data: ex } = await supabase.from('developers').select('id').eq('name', name).single(); data = ex; }
  devCache.set(name, data?.id || null);
  return data?.id || null;
}

async function upsertProject(p, devId) {
  const supabase = getSupabase();
  const rec = {
    external_id: p.external_id, source: p.source, name: p.name, slug: p.slug,
    developer_id: devId, developer_name: p.developer_name, area: p.area, location: p.location,
    price_min: p.price_min, price_max: p.price_max, status: p.status,
    construction_progress: p.construction_progress, completion_date: p.completion_date,
    completion_quarter: p.completion_quarter, bedrooms_available: p.bedrooms_available,
    down_payment: p.down_payment, during_construction: p.during_construction,
    on_completion: p.on_completion, payment_years: p.payment_years,
    amenities: p.amenities, cover_image: p.cover_image, source_url: p.source_url,
    last_scraped_at: p.last_scraped_at,
    ...(p.psf_min     != null && { psf_min: p.psf_min }),
    ...(p.psf_max     != null && { psf_max: p.psf_max }),
    ...(p.psf_avg     != null && { psf_avg: p.psf_avg }),
    ...(p.description != null && { description: p.description }),
    ...(p.units_total != null && { units_total: p.units_total }),
    ...(p.floors      != null && { floors: p.floors }),
  };
  if (p.lat && p.lng) { rec.lat = p.lat; rec.lng = p.lng; }
  const { data, error } = await supabase.from('projects').upsert(rec, { onConflict: 'external_id' }).select('id').single();
  if (error) { log(`  Upsert error ${p.name}: ${error.message}`); return null; }
  return data?.id || null;
}

async function upsertImages(projectId, images) {
  if (!images?.length) return;
  const recs = images.slice(0, 10).map((url, i) => ({ project_id: projectId, url, sort_order: i }));
  await getSupabase().from('project_images').insert(recs, { ignoreDuplicates: true });
}

async function recordPrice(projectId, price) {
  if (!projectId || !price) return;
  const today = new Date().toISOString().split('T')[0];
  await getSupabase().from('price_history').upsert(
    { project_id: projectId, recorded_date: today, price_min: price, source: 'pf-html' },
    { onConflict: 'project_id,recorded_date', ignoreDuplicates: true }
  );
}

async function createRun(mode) {
  const { data } = await getSupabase().from('scraper_runs')
    .insert({ source: `pf-html-v4-${mode}`, status: 'running', started_at: new Date().toISOString() })
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

async function runEnrich() {
  log('MODE: enrich — fetching detail pages for projects missing psf/description');
  const supabase = getSupabase();
  const { data: projects, error } = await supabase
    .from('projects').select('id, name, source_url')
    .eq('source', 'scraped').or('psf_min.is.null,description.is.null')
    .not('source_url', 'is', null).limit(2200);
  if (error) throw error;
  log(`Found ${projects.length} projects needing enrichment`);
  const stats = { enriched: 0, errors: 0 };
  const limit = pLimit(3);
  await Promise.all(projects.map(proj => limit(async () => {
    try {
      const slug = proj.source_url?.replace(`${PF_BASE}/en/new-projects/`, '');
      if (!slug) return;
      const dr = await fetchDetail(slug);
      if (!dr) { stats.errors++; return; }
      const psf = computePsf(dr.units);
      const desc = stripHtml(dr.description);
      const units = computeUnitsTotal(dr.units);
      let floors = null;
      for (const b of (dr.units||[])) { if (b?.buildingInfo?.floors) { floors = b.buildingInfo.floors; break; } }
      const update = {};
      if (psf.psf_min)  { update.psf_min = psf.psf_min; update.psf_max = psf.psf_max; update.psf_avg = psf.psf_avg; }
      if (desc)         update.description = desc;
      if (units)        update.units_total = units;
      if (floors)       update.floors = floors;
      if (!Object.keys(update).length) return;
      const { error: uErr } = await supabase.from('projects').update(update).eq('id', proj.id);
      if (uErr) { stats.errors++; return; }
      stats.enriched++;
      if (stats.enriched % 50 === 0) log(`  Enriched ${stats.enriched}/${projects.length}...`);
    } catch (err) {
      stats.errors++;
      log(`  Error ${proj.name}: ${err.message}`);
    }
  })));
  log(`Enrichment done — enriched=${stats.enriched} errors=${stats.errors}`);
  return stats;
}

async function main() {
  log(`RAQAM Scraper v4 | mode=${MODE} dry_run=${DRY_RUN}`);

  if (MODE === 'enrich') {
    if (DRY_RUN) { log('DRY RUN — would enrich projects missing psf/description'); return; }
    const runId = await createRun('enrich');
    const stats = await runEnrich();
    await finaliseRun(runId, { found: stats.enriched + stats.errors, created: 0, updated: stats.enriched, errors: stats.errors });
    return;
  }

  let runId = null;
  if (!DRY_RUN) runId = await createRun(MODE);

  const stats = { found: 0, dubai: 0, created: 0, updated: 0, errors: 0 };
  log('Fetching page 1...');
  const first = await fetchPage(1);
  const { totalPages, totalProjects } = first;
  log(`Total: ${totalProjects} projects, ${totalPages} pages`);
  let allProjects = [...first.projects];

  if (MODE !== 'price-refresh') {
    const limit = pLimit(3);
    const pages = Array.from({ length: totalPages - 1 }, (_, i) => i + 2);
    log(`Fetching ${pages.length} more pages...`);
    const results = await Promise.allSettled(pages.map(n => limit(async () => {
      const r = await fetchPage(n);
      if (n % 20 === 0) log(`  Progress: page ${n}/${totalPages}`);
      return r.projects;
    })));
    for (const r of results) {
      if (r.status === 'fulfilled') allProjects = allProjects.concat(r.value);
      else { stats.errors++; log(`  Page error: ${r.reason?.message}`); }
    }
  }

  const dubaiProjects = allProjects.filter(isDubaiProject);
  stats.found = allProjects.length;
  stats.dubai = dubaiProjects.length;
  log(`Found ${stats.found} total, ${stats.dubai} Dubai`);

  if (DRY_RUN) { log('DRY RUN done'); return; }

  const upsertLimit = pLimit(4);
  await Promise.all(dubaiProjects.map(pfProject => upsertLimit(async () => {
    try {
      let n = normaliseProject(pfProject);
      const devId = await upsertDeveloper(n.developer_name, n._dev_logo);
      if (n._pf_slug && MODE !== 'price-refresh') {
        const dr = await fetchDetail(n._pf_slug);
        if (dr) n = enrichFromDetail(n, dr);
      }
      const { data: existing } = await getSupabase().from('projects').select('id').eq('external_id', n.external_id).single();
      const projectId = await upsertProject(n, devId);
      if (!projectId) { stats.errors++; return; }
      if (existing) stats.updated++; else stats.created++;
      if (MODE !== 'price-refresh') await upsertImages(projectId, n._images);
      if (n.price_min) await recordPrice(projectId, n.price_min);
    } catch (err) {
      stats.errors++;
      log(`  Error ${pfProject.title}: ${err.message}`);
    }
  })));

  log(`Done — created=${stats.created} updated=${stats.updated} errors=${stats.errors}`);
  if (runId) await finaliseRun(runId, stats);
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
