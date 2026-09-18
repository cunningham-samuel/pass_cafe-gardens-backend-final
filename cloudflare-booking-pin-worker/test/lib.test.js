import test from "node:test";
import assert from "node:assert/strict";

import {
  extractEntityId,
  formatSaltoPin,
  getCustomField,
  normalizeName,
  selectSelfVisitor,
} from "../src/lib.js";

test("formats Salto PIN with one trailing hash", () => {
  assert.equal(formatSaltoPin("587941"), "587941#");
  assert.equal(formatSaltoPin("587941#"), "587941#");
});

test("reads Salto.Pin from Nexudus visitor custom fields", () => {
  const visitor = {
    CustomFields: {
      Data: [
        { Name: "Salto.Pin", Value: "587941", Type: "string" },
        { Name: "Salto.UserId", Value: "abc", Type: "string" },
      ],
    },
  };

  assert.equal(getCustomField(visitor, "Salto.Pin"), "587941");
});

test("normalises case and whitespace in names", () => {
  assert.equal(normalizeName("  Sam   Cunningham "), "sam cunningham");
});

test("selects exactly one same-name visitor", () => {
  const result = selectSelfVisitor(
    [
      { VisitorId: 1, VisitorFullName: "Other Person", VisitorEmail: "o@example.com" },
      { VisitorId: 2, VisitorFullName: "Sam Cunningham", VisitorEmail: "sam@example.com" },
    ],
    "sam  cunningham",
    "sam@example.com"
  );

  assert.equal(result.match.VisitorId, 2);
});

test("uses email to resolve two identical names", () => {
  const result = selectSelfVisitor(
    [
      { VisitorId: 1, VisitorFullName: "Sam Cunningham", VisitorEmail: "one@example.com" },
      { VisitorId: 2, VisitorFullName: "Sam Cunningham", VisitorEmail: "sam@example.com" },
    ],
    "Sam Cunningham",
    "sam@example.com"
  );

  assert.equal(result.match.VisitorId, 2);
});

test("refuses ambiguous identical names", () => {
  const result = selectSelfVisitor(
    [
      { VisitorId: 1, VisitorFullName: "Sam Cunningham" },
      { VisitorId: 2, VisitorFullName: "Sam Cunningham" },
    ],
    "Sam Cunningham"
  );

  assert.equal(result.match, null);
  assert.equal(result.reason, "ambiguous-name-match");
});

test("extracts ids from Nexudus-style array payload", () => {
  assert.equal(extractEntityId([{ Id: 123 }], "booking"), 123);
  assert.equal(extractEntityId([{ VisitorId: 456 }], "visitor"), 456);
});
