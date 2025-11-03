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

      // Wait for the avatar image to confirm login (post-login indicator)
      const avatarSelector = 'img[src="/assets/placeholders/user.png"][alt="Placeholder avatar"]';
      await page.waitForSelector(avatarSelector, { timeout: 60000 });
      console.log('Login successful: Avatar selector found.');

      // Additional check: Log current URL after login
      console.log('Post-login URL:', await page.url());
    });

    // ---------- 2. LOAD LIST & HANDLE PAGINATION ----------
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

    // Get initial page incidents
    let currentIncidents = await fetchCurrentPageIncidents();
    allIncidents.push(...currentIncidents);

    // Determine total pages (evaluate pagination)
    console.log('Evaluating total pages...');
    const totalPages = await page.evaluate(() => {
      const pageItems = document.querySelectorAll('.MuiPaginationItem-page');
      return pageItems.length; // Assumes pages are numbered 1 to N without ellipsis
    });
    console.log(`Detected ${totalPages} pages`);

    // Loop through pages 2 to totalPages
    for (let pageNum = 2; pageNum <= totalPages; pageNum++) {
      await withRetry(async () => {
        console.log(`Switching to page ${pageNum}...`);
        // Target and click the next page button
        const nextSelector = `button.MuiPaginationItem-page[aria-label="page ${pageNum}"]`;
        await page.waitForSelector(nextSelector, { timeout: 20000 });
        const nextButton = await page.$(nextSelector);
        if (nextButton) {
          await nextButton.click();
          console.log(`Clicked page ${pageNum} button.`);
          // Wait for page to load (e.g., new API call)
          await page.waitForSelector('.some-incident-list-selector', { timeout: 30000 }); // Replace with a selector that indicates list refresh, e.g., a table or list class
          console.log(`Page ${pageNum} loaded.`);
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

