import { describe, expect, test } from "bun:test";
import { insertIntoRegistry } from "../../../scripts/scaffold-rule.ts";

const minimalRegistry = `import type { Rule } from "../types/rule.ts";
import { rule as conflictingRole } from "./aria/conflicting-role.ts";
import { rule as hiddenFocus } from "./aria/hidden-focus.ts";
import { rule as contrastMinimum } from "./contrast/minimum.ts";
import { rule as pageTitled } from "./document/page-titled.ts";

export const BUILTIN_RULES: readonly Rule[] = [
  conflictingRole,
  contrastMinimum,
  hiddenFocus,
  pageTitled,
];

export {
  conflictingRole,
  contrastMinimum,
  hiddenFocus,
  pageTitled,
};
`;

describe("insertIntoRegistry — import clustering", () => {
  test("inserts a new aria import alphabetically within the aria cluster", () => {
    const out = insertIntoRegistry(
      minimalRegistry,
      "iconFontHidden",
      `import { rule as iconFontHidden } from "./aria/icon-font-hidden.ts";`,
    );
    const lines = out.split("\n");
    const ariaHidden = lines.indexOf(
      `import { rule as hiddenFocus } from "./aria/hidden-focus.ts";`,
    );
    const ariaIcon = lines.indexOf(
      `import { rule as iconFontHidden } from "./aria/icon-font-hidden.ts";`,
    );
    const contrastMin = lines.indexOf(
      `import { rule as contrastMinimum } from "./contrast/minimum.ts";`,
    );
    expect(ariaHidden).toBeGreaterThan(-1);
    expect(ariaIcon).toBe(ariaHidden + 1);
    expect(ariaIcon).toBeLessThan(contrastMin);
  });

  test("inserts a new navigation import in a fresh cluster after document/", () => {
    const out = insertIntoRegistry(
      minimalRegistry,
      "skipLink",
      `import { rule as skipLink } from "./navigation/skip-link.ts";`,
    );
    const lines = out.split("\n");
    const pageTitled = lines.indexOf(
      `import { rule as pageTitled } from "./document/page-titled.ts";`,
    );
    const skipLink = lines.indexOf(`import { rule as skipLink } from "./navigation/skip-link.ts";`);
    expect(pageTitled).toBeGreaterThan(-1);
    expect(skipLink).toBe(pageTitled + 1);
  });

  test("does not tail-append when the new import slots before an existing aria entry", () => {
    const out = insertIntoRegistry(
      minimalRegistry,
      "autocompleteMissing",
      `import { rule as autocompleteMissing } from "./aria/autocomplete-missing.ts";`,
    );
    const lines = out.split("\n");
    const first = lines.indexOf(
      `import { rule as autocompleteMissing } from "./aria/autocomplete-missing.ts";`,
    );
    const conflicting = lines.indexOf(
      `import { rule as conflictingRole } from "./aria/conflicting-role.ts";`,
    );
    expect(first).toBeGreaterThan(-1);
    expect(first).toBeLessThan(conflicting);
  });

  test("inserts at the end when the new path sorts after every existing path", () => {
    const out = insertIntoRegistry(
      minimalRegistry,
      "wrapperDrift",
      `import { rule as wrapperDrift } from "./wrapper/drift.ts";`,
    );
    const lines = out.split("\n");
    const pageTitled = lines.indexOf(
      `import { rule as pageTitled } from "./document/page-titled.ts";`,
    );
    const wrapperDrift = lines.indexOf(
      `import { rule as wrapperDrift } from "./wrapper/drift.ts";`,
    );
    expect(wrapperDrift).toBeGreaterThan(pageTitled);
  });
});

describe("insertIntoRegistry — BUILTIN_RULES + exports keep identifier sort", () => {
  test("BUILTIN_RULES array keeps local-name alphabetical order after insertion", () => {
    const out = insertIntoRegistry(
      minimalRegistry,
      "iconFontHidden",
      `import { rule as iconFontHidden } from "./aria/icon-font-hidden.ts";`,
    );
    const arrayMatch = /BUILTIN_RULES: readonly Rule\[\] = \[([\s\S]*?)\];/.exec(out);
    expect(arrayMatch).not.toBeNull();
    const names = (arrayMatch?.[1] ?? "")
      .split("\n")
      .map((l) => l.trim().replace(/,$/, ""))
      .filter((l) => l.length > 0);
    expect(names).toEqual([
      "conflictingRole",
      "contrastMinimum",
      "hiddenFocus",
      "iconFontHidden",
      "pageTitled",
    ]);
  });

  test("named export block keeps local-name alphabetical order after insertion", () => {
    const out = insertIntoRegistry(
      minimalRegistry,
      "autocompleteMissing",
      `import { rule as autocompleteMissing } from "./aria/autocomplete-missing.ts";`,
    );
    const exportMatch = /export \{([\s\S]*?)\};/.exec(out);
    expect(exportMatch).not.toBeNull();
    const names = (exportMatch?.[1] ?? "")
      .split("\n")
      .map((l) => l.trim().replace(/,$/, ""))
      .filter((l) => l.length > 0);
    expect(names).toEqual([
      "autocompleteMissing",
      "conflictingRole",
      "contrastMinimum",
      "hiddenFocus",
      "pageTitled",
    ]);
  });
});
