// Dynamic JSX id — opaque to static analysis. The agent reads the
// binding to confirm the runtime value is well-formed.
export function Page({ slug }: { slug: string }) {
  return (
    <section id={slug}>
      <h1>Welcome</h1>
    </section>
  );
}
