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
      '--no-zygote',
      '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
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
      console.log('Navigating to sign-in page...');
      await page.goto('https://client.firenotification.com/auth/sign-in', { waitUntil: 'domcontentloaded' });
      console.log('Sign-in page loaded. Current URL:', await page.url());

      // Wait for and type email
      console.log('Waiting for email input...');
      await page.waitForSelector('input[type="email"]', { timeout: 20000 });
      await page.type('input[type="email"]', EMAIL);
      console.log('Email entered.');

      // Wait for and type password
      console.log('Waiting for password input...');
      await page.waitForSelector('input[type="password"]', { timeout: 20000 });
      await page.type('input[type="password"]', PASSWORD);
      console.log('Password entered.');

      // Click Sign In
      console.log('Clicking submit button...');
      await page.click('button[type="submit"]');
      console.log('Submit clicked. Waiting for login confirmation...');

      // Wait for the login form to disappear (indicating successful redirect)
      await page.waitForFunction(() => !document.querySelector('input[type="email"]'), { timeout: 60000 });
      console.log('Login successful: Login form disappeared.');

      // Additional delay to ensure dashboard loads
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Log current URL and check for error messages (e.g., Material-UI alert)
      console.log('Post-login URL:', await page.url());
      const errorMsg = await page.evaluate(() => {
        const errorEl = document.querySelector('.MuiAlert-message') || document.querySelector('[role="alert"]');
        return errorEl ? errorEl.textContent.trim() : 'No error message found';
      });
      console.log('Potential error message:', errorMsg);

      if (errorMsg !== 'No error message found') {
        throw new Error(`Login error: ${errorMsg}`);
      }
    });

    // ---------- 2. LOAD LIST (First page only) ----------
    console.log('Loading incident list...');
    const allIncidents = [];

    await withRetry(async () => {
      console.log('Navigating to list URL...');
      await page.goto(LIST_URL, { waitUntil: 'domcontentloaded' });
      console.log('List page loaded. Current URL:', await page.url());
    });

    // Function to fetch incidents from current page
    async function fetchCurrentPageIncidents() {
      console.log('Preparing to fetch incidents from current page...');
      const masterPromise = page.waitForResponse(r => 
        r.url().includes('/api/incident') && 
        r.status() === 200
      );

      // Reload or trigger API if needed (assuming goto or refresh triggers it)
      console.log('Reloading page to trigger API...');
      await page.reload({ waitUntil: 'domcontentloaded' });
      console.log('Page reloaded.');

      const masterResp = await masterPromise;
      const masterJson = await masterResp.json();
      const incidents = masterJson.incidents || [];
      console.log(`Found ${incidents.length} incidents on this page`);
      return incidents;
    }

    // Get first page incidents only
    const currentIncidents = await fetchCurrentPageIncidents();
    allIncidents.push(...currentIncidents);

    console.log(`Total incidents found: ${allIncidents.length}`);

    // ---------- 3. FETCH DETAILS & MAP TO SUPABASE SCHEMA ----------
    const rows = [];

    for (const inc of allIncidents) {
      const id = inc.IncidentId;
      console.log(`Processing incident → ${id}`);

      await withRetry(async () => {
        // 3a – assessment / property
        console.log(`Navigating to incident detail: ${id}...`);
        await page.goto(LIST_URL + `incident?incidentId=${id}`, { waitUntil: 'domcontentloaded' });
        console.log('Detail page loaded.');
        const assessResp = await page.waitForResponse(r => 
          r.url().includes(`/api/assessment/incident/${id}`) && 
          !r.url().includes('comments') && 
          !r.url().includes('contact')
        );
        const assessJSON = await assessResp.json();
        const assess = assessJSON.assessments || [];
        console.log('Assessment data fetched.');

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
        console.log('Finding Contact button...');
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
        console.log('Contact button clicked.');
        // Optional delay if needed for modal/load
        // await new Promise(resolve => setTimeout(resolve, 1000));

        const contactResp = await page.waitForResponse(r =>
          r.url().includes(`/api/incident/${id}/contact`) && 
          r.status() === 200 &&
          r.request().method() === 'GET'
        );
        const contactJSON = await contactResp.json();
        const contact = contactJSON.contactNotes || [];
        console.log('Contact: ' + JSON.stringify(contact));

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
        console.log(`Row built for incident ${id}.`);
      });
    }

    // ---------- 4. UPSERT TO SUPABASE ----------
    if (rows.length > 0) {
      console.log(`Upserting ${rows.length} rows to Supabase...`);
      const { error } = await supabase
        .from('incidents')
        .upsert(rows, { onConflict: 'incident_id' });

      if (error) {
        console.error('Supabase error:', error);
      } else {
        console.log(`Upserted ${rows.length} rows successfully.`);
      }
    } else {
      console.log('No rows to upsert.');
    }
  } catch (err) {
    console.error('Script failed:', err);
    // Optional: Log page content on error
    if (page) {
      const pageContent = await page.content();
      console.log('Page content on error:', pageContent.substring(0, 1000)); // Truncated
    }
    // await page.screenshot({ path: 'error-screenshot.png' });
  } finally {
    console.log('Closing browser...');
    await browser.close();
    console.log('Browser closed.');
  }
})();
