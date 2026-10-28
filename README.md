# Cognitive Wedge, v2 prototype

A self-serve session that decides what a person does and what they hand to an AI agent. One chat, six gated states, a one-page report, a staff-only readiness score and a staff dashboard.

It sits in front of the native AI platform. It does not coach people to do their current role better, teach prompting, or build the platform.

## What is in this version

| Area | What it does |
|---|---|
| States | Orientation, Onboarding, Rupture, Deconstruction, Reconstruction, Re-entry. A state ends only when its gate passes on the stored records. No skipping, no going back. |
| Orientation | Fixed script, rendered by the server (the agent cannot paraphrase it). States the objective, steps, minutes and the data notice, and confirms the participant understood. |
| Prompts | `prompts/` holds the spec's prompts verbatim, one file per module. Edit a file, restart, done. |
| Time | Budgets 2 / 7 / 8 / 13 / 35 minutes (about 30 to the build, 65 total). Idle gaps over 30 minutes do not count. Fast mode starts when under 30% of a state's budget is left. |
| Classifier | A second small model call checks every Rupture and Deconstruction turn (reassures, advises, steers). A bad turn is regenerated twice, then replaced by a fixed question. |
| Records | The agent emits JSON in a `record` fence. The server strips it from the chat and stores it as append-only, versioned rows. |
| Tell-tale check | Rejected if it has no observable action or uses notice, feel, resist or mindful. |
| Resume | One email after 30 minutes idle, one after 24 hours, never a third. |
| Report | One page, built from the participant's own words. v1 at the end of Reconstruction, v2 to v4 after each check-in. Print to PDF from the browser. |
| Check-ins | Emailed magic links on day 3, 10 and 30. Short Witness sessions. |
| Readiness score | Rubric v0 (100 points), bands Strong 75+, Watch 55 to 74, At risk under 55, outlook after check-ins. Staff only. |
| Dashboard | `/staff`. Funnel and time, gate friction, results, re-entry, readiness, participants. Aggregates carry no free text. Participant pages show it and each open is logged. |
| Privacy | Staff allowlist with one-time sign-in links. Retention purge (default 12 months). A participant can delete their data from the session page. |

## How this differs from v0.3 on `main`

v2 is rebuilt from the updated spec, not patched from the v0.3 code, so the two do not share files. `main` is untouched; this lives on the `v2` branch.

Carried over: the Railway deploy (`railway.json`, now health-checked at `/healthz`), the model defaults, the per-turn classifier, the tell-tale and feeling checks.

Changed: SQLite instead of one JSON file per session; magic-link sign-in and a staff allowlist instead of a shared team password; a server-side state machine with gates checked on stored records; Orientation, time budgets, fast mode, resume emails, the one-page report, the readiness score and the dashboard (all new in this round).

**Not carried over from v0.3** (going by its README; confirm what you still want): web search during Reconstruction, attaching PDF or Word documents, saving the build as .md and .html files, Export run, the developer rail that jumps between states, and the shared-password gate. These are the first things to port if you want parity.

## Run it locally in two minutes (no API key)

```bash
npm install
MOCK_LLM=1 DEV_MODE=1 STAFF_EMAILS=you@example.com npm start
```

Open http://localhost:3000. In dev mode links are shown on screen and at `/dev/outbox`. `MOCK_LLM=1` swaps in a scripted stand-in so the team can click through every state and the dashboard before spending any tokens.

To skip waiting for check-ins: `curl -X POST localhost:3000/dev/advance -H 'Content-Type: application/json' -d '{"days":3}'` then open the day-3 link from `/dev/outbox`.

## Run it with Claude

```bash
cp .env.example .env     # fill in ANTHROPIC_API_KEY, BASE_URL, STAFF_EMAILS, SMTP_URL
node --env-file=.env server.js
```

## Deploy

GitHub stores the code. The app needs a Node host with a persistent disk, because it keeps a SQLite file. GitHub Pages cannot run it.

- **Railway** (what v0.3 used): connect the repo, pick the `v2` branch, add a volume mounted at `/data`, set the variables from `.env.example`.
- **Any container host** (Render, Fly.io, Azure, AWS): build the `Dockerfile`, mount a volume at `/data`, set the environment variables from `.env.example`, expose port 3000.
- **Single process.** Run one instance. Rate limits and the double-submit lock are in memory.
- **HTTPS.** Set `BASE_URL` to the public https address so cookies are marked Secure.

CI (`.github/workflows/ci.yml`) runs the tests on every push.

## Tests

```bash
npm test
```

Runs the whole six-state flow, check-ins on days 3, 10 and 30, resume emails, the classifier fallback, deletion, report trimming, the tell-tale check, gates, the score, and renders every dashboard view against real stored data. All with the scripted agent.

## Read this before the first live run

1. **The real agent has not been run yet.** Everything above was tested with the scripted stand-in. The first live session will show how well Claude follows the record format and the prompts. Run two or three yourselves first and read the `records` table. Rejections show up in the dashboard's Gate friction view.
2. **The task library is a starter list** in `data/task_library.json`. The spec requires every type to be pre-tested with the Performer prompt. Test each, then edit the list.
3. **Implementation choices not in the spec text.**
   - The Deconstruction gate also requires the `read_back` record, because it is the closing step and the module would otherwise hand over before it.
   - The record format (`src/prompts.js`, `RECORD_FORMAT`) is added to every prompt so the gates can read what the agent produces.
   - After a state change the next module speaks first, so the participant is not left at a blank box.
   - Four score signals are reported by the agent (`felt_reprompts`, `reproposals`, `read_back.done`, `linked_row`). Check them against transcripts on the first cohort.
   - The report header shows the participant ID and track. The spec lists a name; none is collected.
4. **Platform link.** Day 30 asks whether the build shipped and the operating model held. To also ask whether delegated tasks are being done on the platform, set `PLATFORM_CHECK=1` and `PLATFORM_NAME`. Off until the link is confirmed.
5. **The data notice** says nothing is used to assess the participant or their job. Confirm that with HR or legal before launch (`src/config.js`).
6. **The score is a prior, not a prediction.** The calibration plan is in the spec.
7. `node:sqlite` is marked experimental in Node 22. It works, and removes a native dependency. Swap in `better-sqlite3` if your host prefers.

## Layout

```
server.js            routes
src/engine.js        turns, gates, transitions, check-ins
src/gates.js         state gates and record checks
src/prompts.js       builds each system prompt
src/llm.js           Claude calls and the classifier
src/mock-llm.js      scripted stand-in agent
src/score.js         readiness rubric v0
src/report.js        one-page report
src/staff-data.js    rows for the dashboard
src/scheduler.js     resume emails, check-in emails, retention
prompts/             the spec's prompts, verbatim
public/              participant pages and the dashboard
test/                tests
```

Spec: Cognitive Wedge, Self-Serve Prototype: Agent Prompts and System Spec (v0.1, with the changes listed in the Alignment Summary).
