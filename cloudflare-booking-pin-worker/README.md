# Distil Nexudus booking PIN Worker

Cloudflare Worker that copies the Salto visitor PIN onto a Nexudus booking note **only when the booking has a visitor whose name matches the booking customer**.

Example:

- Visitor custom field: `Salto.Pin = 587941`
- Booking note written: `Door access code: 587941#`

The normal Nexudus **Booking confirmation** template can then display the note via `{notes}`.

## Safety rules

The worker does not add a PIN when:

- the booking has no BookingVisitor records;
- no visitor name matches the booking customer's name;
- more than one visitor has the same matching name and email cannot disambiguate;
- the matching Visitor has no `Salto.Pin` yet.

It retries briefly because Nexudus can create the BookingVisitor and/or Salto custom field just after the booking itself.

## Endpoints

- `GET /health` — health check.
- `POST /webhooks/nexudus/booking-created` — primary Nexudus **Bookings → Created** webhook.
- `POST /webhooks/nexudus/visitor-registered` — optional second trigger. If the visitor is linked to a booking, the worker processes that booking; standalone visitors (for example tours) are ignored.
- `POST /admin/process-booking?bookingId=123` — manual test/reconciliation endpoint. Requires `x-admin-token`.

## Required Worker secrets

Set these in Cloudflare Worker **Settings → Variables and Secrets**:

- `NEXUDUS_API_USERNAME`
- `NEXUDUS_API_PASSWORD`
- `NEXUDUS_WEBHOOK_SECRET`
- `ADMIN_TOKEN`

The Worker also supports `NEXUDUS_BEARER_TOKEN` instead of username/password if you move the integration to OAuth later.

Never commit these values to GitHub.

## Non-secret variables

Configured in `wrangler.toml`:

- `NEXUDUS_API_BASE=https://spaces.nexudus.com/api`
- `NOTE_PREFIX=Door access code:`
- `RETRY_DELAYS_MS=0,250,750,1500,3000,6000`

## Deploy with Cloudflare Git integration

1. In Cloudflare, open **Workers & Pages** and create/import a Worker from Git.
2. Connect this GitHub repository.
3. Set the root directory to `cloudflare-booking-pin-worker`.
4. Use the repository's default install step and deploy with Wrangler.
5. Add the four secrets listed above.
6. Deploy and open `https://<your-worker>.workers.dev/health`. You should see `"ok": true`.

Alternatively, from the worker directory:

```bash
npm install
npx wrangler login
npx wrangler deploy
```

Then add secrets:

```bash
npx wrangler secret put NEXUDUS_API_USERNAME
npx wrangler secret put NEXUDUS_API_PASSWORD
npx wrangler secret put NEXUDUS_WEBHOOK_SECRET
npx wrangler secret put ADMIN_TOKEN
```

## Nexudus webhook setup

In Nexudus Admin:

1. Go to **Settings → Integrations → Webhooks**.
2. Add a webhook.
3. Name: `Distil - booking Salto PIN to notes`.
4. Location: Distil Coworking Somerset.
5. Action: **Bookings → Created**.
6. URL: `https://<your-worker>.workers.dev/webhooks/nexudus/booking-created`.
7. Ensure the Nexudus webhook shared secret is the same value as `NEXUDUS_WEBHOOK_SECRET` in Cloudflare.
8. Enable the webhook.

Nexudus signs webhook requests with the `X-Nexudus-Hook-Signature` HMAC-SHA256 header. The Worker rejects requests without a valid signature.

### Optional second trigger

For better coverage of ordering/timing, add another webhook pointing to:

`https://<your-worker>.workers.dev/webhooks/nexudus/visitor-registered`

Choose **Visitors → Created/Registered** (Nexudus API action name `VisitorRegistered`). It is safe for standalone visitors because the Worker checks for a BookingVisitor link and does nothing when none exists.

## Test before enabling the webhook

Pick an existing booking that:

- has a linked BookingVisitor;
- the visitor's name is the same as the booking customer;
- the Visitor record contains `Salto.Pin`.

Run:

```bash
curl -X POST \
  "https://<your-worker>.workers.dev/admin/process-booking?bookingId=BOOKING_ID" \
  -H "x-admin-token: YOUR_ADMIN_TOKEN"
```

Expected result:

```json
{
  "ok": true,
  "result": {
    "status": "note-created",
    "bookingId": 123,
    "visitorId": 456,
    "pin": "587941#"
  }
}
```

Check the Nexudus booking. Its public notes should now include:

`Door access code: 587941#`

Run the same test again. The Worker checks existing BookingNotes and should return `already-present` rather than adding a duplicate.

## Booking email template

Keep `{notes}` in **Booking confirmation**.

If you do not want the booker's PIN to appear in **Booking confirmation for Visitors**, remove `{notes}` from that visitor template, as discussed.

## Timing caveat

Nexudus sends booking confirmation notifications soon after a booking is recorded. This Worker starts processing immediately, but Nexudus does not document a guarantee that a webhook-triggered BookingNote will always be written before the native email is rendered.

Test a real booking after deployment. If the note is occasionally too late for the email, keep this Worker for data synchronisation and use a separate notification strategy for the email itself.

## Nexudus API calls used

- `GET /api/spaces/bookings/{id}`
- `GET /api/spaces/coworkers/{id}` (fallback if the booking response has no customer name)
- `GET /api/spaces/bookingvisitors?BookingVisitor_Booking={id}`
- `GET /api/spaces/visitors/{id}`
- `GET /api/spaces/bookingnotes?BookingNote_Booking={id}` (duplicate check)
- `POST /api/spaces/bookingnotes`

The BookingNote POST body is:

```json
{
  "BookingId": 123,
  "Notes": "Door access code: 587941#"
}
```
