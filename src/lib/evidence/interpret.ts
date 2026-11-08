/**
 * Deterministic rules-based reading of a caller report.
 *
 * Report text is untrusted data. This only extracts a room hint (from the prior's room names) and the
 * reporter's count language as text. It never turns count language into a number, and nothing in the text
 * can change authority, approvals or configuration: instruction-like text simply matches nothing.
 *
 * Room matching: floor words ("upstairs", "second floor", "downstairs", "ground floor"...) restrict the
 * candidate rooms to that floor (US naming: first floor = ground floor; floor indices increase upward).
 * A room is eligible when the text names its head noun ("bedroom") or says "room" generically; rooms are
 * ranked by how many of their qualifier words ("rear", "front") appear, then by a specific head noun.
 * A tie, a conflict between floor words or no match yields null: the rules never guess.
 *
 * Fire-class cues (fireClassCues): words that suggest a fire water is unsafe for — cooking oil or grease
 * ("pan", "grease", "oil", "cooking", "fryer"), flammable liquid or gas ("gasoline", "fuel", "paint thinner",
 * "propane", "motor oil") and live electrical ("outlet", "wires", "electrical panel", "sparks"). Each cue
 * keeps the reporter's words and the one prior room its clause names, if any (clauses split at sentence
 * punctuation, commas and conjunctions; a clause naming no room or several gives no room, and such a cue then
 * applies to every fire). Negations are not parsed: "not a grease fire" still gives a cue. Both shortcuts err
 * toward refusing water, never toward allowing it. Crew statements (fireStatements) recognise a circuit
 * reported de-energized and ordinary combustibles confirmed, only in a clause with no negation word.
 */
import type { FloorPlanPrior, WaterUnsafeFireClass } from "../contracts/evidence.ts";
import type { RoomId } from "../contracts/ids.ts";
import type { PriorRoom } from "./rooms.ts";

export interface ReportInterpretation {
  readonly roomHint: RoomId | null;
  /** The reporter's own count language, verbatim; null when there is none. Never arithmetic. */
  readonly countText: string | null;
}

export function interpretReport(text: string, prior: FloorPlanPrior): ReportInterpretation {
  return { roomHint: matchRoom(text, prior), countText: extractCountText(text) };
}

type FloorCue = "upper" | "ground" | "below";

/** Word normalisation (Maps, not object literals, so untrusted words cannot hit prototype keys). */
const SYNONYMS: ReadonlyMap<string, string> = new Map([["back", "rear"], ["hallway", "hall"], ["2nd", "second"], ["1st", "first"]]);
const COMPOUNDS: ReadonlyMap<string, string> = new Map([["bed room", "bedroom"], ["up stairs", "upstairs"], ["down stairs", "downstairs"]]);
const FLOOR_WORDS: ReadonlySet<string> = new Set(["upstairs", "downstairs", "basement", "cellar", "floor", "level", "story", "storey"]);
const SINGLE_CUES: ReadonlyMap<string, FloorCue> = new Map([["upstairs", "upper"], ["downstairs", "ground"], ["basement", "below"], ["cellar", "below"]]);
const LEVEL_NOUNS: ReadonlySet<string> = new Set(["floor", "level", "story", "storey"]);
const LEVEL_QUALIFIERS: ReadonlyMap<string, FloorCue> = new Map([
  ["upper", "upper"], ["second", "upper"], ["top", "upper"],
  ["ground", "ground"], ["first", "ground"], ["main", "ground"], ["lower", "ground"], ["bottom", "ground"],
]);
const GENERIC_ROOM = "room";

function normalizedTokens(text: string): string[] {
  const raw = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  const tokens: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const compound = COMPOUNDS.get(`${raw[i]} ${raw[i + 1]}`);
    if (compound !== undefined) {
      tokens.push(compound);
      i++;
    } else {
      tokens.push(SYNONYMS.get(raw[i]) ?? raw[i]);
    }
  }
  return tokens;
}

/** Floor cues in the text and the token positions they used, which are then not room words. */
function floorCues(tokens: readonly string[]): { cues: Set<FloorCue>; consumed: Set<number> } {
  const cues = new Set<FloorCue>();
  const consumed = new Set<number>();
  tokens.forEach((token, i) => {
    const single = SINGLE_CUES.get(token);
    const qualified = LEVEL_NOUNS.has(tokens[i + 1] ?? "") ? LEVEL_QUALIFIERS.get(token) : undefined;
    if (single !== undefined) {
      cues.add(single);
      consumed.add(i);
    } else if (qualified !== undefined) {
      cues.add(qualified);
      consumed.add(i).add(i + 1);
    }
  });
  return { cues, consumed };
}

function roomsOnCuedFloor(prior: FloorPlanPrior, cue: FloorCue | null): readonly PriorRoom[] {
  if (cue === null) return prior.rooms;
  const indices = [...prior.floors.map(floor => floor.index), ...prior.rooms.map(room => room.floor)];
  const ground = indices.includes(0) ? 0 : Math.min(...indices);
  return prior.rooms.filter(room => (cue === "upper" ? room.floor > ground : cue === "ground" ? room.floor === ground : room.floor < ground));
}

interface RoomScore {
  readonly room: PriorRoom;
  readonly qualifiers: number;
  readonly specific: boolean;
}

function hasWord(words: ReadonlySet<string>, word: string): boolean {
  return words.has(word) || words.has(`${word}s`) || words.has(`${word}es`);
}

function scoreRoom(room: PriorRoom, words: ReadonlySet<string>): RoomScore | null {
  const nameTokens = normalizedTokens(room.name).filter(token => !FLOOR_WORDS.has(token));
  if (nameTokens.length === 0) return null;
  const head = nameTokens[nameTokens.length - 1];
  const qualifiers = nameTokens.slice(0, -1).filter(token => hasWord(words, token)).length;
  if (head !== GENERIC_ROOM && hasWord(words, head)) return { room, qualifiers, specific: true };
  return hasWord(words, GENERIC_ROOM) ? { room, qualifiers, specific: false } : null;
}

function compareScores(a: RoomScore, b: RoomScore): number {
  return b.qualifiers - a.qualifiers || Number(b.specific) - Number(a.specific);
}

function matchRoom(text: string, prior: FloorPlanPrior): RoomId | null {
  const tokens = normalizedTokens(text);
  const { cues, consumed } = floorCues(tokens);
  const cue = cues.size === 1 ? [...cues][0] : null;
  const words = new Set(tokens.filter((_, i) => !consumed.has(i)));
  const ranked = roomsOnCuedFloor(prior, cue)
    .map(room => scoreRoom(room, words))
    .filter((score): score is RoomScore => score !== null)
    .sort(compareScores);
  if (ranked.length === 0) return null;
  if (ranked.length > 1 && compareScores(ranked[0], ranked[1]) === 0) return null;
  return ranked[0].room.id;
}

const PERSON =
  "(?:no one|someone|somebody|anyone|anybody|everyone|everybody|nobody|persons?|people|m[ae]n|wom[ae]n|adults?|kids?|child(?:ren)?|bab(?:y|ies)|infants?|toddlers?"
  + "|boys?|girls?|teens?|teenagers?|grandparents?|grand(?:mother|father|ma|pa)s?|parents?|mother|mom|mum|father|dad|sons?|daughters?|brothers?|sisters?"
  + "|husband|wife|uncles?|aunts?|cousins?|famil(?:y|ies)|roommates?|residents?|occupants?|tenants?|guests?|neighbou?rs?|guys?|lady|ladies|victims?|elderly)";
const QUANTIFIER = "(?:a|an|the|one|two|three|four|five|six|seven|eight|nine|ten|\\d+|several|few|couple|both|some|many|multiple|another|all|his|her|their|my|our|your|no)";
const HEDGE = "(?:maybe|possibly|perhaps|probably|about|around|roughly|approximately|at least|at most|up to|more than|fewer than|less than|just|only)";
const NUMBER = "(?:one|two|three|four|five|six|seven|eight|nine|ten|\\d+)";

/** "maybe his parents", "a little girl", "two people", "someone": a person word with its own quantifier. */
const PERSON_PHRASE = new RegExp(`\\b(?:${HEDGE}\\s+)?(?:${QUANTIFIER}\\s+(?:[a-z']+\\s+){0,2}?)?${PERSON}\\b`, "gi");
/** A bare count ("maybe three") counts only when it joins a person phrase. */
const NUMBER_PHRASE = new RegExp(`\\b(?:${HEDGE}\\s+)?${NUMBER}\\b`, "gi");
/** Gaps that keep adjacent count phrases together, so hedges survive: "a kid and maybe his parents". */
const JOINER = /^(?:[\s,;]|\b(?:and|or|plus|with|of|maybe|possibly|perhaps|probably|also)\b)*$/i;

interface Span {
  readonly start: number;
  readonly end: number;
  readonly person: boolean;
}

function spansOf(pattern: RegExp, text: string, person: boolean): Span[] {
  return [...text.matchAll(pattern)].map(match => ({ start: match.index, end: match.index + match[0].length, person }));
}

/** The reporter's count language, verbatim. Separate passages are joined with " … ". */
function extractCountText(text: string): string | null {
  const people = spansOf(PERSON_PHRASE, text, true);
  if (people.length === 0) return null;
  const numbers = spansOf(NUMBER_PHRASE, text, false).filter(n => !people.some(p => n.start < p.end && p.start < n.end));
  const spans = [...people, ...numbers].sort((a, b) => a.start - b.start);
  const groups: Span[][] = [];
  for (const span of spans) {
    const group = groups[groups.length - 1];
    if (group !== undefined && JOINER.test(text.slice(group[group.length - 1].end, span.start))) group.push(span);
    else groups.push([span]);
  }
  const passages = groups.filter(group => group.some(span => span.person)).map(group => text.slice(group[0].start, group[group.length - 1].end));
  return passages.join(" … ");
}

/* Fire-class cues and crew statements. */

/** Words in a report or crew statement that suggest a fire water is unsafe for. */
export interface FireClassCue {
  readonly fireClass: WaterUnsafeFireClass;
  /** The matched words, verbatim. */
  readonly phrase: string;
  /** The single prior room the cue's clause names, or null when it names none or several. */
  readonly roomId: RoomId | null;
}

/** A crew statement that resolves indicators: the circuit de-energized, or ordinary combustibles confirmed. */
export interface FireStatement {
  readonly kind: "de_energized" | "ordinary";
  readonly phrase: string;
  readonly roomId: RoomId | null;
}

/**
 * Cue patterns, in claim order: flammable liquids first, so "motor oil" is a fuel and not cooking oil. A span
 * claimed by an earlier pattern is not matched again.
 */
const FIRE_CUE_PATTERNS: readonly (readonly [WaterUnsafeFireClass, RegExp])[] = [
  ["flammable_liquid", /\b(?:gasoline|petrol|diesel|kerosene|paraffin|lighter fluid|paint thinners?|thinners?|turpentine|white spirit|acetone|solvents?|propane|butane|fuels?|gas|(?:motor|engine|heating|lamp) oils?)\b/gi],
  ["cooking_oil", /\b(?:grease|greasy|cooking|(?:deep[- ]?)?fr(?:yers?|ying)|chip pans?|woks?|pans?|oils?|stove ?tops?|(?<!(?:wood|pellet|coal) )stoves?)\b/gi],
  ["electrical", /\b(?:electrical|electric|electricity|outlets?|sockets?|wires?|wiring|power strips?|extension (?:cords?|leads?)|fuse ?box(?:es)?|(?:circuit )?breakers?|short circuits?|shorted|sparks?|sparking|arcing|transformers?|power lines?|space heaters?)\b/gi],
];
const DE_ENERGIZED = /\b(?:de-?energi[sz]ed|(?:power|electricity|mains|supply)(?: (?:is|was|has been|have been|now))? (?:off|cut|isolated|disconnected|shut off|switched off|turned off|killed)|(?:cut|isolated|disconnected|shut off|switched off|turned off|killed) (?:the )?(?:power|electricity|mains|supply)|breakers? (?:(?:is|are|was|were|now) )?(?:off|tripped|open|thrown))\b/i;
const ORDINARY = /\b(?:class a|ordinary combustibles?)\b/i;
const NEGATION = /\b(?:not|no|never|cannot|unable|still)\b|n['\u2019]t\b/i;
const CLAUSE_BREAK = /[.!?;:,\n]+|\b(?:and|but|while|whereas|because|although|though|then|so)\b/i;
/** Name words that do not tell rooms apart. */
const ROOM_STOP_WORDS: ReadonlySet<string> = new Set(["and", "the", "of", "with", "room", "rooms", "area"]);

/** Fire-class cues in the text, in order, each with the room its clause names (see the module comment). */
export function fireClassCues(text: string, prior: FloorPlanPrior): FireClassCue[] {
  return clausesOf(text).flatMap(clause => {
    const claimed: [number, number][] = [];
    const found: { start: number; cue: Omit<FireClassCue, "roomId"> }[] = [];
    for (const [fireClass, pattern] of FIRE_CUE_PATTERNS) {
      for (const match of clause.matchAll(pattern)) {
        const start = match.index;
        const end = start + match[0].length;
        if (claimed.some(([a, b]) => start < b && a < end)) continue;
        claimed.push([start, end]);
        found.push({ start, cue: { fireClass, phrase: match[0] } });
      }
    }
    if (found.length === 0) return [];
    const roomId = clauseRoom(clause, prior);
    return found.sort((a, b) => a.start - b.start).map(f => ({ ...f.cue, roomId }));
  });
}

/** De-energized and ordinary-combustibles statements, each in a clause without a negation word. */
export function fireStatements(text: string, prior: FloorPlanPrior): FireStatement[] {
  return clausesOf(text).flatMap(clause => {
    if (NEGATION.test(clause)) return [];
    const statements: FireStatement[] = [];
    const deEnergized = clause.match(DE_ENERGIZED);
    const ordinary = clause.match(ORDINARY);
    if (deEnergized !== null) statements.push({ kind: "de_energized", phrase: deEnergized[0], roomId: clauseRoom(clause, prior) });
    if (ordinary !== null) statements.push({ kind: "ordinary", phrase: ordinary[0], roomId: clauseRoom(clause, prior) });
    return statements;
  });
}

function clausesOf(text: string): string[] {
  return text.split(CLAUSE_BREAK).map(clause => clause.trim()).filter(clause => clause.length > 0);
}

/**
 * The one prior room a clause names: the room rules' match, or else the room a name word unique to it among
 * the floor-cued rooms points to ("kitchen" for "Kitchen and dining room"). Disagreement or several rooms: null.
 */
function clauseRoom(clause: string, prior: FloorPlanPrior): RoomId | null {
  const matched = matchRoom(clause, prior);
  const tokens = normalizedTokens(clause);
  const { cues, consumed } = floorCues(tokens);
  const words = new Set(tokens.filter((_, i) => !consumed.has(i)));
  const rooms = roomsOnCuedFloor(prior, cues.size === 1 ? [...cues][0] : null);
  const nameWords = rooms.map(room => new Set(normalizedTokens(room.name).filter(t => !FLOOR_WORDS.has(t) && !ROOM_STOP_WORDS.has(t) && t.length >= 3)));
  const named = new Set<RoomId>();
  rooms.forEach((room, i) => {
    for (const word of nameWords[i]) {
      if (hasWord(words, word) && nameWords.every((other, j) => j === i || !other.has(word))) named.add(room.id);
    }
  });
  const unique = named.size === 1 ? [...named][0] : null;
  if (matched !== null && unique !== null && matched !== unique) return null;
  if (matched === null && named.size > 1) return null;
  return matched ?? unique;
}
