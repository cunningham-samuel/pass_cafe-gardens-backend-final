import {
  extractEntityId,
  formatSaltoPin,
  getCustomField,
  selectSelfVisitor,
} from "./lib.js";

const DEFAULT_RETRY_DELAYS = [0, 250, 750, 1500, 3000, 6000];

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return json({
        ok: true,
        service: "distil-nexudus-booking-pin",
        now: new Date().toISOString(),
      });
    }

    if (
      request.method === "POST" &&
      url.pathname === "/webhooks/nexudus/booking-created"
    ) {
      const webhook = await readAndVerifyWebhook(request, env);
      if (!webhook.ok) return webhook.response;

      const bookingId = extractEntityId(webhook.payload, "booking");
      if (!bookingId) {
        console.error("Booking webhook payload had no usable booking id", webhook.payload);
        return json({ ok: false, error: "No booking id in payload" }, 400);
      }

      ctx.waitUntil(
        processBookingWithRetries(bookingId, env).catch((error) => {
          console.error("Booking PIN sync failed", { bookingId, error: error.message });
        })
      );

      return json({ ok: true, accepted: true, bookingId }, 202);
    }

    if (
      request.method === "POST" &&
      url.pathname === "/webhooks/nexudus/visitor-registered"
    ) {
      const webhook = await readAndVerifyWebhook(request, env);
      if (!webhook.ok) return webhook.response;

      const visitorId = extractEntityId(webhook.payload, "visitor");
      if (!visitorId) {
        console.error("Visitor webhook payload had no usable visitor id", webhook.payload);
        return json({ ok: false, error: "No visitor id in payload" }, 400);
      }

      ctx.waitUntil(
        processVisitorWithRetries(visitorId, env).catch((error) => {
          console.error("Visitor-triggered PIN sync failed", {
            visitorId,
            error: error.message,
          });
        })
      );

      return json({ ok: true, accepted: true, visitorId }, 202);
    }

    if (
      request.method === "POST" &&
      url.pathname === "/admin/process-booking"
    ) {
      if (!env.ADMIN_TOKEN || request.headers.get("x-admin-token") !== env.ADMIN_TOKEN) {
        return json({ ok: false, error: "Unauthorized" }, 401);
      }

      const bookingId = Number(url.searchParams.get("bookingId"));
      if (!Number.isInteger(bookingId) || bookingId <= 0) {
        return json({ ok: false, error: "bookingId must be a positive integer" }, 400);
      }

      try {
        const result = await processBookingWithRetries(bookingId, env);
        return json({ ok: true, result });
      } catch (error) {
        console.error("Manual booking PIN sync failed", {
          bookingId,
          error: error.message,
        });
        return json({ ok: false, error: error.message }, 500);
      }
    }

    return json({ ok: false, error: "Not found" }, 404);
  },
};

async function processVisitorWithRetries(visitorId, env) {
  const delays = retryDelays(env);

  for (let attempt = 0; attempt < delays.length; attempt += 1) {
    if (delays[attempt] > 0) await sleep(delays[attempt]);

    const links = await searchBookingVisitors(env, {
      BookingVisitor_Visitor: visitorId,
      size: 20,
      page: 1,
    });

    const bookingIds = [
      ...new Set(
        links
          .map((item) => Number(item?.BookingId))
          .filter((id) => Number.isInteger(id) && id > 0)
      ),
    ];

    if (bookingIds.length === 0) {
      continue;
    }

    const results = [];
    for (const bookingId of bookingIds) {
      results.push(await processBookingWithRetries(bookingId, env));
    }

    return { status: "processed-linked-bookings", visitorId, results };
  }

  return { status: "no-linked-booking", visitorId };
}

async function processBookingWithRetries(bookingId, env) {
  const booking = await apiGet(env, `/spaces/bookings/${bookingId}`);
  const booker = await resolveBooker(booking, env);

  if (!booker.name) {
    return { status: "skipped", reason: "booking-has-no-booker-name", bookingId };
  }

  const delays = retryDelays(env);

  for (let attempt = 0; attempt < delays.length; attempt += 1) {
    if (delays[attempt] > 0) await sleep(delays[attempt]);

    const bookingVisitors = await searchBookingVisitors(env, {
      BookingVisitor_Booking: bookingId,
      size: 50,
      page: 1,
    });

    if (bookingVisitors.length === 0) {
      continue;
    }

    const selection = selectSelfVisitor(
      bookingVisitors,
      booker.name,
      booker.email
    );

    if (!selection.match) {
      return {
        status: "skipped",
        reason: selection.reason,
        bookingId,
        bookerName: booker.name,
        visitorNames: bookingVisitors.map((item) => item?.VisitorFullName ?? null),
      };
    }

    const visitorId = Number(selection.match.VisitorId);
    if (!Number.isInteger(visitorId) || visitorId <= 0) {
      return {
        status: "skipped",
        reason: "matched-bookingvisitor-has-no-visitor-id",
        bookingId,
      };
    }

    const visitor = await apiGet(env, `/spaces/visitors/${visitorId}`);
    const rawPin = getCustomField(visitor, "Salto.Pin");

    if (!rawPin) {
      continue;
    }

    const pin = formatSaltoPin(rawPin);
    const notePrefix = String(env.NOTE_PREFIX || "Door access code:").trim();
    const noteText = `${notePrefix} ${pin}`;

    if (await bookingAlreadyHasNote(env, bookingId, noteText)) {
      return {
        status: "already-present",
        bookingId,
        visitorId,
        pin,
      };
    }

    const created = await apiPost(env, "/spaces/bookingnotes", {
      BookingId: bookingId,
      Notes: noteText,
    });

    if (created?.WasSuccessful === false) {
      throw new Error(
        `Nexudus rejected BookingNote: ${created?.Message || "unknown error"}`
      );
    }

    console.log("Added Salto PIN to booking note", {
      bookingId,
      visitorId,
      selection: selection.reason,
    });

    return {
      status: "note-created",
      bookingId,
      visitorId,
      pin,
      bookingNoteId: created?.Value?.Id ?? null,
    };
  }

  return {
    status: "skipped",
    reason: "visitor-link-or-salto-pin-not-ready-after-retries",
    bookingId,
  };
}

async function resolveBooker(booking, env) {
  const directName =
    booking?.CoworkerFullName ??
    booking?.Booking_CoworkerFullName ??
    booking?.Booking_Coworker?.FullName ??
    booking?.Coworker?.FullName ??
    null;

  const directEmail =
    booking?.CoworkerEmail ??
    booking?.Booking_CoworkerEmail ??
    booking?.Booking_Coworker?.Email ??
    booking?.Coworker?.Email ??
    null;

  if (directName) {
    return { name: directName, email: directEmail };
  }

  const coworkerId = Number(
    booking?.CoworkerId ??
      booking?.Booking_CoworkerId ??
      booking?.Booking_Coworker?.Id ??
      booking?.Coworker?.Id
  );

  if (!Number.isInteger(coworkerId) || coworkerId <= 0) {
    return { name: null, email: null };
  }

  const coworker = await apiGet(env, `/spaces/coworkers/${coworkerId}`);
  return {
    name: coworker?.FullName ?? null,
    email: coworker?.Email ?? null,
  };
}

async function searchBookingVisitors(env, params) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined) {
      query.set(key, String(value));
    }
  }

  const response = await apiGet(
    env,
    `/spaces/bookingvisitors?${query.toString()}`
  );
  return Array.isArray(response?.Records) ? response.Records : [];
}

async function bookingAlreadyHasNote(env, bookingId, noteText) {
  try {
    const query = new URLSearchParams({
      BookingNote_Booking: String(bookingId),
      size: "100",
      page: "1",
    });

    const response = await apiGet(env, `/spaces/bookingnotes?${query.toString()}`);
    const records = Array.isArray(response?.Records) ? response.Records : [];

    return records.some((note) => {
      const sameBooking = Number(note?.BookingId) === Number(bookingId);
      const sameText = String(note?.Notes ?? "").trim() === noteText.trim();
      return sameBooking && sameText;
    });
  } catch (error) {
    // Read access/filter support for BookingNotes varies by API role/version.
    // Failure here should not block the primary write path.
    console.warn("Could not check existing BookingNotes; continuing", {
      bookingId,
      error: error.message,
    });
    return false;
  }
}

async function apiGet(env, path) {
  return apiRequest(env, path, { method: "GET" });
}

async function apiPost(env, path, body) {
  return apiRequest(env, path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function apiRequest(env, path, init) {
  const base = String(
    env.NEXUDUS_API_BASE || "https://spaces.nexudus.com/api"
  ).replace(/\/$/, "");

  const headers = new Headers(init.headers || {});
  headers.set("authorization", buildNexudusAuthorization(env));
  headers.set("accept", "application/json");

  const response = await fetch(`${base}${path}`, {
    ...init,
    headers,
  });

  const text = await response.text();
  let body = null;

  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }

  if (!response.ok) {
    throw new Error(
      `Nexudus ${init.method} ${path} failed (${response.status}): ${typeof body === "string" ? body : JSON.stringify(body)}`
    );
  }

  return body;
}

function buildNexudusAuthorization(env) {
  if (env.NEXUDUS_BEARER_TOKEN) {
    return `Bearer ${env.NEXUDUS_BEARER_TOKEN}`;
  }

  if (!env.NEXUDUS_API_USERNAME || !env.NEXUDUS_API_PASSWORD) {
    throw new Error(
      "Set NEXUDUS_BEARER_TOKEN or NEXUDUS_API_USERNAME + NEXUDUS_API_PASSWORD"
    );
  }

  return `Basic ${base64Utf8(
    `${env.NEXUDUS_API_USERNAME}:${env.NEXUDUS_API_PASSWORD}`
  )}`;
}

function base64Utf8(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function readAndVerifyWebhook(request, env) {
  if (!env.NEXUDUS_WEBHOOK_SECRET) {
    return {
      ok: false,
      response: json(
        { ok: false, error: "NEXUDUS_WEBHOOK_SECRET is not configured" },
        500
      ),
    };
  }

  const rawBody = await request.text();
  let payload;

  try {
    payload = JSON.parse(rawBody);
  } catch {
    return {
      ok: false,
      response: json({ ok: false, error: "Invalid JSON" }, 400),
    };
  }

  const provided = request.headers.get("x-nexudus-hook-signature");
  if (!provided) {
    return {
      ok: false,
      response: json({ ok: false, error: "Missing Nexudus signature" }, 401),
    };
  }

  let valid = await verifyHmac(rawBody, provided, env.NEXUDUS_WEBHOOK_SECRET);

  // Nexudus documents signing JsonConvert.SerializeObject(new[] { dto }).
  // Raw-body verification is preferred; this fallback helps if an object is
  // delivered while the documented signed representation is an array.
  if (!valid && !Array.isArray(payload)) {
    valid = await verifyHmac(
      JSON.stringify([payload]),
      provided,
      env.NEXUDUS_WEBHOOK_SECRET
    );
  }

  if (!valid) {
    return {
      ok: false,
      response: json({ ok: false, error: "Invalid Nexudus signature" }, 401),
    };
  }

  return { ok: true, payload };
}

async function verifyHmac(message, providedHex, secret) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(message)
  );

  const calculated = [...new Uint8Array(signature)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

  return timingSafeEqualHex(calculated, String(providedHex).toLowerCase());
}

function timingSafeEqualHex(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function retryDelays(env) {
  const configured = String(env.RETRY_DELAYS_MS || "").trim();
  if (!configured) return DEFAULT_RETRY_DELAYS;

  const parsed = configured
    .split(",")
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isFinite(value) && value >= 0);

  return parsed.length ? parsed : DEFAULT_RETRY_DELAYS;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
