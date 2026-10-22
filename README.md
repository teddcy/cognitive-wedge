# Cognitive Wedge — local prototype (v0.3)

Runs entirely on your machine. The only outbound traffic is each agent turn, sent to the Claude API with your own key.

## Run it

Double-click `start.command`. The first run asks for your API key and saves it to `.env`. Your browser opens http://localhost:3000.

## What's in here

| File | What it is |
|---|---|
| `server.js` | Static server + API. `/api/sample` forwards a turn list to the Claude API (the leading module prompt becomes the system prompt) and streams the reply back; on Reconstruction turns it enables the API's web search tool. `/api/session/:id` reads and writes a session. `/api/session/:id/documents` stores files the participant attaches (PDFs go to the API as documents; Word and text as text). `/api/session/:id/artifacts` saves the build's output as .md and .html. No dependencies. |
| `public/index.html` | The whole prototype: five-state machine, module prompts (v0.3), gate checks on the stored record, the reassure/advise classifier, the feeling and tell-tale checks, build timers, the record rail, document intake, Export run, and dev controls. |
| `data/<session>.json` | One file per session: state, every record (versioned, with `prompt_version`), transcript, engine log. |
| `data/<session>/` | That session's attached documents and saved artifacts. |

## Settings (`.env`)

| Variable | Default | Role |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | required |
| `PORT` | `3000` | |
| `MODEL_DEFAULT` | `claude-sonnet-5-5` | the agent |
| `MODEL_QUICK` | `claude-haiku-5-5` | the turn classifier (falls back to the agent model if it fails) |
| `WEB_SEARCH_MAX_USES` | `8` | searches allowed per agent turn in Reconstruction ($10 per 1,000 searches) |

## v0.3 changes

- Module 1: the derived library's first entry is the identity task, as an artifact or, where the task is a presence, as a live eight-to-ten-turn exchange (an "effect"). The feeling line on the witness card must be a feeling; the gate checks it.
- Module 2: questions are asked in terms of the participant's task first; archaeology is capped at four steps chosen by them; "present/gone" is explained.
- Module 3: the agent has web search and the participant's documents; the artifact is written as a file and saved; a declined or shrunk build is proposed again once, then recorded as a ledger entry and `exceeded_alone:false`, and the module continues. A second "stop" closes the session.
- Engine: performer output captured from the turn that contains it; modules advance only when the agent emits `module_close`; classifier falls back to the agent model.

## Dev controls (right rail)

Jump to any state, open a re-entry checkpoint, Export run (Markdown report), Reset session, Show instruction (the exact text sent to the agent).

## Hosting for a team (Railway)

The repo carries a `Dockerfile` and `railway.json`. On Railway: New Project → Deploy from GitHub repo → this repo. Then in the service:

1. **Variables**: `ANTHROPIC_API_KEY`, `TEAM_PASSWORD` (what the team types to get in), `DATA_DIR=/data`.
2. **Volume**: add one and mount it at `/data`, so sessions, documents and artifacts survive redeploys.
3. **Settings → Networking**: generate a public domain. That's the link to share.

Everyone who opens the link sees a password screen; after that the app behaves as it does locally. Each run is saved under its participant's name and date and can be reopened from the session picker or exported. To pull all data down, use Railway's volume browser or the `/api/sessions` and `/api/session/:id` endpoints while signed in.

Spending is on your key. `MAX_TURNS_PER_SESSION` (default 400) and `WEB_SEARCH_MAX_USES` (default 8 per turn) are the caps.
