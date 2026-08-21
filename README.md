# omp-omniroute-provider-ext

OmniRoute provider extension for OMP 17.0.5+. Pi 0.80.10+ is also supported.

## Supported

- Loads every `/v1/models` entry before startup model resolution; owner metadata only enables combo routing status and direct Codex transport features.
- Uses each entry's `capabilities.effort_tiers` when OmniRoute supplies it.
- Otherwise exposes `low`, `medium`, `high`, `xhigh`, and `max`; override per entry in `omniroute.yml`.
- OMP uses catalog model names immediately at startup. Combo entries append a differing routed model ID to that name; direct models stay plain in both API formats.
- Direct `owned_by: codex` entries use OMP's native Codex Responses transport, including fast mode, WebSockets, and remote compaction V1 and V2.
- Drops OmniRoute's synthetic slow-start keepalive frames so they never surface as thinking text or as a routed model named `omniroute`. The keepalive still does its job: the early HTTP commit that keeps the connection alive is untouched.
- Logs a warning and lets the host continue when startup discovery fails.

Shared OmniRoute logic lives in `src/shared.ts`. Host-specific behavior lives in `src/pi.ts` and `src/omp.ts`.

## Install

### OMP

```bash
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

API format and reasoning-effort overrides live in `omniroute.yml` in that same agent directory—not in environment variables:

```yaml
format: responses # chat_completions (default) or responses
<model-id>: [low, medium, high, max]
"*": [low, medium, high, xhigh]
```

`responses` uses OpenAI's native Responses API at `/v1/responses` in both Pi and OMP. Omitting `format` keeps Chat Completions behavior.

The exact effort entry takes precedence over `*`, then OmniRoute's `effort_tiers`, then the built-in `low,medium,high,xhigh,max` default.

## Development

```bash
bun install
bun test
bun run check
```
