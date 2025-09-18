const axios = require('axios');
const fs = require('fs');
const path = require('path');

// Nexudus credentials from environment variables
const NEXUDUS_API_USERNAME = process.env.NEXUDUS_API_USERNAME;
const NEXUDUS_API_PASSWORD = process.env.NEXUDUS_API_PASSWORD;

if (!NEXUDUS_API_USERNAME || !NEXUDUS_API_PASSWORD) {
    console.error("❌ Missing Nexudus credentials in environment variables.");
    process.exit(1);
}

console.log(`🔐 Using Nexudus API username: ${NEXUDUS_API_USERNAME}`);

// Get today's date range (00:00 to 23:59 UTC)
function getTodayDateRange() {
    const now = new Date();

    const startOfDay = new Date(Date.UTC(
        now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(),
        0, 0, 0, 0
    ));

    const endOfDay = new Date(Date.UTC(
        now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(),
        23, 59, 59, 999
    ));

    const format = (date) => date.toISOString().split('.')[0] + 'Z';

    return {
        from: format(startOfDay),
        to: format(endOfDay),
    };
}

async function fetchAllCoworkers() {
    const coworkers = [];
    let page = 1;

    while (true) {
        console.log(`🔄 Fetching coworkers page ${page}...`);
        try {
            const res = await axios.get(`https://spaces.nexudus.com/api/spaces/coworkers?page=${page}&size=100`, {
                auth: {
                    username: NEXUDUS_API_USERNAME,
                    password: NEXUDUS_API_PASSWORD
                }
            });

            coworkers.push(...res.data.Records);

            if (res.data.Records.length < 100) break;
            page++;
        } catch (error) {
            console.error(`❌ Failed to fetch coworkers page ${page}:`, error.response?.data || error.message);
            throw error;
        }
    }

    console.log(`✅ Retrieved ${coworkers.length} coworkers`);
    return coworkers;
}

async function fetchBookingsForCoworker(coworkerId, coworkerFullName) {
    const { from, to } = getTodayDateRange();
    const url = `https://spaces.nexudus.com/api/spaces/bookings?Booking_Coworker=${coworkerId}&from_Booking_FromTime=${from}&to_Booking_ToTime=${to}&status=Confirmed`;

    try {
        const res = await axios.get(url, {
            auth: {
                username: NEXUDUS_API_USERNAME,
                password: NEXUDUS_API_PASSWORD
            }
        });

        return res.data.Records.map(b => ({
            CoworkerId: coworkerId,
            CoworkerFullName: coworkerFullName,
            ResourceName: b.ResourceName,
            FromTime: b.FromTime,
            ToTime: b.ToTime,
        }));
    } catch (error) {
        console.error(`❌ Failed to fetch bookings for coworker ${coworkerFullName} (${coworkerId}):`, error.response?.data || error.message);
        return []; // fail silently, skip broken coworker
    }
}

async function main() {
    try {
        console.log("🚀 Starting bookings update...");

        const coworkers = await fetchAllCoworkers();
        const allBookings = [];

        for (const coworker of coworkers) {
            const isDedicated = (coworker.CoworkerContractTariffNames || '').toLowerCase().includes('dedicated');
            const coworkerUserId = coworker.UserId;

            if (isDedicated) {
                console.log(`🪑 Dedicated member: ${coworker.FullName}`);
                allBookings.push({
                    CoworkerId: coworker.Id,
                    CoworkerFullName: coworker.FullName,
                    UserId: coworkerUserId,
                    isDedicated: true,
                });
                continue;
            }

            const bookings = await fetchBookingsForCoworker(coworker.Id, coworker.FullName);
            bookings.forEach(booking => booking.UserId = coworkerUserId); // Attach UserId
            allBookings.push(...bookings);
        }

        const outputPath = path.join(__dirname, '..', 'bookings.json');
        fs.writeFileSync(outputPath, JSON.stringify(allBookings, null, 2));

        console.log(`✅ Saved ${allBookings.length} records to bookings.json`);
    } catch (err) {
        console.error("❌ Error updating bookings:", err.response?.data || err.message);
        process.exit(1);
    }
}

main();


