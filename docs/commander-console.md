# Free-WiLi commander console

November 8, 2026 · Physical buttons for the commander gates in [PRD.md](../PRD.md) · Status per [PLAN.md](../PLAN.md)

The commander can approve or reject the pending glass, water or payload action, and abort the mission, from the buttons of a Free-WiLi OG (Intrepid Control Systems) plugged into the presenting Mac by USB. The device shows a short line naming the decision and its countdown, and the app shows the full console screen beside the action card. The console is **only an input device for the human commander**: a button press becomes exactly the command the on-screen action card sends, and the mission worker and harness revalidate it like any other.

**Current state.** The board runs the official FreeWili OG firmware **v024** (MAIN 024, DISPLAY 020). The console's session code was driven against it from a script: it identified the board, received button levels, and the board acknowledged the device line ("GLASS 12") for a proposal. No button has been pressed in a test yet, and the console has not yet been used from the browser.

**What the device can show.** On v024 the only host-controlled display output is a one-line text overlay, and it shows about 8 characters (the user saw "Phase 3/" of a longer line). The firmware refuses file-backed images (`g\l` answers "NotSupported file-backed images are not supported on FreeWili OG"). Its custom panel, control and dialog commands (`g\c`, `g\b`, `g\e`, `g\f`) all answer `Failed`. Full-screen images like the LIFELINE UI are therefore not possible on this firmware (see [Full screens on the device](#full-screens-on-the-device)).

## What it does

| Button | Gesture | Command sent |
| --- | --- | --- |
| Green | press | Approve the decision shown, once the review delay has passed. |
| Yellow | press | Reject the decision shown. |
| Red | press twice within 0.6 s (the Esc Esc window), or hold 1 s | Abort the mission. One tap only primes it. |
| Gray, blue | — | Nothing. |

**Screens** (`console/screens.ts` picks one, `console/render.ts` draws it at 320 × 240 with Canvas 2D in the app's colours and the brand's fly mark; the action card column shows it under "Console screen"):

| Screen | When | Device line (≤ 8 characters) |
| --- | --- | --- |
| No run | no mission view | `NO RUN` |
| Standing by | awaiting the report or authorization | `STANDBY` |
| Phase (Report … Outside, with progress dots; a halt pill such as HOLD or REROUTE) | running, nothing pending | `SEARCH`, `SUPPRESS`, `HOLD`… |
| Review hold | a decision appeared less than the review delay ago; approve chip shows HOLD… | `GLASS ..` |
| Pending approval: BREAK GLASS, SPRAY WATER or RELEASE PAYLOAD | a decision is waiting. The card shows an icon, the target, a coverage bar with %, one "Unseen: …" line, a countdown ring (12 steps) with seconds, the digest prefix, and chips ✕ REJECT · ✓ APPROVE · ⏹ ABORT ×2 above their buttons | `GLASS 12`, `SPRAY 7`, `DROP 17` |
| Approved / Rejected | for 3 s of mission time after the harness records it, with who decided and whether via console or screen | `APPROVED`, `REJECTED` |
| Mission aborted (full red) | mission status aborted | `ABORTED` |
| Console disconnected | the console dropped (mirror only) | — |

The renderer's technique (a fixed 320 × 240 vocabulary of calm, full-screen states, with labels above the physical buttons) is adapted from the author's earlier LIFELINE ambient UI (MHacks, `docs/wili-ambient-ui.md`). The artwork and code here are new.

## Setup

1. Use Chrome or Edge on this Mac with the app at `http://127.0.0.1:3200` (Web Serial needs a secure context; 127.0.0.1 counts).
2. Close any other program holding the board's ports (a `freewili` or `onewili` script, a serial terminal, App Explorer).
3. In the action card column, click **Connect console**. The browser lists only the board's MAIN CPU, which offers two ports. Choose the one named **"Board CDC"**, not "FWOG binary events". If the chooser does not show names, pick either: the wrong one is refused within 2 seconds with a message saying so. Then click Disconnect and connect again.
4. The status line should read "Connected (FWOG main ogfw 024): GREEN approve…". When a decision is waiting, the device line and the mirror show it. The line under the status says what the device shows and when it has confirmed the proposal.
5. **Disconnect console** stops the button stream, clears the text from the device screen, and closes the port.

## Safety rules, and how the code enforces them

- **Same path as the action card.** Approve, reject and abort are built with the action card's builders in `src/components/mission/approval.ts`, bound to the pending proposal's id and digest at the view tick. They are sent through the same `send` to the mission worker, where the harness checks the digest, expiry and current evidence (`console/decide.ts`).
- **Never more than the screen.** A console approval needs:
  - a decision for this live run;
  - the digest the action card is showing, and the action card's review delay (`APPROVAL_ARMING_MS`);
  - no dialog covering the card;
  - the device display to have confirmed the same digest, plus the review delay counted from that confirmation.

  A changed or stale proposal is refused because the digest is bound.
- **Display confirmation.** The device counts as showing a proposal only when the firmware acknowledges the show-text write made for that proposal (`[g\p … Ok 1]`). One show-text write is in flight at a time, so an acknowledgement cannot be credited to the wrong screen. A new proposal clears the confirmation at once. A refused acknowledgement, or none within 2 s, leaves it cleared (`console/session.ts`). On v024 the device line names the action kind and seconds left, not the digest, because 8 characters are all it shows. Digest binding is enforced, as for the keyboard, by the digest on the action card and the approval builders.
- **Display rate.** At most five screen writes per second. Once an acknowledgement takes longer than 150 ms, the limit drops to one per second for the rest of the connection. The countdown refreshes at most once a second.
- **Nothing automatic.** The first button reading after connecting or reconnecting is a baseline: a button already held must be released and pressed again. Only an observed released-to-pressed edge counts. These are ignored:
  - repeated frames;
  - frames with an older sequence number (responses and events share one counter);
  - contact bounce (a press within 60 ms of a release);
  - green and yellow pressed together.

  The console sends at most one approve or reject per digest (`console/buttons.ts`, `console/decide.ts`).
- **Abort is an e-stop.** It is always available while the run is live, including under a dialog and while other buttons are held. It needs a deliberate gesture, a double press or a 1 s hold, and fires once per gesture.
- **Attribution.** The commander id carries the source, for example `commander-1 (Free-WiLi console)`, and the reject and abort reasons name the button. The event log shows "Approved by commander-1 (Free-WiLi console)…". The harness does not compare the id with the envelope's commander, so the attributed id is accepted as before.
- **Disconnect.** If the device is unplugged or the port fails, the panel says "Console disconnected". All console state (button baseline, display confirmation) is dropped, and the on-screen controls and keyboard shortcuts keep working. A reconnect starts from scratch. A user disconnect also clears the text from the device screen, so no stale proposal stays on it.
- **Identify before writing.** After opening, the session writes only the identify query (`?`). It sends nothing else unless the port answers `FWOG main ogfw NNN` with NNN ≥ 023. Any other outcome gets no further writes: the display CPU's heartbeat, WiLiDoro's heartbeat, another identity, an older version, or silence for 2 s.
- **Write allowlist on MAIN** (unchanged: no file upload was added, because v024 cannot show uploaded images). MAIN also drives the sub-GHz radios, IR and GPIO. The session can write only these commands (`console/stock-protocol.ts`):
  - Ctrl-B;
  - identify (`?`);
  - button stream (`g\o`);
  - read all buttons (`g\u`);
  - show text (`g\p`);
  - clear the text overlay (`g\t`).

  No radio, IR, GPIO, LED, simulated keypress, file, settings or firmware command can be expressed. Display text is reduced to one line of printable ASCII with backslashes replaced, so harness text cannot carry a newline, Ctrl-B or a menu path into another command. A write that does not finish in 2 s stops all further writes for that connection.
- **Never 1200 baud.** Opening an RP2040 USB serial port at 1200 baud reboots that CPU into its UF2 bootloader. The console always opens at 1,000,000 baud (the official libraries' rate; USB serial otherwise ignores it) and refuses 1200 outright.

## Device findings (this Mac, November 8, 2026, official OG firmware v024)

- **Enumeration.**
  - `FWOG main ogfw 024` (VID 0x093C, PID 0x2054, serial E463A8574B563639). It has two CDC interfaces: "Board CDC" (interfaces 0/1, `/dev/cu.usbmodem11101`) and "FWOG binary events" (2/3, `/dev/cu.usbmodem11103`). It also has "FWOG storage" (mass storage).
  - `FWOG display ogfw 020` (VID 0x093C, PID 0x2055, `/dev/cu.usbmodem11201`).
  - An FTDI `FreeWili` interface (0x0403/0x6014, `/dev/cu.usbserial-FW5414`).
- **Protocol.** Since v023 the OG firmware uses the shared menu that the official OneWili library documents (github.com/freewili/onewili, `python/onewili/transport.py` and `framing.py`; the v023 notes say "top-level GUI button reads remain the supported paths"). Each command is Ctrl-B (back to the menu root, quiet mode), then a backslash path, an optional argument, and a newline. Host commands go to MAIN, which reaches the display CPU over its internal link. The legacy `freewili` 0.0.51 SDK's multi-line display-port protocol does not apply. The display CPU's port only prints `[ogfw_display] alive link=1 ioexp=1 lcd=1 sel=0 evq=0 drop=0`. The binary events port did not answer `?`.
- **Recorded on "Board CDC":**
  - `?` → `[? 0D93A5AC856884B8 1 FWOG main ogfw 024 1]`
  - `g\u` → `[g\u 0D93A5B3B0BEC940 2 0 0 0 0 0 1]` (gray, yellow, green, blue, red)
  - `g\o 100` → `[g\o … Ok 1]`, followed by `[*button … 0 0 0 0 0 1]` events
  - `g\o 0` → `Ok`
  - `g\p <text>` → `[g\p … Ok 1]`
  - `g\t` → `Ok`
- **Button stream cadence.** With no button pressed, the stream reported about once a second whether 20 ms or 100 ms was requested. It is unknown whether it also reports immediately on a change. So the session also reads all buttons every 100 ms. In the scripted run, 39 reads in about 4 s were all answered.
- **Display commands probed on v024:**
  - `g\l nosuchfile.fwi` → `NotSupported file-backed images are not supported on FreeWili OG 0`.
  - `g\c\a` (add panel), `g\b\e` (add text), `g\c\f` (menu text), `g\c\c` (show panel), `g\c\e` (latched buttons) and `g\f\a` (message box) each → `Failed 0`.
  - The main filesystem (`h\x\l /`) holds `settings.txt`, `scripts`, `data` and `radio`. It has no `/images`.
- **Not yet verified:** that a physical press shows up in `g\u` and `[*button]` with the expected column (the order comes from OneWili's `owGUIButton` enum). The device was left showing `STANDBY`.

## Full screens on the device (legacy FREE-WILi firmware v54)

On November 8, 2026 the user reflashed the board by hand to LIFELINE's legacy firmware: flash_nuke, then DisplayCPU v54, then MainCPU v54. The files came from the official freewili/freewili-firmware repository at commit 9208bf46 (v54 is not a GitHub release), and their git blob ids were verified. SHA-256: FreeWiliDisplayV54.uf2 `60037880…bbb389`, FreeWiliMainV54.uf2 `d14f7471…e7d80`, flash_nuke.uf2 `f3c3b6a6…ad5b49d`. Returning to OG v024 needs FreeWili OG App Explorer, which is Windows-only, to reinstall the OG display bootloader.

**How it works.** Connect the console to the **DisplayCPU** port. The session identifies "DisplayCPU v54" and switches to images. OG v024's MAIN "Board CDC" still gets the one-line text, chosen automatically by identity.

- At connect it installs a fixed set of 16 full screens, content-addressed `/images/FF<6 hex>.FWI` (8.3 names), in priority order. The three decision templates (BREAK GLASS, SPRAY WATER, RELEASE PAYLOAD) go first and are read back byte for byte. Then standby, approved, rejected, aborted, no run and the eight phase screens follow; for these the firmware's own CRC check is trusted. The app shows "Loading console screens n/16".
- A waiting decision shows its kind's template at once (one image command, about 44 ms). Its acknowledgement confirms the decision for console approval, like the v024 line. The digest binding stays with the action card and the approval builders. The template carries no per-proposal numbers; the full card stays in the app's mirror.
- Until a screen is installed, the device shows its text line instead.
- Shows are rate-limited (5/s, 1/s if slow), and repeated after any button edge, because the firmware's own GUI also reacts to buttons.
- Buttons come from the legacy read-buttons command and button events.

Measured on the board: upload 4.5 s, readback 4.0 s, show 44 ms per 153,624-byte screen. Every legacy command starts with Ctrl-B; without it, a menu stays in its last submenu.

**Allowlist on v54:** identify, button reads and button events, show text, reset display, upload, readback and show of `FF??????.FWI` in `/images` only. Nothing is deleted. Payload bytes are written only after the firmware's "Send File Now" frame.

## What is implemented and what is not

| Item | Status |
| --- | --- |
| v024 protocol parser, write allowlist, text sanitiser | Implemented. Unit-tested with frames recorded from this board. |
| Identify-first handshake; wrong port, WiLiDoro, old firmware and silence refused | Implemented and unit-tested. On hardware, the session refused the binary events port and the display port, and accepted Board CDC. |
| Gestures (baseline, edges, debounce, chord, double press, hold), button polling | Implemented and unit-tested. Polling exercised on hardware with no press. |
| Same-path approve, reject, abort with digest, review delay, device confirmation, dedupe, attribution | Implemented. Unit-tested against the `approval.ts` builders. |
| Screen state machine, 320 × 240 renderer (app mirror), v024 device line, display rate limit | Implemented and unit-tested; the renderer is tested against a recording canvas stand-in. A contact sheet renders every screen for review. On hardware, the board acknowledged "GLASS 12" and the session confirmed the proposal. |
| `.FWI` encoder | Implemented. It matches the official `fwi-convert` byte for byte on a fixture. Not used on v024. |
| Image upload, readback and show on the device | **Not possible on v024** (file-backed images NotSupported); not implemented. |
| Web Serial adapter (MAIN filter), Connect control, status, canvas mirror | Implemented. Typechecked and linted, not yet used in a browser. |
| Physical presses → gestures on hardware | **Not verified.** Needs someone to press the buttons. |
| LEDs, sound, IR, radios | Not used, deliberately. |

## Files

- `src/components/mission/console/stock-protocol.ts`: v024 frame parser, write allowlist, display text sanitiser
- `src/components/mission/console/buttons.ts`: button levels to gestures
- `src/components/mission/console/decide.ts`: gestures to the action card's commands
- `src/components/mission/console/screens.ts`: screen state machine and the v024 device line
- `src/components/mission/console/render.ts`: Canvas 2D renderer for the 320 × 240 screens
- `src/components/mission/console/ConsoleScreenCanvas.tsx`: the mirror canvas (at most 640 × 480 backing store)
- `src/components/mission/console/fwi.ts`: `.FWI` encoder for image-capable firmware
- `src/components/mission/console/session.ts`: one serial connection (identify, poll, display, disconnect)
- `src/components/mission/console/web-serial.ts`: Web Serial adapter and MAIN port filter
- `src/components/mission/console/CommanderConsole.tsx`: connect control, status, screen mirror
- `src/hooks/useCommanderConsole.ts`: React wiring to the mission worker's `send`
- Tests: `src/components/mission/console/*.test.ts` (`node --test`, no hardware)
