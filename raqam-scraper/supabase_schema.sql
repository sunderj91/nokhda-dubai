-- ============================================================
-- RAQAM Dubai Projects Database Schema
-- Run this in Supabase SQL Editor (supabase.com → SQL Editor)
-- ============================================================

-- Enable extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS postgis;

-- ============================================================
-- DEVELOPERS
-- ============================================================
CREATE TABLE IF NOT EXISTS developers (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT NOT NULL UNIQUE,
  slug TEXT NOT NULL UNIQUE,
  logo_url TEXT,
  website TEXT,
  phone TEXT,
  email TEXT,
  tier INTEGER DEFAULT 1, -- 1=Tier1 (Emaar/DAMAC), 2=Tier2, 3=Tier3
  projects_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- PROJECTS
-- ============================================================
CREATE TABLE IF NOT EXISTS projects (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  external_id TEXT UNIQUE, -- Bayut/PF listing ID for dedup
  name TEXT NOT NULL,
  slug TEXT UNIQUE,
  developer_id UUID REFERENCES developers(id),
  developer_name TEXT, -- denormalized for speed
  area TEXT NOT NULL,
  district TEXT,
  location TEXT, -- human readable sub-area
  lat DOUBLE PRECISION,
  lng DOUBLE PRECISION,
  geom GEOMETRY(Point, 4326),

  -- Type & Status
  type TEXT CHECK (type IN ('apartment','villa','townhouse','penthouse','mixed','commercial')),
  status TEXT CHECK (status IN ('off-plan','under-construction','ready','sold-out')) DEFAULT 'off-plan',
  
  -- Pricing
  price_min BIGINT,  -- AED
  price_max BIGINT,
  price_avg BIGINT,
  psf_min INTEGER,   -- AED per sqft
  psf_max INTEGER,
  psf_avg INTEGER,
  
  -- Project details
  units_total INTEGER,
  units_available INTEGER,
  floors INTEGER,
  bedrooms_available TEXT[], -- e.g. ['studio','1br','2br','3br']
  completion_date DATE,
  completion_quarter TEXT,   -- e.g. 'Q4 2026'
  handover_status TEXT,      -- 'on-track' | 'delayed' | 'completed'
  construction_progress INTEGER, -- 0-100
  
  -- Payment plan
  down_payment INTEGER,       -- % 
  during_construction INTEGER,
  on_completion INTEGER,
  payment_years INTEGER,
  post_handover_available BOOLEAN DEFAULT false,
  
  -- Rich content
  description TEXT,
  amenities TEXT[],
  cover_image TEXT,           -- primary image URL (stored in Supabase Storage)
  
  -- Area benchmarks
  area_avg_psf INTEGER,
  area_rental_yield NUMERIC(4,2),
  
  -- Intelligence flags
  featured BOOLEAN DEFAULT false,
  featured_rank INTEGER,      -- sort order for featured projects
  raqam_signal TEXT CHECK (raqam_signal IN ('strong-buy','buy','hold','watch','avoid')),
  raqam_score NUMERIC(3,1),   -- 0-10
  
  -- Metadata
  source TEXT DEFAULT 'bayut', -- scrape source
  source_url TEXT,
  last_scraped_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Spatial index
CREATE INDEX IF NOT EXISTS idx_projects_geom ON projects USING GIST(geom);
CREATE INDEX IF NOT EXISTS idx_projects_area ON projects(area);
CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status);
CREATE INDEX IF NOT EXISTS idx_projects_developer ON projects(developer_id);

-- Auto-set geom from lat/lng
CREATE OR REPLACE FUNCTION set_project_geom()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.lat IS NOT NULL AND NEW.lng IS NOT NULL THEN
    NEW.geom = ST_SetSRID(ST_MakePoint(NEW.lng, NEW.lat), 4326);
  END IF;
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_project_geom
  BEFORE INSERT OR UPDATE ON projects
  FOR EACH ROW EXECUTE FUNCTION set_project_geom();

-- ============================================================
-- PROJECT IMAGES
-- ============================================================
CREATE TABLE IF NOT EXISTS project_images (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
  url TEXT NOT NULL,                  -- Supabase Storage public URL
  original_url TEXT,                  -- source URL (Bayut CDN)
  caption TEXT,
  image_type TEXT DEFAULT 'gallery',  -- 'cover' | 'gallery' | 'floorplan' | 'render'
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_project_images_project ON project_images(project_id);

-- ============================================================
-- UNIT TYPES (breakdown per project)
-- ============================================================
CREATE TABLE IF NOT EXISTS unit_types (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
  bedrooms TEXT NOT NULL,   -- 'studio', '1', '2', '3', '4', '5+'
  size_min INTEGER,         -- sqft
  size_max INTEGER,
  price_min BIGINT,
  price_max BIGINT,
  psf_avg INTEGER,
  units_total INTEGER,
  units_available INTEGER,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_unit_types_project ON unit_types(project_id);

-- ============================================================
-- PSF PRICE HISTORY (for trend charts)
-- ============================================================
CREATE TABLE IF NOT EXISTS price_history (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
  recorded_date DATE NOT NULL DEFAULT CURRENT_DATE,
  psf_avg INTEGER,
  psf_min INTEGER,
  psf_max INTEGER,
  price_min BIGINT,
  price_max BIGINT,
  units_available INTEGER,
  source TEXT DEFAULT 'scraper'
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_price_history_unique ON price_history(project_id, recorded_date);
CREATE INDEX IF NOT EXISTS idx_price_history_project ON price_history(project_id, recorded_date DESC);

-- ============================================================
-- CONSTRUCTION UPDATES
-- ============================================================
CREATE TABLE IF NOT EXISTS construction_updates (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
  update_date DATE NOT NULL DEFAULT CURRENT_DATE,
  progress_pct INTEGER,              -- 0-100
  milestone TEXT,                    -- 'Foundation complete', 'Structure 50%' etc
  note TEXT,
  image_url TEXT,
  source TEXT DEFAULT 'developer'
);

CREATE INDEX IF NOT EXISTS idx_construction_project ON construction_updates(project_id, update_date DESC);

-- ============================================================
-- SCRAPER LOG (track runs, errors)
-- ============================================================
CREATE TABLE IF NOT EXISTS scraper_runs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  source TEXT NOT NULL,
  started_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  projects_found INTEGER DEFAULT 0,
  projects_new INTEGER DEFAULT 0,
  projects_updated INTEGER DEFAULT 0,
  errors INTEGER DEFAULT 0,
  error_log TEXT,
  status TEXT DEFAULT 'running' -- 'running' | 'completed' | 'failed'
);

-- ============================================================
-- ROW LEVEL SECURITY (public read, service role write)
-- ============================================================
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE developers ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_images ENABLE ROW LEVEL SECURITY;
ALTER TABLE unit_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE price_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE construction_updates ENABLE ROW LEVEL SECURITY;

-- Public read policies
CREATE POLICY "Public read projects" ON projects FOR SELECT USING (true);
CREATE POLICY "Public read developers" ON developers FOR SELECT USING (true);
CREATE POLICY "Public read images" ON project_images FOR SELECT USING (true);
CREATE POLICY "Public read units" ON unit_types FOR SELECT USING (true);
CREATE POLICY "Public read price history" ON price_history FOR SELECT USING (true);
CREATE POLICY "Public read construction" ON construction_updates FOR SELECT USING (true);

-- Service role (scraper) can write everything
CREATE POLICY "Service write projects" ON projects FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "Service write developers" ON developers FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "Service write images" ON project_images FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "Service write units" ON unit_types FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "Service write price_history" ON price_history FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "Service write construction" ON construction_updates FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "Service write scraper_runs" ON scraper_runs FOR ALL USING (auth.role() = 'service_role');

-- ============================================================
-- VIEWS (for convenience)
-- ============================================================

-- Projects with developer info + latest price
CREATE OR REPLACE VIEW projects_full AS
SELECT 
  p.*,
  d.logo_url AS developer_logo,
  d.website AS developer_website,
  d.tier AS developer_tier,
  (SELECT COUNT(*) FROM project_images pi WHERE pi.project_id = p.id) AS image_count,
  (SELECT COUNT(*) FROM unit_types ut WHERE ut.project_id = p.id) AS unit_type_count,
  (SELECT ph.psf_avg FROM price_history ph WHERE ph.project_id = p.id ORDER BY ph.recorded_date DESC LIMIT 1) AS latest_psf,
  (SELECT ph.psf_avg FROM price_history ph WHERE ph.project_id = p.id ORDER BY ph.recorded_date ASC LIMIT 1) AS initial_psf
FROM projects p
LEFT JOIN developers d ON d.id = p.developer_id;

-- Price trend per project (last 90 days)
CREATE OR REPLACE VIEW psf_trend_90d AS
SELECT 
  project_id,
  recorded_date,
  psf_avg,
  LAG(psf_avg) OVER (PARTITION BY project_id ORDER BY recorded_date) AS prev_psf,
  psf_avg - LAG(psf_avg) OVER (PARTITION BY project_id ORDER BY recorded_date) AS psf_change
FROM price_history
WHERE recorded_date >= CURRENT_DATE - INTERVAL '90 days';

-- ============================================================
-- STORAGE BUCKET (run separately or via Supabase dashboard)
-- ============================================================
-- In Supabase Dashboard → Storage → New Bucket:
-- Name: project-images
-- Public: YES
-- File size limit: 10MB
-- Allowed MIME types: image/jpeg, image/png, image/webp
