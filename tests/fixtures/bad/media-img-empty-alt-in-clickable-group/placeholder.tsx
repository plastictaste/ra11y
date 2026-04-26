// Bad: an icon-only <a href> wraps an <img alt=""> with no other
// accessible-name source — the link is announced as "link" with no
// payload. media/img-empty-alt-in-clickable-group fires here.

export function ProfileLink() {
  return (
    <a href="/profile">
      <img src="/avatar.png" alt="" />
    </a>
  );
}
