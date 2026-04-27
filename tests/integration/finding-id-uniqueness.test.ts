/**
 * Cross-rule invariant: every Violation in a single ScanResult carries a
 * `findingId` that is unique across the response.
 *
 * `findingId` is documented as the agent's primary key for dedupe and
 * suppress flows (see `src/utils/finding-id.ts`). When two structurally
 * distinct emissions land in the same response under the same id, the
 * agent silently merges them: a "fix progress" check via id-equality
 * loses N-1 findings, and a `suggest_fix` retry against the surviving
 * id shows up as "already addressed" even though the other N-1 bodies
 * were never touched. The miss is non-reversible because the duplicates
 * never reached the agent's view.
 *
 * Per AI-first doctrine (`docs/kb/architecture/ai-first-consumer.md`,
 * "Ambiguous field shapes are dishonest"), id-collision is the
 * worst-case ambiguity — two distinct entries claim the same identity.
 *
 * The collision-by-design contract documented on `computeFindingId`
 * (two findings of the same rule on byte-identical line text collapse
 * to one id) is honest only when the rule itself collapses the
 * emissions into ONE entry carrying `siblingInstances` (the
 * `forms/labels-required` precedent in `_label-sibling-collapse.ts`).
 * A rule that emits N entries while letting the engine stamp them all
 * with the same id has dishonest output.
 */

import { describe, expect, it } from "bun:test";
import { type ParsedFile, runScan } from "../../src/engine/scanner.ts";
import { parseHtml, parseTsx } from "../../src/input/parsers/index.ts";
import { BUILTIN_RULES } from "../../src/rules/index.ts";
import { wcag22 } from "../../src/standards/wcag22/standard.ts";
import type { Ast } from "../../src/types/ast.ts";

function htmlFile(filePath: string, source: string): ParsedFile {
  const r = parseHtml(source);
  const ast: Ast = { language: "html", root: r.root, errors: r.errors };
  return { filePath, source, ast };
}

function tsxFile(filePath: string, source: string): ParsedFile {
  const r = parseTsx(source, { filePath });
  const ast: Ast = { language: "tsx", root: r.root, errors: r.errors };
  return { filePath, source, ast };
}

/**
 * Diagnostic helper — when uniqueness fails, surface the colliding
 * (ruleId, findingId, location) trail so the failure message names the
 * exact rule and the specific lines that collapsed under one id.
 */
function describeCollisions(
  violations: ReadonlyArray<{
    readonly ruleId: string;
    readonly findingId: string;
    readonly location: { readonly filePath: string; readonly line: number };
  }>,
): string {
  const byId = new Map<string, typeof violations>();
  for (const v of violations) {
    const list = byId.get(v.findingId);
    if (list === undefined) byId.set(v.findingId, [v]);
    // biome-ignore lint/suspicious/noExplicitAny: building a transient diagnostic list
    else (list as any).push(v);
  }
  const colliding: string[] = [];
  for (const [id, members] of byId) {
    if (members.length < 2) continue;
    const trail = members
      .map((m) => `${m.ruleId}@${m.location.filePath}:${m.location.line}`)
      .join(", ");
    colliding.push(`  - findingId=${id} → ${members.length} entries: [${trail}]`);
  }
  return colliding.join("\n");
}

describe("Violation.findingId — cross-rule uniqueness invariant on a single scan", () => {
  it("placeholder-as-label cluster: 6 visually-grouped sibling inputs share one id only when collapsed", () => {
    // Repro: a sign-up form with six near-identical inputs each
    // carrying `placeholder="Email"` and no label. The lines are
    // byte-identical except for surrounding whitespace, so the
    // line-text-keyed `findingId` recipe collapses all six to one
    // hash. Per the collision-by-design contract, the honest shape
    // is ONE finding with `siblingInstances: [...]` — not six
    // separate entries that share an id and silently dedupe at the
    // agent's primary-key boundary.
    const source = `<!doctype html><html><body><form>
      <input type="email" placeholder="Email">
      <input type="email" placeholder="Email">
      <input type="email" placeholder="Email">
      <input type="email" placeholder="Email">
      <input type="email" placeholder="Email">
      <input type="email" placeholder="Email">
    </form></body></html>`;
    const { result } = runScan({
      standards: [wcag22],
      rules: BUILTIN_RULES,
      enabled: ["wcag22"],
      files: [htmlFile("signup.html", source)],
    });

    const placeholder = result.violations.filter((v) => v.ruleId === "forms/placeholder-as-label");
    // Surface-don't-suppress: the cluster must still be visible — the
    // collapsed shape carries `siblingInstances` so all six lines are
    // enumerable from one finding.
    expect(placeholder.length).toBeGreaterThan(0);
    const ids = placeholder.map((v) => v.findingId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("scan-wide invariant: no two emissions across BUILTIN_RULES share a findingId on placeholder + OTP-cluster shapes", () => {
    // Two file shapes that previously each landed N entries under one
    // findingId: an HTML placeholder cluster (the named bug) and a JSX
    // placeholder cluster (the same shape, JSX path). The OTP fixture
    // exercises the existing `forms/labels-required` collapse so the
    // asserted invariant has at least one rule-pair contributing
    // distinct ids — guards against a future regression that would
    // accidentally re-collapse two rules' findings into one bucket.
    //
    // Inputs are kept off the `forms/autocomplete-missing` purpose-
    // inference path (no `type="email"` / `name="email"` cluster) so
    // the assertion fails if and only if the placeholder rule
    // regresses on its own collapse contract — out-of-scope rules
    // with their own collision history (autocomplete-missing on
    // identical type=email siblings) are not the lever this test
    // pulls.
    const files: ParsedFile[] = [
      htmlFile(
        "signup.html",
        `<!doctype html><html><body><form>
          <input type="text" placeholder="First name">
          <input type="text" placeholder="First name">
          <input type="text" placeholder="First name">
          <input type="text" placeholder="First name">
        </form></body></html>`,
      ),
      htmlFile(
        "otp.html",
        `<!doctype html><html><body><form>
          <input class="otp" type="number" maxlength="1" id="d1">
          <input class="otp" type="number" maxlength="1" id="d2">
          <input class="otp" type="number" maxlength="1" id="d3">
          <input class="otp" type="number" maxlength="1" id="d4">
        </form></body></html>`,
      ),
      tsxFile(
        "Form.tsx",
        `export default function Form() {
          return (
            <form>
              <input type="text" placeholder="Given name" />
              <input type="text" placeholder="Given name" />
              <input type="text" placeholder="Given name" />
            </form>
          );
        }`,
      ),
    ];
    const { result } = runScan({
      standards: [wcag22],
      rules: BUILTIN_RULES,
      enabled: ["wcag22"],
      files,
    });

    const ids = result.violations.map((v) => v.findingId);
    const unique = new Set(ids);
    if (unique.size !== ids.length) {
      throw new Error(
        `Expected every Violation to carry a unique findingId across the response, ` +
          `got ${ids.length} entries collapsing to ${unique.size} ids. Colliding trails:\n` +
          describeCollisions(result.violations),
      );
    }
    // Belt-and-braces: violations did happen — the assertion above
    // would also pass on an empty list.
    expect(result.violations.length).toBeGreaterThan(0);
  });
});
