/**
 * Auto-playing carousel/slider detection helpers for the
 * `motion/pause-stop-hide` rule (WCAG 2.2.2).
 *
 * The matched markers are exclusively *documented* auto-init signals
 * published by the upstream plugin/framework — generic class names like
 * `.slider` or `.carousel` are NOT matched. Per the AI-first doctrine
 * ("Heuristic-mislabeled meta sub-fields are dishonest" /
 * "Don't duplicate capability the agent already has"), the signal must
 * be provable from the code: an attribute or class the plugin's bundled
 * JS literally scans for to start its auto-advance timer.
 *
 * Supported markers:
 *   - Bootstrap 5: `data-bs-ride="carousel"` or `="true"`.
 *   - Bootstrap 4 (legacy): `data-ride="carousel"` or `="true"`.
 *   - jQuery FlexSlider: `class="… flexslider …"`.
 *   - Camera slideshow: `class="… camera_wrap …"`.
 *   - Slicebox / sl-slider: `class="… sl-slider-wrapper …"`.
 *
 * Class matching is whole-token (`split(/\s+/)`); substring containment
 * (`myflexslider2`) does not match.
 */

import { getHtmlAttribute } from "../../engine/ast-helpers.ts";
import type { HtmlElement } from "../../types/ast.ts";

export interface AutoplaySignal {
  /** Short token naming the matched marker, embedded into the message. */
  readonly marker: string;
  /** Plain-English source of the signal (e.g. "Bootstrap 5 data-bs-ride attribute"). */
  readonly origin: string;
  /** Documented default cycle, included so the agent sees the stake. */
  readonly defaultCycle: string;
}

interface SliderClassMatch {
  readonly token: string;
  readonly origin: string;
  readonly defaultCycle: string;
}

const AUTOPLAY_SLIDER_CLASSES: ReadonlyMap<string, Omit<SliderClassMatch, "token">> = new Map([
  [
    "flexslider",
    {
      origin: "jQuery FlexSlider plugin auto-init class",
      defaultCycle: "7 seconds",
    },
  ],
  [
    "camera_wrap",
    {
      origin: "Camera slideshow plugin auto-init class",
      defaultCycle: "7 seconds",
    },
  ],
  [
    "sl-slider-wrapper",
    {
      origin: "Slicebox / sl-slider plugin auto-init class",
      defaultCycle: "auto-cycle",
    },
  ],
]);

/**
 * Returns the highest-precedence auto-play signal carried by `element`,
 * or `null` when none of the documented markers match. Precedence order
 * (most specific first): BS5 `data-bs-ride` → BS4 `data-ride` →
 * documented JS-init slider class. A single element with multiple
 * markers emits one finding under the highest-precedence signal so the
 * agent's reason text isn't duplicated.
 */
export function detectAutoplaySignal(element: HtmlElement): AutoplaySignal | null {
  const bs5 = matchRideAttribute(element, "data-bs-ride", "Bootstrap 5 data-bs-ride attribute");
  if (bs5 !== null) return bs5;
  const bs4 = matchRideAttribute(element, "data-ride", "Bootstrap 4 (legacy) data-ride attribute");
  if (bs4 !== null) return bs4;
  const sliderClass = matchAutoplaySliderClass(element);
  if (sliderClass !== null) {
    return {
      marker: `class="…${sliderClass.token}…"`,
      origin: sliderClass.origin,
      defaultCycle: sliderClass.defaultCycle,
    };
  }
  return null;
}

function matchRideAttribute(
  element: HtmlElement,
  attr: string,
  origin: string,
): AutoplaySignal | null {
  const value = getHtmlAttribute(element, attr);
  if (value === null) return null;
  const v = value.trim().toLowerCase();
  if (v !== "carousel" && v !== "true") return null;
  return { marker: `${attr}="${v}"`, origin, defaultCycle: "5 seconds" };
}

function matchAutoplaySliderClass(element: HtmlElement): SliderClassMatch | null {
  const klass = getHtmlAttribute(element, "class");
  if (klass === null) return null;
  for (const token of klass.split(/\s+/)) {
    const meta = AUTOPLAY_SLIDER_CLASSES.get(token);
    if (meta) return { token, origin: meta.origin, defaultCycle: meta.defaultCycle };
  }
  return null;
}
