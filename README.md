# FlyFireFighter

**A rescue drone with a fly’s reflexes and a firefighter in command.**

FlyFireFighter is a firefighting simulation set in a digital twin of a building in Troy, NY. A drone investigates a report of someone trapped inside, proposes interventions, and guides the simulated occupant toward an exit when the route is supported.

The commander reviews each proposed window breach or water discharge before it can happen. The simulator records whether the occupant actually reaches the outdoor assembly point.

## Run locally

Requires Node.js 24.

```sh
npm ci
npm run dev
```

Open [localhost:3200](http://localhost:3200). Select **Optical-flow baseline** and **Local planner** for a run without external services. Then start a run, enter an incident report, and authorize the mission.

## What’s inside

- **Mission console** with a 3D building view, drone camera, synthetic thermal view, and commander approvals.
- **Fly-inspired flight** using a local FlyVis service, with an optical-flow alternative.
- **Optional integrations** for OpenAI Decisions and Gemini planning, MongoDB Atlas run storage, and Free-WiLi commander controls.
- **Results and replay** for reviewing decisions, interventions, and the simulated outcome.

The Troy exterior has a real reference. The interior, incident, and occupants are fictional.
