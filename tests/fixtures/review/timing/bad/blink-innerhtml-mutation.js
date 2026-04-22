// Periodic innerHTML mutation — any repeated DOM rewrite on an interval
// triggers the Pause/Stop/Hide question.
const target = document.getElementById("counter");
let n = 0;

setInterval(function tick() {
  n++;
  target.innerHTML = `Count: ${n}`;
}, 1000);
