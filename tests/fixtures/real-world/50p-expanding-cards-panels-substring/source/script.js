// Sanitized from 50projects50days/01-expanding-cards/script.js.
// The identifier `panels` contains the substring "pan" but is NOT a
// pan-gesture reference — it's a DOM collection named after the CSS
// class `.panel`. There is no `touchstart`/`touchmove`/`pointermove`
// event listener in this file, and no pointer-event library is
// imported — no companion evidence of gesture-driven interaction
// exists. The review/pointer-input finder must not surface 2.5.1 /
// 2.5.6 candidates from identifier-substring matches alone.

const panels = document.querySelectorAll(".panel");

panels.forEach((panel) => {
  panel.addEventListener("click", () => {
    removeActiveClasses();
    panel.classList.add("active");
  });
});

function removeActiveClasses() {
  panels.forEach((panel) => {
    panel.classList.remove("active");
  });
}
