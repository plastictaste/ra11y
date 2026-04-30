// Sanitized from jekyll/lib/jekyll/commands/serve/livereload_assets/livereload.js
// (single-line minified distribution). The canonical failure token from the upstream
// scan is `Unclosed JSX element <r.length>` — the TSX parser treats `r.length<b.length`
// as a JSX open-tag because the `<` character that separates a variable identifier
// from the `<` comparison operator is also the first character of a JSX element open.
//
// The pattern below preserves the shape (single-line, length comparisons, short
// identifiers, immediately-invoked function expression) without shipping any
// upstream semantics. If the TSX parser stops promoting `<identifier` to a JSX tag
// in non-JSX contexts (bare .js files without JSX imports), this file parses as
// clean JavaScript.
// biome-ignore format: intentional single-line minified shape
!function(r,b){var x=r.length<b.length?r.length:b.length;for(var i=0;i<x;i+=1){if(r[i]<b[i])return -1;if(r[i]>b[i])return 1}return 0}([1,2],[1,2,3]);
