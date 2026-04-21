// Bad: failing semantics/table-th-scope-missing scenarios — multi-row
// × multi-column tables whose <th> cells lack a scope attribute and
// are not wired up via headers=/id. Three distinct failure modes:
//   1. bare <th> header row with no scope
//   2. row-header <th> in first column of each row with no scope
//   3. partial headers= wiring (some <td>s use it, others don't) — the
//      rule does NOT accept the association as complete and still
//      flags the unscoped <th>s
// This shape is common in documentation examples that predate the
// current WCAG 1.3.1 emphasis on explicit header-cell association
// (Bootstrap's `docs/_docs/components/tables.md` ships many like this).
export function BadTables() {
  return (
    <section>
      <table>
        <thead>
          <tr>
            <th>Product</th>
            <th>Price</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Widget</td>
            <td>$50</td>
          </tr>
          <tr>
            <td>Gadget</td>
            <td>$75</td>
          </tr>
        </tbody>
      </table>

      <table>
        <thead>
          <tr>
            <th scope="col">Product</th>
            <th scope="col">Price</th>
            <th scope="col">Stock</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <th>Widget</th>
            <td>$50</td>
            <td>12</td>
          </tr>
          <tr>
            <th>Gadget</th>
            <td>$75</td>
            <td>8</td>
          </tr>
        </tbody>
      </table>

      <table>
        <thead>
          <tr>
            <th id="th-a">A</th>
            <th id="th-b">B</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td headers="th-a">1</td>
            <td headers="th-b">2</td>
          </tr>
          <tr>
            <td>3</td>
            <td>4</td>
          </tr>
        </tbody>
      </table>
    </section>
  );
}
