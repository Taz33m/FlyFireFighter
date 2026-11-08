/**
 * About: what is real, simulated and fictional; the fly model; the cloud decider (OpenAI Decisions, Gemini,
 * consensus) and MongoDB Atlas persistence disclosures. Every statement describes implemented code or names
 * its status; nothing here is a performance claim.
 */

const FLYVIS_COMMIT = "0a69fa2fc8e1bfe1d837d722c252ab5f5d6fcbfa";
const CHECKPOINT_SHA256 = "d0e42857e738d0315897c2d50fde9eb3fb1a3fb1f071d55dfc13d53d72bccc3f";
const ARCHIVE_SHA256 = "71c78d4070556a536b13b23ee3139cd2788aa2a9d07d430a223b4edead281db1";

const PROVENANCE: readonly { readonly item: string; readonly status: "Real reference" | "Licensed asset" | "Simulated" | "Fictional"; readonly detail: string }[] = [
  { item: "Troy exterior", status: "Real reference", detail: "Peoples Avenue and Heffner Alumni House near RPI. The footprint and nearby streets come from OpenStreetMap (way 73141173); proportions were estimated from Wikimedia Commons photographs used as reference only. It is Blender massing, not a scan." },
  { item: "Interior", status: "Fictional", detail: "An authored two-level training interior inside the reference shell. It is not Heffner Alumni House's floor plan and says nothing about that building's occupancy or hazards." },
  { item: "Incident", status: "Fictional", detail: "The report, fire and occupant are invented. A fatal fire on 13th Street in Troy motivated the project; this is not that property, family or rescue." },
  { item: "Occupant", status: "Licensed asset", detail: "A fictional person drawn with a licensed scanned, rigged adult (Mike Alger, CC BY 4.0) animated with Microsoft Rocketbox clips (MIT). The character is not named after the scan's subject." },
  { item: "Aircraft", status: "Fictional", detail: "Modular rescue drone profiles (Scout S1, Tender T1) with bounded capabilities. Software cannot add heat tolerance, payload or flight performance an aircraft lacks." },
  { item: "Fire, smoke, water, glass, ventilation", status: "Simulated", detail: "A seeded 100 Hz simulator with a documented, simplified fire and smoke model. Ventilation and suppression interact, but the fire dynamics are not validated." },
  { item: "Drone camera", status: "Simulated", detail: "A calibrated pinhole camera (rgb-front/v1, 320 × 180) rendered from the aircraft's true pose. The same smoke reaches the controller's input frames." },
  { item: "Thermal view", status: "Simulated", detail: "A synthetic false-colour view (thermal-front/v1, 160 × 120) from simulated room, fire and occupant temperatures. Walls and glass block it; smoke attenuates it only weakly. It is for display and is not a controller input." },
  { item: "Range sensing and position", status: "Simulated", detail: "Lidar and ultrasound ranges with finite coverage, noise and missed returns, plus a separate position estimate with an error model. The indoor controller receives no GPS or true pose." },
  { item: "Outcomes", status: "Simulated", detail: "Only the independent simulation evaluator reads hidden truth. It decides whether the simulated occupant reached the exterior assembly point. Command never sees that truth." },
];

export function RealVsSimulated() {
  return <section className="doc-section" id="real" aria-labelledby="real-title">
    <h2 id="real-title">What is real, simulated and fictional</h2>
    <p className="lead">Troy training scene: <strong>real exterior reference; fictional interior and incident.</strong> Everything that moves, burns or is sensed is simulated in a digital twin.</p>
    <div className="table-wrap">
      <table className="data-table provenance-table">
        <caption className="sr-only">Provenance of each part of the demonstration</caption>
        <thead><tr><th scope="col">Part</th><th scope="col">Status</th><th scope="col">Details</th></tr></thead>
        <tbody>{PROVENANCE.map(p => <tr key={p.item}><th scope="row">{p.item}</th><td><span className={`tag prov-${p.status.split(" ")[0].toLowerCase()}`}>{p.status}</span></td><td>{p.detail}</td></tr>)}</tbody>
      </table>
    </div>
  </section>;
}

export function FlyModel() {
  return <section className="doc-section" id="fly" aria-labelledby="fly-title">
    <h2 id="fly-title">What came from the fly</h2>
    <p>The drone&apos;s rendered camera frames feed a pretrained <strong>FlyVis connectome-constrained model of the fly visual system</strong> (Lappalainen et al., <em>Nature</em> 634, 1132–1140, 2024). It models visual circuitry; it is not an uploaded whole fly brain. Its motion responses go to a readout that proposes braking and turning. Every proposal passes through the harness before any motion executes.</p>
    <dl className="facts doc-facts">
      <dt>Runtime</dt><dd>TuragaLab/flyvis at commit <code className="hash">{FLYVIS_COMMIT}</code> (code: MIT), running in a local Python service that a WebSocket client calls each 50 Hz frame.</dd>
      <dt>Checkpoint</dt><dd><code>flow/0000/000</code> · SHA-256 <code className="hash">{CHECKPOINT_SHA256}</code>, from <code>results_pretrained_models.zip</code> (SHA-256 <code className="hash">{ARCHIVE_SHA256}</code>, matching upstream&apos;s checksum).</dd>
      <dt>Weights licence</dt><dd className="warn">Unclear: upstream states no licence for the pretrained weights. They are used for <strong>local evaluation only</strong>. They are cached outside Git, not redistributed and not served by this app.</dd>
      <dt>Engineered readout</dt><dd>Implemented. A hand-designed mapping from FlyVis motion responses to brake and turn requests that lets integration run before training. Tuning it is not training a rescue policy.</dd>
      <dt>Trained readout</dt><dd>Not available in this build: training and the held-out comparison against optical flow are in progress. No trained-readout result is claimed until that comparison&apos;s saved bundle exists.</dd>
      <dt>Baseline and fallback</dt><dd>A conventional optical-flow baseline is the comparison controller. If FlyVis is unavailable mid-run, the run switches to it labelled “classical fallback — FlyVis unavailable”, and nothing after that is called fly-model inference.</dd>
    </dl>
    <p><strong>Ours:</strong> the readouts, the camera and smoke rendering, mission planning, the harness and approval rules, the simulator and the evaluator. <strong>Credited references:</strong> <a href="https://github.com/monishramj/flyby">FlyBy</a> was the reference for presenting camera → fly model → looming readout → flight control. No FlyBy code was copied, and its readout and controller are engineered components. <a href="https://github.com/pearwpi/Saranga">Saranga</a> informed the ultrasound requirement. Our ultrasound is a simulated range model, not the published echo network.</p>
  </section>;
}

export function DecisionsDisclosure() {
  return <section className="doc-section" id="deciders" aria-labelledby="deciders-title">
    <h2 id="deciders-title">What the cloud deciders do, and what is sent</h2>
    <p><strong>Mission planner</strong> in run setup picks who chooses: the local planner alone; OpenAI Decisions (model <code>gpt-6-luna</code>); Gemini (model <code>gemini-3.6-flash</code>); or <strong>consensus</strong>, which asks both models in parallel with the same request and uses their choice only when both chose the same candidate. A configured model <strong>chooses one of the mission candidates the application has already generated</strong>, such as which viewpoint to visit next. It cannot actuate the aircraft, approve an intervention or declare an outcome. The application turns the chosen id back into its own proposal. The harness then revalidates that proposal, and the commander must individually approve every glass-breaking, spraying or payload-release action. Local reflexes handle motion.</p>
    <div className="disclosure-grid">
      <div>
        <h3>Sent, per request</h3>
        <ul>
          <li>The run id and the evidence revision.</li>
          <li>A bounded, <strong>truth-free evidence summary</strong> built from the command belief: up to four reports in the reporter&apos;s own words (sanitised and truncated, sent as data and never as instructions); the position estimate&apos;s support, uncertainty and room; room observation coverage; possible-occupant tracks with confidence and uncertainty; observed hazards, openings and route assessments with their ages; and remaining endurance, water and ambient temperature.</li>
          <li>The harness-built candidate ids, each with a short application-written description. For Gemini, a response schema also limits the answer to those ids.</li>
          <li>Fixed instructions that never include caller or candidate text.</li>
        </ul>
        <p>Both models receive the same summary and candidates. OpenAI Decisions requests go to <code>api.openai.com</code> and Gemini requests to <code>generativelanguage.googleapis.com</code>; consensus sends one to each.</p>
      </div>
      <div>
        <h3>Never sent</h3>
        <ul>
          <li>Simulator truth, true positions or evaluator outcomes. None of these exist in the summary&apos;s source.</li>
          <li>Camera or thermal images, audio and FlyVis activity.</li>
          <li>The API keys. <code>OPENAI_API_KEY</code> and <code>GEMINI_API_KEY</code> are read only on the server by <code>/api/decisions</code>. Each goes only to its own provider, in that provider&apos;s auth header, and neither is sent to the browser or logged.</li>
        </ul>
      </div>
    </div>
    <p><strong>Fallback and labels.</strong> Without a key, or on refusal, an invalid choice, a 2-second timeout or an error, the deterministic <strong>local planner</strong> decides, and command shows “Local planner” with the reason. In consensus mode a disagreement, or either model failing, also leaves the choice to the local planner; one model&apos;s lone choice is never used. “OpenAI Decisions”, “Gemini” or “Consensus: OpenAI Decisions + Gemini” appears only when that choice was actually used. No model-written text is kept or shown: Gemini&apos;s one-sentence rationale is discarded. Authority and harness checks are identical in every mode, and the flight loop never waits for a cloud model.</p>
    <p><strong>Voice.</strong> Report intake is typed only in this build: no microphone is used and no audio leaves the machine. Any future voice intake will name its cloud providers before the microphone is used.</p>
  </section>;
}

export function AtlasDisclosure() {
  return <section className="doc-section" id="atlas" aria-labelledby="atlas-title">
    <h2 id="atlas-title">What is saved to MongoDB Atlas</h2>
    <p>Persistence is optional and off unless <code>MONGODB_URI</code> is set on the server. When it is, the workspace <strong>saves each finished simulation run once, automatically</strong>, after the simulation evaluator has posted the run&apos;s outcome, and a status line in the workspace says whether it was saved and, if not, why. <strong>UI-fixture runs are never saved</strong>: they are not simulation runs. The server stores only bundles labelled as simulation runs whose files match their recorded SHA-256 hashes, recomputes the outcome from the evaluator result rather than trusting the label sent, and never overwrites a stored run. The batch runner can upload its bundles the same way.</p>
    <div className="disclosure-grid">
      <div>
        <h3>Stored, per simulation run</h3>
        <ul>
          <li>The run record: configuration and seed, the evaluator outcome, violations, timing and stage times, and the git commit.</li>
          <li>The mission event log and the planner decision log (decider, model when recorded, latency and consensus agreement), one document per entry.</li>
          <li>The recorded replay of the simulated world, gzip-compressed in GridFS.</li>
          <li>Report text <strong>verbatim</strong>, inside the event log, and the commander id. Do not type real names, addresses or other personal details into reports.</li>
        </ul>
      </div>
      <div>
        <h3>Never stored</h3>
        <ul>
          <li>UI-fixture runs.</li>
          <li>Camera frames, audio or browser data.</li>
          <li>The connection string. <code>MONGODB_URI</code> is read only on the server, by the <code>/api/runs</code> routes and the scripts; it is never sent to the browser, returned or logged, and driver errors leave the server only as their class name.</li>
        </ul>
      </div>
    </div>
    <p><strong>Using saved runs.</strong> <code>/results</code> lists saved runs with aggregates computed in Atlas (completion, violations and median stage times by condition, controller, planner or scenario), and <code>/replay?atlas=&lt;runId&gt;</code> replays one. <strong>Search</strong> looks for words in event reasons and planner rationales across every saved run, using Atlas Search (fuzzy full text, ranked, with highlights). While the Search indexes are missing or still building it falls back to a plain text match and says so.</p>
    <p><strong>Access.</strong> The <code>/api/runs</code> routes admit only local callers, with rate limits and size caps. That is not authentication: a process on this Mac can read and add runs through them, and anyone holding the database user&apos;s credentials can read the stored runs. Runs are stored in the Atlas cluster that the connection string names, in the region chosen for it.</p>
  </section>;
}
