/**
 * RAQAM Dubai Project Scraper
 * Sources: Bayut.com + PropertyFinder.ae
 * Stores to: Supabase (projects, unit_types, price_history, project_images)
 * 
 * Usage:
 *   node scraper.js               # scrape all
 *   node scraper.js --source=bayut
 *   node scraper.js --area="Dubai Marina"
 *   node scraper.js --dry-run     # print without saving
 */

import axios from 'axios';
import * as cheerio from 'cheerio';
import { createClient } from '@supabase/supabase-js';
import pLimit from 'p-limit';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import 'dotenv/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Config ────────────────────────────────────────────────────────────────────

const CONFIG = {
  supabaseUrl: process.env.SUPABASE_URL,
  supabaseServiceKey: process.env.SUPABASE_SERVICE_KEY,
  
  concurrency: 3,          // parallel requests
  delayMs: 1200,           // polite delay between requests (ms)
  maxPages: 50,            // max pages per area (20 listings/page → 1000 projects)
  downloadImages: true,    // download & upload images to Supabase Storage
  maxImagesPerProject: 8,  // cap images per project
  
  dryRun: process.argv.includes('--dry-run'),
  sourceFilter: process.argv.find(a => a.startsWith('--source='))?.split('=')[1],
  areaFilter: process.argv.find(a => a.startsWith('--area='))?.split('=')[1],
};

// ── Dubai Areas to scrape ─────────────────────────────────────────────────────

const DUBAI_AREAS = [
  { name: 'Downtown Dubai', bayutSlug: 'downtown-dubai' },
  { name: 'Dubai Marina', bayutSlug: 'dubai-marina' },
  { name: 'Business Bay', bayutSlug: 'business-bay' },
  { name: 'Palm Jumeirah', bayutSlug: 'palm-jumeirah' },
  { name: 'Dubai Hills Estate', bayutSlug: 'dubai-hills-estate' },
  { name: 'Dubai Creek Harbour', bayutSlug: 'dubai-creek-harbour' },
  { name: 'Jumeirah Village Circle', bayutSlug: 'jumeirah-village-circle' },
  { name: 'Mohammed Bin Rashid City', bayutSlug: 'mohammed-bin-rashid-city' },
  { name: 'Dubai South', bayutSlug: 'dubai-south' },
  { name: 'Jumeirah Beach Residence', bayutSlug: 'jumeirah-beach-residence' },
  { name: 'DAMAC Hills', bayutSlug: 'damac-hills' },
  { name: 'Arjan', bayutSlug: 'arjan' },
  { name: 'Jumeirah Lake Towers', bayutSlug: 'jumeirah-lake-towers' },
  { name: 'Meydan', bayutSlug: 'meydan' },
  { name: 'Dubai Harbour', bayutSlug: 'dubai-harbour' },
  { name: 'Al Jaddaf', bayutSlug: 'al-jaddaf' },
  { name: 'City Walk', bayutSlug: 'city-walk' },
  { name: 'Bluewaters Island', bayutSlug: 'bluewaters-island' },
  { name: 'Emaar Beachfront', bayutSlug: 'emaar-beachfront' },
  { name: 'Sobha Hartland', bayutSlug: 'sobha-hartland' },
  { name: 'District One', bayutSlug: 'district-one' },
  { name: 'Arabian Ranches', bayutSlug: 'arabian-ranches' },
  { name: 'Al Furjan', bayutSlug: 'al-furjan' },
  { name: 'Dubai Investment Park', bayutSlug: 'dubai-investment-park' },
  { name: 'Dubai Sports City', bayutSlug: 'dubai-sports-city' },
  { name: 'Motor City', bayutSlug: 'motor-city' },
  { name: 'Deira', bayutSlug: 'deira' },
  { name: 'Bur Dubai', bayutSlug: 'bur-dubai' },
  { name: 'Ras Al Khor', bayutSlug: 'ras-al-khor' },
  { name: 'Dubai Silicon Oasis', bayutSlug: 'dubai-silicon-oasis' },
];

// ── HTTP helpers ──────────────────────────────────────────────────────────────

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Cache-Control': 'no-cache',
  'Pragma': 'no-cache',
  'sec-fetch-dest': 'document',
  'sec-fetch-mode': 'navigate',
};

async function fetch(url, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      await sleep(CONFIG.delayMs * (i + 1));
      const res = await axios.get(url, { 
        headers: HEADERS, 
        timeout: 15000,
        maxRedirects: 5,
      });
      return res.data;
    } catch (err) {
      if (i === retries - 1) throw err;
      log(`Retry ${i+1} for ${url}: ${err.message}`);
    }
  }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── Bayut Scraper ─────────────────────────────────────────────────────────────

class BayutScraper {
  constructor() {
    this.source = 'bayut';
    this.baseUrl = 'https://www.bayut.com';
  }

  /**
   * Scrape all off-plan projects for a given area slug
   */
  async scrapeArea(area) {
    const projects = [];
    let page = 1;
    
    while (page <= CONFIG.maxPages) {
      const url = `${this.baseUrl}/to-buy/property/dubai/${area.bayutSlug}/?off_plan=true&page=${page}`;
      log(`[Bayut] Scraping ${area.name} page ${page}...`);
      
      let html;
      try {
        html = await fetch(url);
      } catch (err) {
        log(`[Bayut] Failed to fetch ${url}: ${err.message}`);
        break;
      }
      
      const $ = cheerio.load(html);
      
      // Bayut listing cards (CSS selectors as of early 2026)
      const listings = $('[class*="listing-card"], [data-testid*="listing"]');
      
      if (listings.length === 0) {
        // Also try JSON-LD structured data
        const jsonLdScripts = $('script[type="application/ld+json"]');
        let foundAny = false;
        
        jsonLdScripts.each((_, el) => {
          try {
            const data = JSON.parse($(el).text());
            if (data['@type'] === 'Product' || data['@type'] === 'RealEstateListing') {
              const project = this.parseJsonLd(data, area);
              if (project) { projects.push(project); foundAny = true; }
            }
          } catch(e) {}
        });
        
        if (!foundAny) break; // no more results
      }
      
      listings.each((_, el) => {
        const project = this.parseListing($, el, area);
        if (project) projects.push(project);
      });
      
      // Check for next page
      const hasNext = $('[aria-label="Next page"], .next-page, [class*="nextPage"]').length > 0;
      if (!hasNext) break;
      
      page++;
    }
    
    return projects;
  }

  parseListing($, el, area) {
    try {
      const $el = $(el);
      
      // External ID from URL or data attribute
      const href = $el.find('a[href*="/to-buy/"]').first().attr('href') || 
                   $el.closest('a').attr('href') || '';
      const externalId = href.match(/(\d+)\.html/)?.[1] || 
                         $el.attr('data-id') || 
                         null;
      
      if (!externalId) return null;
      
      const name = $el.find('[class*="title"], [class*="name"], h2, h3').first().text().trim();
      const developer = $el.find('[class*="developer"], [class*="agency"]').first().text().trim();
      
      // Price parsing
      const priceText = $el.find('[class*="price"]').first().text().replace(/[^0-9,]/g, '').replace(/,/g, '');
      const priceMin = parseInt(priceText) || null;
      
      // PSF parsing
      const psfText = $el.find('[class*="psf"], [class*="per-sqft"]').first().text();
      const psfMatch = psfText.match(/[\d,]+/);
      const psfAvg = psfMatch ? parseInt(psfMatch[0].replace(/,/g, '')) : null;
      
      // Completion date
      const completionText = $el.find('[class*="completion"], [class*="handover"]').first().text().trim();
      const completionDate = parseCompletionDate(completionText);
      
      // Image
      const img = $el.find('img[src*="bayut"], img[src*="propertyfinder"]').first().attr('src') ||
                  $el.find('img').first().attr('src') || null;
      
      // Type
      const typeText = $el.find('[class*="type"], [class*="category"]').first().text().toLowerCase();
      const type = inferType(typeText);
      
      // Bedrooms
      const bedsText = $el.find('[class*="bed"], [aria-label*="bed"]').first().text();
      
      return {
        external_id: `bayut-${externalId}`,
        name: name || `Off-Plan Project ${externalId}`,
        developer_name: developer || null,
        area: area.name,
        price_min: priceMin,
        price_max: null,
        price_avg: priceMin,
        psf_avg: psfAvg,
        completion_date: completionDate,
        status: 'off-plan',
        type: type,
        cover_image: img,
        source: 'bayut',
        source_url: `${this.baseUrl}${href}`,
      };
    } catch (err) {
      return null;
    }
  }

  parseJsonLd(data, area) {
    try {
      return {
        external_id: `bayut-jld-${data.identifier || data.url?.match(/(\d+)/)?.[1]}`,
        name: data.name,
        developer_name: data.seller?.name || null,
        area: area.name,
        price_min: data.offers?.price || null,
        description: data.description || null,
        cover_image: Array.isArray(data.image) ? data.image[0] : data.image,
        source: 'bayut',
        source_url: data.url,
        status: 'off-plan',
      };
    } catch { return null; }
  }

  /**
   * Fetch full project detail page for enriched data
   */
  async scrapeProjectDetail(project) {
    if (!project.source_url) return project;
    
    try {
      const html = await fetch(project.source_url);
      const $ = cheerio.load(html);
      
      // Try to get structured data from page
      const jsonLd = $('script[type="application/ld+json"]').toArray()
        .map(el => { try { return JSON.parse($(el).text()); } catch { return null; } })
        .find(d => d && (d['@type'] === 'Product' || d['@type'] === 'RealEstateListing'));
      
      // Images
      const images = [];
      $('img[src*="bayut"], img[src*="cdn"]').each((_, img) => {
        const src = $(img).attr('src');
        if (src && src.includes('http') && !src.includes('logo') && !src.includes('icon')) {
          images.push(src);
        }
      });
      
      // Description
      const desc = $('[class*="description"], [class*="about"]').first().text().trim().slice(0, 2000);
      
      // Amenities
      const amenities = [];
      $('[class*="amenity"], [class*="feature"] li').each((_, el) => {
        const text = $(el).text().trim();
        if (text) amenities.push(text);
      });
      
      // Floor count
      const floorsText = $('[class*="floor"], [class*="storey"]').first().text();
      const floors = parseInt(floorsText.match(/\d+/)?.[0]) || null;
      
      // Units
      const unitsText = $('[class*="units"], [class*="total"]').first().text();
      const units = parseInt(unitsText.match(/\d+/)?.[0]) || null;
      
      // Payment plan
      const downPayText = $('[class*="down-payment"], [class*="downpayment"]').first().text();
      const downPayMatch = downPayText.match(/(\d+)%/);
      
      // Lat/lng from map embed or data attrs
      const mapEl = $('[data-lat], [data-lng]').first();
      const lat = parseFloat(mapEl.attr('data-lat')) || null;
      const lng = parseFloat(mapEl.attr('data-lng')) || null;
      
      // Bed types
      const bedsAvailable = [];
      $('[class*="bedroom-type"], [class*="unit-type"]').each((_, el) => {
        const text = $(el).text().toLowerCase();
        if (text.includes('studio')) bedsAvailable.push('studio');
        else if (text.match(/\d+\s*bed/)) {
          const n = text.match(/(\d+)\s*bed/)?.[1];
          if (n) bedsAvailable.push(`${n}br`);
        }
      });
      
      return {
        ...project,
        description: desc || project.description,
        amenities: amenities.slice(0, 20),
        floors: floors || project.floors,
        units_total: units || project.units_total,
        down_payment: downPayMatch ? parseInt(downPayMatch[1]) : project.down_payment,
        lat: lat || project.lat,
        lng: lng || project.lng,
        bedrooms_available: bedsAvailable.length > 0 ? bedsAvailable : project.bedrooms_available,
        _images: images.slice(0, CONFIG.maxImagesPerProject),
      };
    } catch (err) {
      log(`[Bayut] Detail fetch failed for ${project.source_url}: ${err.message}`);
      return project;
    }
  }
}

// ── PropertyFinder Scraper ────────────────────────────────────────────────────

class PropertyFinderScraper {
  constructor() {
    this.source = 'propertyfinder';
    this.baseUrl = 'https://www.propertyfinder.ae';
  }

  async scrapeArea(area) {
    const projects = [];
    let page = 1;
    
    // PropertyFinder uses different URL structure
    const areaSlug = area.name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
    
    while (page <= CONFIG.maxPages) {
      const url = `${this.baseUrl}/en/buy/apartments-for-sale-in-${areaSlug}-off-plan.html?page=${page}`;
      log(`[PF] Scraping ${area.name} page ${page}...`);
      
      let html;
      try {
        html = await fetch(url);
      } catch (err) {
        log(`[PF] Failed: ${err.message}`);
        break;
      }
      
      const $ = cheerio.load(html);
      
      // PF uses Next.js — try __NEXT_DATA__ JSON first
      const nextData = extractNextData($);
      if (nextData?.listings) {
        nextData.listings.forEach(listing => {
          const project = this.parseNextListing(listing, area);
          if (project) projects.push(project);
        });
      } else {
        // Fallback to HTML parsing
        $('[class*="card"], [data-testid*="card"]').each((_, el) => {
          const project = this.parseHtmlListing($, el, area);
          if (project) projects.push(project);
        });
      }
      
      const hasNext = $('[aria-label="Next"], .page-next, [class*="paginationNext"]').length > 0;
      if (!hasNext) break;
      page++;
    }
    
    return projects;
  }

  parseNextListing(listing, area) {
    try {
      return {
        external_id: `pf-${listing.id || listing.externalId}`,
        name: listing.project?.name || listing.title || listing.name,
        developer_name: listing.developer?.name || listing.agent?.company || null,
        area: area.name,
        price_min: listing.price?.amount || listing.price?.min || null,
        price_max: listing.price?.max || null,
        psf_avg: listing.pricePerSqft || listing.priceSqft || null,
        completion_date: listing.completionDate ? new Date(listing.completionDate) : null,
        completion_quarter: listing.handoverDate || null,
        lat: listing.coordinates?.lat || listing.location?.lat || null,
        lng: listing.coordinates?.lng || listing.location?.lng || null,
        type: inferType(listing.type || listing.propertyType || ''),
        status: 'off-plan',
        units_total: listing.totalUnits || null,
        bedrooms_available: listing.bedrooms ? [String(listing.bedrooms)] : [],
        cover_image: listing.photos?.[0]?.url || listing.mainImage || null,
        source: 'propertyfinder',
        source_url: `${this.baseUrl}${listing.url || ''}`,
      };
    } catch { return null; }
  }

  parseHtmlListing($, el, area) {
    try {
      const $el = $(el);
      const href = $el.find('a').first().attr('href') || '';
      const id = href.match(/(\d+)/)?.[1];
      if (!id) return null;
      
      return {
        external_id: `pf-${id}`,
        name: $el.find('h2, h3, [class*="title"]').first().text().trim(),
        developer_name: $el.find('[class*="developer"]').first().text().trim() || null,
        area: area.name,
        price_min: parseInt($el.find('[class*="price"]').first().text().replace(/[^0-9]/g, '')) || null,
        type: 'apartment',
        status: 'off-plan',
        cover_image: $el.find('img').first().attr('src') || null,
        source: 'propertyfinder',
        source_url: `${this.baseUrl}${href}`,
      };
    } catch { return null; }
  }
}

// ── Supabase Storage (Image Upload) ──────────────────────────────────────────

async function uploadImageToSupabase(supabase, imageUrl, projectSlug, index) {
  try {
    const res = await axios.get(imageUrl, { 
      responseType: 'arraybuffer', 
      timeout: 10000,
      headers: HEADERS,
    });
    
    const ext = imageUrl.match(/\.(jpg|jpeg|png|webp)/i)?.[1] || 'jpg';
    const filename = `${projectSlug}/${index}.${ext}`;
    const contentType = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
    
    const { data, error } = await supabase.storage
      .from('project-images')
      .upload(filename, res.data, { 
        contentType, 
        upsert: true,
      });
    
    if (error) throw error;
    
    const { data: { publicUrl } } = supabase.storage
      .from('project-images')
      .getPublicUrl(filename);
    
    return publicUrl;
  } catch (err) {
    log(`[Storage] Image upload failed: ${err.message}`);
    return imageUrl; // fallback to original URL
  }
}

// ── Database upsert ───────────────────────────────────────────────────────────

async function upsertProject(supabase, project, runId) {
  // 1. Upsert developer
  let developerId = null;
  if (project.developer_name) {
    const slug = project.developer_name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
    const { data: dev } = await supabase
      .from('developers')
      .upsert({ name: project.developer_name, slug }, { onConflict: 'slug', ignoreDuplicates: false })
      .select('id')
      .single();
    developerId = dev?.id || null;
  }
  
  // 2. Generate slug
  const slug = `${project.name || 'project'}-${project.area}`
    .toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').slice(0, 80)
    + '-' + (project.external_id || '').split('-').pop();
  
  // 3. Handle images
  let coverImage = project.cover_image;
  const extraImages = project._images || [];
  
  if (CONFIG.downloadImages && coverImage) {
    coverImage = await uploadImageToSupabase(supabase, coverImage, slug, 0);
  }
  
  // 4. Upsert project
  const projectData = {
    external_id: project.external_id,
    name: project.name,
    slug,
    developer_id: developerId,
    developer_name: project.developer_name,
    area: project.area,
    lat: project.lat,
    lng: project.lng,
    type: project.type || 'apartment',
    status: project.status || 'off-plan',
    price_min: project.price_min,
    price_max: project.price_max,
    price_avg: project.price_avg || project.price_min,
    psf_avg: project.psf_avg,
    psf_min: project.psf_min,
    psf_max: project.psf_max,
    units_total: project.units_total,
    bedrooms_available: project.bedrooms_available || [],
    completion_date: project.completion_date,
    completion_quarter: project.completion_quarter,
    floors: project.floors,
    down_payment: project.down_payment,
    description: project.description,
    amenities: project.amenities || [],
    cover_image: coverImage,
    source: project.source,
    source_url: project.source_url,
    last_scraped_at: new Date().toISOString(),
  };
  
  const { data: saved, error } = await supabase
    .from('projects')
    .upsert(projectData, { onConflict: 'external_id' })
    .select('id')
    .single();
  
  if (error) {
    log(`[DB] Upsert error for ${project.name}: ${error.message}`);
    return null;
  }
  
  const projectId = saved.id;
  
  // 5. Insert extra images
  if (extraImages.length > 0) {
    const imageRecords = [];
    for (let i = 0; i < extraImages.length; i++) {
      let url = extraImages[i];
      if (CONFIG.downloadImages) {
        url = await uploadImageToSupabase(supabase, url, slug, i + 1);
      }
      imageRecords.push({
        project_id: projectId,
        url,
        original_url: extraImages[i],
        sort_order: i,
        image_type: i === 0 ? 'cover' : 'gallery',
      });
    }
    await supabase.from('project_images').upsert(imageRecords, { onConflict: 'project_id,sort_order', ignoreDuplicates: true });
  }
  
  // 6. Record price history snapshot
  if (project.psf_avg || project.price_min) {
    await supabase.from('price_history').upsert({
      project_id: projectId,
      recorded_date: new Date().toISOString().split('T')[0],
      psf_avg: project.psf_avg,
      psf_min: project.psf_min,
      psf_max: project.psf_max,
      price_min: project.price_min,
      price_max: project.price_max,
      units_available: project.units_available,
      source: project.source,
    }, { onConflict: 'project_id,recorded_date' });
  }
  
  return projectId;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function inferType(text) {
  text = text.toLowerCase();
  if (text.includes('villa')) return 'villa';
  if (text.includes('townhouse') || text.includes('town house')) return 'townhouse';
  if (text.includes('penthouse')) return 'penthouse';
  if (text.includes('commercial') || text.includes('office')) return 'commercial';
  return 'apartment';
}

function parseCompletionDate(text) {
  if (!text) return null;
  const yearMatch = text.match(/20\d{2}/);
  const quarterMatch = text.match(/Q([1-4])/i);
  if (yearMatch) {
    const year = parseInt(yearMatch[0]);
    const quarter = quarterMatch ? parseInt(quarterMatch[1]) : 4;
    const month = quarter * 3;
    return new Date(year, month - 1, 1).toISOString().split('T')[0];
  }
  return null;
}

function extractNextData($) {
  try {
    const script = $('#__NEXT_DATA__').text();
    if (!script) return null;
    const data = JSON.parse(script);
    return data?.props?.pageProps;
  } catch { return null; }
}

function slugify(text) {
  return text.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
}

function log(msg) {
  const ts = new Date().toISOString().split('T')[1].split('.')[0];
  console.log(`[${ts}] ${msg}`);
}

function dedup(projects) {
  const seen = new Set();
  return projects.filter(p => {
    const key = p.external_id || p.name + p.area;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  log('🚀 RAQAM Scraper starting...');
  log(`Mode: ${CONFIG.dryRun ? 'DRY RUN' : 'LIVE'}`);
  
  // Validate env
  if (!CONFIG.supabaseUrl || !CONFIG.supabaseServiceKey) {
    if (!CONFIG.dryRun) {
      console.error('❌ Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in .env');
      process.exit(1);
    }
  }
  
  const supabase = CONFIG.dryRun ? null : createClient(CONFIG.supabaseUrl, CONFIG.supabaseServiceKey);
  
  // Log run start
  let runId = null;
  if (supabase) {
    const { data: run } = await supabase.from('scraper_runs').insert({ source: 'bayut+pf' }).select('id').single();
    runId = run?.id;
  }
  
  const scrapers = [];
  if (!CONFIG.sourceFilter || CONFIG.sourceFilter === 'bayut') scrapers.push(new BayutScraper());
  if (!CONFIG.sourceFilter || CONFIG.sourceFilter === 'pf') scrapers.push(new PropertyFinderScraper());
  
  const areas = CONFIG.areaFilter 
    ? DUBAI_AREAS.filter(a => a.name.toLowerCase().includes(CONFIG.areaFilter.toLowerCase()))
    : DUBAI_AREAS;
  
  log(`Scraping ${areas.length} areas with ${scrapers.length} scrapers`);
  
  let totalNew = 0, totalUpdated = 0, totalErrors = 0;
  const limit = pLimit(CONFIG.concurrency);
  const allProjects = [];
  
  // Collect all projects
  for (const scraper of scrapers) {
    for (const area of areas) {
      try {
        const projects = await scraper.scrapeArea(area);
        log(`[${scraper.source}] ${area.name}: ${projects.length} projects found`);
        allProjects.push(...projects);
      } catch (err) {
        log(`[${scraper.source}] Area failed (${area.name}): ${err.message}`);
        totalErrors++;
      }
    }
  }
  
  // Deduplicate
  const unique = dedup(allProjects);
  log(`Total unique projects: ${unique.length} (from ${allProjects.length} raw)`);
  
  if (CONFIG.dryRun) {
    log('\n=== DRY RUN SAMPLE (first 5) ===');
    unique.slice(0, 5).forEach(p => {
      log(`  ${p.name} | ${p.developer_name} | ${p.area} | AED ${p.price_min?.toLocaleString()} | ${p.source}`);
    });
    log(`\nWould save ${unique.length} projects to Supabase`);
    return;
  }
  
  // Enrich details (with concurrency limit)
  log('Fetching project details...');
  const enriched = await Promise.all(
    unique.map(p => limit(async () => {
      if (p.source === 'bayut') {
        const scraper = new BayutScraper();
        return scraper.scrapeProjectDetail(p);
      }
      return p;
    }))
  );
  
  // Save to Supabase
  log('Saving to Supabase...');
  for (const project of enriched) {
    try {
      await upsertProject(supabase, project, runId);
      totalNew++;
    } catch (err) {
      log(`Error saving ${project.name}: ${err.message}`);
      totalErrors++;
    }
  }
  
  // Update run log
  if (supabase && runId) {
    await supabase.from('scraper_runs').update({
      completed_at: new Date().toISOString(),
      projects_found: unique.length,
      projects_new: totalNew,
      errors: totalErrors,
      status: 'completed',
    }).eq('id', runId);
  }
  
  log(`✅ Done. ${totalNew} saved, ${totalErrors} errors`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
