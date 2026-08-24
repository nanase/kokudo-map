/* Locate the project. pipeline/ sits directly under the project root, so the
 * depth is fixed. */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/* Per-region GeoJSON and meta: intermediate, not served. What the viewer
 * fetches is packed into web/data by pack_web.mjs. */
export const REGIONS = join(ROOT, 'build', 'regions');
export const DATA = join(ROOT, 'web', 'data');
