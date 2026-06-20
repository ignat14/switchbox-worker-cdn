import { defineConfig } from "vitest/config";

// Plain node env: the worker is a `export default { fetch }` handler we invoke
// directly with a mock env/ctx. That's deliberately *not* the Workers pool —
// calling the handler with fake bindings is the only way to simulate a binding
// *throwing* (R2/KV/AE), which is exactly the fail-open contract under test.
export default defineConfig({
  test: {
    environment: "node",
    globals: true,
  },
});
