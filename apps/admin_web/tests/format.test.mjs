// Run with: npm test
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { agoLabel, dayLabel, humanize, rangeToIso, sarH, shortH, todayInRiyadh, whenLabel } from "../src/lib/format.ts";

describe("money from halalas", () => {
  it("shows whole riyals without decimals and keeps halalas when there are some", () => {
    assert.equal(sarH(23000), "SAR 230");
    assert.equal(sarH(23050), "SAR 230.50");
    assert.equal(sarH(123456789), "SAR 1,234,567.89");
    assert.equal(sarH(0), "SAR 0");
    assert.equal(sarH(null), "—");
    assert.equal(sarH(undefined), "—");
  });
  it("shortens big figures", () => {
    assert.equal(shortH(384000000), "SAR 3.84M");
    assert.equal(shortH(56200000), "SAR 562K");
    assert.equal(shortH(150000), "SAR 1,500");
    assert.equal(shortH(null), "—");
  });
});

describe("the Riyadh calendar", () => {
  it("takes today's date in UTC+3", () => {
    assert.equal(todayInRiyadh(Date.parse("2026-10-07T20:59:00Z")), "2026-10-07");
    assert.equal(todayInRiyadh(Date.parse("2026-10-07T21:00:00Z")), "2026-10-08");
  });
  it("turns a day range into the instants the backend takes: start of the first day, start of the day after the last", () => {
    assert.deepEqual(rangeToIso({ from: "2026-10-01", to: "2026-10-07" }), { from: "2026-09-30T21:00:00.000Z", to: "2026-10-07T21:00:00.000Z" });
    assert.deepEqual(rangeToIso({ from: "2026-12-31", to: "2026-12-31" }), { from: "2026-12-30T21:00:00.000Z", to: "2026-12-31T21:00:00.000Z" });
  });
  it("labels days and times", () => {
    const now = Date.parse("2026-10-07T12:00:00Z");
    assert.equal(dayLabel("2026-10-05T10:00:00Z", now), "5 Oct");
    assert.equal(dayLabel("2025-10-05T10:00:00Z", now), "5 Oct 2025");
    assert.equal(dayLabel(null), "—");
    assert.equal(whenLabel("2026-10-07T15:00:00Z", now), "Today · 6:00 PM");
    assert.equal(whenLabel("2026-10-06T16:00:00Z", now), "Yesterday · 7:00 PM");
    assert.equal(whenLabel("2026-10-08T09:30:00Z", now), "Tomorrow · 12:30 PM");
    assert.equal(whenLabel("2026-10-03T09:00:00Z", now), "3 Oct · 12:00 PM");
    assert.equal(whenLabel("2026-10-07T21:30:00Z", now), "Tomorrow · 12:30 AM");
  });
  it("says how long ago", () => {
    const now = Date.parse("2026-10-07T12:00:00Z");
    assert.equal(agoLabel("2026-10-07T11:59:40Z", now), "just now");
    assert.equal(agoLabel("2026-10-07T11:55:00Z", now), "5 min ago");
    assert.equal(agoLabel("2026-10-07T09:00:00Z", now), "3 h ago");
    assert.equal(agoLabel("2026-10-05T12:00:00Z", now), "2 d ago");
    assert.equal(agoLabel(null), "—");
  });
});

describe("humanize", () => {
  it("turns enum values into words", () => {
    assert.equal(humanize("UNDER_REVIEW"), "Under review");
    assert.equal(humanize("CASH"), "Cash");
    assert.equal(humanize(null), "—");
  });
});
