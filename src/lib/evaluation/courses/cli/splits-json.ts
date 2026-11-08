/**
 * Print the fixed course seed lists (splits.ts) as JSON, for embedding in the trained readout's metadata:
 *   node src/lib/evaluation/courses/cli/splits-json.ts > datasets/generated/readout-v1/splits.json
 */
import { COURSE_FAMILY, COURSE_SEEDS } from "../splits.ts";

process.stdout.write(`${JSON.stringify({ family: COURSE_FAMILY, drawn: "2026-11-07, before any frame was rendered", ...COURSE_SEEDS, testUse: "held-out comparison only; never read by training or tuning" }, null, 2)}\n`);
