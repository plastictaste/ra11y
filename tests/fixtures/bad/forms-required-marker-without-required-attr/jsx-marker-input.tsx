// JSX shape of the failure. Sighted users see the red asterisk; the
// underlying <input> sets neither `required` nor `aria-required="true"`,
// so screen-reader users get no programmatic signal that the field is
// required.
export function ContactForm() {
  return (
    <form>
      <label htmlFor="email">
        Email <span className="text-danger">*</span>
      </label>
      <input id="email" type="email" className="form-control" />
    </form>
  );
}
