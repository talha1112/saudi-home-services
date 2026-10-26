// Run with: npm test   (Node's built-in test runner; it strips the TypeScript types of the module under test)
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  SingleFlight, backendUrl, cookieLifetimes, isAllowedAdminPath, isSameOrigin, passthroughHeaders,
} from "../src/lib/server/bff-rules.ts";

describe("isAllowedAdminPath: the BFF is not an open proxy", () => {
  it("allows the known admin areas with plain segments", () => {
    for (const p of [["workers"], ["workers", "3f2a-uuid"], ["workers", "id", "documents", "doc", "download-url"], ["services"], ["pricing-settings", "current"], ["reports", "bookings", "trend"], ["support", "threads"], ["support", "threads", "3f2a-uuid", "reply"], ["dashboard"], ["customers", "id"], ["quotes", "summary"], ["search"], ["commissions"], ["notifications", "broadcast"], ["transactions", "summary"], ["admins"], ["system"], ["catalog-stats"], ["report-series", "summary"]]) {
      assert.equal(isAllowedAdminPath(p), true, p.join("/"));
    }
  });
  it("refuses everything else", () => {
    for (const p of [[], ["auth", "refresh"], ["auth"], ["workers", ".."], ["..", "auth", "me"], ["workers", "a/b"], ["workers", "a%2Fb"], ["workers", ""], ["dev", "payments"], ["payments", "webhooks", "x", "a", "b", "c", "d"], ["Workers"], ["workers", "a b"], ["workers", "a?x=1"]]) {
      assert.equal(isAllowedAdminPath(p), false, JSON.stringify(p));
    }
  });
});

describe("backendUrl", () => {
  it("builds /admin/<path> with the query string and encodes segments", () => {
    assert.equal(backendUrl("http://api/v1", ["workers", "x"], "?status=A,B&limit=5"), "http://api/v1/admin/workers/x?status=A,B&limit=5");
    assert.equal(backendUrl("http://api/v1/", ["workers"], ""), "http://api/v1/admin/workers");
    assert.equal(backendUrl("http://api/v1", ["workers"], "?"), "http://api/v1/admin/workers");
  });
});

describe("isSameOrigin (CSRF defence for state-changing requests)", () => {
  it("accepts only the site's own origin", () => {
    assert.equal(isSameOrigin("http://localhost:3000", "localhost:3000"), true);
    assert.equal(isSameOrigin("https://admin.example.com", "admin.example.com"), true);
    assert.equal(isSameOrigin("https://evil.example", "admin.example.com"), false);
    assert.equal(isSameOrigin("http://localhost:3000.evil.example", "localhost:3000"), false);
    assert.equal(isSameOrigin(null, "localhost:3000"), false);
    assert.equal(isSameOrigin("http://localhost:3000", null), false);
    assert.equal(isSameOrigin("not a url", "localhost:3000"), false);
  });
});

describe("cookieLifetimes", () => {
  it("expires the access cookie before the token, so a missing cookie means refresh first", () => {
    const now = new Date("2026-11-01T10:00:00Z");
    const t = { accessToken: "a", refreshToken: "r", accessExpiresIn: 900, refreshExpiresAt: new Date("2026-11-02T10:00:00Z") };
    assert.deepEqual(cookieLifetimes(t, now), { accessMaxAge: 870, refreshMaxAge: 86400 });
    assert.equal(cookieLifetimes({ ...t, accessExpiresIn: 10 }, now).accessMaxAge, 1);
    assert.equal(cookieLifetimes({ ...t, refreshExpiresAt: new Date("2026-11-01T09:00:00Z") }, now).refreshMaxAge, 1);
  });
});

describe("SingleFlight: one refresh per single-use refresh token", () => {
  it("shares one call between concurrent callers", async () => {
    const flight = new SingleFlight(50);
    let calls = 0;
    const work = async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 10));
      return "tokens-2";
    };
    const results = await Promise.all([flight.run("old", work), flight.run("old", work), flight.run("old", work)]);
    assert.deepEqual(results, ["tokens-2", "tokens-2", "tokens-2"]);
    assert.equal(calls, 1);
  });
  it("keeps the result briefly for late callers still holding the old token, then forgets it", async () => {
    const flight = new SingleFlight(30);
    let calls = 0;
    const work = async () => ++calls;
    assert.equal(await flight.run("old", work), 1);
    assert.equal(await flight.run("old", work), 1, "a late request with the stale cookie must not trigger a second (reuse) refresh");
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(flight.size, 0);
    assert.equal(await flight.run("old", work), 2);
  });
  it("different tokens do not share, and a failure is not remembered", async () => {
    const flight = new SingleFlight(1000);
    assert.equal(await flight.run("a", async () => 1), 1);
    assert.equal(await flight.run("b", async () => 2), 2);
    let attempts = 0;
    await assert.rejects(flight.run("c", async () => { attempts++; throw new Error("boom"); }));
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(await flight.run("c", async () => { attempts++; return "ok"; }), "ok");
    assert.equal(attempts, 2);
  });
});

describe("passthroughHeaders", () => {
  it("passes only the headers the browser needs", () => {
    const h = new Headers({ "content-type": "application/json", "retry-after": "30", "set-cookie": "x=1", authorization: "Bearer secret", "x-request-id": "r1", server: "nginx" });
    assert.deepEqual(passthroughHeaders(h), { "content-type": "application/json", "retry-after": "30", "x-request-id": "r1" });
  });
});
