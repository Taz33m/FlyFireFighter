/**
 * Fixed course seed lists for the controller comparison (architecture §3 "Training and comparison").
 *
 * The split is by course seed, and a course seed fixes BOTH the layout and the motion sequence (start
 * offset, approach speed, smoke, lighting, debris timing; see course.ts). The lists were drawn once
 * (random 32-bit hex) on 2026-11-07, before any frame was rendered or any controller was tuned, and are
 * never edited afterwards: training and validation runs use only their own lists, and the held-out
 * comparison runs only the test list. A layout or sequence therefore never appears in two splits, and
 * adjacent frames of one run always share its split.
 */
export type CourseSplit = "train" | "validation" | "test";

export const COURSE_FAMILY = "corridor-doorway/v1";

export const COURSE_SEEDS: Readonly<Record<CourseSplit, readonly string[]>> = Object.freeze({
  train: Object.freeze([
    "ecabf060", "f525c15e", "ce6ae191", "7358f260", "5062b1ab", "a2c09698", "5eb43172", "62304662", "6053c4e3", "9ea3b7d0",
    "5ff25fe3", "8364d188", "f3830d81", "32cdb7b7", "3b2ef38b", "560ce2bd", "4b9e2ceb", "83e49d2f", "11cd8081", "bd6b82d9",
    "9ef70b7f", "889e9b1c", "cbf83046", "4b9c2ac4", "d3dbc725", "a66b221c", "742848ce", "6891103e", "bf8bff7a", "129ffefb",
    "6a51a9c8", "fc9ef0c4", "a5f0757e", "1e610c0d", "ed653274", "e034b70e", "f05c6d06", "ae4cf6eb", "9dbd75d0", "dc8a6d74",
  ]),
  validation: Object.freeze([
    "64f08b96", "d66ffacc", "d05018ee", "a8742d67", "7ee312ef", "3ab82796", "8af84cfa", "96bb5ff4", "4709a950", "4b6bd4d8",
    "6a830019", "42d4da83",
  ]),
  test: Object.freeze([
    "94621f27", "b46e42fd", "6987b937", "0f7f787d", "35218a79", "73cdf689", "df216675", "eac78b7c", "a593ae7a", "c3930aee",
    "117d5f82", "31b63691", "c817b50c", "b0119266", "aa63752c", "2e445a64", "2d26453f", "effc13ba", "ecfc0503", "096a0d4f",
    "16591b79", "4f60469f", "ae26841b", "df537799",
  ]),
});

/** Course id: split prefix + seed, so a run bundle always names the split it came from. */
export function courseId(split: CourseSplit, seed: string): string {
  return `${split === "validation" ? "val" : split}-${seed}`;
}

/** The split a seed belongs to, or null for a seed in no list. */
export function splitOf(seed: string): CourseSplit | null {
  for (const split of ["train", "validation", "test"] as const) if (COURSE_SEEDS[split].includes(seed)) return split;
  return null;
}
