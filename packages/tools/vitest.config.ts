import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    /**
     * Some of these tests start a process or reach the network, and they
     * share the machine with the rest of the suite: a test that is quick
     * on its own can be slow when everything runs at once.
     *
     * The limit is generous so that a busy machine does not turn a passing
     * test into a failing one. A test that really hangs still fails.
     */
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
