export function normalizeName(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ")
    .toLocaleLowerCase("en-GB");
}

export function normalizeEmail(value) {
  return String(value ?? "").trim().toLowerCase();
}

export function getCustomField(record, name) {
  const data = record?.CustomFields?.Data;
  if (!Array.isArray(data)) return null;

  const field = data.find((item) => item?.Name === name);
  const value = field?.Value;
  if (value === null || value === undefined || String(value).trim() === "") {
    return null;
  }
  return String(value).trim();
}

export function formatSaltoPin(rawPin) {
  if (rawPin === null || rawPin === undefined) return null;
  const pin = String(rawPin).trim().replace(/#+$/g, "");
  return pin ? `${pin}#` : null;
}

export function selectSelfVisitor(bookingVisitors, bookerName, bookerEmail = null) {
  if (!Array.isArray(bookingVisitors) || !bookerName) {
    return { match: null, reason: "no-candidates" };
  }

  const wantedName = normalizeName(bookerName);
  const nameMatches = bookingVisitors.filter(
    (item) => normalizeName(item?.VisitorFullName) === wantedName
  );

  if (nameMatches.length === 0) {
    return { match: null, reason: "name-mismatch" };
  }

  if (nameMatches.length === 1) {
    return { match: nameMatches[0], reason: "name-match" };
  }

  const wantedEmail = normalizeEmail(bookerEmail);
  if (wantedEmail) {
    const emailMatches = nameMatches.filter(
      (item) => normalizeEmail(item?.VisitorEmail) === wantedEmail
    );
    if (emailMatches.length === 1) {
      return { match: emailMatches[0], reason: "name-and-email-match" };
    }
  }

  return { match: null, reason: "ambiguous-name-match" };
}

export function firstObject(payload) {
  if (Array.isArray(payload)) return payload[0] ?? null;
  return payload && typeof payload === "object" ? payload : null;
}

export function extractEntityId(payload, entityName) {
  const root = firstObject(payload);
  if (!root) return null;

  const directCandidates =
    entityName === "booking"
      ? [root.BookingId, root.Id]
      : [root.VisitorId, root.Id];

  for (const value of directCandidates) {
    const id = Number(value);
    if (Number.isInteger(id) && id > 0) return id;
  }

  const nestedCandidates = [
    root.Data,
    root.Record,
    root.Item,
    entityName === "booking" ? root.Booking : root.Visitor,
  ];

  for (const nested of nestedCandidates) {
    if (!nested || typeof nested !== "object") continue;
    const value =
      entityName === "booking"
        ? nested.BookingId ?? nested.Id
        : nested.VisitorId ?? nested.Id;
    const id = Number(value);
    if (Number.isInteger(id) && id > 0) return id;
  }

  return null;
}
