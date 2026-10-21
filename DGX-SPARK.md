# DGX Spark custom branch

This branch is a public, sanitized snapshot of a private DGX Spark deployment of
[sparkDash](https://github.com/MiaAI-Lab/sparkDash). It is based on sparkDash
2.50.0 and keeps the upstream Apache-2.0 license.

## What this branch adds

- **AI mode panel** on the local head Spark: start/stop local model modes through
  an external `ai-mode` command.
- **Model eval**: EvalScope jobs, speed/prefill/decode benchmarks, SVG eval and
  Gemini web tasks.
- **Simplified Chinese UI**: a runtime dictionary and text/attribute translator,
  enabled by default with an `EN / 中文` toggle in the bottom-right corner.

The upstream dashboard framework itself is unchanged apart from the additions
above.

## What is not included

Deployment-specific files are intentionally excluded from this repository:

- `.env` and access tokens
- `config/` (Spark inventory, encrypted keys, history and eval outputs)
- model weights, runtime logs and browser profiles
- the private `ai-mode` binary and Gemini driver

Create your own `.env` and `config/` for your hosts. See `.env.example` and the
upstream README for the base dashboard configuration.

## Optional integrations

The AI mode, EvalScope and Gemini panels are optional. Their external commands can
be configured with environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `AI_MODE_BIN` | `ai-mode` (from `PATH`) | External AI mode control command |
| `SPARKDASH_LAN_BASE` | `http://localhost` | Base URL used in generated service links |
| `EVALESCOPE_BIN` | `evalscope` (from `PATH`) | EvalScope CLI |
| `EVALESCOPE_OUTPUTS_DIR` | `~/.local/share/sparkdash/eval-outputs` | EvalScope report root |
| `EVALESCOPE_SERVICE_URL` | `http://127.0.0.1:9000` | EvalScope web service |
| `GEMINI_TASK_DRIVER` | `~/.local/share/sparkdash/gemini-web-task/driver.py` | Gemini browser driver |

The AI mode panel expects the dashboard to run as a host process (not in a
container) when it controls user services. None of these integrations are needed
for the base monitoring dashboard.

## Build and run

```bash
npm ci
npm run build
node server/index.js
```

The default bind is `0.0.0.0:5555`; set `PORT`, `BIND_HOST` and
`SPARKDASH_TOKEN` as described in the upstream README.

The Chinese dictionary is in `src/i18n/zh.ts`; UI strings not present there remain
in English. Demo prompt content is intentionally not translated.

## Upstream

- Upstream: https://github.com/MiaAI-Lab/sparkDash
- License: Apache-2.0 (see `LICENSE`)
- This branch: `dgx-spark-custom`
