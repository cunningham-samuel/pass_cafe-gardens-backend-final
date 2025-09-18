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

app.use(cors());

const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
});
app.use(limiter);

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
            return res.json({ dedicatedMember: true });
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

cron.schedule('*/5 8-19 * * 1-5', () => {
  bookingsJob.runOnce(console).catch(err => console.error('bookingsJob failed:', err));
}, { timezone: 'Europe/London' });

cron.schedule('0 5 * * *', () => {
  dedicatedJob.runOnce(console).catch(err => console.error('dedicatedMembersJob failed:', err));
}, { timezone: 'Europe/London' });

// Warm on boot (optional)
(async () => {
  try { await dedicatedJob.runOnce(console); await bookingsJob.runOnce(console); }
  catch (e) { console.error('Initial warm failed:', e); }
})();

app.listen(port, () => {
    console.log(`Server running on port ${port}`);
});

