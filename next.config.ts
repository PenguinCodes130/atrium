import { writeFileSync } from "node:fs";
import type { NextConfig } from "next";

// Parallel wave builds each set their own build folder (shared/wave-protocol.md).
const distDir = process.env.ATRIUM_DIST_DIR ?? ".next";

// A slot build type-checks only its own generated types, so a stale validator
// in another slot's folder (e.g. after a page moves) cannot fail this build.
function slotTsconfig(): string | undefined {
  if (distDir === ".next") return undefined;
  const path = `tsconfig.slot${distDir.replace(/^\.next/, "")}.json`;
  const slot = {
    extends: "./tsconfig.json",
    include: [
      "next-env.d.ts",
      "src/**/*.ts",
      "src/**/*.tsx",
      "tests/**/*.ts",
      "*.config.ts",
      `${distDir}/types/**/*.ts`,
      `${distDir}/dev/types/**/*.ts`,
    ],
  };
  writeFileSync(path, `${JSON.stringify(slot, null, 2)}\n`);
  return path;
}

const config: NextConfig = {
  output: "standalone",
  distDir,
  typescript: { tsconfigPath: slotTsconfig() },
  poweredByHeader: false,
  serverExternalPackages: ["better-sqlite3"],
  // Video uploads are up to 25 MB (amendment A7.1); the proxy cuts request bodies at 10 MB by default.
  experimental: { proxyClientMaxBodySize: "26mb" },
  async headers() {
    return [
      {
        source: "/_next/static/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "same-origin" },
        ],
      },
    ];
  },
};

export default config;
