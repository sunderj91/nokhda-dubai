/**
 * RAQAM Dubai Project Scraper v2
 * Uses Bayut's internal JSON API (same endpoint their mobile app uses)
 * Much more reliable than HTML scraping — returns structured data directly
 */

import axios from 'axios';
import { createClient } from '@supabase/supabase-js';
import pLimit from 'p-limit';
import 'dotenv/config';

// ── Config ────────────────────────────────────────────────────────────────────

const DRY_RUN     = process.argv.includes('--dry-run');
const SOURCE      = process.argv.find(a => a.startsWith('--source='))?.split('=')[1] || 'all';
const AREA_FILTER = process.argv.find(a => a.startsWith('--area='))?.split('=')[1];

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

function log(msg) {
  console.log(`[${new Date().toISOString().split('T')[1].split('.')[0]}] ${msg}`);
}

// ── Bayut GraphQL API ─────────────────────────────────────────────────────────
// Bayut uses a public GraphQL endpoint — no auth required, structured JSON response

const BAYUT_API = 'https://gateway.bayut.com/api/graphql';

const BAYUT_HEADERS = {
  'Content-Type':  'application/json',
  'User-Agent':    'Bayut/24.1.0 (iPhone; iOS 17.0; Scale/3.00)',
  'X-Bayut-Site':  'bayut',
  'Accept':        'application/json',
  'Origin':        'https://www.bayut.com',
  'Referer':       'https://www.bayut.com/',
};

const PROJECTS_QUERY = `
query GetOffPlanProjects($locationExternalIDs: [String!], $page: Int, $hitsPerPage: Int) {
  properties(
    purpose: "for-sale"
    rentFrequency: null
    categoryExternalID: "4"
    locationExternalIDs: $locationExternalIDs
    offPlan: true
    page: $page
    hitsPerPage: $hitsPerPage
    lang: "en"
    sort: "date_desc"
  ) {
    total
    properties {
      id
      externalID
      title
      slug
      purpose
      type { name }
      category { name }
      location { name externalID level }
      geography { lat lng }
      price
      rentFrequency
      rooms
      baths
      area
      coverPhoto { url }
      photos { url }
      agency { name logo { url } }
      project {
        id
        title
        imageCount
        coverPhoto { url }
        photos { url }
        description
        amenities { text }
        completionDetails {
          completionDate
          percentComplete
          constructionStatus
          isOffPlan
        }
        paymentPlanSummary {
          downPaymentPercentage
          installmentsPaymentPercentage
          handoverPaymentPercentage
        }
        stats {
          areaRange { min max }
          priceRange { min max }
          bedrooms { text count }
        }
        floorPlans { url }
        developer { name url logoUrl }
      }
      floorArea { min max }
      pricePerUnitArea
      keywords
      state
    }
  }
}`;

// ── Dubai area location IDs (Bayut's internal IDs) ────────────────────────────

const DUBAI_LOCATIONS = [
  { name: 'Downtown Dubai',             id: '5002' },
  { name: 'Dubai Marina',               id: '5001' },
  { name: 'Business Bay',               id: '5169' },
  { name: 'Palm Jumeirah',              id: '5226' },
  { name: 'Dubai Hills Estate',         id: '91006' },
  { name: 'Dubai Creek Harbour',        id: '91011' },
  { name: 'Jumeirah Village Circle',    id: '6020' },
  { name: 'Mohammed Bin Rashid City',   id: '91007' },
  { name: 'Dubai South',                id: '91009' },
  { name: 'Jumeirah Beach Residence',   id: '5003' },
  { name: 'DAMAC Hills',                id: '91015' },
  { name: 'Arjan',                      id: '91017' },
  { name: 'Jumeirah Lake Towers',       id: '5116' },
  { name: 'Meydan',                     id: '91008' },
  { name: 'Dubai Harbour',              id: '91012' },
  { name: 'Al Jaddaf',                  id: '5172' },
  { name: 'City Walk',                  id: '91013' },
  { name: 'Bluewaters Island',          id: '91014' },
  { name: 'Emaar Beachfront',           id: '91016' },
  { name: 'Sobha Hartland',             id: '91018' },
  { name: 'District One',               id: '91019' },
  { name: 'Arabian Ranches',            id: '5246' },
  { name: 'Al Furjan',                  id: '91020' },
  { name: 'Dubai Investment Park',      id: '5178' },
  { name: 'Dubai Sports City',          id: '91021' },
  { name: 'Motor City',                 id: '5213' },
  { name: 'Deira',                      id: '5010' },
  { name: 'Bur Dubai',                  id: '5011' },
  { name: 'Dubai Silicon Oasis',        id: '5174' },
  { name: 'Ras Al Khor',                id: '5182' },
];

// ── Scrape one location ───────────────────────────────────────────────────────

async function scrapeLocation(location) {
  const projects = [];
  let page = 0;
  const hitsPerPage = 25;

  while (true) {
    try {
      const res = await axios.post(BAYUT_API, {
        query: PROJECTS_QUERY,
        variables: {
          locationExternalIDs: [location.id],
          page,
          hitsPerPage,
        }
      }, { headers: BAYUT_HEADERS, timeout: 20000 });

      const data = res.data?.data?.properties;
      if (!data || !data.properties?.length) break;

      log(`  [${location.name}] page ${page}: ${data.properties.length} listings (total: ${data.total})`);

      for (const p of data.properties) {
        const proj = normalise(p, location);
        if (proj) projects.push(proj);
      }

      // Check if more pages
      if ((page + 1) * hitsPerPage >= data.total || data.properties.length < hitsPerPage) break;
      page++;

      await sleep(800);
    } catch (err) {
      log(`  [${location.name}] API error: ${err.message}`);
      break;
    }
  }

  return projects;
}

// ── Normalise API response → our schema ──────────────────────────────────────

function normalise(p, location) {
  try {
    const proj = p.project;
    const name = proj?.title || p.title;
    if (!name) return null;

    const externalId = `bayut-${p.externalID || p.id}`;

    // Price
    const priceMin = proj?.stats?.priceRange?.min || p.price || null;
    const priceMax = proj?.stats?.priceRange?.max || null;
    const priceAvg = priceMin && priceMax ? Math.round((priceMin + priceMax) / 2) : priceMin;

    // PSF
    const psfAvg = p.pricePerUnitArea ? Math.round(p.pricePerUnitArea) : null;

    // Completion
    const completion = proj?.completionDetails;
    const completionDate = completion?.completionDate || null;
    const constructionProgress = completion?.percentComplete || null;
    const status = completion?.isOffPlan === false ? 'ready'
      : constructionProgress > 0 ? 'under-construction' : 'off-plan';

    // Payment plan
    const pp = proj?.paymentPlanSummary;
    const downPayment = pp?.downPaymentPercentage || null;
    const onCompletion = pp?.handoverPaymentPercentage || null;
    const duringConstruction = pp?.installmentsPaymentPercentage || null;

    // Bedrooms
    const bedrooms = (proj?.stats?.bedrooms || []).map(b => b.text?.toLowerCase()
      .replace('studio', 'studio')
      .replace(' bedroom', 'br')
      .replace(' bedrooms', 'br'));

    // Images
    const coverImage = proj?.coverPhoto?.url || p.coverPhoto?.url || null;
    const extraImages = (proj?.photos || p.photos || []).map(ph => ph.url).filter(Boolean).slice(0, 8);

    // Amenities
    const amenities = (proj?.amenities || []).map(a => a.text).filter(Boolean).slice(0, 15);

    // Developer
    const developerName = proj?.developer?.name || p.agency?.name || null;

    // Coordinates
    const lat = p.geography?.lat || null;
    const lng = p.geography?.lng || null;

    // Type
    const typeRaw = (p.type?.name || p.category?.name || '').toLowerCase();
    const type = typeRaw.includes('villa') ? 'villa'
      : typeRaw.includes('townhouse') ? 'townhouse'
      : typeRaw.includes('penthouse') ? 'penthouse'
      : typeRaw.includes('commercial') ? 'commercial' : 'apartment';

    return {
      external_id:            externalId,
      name,
      developer_name:         developerName,
      area:                   location.name,
      lat,
      lng,
      type,
      status,
      price_min:              priceMin,
      price_max:              priceMax,
      price_avg:              priceAvg,
      psf_avg:                psfAvg,
      bedrooms_available:     bedrooms.filter(Boolean),
      completion_date:        completionDate ? completionDate.split('T')[0] : null,
      construction_progress:  constructionProgress,
      down_payment:           downPayment,
      on_completion:          onCompletion,
      during_construction:    duringConstruction,
      amenities,
      description:            proj?.description || null,
      cover_image:            coverImage,
      units_total:            null,
      source:                 'bayut',
      source_url:             `https://www.bayut.com/property/details-${p.externalID}.html`,
      _extra_images:          extraImages,
    };
  } catch (err) {
    return null;
  }
}

// ── Supabase upsert ───────────────────────────────────────────────────────────

async function upsertProject(supabase, project) {
  // Upsert developer
  let developerId = null;
  if (project.developer_name) {
    const slug = project.developer_name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
    const { data: dev } = await supabase
      .from('developers')
      .upsert({ name: project.developer_name, slug }, { onConflict: 'slug' })
      .select('id').single();
    developerId = dev?.id || null;
  }

  // Slug
  const slug = `${project.name}-${project.area}`
    .toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').slice(0, 80)
    + '-' + (project.external_id || '').split('-').pop();

  const { _extra_images, ...projectData } = project;

  const { data: saved, error } = await supabase
    .from('projects')
    .upsert({ ...projectData, slug, developer_id: developerId, last_scraped_at: new Date().toISOString() },
      { onConflict: 'external_id' })
    .select('id').single();

  if (error) { log(`  DB error: ${error.message}`); return null; }

  const projectId = saved.id;

  // Images
  if (_extra_images?.length > 0) {
    const imageRecords = _extra_images.map((url, i) => ({
      project_id: projectId, url, original_url: url,
      sort_order: i, image_type: i === 0 ? 'cover' : 'gallery',
    }));
    await supabase.from('project_images')
      .upsert(imageRecords, { onConflict: 'project_id,sort_order', ignoreDuplicates: true });
  }

  // Price history snapshot
  if (project.psf_avg || project.price_min) {
    await supabase.from('price_history').upsert({
      project_id: projectId,
      recorded_date: new Date().toISOString().split('T')[0],
      psf_avg: project.psf_avg,
      price_min: project.price_min,
      price_max: project.price_max,
      source: 'bayut',
    }, { onConflict: 'project_id,recorded_date' });
  }

  return projectId;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function dedup(arr) {
  const seen = new Set();
  return arr.filter(p => { const k = p.external_id; if (seen.has(k)) return false; seen.add(k); return true; });
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  log(`🚀 RAQAM Scraper v2 — ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`);

  const supabase = DRY_RUN ? null : createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  const locations = AREA_FILTER
    ? DUBAI_LOCATIONS.filter(l => l.name.toLowerCase().includes(AREA_FILTER.toLowerCase()))
    : DUBAI_LOCATIONS;

  log(`Scraping ${locations.length} areas via Bayut GraphQL API...`);

  // Log run start
  let runId = null;
  if (supabase) {
    const { data: run } = await supabase.from('scraper_runs')
      .insert({ source: 'bayut-graphql', status: 'running' }).select('id').single();
    runId = run?.id;
  }

  const allProjects = [];

  for (const loc of locations) {
    log(`Scraping ${loc.name}...`);
    const projects = await scrapeLocation(loc);
    log(`  → ${projects.length} projects`);
    allProjects.push(...projects);
    await sleep(500);
  }

  const unique = dedup(allProjects);
  log(`\nTotal unique projects: ${unique.length}`);

  if (DRY_RUN) {
    log('\n=== DRY RUN — sample output ===');
    unique.slice(0, 8).forEach(p =>
      log(`  ${p.name} | ${p.developer_name || 'Unknown'} | ${p.area} | AED ${p.price_min?.toLocaleString() || 'N/A'} | ${p.status}`)
    );
    log(`\nWould save ${unique.length} projects to Supabase.`);
    return;
  }

  // Save to DB
  log('\nSaving to Supabase...');
  const limit = pLimit(3);
  let saved = 0, errors = 0;

  await Promise.all(unique.map(p => limit(async () => {
    const id = await upsertProject(supabase, p);
    if (id) saved++; else errors++;
  })));

  // Update run log
  if (supabase && runId) {
    await supabase.from('scraper_runs').update({
      completed_at: new Date().toISOString(),
      projects_found: unique.length,
      projects_new: saved,
      errors,
      status: 'completed',
    }).eq('id', runId);
  }

  log(`\n✅ Done — ${saved} saved, ${errors} errors`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
