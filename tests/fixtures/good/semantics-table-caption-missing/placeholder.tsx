// Good: compliant semantics/table-caption-missing scenario — each data
// table carries an accessible name via <caption>, aria-label, or
// aria-labelledby, and the layout table is marked role="presentation".
export function GoodTables() {
  return (
    <section>
      <table>
        <caption>Quarterly sales by region</caption>
        <thead>
          <tr>
            <th scope="col">Region</th>
            <th scope="col">Q1</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>North</td>
            <td>$100</td>
          </tr>
        </tbody>
      </table>

      <table aria-label="Product inventory">
        <thead>
          <tr>
            <th scope="col">SKU</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>A-001</td>
          </tr>
        </tbody>
      </table>

      <h2 id="employee-list">Current employees</h2>
      <table aria-labelledby="employee-list">
        <thead>
          <tr>
            <th scope="col">Name</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Ada Lovelace</td>
          </tr>
        </tbody>
      </table>

      <table role="presentation">
        <tbody>
          <tr>
            <td>left column</td>
            <td>right column</td>
          </tr>
        </tbody>
      </table>
    </section>
  );
}
