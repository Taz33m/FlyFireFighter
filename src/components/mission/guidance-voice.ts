/**
 * Guidance voice: plays the drone's guidance speech aloud in the room, through the OS's local speech engine
 * via window.speechSynthesis. Pure core plus an injectable speech output, so the logic runs in node tests.
 *
 * What may be spoken: only SPEECH_TEMPLATES (src/lib/contracts/actions.ts), the approved scenario templates
 * that the harness's H8 rule checks. Text is never invented or paraphrased. If an unknown template id, or a
 * dispatch template without the commander's dispatch fact, shows up, that activation stays silent and the
 * reason says why.
 *
 * When: only from the truth-free MissionView. A speak or guide proposal has to have started executing in the
 * harness (ProposalRecord.execution), and the aircraft profile must have a speaker. A guide speaks each of its
 * templates once when it starts, then repeats them no more often than repeatMs while it is still executing.
 * A speak action plays once, and only within SPEAK_FRESH_TICKS of executing. Speech is cancelled on mute, abort,
 * reset or a new run, and when the harness stops the guidance (invalidated, aborted, expired). It never
 * interrupts its own utterance, keeps at least gapMs between utterances, and is muted until the presenter
 * enables it.
 *
 * No network: only voices that report localService === true are used, and the utterance's voice is set
 * explicitly. Some browser voices (e.g. Chrome's "Google …" voices) run in the cloud. If no local voice
 * exists the voice stays silent ("No local speech voice available") and never falls back to a remote voice.
 */
import { SPEECH_TEMPLATES } from "../../lib/contracts/actions.ts";
import type { ActionSpec, ProposalRecord, ProposalStatus } from "../../lib/contracts/actions.ts";
import { AIRCRAFT_PROFILES } from "../../lib/contracts/aircraft.ts";
import type { MissionStatus, MissionView } from "../../lib/mission/protocol.ts";

/** A speak action is voiced only this soon (simulated ticks) after it executed, never late. */
export const SPEAK_FRESH_TICKS = 300;
export const NO_LOCAL_VOICE = "No local speech voice available";
export const MUTED = "Guidance voice is muted";

/* Activation, from MissionView only. */

export type SpeechActivation =
  | { readonly kind: "active"; readonly proposalId: string; readonly templateIds: readonly string[]; readonly repeat: boolean }
  /** The harness stopped this speech action; speech for it must stop too. */
  | { readonly kind: "stopped"; readonly proposalId: string; readonly reason: string }
  | { readonly kind: "none"; readonly reason: string };

const STOPPED_STATUSES: ReadonlySet<ProposalStatus> = new Set<ProposalStatus>(["invalidated", "aborted", "expired", "rejected"]);

type SpeechAction = Extract<ActionSpec, { kind: "speak" | "guide" }>;

function isSpeech(record: ProposalRecord): record is ProposalRecord & { readonly proposal: { readonly action: SpeechAction } } {
  return record.proposal.action.kind === "speak" || record.proposal.action.kind === "guide";
}

function activeOrDone(record: ProposalRecord & { readonly proposal: { readonly action: SpeechAction } }, tick: number): SpeechActivation {
  const id = record.proposal.id;
  const action = record.proposal.action;
  if (action.kind === "guide") {
    return record.status === "executing" ? { kind: "active", proposalId: id, templateIds: action.templateIds, repeat: true } : { kind: "none", reason: `Guidance ${id} is ${record.status}` };
  }
  const execution = record.execution;
  if (execution === null || execution.effects.cuesIssued === 0) return { kind: "none", reason: `Speak action ${id} has not played yet` };
  if (tick - execution.startedTick > SPEAK_FRESH_TICKS) return { kind: "none", reason: `Speak action ${id} played earlier; it is not replayed late` };
  return { kind: "active", proposalId: id, templateIds: [action.templateId], repeat: false };
}

/** The speech the drone is making now, from the latest speak or guide proposal that started executing. */
export function speechActivation(view: Pick<MissionView, "tick" | "proposals" | "config"> | null): SpeechActivation {
  if (view === null) return { kind: "none", reason: "No run" };
  if (AIRCRAFT_PROFILES.find(p => p.id === view.config.aircraftId)?.modules.speaker !== true) return { kind: "none", reason: "This aircraft has no speaker; guidance uses the light cue only" };
  const record = [...view.proposals].reverse().find(r => isSpeech(r) && r.execution !== null);
  if (record === undefined || !isSpeech(record)) return { kind: "none", reason: "No speech or guidance action has started" };
  if (STOPPED_STATUSES.has(record.status)) return { kind: "stopped", proposalId: record.proposal.id, reason: `the harness marked it ${record.status}` };
  return activeOrDone(record, view.tick);
}

/* Voice selection: local voices only. */

export interface VoiceLike {
  readonly name: string;
  readonly lang: string;
  readonly localService: boolean;
  readonly default: boolean;
  readonly voiceURI: string;
}

export type VoiceChoice =
  | { readonly available: true; readonly voiceId: string; readonly label: string }
  | { readonly available: false; readonly reason: string };

const normLang = (lang: string) => lang.replace("_", "-").toLowerCase();

/** The local English voice to use: the preferred language first, then the system default, then by name. */
export function chooseLocalVoice(voices: readonly VoiceLike[], preferredLang = "en-US"): VoiceChoice {
  const local = voices.filter(v => v.localService === true);
  if (local.length === 0) {
    return { available: false, reason: voices.length === 0 ? `${NO_LOCAL_VOICE} (the browser lists no voices)` : `${NO_LOCAL_VOICE}: the browser offers only network voices, which would send the text to a cloud service` };
  }
  const english = local.filter(v => normLang(v.lang).startsWith("en"));
  if (english.length === 0) return { available: false, reason: `${NO_LOCAL_VOICE} for English (the scenario templates are English)` };
  const want = normLang(preferredLang);
  const rank = (v: VoiceLike) => (normLang(v.lang) === want ? 0 : 2) + (v.default ? 0 : 1);
  const best = [...english].sort((a, b) => rank(a) - rank(b) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))[0];
  return { available: true, voiceId: best.voiceURI, label: `${best.name} (${best.lang}, local)` };
}

/* State machine. */

export interface VoiceTiming {
  /** A guidance template is repeated no sooner than this after it was last spoken. */
  readonly repeatMs: number;
  /** Minimum time between the starts of two utterances. */
  readonly gapMs: number;
}

export const DEFAULT_VOICE_TIMING: VoiceTiming = { repeatMs: 12_000, gapMs: 1_500 };

export interface VoiceInput {
  readonly runId: string | null;
  readonly status: MissionStatus | null;
  readonly activation: SpeechActivation;
  /** BeliefSnapshot.dispatchConfirmed !== null: the commander entered the dispatch fact. */
  readonly dispatchConfirmed: boolean;
  /** The presenter turned the voice on. Default off. */
  readonly enabled: boolean;
  readonly voice: VoiceChoice;
  /** The speech output is speaking or has queued speech. */
  readonly busy: boolean;
  /** Monotonic wall clock, ms. */
  readonly nowMs: number;
}

export interface VoiceState {
  readonly runId: string | null;
  /** Last time each (proposal, template) was spoken in this run. */
  readonly spokenAtMs: ReadonlyMap<string, number>;
  readonly lastUtteranceMs: number | null;
  /** Proposal of the last utterance, so stopping that guidance cancels it. */
  readonly speakingFor: string | null;
}

export const INITIAL_VOICE: VoiceState = { runId: null, spokenAtMs: new Map(), lastUtteranceMs: null, speakingFor: null };

export type VoiceEffect =
  | { readonly kind: "speak"; readonly text: string; readonly templateId: string; readonly proposalId: string; readonly voiceId: string }
  | { readonly kind: "cancel"; readonly reason: string };

export interface VoiceStep {
  readonly state: VoiceState;
  readonly effects: readonly VoiceEffect[];
  readonly reason: string;
}

const spokenKey = (proposalId: string, templateId: string) => `${proposalId}\u0000${templateId}`;

function cancelReason(state: VoiceState, input: VoiceInput): string | null {
  if (input.runId !== state.runId && state.runId !== null) return input.runId === null ? "Run reset: speech stopped" : "New run: speech from the previous run stopped";
  if (!input.enabled) return MUTED;
  if (input.status === "aborted") return "Mission aborted: guidance speech stopped";
  const a = input.activation;
  if (a.kind === "stopped" && state.speakingFor === a.proposalId) return `Guidance ${a.proposalId} stopped (${a.reason}): speech cancelled`;
  return null;
}

function statusSilence(input: VoiceInput): string | null {
  if (input.runId === null || input.status === null) return "No run";
  if (input.status === "paused") return "Run paused: no new speech";
  if (input.status === "ended") return "Run ended";
  if (input.activation.kind !== "active") return input.activation.reason;
  return null;
}

/** Every template of the activation must be an approved one that is allowed now, or the activation stays silent. */
function templateSilence(templateIds: readonly string[], dispatchConfirmed: boolean): string | null {
  for (const id of templateIds) {
    const template = SPEECH_TEMPLATES.find(t => t.id === id);
    if (template === undefined) return `Template "${id}" is not an approved scenario template; nothing is spoken`;
    if (template.requiresDispatchConfirmed && !dispatchConfirmed) return `Template "${id}" mentions dispatch, which the commander has not confirmed; nothing is spoken`;
  }
  return templateIds.length === 0 ? "The action names no template" : null;
}

function outputSilence(state: VoiceState, input: VoiceInput, timing: VoiceTiming): string | null {
  if (!input.voice.available) return input.voice.reason;
  if (input.busy) return "Waiting for the current utterance to finish";
  if (state.lastUtteranceMs !== null && input.nowMs - state.lastUtteranceMs < timing.gapMs) return "Spacing utterances";
  return null;
}

type TemplatePick = { readonly templateId: string } | { readonly wait: string };

/** First every template once, in order; then (guide only) the least recently spoken one that is due again. */
function pickTemplate(state: VoiceState, a: Extract<SpeechActivation, { kind: "active" }>, nowMs: number, timing: VoiceTiming): TemplatePick {
  const unspoken = a.templateIds.find(t => !state.spokenAtMs.has(spokenKey(a.proposalId, t)));
  if (unspoken !== undefined) return { templateId: unspoken };
  if (!a.repeat) return { wait: "Spoken once: a speak action plays a single time" };
  const due = a.templateIds
    .map(t => ({ t, at: state.spokenAtMs.get(spokenKey(a.proposalId, t)) ?? 0 }))
    .filter(x => nowMs - x.at >= timing.repeatMs)
    .sort((x, y) => x.at - y.at)[0];
  return due === undefined ? { wait: `Repeats every ${Math.round(timing.repeatMs / 1000)} s while guidance continues` } : { templateId: due.t };
}

/** Advance the voice by one UI update: what to speak or cancel, and why. */
export function stepVoice(state: VoiceState, input: VoiceInput, timing: VoiceTiming = DEFAULT_VOICE_TIMING): VoiceStep {
  const base: VoiceState = input.runId !== state.runId ? { ...INITIAL_VOICE, runId: input.runId } : state;
  const cancel = cancelReason(state, input);
  if (cancel !== null) return { state: base, effects: input.busy ? [{ kind: "cancel", reason: cancel }] : [], reason: cancel };
  const a = input.activation;
  const silent = statusSilence(input)
    ?? (a.kind === "active" ? templateSilence(a.templateIds, input.dispatchConfirmed) : null)
    ?? outputSilence(base, input, timing);
  if (silent !== null || a.kind !== "active" || !input.voice.available) return { state: base, effects: [], reason: silent ?? "Silent" };
  const pick = pickTemplate(base, a, input.nowMs, timing);
  if ("wait" in pick) return { state: base, effects: [], reason: pick.wait };
  const text = SPEECH_TEMPLATES.find(t => t.id === pick.templateId)?.text;
  if (text === undefined) return { state: base, effects: [], reason: `Template "${pick.templateId}" is not an approved scenario template; nothing is spoken` };
  const spokenAtMs = new Map(base.spokenAtMs).set(spokenKey(a.proposalId, pick.templateId), input.nowMs);
  return {
    state: { ...base, spokenAtMs, lastUtteranceMs: input.nowMs, speakingFor: a.proposalId },
    effects: [{ kind: "speak", text, templateId: pick.templateId, proposalId: a.proposalId, voiceId: input.voice.voiceId }],
    reason: `Speaking approved template "${pick.templateId}" for ${a.proposalId}`,
  };
}

/* Driver over an injectable speech output. */

export interface SpeechOutput {
  /** A local voice, or why there is none. Never a network voice. */
  chooseVoice(): VoiceChoice;
  busy(): boolean;
  /** Speak with exactly this local voice; do nothing if it is gone. */
  speak(text: string, voiceId: string): void;
  cancel(): void;
}

export interface GuidanceVoiceStatus {
  readonly enabled: boolean;
  readonly reason: string;
  readonly voiceLabel: string | null;
  readonly lastSpoken: { readonly proposalId: string; readonly templateId: string; readonly text: string } | null;
}

export type GuidanceVoiceUpdate = Omit<VoiceInput, "voice" | "busy">;

/** Holds the voice state, applies its effects to the output and publishes a status (useSyncExternalStore-ready). */
export class GuidanceVoice {
  private state: VoiceState = INITIAL_VOICE;
  private status: GuidanceVoiceStatus = { enabled: false, reason: MUTED, voiceLabel: null, lastSpoken: null };
  private readonly output: SpeechOutput;
  private readonly timing: VoiceTiming;
  private readonly listeners = new Set<() => void>();
  private lastSpoken: (NonNullable<GuidanceVoiceStatus["lastSpoken"]> & { readonly runId: string | null }) | null = null;

  constructor(output: SpeechOutput, timing: VoiceTiming = DEFAULT_VOICE_TIMING) {
    this.output = output;
    this.timing = timing;
  }

  update(update: GuidanceVoiceUpdate): GuidanceVoiceStatus {
    const voice: VoiceChoice = update.enabled ? this.output.chooseVoice() : { available: false, reason: MUTED };
    const step = stepVoice(this.state, { ...update, voice, busy: this.output.busy() }, this.timing);
    this.state = step.state;
    for (const effect of step.effects) {
      if (effect.kind === "cancel") this.output.cancel();
      else {
        this.output.speak(effect.text, effect.voiceId);
        this.lastSpoken = { runId: update.runId, proposalId: effect.proposalId, templateId: effect.templateId, text: effect.text };
      }
    }
    const last = this.lastSpoken !== null && this.lastSpoken.runId === update.runId ? this.lastSpoken : null;
    this.publish({ enabled: update.enabled, reason: step.reason, voiceLabel: voice.available ? voice.label : null, lastSpoken: last });
    return this.status;
  }

  /** Cancel any speech now (unmount, page hide). */
  stop(): void {
    this.output.cancel();
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getStatus = (): GuidanceVoiceStatus => this.status;

  private publish(next: GuidanceVoiceStatus): void {
    const s = this.status;
    if (s.enabled === next.enabled && s.reason === next.reason && s.voiceLabel === next.voiceLabel && s.lastSpoken === next.lastSpoken) return;
    this.status = next;
    for (const listener of this.listeners) listener();
  }
}

/* Browser output over window.speechSynthesis. */

interface UtteranceLike {
  voice: unknown;
  lang: string;
}

interface SynthesisLike {
  readonly speaking: boolean;
  readonly pending: boolean;
  getVoices(): readonly VoiceLike[];
  speak(utterance: UtteranceLike): void;
  cancel(): void;
}

export interface SpeechEnvironment {
  readonly speechSynthesis?: SynthesisLike;
  readonly SpeechSynthesisUtterance?: new (text: string) => UtteranceLike;
}

const browserEnvironment = (): SpeechEnvironment | undefined => (typeof window === "undefined" ? undefined : (window as unknown as SpeechEnvironment));

/**
 * SpeechOutput over the Web Speech API. The environment is read on each call (safe to construct during server
 * rendering). Only voices with localService === true are ever assigned to an utterance.
 */
export function browserSpeechOutput(environment: () => SpeechEnvironment | undefined = browserEnvironment): SpeechOutput {
  const synth = () => {
    const env = environment();
    return env?.speechSynthesis !== undefined && env.SpeechSynthesisUtterance !== undefined ? { synthesis: env.speechSynthesis, Utterance: env.SpeechSynthesisUtterance } : null;
  };
  return {
    chooseVoice: () => {
      const s = synth();
      return s === null ? { available: false, reason: `${NO_LOCAL_VOICE}: this browser has no speech synthesis` } : chooseLocalVoice(s.synthesis.getVoices());
    },
    busy: () => {
      const s = synth();
      return s !== null && (s.synthesis.speaking || s.synthesis.pending);
    },
    speak: (text, voiceId) => {
      const s = synth();
      const voice = s?.synthesis.getVoices().find(v => v.voiceURI === voiceId && v.localService === true);
      if (s === null || voice === undefined) return;
      const utterance = new s.Utterance(text);
      utterance.voice = voice;
      utterance.lang = voice.lang;
      s.synthesis.speak(utterance);
    },
    cancel: () => synth()?.synthesis.cancel(),
  };
}
