// Minimal reproducer for aria/live-region-missing-on-innerhtml-target.
// Pairs with index.html in this directory.
//
// `setInterval` is the recurring scheduler; the body assigns to
// `.innerHTML` on `document.getElementById('clock')`. The rule pairs the
// JS site with the HTML host element by ID and emits a finding at the
// HTML element's location.
setInterval(() => {
  document.getElementById("clock").innerHTML = new Date().toLocaleTimeString();
}, 1000);
