/**
 * RAQAM Scraper Scheduler
 * Runs daily at 3am Dubai time (UTC+4)
 * 
 * Usage: node scheduler.js
 * Or with PM2: pm2 start scheduler.js --name raqam-scraper
 */

import cron from 'node-cron';
import { execSync } from 'child_process';
import { createClient } from '@supabase/supabase-js';
import 'dotenv/config';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

async function runScraper() {
  log('⏰ Scheduled scrape starting...');
  try {
    execSync('node scraper.js', { stdio: 'inherit', timeout: 60 * 60 * 1000 }); // 1hr timeout
    log('✅ Scheduled scrape complete');
  } catch (err) {
    log(`❌ Scrape failed: ${err.message}`);
    // Alert via Supabase (you can hook this to email/webhook)
    await supabase.from('scraper_runs').insert({
      source: 'scheduler',
      status: 'failed',
      error_log: err.message,
      completed_at: new Date().toISOString(),
    });
  }
}

// Run at 3:00 AM Dubai time (UTC+4 = 23:00 UTC previous day)
// Cron: minute hour day month weekday
cron.schedule('0 23 * * *', runScraper, {
  timezone: 'UTC',
});

// Also run price-only refresh at 9am Dubai time (05:00 UTC) — faster, just checks prices
cron.schedule('0 5 * * *', async () => {
  log('⏰ Price refresh starting...');
  try {
    execSync('node scraper.js --source=bayut', { stdio: 'inherit', timeout: 30 * 60 * 1000 });
  } catch (err) {
    log(`❌ Price refresh failed: ${err.message}`);
  }
}, { timezone: 'UTC' });

log('📅 Scheduler running. Next full scrape: 3:00 AM Dubai time daily.');
log('   Price refresh: 9:00 AM Dubai time daily.');
