const db = require('../db');
const { client } = require('../nexudus');

function todayRangeISO() {
  const now = new Date();
  const start = new Date(now); start.setHours(0,0,0,0);
  const end   = new Date(now); end.setHours(23,59,59,999);
  const fix = d => new Date(d.getTime() - d.getTimezoneOffset()*60000).toISOString().split('.')[0] + 'Z';
  return { from: fix(start), to: fix(end) };
}

async function upsertBooking(rec) {
  const q = `
    INSERT INTO bookings (booking_id, coworker_id, coworker_full_name, resource_name, from_time_utc, to_time_utc, status, payload, fetched_at_utc)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
    ON CONFLICT (booking_id) DO UPDATE SET
      coworker_id=$2, coworker_full_name=$3, resource_name=$4,
      from_time_utc=$5, to_time_utc=$6, status=$7, payload=$8, fetched_at_utc=NOW()
  `;
  const params = [
    rec.Id,
    rec.Booking_Coworker?.Id || rec.Booking_Coworker || null,
    rec.CoworkerFullName || null,
    rec.ResourceName || null,
    rec.FromTime,
    rec.ToTime,
    rec.Status || 'Confirmed',
    rec
  ];
  await db.query(q, params);
}

async function runOnce(logger = console) {
  const { from, to } = todayRangeISO();
  logger.info?.(`Pulling bookings from ${from} to ${to}...`);
  const res = await client.get('/spaces/bookings', {
    params: { from_Booking_FromTime: from, to_Booking_ToTime: to, status: 'Confirmed', size: 500, page: 1 }
  });
  const records = res.data?.Records || [];
  logger.info?.(`Got ${records.length} bookings.`);
  for (const r of records) await upsertBooking(r);
  await db.query(`DELETE FROM bookings WHERE to_time_utc::date < NOW()::date;`);
  await db.query(`
    INSERT INTO job_state (job_name, last_run_utc)
    VALUES ('bookingsJob', NOW())
    ON CONFLICT (job_name) DO UPDATE SET last_run_utc = EXCLUDED.last_run_utc;
  `);
  logger.info?.('Bookings job complete');
}

module.exports = { runOnce };
