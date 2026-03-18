# Voice V2 Plan

## Goal

Move the current bridge from a single-turn `/listen` workflow toward a faster, more human conversation loop.

The main targets are:

- lower perceived latency
- more natural voice output
- less command friction
- better interruption handling
- a cleaner architecture for real-time audio

## Current bottlenecks

The current flow is reliable enough for a prototype, but it is still batch-oriented:

1. user runs `/listen`
2. bot waits for one spoken turn
3. audio is written to disk
4. Whisper transcribes after capture ends
5. OpenClaw replies after the full transcript is ready
6. macOS `say` renders full reply audio
7. bot plays the finished file

This creates delay at every stage and makes the interaction feel more like "record and answer" than a live conversation.

## V2 architecture

### 1. Continuous session mode

Add a long-running voice mode instead of requiring `/listen` for every turn.

Suggested commands:

- `/start-conversation`
- `/stop-conversation`
- `/interrupt`

Behavior:

- bot joins once
- bot keeps a conversation loop active for the current guild/channel
- bot listens automatically for new speech
- bot responds without needing a manual command every turn

### 2. Voice activity detection

Replace the current one-shot silence-stop capture with proper VAD.

Goal:

- detect when a speaker starts talking
- detect when they stop
- avoid waiting for a slash command every turn
- reduce dead time before transcription

Possible options:

- local VAD with a lightweight Node/native binding
- external VAD sidecar process
- model-based VAD if already available in your speech stack

Important requirement:

- keep VAD state per guild/channel
- only trigger on the intended speaker policy

Speaker policy options:

- anyone in the channel
- only the user who started conversation mode
- active speaker handoff

For V2, the safest first version is:

- only the user who started the conversation mode

### 3. Faster STT path

The current `pcm -> wav -> whisper-cli` flow is simple but slow.

V2 should aim for one of these:

- streaming Whisper-compatible transcription
- chunked transcription with rolling partials
- an always-warm STT worker process instead of fresh CLI execution each turn

Recommended first step:

- keep Whisper local
- move transcription into a warm worker process
- reduce file-based handoff where possible

That gives a meaningful speedup without fully rewriting the speech stack on day one.

### 4. ElevenLabs TTS

Replace or optionally supplement macOS `say` with ElevenLabs for more natural output.

Benefits:

- much more human voice quality
- better emotional tone
- better fit for an assistant experience

Recommended implementation:

- add optional provider selection:
  - `TTS_PROVIDER=say`
  - `TTS_PROVIDER=elevenlabs`
- add env vars:
  - `ELEVENLABS_API_KEY`
  - `ELEVENLABS_VOICE_ID`
  - optional model/output settings

Important:

- keep `say` as fallback
- do not make ElevenLabs mandatory

### 5. Interruptible playback

Human-feeling conversation needs barge-in.

That means:

- if the user starts speaking while the bot is replying, stop playback immediately
- discard the unfinished reply
- begin a new capture/transcribe/respond cycle

This is one of the biggest UX improvements after TTS quality.

Needed changes:

- playback state per guild
- interruption event from VAD
- safe cancellation of current audio player/resource
- protection against race conditions between playback stop and next capture start

### 6. Lower-latency OpenClaw path

The OpenClaw step is valuable for sessions and agent behavior, but voice UX needs aggressive latency control.

Options:

- keep current OpenClaw session model, but send shorter user turns
- stream partial text to OpenClaw if supported later
- use a lower-latency agent profile for voice turns
- cap overly long replies before TTS

Recommended first rule:

- voice replies should be short by default
- optimize the agent prompt for spoken answers, not long text answers

### 7. Runtime state model

V2 needs stronger state separation.

Add a dedicated conversation state object per guild:

- mode active/inactive
- channel id
- owner user id
- current speaker state
- capture state
- transcription state
- LLM request state
- playback state
- interrupt token / cancellation token
- OpenClaw session ref

This should live separately from the current basic session map.

## Recommended delivery phases

## Phase 1: Better voice output

Goal:

- improve quality fast without rewriting everything

Build:

- ElevenLabs provider integration
- `TTS_PROVIDER` switching
- shorter spoken reply formatting

Success criteria:

- same current `/join -> /listen -> /leave` flow
- noticeably better voice quality

## Phase 2: Faster turn loop

Goal:

- reduce latency within the current command model

Build:

- warm STT worker
- less disk-heavy audio handoff
- playback cancellation groundwork

Success criteria:

- current `/listen` feels meaningfully faster

## Phase 3: Conversation mode

Goal:

- move from manual turns to a human-feeling session mode

Build:

- `/start-conversation`
- `/stop-conversation`
- VAD-based automatic capture
- one active conversation loop per guild

Success criteria:

- no need to run `/listen` every turn

## Phase 4: Barge-in and polish

Goal:

- make the interaction feel conversational instead of sequential

Build:

- interruptible TTS playback
- better turn-taking
- tighter UX and embeds

Success criteria:

- user can interrupt the bot naturally

## Suggested first implementation order

If you want the highest impact with the lowest rewrite risk:

1. ElevenLabs TTS provider
2. shorter reply shaping for spoken output
3. warm STT worker
4. conversation mode state model
5. VAD auto-listen
6. interruptible playback

## New config to expect

Likely new env vars:

```env
TTS_PROVIDER=say
ELEVENLABS_API_KEY=
ELEVENLABS_VOICE_ID=
VOICE_MODE_DEFAULT=manual
VOICE_REPLY_MAX_CHARS=240
```

## Risks

- VAD and playback interruption can create race conditions if layered onto the current flow too quickly
- ElevenLabs adds a network dependency and cost
- streaming or worker-based STT increases implementation complexity
- conversation mode needs stronger cleanup logic on disconnects, restarts, and channel moves

## Recommendation

Do not try to jump straight from the current bot to full real-time conversation in one patch.

The safest path is:

1. improve TTS first
2. reduce latency second
3. add conversation mode third
4. add interruption last

That keeps the current bot usable while evolving toward a much more human voice experience.
