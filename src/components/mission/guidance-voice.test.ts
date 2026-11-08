/**
 * Guidance voice: speaks only approved template text, only while the harness is executing a speech action
 * (read from MissionView), never late, never over itself, and stops on mute, abort, reset and harness stop.
 * Voice selection never uses a network voice.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ActionSpec, ProposalRecord, ProposalStatus } from "../../lib/contracts/actions.ts";
import { SPEECH_TEMPLATES } from "../../lib/contracts/actions.ts";
import { TENDER_T1 } from "../../lib/contracts/aircraft.ts";
import type { MissionView } from "../../lib/mission/protocol.ts";
import type { GuidanceVoiceUpdate, SpeechActivation, SpeechEnvironment, SpeechOutput, VoiceChoice, VoiceLike } from "./guidance-voice.ts";
import { DEFAULT_VOICE_TIMING, GuidanceVoice, MUTED, NO_LOCAL_VOICE, SPEAK_FRESH_TICKS, browserSpeechOutput, chooseLocalVoice, speechActivation } from "./guidance-voice.ts";

const RUN = "run-3";
const TEXT = (id: string) => SPEECH_TEMPLATES.find(t => t.id === id)!.text;
const GUIDE: ActionSpec = { kind: "guide", trackId: "track-1", routeId: "route-evac", templateIds: ["follow-light", "stay-low"], maxDurationTicks: 6000 };

function record(id: string, action: ActionSpec, status: ProposalStatus, started: number | null = 1000, cuesIssued = 1): ProposalRecord {
  const execution = started === null ? null : { proposalId: id, startedTick: started, endedTick: null, requestIds: [], effects: { waterDischargedL: 0, strikeDelivered: false, payloadReleased: false, cuesIssued, ticksExecuted: 1 }, stopReason: null };
  return { proposal: { id, action, digest: `d-${id}` }, risk: "routine", status, approval: null, execution, findings: [], history: [] } as unknown as ProposalRecord;
}

type ActivationView = Pick<MissionView, "tick" | "proposals" | "config">;

function view(records: readonly ProposalRecord[], tick = 1100, aircraftId = TENDER_T1.id): ActivationView {
  return { tick, proposals: records, config: { aircraftId } as MissionView["config"] };
}

describe("speechActivation (MissionView only)", () => {
  test("an executing guidance on an aircraft with a speaker activates its approved templates, repeating", () => {
    assert.deepEqual(speechActivation(view([record("p-guide", GUIDE, "executing")])), { kind: "active", proposalId: "p-guide", templateIds: ["follow-light", "stay-low"], repeat: true });
  });

  test("guidance that has not started, has finished, or belongs to a speakerless aircraft is silent", () => {
    assert.equal(speechActivation(view([record("p-guide", GUIDE, "approved", null)])).kind, "none");
    assert.equal(speechActivation(view([record("p-guide", GUIDE, "completed")])).kind, "none");
    assert.match((speechActivation(view([record("p-guide", GUIDE, "executing")], 1100, "unknown-aircraft")) as { reason: string }).reason, /no speaker/);
    assert.equal(speechActivation(null).kind, "none");
  });

  test("guidance the harness stopped is reported as stopped, so its speech can be cancelled", () => {
    for (const status of ["invalidated", "aborted", "expired"] as const) {
      assert.equal(speechActivation(view([record("p-guide", GUIDE, status)])).kind, "stopped", status);
    }
  });

  test("a speak action plays once, only soon after it executed and only once a cue was issued", () => {
    const speak = (startedTick: number, cues = 1) => record("p-speak", { kind: "speak", templateId: "stay-low" }, "completed", startedTick, cues);
    assert.deepEqual(speechActivation(view([speak(1000)], 1000 + SPEAK_FRESH_TICKS)), { kind: "active", proposalId: "p-speak", templateIds: ["stay-low"], repeat: false });
    assert.equal(speechActivation(view([speak(1000)], 1001 + SPEAK_FRESH_TICKS)).kind, "none", "never replayed late");
    assert.equal(speechActivation(view([speak(1000, 0)])).kind, "none", "no cue issued yet");
  });
});

/* Voice over a fake output. */

class FakeOutput implements SpeechOutput {
  choice: VoiceChoice = { available: true, voiceId: "local-samantha", label: "Samantha (en-US, local)" };
  speaking = false;
  readonly spoken: { text: string; voiceId: string }[] = [];
  cancels = 0;
  chooseVoice(): VoiceChoice {
    return this.choice;
  }
  busy(): boolean {
    return this.speaking;
  }
  speak(text: string, voiceId: string): void {
    this.spoken.push({ text, voiceId });
  }
  cancel(): void {
    this.cancels += 1;
    this.speaking = false;
  }
}

const active = (templateIds: readonly string[] = ["follow-light", "stay-low"], proposalId = "p-guide", repeat = true): SpeechActivation => ({ kind: "active", proposalId, templateIds, repeat });

function update(nowMs: number, extra: Partial<GuidanceVoiceUpdate> = {}): GuidanceVoiceUpdate {
  return { runId: RUN, status: "running", activation: active(), dispatchConfirmed: false, enabled: true, nowMs, ...extra };
}

/** Drive the voice every 100 ms over [from, to]; returns [time, text] for every utterance. */
function drive(voice: GuidanceVoice, output: FakeOutput, from: number, to: number, extra: Partial<GuidanceVoiceUpdate> = {}): [number, string][] {
  const said: [number, string][] = [];
  for (let t = from; t <= to; t += 100) {
    const before = output.spoken.length;
    voice.update(update(t, extra));
    for (const s of output.spoken.slice(before)) said.push([t, s.text]);
  }
  return said;
}

describe("guidance voice", () => {
  test("is muted by default: active guidance says nothing until enabled, then speaks the approved text verbatim with the chosen local voice", () => {
    const output = new FakeOutput();
    const voice = new GuidanceVoice(output);
    assert.equal(voice.getStatus().reason, MUTED);
    assert.deepEqual(drive(voice, output, 0, 5000, { enabled: false }), []);
    voice.update(update(5100));
    assert.deepEqual(output.spoken, [{ text: TEXT("follow-light"), voiceId: "local-samantha" }]);
  });

  test("an unknown template id keeps the whole activation silent and says why", () => {
    const output = new FakeOutput();
    const voice = new GuidanceVoice(output);
    assert.deepEqual(drive(voice, output, 0, 20_000, { activation: active(["follow-light", "you-are-safe-now"]) }), []);
    assert.match(voice.getStatus().reason, /"you-are-safe-now" is not an approved scenario template/);
  });

  test("a dispatch template is silent until the commander has entered the dispatch fact", () => {
    const output = new FakeOutput();
    const voice = new GuidanceVoice(output);
    const dispatch = active(["firefighters-dispatched"], "p-speak", false);
    assert.deepEqual(drive(voice, output, 0, 3000, { activation: dispatch }), []);
    assert.match(voice.getStatus().reason, /dispatch/);
    assert.deepEqual(drive(voice, output, 3100, 3100, { activation: dispatch, dispatchConfirmed: true }), [[3100, TEXT("firefighters-dispatched")]]);
  });

  test("speaks each template once per activation, then repeats no sooner than the repeat interval, keeping a gap between utterances", () => {
    const output = new FakeOutput();
    const voice = new GuidanceVoice(output);
    const said = drive(voice, output, 0, 30_000);
    const { repeatMs, gapMs } = DEFAULT_VOICE_TIMING;
    assert.deepEqual(said.slice(0, 2).map(s => s[1]), [TEXT("follow-light"), TEXT("stay-low")]);
    for (let i = 1; i < said.length; i += 1) assert.ok(said[i][0] - said[i - 1][0] >= gapMs, "gap between utterances");
    for (const text of [TEXT("follow-light"), TEXT("stay-low")]) {
      const times = said.filter(s => s[1] === text).map(s => s[0]);
      for (let i = 1; i < times.length; i += 1) assert.ok(times[i] - times[i - 1] >= repeatMs, `${text} repeat interval`);
      assert.ok(times.length >= 2 && times.length <= 3, `${text} repeats while guidance continues`);
    }
  });

  test("a single speak action is spoken once, however long it stays active", () => {
    const output = new FakeOutput();
    const voice = new GuidanceVoice(output);
    assert.equal(drive(voice, output, 0, 60_000, { activation: active(["stay-low"], "p-speak", false) }).length, 1);
  });

  test("never interrupts its own utterance", () => {
    const output = new FakeOutput();
    const voice = new GuidanceVoice(output);
    voice.update(update(0));
    output.speaking = true;
    assert.deepEqual(drive(voice, output, 100, 20_000), []);
    output.speaking = false;
    assert.deepEqual(drive(voice, output, 20_100, 20_100), [[20_100, TEXT("stay-low")]]);
  });

  test("abort cancels speech in progress and nothing more is said", () => {
    const output = new FakeOutput();
    const voice = new GuidanceVoice(output);
    voice.update(update(0));
    output.speaking = true;
    assert.deepEqual(drive(voice, output, 100, 30_000, { status: "aborted" }), []);
    assert.equal(output.cancels, 1);
  });

  test("muting while speaking cancels; pausing only stops new speech", () => {
    const output = new FakeOutput();
    const voice = new GuidanceVoice(output);
    voice.update(update(0));
    output.speaking = true;
    voice.update(update(100, { status: "paused" }));
    assert.equal(output.cancels, 0, "pause does not cut the drone off mid-sentence");
    voice.update(update(200, { enabled: false }));
    assert.equal(output.cancels, 1);
    assert.equal(output.spoken.length, 1);
  });

  test("reset cancels, and a new run forgets the old one (proposal ids are run-scoped)", () => {
    const output = new FakeOutput();
    const voice = new GuidanceVoice(output);
    voice.update(update(0));
    output.speaking = true;
    voice.update(update(100, { runId: null, status: null, activation: { kind: "none", reason: "No run" } }));
    assert.equal(output.cancels, 1);
    // The new run's guidance happens to reuse the id "p-guide": it is a different activation and is spoken.
    assert.deepEqual(drive(voice, output, 200, 200, { runId: "run-4" }), [[200, TEXT("follow-light")]]);
    assert.equal(voice.getStatus().lastSpoken?.proposalId, "p-guide");
  });

  test("when the harness stops the guidance it is speaking, the speech is cancelled", () => {
    const output = new FakeOutput();
    const voice = new GuidanceVoice(output);
    voice.update(update(0));
    output.speaking = true;
    voice.update(update(100, { activation: { kind: "stopped", proposalId: "p-guide", reason: "the harness marked it invalidated" } }));
    assert.equal(output.cancels, 1);
    assert.deepEqual(drive(voice, output, 200, 20_000, { activation: { kind: "stopped", proposalId: "p-guide", reason: "the harness marked it invalidated" } }), []);
  });

  test("with no local voice it stays silent and reports why", () => {
    const output = new FakeOutput();
    output.choice = chooseLocalVoice([{ name: "Google US English", lang: "en-US", localService: false, default: true, voiceURI: "Google US English" }]);
    const voice = new GuidanceVoice(output);
    assert.deepEqual(drive(voice, output, 0, 5000), []);
    assert.match(voice.getStatus().reason, new RegExp(`^${NO_LOCAL_VOICE}`));
  });
});

/* Voice selection and the browser output. */

const GOOGLE: VoiceLike = { name: "Google US English", lang: "en-US", localService: false, default: true, voiceURI: "Google US English" };
const SAMANTHA: VoiceLike = { name: "Samantha", lang: "en-US", localService: true, default: false, voiceURI: "com.apple.voice.compact.en-US.Samantha" };
const DANIEL: VoiceLike = { name: "Daniel", lang: "en-GB", localService: true, default: false, voiceURI: "com.apple.voice.compact.en-GB.Daniel" };
const THOMAS: VoiceLike = { name: "Thomas", lang: "fr-FR", localService: true, default: true, voiceURI: "com.apple.voice.compact.fr-FR.Thomas" };

describe("chooseLocalVoice", () => {
  test("a network-only list is silent with a reason, never a fallback to the remote voice", () => {
    const choice = chooseLocalVoice([GOOGLE]);
    assert.equal(choice.available, false);
    if (!choice.available) assert.ok(choice.reason.startsWith(NO_LOCAL_VOICE));
    assert.equal(chooseLocalVoice([]).available, false);
  });

  test("a mixed list picks the local voice even when the remote one is the default; en-US is preferred", () => {
    assert.deepEqual(chooseLocalVoice([GOOGLE, DANIEL, SAMANTHA]), { available: true, voiceId: SAMANTHA.voiceURI, label: "Samantha (en-US, local)" });
    assert.equal((chooseLocalVoice([GOOGLE, DANIEL]) as { voiceId: string }).voiceId, DANIEL.voiceURI);
  });

  test("local voices that cannot speak English are not used for the English templates", () => {
    assert.equal(chooseLocalVoice([THOMAS, GOOGLE]).available, false);
  });
});

class FakeUtterance {
  voice: unknown = null;
  lang = "";
  readonly text: string;
  constructor(text: string) {
    this.text = text;
  }
}

function fakeEnvironment(voices: readonly VoiceLike[]) {
  const spoken: FakeUtterance[] = [];
  const env: SpeechEnvironment = {
    speechSynthesis: { speaking: false, pending: false, getVoices: () => voices, speak: u => void spoken.push(u as FakeUtterance), cancel: () => undefined },
    SpeechSynthesisUtterance: FakeUtterance,
  };
  return { env, spoken };
}

describe("browserSpeechOutput", () => {
  test("sets the utterance's voice explicitly to the chosen local voice", () => {
    const { env, spoken } = fakeEnvironment([GOOGLE, SAMANTHA]);
    const voice = new GuidanceVoice(browserSpeechOutput(() => env));
    voice.update(update(0));
    assert.equal(spoken.length, 1);
    assert.equal(spoken[0].voice, SAMANTHA);
    assert.equal(spoken[0].lang, "en-US");
    assert.equal(spoken[0].text, TEXT("follow-light"));
  });

  test("with only network voices nothing reaches speechSynthesis.speak", () => {
    const { env, spoken } = fakeEnvironment([GOOGLE]);
    const voice = new GuidanceVoice(browserSpeechOutput(() => env));
    voice.update(update(0));
    assert.equal(spoken.length, 0);
    assert.match(voice.getStatus().reason, new RegExp(`^${NO_LOCAL_VOICE}`));
  });

  test("refuses a voice id that is not a local voice, and is safe where speech synthesis does not exist", () => {
    const { env, spoken } = fakeEnvironment([GOOGLE]);
    browserSpeechOutput(() => env).speak("Follow the light. It leads the way out.", GOOGLE.voiceURI);
    assert.equal(spoken.length, 0);
    const absent = browserSpeechOutput(() => undefined);
    assert.equal(absent.chooseVoice().available, false);
    assert.equal(absent.busy(), false);
    absent.speak("x", "y");
    absent.cancel();
  });
});
