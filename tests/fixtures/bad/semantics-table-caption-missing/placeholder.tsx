// Bad: failing semantics/table-caption-missing scenario — data tables
// with no accessible name. Three distinct failure modes:
//   1. bare <table> with no caption / aria-label / aria-labelledby / title
//   2. <table> with an empty <caption /> shell
//   3. <table> preceded by an <h2> (suggestion should echo the heading)
export function BadTables() {
  return (
    <section>
      <table>
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

      <table>
        <caption />
        <tbody>
          <tr>
            <th scope="col">SKU</th>
          </tr>
          <tr>
            <td>A-001</td>
          </tr>
        </tbody>
      </table>

      <h2>Employees</h2>
      <table>
        <tbody>
          <tr>
            <th scope="col">Name</th>
          </tr>
          <tr>
            <td>Ada Lovelace</td>
          </tr>
        </tbody>
      </table>
    </section>
  );
}
