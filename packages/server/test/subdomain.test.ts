import { describe, it, expect } from "vitest";
import { resolveSurface, isValidSubdomain } from "@smma/core";

// Pure, DB-free unit tests for the subdomain routing rules. The behavioral
// consequences — tenant scoping, and that the reserved `admin.` label now
// reaches nothing at all — are covered in tenancy.test.ts.
describe("resolveSurface", () => {
  const base = "ourapp.com";

  it("maps the reserved admin label to the admin surface", () => {
    expect(resolveSurface("admin.ourapp.com", base)).toEqual({ kind: "admin" });
  });

  it("maps a single-label subdomain to that Client", () => {
    expect(resolveSurface("acme.ourapp.com", base)).toEqual({
      kind: "client",
      subdomain: "acme",
    });
  });

  it("ignores the port and is case-insensitive", () => {
    expect(resolveSurface("Acme.OurApp.com:5173", base)).toEqual({
      kind: "client",
      subdomain: "acme",
    });
  });

  it("treats the apex, foreign hosts, and nested labels as unknown", () => {
    expect(resolveSurface("ourapp.com", base)).toEqual({ kind: "unknown" });
    expect(resolveSurface("evil.com", base)).toEqual({ kind: "unknown" });
    expect(resolveSurface("a.b.ourapp.com", base)).toEqual({ kind: "unknown" });
    expect(resolveSurface(undefined, base)).toEqual({ kind: "unknown" });
  });
});

describe("isValidSubdomain", () => {
  it("accepts plain DNS labels", () => {
    expect(isValidSubdomain("acme")).toBe(true);
    expect(isValidSubdomain("acme-co-2")).toBe(true);
  });

  it("rejects the reserved admin label and malformed labels", () => {
    expect(isValidSubdomain("admin")).toBe(false);
    expect(isValidSubdomain("-acme")).toBe(false);
    expect(isValidSubdomain("acme-")).toBe(false);
    expect(isValidSubdomain("ACME")).toBe(false);
    expect(isValidSubdomain("a.b")).toBe(false);
    expect(isValidSubdomain("")).toBe(false);
  });
});
