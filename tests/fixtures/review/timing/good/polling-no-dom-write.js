// setInterval that polls a remote endpoint without touching the DOM.
// Static analysis cannot see a DOM write, so the finder should NOT
// escalate to 2.2.2 — the base 2.2.1 candidate remains, and the agent
// reads the file to judge whether the fetch's result eventually
// reaches the DOM.
async function poll() {
  const res = await fetch("/status");
  return res.json();
}

setInterval(poll, 30_000);
