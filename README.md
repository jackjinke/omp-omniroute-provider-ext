# omp-omniroute-provider-ext

OmniRoute provider extension for OMP 17.2.2+. Pi 0.80.10+ is also supported.

## Supported

- Loads every `/v1/models` entry before startup model resolution; owner metadata enables combo routing status and Codex transport features.
- Uses each entry's `capabilities.effort_tiers` when OmniRoute supplies it.
- Otherwise exposes `low`, `medium`, `high`, `xhigh`, and `max`; override per entry in `omniroute.yml`.
- OMP uses catalog model names immediately at startup. Combo entries append a differing routed model ID to that name; direct models stay plain in both API formats.
- OMP's native Codex Responses transport applies to direct `owned_by: codex` entries, model IDs starting with `gpt-` or containing `/gpt-`, and IDs listed in `codex_transport`. This uses SSE with fast mode, encrypted-reasoning replay, and remote V2 compaction; WebSockets are disabled for OmniRoute.
- Drops OmniRoute's synthetic slow-start keepalive frames so they never surface as thinking text or as a routed model named `omniroute`. The keepalive still does its job: the early HTTP commit that keeps the connection alive is untouched.
- Logs a warning and lets the host continue when startup discovery fails.

Shared OmniRoute logic lives in `src/shared.ts`. Host-specific behavior lives in `src/pi.ts` and `src/omp.ts`.

OMP 17.2.2 is the minimum because earlier versions do not load extension-registered providers in `omp commit`.

## Install

### OMP

```bash
omp install git:github.com/jackjinke/omp-omniroute-provider-ext
```

If this was previously installed from the renamed `omniroute-pi-adapter-ext` repository URL, remove the existing package before switching sources:

```bash
omp plugin uninstall omp-omniroute-provider-ext
omp install git:github.com/jackjinke/omp-omniroute-provider-ext
```

### Pi

```bash
pi install git:github.com/jackjinke/omp-omniroute-provider-ext
```

Restart Pi or OMP after installation. The package manifest selects the correct host adapter automatically.

For local development instead:

```bash
omp -e /absolute/path/to/omp-omniroute-provider-ext/src/index.ts
pi -e /absolute/path/to/omp-omniroute-provider-ext/src/pi-entry.ts
```

## Use

```bash
export OMNIROUTE_API_KEY='...'
# Only needed when OmniRoute is not local:
export OMNIROUTE_BASE_URL='http://your-omniroute-host:20128'
```

Choose any entry returned by your OmniRoute instance:

```bash
omp --model omniroute/<model-id>
pi --model omniroute/<model-id>
```

For persistent configuration, set the discovered `omniroute/<model-id>` in the host's normal model settings. Do not add a hardcoded OmniRoute model list.

## Optional settings

Environment settings can be exported in your shell or placed in the host agent directory's `.env` file: `~/.pi/agent/.env` for Pi and `~/.omp/agent/.env` for OMP (or the corresponding custom/profile agent directory).

```bash
OMNIROUTE_STARTUP_TIMEOUT_MS='15000'
```

API format, Codex transport selection, and reasoning-effort overrides live in `omniroute.yml` in that same agent directory—not in environment variables:

```yaml
format: responses # responses (default) or chat_completions
codex_transport: [combo/coding]
<model-id>: [low, medium, high, max]
"*": [low, medium, high, xhigh]
```

`responses` uses OpenAI's native Responses API at `/v1/responses` in both Pi and OMP. Omitting `format` keeps Responses behavior; set `format: chat_completions` to use Chat Completions.

`codex_transport` is an OMP-only list of exact catalog model IDs, primarily intended for combos whose members are Codex-compatible. Codex-owned entries and IDs starting with `gpt-` or containing `/gpt-` use the Codex transport automatically. For a combo, OmniRoute still chooses the member for each attempt; encrypted reasoning and real Codex compaction are guaranteed only when routing stays on Codex-compatible members. This setting does not enable OMP Code Mode.

The exact effort entry takes precedence over `*`, then OmniRoute's `effort_tiers`, then the built-in `low,medium,high,xhigh,max` default.

## Development

```bash
bun install
bun test
bun run check
```
