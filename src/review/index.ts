/**
 * Built-in candidate finders barrel. Every finder ra11y ships for
 * assisted manual review is registered here.
 */

import type { CandidateFinder } from "../types/review.ts";
import { finder as captcha } from "./finders/captcha.ts";
import { finder as carouselPattern } from "./finders/carousel-pattern.ts";
import { finder as consistentIdentification } from "./finders/consistent-identification.ts";
import { finder as consistentNavigation } from "./finders/consistent-navigation.ts";
import { finder as decorativeImgWithAdjacentMeaning } from "./finders/decorative-img-with-adjacent-meaning.ts";
import { finder as errorIdentification } from "./finders/error-identification.ts";
import { finder as errorPrevention } from "./finders/error-prevention.ts";
import { finder as errorSuggestion } from "./finders/error-suggestion.ts";
import { finder as flashingContent } from "./finders/flashing-content.ts";
import { finder as focusOrder } from "./finders/focus-order.ts";
import { finder as formRequiredAttrs } from "./finders/form-required-attrs.ts";
import { finder as headingsAndLabels } from "./finders/headings-and-labels.ts";
import { finder as identifyPurpose } from "./finders/identify-purpose.ts";
import { finder as imagesOfText } from "./finders/images-of-text.ts";
import { finder as liveRegionPreExistence } from "./finders/live-region-pre-existence.ts";
import { finder as liveRegionRuntimeMutationMissing } from "./finders/live-region-runtime-mutation-missing.ts";
import { finder as meaningfulSequence } from "./finders/meaningful-sequence.ts";
import { finder as mediaAlternatives } from "./finders/media-alternatives.ts";
import { finder as mediaVariants } from "./finders/media-variants.ts";
import { finder as motionActuation } from "./finders/motion-actuation.ts";
import { finder as multipleWays } from "./finders/multiple-ways.ts";
import { finder as noKeyboardTrap } from "./finders/no-keyboard-trap.ts";
import { finder as onInputChange } from "./finders/on-input-change.ts";
import { finder as otpInputCluster } from "./finders/otp-input-cluster.ts";
import { finder as paginationGlyphAccessibleName } from "./finders/pagination-glyph-accessible-name.ts";
import { finder as passwordInputs } from "./finders/password-inputs.ts";
import { finder as pointerInput } from "./finders/pointer-input.ts";
import { finder as redundantEntry } from "./finders/redundant-entry.ts";
import { finder as sectionHeadings } from "./finders/section-headings.ts";
import { finder as sensoryCharacteristics } from "./finders/sensory-characteristics.ts";
import { finder as serverErrorUntied } from "./finders/server-error-untied.ts";
import { finder as suppressionNoReason } from "./finders/suppression-no-reason.ts";
import { finder as timing } from "./finders/timing.ts";
import { finder as useOfColor } from "./finders/use-of-color.ts";
import { finder as validationTiming } from "./finders/validation-timing.ts";

export const BUILTIN_CANDIDATE_FINDERS: readonly CandidateFinder[] = [
  captcha,
  carouselPattern,
  consistentIdentification,
  consistentNavigation,
  decorativeImgWithAdjacentMeaning,
  errorIdentification,
  errorPrevention,
  errorSuggestion,
  flashingContent,
  focusOrder,
  formRequiredAttrs,
  headingsAndLabels,
  identifyPurpose,
  imagesOfText,
  liveRegionPreExistence,
  liveRegionRuntimeMutationMissing,
  meaningfulSequence,
  mediaAlternatives,
  mediaVariants,
  motionActuation,
  multipleWays,
  noKeyboardTrap,
  onInputChange,
  otpInputCluster,
  paginationGlyphAccessibleName,
  passwordInputs,
  pointerInput,
  redundantEntry,
  sectionHeadings,
  sensoryCharacteristics,
  serverErrorUntied,
  suppressionNoReason,
  timing,
  useOfColor,
  validationTiming,
];
