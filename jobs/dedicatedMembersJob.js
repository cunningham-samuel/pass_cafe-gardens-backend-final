const db = require('../db');
const { fetchAllPaged } = require('../nexudus');

const isDedicated = s => String(s || '').toLowerCase().includes('dedicated');

async function runOnce(logger = console) {
  logger.info?.('Scanning coworkers for dedicated-desk members...');
  const coworkers = await fetchAllPaged('/spaces/coworkers', {});
  const dedicated = coworkers.filter(cw => isDedicated(cw.CoworkerContractTariffNames));
  logger.info?.(`Found ${dedicated.length} dedicated members.`);
  await db.query('BEGIN');
  try {
    await db.query('TRUNCATE TABLE dedicated_members');
    const insert = `
      INSERT INTO dedicated_members (coworker_id, coworker_userid, full_name, tariff_names, payload, updated_at_utc)
      VALUES ($1,$2,$3,$4,$5,NOW())
      ON CONFLICT (coworker_id) DO UPDATE SET
        coworker_userid=EXCLUDED.coworker_userid,
        full_name=EXCLUDED.full_name,
        tariff_names=EXCLUDED.tariff_names,
        payload=EXCLUDED.payload,
        updated_at_utc=NOW()
    `;
    for (const cw of dedicated) {
      await db.query(insert, [cw.Id, cw.Coworker_User || null, cw.FullName || null, cw.CoworkerContractTariffNames || null, cw]);
    }
    await db.query(`
      INSERT INTO job_state (job_name, last_run_utc)
      VALUES ('dedicatedMembersJob', NOW())
      ON CONFLICT (job_name) DO UPDATE SET last_run_utc = EXCLUDED.last_run_utc;
    `);
    await db.query('COMMIT');
  } catch (e) {
    await db.query('ROLLBACK'); throw e;
  }
  logger.info?.('Dedicated members job complete');
}
module.exports = { runOnce };
