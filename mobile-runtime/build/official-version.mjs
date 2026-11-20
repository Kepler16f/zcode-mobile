import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Single source of truth for the injected `__ZCODE_VERSION__` build define:
 * reads `OFFICIAL_COMPAT_VERSION` directly from `mobile-runtime/ui/server-compat.ts`
 * so bundled `ZCODE_VERSION` never drifts from runtime compatibility headers.
 */
export function readOfficialCompatVersion(root) {
  const source = readFileSync(path.join(root, "mobile-runtime/ui/server-compat.ts"), "utf8");
  const match = source.match(/export\s+const\s+OFFICIAL_COMPAT_VERSION\s*=\s*"([^"]+)"/);
  if (!match?.[1]) {
    throw new Error("OFFICIAL_COMPAT_VERSION not found in mobile-runtime/ui/server-compat.ts");
  }
  return match[1];
}
