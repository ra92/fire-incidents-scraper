// Version: 4
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
    // ---------- 1. LOGIN ----------
    console.log('[1:LOGIN_START] Logging in...');
    await withRetry(async () => {
      await page.goto('https://client.firenotification.com/auth/sign-in', { waitUntil: 'domcontentloaded' });

      await page.waitForSelector('input[type="email"]', { timeout: 20000 });
      await page.type('input[type="email"]', EMAIL, { delay: 100 });

      await page.waitForSelector('input[type="password"]', { timeout: 20000 });
      await page.type('input[type="password"]', PASSWORD, { delay: 100 });

      await page.click('button[type="submit"]');

      await new Promise(resolve => setTimeout(resolve, 5000));

      const errorMsg = await page.evaluate(() => {
        const errorEl = document.querySelector('.MuiAlert-message, .MuiAlert-root, [role="alert"], .error');
        return errorEl ? errorEl.textContent.trim() : 'No error message found';
      });

      if (errorMsg !== 'No error message found') {
        throw new Error(`Login error: ${errorMsg}`);
      }

      await page.goto(LIST_URL, { waitUntil: 'domcontentloaded' });

      const avatarSelector = 'img[src="/assets/placeholders/user.png"][alt="Placeholder avatar"]';
      const paginationSelector = 'button.MuiPaginationItem-page[aria-label="page 1"]';
      try {
        await Promise.race([
          page.waitForSelector(avatarSelector, { timeout: 30000 }),
          page.waitForSelector(paginationSelector, { timeout: 30000 })
        ]);
        console.log('[1:LOGIN_SUCCESS] Login successful.');
      } catch (err) {
        throw new Error('Login failed: No dashboard indicator found.');
      }
    });

    // ---------- 2. LOAD LIST ----------
    console.log('[2:LIST_START] Loading incident list...');
    const allIncidents = [];

    async function fetchCurrentPageIncidents() {
      const masterPromise = page.waitForResponse(r => 
        r.url().includes('/api/incident') && 
        r.status() === 200 &&
        !r.url().includes('comments') && 
        !r.url().includes('contact')
      );

      try {
        const masterResp = await masterPromise;
        const masterJson = await masterResp.json();
        const incidents = masterJson.incidents || [];
        console.log(`[2:LIST_FOUND] Found ${incidents.length} incidents.`);
        return incidents;
      } catch (err) {
        console.error('[2:LIST_ERROR] Error fetching incidents:', err);
        return [];
      }
    }

    const currentIncidents = await fetchCurrentPageIncidents();
    allIncidents.push(...currentIncidents);

    // ---------- 3. FETCH DETAILS ----------
    const rows = [];

    for (const inc of allIncidents) {
      const id = inc.IncidentId;
      console.log(`[3:DETAIL_START:${id}] Processing ${id}...`);

      try {
        await withRetry(async () => {
          await page.goto(LIST_URL + `incident?incidentId=${id}`, { waitUntil: 'domcontentloaded' });
          const assessResp = await page.waitForResponse(r => 
            r.url().includes(`/api/assessment/incident/${id}`) && 
            !r.url().includes('comments') && 
            !r.url().includes('contact')
          );
          const assessJSON = await assessResp.json();
          const assess = assessJSON.assessments || [];

          const commentsResp = await page.waitForResponse(r => 
            r.url().includes(`/api/incident/${id}/comments`)
          );
          const commentsJSON = await commentsResp.json();
          const commentsArray = commentsJSON.comments || [];
          let comments = '';
          for (const cmnts of commentsArray) {
            comments += (`[ ${cmnts.description} ]\n`);
          }

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

          // Wait for modal to appear (adjust selector if needed, e.g., a dialog class)
          try {
            await page.waitForSelector('.MuiDialog-root, .modal-class', { timeout: 5000 }); // Placeholder for modal
          } catch {
            console.warn('[3:DETAIL_WARN] Modal not detected; proceeding anyway.');
          }

          await new Promise(resolve => setTimeout(resolve, 3000));

          let contact = [];
          try {
            const contactResp = await page.waitForResponse(r =>
              r.url().includes(`/api/incident/${id}/contact`) && 
              r.status() === 200 &&
              r.request().method() === 'GET'
            , { timeout: 120000 });
            const contactJSON = await contactResp.json();
            contact = contactJSON.contactNotes || [];
          } catch (err) {
            console.warn(`[3:DETAIL_WARN:${id}] Contact API timeout; using empty contact.`);
          }

          const addrParts = (inc.addressRaw || '').split(', ');
          const city = inc.cityName || addrParts[1] || '';
          const zip = addrParts[2] ? addrParts[2].split(' ')[1] : '';

          const phoneMatch = (inc.searchableContent || '').match(/\d{3}[-.\s]?\d{3}[-.\s]?\d{4}/g) || [];
          const ownerMatch = (inc.searchableContent || '').match(/\[CONTACT\][^/]+\/([^/]+)/i);
          const ownerName = ownerMatch ? ownerMatch[1].trim() : '';

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
            sla_due: null,
            ai_score: inc.commentCount > 3 ? 95 : (inc.commentCount > 1 ? 80 : 60),
            assigned_agent: '',
            contractor: '',
            commission_pct: null,
            owner_name: (assess[0]?.ownerInfo?.name + ' / ' + assess[0]?.lastSale?.buyer) || ownerName || null,
            phone: phoneMatch[0] || 
                    (contact[0]?.contact ? 
                    contact[0].contact.match(/\d{3}[-.\s]?\d{3}[-.\s]?\d{4}/)?.[0] : null) || null,
            damage_description: inc.searchableContent ? inc.searchableContent.substring(0, 300) : null,
            family_note: inc.paged ? 'PAGED - Urgent Follow-Up' : 'Not Paged',
            description: inc.searchableContent ? inc.searchableContent.substring(0, 500) : null,
            stage: 'New Alert'
          });
        });
      } catch (detailErr) {
        console.error(`[3:DETAIL_ERROR:${id}] Failed to process ${id}:`, detailErr);
        // Continue to next incident
      }
    }

    // ---------- 4. UPSERT TO SUPABASE ----------
    if (rows.length > 0) {
      console.log(`[4:UPSERT_START] Upserting ${rows.length} rows...`);
      const { error } = await supabase
        .from('incidents')
        .upsert(rows, { onConflict: 'incident_id' });

      if (error) {
        console.error('[4:UPSERT_ERROR] Supabase error:', error);
      } else {
        console.log('[4:UPSERT_SUCCESS] Upsert successful.');
      }
    } else {
      console.log('[4:UPSERT_NONE] No rows to upsert.');
    }
  } catch (err) {
    console.error('[ERROR] Script failed:', err);
    if (page) {
      const pageContent = await page.content();
      console.log('[ERROR_PAGE] Page content on error:', pageContent.substring(0, 1000));
    }
  } finally {
    console.log('[FINAL] Closing browser...');
    await browser.close();
  }
})();
