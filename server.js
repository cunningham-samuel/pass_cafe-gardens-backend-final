const express = require('express');
const axios = require('axios');
const cors = require('cors');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');

const app = express();
const port = process.env.PORT;

const cron = require('node-cron');
const db = require('./db');
const bookingsJob = require('./jobs/bookingsJob');
const dedicatedJob = require('./jobs/dedicatedMembersJob');

const fs = require('fs');
const path = require('path');

async function autoMigrate() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await db.query(sql);
  await db.query(`ALTER TABLE IF EXISTS bookings ALTER COLUMN coworker_id DROP NOT NULL`);
  console.log('✅ autoMigrate: schema ensured');
}

app.use(cors());

const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
});
app.use(limiter);

// ADD: simple admin token auth for health/stats endpoints
function adminAuth(req, res, next) {
  const token = req.get('x-admin-token');
  if (!token || token !== process.env.ADMIN_READONLY_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ADD: admin-only endpoints to verify DB + jobs
app.get('/admin/health', adminAuth, (req, res) => {
  res.json({ ok: true, tz: process.env.TZ || 'default', now: new Date().toISOString() });
});

app.get('/admin/stats', adminAuth, async (req, res) => {
  const b = await db.query('SELECT COUNT(*)::int AS count FROM bookings');
  const d = await db.query('SELECT COUNT(*)::int AS count FROM dedicated_members');
  const j = await db.query('SELECT job_name, last_run_utc FROM job_state ORDER BY job_name');
  res.json({ bookingsCount: b.rows[0].count, dedicatedCount: d.rows[0].count, jobs: j.rows });
});

app.get('/admin/bookings/sample', adminAuth, async (req, res) => {
  const r = await db.query(`
    SELECT booking_id, coworker_full_name, resource_name, from_time_utc, to_time_utc, status
    FROM bookings
    ORDER BY from_time_utc DESC
    LIMIT 10
  `);
  res.json(r.rows);
});

const NEXUDUS_API_USERNAME = process.env.NEXUDUS_API_USERNAME;
const NEXUDUS_API_PASSWORD = process.env.NEXUDUS_API_PASSWORD;
const NEXUDUS_SHARED_SECRET = process.env.NEXUDUS_SHARED_SECRET;

function isValidHash(userid, providedHash) {
    const stringToSign = String(userid).trim();
    const hmac = crypto.createHmac('sha256', NEXUDUS_SHARED_SECRET);
    hmac.update(stringToSign);
    const calculatedHash = hmac.digest('hex');

    console.log("Validating request:");
    console.log("UserID:", stringToSign);
    console.log("Provided Hash:", providedHash);
    console.log("Calculated Hash:", calculatedHash);

    return calculatedHash === providedHash;
}

function getTodayDateRange() {
    const now = new Date();

    const startOfDay = new Date(now);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(now);
    endOfDay.setHours(23, 59, 59, 999);

    const format = (date) => date.toISOString().split('.')[0] + 'Z';

    return {
        from: format(startOfDay),
        to: format(endOfDay),
    };
}

app.get('/api/get-bookings', async (req, res) => {
    const { userid, hash } = req.query;

    if (!userid || !hash) {
        return res.status(400).json({ error: 'Missing userid or hash parameter.' });
    }
    if (!/^\d+$/.test(userid)) {
        return res.status(400).json({ error: 'Invalid userid format.' });
    }

    if (!isValidHash(userid, hash)) {
        console.error('Invalid hash signature.');
        return res.status(403).json({ error: 'Invalid signature.' });
    }

    try {
        // STEP 1 - Lookup coworker by user ID
        console.log("Looking up coworker for UserID:", userid);
        const coworkerRes = await axios.get(
            `https://spaces.nexudus.com/api/spaces/coworkers?Coworker_User=${userid}`,
            {
                auth: {
                    username: NEXUDUS_API_USERNAME,
                    password: NEXUDUS_API_PASSWORD
                }
            }
        );

        const coworkerRecords = coworkerRes.data.Records;
        if (!coworkerRecords || coworkerRecords.length === 0) {
            console.error("No coworker found for UserID:", userid);
            return res.json({ bookings: [] });
        }

        const coworker = coworkerRecords[0];
        const coworkerId = coworker.Id;
        console.log("Found coworker ID:", coworkerId);

        // ✅ NEW LOGIC: Check for Dedicated desk membership
        const tariff = coworker.CoworkerContractTariffNames || '';
        console.log("Tariff names:", tariff);
        if (tariff.toLowerCase().includes("dedicated")) {
  console.log("Dedicated desk member detected, skipping bookings check.");
  return res.json({ dedicatedDesk: true }); // match your HTML
}


        // STEP 2 - Get bookings for coworker today
        const { from, to } = getTodayDateRange();

        console.log(`Querying bookings for coworker ${coworkerId} from ${from} to ${to}`);

        const bookingsRes = await axios.get(
            `https://spaces.nexudus.com/api/spaces/bookings?Booking_Coworker=${coworkerId}&from_Booking_FromTime=${from}&to_Booking_ToTime=${to}&status=Confirmed`,
            {
                auth: {
                    username: NEXUDUS_API_USERNAME,
                    password: NEXUDUS_API_PASSWORD
                }
            }
        );

        const bookings = bookingsRes.data.Records || [];

        console.log(`Found ${bookings.length} bookings for coworker.`);

        res.json({ bookings: bookings });
    } catch (err) {
        console.error("Error calling Nexudus API:", err?.response?.data || err.message);
        res.status(500).json({ error: 'Failed to retrieve bookings.' });
    }
});

// ADD: scheduled jobs (Europe/London)
cron.schedule('*/5 8-19 * * 1-5', () => {
  bookingsJob.runOnce(console).catch(err => console.error('bookingsJob failed:', err));
}, { timezone: 'Europe/London' });

cron.schedule('0 5 * * *', () => {
  dedicatedJob.runOnce(console).catch(err => console.error('dedicatedMembersJob failed:', err));
}, { timezone: 'Europe/London' });

// Optional: warm jobs on boot so you have data immediately

(async () => {
  try {
    await autoMigrate();                 // <-- runs the schema
    // (optional) warm jobs on boot:
    await dedicatedJob.runOnce(console);
    await bookingsJob.runOnce(console);
  } catch (e) {
    console.error('Startup init failed:', e);
  }
})();

app.listen(port, () => {
    console.log(`Server running on port ${port}`);
});

