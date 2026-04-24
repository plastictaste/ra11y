/**
 * Unit tests for the review/error-prevention finder (wcag22:3.3.4).
 */

import { describe, expect, it } from "bun:test";
import { finder } from "../../../src/review/finders/error-prevention.ts";
import { runFinder } from "../../helpers/run-finder.ts";

describe("review/error-prevention", () => {
  it("flags an HTML checkout form with no confirmation signal", () => {
    const source = `<form id="checkout"><input name="cc" /><button type="submit">Pay</button></form>`;
    const out = runFinder(finder, source, { filePath: "input.html" });
    expect(out.length).toBeGreaterThan(0);
  });

  it("flags a JSX payment form with no confirmation signal", () => {
    const source = `const x = <form className="payment-form"><button type="submit">Submit</button></form>;`;
    const out = runFinder(finder, source);
    expect(out.length).toBeGreaterThan(0);
  });

  it("flags a JSX form whose name references a destructive action", () => {
    const source = `const x = <form name="delete-account"><button type="submit">Delete</button></form>;`;
    const out = runFinder(finder, source);
    expect(out.length).toBeGreaterThan(0);
  });

  it("does not flag when the file has a consent checkbox", () => {
    const source = `const x = <div><form id="checkout"><input type="checkbox" name="accept-terms" /><button type="submit">Pay</button></form></div>;`;
    const out = runFinder(finder, source);
    expect(out).toEqual([]);
  });

  it("does not flag when the file has a review-style submit button", () => {
    const source = `const x = <form id="payment"><button type="submit">Review order</button></form>;`;
    const out = runFinder(finder, source);
    expect(out).toEqual([]);
  });

  it("does not flag when onSubmit invokes confirm()", () => {
    // name="checkout" is in-scope for 3.3.4; the confirm-handler branch
    // of the file-level suppression should still silence the candidate.
    const source = `const x = <form name="checkout" onSubmit={(e) => { if (!confirm('Sure?')) e.preventDefault(); }}><button type="submit">Pay</button></form>;`;
    const out = runFinder(finder, source);
    expect(out).toEqual([]);
  });

  it("does not flag a generic contact form", () => {
    const source = `const x = <form id="contact-us"><input name="message" /><button type="submit">Send</button></form>;`;
    const out = runFinder(finder, source);
    expect(out).toEqual([]);
  });

  it("does not flag a layout utility class like order-1", () => {
    const source = `const x = <form className="order-1 flex"><input name="q" /><button type="submit">Go</button></form>;`;
    const out = runFinder(finder, source);
    expect(out).toEqual([]);
  });

  it("emits candidates across all four covered standards", () => {
    const source = `const x = <form id="checkout"><button type="submit">Pay</button></form>;`;
    const out = runFinder(finder, source);
    const ids = new Set(out.map((c) => c.criterionId));
    expect(ids.has("wcag22:3.3.4")).toBe(true);
    expect(ids.has("wcag21:3.3.4")).toBe(true);
    expect(ids.has("section508:3.3.4")).toBe(true);
    expect(ids.has("en301549:9.3.3.4")).toBe(true);
  });

  // Scope gate: WCAG 3.3.4 normative scope is "legal commitments,
  // financial transactions, modify/delete user data, test responses."
  // Newsletter / subscribe / signup / signin / contact forms are
  // explicitly outside scope and must not fire — a finder that fires
  // when the criterion provably doesn't apply duplicates capability the
  // consuming agent has.

  it("does NOT flag a newsletter subscribe form (class='subscribe-form')", () => {
    const source = `<form class="form subscribe-form" action="/newsletter"><input name="email" /><button type="submit">Subscribe</button></form>`;
    const out = runFinder(finder, source, { filePath: "input.html" });
    expect(out).toEqual([]);
  });

  it("does NOT flag a bare signup form", () => {
    const source = `const x = <form id="signup" action="/signup"><input name="email" /><button type="submit">Sign up</button></form>;`;
    const out = runFinder(finder, source);
    expect(out).toEqual([]);
  });

  it("does NOT flag a signin form", () => {
    const source = `const x = <form id="signin"><input name="password" /><button type="submit">Sign in</button></form>;`;
    const out = runFinder(finder, source);
    expect(out).toEqual([]);
  });

  it("does NOT flag a form with a generic 'cancel' button name", () => {
    // Bare `cancel` used to fire via the old GENERIC_RISK_KEYWORDS set.
    // In-scope is `cancel-subscription`; a generic cancel button is not.
    const source = `const x = <form name="cancel"><button type="submit">Cancel</button></form>;`;
    const out = runFinder(finder, source);
    expect(out).toEqual([]);
  });

  it("does NOT flag a form with a generic 'delete' class (not delete-account)", () => {
    const source = `const x = <form className="delete-row-form"><button type="submit">Delete row</button></form>;`;
    const out = runFinder(finder, source);
    expect(out).toEqual([]);
  });

  it("flags a cancel-subscription form", () => {
    const source = `const x = <form id="cancel-subscription" action="/billing/cancel"><button type="submit">Cancel plan</button></form>;`;
    const out = runFinder(finder, source);
    expect(out.length).toBeGreaterThan(0);
  });

  it("flags a billing form", () => {
    const source = `const x = <form className="billing-form"><button type="submit">Update</button></form>;`;
    const out = runFinder(finder, source);
    expect(out.length).toBeGreaterThan(0);
  });

  it("flags a form whose action URL contains /checkout", () => {
    const source = `<form action="/shop/checkout/submit"><button type="submit">Pay</button></form>`;
    const out = runFinder(finder, source, { filePath: "input.html" });
    expect(out.length).toBeGreaterThan(0);
  });

  it("flags a form whose action URL contains /legal", () => {
    const source = `const x = <form action="/legal/accept"><button type="submit">Accept</button></form>;`;
    const out = runFinder(finder, source);
    expect(out.length).toBeGreaterThan(0);
  });
});
