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

    (async () => {
    const browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu', '--disable-dev-shm-usage']
    });
    const page = await browser.newPage();

    // ---------- 1. LOGIN (Using name attributes) ----------
    console.log('Logging in...');
    await page.goto('https://client.firenotification.com/auth/sign-in');

    // Wait for email field
    await page.waitForSelector('input[name="email"]', { timeout: 10000 });
    await page.type('input[name="email"]', EMAIL);

    // Wait for password field
    await page.waitForSelector('input[name="password"]');
    await page.type('input[name="password"]', PASSWORD);

    // Click Sign In
    await Promise.all([
        page.click('button[type="submit"]'),
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
    const incidents = masterJson.incidents || [];

    console.log(`Found ${masterJson}`);
    console.log(`Found ${incidents.length} incidents`);

    // ---------- 3. FETCH DETAILS & MAP TO SUPABASE SCHEMA ----------
    const rows = [];

    for (const inc of incidents) {
        const id = inc.IncidentId;
        console.log(`  → ${id}`);

        // 3a – assessment / property
        await page.goto(LIST_URL + `incident?incidentId=${id}`);
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
        const commentsJSON = await commentsResp.json();
        const commentsArray = commentsJSON.comments || [];
        var comments = '';
        for(const cmnts of commentsArray) {
        console.log('CL-1:' + cmnts.description);
        comments += ('[ ' + cmnts.description + ' ]' + '\n');
        }

        console.log('Full Comments: ' + comments);

        // 3c – contact
        // Contact button
        await Promise.all([
            page.click('button:has-text("Contact")'),
            page.waitForNavigation({ waitUntil: 'networkidle0' })
        ]);

        const contactResp = await page.waitForResponse(r => 
        r.url().includes(`/api/incident/${id}/contact`)
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
        owner_name: ownerName || (assess.assessments?.[0]?.ownerInfo?.name) || null,
        phone: phoneMatch[0] || 
                (contact.contactNotes?.[0]?.contact ? 
                contact.contactNotes[0].contact.match(/\d{3}[-.\s]?\d{3}[-.\s]?\d{4}/)?.[0] : null) || null,
        damage_description: inc.searchableContent ? inc.searchableContent.substring(0, 300) : null,
        family_note: inc.paged ? 'PAGED - Urgent Follow-Up' : 'Not Paged',
        description: inc.searchableContent ? inc.searchableContent.substring(0, 500) : null,
        stage: 'New Alert'
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

    await browser.close();
    })();
