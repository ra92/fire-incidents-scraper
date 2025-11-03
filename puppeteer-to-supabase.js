// ---------------------------------------------------------------
// puppeteer-to-supabase.js
// ---------------------------------------------------------------
const puppeteer = require('puppeteer');
const { createClient } = require('@supabase/supabase-js');

// ==== CONFIG =========================================================
const EMAIL          = 'rob@emberhouseproductions.com';
const PASSWORD       = 'R0b!Ember';
const LIST_URL       = 'https://client.firenotification.com/?location=arizona';

const SUPABASE_URL   = 'YOUR_SUPABASE_URL';
const SUPABASE_KEY   = 'YOUR_SUPABASE_ANON_KEY';
const supabase       = createClient(SUPABASE_URL, SUPABASE_KEY);
// =====================================================================

(async () => {
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu', '--disable-dev-shm-usage']
  });
  const page = await browser.newPage();

  // ---------- 1. LOGIN ----------
  console.log('Logging in...');
  await page.goto('https://client.firenotification.com/auth/sign-in');
  await page.type('#\\:r16j\\:', EMAIL);      // email
  await page.type('#\\:r16k\\:', PASSWORD);   // password
  await Promise.all([
    page.click('.MuiButton-root'),
    page.waitForNavigation({ waitUntil: 'networkidle0' })
  ]);

  // ---------- 2. LOAD LIST & INTERCEPT MASTER API ----------
  console.log('Loading incident list...');
  const masterPromise = page.waitForResponse(r =>
    r.url().includes('/api/incident') && 
    r.status() === 200 && 
    !r.url().includes('comments') && 
    !r.url().includes('contact')
  );

  await page.goto(LIST_URL);
  const masterResp = await masterPromise;
  const masterJson = await masterResp.json();
  const incidents  = masterJson.incidents || [];

  console.log(`Found ${incidents.length} incidents`);

  // ---------- 3. FETCH DETAILS & MAP TO SUPABASE SCHEMA ----------
  const rows = [];

  for (const inc of incidents) {
    const id = inc.IncidentId;
    console.log(`  → ${id}`);

    // 3a – assessment / property
    const assessResp = await page.waitForResponse(r =>
      r.url().includes(`/api/incident/${id}`) && 
      !r.url().includes('comments') && 
      !r.url().includes('contact')
    );
    const assess = await assessResp.json();

    // 3b – comments
    const commentsResp = await page.waitForResponse(r =>
      r.url().includes(`/api/incident/${id}/comments`)
    );
    const comments = await commentsResp.json();

    // 3c – contact
    const contactResp = await page.waitForResponse(r =>
      r.url().includes(`/api/incident/${id}/contact`)
    );
    const contact = await contactResp.json();

    // ----- Parse address parts -----
    const addrParts = (inc.addressRaw || '').split(', ');
    const city = inc.cityName || addrParts[1] || '';
    const zip  = addrParts[2]?.split(' ')[1] || '';

    // ----- Extract phone & owner from searchableContent -----
    const phoneMatch = (inc.searchableContent || '').match(/\d{3}[-.\s]?\d{3}[-.\s]?\d{4}/g) || [];
    const ownerMatch = (inc.searchableContent || '').match(/\[CONTACT\][^/]+\/([^/]+)/i);
    const ownerName = ownerMatch ? ownerMatch[1].trim() : '';

    // ----- Build row matching your Supabase schema -----
    rows.push({
      incident_id: id,
      preset_label: inc.presetLabel || null,
      incident_type: inc.incidentTypeName || null,
      structure_type: inc.structureTypeName || null,
      address: inc.addressRaw || null,
      street_address: inc.streetAddress || null,
      city,
      state: 'AZ',
      zipcode: zip,
      county: inc.countyShortName || null,
      latitude: inc.latitude?.toString() || null,
      longitude: inc.longitude?.toString() || null,
      reported_at: inc.createdAt || null,
      sla_due: null,
      ai_score: inc.commentCount > 3 ? 95 : inc.commentCount > 1 ? 80 : 60,
      assigned_agent: '',
      contractor: '',
      commission_pct: null,
      owner_name: ownerName || (assess.assessments?.[0]?.ownerInfo?.name) || null,
      phone: phoneMatch[0] || 
             (contact.contactNotes?.[0]?.contact?.match(/\d{3}[-.\s]?\d{3}[-.\s]?\d{4}/)?.[0]) || null,
      damage_description: inc.searchableContent?.substring(0, 300) || null,
      family_note: inc.paged ? 'PAGED - Urgent Follow-Up' : 'Not Paged',
      description: inc.searchableContent?.substring(0, 500) || null,
      stage: 'New Alert'
    });
  }

  // ---------- 4. UPSERT TO SUPABASE ----------
  if (rows.length) {
    const { error } = await supabase
      .from('incidents')
      .upsert(rows, { onConflict: 'incident_id' });

    if (error) console.error('Supabase error:', error);
    else console.log(`Upserted ${rows.length} rows`);
  }

  await browser.close();
})();
