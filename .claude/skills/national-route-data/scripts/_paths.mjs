/* Locate the project regardless of where these scripts are installed.
 * The scripts belong to the skill, so their depth below the project root is
 * not fixed. They walk up until they find the project instead of counting
 * parents. */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export function projectRoot(from = dirname(fileURLToPath(import.meta.url))) {
  let d = from;
  for (;;) {
    if (existsSync(join(d, 'mise.toml')) && existsSync(join(d, 'web')))
      return d;
    const up = dirname(d);
    if (up === d) {
      throw new Error(
        'project root not found: expected a directory containing mise.toml and web/',
      );
    }
    d = up;
  }
}

export const ROOT = projectRoot();

/* Per-region GeoJSON and meta: intermediate, not served. What the viewer
 * fetches is packed into web/data by pack_web.mjs. */
export const REGIONS = join(ROOT, 'build', 'regions');
export const DATA = join(ROOT, 'web', 'data');
