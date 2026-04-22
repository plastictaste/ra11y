// setTimeout (not setInterval) — a single delayed DOM write is not
// "auto-updating information" under 2.2.2. The timing finder still
// surfaces the 2.2.1 candidate (any timer may govern a user-facing
// limit) but must NOT escalate to Pause, Stop, Hide.
setTimeout(() => {
  document.getElementById("notice").classList.add("visible");
}, 500);
