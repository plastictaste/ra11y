// Sanitized from 50projects50days/image-carousel/script.js — the
// canonical carousel shape: setInterval drives style/class mutations on
// the visible slides, no pause control rendered. The finder must
// escalate this to WCAG 2.2.2 (Pause, Stop, Hide).
const img = document.getElementById("slide");
let index = 0;

function run() {
  index++;
  if (index > 3) index = 0;
  img.style.transform = `translateX(${-index * 500}px)`;
}

setInterval(run, 2000);
