# dsh-smooth-stream

> **Main rebuild candidate 0.11.0-rebuild.3**: Based on `origin/main` commit `d0c96a4651e175d393799168c11b42a9a743649a` (baseline package version 0.10.9), with unified session playback rebuilt inside the independent injection plugin. The earlier candidate based on the 0.10.10 fix branch is superseded for this task. See the [candidate notes](docs/changes-0.11.0-rebuild.3.md). This candidate has not been installed or reviewed on a live UI; the older performance and feel descriptions below are not evidence of candidate device validation.

> **Transform jumpy AI outputs into a calm, teleprompter-smooth reading experience.**  
> Physics-based stream rendering and zero-reflow viewport tracking for the DeepSeek Harness (`dsh`) Web UI.

English · [中文](README.md) · [Homepage](https://laplace-bit.github.io/dsh-smooth-stream/) · [How It Works](https://laplace-bit.github.io/dsh-smooth-stream/how-it-works.html) · [npm](https://www.npmjs.com/package/dsh-smooth-stream)

---

## The Silky Smooth Feel

Whether reviewing hundreds of lines of complex reasoning or watching fast-paced code generation, `dsh-smooth-stream` delivers a **calm, continuous, and fatigue-free** reading experience:

- **Organic, fluid text expansion**: No more walls of text abruptly snapping onto your screen. Words glide in with an organic rhythm that feels alive yet unhurried.
- **Effortless eye tracking**: The viewport glides as if on a precision-damped rail. Line wraps and code blocks no longer jar your eyes, eliminating cognitive friction.
- **Adaptive cadence**: Leisurely during slow arrivals, smoothly accelerating during high-volume bursts—keeping your screen composed no matter how fast tokens arrive.

---

## Why this exists

Large language models emit tokens in discrete network bursts: hundreds of characters can arrive within milliseconds, followed by tens of milliseconds of silence.

Traditional chat UIs bind DOM rendering and scrolling directly to arrival events, causing two jarring failure modes:
1. **Visual snapping**: Text blocks, tables, and code snippets pop in abruptly, forcing the reader's eye to constantly re-acquire focus.
2. **Scroll jitter and reflow storms**: Hard `scrollTop = scrollHeight` jumps or interrupted `scroll-behavior: smooth` animations restart their easing curves on every chunk, leading to sluggish lag and severe layout thrashing.

`dsh-smooth-stream` decouples **text reveal cadence** from **viewport motion** into two independent dynamical systems, integrating them per animation frame (`requestAnimationFrame`) to ensure uninterrupted continuity.

---

## Architecture & Mechanics

```
[ Model SSE Stream ]
         │
         ▼
 ┌─────────────────┐       Backpressure Damping (0.55x ~ 1.0x)       ┌─────────────────┐
 │  Reveal Engine  │ ◄────────────────────────────────────────────── │  Follow Engine  │
 └────────┬────────┘                                                 └────────┬────────┘
          │ Fractional character debt integration                             │ 2nd-order damped spring (k=130, c=24)
          ▼                                                                   ▼
 [ Progressive DOM Reveal ] ────────────────────────────────────────► [ GPU Compositor Transform ]
  (Per-frame visual delta ≤ 8px)                                       (Zero Reflow / Pure Composite)
```

### 1. Dynamic Adaptive Reveal Engine
- **Fractional character debt**: Evaluates reveal velocity from current backlog ($v = 90 + \text{backlog}^{1.25} \times P$). Leisurely when arrival is slow; accelerates smoothly during bursts without ever dumping text walls.
- **Wrap smoothing**: Caps per-frame visual displacement to $\le 8\text{px}$ during line wraps and new block arrivals, spreading sudden $24\text{--}28\text{px}$ layout steps across several frames.
- **Uniform completion drain**: When the generation finishes, the residual queue drains at a steady speed, creating clean transitions between body, reasoning, and tool calls.

### 2. GPU-Driven Damped Spring Follower
- **Second-order spring physics**: Uses a sub-stepped damped spring ($k=130, c=24, m=1$) to convert discrete height changes into a continuous trajectory.
- **Zero-reflow viewport tracking**: Keeps the real scrollport pinned to the bottom while absorbing residual visual lag entirely via `transform: translate3d` on the message container. No layout-triggering properties are touched during follow.
- **Closed-loop backpressure**: If visual lag fills the predictive runway ($\approx 72\text{px}$), the follower throttles reveal speed (down to $0.55\times$), ensuring text expansion never outpaces the viewport spring.
- **Stall resilience & ProMotion parity**: Clamps elapsed physical time ($\Delta t \le 32\text{ms}$) during main-thread stalls to prevent teleporting catches. Settling dynamics are identical across 60Hz and 120Hz (ProMotion) displays.

### 3. Turn Lifecycle Auto-Collapse
- Reasoning and tool executions remain expanded while streaming.
- Once a turn settles, intermediate processes cleanly fold behind a minimalist `Processed in Xs` summary row, keeping the conversation view focused on final answers.

### 4. Session-Scoped Protocol Playback (0.11.0-rebuild.3 Candidate)

This candidate uses one playback queue per injected Flow and orders visible content by conversation protocol metadata rather than DOM grouping. See the [candidate notes](docs/changes-0.11.0-rebuild.3.md) for behavior and verification boundaries.

- Response text, expanded reasoning, and tool cards follow protocol sequence; tool cards retain the official renderer and enter atomically.
- A predecessor releases its successor only after an explicit block-end or durable settlement boundary. Network silence or a temporarily drained character buffer is not treated as protocol completion.
- Initial history and older-page navigation display without replay. Background recovery applies the selected `replay`, `catch-up`, or `latest` policy to a finite batch.
- The candidate retains the mainline renderer fallback. This page's inherited performance and motion claims are not evidence of live-device validation for this candidate.

### 5. Running Status & Bottom Baseline Stabilization
- **Accurate DSH Status Container Targeting**: Specifically matches Harness's native running indicator via `[data-chat-running]` (including the "Deep diving..." status and `runningDivider`), strictly isolating it from ordinary message transform surfaces (`shiftSurfaces`).
- **Synchronized Trajectory Position on Text Wraps**: Immediately steps `trajectoryPositionPx` in lockstep with wrap growth (`floorNow - trajectoryFloorPx`), preserving visual shift continuity and completely eliminating the abrupt upward jerk when lines wrap.
- **Elimination of Artificial Height Stacking on Tool/Command Transitions**: Removes the buggy `lastStatusHeightPx` accumulation onto `reservePx` during step transitions, putting an end to the sudden upward bottom ballooning whenever a tool or command is invoked.
- **Strict Clamping on Runway Offset**: Caps the layout runway offset within `requestedRunwayPx` to prevent concurrent wrap heights from leaking into padding calculations, guaranteeing that the running status and divider remain rock-solid across all execution stages.

---

## Visual Comparison

Left: default Web UI. Right: dsh-smooth-stream.

![Left: default Web UI. Right: dsh-smooth-stream.](docs/compare.gif)

---

## Performance & Test Benchmarks

Verified by local browser-level audit suites:

| Gate | Command | Passing Standard |
| :--- | :--- | :--- |
| **Stream Render Audit** | `node scripts/run-render-audit.mjs` | 10/10 clean across 5 streaming patterns; zero regressions |
| **Overflow & Rebound Gate** | `node scripts/verify-overflow.mjs` | Zero over-scroll, zero bounce under burst load |
| **Tail Vibration Probe** | `pnpm test` | Single-frame shift $\le 30\text{px}$, 7-frame amplitude $\le 32\text{px}$ |

- Core ESM bundle is approximately **4.7 kB** (gzipped). See [How It Works](https://laplace-bit.github.io/dsh-smooth-stream/how-it-works.html) for full benchmarks.

---

## Quick Start

### Installation

**`0.11.0-rebuild.3` has not been published to npm.** Use the local `dsh-smooth-stream-0.11.0-rebuild.3.tgz` delivered with this candidate. Installing by npm package name or using an older `dist` download URL will not install this candidate.

Use its absolute path in DSH's **Plugins → Add plugin** flow. Alternatively, use the existing CLI from your DeepSeek Harness checkout:

```sh
pnpm dsh plugin --profile web add /absolute/path/dsh-smooth-stream-0.11.0-rebuild.3.tgz
```

If `dsh` is in your system `PATH`:

```sh
dsh plugin --profile web add /absolute/path/dsh-smooth-stream-0.11.0-rebuild.3.tgz
```

Replace `web` with the intended profile. Follow the plugin manager's application result after installation; a load log alone does not validate page behavior or animation quality. This delivery only builds and verifies the archive; it does not install, publish, or restart DSH.

To uninstall: `pnpm dsh plugin --profile web remove dsh-smooth-stream`.

---

## Kernel Compatibility

| DSH kernel | This plugin |
|---|---|
| `0.2.2-rc.2` | Validated against the new `ui-conversation`, `ui-chat` and `ui-renderer` contracts |
| `0.1.x` | Use an earlier compatible release; this branch requires `>=0.2.2-rc.2 <0.3.0` |

The adapter paces the text supplied to the shipped assistant renderer. Its registration keeps the official locale, child Slots, image loading, translation, context menus and presentation hooks. Auto-expansion wraps the official disclosure Hook, preserving manual choices and Turn resets. The injected Flow owns one protocol-ordered playback queue and character budget; tool cards enter atomically with their official renderer. Suspense hiding preserves the playback engine; a true unmount disposes it. Mainline fallback rendering remains available.

Fast dispatch remains optional and feature-detected. It accelerates only `animation-frame` publications on compatible binding instances and restores the original methods when unloaded. History is displayed immediately. The settings UI uses `settings.section` and `settings.plugins.tab`.
- **Never statically import runtime symbols from `@deepseek-ai/*` packages.** The host CLI starts via `node --import tsx/esm`, and tsx applies the host `tsconfig` `paths` mapping, so a bare `@deepseek-ai/*` import from an external plugin may be redirected into the host's own sources — any host-side rename or removal then explodes at boot as a module instantiation error. Type-only imports (`import type`) are unaffected.

## Presets & Configuration

The plugin defaults to `preset: balanced`. You can tune the cadence in your profile's `cordis.patch.yml`:

| `preset` | Characteristics |
| :--- | :--- |
| `realtime` | Low buffer; closely follows model token arrival |
| `balanced` | Recommended default; balances smoothness and latency |
| `silky` | Generous buffer with gentler acceleration curves |

---

## User Preferences

Open **Settings → Smooth stream**, or **Settings → Plugins → Smooth stream**, in the Web UI:

**Logarithmic fade** (on by default) adapts the tail from 24 to at most 160 graphemes according to reveal speed, fading answers and expanded thinking from 0% opacity over 240ms with a reversed logarithmic curve that stays translucent longer. Text settles even during network pauses. Turning it off preserves text pacing and scrolling. It follows the motion preference and skips code, formulas and thinking summaries. Browsers without text-range highlighting support retain the existing reveal behavior.

For a local preview, run `pnpm build:repro`, serve the repository with `python3 -m http.server 8765 --bind 127.0.0.1`, and open `http://127.0.0.1:8765/repro/index.html?demo=fade`. This uses the real reveal/fade hooks with synthetic rich-text fixtures. Run `node scripts/verify-logarithmic-fade.mjs` to check and record it (Chrome and `pnpm exec playwright-core install ffmpeg` required; override the Chrome path with `CHROME_BIN`). Reports and recordings go to the ignored `repro/artifacts/logarithmic-fade/` directory.

- **Enable smooth streaming** (default on): Toggles custom stream rendering and follow. Disabling instantly falls back to built-in Harness rendering.
- **Auto-expand thinking**: Uses the official disclosure Hook and preserves manual choices and Turn resets. Automatically opened reasoning closes when playback drains or the setting is disabled. Background recovery closes plugin-opened reasoning and suppresses automatic reopening for that response; manual expansion remains available and new responses follow the setting. Collapsed reasoning synchronizes its snapshot without invisible reveal debt; newly arriving expanded content is paced.
- **Keep tool introductions streaming**: Paces preceding text before admitting a tool card. Disabling it skips that text animation while retaining explicit protocol-end barriers. Tool card contents keep the official renderer.
- **Background recovery**: `replay` resumes at normal speed, `catch-up` drains a bounded batch with a limited per-frame budget, and `latest` skips animation for that batch without crossing an unsealed block. After a reconnect, accepted Session publications are flushed before capturing the recovery frontier; later foreground text does not extend the batch. Initial history and older-page navigation display without replay.
- **Collapse finished work** (default on): Folds thoughts and tool steps into a summary line once the turn settles.
- **Show render diagnostics** (default off): Opens a live HUD on the right side to inspect FPS, character backlog, spring state, and adjust physical parameters in real time.

---

## License

[MIT](LICENSE)
