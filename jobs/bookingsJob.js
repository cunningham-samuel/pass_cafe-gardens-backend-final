const db = require('../db');
const { client } = require('../nexudus');

function todayRangeISO() {
  const now = new Date();
  const start = new Date(now); start.setHours(0, 0, 0, 0);
  const end = new Date(now);   end.setHours(23, 59, 59, 999);
  const fix = d => new Date(d.getTime() - d.getTimezoneOffset() * 60000)
    .toISOString().split('.')[0] + 'Z';
  return { from: fix(start), to: fix(end) };
}

// ---- helpers to handle different Nexudus shapes ----
function extractCoworkerId(rec) {
  return (
    rec.Booking_CoworkerId ??
    rec.Booking_Coworker?.Id ??
    rec.Booking_Coworker ??
    rec.CoworkerId ??
    rec.Coworker?.Id ??
    null
  );
}
function extractCoworkerFullName(rec) {
  return rec.CoworkerFullName ?? rec.FullName ?? null;
}
function extractResourceName(rec) {
  return rec.ResourceName ?? rec.Resource?.Name ?? null;
}
// ----------------------------------------------------

async function upsertBooking(rec, logger = console) {
  const coworkerId = extractCoworkerId(rec);
  const coworkerFullName = extractCoworkerFullName(rec);
  const resourceName = extractResourceName(rec);

  if (coworkerId == null) {
    logger.warn?.(`Booking ${rec.Id} has no coworker_id; inserting with NULL.`);
  }

  const q = `
    INSERT INTO bookings
      (booking_id, coworker_id, coworker_full_name, resource_name, from_time_utc, to_time_utc, status, payload, fetched_at_utc)
    VALUES
      ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
    ON CONFLICT (booking_id) DO UPDATE SET
      coworker_id=$2,
      coworker_full_name=$3,
      resource_name=$4,
      from_time_utc=$5,
      to_time_utc=$6,
      status=$7,
      payload=$8,
      fetched_at_utc=NOW()
  `;

  const params = [
    rec.Id,
    coworkerId,                     // may be NULL (schema must allow it)
    coworkerFullName,
    resourceName,
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

  // NOTE: removed the status:'Confirmed' filter so we fetch bookings regardless of status
  const res = await client.get('/spaces/bookings', {
    params: {
      from_Booking_FromTime: from,
      to_Booking_ToTime: to,
      // status: 'Confirmed',   <-- removed per Option A
      size: 500,
      page: 1
    }
  });

  const records = res.data?.Records || [];
  logger.info?.(`Got ${records.length} bookings.`);

  for (const r of records) {
    try {
      await upsertBooking(r, logger);
    } catch (e) {
      logger.error?.(`Failed to upsert booking ${r?.Id}: ${e.message}`);
    }
  }

  // Keep table small (only today)
  await db.query(`DELETE FROM bookings WHERE to_time_utc::date < NOW()::date;`);

  /*
    OPTIONAL: if you want to remove cancelled (or otherwise non-Confirmed) bookings
    from the table for today/future, uncomment or adapt the following line.

    Example: remove non-Confirmed bookings that are today or later:
    await db.query(`DELETE FROM bookings WHERE status != 'Confirmed' AND to_time_utc::date >= NOW()::date;`);

    Alternatively, you might prefer to keep cancelled rows for auditing — choose
    the behavior that matches your app's needs.
  */

  await db.query(`
    INSERT INTO job_state (job_name, last_run_utc)
    VALUES ('bookingsJob', NOW())
    ON CONFLICT (job_name) DO UPDATE SET last_run_utc = EXCLUDED.last_run_utc;
  `);

  logger.info?.('Bookings job complete');
}

module.exports = { runOnce };