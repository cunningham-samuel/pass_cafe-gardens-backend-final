// jobs/visitorsJob.js
const db = require('../db');
const { client } = require('../nexudus');

function todayRangeISO() {
  const now = new Date();
  const start = new Date(now); start.setHours(0,0,0,0);
  const end   = new Date(now); end.setHours(23,59,59,999);
  // force UTC without ms
  const fix = d => new Date(d.getTime() - d.getTimezoneOffset()*60000).toISOString().split('.')[0] + 'Z';
  return { from: fix(start), to: fix(end) };
}

async function upsertVisitor(v) {
  const sql = `
    INSERT INTO visitors (
      visitor_id,
      coworker_id,
      coworker_full_name,
      full_name,
      email,
      visitor_code,
      phone_number,
      notes,
      expected_arrival_utc,
      arrived,
      arrival_date_utc,
      departure_date_utc,
      is_tour,
      payload,
      fetched_at_utc
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,NOW())
    ON CONFLICT (visitor_id) DO UPDATE SET
      coworker_id = EXCLUDED.coworker_id,
      coworker_full_name = EXCLUDED.coworker_full_name,
      full_name = EXCLUDED.full_name,
      email = EXCLUDED.email,
      visitor_code = EXCLUDED.visitor_code,
      phone_number = EXCLUDED.phone_number,
      notes = EXCLUDED.notes,
      expected_arrival_utc = EXCLUDED.expected_arrival_utc,
      arrived = EXCLUDED.arrived,
      arrival_date_utc = EXCLUDED.arrival_date_utc,
      departure_date_utc = EXCLUDED.departure_date_utc,
      is_tour = EXCLUDED.is_tour,
      payload = EXCLUDED.payload,
      fetched_at_utc = NOW();
  `;
  const params = [
    v.Id,
    v.CoworkerId ?? null,
    v.CoworkerFullName ?? null,
    v.FullName ?? null,
    v.Email ?? null,
    v.VisitorCode ?? null,
    v.PhoneNumber ?? null,
    // prefer Notes; fall back to CustomerNotes
    (v.Notes ?? v.CustomerNotes) ?? null,
    v.ExpectedArrival ?? null,
    // Nexudus sends booleans already
    v.Arrived ?? false,
    v.ArrivalDate ?? null,
    v.DepartureDate ?? null,
    v.IsTour ?? false,
    v
  ];
  await db.query(sql, params);
}

async function runOnce(logger = console) {
  const { from, to } = todayRangeISO();
  logger.info?.(`Pulling visitors (ExpectedArrival) from ${from} to ${to}...`);

  // Use same Axios client you already use for bookings
  const res = await client.get('/spaces/visitors', {
    params: {
      // window by expected arrival today
      from_Visitor_ExpectedArrival: from,
      to_Visitor_ExpectedArrival: to,
      orderBy: 'ExpectedArrival',
      dir: 'Ascending',
      size: 500,
      page: 1
    }
  });

  const records = res.data?.Records || [];
  logger.info?.(`Got ${records.length} visitors.`);

  for (const v of records) {
    await upsertVisitor(v);
  }

  // keep table tidy: drop rows whose expected arrival is before today
  await db.query(`DELETE FROM visitors WHERE expected_arrival_utc::date < NOW()::date;`);

  await db.query(`
    INSERT INTO job_state (job_name, last_run_utc)
    VALUES ('visitorsJob', NOW())
    ON CONFLICT (job_name) DO UPDATE SET last_run_utc = EXCLUDED.last_run_utc;
  `);

  logger.info?.('Visitors job complete');
}

module.exports = { runOnce };
