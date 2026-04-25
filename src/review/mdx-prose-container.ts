/**
 * MDX prose-container ancestor detection.
 *
 * MDX docs sites embed JSX components like `<Callout>`, `<Note>`,
 * `<Warning>`, `<Tip>`, `<Info>`, `<Caution>`, `<Important>`,
 * `<Example>` to wrap explanatory prose. Authors routinely write
 * inline tag-name examples inside these containers without
 * surrounding them in backticks — `<Callout>Use the <iframe>
 * element to embed</Callout>` — and the in-house TSX parser
 * (which MDX delegates to) parses the bare `<iframe>` as a real
 * JSX element child.
 *
 * Downstream review finders (`review/media-alternatives`,
 * `review/media-variants`) walk for `<video>` / `<audio>` / `<iframe>`
 * elements with no awareness of whether they sit inside a prose
 * container. The candidate they emit has reason text claiming the
 * element exists; the agent reading the source sees a code-mention,
 * not a rendered element. The dismissal is one read but the framing
 * is dishonest.
 *
 * Per the AI-first consumer doctrine
 * (`docs/kb/architecture/ai-first-consumer.md`):
 *
 *   > When a field report suggests "reduce noise," ask first: noise
 *   > for whom? […] Enrich the `reason` text with the dismissal
 *   > signal; keep the candidate in the primary list.
 *
 * The candidate stays. The reason names the prose-container
 * ancestor and frames the dismissal: "may be inside backticks/code;
 * verify the element actually renders." An agent reads the file
 * once and either dismisses (it was prose) or files a finding (it
 * was a real embed inside a styled box).
 *
 * This helper is independent of the finder — both `media-variants`
 * and `media-alternatives` consume it, and any future finder that
 * walks tag-named elements can opt in by importing
 * {@link findProseContainerAncestor}.
 *
 * Container set rationale: the names are component conventions
 * shared across Starlight, Docusaurus, Nextra, Astro Starlight, and
 * the bootstrap-docs MDX flavor. The set is closed (small, named) —
 * heuristic patterns like "any component whose body is JSX text"
 * would over-trigger on layout components that DO render their
 * children as DOM. The component-name predicate is provable from
 * the AST (the JSX opening tag carries the name verbatim) so the
 * enrichment label clears the doctrine bar for "labeled fields"
 * (must be deterministic, not heuristic).
 */

import type { JsxElement, JsxNode, TsxModule } from "../types/ast.ts";

/**
 * Documented prose-container component names. Authors write code
 * mentions inside these as styled prose; the children are typically
 * rendered as decorated text rather than passed-through DOM.
 *
 * The set is intentionally closed — see file header for rationale.
 * Names are case-sensitive (matches the React component-name
 * convention preserved by the TSX parser): `Callout` is a prose
 * container; `callout` is a custom HTML element with no such
 * convention.
 */
export const PROSE_CONTAINER_NAMES: ReadonlySet<string> = new Set([
  "Callout",
  "Note",
  "Warning",
  "Tip",
  "Info",
  "Caution",
  "Important",
  "Example",
]);

/**
 * Returns the nearest prose-container ancestor's component name,
 * or `null` when `target` is not nested inside any container in
 * {@link PROSE_CONTAINER_NAMES}.
 *
 * Walks the JSX tree from the module root looking for `target` by
 * reference identity. The walk records the ancestor chain as it
 * descends; on hit, the chain is scanned outermost-to-innermost for
 * the first prose-container name. Ancestor-chain order means the
 * outermost matching container wins — `<Callout><Note>...<iframe/>`
 * reports `Callout`, which is the user-visible framing the agent
 * reads first.
 *
 * Pure: no I/O, no global state, no mutation of inputs. Safe to
 * call from any finder's `find` callback.
 */
export function findProseContainerAncestor(target: JsxElement, root: TsxModule): string | null {
  const ancestors: JsxElement[] = [];
  if (!locateInList(root.jsxElements, target, ancestors)) return null;
  // Outermost-first: the user's framing component wins over inner
  // wrappers (`<Callout><Note><iframe/></Note></Callout>` reports
  // "Callout"). Iterate ancestors in declaration order and return
  // the first prose-container name seen.
  for (const a of ancestors) {
    if (PROSE_CONTAINER_NAMES.has(a.tagName)) return a.tagName;
  }
  return null;
}

/**
 * Builds the reason-suffix appended to a finder's reason text when
 * its candidate sits inside a prose container. Centralizing the
 * phrasing keeps `media-variants` and `media-alternatives` (and any
 * future iframe/media finder) emitting the same enriched framing
 * the agent learns to recognize.
 *
 * The phrasing names the container component verbatim so the agent
 * can grep for it in the file with one read; it also names the
 * "code-span backticks" failure mode the MDX inline-code-span pass
 * does NOT catch (prose without backticks parses as real JSX).
 */
export function proseContainerReasonSuffix(containerName: string): string {
  return ` (token is inside an MDX <${containerName}> prose block — may be in code-span backticks; verify the element actually renders)`;
}

// ---------------------------------------------------------------------------
// Internal traversal
// ---------------------------------------------------------------------------

/**
 * Depth-first search for `target` by reference identity through a
 * list of JSX elements. Pushes ancestors onto `chain` as it descends
 * and pops on backtrack so the caller's array is left in a valid
 * state regardless of hit/miss. Returns `true` on hit; `chain` then
 * holds the path from the outermost element to `target`'s parent
 * (`target` itself is excluded — the caller already has it).
 *
 * Reference equality is the right comparator here: the finder hands
 * us the exact `JsxElement` it walked over; we just need to find
 * its position in the tree to read the ancestors.
 */
function locateInList(
  elements: readonly JsxElement[],
  target: JsxElement,
  chain: JsxElement[],
): boolean {
  for (const el of elements) {
    if (el === target) return true;
    chain.push(el);
    if (locateInChildren(el.children, target, chain)) return true;
    chain.pop();
  }
  return false;
}

function locateInChildren(
  children: readonly JsxNode[],
  target: JsxElement,
  chain: JsxElement[],
): boolean {
  for (const child of children) {
    if (child.kind !== "JsxElement") continue;
    if (child === target) return true;
    chain.push(child);
    if (locateInChildren(child.children, target, chain)) return true;
    chain.pop();
  }
  return false;
}
