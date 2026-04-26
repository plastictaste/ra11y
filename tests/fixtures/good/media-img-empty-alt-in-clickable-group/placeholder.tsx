// Good: the wrapping <a href> has a sibling visible-text label, so the
// empty alt on the decorative icon is correct — the link's accessible
// name is "View profile". media/img-empty-alt-in-clickable-group does
// not fire here.

export function ProfileLink() {
  return (
    <a href="/profile">
      <img src="/avatar.png" alt="" />
      View profile
    </a>
  );
}
