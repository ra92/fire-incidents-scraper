// ---------------------------------------------------------------
// puppeteer-to-supabase.js
// ---------------------------------------------------------------
const puppeteer = require('puppeteer');
const { createClient } = require('@supabase/supabase-js');

// ==== CONFIG =========================================================
const EMAIL          = process.env.EMAIL;
const PASSWORD       = process.env.PSKY;
const LIST_URL       = 'https://client.firenotification.com/';

const SUPABASE_URL   = process.env.SUPABASE_URL;
const SUPABASE_KEY   = process.env.SUPABASE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  throw new Error('Missing SUPABASE_URL or SUPABASE_KEY environment variables');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
// =====================================================================

// Utility for retries
async function withRetry(fn, maxRetries = 3, delayMs = 2000) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      console.warn(`Attempt ${attempt} failed: ${err.message}. Retrying...`);
      if (attempt === maxRetries) throw err;
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
}

(async () => {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--single-process',
      '--no-zygote'
    ],
    defaultViewport: { width: 1280, height: 800 },
    ignoreHTTPSErrors: true
  });
  const page = await browser.newPage();

  // Set global timeouts to 60s
  page.setDefaultNavigationTimeout(60000);
  page.setDefaultTimeout(60000);

  try {
    // ---------- 1. LOGIN (Using type attributes) ----------
    console.log('Logging in...');
    await withRetry(async () => {
      await page.goto('https://client.firenotification.com/auth/sign-in', { waitUntil: 'domcontentloaded' });

      // Wait for and type email
      await page.waitForSelector('input[type="email"]', { timeout: 20000 });
      await page.type('input[type="email"]', EMAIL);

      // Wait for and type password
      await page.waitForSelector('input[type="password"]', { timeout: 20000 });
      await page.type('input[type="password"]', PASSWORD);

      // Click Sign In and wait for navigation
      await page.click('button[type="submit"]');
      await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 });
    });

    // ---------- 2. LOAD LIST & HANDLE PAGINATION ----------
    console.log('Loading incident list...');
    const allIncidents = [];

    await withRetry(async () => {
      await page.goto(LIST_URL, { waitUntil: 'domcontentloaded' });
    });

    // Function to fetch incidents from current page
    async function fetchCurrentPageIncidents() {
      const masterPromise = page.waitForResponse(r => 
        r.url().includes('/api/incident') && 
        r.status() === 200
      );

      // Reload or trigger API if needed (assuming goto or refresh triggers it)
      await page.reload({ waitUntil: 'domcontentloaded' });

      const masterResp = await masterPromise;
      const masterJson = await masterResp.json();
      const incidents = masterJson.incidents || [];
      console.log(`Found ${incidents.length} incidents on this page`);
      return incidents;
    }

    // Get initial page incidents
    let currentIncidents = await fetchCurrentPageIncidents();
    allIncidents.push(...currentIncidents);

    // Determine total pages (evaluate pagination)
    const totalPages = await page.evaluate(() => {
      const pageItems = document.querySelectorAll('.MuiPaginationItem-page');
      return pageItems.length; // Assumes pages are numbered 1 to N without ellipsis
    });
    console.log(`Detected ${totalPages} pages`);

    // Loop through pages 2 to totalPages
    for (let pageNum = 2; pageNum <= totalPages; pageNum++) {
      await withRetry(async () => {
        // Target and click the next page button
        const nextSelector = `button.MuiPaginationItem-page[aria-label="page ${pageNum}"]`;
        await page.waitForSelector(nextSelector, { timeout: 20000 });
        const nextButton = await page.$(nextSelector);
        if (nextButton) {
          await nextButton.click();
          // Wait for page to load (e.g., new API call)
          await page.waitForSelector('.some-incident-list-selector', { timeout: 30000 }); // Replace with a selector that indicates list refresh, e.g., a table or list class
        } else {
          throw new Error(`Page ${pageNum} button not found`);
        }
      });

      // Fetch incidents from this page
      currentIncidents = await fetchCurrentPageIncidents();
      allIncidents.push(...currentIncidents);
    }

    console.log(`Total incidents found: ${allIncidents.length}`);

    // ---------- 3. FETCH DETAILS & MAP TO SUPABASE SCHEMA ----------
    const rows = [];

    for (const inc of allIncidents) {
      const id = inc.IncidentId;
      console.log(`  → ${id}`);

      await withRetry(async () => {
        // 3a – assessment / property
        await page.goto(LIST_URL + `incident?incidentId=${id}`, { waitUntil: 'domcontentloaded' });
        const assessResp = await page.waitForResponse(r => 
          r.url().includes(`/api/assessment/incident/${id}`) && 
          !r.url().includes('comments') && 
          !r.url().includes('contact')
        );
        const assessJSON = await assessResp.json();
        const assess = assessJSON.assessments || [];

        // 3b – comments
        const commentsResp = await page.waitForResponse(r => 
          r.url().includes(`/api/incident/${id}/comments`)
        );
        const commentsJSON = await commentsResp.json();
        const commentsArray = commentsJSON.comments || [];
        let comments = '';
        for (const cmnts of commentsArray) {
          console.log('CL-1:' + cmnts.description);
          comments += ('[ ' + cmnts.description + ' ]' + '\n');
        }
        console.log('Full Comments: ' + comments);

        // 3c – contact
        // Find and click Contact button
        const contactButtonHandle = await page.evaluateHandle(() => {
          const buttons = Array.from(document.querySelectorAll('button'));
          return buttons.find(btn => 
            btn.textContent.includes('Contact') && 
            btn.querySelector('.MuiBadge-badge')
          );
        });

        if (!contactButtonHandle.asElement()) {
          throw new Error('Contact button not found');
        }
        await contactButtonHandle.asElement().click();
        // Optional delay if needed for modal/load
        // await new Promise(resolve => setTimeout(resolve, 1000));

        const contactResp = await page.waitForResponse(r =>
          r.url().includes(`/api/incident/${id}/contact`) && 
          r.status() === 200 &&
          r.request().method() === 'GET'
        );
        const contactJSON = await contactResp.json();
        const contact = contactJSON.contactNotes || [];
        console.log('Contact: ' + contact);

        // ----- Parse address parts -----
        const addrParts = (inc.addressRaw || '').split(', ');
        const city = inc.cityName || addrParts[1] || '';
        const zip = addrParts[2] ? addrParts[2].split(' ')[1] : '';

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
          latitude: inc.latitude ? inc.latitude.toString() : null,
          longitude: inc.longitude ? inc.longitude.toString() : null,
          reported_at: inc.createdAt || null,
          sla_due: null, // not in API – set later
          ai_score: inc.commentCount > 3 ? 95 : (inc.commentCount > 1 ? 80 : 60),
          assigned_agent: '',
          contractor: '',
          commission_pct: null,
          owner_name: (assess.assessments?.[0]?.ownerInfo?.name + ' / ' + assess.assessments?.[0]?.lastSale?.buyer) || ownerName || null,
          phone: phoneMatch[0] || 
                  (contact.contactNotes?.[0]?.contact ? 
                  contact.contactNotes[0].contact.match(/\d{3}[-.\s]?\d{3}[-.\s]?\d{4}/)?.[0] : null) || null,
          damage_description: inc.searchableContent ? inc.searchableContent.substring(0, 300) : null,
          family_note: inc.paged ? 'PAGED - Urgent Follow-Up' : 'Not Paged',
          description: inc.searchableContent ? inc.searchableContent.substring(0, 500) : null,
          stage: 'New Alert'
        });
      });
    }

    // ---------- 4. UPSERT TO SUPABASE ----------
    if (rows.length > 0) {
      const { error } = await supabase
        .from('incidents')
        .upsert(rows, { onConflict: 'incident_id' });

      if (error) {
        console.error('Supabase error:', error);
      } else {
        console.log(`Upserted ${rows.length} rows`);
      }
    }
  } catch (err) {
    console.error('Script failed:', err);
    // Optional: await page.screenshot({ path: 'error-screenshot.png' });
  } finally {
    await browser.close();
  }
})();
