// Repeated single word — "image image" carries no more information
// than "image" does.
export function Gallery() {
  return <img src="/hero.png" alt="image image" />;
}
