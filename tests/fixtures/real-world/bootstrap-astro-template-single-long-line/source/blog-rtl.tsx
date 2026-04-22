/*
 * Sanitized snippet of an Astro/Starlight `examples/<page>/index.astro`
 * shape from the Bootstrap docs site, transposed to `.tsx` so the
 * fixture harness's parser handles it (the harness's
 * `parseForExtension` does not register `.astro`). What the fixture
 * preserves is the file shape that triggers the false build-artifact
 * label, not the Astro syntax itself: many short authored lines plus
 * exactly ONE line whose length crosses 500 characters because a JSX
 * prop value carries a multi-clause HTML string concatenation on one
 * source line.
 *
 * The true upstream is `site/src/assets/examples/blog-rtl/index.astro`
 * (Bootstrap docs build), 255 lines tall, where the `code={`…`}`
 * template-literal prop holds a multi-tag preview HTML on a single
 * authored line. The classifier currently sees that one long line and
 * labels the whole file `minified` — wrong, since the surrounding 254
 * lines are normal authored code.
 */

import { Example } from "../components/Example";

export const layout = "../layouts/BlogPostLayout.astro";
export const title = "Bidirectional blog template preview";
export const description = "Preview of a right-to-left blog layout demonstrating typographic mirroring.";

export function BlogRtlPreview() {
  // The `code` prop intentionally lives on ONE authored line so the
  // file reproduces the single-long-line minified false-positive. The
  // surrounding component is normal multi-line authored TSX so the
  // line-ratio + median-line-length corroborators stay well below
  // their thresholds (1 long line out of ~30 total ≈ 3%).
  const previewMarkup = "<article class=\"blog-post\" dir=\"rtl\" lang=\"ar\"><header class=\"post-header\"><h1 class=\"post-title\">عنوان المقال التجريبي للعرض</h1><p class=\"post-byline\">كتبه فريق التحرير في الثاني من نيسان</p></header><section class=\"post-body\"><p>هذه فقرة تمهيدية تعرض اتجاه القراءة من اليمين إلى اليسار وتثبت أن المحرف العربي يتدفق بشكل سليم.</p><p>الفقرة الثانية مخصصة لاختبار التشكيل والمسافات بين السطور وعلامات الترقيم.</p></section><footer class=\"post-footer\"><nav aria-label=\"Article actions\"><a href=\"#share\">Share</a><a href=\"#print\">Print</a></nav></footer></article>";

  return (
    <main className="example-frame">
      <header>
        <h2>{title}</h2>
        <p>{description}</p>
      </header>
      <Example code={previewMarkup} lang="html" />
      <footer>
        <p>Preview generated for the bidirectional blog template.</p>
      </footer>
    </main>
  );
}

export default BlogRtlPreview;
