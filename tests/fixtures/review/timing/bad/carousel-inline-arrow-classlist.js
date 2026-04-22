// Alternative carousel shape: inline arrow callback, classList toggle
// on the active slide. Still auto-advancing, still needs a 2.2.2 pause
// control.
const slides = document.querySelectorAll(".slide");
let active = 0;

setInterval(() => {
  slides[active].classList.remove("active");
  active = (active + 1) % slides.length;
  slides[active].classList.add("active");
}, 3000);
