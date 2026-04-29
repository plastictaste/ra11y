// Compliant fixture for aria/live-region-missing-on-innerhtml-target.
// Identical JS to the failing fixture — the only difference is the HTML
// host carries `aria-live="polite"`.
setInterval(() => {
  document.getElementById("clock").innerHTML = new Date().toLocaleTimeString();
}, 1000);
