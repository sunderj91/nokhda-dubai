/**
 * RAQAM → Supabase Client
 * Drop this into the RAQAM frontend to replace the hardcoded PROJECTS array
 * 
 * Usage in index.html:
 *   <script type="module" src="supabase-client.js"></script>
 *   window.RAQAM_DB.getProjects({ area: 'Dubai Marina' })
 */

// ── Supabase config (public anon key — safe for browser) ─────────────────────
const SUPABASE_URL = 'https://vmzcwnzsyaeqvvwqhjjr.supabase.co';       // e.g. https://xxxxx.supabase.co
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZtemN3bnpzeWFlcXZ2d3FoampyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMzMTcyNjYsImV4cCI6MjA4ODg5MzI2Nn0.UD1FLFJ6xtn_D060zfEye1ekxMLGEyJFqTar04eFldY';      // from Supabase → Settings → API

// ── REST API helper (no SDK needed in browser) ───────────────────────────────

async function supabaseQuery(table, params = {}) {
  const url = new URL(`${SUPABASE_URL}/rest/v1/${table}`);
  
  // Build query params
  if (params.select) url.searchParams.set('select', params.select);
  if (params.order) url.searchParams.set('order', params.order);
  if (params.limit) url.searchParams.set('limit', params.limit);
  if (params.offset) url.searchParams.set('offset', params.offset);
  
  // Filters (PostgREST syntax)
  if (params.filters) {
    params.filters.forEach(([col, op, val]) => {
      url.searchParams.set(col, `${op}.${val}`);
    });
  }
  
  const res = await fetch(url.toString(), {
    headers: {
      'apikey': SUPABASE_ANON_KEY,
      'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'count=exact',
    }
  });
  
  if (!res.ok) throw new Error(`Supabase error: ${res.status} ${await res.text()}`);
  
  const data = await res.json();
  const count = parseInt(res.headers.get('content-range')?.split('/')[1]) || null;
  
  return { data, count };
}

// ── RAQAM DB API ──────────────────────────────────────────────────────────────

window.RAQAM_DB = {
  
  /**
   * Get projects with filters
   * @param {Object} opts
   * @param {string} [opts.area] - filter by area name
   * @param {string} [opts.status] - 'off-plan' | 'under-construction' | 'ready'
   * @param {string} [opts.type] - 'apartment' | 'villa' | etc
   * @param {number} [opts.psfMin] - min PSF price
   * @param {number} [opts.psfMax] - max PSF price  
   * @param {boolean} [opts.featuredFirst] - sort featured projects first
   * @param {number} [opts.limit] - default 200
   * @param {number} [opts.offset]
   */
  async getProjects(opts = {}) {
    const filters = [];
    if (opts.area) filters.push(['area', 'eq', opts.area]);
    if (opts.status) filters.push(['status', 'eq', opts.status]);
    if (opts.type) filters.push(['type', 'eq', opts.type]);
    if (opts.psfMin) filters.push(['psf_avg', 'gte', opts.psfMin]);
    if (opts.psfMax) filters.push(['psf_avg', 'lte', opts.psfMax]);
    if (opts.search) filters.push(['name', 'ilike', `*${opts.search}*`]);
    
    const order = opts.featuredFirst 
      ? 'featured.desc.nullslast,featured_rank.asc.nullslast,raqam_score.desc.nullslast'
      : 'raqam_score.desc.nullslast,created_at.desc';
    
    const { data, count } = await supabaseQuery('projects_full', {
      select: `
        id, name, slug, developer_name, developer_logo, area, lat, lng,
        type, status, price_min, price_max, psf_avg, psf_min, psf_max,
        units_total, units_available, bedrooms_available,
        completion_date, completion_quarter, handover_status, construction_progress,
        down_payment, during_construction, on_completion,
        cover_image, amenities, description,
        area_avg_psf, area_rental_yield,
        featured, featured_rank, raqam_signal, raqam_score,
        image_count, latest_psf, initial_psf
      `,
      filters,
      order,
      limit: opts.limit || 200,
      offset: opts.offset || 0,
    });
    
    return { projects: data, total: count };
  },

  /**
   * Get a single project with all related data
   */
  async getProject(id) {
    const [projectRes, imagesRes, unitsRes, priceHistoryRes, constructionRes] = await Promise.all([
      supabaseQuery('projects_full', { 
        select: '*', 
        filters: [['id', 'eq', id]], 
        limit: 1 
      }),
      supabaseQuery('project_images', {
        select: 'url, caption, image_type, sort_order',
        filters: [['project_id', 'eq', id]],
        order: 'sort_order.asc',
      }),
      supabaseQuery('unit_types', {
        select: 'bedrooms, size_min, size_max, price_min, price_max, psf_avg, units_total, units_available',
        filters: [['project_id', 'eq', id]],
        order: 'bedrooms.asc',
      }),
      supabaseQuery('price_history', {
        select: 'recorded_date, psf_avg, psf_min, psf_max, price_min',
        filters: [['project_id', 'eq', id]],
        order: 'recorded_date.asc',
        limit: 90,
      }),
      supabaseQuery('construction_updates', {
        select: 'update_date, progress_pct, milestone, note, image_url',
        filters: [['project_id', 'eq', id]],
        order: 'update_date.desc',
        limit: 10,
      }),
    ]);
    
    return {
      project: projectRes.data[0],
      images: imagesRes.data,
      units: unitsRes.data,
      priceHistory: priceHistoryRes.data,
      constructionUpdates: constructionRes.data,
    };
  },

  /**
   * Get PSF trend for a project (for sparkline charts)
   * Returns: [{ date, psf }]
   */
  async getPsfTrend(projectId, days = 90) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    
    const { data } = await supabaseQuery('price_history', {
      select: 'recorded_date, psf_avg',
      filters: [
        ['project_id', 'eq', projectId],
        ['recorded_date', 'gte', cutoff.toISOString().split('T')[0]],
      ],
      order: 'recorded_date.asc',
    });
    
    return data.map(r => ({ date: r.recorded_date, psf: r.psf_avg }));
  },

  /**
   * Get projects grouped by area (for map heatmap)
   */
  async getProjectsByArea() {
    const { data } = await supabaseQuery('projects', {
      select: 'area, psf_avg, raqam_score, status',
      filters: [['status', 'neq', 'sold-out']],
      limit: 5000,
    });
    
    // Group by area
    const areas = {};
    data.forEach(p => {
      if (!areas[p.area]) areas[p.area] = { count: 0, psfSum: 0, scoreSum: 0 };
      areas[p.area].count++;
      if (p.psf_avg) areas[p.area].psfSum += p.psf_avg;
      if (p.raqam_score) areas[p.area].scoreSum += p.raqam_score;
    });
    
    return Object.entries(areas).map(([area, stats]) => ({
      area,
      project_count: stats.count,
      avg_psf: stats.count > 0 ? Math.round(stats.psfSum / stats.count) : null,
      avg_score: stats.count > 0 ? +(stats.scoreSum / stats.count).toFixed(1) : null,
    }));
  },

  /**
   * Get featured/promoted projects (for Layer 2 commercial model)
   */
  async getFeaturedProjects(limit = 10) {
    const { data } = await supabaseQuery('projects_full', {
      select: 'id, name, slug, developer_name, area, psf_avg, cover_image, raqam_signal, featured_rank',
      filters: [['featured', 'eq', 'true']],
      order: 'featured_rank.asc',
      limit,
    });
    return data;
  },

  /**
   * Search projects by name/developer
   */
  async search(query, limit = 20) {
    const { data } = await supabaseQuery('projects', {
      select: 'id, name, developer_name, area, psf_avg, cover_image, status',
      filters: [['name', 'ilike', `*${query}*`]],
      order: 'raqam_score.desc.nullslast',
      limit,
    });
    return data;
  },
};

// ── Convert Supabase project to RAQAM internal format ─────────────────────────

window.RAQAM_DB.toMapProject = function(p) {
  return {
    id: p.id,
    name: p.name,
    developer: p.developer_name,
    area: p.area,
    coords: p.lng && p.lat ? [p.lng, p.lat] : null,
    type: p.type,
    status: p.status,
    completionDate: p.completion_quarter || p.completion_date?.substring(0, 7),
    priceMin: p.price_min,
    priceMax: p.price_max,
    priceAvg: p.price_avg || p.price_min,
    psfMin: p.psf_min,
    psfMax: p.psf_max,
    psfAvg: p.psf_avg || p.latest_psf,
    units: p.units_total,
    bedrooms: p.bedrooms_available || [],
    downPayment: p.down_payment,
    amenities: p.amenities || [],
    description: p.description,
    featured: p.featured,
    coverImage: p.cover_image,
    raqamSignal: p.raqam_signal,
    raqamScore: p.raqam_score,
    areaAvgPsf: p.area_avg_psf,
    areaYield: p.area_rental_yield,
    // Trend data
    psfTrend: p.initial_psf && p.latest_psf 
      ? ((p.latest_psf - p.initial_psf) / p.initial_psf * 100).toFixed(1)
      : null,
  };
};

console.log('✅ RAQAM_DB ready. Usage: await window.RAQAM_DB.getProjects()');
