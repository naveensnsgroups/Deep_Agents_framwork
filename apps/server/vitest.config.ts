import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // Belt and braces alongside the tsconfig exclude: if a stale `dist` from an older build
    // is lying around, vitest would otherwise run every suite a second time from there.
    exclude: ["dist/**", "node_modules/**"],
  },
});
