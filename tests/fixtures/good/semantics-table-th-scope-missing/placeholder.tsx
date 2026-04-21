// Good: compliant semantics/table-th-scope-missing scenarios — every
// multi-row × multi-column data table either declares scope on each
// <th> or wires the complex-table headers=/id association. Single-
// row and single-column tables are exempt by structure and skipped
// as well. A presentation-marked table is non-tabular and skipped.
export function GoodTables() {
  return (
    <section>
      {/* scope="col" + scope="row" — the canonical 2-D data table shape. */}
      <table>
        <thead>
          <tr>
            <th scope="col">Product</th>
            <th scope="col">Price</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <th scope="row">Widget</th>
            <td>$50</td>
          </tr>
          <tr>
            <th scope="row">Gadget</th>
            <td>$75</td>
          </tr>
        </tbody>
      </table>

      {/* scope="colgroup" + scope="col" — grouped columns. */}
      <table>
        <thead>
          <tr>
            <th scope="colgroup" colSpan={2}>
              Sales
            </th>
          </tr>
          <tr>
            <th scope="col">Q1</th>
            <th scope="col">Q2</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>100</td>
            <td>120</td>
          </tr>
        </tbody>
      </table>

      {/* Complex-table association via headers= / id — a scope alternative. */}
      <table>
        <thead>
          <tr>
            <th id="th-product">Product</th>
            <th id="th-price">Price</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td headers="th-product">Widget</td>
            <td headers="th-price">$50</td>
          </tr>
          <tr>
            <td headers="th-product">Gadget</td>
            <td headers="th-price">$75</td>
          </tr>
        </tbody>
      </table>
    </section>
  );
}
