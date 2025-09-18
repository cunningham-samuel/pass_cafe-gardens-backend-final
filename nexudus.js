const axios = require('axios');
const client = axios.create({
  baseURL: 'https://spaces.nexudus.com/api',
  auth: { username: process.env.NEXUDUS_API_USERNAME, password: process.env.NEXUDUS_API_PASSWORD },
  timeout: 20000
});
async function fetchAllPaged(path, params = {}, pageSize = 200) {
  let page = 1; const out = [];
  while (true) {
    const res = await client.get(path, { params: { ...params, size: pageSize, page } });
    const records = res.data?.Records || [];
    out.push(...records);
    if (records.length < pageSize) break;
    await new Promise(r => setTimeout(r, 200));
    page += 1;
  }
  return out;
}
module.exports = { client, fetchAllPaged };
