# scan

Function export from `@ra11y/core`.

Runs the built-in scanner programmatically:

```ts
import { scan } from "@ra11y/core";

const result = await scan({ paths: ["src"], standards: ["wcag22"], level: "AA" });
```

`scan()` discovers parseable files under `paths`, parses them, runs the built-in registry, and returns a `ScanResult`.
