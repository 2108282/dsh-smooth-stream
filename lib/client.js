window.__ModuleLoader__.load({
	id: "dsh-smooth-stream",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		let _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		let react_dom = require("react-dom");
		//#region src/client/clientStore.ts
		function fallbackSnapshotStore(init) {
			let state = init;
			const listeners = /* @__PURE__ */ new Set();
			return {
				getSnapshot: () => state,
				subscribe: (listener) => {
					listeners.add(listener);
					return () => {
						listeners.delete(listener);
					};
				},
				update: (mutator) => {
					const draft = Object.create(Object.getPrototypeOf(state), Object.getOwnPropertyDescriptors(state));
					mutator(draft);
					state = draft;
					for (const listener of [...listeners]) listener(state);
				},
				set: (next) => {
					state = next;
					for (const listener of [...listeners]) listener(state);
				}
			};
		}
		/**
		* Runtime require: the module-loader factory scopes its own resolver over the
		* booting kernel's table; under Node (vitest) there is no global require, so
		* fall back to `createRequire`.
		*/
		function pickRequire() {
			if (typeof require === "function") try {
				return require;
			} catch {
				return null;
			}
			if (typeof process !== "undefined" && typeof process.getBuiltinModule === "function") try {
				const { createRequire } = process.getBuiltinModule("node:module");
				return createRequire(process.cwd() + "/package.json");
			} catch {
				return null;
			}
			return null;
		}
		let clientStore;
		try {
			const req = pickRequire();
			if (req !== null) try {
				clientStore = req("@deepseek-ai/dsh-client-store");
			} catch {
				try {
					clientStore = req("@deepseek-ai/dsh-client-runtime/client");
				} catch {}
			}
		} catch {}
		const createSnapshotStore = clientStore?.createSnapshotStore ?? fallbackSnapshotStore;
		//#endregion
		//#region src/settings.ts
		/** Defaults preserve the production engine exactly. */
		const DEFAULT_STREAM_DEBUG_TUNING = {
			revealScale: 1,
			queuePressure: .85,
			maxRevealCps: 600,
			cadenceClamp: 4,
			springStiffness: 130,
			springDamping: 24,
			springMass: 1,
			runwayPx: 72,
			reserveResponseMs: 180,
			backpressureMinScale: .55
		};
		/** Defaults shared by the Host schema and the client-side fallback. */
		const DEFAULT_STREAM_SETTINGS = {
			enabled: true,
			controlScroll: true,
			motionPreference: "force-smooth",
			backgroundRecovery: "catch-up",
			foregroundRecoveryDelayMs: 0,
			thinkAutoExpand: true,
			logarithmicFade: true,
			fastFold: true,
			fastPipeline: true,
			keepStreamOnToolCall: true,
			debugEnabled: false,
			debugTuningEnabled: false,
			debugTuning: DEFAULT_STREAM_DEBUG_TUNING
		};
		//#endregion
		//#region src/client/debugRuntime.ts
		/**
		* Shared browser-side diagnostics state.
		*
		* The settings card owns persistence. This module is the live bridge used by
		* the renderer and the chat-side panel: renderer loops publish measurements,
		* while panel edits are staged through the settings-card controller.
		*/
		const DIAGNOSTIC_SAMPLE_LIMIT = 240;
		const DIAGNOSTIC_FRAME_INTERVAL_MS = 100;
		const DIAGNOSTIC_FRAME_SOURCE_LIMIT = 64;
		const diagnosticSamples = [];
		const diagnosticLastSampleAt = /* @__PURE__ */ new Map();
		const diagnosticLastFrameAt = /* @__PURE__ */ new Map();
		const diagnosticFrames = /* @__PURE__ */ new Map();
		let diagnosticStartedAt = null;
		let diagnosticLifecycleCleanup;
		let diagnosticLongTaskObserver;
		let diagnosticLongTasks = {
			count: 0,
			maxDurationMs: 0,
			over50: 0,
			over100: 0
		};
		function pushDiagnostic(sample) {
			if (diagnosticSamples.length === DIAGNOSTIC_SAMPLE_LIMIT) diagnosticSamples.shift();
			diagnosticSamples.push(sample);
		}
		const EMPTY_METRICS = {
			fps: null,
			frameMs: null,
			fpsDegraded: false,
			streamActive: false,
			streamBacklog: 0,
			streamSpeedCps: 0,
			streamTargetChars: 0,
			streamDisplayedChars: 0,
			followActive: false,
			followLagPx: 0,
			followVelocityPxPerSec: 0,
			followReservePx: 0,
			followCapacityPx: 0,
			followRevealScale: 1,
			followFollowing: false,
			followConstrained: false,
			scrollTop: null,
			scrollHeight: null,
			clientHeight: null,
			lastUpdatedMs: null
		};
		const INITIAL_STATE = {
			available: false,
			enabled: false,
			diagnosticActive: false,
			tuningEnabled: false,
			writable: false,
			dirty: false,
			status: "loading",
			tuning: { ...DEFAULT_STREAM_DEBUG_TUNING },
			metrics: EMPTY_METRICS
		};
		const store = createSnapshotStore(INITIAL_STATE);
		const streamMetrics = /* @__PURE__ */ new Map();
		const followMetrics = /* @__PURE__ */ new Map();
		let actions;
		let lastMetricPublish = 0;
		function resetMetrics() {
			streamMetrics.clear();
			followMetrics.clear();
			lastMetricPublish = 0;
		}
		function resetRuntime() {
			if (diagnosticStartedAt !== null) {
				diagnosticLifecycleCleanup?.();
				diagnosticLifecycleCleanup = void 0;
				diagnosticStartedAt = null;
				diagnosticLastSampleAt.clear();
				diagnosticLastFrameAt.clear();
				diagnosticSamples.length = 0;
				diagnosticFrames.clear();
				diagnosticLongTaskObserver?.disconnect();
				diagnosticLongTaskObserver = void 0;
				diagnosticLongTasks = {
					count: 0,
					maxDurationMs: 0,
					over50: 0,
					over100: 0
				};
			}
			actions = void 0;
			resetMetrics();
			store.set({
				...INITIAL_STATE,
				metrics: EMPTY_METRICS
			});
		}
		function now() {
			return typeof performance === "undefined" ? Date.now() : performance.now();
		}
		function sameTuning(left, right) {
			return left.revealScale === right.revealScale && left.queuePressure === right.queuePressure && left.maxRevealCps === right.maxRevealCps && left.cadenceClamp === right.cadenceClamp && left.springStiffness === right.springStiffness && left.springDamping === right.springDamping && left.springMass === right.springMass && left.runwayPx === right.runwayPx && left.reserveResponseMs === right.reserveResponseMs && left.backpressureMinScale === right.backpressureMinScale;
		}
		function currentMetrics(timestamp) {
			let stream;
			for (const candidate of streamMetrics.values()) if (stream === void 0 || candidate.updatedAt > stream.updatedAt) stream = candidate;
			let follow;
			for (const candidate of followMetrics.values()) if (follow === void 0 || candidate.updatedAt > follow.updatedAt) follow = candidate;
			return {
				fps: store.getSnapshot().metrics.fps,
				frameMs: store.getSnapshot().metrics.frameMs,
				fpsDegraded: store.getSnapshot().metrics.fpsDegraded,
				streamActive: stream?.active ?? false,
				streamBacklog: stream?.backlog ?? 0,
				streamSpeedCps: stream?.speedCps ?? 0,
				streamTargetChars: stream?.targetChars ?? 0,
				streamDisplayedChars: stream?.displayedChars ?? 0,
				followActive: follow?.active ?? false,
				followLagPx: follow?.lagPx ?? 0,
				followVelocityPxPerSec: follow?.velocityPxPerSec ?? 0,
				followReservePx: follow?.reservePx ?? 0,
				followCapacityPx: follow?.capacityPx ?? 0,
				followRevealScale: follow?.revealScale ?? 1,
				followFollowing: follow?.following ?? false,
				followConstrained: follow?.constrained ?? false,
				scrollTop: follow?.scrollTop ?? null,
				scrollHeight: follow?.scrollHeight ?? null,
				clientHeight: follow?.clientHeight ?? null,
				lastUpdatedMs: timestamp
			};
		}
		function publishMetrics(force = false) {
			const timestamp = now();
			if (!force && timestamp - lastMetricPublish < 80) return;
			lastMetricPublish = timestamp;
			store.set({
				...store.getSnapshot(),
				metrics: currentMetrics(timestamp)
			});
		}
		const debugRuntime = {
			store,
			getSnapshot() {
				return store.getSnapshot();
			},
			subscribe(listener) {
				return store.subscribe(listener);
			},
			/** Whether hot-path instrumentation should do any work. */
			isEnabled() {
				return store.getSnapshot().enabled;
			},
			tuning() {
				return store.getSnapshot().tuning;
			},
			/** Saved physical parameters are independent of HUD instrumentation. */
			activeTuning() {
				return store.getSnapshot().tuningEnabled ? store.getSnapshot().tuning : DEFAULT_STREAM_DEBUG_TUNING;
			},
			bindSettings(nextActions) {
				actions = nextActions;
				return () => {
					if (actions !== nextActions) return;
					resetRuntime();
				};
			},
			syncSettings(input) {
				const current = store.getSnapshot();
				const available = input.available ?? true;
				const enabled = available && input.enabled;
				const tuningEnabled = available && (input.tuningEnabled ?? false);
				const availabilityChanged = current.available !== available;
				const enabledChanged = current.enabled !== enabled;
				if (availabilityChanged || enabledChanged) resetMetrics();
				const tuning = input.tuning === void 0 ? current.tuning : {
					...DEFAULT_STREAM_DEBUG_TUNING,
					...input.tuning
				};
				if (current.available === available && current.enabled === enabled && current.tuningEnabled === tuningEnabled && current.writable === input.writable && current.dirty === input.dirty && current.status === input.status && sameTuning(current.tuning, tuning)) return;
				store.set({
					...current,
					available,
					enabled,
					diagnosticActive: diagnosticStartedAt !== null,
					tuningEnabled,
					writable: input.writable,
					dirty: input.dirty,
					status: input.status,
					tuning,
					metrics: availabilityChanged || enabledChanged || !enabled ? EMPTY_METRICS : current.metrics
				});
			},
			edit(patch) {
				const current = store.getSnapshot();
				const enabled = patch.debugEnabled ?? current.enabled;
				const tuningEnabled = patch.debugTuningEnabled ?? current.tuningEnabled;
				const enabledChanged = current.enabled !== enabled;
				if (enabledChanged) resetMetrics();
				const tuning = patch.debugTuning === void 0 ? current.tuning : {
					...current.tuning,
					...patch.debugTuning
				};
				store.set({
					...current,
					enabled,
					tuningEnabled,
					dirty: true,
					diagnosticActive: diagnosticStartedAt !== null,
					tuning,
					metrics: enabledChanged || !enabled ? EMPTY_METRICS : current.metrics
				});
				actions?.edit({
					...patch.debugEnabled === void 0 ? {} : { debugEnabled: patch.debugEnabled },
					...patch.debugTuningEnabled === void 0 ? {} : { debugTuningEnabled: patch.debugTuningEnabled },
					...patch.debugTuning === void 0 ? {} : { debugTuning: tuning }
				});
			},
			save() {
				actions?.save();
			},
			discard() {
				actions?.discard();
			},
			reset() {
				this.edit({ debugTuning: { ...DEFAULT_STREAM_DEBUG_TUNING } });
			},
			reportStream(id, metric) {
				if (!this.isEnabled()) return;
				if (metric === null) streamMetrics.delete(id);
				else streamMetrics.set(id, {
					...metric,
					updatedAt: now()
				});
				publishMetrics(metric === null);
			},
			reportFollow(port, metric) {
				if (!this.isEnabled()) return;
				if (metric === null) followMetrics.delete(port);
				else followMetrics.set(port, {
					...metric,
					updatedAt: now()
				});
				publishMetrics(metric === null);
			},
			startDiagnostics() {
				if (diagnosticStartedAt !== null) return false;
				diagnosticStartedAt = now();
				store.set({
					...store.getSnapshot(),
					diagnosticActive: true
				});
				if (typeof PerformanceObserver !== "undefined") try {
					diagnosticLongTaskObserver = new PerformanceObserver((list) => {
						for (const entry of list.getEntries()) {
							diagnosticLongTasks.count++;
							diagnosticLongTasks.maxDurationMs = Math.max(diagnosticLongTasks.maxDurationMs, entry.duration);
							if (entry.duration > 50) diagnosticLongTasks.over50++;
							if (entry.duration > 100) diagnosticLongTasks.over100++;
						}
					});
					diagnosticLongTaskObserver.observe({
						type: "longtask",
						buffered: false
					});
				} catch {
					diagnosticLongTaskObserver = void 0;
				}
				if (typeof document !== "undefined") {
					const onVisibility = () => {
						this.recordDiagnostic("lifecycle", { event: document.hidden ? "visibility-hidden" : "visibility-visible" });
					};
					const onBackground = () => {
						this.recordDiagnostic("lifecycle", { event: "native-background" });
					};
					const onForeground = () => {
						this.recordDiagnostic("lifecycle", { event: "native-foreground" });
					};
					document.addEventListener("visibilitychange", onVisibility);
					window.addEventListener("dsha:background", onBackground);
					window.addEventListener("dsha:foreground", onForeground);
					diagnosticLifecycleCleanup = () => {
						document.removeEventListener("visibilitychange", onVisibility);
						window.removeEventListener("dsha:background", onBackground);
						window.removeEventListener("dsha:foreground", onForeground);
					};
				}
				diagnosticLastSampleAt.clear();
				diagnosticLastFrameAt.clear();
				diagnosticSamples.length = 0;
				diagnosticFrames.clear();
				diagnosticLongTasks = {
					count: 0,
					maxDurationMs: 0,
					over50: 0,
					over100: 0
				};
				pushDiagnostic({
					atMs: 0,
					kind: "lifecycle",
					event: "capture-start"
				});
				return true;
			},
			stopDiagnostics() {
				if (diagnosticStartedAt === null) return null;
				const timestamp = now();
				const startedAtMs = diagnosticStartedAt;
				const frames = Object.fromEntries([...diagnosticFrames].map(([name, stats]) => [name, { ...stats }]));
				if (startedAtMs !== null) pushDiagnostic({
					atMs: timestamp - startedAtMs,
					kind: "lifecycle",
					event: "capture-stop"
				});
				const result = {
					startedAtMs,
					durationMs: startedAtMs === null ? 0 : timestamp - startedAtMs,
					frameMetric: "requestAnimationFrame callback interval; not display/compositor FPS",
					samples: diagnosticSamples.map((sample) => ({ ...sample })),
					frames,
					longTasks: {
						...diagnosticLongTasks,
						supported: typeof PerformanceObserver !== "undefined"
					}
				};
				diagnosticLongTaskObserver?.disconnect();
				diagnosticLongTaskObserver = void 0;
				diagnosticLongTasks = {
					count: 0,
					maxDurationMs: 0,
					over50: 0,
					over100: 0
				};
				diagnosticLifecycleCleanup?.();
				diagnosticLifecycleCleanup = void 0;
				diagnosticStartedAt = null;
				store.set({
					...store.getSnapshot(),
					diagnosticActive: false
				});
				diagnosticLastSampleAt.clear();
				diagnosticLastFrameAt.clear();
				diagnosticSamples.length = 0;
				diagnosticFrames.clear();
				return result;
			},
			diagnosticsActive() {
				return diagnosticStartedAt !== null;
			},
			recordDiagnostic(kind, values = {}) {
				if (diagnosticStartedAt === null) return;
				const timestamp = now();
				const sampleKey = values.event === void 0 ? kind : `${kind}:${values.event}`;
				const previous = diagnosticLastSampleAt.get(sampleKey) ?? 0;
				if (kind !== "lifecycle" && timestamp - previous < DIAGNOSTIC_FRAME_INTERVAL_MS) return;
				diagnosticLastSampleAt.set(sampleKey, timestamp);
				pushDiagnostic({
					atMs: timestamp - diagnosticStartedAt,
					kind,
					...values
				});
			},
			recordDiagnosticFrame(name, timestamp, durationMs) {
				if (diagnosticStartedAt === null) return;
				if (!diagnosticFrames.has(name) && diagnosticFrames.size >= DIAGNOSTIC_FRAME_SOURCE_LIMIT) return;
				const previous = diagnosticLastFrameAt.get(name) ?? 0;
				diagnosticLastFrameAt.set(name, timestamp);
				const gapMs = previous === 0 ? 0 : Math.max(0, timestamp - previous);
				const stats = diagnosticFrames.get(name) ?? {
					count: 0,
					over16: 0,
					over32: 0,
					over50: 0,
					over100: 0,
					over1000: 0,
					maxGapMs: 0,
					maxDurationMs: 0
				};
				stats.count++;
				if (gapMs > 16) stats.over16++;
				if (gapMs > 32) stats.over32++;
				if (gapMs > 50) stats.over50++;
				if (gapMs > 100) stats.over100++;
				if (gapMs > 1e3) stats.over1000++;
				stats.maxGapMs = Math.max(stats.maxGapMs, gapMs);
				stats.maxDurationMs = Math.max(stats.maxDurationMs, durationMs);
				diagnosticFrames.set(name, stats);
				const lastSample = diagnosticLastSampleAt.get(`frame:${name}`) ?? 0;
				if (gapMs > 32 || durationMs > 8 || timestamp - lastSample >= DIAGNOSTIC_FRAME_INTERVAL_MS) {
					diagnosticLastSampleAt.set(`frame:${name}`, timestamp);
					pushDiagnostic({
						atMs: timestamp - diagnosticStartedAt,
						kind: name.startsWith("follow") ? "follow-frame" : "text-frame",
						gapMs,
						durationMs
					});
				}
			},
			reportFps(fps, frameMs, degraded) {
				if (!this.isEnabled()) return;
				const current = store.getSnapshot();
				store.set({
					...current,
					metrics: {
						...current.metrics,
						fps,
						frameMs,
						fpsDegraded: degraded,
						lastUpdatedMs: now()
					}
				});
			},
			clearFps() {
				if (!this.isEnabled()) return;
				const current = store.getSnapshot();
				store.set({
					...current,
					metrics: {
						...current.metrics,
						fps: null,
						frameMs: null,
						fpsDegraded: false,
						lastUpdatedMs: now()
					}
				});
			},
			panelFace() {
				return {
					hooks: { debugRuntime: store },
					edit: (patch) => {
						this.edit(patch);
					},
					save: () => {
						this.save();
					},
					discard: () => {
						this.discard();
					},
					reset: () => {
						this.reset();
					},
					startDiagnostics: () => {
						this.startDiagnostics();
					},
					stopDiagnostics: () => this.stopDiagnostics()
				};
			},
			resetRuntime() {
				resetRuntime();
			}
		};
		let synchronization;
		function installRecoverySynchronization(source) {
			synchronization = source;
			return () => {
				if (synchronization !== source) return;
				synchronization = void 0;
				notifyRecoverySynchronized();
			};
		}
		function notifyRecoverySynchronized() {
			if (background) return;
			for (const client of [...clients]) {
				const key = client.key();
				if (client.recovering() && client.waitingForSync() && (key === void 0 || synchronization?.pending(key) !== true)) client.synchronized();
			}
		}
		const clients = /* @__PURE__ */ new Set();
		const recoveryScopes = /* @__PURE__ */ new Map();
		let attached = false;
		let background = false;
		let nativeBackground = false;
		let foregroundDelayMs = 0;
		let foregroundPending = false;
		let foregroundSequence = 0;
		let foregroundTimer;
		/** Set the user-owned delay used only for native dsha:foreground signals. */
		function setForegroundRecoveryDelay(delayMs) {
			foregroundDelayMs = Number.isInteger(delayMs) && delayMs >= 0 ? Math.min(1e4, delayMs) : 0;
		}
		/** A resume batch belongs to its observed turn, not a wall-clock window. */
		function isBackgroundRecoveryScope(key, position) {
			if (!recoveryScopes.has(key)) return false;
			const frontier = recoveryScopes.get(key);
			return position === void 0 || frontier === void 0 || comparePosition(position, frontier) >= 0;
		}
		function comparePosition(left, right) {
			for (let index = 0; index < left.length; index++) {
				const delta = left[index] - right[index];
				if (delta !== 0) return delta;
			}
			return 0;
		}
		function rememberScope(key, position) {
			if (key === void 0) return;
			const previous = recoveryScopes.get(key);
			if (!recoveryScopes.has(key) || previous === void 0 || position !== void 0 && comparePosition(position, previous) < 0) recoveryScopes.set(key, position);
		}
		function rememberScopes() {
			for (const client of clients) rememberScope(client.key(), client.position());
		}
		function retireScopes() {
			for (const key of recoveryScopes.keys()) if (![...clients].some((client) => client.key() === key && client.recovering())) recoveryScopes.delete(key);
		}
		function hide(native = false) {
			if (native) nativeBackground = true;
			if (background && !foregroundPending) return;
			if (foregroundTimer !== void 0) clearTimeout(foregroundTimer);
			foregroundTimer = void 0;
			foregroundPending = false;
			background = true;
			debugRuntime.recordDiagnostic("lifecycle", { event: "recovery-hidden" });
			rememberScopes();
			for (const client of [...clients]) client.hidden();
		}
		function show(delayMs = 0, native = false) {
			if (foregroundPending) return;
			if (native) nativeBackground = false;
			if (nativeBackground && !native) return;
			if (!background && !foregroundPending) return;
			if (foregroundTimer !== void 0) clearTimeout(foregroundTimer);
			foregroundTimer = void 0;
			foregroundPending = false;
			if (delayMs > 0) {
				foregroundPending = true;
				foregroundSequence++;
				for (const client of [...clients]) client.foregroundWaiting();
				foregroundTimer = setTimeout(() => {
					foregroundTimer = void 0;
					if (!foregroundPending) return;
					foregroundPending = false;
					background = false;
					debugRuntime.recordDiagnostic("lifecycle", { event: "recovery-resume" });
					rememberScopes();
					for (const client of [...clients]) client.resume();
				}, delayMs);
				return;
			}
			background = false;
			debugRuntime.recordDiagnostic("lifecycle", { event: "recovery-resume" });
			rememberScopes();
			for (const client of [...clients]) client.resume();
		}
		function visibility() {
			if (document.hidden) hide();
			else show();
		}
		function pageHide() {
			hide();
		}
		function focus() {
			if (!document.hidden) show();
		}
		function nativeBackgroundSignal() {
			hide(true);
		}
		function nativeForeground() {
			show(foregroundDelayMs, true);
		}
		function attach() {
			if (attached || typeof document === "undefined") return;
			attached = true;
			background = document.hidden;
			nativeBackground = false;
			document.addEventListener("visibilitychange", visibility);
			window.addEventListener("pagehide", pageHide);
			window.addEventListener("pageshow", focus);
			window.addEventListener("focus", focus);
			window.addEventListener("dsha:background", nativeBackgroundSignal);
			window.addEventListener("dsha:foreground", nativeForeground);
		}
		function detach() {
			queueMicrotask(detachIfUnused);
		}
		function detachIfUnused() {
			if (!attached || clients.size !== 0) return;
			document.removeEventListener("visibilitychange", visibility);
			window.removeEventListener("pagehide", pageHide);
			window.removeEventListener("pageshow", focus);
			window.removeEventListener("focus", focus);
			window.removeEventListener("dsha:background", nativeBackgroundSignal);
			window.removeEventListener("dsha:foreground", nativeForeground);
			attached = false;
			background = false;
			nativeBackground = false;
			foregroundPending = false;
			if (foregroundTimer !== void 0) clearTimeout(foregroundTimer);
			foregroundTimer = void 0;
			recoveryScopes.clear();
		}
		/** Shared lifecycle listeners, per-renderer playback progress and disposal. */
		function useBackgroundRecovery(mode, onHidden, onResume, scopeKey, scopePosition, resumeOnMount = false, active = true, onForegroundWaiting) {
			const keyRef = (0, react.useRef)(scopeKey);
			keyRef.current = scopeKey;
			const positionRef = (0, react.useRef)(scopePosition);
			positionRef.current = scopePosition;
			const callbacks = (0, react.useRef)({
				onHidden,
				onResume,
				onForegroundWaiting
			});
			callbacks.current = {
				onHidden,
				onResume,
				onForegroundWaiting
			};
			const state = (0, react.useRef)({
				mode,
				recovering: false,
				resumed: false,
				wasHidden: false,
				waitingSync: false
			});
			state.current.mode = mode;
			(0, react.useLayoutEffect)(() => {
				if (!active) {
					state.current.recovering = false;
					state.current.resumed = false;
					state.current.wasHidden = false;
					state.current.waitingSync = false;
					return;
				}
				attach();
				let stopForegroundWaiting;
				const releaseForegroundWaiting = (reason) => {
					stopForegroundWaiting?.(reason);
					stopForegroundWaiting = void 0;
				};
				const client = {
					key: () => keyRef.current,
					position: () => positionRef.current,
					recovering: () => state.current.recovering || state.current.wasHidden,
					waitingForSync: () => state.current.waitingSync,
					hidden: () => {
						releaseForegroundWaiting("hidden");
						state.current.wasHidden = true;
						state.current.waitingSync = false;
						callbacks.current.onHidden();
					},
					resume: () => {
						releaseForegroundWaiting("resume");
						state.current.wasHidden = false;
						state.current.waitingSync = false;
						state.current.recovering = true;
						state.current.resumed = true;
						callbacks.current.onResume();
					},
					synchronized: () => {
						state.current.waitingSync = false;
						callbacks.current.onResume();
					},
					foregroundWaiting: () => {
						const stop = callbacks.current.onForegroundWaiting?.(foregroundSequence);
						if (typeof stop === "function") stopForegroundWaiting = stop;
					}
				};
				clients.add(client);
				const key = keyRef.current;
				state.current.recovering = resumeOnMount || key !== void 0 && isBackgroundRecoveryScope(key, positionRef.current);
				state.current.resumed = state.current.recovering;
				if (key !== void 0) synchronization?.pending(key);
				if (background) {
					rememberScope(key, positionRef.current);
					client.hidden();
					if (foregroundPending) client.foregroundWaiting();
				}
				return () => {
					releaseForegroundWaiting("dispose");
					clients.delete(client);
					retireScopes();
					detach();
				};
			}, [active]);
			(0, react.useLayoutEffect)(() => {
				if (scopeKey !== void 0) synchronization?.pending(scopeKey);
				retireScopes();
			}, [scopeKey]);
			return {
				hidden: () => background,
				mode: () => state.current.mode,
				recovering: () => state.current.recovering,
				resumed: () => state.current.resumed,
				cancel: () => {
					state.current.recovering = false;
					state.current.resumed = false;
					state.current.wasHidden = false;
					state.current.waitingSync = false;
					retireScopes();
				},
				finish: () => {
					const key = keyRef.current;
					if (key !== void 0 && synchronization?.pending(key) === true) {
						state.current.waitingSync = true;
						return;
					}
					state.current.waitingSync = false;
					state.current.recovering = false;
					state.current.resumed = false;
					retireScopes();
				},
				detectGap: (elapsed) => {
					if (elapsed >= 1e3) state.current.recovering = true;
				}
			};
		}
		/** Per-frame fractional budget; the character cap is unchanged and long stalls never accrue whole-token debt. */
		function recoveryBudget(backlog, elapsedMs, debt, tuning, retainDebt = false) {
			if (backlog <= 0 || elapsedMs <= 0) return {
				chars: 0,
				debt: backlog <= 0 ? 0 : Math.max(0, debt) % 1
			};
			const budget = Math.min(400, Math.max(120, tuning.maxRevealCps * tuning.revealScale * 1.5)) * Math.min(elapsedMs, 80) / 1e3 + Math.max(0, debt) % 1;
			const chars = Math.min(backlog, 16, Math.floor(budget));
			return {
				chars,
				debt: chars >= backlog && !retainDebt ? 0 : budget % 1
			};
		}
		//#endregion
		//#region src/client/teleprompterGlide.ts
		/**
		* Conversation-port follow while an assistant reply streams.
		*
		* A sub-stepped spring physics engine drives a float `animatedH`, rather
		* than restarting native smooth-scroll animations as every glyph lands.
		* Remaining lag rides a small compositor transform while the real scrollport
		* stays at its floor. The transform is bounded by the measured paint gap
		* before conversation chrome. This follower:
		*
		* - marks programmatic writes via `data-follow-owned` for compatible hosts;
		* - sets `overflow-anchor: none` so CSS scroll-anchoring does not snap;
		* - restores `animatedH` in a ResizeObserver (before paint) so a layout
		*   pass cannot flash a snapped frame;
		* - expresses safe lag as a compositor transform on message rows;
		* - opens a speed-adaptive layout runway before fast output wraps, preserving
		*   the reference spring constants at every reveal speed;
		* - catches up any lag that cannot fit before turn status / composer chrome,
		*   so fixed chrome never has to counter-shift and the host stays at-bottom;
		* - never clips or overlays streamed text.
		*
		* A real reader gesture receives the effective visual position before the
		* transform clears. Lifecycle completion instead settles at the floor.
		*
		* Directional wheel/touch intent unpins immediately; pointer/key input falls
		* back to an upward scroll delta from the engine's own written position. A
		* reader release re-acquires only after returning to the real floor.
		*/
		/**
		* Programmatic follow marker retained for hosts that recognize external
		* scroll ownership. Current Harness also sees the write land at the floor.
		*/
		const FOLLOW_OWNED_ATTR = "data-follow-owned";
		/**
		* Duration of completion runway retirement. The final pad is visible motion:
		* its shrinking floor brings the transcript down to its natural resting
		* position. 1.5s keeps the default 72px runway at 48px/s (0.8px per 60Hz
		* frame), matching the configured default reading-follow velocity instead of
		* the old 160ms / 450px/s staircase that looked like repeated completion
		* jumps.
		*/
		const FOLLOW_RUNWAY_RETIRE_MS = 1500;
		/** Runway size emitted by bundles before the 72px predictive runway. */
		const LEGACY_RUNWAY_PX = 48;
		/** Safe-lag occupancy band over which reveal pressure is progressively reduced. */
		const FOLLOW_BACKPRESSURE_START_RATIO = .1;
		/** Effective-scroll acceleration budget, in px/ms². */
		const FOLLOW_TRAJECTORY_ACCELERATION = 22e-5;
		const GESTURE_EVENTS = [
			"wheel",
			"touchstart",
			"touchmove",
			"touchend",
			"touchcancel",
			"pointerdown",
			"keydown"
		];
		/** Visible runway needed for the current reveal pressure. */
		function computeFollowReserve(speedCps, runwayPx = 72) {
			const available = Math.max(0, runwayPx);
			if (available <= 0) return 0;
			if (speedCps <= 20) return 0;
			const normalized = Math.min(1, Math.max(0, (speedCps - 20) / 580));
			const minimum = Math.min(available, 31);
			return minimum + normalized * (available - minimum);
		}
		/**
		* Character-domain feed-forward for the stepped layout floor. Callers only
		* provide committed reveal progress and the measured floor; wrap capacity and
		* line height stay local to this module and adapt when a real wrap lands.
		*/
		var FollowRevealPhaseTracker = class {
			charsPerLine;
			lineHeightPx;
			floorPx = null;
			wrapRevealCount = 0;
			lastRevealCount = 0;
			constructor({ seedCharsPerLine = 50, seedLineHeightPx = 26 } = {}) {
				this.charsPerLine = Math.max(1, seedCharsPerLine);
				this.lineHeightPx = Math.max(1, seedLineHeightPx);
			}
			advance(floorPx, revealedChars) {
				const nextFloor = Math.max(0, floorPx);
				const nextRevealCount = Math.max(0, revealedChars);
				if (this.floorPx === null || nextRevealCount < this.lastRevealCount) {
					this.floorPx = nextFloor;
					this.wrapRevealCount = nextRevealCount;
					this.lastRevealCount = nextRevealCount;
					return this.snapshot(nextFloor, 0);
				}
				const floorDelta = nextFloor - this.floorPx;
				const lineStepThreshold = Math.max(4, this.lineHeightPx * .5);
				if (floorDelta >= lineStepThreshold) {
					const wrappedLines = Math.max(1, Math.round(floorDelta / this.lineHeightPx));
					const sampledLineHeight = floorDelta / wrappedLines;
					const revealedSinceWrap = nextRevealCount - this.wrapRevealCount;
					if (revealedSinceWrap >= this.charsPerLine * .5) {
						const sampledCharsPerLine = revealedSinceWrap / wrappedLines;
						const alpha = .25;
						this.charsPerLine += (sampledCharsPerLine - this.charsPerLine) * alpha;
						this.lineHeightPx += (sampledLineHeight - this.lineHeightPx) * alpha;
						this.wrapRevealCount = nextRevealCount;
					} else this.wrapRevealCount = nextRevealCount;
				} else if (floorDelta <= -lineStepThreshold) this.wrapRevealCount = nextRevealCount;
				this.floorPx = nextFloor;
				this.lastRevealCount = nextRevealCount;
				const phase = Math.min(1, Math.max(0, (nextRevealCount - this.wrapRevealCount) / this.charsPerLine));
				return this.snapshot(nextFloor, phase);
			}
			snapshot(floorPx, phase) {
				return {
					targetPx: floorPx + this.lineHeightPx * phase,
					phase,
					charsPerLine: this.charsPerLine,
					lineHeightPx: this.lineHeightPx
				};
			}
		};
		/** Advance a continuous effective scroll position behind a stepped floor. */
		function computeFollowTrajectoryStep(dtMs, input) {
			if (dtMs <= 0) return {
				positionPx: input.positionPx,
				shiftPx: Math.max(0, (input.paintFloorPx ?? input.targetPx) - input.positionPx),
				velocityPxPerMs: input.velocityPxPerMs
			};
			const elapsedMs = Math.min(32, dtMs);
			const currentLagPx = input.targetPx - input.positionPx;
			const maxLagPx = Math.max(0, input.maxLagPx);
			const minLagPx = Math.min(Math.max(0, input.minLagPx), maxLagPx);
			const centerLagPx = (minLagPx + maxLagPx) / 2;
			const desiredVelocity = Math.max(0, input.targetVelocityPxPerMs + (currentLagPx - centerLagPx) / 120);
			const maxVelocityChange = FOLLOW_TRAJECTORY_ACCELERATION * elapsedMs;
			const velocityPxPerMs = desiredVelocity >= input.velocityPxPerMs ? Math.min(desiredVelocity, input.velocityPxPerMs + maxVelocityChange) : Math.max(desiredVelocity, input.velocityPxPerMs - maxVelocityChange);
			const minPosition = input.targetPx - maxLagPx;
			const maxPosition = input.targetPx - minLagPx;
			const frameAdvancePx = velocityPxPerMs * elapsedMs;
			const boundedPositionPx = Math.min(maxPosition, Math.max(minPosition, input.positionPx + frameAdvancePx));
			const positionPx = Math.max(input.positionPx, boundedPositionPx);
			return {
				positionPx,
				shiftPx: Math.max(0, (input.paintFloorPx ?? input.targetPx) - positionPx),
				velocityPxPerMs
			};
		}
		/**
		* Reveal-rate multiplier needed to retain one-wrap headroom for the spring.
		* Throttling starts only after a quarter of the safe transform is occupied;
		* a constrained paint lands at the minimum immediately so the next reveal
		* commit cannot keep feeding an already-full visual buffer.
		*/
		function computeFollowRevealScale(lagPx, capacityPx, constrained = false, tuning = DEFAULT_STREAM_DEBUG_TUNING) {
			if (constrained) return tuning.backpressureMinScale;
			if (!Number.isFinite(capacityPx)) return 1;
			if (capacityPx <= 0) return lagPx > 0 ? tuning.backpressureMinScale : 1;
			const ratio = Math.min(1, Math.max(0, lagPx / capacityPx));
			if (ratio >= .75) return tuning.backpressureMinScale;
			const progress = Math.min(1, Math.max(0, (ratio - FOLLOW_BACKPRESSURE_START_RATIO) / .65));
			const eased = progress * progress * (3 - 2 * progress);
			return 1 - (1 - tuning.backpressureMinScale) * eased;
		}
		/** Semi-implicit spring integration with four substeps per <=32ms slice. */
		function computeFollowStep(dtMs, input, tuning = DEFAULT_STREAM_DEBUG_TUNING) {
			if (input.lag <= .1 || dtMs <= 0) return {
				advancePx: 0,
				lerpStep: 0,
				velocityPxPerSec: 0
			};
			let lag = input.lag;
			let velocity = Math.max(0, input.velocityPxPerSec ?? 0);
			const elapsedMs = Math.min(32, dtMs);
			const slices = Math.max(1, Math.ceil(elapsedMs / 32));
			const subDt = elapsedMs / 1e3 / slices / 4;
			for (let slice = 0; slice < slices; slice += 1) for (let substep = 0; substep < 4; substep += 1) {
				const acceleration = (tuning.springStiffness * lag - tuning.springDamping * velocity) / tuning.springMass;
				velocity = Math.max(0, velocity + acceleration * subDt);
				const advance = velocity * subDt;
				if (advance >= lag) return {
					advancePx: input.lag,
					lerpStep: 1,
					velocityPxPerSec: 0
				};
				lag -= advance;
			}
			const advancePx = input.lag - lag;
			return {
				advancePx,
				lerpStep: advancePx / input.lag,
				velocityPxPerSec: velocity
			};
		}
		/** Element whose resize signals flow growth for the before-paint restore. */
		function resizeProxyOf(port) {
			return port.querySelector("[data-chat-transcript]") ?? port.querySelector("[data-chat-flow]");
		}
		/**
		* Outermost message surfaces; nested tool rows ride their parent.
		*
		* Another plugin may insert its own element as a flow sibling of the Chat rows
		* (meow-memory's fold bar is one).
		* Such a row carries no `data-chat-anchor-key`, so selecting only anchored
		* rows would shift the conversation while leaving the foreign row at its
		* natural offset, letting the shifted rows paint over it. Every direct flow
		* child therefore rides the same transform, keeping the visual order of the
		* column intact.
		*/
		const directShiftCache = /* @__PURE__ */ new WeakMap();
		function shiftSurfacesOf(port) {
			const transcript = port.querySelector("[data-chat-transcript]");
			if (transcript !== null) return [transcript];
			const flow = port.querySelector("[data-chat-flow]");
			if (flow === null) return [...port.querySelectorAll("[data-chat-anchor-key]")].filter((row) => row.parentElement?.closest("[data-chat-anchor-key]") === null);
			const status = turnStatusOf(port);
			const surfaces = [];
			const append = (parent) => {
				for (const child of parent.children) {
					if (!(child instanceof HTMLElement) || child === status) continue;
					if (child.getAttribute("data-slot") === "conversation.chat.flow" || child.style.display === "contents") append(child);
					else if (!child.hasAttribute("data-text-interaction-surface")) surfaces.push(child);
				}
			};
			append(flow);
			return surfaces;
		}
		function currentShiftOf(element) {
			const cached = directShiftCache.get(element);
			if (cached !== void 0) return cached;
			const parsed = Number(/translate3d\(0(?:px)?,\s*(-?[\d.]+)px,\s*0(?:px)?\)/.exec(element.style.transform)?.[1] ?? 0);
			directShiftCache.set(element, parsed);
			return parsed;
		}
		const followSurfaceStyles = /* @__PURE__ */ new WeakMap();
		const followPortStyles = /* @__PURE__ */ new WeakMap();
		function setDirectShift(element, px) {
			const current = currentShiftOf(element);
			if (Math.abs(px) > .01) {
				if (!followSurfaceStyles.has(element)) followSurfaceStyles.set(element, {
					transform: element.style.transform,
					willChange: element.style.willChange,
					clipPath: element.style.clipPath
				});
				if (Math.abs(current - px) <= .01 && element.style.willChange === "transform" && element.style.clipPath === "") return;
				directShiftCache.set(element, px);
				const original = followSurfaceStyles.get(element);
				element.style.transform = `translate3d(0, ${px}px, 0)${original.transform === "" ? "" : ` ${original.transform}`}`;
				element.style.willChange = "transform";
			} else {
				directShiftCache.set(element, 0);
				const original = followSurfaceStyles.get(element);
				if (original === void 0) return;
				element.style.transform = original.transform;
				element.style.willChange = original.willChange;
				element.style.clipPath = original.clipPath;
				followSurfaceStyles.delete(element);
				return;
			}
			element.style.clipPath = "";
		}
		function setShift(element, px) {
			if (Math.abs(px) > .01 && element.querySelector("[role=\"tooltip\"]") !== null) {
				setDirectShift(element, 0);
				return;
			}
			setDirectShift(element, px);
		}
		function turnStatusOf(port) {
			return port.querySelector("[data-chat-running], [data-chat-turn-status], [data-chat-flow] > [role=\"status\"]") ?? port.querySelector("[data-chat-flow] [role=\"status\"]")?.closest("[data-chat-flow] > *") ?? null;
		}
		const FOLLOW_FLOW_FILL_SYMBOL = Symbol.for("dsh-smooth-stream.follow-flow-fill");
		const followFlowFillHost = globalThis;
		const followFlowFills = followFlowFillHost[FOLLOW_FLOW_FILL_SYMBOL] ?? /* @__PURE__ */ new WeakMap();
		followFlowFillHost[FOLLOW_FLOW_FILL_SYMBOL] = followFlowFills;
		const FOLLOW_FLOW_FILL_USERS_SYMBOL = Symbol.for("dsh-smooth-stream.follow-flow-fill-users");
		const followFlowFillUsersHost = globalThis;
		const followFlowFillUsers = followFlowFillUsersHost[FOLLOW_FLOW_FILL_USERS_SYMBOL] ?? /* @__PURE__ */ new WeakMap();
		followFlowFillUsersHost[FOLLOW_FLOW_FILL_USERS_SYMBOL] = followFlowFillUsers;
		function flowElementOf(port) {
			return port.querySelector("[data-chat-transcript]") ?? port.querySelector("[data-chat-flow]");
		}
		function ensureFlowFillsPort(port) {
			const element = flowElementOf(port);
			const owned = followFlowFills.get(port);
			if (element === null) {
				if (owned !== void 0) restoreFlowFill(port);
				return;
			}
			const client = Math.max(0, port.clientHeight);
			let overshoot = owned?.overshootPx;
			if (overshoot === void 0) {
				const pendingOriginal = element.style.minHeight;
				element.style.minHeight = `${client}px`;
				overshoot = Math.max(0, port.scrollHeight - client);
				element.style.minHeight = pendingOriginal;
				if (owned !== void 0) restoreFlowFill(port);
			}
			const target = `${Math.max(0, client - overshoot)}px`;
			if (owned !== void 0) {
				if (owned.element === element && owned.overshootPx === overshoot && element.style.minHeight === target) return;
				restoreFlowFill(port);
			}
			const original = element.style.minHeight;
			element.style.minHeight = target;
			followFlowFills.set(port, {
				element,
				original,
				overshootPx: overshoot
			});
		}
		function restoreFlowFill(port) {
			const owned = followFlowFills.get(port);
			if (owned === void 0) return;
			owned.element.style.minHeight = owned.original;
			followFlowFills.delete(port);
		}
		/**
		* The plugin can be reinjected without replacing the conversation DOM. Keep
		* runway ownership in the page realm so a fresh bundle adopts the existing
		* margin instead of treating it as host layout and adding another 48px.
		*/
		const FOLLOW_RUNWAYS_SYMBOL = Symbol.for("dsh-smooth-stream.follow-runways");
		const followRunwayRegistry = globalThis;
		const followRunways = followRunwayRegistry[FOLLOW_RUNWAYS_SYMBOL] ?? /* @__PURE__ */ new WeakMap();
		followRunwayRegistry[FOLLOW_RUNWAYS_SYMBOL] = followRunways;
		const followPaintLimits = /* @__PURE__ */ new WeakMap();
		const followHadChrome = /* @__PURE__ */ new WeakSet();
		/** Last painted shift per port, to spread a wrap's one-line step over frames. */
		const followLastShiftPx = /* @__PURE__ */ new WeakMap();
		/** Last settled floor per port, to size the shift decay bound against extent collapse. */
		const followLastFloorPx = /* @__PURE__ */ new WeakMap();
		const followGuardAnchors = /* @__PURE__ */ new WeakMap();
		/**
		* Ports whose completion settle loop owns the follow. The settle drains the
		* reveal, retires the pad and guards the cascade; the swap that ends the
		* turn REMOUNTS the follower arms in the same frame cluster, and a freshly
		* mounted arm primes with a higher generation and would otherwise steal the
		* port mid-drain — its observers miss the cascade mutations (armed after
		* the fact) and its state initialization re-materializes engine space.
		* Ownership is released only when the settle finishes, the reader gestures,
		* or a genuinely NEW turn arrives (a user row joined since the handoff).
		*/
		const followCompletionSettle = /* @__PURE__ */ new WeakSet();
		/** User-row count at handoff, for the new-turn check above. */
		const followCompletionSettleRows = /* @__PURE__ */ new WeakMap();
		/** User rows below the flow, or -1 when the host does not label rows with
		*  `data-chat-flow-kind` (the engine's own audit benches): the new-turn
		*  check is unsupported there and ownership guarding must stay OFF. */
		function countUserRows(port) {
			if (flowElementOf(port) === null) return -1;
			let count = 0;
			let sawKind = false;
			for (const child of shiftSurfacesOf(port)) {
				const kind = child.getAttribute("data-chat-flow-kind");
				if (kind !== null) sawKind = true;
				if (kind === "user") count++;
			}
			return sawKind ? count : -1;
		}
		/** True while this port's completion settle owns the follow and no new turn
		*  has arrived since the handoff. */
		function completionSettleGuardsPort(port) {
			if (!followCompletionSettle.has(port)) return false;
			const baseline = followCompletionSettleRows.get(port) ?? -1;
			const current = countUserRows(port);
			return baseline >= 0 && current >= 0 && current <= baseline;
		}
		/**
		* Ports whose completion settle loop owns the follow. A settle loop drains,
		* retires the pad and guards the cascade; an arm that primes while this is
		* set with `active === false` (the settled-side static arm mounting in the
		* very swap frame) must NOT seize leadership — the swap re-renders the node
		* view, a fresh arm would otherwise steal the port mid-drain with
		* `reservePx = ownedBottomSpace` (the pad!), re-materialize an equal runway
		* through applyVisual, double-count the extent and fight the settle's own
		* guard for the rest of the window. A streaming arm (active === true, the
		* next turn) still takes over normally and the settle yields.
		*/
		function readingAnchorOf(port) {
			if (flowElementOf(port) === null) return null;
			let anchor = null;
			for (const child of shiftSurfacesOf(port)) if (child.getAttribute("data-chat-flow-kind") === "assistant" || child.querySelector("[data-variant=\"think\"]") !== null) anchor = child;
			return anchor ?? shiftSurfacesOf(port).at(-1) ?? null;
		}
		/**
		* Measure the reading surface's screen delta since the last guard pass.
		* Returns null when there is nothing comparable yet (first observation), or
		* when the anchor changed identity in a way that is NOT the in-place
		* live→settled replacement (a new turn's row joined — nothing jumped,
		* re-seed). Compensation sites must store the POST-compensation held
		* position via `holdGuardAnchor`, or the guard would read its own
		* correction as a fresh jump and oscillate.
		*/
		function measureReadingAnchor(port) {
			const anchor = readingAnchorOf(port);
			if (anchor === null) {
				followGuardAnchors.delete(port);
				return null;
			}
			const rect = anchor.getBoundingClientRect();
			if (!(rect.width > 0 || rect.height > 0)) return null;
			const top = rect.top;
			const shift = currentShiftOf(anchor);
			const pad = flowPadOf(port);
			const scrollTop = port.scrollTop;
			const scrollHeight = port.scrollHeight;
			const index = flowElementOf(port) === null ? -1 : shiftSurfacesOf(port).indexOf(anchor);
			const stored = followGuardAnchors.get(port);
			if (stored === void 0) {
				followGuardAnchors.set(port, {
					element: anchor,
					top,
					index,
					shift,
					pad,
					scrollTop,
					scrollHeight
				});
				return null;
			}
			if (Math.abs(scrollHeight - stored.scrollHeight) <= .5 && Math.abs(scrollTop - stored.scrollTop) > .5) {
				followScrollLedgers.set(port, scrollTop);
				followGuardAnchors.set(port, {
					element: anchor,
					top,
					index,
					shift,
					pad,
					scrollTop,
					scrollHeight
				});
				return null;
			}
			const scrollDelta = scrollTop - stored.scrollTop;
			const delta = top - stored.top + scrollDelta - (shift - stored.shift) + (pad - stored.pad);
			if (stored.element === anchor) {
				followGuardAnchors.set(port, {
					element: anchor,
					top,
					index,
					shift,
					pad,
					scrollTop,
					scrollHeight
				});
				return {
					anchor,
					index,
					top,
					delta
				};
			}
			if (!stored.element.isConnected && stored.index === index) return {
				anchor,
				index,
				top,
				delta
			};
			followGuardAnchors.set(port, {
				element: anchor,
				top,
				index,
				shift,
				pad,
				scrollTop,
				scrollHeight
			});
			return null;
		}
		/** Record the position the reader should keep seeing after a correction. */
		function holdGuardAnchor(port, measured, heldTop) {
			followGuardAnchors.set(port, {
				element: measured.anchor,
				index: measured.index,
				top: heldTop,
				shift: currentShiftOf(measured.anchor),
				pad: flowPadOf(port),
				scrollTop: port.scrollTop,
				scrollHeight: port.scrollHeight
			});
		}
		/** Last runway offset seen per port, to rebase the extent when the margin size changes. */
		const followRunwayOffsetHistory = /* @__PURE__ */ new WeakMap();
		/** Last observed scroll floor per port, for the slack→overflow runway re-measure. */
		const followFloorHistory = /* @__PURE__ */ new WeakMap();
		/** One-shot flag: the transition frame must paint the full runway as baseline. */
		const followSlackTransition = /* @__PURE__ */ new WeakSet();
		const followSettlePads = /* @__PURE__ */ new WeakMap();
		/**
		* Retired follower space lives as `padding-bottom` on the FLOW element — the
		* one node the engine already owns styles on (flow-fill min-height) and the
		* host never rewrites. Host completion commits routinely REPLACE row elements
		* (live→settled swap re-keys the assistant row, the status row unmounts), and
		* any engine space written on those rows dies with them, sinking the floor
		* and slamming the pinned transcript for a frame. The flow survives.
		*/
		function flowPadOf(port) {
			return followSettlePads.get(port)?.px ?? 0;
		}
		/**
		* After a loss is re-opened as pad, a registry entry whose element is no
		* longer connected claims extent that no longer exists; drop it so the next
		* `ensureRunway` re-measures fresh instead of double-counting.
		*/
		function pruneDeadRunway(port) {
			const runway = followRunways.get(port);
			if (runway !== void 0 && !runway.element.isConnected) {
				restoreRunway(port);
				return true;
			}
			return false;
		}
		function setFlowPad(port, px) {
			const flow = flowElementOf(port);
			if (flow === null) return;
			const maxPad = Math.max(0, debugRuntime.activeTuning().runwayPx);
			const clampedPx = Math.min(maxPad, Math.max(0, px));
			const existing = followSettlePads.get(port);
			const original = existing?.original ?? flow.style.paddingBottom;
			if (clampedPx <= .25) {
				if (existing !== void 0) {
					flow.style.paddingBottom = existing.original;
					followSettlePads.delete(port);
				}
				return;
			}
			flow.style.paddingBottom = original === "" ? `${clampedPx}px` : `calc(${original} + ${clampedPx}px)`;
			followSettlePads.set(port, {
				element: flow,
				original,
				px: clampedPx
			});
		}
		/** Extent the follower owns below the content: the live runway margin plus
		*  the retired completion pad. At adopt the pad is reclaimed into the fresh
		*  reservation (same frame, pre-paint), so the floor never steps. */
		function ownedBottomSpaceOf(port) {
			const maxPad = Math.max(0, debugRuntime.activeTuning().runwayPx);
			return Math.min(maxPad, runwayOffsetOf(port) + flowPadOf(port));
		}
		/**
		* Completion-window diagnostics. Armed when a follower hands off to its
		* settle loop; every engine decision and every externally-written scroll
		* position inside the window prints one compact console line, so a live
		* host session can be diffed against the lab without a debugger.
		*/
		let followTraceUntilMs = 0;
		function traceActive() {
			return debugRuntime.isEnabled() && performance.now() < followTraceUntilMs;
		}
		function followTrace(event, detail) {
			if (!traceActive()) return;
			console.log(`[dsh-follow] ${event}`, JSON.stringify(detail));
		}
		function hostShOf(port) {
			return port.scrollHeight;
		}
		function invalidatePaintLimit(port) {
			followPaintLimits.delete(port);
		}
		/** Logical position and velocity survive a React owner handoff and finish. */
		const followMotionStates = /* @__PURE__ */ new WeakMap();
		const followReaderHolds = /* @__PURE__ */ new WeakMap();
		/**
		* Commit-time correction channel. A reveal commit that lands after this
		* frame's ResizeObserver delivery would otherwise paint one intermediate
		* frame — content grown, scrollTop/transform not yet compensated — before
		* the next tick fixes it. Reveal arms call {@link notifyFollowCommit} right
		* after their commit; the leading follower re-runs its geometry in the same
		* task, so the intermediate state never reaches a paint.
		*/
		const followCommitListeners = /* @__PURE__ */ new WeakMap();
		function notifyFollowCommit(fromInsidePort) {
			if (fromInsidePort === null) return;
			const port = fromInsidePort.closest("[data-conversation-scroll]");
			const listeners = port === null ? void 0 : followCommitListeners.get(port);
			if (listeners === void 0) return;
			for (const listener of [...listeners]) listener();
		}
		function subscribeFollowCommit(port, fn) {
			let listeners = followCommitListeners.get(port);
			if (listeners === void 0) {
				listeners = /* @__PURE__ */ new Set();
				followCommitListeners.set(port, listeners);
			}
			listeners.add(fn);
			return () => {
				listeners.delete(fn);
			};
		}
		function restoreRunway(port) {
			const runway = followRunways.get(port);
			if (runway === void 0) return;
			runway.element.style[runway.property] = runway.original;
			followRunways.delete(port);
			invalidatePaintLimit(port);
		}
		function isLegacyRunway(value) {
			if (value === "") return false;
			const terms = [...value.matchAll(/([\d.]+)px/g)];
			if (terms.length === 0 || value.replaceAll(/calc|px|[\d.+()\s]/g, "") !== "") return false;
			const values = terms.map(([, raw]) => Number(raw));
			if (values.some((px) => !Number.isFinite(px))) return false;
			return [LEGACY_RUNWAY_PX, 72].some((unit) => values.every((px) => px >= unit && Math.abs(px % unit) <= Number.EPSILON));
		}
		/** Remove unowned runway residue written by v0.3.3 and earlier bundles. */
		function migrateLegacyRunway(port, surfaces, status, composer) {
			if (followRunways.has(port)) return false;
			let migrated = false;
			if (status !== null && isLegacyRunway(status.style.marginTop)) {
				status.style.marginTop = "";
				migrated = true;
			}
			const last = surfaces.at(-1);
			if (status === null && composer !== null && last !== void 0 && isLegacyRunway(last.style.marginBottom)) {
				last.style.marginBottom = "";
				migrated = true;
			}
			if (migrated) invalidatePaintLimit(port);
			return migrated;
		}
		function ensureRunway(port, surfaces, runwayPx = 72) {
			const status = turnStatusOf(port);
			const composer = port.querySelector("[data-composer-seat]");
			if (status !== null && followRunways.get(port) === void 0) {
				const inlinePx = Number.parseFloat(status.style.marginTop ?? "") || 0;
				if (Math.abs(inlinePx - 72) <= .5) {
					followRunways.set(port, {
						element: status,
						offset: inlinePx,
						property: "marginTop",
						original: "",
						requestedPx: inlinePx
					});
					invalidatePaintLimit(port);
				}
			}
			const migratedLegacy = migrateLegacyRunway(port, surfaces, status, composer);
			const naturalHeight = Math.max(0, port.scrollHeight - runwayOffsetOf(port));
			const existing = followRunways.get(port);
			const budget = Math.max(0, debugRuntime.activeTuning().runwayPx);
			const maxRunway = Math.min(budget, Math.max(0, runwayPx, migratedLegacy || existing?.normalizedLegacy === true ? budget : 0));
			if (flowPadOf(port) > budget) setFlowPad(port, budget);
			const currentPad = flowPadOf(port);
			const remainingAllowance = Math.max(0, maxRunway - currentPad);
			const requestedRunwayPx = Math.min(maxRunway, remainingAllowance);
			if (requestedRunwayPx <= 0 || port.clientHeight <= 0 || naturalHeight <= port.clientHeight) {
				restoreRunway(port);
				return;
			}
			const target = status === null ? {
				element: composer === null ? void 0 : surfaces.at(-1),
				property: "marginBottom"
			} : {
				element: status,
				property: "marginTop"
			};
			if (target.element === void 0) {
				restoreRunway(port);
				return;
			}
			const element = target.element;
			const current = followRunways.get(port);
			if (current?.element === element && current.property === target.property && Math.abs(current.requestedPx - requestedRunwayPx) < 1) return;
			const original = current?.element === element && current.property === target.property ? current.original : element.style[target.property];
			if (current?.element !== element || current?.property !== target.property) restoreRunway(port);
			const beforeHeight = port.scrollHeight;
			element.style[target.property] = original === "" ? `${requestedRunwayPx}px` : `calc(${original} + ${requestedRunwayPx}px)`;
			const offset = Math.min(requestedRunwayPx, Math.max(0, port.scrollHeight - beforeHeight + (current?.offset ?? 0)));
			followRunways.set(port, {
				element,
				offset,
				property: target.property,
				original,
				requestedPx: requestedRunwayPx,
				normalizedLegacy: migratedLegacy || existing?.normalizedLegacy === true
			});
			invalidatePaintLimit(port);
		}
		function runwayOffsetOf(port) {
			return followRunways.get(port)?.offset ?? 0;
		}
		/**
		* Move owned runway margin into the persistent flow pad without changing the
		* scroll extent. Returns the actual layout pixels removed from the margin.
		*/
		function transferRunwayToFlowPad(port, requestedPx) {
			const runway = followRunways.get(port);
			if (runway === void 0 || requestedPx <= 0 || !runway.element.isConnected) return 0;
			const nextRequestedPx = Math.max(0, runway.requestedPx - requestedPx);
			const beforeOffset = runway.offset;
			const beforeHeight = port.scrollHeight;
			runway.element.style[runway.property] = nextRequestedPx <= .25 ? runway.original : runway.original === "" ? `${nextRequestedPx}px` : `calc(${runway.original} + ${nextRequestedPx}px)`;
			const nextOffset = Math.max(0, beforeOffset + port.scrollHeight - beforeHeight);
			const transferredPx = Math.max(0, beforeOffset - nextOffset);
			if (nextRequestedPx <= .25 || nextOffset <= .25) followRunways.delete(port);
			else followRunways.set(port, {
				...runway,
				offset: nextOffset,
				requestedPx: nextRequestedPx
			});
			if (transferredPx > 0) {
				const maxPad = Math.max(0, debugRuntime.activeTuning().runwayPx);
				setFlowPad(port, Math.min(maxPad, flowPadOf(port) + transferredPx));
				invalidatePaintLimit(port);
			}
			return transferredPx;
		}
		/** Available paint room below the last message before fixed conversation chrome. */
		function safeShiftLimit(port, surfaces) {
			const last = surfaces.at(-1);
			if (last === void 0) return 0;
			const status = turnStatusOf(port);
			const composer = port.querySelector("[data-composer-seat]");
			if (status !== null || composer !== null) followHadChrome.add(port);
			const cached = followPaintLimits.get(port);
			if (cached !== void 0 && performance.now() - cached.measuredAtMs <= 250 && cached.clientHeight === port.clientHeight && cached.surface === last && cached.status === status && cached.composer === composer) return cached.limit;
			const ceiling = [status, composer].filter((element) => element !== null).map((element) => ({
				element,
				rect: element.getBoundingClientRect()
			})).filter(({ rect }) => Number.isFinite(rect.top) && Number.isFinite(rect.bottom) && rect.bottom > rect.top).sort((first, second) => first.rect.top - second.rect.top)[0];
			if (ceiling === void 0) return status === null && composer === null ? followHadChrome.has(port) ? 0 : Number.POSITIVE_INFINITY : runwayOffsetOf(port);
			const ceilingTop = ceiling.rect.top - currentShiftOf(ceiling.element);
			const naturalBottom = last.getBoundingClientRect().bottom - currentShiftOf(last);
			const limit = Math.max(0, ceilingTop - naturalBottom - 1);
			followPaintLimits.set(port, {
				clientHeight: port.clientHeight,
				limit,
				measuredAtMs: performance.now(),
				composer,
				status,
				surface: last
			});
			return limit;
		}
		function setFollowScrollTop(port, nextTop) {
			const ledger = followScrollLedgers.get(port);
			if (port.getAttribute(FOLLOW_OWNED_ATTR) === null) port.setAttribute(FOLLOW_OWNED_ATTR, "active");
			if (ledger !== void 0 && traceActive() && Math.abs(port.scrollTop - ledger) > 1) followTrace("external-scroll", {
				from: Math.round(port.scrollTop),
				to: Math.round(nextTop),
				ledger: Math.round(ledger)
			});
			if (Math.abs(port.scrollTop - nextTop) > .01) port.scrollTop = nextTop;
			followScrollLedgers.set(port, port.scrollTop);
			const ownedTop = String(port.scrollTop);
			if (port.getAttribute(FOLLOW_OWNED_ATTR) !== ownedTop) port.setAttribute(FOLLOW_OWNED_ATTR, ownedTop);
		}
		/**
		* Last scrollTop this engine wrote or accepted, per port. Reader intent is a
		* real upward delta from this ledger; a key press or touch while pinned
		* (typing in the composer) must not release the pin, because a released pin
		* can never re-acquire while content streams away from the reader position.
		*/
		const followScrollLedgers = /* @__PURE__ */ new WeakMap();
		const followActivityAt = /* @__PURE__ */ new WeakMap();
		/**
		* Scroll ownership must survive follower-arm remounts. Per-closure state let a
		* new text/tool arm reset the strike counter, so the same host write kept
		* triggering another engine write and repainting the visible up/down fight.
		*/
		const followHostScrollPorts = /* @__PURE__ */ new WeakMap();
		/** Clear host ownership only when a new user turn actually starts. */
		function resetHostScrollOwnershipForNewTurn(port) {
			const ownership = followHostScrollPorts.get(port);
			if (ownership === void 0) return;
			const userRows = countUserRows(port);
			if (userRows >= 0 && userRows > ownership.userRows) followHostScrollPorts.delete(port);
		}
		/** Whether this port was owned recently enough to identify a closing tail row. */
		function hasRecentConversationFollow(port, windowMs = 250) {
			const last = followActivityAt.get(port);
			return last !== void 0 && performance.now() - last <= windowMs;
		}
		function readerScrolledUp(port) {
			return port.scrollTop < (followScrollLedgers.get(port) ?? 0) - 8;
		}
		const followBudgetReleases = /* @__PURE__ */ new WeakMap();
		const followSpaceEpochs = /* @__PURE__ */ new WeakMap();
		const followSettleStops = /* @__PURE__ */ new WeakMap();
		function cancelBudgetRelease(port) {
			const release = followBudgetReleases.get(port);
			if (release !== void 0) cancelAnimationFrame(release.frame);
			followBudgetReleases.delete(port);
		}
		/** Layout budget is strict; only a temporary transform may outlive a reduction. */
		function reconcileFollowBudget(port) {
			const cap = Math.max(0, debugRuntime.activeTuning().runwayPx);
			const runway = followRunways.get(port);
			const pad = flowPadOf(port);
			if (pad + (runway?.requestedPx ?? 0) <= cap) return;
			const previousTop = port.scrollTop;
			setFlowPad(port, Math.min(pad, cap));
			ensureRunway(port, shiftSurfacesOf(port), Math.min(runway?.requestedPx ?? 0, Math.max(0, cap - flowPadOf(port))));
			const floor = Math.max(0, port.scrollHeight - port.clientHeight);
			setFollowScrollTop(port, Math.min(previousTop, floor));
			const adjustment = port.scrollTop - previousTop;
			if (adjustment >= -.01) return;
			const existing = followBudgetReleases.get(port);
			const release = existing ?? {
				shift: 0,
				last: performance.now(),
				frame: 0
			};
			release.shift += adjustment;
			followBudgetReleases.set(port, release);
			for (const surface of shiftSurfacesOf(port)) setShift(surface, currentShiftOf(surface) + adjustment);
			if (existing !== void 0) return;
			const tick = (now) => {
				if (followBudgetReleases.get(port) !== release) return;
				const elapsed = Math.min(64, Math.max(0, now - release.last));
				release.last = now;
				const before = release.shift;
				const response = debugRuntime.activeTuning().reserveResponseMs;
				const magnitude = Math.abs(before);
				const step = Math.min(magnitude, Math.max(.25, magnitude * (1 - Math.exp(-elapsed / response))), 8 * elapsed / 16.67);
				release.shift = before - Math.sign(before) * step;
				if (Math.abs(release.shift) < .01) release.shift = 0;
				for (const surface of shiftSurfacesOf(port)) setShift(surface, currentShiftOf(surface) + release.shift - before);
				if (release.shift === 0 || !port.isConnected) followBudgetReleases.delete(port);
				else release.frame = requestAnimationFrame(tick);
			};
			release.frame = requestAnimationFrame(tick);
		}
		const followSuspensions = /* @__PURE__ */ new WeakMap();
		const followRecoveryTimes = /* @__PURE__ */ new WeakMap();
		const foregroundScrollHolds = /* @__PURE__ */ new WeakMap();
		const foregroundReaderReleases = /* @__PURE__ */ new WeakMap();
		function releaseForegroundScrollHold(port, owner, defer = false) {
			const hold = foregroundScrollHolds.get(port);
			if (hold === void 0) return;
			hold.owners.delete(owner);
			const stopIfUnused = () => {
				if (foregroundScrollHolds.get(port) !== hold || hold.owners.size !== 0) return;
				foregroundScrollHolds.delete(port);
				hold.stop();
			};
			if (defer) queueMicrotask(stopIfUnused);
			else stopIfUnused();
		}
		/** Native foreground delay pauses Host scroll motion as well as our reveal clock. */
		function holdForegroundScroll(port, owner, sequence) {
			const previous = foregroundScrollHolds.get(port);
			if (previous?.sequence === sequence) {
				previous.owners.add(owner);
				return;
			}
			previous?.stop();
			const owners = /* @__PURE__ */ new Set([owner]);
			const overflowAnchor = port.style.overflowAnchor;
			const scrollBehavior = port.style.scrollBehavior;
			let top = port.scrollTop;
			const readingAnchor = () => {
				const rows = [...port.querySelectorAll("[data-chat-anchor-key]")];
				const viewport = port.getBoundingClientRect();
				return rows.find((row) => {
					const rect = row.getBoundingClientRect();
					return rect.height > 0 && rect.bottom > viewport.top && rect.top < viewport.bottom;
				}) ?? rows.at(-1) ?? readingAnchorOf(port);
			};
			let anchor = readingAnchor();
			let anchorTop = port.clientHeight > 0 && anchor !== null ? anchor.getBoundingClientRect().top - port.getBoundingClientRect().top : null;
			let frame = 0;
			let restoring = false;
			let readerReleased = foregroundReaderReleases.get(port) === sequence;
			let touchStartY = null;
			let heldPad = 0;
			const releasePad = () => {
				if (heldPad <= 0) return;
				setFlowPad(port, Math.max(0, flowPadOf(port) - heldPad));
				heldPad = 0;
			};
			port.style.overflowAnchor = "none";
			port.style.scrollBehavior = "auto";
			if (!readerReleased) {
				port.scrollTo?.({
					top,
					behavior: "instant"
				});
				port.setAttribute(FOLLOW_OWNED_ATTR, String(top));
			}
			const rememberReader = () => {
				const suspended = followSuspensions.get(port);
				if (suspended !== void 0) {
					suspended.following = false;
					suspended.readerTop = port.scrollTop;
				}
				followReaderHolds.set(port, { atMs: performance.now() });
			};
			const restore = () => {
				if (restoring) return;
				if (readerReleased) {
					rememberReader();
					return;
				}
				if (port.clientHeight <= 0) return;
				if (anchor !== null && port.contains(anchor) && anchorTop !== null) top = port.scrollTop + anchor.getBoundingClientRect().top - port.getBoundingClientRect().top - anchorTop;
				else {
					anchor = readingAnchor();
					anchorTop = anchor === null ? null : anchor.getBoundingClientRect().top - port.getBoundingClientRect().top;
				}
				const missingExtent = top - Math.max(0, port.scrollHeight - port.clientHeight);
				if (missingExtent > .01) {
					const previousPad = flowPadOf(port);
					setFlowPad(port, previousPad + missingExtent);
					heldPad += Math.max(0, flowPadOf(port) - previousPad);
				}
				top = Math.max(0, Math.min(top, Math.max(0, port.scrollHeight - port.clientHeight)));
				restoring = true;
				if (Math.abs(port.scrollTop - top) > .01) port.scrollTop = top;
				const ownedTop = String(port.scrollTop);
				if (port.getAttribute(FOLLOW_OWNED_ATTR) !== ownedTop) port.setAttribute(FOLLOW_OWNED_ATTR, ownedTop);
				const suspended = followSuspensions.get(port);
				if (suspended !== void 0 && !suspended.following) suspended.readerTop = port.scrollTop;
				restoring = false;
			};
			const releaseToReader = (event) => {
				if (event.type === "touchstart") {
					touchStartY = event.touches[0]?.clientY ?? null;
					return;
				}
				if (event.type === "touchend" || event.type === "touchcancel") {
					touchStartY = null;
					return;
				}
				if (readerReleased) return;
				if (event.type === "wheel") {
					const delta = event.deltaY;
					if (!Number.isFinite(delta) || delta === 0) return;
				} else if (event.type === "touchmove") {
					const y = event.touches[0]?.clientY;
					if (y === void 0 || touchStartY === null || Math.abs(y - touchStartY) <= 1) return;
				} else if (event instanceof KeyboardEvent) {
					if (![
						"ArrowUp",
						"ArrowDown",
						"PageUp",
						"PageDown",
						"Home",
						"End",
						" "
					].includes(event.key)) return;
					if (event.target instanceof Element && event.target.closest("input, textarea, select, button, a, [role=\"button\"], [contenteditable]:not([contenteditable=\"false\"])") !== null) return;
				} else return;
				readerReleased = true;
				foregroundReaderReleases.set(port, sequence);
				releasePad();
				port.removeAttribute(FOLLOW_OWNED_ATTR);
				rememberReader();
			};
			const tick = () => {
				if (!port.isConnected) {
					foregroundScrollHolds.delete(port);
					stop();
					return;
				}
				restore();
				frame = requestAnimationFrame(tick);
			};
			const unsubscribeCommit = subscribeFollowCommit(port, restore);
			const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(restore);
			resize?.observe(port);
			const flow = flowElementOf(port);
			if (flow !== null) resize?.observe(flow);
			if (anchor !== null && anchor !== flow) resize?.observe(anchor);
			const stop = () => {
				cancelAnimationFrame(frame);
				unsubscribeCommit();
				resize?.disconnect();
				releasePad();
				port.removeEventListener("scroll", restore, true);
				for (const name of GESTURE_EVENTS) port.removeEventListener(name, releaseToReader);
				if (port.style.overflowAnchor === "none") port.style.overflowAnchor = overflowAnchor;
				if (port.style.scrollBehavior === "auto") port.style.scrollBehavior = scrollBehavior;
				if (!readerReleased && port.getAttribute(FOLLOW_OWNED_ATTR) === String(top)) port.removeAttribute(FOLLOW_OWNED_ATTR);
			};
			foregroundScrollHolds.set(port, {
				sequence,
				owners,
				stop
			});
			port.addEventListener("scroll", restore, {
				capture: true,
				passive: true
			});
			for (const name of GESTURE_EVENTS) port.addEventListener(name, releaseToReader, { passive: true });
			frame = requestAnimationFrame(tick);
		}
		/** Drop stale paint geometry while retaining the reader and Host ownership. */
		function suspendFollowPort(port) {
			const previous = followSuspensions.get(port);
			if (previous?.hidden) return;
			const hostOwner = followHostScrollPorts.get(port);
			const readerHold = followReaderHolds.get(port);
			const shift = currentShiftOf(shiftSurfacesOf(port).at(-1) ?? port);
			const measurable = port.clientHeight > 0;
			const floor = Math.max(0, port.scrollHeight - port.clientHeight);
			const following = previous?.pending ? previous.following && readerHold === void 0 : readerHold === void 0 && (!measurable ? followLeaders.has(port) || hostOwner !== void 0 : !readerScrolledUp(port) && (followLeaders.has(port) || hostOwner !== void 0 || floor - port.scrollTop <= 1));
			const readerTop = previous?.pending && readerHold === void 0 ? previous.readerTop : Math.max(0, (measurable ? port.scrollTop : followScrollLedgers.get(port) ?? port.scrollTop) - shift);
			releaseFollowSpace(port);
			followLeaders.delete(port);
			if (hostOwner !== void 0) followHostScrollPorts.set(port, hostOwner);
			if (!following) followReaderHolds.set(port, readerHold ?? { atMs: performance.now() });
			if (!following) setFollowScrollTop(port, Math.min(readerTop, Math.max(0, port.scrollHeight - port.clientHeight)));
			port.removeAttribute(FOLLOW_OWNED_ATTR);
			followSuspensions.set(port, {
				sequence: (previous?.sequence ?? 0) + 1,
				hidden: true,
				pending: true,
				following,
				readerTop,
				userRows: countUserRows(port)
			});
		}
		function resumeFollowPort(port) {
			const state = followSuspensions.get(port);
			if (state !== void 0) state.hidden = false;
			followRecoveryTimes.set(port, performance.now());
			invalidatePaintLimit(port);
		}
		/** Restore only styles owned by this plugin, leaving host spacer/chrome intact. */
		function releaseFollowSpace(port) {
			followSpaceEpochs.set(port, (followSpaceEpochs.get(port) ?? 0) + 1);
			for (const stop of followSettleStops.get(port) ?? []) stop();
			followSettleStops.delete(port);
			clearVisual(port);
			setFlowPad(port, 0);
			restoreFlowFill(port);
			followCompletionSettle.delete(port);
			followCompletionSettleRows.delete(port);
			followGuardAnchors.delete(port);
			followRunwayOffsetHistory.delete(port);
			followFloorHistory.delete(port);
			followActivePorts.delete(port);
			followMotionStates.delete(port);
			const floor = Math.max(0, port.scrollHeight - port.clientHeight);
			if (port.scrollTop > floor) setFollowScrollTop(port, floor);
			port.removeAttribute(FOLLOW_OWNED_ATTR);
			followScrollLedgers.delete(port);
			followHostScrollPorts.delete(port);
			followReaderHolds.delete(port);
			debugRuntime.reportFollow(port, null);
		}
		/**
		* Paint a bounded visual lag and return the effective logical extent.
		*
		* This is the final geometry invariant, not merely an animation preference:
		* any lag beyond the real gap to status/composer chrome is caught up in the
		* same frame. Carrying that excess in `scrollTop` would move the transcript
		* toward fixed chrome and also make the host expose jump-to-bottom.
		*/
		function applyVisual(port, animatedH, reservePx, velocityPxPerSec = 0, runwayPx = 72, shiftCeilingPx = Number.POSITIVE_INFINITY, promoteAtRest = false, trajectoryShiftPx, dtMs = 16.7, writeScrollTop = true) {
			const surfaces = shiftSurfacesOf(port);
			ensureFlowFillsPort(port);
			if (!followPortStyles.has(port)) followPortStyles.set(port, {
				overflowAnchor: port.style.overflowAnchor,
				scrollBehavior: port.style.scrollBehavior
			});
			{
				const preFloor = Math.max(0, port.scrollHeight - port.clientHeight);
				const lastFloorSeen = followFloorHistory.get(port);
				if (lastFloorSeen !== void 0 && lastFloorSeen === 0 && preFloor > 0 && followRunways.has(port)) {
					const owned = followRunways.get(port);
					restoreRunway(port);
					ensureRunway(port, surfaces, owned?.requestedPx ?? runwayPx);
					followSlackTransition.add(port);
				}
				if (preFloor !== lastFloorSeen) followFloorHistory.set(port, preFloor);
			}
			ensureRunway(port, surfaces, reservePx);
			const contentHeight2 = Math.max(0, port.scrollHeight);
			const runwayOffset2 = runwayOffsetOf(port);
			const prevOffset2 = followRunwayOffsetHistory.get(port);
			if (prevOffset2 !== void 0 && runwayOffset2 !== prevOffset2) animatedH = Math.max(0, animatedH - (runwayOffset2 - prevOffset2));
			followRunwayOffsetHistory.set(port, runwayOffset2);
			const contentHeight = contentHeight2;
			const runwayOffset = runwayOffset2;
			const targetHeight = Math.max(0, contentHeight - runwayOffset);
			const floor = Math.max(0, contentHeight - port.clientHeight);
			const extent = Math.min(targetHeight, Math.max(0, animatedH));
			if (port.style.overflowAnchor !== "none") port.style.overflowAnchor = "none";
			if (port.style.scrollBehavior !== "auto") port.style.scrollBehavior = "auto";
			if (floor <= 0) {
				followRunwayOffsetHistory.set(port, 0);
				if (writeScrollTop) setFollowScrollTop(port, 0);
				followMotionStates.set(port, {
					capacityPx: Number.POSITIVE_INFINITY,
					constrained: false,
					extent: targetHeight,
					lagPx: 0,
					reservePx: 0,
					velocityPxPerSec: 0
				});
				for (const surface of surfaces) setShift(surface, 0);
				followLastShiftPx.set(port, 0);
				const status = turnStatusOf(port);
				if (status !== null) setShift(status, 0);
				return targetHeight;
			}
			if (writeScrollTop) setFollowScrollTop(port, floor);
			const limit = safeShiftLimit(port, surfaces);
			followSlackTransition.delete(port);
			const visibleReserve = Math.min(runwayOffset, Math.max(0, reservePx), Math.max(0, runwayPx));
			const baselineShift = runwayOffset - visibleReserve;
			const requestedLag = Math.max(0, targetHeight - extent);
			const availableShift = Math.min(Math.max(0, limit), Math.max(0, shiftCeilingPx));
			let shift = Math.min(trajectoryShiftPx ?? baselineShift + requestedLag, availableShift);
			const previousShift = followLastShiftPx.get(port);
			const previousFloor = followLastFloorPx.get(port);
			const floorDropPx = Math.max(0, (previousFloor ?? floor) - floor);
			const maxDecayPx = Math.max(dtMs <= 0 ? 8 : Math.max(1, 8 / 16.67 * dtMs), floorDropPx);
			followLastFloorPx.set(port, floor);
			if (previousShift !== void 0 && shift < previousShift - maxDecayPx) shift = previousShift - maxDecayPx;
			if (followCompletionSettle.has(port) && previousShift !== void 0 && previousFloor !== void 0) {
				const confirmedGrowthPx = Math.max(0, floor - previousFloor);
				if (shift > previousShift + confirmedGrowthPx) shift = previousShift + confirmedGrowthPx;
			}
			followLastShiftPx.set(port, shift);
			const requestedShift = trajectoryShiftPx ?? baselineShift + requestedLag;
			const effectiveLag = Math.max(0, shift - baselineShift);
			const capacityPx = Math.max(0, limit - baselineShift);
			const effectiveExtent = targetHeight - effectiveLag;
			const isConstrained = requestedShift > availableShift + .25 || limit <= 0 && requestedShift > baselineShift;
			if (writeScrollTop) setFollowScrollTop(port, floor);
			followMotionStates.set(port, {
				capacityPx,
				constrained: isConstrained,
				extent: effectiveExtent,
				lagPx: effectiveLag,
				reservePx: visibleReserve,
				velocityPxPerSec
			});
			const release = followBudgetReleases.get(port);
			if (release !== void 0) release.shift = currentShiftOf(surfaces.at(-1) ?? port) - shift;
			for (const surface of surfaces) setShift(surface, shift + (release?.shift ?? 0));
			const status = turnStatusOf(port);
			if (status !== null) setShift(status, 0);
			return effectiveExtent;
		}
		function clearMotion(port) {
			port.removeAttribute(FOLLOW_OWNED_ATTR);
			const original = followPortStyles.get(port);
			if (original !== void 0) {
				port.style.overflowAnchor = original.overflowAnchor;
				port.style.scrollBehavior = original.scrollBehavior;
				followPortStyles.delete(port);
			}
			for (const surface of shiftSurfacesOf(port)) setShift(surface, 0);
			const status = turnStatusOf(port);
			if (status !== null) setShift(status, 0);
		}
		function clearVisual(port) {
			cancelBudgetRelease(port);
			clearMotion(port);
			restoreRunway(port);
			followMotionStates.delete(port);
			followLastShiftPx.delete(port);
			followLastFloorPx.delete(port);
			invalidatePaintLimit(port);
		}
		/** Keep an already-promoted surface at zero until one stable final paint lands. */
		function holdCompositorAtRest(element) {
			directShiftCache.set(element, 0);
			const original = followSurfaceStyles.get(element);
			element.style.transform = `translate3d(0, 0px, 0)${original?.transform ? ` ${original.transform}` : ""}`;
			element.style.willChange = "transform";
			element.style.clipPath = "";
		}
		/** Remove equal offsets, land on the floor, then retire the compositor quietly. */
		function finishAtNaturalFloor(port, retainCompositor = true, writeScrollTop = true) {
			if (followBudgetReleases.has(port)) return;
			followCompletionSettle.delete(port);
			followTraceUntilMs = Math.max(followTraceUntilMs, performance.now() + 1e4);
			followTrace("finish-enter", {
				sh: hostShOf(port),
				st: Math.round(port.scrollTop),
				pad: Math.round(flowPadOf(port)),
				retain: retainCompositor
			});
			const surfaces = shiftSurfacesOf(port);
			const status = turnStatusOf(port);
			if (!retainCompositor) {
				restoreRunway(port);
				if (writeScrollTop) settleAtFloor(port);
				clearMotion(port);
				followMotionStates.delete(port);
				return;
			}
			const promoted = [...surfaces, ...status === null ? [] : [status]].filter((element) => element.style.transform !== "" || element.style.willChange === "transform");
			const promotedSet = new Set(promoted);
			if (writeScrollTop) settleAtFloor(port);
			port.removeAttribute(FOLLOW_OWNED_ATTR);
			const original = followPortStyles.get(port);
			if (original !== void 0) {
				port.style.overflowAnchor = original.overflowAnchor;
				port.style.scrollBehavior = original.scrollBehavior;
				followPortStyles.delete(port);
			}
			for (const surface of surfaces) if (promotedSet.has(surface)) holdCompositorAtRest(surface);
			else setShift(surface, 0);
			if (status !== null) {
				if (promotedSet.has(status)) holdCompositorAtRest(status);
				else setShift(status, 0);
			}
			followMotionStates.delete(port);
			if (promoted.length === 0) return;
			requestAnimationFrame(() => {
				requestAnimationFrame(() => {
					for (const element of promoted) if (Math.abs(currentShiftOf(element)) <= .01) setShift(element, 0);
				});
			});
		}
		function settleAtFloor(port) {
			setFollowScrollTop(port, Math.max(0, port.scrollHeight - port.clientHeight));
			followReaderHolds.delete(port);
		}
		/** Only the newest active follower may write one port's shared visual state. */
		const followLeaders = /* @__PURE__ */ new WeakMap();
		let followGeneration = 0;
		/** Ports with a live streaming arm; completion guards must not fight them. */
		const followActivePorts = /* @__PURE__ */ new WeakSet();
		/**
		* Own the conversation scrollport's bottom-follow while `active` is true.
		*
		* @param rootRef - An element inside the conversation scrollport.
		* @param active - True while the reply is still revealing.
		* @param speedCpsRef - Live reveal-rate EMA from the smoother.
		* @param revealScaleRef - Optional backpressure control for text reveal.
		* @param predictive - Whether to reserve paint room ahead of growth.
		* @param entrance - Whether the first committed row height should glide in.
		* @param onEntranceSettled - Releases a one-shot entrance owner after catch-up.
		* @param predictiveRef - Optional live visibility gate for predictive runway.
		* @param entranceExtentRef - Optional measured growth delta for a generic row.
		* @param revealedCharsRef - Committed code-point count for feed-forward phase.
		* @param controlScroll - When false, leave the scrollport entirely to the Host.
		*/
		function useConversationFollow(rootRef, active, speedCpsRef, revealScaleRef, predictive = true, entrance = false, onEntranceSettled, predictiveRef, entranceExtentRef, revealedCharsRef, controlScroll = true) {
			const activeRef = (0, react.useRef)(active);
			const entranceRef = (0, react.useRef)(entrance);
			const onEntranceSettledRef = (0, react.useRef)(onEntranceSettled);
			entranceRef.current = entrance;
			onEntranceSettledRef.current = onEntranceSettled;
			activeRef.current = active;
			const controlScrollRef = (0, react.useRef)(controlScroll);
			controlScrollRef.current = controlScroll;
			const [settlingOwner, setSettlingOwner] = (0, react.useState)(null);
			const [lifecycleVersion, setLifecycleVersion] = (0, react.useState)(0);
			const lifecycle = useBackgroundRecovery("replay", () => {
				if (!controlScrollRef.current) return;
				const port = rootRef.current?.closest("[data-conversation-scroll]");
				if (port !== void 0 && port !== null) suspendFollowPort(port);
				setLifecycleVersion((version) => version + 1);
			}, () => {
				if (!controlScrollRef.current) return;
				const port = rootRef.current?.closest("[data-conversation-scroll]");
				if (port !== void 0 && port !== null) resumeFollowPort(port);
				setLifecycleVersion((version) => version + 1);
			}, void 0, void 0, false, controlScroll && (active || settlingOwner !== null), (sequence) => {
				const port = rootRef.current?.closest("[data-conversation-scroll]");
				if (!controlScrollRef.current || port === void 0 || port === null) return;
				const owner = {};
				holdForegroundScroll(port, owner, sequence);
				return (reason) => releaseForegroundScrollHold(port, owner, reason === "dispose" && controlScrollRef.current);
			});
			const lifecycleRef = (0, react.useRef)(lifecycle);
			lifecycleRef.current = lifecycle;
			(0, react.useLayoutEffect)(() => {
				if (!controlScroll || lifecycleRef.current.hidden()) return;
				if (!active) return;
				const startedAsEntrance = entrance;
				const owner = {};
				const generation = ++followGeneration;
				let rafId = 0;
				let last = performance.now();
				let following = true;
				let primed = false;
				let animatedH = 0;
				let reservePx = 0;
				let velocityPxPerSec = 0;
				let interacting = false;
				let readerGestureIntent = false;
				let readerReleased = false;
				let touchStartY = null;
				let interactTimer = null;
				let port = null;
				let spaceEpoch = 0;
				const initialPort = rootRef.current?.closest("[data-conversation-scroll]");
				const initialSuspension = initialPort ? followSuspensions.get(initialPort) : void 0;
				let resumeSequence = initialSuspension?.pending ? 0 : initialSuspension?.sequence ?? 0;
				let resize = null;
				let mutations = null;
				let observedTail = null;
				let statusWasPresent = null;
				let trajectoryPositionPx = null;
				let trajectoryVelocityPxPerMs = 0;
				let trajectoryTargetVelocityPxPerMs = 0;
				let trajectoryFloorPx = null;
				let trajectoryGrowthAtMs = null;
				let trajectoryAccumulatedGrowthPx = 0;
				let trajectoryAccumulatedGrowthMs = 0;
				let trajectoryGrowthSamples = 0;
				let trajectoryWasActive = false;
				let revealPhase = new FollowRevealPhaseTracker();
				let holding = null;
				let entrancePending = entranceRef.current;
				let predictionNaturalHeight = null;
				let predictionSawGrowth = false;
				const predictsGrowth = (next) => {
					if (predictiveRef === void 0) return predictive;
					const naturalHeight = next.scrollHeight - ownedBottomSpaceOf(next);
					if (!predictiveRef.current) {
						predictionNaturalHeight = naturalHeight;
						predictionSawGrowth = false;
						return false;
					}
					if (predictionNaturalHeight === null) predictionNaturalHeight = naturalHeight;
					if (naturalHeight > predictionNaturalHeight + .5) predictionSawGrowth = true;
					return predictionSawGrowth;
				};
				const finishEntrance = () => {
					if (!entrancePending) return;
					entrancePending = false;
					onEntranceSettledRef.current?.();
				};
				const updateRevealScale = (next, elapsedMs, urgent = false) => {
					if (revealScaleRef === void 0) return;
					const tuning = debugRuntime.activeTuning();
					const state = followMotionStates.get(next);
					const target = state === void 0 ? 1 : computeFollowRevealScale(state.lagPx, state.capacityPx, state.constrained, tuning);
					const current = Math.min(1, Math.max(tuning.backpressureMinScale, revealScaleRef.current));
					if (target < current || urgent) {
						revealScaleRef.current = Math.min(current, target);
						return;
					}
					const releaseStep = 1 - Math.exp(-Math.max(0, elapsedMs) / 240);
					revealScaleRef.current = current + (target - current) * releaseStep;
				};
				const releaseRevealScale = () => {
					if (revealScaleRef !== void 0) revealScaleRef.current = 1;
				};
				const reportFollow = (next, isActive) => {
					const state = followMotionStates.get(next);
					debugRuntime.reportFollow(next, {
						lagPx: state ? state.lagPx : -1,
						velocityPxPerSec: state?.velocityPxPerSec ?? 0,
						reservePx: state?.reservePx ?? 0,
						capacityPx: state ? state.capacityPx : -1,
						revealScale: revealScaleRef?.current ?? 1,
						following,
						constrained: state?.constrained ?? false,
						scrollTop: next.scrollTop,
						scrollHeight: next.scrollHeight,
						clientHeight: next.clientHeight,
						active: isActive
					});
				};
				const isLeader = (next) => followLeaders.get(next)?.owner === owner;
				const hold = (next) => {
					followActivityAt.set(next, performance.now());
					if (holding === next && isLeader(next)) return;
					holding = next;
					const leader = followLeaders.get(next);
					if ((leader === void 0 || generation > leader.generation) && !completionSettleGuardsPort(next)) {
						followCompletionSettle.delete(next);
						followLeaders.set(next, {
							generation,
							owner
						});
					}
				};
				const yieldScrollOwnership = (next, floor) => {
					if (hostOwnsScroll) return;
					hostOwnsScroll = true;
					followHostScrollPorts.set(next, { userRows: countUserRows(next) });
					followTrace("yield-scroll", {
						from: Math.round(next.scrollTop),
						to: Math.round(floor)
					});
					clearVisual(next);
					setFollowScrollTop(next, Math.max(0, next.scrollHeight - next.clientHeight));
					next.removeAttribute(FOLLOW_OWNED_ATTR);
					followLeaders.delete(next);
					releaseRevealScale();
					debugRuntime.reportFollow(next, null);
				};
				const hostInputFoldActive = (next) => {
					return flowElementOf(next)?.hasAttribute("data-input-fold") === true || next.querySelector("[data-chat-transcript][data-input-fold], [data-chat-flow][data-input-fold]") !== null;
				};
				const yieldToInputFold = (next) => {
					if (followHostScrollPorts.has(next)) {
						hostOwnsScroll = true;
						return;
					}
					const readerHold = followReaderHolds.get(next);
					releaseFollowSpace(next);
					followLeaders.delete(next);
					followHostScrollPorts.set(next, { userRows: countUserRows(next) });
					if (readerHold !== void 0) followReaderHolds.set(next, readerHold);
					hostOwnsScroll = true;
					releaseRevealScale();
				};
				const detectHostScroll = (next, floor) => {
					if (followHostScrollPorts.has(next)) {
						hostOwnsScroll = true;
						return;
					}
					const ledger = followScrollLedgers.get(next);
					if (ledger === void 0 || Math.abs(next.scrollTop - ledger) <= 1) return;
					if (Math.abs(next.scrollTop - floor) <= 1) {
						followScrollLedgers.set(next, next.scrollTop);
						externalScrollStrikes = 0;
						return;
					}
					externalScrollStrikes += 1;
					if (externalScrollStrikes >= 2) yieldScrollOwnership(next, floor);
				};
				const drop = (next) => {
					if (holding === next) holding = null;
					if (isLeader(next)) {
						clearMotion(next);
						followMotionStates.delete(next);
						releaseRevealScale();
						debugRuntime.reportFollow(next, null);
					}
				};
				const handBackVisual = (next) => {
					const shift = currentShiftOf(shiftSurfacesOf(next).at(-1) ?? next);
					const transferableShift = shift > .25 ? shift : 0;
					const visualTop = Math.max(0, next.scrollTop - transferableShift);
					clearMotion(next);
					restoreRunway(next);
					const floor = Math.max(0, next.scrollHeight - next.clientHeight);
					next.scrollTop = Math.min(visualTop, Math.max(0, floor - 26));
					followScrollLedgers.set(next, next.scrollTop);
				};
				const markGesture = (event) => {
					interacting = true;
					if (event.type === "wheel") {
						const deltaY = event.deltaY;
						if (Number.isFinite(deltaY) && deltaY < 0) readerGestureIntent = true;
					} else if (event.type === "touchstart") touchStartY = event.touches[0]?.clientY ?? null;
					else if (event.type === "touchmove") {
						const touch = event.touches[0];
						if (touch !== void 0) {
							if (touchStartY === null) touchStartY = touch.clientY;
							if (touch.clientY - touchStartY > 1) readerGestureIntent = true;
						}
					} else if (event.type === "touchend" || event.type === "touchcancel") touchStartY = null;
					if (interactTimer !== null) clearTimeout(interactTimer);
					interactTimer = setTimeout(() => {
						interacting = false;
						readerGestureIntent = false;
						interactTimer = null;
					}, 800);
				};
				/**
				* Last observed scroll extent, shared by the pre-paint correction and the
				* settle loop so a host layout shrink is re-opened exactly once no matter
				* which observer sees it first. `-1` until the first owned observation.
				*/
				let settleRetiring = false;
				let hostOwnsScroll = false;
				let externalScrollStrikes = 0;
				Number.NEGATIVE_INFINITY;
				let handedOff = false;
				/**
				* Bring the reading surface back down toward its held position after an
				* upward host push (clamp jump, live→settled swap): spend persistent pad
				* first — lowering the floor lets the pin carry the text back down —
				* then raise the compositor shift for whatever pad cannot cover, and
				* rebase the spring extent so the raise survives the next applyVisual
				* (which otherwise recomputes the shift from lag and undoes it).
				*/
				const pullReadingAnchorBack = (host, measured, trace = false) => {
					holdGuardAnchor(host, measured, measured.top);
				};
				/**
				* THE screen-space anchor hold, shared by every entry point: the
				* structural-observer path (pre-paint cascade correction), the settle
				* loop's per-frame poll, and the ACTIVE loop's per-frame poll. The
				* shift-excluded delta filters the engine's own motion (reveal glide,
				* wrap lockstep) to ~0, so a live poll may compensate safely — which is
				* what saves the completion swap: the settled-side arm primes in its
				* layout effect and steals leadership IN the cascade frame, its own
				* observers miss the mutations (armed after the fact), and only this
				* poll sees the jump while it can still be corrected before paint.
				* Returns the measured delta (null when nothing was comparable).
				*/
				const enforceReadingAnchor = (host, trace = false) => {
					const measured = measureReadingAnchor(host);
					if (measured === null) return null;
					if (measured.delta > .5) {
						if (trace) followTrace("anchor-hold", {
							screenDelta: Math.round(measured.delta),
							st: Math.round(host.scrollTop)
						});
						if (pruneDeadRunway(host)) reservePx = 0;
						holdGuardAnchor(host, measured, measured.top);
					} else if (measured.delta < -.5) {
						if (pruneDeadRunway(host)) reservePx = 0;
						pullReadingAnchorBack(host, measured, trace);
					} else holdGuardAnchor(host, measured, measured.top);
					return measured.delta;
				};
				/** Pre-paint correction (observers, commit subscription). */
				const restoreBeforePaint = () => {
					if (lifecycleRef.current.hidden()) return;
					if (port !== null && hostInputFoldActive(port)) {
						yieldToInputFold(port);
						return;
					}
					if (port !== null && followSuspensions.get(port)?.pending) return;
					if (!controlScrollRef.current || !following || port === null || (followSpaceEpochs.get(port) ?? 0) !== spaceEpoch) return;
					if (hostOwnsScroll || followHostScrollPorts.has(port)) {
						hostOwnsScroll = true;
						followScrollLedgers.set(port, port.scrollTop);
						return;
					}
					if (!activeRef.current) detectHostScroll(port, Math.max(0, port.scrollHeight - port.clientHeight));
					const leaderless = !isLeader(port);
					if (!activeRef.current && followActivePorts.has(port)) return;
					if (leaderless && (followLeaders.has(port) || !handedOff)) return;
					if (leaderless) {
						const sharedMotion = followMotionStates.get(port);
						if (sharedMotion !== void 0) {
							animatedH = Math.min(port.scrollHeight, Math.max(0, sharedMotion.extent));
							reservePx = sharedMotion.reservePx;
							velocityPxPerSec = sharedMotion.velocityPxPerSec;
						}
					}
					pruneDeadRunway(port);
					if (!activeRef.current) {
						const measured = measureReadingAnchor(port);
						if (measured !== null && measured.delta > .5) {
							if (pruneDeadRunway(port)) reservePx = 0;
							holdGuardAnchor(port, measured, measured.top);
						} else if (measured !== null && measured.delta < -.5) {
							if (pruneDeadRunway(port)) reservePx = 0;
							if (!activeRef.current) pullReadingAnchorBack(port, measured);
							else {
								const released = Math.min(flowPadOf(port), -measured.delta);
								if (released > .25) {
									setFlowPad(port, flowPadOf(port) - released);
									animatedH = Math.max(0, animatedH - released);
								}
								holdGuardAnchor(port, measured, measured.top + released);
							}
						} else if (measured !== null) holdGuardAnchor(port, measured, measured.top);
					}
					const tuning = debugRuntime.activeTuning();
					const predictGrowth = predictsGrowth(port);
					const floor = Math.max(0, port.scrollHeight - port.clientHeight);
					if (followFloorHistory.get(port) !== floor) invalidatePaintLimit(port);
					const isReasoningSurface = rootRef.current?.querySelector("[data-variant=\"think\"]") !== null;
					const trajectoryShift = predictive && !isReasoningSurface && runwayOffsetOf(port) > 0 && trajectoryPositionPx !== null ? floor - trajectoryPositionPx : void 0;
					animatedH = applyVisual(port, animatedH, reservePx, velocityPxPerSec, tuning.runwayPx, activeRef.current ? Number.POSITIVE_INFINITY : followLastShiftPx.get(port) ?? Number.POSITIVE_INFINITY, !predictGrowth, trajectoryShift, 0, activeRef.current && !hostOwnsScroll);
					if (trajectoryShift !== void 0) trajectoryPositionPx = floor - (followLastShiftPx.get(port) ?? floor - (trajectoryPositionPx ?? floor));
					updateRevealScale(port, 0, true);
					reportFollow(port, activeRef.current);
				};
				let unsubscribeCommit = null;
				const bindPort = (next) => {
					if (port === next) return;
					if (port !== null) {
						for (const name of GESTURE_EVENTS) port.removeEventListener(name, markGesture);
						resize?.disconnect();
						mutations?.disconnect();
					}
					unsubscribeCommit?.();
					port = next;
					spaceEpoch = followSpaceEpochs.get(next) ?? 0;
					invalidatePaintLimit(port);
					unsubscribeCommit = subscribeFollowCommit(port, () => {
						restoreBeforePaint();
					});
					for (const name of GESTURE_EVENTS) port.addEventListener(name, markGesture, { passive: true });
					if (typeof ResizeObserver !== "undefined") {
						resize = new ResizeObserver(() => restoreBeforePaint());
						resize.observe(port);
						const proxy = resizeProxyOf(port);
						if (proxy !== null) resize.observe(proxy);
					}
					if (typeof MutationObserver !== "undefined") {
						const flow = flowElementOf(port);
						if (flow !== null) {
							mutations = new MutationObserver(() => {
								restoreBeforePaint();
							});
							mutations.observe(flow, {
								childList: true,
								subtree: true,
								attributes: true,
								attributeFilter: ["data-input-fold"]
							});
						}
					}
				};
				/**
				* Keep the observer on the flow's TAIL surface. A flow locked to the
				* viewport by min-height does not resize when content grows inside it —
				* only the last message row does, and missing that resize means missing
				* the pre-paint correction for that frame's wrap.
				*/
				const observeTailSurface = () => {
					if (resize === null || port === null) return;
					const tail = shiftSurfacesOf(port).at(-1) ?? null;
					if (tail === observedTail) return;
					if (observedTail !== null) resize.unobserve(observedTail);
					observedTail = tail;
					if (tail !== null) resize.observe(tail);
				};
				const frame = (now) => {
					const frameStartedAt = performance.now();
					rafId = requestAnimationFrame(frame);
					if (lifecycleRef.current.hidden()) return;
					const elapsedMs = Math.max(.001, now - last);
					const dt = Math.min(32, elapsedMs);
					const recordFrame = () => {
						debugRuntime.recordDiagnosticFrame(`follow-${generation}`, now, performance.now() - frameStartedAt);
					};
					const tuning = debugRuntime.activeTuning();
					last = now;
					const root = rootRef.current;
					if (root === null) return;
					const nextPort = root.closest("[data-conversation-scroll]");
					if (nextPort === null) return;
					bindPort(nextPort);
					observeTailSurface();
					resetHostScrollOwnershipForNewTurn(nextPort);
					hostOwnsScroll = followHostScrollPorts.has(nextPort);
					if (hostInputFoldActive(nextPort)) {
						yieldToInputFold(nextPort);
						recordFrame();
						return;
					}
					if (activeRef.current) followActivePorts.add(nextPort);
					else followActivePorts.delete(nextPort);
					if (nextPort.clientHeight <= 0) {
						recordFrame();
						return;
					}
					const lastRecovery = followRecoveryTimes.get(nextPort);
					if (primed && elapsedMs >= 1e3 && (lastRecovery === void 0 || now - lastRecovery >= 1e3)) {
						suspendFollowPort(nextPort);
						resumeFollowPort(nextPort);
					}
					const resumed = followSuspensions.get(nextPort);
					if (resumed !== void 0 && resumed.userRows !== countUserRows(nextPort)) followSuspensions.delete(nextPort);
					else if (resumed !== void 0 && resumeSequence !== resumed.sequence) {
						resumeSequence = resumed.sequence;
						spaceEpoch = followSpaceEpochs.get(nextPort) ?? 0;
						if (resumed.pending) {
							if (!hostOwnsScroll) setFollowScrollTop(nextPort, resumed.following ? Math.max(0, nextPort.scrollHeight - nextPort.clientHeight) : Math.min(resumed.readerTop, Math.max(0, nextPort.scrollHeight - nextPort.clientHeight)));
							if (!resumed.following) nextPort.removeAttribute(FOLLOW_OWNED_ATTR);
							resumed.pending = false;
						}
						following = resumed.following && !followReaderHolds.has(nextPort);
						readerReleased = !following;
						animatedH = nextPort.scrollHeight;
						reservePx = 0;
						velocityPxPerSec = 0;
						trajectoryPositionPx = null;
						trajectoryVelocityPxPerMs = 0;
						trajectoryTargetVelocityPxPerMs = 0;
						trajectoryFloorPx = null;
						trajectoryGrowthAtMs = null;
						trajectoryAccumulatedGrowthPx = 0;
						trajectoryAccumulatedGrowthMs = 0;
						trajectoryGrowthSamples = 0;
						trajectoryWasActive = false;
						externalScrollStrikes = 0;
						interacting = false;
						readerGestureIntent = false;
						predictionNaturalHeight = null;
						invalidatePaintLimit(nextPort);
						revealPhase = new FollowRevealPhaseTracker();
						releaseRevealScale();
						finishEntrance();
						primed = true;
						last = now;
						followScrollLedgers.set(nextPort, nextPort.scrollTop);
						if (following && !hostOwnsScroll) hold(nextPort);
						reportFollow(nextPort, following && !hostOwnsScroll);
						return;
					}
					if (hostOwnsScroll) {
						primed = true;
						followScrollLedgers.set(nextPort, nextPort.scrollTop);
						finishEntrance();
						return;
					}
					const floor = Math.max(0, nextPort.scrollHeight - nextPort.clientHeight);
					const reportedLag = floor - nextPort.scrollTop;
					const extent = Math.min(nextPort.scrollHeight, Math.max(0, nextPort.scrollHeight - reportedLag));
					if (!primed) {
						if (completionSettleGuardsPort(nextPort)) {
							primed = true;
							following = false;
							return;
						}
						const inherited = nextPort.hasAttribute(FOLLOW_OWNED_ATTR) ? followMotionStates.get(nextPort) : void 0;
						if (inherited === void 0) {
							const predictGrowth = predictsGrowth(nextPort);
							const entranceHeight = entranceRef.current ? Math.max(0, entranceExtentRef?.current ?? root.getBoundingClientRect().height) : 0;
							animatedH = Math.max(0, nextPort.scrollHeight - entranceHeight);
							const hasStatus = turnStatusOf(nextPort) !== null;
							reservePx = Math.max(ownedBottomSpaceOf(nextPort), predictGrowth && (hasStatus || speedCpsRef.current > 90) ? computeFollowReserve(speedCpsRef.current, tuning.runwayPx) : 0);
							if (!completionSettleGuardsPort(nextPort)) setFlowPad(nextPort, 0);
							statusWasPresent = hasStatus;
							velocityPxPerSec = 0;
							following = !readerScrolledUp(nextPort) && !followReaderHolds.has(nextPort);
						} else {
							animatedH = Math.min(nextPort.scrollHeight, inherited.extent);
							reservePx = inherited.reservePx;
							velocityPxPerSec = inherited.velocityPxPerSec;
							following = true;
						}
						if (following) {
							hold(nextPort);
							if (isLeader(nextPort)) {
								animatedH = applyVisual(nextPort, animatedH, reservePx, velocityPxPerSec, tuning.runwayPx, Number.POSITIVE_INFINITY, !(predictiveRef?.current ?? predictive), void 0, 0, !hostOwnsScroll);
								if (predictive && root.querySelector("[data-variant=\"think\"]") === null && runwayOffsetOf(nextPort) > 0) {
									const floor = Math.max(0, nextPort.scrollHeight - nextPort.clientHeight);
									const paintMaxLagPx = Math.max(0, safeShiftLimit(nextPort, shiftSurfacesOf(nextPort)) - 1);
									const currentShift = currentShiftOf(shiftSurfacesOf(nextPort).at(-1) ?? nextPort);
									trajectoryPositionPx = floor - Math.min(paintMaxLagPx, Math.max(predictiveRef === void 0 ? Math.max(20, runwayOffsetOf(nextPort) - 32) : runwayOffsetOf(nextPort), currentShift));
									trajectoryTargetVelocityPxPerMs = Math.max(0, speedCpsRef.current) * .4 / 1e3;
									trajectoryVelocityPxPerMs = trajectoryTargetVelocityPxPerMs;
									trajectoryFloorPx = floor;
									trajectoryGrowthAtMs = now;
									trajectoryAccumulatedGrowthPx = 0;
									trajectoryAccumulatedGrowthMs = 0;
									trajectoryGrowthSamples = 0;
									trajectoryWasActive = true;
								}
								updateRevealScale(nextPort, elapsedMs);
								reportFollow(nextPort, activeRef.current);
								const runwayOffset = runwayOffsetOf(nextPort);
								if (Math.max(0, nextPort.scrollHeight - animatedH - runwayOffset) <= .25) finishEntrance();
							} else finishEntrance();
						} else finishEntrance();
						primed = true;
						return;
					}
					if (!following && (!interacting || readerReleased && !readerGestureIntent && reportedLag <= 1) && reportedLag <= (readerReleased ? 1 : 25)) {
						following = true;
						readerReleased = false;
						followReaderHolds.delete(nextPort);
						animatedH = extent;
						reservePx = 0;
						velocityPxPerSec = 0;
						followScrollLedgers.set(nextPort, nextPort.scrollTop);
						hold(nextPort);
					} else if (following && interacting && (readerGestureIntent || readerScrolledUp(nextPort))) {
						following = false;
						readerGestureIntent = false;
						readerReleased = true;
						followReaderHolds.set(nextPort, { atMs: performance.now() });
						handBackVisual(nextPort);
						animatedH = nextPort.scrollHeight;
						reservePx = 0;
						velocityPxPerSec = 0;
						drop(nextPort);
						finishEntrance();
					}
					if (!activeRef.current || !following) {
						followScrollLedgers.set(nextPort, nextPort.scrollTop);
						reportFollow(nextPort, activeRef.current);
						recordFrame();
						return;
					}
					detectHostScroll(nextPort, floor);
					if (hostOwnsScroll) {
						followScrollLedgers.set(nextPort, nextPort.scrollTop);
						reportFollow(nextPort, false);
						recordFrame();
						return;
					}
					hold(nextPort);
					if (!isLeader(nextPort)) {
						finishEntrance();
						recordFrame();
						return;
					}
					const predictGrowth = predictsGrowth(nextPort);
					const hasStatus = turnStatusOf(nextPort) !== null;
					const statusJustRemoved = predictGrowth && statusWasPresent === true && !hasStatus;
					if (statusJustRemoved) reservePx = Math.max(reservePx, tuning.runwayPx);
					statusWasPresent = hasStatus;
					const reserveEnabled = hasStatus || statusJustRemoved || reservePx > .25 || speedCpsRef.current > 90;
					const pressureReserveTarget = predictGrowth && reserveEnabled ? computeFollowReserve(speedCpsRef.current, tuning.runwayPx) : 0;
					reservePx = Math.min(Math.max(0, tuning.runwayPx), reservePx);
					const effectiveReserveTarget = Math.min(Math.max(0, tuning.runwayPx), Math.max(reservePx, pressureReserveTarget));
					const reserveStep = 1 - Math.exp(-elapsedMs / tuning.reserveResponseMs);
					reservePx = predictionSawGrowth && reservePx <= .25 ? effectiveReserveTarget : reservePx + (effectiveReserveTarget - reservePx) * reserveStep;
					if (predictGrowth || runwayOffsetOf(nextPort) > .5) ensureRunway(nextPort, shiftSurfacesOf(nextPort), reservePx);
					const runwayOffset = runwayOffsetOf(nextPort);
					const contentHeight = nextPort.scrollHeight;
					const floorNow = Math.max(0, contentHeight - nextPort.clientHeight);
					const trajectoryActive = predictive && root.querySelector("[data-variant=\"think\"]") === null && runwayOffset > 0;
					let trajectoryShift;
					if (trajectoryActive) {
						const requestedMinLagPx = Math.max(20, runwayOffset - 32);
						const paintLimit = safeShiftLimit(nextPort, shiftSurfacesOf(nextPort));
						const maxLagPx = Math.max(0, paintLimit - 1);
						const minLagPx = Math.min(requestedMinLagPx, maxLagPx);
						if (trajectoryPositionPx === null || trajectoryFloorPx === null) {
							const currentShift = currentShiftOf(shiftSurfacesOf(nextPort).at(-1) ?? nextPort);
							trajectoryPositionPx = floorNow - Math.min(maxLagPx, Math.max(predictiveRef === void 0 ? minLagPx : runwayOffset, currentShift));
							trajectoryTargetVelocityPxPerMs = Math.max(0, speedCpsRef.current) * .4 / 1e3;
							trajectoryVelocityPxPerMs = trajectoryTargetVelocityPxPerMs;
							trajectoryGrowthAtMs = now;
						} else if (floorNow > trajectoryFloorPx + .5) {
							const intervalMs = Math.max(1, now - (trajectoryGrowthAtMs ?? now));
							if (trajectoryGrowthSamples > 0) {
								trajectoryAccumulatedGrowthPx += floorNow - trajectoryFloorPx;
								trajectoryAccumulatedGrowthMs += intervalMs;
								const measuredVelocity = trajectoryAccumulatedGrowthPx / trajectoryAccumulatedGrowthMs;
								const targetBlend = 1 - Math.exp(-intervalMs / 240);
								trajectoryTargetVelocityPxPerMs += (measuredVelocity - trajectoryTargetVelocityPxPerMs) * targetBlend;
							}
							trajectoryGrowthSamples += 1;
							trajectoryGrowthAtMs = now;
						} else if (floorNow < trajectoryFloorPx - .5) {
							trajectoryPositionPx = floorNow - minLagPx;
							trajectoryGrowthAtMs = now;
							trajectoryAccumulatedGrowthPx = 0;
							trajectoryAccumulatedGrowthMs = 0;
							trajectoryGrowthSamples = 0;
						}
						trajectoryFloorPx = floorNow;
						const phaseTarget = revealedCharsRef === void 0 ? floorNow : revealPhase.advance(floorNow, revealedCharsRef.current).targetPx;
						const trajectoryStep = computeFollowTrajectoryStep(elapsedMs, {
							positionPx: trajectoryPositionPx,
							velocityPxPerMs: trajectoryVelocityPxPerMs,
							targetPx: phaseTarget,
							targetVelocityPxPerMs: trajectoryTargetVelocityPxPerMs,
							minLagPx,
							maxLagPx,
							paintFloorPx: floorNow
						});
						trajectoryPositionPx = trajectoryStep.positionPx;
						trajectoryVelocityPxPerMs = trajectoryStep.velocityPxPerMs;
						trajectoryShift = trajectoryStep.shiftPx;
						trajectoryWasActive = true;
						const baselineShift = runwayOffset - Math.min(runwayOffset, Math.max(0, reservePx));
						animatedH = contentHeight - runwayOffset - Math.max(0, trajectoryShift - baselineShift);
						velocityPxPerSec = trajectoryVelocityPxPerMs * 1e3;
					} else {
						if (trajectoryWasActive) {
							const currentShift = currentShiftOf(shiftSurfacesOf(nextPort).at(-1) ?? nextPort);
							animatedH = contentHeight - runwayOffset - Math.max(0, currentShift);
							velocityPxPerSec = trajectoryVelocityPxPerMs * 1e3;
							trajectoryPositionPx = null;
							trajectoryWasActive = false;
						}
						const lag = Math.max(0, contentHeight - animatedH - runwayOffset);
						const step = computeFollowStep(dt, {
							lag,
							speedEma: speedCpsRef.current,
							velocityPxPerSec
						}, tuning);
						if (lag <= .1) {
							animatedH = contentHeight - runwayOffset;
							velocityPxPerSec = 0;
						} else {
							animatedH = Math.min(contentHeight - runwayOffset, animatedH + step.advancePx);
							velocityPxPerSec = step.velocityPxPerSec;
						}
					}
					animatedH = applyVisual(nextPort, animatedH, reservePx, velocityPxPerSec, tuning.runwayPx, Number.POSITIVE_INFINITY, !predictGrowth, trajectoryShift, elapsedMs, !hostOwnsScroll);
					if (trajectoryActive) trajectoryPositionPx = floorNow - (followLastShiftPx.get(nextPort) ?? trajectoryShift ?? 0);
					updateRevealScale(nextPort, elapsedMs);
					reportFollow(nextPort, true);
					recordFrame();
					if (isLeader(nextPort)) {
						if (!activeRef.current) enforceReadingAnchor(nextPort);
						else measureReadingAnchor(nextPort);
					}
					if (Math.max(0, nextPort.scrollHeight - animatedH - runwayOffsetOf(nextPort)) <= .25) finishEntrance();
				};
				frame(performance.now());
				return () => {
					if (!controlScrollRef.current) {
						cancelAnimationFrame(rafId);
						if (port !== null) followActivePorts.delete(port);
						unsubscribeCommit?.();
						resize?.disconnect();
						mutations?.disconnect();
						if (port !== null) for (const name of GESTURE_EVENTS) port.removeEventListener(name, markGesture);
						if (interactTimer !== null) clearTimeout(interactTimer);
						const disabledHost = rootRef.current?.closest("[data-conversation-scroll]") ?? port;
						if (disabledHost !== null) {
							releaseFollowSpace(disabledHost);
							followSuspensions.delete(disabledHost);
							followRecoveryTimes.delete(disabledHost);
							followLeaders.delete(disabledHost);
							debugRuntime.reportFollow(disabledHost, null);
						}
						releaseRevealScale();
						return;
					}
					cancelAnimationFrame(rafId);
					if (port !== null) followActivePorts.delete(port);
					unsubscribeCommit?.();
					if (interactTimer !== null) clearTimeout(interactTimer);
					resize?.disconnect();
					mutations?.disconnect();
					if (port !== null) for (const name of GESTURE_EVENTS) port.removeEventListener(name, markGesture);
					const host = rootRef.current?.closest("[data-conversation-scroll]") ?? port;
					if (host === null) return;
					holding = null;
					if (!isLeader(host)) return;
					const preserveReader = interacting && (readerGestureIntent || readerScrolledUp(host));
					if (!following || !primed) {
						if (!following && primed) followReaderHolds.set(host, { atMs: performance.now() });
						clearVisual(host);
						followLeaders.delete(host);
						releaseRevealScale();
						debugRuntime.reportFollow(host, null);
						return;
					}
					if (preserveReader) {
						handBackVisual(host);
						followReaderHolds.set(host, { atMs: performance.now() });
						clearVisual(host);
						followLeaders.delete(host);
						releaseRevealScale();
						debugRuntime.reportFollow(host, null);
						return;
					}
					let settleQuietMs = 0;
					let settleSig = "";
					const finalGrowthPx = Math.max(0, host.scrollHeight - animatedH - runwayOffsetOf(host));
					if (!activeRef.current && finalGrowthPx <= .25 && !followBudgetReleases.has(host)) {
						followTraceUntilMs = Math.max(followTraceUntilMs, performance.now() + 1e4);
						followTrace("fast-gate", {
							sh: host.scrollHeight,
							st: Math.round(host.scrollTop),
							pad: Math.round(flowPadOf(host))
						});
						restoreRunway(host);
						finishAtNaturalFloor(host, !startedAsEntrance, true);
						followLeaders.delete(host);
						followCompletionSettle.delete(host);
						releaseRevealScale();
						debugRuntime.reportFollow(host, null);
						return;
					}
					const completionShift = currentShiftOf(shiftSurfacesOf(host).at(-1) ?? host);
					const completionShiftCeiling = finalGrowthPx > .25 || startedAsEntrance && completionShift <= .25 ? Number.POSITIVE_INFINITY : completionShift;
					if (hostOwnsScroll) {
						clearVisual(host);
						setFollowScrollTop(host, Math.max(0, host.scrollHeight - host.clientHeight));
						host.removeAttribute(FOLLOW_OWNED_ATTR);
						followLeaders.delete(host);
						releaseRevealScale();
						debugRuntime.reportFollow(host, null);
						return;
					}
					followTraceUntilMs = performance.now() + 15e3;
					if (pruneDeadRunway(host)) {
						followTrace("cleanup-dead-margin", {
							sh: host.scrollHeight,
							st: Math.round(host.scrollTop),
							pad: Math.round(flowPadOf(host))
						});
						reservePx = 0;
					}
					const completionTuning = debugRuntime.activeTuning();
					reservePx = Math.min(reservePx, Math.max(0, completionTuning.runwayPx));
					const previousCompletionRunway = runwayOffsetOf(host);
					ensureRunway(host, shiftSurfacesOf(host), Math.max(reservePx, Math.max(0, completionTuning.runwayPx - flowPadOf(host))));
					const completionRunway = runwayOffsetOf(host);
					measureReadingAnchor(host);
					animatedH = Math.max(0, animatedH - (completionRunway - previousCompletionRunway));
					if (!hostOwnsScroll) settleAtFloor(host);
					animatedH = applyVisual(host, animatedH, reservePx, velocityPxPerSec, completionRunway, completionShiftCeiling, false, void 0, 0, !hostOwnsScroll);
					reportFollow(host, false);
					const runwayOffset = runwayOffsetOf(host);
					if (Math.max(0, host.scrollHeight - animatedH - runwayOffset) <= .25 && runwayOffset <= .25 && reservePx <= .25 && !followBudgetReleases.has(host)) {
						finishAtNaturalFloor(host, !startedAsEntrance, !hostOwnsScroll);
						followLeaders.delete(host);
						releaseRevealScale();
						debugRuntime.reportFollow(host, null);
						return;
					}
					for (const name of GESTURE_EVENTS) host.addEventListener(name, markGesture, { passive: true });
					const stopSettleListeners = () => {
						setSettlingOwner((current) => current === owner ? null : current);
						followSettleStops.get(host)?.delete(stopSettleListeners);
						for (const name of GESTURE_EVENTS) host.removeEventListener(name, markGesture);
						resize?.disconnect();
						mutations?.disconnect();
						if (interactTimer !== null) {
							clearTimeout(interactTimer);
							interactTimer = null;
						}
					};
					if (typeof ResizeObserver !== "undefined") {
						resize = new ResizeObserver(() => restoreBeforePaint());
						resize.observe(host);
						const proxy = resizeProxyOf(host);
						if (proxy !== null) resize.observe(proxy);
					}
					if (typeof MutationObserver !== "undefined") {
						const flow = flowElementOf(host);
						if (flow !== null) {
							mutations = new MutationObserver(() => {
								restoreBeforePaint();
							});
							mutations.observe(flow, {
								childList: true,
								subtree: true,
								attributes: true,
								attributeFilter: ["data-input-fold"]
							});
						}
					}
					followCompletionSettle.add(host);
					followCompletionSettleRows.set(host, countUserRows(host));
					const stops = followSettleStops.get(host) ?? /* @__PURE__ */ new Set();
					stops.add(stopSettleListeners);
					followSettleStops.set(host, stops);
					handedOff = true;
					setSettlingOwner(owner);
					let settleLast = performance.now();
					const settleFrame = (now) => {
						if (lifecycleRef.current.hidden()) {
							stopSettleListeners();
							return;
						}
						if (!controlScrollRef.current || (followSpaceEpochs.get(host) ?? 0) !== spaceEpoch) {
							stopSettleListeners();
							return;
						}
						if (!host.isConnected) {
							releaseFollowSpace(host);
							followLeaders.delete(host);
							releaseRevealScale();
							stopSettleListeners();
							return;
						}
						if (!isLeader(host)) {
							stopSettleListeners();
							return;
						}
						if (interacting && (readerGestureIntent || readerScrolledUp(host))) {
							readerGestureIntent = false;
							handBackVisual(host);
							clearVisual(host);
							followCompletionSettle.delete(host);
							followLeaders.delete(host);
							releaseRevealScale();
							debugRuntime.reportFollow(host, null);
							stopSettleListeners();
							return;
						}
						const dt = Math.min(32, Math.max(0, now - settleLast));
						const tuning = debugRuntime.activeTuning();
						reservePx = Math.min(reservePx, Math.max(0, tuning.runwayPx));
						settleLast = now;
						detectHostScroll(host, Math.max(0, host.scrollHeight - host.clientHeight));
						if (hostOwnsScroll) {
							clearVisual(host);
							setFollowScrollTop(host, Math.max(0, host.scrollHeight - host.clientHeight));
							host.removeAttribute(FOLLOW_OWNED_ATTR);
							followCompletionSettle.delete(host);
							followLeaders.delete(host);
							releaseRevealScale();
							debugRuntime.reportFollow(host, null);
							stopSettleListeners();
							return;
						}
						const guardDelta = !followActivePorts.has(host) ? enforceReadingAnchor(host, true) : null;
						settleQuietMs = guardDelta === null || Math.abs(guardDelta) <= .5 ? settleQuietMs + dt : 0;
						const settleStatus = turnStatusOf(host);
						const ownedRunwayPx = runwayOffsetOf(host);
						if (ownedRunwayPx > .25) {
							const requestedTransferPx = settleStatus === null ? ownedRunwayPx : Math.min(reservePx, Math.max(0, tuning.runwayPx) / FOLLOW_RUNWAY_RETIRE_MS * dt);
							const transferredPx = transferRunwayToFlowPad(host, requestedTransferPx);
							reservePx = Math.max(0, reservePx - transferredPx);
							animatedH += transferredPx;
						}
						const runwayOffset = runwayOffsetOf(host);
						const lag = Math.max(0, host.scrollHeight - animatedH - runwayOffset);
						if (lag <= .25 && (reservePx <= .25 || settleStatus === null) && !followBudgetReleases.has(host) && settleQuietMs >= 240) {
							followTrace("finish", {
								st: Math.round(host.scrollTop),
								sh: host.scrollHeight,
								pad: Math.round(flowPadOf(host))
							});
							animatedH = host.scrollHeight;
							velocityPxPerSec = 0;
							finishAtNaturalFloor(host, !startedAsEntrance, !hostOwnsScroll);
							followLeaders.delete(host);
							releaseRevealScale();
							debugRuntime.reportFollow(host, null);
							stopSettleListeners();
							return;
						}
						const step = computeFollowStep(dt, {
							lag,
							speedEma: speedCpsRef.current,
							velocityPxPerSec
						}, tuning);
						animatedH = Math.min(host.scrollHeight - runwayOffset, animatedH + step.advancePx);
						velocityPxPerSec = step.velocityPxPerSec;
						if (!hostOwnsScroll) settleAtFloor(host);
						animatedH = applyVisual(host, animatedH, reservePx, velocityPxPerSec, runwayOffset, Number.POSITIVE_INFINITY, false, void 0, 0, !hostOwnsScroll);
						if (traceActive()) {
							const sig = `${Math.round(host.scrollTop)}|${host.scrollHeight}|${Math.round(flowPadOf(host))}|${Math.round(reservePx)}|${settleRetiring}`;
							if (sig !== settleSig) {
								followTrace("settle", {
									st: Math.round(host.scrollTop),
									sh: host.scrollHeight,
									pad: Math.round(flowPadOf(host)),
									reserve: Math.round(reservePx),
									lag: Math.round(lag * 10) / 10,
									retiring: settleRetiring
								});
								settleSig = sig;
							}
						}
						reportFollow(host, false);
						requestAnimationFrame(settleFrame);
					};
					requestAnimationFrame(settleFrame);
				};
			}, [
				active,
				rootRef,
				speedCpsRef,
				revealScaleRef,
				predictive,
				predictiveRef,
				controlScroll,
				lifecycleVersion
			]);
			(0, react.useLayoutEffect)(() => {
				const host = rootRef.current?.closest("[data-conversation-scroll]") ?? null;
				if (host === null) return;
				if (!controlScroll) {
					releaseFollowSpace(host);
					followSuspensions.delete(host);
					followRecoveryTimes.delete(host);
					return;
				}
				const reconcile = () => {
					if (!lifecycleRef.current.hidden()) reconcileFollowBudget(host);
				};
				reconcile();
				return debugRuntime.subscribe(reconcile);
			}, [rootRef, controlScroll]);
			(0, react.useLayoutEffect)(() => {
				const host = rootRef.current?.closest("[data-conversation-scroll]") ?? null;
				if (host !== null) followFlowFillUsers.set(host, (followFlowFillUsers.get(host) ?? 0) + 1);
				return () => {
					if (host === null) return;
					const remaining = Math.max(0, (followFlowFillUsers.get(host) ?? 1) - 1);
					if (remaining > 0) {
						followFlowFillUsers.set(host, remaining);
						return;
					}
					followFlowFillUsers.delete(host);
					requestAnimationFrame(() => {
						requestAnimationFrame(() => {
							if (!followLeaders.has(host) && !followFlowFillUsers.has(host)) restoreFlowFill(host);
						});
					});
				};
			}, [rootRef]);
		}
		//#endregion
		//#region \0dsh-css:/root/workspaces/DSH项目维护/dsh-smooth-stream-git/src/client/TypewriterAssistantNodeView.module.css.mjs
		const css$4 = ".nHgJNa_root{min-width:0;color:var(--dsw-alias-label-primary);font-size:var(--dsh-content-font-size,16px);line-height:calc(24px + var(--dsh-content-font-delta,4px));flex-direction:column;display:flex}.nHgJNa_body{flex-direction:column;gap:16px;min-width:0;display:flex}.nHgJNa_body>[data-turn-process-inline][hidden]{margin-bottom:-16px}.nHgJNa_think{flex-direction:column;display:flex}.nHgJNa_thinkRow{position:relative;overflow:hidden}.nHgJNa_think[data-state=running] .nHgJNa_thinkRow:after{content:\"\";inset-block:0;background:linear-gradient(90deg, transparent 0%, color-mix(in srgb, var(--dsw-alias-bg-base) 60%, transparent) 55%, transparent 100%);pointer-events:none;width:300px;animation:2.6s ease-out infinite nHgJNa_dsh-smooth-stream-think-sweep;position:absolute;left:0}@keyframes nHgJNa_dsh-smooth-stream-think-sweep{0%{left:-300px}90%,to{left:100%}}.nHgJNa_thinkLeading{flex-shrink:0}.nHgJNa_thinkChevron{color:var(--dsw-alias-label-secondary)}.nHgJNa_thinkTitle{font-weight:400}.nHgJNa_thinkSeparator{background:var(--dsw-alias-label-caption);border-radius:1px;flex:none;width:2px;height:2px;margin:0 8px}.nHgJNa_thinkSummary{min-width:0;color:var(--dsw-alias-label-tertiary);font-size:var(--dsh-content-font-size-secondary,14px);line-height:calc(20px + var(--dsh-content-font-delta-secondary,4px));text-overflow:ellipsis;white-space:nowrap;flex:auto;overflow:hidden}.nHgJNa_thinkSummary[data-follow-end]{text-overflow:clip}.nHgJNa_thinkBody{padding:4px 0 4px calc(22px + var(--dsh-content-font-delta,0px));color:var(--dsw-alias-label-tertiary);font-size:var(--dsh-content-font-size-secondary,14px);line-height:calc(20px + var(--dsh-content-font-delta-secondary,4px));white-space:pre-wrap;word-break:break-word}.nHgJNa_disclosureRoot{flex-direction:column;width:100%;min-width:0;display:flex}.nHgJNa_disclosureRow{height:calc(24px + var(--dsh-content-font-delta,0px));cursor:pointer;align-items:center;min-width:0;display:flex;position:relative;overflow:hidden}.nHgJNa_disclosureLeading{width:calc(16px + var(--dsh-content-font-delta,0px));height:calc(16px + var(--dsh-content-font-delta,0px));color:var(--dsw-alias-label-tertiary);flex:none;justify-content:center;align-items:center;margin-right:6px;display:inline-flex;position:relative}.nHgJNa_disclosureLeading svg:not([data-state]){width:calc(14px + var(--dsh-content-font-delta,0px));height:calc(14px + var(--dsh-content-font-delta,0px))}.nHgJNa_disclosureIconIdle{opacity:1;transition:opacity .1s;display:inline-flex}.nHgJNa_disclosureChevronHover{opacity:0;margin:auto;transition:opacity .1s;position:absolute;inset:0}.nHgJNa_disclosureRow:hover .nHgJNa_disclosureIconIdle{opacity:0}.nHgJNa_disclosureRow:hover .nHgJNa_disclosureChevronHover{opacity:1}.nHgJNa_disclosureTitle{font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(24px + var(--dsh-content-font-delta,0px));color:var(--dsw-alias-label-secondary);flex:none}.nHgJNa_disclosureContent{visibility:visible;transition:grid-template-rows var(--ds-transition-duration,.2s) var(--ds-ease-in-out,cubic-bezier(.4, 0, .2, 1)), visibility 0s;grid-template-rows:1fr;display:grid;overflow:hidden}.nHgJNa_disclosureContent[data-collapsed]{visibility:hidden;grid-template-rows:0fr;transition:none;display:none!important}.nHgJNa_disclosureContent[data-collapsed]>*{padding-top:0!important;padding-bottom:0!important}.nHgJNa_disclosureContent[data-no-transition]{transition:none}.nHgJNa_disclosureContent>*{min-height:0;overflow:hidden}@media (prefers-reduced-motion:reduce){.nHgJNa_think[data-state=running] .nHgJNa_thinkRow:after{animation:none}.nHgJNa_disclosureContent,.nHgJNa_disclosureContent[data-collapsed]{transition:none}}.nHgJNa_stopped{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-tertiary);border-radius:6px;align-self:flex-start;padding:0 6px;font-size:11px;line-height:18px}.nHgJNa_visuallyHidden{clip:rect(0 0 0 0);clip-path:inset(50%);white-space:nowrap;border:0;width:1px;height:1px;margin:-1px;padding:0;position:absolute;overflow:hidden}.nHgJNa_follow{contain:layout style;min-width:0}.nHgJNa_root :not(pre)>code{line-height:inherit;white-space:normal;overflow-wrap:anywhere;vertical-align:baseline;display:inline}@supports (text-box-trim:trim-both){.nHgJNa_root :is(p,h1,h2,h3,h4,h5,h6,blockquote){text-box-trim:trim-both;text-box-edge:text}}";
		const tagId$4 = "dsh-smooth-stream/TypewriterAssistantNodeView.module.css";
		if (typeof document !== "undefined") {
			let tag = document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId$4) + "]");
			if (tag === null) {
				tag = document.createElement("style");
				tag.dataset.plugin = "dsh-smooth-stream";
				tag.dataset.pluginCss = tagId$4;
				document.head.appendChild(tag);
			}
			tag.textContent = css$4;
		}
		var TypewriterAssistantNodeView_module_css_default = {
			"dsh-smooth-stream-think-sweep": "nHgJNa_dsh-smooth-stream-think-sweep",
			"body": "nHgJNa_body",
			"thinkChevron": "nHgJNa_thinkChevron",
			"disclosureRow": "nHgJNa_disclosureRow",
			"think": "nHgJNa_think",
			"root": "nHgJNa_root",
			"thinkLeading": "nHgJNa_thinkLeading",
			"disclosureLeading": "nHgJNa_disclosureLeading",
			"thinkSeparator": "nHgJNa_thinkSeparator",
			"disclosureIconIdle": "nHgJNa_disclosureIconIdle",
			"thinkTitle": "nHgJNa_thinkTitle",
			"disclosureTitle": "nHgJNa_disclosureTitle",
			"stopped": "nHgJNa_stopped",
			"disclosureRoot": "nHgJNa_disclosureRoot",
			"follow": "nHgJNa_follow",
			"disclosureChevronHover": "nHgJNa_disclosureChevronHover",
			"disclosureContent": "nHgJNa_disclosureContent",
			"visuallyHidden": "nHgJNa_visuallyHidden",
			"thinkRow": "nHgJNa_thinkRow",
			"thinkSummary": "nHgJNa_thinkSummary",
			"thinkBody": "nHgJNa_thinkBody"
		};
		//#endregion
		//#region src/client/FollowHost.tsx
		/**
		* Document-flow host that owns conversation-port follow while `active`.
		* Shared by assistant blocks and every other Agent Chat row. `onGrowth` lets
		* generic wrapped renderers re-arm one glide when their DOM grows without
		* requiring a business-kind-specific lifecycle predicate.
		*/
		function FollowHost({ active, entrance = false, onEntranceSettled, onGrowth, entranceExtentRef, speedCpsRef, revealedCharsRef, revealScaleRef, predictive = true, predictiveRef, controlScroll = true, hostRef, className, entranceActive, children }) {
			const localRootRef = (0, react.useRef)(null);
			const rootRef = hostRef ?? localRootRef;
			useConversationFollow(rootRef, active || entrance, speedCpsRef, revealScaleRef, predictive, entrance, onEntranceSettled, predictiveRef, entranceExtentRef, revealedCharsRef, controlScroll);
			const onGrowthRef = (0, react.useRef)(onGrowth);
			onGrowthRef.current = onGrowth;
			const watchesGrowth = onGrowth !== void 0;
			(0, react.useLayoutEffect)(() => {
				if (!watchesGrowth || typeof ResizeObserver === "undefined") return;
				const root = rootRef.current;
				if (root === null) return;
				let previousHeight = null;
				let pendingGrowth = 0;
				let growthFrame = null;
				const flushGrowth = () => {
					growthFrame = null;
					if (pendingGrowth <= 0) return;
					const delta = pendingGrowth;
					pendingGrowth = 0;
					onGrowthRef.current?.(delta);
				};
				const observer = new ResizeObserver((entries) => {
					const measuredHeight = entries[0]?.contentRect.height;
					if (measuredHeight === void 0 || !Number.isFinite(measuredHeight)) return;
					const nextHeight = measuredHeight;
					if (previousHeight !== null && nextHeight > previousHeight + .5) {
						pendingGrowth += nextHeight - previousHeight;
						if (growthFrame === null) growthFrame = requestAnimationFrame(flushGrowth);
					}
					previousHeight = nextHeight;
				});
				observer.observe(root);
				return () => {
					observer.disconnect();
					if (growthFrame !== null) cancelAnimationFrame(growthFrame);
				};
			}, [rootRef, watchesGrowth]);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				ref: rootRef,
				className: className === void 0 ? TypewriterAssistantNodeView_module_css_default.follow : `${TypewriterAssistantNodeView_module_css_default.follow} ${className}`,
				"data-entrance": entranceActive === void 0 ? void 0 : entranceActive ? "active" : "idle",
				children
			});
		}
		//#endregion
		//#region src/client/streamRelay.ts
		const PART_ORDER$1 = {
			reasoning: 0,
			response: 1,
			tool: 2,
			output: 2
		};
		function record$1(value) {
			return value !== null && typeof value === "object" ? value : {};
		}
		/** Unknown owners remain local to their node rather than sharing a global active turn. */
		function relayScope(node, sessionId) {
			const n = record$1(node);
			const data = record$1(n.data);
			const location = record$1(n.location);
			const root = record$1(data.root);
			const turn = record$1(location.turn);
			const step = record$1(location.step);
			return {
				session: String(sessionId ?? n.sessionId ?? "unscoped"),
				turn: String(data.turn ?? turn.turn ?? root.turn ?? n.key ?? "unknown"),
				step: Number(data.step ?? step.step ?? root.step ?? 0),
				node: String(n.key ?? "unknown"),
				order: typeof n.anchorSeq === "number" ? n.anchorSeq : NaN
			};
		}
		/** Shared recovery identity, isolated from other sessions and historical turns. */
		function relayTurnKey(scope) {
			return JSON.stringify([scope.session, scope.turn]);
		}
		function lowerBound(items, before) {
			let start = 0;
			let end = items.length;
			while (start < end) {
				const middle = start + end >>> 1;
				if (before(items[middle])) start = middle + 1;
				else end = middle;
			}
			return start;
		}
		function positionForLease(lease) {
			return {
				order: Number.isFinite(lease.sourceOrder) ? lease.sourceOrder : lease.order,
				part: PART_ORDER$1[lease.part]
			};
		}
		function positionForScope(scope, part) {
			return {
				order: Number.isFinite(scope.sourceOrder) ? scope.sourceOrder : scope.order,
				part
			};
		}
		function before(left, right) {
			if (!Number.isFinite(left.order) || !Number.isFinite(right.order)) return false;
			return left.order < right.order || left.order === right.order && left.part < right.part;
		}
		/** Same-node ordering is by part; cross-node ordering is by event position. */
		var StepActivity = class {
			nodes = /* @__PURE__ */ new Map();
			frontier = [];
			get empty() {
				return this.nodes.size === 0;
			}
			change(lease, active) {
				const part = PART_ORDER$1[lease.part];
				const position = positionForLease(lease);
				const activity = this.nodes.get(lease.node) ?? {
					ordered: [],
					counts: [
						0,
						0,
						0
					]
				};
				const previous = activity.ordered[0];
				activity.counts[part] = activity.counts[part] + (active ? 1 : -1);
				if (!Number.isNaN(position.order)) {
					const index = lowerBound(activity.ordered, (value) => before(value, position));
					if (active) activity.ordered.splice(index, 0, position);
					else activity.ordered.splice(index, 1);
				}
				if (activity.counts.some((count) => count > 0)) this.nodes.set(lease.node, activity);
				else this.nodes.delete(lease.node);
				const next = activity.ordered[0];
				if (previous?.order === next?.order && previous?.part === next?.part) return;
				if (previous !== void 0) this.frontier.splice(this.frontierIndex({
					...previous,
					node: lease.node
				}), 1);
				if (next !== void 0) {
					const head = {
						...next,
						node: lease.node
					};
					this.frontier.splice(this.frontierIndex(head), 0, head);
				}
			}
			blocks(scope, part) {
				const own = this.nodes.get(scope.node);
				if (own !== void 0 && (part >= 1 && own.counts[0] > 0 || part >= 2 && own.counts[1] > 0)) return true;
				const other = this.frontier.find((entry) => entry.node !== scope.node && Number.isFinite(entry.order));
				const target = positionForScope(scope, part);
				if (other === void 0 || !Number.isFinite(target.order) || other.order >= target.order) return false;
				return true;
			}
			frontierIndex(position) {
				return lowerBound(this.frontier, (value) => before(value, position) || value.order === position.order && value.part === position.part && value.node < position.node);
			}
		};
		var TurnActivity = class {
			steps = [];
			byStep = /* @__PURE__ */ new Map();
			get empty() {
				return this.steps.length === 0;
			}
			change(lease, active) {
				let step = this.byStep.get(lease.step);
				if (step === void 0) {
					step = new StepActivity();
					this.byStep.set(lease.step, step);
					this.steps.splice(lowerBound(this.steps, (value) => value < lease.step), 0, lease.step);
				}
				step.change(lease, active);
				if (step.empty) {
					this.byStep.delete(lease.step);
					this.steps.splice(lowerBound(this.steps, (value) => value < lease.step), 1);
				}
			}
			blocks(scope, part) {
				const first = this.steps[0];
				if (first === void 0 || !(first <= scope.step)) return false;
				return first < scope.step || this.byStep.get(first).blocks(scope, PART_ORDER$1[part]);
			}
		};
		/** Every mounted renderer owns a token; another viewport cannot release its work. */
		var StreamRelay = class {
			leases = /* @__PURE__ */ new Map();
			activeTurns = /* @__PURE__ */ new Map();
			tools = /* @__PURE__ */ new Map();
			blockedListeners = /* @__PURE__ */ new Map();
			toolListeners = /* @__PURE__ */ new Map();
			pending = /* @__PURE__ */ new Set();
			legacy = /* @__PURE__ */ new Map();
			legacyListeners = /* @__PURE__ */ new Set();
			legacyPending = false;
			notifying = false;
			acquire(scope, part, active = true) {
				const token = Symbol(part);
				const lease = {
					turnKey: relayTurnKey(scope),
					step: scope.step,
					node: scope.node,
					order: scope.order,
					sourceOrder: scope.sourceOrder,
					recoveryEpoch: scope.recoveryEpoch,
					part,
					active
				};
				this.leases.set(token, lease);
				if (part === "tool") this.changeTool(lease, 1);
				if (active) this.changeActive(lease, true);
				this.flushNotifications();
				return token;
			}
			update(token, active) {
				const lease = this.leases.get(token);
				if (lease === void 0 || lease.active === active) return;
				lease.active = active;
				this.changeActive(lease, active);
				this.flushNotifications();
			}
			release(token) {
				const lease = this.leases.get(token);
				if (lease === void 0) return;
				this.leases.delete(token);
				if (lease.active) this.changeActive(lease, false);
				if (lease.part === "tool") this.changeTool(lease, -1);
				this.flushNotifications();
			}
			/** Lowest mounted active recovery batch; new recovery seats join that batch. */
			recoveryEpoch(scope) {
				const batches = this.activeTurns.get(typeof scope === "string" ? scope : relayTurnKey(scope));
				let earliest;
				if (batches !== void 0) {
					for (const epoch of batches.keys()) if (epoch !== void 0 && (earliest === void 0 || epoch < earliest)) earliest = epoch;
				}
				return earliest;
			}
			isBlocked(scope, part) {
				const batches = this.activeTurns.get(relayTurnKey(scope));
				if (batches === void 0) return false;
				const earliest = this.recoveryEpoch(scope);
				if (earliest !== void 0 && (scope.recoveryEpoch === void 0 || earliest < scope.recoveryEpoch)) return true;
				return batches.get(scope.recoveryEpoch)?.blocks(scope, part) ?? false;
			}
			hasTool(scope) {
				return this.tools.get(relayTurnKey(scope))?.has(scope.step) ?? false;
			}
			subscribeBlocked(scope, part, listener) {
				const key = relayTurnKey(scope);
				const position = { ...scope };
				return this.subscribeTo(this.blockedListeners, key, listener, () => this.isBlocked(position, part));
			}
			subscribeTool(scope, listener) {
				const key = relayTurnKey(scope);
				const step = scope.step;
				const byStep = this.toolListeners.get(key) ?? /* @__PURE__ */ new Map();
				this.toolListeners.set(key, byStep);
				const stop = this.subscribeTo(byStep, step, listener, () => this.tools.get(key)?.has(step) ?? false);
				return () => {
					stop();
					if (byStep.size === 0 && this.toolListeners.get(key) === byStep) this.toolListeners.delete(key);
				};
			}
			subscribeTo(groups, key, listener, query) {
				const group = groups.get(key) ?? /* @__PURE__ */ new Set();
				const subscription = {
					listener,
					query,
					previous: query()
				};
				group.add(subscription);
				groups.set(key, group);
				return () => {
					if (!group.delete(subscription)) return;
					this.pending.delete(subscription);
					if (group.size === 0) groups.delete(key);
				};
			}
			changeActive(lease, active) {
				if (Number.isNaN(lease.step)) return;
				const batches = this.activeTurns.get(lease.turnKey) ?? /* @__PURE__ */ new Map();
				const turn = batches.get(lease.recoveryEpoch) ?? new TurnActivity();
				turn.change(lease, active);
				if (turn.empty) batches.delete(lease.recoveryEpoch);
				else batches.set(lease.recoveryEpoch, turn);
				if (batches.size === 0) this.activeTurns.delete(lease.turnKey);
				else this.activeTurns.set(lease.turnKey, batches);
				this.enqueue(this.blockedListeners.get(lease.turnKey));
			}
			changeTool(lease, delta) {
				if (Number.isNaN(lease.step)) return;
				const byStep = this.tools.get(lease.turnKey) ?? /* @__PURE__ */ new Map();
				const previous = byStep.get(lease.step) ?? 0;
				const next = previous + delta;
				if (next === 0) byStep.delete(lease.step);
				else byStep.set(lease.step, next);
				if (byStep.size === 0) this.tools.delete(lease.turnKey);
				else this.tools.set(lease.turnKey, byStep);
				if (previous === 0 !== (next === 0)) this.enqueue(this.toolListeners.get(lease.turnKey)?.get(lease.step));
			}
			enqueue(subscriptions) {
				if (subscriptions !== void 0) for (const subscription of subscriptions) this.pending.add(subscription);
			}
			flushNotifications() {
				if (this.notifying) return;
				this.notifying = true;
				try {
					while (this.pending.size > 0 || this.legacyPending) {
						const subscription = this.pending.values().next().value;
						if (subscription !== void 0) {
							this.pending.delete(subscription);
							const current = subscription.query();
							if (current === subscription.previous) continue;
							subscription.previous = current;
							subscription.listener();
						} else {
							this.legacyPending = false;
							for (const listener of [...this.legacyListeners]) if (this.legacyListeners.has(listener)) listener();
						}
					}
				} finally {
					this.notifying = false;
				}
			}
			setReasoningActive(key, active) {
				this.setLegacy(key, "reasoning", active);
			}
			setTextActive(key, active) {
				this.setLegacy(key, "response", active);
			}
			setLegacy(key, part, active) {
				const id = key ?? "active";
				const state = this.legacy.get(id) ?? {
					reasoning: false,
					response: false
				};
				if (state[part] === active) return;
				state[part] = active;
				if (!state.reasoning && !state.response) this.legacy.delete(id);
				else this.legacy.set(id, state);
				this.legacyPending = true;
				this.flushNotifications();
			}
			isReasoningActive(key) {
				return this.legacy.get(key ?? "active")?.reasoning ?? false;
			}
			isTextActive(key) {
				return this.legacy.get(key ?? "active")?.response ?? false;
			}
			isToolBlocked(key) {
				return this.isReasoningActive(key) || this.isTextActive(key);
			}
			resetTurn(key) {
				if (!this.legacy.delete(key ?? "active")) return;
				this.legacyPending = true;
				this.flushNotifications();
			}
			clearAll() {
				for (const key of this.activeTurns.keys()) this.enqueue(this.blockedListeners.get(key));
				for (const [key, byStep] of this.tools) {
					const listeners = this.toolListeners.get(key);
					if (listeners !== void 0) for (const step of byStep.keys()) this.enqueue(listeners.get(step));
				}
				this.leases.clear();
				this.activeTurns.clear();
				this.tools.clear();
				if (this.legacy.size > 0) {
					this.legacy.clear();
					this.legacyPending = true;
				}
				this.flushNotifications();
			}
			subscribe = (listener) => {
				this.legacyListeners.add(listener);
				return () => {
					this.legacyListeners.delete(listener);
				};
			};
		};
		const streamRelay = new StreamRelay();
		//#endregion
		//#region src/client/useSmoothStreamContent.ts
		/**
		* Stream-smoothing reveal hook.
		*
		* Buffers the model's chunked text and reveals it at a cadence that tracks
		* the observed arrival rate, so a long reply never dumps whole paragraphs at
		* once and a fast stream never stutters. Port of lobe-ui's smoother: EMA
		* arrival cps + chunk size, backlog pressure, commit-interval widening with
		* tail length, and a flush-speed settle drain once the input idles. The
		* reveal decision is the pure {@link computeRevealStep} for unit tests.
		*
		* `shouldHoldBack` is the performance guard's veto: while it returns true the
		* loop keeps measuring but skips the DOM commit, so an offscreen reply never
		* competes with visible frames when the frame rate is degraded.
		*/
		const PRESET_CONFIG = {
			balanced: {
				activeInputWindowMs: 220,
				defaultCps: 110,
				emaAlpha: .38,
				flushCps: 260,
				largeAppendChars: 140,
				maxActiveCps: 420,
				maxCps: 320,
				maxFlushCps: 560,
				minCps: 28,
				settleAfterMs: 260,
				settleDrainMaxMs: 380,
				settleDrainMinMs: 100,
				targetBufferMs: 32
			},
			realtime: {
				activeInputWindowMs: 140,
				defaultCps: 120,
				emaAlpha: .45,
				flushCps: 240,
				largeAppendChars: 180,
				maxActiveCps: 480,
				maxCps: 320,
				maxFlushCps: 640,
				minCps: 32,
				settleAfterMs: 200,
				settleDrainMaxMs: 280,
				settleDrainMinMs: 100,
				targetBufferMs: 24
			},
			silky: {
				activeInputWindowMs: 280,
				defaultCps: 64,
				emaAlpha: .28,
				flushCps: 140,
				largeAppendChars: 100,
				maxActiveCps: 280,
				maxCps: 180,
				maxFlushCps: 400,
				minCps: 20,
				settleAfterMs: 360,
				settleDrainMaxMs: 520,
				settleDrainMinMs: 160,
				targetBufferMs: 56
			}
		};
		const QUEUE_ACCEL_EXPONENT = 1.25;
		const CATCHUP_SECONDS = .15;
		const clamp = (value, min, max) => {
			return Math.min(max, Math.max(min, value));
		};
		/** Float-debt queue integration from `ultimate_stream_physics_scroller.html`. */
		function computeAdaptiveQueueStep(backlog, dtMs, debt, revealScale = 1, tuning = DEFAULT_STREAM_DEBUG_TUNING, retainDebt = false) {
			if (backlog <= 0 || dtMs <= 0) return {
				revealChars: 0,
				debt: 0,
				speedCps: 0
			};
			const speedCps = Math.min(tuning.maxRevealCps, 90 + Math.pow(backlog, QUEUE_ACCEL_EXPONENT) * tuning.queuePressure);
			const effectiveScale = clamp(revealScale * tuning.revealScale, .05, 2);
			const maxClamp = Math.max(1, Math.floor(tuning.cadenceClamp ?? 4));
			const accumulated = Math.max(0, debt) % 1 + Math.min(maxClamp, speedCps * (dtMs / 1e3)) * effectiveScale;
			const wholeBudget = Math.floor(accumulated);
			const revealChars = Math.min(backlog, maxClamp, wholeBudget);
			return {
				revealChars,
				debt: revealChars >= backlog && !retainDebt ? 0 : accumulated - wholeBudget,
				speedCps
			};
		}
		/** Counts user-perceived characters (code points), not UTF-16 units. */
		const countChars = (text) => {
			let count = 0;
			for (const char of text) count += 1;
			return count;
		};
		/** Pure settle-drain decision shared by the frame loop and its tests. */
		function computeSettleDrain(config, input) {
			if (input.inputActive || !input.settling) return 0;
			const overflowCps = Math.max(0, input.backlog - 300) * 1e3 / 2;
			const drainTargetMs = clamp(input.backlog * 8, config.settleDrainMinMs, config.settleDrainMaxMs);
			const settleCps = input.backlog * 1e3 / drainTargetMs;
			return clamp(Math.max(settleCps, overflowCps), config.flushCps, config.maxFlushCps);
		}
		/**
		* Fixed velocity that closes a producer-complete queue within its deadline.
		* This completion-only target may exceed the live-stream flush ceiling.
		*/
		function computeCompletionDrain(config, backlog, initialCps = 0) {
			if (backlog <= 0) return 0;
			const deadlineSeconds = clamp(backlog * 8, config.settleDrainMinMs, config.settleDrainMaxMs) / 1e3;
			const rampAreaSeconds = SETTLE_RAMP_TAU_S * (1 - Math.exp(-deadlineSeconds / SETTLE_RAMP_TAU_S));
			const deadlineCps = (backlog - Math.max(0, initialCps) * rampAreaSeconds) / Math.max(.001, deadlineSeconds - rampAreaSeconds);
			return Math.max(deadlineCps, computeSettleDrain(config, {
				backlog,
				inputActive: false,
				settling: true
			}));
		}
		/**
		* Drain rate multiplier once the input ends: leftover backlog reveals at
		* this multiple of the steady rate, so the end never drags.
		*/
		const SETTLE_DRAIN_MULTIPLIER = 1.8;
		/** Time constant for ramping the completion-drain velocity up from streaming pace. */
		const SETTLE_RAMP_TAU_S = .09;
		/** Pure per-frame reveal decision shared by the loop and its tests. */
		function computeRevealStep(config, input, dtSeconds) {
			const trackedCps = Math.max(input.emaCps, input.arrivalCpsEma);
			const baseCps = clamp(trackedCps, config.minCps, config.maxFlushCps);
			const targetLagChars = input.inputActive ? Math.max(2, Math.round(baseCps * config.targetBufferMs / 1e3)) : 0;
			let currentCps;
			if (input.steadyCps !== void 0) currentCps = input.inputActive || input.settling ? clamp(input.steadyCps * (input.inputActive ? 1 : SETTLE_DRAIN_MULTIPLIER), config.minCps, config.maxFlushCps) : 0;
			else if (input.inputActive) {
				const overflow = Math.max(0, input.backlog - 32);
				const catchup = overflow > 0 ? overflow / CATCHUP_SECONDS : 0;
				currentCps = clamp(baseCps * 1.08 + catchup, config.minCps, config.maxFlushCps);
			} else if (input.settling) currentCps = computeSettleDrain(config, input);
			else {
				const idleFlushCps = Math.max(config.flushCps, baseCps * 1.8, input.arrivalCpsEma * .8);
				currentCps = clamp(idleFlushCps, config.flushCps, config.maxFlushCps);
			}
			const minRevealChars = input.inputActive ? 1 : 2;
			return {
				revealChars: Math.max(minRevealChars, Math.round(currentCps * dtSeconds)),
				targetLagChars
			};
		}
		/**
		* Smooth a chunked content stream into a reveal-paced display string.
		*
		* @param content - The full accumulated input so far.
		* @param options - Preset, guard, and steady-rate wiring.
		* @returns The displayed content, revealed at the smoothed cadence.
		*/
		function useSmoothStreamContent(content, { enabled = true, replayOnEnable = false, backgroundRecovery = "catch-up", recoveryKey, recoveryPosition, onRecoveryBacklogChange, initialRecoveryEpoch, onRecoveryBatchChange, initialDisplayedContent, resumeOnMount = false, skipRanges, canSkipRange, inputComplete = false, preset = "balanced", shouldHoldBack, steadyCps, defaultCps, speedCpsRef, revealedCharsRef, revealScaleRef, onRevealCommit } = {}) {
			const config = PRESET_CONFIG[preset];
			const seedCps = defaultCps ?? config.defaultCps;
			const [initial] = (0, react.useState)(() => {
				const text = enabled ? initialDisplayedContent !== void 0 && content.startsWith(initialDisplayedContent) ? initialDisplayedContent : "" : content;
				const chars = [...text];
				return {
					text,
					chars,
					count: chars.length
				};
			});
			const [displayedContent, setDisplayedContent] = (0, react.useState)(initial.text);
			const displayedContentRef = (0, react.useRef)(initial.text);
			const displayedCountRef = (0, react.useRef)(initial.count);
			const targetContentRef = (0, react.useRef)(initial.text);
			const targetCharsRef = (0, react.useRef)(initial.chars);
			const targetCountRef = (0, react.useRef)(initial.count);
			const replacementPendingRef = (0, react.useRef)(false);
			const previousEnabledRef = (0, react.useRef)(enabled);
			const emaCpsRef = (0, react.useRef)(seedCps);
			const lastInputTsRef = (0, react.useRef)(0);
			const lastInputCountRef = (0, react.useRef)(initial.count);
			const chunkSizeEmaRef = (0, react.useRef)(1);
			const arrivalCpsEmaRef = (0, react.useRef)(seedCps);
			const rafRef = (0, react.useRef)(null);
			const lastFrameTsRef = (0, react.useRef)(null);
			const queueDebtRef = (0, react.useRef)(0);
			const settleCpsRef = (0, react.useRef)(null);
			const lastDrainCpsRef = (0, react.useRef)(0);
			const holdBackRef = (0, react.useRef)(shouldHoldBack);
			const skipRangesRef = (0, react.useRef)(skipRanges);
			skipRangesRef.current = skipRanges;
			const canSkipRangeRef = (0, react.useRef)(canSkipRange);
			canSkipRangeRef.current = canSkipRange;
			const visibleBacklog = (0, react.useCallback)((displayed, target) => {
				let hidden = 0;
				for (const [start, end] of skipRangesRef.current ?? []) {
					if (end <= displayed) continue;
					if (canSkipRangeRef.current?.(start, end) === false) continue;
					const from = Math.max(start, displayed);
					const to = Math.min(target, end);
					if (to > from) hidden += to - from;
				}
				return Math.max(0, target - displayed - hidden);
			}, []);
			const recoveryBacklogRef = (0, react.useRef)(false);
			const onRecoveryBacklogChangeRef = (0, react.useRef)(onRecoveryBacklogChange);
			onRecoveryBacklogChangeRef.current = onRecoveryBacklogChange;
			const speedOutRef = (0, react.useRef)(speedCpsRef);
			speedOutRef.current = speedCpsRef;
			const revealedCharsOutRef = (0, react.useRef)(revealedCharsRef);
			revealedCharsOutRef.current = revealedCharsRef;
			const revealScaleOutRef = (0, react.useRef)(revealScaleRef);
			revealScaleOutRef.current = revealScaleRef;
			const onRevealCommitOutRef = (0, react.useRef)(onRevealCommit);
			onRevealCommitOutRef.current = onRevealCommit;
			const inputCompleteRef = (0, react.useRef)(inputComplete);
			inputCompleteRef.current = inputComplete;
			const streamIdRef = (0, react.useRef)(`stream-${Math.random().toString(36).slice(2)}`);
			const recoveryBatchRef = (0, react.useRef)(null);
			const initialRecoveryEpochRef = (0, react.useRef)(initialRecoveryEpoch);
			const nextRecoveryEpochRef = (0, react.useRef)(void 0);
			const recoveryBatchCallbackRef = (0, react.useRef)(onRecoveryBatchChange);
			recoveryBatchCallbackRef.current = onRecoveryBatchChange;
			const recoveryKeyRef = (0, react.useRef)(recoveryKey);
			recoveryKeyRef.current = recoveryKey;
			const clearRecoveryBatch = (0, react.useCallback)((preserveNextEpoch = false) => {
				if (recoveryBatchRef.current === null && initialRecoveryEpochRef.current === void 0 && (nextRecoveryEpochRef.current === void 0 || preserveNextEpoch)) return;
				const published = recoveryBatchRef.current !== null || initialRecoveryEpochRef.current !== void 0;
				if (preserveNextEpoch && recoveryBatchRef.current !== null) nextRecoveryEpochRef.current = recoveryBatchRef.current.epoch + 1;
				initialRecoveryEpochRef.current = void 0;
				recoveryBatchRef.current = null;
				if (!preserveNextEpoch) nextRecoveryEpochRef.current = void 0;
				if (published) recoveryBatchCallbackRef.current?.(void 0);
			}, []);
			const freezeRecoveryBatch = (0, react.useCallback)((end, nextEpoch) => {
				const activeEpoch = streamRelay.recoveryEpoch(recoveryKeyRef.current ?? "");
				const receivingEpoch = activeEpoch === void 0 || nextRecoveryEpochRef.current === void 0 ? void 0 : Math.max(nextRecoveryEpochRef.current, activeEpoch + 1);
				const epoch = nextEpoch ?? initialRecoveryEpochRef.current ?? receivingEpoch ?? activeEpoch ?? 0;
				initialRecoveryEpochRef.current = void 0;
				nextRecoveryEpochRef.current = void 0;
				recoveryBatchRef.current = {
					end,
					epoch
				};
				recoveryBatchCallbackRef.current?.(epoch);
			}, []);
			(0, react.useEffect)(() => {
				holdBackRef.current = shouldHoldBack;
			}, [shouldHoldBack]);
			const stopFrameLoop = (0, react.useCallback)(() => {
				if (rafRef.current !== null) {
					cancelAnimationFrame(rafRef.current);
					rafRef.current = null;
				}
				lastFrameTsRef.current = null;
			}, []);
			const reportRecoveryBacklog = (0, react.useCallback)((pending) => {
				if (recoveryBacklogRef.current === pending) return;
				recoveryBacklogRef.current = pending;
				onRecoveryBacklogChangeRef.current?.(pending);
			}, []);
			const observeRecoveryBacklog = (0, react.useCallback)((backlog) => {
				if (backlog > 1200) reportRecoveryBacklog(true);
				else if (backlog <= 0) reportRecoveryBacklog(false);
			}, [reportRecoveryBacklog]);
			const startFrameLoopRef = (0, react.useRef)(() => {});
			const recovery = useBackgroundRecovery(backgroundRecovery, () => {
				clearRecoveryBatch();
				stopFrameLoop();
			}, () => {
				if (recoveryBatchRef.current === null) {
					queueDebtRef.current = 0;
					settleCpsRef.current = null;
					lastDrainCpsRef.current = 0;
					lastFrameTsRef.current = null;
					if (targetCountRef.current > displayedCountRef.current) freezeRecoveryBatch(targetCountRef.current);
					else if (backgroundRecovery !== "latest") {
						const activeEpoch = streamRelay.recoveryEpoch(recoveryKeyRef.current ?? "");
						nextRecoveryEpochRef.current = initialRecoveryEpochRef.current ?? (activeEpoch === void 0 ? void 0 : activeEpoch + 1);
						initialRecoveryEpochRef.current = void 0;
					}
				}
				observeRecoveryBacklog(visibleBacklog(replacementPendingRef.current ? 0 : displayedCountRef.current, targetCountRef.current));
				startFrameLoopRef.current();
			}, enabled && (!inputComplete || content !== displayedContent) ? recoveryKey : void 0, recoveryPosition, resumeOnMount, enabled && (!inputComplete || content !== displayedContent));
			const recoveryRef = (0, react.useRef)(recovery);
			recoveryRef.current = recovery;
			const syncImmediate = (0, react.useCallback)((nextContent) => {
				stopFrameLoop();
				clearRecoveryBatch();
				replacementPendingRef.current = false;
				const chars = [...nextContent];
				const now = performance.now();
				targetContentRef.current = nextContent;
				targetCharsRef.current = chars;
				targetCountRef.current = chars.length;
				displayedContentRef.current = nextContent;
				displayedCountRef.current = chars.length;
				queueDebtRef.current = 0;
				settleCpsRef.current = null;
				lastDrainCpsRef.current = 0;
				const speedOut = speedOutRef.current;
				if (speedOut !== void 0) speedOut.current = seedCps;
				setDisplayedContent(nextContent);
				emaCpsRef.current = seedCps;
				chunkSizeEmaRef.current = 1;
				arrivalCpsEmaRef.current = seedCps;
				lastInputTsRef.current = now;
				lastInputCountRef.current = chars.length;
				reportRecoveryBacklog(false);
			}, [
				clearRecoveryBatch,
				reportRecoveryBacklog,
				seedCps,
				stopFrameLoop
			]);
			const startFrameLoop = (0, react.useCallback)(() => {
				if (rafRef.current !== null || recoveryRef.current.hidden()) return;
				const tick = (now) => {
					const frameStartedAt = performance.now();
					if (recoveryRef.current.hidden()) {
						stopFrameLoop();
						return;
					}
					if (replacementPendingRef.current) {
						if (holdBackRef.current?.() === true) {
							lastFrameTsRef.current = null;
							debugRuntime.recordDiagnosticFrame(`${streamIdRef.current}:text`, now, performance.now() - frameStartedAt);
							rafRef.current = requestAnimationFrame(tick);
							return;
						}
						replacementPendingRef.current = false;
						displayedContentRef.current = "";
						displayedCountRef.current = 0;
						setDisplayedContent("");
					}
					const sourceCount = targetCountRef.current;
					const playback = recoveryRef.current;
					if (!playback.recovering() && streamRelay.recoveryEpoch(recoveryKeyRef.current ?? "") === void 0) clearRecoveryBatch();
					if (recoveryBatchRef.current === null && sourceCount > displayedCountRef.current && playback.mode() !== "latest" && (playback.recovering() || streamRelay.recoveryEpoch(recoveryKeyRef.current ?? "") !== void 0)) freezeRecoveryBatch(sourceCount);
					const targetCount = Math.min(sourceCount, recoveryBatchRef.current?.end ?? sourceCount);
					let displayedCount = displayedCountRef.current;
					if (holdBackRef.current?.() !== true) {
						for (const [start, end] of skipRangesRef.current ?? []) {
							if (start > displayedCount) break;
							if (canSkipRangeRef.current?.(start, end) === false) continue;
							displayedCount = Math.max(displayedCount, Math.min(targetCount, end));
						}
						if (displayedCount !== displayedCountRef.current) {
							const shown = targetCharsRef.current.slice(0, displayedCount).join("");
							displayedContentRef.current = shown;
							displayedCountRef.current = displayedCount;
							queueDebtRef.current = 0;
							setDisplayedContent(shown);
						}
					}
					const backlog = targetCount - displayedCount;
					const drainBacklog = visibleBacklog(displayedCount, targetCount);
					debugRuntime.recordDiagnostic("text-queue", {
						backlogChars: sourceCount - displayedCount,
						activeBatchChars: recoveryBatchRef.current === null ? void 0 : backlog,
						incomingBatchChars: recoveryBatchRef.current === null ? void 0 : sourceCount - targetCount,
						recoveryEpoch: recoveryBatchRef.current?.epoch,
						mode: "assistant"
					});
					if (drainBacklog <= 0) {
						if (displayedCount < targetCount && holdBackRef.current?.() === true) {
							lastFrameTsRef.current = null;
							rafRef.current = requestAnimationFrame(tick);
							return;
						}
						const batch = recoveryBatchRef.current;
						if (batch !== null && sourceCount > targetCount) {
							if (visibleBacklog(displayedCount, sourceCount) > 0) {
								freezeRecoveryBatch(sourceCount, batch.epoch + 1);
								rafRef.current = requestAnimationFrame(tick);
								return;
							}
							displayedContentRef.current = targetContentRef.current;
							displayedCountRef.current = sourceCount;
							setDisplayedContent(targetContentRef.current);
						}
						clearRecoveryBatch(streamRelay.recoveryEpoch(recoveryKeyRef.current ?? "") !== void 0);
						reportRecoveryBacklog(false);
						recoveryRef.current.finish();
						queueDebtRef.current = 0;
						settleCpsRef.current = null;
						const speedOut = speedOutRef.current;
						if (speedOut !== void 0) speedOut.current = seedCps;
						debugRuntime.recordDiagnosticFrame(`${streamIdRef.current}:text`, now, performance.now() - frameStartedAt);
						debugRuntime.recordDiagnostic("text-queue", {
							backlogChars: 0,
							mode: "drained"
						});
						debugRuntime.recordDiagnosticFrame(`${streamIdRef.current}:text`, now, performance.now() - frameStartedAt);
						debugRuntime.recordDiagnostic("text-queue", {
							backlogChars: 0,
							mode: "drained"
						});
						debugRuntime.reportStream(streamIdRef.current, null);
						stopFrameLoop();
						return;
					}
					if (lastFrameTsRef.current === null) {
						lastFrameTsRef.current = now;
						rafRef.current = requestAnimationFrame(tick);
						return;
					}
					const frameIntervalMs = Math.max(0, now - lastFrameTsRef.current);
					debugRuntime.recordDiagnosticFrame(`${streamIdRef.current}:text`, now, performance.now() - frameStartedAt);
					playback.detectGap(frameIntervalMs);
					const recovering = playback.recovering();
					if (recovering && playback.mode() !== "latest" && recoveryBatchRef.current === null) freezeRecoveryBatch(sourceCount);
					if (playback.resumed()) observeRecoveryBacklog(visibleBacklog(displayedCount, sourceCount));
					const recoveryMode = playback.mode();
					if (recovering && recoveryMode === "latest" && holdBackRef.current?.() !== true) {
						syncImmediate(targetContentRef.current);
						playback.finish();
						return;
					}
					const dtSeconds = Math.max(.001, Math.min(frameIntervalMs / 1e3, .12));
					lastFrameTsRef.current = now;
					const idleMs = now - lastInputTsRef.current;
					const producerComplete = inputCompleteRef.current;
					const debugTuning = debugRuntime.activeTuning();
					const inputActive = !producerComplete && idleMs <= config.activeInputWindowMs;
					const settling = producerComplete || !inputActive && idleMs >= config.settleAfterMs;
					if (!producerComplete) settleCpsRef.current = null;
					let revealChars;
					let revealSpeedCps;
					let nextQueueDebt = 0;
					if (recovering && recoveryMode === "catch-up") {
						const step = recoveryBudget(backlog, frameIntervalMs, queueDebtRef.current, debugTuning, true);
						revealChars = step.chars;
						nextQueueDebt = step.debt;
						revealSpeedCps = revealChars * 1e3 / Math.max(1, frameIntervalMs);
					} else if (recovering) {
						const step = computeAdaptiveQueueStep(backlog, Math.min(frameIntervalMs, 32), queueDebtRef.current, revealScaleOutRef.current?.current ?? 1, debugTuning, true);
						revealChars = step.revealChars;
						revealSpeedCps = step.speedCps;
						nextQueueDebt = step.debt;
					} else if (producerComplete) {
						const previousCps = lastDrainCpsRef.current > 0 ? lastDrainCpsRef.current : Math.max(config.minCps, emaCpsRef.current);
						const drainTargetCps = settleCpsRef.current ?? computeCompletionDrain(config, backlog, previousCps);
						settleCpsRef.current = drainTargetCps;
						const rampedCps = previousCps + (drainTargetCps - previousCps) * (1 - Math.exp(-dtSeconds / SETTLE_RAMP_TAU_S));
						const settleCps = Math.min(drainTargetCps, Math.max(previousCps, rampedCps));
						lastDrainCpsRef.current = Math.min(drainTargetCps, rampedCps);
						const accumulated = Math.max(0, queueDebtRef.current) + settleCps * dtSeconds;
						revealChars = Math.min(backlog, Math.floor(accumulated));
						revealSpeedCps = settleCps;
						nextQueueDebt = revealChars >= backlog ? 0 : accumulated - revealChars;
						if (revealChars >= backlog) lastDrainCpsRef.current = 0;
					} else if (steadyCps !== void 0) {
						const step = computeRevealStep(config, {
							backlog,
							chunkSizeEma: chunkSizeEmaRef.current,
							arrivalCpsEma: arrivalCpsEmaRef.current,
							emaCps: emaCpsRef.current,
							inputActive,
							settling,
							steadyCps
						}, dtSeconds);
						revealChars = Math.min(Math.round(step.revealChars * debugTuning.revealScale), backlog);
						revealSpeedCps = frameIntervalMs > 0 ? revealChars * 1e3 / frameIntervalMs : 0;
					} else {
						const step = computeAdaptiveQueueStep(backlog, frameIntervalMs, queueDebtRef.current, revealScaleOutRef.current?.current ?? 1, debugTuning);
						revealChars = step.revealChars;
						revealSpeedCps = step.speedCps;
						nextQueueDebt = step.debt;
					}
					debugRuntime.reportStream(streamIdRef.current, {
						backlog: sourceCount - displayedCount,
						speedCps: revealSpeedCps,
						targetChars: sourceCount,
						displayedChars: displayedCount,
						active: !producerComplete
					});
					if (holdBackRef.current?.() === true) {
						rafRef.current = requestAnimationFrame(tick);
						return;
					}
					queueDebtRef.current = nextQueueDebt;
					const speedOut = speedOutRef.current;
					if (speedOut !== void 0) speedOut.current = revealSpeedCps;
					if (revealChars <= 0) {
						rafRef.current = requestAnimationFrame(tick);
						return;
					}
					const nextCount = displayedCount + revealChars;
					const segment = targetCharsRef.current.slice(displayedCount, nextCount).join("");
					if (segment) {
						const nextDisplayed = displayedContentRef.current + segment;
						displayedContentRef.current = nextDisplayed;
						displayedCountRef.current = nextCount;
						setDisplayedContent(nextDisplayed);
					} else {
						displayedContentRef.current = targetContentRef.current;
						displayedCountRef.current = targetCount;
						setDisplayedContent(targetContentRef.current);
					}
					if (visibleBacklog(displayedCountRef.current, sourceCount) <= 0) reportRecoveryBacklog(false);
					const batch = recoveryBatchRef.current;
					if (batch !== null && displayedCountRef.current >= batch.end && sourceCount > batch.end) freezeRecoveryBatch(sourceCount, batch.epoch + 1);
					rafRef.current = requestAnimationFrame(tick);
				};
				rafRef.current = requestAnimationFrame(tick);
			}, [
				clearRecoveryBatch,
				config,
				freezeRecoveryBatch,
				observeRecoveryBacklog,
				reportRecoveryBacklog,
				seedCps,
				stopFrameLoop,
				steadyCps,
				syncImmediate,
				visibleBacklog
			]);
			(0, react.useLayoutEffect)(() => {
				const revealedCharsOut = revealedCharsOutRef.current;
				if (revealedCharsOut !== void 0) revealedCharsOut.current = displayedCountRef.current;
				if (displayedContent === "") return;
				onRevealCommitOutRef.current?.();
			}, [displayedContent]);
			(0, react.useEffect)(() => {
				startFrameLoopRef.current = startFrameLoop;
			}, [startFrameLoop]);
			(0, react.useEffect)(() => {
				const replay = enabled && !previousEnabledRef.current && replayOnEnable;
				previousEnabledRef.current = enabled;
				if (!enabled) {
					recoveryRef.current.cancel();
					clearRecoveryBatch();
					if (content === targetContentRef.current && displayedCountRef.current < targetCountRef.current) {
						startFrameLoop();
						return;
					}
					syncImmediate(content);
					return;
				}
				if (replay) syncImmediate("");
				const prevTargetContent = targetContentRef.current;
				if (content === prevTargetContent) return;
				const now = performance.now();
				if (!content.startsWith(prevTargetContent)) {
					if (recoveryRef.current.hidden() || holdBackRef.current?.() === true) {
						targetContentRef.current = content;
						targetCharsRef.current = [...content];
						targetCountRef.current = targetCharsRef.current.length;
						replacementPendingRef.current = true;
						if (recoveryBatchRef.current !== null) recoveryBatchRef.current.end = targetCountRef.current;
						if (recoveryRef.current.resumed()) observeRecoveryBacklog(visibleBacklog(0, targetCountRef.current));
						startFrameLoop();
						return;
					}
					syncImmediate(content);
					return;
				}
				const appendedChars = [...content.slice(prevTargetContent.length)];
				const appendedCount = appendedChars.length;
				targetContentRef.current = content;
				targetCharsRef.current.push(...appendedChars);
				targetCountRef.current += appendedCount;
				if (recoveryRef.current.recovering() && !recoveryRef.current.hidden() && backgroundRecovery !== "latest" && recoveryBatchRef.current === null) freezeRecoveryBatch(targetCountRef.current);
				if (recoveryBatchRef.current === null) settleCpsRef.current = null;
				const hadSample = lastInputTsRef.current > 0;
				const deltaChars = targetCountRef.current - lastInputCountRef.current;
				const deltaMs = Math.max(1, now - lastInputTsRef.current);
				if (hadSample && deltaChars > 0) {
					const instantCps = deltaChars * 1e3 / deltaMs;
					const normalizedInstantCps = clamp(instantCps, config.minCps, config.maxFlushCps * 3);
					const chunkEmaAlpha = .45;
					chunkSizeEmaRef.current = chunkSizeEmaRef.current * .55 + appendedCount * chunkEmaAlpha;
					arrivalCpsEmaRef.current = arrivalCpsEmaRef.current * .55 + normalizedInstantCps * chunkEmaAlpha;
					emaCpsRef.current = emaCpsRef.current * (1 - config.emaAlpha) + normalizedInstantCps * config.emaAlpha;
				}
				lastInputTsRef.current = now;
				lastInputCountRef.current = targetCountRef.current;
				if (recoveryRef.current.resumed()) observeRecoveryBacklog(visibleBacklog(replacementPendingRef.current ? 0 : displayedCountRef.current, targetCountRef.current));
				startFrameLoop();
			}, [
				backgroundRecovery,
				clearRecoveryBatch,
				content,
				enabled,
				freezeRecoveryBatch,
				replayOnEnable,
				config,
				observeRecoveryBacklog,
				startFrameLoop,
				syncImmediate,
				visibleBacklog
			]);
			(0, react.useEffect)(() => {
				if (enabled && skipRanges !== void 0) startFrameLoop();
			}, [
				enabled,
				skipRanges,
				startFrameLoop
			]);
			(0, react.useEffect)(() => {
				return () => {
					stopFrameLoop();
					debugRuntime.reportStream(streamIdRef.current, null);
				};
			}, [stopFrameLoop]);
			return displayedContent;
		}
		//#endregion
		//#region \0dsh-css:/root/workspaces/DSH项目维护/dsh-smooth-stream-git/src/client/LogarithmicFade.module.css.mjs
		const css$3 = ".FbuKPq_scope::highlight(FbuKPq_dsh-smooth-stream-log-fade-0),.FbuKPq_scope ::highlight(FbuKPq_dsh-smooth-stream-log-fade-0){color:color-mix(in srgb, var(--dsh-smooth-stream-fade-color,currentColor) 0.0%, transparent)}.FbuKPq_scope::highlight(FbuKPq_dsh-smooth-stream-log-fade-1),.FbuKPq_scope ::highlight(FbuKPq_dsh-smooth-stream-log-fade-1){color:color-mix(in srgb, var(--dsh-smooth-stream-fade-color,currentColor) 3.22581%, transparent)}.FbuKPq_scope::highlight(FbuKPq_dsh-smooth-stream-log-fade-2),.FbuKPq_scope ::highlight(FbuKPq_dsh-smooth-stream-log-fade-2){color:color-mix(in srgb, var(--dsh-smooth-stream-fade-color,currentColor) 6.45161%, transparent)}.FbuKPq_scope::highlight(FbuKPq_dsh-smooth-stream-log-fade-3),.FbuKPq_scope ::highlight(FbuKPq_dsh-smooth-stream-log-fade-3){color:color-mix(in srgb, var(--dsh-smooth-stream-fade-color,currentColor) 9.67742%, transparent)}.FbuKPq_scope::highlight(FbuKPq_dsh-smooth-stream-log-fade-4),.FbuKPq_scope ::highlight(FbuKPq_dsh-smooth-stream-log-fade-4){color:color-mix(in srgb, var(--dsh-smooth-stream-fade-color,currentColor) 12.9032%, transparent)}.FbuKPq_scope::highlight(FbuKPq_dsh-smooth-stream-log-fade-5),.FbuKPq_scope ::highlight(FbuKPq_dsh-smooth-stream-log-fade-5){color:color-mix(in srgb, var(--dsh-smooth-stream-fade-color,currentColor) 16.129%, transparent)}.FbuKPq_scope::highlight(FbuKPq_dsh-smooth-stream-log-fade-6),.FbuKPq_scope ::highlight(FbuKPq_dsh-smooth-stream-log-fade-6){color:color-mix(in srgb, var(--dsh-smooth-stream-fade-color,currentColor) 19.3548%, transparent)}.FbuKPq_scope::highlight(FbuKPq_dsh-smooth-stream-log-fade-7),.FbuKPq_scope ::highlight(FbuKPq_dsh-smooth-stream-log-fade-7){color:color-mix(in srgb, var(--dsh-smooth-stream-fade-color,currentColor) 22.5807%, transparent)}.FbuKPq_scope::highlight(FbuKPq_dsh-smooth-stream-log-fade-8),.FbuKPq_scope ::highlight(FbuKPq_dsh-smooth-stream-log-fade-8){color:color-mix(in srgb, var(--dsh-smooth-stream-fade-color,currentColor) 25.8065%, transparent)}.FbuKPq_scope::highlight(FbuKPq_dsh-smooth-stream-log-fade-9),.FbuKPq_scope ::highlight(FbuKPq_dsh-smooth-stream-log-fade-9){color:color-mix(in srgb, var(--dsh-smooth-stream-fade-color,currentColor) 29.0323%, transparent)}.FbuKPq_scope::highlight(FbuKPq_dsh-smooth-stream-log-fade-10),.FbuKPq_scope ::highlight(FbuKPq_dsh-smooth-stream-log-fade-10){color:color-mix(in srgb, var(--dsh-smooth-stream-fade-color,currentColor) 32.2581%, transparent)}.FbuKPq_scope::highlight(FbuKPq_dsh-smooth-stream-log-fade-11),.FbuKPq_scope ::highlight(FbuKPq_dsh-smooth-stream-log-fade-11){color:color-mix(in srgb, var(--dsh-smooth-stream-fade-color,currentColor) 35.4839%, transparent)}.FbuKPq_scope::highlight(FbuKPq_dsh-smooth-stream-log-fade-12),.FbuKPq_scope ::highlight(FbuKPq_dsh-smooth-stream-log-fade-12){color:color-mix(in srgb, var(--dsh-smooth-stream-fade-color,currentColor) 38.7097%, transparent)}.FbuKPq_scope::highlight(FbuKPq_dsh-smooth-stream-log-fade-13),.FbuKPq_scope ::highlight(FbuKPq_dsh-smooth-stream-log-fade-13){color:color-mix(in srgb, var(--dsh-smooth-stream-fade-color,currentColor) 41.9355%, transparent)}.FbuKPq_scope::highlight(FbuKPq_dsh-smooth-stream-log-fade-14),.FbuKPq_scope ::highlight(FbuKPq_dsh-smooth-stream-log-fade-14){color:color-mix(in srgb, var(--dsh-smooth-stream-fade-color,currentColor) 45.1613%, transparent)}.FbuKPq_scope::highlight(FbuKPq_dsh-smooth-stream-log-fade-15),.FbuKPq_scope ::highlight(FbuKPq_dsh-smooth-stream-log-fade-15){color:color-mix(in srgb, var(--dsh-smooth-stream-fade-color,currentColor) 48.3871%, transparent)}.FbuKPq_scope::highlight(FbuKPq_dsh-smooth-stream-log-fade-16),.FbuKPq_scope ::highlight(FbuKPq_dsh-smooth-stream-log-fade-16){color:color-mix(in srgb, var(--dsh-smooth-stream-fade-color,currentColor) 51.6129%, transparent)}.FbuKPq_scope::highlight(FbuKPq_dsh-smooth-stream-log-fade-17),.FbuKPq_scope ::highlight(FbuKPq_dsh-smooth-stream-log-fade-17){color:color-mix(in srgb, var(--dsh-smooth-stream-fade-color,currentColor) 54.8387%, transparent)}.FbuKPq_scope::highlight(FbuKPq_dsh-smooth-stream-log-fade-18),.FbuKPq_scope ::highlight(FbuKPq_dsh-smooth-stream-log-fade-18){color:color-mix(in srgb, var(--dsh-smooth-stream-fade-color,currentColor) 58.0645%, transparent)}.FbuKPq_scope::highlight(FbuKPq_dsh-smooth-stream-log-fade-19),.FbuKPq_scope ::highlight(FbuKPq_dsh-smooth-stream-log-fade-19){color:color-mix(in srgb, var(--dsh-smooth-stream-fade-color,currentColor) 61.2903%, transparent)}.FbuKPq_scope::highlight(FbuKPq_dsh-smooth-stream-log-fade-20),.FbuKPq_scope ::highlight(FbuKPq_dsh-smooth-stream-log-fade-20){color:color-mix(in srgb, var(--dsh-smooth-stream-fade-color,currentColor) 64.5161%, transparent)}.FbuKPq_scope::highlight(FbuKPq_dsh-smooth-stream-log-fade-21),.FbuKPq_scope ::highlight(FbuKPq_dsh-smooth-stream-log-fade-21){color:color-mix(in srgb, var(--dsh-smooth-stream-fade-color,currentColor) 67.7419%, transparent)}.FbuKPq_scope::highlight(FbuKPq_dsh-smooth-stream-log-fade-22),.FbuKPq_scope ::highlight(FbuKPq_dsh-smooth-stream-log-fade-22){color:color-mix(in srgb, var(--dsh-smooth-stream-fade-color,currentColor) 70.9677%, transparent)}.FbuKPq_scope::highlight(FbuKPq_dsh-smooth-stream-log-fade-23),.FbuKPq_scope ::highlight(FbuKPq_dsh-smooth-stream-log-fade-23){color:color-mix(in srgb, var(--dsh-smooth-stream-fade-color,currentColor) 74.1936%, transparent)}.FbuKPq_scope::highlight(FbuKPq_dsh-smooth-stream-log-fade-24),.FbuKPq_scope ::highlight(FbuKPq_dsh-smooth-stream-log-fade-24){color:color-mix(in srgb, var(--dsh-smooth-stream-fade-color,currentColor) 77.4194%, transparent)}.FbuKPq_scope::highlight(FbuKPq_dsh-smooth-stream-log-fade-25),.FbuKPq_scope ::highlight(FbuKPq_dsh-smooth-stream-log-fade-25){color:color-mix(in srgb, var(--dsh-smooth-stream-fade-color,currentColor) 80.6452%, transparent)}.FbuKPq_scope::highlight(FbuKPq_dsh-smooth-stream-log-fade-26),.FbuKPq_scope ::highlight(FbuKPq_dsh-smooth-stream-log-fade-26){color:color-mix(in srgb, var(--dsh-smooth-stream-fade-color,currentColor) 83.871%, transparent)}.FbuKPq_scope::highlight(FbuKPq_dsh-smooth-stream-log-fade-27),.FbuKPq_scope ::highlight(FbuKPq_dsh-smooth-stream-log-fade-27){color:color-mix(in srgb, var(--dsh-smooth-stream-fade-color,currentColor) 87.0968%, transparent)}.FbuKPq_scope::highlight(FbuKPq_dsh-smooth-stream-log-fade-28),.FbuKPq_scope ::highlight(FbuKPq_dsh-smooth-stream-log-fade-28){color:color-mix(in srgb, var(--dsh-smooth-stream-fade-color,currentColor) 90.3226%, transparent)}.FbuKPq_scope::highlight(FbuKPq_dsh-smooth-stream-log-fade-29),.FbuKPq_scope ::highlight(FbuKPq_dsh-smooth-stream-log-fade-29){color:color-mix(in srgb, var(--dsh-smooth-stream-fade-color,currentColor) 93.5484%, transparent)}.FbuKPq_scope::highlight(FbuKPq_dsh-smooth-stream-log-fade-30),.FbuKPq_scope ::highlight(FbuKPq_dsh-smooth-stream-log-fade-30){color:color-mix(in srgb, var(--dsh-smooth-stream-fade-color,currentColor) 96.7742%, transparent)}.FbuKPq_scope::highlight(FbuKPq_dsh-smooth-stream-log-fade-31),.FbuKPq_scope ::highlight(FbuKPq_dsh-smooth-stream-log-fade-31){color:color-mix(in srgb, var(--dsh-smooth-stream-fade-color,currentColor) 100.0%, transparent)}";
		const tagId$3 = "dsh-smooth-stream/LogarithmicFade.module.css";
		if (typeof document !== "undefined") {
			let tag = document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId$3) + "]");
			if (tag === null) {
				tag = document.createElement("style");
				tag.dataset.plugin = "dsh-smooth-stream";
				tag.dataset.pluginCss = tagId$3;
				document.head.appendChild(tag);
			}
			tag.textContent = css$3;
		}
		var LogarithmicFade_module_css_default = {
			"dsh-smooth-stream-log-fade-11": "FbuKPq_dsh-smooth-stream-log-fade-11",
			"dsh-smooth-stream-log-fade-17": "FbuKPq_dsh-smooth-stream-log-fade-17",
			"dsh-smooth-stream-log-fade-30": "FbuKPq_dsh-smooth-stream-log-fade-30",
			"dsh-smooth-stream-log-fade-4": "FbuKPq_dsh-smooth-stream-log-fade-4",
			"dsh-smooth-stream-log-fade-7": "FbuKPq_dsh-smooth-stream-log-fade-7",
			"dsh-smooth-stream-log-fade-21": "FbuKPq_dsh-smooth-stream-log-fade-21",
			"dsh-smooth-stream-log-fade-24": "FbuKPq_dsh-smooth-stream-log-fade-24",
			"dsh-smooth-stream-log-fade-0": "FbuKPq_dsh-smooth-stream-log-fade-0",
			"dsh-smooth-stream-log-fade-18": "FbuKPq_dsh-smooth-stream-log-fade-18",
			"dsh-smooth-stream-log-fade-2": "FbuKPq_dsh-smooth-stream-log-fade-2",
			"dsh-smooth-stream-log-fade-20": "FbuKPq_dsh-smooth-stream-log-fade-20",
			"dsh-smooth-stream-log-fade-16": "FbuKPq_dsh-smooth-stream-log-fade-16",
			"dsh-smooth-stream-log-fade-28": "FbuKPq_dsh-smooth-stream-log-fade-28",
			"dsh-smooth-stream-log-fade-31": "FbuKPq_dsh-smooth-stream-log-fade-31",
			"scope": "FbuKPq_scope",
			"dsh-smooth-stream-log-fade-1": "FbuKPq_dsh-smooth-stream-log-fade-1",
			"dsh-smooth-stream-log-fade-5": "FbuKPq_dsh-smooth-stream-log-fade-5",
			"dsh-smooth-stream-log-fade-8": "FbuKPq_dsh-smooth-stream-log-fade-8",
			"dsh-smooth-stream-log-fade-12": "FbuKPq_dsh-smooth-stream-log-fade-12",
			"dsh-smooth-stream-log-fade-13": "FbuKPq_dsh-smooth-stream-log-fade-13",
			"dsh-smooth-stream-log-fade-22": "FbuKPq_dsh-smooth-stream-log-fade-22",
			"dsh-smooth-stream-log-fade-26": "FbuKPq_dsh-smooth-stream-log-fade-26",
			"dsh-smooth-stream-log-fade-3": "FbuKPq_dsh-smooth-stream-log-fade-3",
			"dsh-smooth-stream-log-fade-23": "FbuKPq_dsh-smooth-stream-log-fade-23",
			"dsh-smooth-stream-log-fade-10": "FbuKPq_dsh-smooth-stream-log-fade-10",
			"dsh-smooth-stream-log-fade-15": "FbuKPq_dsh-smooth-stream-log-fade-15",
			"dsh-smooth-stream-log-fade-9": "FbuKPq_dsh-smooth-stream-log-fade-9",
			"dsh-smooth-stream-log-fade-6": "FbuKPq_dsh-smooth-stream-log-fade-6",
			"dsh-smooth-stream-log-fade-25": "FbuKPq_dsh-smooth-stream-log-fade-25",
			"dsh-smooth-stream-log-fade-19": "FbuKPq_dsh-smooth-stream-log-fade-19",
			"dsh-smooth-stream-log-fade-29": "FbuKPq_dsh-smooth-stream-log-fade-29",
			"dsh-smooth-stream-log-fade-27": "FbuKPq_dsh-smooth-stream-log-fade-27",
			"dsh-smooth-stream-log-fade-14": "FbuKPq_dsh-smooth-stream-log-fade-14"
		};
		const FADE_STEPS = 32;
		const PREFIX = "dsh-smooth-stream-log-fade-";
		const COLOR_PROPERTY = "--dsh-smooth-stream-fade-color";
		const highlightName = (index) => LogarithmicFade_module_css_default[`${PREFIX}${index}`] ?? `${PREFIX}${index}`;
		const EXCLUDED = "pre,code,math,.katex,.katex-display,mjx-container,svg,script,style,textarea,input,button,select,[role=\"button\"],[contenteditable],[hidden],[aria-hidden=\"true\"],[aria-live]";
		function logarithmicOpacity(progress) {
			return 0 + 1 * (1 - Math.log1p(5 * (1 - (Number.isFinite(progress) ? Math.max(0, Math.min(1, progress)) : 1))) / Math.log(6));
		}
		function fadeTailSize(speedCps) {
			return Math.min(160, Math.max(24, Math.ceil((Number.isFinite(speedCps) ? Math.max(0, speedCps) : 0) * 240 / 1e3)));
		}
		const schedulers = /* @__PURE__ */ new WeakMap();
		const segmenter = new Intl.Segmenter(void 0, { granularity: "grapheme" });
		function schedule(scheduler) {
			if (scheduler.frame !== 0 || scheduler.pending.size === 0) return;
			scheduler.frame = scheduler.window.requestAnimationFrame((now) => {
				scheduler.frame = 0;
				for (const client of scheduler.pending) if (!client.paint(now)) scheduler.pending.delete(client);
				schedule(scheduler);
			});
		}
		function schedulerFor(root) {
			const doc = root.ownerDocument;
			const win = doc.defaultView;
			if (win === null) return null;
			const realm = win;
			if (typeof realm.Highlight !== "function" || !realm.CSS?.highlights || !realm.CSS.supports("color", "color-mix(in srgb, currentColor 15%, transparent)")) return null;
			let scheduler = schedulers.get(doc);
			if (scheduler === void 0) {
				const highlights = Array.from({ length: FADE_STEPS }, () => new realm.Highlight());
				for (const [index, highlight] of highlights.entries()) realm.CSS.highlights.set(highlightName(index), highlight);
				scheduler = {
					highlights,
					clients: /* @__PURE__ */ new Set(),
					pending: /* @__PURE__ */ new Set(),
					frame: 0,
					registry: realm.CSS.highlights,
					window: win
				};
				schedulers.set(doc, scheduler);
			}
			return scheduler;
		}
		/** Owns ranges only: React retains ownership of every element and Text node. */
		var LogarithmicFadeController = class LogarithmicFadeController {
			root;
			scheduler;
			previous = "";
			characters = [];
			colors = /* @__PURE__ */ new Map();
			enabled = false;
			active = false;
			speedCps = 100;
			pausedAt = null;
			disposed = false;
			observer;
			constructor(root, scheduler) {
				this.root = root;
				this.scheduler = scheduler;
				scheduler.clients.add(this);
				const win = root.ownerDocument.defaultView;
				this.observer = new win.MutationObserver(() => {
					this.reconcile();
				});
				this.observer.observe(root, {
					subtree: true,
					childList: true,
					characterData: true
				});
			}
			static create(root) {
				const scheduler = schedulerFor(root);
				return scheduler === null ? null : new LogarithmicFadeController(root, scheduler);
			}
			update(enabled, active, speedCps = 100, paused = false) {
				const now = this.scheduler.window.performance.now();
				if (paused && this.pausedAt === null) this.pausedAt = now;
				if (!paused && this.pausedAt !== null) {
					const pauseDuration = now - this.pausedAt;
					for (const character of this.characters) character.born += pauseDuration;
					this.pausedAt = null;
				}
				this.enabled = enabled;
				this.active = active;
				this.speedCps = speedCps;
				this.reconcile();
			}
			clearRanges() {
				for (const character of this.characters) this.scheduler.highlights[character.bucket]?.delete(character.range);
				this.characters = [];
				this.restoreColors();
			}
			restoreColors() {
				for (const [element, original] of this.colors) if (original.value === "") element.style.removeProperty(COLOR_PROPERTY);
				else element.style.setProperty(COLOR_PROPERTY, original.value, original.priority);
				this.colors.clear();
			}
			preserveColor(element) {
				if (this.colors.has(element)) return;
				const color = this.scheduler.window.getComputedStyle(element).color;
				this.colors.set(element, {
					value: element.style.getPropertyValue(COLOR_PROPERTY),
					priority: element.style.getPropertyPriority(COLOR_PROPERTY)
				});
				element.style.setProperty(COLOR_PROPERTY, color);
			}
			reconcile() {
				if (this.disposed) return;
				const text = this.root.textContent ?? "";
				const previous = this.previous;
				this.previous = text;
				const old = this.characters;
				this.clearRanges();
				if (!this.enabled) {
					this.root.classList.remove(LogarithmicFade_module_css_default.scope);
					this.scheduler.pending.delete(this);
					this.stopIfIdle();
					return;
				}
				this.root.classList.add(LogarithmicFade_module_css_default.scope);
				const now = this.pausedAt ?? this.scheduler.window.performance.now();
				let prefix = 0;
				while (prefix < previous.length && prefix < text.length && previous[prefix] === text[prefix]) prefix += 1;
				const appended = text.startsWith(previous);
				const tailCutoff = Math.max(0, text.length - 320);
				const nodes = [];
				const walker = this.root.ownerDocument.createTreeWalker(this.root, NodeFilter.SHOW_TEXT);
				let offset = 0;
				for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
					const len = node.textContent?.length ?? 0;
					const end = offset + len;
					if (end > tailCutoff) nodes.push({
						node,
						start: offset,
						end,
						eligible: node.parentElement?.closest(EXCLUDED) === null
					});
					offset = end;
				}
				const tailText = tailCutoff > 0 ? text.slice(tailCutoff) : text;
				const segments = segmenter.segment(tailText);
				const tailSize = fadeTailSize(this.speedCps);
				const oldestLiveStart = old.reduce((start, character) => now - character.born < 240 && character.end <= prefix ? Math.min(start, character.start) : start, Infinity);
				let end = text.length;
				for (let count = 0; count < 160 && end > tailCutoff && (count < tailSize || end > oldestLiveStart); count += 1) {
					const localPos = end - 1 - tailCutoff;
					const segment = segments.containing(localPos);
					if (segment === void 0) break;
					const start = tailCutoff + segment.index;
					const parts = nodes.filter((node) => node.end > start && node.start < end);
					const born = old.find((character) => character.start === start && character.end === end && end <= prefix)?.born ?? (this.active && appended && start >= previous.length ? now : null);
					if (born !== null && now - born < 240 && segment.segment.trim() !== "" && parts.length > 0 && parts.every((part) => part.eligible)) {
						const first = parts[0];
						const last = parts[parts.length - 1];
						const range = this.root.ownerDocument.createRange();
						range.setStart(first.node, start - first.start);
						range.setEnd(last.node, end - last.start);
						for (const part of parts) this.preserveColor(part.node.parentElement);
						this.characters.push({
							start,
							end,
							born,
							range,
							bucket: -1
						});
					}
					end = start;
				}
				if (this.paint(now)) {
					if (this.pausedAt === null) {
						this.scheduler.pending.add(this);
						schedule(this.scheduler);
					} else {
						this.scheduler.pending.delete(this);
						this.stopIfIdle();
					}
				} else {
					this.scheduler.pending.delete(this);
					this.stopIfIdle();
				}
			}
			paint(now) {
				this.characters = this.characters.filter((character) => {
					const progress = (now - character.born) / 240;
					if (progress >= 1 || !this.root.isConnected || !this.root.contains(character.range.startContainer)) {
						this.scheduler.highlights[character.bucket]?.delete(character.range);
						return false;
					}
					const bucket = Math.min(31, Math.round((logarithmicOpacity(progress) - 0) / 1 * 31));
					if (bucket !== character.bucket) {
						this.scheduler.highlights[character.bucket]?.delete(character.range);
						this.scheduler.highlights[bucket].add(character.range);
						character.bucket = bucket;
					}
					return true;
				});
				if (this.characters.length === 0) this.restoreColors();
				return this.characters.length > 0;
			}
			stopIfIdle() {
				if (this.scheduler.pending.size !== 0) return;
				this.scheduler.window.cancelAnimationFrame(this.scheduler.frame);
				this.scheduler.frame = 0;
			}
			dispose() {
				if (this.disposed) return;
				this.disposed = true;
				this.observer.disconnect();
				this.clearRanges();
				this.root.classList.remove(LogarithmicFade_module_css_default.scope);
				this.scheduler.pending.delete(this);
				this.scheduler.clients.delete(this);
				this.stopIfIdle();
				if (this.scheduler.clients.size === 0) {
					for (const [index, highlight] of this.scheduler.highlights.entries()) {
						const name = highlightName(index);
						if (this.scheduler.registry.get(name) === highlight) this.scheduler.registry.delete(name);
					}
					schedulers.delete(this.root.ownerDocument);
				}
			}
		};
		/** active admits new characters; enabled=false also cancels completion linger. */
		function useLogarithmicFade(rootRef, enabled, active, speedCpsRef, paused = false) {
			const controller = (0, react.useRef)(null);
			const committed = (0, react.useRef)(false);
			(0, react.useLayoutEffect)(() => {
				return () => {
					controller.current?.dispose();
					controller.current = null;
				};
			}, [rootRef]);
			(0, react.useLayoutEffect)(() => {
				const root = rootRef.current;
				if (controller.current === null && root !== null && enabled && active) {
					controller.current = LogarithmicFadeController.create(root);
					if (committed.current) controller.current?.update(false, false);
				}
				controller.current?.update(enabled, active, speedCpsRef?.current, paused);
				committed.current = true;
			});
		}
		//#endregion
		//#region src/client/presentationProgress.ts
		/** Bounded, derived presentation progress. No session content is persisted here. */
		var PresentationProgress = class {
			maxEntries;
			maxChars;
			entries = /* @__PURE__ */ new Map();
			size = 0;
			constructor(maxEntries = 512, maxChars = 1e6) {
				this.maxEntries = maxEntries;
				this.maxChars = maxChars;
			}
			read(key, source) {
				const shown = this.entries.get(key);
				return shown !== void 0 && source.startsWith(shown) ? shown : void 0;
			}
			remember(key, shown) {
				const previous = this.entries.get(key);
				if (previous === shown) return;
				if (previous !== void 0) this.size -= previous.length;
				this.entries.delete(key);
				if (shown.length > this.maxChars) return;
				this.entries.set(key, shown);
				this.size += shown.length;
				while (this.entries.size > this.maxEntries || this.size > this.maxChars) {
					const oldest = this.entries.entries().next().value;
					if (oldest === void 0) break;
					this.entries.delete(oldest[0]);
					this.size -= oldest[1].length;
				}
			}
			clear() {
				this.entries.clear();
				this.size = 0;
			}
		};
		const assistantProgress = new PresentationProgress();
		//#endregion
		//#region src/client/streamOrder.ts
		const STREAM_ORDER_DATA_KEY = "dsh-smooth-stream/order";
		function coordinates(match) {
			const location = match.location;
			if (location.kind !== "step") return void 0;
			return {
				turn: location.step.turn,
				step: location.step.step
			};
		}
		function eventBlockIndex(match) {
			const event = match.event;
			if (event.type !== "assistant/live-chunk") return void 0;
			const chunk = event.data.chunk;
			if (chunk.type !== "block-start" && chunk.type !== "text-delta" && chunk.type !== "reasoning-delta" && chunk.type !== "tool-call-delta" && chunk.type !== "block-end") return void 0;
			return chunk.index;
		}
		function matchesStep(match, state) {
			const coordinatesValue = coordinates(match);
			return coordinatesValue?.turn === state.turn && coordinatesValue.step === state.step;
		}
		function updateState(state, match) {
			if (!matchesStep(match, state)) return state;
			const index = eventBlockIndex(match);
			if (index === void 0 || state.blockSeqs.has(index)) return state;
			const next = new Map(state.blockSeqs);
			next.set(index, Number(match.event.seq));
			return {
				...state,
				blockSeqs: next
			};
		}
		function streamOrderDefinition() {
			return {
				kind: STREAM_ORDER_DATA_KEY,
				match: (event) => {
					if (event.type === "step/start") return {
						id: `${event.data.turn}:${event.data.step}`,
						role: "start"
					};
					if (event.type === "assistant/live-chunk" || event.type === "assistant/message" || event.type === "assistant/attempt") return {
						id: `${event.data.turn}:${event.data.step}`,
						role: "update"
					};
					return null;
				},
				start: (_context, match) => {
					const coordinatesValue = coordinates(match);
					if (coordinatesValue === void 0) throw new Error("stream order start outside a step");
					return updateState({
						...coordinatesValue,
						blockSeqs: /* @__PURE__ */ new Map()
					}, match);
				},
				update: (context, match) => updateState(context.state, match),
				buildLocationData: (context, scope) => {
					if (scope !== "step" || context.state === void 0) return null;
					return {
						kind: "step",
						turn: context.state.turn,
						step: context.state.step,
						key: STREAM_ORDER_DATA_KEY,
						value: { blockSeqs: new Map(context.state.blockSeqs) }
					};
				}
			};
		}
		//#endregion
		//#region src/client/usePresentationAdmission.ts
		const admissions = /* @__PURE__ */ new Map();
		const subscriptions = /* @__PURE__ */ new Map();
		const admissionListeners = /* @__PURE__ */ new Set();
		let admissionRevision = 0;
		let ordinal = 0;
		let scheduled = false;
		const PART_ORDER = {
			reasoning: 0,
			response: 1,
			tool: 2,
			output: 2
		};
		const sourceSnapshots = /* @__PURE__ */ new Map();
		const nodeSources = /* @__PURE__ */ new Map();
		const sourceListeners = /* @__PURE__ */ new Map();
		function sourceKey(session, node) {
			return JSON.stringify([session, node]);
		}
		function publishSource(key) {
			for (const listener of [...sourceListeners.get(key) ?? []]) listener();
		}
		function readPresentationSource(session, node) {
			const key = sourceKey(session, node);
			let first;
			for (const snapshot of nodeSources.get(key) ?? []) if (first === void 0 || snapshot.epoch < first.epoch) first = snapshot;
			return first?.source;
		}
		function subscribePresentationSource(session, node, listener) {
			const key = sourceKey(session, node);
			const listeners = sourceListeners.get(key) ?? /* @__PURE__ */ new Set();
			sourceListeners.set(key, listeners);
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
				if (listeners.size === 0) sourceListeners.delete(key);
			};
		}
		function reservePresentationSource(ownerKey, scope, epoch, source) {
			const snapshot = sourceSnapshots.get(ownerKey) ?? {
				key: sourceKey(scope.session, scope.node),
				epoch,
				source,
				holders: /* @__PURE__ */ new Set()
			};
			const holder = Symbol("presentation-source");
			snapshot.holders.add(holder);
			sourceSnapshots.set(ownerKey, snapshot);
			const snapshots = nodeSources.get(snapshot.key) ?? /* @__PURE__ */ new Set();
			snapshots.add(snapshot);
			nodeSources.set(snapshot.key, snapshots);
			publishSource(snapshot.key);
			return () => {
				snapshot.holders.delete(holder);
				if (snapshot.holders.size > 0 || sourceSnapshots.get(ownerKey) !== snapshot) return;
				finishPresentationSource(ownerKey);
			};
		}
		function finishPresentationSource(ownerKey) {
			if (ownerKey === void 0) return;
			const snapshot = sourceSnapshots.get(ownerKey);
			if (snapshot === void 0) return;
			sourceSnapshots.delete(ownerKey);
			const snapshots = nodeSources.get(snapshot.key);
			snapshots?.delete(snapshot);
			if (snapshots?.size === 0) nodeSources.delete(snapshot.key);
			publishSource(snapshot.key);
		}
		function publishAdmissions() {
			admissionRevision += 1;
			for (const listener of [...admissionListeners]) listener();
		}
		function presentationOwnerKey(scope, part) {
			return JSON.stringify([
				scope.session,
				scope.turn,
				scope.step,
				scope.node,
				part
			]);
		}
		function presentationOwnerAdmitted(ownerKey) {
			return admissions.get(ownerKey)?.admitted;
		}
		function subscribePresentationOwner(ownerKey, listener) {
			const listeners = subscriptions.get(ownerKey) ?? /* @__PURE__ */ new Set();
			listeners.add(listener);
			subscriptions.set(ownerKey, listeners);
			return () => {
				listeners.delete(listener);
				if (listeners.size === 0) subscriptions.delete(ownerKey);
			};
		}
		function compare(left, right) {
			const step = left.scope.step - right.scope.step;
			if (step !== 0) return step;
			const source = (left.scope.sourceOrder ?? left.scope.order) - (right.scope.sourceOrder ?? right.scope.order);
			if (Number.isFinite(source) && source !== 0) return source;
			if (left.scope.node === right.scope.node) {
				const part = PART_ORDER[left.part] - PART_ORDER[right.part];
				if (part !== 0) return part;
			}
			const a = left.root.current;
			const b = right.root.current;
			if (a !== null && b !== null && a !== b && a.isConnected && b.isConnected) {
				const position = a.compareDocumentPosition(b);
				if ((position & Node.DOCUMENT_POSITION_DISCONNECTED) === 0) {
					if ((position & Node.DOCUMENT_POSITION_FOLLOWING) !== 0) return -1;
					if ((position & Node.DOCUMENT_POSITION_PRECEDING) !== 0) return 1;
				}
			}
			return left.ordinal - right.ordinal;
		}
		function scheduleAdmissions() {
			if (scheduled) return;
			scheduled = true;
			queueMicrotask(() => {
				scheduled = false;
				const turns = /* @__PURE__ */ new Map();
				for (const entry of admissions.values()) {
					const key = relayTurnKey(entry.scope);
					const items = turns.get(key) ?? [];
					items.push(entry);
					turns.set(key, items);
				}
				const changed = [];
				for (const items of turns.values()) {
					let pendingOwner = false;
					let unbatchedPredecessor = false;
					let earliestPendingEpoch = Number.POSITIVE_INFINITY;
					for (const entry of items.sort(compare)) {
						const epoch = entry.scope.recoveryEpoch;
						const predecessor = pendingOwner && (unbatchedPredecessor || epoch === void 0 || entry.reservedEpoch !== epoch || earliestPendingEpoch <= epoch);
						if (!entry.admitted && !predecessor && !streamRelay.isBlocked(entry.scope, entry.part)) {
							entry.admitted = true;
							changed.push(entry);
						}
						if (entry.admitted && (!entry.committed || entry.pending)) {
							pendingOwner = true;
							if (epoch === void 0) unbatchedPredecessor = true;
							else earliestPendingEpoch = Math.min(earliestPendingEpoch, epoch);
						}
					}
				}
				if (changed.length > 0) {
					publishAdmissions();
					for (const entry of changed) {
						const listeners = subscriptions.get(entry.token);
						if (listeners !== void 0) for (const listener of [...listeners]) listener();
					}
				}
			});
		}
		/**
		* Reserve an owner without creating its actual renderer, icon or card DOM.
		* Admission is latched: a later pause never unmounts an already presented row.
		*/
		function usePresentationAdmission(scope, part, enabled, pending, root, initiallyPresented = false, ownerKey, reserveOnly = false) {
			const tokenRef = (0, react.useRef)(null);
			if (tokenRef.current === null || tokenRef.current.ownerKey !== ownerKey) tokenRef.current = {
				ownerKey,
				token: ownerKey ?? Symbol("presentation-admission")
			};
			const token = tokenRef.current.token;
			const presented = (0, react.useRef)(initiallyPresented || !enabled);
			if (!enabled) presented.current = true;
			const current = (0, react.useRef)({
				scope,
				part,
				pending,
				root
			});
			current.current = {
				scope,
				part,
				pending,
				root
			};
			const subscribe = (0, react.useCallback)((listener) => {
				const listeners = subscriptions.get(token) ?? /* @__PURE__ */ new Set();
				listeners.add(listener);
				subscriptions.set(token, listeners);
				return () => {
					listeners.delete(listener);
					if (listeners.size === 0) subscriptions.delete(token);
				};
			}, [token]);
			const read = (0, react.useCallback)(() => presented.current || admissions.get(token)?.admitted === true, [token]);
			const admitted = (0, react.useSyncExternalStore)(subscribe, read, read);
			if (admitted) presented.current = true;
			(0, react.useLayoutEffect)(() => {
				if (!enabled) return;
				const existing = admissions.get(token);
				if (existing !== void 0) existing.refs += 1;
				else if (!presented.current) {
					const value = current.current;
					admissions.set(token, {
						token,
						...value,
						ordinal: ordinal++,
						admitted: false,
						committed: false,
						pending: true,
						reservedEpoch: reserveOnly ? value.scope.recoveryEpoch : void 0,
						refs: 1
					});
				} else return;
				publishAdmissions();
				scheduleAdmissions();
				return () => {
					const entry = admissions.get(token);
					if (entry !== void 0) {
						entry.refs -= 1;
						if (entry.refs <= 0) admissions.delete(token);
					}
					publishAdmissions();
					scheduleAdmissions();
				};
			}, [
				enabled,
				scope.session,
				scope.turn,
				scope.node,
				part,
				token
			]);
			(0, react.useLayoutEffect)(() => {
				if (!enabled || !admissions.has(token)) return;
				return streamRelay.subscribeBlocked(scope, part, scheduleAdmissions);
			}, [
				enabled,
				scope.session,
				scope.turn,
				scope.step,
				scope.node,
				scope.order,
				scope.sourceOrder,
				scope.recoveryEpoch,
				part,
				token
			]);
			(0, react.useLayoutEffect)(() => {
				const entry = admissions.get(token);
				if (entry === void 0) return;
				if (reserveOnly) {
					if (!admitted) {
						entry.scope = scope;
						entry.reservedEpoch = scope.recoveryEpoch;
						publishAdmissions();
						scheduleAdmissions();
					}
					if (admitted && !entry.committed) {
						entry.committed = true;
						entry.pending = pending;
						publishAdmissions();
						scheduleAdmissions();
					}
					return;
				}
				entry.scope = scope;
				entry.root = root;
				if (admitted) {
					entry.committed = true;
					entry.pending = pending;
				}
				publishAdmissions();
				scheduleAdmissions();
			}, [
				admitted,
				pending,
				root,
				reserveOnly,
				scope.session,
				scope.turn,
				scope.step,
				scope.node,
				scope.order,
				scope.sourceOrder,
				scope.recoveryEpoch,
				token
			]);
			(0, react.useLayoutEffect)(() => {
				if (!reserveOnly && admitted && !pending) finishPresentationSource(ownerKey);
			}, [
				admitted,
				pending,
				reserveOnly,
				ownerKey
			]);
			return admitted;
		}
		//#endregion
		//#region src/client/NativeAssistantNodeView.tsx
		function useReducedMotion(preference) {
			const [system, setSystem] = (0, react.useState)(() => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches);
			(0, react.useEffect)(() => {
				if (typeof matchMedia !== "function") return;
				const query = matchMedia("(prefers-reduced-motion: reduce)");
				const change = () => {
					setSystem(query.matches);
				};
				change();
				query.addEventListener("change", change);
				return () => {
					query.removeEventListener("change", change);
				};
			}, []);
			return preference === "force-reduced" || preference === "auto" && system;
		}
		const projectionCaches = /* @__PURE__ */ new WeakMap();
		function projectionCache(projection) {
			const cached = projectionCaches.get(projection);
			if (cached !== void 0) return cached;
			let offset = 0;
			const offsets = projection.segments.map((segment) => {
				const start = offset;
				offset += segment.length;
				return start;
			});
			const cache = {
				source: projection.segments.join(""),
				offsets,
				partials: /* @__PURE__ */ new Map()
			};
			projectionCaches.set(projection, cache);
			return cache;
		}
		/** Only smooth text this grouped row actually owns; its other blocks retain their source data. */
		function assistantTextSegments(blocks, groupPart) {
			const segments = [];
			const blockIndices = [];
			blocks.forEach((block, index) => {
				if (block.kind === "reasoning" && groupPart !== "response") {
					segments.push(block.text);
					blockIndices.push(index);
				} else if (block.kind === "text" && groupPart !== "reasoning") {
					segments.push(block.text);
					blockIndices.push(index);
				}
			});
			return {
				segments,
				blockIndices
			};
		}
		/** Avoid splitting a code point even if an external caller supplies a partial surrogate prefix. */
		function codePointEnd(source, end) {
			if (end <= 0 || end >= source.length) return end;
			const previous = source.charCodeAt(end - 1);
			const next = source.charCodeAt(end);
			return previous >= 55296 && previous <= 56319 && next >= 56320 && next <= 57343 ? end - 1 : end;
		}
		/** Distribute a committed prefix without changing block count, order, identity or opaque metadata. */
		function revealAssistantBlocks(blocks, projection, shown) {
			const cache = projectionCache(projection);
			const end = codePointEnd(cache.source, Math.min(shown.length, cache.source.length));
			if (end === cache.source.length) return blocks;
			let next;
			projection.blockIndices.forEach((blockIndex, segmentIndex) => {
				const source = projection.segments[segmentIndex];
				const start = cache.offsets[segmentIndex];
				const block = blocks[blockIndex];
				if (source === void 0 || start === void 0 || block === void 0 || block.kind !== "text" && block.kind !== "reasoning") return;
				const count = codePointEnd(source, Math.max(0, Math.min(end - start, source.length)));
				if (count === source.length) return;
				const previous = cache.partials.get(blockIndex);
				const partial = previous?.source === block && previous.end === count ? previous.block : {
					...block,
					text: source.slice(0, count)
				};
				if (partial !== previous?.block) cache.partials.set(blockIndex, {
					source: block,
					end: count,
					block: partial
				});
				next ??= blocks.slice();
				next[blockIndex] = partial;
			});
			return next ?? blocks;
		}
		/** Keep future images/opaque blocks out of the renderer until their source position. */
		function projectAssistantPresentation(blocks, projection, shown) {
			const revealed = revealAssistantBlocks(blocks, projection, shown);
			if (revealed === blocks) return blocks;
			const cache = projectionCache(projection);
			for (const [segmentIndex, blockIndex] of projection.blockIndices.entries()) {
				const source = projection.segments[segmentIndex];
				const start = cache.offsets[segmentIndex];
				if (source !== void 0 && start !== void 0 && shown.length < start + source.length) return revealed.slice(0, blockIndex + 1);
			}
			return revealed;
		}
		/** Match the official reasoning-text prefix filter without importing a Client plugin. */
		function reasoningDisplayStart(text) {
			if (text[0] !== "<") return 0;
			const opening = "<signature>";
			if (opening.startsWith(text)) return text.length;
			if (!text.startsWith(opening)) return 0;
			const end = text.indexOf("</signature>", 11);
			if (end === -1) return text.length;
			let start = end + 12;
			while (start < text.length) if (text[start] === "\n") start++;
			else if (text[start] === "\r" && text[start + 1] === "\n") start += 2;
			else break;
			return start;
		}
		function blockSourceOrder(node, groupPart, shown) {
			const location = node.location;
			if (location.kind !== "step") return void 0;
			const data = location.step.data.get(STREAM_ORDER_DATA_KEY);
			if (data === void 0) return void 0;
			let offset = 0;
			for (const [index, block] of node.data.blocks.entries()) {
				if (block.kind !== "reasoning" && block.kind !== "text") continue;
				if (groupPart === "reasoning" && block.kind !== "reasoning") continue;
				if (groupPart === "response" && block.kind !== "text") continue;
				const next = offset + countChars(block.text);
				if (shown.length < next) return data.blockSeqs.get(index);
				offset = next;
			}
		}
		function hasVisibleReasoning(text) {
			return text.slice(reasoningDisplayStart(text)).trim() !== "";
		}
		function hiddenAncestor(element) {
			let current = element;
			while (current !== null) {
				if (current.hasAttribute("hidden") || current.hasAttribute("data-turn-process-inline")) return true;
				if (current instanceof HTMLElement && (current.style.display === "none" || current.style.contentVisibility === "hidden")) return true;
				const style = getComputedStyle(current);
				if (style.display === "none" || style.contentVisibility === "hidden") return true;
				current = current.parentElement;
			}
			return false;
		}
		/** Observe the official disclosures, not a second invocation of their independent Hook. */
		function useCollapsedReasoning(root, blocks, active, disclosureRows, setCollapsed, setHidden) {
			const blocksRef = (0, react.useRef)(blocks);
			blocksRef.current = blocks;
			const shape = blocks.flatMap((block, index) => block.kind === "reasoning" && hasVisibleReasoning(block.text) ? [index] : []).join(",");
			(0, react.useLayoutEffect)(() => {
				const element = root.current;
				if (!active || element === null) return;
				const indices = shape === "" ? [] : shape.split(",").map(Number);
				const rows = [...element.querySelectorAll("[data-variant=\"think\"]")];
				const mappedRows = /* @__PURE__ */ new Map();
				rows.forEach((row, order) => {
					if (indices[order] !== void 0) mappedRows.set(indices[order], row);
				});
				disclosureRows.current = mappedRows;
				let disposed = false;
				const inspect = () => {
					if (disposed) return;
					const hidden = hiddenAncestor(element);
					setHidden((previous) => previous === hidden ? previous : hidden);
					setCollapsed((previous) => {
						const next = new Set(previous.filter((index) => blocksRef.current[index]?.kind === "reasoning"));
						rows.forEach((row, order) => {
							const index = indices[order];
							if (index === void 0) return;
							if (!row.hasAttribute("data-expanded") || hiddenAncestor(row)) next.add(index);
							else next.delete(index);
						});
						const sorted = [...next].sort((left, right) => left - right);
						return previous.length === sorted.length && previous.every((index, order) => index === sorted[order]) ? previous : sorted;
					});
				};
				const changed = () => {
					queueMicrotask(inspect);
				};
				const observer = typeof MutationObserver === "undefined" ? null : new MutationObserver(changed);
				for (const row of rows) {
					observer?.observe(row, {
						attributes: true,
						attributeFilter: ["data-expanded"]
					});
					for (let parent = row.parentElement; parent !== null && parent !== element; parent = parent.parentElement) observer?.observe(parent, {
						attributes: true,
						attributeFilter: ["hidden", "data-turn-process-inline"]
					});
				}
				for (let parent = element; parent !== null; parent = parent.parentElement) observer?.observe(parent, {
					attributes: true,
					attributeFilter: [
						"hidden",
						"style",
						"class"
					]
				});
				changed();
				return () => {
					disposed = true;
					observer?.disconnect();
					if (disclosureRows.current === mappedRows) disclosureRows.current = /* @__PURE__ */ new Map();
				};
			}, [
				root,
				shape,
				active
			]);
		}
		/** Call the official Hook in every ReasoningRow, retaining its reset subscription. */
		function useAutomaticDisclosure(official, enabled, active) {
			return (0, react.useMemo)(() => function useStreamDisclosure() {
				const disclosure = official();
				const state = (0, react.useRef)({
					manual: false,
					autoOpened: false,
					setter: disclosure.setExpanded,
					expanded: disclosure.expanded
				});
				if (state.current.setter !== disclosure.setExpanded || state.current.expanded && !disclosure.expanded && state.current.autoOpened) {
					state.current.manual = true;
					state.current.autoOpened = false;
				}
				state.current.setter = disclosure.setExpanded;
				state.current.expanded = disclosure.expanded;
				const auto = enabled;
				const streaming = active;
				(0, react.useEffect)(() => {
					if (state.current.manual) return;
					if (auto && streaming && !disclosure.expanded) {
						state.current.autoOpened = true;
						disclosure.setExpanded(true);
					} else if ((!auto || !streaming) && state.current.autoOpened) {
						state.current.autoOpened = false;
						disclosure.setExpanded(false);
					}
				}, [
					auto,
					streaming,
					disclosure.expanded,
					disclosure.setExpanded
				]);
				const setExpanded = (0, react.useCallback)((open) => {
					state.current.manual = true;
					state.current.autoOpened = false;
					disclosure.setExpanded(open);
				}, [disclosure.setExpanded]);
				const toggle = (0, react.useCallback)(() => {
					state.current.manual = true;
					state.current.autoOpened = false;
					disclosure.toggle();
				}, [disclosure.toggle]);
				return {
					...disclosure,
					setExpanded,
					toggle
				};
			}, [
				official,
				enabled,
				active
			]);
		}
		/**
		* Feed paced text to the shipped renderer instead of cloning Chat's UI.
		* Its registration still owns locale, children, disclosures, file gestures,
		* image loading, presentation policy and reasoning-translation extensions.
		*/
		function NativeAssistantNodeView(props) {
			const { owner } = props;
			const key = JSON.stringify([
				owner.sessionId,
				owner.node.data.turn,
				owner.node.data.step,
				owner.node.key,
				owner.groupPart
			]);
			return (0, react.createElement)(NativeAssistantSeat, {
				...props,
				key
			});
		}
		function NativeAssistantSeat({ Inner, owner, preferences }) {
			const { node, groupPart } = owner;
			const { preset, controlScroll, logarithmicFade, motionPreference } = preferences;
			const reduced = useReducedMotion(motionPreference);
			const live = node.data.status === "running";
			const baseScope = (0, react.useMemo)(() => relayScope(node, owner.sessionId), [
				node.key,
				node.anchorSeq,
				node.data.turn,
				node.data.step,
				owner.sessionId
			]);
			const recoveryKey = relayTurnKey(baseScope);
			const part = groupPart === "reasoning" ? "reasoning" : "response";
			const recoveryPosition = [
				baseScope.step,
				baseScope.order,
				groupPart === "reasoning" ? 0 : 1
			];
			const recoveringScope = isBackgroundRecoveryScope(recoveryKey, recoveryPosition);
			const [recoveryEpoch, setRecoveryEpoch] = (0, react.useState)(() => {
				const activeEpoch = streamRelay.recoveryEpoch(recoveryKey);
				return recoveringScope ? activeEpoch ?? 0 : void 0;
			});
			const scope = (0, react.useMemo)(() => ({
				...baseScope,
				recoveryEpoch
			}), [baseScope, recoveryEpoch]);
			const queuedOnMount = streamRelay.recoveryEpoch(recoveryKey) === void 0 && streamRelay.isBlocked(baseScope, part);
			const seenLive = (0, react.useRef)(live || recoveringScope || queuedOnMount);
			if (live || recoveringScope) seenLive.current = true;
			const segments = (0, react.useMemo)(() => assistantTextSegments(node.data.blocks, groupPart), [node.data.blocks, groupPart]);
			const source = projectionCache(segments).source;
			const [recoveryBacklog, setRecoveryBacklog] = (0, react.useState)(() => !reduced && node.data.status !== "interrupted" && recoveringScope && countChars(source) > 1200);
			const recoveryDisclosure = (0, react.useRef)(reduced ? false : recoveringScope || recoveryBacklog);
			if (!reduced && (recoveringScope || recoveryBacklog)) recoveryDisclosure.current = true;
			const root = (0, react.useRef)(null);
			const [collapsedReasoning, setCollapsedReasoning] = (0, react.useState)(() => !preferences.thinkAutoExpand ? node.data.blocks.flatMap((block, index) => block.kind === "reasoning" ? [index] : []) : []);
			const [detailsHidden, setDetailsHidden] = (0, react.useState)(false);
			const disclosureRows = (0, react.useRef)(/* @__PURE__ */ new Map());
			const skipPlan = (0, react.useMemo)(() => {
				const collapsed = new Set(collapsedReasoning);
				const ranges = [];
				const guards = /* @__PURE__ */ new Map();
				let offset = 0;
				segments.segments.forEach((segment, index) => {
					const start = offset;
					offset += countChars(segment);
					const blockIndex = segments.blockIndices[index];
					const block = node.data.blocks[blockIndex];
					const invisibleReasoning = block?.kind === "reasoning" && !hasVisibleReasoning(segment);
					if (detailsHidden || collapsed.has(blockIndex) || invisibleReasoning) {
						ranges.push([start, offset]);
						guards.set(start, {
							blockIndex,
							prefixOnly: invisibleReasoning
						});
					} else if (block?.kind === "reasoning") {
						const hiddenPrefix = reasoningDisplayStart(segment);
						if (hiddenPrefix > 0) {
							ranges.push([start, start + countChars(segment.slice(0, hiddenPrefix))]);
							guards.set(start, {
								blockIndex,
								prefixOnly: true
							});
						}
					}
				});
				return {
					ranges,
					guards
				};
			}, [
				segments,
				collapsedReasoning,
				detailsHidden,
				node.data.blocks
			]);
			const canSkipRange = (0, react.useCallback)((start) => {
				const guard = skipPlan.guards.get(start);
				if (guard?.prefixOnly) return true;
				const element = root.current;
				if (element === null || !element.isConnected) return false;
				if (hiddenAncestor(element)) return true;
				if (guard === void 0 || node.data.blocks[guard.blockIndex]?.kind !== "reasoning") return false;
				const row = disclosureRows.current.get(guard.blockIndex);
				if (row === void 0 || !row.isConnected) return !preferences.thinkAutoExpand;
				return !row.hasAttribute("data-expanded") || hiddenAncestor(row);
			}, [
				skipPlan,
				node.data.blocks,
				preferences.thinkAutoExpand
			]);
			const speed = (0, react.useRef)(35);
			const revealed = (0, react.useRef)(0);
			const scale = (0, react.useRef)(1);
			const presentationKey = JSON.stringify([
				scope.session,
				scope.turn,
				scope.step,
				scope.node,
				part
			]);
			const [restored] = (0, react.useState)(() => assistantProgress.read(presentationKey, source));
			const committed = (0, react.useRef)(restored ?? (seenLive.current ? "" : source));
			const animate = seenLive.current && !reduced && node.data.status !== "interrupted";
			const subscribeTool = (0, react.useCallback)((listener) => live ? streamRelay.subscribeTool(scope, listener) : () => {}, [live, scope]);
			const toolPresent = (0, react.useSyncExternalStore)(subscribeTool, () => live && streamRelay.hasTool(scope), () => false);
			const toolHandoff = !preferences.keepStreamOnToolCall && (toolPresent || node.data.blocks.some((block) => block.kind === "tool-call"));
			const admissionHold = (0, react.useRef)(animate);
			const hold = (0, react.useRef)(false);
			hold.current = admissionHold.current || animate && source !== committed.current && streamRelay.isBlocked(scope, part);
			const smoothed = useSmoothStreamContent(source, {
				enabled: animate,
				backgroundRecovery: preferences.backgroundRecovery,
				recoveryKey: seenLive.current ? recoveryKey : void 0,
				recoveryPosition,
				replayOnEnable: false,
				initialDisplayedContent: restored,
				resumeOnMount: restored !== void 0,
				skipRanges: skipPlan.ranges,
				canSkipRange,
				onRecoveryBacklogChange: setRecoveryBacklog,
				initialRecoveryEpoch: recoveryEpoch,
				onRecoveryBatchChange: (epoch) => setRecoveryEpoch(epoch === void 0 || isBackgroundRecoveryScope(recoveryKey, recoveryPosition) || streamRelay.recoveryEpoch(recoveryKey) !== void 0 ? epoch : void 0),
				inputComplete: !live || toolPresent || node.data.blocks.some((block) => block.kind === "tool-call") || groupPart === "reasoning" && node.data.blocks.at(-1)?.kind !== "reasoning",
				shouldHoldBack: () => hold.current,
				preset,
				speedCpsRef: speed,
				revealedCharsRef: revealed,
				revealScaleRef: scale,
				onRevealCommit: () => {
					notifyFollowCommit(root.current);
				}
			});
			const shown = animate && !toolHandoff ? smoothed : source;
			const pending = animate && !toolHandoff && shown !== source;
			const sourceOrder = blockSourceOrder(node, groupPart, shown);
			const activeScope = (0, react.useMemo)(() => sourceOrder === void 0 ? scope : {
				...scope,
				sourceOrder
			}, [scope, sourceOrder]);
			const admitted = usePresentationAdmission(activeScope, part, animate, pending, root, restored !== void 0 && restored !== "", presentationOwnerKey(baseScope, part));
			admissionHold.current = !admitted;
			const subscribeBlocked = (0, react.useCallback)((listener) => pending ? streamRelay.subscribeBlocked(activeScope, part, listener) : () => {}, [
				pending,
				activeScope,
				part
			]);
			const relayBlocked = (0, react.useSyncExternalStore)(subscribeBlocked, () => pending && streamRelay.isBlocked(activeScope, part), () => false);
			const blocked = !admitted || relayBlocked;
			hold.current = blocked;
			const ownsLiveTail = live && !toolPresent && !node.data.blocks.some((block) => block.kind === "tool-call") && (groupPart !== "reasoning" || node.data.blocks.at(-1)?.kind === "reasoning");
			const typing = !toolHandoff && (ownsLiveTail || pending);
			(0, react.useLayoutEffect)(() => {
				committed.current = shown;
				if (seenLive.current) assistantProgress.remember(presentationKey, shown);
			}, [presentationKey, shown]);
			const lease = (0, react.useRef)(null);
			(0, react.useLayoutEffect)(() => {
				if (!pending || !admitted) return;
				const token = streamRelay.acquire(activeScope, part, true);
				lease.current = token;
				return () => {
					streamRelay.release(token);
					if (lease.current === token) lease.current = null;
				};
			}, [
				activeScope,
				part,
				pending,
				admitted
			]);
			const blocks = (0, react.useMemo)(() => animate && !toolHandoff ? projectAssistantPresentation(node.data.blocks, segments, shown) : node.data.blocks, [
				animate,
				toolHandoff,
				node.data.blocks,
				segments,
				shown
			]);
			useCollapsedReasoning(root, blocks, animate, disclosureRows, setCollapsedReasoning, setDetailsHidden);
			const reasoningPending = blocks.some((block, index) => block.kind === "reasoning" && block.text !== node.data.blocks[index]?.text);
			const reasoningTyping = !toolHandoff && (reasoningPending || live && !toolPresent && node.data.blocks.at(-1)?.kind === "reasoning");
			const useDisclosure = useAutomaticDisclosure(owner.useDisclosure, preferences.thinkAutoExpand && !recoveryDisclosure.current, reasoningTyping && !blocked);
			const adapted = (0, react.useMemo)(() => ({
				...owner,
				useDisclosure,
				node: {
					...node,
					data: {
						...node.data,
						blocks,
						status: typing ? "running" : live && !ownsLiveTail ? "settled" : node.data.status
					}
				}
			}), [
				owner,
				node,
				blocks,
				useDisclosure,
				typing,
				live,
				ownsLiveTail
			]);
			useLogarithmicFade(root, logarithmicFade && !reduced, typing, speed);
			(0, react.useLayoutEffect)(() => {
				const row = root.current?.closest("[data-chat-flow-key]");
				if (row === void 0 || row === null) return;
				if (typing) row.removeAttribute("data-smooth-stream-settled");
				else row.setAttribute("data-smooth-stream-settled", "true");
				return () => {
					row.removeAttribute("data-smooth-stream-settled");
				};
			}, [typing]);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				ref: root,
				"data-smooth-stream-phase": blocked ? "waiting" : typing ? "typing" : "settled",
				"data-smooth-stream-typing": !blocked && typing ? "true" : void 0,
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(FollowHost, {
					active: !blocked && typing && !reduced,
					speedCpsRef: speed,
					revealedCharsRef: revealed,
					revealScaleRef: scale,
					controlScroll,
					predictive: ownsLiveTail,
					children: admitted ? (0, react.createElement)(Inner, adapted) : null
				})
			});
		}
		//#endregion
		//#region src/client/rendererAdapter.ts
		const CHAT_NODE_SLOT$1 = "conversation.chat.node";
		/** Decorate components without stealing their owned child Slots or injected services. */
		function installRendererAdapter(ctx, decorate) {
			const originals = /* @__PURE__ */ new Map();
			const listeners = /* @__PURE__ */ new Set();
			let revision = 0;
			let disposed = false;
			let lastSlotVersion = ctx.slots.getVersion(CHAT_NODE_SLOT$1);
			const subscribe = (listener) => {
				if (disposed) return () => {};
				listeners.add(listener);
				const off = ctx.slots.subscribe(CHAT_NODE_SLOT$1, listener);
				return () => {
					off();
					listeners.delete(listener);
				};
			};
			const getSnapshot = () => {
				if (!disposed) lastSlotVersion = ctx.slots.getVersion(CHAT_NODE_SLOT$1);
				return `${lastSlotVersion}:${revision}:${disposed}`;
			};
			const apply = () => {
				if (disposed) return;
				for (const entry of ctx.slots.entries(CHAT_NODE_SLOT$1)) {
					const key = entry.options.key;
					if (key === void 0) continue;
					if (originals.get(entry)?.wrapped === entry.component) continue;
					const original = entry.component;
					const decorated = decorate(key, original);
					if (decorated === original) continue;
					const wrapped = function RendererAdapterEntry(props) {
						(0, react.useSyncExternalStore)(subscribe, getSnapshot, getSnapshot);
						return (0, react.createElement)(disposed ? original : decorated, props);
					};
					originals.set(entry, {
						original,
						wrapped
					});
					entry.component = wrapped;
				}
			};
			const off = ctx.slots.subscribe(CHAT_NODE_SLOT$1, apply);
			apply();
			return () => {
				if (disposed) return;
				disposed = true;
				revision += 1;
				for (const listener of [...listeners]) listener();
				off();
				for (const [entry, record] of originals) if (entry.component === record.wrapped) entry.component = record.original;
				originals.clear();
			};
		}
		//#endregion
		//#region src/client/ellipsisTail.ts
		const UNSAFE_DIRECTION = /[\n\r\u0590-\u08ff\u200e-\u200f\u202a-\u202e\u2066-\u2069\ufb1d-\ufdff\ufe70-\ufeff\u{10800}-\u{10fff}\u{1e800}-\u{1efff}]/u;
		const BLOCK_CONTAINERS = /* @__PURE__ */ new Set([
			"block",
			"inline-block",
			"flow-root"
		]);
		function presented(element) {
			let current = element;
			while (current !== null) {
				const style = getComputedStyle(current);
				if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" || style.contentVisibility === "hidden" || style.opacity === "0") return false;
				current = current.parentElement;
			}
			return true;
		}
		/** Detect a hidden LTR tail only after the animated prefix itself reaches an ellipsis. */
		function createEllipsisTailProbe(root) {
			const range = (() => {
				try {
					return typeof root.ownerDocument.createRange === "function" ? root.ownerDocument.createRange() : null;
				} catch {
					return null;
				}
			})();
			if (range === null || typeof range.getBoundingClientRect !== "function" || typeof range.getClientRects !== "function") return () => false;
			return (node, source) => {
				if (node.data === "" || node.data.length >= source.length || !node.isConnected || !root.contains(node)) return false;
				const parent = node.parentElement;
				if (parent === null) return false;
				const textStyle = getComputedStyle(parent);
				if (textStyle.whiteSpace !== "nowrap" || textStyle.direction === "rtl" || textStyle.visibility === "hidden" || textStyle.visibility === "collapse" || textStyle.textAlign !== "" && ![
					"left",
					"start",
					"initial"
				].includes(textStyle.textAlign) || textStyle.unicodeBidi !== "" && textStyle.unicodeBidi !== "normal" || textStyle.writingMode !== "" && textStyle.writingMode !== "horizontal-tb" || UNSAFE_DIRECTION.test(source)) return false;
				let element = parent;
				while (element !== null && root.contains(element)) {
					const style = element === parent ? textStyle : getComputedStyle(element);
					if (style.position === "absolute" || style.position === "fixed" || style.transform !== "" && style.transform !== "none") return false;
					const ellipsis = style.textOverflow === "ellipsis" && style.whiteSpace === "nowrap" && (style.overflowX === "hidden" || style.overflowX === "clip") && style.direction !== "rtl" && BLOCK_CONTAINERS.has(style.display) && element.scrollLeft === 0;
					if (ellipsis) try {
						const clip = element.getBoundingClientRect();
						if (Number.isFinite(clip.left) && Number.isFinite(clip.right) && Number.isFinite(clip.width) && Number.isFinite(clip.height) && clip.width > 0 && clip.height > 0 && element.clientWidth > 0 && element.scrollWidth > element.clientWidth) {
							range.selectNodeContents(node);
							const prefix = range.getBoundingClientRect();
							const lines = Array.from(range.getClientRects());
							const first = lines[0];
							if (first !== void 0 && lines.every((line) => Number.isFinite(line.top) && Number.isFinite(line.bottom) && Math.abs(line.top - first.top) <= 1 && Math.abs(line.bottom - first.bottom) <= 1) && Number.isFinite(prefix.left) && Number.isFinite(prefix.right) && Number.isFinite(prefix.width) && Number.isFinite(prefix.height) && prefix.width > 0 && prefix.height > 0 && prefix.left < clip.right && prefix.right > clip.left && prefix.right > clip.right + 1 && presented(parent)) return true;
						}
					} catch {
						return false;
					}
					if (style.display === "flex" || style.display === "inline-flex" || style.display === "grid" || style.display === "inline-grid" || BLOCK_CONTAINERS.has(style.display) && !ellipsis) return false;
					if (element === root) break;
					element = element.parentElement;
				}
				return false;
			};
		}
		//#endregion
		//#region src/client/useProgressiveDomText.ts
		/**
		* Progressive text reveal for opaque Agent renderers.
		*
		* Slot renderers own arbitrary React trees, so the generic integration cannot
		* clone or classify their business components. This hook leaves that tree and
		* all of its event handlers in place, and only paces visible Text node data
		* while the row belongs to the live Agent turn. No clip, mask, overlay, or
		* duplicate accessibility tree is introduced.
		*/
		/** Last presented text per root, retained across follow lifecycle flips. */
		const ledgerByRoot = /* @__PURE__ */ new WeakMap();
		const SKIP_TEXT_SELECTOR = [
			"[aria-hidden=\"true\"]",
			"[aria-live]",
			"[contenteditable=\"true\"]",
			"script",
			"style",
			"textarea"
		].join(",");
		function excludedElement(element) {
			return element.matches(SKIP_TEXT_SELECTOR);
		}
		/** DSH ToolRow mounts its DisclosureRow body on open; nested ToolDetails also
		* use native details. Neither an aria-hidden icon nor a collapsed summary is
		* evidence that the whole Tool call should stop updating. */
		const cssHidden = /* @__PURE__ */ new WeakSet();
		const measuredClasses = /* @__PURE__ */ new WeakMap();
		function hiddenElement(element) {
			if (element.hasAttribute("hidden")) return true;
			if (element instanceof HTMLElement && (element.style.display === "none" || element.style.contentVisibility === "hidden" || !element.hasAttribute("data-chat-call-id") && element.style.visibility === "hidden")) return true;
			const classes = element.getAttribute("class") ?? "";
			if (classes === "" && measuredClasses.has(element)) {
				measuredClasses.delete(element);
				cssHidden.delete(element);
			} else if (classes !== "" && measuredClasses.get(element) !== classes) {
				measuredClasses.set(element, classes);
				const style = getComputedStyle(element);
				if (style.display === "none" || style.contentVisibility === "hidden") cssHidden.add(element);
				else cssHidden.delete(element);
			}
			if (cssHidden.has(element)) return true;
			const parent = element.parentElement;
			return parent instanceof HTMLDetailsElement && !parent.open && element !== parent.querySelector(":scope > summary");
		}
		function hiddenOutside(root) {
			let element = root.parentElement;
			while (element !== null) {
				if (hiddenElement(element)) return true;
				element = element.parentElement;
			}
			return false;
		}
		function visibleWithin(node, root) {
			if (node.nodeType === Node.TEXT_NODE && node.parentElement instanceof HTMLDetailsElement && !node.parentElement.open) return false;
			let element = node instanceof Element ? node : node.parentElement;
			while (element !== null) {
				if (excludedElement(element) || hiddenElement(element)) return false;
				if (element === root) return !hiddenOutside(root);
				element = element.parentElement;
			}
			return false;
		}
		function revealable(node, root) {
			return node.data.trim() !== "" && visibleWithin(node, root);
		}
		function commonPrefix(left, right) {
			const limit = Math.min(left.length, right.length);
			let index = 0;
			while (index < limit && left[index] === right[index]) index += 1;
			return index;
		}
		/**
		* Pace text inside a renderer whose React component is intentionally opaque.
		* Initial content is revealed only for a genuinely new row; later mutations
		* stay paced until `enabled` becomes false, at which point the full renderer
		* content is restored synchronously before paint.
		*/
		function useProgressiveDomText(rootRef, enabled, revealInitial, speedCpsRef, onSettled, onPendingChange, paused = false, backgroundRecovery = "catch-up", recoveryKey, recoveryPosition, observeChanges = enabled, onRecoveryBatchChange, initialRecoveryEpoch, deferredSource) {
			const deferredRef = (0, react.useRef)(deferredSource);
			deferredRef.current = deferredSource;
			const callbacks = (0, react.useRef)({
				onSettled,
				onPendingChange,
				onRecoveryBatchChange
			});
			callbacks.current = {
				onSettled,
				onPendingChange,
				onRecoveryBatchChange
			};
			const pausedRef = (0, react.useRef)(paused);
			pausedRef.current = paused;
			const resume = (0, react.useRef)(null);
			const wake = (0, react.useRef)(null);
			const suspend = (0, react.useRef)(null);
			const recovery = useBackgroundRecovery(backgroundRecovery, () => suspend.current?.(), () => resume.current?.(), recoveryKey, recoveryPosition, false, enabled || observeChanges);
			const recoveryRef = (0, react.useRef)(recovery);
			recoveryRef.current = recovery;
			const hasDeferredSource = deferredSource?.hasPending() === true;
			(0, react.useLayoutEffect)(() => {
				if (!paused) wake.current?.();
			}, [paused, hasDeferredSource]);
			(0, react.useLayoutEffect)(() => {
				const root = rootRef.current;
				if (root === null || typeof document === "undefined") return;
				let records = ledgerByRoot.get(root);
				if (!enabled && records === void 0 && !observeChanges) {
					callbacks.current.onPendingChange?.(false);
					return;
				}
				if (records === void 0) {
					records = /* @__PURE__ */ new Map();
					ledgerByRoot.set(root, records);
				}
				const callRows = /* @__PURE__ */ new Set();
				const newlyRegisteredCalls = /* @__PURE__ */ new Set();
				let orderedCalls = [];
				let callOrderDirty = true;
				const registerCall = (element) => {
					if (callRows.has(element)) return;
					callRows.add(element);
					newlyRegisteredCalls.add(element);
					callOrderDirty = true;
				};
				const forEachText = (from, callback) => {
					if (!visibleWithin(from, root)) return;
					if (from instanceof HTMLElement && from.hasAttribute("data-chat-call-id")) registerCall(from);
					if (from.nodeType === Node.TEXT_NODE) {
						callback(from);
						return;
					}
					const walker = document.createTreeWalker(from, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, { acceptNode: (node) => {
						if (!(node instanceof Element)) return NodeFilter.FILTER_ACCEPT;
						if (excludedElement(node) || hiddenElement(node)) return NodeFilter.FILTER_REJECT;
						if (node instanceof HTMLElement && node.hasAttribute("data-chat-call-id")) registerCall(node);
						return NodeFilter.FILTER_SKIP;
					} });
					let current = walker.nextNode();
					while (current !== null) {
						callback(current);
						current = walker.nextNode();
					}
				};
				const textSlots = /* @__PURE__ */ new WeakMap();
				const indexCallText = (call) => {
					const callId = call.getAttribute("data-chat-call-id");
					if (!callId || !visibleWithin(call, root)) return [];
					const texts = [];
					const walker = document.createTreeWalker(call, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, { acceptNode: (node) => {
						if (!(node instanceof Element)) return NodeFilter.FILTER_ACCEPT;
						if (node.hasAttribute("data-chat-call-id") || excludedElement(node) || hiddenElement(node)) return NodeFilter.FILTER_REJECT;
						return NodeFilter.FILTER_SKIP;
					} });
					let node = walker.nextNode();
					while (node !== null) {
						const text = node;
						textSlots.set(text, {
							callId,
							index: texts.length
						});
						texts.push(text);
						node = walker.nextNode();
					}
					return texts;
				};
				const textSlot = (text) => {
					const known = textSlots.get(text);
					if (known !== void 0) return known;
					const call = text.parentElement?.closest("[data-chat-call-id]");
					if (call === null || call === void 0) return void 0;
					indexCallText(call);
					return textSlots.get(text);
				};
				const rememberText = (text, record) => {
					records.set(text, record);
					const saved = deferredRef.current?.presentations;
					const slot = saved === void 0 ? void 0 : textSlot(text);
					if (saved !== void 0 && slot !== void 0) {
						const values = saved.get(slot.callId) ?? [];
						values[slot.index] = record.chars.slice(0, record.shown).join("");
						saved.set(slot.callId, values);
					}
				};
				const restoreText = (text) => {
					const saved = deferredRef.current?.presentations;
					const slot = saved === void 0 ? void 0 : textSlot(text);
					const prefix = slot === void 0 ? void 0 : saved?.get(slot.callId)?.[slot.index];
					if (prefix === void 0) return void 0;
					const chars = [...prefix];
					return {
						chars,
						full: prefix,
						shown: chars.length
					};
				};
				const settle = (text) => {
					if (!revealable(text, root)) return;
					const chars = [...text.data];
					rememberText(text, {
						chars,
						full: text.data,
						shown: chars.length
					});
				};
				const snapshotVisible = () => {
					const current = /* @__PURE__ */ new Set();
					forEachText(root, (text) => {
						if (!revealable(text, root)) return;
						current.add(text);
						settle(text);
					});
					for (const text of records.keys()) if (!current.has(text)) records.delete(text);
				};
				if (!enabled) {
					callbacks.current.onPendingChange?.(false);
					snapshotVisible();
					if (!observeChanges) return;
					const observer = typeof MutationObserver === "undefined" ? null : new MutationObserver((mutations) => {
						for (const mutation of mutations) {
							if (!visibleWithin(mutation.target, root)) continue;
							if (mutation.type === "characterData") settle(mutation.target);
							else for (const added of mutation.addedNodes) forEachText(added, settle);
						}
					});
					observer?.observe(root, {
						childList: true,
						characterData: true,
						subtree: true
					});
					return () => {
						observer?.disconnect();
					};
				}
				const pending = /* @__PURE__ */ new Set();
				let structuralPending = false;
				let activeBatch = null;
				let batchEpoch = initialRecoveryEpoch;
				let nextBatchEpoch;
				const clearBatch = (preserveNextEpoch = false) => {
					const hadBatch = activeBatch !== null || batchEpoch !== void 0 || !preserveNextEpoch && nextBatchEpoch !== void 0;
					if (preserveNextEpoch && batchEpoch !== void 0) nextBatchEpoch = batchEpoch + 1;
					activeBatch = null;
					batchEpoch = void 0;
					if (!preserveNextEpoch) nextBatchEpoch = void 0;
					if (hadBatch) callbacks.current.onRecoveryBatchChange?.(void 0);
				};
				const presentedCalls = /* @__PURE__ */ new Set();
				const freezeBatch = (nextEpoch) => {
					activeBatch = /* @__PURE__ */ new Map();
					for (const node of pending) {
						const record = records.get(node);
						if (record !== void 0 && record.shown < record.chars.length) activeBatch.set(node, record.chars.length);
					}
					if (activeBatch.size > 0 || deferredRef.current?.hasPending() === true) {
						const activeEpoch = streamRelay.recoveryEpoch(recoveryKey ?? "");
						const receivingEpoch = activeEpoch === void 0 || nextBatchEpoch === void 0 ? void 0 : Math.max(nextBatchEpoch, activeEpoch + 1);
						batchEpoch = nextEpoch ?? receivingEpoch ?? batchEpoch ?? activeEpoch ?? 0;
						nextBatchEpoch = void 0;
						deferredRef.current?.freeze(batchEpoch);
						callbacks.current.onRecoveryBatchChange?.(batchEpoch);
					}
				};
				const advanceBatch = () => {
					if (activeBatch === null) return;
					for (const [node, end] of activeBatch) {
						const record = records.get(node);
						if (!pending.has(node) || record === void 0 || record.shown >= end) activeBatch.delete(node);
					}
					if (activeBatch.size === 0 && pending.size > 0 && deferredRef.current?.hasPending(batchEpoch) !== true) {
						const nextEpoch = batchEpoch === void 0 ? void 0 : batchEpoch + 1;
						activeBatch = null;
						batchEpoch = void 0;
						freezeBatch(nextEpoch);
					}
				};
				const concealed = /* @__PURE__ */ new Map();
				const syncCallVisibility = () => {
					if (deferredRef.current !== void 0 || callRows.size === 0) return;
					if (callOrderDirty) {
						orderedCalls = [...callRows].sort((left, right) => left === right ? 0 : (left.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0 ? -1 : 1);
						callOrderDirty = false;
					}
					const pendingCalls = /* @__PURE__ */ new Set();
					for (const text of pending) {
						const record = records.get(text);
						if (activeBatch !== null && (record === void 0 || record.shown >= (activeBatch.get(text) ?? record.shown))) continue;
						const call = text.parentElement?.closest("[data-chat-call-id]");
						if (call) pendingCalls.add(call);
					}
					let waitingForEarlier = false;
					for (const call of orderedCalls) {
						if (!root.contains(call) || !visibleWithin(call, root)) {
							const previous = concealed.get(call);
							if (previous !== void 0) {
								if (previous.visibility) call.style.setProperty("visibility", previous.visibility, previous.priority);
								else call.style.removeProperty("visibility");
								concealed.delete(call);
							}
							callRows.delete(call);
							callOrderDirty = true;
							continue;
						}
						const hasPending = pendingCalls.has(call);
						const holdVisibility = activeBatch !== null && presentedCalls.has(call);
						const hide = (pausedRef.current || waitingForEarlier) && !holdVisibility;
						if (activeBatch !== null && !hide) presentedCalls.add(call);
						if (hide && !concealed.has(call)) {
							concealed.set(call, {
								visibility: call.style.getPropertyValue("visibility"),
								priority: call.style.getPropertyPriority("visibility")
							});
							call.style.setProperty("visibility", "hidden");
						} else if (!hide && concealed.has(call)) {
							const previous = concealed.get(call);
							if (previous.visibility) call.style.setProperty("visibility", previous.visibility, previous.priority);
							else call.style.removeProperty("visibility");
							concealed.delete(call);
						}
						if (hasPending) waitingForEarlier = true;
					}
				};
				const internalWrites = /* @__PURE__ */ new WeakMap();
				let rafId = 0;
				let lastFrame = null;
				let debt = 0;
				let stopped = false;
				let announcedSettled = false;
				const streamId = `dom-${Math.random().toString(36).slice(2)}`;
				const isEllipsisTailClipped = createEllipsisTailProbe(root);
				const announceSettled = (advanceDeferred = false) => {
					const deferred = deferredRef.current;
					if (structuralPending && !advanceDeferred) {
						callbacks.current.onPendingChange?.(true);
						scheduleFrame();
						return;
					}
					if (deferred?.hasPending() === true) {
						if (advanceDeferred && !pausedRef.current && !recoveryRef.current.hidden()) {
							const nextEpoch = deferred.onDrained(batchEpoch);
							if (nextEpoch !== void 0 && nextEpoch !== batchEpoch) {
								activeBatch = null;
								batchEpoch = void 0;
								freezeBatch(nextEpoch);
							}
						}
						callbacks.current.onPendingChange?.(true);
						scheduleFrame();
						return;
					}
					clearBatch(streamRelay.recoveryEpoch(recoveryKey ?? "") !== void 0);
					presentedCalls.clear();
					lastFrame = null;
					debt = 0;
					speedCpsRef.current = 35;
					debugRuntime.reportStream(streamId, null);
					recoveryRef.current.finish();
					if (announcedSettled) return;
					announcedSettled = true;
					callbacks.current.onPendingChange?.(false);
					callbacks.current.onSettled?.();
				};
				const write = (node, value) => {
					if (node.data === value) return;
					internalWrites.set(node, value);
					node.data = value;
				};
				const enqueue = (node, full, preserve) => {
					if (!revealable(node, root)) {
						pending.delete(node);
						records.delete(node);
						internalWrites.delete(node);
						return;
					}
					preserve ??= restoreText(node);
					const chars = [...full];
					const prefix = preserve === void 0 ? 0 : commonPrefix(preserve.chars, chars);
					const preserved = preserve === void 0 ? 0 : Math.min(preserve.shown, prefix);
					const boundary = activeBatch?.get(node);
					if (boundary !== void 0 && preserve !== void 0 && !full.startsWith(preserve.full)) activeBatch.set(node, Math.min(boundary, prefix));
					const record = {
						chars,
						full,
						shown: preserved
					};
					const call = node.parentElement?.closest("[data-chat-call-id]");
					const callId = call?.getAttribute("data-chat-call-id");
					if (activeBatch !== null && batchEpoch !== void 0 && call !== null && call !== void 0 && callId !== null && callId !== void 0 && (newlyRegisteredCalls.has(call) && deferredRef.current?.epochForCall(callId) === batchEpoch || deferredRef.current?.adoptingEpoch?.(callId) === batchEpoch)) activeBatch.set(node, chars.length);
					rememberText(node, record);
					if (preserved < chars.length) {
						pending.add(node);
						announcedSettled = false;
						callbacks.current.onPendingChange?.(true);
					} else pending.delete(node);
					write(node, chars.slice(0, preserved).join(""));
				};
				const visit = (from, reveal) => {
					forEachText(from, (text) => {
						if (!revealable(text, root)) return;
						if (reveal) {
							const record = records.get(text);
							if (record !== void 0 && text.data === record.chars.slice(0, record.shown).join("")) return;
							enqueue(text, text.data, record);
							return;
						}
						settle(text);
					});
					if (newlyRegisteredCalls.size > 0 && deferredRef.current !== void 0) structuralPending = true;
					newlyRegisteredCalls.clear();
				};
				const forget = (from) => {
					for (const [text] of records) {
						if (!from.contains(text) || root.contains(text)) continue;
						records.delete(text);
						pending.delete(text);
					}
				};
				const scheduleFrame = () => {
					const playback = recoveryRef.current;
					const hasDeferred = deferredRef.current?.hasPending() === true;
					if (!playback.hidden() && activeBatch === null && (pending.size > 0 || hasDeferred) && playback.mode() !== "latest" && (playback.recovering() || streamRelay.recoveryEpoch(recoveryKey ?? "") !== void 0)) freezeBatch();
					syncCallVisibility();
					if (stopped || pausedRef.current || recoveryRef.current.hidden() || pending.size === 0 && !hasDeferred && !structuralPending || rafId !== 0) return;
					rafId = requestAnimationFrame(frame);
				};
				const frame = (now) => {
					const frameStartedAt = performance.now();
					rafId = 0;
					if (stopped || recoveryRef.current.hidden()) {
						lastFrame = null;
						return;
					}
					const mutations = observer?.takeRecords();
					if (mutations !== void 0 && mutations.length > 0) processMutations(mutations);
					structuralPending = false;
					if (pending.size === 0) {
						announceSettled(true);
						return;
					}
					if (pausedRef.current) {
						lastFrame = null;
						return;
					}
					announcedSettled = false;
					if (lastFrame === null) {
						lastFrame = now;
						scheduleFrame();
						return;
					}
					const elapsed = Math.max(0, now - lastFrame);
					const playback = recoveryRef.current;
					playback.detectGap(elapsed);
					const catchingUp = playback.recovering() && playback.mode() === "catch-up";
					if (playback.mode() === "latest" && activeBatch !== null) clearBatch();
					const activeRecoveryEpoch = streamRelay.recoveryEpoch(recoveryKey ?? "");
					if (activeBatch === null && pending.size > 0 && playback.mode() !== "latest" && (playback.recovering() || activeRecoveryEpoch !== void 0)) freezeBatch();
					if (playback.recovering()) debugRuntime.recordDiagnostic("raf", {
						event: "text-recovery-frame",
						gapMs: elapsed,
						mode: playback.mode()
					});
					const candidates = [];
					let backlog = 0;
					for (const node of pending) {
						let record = records.get(node);
						if (record === void 0 || !node.isConnected || !visibleWithin(node, root)) {
							if (record !== void 0 && node.isConnected && root.contains(node)) {
								const controlled = record.chars.slice(0, record.shown).join("");
								if (node.data === controlled) write(node, record.full);
							}
							pending.delete(node);
							records.delete(node);
							continue;
						}
						if (node.data !== record.chars.slice(0, record.shown).join("")) {
							enqueue(node, node.data, record);
							record = records.get(node);
							if (record === void 0 || !pending.has(node)) continue;
						}
						candidates.push({
							node,
							record,
							end: record.chars.length
						});
					}
					advanceBatch();
					const orderedPending = candidates.filter((item) => {
						item.end = activeBatch === null ? item.record.chars.length : Math.min(item.record.chars.length, activeBatch.get(item.node) ?? item.record.shown);
						backlog += Math.max(0, item.end - item.record.shown);
						return item.end > item.record.shown;
					});
					if (orderedPending.length === 0 && deferredRef.current?.hasPending(batchEpoch) === true) {
						announceSettled(true);
						return;
					}
					const activeBatchChars = activeBatch === null ? void 0 : backlog;
					const incomingBatchChars = activeBatch === null ? void 0 : candidates.reduce((sum, item) => sum + item.record.chars.length - item.record.shown, 0) - backlog;
					orderedPending.sort((left, right) => (left.node.compareDocumentPosition(right.node) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0 ? -1 : 1);
					let clippedCount = 0;
					for (const { node, record, end } of orderedPending) {
						if (record.shown === 0 || node.data !== record.chars.slice(0, record.shown).join("") || !isEllipsisTailClipped(node, record.chars.slice(0, end).join(""))) break;
						clippedCount++;
					}
					for (let index = 0; index < clippedCount; index++) {
						const { node, record, end } = orderedPending[index];
						backlog -= end - record.shown;
						write(node, record.chars.slice(0, end).join(""));
						rememberText(node, {
							...record,
							shown: end
						});
						if (end >= record.chars.length) pending.delete(node);
					}
					if (clippedCount > 0) orderedPending.splice(0, clippedCount);
					if (playback.recovering() && playback.mode() === "latest") {
						for (const { node, record } of orderedPending) {
							write(node, record.full);
							rememberText(node, {
								...record,
								shown: record.chars.length
							});
						}
						pending.clear();
						syncCallVisibility();
						announceSettled();
						playback.finish();
						return;
					}
					lastFrame = now;
					const tuning = debugRuntime.activeTuning();
					const step = computeAdaptiveQueueStep(backlog, Math.min(elapsed, 32), debt, 1, tuning, activeBatch !== null);
					const budget = catchingUp ? recoveryBudget(backlog, elapsed, debt, tuning, true) : {
						chars: step.revealChars,
						debt: step.debt
					};
					debt = budget.debt;
					speedCpsRef.current = catchingUp ? budget.chars * 1e3 / Math.max(1, elapsed) : step.speedCps;
					let remaining = budget.chars;
					for (const { node, record, end } of orderedPending) {
						if (remaining <= 0) break;
						const amount = Math.min(remaining, end - record.shown);
						const shown = record.shown + amount;
						const next = {
							...record,
							shown
						};
						rememberText(node, next);
						write(node, next.chars.slice(0, shown).join(""));
						remaining -= amount;
						if (shown >= next.chars.length) pending.delete(node);
					}
					let targetChars = 0;
					let displayedChars = 0;
					let nextBacklog = 0;
					for (const [node, record] of records) {
						if (!node.isConnected) {
							records.delete(node);
							pending.delete(node);
							continue;
						}
						targetChars += record.chars.length;
						displayedChars += record.shown;
						if (pending.has(node)) nextBacklog += record.chars.length - record.shown;
					}
					debugRuntime.recordDiagnostic("text-queue", {
						backlogChars: nextBacklog,
						activeBatchChars,
						incomingBatchChars,
						recoveryEpoch: batchEpoch,
						pendingNodes: pending.size,
						records: records.size,
						mode: catchingUp ? "catch-up" : playback.recovering() ? playback.mode() : "normal"
					});
					debugRuntime.recordDiagnosticFrame(streamId, now, performance.now() - frameStartedAt);
					debugRuntime.reportStream(streamId, {
						backlog: nextBacklog,
						speedCps: speedCpsRef.current,
						targetChars,
						displayedChars,
						active: pending.size > 0
					});
					advanceBatch();
					syncCallVisibility();
					if (pending.size === 0) announceSettled(true);
					else if (activeBatch?.size === 0 && deferredRef.current?.hasPending(batchEpoch) === true) announceSettled(true);
					else scheduleFrame();
				};
				wake.current = () => {
					announcedSettled = false;
					structuralPending = true;
					scheduleFrame();
				};
				resume.current = () => {
					if (recoveryRef.current.recovering() && recoveryRef.current.mode() !== "latest" && activeBatch === null) {
						const mutations = observer?.takeRecords();
						if (mutations !== void 0 && mutations.length > 0) processMutations(mutations);
						if (pending.size > 0) freezeBatch();
						else if (recoveryRef.current.mode() !== "latest") {
							const activeEpoch = streamRelay.recoveryEpoch(recoveryKey ?? "");
							if (activeEpoch !== void 0) nextBatchEpoch = activeEpoch + 1;
						}
					}
					if (pending.size === 0 && rafId === 0 && !stopped && !recoveryRef.current.hidden()) rafId = requestAnimationFrame(frame);
					else scheduleFrame();
				};
				suspend.current = () => {
					cancelAnimationFrame(rafId);
					rafId = 0;
					lastFrame = null;
					debt = 0;
					clearBatch();
					for (const call of callRows) if (!concealed.has(call)) presentedCalls.add(call);
				};
				visit(root, revealInitial);
				const releaseSubtree = (from) => {
					for (const [node, record] of records) {
						if (!from.contains(node)) continue;
						const controlled = record.chars.slice(0, record.shown).join("");
						if (node.data === controlled) write(node, record.full);
						records.delete(node);
						pending.delete(node);
					}
				};
				const isOpenedBody = (node) => node instanceof Element && node.closest("[data-tool]") !== null && (node.matches("[data-tool-body], [data-disclosure-body], [class*=\"_bodyWrap\"]") || node.id !== "" && [...node.parentElement?.querySelectorAll("[data-disclosure-header] [aria-controls][aria-expanded=\"true\"]") ?? []].some((control) => control.getAttribute("aria-controls")?.split(/\s+/).includes(node.id)));
				const processMutations = (mutations) => {
					const presentations = deferredRef.current?.presentations;
					const changedCalls = /* @__PURE__ */ new Map();
					if (presentations !== void 0) for (const mutation of mutations) {
						if (mutation.type !== "childList") continue;
						const call = (mutation.target instanceof Element ? mutation.target : mutation.target.parentElement)?.closest("[data-chat-call-id]");
						if (call !== null && call !== void 0 && !changedCalls.has(call)) changedCalls.set(call, indexCallText(call));
					}
					const snapshots = /* @__PURE__ */ new Set();
					for (const mutation of mutations) {
						if (mutation.type !== "attributes") continue;
						const target = mutation.target;
						const attribute = mutation.attributeName;
						if (target !== root && target.parentElement !== null && !visibleWithin(target.parentElement, root)) continue;
						const previouslyHidden = cssHidden.has(target) || attribute === "hidden" && mutation.oldValue !== null || attribute === "style" && (/(?:display\s*:\s*none|content-visibility\s*:\s*hidden)/i.test(mutation.oldValue ?? "") || !target.hasAttribute("data-chat-call-id") && /(?:^|;)\s*visibility\s*:\s*hidden/i.test(mutation.oldValue ?? ""));
						if (attribute === "style" || attribute === "class") {
							const style = getComputedStyle(target);
							if (style.display === "none" || style.contentVisibility === "hidden") cssHidden.add(target);
							else cssHidden.delete(target);
						}
						const nowHidden = hiddenElement(target);
						if (attribute !== "open" && previouslyHidden === nowHidden) continue;
						releaseSubtree(target);
						if (visibleWithin(target, root)) snapshots.add(target);
					}
					const processedTexts = /* @__PURE__ */ new Set();
					for (const mutation of mutations) {
						if (mutation.type === "attributes" || !visibleWithin(mutation.target, root)) continue;
						if ([...snapshots].some((snapshot) => snapshot.contains(mutation.target))) continue;
						if (mutation.type === "characterData") {
							const node = mutation.target;
							if (processedTexts.has(node)) continue;
							processedTexts.add(node);
							if (internalWrites.get(node) === node.data) {
								internalWrites.delete(node);
								continue;
							}
							enqueue(node, node.data, records.get(node));
							continue;
						}
						callOrderDirty = true;
						for (const removed of mutation.removedNodes) forget(removed);
						for (const added of mutation.addedNodes) if (isOpenedBody(added)) snapshots.add(added);
						else visit(added, true);
					}
					for (const snapshot of snapshots) {
						if ([...snapshots].some((other) => other !== snapshot && other.contains(snapshot))) continue;
						visit(snapshot, false);
					}
					if (presentations !== void 0) for (const [call, texts] of changedCalls) {
						const callId = call.getAttribute("data-chat-call-id");
						if (!callId || !root.contains(call)) continue;
						const prefixes = [];
						texts.forEach((text, index) => {
							const record = records.get(text);
							if (record !== void 0) prefixes[index] = record.chars.slice(0, record.shown).join("");
						});
						presentations.set(callId, prefixes);
					}
					deferredRef.current?.didObserve?.();
					syncCallVisibility();
					if (pending.size === 0) announceSettled();
					else scheduleFrame();
				};
				const observer = !observeChanges || typeof MutationObserver === "undefined" ? null : new MutationObserver(processMutations);
				let outsideHidden = hiddenOutside(root);
				const ancestorObserver = typeof MutationObserver === "undefined" ? null : new MutationObserver(() => {
					const hidden = hiddenOutside(root);
					if (hidden === outsideHidden) return;
					outsideHidden = hidden;
					if (hidden) releaseSubtree(root);
					else visit(root, false);
					syncCallVisibility();
					if (pending.size === 0) announceSettled();
					else scheduleFrame();
				});
				for (let ancestor = root.parentElement; ancestor !== null; ancestor = ancestor.parentElement) ancestorObserver?.observe(ancestor, {
					attributes: true,
					attributeFilter: [
						"hidden",
						"style",
						"class"
					]
				});
				if (observer !== null) {
					for (const node of records.keys()) internalWrites.delete(node);
					observer.observe(root, {
						childList: true,
						characterData: true,
						subtree: true,
						attributes: true,
						attributeFilter: [
							"hidden",
							"style",
							"class",
							"open"
						],
						attributeOldValue: true
					});
				}
				if (recoveryRef.current.recovering() && !recoveryRef.current.hidden() && recoveryRef.current.mode() !== "latest") freezeBatch();
				if (pending.size === 0) announceSettled();
				else scheduleFrame();
				return () => {
					stopped = true;
					resume.current = null;
					wake.current = null;
					suspend.current = null;
					clearBatch();
					callbacks.current.onPendingChange?.(false);
					cancelAnimationFrame(rafId);
					observer?.disconnect();
					ancestorObserver?.disconnect();
					for (const [node, record] of records) {
						const controlled = record.chars.slice(0, record.shown).join("");
						if (node.isConnected && node.data === controlled) write(node, record.full);
					}
					pending.clear();
					for (const [call, previous] of concealed) if (previous.visibility) call.style.setProperty("visibility", previous.visibility, previous.priority);
					else call.style.removeProperty("visibility");
					concealed.clear();
					speedCpsRef.current = 35;
					debugRuntime.reportStream(streamId, null);
				};
			}, [
				enabled,
				observeChanges,
				revealInitial,
				rootRef,
				speedCpsRef
			]);
		}
		//#endregion
		//#region src/client/toolTreePresentation.ts
		/** Validate the whole shape before projecting; opaque/malformed trees stay untouched. */
		function readToolTree(root) {
			const ancestors = /* @__PURE__ */ new Set();
			const visit = (value) => {
				if (value === null || typeof value !== "object" || Array.isArray(value)) return void 0;
				const source = value;
				if (typeof source.callId !== "string" || source.callId === "" || ancestors.has(source)) return void 0;
				if (!Array.isArray(source.subCalls)) return source.phase === "preparing" && source.subCalls === void 0 ? {
					source,
					callId: source.callId,
					children: []
				} : void 0;
				ancestors.add(source);
				const children = [];
				for (const child of source.subCalls) {
					const parsed = visit(child);
					if (parsed === void 0) {
						ancestors.delete(source);
						return;
					}
					children.push(parsed);
				}
				ancestors.delete(source);
				return {
					source,
					callId: source.callId,
					children
				};
			};
			return visit(root);
		}
		function collectCallIds(node, result) {
			result.push(node.callId);
			for (const child of node.children) collectCallIds(child, result);
		}
		/** Root first, then each subCalls subtree in its existing display order. */
		function toolTreeCallIds(root) {
			const tree = readToolTree(root);
			if (tree === void 0) return [];
			const result = [];
			collectCallIds(tree, result);
			return result;
		}
		/** Original per-call payloads, keyed by the Host's stable call identity. */
		function toolTreeCallSources(root) {
			const tree = readToolTree(root);
			const result = /* @__PURE__ */ new Map();
			const visit = (node) => {
				result.set(node.callId, node.source);
				for (const child of node.children) visit(child);
			};
			if (tree !== void 0) visit(tree);
			return result;
		}
		/**
		* Retain admitted identities rather than a numeric prefix: a new grandchild
		* must not evict a sibling whose component and hook state are already visible.
		* Frozen payload overrides affect only the call itself; children still follow
		* the live source hierarchy and their independent admission identities.
		*/
		function projectToolTreeCallIds(root, visible, frozen) {
			const tree = readToolTree(root);
			if (tree === void 0) return root;
			const project = (node) => {
				const source = frozen?.get(node.callId) ?? node.source;
				const children = node.children.filter((child) => visible.has(child.callId)).map(project);
				const original = source.subCalls;
				if (original === void 0 && children.length === 0) return source;
				return Array.isArray(original) && children.length === original.length && children.every((child, index) => child === original[index]) ? source : {
					...source,
					subCalls: children
				};
			};
			return project(tree);
		}
		//#endregion
		//#region \0dsh-css:/root/workspaces/DSH项目维护/dsh-smooth-stream-git/src/client/AgentRowEntrance.module.css.mjs
		const css$2 = ".T0sFra_surface{min-width:0}.T0sFra_surface[data-entrance=active]{will-change:opacity;animation:.12s ease-out both T0sFra_dsh-smooth-stream-agent-row-in}@keyframes T0sFra_dsh-smooth-stream-agent-row-in{0%{opacity:.85}to{opacity:1}}@media (prefers-reduced-motion:reduce){.T0sFra_surface[data-entrance=active]{opacity:1;clip-path:none;will-change:auto;animation:none;transform:none}}";
		const tagId$2 = "dsh-smooth-stream/AgentRowEntrance.module.css";
		if (typeof document !== "undefined") {
			let tag = document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId$2) + "]");
			if (tag === null) {
				tag = document.createElement("style");
				tag.dataset.plugin = "dsh-smooth-stream";
				tag.dataset.pluginCss = tagId$2;
				document.head.appendChild(tag);
			}
			tag.textContent = css$2;
		}
		var AgentRowEntrance_module_css_default = {
			"dsh-smooth-stream-agent-row-in": "T0sFra_dsh-smooth-stream-agent-row-in",
			"surface": "T0sFra_surface"
		};
		//#endregion
		//#region src/client/TypewriterToolNodeView.tsx
		/**
		* 判定后端生命周期是否已结算（含未成功加载、中断、执行完毕的卡片）。
		* 是否属于展示历史由独立的呈现记录判定；首次发布的已完成结果仍可能需要排队。
		*/
		function isSettledChatNode(node) {
			if (node === null || typeof node !== "object") return false;
			const n = node;
			const data = n.data;
			if (data !== void 0 && typeof data === "object") {
				if (data.status === "settled" || data.status === "interrupted") return true;
				if (data.root !== null && typeof data.root === "object") {
					const root = data.root;
					if (root.kind === "tool-result" || "result" in root && root.result !== void 0) return true;
					if ("state" in root && (root.state === "ok" || root.state === "error" || root.state === "stopped")) return true;
				}
				if (data.command !== null && typeof data.command === "object") {
					const cmd = data.command;
					if (cmd.outcome !== null && cmd.outcome !== void 0) return true;
				}
				if ("outcome" in data && data.outcome !== null && data.outcome !== void 0) return true;
				if (data.current !== null && typeof data.current === "object") {
					const cur = data.current;
					if (cur.retryState !== void 0 && cur.retryState !== "scheduled") return true;
				}
				if (data.state === "ok" || data.state === "error" || data.state === "stopped") return true;
			}
			const location = n.location;
			if (location !== void 0 && typeof location === "object") {
				if (location.kind === "step" && location.step !== null && typeof location.step === "object") {
					if (location.step.status === "closed") return true;
				}
				if (location.kind === "turn" && location.turn !== null && typeof location.turn === "object") {
					if (location.turn.status === "closed") return true;
				}
			}
			return false;
		}
		function isInterruptedChatNode(node) {
			if (node === null || typeof node !== "object" || !("data" in node)) return false;
			const data = node.data;
			if (data === null || typeof data !== "object") return false;
			if ("status" in data && data.status === "interrupted") return true;
			if ("state" in data && data.state === "stopped") return true;
			return "root" in data && data.root !== null && typeof data.root === "object" && "state" in data.root && data.root.state === "stopped";
		}
		function openAgentLocation(node) {
			if (node === null || typeof node !== "object" || !("location" in node)) return false;
			const location = node.location;
			if (location === null || typeof location !== "object" || !("kind" in location)) return false;
			const kind = location.kind;
			if (!("turn" in location)) return false;
			const turn = location.turn;
			if (turn === null || typeof turn !== "object" || !("status" in turn)) return false;
			if (kind === "turn") return turn.status === "open";
			if (kind !== "step" || !("step" in location)) return false;
			const step = location.step;
			return step !== null && typeof step === "object" && "status" in step && step.status === "open";
		}
		/**
		* True while a Chat node has an explicitly unfinished lifecycle: an
		* assistant/workflow `status: 'running'` payload, a Tool root that has not
		* settled (`kind` absent), or a model-retry whose current attempt is still
		* `scheduled`.
		*/
		function isGrowingChatNode(node) {
			if (isSettledChatNode(node)) return false;
			if (node === null || typeof node !== "object" || !("data" in node)) return false;
			const data = node.data;
			if (data === null || typeof data !== "object") return false;
			if ("status" in data && data.status === "running") return true;
			if ("kind" in data && data.kind === "command" && "outcome" in data && data.outcome === null) return true;
			if ("command" in data) {
				const command = data.command;
				if (command !== null && typeof command === "object" && "outcome" in command && command.outcome === null) return true;
			}
			if ("root" in data) {
				const root = data.root;
				if (root !== null && typeof root === "object" && !("kind" in root)) return true;
			}
			if ("current" in data) {
				const current = data.current;
				if (current !== null && typeof current === "object" && "retryState" in current && current.retryState === "scheduled") return true;
			}
			return false;
		}
		/**
		* True for any Agent-owned Chat row in the currently open turn/step.
		* Settled historical cards are unconditionally excluded.
		*/
		function isFollowableChatNode(node) {
			if (isSettledChatNode(node)) return false;
			return isGrowingChatNode(node) || openAgentLocation(node);
		}
		/** Runtime-only fallback for unknown or terminal rows at the active flow tip. */
		function liveAgentTailMode(root) {
			const port = root.closest("[data-conversation-scroll]");
			if (port === null) return null;
			const row = root.closest("[data-chat-flow-key]");
			if (row !== null) {
				let sibling = row.nextElementSibling;
				while (sibling !== null) {
					if (sibling instanceof HTMLElement && sibling.hasAttribute("data-chat-flow-key")) return null;
					sibling = sibling.nextElementSibling;
				}
			}
			const flow = root.closest("[data-chat-flow]");
			if (flow !== null && [...flow.children].some((child) => child instanceof HTMLElement && child.getAttribute("role") === "status" && !child.hasAttribute("data-chat-flow-key"))) return "turn";
			return hasRecentConversationFollow(port) ? "handoff" : null;
		}
		const presentedTools = /* @__PURE__ */ new Map();
		const PRESENTED_TOOL_LIMIT = 512;
		function hasPresentedToolNode(node, sessionId) {
			const scope = relayScope(node, sessionId);
			return presentedTools.has(JSON.stringify([
				scope.session,
				scope.turn,
				scope.node
			]));
		}
		function sameCallPayload(left, right) {
			const keys = Object.keys(left).filter((key) => key !== "subCalls");
			const other = Object.keys(right).filter((key) => key !== "subCalls");
			return keys.length === other.length && keys.every((key) => left[key] === right[key]);
		}
		function rememberTool(key, presentation) {
			presentedTools.delete(key);
			presentedTools.set(key, presentation);
			if (presentedTools.size > PRESENTED_TOOL_LIMIT) presentedTools.delete(presentedTools.keys().next().value);
		}
		/**
		* Wrap a prior Agent Chat renderer so its entrance and later growth share
		* conversation follow. Presentation stays with the wrapped component; kit
		* seats (`renderSlot`, locale, inject) pass through unchanged.
		*/
		function wrapFollowNodeView(Inner, useControlScroll, useRecoveryMode) {
			return function TypewriterFollowNodeView(props) {
				const controlScroll = useControlScroll?.() ?? true;
				const recoveryMode = useRecoveryMode?.() ?? "catch-up";
				const speedCpsRef = (0, react.useRef)(35);
				const hostRef = (0, react.useRef)(null);
				const isSettled = isSettledChatNode(props.node);
				const growing = !isSettled && isGrowingChatNode(props.node);
				const baseScope = (0, react.useMemo)(() => relayScope(props.node, props.sessionId), [props.node, props.sessionId]);
				const recoveryKey = relayTurnKey(baseScope);
				const part = (props.node !== null && typeof props.node === "object" && "kind" in props.node ? props.node.kind : void 0) === "tool-call" || props.node !== null && typeof props.node === "object" && "data" in props.node && props.node.data !== null && typeof props.node.data === "object" && "root" in props.node.data ? "tool" : "output";
				const recoveryPosition = [
					baseScope.step,
					baseScope.order,
					2
				];
				const recoveringScope = isBackgroundRecoveryScope(recoveryKey, recoveryPosition);
				const [recoveryEpoch, setRecoveryEpoch] = (0, react.useState)(() => {
					const activeEpoch = streamRelay.recoveryEpoch(recoveryKey);
					return recoveringScope ? activeEpoch ?? 0 : void 0;
				});
				const scope = (0, react.useMemo)(() => ({
					...baseScope,
					recoveryEpoch
				}), [baseScope, recoveryEpoch]);
				const presentationKey = scope.node === "unknown" ? void 0 : JSON.stringify([
					scope.session,
					scope.turn,
					scope.node
				]);
				const priorPresentation = (0, react.useRef)(presentationKey === void 0 ? void 0 : presentedTools.get(presentationKey)).current;
				const presentation = (0, react.useRef)(priorPresentation ?? {
					calls: /* @__PURE__ */ new Set(),
					text: /* @__PURE__ */ new Map()
				}).current;
				const revealInitialRef = (0, react.useRef)(priorPresentation === void 0);
				const revealDomInitial = (0, react.useRef)(revealInitialRef.current || presentation.text.size > 0).current;
				const queuedOnMount = (0, react.useRef)(revealInitialRef.current && streamRelay.recoveryEpoch(recoveryKey) === void 0 && streamRelay.isBlocked(baseScope, part)).current;
				const structurallyFollowable = isFollowableChatNode(props.node) || !isSettled && openAgentLocation(props.node) || recoveringScope && revealInitialRef.current || queuedOnMount;
				const structuralRef = (0, react.useRef)(structurallyFollowable);
				const [runtimeFollowable, setRuntimeFollowable] = (0, react.useState)(false);
				const runtimePersistentRef = (0, react.useRef)(false);
				const runtimeHandledRef = (0, react.useRef)(false);
				const seenFollowable = (0, react.useRef)(structurallyFollowable);
				if (structurallyFollowable) seenFollowable.current = true;
				const settledOpenGrowth = isSettled && seenFollowable.current && openAgentLocation(props.node);
				const followable = !isInterruptedChatNode(props.node) && (seenFollowable.current || !isSettled && runtimeFollowable || settledOpenGrowth);
				const [revealPending, setRevealPending] = (0, react.useState)(followable && revealInitialRef.current);
				const sourceNode = props.node !== null && typeof props.node === "object" ? props.node : void 0;
				const sourceData = sourceNode?.data !== null && typeof sourceNode?.data === "object" ? sourceNode.data : void 0;
				const sourceRoot = sourceData?.root;
				const sourceCallIds = (0, react.useMemo)(() => toolTreeCallIds(sourceRoot), [sourceRoot]);
				const sourceCalls = (0, react.useMemo)(() => toolTreeCallSources(sourceRoot), [sourceRoot]);
				const [visibleIds, setVisibleIds] = (0, react.useState)(() => new Set(presentation.calls));
				const visibleCallIds = (0, react.useMemo)(() => /* @__PURE__ */ new Set([...visibleIds, ...sourceCallIds.slice(0, 1)]), [visibleIds, sourceCallIds]);
				const projectCalls = followable && sourceCallIds.length > 0;
				const deferredIds = projectCalls ? sourceCallIds.filter((id) => !visibleCallIds.has(id)) : [];
				const admittedRef = (0, react.useRef)(false);
				const materializedRef = (0, react.useRef)(!followable || !revealInitialRef.current);
				const waitingRef = (0, react.useRef)(true);
				const frozenCalls = (0, react.useRef)(/* @__PURE__ */ new Map());
				const releasedCalls = (0, react.useRef)(/* @__PURE__ */ new Map());
				const lockedSources = /* @__PURE__ */ new Map();
				const changedPayloads = [];
				for (const [id, frozen] of frozenCalls.current) {
					const current = sourceCalls.get(id);
					if (!frozen.locked || frozen.epoch !== recoveryEpoch || current === void 0) continue;
					lockedSources.set(id, frozen.source);
					if (!sameCallPayload(current, frozen.source)) changedPayloads.push(id);
				}
				const deferredCalls = deferredIds.length > 0 || changedPayloads.length > 0;
				const treeRef = (0, react.useRef)({
					ids: sourceCallIds,
					visible: visibleCallIds,
					calls: sourceCalls,
					deferredIds,
					changedPayloads,
					deferred: deferredCalls
				});
				treeRef.current = {
					ids: sourceCallIds,
					visible: visibleCallIds,
					calls: sourceCalls,
					deferredIds,
					changedPayloads,
					deferred: deferredCalls
				};
				const previousLocks = (0, react.useRef)(lockedSources);
				(0, react.useLayoutEffect)(() => {
					if (recoveryEpoch !== void 0) for (const [id, previous] of previousLocks.current) {
						const current = sourceCalls.get(id);
						if (!lockedSources.has(id) && current !== void 0 && !sameCallPayload(current, previous)) releasedCalls.current.set(id, recoveryEpoch);
					}
					previousLocks.current = lockedSources;
				});
				const [entering, setEntering] = (0, react.useState)(structurallyFollowable);
				const [growthPulse, setGrowthPulse] = (0, react.useState)(false);
				const followableRef = (0, react.useRef)(false);
				const growingRef = (0, react.useRef)(growing);
				const entranceActiveRef = (0, react.useRef)(entering || growthPulse);
				const growthExtentRef = (0, react.useRef)(null);
				const mountedRef = (0, react.useRef)(true);
				const pulseTimerRef = (0, react.useRef)(null);
				structuralRef.current = structurallyFollowable;
				followableRef.current = followable;
				growingRef.current = growing;
				entranceActiveRef.current = entering || growthPulse;
				const admitted = usePresentationAdmission(scope, part, followable, revealPending || deferredCalls, hostRef, !revealInitialRef.current, presentationOwnerKey(baseScope, part));
				admittedRef.current = admitted;
				const participating = growing || revealPending || deferredCalls || !isSettled && followable;
				const subscribeBlocked = (0, react.useCallback)((listener) => participating ? streamRelay.subscribeBlocked(scope, part, listener) : () => {}, [
					participating,
					scope.session,
					scope.turn,
					scope.step,
					scope.node,
					scope.order,
					scope.recoveryEpoch,
					part
				]);
				const readBlocked = (0, react.useCallback)(() => participating && streamRelay.isBlocked(scope, part), [
					participating,
					scope.session,
					scope.turn,
					scope.step,
					scope.node,
					scope.order,
					scope.recoveryEpoch,
					part
				]);
				const relayBlocked = (0, react.useSyncExternalStore)(subscribeBlocked, readBlocked, () => false);
				const lease = (0, react.useRef)(null);
				const pendingRef = (0, react.useRef)(revealPending || deferredCalls);
				pendingRef.current = revealPending || deferredCalls;
				const needsLease = participating && (admitted || part === "tool");
				const updatePending = (0, react.useCallback)((pending) => {
					if (!admittedRef.current || !materializedRef.current) return;
					pendingRef.current = pending || treeRef.current.deferred;
					setRevealPending(pending);
					if (lease.current !== null) streamRelay.update(lease.current, pendingRef.current);
				}, []);
				(0, react.useLayoutEffect)(() => {
					if (!needsLease) return;
					const token = streamRelay.acquire(scope, part, admitted && pendingRef.current);
					lease.current = token;
					return () => {
						streamRelay.release(token);
						if (lease.current === token) lease.current = null;
					};
				}, [
					scope.session,
					scope.turn,
					scope.step,
					scope.node,
					scope.order,
					scope.recoveryEpoch,
					part,
					needsLease
				]);
				(0, react.useLayoutEffect)(() => {
					if (lease.current !== null) streamRelay.update(lease.current, admitted && pendingRef.current);
				}, [
					admitted,
					revealPending,
					deferredCalls
				]);
				const [precedingTyping, setPrecedingTyping] = (0, react.useState)(false);
				const isUnsettled = participating && (relayBlocked || growing || structurallyFollowable);
				(0, react.useLayoutEffect)(() => {
					if (!isUnsettled) {
						setPrecedingTyping(false);
						return;
					}
					const root = hostRef.current;
					if (!root) return;
					const flowItem = root.closest("[data-chat-flow-key]");
					if (!flowItem) return;
					let prev = null;
					let cur = flowItem.previousElementSibling;
					while (cur instanceof HTMLElement) {
						if (cur.hasAttribute("data-chat-flow-key")) {
							prev = cur;
							break;
						}
						cur = cur.previousElementSibling;
					}
					if (!prev) {
						setPrecedingTyping(false);
						return;
					}
					const checkPreceding = () => {
						if (!prev) return false;
						if (prev.querySelector("[data-smooth-stream-phase]") !== null) return false;
						return prev.querySelector("[data-streaming], [data-smooth-stream-typing=\"true\"]") !== null;
					};
					const isTyping = checkPreceding();
					setPrecedingTyping(isTyping);
					if (!isTyping || typeof MutationObserver === "undefined") return;
					const observer = new MutationObserver(() => {
						const stillTyping = checkPreceding();
						setPrecedingTyping(stillTyping);
						if (!stillTyping) observer.disconnect();
					});
					observer.observe(prev, {
						attributes: true,
						childList: true,
						attributeFilter: [
							"data-streaming",
							"data-smooth-stream-typing",
							"data-smooth-stream-phase"
						],
						subtree: true
					});
					return () => observer.disconnect();
				}, [
					isUnsettled,
					relayBlocked,
					scope.session,
					scope.turn,
					scope.step,
					scope.node
				]);
				const waiting = !admitted || relayBlocked || isUnsettled && precedingTyping;
				waitingRef.current = waiting;
				if (!waiting) materializedRef.current = true;
				(0, react.useLayoutEffect)(() => {
					if (!materializedRef.current) return;
					for (const id of projectCalls ? visibleCallIds : sourceCallIds) presentation.calls.add(id);
					if (presentationKey !== void 0) rememberTool(presentationKey, presentation);
				}, [
					admitted,
					waiting,
					presentationKey,
					presentation,
					projectCalls,
					visibleCallIds,
					sourceCallIds
				]);
				const finishRuntimeReveal = (0, react.useCallback)(() => {
					if (structuralRef.current || runtimePersistentRef.current) return;
					runtimeHandledRef.current = true;
					setRuntimeFollowable(false);
				}, []);
				const deferredSource = (0, react.useMemo)(() => ({
					presentations: presentation.text,
					hasPending(epoch) {
						const tree = treeRef.current;
						return tree.deferred && (epoch === void 0 || [...tree.deferredIds, ...tree.changedPayloads].some((id) => frozenCalls.current.get(id)?.epoch === epoch));
					},
					freeze(epoch) {
						const tree = treeRef.current;
						for (const id of tree.ids) {
							const source = tree.calls.get(id);
							if (source !== void 0 && !frozenCalls.current.has(id)) frozenCalls.current.set(id, {
								epoch,
								source,
								locked: !materializedRef.current || !tree.visible.has(id)
							});
						}
					},
					epochForCall: (id) => frozenCalls.current.get(id)?.epoch,
					adoptingEpoch: (id) => releasedCalls.current.get(id),
					didObserve: () => {
						releasedCalls.current.clear();
					},
					onDrained(epoch) {
						const tree = treeRef.current;
						if (!tree.deferred || !admittedRef.current || waitingRef.current) return epoch;
						const id = epoch === void 0 ? tree.deferredIds[0] : tree.deferredIds.find((candidate) => frozenCalls.current.get(candidate)?.epoch === epoch);
						if (id === void 0 && epoch !== void 0) return epoch + 1;
						if (id === void 0) return epoch;
						updatePending(true);
						setVisibleIds((current) => /* @__PURE__ */ new Set([...current, id]));
						return epoch;
					}
				}), [presentation, updatePending]);
				const updateRecoveryEpoch = (0, react.useCallback)((epoch) => {
					if (epoch === void 0) {
						frozenCalls.current.clear();
						releasedCalls.current.clear();
					}
					setRecoveryEpoch(epoch);
				}, []);
				const projectedRoot = projectCalls ? projectToolTreeCallIds(sourceRoot, visibleCallIds, lockedSources) : sourceRoot;
				const adapted = (0, react.useMemo)(() => projectedRoot === sourceRoot ? props : {
					...props,
					node: {
						...sourceNode,
						data: {
							...sourceData,
							root: projectedRoot
						}
					}
				}, [
					props,
					projectedRoot,
					sourceRoot,
					sourceNode,
					sourceData
				]);
				useProgressiveDomText(hostRef, followable && (!isSettled || settledOpenGrowth || revealPending || deferredCalls), revealDomInitial, speedCpsRef, runtimeFollowable ? finishRuntimeReveal : void 0, updatePending, waiting, recoveryMode, followable && (growing || revealPending || deferredCalls) ? recoveryKey : void 0, recoveryPosition, growing || settledOpenGrowth || revealPending || deferredCalls || !isSettled && followable, updateRecoveryEpoch, recoveryEpoch, projectCalls ? deferredSource : void 0);
				(0, react.useLayoutEffect)(() => {
					if (structurallyFollowable || isSettled) return;
					const root = hostRef.current;
					if (root === null) return;
					const mode = liveAgentTailMode(root);
					if (runtimeFollowable) {
						if (runtimePersistentRef.current && mode !== "turn") {
							runtimePersistentRef.current = false;
							runtimeHandledRef.current = true;
							setRuntimeFollowable(false);
						}
						return;
					}
					if (runtimeHandledRef.current || mode === null) return;
					runtimePersistentRef.current = mode === "turn";
					setRuntimeFollowable(true);
					setEntering(false);
				}, [
					runtimeFollowable,
					structurallyFollowable,
					isSettled
				]);
				const finishEntrance = (0, react.useCallback)(() => {
					growthExtentRef.current = null;
					if (pulseTimerRef.current !== null) {
						clearTimeout(pulseTimerRef.current);
						pulseTimerRef.current = null;
					}
					setEntering(false);
					setGrowthPulse(false);
				}, []);
				const onGrowth = (0, react.useCallback)((deltaPx) => {
					if (!mountedRef.current || !followableRef.current || growingRef.current || entranceActiveRef.current || isSettled && !settledOpenGrowth) return;
					growthExtentRef.current = deltaPx;
					setGrowthPulse(true);
					if (pulseTimerRef.current !== null) clearTimeout(pulseTimerRef.current);
					pulseTimerRef.current = setTimeout(() => {
						pulseTimerRef.current = null;
						setGrowthPulse(false);
					}, 1200);
				}, [isSettled, settledOpenGrowth]);
				(0, react.useEffect)(() => {
					mountedRef.current = true;
					return () => {
						mountedRef.current = false;
						if (pulseTimerRef.current !== null) clearTimeout(pulseTimerRef.current);
					};
				}, []);
				(0, react.useLayoutEffect)(() => {
					const el = hostRef.current;
					if (!el) return;
					const card = el.closest("[data-chat-flow-key]");
					if (!revealPending && !waiting && (isSettled || !growing && !entering && !growthPulse)) {
						el.setAttribute("data-smooth-stream-settled", "true");
						if (card instanceof HTMLElement) card.setAttribute("data-smooth-stream-settled", "true");
					} else {
						el.removeAttribute("data-smooth-stream-settled");
						if (card instanceof HTMLElement) card.removeAttribute("data-smooth-stream-settled");
					}
				}, [
					isSettled,
					growing,
					entering,
					growthPulse,
					waiting,
					revealPending
				]);
				return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					"data-smooth-stream-phase": waiting ? "waiting" : revealPending ? "typing" : "settled",
					"data-smooth-stream-typing": revealPending ? "true" : void 0,
					style: { transition: "opacity 0.15s ease" },
					children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(FollowHost, {
						active: !waiting && revealPending,
						entrance: !waiting && (entering || growthPulse),
						onEntranceSettled: finishEntrance,
						onGrowth: followable && !waiting && (!isSettled || settledOpenGrowth) ? onGrowth : void 0,
						entranceExtentRef: growthExtentRef,
						speedCpsRef,
						controlScroll,
						predictive: false,
						hostRef,
						className: AgentRowEntrance_module_css_default.surface,
						entranceActive: !waiting && (entering || growthPulse),
						children: materializedRef.current ? (0, react.createElement)(Inner, adapted) : null
					})
				});
			};
		}
		//#endregion
		//#region src/client/flowPresentationAdapter.tsx
		const CHAT_FLOW_SLOT = "conversation.chat.flow";
		const CHAT_NODE_SLOT = "conversation.chat.node";
		const PRESENTED_GROUP_LIMIT = 512;
		const presentedGroups = /* @__PURE__ */ new Set();
		const groupSetStates = /* @__PURE__ */ new Map();
		function groupIdentity(sessionId, key) {
			return JSON.stringify([sessionId, key]);
		}
		function groupSetState(sessionId) {
			const state = groupSetStates.get(sessionId) ?? {
				revision: 0,
				listeners: /* @__PURE__ */ new Set()
			};
			groupSetStates.set(sessionId, state);
			return state;
		}
		function groupSetSnapshot(sessionId) {
			return groupSetStates.get(sessionId)?.revision ?? 0;
		}
		function subscribeGroupSet(sessionId, listener) {
			const state = groupSetState(sessionId);
			state.listeners.add(listener);
			return () => {
				state.listeners.delete(listener);
			};
		}
		function publishGroupSet(sessionId) {
			const state = groupSetState(sessionId);
			state.revision += 1;
			for (const listener of [...state.listeners]) listener();
		}
		function rememberGroup(identity) {
			if (presentedGroups.has(identity)) return false;
			presentedGroups.add(identity);
			if (presentedGroups.size > PRESENTED_GROUP_LIMIT) presentedGroups.delete(presentedGroups.values().next().value);
			return true;
		}
		function asRecord(value) {
			return value !== null && typeof value === "object" ? value : void 0;
		}
		function ownerPart(node, reference) {
			const value = asRecord(node);
			const data = asRecord(value?.data);
			if (value?.kind === "assistant-step") return reference.groupPart === "reasoning" ? "reasoning" : "response";
			if (value?.kind === "tool-call" || data !== void 0 && "root" in data) return "tool";
			return "output";
		}
		function ownerWasPresented(node, reference, scope) {
			const value = asRecord(node);
			if (value?.kind !== "assistant-step") return hasPresentedToolNode(node, scope.session);
			const blocks = asRecord(value.data)?.blocks;
			if (!Array.isArray(blocks)) return false;
			const projection = assistantTextSegments(blocks, reference.groupPart);
			const part = ownerPart(node, reference);
			const key = JSON.stringify([
				scope.session,
				scope.turn,
				scope.step,
				scope.node,
				part
			]);
			const prefix = assistantProgress.read(key, projection.segments.join(""));
			return prefix !== void 0 && prefix !== "";
		}
		function describeOwner(node, reference, sessionId) {
			const scope = relayScope(node, sessionId);
			const part = ownerPart(node, reference);
			const position = Number.isFinite(scope.order) ? [
				scope.step,
				scope.order,
				part === "reasoning" ? 0 : part === "response" ? 1 : 2
			] : void 0;
			const queued = isFollowableChatNode(node) || isBackgroundRecoveryScope(relayTurnKey(scope), position) || streamRelay.isBlocked(scope, part);
			return {
				scope,
				part,
				ownerKey: presentationOwnerKey(scope, part),
				queued,
				previouslyPresented: ownerWasPresented(node, reference, scope)
			};
		}
		function OwnerReservation({ nodeKey, groupPart, sessionId, enabled, recoveryMode, useChatNode, managedNodeKinds }) {
			const node = useChatNode(nodeKey, (value) => value);
			if (node === void 0 || !managedNodeKinds.has(node.kind)) return null;
			return (0, react.createElement)(OwnerReservationReady, {
				node,
				groupPart,
				sessionId,
				enabled,
				recoveryMode
			});
		}
		function OwnerReservationReady({ node, groupPart, sessionId, enabled, recoveryMode }) {
			const descriptor = describeOwner(node, groupPart === void 0 ? {} : { groupPart }, sessionId);
			const recoveryKey = relayTurnKey(descriptor.scope);
			const recoveryPosition = [
				descriptor.scope.step,
				descriptor.scope.order,
				descriptor.part === "reasoning" ? 0 : descriptor.part === "response" ? 1 : 2
			];
			const [recoveryEpoch, setRecoveryEpoch] = (0, react.useState)(() => recoveryMode !== "latest" && isBackgroundRecoveryScope(recoveryKey, recoveryPosition) ? streamRelay.recoveryEpoch(recoveryKey) ?? 0 : void 0);
			const scope = {
				...descriptor.scope,
				recoveryEpoch
			};
			const ownerState = (0, react.useRef)({
				ownerKey: descriptor.ownerKey,
				required: false
			});
			if (ownerState.current.ownerKey !== descriptor.ownerKey) ownerState.current = {
				ownerKey: descriptor.ownerKey,
				required: false
			};
			if (descriptor.queued && !descriptor.previouslyPresented) ownerState.current.required = true;
			const shouldQueue = ownerState.current.required && !descriptor.previouslyPresented;
			const root = (0, react.useRef)(null);
			const admitted = usePresentationAdmission(scope, descriptor.part, enabled && shouldQueue, true, root, !enabled || !shouldQueue || descriptor.previouslyPresented, descriptor.ownerKey, true);
			const reserving = enabled && shouldQueue && !admitted;
			const sourceReservation = (0, react.useRef)(void 0);
			const releaseSource = () => {
				sourceReservation.current?.();
				sourceReservation.current = void 0;
			};
			const freezeSource = (epoch) => {
				if (reserving && recoveryMode !== "latest" && sourceReservation.current === void 0) sourceReservation.current = reservePresentationSource(descriptor.ownerKey, scope, epoch, node);
			};
			const joinRecovery = () => {
				const epoch = recoveryMode === "latest" ? void 0 : streamRelay.recoveryEpoch(recoveryKey) ?? 0;
				setRecoveryEpoch(epoch);
				return epoch;
			};
			const playback = useBackgroundRecovery(recoveryMode, () => {
				releaseSource();
				joinRecovery();
			}, () => {
				const epoch = joinRecovery();
				if (epoch !== void 0) freezeSource(epoch);
			}, recoveryKey, recoveryPosition, false, reserving);
			(0, react.useLayoutEffect)(() => {
				if (!enabled || recoveryMode === "latest") releaseSource();
				else if (recoveryEpoch !== void 0 && !playback.hidden()) freezeSource(recoveryEpoch);
			}, [
				enabled,
				recoveryMode,
				recoveryEpoch,
				reserving,
				node
			]);
			(0, react.useLayoutEffect)(() => () => {
				releaseSource();
			}, [descriptor.ownerKey]);
			(0, react.useLayoutEffect)(() => {
				if (!reserving || recoveryMode === "latest" || recoveryEpoch === void 0) return;
				const lease = streamRelay.acquire(scope, descriptor.part);
				return () => {
					streamRelay.release(lease);
				};
			}, [
				reserving,
				recoveryMode,
				recoveryEpoch,
				recoveryKey,
				scope.step,
				scope.node,
				scope.order,
				descriptor.part
			]);
			return null;
		}
		function GroupOwnerReservations({ groupKey, sessionId, enabled, recoveryMode, useChatGroup, useChatNode, managedNodeKinds }) {
			const group = useChatGroup(groupKey, (value) => value);
			if (group === void 0) return null;
			return (0, react.createElement)(react.Fragment, null, ...group.members.map((member, index) => (0, react.createElement)(OwnerReservation, {
				key: `${member.key}:${member.groupPart ?? ""}:${index}`,
				nodeKey: member.key,
				groupPart: member.groupPart,
				sessionId,
				enabled,
				recoveryMode,
				useChatNode,
				managedNodeKinds
			})));
		}
		function FlowPresentationAdapter({ Inner, props, settings, managedNodeKinds }) {
			const preferences = (0, react.useSyncExternalStore)(settings.subscribe, settings.getSnapshot, settings.getSnapshot);
			const sessionId = String(props.sessionId);
			const versionSubscribe = (0, react.useCallback)((listener) => subscribeGroupSet(sessionId, listener), [sessionId]);
			const versionSnapshot = (0, react.useCallback)(() => groupSetSnapshot(sessionId), [sessionId]);
			const groupSetVersion = (0, react.useSyncExternalStore)(versionSubscribe, versionSnapshot, versionSnapshot);
			const gatedUseChatNode = (0, react.useCallback)((key, selector) => {
				const node = props.useChatNode(key, (value) => value);
				const subscribe = (0, react.useCallback)((listener) => subscribePresentationSource(sessionId, key, listener), [key, sessionId]);
				const read = (0, react.useCallback)(() => readPresentationSource(sessionId, key), [key, sessionId]);
				const frozen = (0, react.useSyncExternalStore)(subscribe, read, read);
				const projected = (0, react.useMemo)(() => {
					const data = asRecord(node?.data);
					const frozenData = asRecord(asRecord(frozen)?.data);
					if (node === void 0 || data === void 0 || frozenData === void 0 || data.status === "interrupted") return node;
					return {
						...node,
						data: {
							...frozenData,
							..."status" in data ? { status: data.status } : {}
						}
					};
				}, [node, frozen]);
				return selector === void 0 ? projected : selector(projected);
			}, [props.useChatNode, sessionId]);
			const gatedUseChatGroup = (0, react.useCallback)((key, selector) => {
				const group = props.useChatGroup(key, (value) => value);
				const firstMember = group?.members[0];
				const firstNode = props.useChatNode(firstMember?.key ?? "", (value) => value);
				const descriptor = firstMember !== void 0 && firstNode !== void 0 && managedNodeKinds.has(firstNode.kind) ? describeOwner(firstNode, firstMember, sessionId) : void 0;
				const identity = groupIdentity(sessionId, key);
				const ownerKey = descriptor?.ownerKey;
				const subscribeOwner = (0, react.useCallback)((listener) => ownerKey === void 0 ? () => {} : subscribePresentationOwner(ownerKey, listener), [ownerKey]);
				const readOwner = (0, react.useCallback)(() => ownerKey !== void 0 && presentationOwnerAdmitted(ownerKey) === true, [ownerKey]);
				const ownerAdmitted = (0, react.useSyncExternalStore)(subscribeOwner, readOwner, readOwner);
				const required = (0, react.useRef)({
					identity,
					ownerKey,
					queued: false,
					unresolved: false
				});
				if (required.current.identity !== identity) required.current = {
					identity,
					ownerKey,
					queued: false,
					unresolved: false
				};
				else if (required.current.ownerKey !== void 0 && required.current.ownerKey !== ownerKey) required.current = {
					identity,
					ownerKey,
					queued: false,
					unresolved: false
				};
				else required.current.ownerKey = ownerKey;
				const hasMembers = (group?.members.length ?? 0) > 0;
				if (preferences.enabled && hasMembers && firstNode === void 0) required.current.unresolved = true;
				else if (firstNode !== void 0 && descriptor === void 0) {
					required.current.queued = false;
					required.current.unresolved = false;
				} else if (descriptor !== void 0) {
					if (descriptor.queued && !descriptor.previouslyPresented) {
						required.current.queued = true;
						required.current.unresolved = false;
					} else if (required.current.unresolved && !descriptor.queued) {
						required.current.queued = false;
						required.current.unresolved = false;
					}
				}
				const wasPresented = presentedGroups.has(identity);
				const needsGate = preferences.enabled && (required.current.queued || required.current.unresolved) && !wasPresented;
				const ready = !preferences.enabled || wasPresented || descriptor?.previouslyPresented === true || !needsGate && (!hasMembers || firstNode !== void 0) || ownerAdmitted;
				(0, react.useLayoutEffect)(() => {
					if (group === void 0 || !ready || !rememberGroup(identity)) return;
					if (needsGate) publishGroupSet(sessionId);
				}, [
					group,
					identity,
					needsGate,
					ready,
					sessionId
				]);
				return ready ? selector === void 0 ? group : selector(group) : void 0;
			}, [
				managedNodeKinds,
				preferences.enabled,
				props.useChatGroup,
				props.useChatNode,
				sessionId
			]);
			const useGroupAction = (0, react.useCallback)((hidden, reveal) => {
				const versionedReveal = (0, react.useCallback)(() => reveal(), [reveal, groupSetVersion]);
				return props.useGroupAction(hidden, versionedReveal);
			}, [groupSetVersion, props.useGroupAction]);
			const useGroupHeaderAction = (0, react.useCallback)((ref, hidden) => {
				const versionedRef = (0, react.useMemo)(() => ({ get current() {
					return ref.current;
				} }), [ref, groupSetVersion]);
				return props.useGroupHeaderAction(versionedRef, hidden);
			}, [groupSetVersion, props.useGroupHeaderAction]);
			const reservations = preferences.enabled ? props.entries.map((entry, index) => entry.kind === "node" ? (0, react.createElement)(OwnerReservation, {
				key: `node:${entry.key}:${entry.groupPart ?? ""}:${index}`,
				nodeKey: entry.key,
				groupPart: entry.groupPart,
				sessionId,
				enabled: true,
				recoveryMode: preferences.backgroundRecovery,
				managedNodeKinds,
				useChatNode: props.useChatNode
			}) : (0, react.createElement)(GroupOwnerReservations, {
				key: `group:${entry.key}:${index}`,
				groupKey: entry.key,
				sessionId,
				enabled: true,
				recoveryMode: preferences.backgroundRecovery,
				managedNodeKinds,
				useChatGroup: props.useChatGroup,
				useChatNode: props.useChatNode
			})) : [];
			return (0, react.createElement)(react.Fragment, null, ...reservations, (0, react.createElement)(Inner, {
				...props,
				useChatNode: gatedUseChatNode,
				useChatGroup: gatedUseChatGroup,
				useGroupAction,
				useGroupHeaderAction
			}));
		}
		/** Decorate the installed Chat Flow component without changing its official entries or child slots. */
		function installFlowPresentationAdapter(ctx, settings, canManageRenderer) {
			const originals = /* @__PURE__ */ new Map();
			const listeners = /* @__PURE__ */ new Set();
			let revision = 0;
			let disposed = false;
			let lastSlotVersion = ctx.slots.getVersion(CHAT_FLOW_SLOT);
			let lastNodeVersion = ctx.slots.getVersion(CHAT_NODE_SLOT);
			const subscribe = (listener) => {
				if (disposed) return () => {};
				listeners.add(listener);
				const offFlow = ctx.slots.subscribe(CHAT_FLOW_SLOT, listener);
				const offNodes = ctx.slots.subscribe(CHAT_NODE_SLOT, listener);
				return () => {
					offFlow();
					offNodes();
					listeners.delete(listener);
				};
			};
			const getSnapshot = () => {
				if (!disposed) {
					lastSlotVersion = ctx.slots.getVersion(CHAT_FLOW_SLOT);
					lastNodeVersion = ctx.slots.getVersion(CHAT_NODE_SLOT);
				}
				return `${lastSlotVersion}:${lastNodeVersion}:${revision}:${disposed}`;
			};
			const apply = () => {
				if (disposed) return;
				for (const entry of ctx.slots.entries(CHAT_FLOW_SLOT)) {
					if (originals.get(entry)?.wrapped === entry.component) continue;
					const original = entry.component;
					if (typeof original !== "function" && (original === null || typeof original !== "object" || !("$$typeof" in original))) continue;
					const Inner = original;
					const wrapped = function SmoothStreamFlowEntry(props) {
						const version = (0, react.useSyncExternalStore)(subscribe, getSnapshot, getSnapshot);
						const managedNodeKinds = (0, react.useMemo)(() => new Set(disposed ? [] : ctx.slots.entries(CHAT_NODE_SLOT).filter((nodeEntry) => canManageRenderer(String(nodeEntry.options.key), nodeEntry.component)).map((nodeEntry) => String(nodeEntry.options.key))), [version]);
						return disposed ? (0, react.createElement)(Inner, props) : (0, react.createElement)(FlowPresentationAdapter, {
							Inner,
							props,
							settings,
							managedNodeKinds
						});
					};
					originals.set(entry, {
						original,
						wrapped
					});
					entry.component = wrapped;
				}
			};
			const off = ctx.slots.subscribe(CHAT_FLOW_SLOT, apply);
			apply();
			return () => {
				if (disposed) return;
				disposed = true;
				revision += 1;
				for (const listener of [...listeners]) listener();
				off();
				for (const [entry, record] of originals) if (entry.component === record.wrapped) entry.component = record.original;
				originals.clear();
			};
		}
		//#endregion
		//#region src/client/conversationPipeline.ts
		const pipelines = /* @__PURE__ */ new WeakMap();
		const patchedBindings = /* @__PURE__ */ new WeakMap();
		function isRecord(value) {
			return typeof value === "object" && value !== null;
		}
		function isIterable(value) {
			return isRecord(value) && typeof value[Symbol.iterator] === "function";
		}
		function readBindings(service) {
			const bindings = service.bindings;
			if (!isRecord(bindings)) return [];
			try {
				const values = bindings.values;
				const records = typeof values === "function" ? Reflect.apply(values, bindings, []) : values;
				return isIterable(records) ? Array.from(records) : [];
			} catch {
				return [];
			}
		}
		function installMethod(target, key, installed) {
			const original = target[key];
			if (typeof original !== "function") return void 0;
			const descriptor = Object.getOwnPropertyDescriptor(target, key);
			try {
				Object.defineProperty(target, key, {
					configurable: descriptor?.configurable ?? true,
					enumerable: descriptor?.enumerable ?? false,
					writable: true,
					value: installed
				});
			} catch {
				return;
			}
			return {
				target,
				key,
				original,
				installed,
				descriptor
			};
		}
		function restoreMethod(method) {
			if (method.target[method.key] !== method.installed) return;
			if (method.descriptor) Object.defineProperty(method.target, method.key, method.descriptor);
			else delete method.target[method.key];
		}
		function isEnabled(patch) {
			for (const owner of patch.owners) for (const enabled of owner.checks) if (enabled()) return true;
			return false;
		}
		function patchBinding(pipeline, value) {
			if (!isRecord(value) || typeof value.publish !== "function" || typeof value.flush !== "function") return;
			let patch = patchedBindings.get(value);
			if (!patch) {
				const original = value.publish;
				let current;
				const installed = function(...args) {
					if (this !== value || !current || current.owners.size === 0 || args[0] !== "animation-frame" || !isEnabled(current) || typeof requestAnimationFrame !== "function") return Reflect.apply(original, this, args);
					if (value.frame !== void 0) return void 0;
					const pending = {
						id: requestAnimationFrame(() => {
							if (!current || current.pending !== pending || value.frame !== pending.id) return;
							current.pending = void 0;
							value.frame = void 0;
							if (!isEnabled(current)) {
								Reflect.apply(original, value, pending.args);
								return;
							}
							const flush = value.flush;
							if (typeof flush === "function") Reflect.apply(flush, value, []);
						}),
						args
					};
					current.pending = pending;
					value.frame = pending.id;
				};
				const method = installMethod(value, "publish", installed);
				if (!method) return;
				patch = {
					binding: value,
					method,
					owners: /* @__PURE__ */ new Set(),
					pending: void 0
				};
				current = patch;
				patchedBindings.set(value, patch);
			}
			patch.owners.add(pipeline);
			pipeline.bindings.add(patch);
		}
		/**
		* Optimize only animation-frame publications; all other publications stay with DSH.
		* Pass a live enabled && fastPipeline predicate and return this cleanup from ctx.inject.
		*/
		function installConversationPipeline(service, enabled) {
			if (!isRecord(service)) return () => {};
			let pipeline = pipelines.get(service);
			if (!pipeline) {
				pipeline = {
					checks: /* @__PURE__ */ new Set(),
					bindings: /* @__PURE__ */ new Set(),
					bindingMethod: void 0
				};
				pipelines.set(service, pipeline);
				const owner = pipeline;
				const original = service.binding;
				if (typeof original === "function") {
					const installed = function(...args) {
						const binding = Reflect.apply(original, this, args);
						if (owner.checks.size > 0) patchBinding(owner, binding);
						return binding;
					};
					pipeline.bindingMethod = installMethod(service, "binding", installed);
				}
			}
			const lease = () => enabled();
			pipeline.checks.add(lease);
			for (const record of readBindings(service)) if (isRecord(record)) patchBinding(pipeline, record.binding);
			const owner = pipeline;
			let active = true;
			return () => {
				if (!active) return;
				active = false;
				owner.checks.delete(lease);
				if (owner.checks.size > 0) return;
				if (owner.bindingMethod) restoreMethod(owner.bindingMethod);
				pipelines.delete(service);
				for (const patch of owner.bindings) {
					patch.owners.delete(owner);
					if (patch.owners.size > 0) continue;
					const pending = patch.pending;
					patch.pending = void 0;
					restoreMethod(patch.method);
					patchedBindings.delete(patch.binding);
					if (pending && patch.binding.frame === pending.id) {
						if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(pending.id);
						patch.binding.frame = void 0;
						Reflect.apply(patch.method.original, patch.binding, pending.args);
					}
				}
				owner.bindings.clear();
			};
		}
		//#endregion
		//#region src/client/recoverySynchronization.ts
		/** Borrow existing Session feeds; never open another stream or force a reconnect. */
		function bindRecoverySynchronization(sessions, connection) {
			const tracked = /* @__PURE__ */ new Map();
			let generation = connection.generation.getSnapshot()?.id;
			let disposed = false;
			const connected = () => connection.state.getSnapshot() === "connected" && connection.generation.getSnapshot() !== void 0;
			const wake = () => {
				queueMicrotask(() => {
					if (!disposed) notifyRecoverySynchronized();
				});
			};
			const observe = (sessionId) => {
				const binding = sessions.binding(sessionId);
				const previous = tracked.get(sessionId);
				if (previous?.binding === binding) return previous;
				previous?.dispose();
				if (binding === void 0) return void 0;
				const entry = {
					binding,
					awaitingBaseline: !connected(),
					dispose: () => {}
				};
				tracked.set(sessionId, entry);
				const offFeed = binding.eventSource.subscribe(() => {
					if (binding.eventSource.getSnapshot().change.kind !== "replace") return;
					entry.awaitingBaseline = false;
					wake();
				});
				let openState = binding.session.getSnapshot().openState;
				const offSession = binding.session.subscribe(() => {
					const next = binding.session.getSnapshot().openState;
					if (next === openState) return;
					openState = next;
					wake();
				});
				let active = true;
				entry.dispose = () => {
					if (!active) return;
					active = false;
					offFeed();
					offSession();
					if (tracked.get(sessionId) === entry) tracked.delete(sessionId);
				};
				binding.ctx.effect(() => entry.dispose, "smooth-stream: borrowed recovery feed");
				return entry;
			};
			const offFence = installRecoverySynchronization({ pending(key) {
				let sessionId;
				try {
					sessionId = JSON.parse(key)[0];
				} catch {
					return false;
				}
				if (typeof sessionId !== "string") return false;
				const entry = observe(sessionId);
				if (entry === void 0) return false;
				const openState = entry.binding.session.getSnapshot().openState;
				if (openState === "error") return false;
				return !connected() || entry.awaitingBaseline || openState === "cold" || openState === "loading";
			} });
			const connectionChanged = () => {
				const next = connection.generation.getSnapshot()?.id;
				if (!connected() || next !== generation) for (const entry of tracked.values()) entry.awaitingBaseline = true;
				generation = next;
				wake();
			};
			const offGeneration = connection.generation.subscribe(connectionChanged);
			const offState = connection.state.subscribe(connectionChanged);
			return () => {
				disposed = true;
				offGeneration();
				offState();
				for (const entry of [...tracked.values()]) entry.dispose();
				offFence();
			};
		}
		//#endregion
		//#region src/client/locales.ts
		/** Locale bundles for the smooth-stream plugin configuration card. */
		/** Dictionary namespace owned by this plugin's settings card. */
		const NS = "settings.smoothStream";
		/** English copy. */
		const en = {
			title: "Smooth stream",
			description: "How replies are revealed while they stream.",
			enabled: "Enable smooth streaming",
			enabledHint: "Let this plugin render and follow streaming replies. Turn off to use the built-in Harness renderer.",
			controlScroll: "Take over scrolling",
			controlScrollHint: "On by default; smooth-stream writes the conversation scroll position. Turn off to leave bottom-follow to Harness.",
			backgroundRecovery: "Background recovery",
			backgroundRecoveryHint: "Choose how queued text is displayed when returning to the page. Task execution is unchanged.",
			foregroundRecoveryDelay: "Foreground recovery delay (ms)",
			foregroundRecoveryDelayHint: "Wait this long after the native foreground signal before resuming text and scroll animation. Range: 0–10000 ms.",
			backgroundReplay: "Continue at normal speed",
			backgroundReplayHint: "Resume from the previous display position with small frame budgets, including completed replies.",
			backgroundCatchUp: "Bounded catch-up",
			backgroundCatchUpHint: "Catch up on each animation frame, with at most 16 characters per commit and no fixed inter-commit wait.",
			backgroundLatest: "Show latest immediately",
			backgroundLatestHint: "Skip queued character animation on return, then reveal new text normally. Existing row order is preserved.",
			motionPreference: "Motion",
			motionPreferenceHint: "How streaming responds to the system reduce-motion setting.",
			motionAuto: "Follow system",
			motionAutoHint: "Reduced-motion systems get raw text (accessibility first).",
			motionForceSmooth: "Always smooth",
			motionForceSmoothHint: "Keep the smoothing engine even when the system asks for reduced motion.",
			motionForceReduced: "Always raw",
			motionForceReducedHint: "Render raw text even when the system allows motion.",
			thinkAutoExpand: "Auto-expand thinking",
			logarithmicFade: "Logarithmic fade",
			logarithmicFadeHint: "Fade new answer and expanded thinking text into view. Follows the motion preference.",
			fastFold: "Fast fold acceleration",
			fastFoldHint: "Detach collapsed tool steps from the layout tree using display: none, eliminating reflow stutter during streaming in long conversations.",
			fastPipeline: "Fast dispatch pipeline (Heal DSH 3-frame throttle)",
			fastPipelineHint: "Bypass DSH 3-frame nested requestAnimationFrame throttle (~50ms delay per chunk) into instant native single-frame rendering, making streaming output completely responsive.",
			keepStreamOnToolCall: "Keep streaming before tool calls",
			keepStreamOnToolCallHint: "Do not end text streaming early when followed by a tool call; preserve fluid typewriter reveal.",
			thinkAutoExpandHint: "Open thinking while it streams. After returning from the background, keep it collapsed for the rest of that reply; ordinary foreground output and manual choices are unchanged. Turn off to keep automatic expansion disabled.",
			debugTuningEnabled: "Apply saved physical parameters",
			debugTuningEnabledHint: "Use your saved reveal and scroll parameters even with diagnostics hidden. Turn off to use production defaults; saved values are retained.",
			debugEnabled: "Show render diagnostics",
			debugEnabledHint: "Show live streaming and scroll metrics and edit parameters. This switch only controls diagnostics; applying parameters uses the independent switch above.",
			debugUnavailable: "Live diagnostics require a newer plugin Host.",
			debugPanelTitle: "Render diagnostics",
			debugPanelToggle: "Toggle render diagnostics",
			debugPanelClose: "Hide diagnostics panel",
			debugGuide: "Enable Apply saved physical parameters to use your tuning; hiding diagnostics does not disable it. Tune one value at a time while a reply streams. Keep FPS stable and backlog near zero. If text lags, raise the reveal multiplier, queue pressure, or maximum reveal; if a blank gap appears, reduce Predictive runway. Increase damping when the scroll feels springy. Save only after the behavior is stable; Reset restores the production defaults.",
			debugLive: "Streaming",
			debugIdle: "Idle",
			debugUnsaved: "Unsaved tuning",
			debugSave: "Save tuning",
			debugDiscard: "Discard changes",
			debugReset: "Reset tuning",
			debugCopy: "Copy diagnostics",
			debugCopied: "Copied",
			debugCaptureStart: "Start recovery capture",
			debugCaptureStopCopy: "Stop and copy recovery capture",
			debugCaptureCopied: "Recovery capture copied",
			debugCaptureHint: "Capture continues while you leave this settings page. Stop to copy the JSON.",
			debugCaptureCopyFailed: "Could not copy diagnostics. Check clipboard permission and try stopping again.",
			debugSectionLive: "Live renderer",
			debugSectionReveal: "Reveal tuning",
			debugSectionFollow: "Scroll tuning",
			debugFps: "FPS",
			debugFrameTime: "Frame",
			debugBacklog: "Backlog",
			debugRevealSpeed: "Reveal",
			debugProgress: "Progress",
			debugFollowState: "Follow",
			debugFollowing: "Pinned",
			debugReleased: "Released",
			debugLag: "Visual lag",
			debugVelocity: "Velocity",
			debugReserve: "Reserve",
			debugCapacity: "Capacity",
			debugAppliedScale: "Applied scale",
			debugRevealMultiplier: "Reveal multiplier",
			debugQueuePressure: "Queue pressure",
			debugMaxReveal: "Maximum reveal",
			debugCadenceClamp: "Cadence clamp",
			debugSpringStiffness: "Spring stiffness",
			debugSpringDamping: "Spring damping",
			debugSpringMass: "Spring mass",
			debugRunway: "Predictive runway",
			debugReserveResponse: "Runway response",
			debugBackpressureMin: "Minimum backpressure",
			debugTipRevealMultiplier: "Overall reveal speed multiplier. Higher reveals text faster and clears backlog sooner, but can feel jumpy. Lower is smoother but takes longer to finish.",
			debugTipQueuePressure: "Backlog acceleration strength. Higher catches up to a growing queue more aggressively; lower keeps speed steadier but may leave backlog.",
			debugTipMaxReveal: "Hard cap for reveal speed in characters per second. Higher allows faster catch-up; lower limits bursts and keeps motion calmer.",
			debugTipCadenceClamp: "Micro-step character limit per rendering frame (1~16). Prevents burst jumps during frame drops and maintains silky fluid pacing.",
			debugTipSpringStiffness: "Scroll spring strength. Higher closes visual lag faster but can feel sharp; lower feels softer but follows more slowly.",
			debugTipSpringDamping: "Scroll energy damping. Higher suppresses overshoot and jitter but feels heavier; lower feels livelier but may oscillate.",
			debugTipSpringMass: "Scroll inertia. Higher makes movement slower and heavier; lower makes it react faster but can feel abrupt.",
			debugTipRunway: "Caps only the extra predictive space added by this plugin while scroll control is enabled. Set to 0 to disable extra runway; lowering the value reclaims existing plugin space while preserving the reading position. Does not control native fold spacers, composer clearance, or safe-area spacing.",
			debugTipReserveResponse: "How quickly the reserved runway opens or closes. Higher changes more gradually; lower reacts faster but can look abrupt.",
			debugTipBackpressureMin: "Slowest reveal multiplier under scroll pressure. Higher keeps text moving but may increase visual lag; lower slows text more to protect smooth following.",
			readOnly: "This deployment stores settings read-only.",
			loading: "Loading plugin settings…",
			unavailable: "Plugin settings are unavailable in this connection.",
			retry: "Retry",
			version: "Version {version}",
			developmentVersion: "Development version {version}",
			updates: "Updates",
			updateHint: "Install the newest npm version, then restart Harness.",
			developmentBuild: "Linked source; updates are managed in the checkout.",
			updateUnavailable: "Updates are available only for an npm profile installation.",
			update: "Update",
			updating: "Updating…",
			restartRequired: "Updated. Restart Harness to load the new version.",
			updateFailed: "The package update failed; your current version is unchanged.",
			save: "Save",
			saving: "Saving…",
			discard: "Discard",
			unsaved: "Unsaved",
			saveFailed: "The deployment did not accept these values; they were left for you to correct."
		};
		/** Simplified Chinese copy. */
		const zh = {
			title: "丝滑流式",
			description: "回复在流式输出时如何逐字展现。",
			enabled: "启用丝滑流式渲染",
			enabledHint: "由本插件渲染并跟随流式回复；关闭后使用 Harness 内置渲染。",
			controlScroll: "接管滚动",
			controlScrollHint: "默认开启，由丝滑流式写入会话滚动位置；关闭后贴底滚动交给 Harness。",
			backgroundRecovery: "后台恢复方式",
			backgroundRecoveryHint: "返回页面时如何显示后台积压的文字；不影响任务执行。",
			foregroundRecoveryDelay: "前台恢复延迟（毫秒）",
			foregroundRecoveryDelayHint: "收到原生前台恢复信号后，等待指定时间再恢复文字与滚动动画。范围：0–10000 毫秒。",
			backgroundReplay: "正常速度续播",
			backgroundReplayHint: "从离开时的显示位置继续，小预算逐帧播放；已完成回复也不突然加速排空。",
			backgroundCatchUp: "限速追赶",
			backgroundCatchUpHint: "逐动画帧限速追赶，单次最多提交 16 字，不再额外等待固定提交间隔。",
			backgroundLatest: "直接显示最新",
			backgroundLatestHint: "返回后跳过积压文字动画，后续新文字正常吐字，保留各条记录的顺序。",
			motionPreference: "动效偏好",
			motionPreferenceHint: "流式渲染如何响应系统的「减少动态效果」设置。",
			motionAuto: "跟随系统",
			motionAutoHint: "系统开启减少动态效果时直接呈现原始文本（优先无障碍）。",
			motionForceSmooth: "始终平滑",
			motionForceSmoothHint: "即使系统要求减少动态效果，仍保持平滑流式渲染。",
			motionForceReduced: "始终原始",
			motionForceReducedHint: "即使系统允许动效，也直接呈现原始文本。",
			thinkAutoExpand: "自动展开思考",
			logarithmicFade: "对数淡入",
			logarithmicFadeHint: "让回答正文和展开的思考文字由淡变实，遵循动效偏好。",
			fastFold: "折叠彻底跳过排版（长对话极速出字）",
			fastFoldHint: "收起已完成的工具步骤时使用 display: none 彻底脱离排版树，根除长对话下出字与滚动的严重卡顿（仅失去针对收缩内容的 Ctrl+F 页面搜索）。",
			fastPipeline: "解除 DSH 官方 3 帧限制（极速吐字自愈）",
			fastPipelineHint: "DSH 官方核心写死了 3 重嵌套 requestAnimationFrame（每 50ms 仅刷新一次，长对话严重顿挫）。插件在内存中将其自愈为原生单帧极速派发，出字顺滑跟手。",
			keepStreamOnToolCall: "工具引导语保持流式",
			keepStreamOnToolCallHint: "文字后紧接工具调用时不提前宣告结束，让短引导语保持平滑打字。",
			thinkAutoExpandHint: "流式时自动展开思考；从后台恢复后，该条回复余下过程保持收起，普通前台输出和手动点开不受影响；关闭后不再自动展开。",
			debugTuningEnabled: "启用已保存的物理参数",
			debugTuningEnabledHint: "开启后使用已保存的吐字与滚动物理参数，关闭诊断面板仍然生效；关闭此开关使用默认参数，已保存数值会保留。",
			debugEnabled: "显示渲染调试面板",
			debugEnabledHint: "显示流式渲染、滚动的实时指标并编辑参数；此开关仅控制诊断，参数是否生效由上方独立开关决定。",
			debugUnavailable: "当前 Host 版本不支持实时调试，请先更新插件 Host。",
			debugPanelTitle: "渲染诊断",
			debugPanelToggle: "显示或隐藏渲染诊断",
			debugPanelClose: "收起诊断面板",
			debugGuide: "先开启“启用已保存的物理参数”使调参生效，收起诊断面板不会停用参数。流式输出时一次只调一个参数，观察帧率、积压和视觉滞后。优先保持帧率稳定、积压接近 0；如果文字滞后，提高揭示倍率、队列压力或最大揭示速度；如果底部出现空白，降低“预测预留空间”。滚动有回弹或抖动时提高阻尼。确认表现稳定后再保存；“恢复默认参数”会回到生产默认值。",
			debugLive: "正在流式输出",
			debugIdle: "空闲",
			debugUnsaved: "参数尚未保存",
			debugSave: "保存参数",
			debugDiscard: "放弃修改",
			debugReset: "恢复默认参数",
			debugCopy: "复制诊断数据",
			debugCopied: "已复制",
			debugCaptureStart: "开始捕获恢复过程",
			debugCaptureStopCopy: "停止并复制恢复诊断",
			debugCaptureCopied: "恢复诊断已复制",
			debugCaptureHint: "离开设置页后仍会继续捕获；点击停止后复制 JSON。",
			debugCaptureCopyFailed: "复制诊断失败。请检查剪贴板权限后再点停止复制。",
			debugSectionLive: "实时渲染",
			debugSectionReveal: "流式参数",
			debugSectionFollow: "滚动参数",
			debugFps: "帧率",
			debugFrameTime: "帧耗时",
			debugBacklog: "积压字符",
			debugRevealSpeed: "揭示速度",
			debugProgress: "渲染进度",
			debugFollowState: "跟随状态",
			debugFollowing: "跟随底部",
			debugReleased: "用户已释放",
			debugLag: "视觉滞后",
			debugVelocity: "滚动速度",
			debugReserve: "预留空间",
			debugCapacity: "安全容量",
			debugAppliedScale: "实际倍率",
			debugRevealMultiplier: "揭示倍率",
			debugQueuePressure: "队列压力",
			debugMaxReveal: "最大揭示速度",
			debugCadenceClamp: "单帧微步长上限",
			debugSpringStiffness: "弹簧刚度",
			debugSpringDamping: "弹簧阻尼",
			debugSpringMass: "弹簧质量",
			debugRunway: "预测预留空间",
			debugReserveResponse: "预留响应时间",
			debugBackpressureMin: "最小背压倍率",
			debugTipRevealMultiplier: "整体文字揭示速度倍率。调大能更快清空积压，但可能显得跳；调小更平滑，但完成回复需要更久。",
			debugTipQueuePressure: "积压对加速的影响强度。调大能更积极追赶增长中的队列；调小速度更稳定，但积压可能持续。",
			debugTipMaxReveal: "每秒揭示字符数上限。调大允许更快追赶；调小限制突发速度，让动作更平稳。",
			debugTipCadenceClamp: "单帧渲染最多吐出的字符数上限（Cadence Clamp，1~16 字/帧）。调小能杜绝手机掉帧时的大块蹦字感，保持极度细腻的流水感；调大在快节奏下吐字更激进。",
			debugTipSpringStiffness: "滚动弹簧刚度。调大更快收拢视觉滞后，但感觉更硬；调小更柔和，但跟随更慢。",
			debugTipSpringDamping: "滚动能量阻尼。调大能抑制过冲和抖动，但感觉更沉；调小更灵活，但可能回弹。",
			debugTipSpringMass: "滚动惯性。调大移动更慢更沉；调小反应更快，但可能显得突兀。",
			debugTipRunway: "仅限制插件额外增加的预测空间，需开启“接管滚动”才生效。设为 0 禁用额外预留；调低会回收已有插件空间，并补偿阅读位置。不会清除官方折叠占位、输入框避让或安全区间距。",
			debugTipReserveResponse: "预留空间打开或关闭的响应时间。调大变化更渐进；调小反应更快，但可能显得突变。",
			debugTipBackpressureMin: "滚动压力下允许的最低揭示倍率。调大文字仍会较快前进，但视觉滞后可能增加；调小会更积极减速，以保护跟随平滑。",
			readOnly: "本部署的设置为只读。",
			loading: "正在加载插件设置…",
			unavailable: "当前连接无法访问插件设置。",
			retry: "重试",
			version: "版本 {version}",
			developmentVersion: "开发版本 {version}",
			updates: "更新",
			updateHint: "安装最新 npm 版本后重启 Harness。",
			developmentBuild: "当前为本地链接版本，请在源码目录管理更新。",
			updateUnavailable: "只有 profile 使用 npm 包时才能更新。",
			update: "更新",
			updating: "更新中…",
			restartRequired: "已更新；重启 Harness 后加载新版本。",
			updateFailed: "包更新失败，当前版本未改变。",
			save: "保存",
			saving: "保存中…",
			discard: "放弃修改",
			unsaved: "未保存",
			saveFailed: "本部署没有接受这些值，已保留供你修改。"
		};
		//#endregion
		//#region \0dsh-css:/root/workspaces/DSH项目维护/dsh-smooth-stream-git/src/client/SmoothStreamCard.module.css.mjs
		const css$1 = "._6of8mW_card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px;flex-direction:column;list-style:none;transition:border-color .16s,background .16s;display:flex}._6of8mW_card:hover{border-color:var(--dsw-alias-label-dimmed)}._6of8mW_cardOpen{border-color:var(--dsw-alias-label-dimmed);background:var(--dsw-alias-bg-layer-2)}._6of8mW_header{appearance:none;cursor:pointer;text-align:left;width:100%;font:inherit;color:inherit;background:0 0;border:0;border-radius:12px;align-items:center;gap:12px;padding:14px 16px;display:flex}._6of8mW_header:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}._6of8mW_headText{flex-direction:column;flex:1;gap:4px;min-width:0;display:flex}._6of8mW_name{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4}._6of8mW_description{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5}._6of8mW_version{text-overflow:ellipsis;white-space:nowrap;max-width:16rem;color:var(--dsw-alias-label-tertiary);flex:none;font-size:12px;line-height:1.5;overflow:hidden}._6of8mW_pending{background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);white-space:nowrap;border-radius:999px;flex:none;padding:1px 8px;font-size:11px;font-weight:500;line-height:17px}._6of8mW_chevron{color:var(--dsw-alias-label-tertiary);flex:none;transition:transform .16s}._6of8mW_chevronOpen{transform:rotate(180deg)}._6of8mW_body{border-top:1px solid var(--dsw-alias-border-l2);flex-direction:column;margin:0 16px;padding-bottom:8px;display:flex}._6of8mW_readOnly{color:var(--dsw-alias-label-tertiary);margin:12px 0 0;font-size:12px;line-height:1.5}._6of8mW_field{flex-direction:column;gap:6px;padding:12px 0;display:flex}._6of8mW_field+._6of8mW_field{border-top:1px solid var(--dsw-alias-border-l2)}._6of8mW_fieldDisabled{opacity:.5}._6of8mW_fieldHead{justify-content:space-between;align-items:center;gap:8px;display:flex}._6of8mW_label{min-width:0;color:var(--dsw-alias-label-primary);flex:1;font-size:13px;font-weight:500;line-height:1.5}._6of8mW_toggle{width:16px;height:16px;accent-color:var(--dsw-alias-brand-primary);cursor:pointer}._6of8mW_toggle:disabled{cursor:default}._6of8mW_toggle:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}._6of8mW_choiceRow{flex-wrap:wrap;gap:6px 14px;margin:2px 0 0;padding:0;display:flex}._6of8mW_choice{color:var(--dsw-alias-label-secondary);cursor:pointer;align-items:center;gap:5px;font-size:12px;line-height:1.5;display:flex}._6of8mW_choiceInput{width:14px;height:14px;accent-color:var(--dsw-alias-brand-primary);cursor:pointer}._6of8mW_choice:has(._6of8mW_choiceInput:disabled){cursor:default;opacity:.55}._6of8mW_choiceInput:disabled{cursor:default}._6of8mW_hint{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:1.5}._6of8mW_failure{justify-content:space-between;align-items:center;gap:12px;padding:12px 0;display:flex}._6of8mW_updateRow{border-top:1px solid var(--dsw-alias-border-l2);justify-content:space-between;align-items:center;gap:12px;padding:12px 0;display:flex}._6of8mW_updateCopy{flex-direction:column;gap:4px;min-width:0;display:flex}._6of8mW_footer{border-top:1px solid var(--dsw-alias-border-l2);justify-content:flex-end;align-items:center;gap:8px;padding:12px 0 4px;display:flex}._6of8mW_failed{min-width:0;color:var(--dsw-alias-label-error);flex:1;margin:0;font-size:12px;line-height:1.5}._6of8mW_save,._6of8mW_discard,._6of8mW_update{appearance:none;font:inherit;cursor:pointer;border:1px solid #0000;border-radius:8px;padding:5px 14px;font-size:13px;line-height:1.5}._6of8mW_save{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3)}._6of8mW_discard{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);background:0 0}._6of8mW_discard:hover:not(:disabled),._6of8mW_update:hover:not(:disabled){border-color:var(--dsw-alias-label-dimmed);color:var(--dsw-alias-label-primary)}._6of8mW_update{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);background:0 0;flex:none;align-items:center;gap:6px;display:inline-flex}._6of8mW_discard:disabled,._6of8mW_save:disabled,._6of8mW_update:disabled{opacity:.4;cursor:default}._6of8mW_discard:focus-visible,._6of8mW_save:focus-visible,._6of8mW_update:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}";
		const tagId$1 = "dsh-smooth-stream/SmoothStreamCard.module.css";
		if (typeof document !== "undefined") {
			let tag = document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId$1) + "]");
			if (tag === null) {
				tag = document.createElement("style");
				tag.dataset.plugin = "dsh-smooth-stream";
				tag.dataset.pluginCss = tagId$1;
				document.head.appendChild(tag);
			}
			tag.textContent = css$1;
		}
		var SmoothStreamCard_module_css_default = {
			"header": "_6of8mW_header",
			"fieldDisabled": "_6of8mW_fieldDisabled",
			"headText": "_6of8mW_headText",
			"cardOpen": "_6of8mW_cardOpen",
			"card": "_6of8mW_card",
			"version": "_6of8mW_version",
			"label": "_6of8mW_label",
			"choiceRow": "_6of8mW_choiceRow",
			"name": "_6of8mW_name",
			"pending": "_6of8mW_pending",
			"toggle": "_6of8mW_toggle",
			"chevronOpen": "_6of8mW_chevronOpen",
			"field": "_6of8mW_field",
			"update": "_6of8mW_update",
			"footer": "_6of8mW_footer",
			"save": "_6of8mW_save",
			"discard": "_6of8mW_discard",
			"readOnly": "_6of8mW_readOnly",
			"body": "_6of8mW_body",
			"description": "_6of8mW_description",
			"choiceInput": "_6of8mW_choiceInput",
			"failure": "_6of8mW_failure",
			"choice": "_6of8mW_choice",
			"fieldHead": "_6of8mW_fieldHead",
			"hint": "_6of8mW_hint",
			"updateRow": "_6of8mW_updateRow",
			"updateCopy": "_6of8mW_updateCopy",
			"chevron": "_6of8mW_chevron",
			"failed": "_6of8mW_failed"
		};
		//#endregion
		//#region src/client/SmoothStreamCard.tsx
		/**
		* The smooth-stream plugin configuration card, rendered inside the Web
		* Settings "plugin configuration" page. Preferences are staged until the user
		* saves — the same shape as the Host-shipped cards, hand-drawn because the
		* Host cards' chrome is not exported for reuse.
		*/
		/** Render the smooth-stream card independently of the core settings namespace allowlist. */
		function SmoothStreamCard(props) {
			const { defaultOpen = false, cardController } = props;
			const [open, setOpen] = (0, react.useState)(defaultOpen);
			const cardFace = cardController ? cardController.inject() : void 0;
			const state = typeof props.useSmoothStreamCard === "function" ? props.useSmoothStreamCard((snapshot) => snapshot) : cardController ? (0, react.useSyncExternalStore)(cardController.subscribe, () => cardController.getSnapshot()) : {
				status: "ready",
				writable: true,
				dirty: false,
				saving: false,
				failed: false,
				enabled: true,
				controlScroll: true,
				motionPreference: "auto",
				backgroundRecovery: "catch-up",
				foregroundRecoveryDelayMs: 0,
				thinkAutoExpand: false,
				logarithmicFade: true,
				fastFold: true,
				fastPipeline: true,
				keepStreamOnToolCall: true,
				debugEnabled: false,
				debugTuningEnabled: false,
				debugTuning: {
					revealScale: 1,
					queuePressure: .8,
					maxRevealCps: 360,
					springStiffness: 140,
					springDamping: 24,
					springMass: 1,
					runwayPx: 32,
					reserveResponseMs: 180,
					backpressureMinScale: .5
				},
				debugAvailable: false,
				version: void 0,
				installation: "unmanaged",
				canUpgrade: false,
				upgrading: false,
				upgradeFailed: false,
				restartRequired: false
			};
			const t = typeof props.t === "function" ? props.t : ((key) => zh[key] ?? key);
			const diagnostics = (0, react.useSyncExternalStore)(debugRuntime.subscribe, debugRuntime.getSnapshot, debugRuntime.getSnapshot);
			const edit = props.edit ?? ((patch) => {
				cardFace?.edit(patch);
			});
			const save = props.save ?? (() => {
				cardFace?.save();
			});
			const discard = props.discard ?? (() => {
				cardFace?.discard();
			});
			const reload = props.reload ?? (() => {
				cardFace?.reload();
			});
			const upgrade = props.upgrade ?? (() => {
				cardFace?.upgrade();
			});
			const startCapture = () => {
				const started = debugRuntime.startDiagnostics();
				setCaptureError(!started);
			};
			const [captureError, setCaptureError] = (0, react.useState)(false);
			const stopCapture = async () => {
				const capture = debugRuntime.stopDiagnostics();
				if (capture === null) return;
				const accepted = await (0, _deepseek_ai_dsh_client_ui_primitives.writeClipboard)(JSON.stringify({
					version: state.version ?? "0.10.10",
					capture,
					tuning: state.debugTuning
				}, null, 2));
				setCaptureError(!accepted);
			};
			const blocked = !state.dirty || state.saving || state.status !== "ready";
			const versionLabel = state.version === void 0 ? null : t(state.installation === "development" ? "developmentVersion" : "version").replace("{version}", state.version);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", {
				className: open ? `${SmoothStreamCard_module_css_default.card} ${SmoothStreamCard_module_css_default.cardOpen}` : SmoothStreamCard_module_css_default.card,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
					type: "button",
					className: SmoothStreamCard_module_css_default.header,
					"aria-expanded": open,
					onClick: () => {
						setOpen(!open);
					},
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: SmoothStreamCard_module_css_default.headText,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: SmoothStreamCard_module_css_default.name,
								children: t("title")
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: SmoothStreamCard_module_css_default.description,
								children: t("description")
							})]
						}),
						versionLabel === null ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: SmoothStreamCard_module_css_default.version,
							children: versionLabel
						}),
						state.dirty ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: SmoothStreamCard_module_css_default.pending,
							children: t("unsaved")
						}) : null,
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconChevronDownOutlineRegular, { className: open ? `${SmoothStreamCard_module_css_default.chevron} ${SmoothStreamCard_module_css_default.chevronOpen}` : SmoothStreamCard_module_css_default.chevron })
					]
				}), open ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: SmoothStreamCard_module_css_default.body,
					children: [
						state.status === "loading" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: SmoothStreamCard_module_css_default.readOnly,
							role: "status",
							children: t("loading")
						}) : null,
						state.status === "unavailable" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: SmoothStreamCard_module_css_default.failure,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: SmoothStreamCard_module_css_default.readOnly,
								role: "status",
								children: t("unavailable")
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: SmoothStreamCard_module_css_default.discard,
								onClick: reload,
								children: t("retry")
							})]
						}) : null,
						state.status === "ready" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
							!state.writable ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: SmoothStreamCard_module_css_default.readOnly,
								role: "status",
								children: t("readOnly")
							}) : null,
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
								className: SmoothStreamCard_module_css_default.field,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									className: SmoothStreamCard_module_css_default.fieldHead,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: SmoothStreamCard_module_css_default.label,
										children: t("enabled")
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
										type: "checkbox",
										className: SmoothStreamCard_module_css_default.toggle,
										checked: state.enabled,
										disabled: !state.writable || state.saving,
										onChange: (event) => {
											edit({ enabled: event.target.checked });
										}
									})]
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: SmoothStreamCard_module_css_default.hint,
									children: t("enabledHint")
								})]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
								className: state.enabled ? SmoothStreamCard_module_css_default.field : `${SmoothStreamCard_module_css_default.field} ${SmoothStreamCard_module_css_default.fieldDisabled}`,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									className: SmoothStreamCard_module_css_default.fieldHead,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: SmoothStreamCard_module_css_default.label,
										children: t("controlScroll")
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
										type: "checkbox",
										className: SmoothStreamCard_module_css_default.toggle,
										checked: state.controlScroll,
										disabled: !state.writable || state.saving || !state.enabled,
										onChange: (event) => {
											edit({ controlScroll: event.target.checked });
										}
									})]
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: SmoothStreamCard_module_css_default.hint,
									children: t("controlScrollHint")
								})]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
								className: state.enabled ? SmoothStreamCard_module_css_default.field : `${SmoothStreamCard_module_css_default.field} ${SmoothStreamCard_module_css_default.fieldDisabled}`,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									className: SmoothStreamCard_module_css_default.fieldHead,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: SmoothStreamCard_module_css_default.label,
										children: t("fastFold")
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
										type: "checkbox",
										className: SmoothStreamCard_module_css_default.toggle,
										checked: state.fastFold,
										disabled: !state.writable || state.saving || !state.enabled,
										onChange: (event) => {
											edit({ fastFold: event.target.checked });
										}
									})]
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: SmoothStreamCard_module_css_default.hint,
									children: t("fastFoldHint")
								})]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
								className: state.enabled ? SmoothStreamCard_module_css_default.field : `${SmoothStreamCard_module_css_default.field} ${SmoothStreamCard_module_css_default.fieldDisabled}`,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									className: SmoothStreamCard_module_css_default.fieldHead,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: SmoothStreamCard_module_css_default.label,
										children: t("fastPipeline")
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
										type: "checkbox",
										className: SmoothStreamCard_module_css_default.toggle,
										checked: state.fastPipeline,
										disabled: !state.writable || state.saving || !state.enabled,
										onChange: (event) => {
											edit({ fastPipeline: event.target.checked });
										}
									})]
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: SmoothStreamCard_module_css_default.hint,
									children: t("fastPipelineHint")
								})]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
								className: state.enabled ? SmoothStreamCard_module_css_default.field : `${SmoothStreamCard_module_css_default.field} ${SmoothStreamCard_module_css_default.fieldDisabled}`,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									className: SmoothStreamCard_module_css_default.fieldHead,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: SmoothStreamCard_module_css_default.label,
										children: t("logarithmicFade")
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
										type: "checkbox",
										className: SmoothStreamCard_module_css_default.toggle,
										checked: state.logarithmicFade,
										disabled: !state.writable || state.saving || !state.enabled,
										onChange: (event) => {
											edit({ logarithmicFade: event.target.checked });
										}
									})]
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: SmoothStreamCard_module_css_default.hint,
									children: t("logarithmicFadeHint")
								})]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: state.enabled ? SmoothStreamCard_module_css_default.field : `${SmoothStreamCard_module_css_default.field} ${SmoothStreamCard_module_css_default.fieldDisabled}`,
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: SmoothStreamCard_module_css_default.fieldHead,
										children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: SmoothStreamCard_module_css_default.label,
											children: t("backgroundRecovery")
										})
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: SmoothStreamCard_module_css_default.hint,
										children: t("backgroundRecoveryHint")
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
										role: "radiogroup",
										"aria-label": t("backgroundRecovery"),
										children: [
											[
												"replay",
												"backgroundReplay",
												"backgroundReplayHint"
											],
											[
												"catch-up",
												"backgroundCatchUp",
												"backgroundCatchUpHint"
											],
											[
												"latest",
												"backgroundLatest",
												"backgroundLatestHint"
											]
										].map(([value, label, hint]) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
											className: SmoothStreamCard_module_css_default.choice,
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
												type: "radio",
												className: SmoothStreamCard_module_css_default.choiceInput,
												name: "smooth-stream-background-recovery",
												checked: state.backgroundRecovery === value,
												disabled: !state.writable || state.saving || !state.enabled,
												onChange: () => {
													edit({ backgroundRecovery: value });
												}
											}), t(label)]
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
											className: SmoothStreamCard_module_css_default.hint,
											children: t(hint)
										})] }, value))
									})
								]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
								className: state.enabled ? SmoothStreamCard_module_css_default.field : `${SmoothStreamCard_module_css_default.field} ${SmoothStreamCard_module_css_default.fieldDisabled}`,
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: SmoothStreamCard_module_css_default.fieldHead,
										children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: SmoothStreamCard_module_css_default.label,
											children: t("foregroundRecoveryDelay")
										})
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: SmoothStreamCard_module_css_default.hint,
										children: t("foregroundRecoveryDelayHint")
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
										type: "number",
										min: 0,
										max: 1e4,
										step: 1,
										inputMode: "numeric",
										value: state.foregroundRecoveryDelayMs,
										disabled: !state.writable || state.saving || !state.enabled,
										onChange: (event) => {
											const value = event.currentTarget.valueAsNumber;
											if (Number.isInteger(value) && value >= 0 && value <= 1e4) edit({ foregroundRecoveryDelayMs: value });
										}
									})
								]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: state.enabled ? SmoothStreamCard_module_css_default.field : `${SmoothStreamCard_module_css_default.field} ${SmoothStreamCard_module_css_default.fieldDisabled}`,
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: SmoothStreamCard_module_css_default.fieldHead,
										children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: SmoothStreamCard_module_css_default.label,
											children: t("motionPreference")
										})
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: SmoothStreamCard_module_css_default.hint,
										children: t("motionPreferenceHint")
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: SmoothStreamCard_module_css_default.choiceRow,
										role: "radiogroup",
										"aria-label": t("motionPreference"),
										children: [
											[
												"auto",
												"motionAuto",
												"motionAutoHint"
											],
											[
												"force-smooth",
												"motionForceSmooth",
												"motionForceSmoothHint"
											],
											[
												"force-reduced",
												"motionForceReduced",
												"motionForceReducedHint"
											]
										].map(([value, label, hint]) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
											className: SmoothStreamCard_module_css_default.choice,
											title: t(hint),
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
												type: "radio",
												className: SmoothStreamCard_module_css_default.choiceInput,
												name: "smooth-stream-motion",
												checked: state.motionPreference === value,
												disabled: !state.writable || state.saving || !state.enabled,
												onChange: () => {
													edit({ motionPreference: value });
												}
											}), t(label)]
										}, value))
									})
								]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
								className: state.enabled ? SmoothStreamCard_module_css_default.field : `${SmoothStreamCard_module_css_default.field} ${SmoothStreamCard_module_css_default.fieldDisabled}`,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									className: SmoothStreamCard_module_css_default.fieldHead,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: SmoothStreamCard_module_css_default.label,
										children: t("thinkAutoExpand")
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
										type: "checkbox",
										className: SmoothStreamCard_module_css_default.toggle,
										checked: state.thinkAutoExpand,
										disabled: !state.writable || state.saving || !state.enabled,
										onChange: (event) => {
											edit({ thinkAutoExpand: event.target.checked });
										}
									})]
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: SmoothStreamCard_module_css_default.hint,
									children: t("thinkAutoExpandHint")
								})]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
								className: state.enabled ? SmoothStreamCard_module_css_default.field : `${SmoothStreamCard_module_css_default.field} ${SmoothStreamCard_module_css_default.fieldDisabled}`,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									className: SmoothStreamCard_module_css_default.fieldHead,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: SmoothStreamCard_module_css_default.label,
										children: t("keepStreamOnToolCall")
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
										type: "checkbox",
										className: SmoothStreamCard_module_css_default.toggle,
										checked: state.keepStreamOnToolCall,
										disabled: !state.writable || state.saving || !state.enabled,
										onChange: (event) => {
											edit({ keepStreamOnToolCall: event.target.checked });
										}
									})]
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: SmoothStreamCard_module_css_default.hint,
									children: t("keepStreamOnToolCallHint")
								})]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
								className: state.debugAvailable ? SmoothStreamCard_module_css_default.field : `${SmoothStreamCard_module_css_default.field} ${SmoothStreamCard_module_css_default.fieldDisabled}`,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									className: SmoothStreamCard_module_css_default.fieldHead,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: SmoothStreamCard_module_css_default.label,
										children: t("debugTuningEnabled")
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
										type: "checkbox",
										className: SmoothStreamCard_module_css_default.toggle,
										checked: state.debugTuningEnabled,
										disabled: !state.debugAvailable || !state.writable || state.saving,
										onChange: (event) => {
											edit({ debugTuningEnabled: event.target.checked });
										}
									})]
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: SmoothStreamCard_module_css_default.hint,
									children: t("debugTuningEnabledHint")
								})]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
								className: state.debugAvailable ? SmoothStreamCard_module_css_default.field : `${SmoothStreamCard_module_css_default.field} ${SmoothStreamCard_module_css_default.fieldDisabled}`,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									className: SmoothStreamCard_module_css_default.fieldHead,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: SmoothStreamCard_module_css_default.label,
										children: t("debugEnabled")
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
										type: "checkbox",
										className: SmoothStreamCard_module_css_default.toggle,
										checked: state.debugEnabled,
										disabled: !state.debugAvailable || !state.writable || state.saving,
										onChange: (event) => {
											edit({ debugEnabled: event.target.checked });
										}
									})]
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: SmoothStreamCard_module_css_default.hint,
									children: state.debugAvailable ? t("debugEnabledHint") : t("debugUnavailable")
								})]
							}),
							state.status === "ready" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: SmoothStreamCard_module_css_default.field,
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
										className: SmoothStreamCard_module_css_default.fieldHead,
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: SmoothStreamCard_module_css_default.label,
											children: t(diagnostics.diagnosticActive ? "debugCaptureStopCopy" : "debugCaptureStart")
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
											type: "button",
											className: diagnostics.diagnosticActive ? SmoothStreamCard_module_css_default.discard : SmoothStreamCard_module_css_default.save,
											onClick: () => {
												diagnostics.diagnosticActive ? stopCapture() : startCapture();
											},
											children: t(diagnostics.diagnosticActive ? "debugCaptureStopCopy" : "debugCaptureStart")
										})]
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: SmoothStreamCard_module_css_default.hint,
										children: t("debugCaptureHint")
									}),
									captureError ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: SmoothStreamCard_module_css_default.failed,
										role: "status",
										children: t("debugCaptureCopyFailed")
									}) : null
								]
							}) : null,
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: SmoothStreamCard_module_css_default.updateRow,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									className: SmoothStreamCard_module_css_default.updateCopy,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: SmoothStreamCard_module_css_default.label,
										children: t("updates")
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: SmoothStreamCard_module_css_default.hint,
										children: state.restartRequired ? t("restartRequired") : state.installation === "npm" ? t("updateHint") : state.installation === "development" ? t("developmentBuild") : t("updateUnavailable")
									})]
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
									type: "button",
									className: SmoothStreamCard_module_css_default.update,
									disabled: !state.canUpgrade || state.upgrading || state.restartRequired,
									title: state.canUpgrade ? void 0 : t("updateUnavailable"),
									onClick: upgrade,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										"aria-hidden": "true",
										children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconRefreshOutlineRegular, {})
									}), t(state.upgrading ? "updating" : "update")]
								})]
							}),
							state.upgradeFailed ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: SmoothStreamCard_module_css_default.failed,
								role: "status",
								children: t("updateFailed")
							}) : null,
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: SmoothStreamCard_module_css_default.footer,
								children: [
									state.failed ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
										className: SmoothStreamCard_module_css_default.failed,
										role: "status",
										children: t("saveFailed")
									}) : null,
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: SmoothStreamCard_module_css_default.discard,
										disabled: !state.dirty || state.saving,
										onClick: discard,
										children: t("discard")
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: SmoothStreamCard_module_css_default.save,
										disabled: blocked,
										onClick: save,
										children: t(state.saving ? "saving" : "save")
									})
								]
							})
						] }) : null
					]
				}) : null]
			});
		}
		//#endregion
		//#region src/client/smooth-stream-card-controller.ts
		/** Staged form state for the plugin-owned smooth-stream settings RPC. */
		/** Bridges the plugin's protected Host interface onto a staged settings form. */
		var SmoothStreamCardController = class {
			api;
			store = createSnapshotStore(this.projection());
			loaded;
			loadedDebug;
			stagedBase;
			stagedDebug;
			saving = false;
			failed = false;
			upgrading = false;
			upgradeFailed = false;
			restartRequired = false;
			loadGeneration = 0;
			loadStatus = "loading";
			constructor(api) {
				this.api = api;
			}
			/** Begin the background read after the card has been registered. */
			start() {
				this.load();
			}
			/** Ignore a late response after the surrounding optional services unload. */
			stop() {
				this.loadGeneration += 1;
			}
			/** Current card snapshot, also consumed by the streaming preference cell. */
			getSnapshot() {
				return this.store.getSnapshot();
			}
			/** Subscribe to state changes. */
			subscribe(listener) {
				return this.store.subscribe(listener);
			}
			/** Build the face consumed by the settings slot renderer. */
			inject() {
				return {
					hooks: { smoothStreamCard: this.store },
					edit: (patch) => {
						if (this.saving) return;
						if (patch.enabled !== void 0 || patch.controlScroll !== void 0 || patch.motionPreference !== void 0 || patch.backgroundRecovery !== void 0 || patch.foregroundRecoveryDelayMs !== void 0 || patch.thinkAutoExpand !== void 0 || patch.logarithmicFade !== void 0 || patch.fastFold !== void 0 || patch.fastPipeline !== void 0 || patch.keepStreamOnToolCall !== void 0) this.stagedBase = {
							...this.baseValues(),
							...patch.enabled === void 0 ? {} : { enabled: patch.enabled },
							...patch.controlScroll === void 0 ? {} : { controlScroll: patch.controlScroll },
							...patch.motionPreference === void 0 ? {} : { motionPreference: patch.motionPreference },
							...patch.backgroundRecovery === void 0 ? {} : { backgroundRecovery: patch.backgroundRecovery },
							...patch.foregroundRecoveryDelayMs === void 0 ? {} : { foregroundRecoveryDelayMs: patch.foregroundRecoveryDelayMs },
							...patch.thinkAutoExpand === void 0 ? {} : { thinkAutoExpand: patch.thinkAutoExpand },
							...patch.logarithmicFade === void 0 ? {} : { logarithmicFade: patch.logarithmicFade },
							...patch.fastFold === void 0 ? {} : { fastFold: patch.fastFold },
							...patch.fastPipeline === void 0 ? {} : { fastPipeline: patch.fastPipeline },
							...patch.keepStreamOnToolCall === void 0 ? {} : { keepStreamOnToolCall: patch.keepStreamOnToolCall }
						};
						if (this.loadedDebug !== void 0 && (patch.debugEnabled !== void 0 || patch.debugTuningEnabled !== void 0 || patch.debugTuning !== void 0)) this.stagedDebug = {
							...this.debugValues(),
							...patch.debugEnabled === void 0 ? {} : { debugEnabled: patch.debugEnabled },
							...patch.debugTuningEnabled === void 0 ? {} : { debugTuningEnabled: patch.debugTuningEnabled },
							...patch.debugTuning === void 0 ? {} : { debugTuning: {
								...this.debugValues().debugTuning,
								...patch.debugTuning
							} }
						};
						this.failed = false;
						this.publish();
					},
					save: () => {
						this.save();
					},
					discard: () => {
						if (this.stagedBase === void 0 && this.stagedDebug === void 0 && !this.failed) return;
						this.stagedBase = void 0;
						this.stagedDebug = void 0;
						this.failed = false;
						this.publish();
					},
					reload: () => {
						this.load();
					},
					upgrade: () => {
						this.upgrade();
					}
				};
			}
			projection() {
				return {
					status: this.loadStatus,
					writable: this.loaded?.writable ?? false,
					dirty: this.stagedBase !== void 0 || this.stagedDebug !== void 0,
					saving: this.saving,
					failed: this.failed,
					...this.baseValues(),
					...this.debugValues(),
					debugAvailable: this.loadedDebug !== void 0,
					version: this.loaded?.version,
					installation: this.loaded?.installation ?? "unmanaged",
					canUpgrade: this.loaded?.canUpgrade ?? false,
					upgrading: this.upgrading,
					upgradeFailed: this.upgradeFailed,
					restartRequired: this.restartRequired
				};
			}
			baseValues() {
				return this.stagedBase ?? {
					enabled: this.loaded?.enabled ?? DEFAULT_STREAM_SETTINGS.enabled,
					controlScroll: this.loaded?.controlScroll ?? DEFAULT_STREAM_SETTINGS.controlScroll,
					motionPreference: this.loaded?.motionPreference ?? DEFAULT_STREAM_SETTINGS.motionPreference,
					backgroundRecovery: this.loaded?.backgroundRecovery ?? DEFAULT_STREAM_SETTINGS.backgroundRecovery,
					foregroundRecoveryDelayMs: this.loaded?.foregroundRecoveryDelayMs ?? DEFAULT_STREAM_SETTINGS.foregroundRecoveryDelayMs,
					thinkAutoExpand: this.loaded?.thinkAutoExpand ?? DEFAULT_STREAM_SETTINGS.thinkAutoExpand,
					logarithmicFade: this.loaded?.logarithmicFade ?? DEFAULT_STREAM_SETTINGS.logarithmicFade,
					fastFold: this.loaded?.fastFold ?? DEFAULT_STREAM_SETTINGS.fastFold,
					fastPipeline: this.loaded?.fastPipeline ?? DEFAULT_STREAM_SETTINGS.fastPipeline,
					keepStreamOnToolCall: this.loaded?.keepStreamOnToolCall ?? DEFAULT_STREAM_SETTINGS.keepStreamOnToolCall
				};
			}
			debugValues() {
				return this.stagedDebug ?? {
					debugEnabled: this.loadedDebug?.debugEnabled ?? DEFAULT_STREAM_SETTINGS.debugEnabled,
					debugTuningEnabled: this.loadedDebug?.debugTuningEnabled ?? DEFAULT_STREAM_SETTINGS.debugTuningEnabled,
					debugTuning: this.loadedDebug?.tuning ?? DEFAULT_STREAM_DEBUG_TUNING
				};
			}
			/** Complete settings projection consumed by the live SettingsCell bridge. */
			values() {
				return {
					...this.baseValues(),
					...this.debugValues()
				};
			}
			async load() {
				const generation = ++this.loadGeneration;
				this.loadStatus = "loading";
				this.loaded = void 0;
				this.loadedDebug = void 0;
				this.publish();
				try {
					const view = await this.api.read();
					if (generation !== this.loadGeneration) return;
					this.loaded = view;
					this.loadStatus = "ready";
					this.publish();
					try {
						const debug = await this.api.readDebug();
						if (generation !== this.loadGeneration) return;
						this.loadedDebug = debug;
					} catch {
						if (generation !== this.loadGeneration) return;
						this.loadedDebug = void 0;
					}
				} catch {
					if (generation !== this.loadGeneration) return;
					let fallback = {
						enabled: true,
						controlScroll: true,
						motionPreference: "auto",
						backgroundRecovery: DEFAULT_STREAM_SETTINGS.backgroundRecovery,
						foregroundRecoveryDelayMs: DEFAULT_STREAM_SETTINGS.foregroundRecoveryDelayMs,
						thinkAutoExpand: DEFAULT_STREAM_SETTINGS.thinkAutoExpand,
						logarithmicFade: DEFAULT_STREAM_SETTINGS.logarithmicFade,
						fastFold: DEFAULT_STREAM_SETTINGS.fastFold,
						fastPipeline: DEFAULT_STREAM_SETTINGS.fastPipeline,
						keepStreamOnToolCall: DEFAULT_STREAM_SETTINGS.keepStreamOnToolCall,
						debugEnabled: DEFAULT_STREAM_SETTINGS.debugEnabled
					};
					try {
						const saved = typeof localStorage !== "undefined" ? localStorage.getItem("dsh-smooth-stream:settings") : null;
						if (saved) Object.assign(fallback, JSON.parse(saved));
					} catch {}
					this.loaded = {
						version: "0.10.10",
						installation: "development",
						writable: true,
						enabled: fallback.enabled,
						controlScroll: fallback.controlScroll,
						motionPreference: fallback.motionPreference,
						backgroundRecovery: fallback.backgroundRecovery,
						foregroundRecoveryDelayMs: fallback.foregroundRecoveryDelayMs,
						thinkAutoExpand: fallback.thinkAutoExpand,
						logarithmicFade: fallback.logarithmicFade,
						fastFold: fallback.fastFold,
						fastPipeline: fallback.fastPipeline,
						keepStreamOnToolCall: fallback.keepStreamOnToolCall,
						canUpgrade: false
					};
					this.loadStatus = "ready";
				}
				this.publish();
			}
			async save() {
				if (this.stagedBase === void 0 && this.stagedDebug === void 0 || this.saving || this.loaded?.writable !== true) return;
				const base = this.stagedBase;
				const debug = this.stagedDebug;
				this.saving = true;
				this.failed = false;
				this.publish();
				try {
					if (base !== void 0) {
						const combined = debug !== void 0 && this.loadedDebug !== void 0;
						this.loaded = await this.api.write(combined ? {
							...base,
							...debug
						} : base);
						this.stagedBase = void 0;
						if (combined) {
							this.loadedDebug = {
								debugEnabled: debug.debugEnabled,
								debugTuningEnabled: debug.debugTuningEnabled,
								tuning: { ...debug.debugTuning }
							};
							this.stagedDebug = void 0;
						}
					}
					if (debug !== void 0 && this.loadedDebug !== void 0 && this.stagedDebug !== void 0) {
						this.loadedDebug = await this.api.writeDebug(debug);
						this.stagedDebug = void 0;
					}
				} catch {
					this.failed = true;
				}
				this.saving = false;
				this.publish();
			}
			async upgrade() {
				if (this.loaded?.canUpgrade !== true || this.upgrading) return;
				this.upgrading = true;
				this.upgradeFailed = false;
				this.restartRequired = false;
				this.publish();
				try {
					const result = await this.api.upgrade();
					this.restartRequired = result.restartRequired;
				} catch {
					this.upgradeFailed = true;
				}
				this.upgrading = false;
				this.publish();
			}
			publish() {
				this.store.set(this.projection());
			}
		};
		//#endregion
		//#region src/settings-api.ts
		/** Shared wire vocabulary for the plugin-owned settings RPC channel. */
		/** Dedicated, loopback-only RPC channel registered by the Host half. */
		const STREAM_SETTINGS_RPC_CHANNEL = "/smooth-stream";
		/** Endpoints accepted by {@link STREAM_SETTINGS_RPC_CHANNEL}. */
		const STREAM_SETTINGS_RPC = {
			read: "settings.read",
			write: "settings.write",
			debugRead: "debug.read",
			debugWrite: "debug.write",
			upgrade: "plugin.upgrade"
		};
		//#endregion
		//#region src/client/smooth-stream-settings-api.ts
		function record(value) {
			return typeof value === "object" && value !== null && !Array.isArray(value) ? value : void 0;
		}
		function settingsView(value) {
			const data = record(value);
			if (data === void 0 || typeof data.version !== "string" || ![
				"npm",
				"development",
				"unmanaged"
			].includes(data.installation) || typeof data.writable !== "boolean" || typeof data.enabled !== "boolean" || typeof data.controlScroll !== "boolean" || ![
				"auto",
				"force-smooth",
				"force-reduced"
			].includes(data.motionPreference) || data.backgroundRecovery !== void 0 && ![
				"replay",
				"catch-up",
				"latest"
			].includes(data.backgroundRecovery) || data.foregroundRecoveryDelayMs !== void 0 && (typeof data.foregroundRecoveryDelayMs !== "number" || !Number.isInteger(data.foregroundRecoveryDelayMs) || data.foregroundRecoveryDelayMs < 0 || data.foregroundRecoveryDelayMs > 1e4) || typeof data.thinkAutoExpand !== "boolean" || data.logarithmicFade !== void 0 && typeof data.logarithmicFade !== "boolean" || data.keepStreamOnToolCall !== void 0 && typeof data.keepStreamOnToolCall !== "boolean" || typeof data.canUpgrade !== "boolean") throw new Error("dsh-smooth-stream: malformed settings response");
			return {
				...data,
				backgroundRecovery: data.backgroundRecovery ?? DEFAULT_STREAM_SETTINGS.backgroundRecovery,
				foregroundRecoveryDelayMs: data.foregroundRecoveryDelayMs ?? DEFAULT_STREAM_SETTINGS.foregroundRecoveryDelayMs,
				logarithmicFade: data.logarithmicFade ?? DEFAULT_STREAM_SETTINGS.logarithmicFade,
				fastFold: data.fastFold ?? DEFAULT_STREAM_SETTINGS.fastFold,
				fastPipeline: data.fastPipeline ?? DEFAULT_STREAM_SETTINGS.fastPipeline,
				keepStreamOnToolCall: data.keepStreamOnToolCall ?? DEFAULT_STREAM_SETTINGS.keepStreamOnToolCall
			};
		}
		function upgradeView(value) {
			if (record(value)?.restartRequired !== true) throw new Error("dsh-smooth-stream: malformed update response");
			return { restartRequired: true };
		}
		function debugSettingsView(value) {
			const data = record(value);
			const tuning = record(data?.tuning);
			if (data === void 0 || typeof data.debugEnabled !== "boolean" || data.debugTuningEnabled !== void 0 && typeof data.debugTuningEnabled !== "boolean" || tuning === void 0 || typeof tuning.revealScale !== "number" || typeof tuning.queuePressure !== "number" || typeof tuning.maxRevealCps !== "number" || tuning.cadenceClamp !== void 0 && typeof tuning.cadenceClamp !== "number" || typeof tuning.springStiffness !== "number" || typeof tuning.springDamping !== "number" || typeof tuning.springMass !== "number" || typeof tuning.runwayPx !== "number" || typeof tuning.reserveResponseMs !== "number" || typeof tuning.backpressureMinScale !== "number") throw new Error("dsh-smooth-stream: malformed debug settings response");
			return {
				debugEnabled: data.debugEnabled,
				debugTuningEnabled: data.debugTuningEnabled ?? data.debugEnabled,
				tuning: {
					...tuning,
					cadenceClamp: tuning.cadenceClamp ?? DEFAULT_STREAM_DEBUG_TUNING.cadenceClamp
				}
			};
		}
		function accepted(result) {
			if (!result.ok) throw new Error(result.error.message);
			return result.value;
		}
		/** Build the typed facade over the generic Connection RPC service. */
		function createSmoothStreamSettingsApi(connection) {
			return {
				async read() {
					return settingsView(accepted(await connection.rpc.call(STREAM_SETTINGS_RPC_CHANNEL, STREAM_SETTINGS_RPC.read, {})));
				},
				async write(settings) {
					return settingsView(accepted(await connection.rpc.call(STREAM_SETTINGS_RPC_CHANNEL, STREAM_SETTINGS_RPC.write, {
						enabled: settings.enabled,
						controlScroll: settings.controlScroll,
						motionPreference: settings.motionPreference,
						backgroundRecovery: settings.backgroundRecovery,
						foregroundRecoveryDelayMs: settings.foregroundRecoveryDelayMs,
						thinkAutoExpand: settings.thinkAutoExpand,
						logarithmicFade: settings.logarithmicFade,
						fastFold: settings.fastFold,
						fastPipeline: settings.fastPipeline,
						keepStreamOnToolCall: settings.keepStreamOnToolCall,
						...settings.debugEnabled === void 0 ? {} : { debugEnabled: settings.debugEnabled },
						...settings.debugTuningEnabled === void 0 ? {} : { debugTuningEnabled: settings.debugTuningEnabled },
						...settings.debugTuning === void 0 ? {} : { debugTuning: settings.debugTuning }
					})));
				},
				async readDebug() {
					return debugSettingsView(accepted(await connection.rpc.call(STREAM_SETTINGS_RPC_CHANNEL, STREAM_SETTINGS_RPC.debugRead, {})));
				},
				async writeDebug(settings) {
					return debugSettingsView(accepted(await connection.rpc.call(STREAM_SETTINGS_RPC_CHANNEL, STREAM_SETTINGS_RPC.debugWrite, {
						debugEnabled: settings.debugEnabled,
						debugTuningEnabled: settings.debugTuningEnabled,
						tuning: settings.debugTuning
					})));
				},
				async upgrade() {
					return upgradeView(accepted(await connection.rpc.call(STREAM_SETTINGS_RPC_CHANNEL, STREAM_SETTINGS_RPC.upgrade, {})));
				}
			};
		}
		//#endregion
		//#region \0dsh-css:/root/workspaces/DSH项目维护/dsh-smooth-stream-git/src/client/DebugPanel.module.css.mjs
		const css = ".z4TeJG_trigger,.z4TeJG_iconButton{appearance:none;width:32px;height:32px;color:var(--dsw-alias-label-tertiary);cursor:pointer;background:0 0;border:1px solid #0000;border-radius:6px;justify-content:center;align-items:center;padding:0;display:inline-flex}.z4TeJG_trigger:hover,.z4TeJG_iconButton:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}.z4TeJG_iconButton:disabled{opacity:.45;cursor:not-allowed}.z4TeJG_triggerActive{border-color:var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-state-business-primary)}.z4TeJG_trigger:focus-visible,.z4TeJG_iconButton:focus-visible,.z4TeJG_secondaryButton:focus-visible,.z4TeJG_primaryButton:focus-visible,.z4TeJG_number:focus-visible,.z4TeJG_range:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}.z4TeJG_panel{z-index:30;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);width:min(328px,100vw - 32px);min-height:280px;box-shadow:0 12px 32px color-mix(in srgb, var(--dsw-alias-label-primary) 14%, transparent);color:var(--dsw-alias-label-primary);border-radius:8px;flex-direction:column;display:flex;position:fixed;top:88px;bottom:16px;right:16px;overflow:hidden}.z4TeJG_panelHeader{border-bottom:1px solid var(--dsw-alias-border-l2);flex:none;align-items:center;gap:8px;min-height:48px;padding:0 8px 0 14px;display:flex}.z4TeJG_statusDot{background:var(--dsw-alias-label-caption);border-radius:50%;flex:none;width:7px;height:7px}.z4TeJG_statusLive{background:var(--dsw-alias-state-success-primary);box-shadow:0 0 0 3px color-mix(in srgb, var(--dsw-alias-state-success-primary) 15%, transparent)}.z4TeJG_title{text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0;font-size:14px;font-weight:600;line-height:20px;overflow:hidden}.z4TeJG_state,.z4TeJG_unsaved{color:var(--dsw-alias-label-tertiary);white-space:nowrap;flex:none;font-size:10px;line-height:16px}.z4TeJG_unsaved{color:var(--dsw-alias-state-warn-primary)}.z4TeJG_scrollArea{overscroll-behavior:contain;min-height:0;overflow-y:auto}.z4TeJG_section{padding:14px}.z4TeJG_guide{border-bottom:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-tertiary);margin:0;padding:12px 14px;font-size:11px;line-height:1.55}.z4TeJG_section+.z4TeJG_section{border-top:1px solid var(--dsw-alias-border-l2)}.z4TeJG_section h2{color:var(--dsw-alias-label-secondary);margin:0 0 10px;font-size:12px;font-weight:600;line-height:18px}.z4TeJG_metrics{grid-template-columns:repeat(2,minmax(0,1fr));gap:0 16px;margin:0;display:grid}.z4TeJG_metric{border-bottom:1px solid color-mix(in srgb, var(--dsw-alias-border-l2) 65%, transparent);justify-content:space-between;align-items:baseline;gap:8px;min-width:0;padding:5px 0;display:flex}.z4TeJG_metric dt{min-width:0;color:var(--dsw-alias-label-tertiary);text-overflow:ellipsis;white-space:nowrap;font-size:11px;line-height:16px;overflow:hidden}.z4TeJG_metric dd{min-width:0;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums;text-overflow:ellipsis;white-space:nowrap;margin:0;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;line-height:16px;overflow:hidden}.z4TeJG_metric dd[data-tone=good]{color:var(--dsw-alias-state-success-primary)}.z4TeJG_metric dd[data-tone=warn]{color:var(--dsw-alias-state-warn-primary)}.z4TeJG_control{flex-direction:column;gap:5px;padding:6px 0;display:flex}.z4TeJG_controlHead{color:var(--dsw-alias-label-secondary);justify-content:space-between;align-items:center;gap:10px;font-size:11px;line-height:18px;display:flex}.z4TeJG_controlLabel{align-items:center;gap:4px;min-width:0;display:inline-flex}.z4TeJG_infoButton{appearance:none;width:20px;height:20px;color:var(--dsw-alias-label-tertiary);cursor:help;background:0 0;border:0;border-radius:50%;justify-content:center;align-items:center;padding:0;display:inline-flex}.z4TeJG_infoButton:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}.z4TeJG_infoButton:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}.z4TeJG_numberWrap{flex:none;align-items:center;gap:4px;display:inline-flex}.z4TeJG_number{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);width:68px;height:26px;color:var(--dsw-alias-label-primary);font:inherit;font-variant-numeric:tabular-nums;text-align:right;border-radius:5px;padding:2px 6px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}.z4TeJG_unit{width:30px;color:var(--dsw-alias-label-tertiary);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:10px}.z4TeJG_range{width:100%;height:18px;accent-color:var(--dsw-alias-state-business-primary);cursor:pointer;margin:0}.z4TeJG_range:disabled,.z4TeJG_number:disabled{opacity:.5;cursor:default}.z4TeJG_footer{border-top:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);flex:none;align-items:center;gap:6px;min-height:50px;padding:8px 10px;display:flex}.z4TeJG_footerSpacer{flex:1}.z4TeJG_secondaryButton,.z4TeJG_primaryButton{appearance:none;border:1px solid var(--dsw-alias-border-l2);min-height:30px;color:var(--dsw-alias-label-secondary);font:inherit;cursor:pointer;background:0 0;border-radius:6px;justify-content:center;align-items:center;gap:5px;padding:4px 9px;font-size:11px;line-height:18px;display:inline-flex}.z4TeJG_primaryButton{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3);border-color:#0000}.z4TeJG_secondaryButton:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed)}.z4TeJG_secondaryButton:disabled,.z4TeJG_primaryButton:disabled{opacity:.4;cursor:default}.z4TeJG_visuallyHidden{clip:rect(0 0 0 0);clip-path:inset(50%);white-space:nowrap;border:0;width:1px;height:1px;margin:-1px;padding:0;position:absolute;overflow:hidden}@media (width<=900px){.z4TeJG_trigger,.z4TeJG_iconButton{width:44px;height:44px}.z4TeJG_panel{top:auto;right:12px;bottom:max(12px, env(safe-area-inset-bottom));width:auto;max-height:min(70dvh,640px);left:12px}.z4TeJG_secondaryButton,.z4TeJG_primaryButton{min-height:44px}}@media (prefers-reduced-motion:reduce){.z4TeJG_statusLive{box-shadow:none}}";
		const tagId = "dsh-smooth-stream/DebugPanel.module.css";
		if (typeof document !== "undefined") {
			let tag = document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]");
			if (tag === null) {
				tag = document.createElement("style");
				tag.dataset.plugin = "dsh-smooth-stream";
				tag.dataset.pluginCss = tagId;
				document.head.appendChild(tag);
			}
			tag.textContent = css;
		}
		var DebugPanel_module_css_default = {
			"statusDot": "z4TeJG_statusDot",
			"infoButton": "z4TeJG_infoButton",
			"footerSpacer": "z4TeJG_footerSpacer",
			"secondaryButton": "z4TeJG_secondaryButton",
			"panel": "z4TeJG_panel",
			"panelHeader": "z4TeJG_panelHeader",
			"controlHead": "z4TeJG_controlHead",
			"numberWrap": "z4TeJG_numberWrap",
			"iconButton": "z4TeJG_iconButton",
			"unsaved": "z4TeJG_unsaved",
			"control": "z4TeJG_control",
			"triggerActive": "z4TeJG_triggerActive",
			"statusLive": "z4TeJG_statusLive",
			"metrics": "z4TeJG_metrics",
			"primaryButton": "z4TeJG_primaryButton",
			"unit": "z4TeJG_unit",
			"section": "z4TeJG_section",
			"range": "z4TeJG_range",
			"title": "z4TeJG_title",
			"state": "z4TeJG_state",
			"footer": "z4TeJG_footer",
			"scrollArea": "z4TeJG_scrollArea",
			"guide": "z4TeJG_guide",
			"visuallyHidden": "z4TeJG_visuallyHidden",
			"controlLabel": "z4TeJG_controlLabel",
			"number": "z4TeJG_number",
			"metric": "z4TeJG_metric",
			"trigger": "z4TeJG_trigger"
		};
		//#endregion
		//#region src/client/DebugPanel.tsx
		const REVEAL_CONTROLS = [
			{
				key: "revealScale",
				label: "debugRevealMultiplier",
				tip: "debugTipRevealMultiplier",
				min: .25,
				max: 2,
				step: .05,
				unit: "x"
			},
			{
				key: "queuePressure",
				label: "debugQueuePressure",
				tip: "debugTipQueuePressure",
				min: 0,
				max: 2,
				step: .05,
				unit: "x"
			},
			{
				key: "maxRevealCps",
				label: "debugMaxReveal",
				tip: "debugTipMaxReveal",
				min: 120,
				max: 1e3,
				step: 10,
				unit: "cps"
			},
			{
				key: "cadenceClamp",
				label: "debugCadenceClamp",
				tip: "debugTipCadenceClamp",
				min: 1,
				max: 16,
				step: 1,
				unit: "字/帧"
			}
		];
		const FOLLOW_CONTROLS = [
			{
				key: "springStiffness",
				label: "debugSpringStiffness",
				tip: "debugTipSpringStiffness",
				min: 40,
				max: 320,
				step: 5,
				unit: ""
			},
			{
				key: "springDamping",
				label: "debugSpringDamping",
				tip: "debugTipSpringDamping",
				min: 8,
				max: 80,
				step: 1,
				unit: ""
			},
			{
				key: "springMass",
				label: "debugSpringMass",
				tip: "debugTipSpringMass",
				min: .5,
				max: 3,
				step: .05,
				unit: ""
			},
			{
				key: "runwayPx",
				label: "debugRunway",
				tip: "debugTipRunway",
				min: 0,
				max: 120,
				step: 2,
				unit: "px"
			},
			{
				key: "reserveResponseMs",
				label: "debugReserveResponse",
				tip: "debugTipReserveResponse",
				min: 60,
				max: 600,
				step: 10,
				unit: "ms"
			},
			{
				key: "backpressureMinScale",
				label: "debugBackpressureMin",
				tip: "debugTipBackpressureMin",
				min: .25,
				max: 1,
				step: .05,
				unit: "x"
			}
		];
		function fixed(value, digits = 1) {
			return value === null || !Number.isFinite(value) ? "-" : value.toFixed(digits);
		}
		function Metric({ label, value, tone }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: DebugPanel_module_css_default.metric,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dt", { children: label }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("dd", {
					"data-tone": tone,
					children: value
				})]
			});
		}
		function TuningField({ control, state, edit, label, t }) {
			const [showTip, setShowTip] = (0, react.useState)(false);
			const value = state.tuning[control.key];
			const labelId = `smooth-stream-debug-${control.key}`;
			const update = (next) => {
				if (!Number.isFinite(next)) return;
				const clamped = Math.min(control.max, Math.max(control.min, next));
				edit({ debugTuning: {
					...state.tuning,
					[control.key]: clamped
				} });
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: DebugPanel_module_css_default.control,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
						className: DebugPanel_module_css_default.controlHead,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: DebugPanel_module_css_default.controlLabel,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								id: labelId,
								children: label
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tooltip, {
								label: t(control.tip),
								side: "right",
								maxWidth: 300,
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									className: DebugPanel_module_css_default.infoButton,
									type: "button",
									"aria-label": label,
									title: t(control.tip),
									onClick: (e) => {
										e.stopPropagation();
										setShowTip((s) => !s);
									},
									children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconQuestionOutlineRegular, {})
								})
							})]
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: DebugPanel_module_css_default.numberWrap,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								className: DebugPanel_module_css_default.number,
								type: "number",
								"aria-labelledby": labelId,
								min: control.min,
								max: control.max,
								step: control.step,
								value,
								disabled: !state.writable,
								onChange: (event) => {
									update(event.currentTarget.valueAsNumber);
								}
							}), control.unit === "" ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: DebugPanel_module_css_default.unit,
								children: control.unit
							})]
						})]
					}),
					showTip && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: {
							fontSize: "11px",
							lineHeight: "16px",
							color: "var(--dsw-alias-label-secondary)",
							background: "var(--dsw-alias-bg-layer-2)",
							padding: "6px 10px",
							borderRadius: "6px",
							border: "1px solid var(--dsw-alias-border-l2)",
							marginTop: "2px",
							marginBottom: "4px"
						},
						children: t(control.tip)
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
						className: DebugPanel_module_css_default.range,
						type: "range",
						"aria-labelledby": labelId,
						min: control.min,
						max: control.max,
						step: control.step,
						value,
						disabled: !state.writable,
						onChange: (event) => {
							update(event.currentTarget.valueAsNumber);
						}
					})
				]
			});
		}
		function DebugPanel(props) {
			const { t } = props;
			const state = props.useDebugRuntime((snapshot) => snapshot);
			const [open, setOpen] = (0, react.useState)(true);
			const [copied, setCopied] = (0, react.useState)(false);
			(0, react.useEffect)(() => {
				if (!copied) return;
				const timer = setTimeout(() => {
					setCopied(false);
				}, 1400);
				return () => {
					clearTimeout(timer);
				};
			}, [copied]);
			(0, react.useEffect)(() => {
				if (state.enabled) setOpen(true);
			}, [state.enabled]);
			if (!state.available || !state.enabled || !open) return null;
			const metrics = state.metrics;
			const live = metrics.streamActive || metrics.followActive;
			const progress = metrics.streamTargetChars <= 0 ? "-" : `${String(metrics.streamDisplayedChars)} / ${String(metrics.streamTargetChars)}`;
			const copyDiagnostics = async () => {
				if (await (0, _deepseek_ai_dsh_client_ui_primitives.writeClipboard)(JSON.stringify({
					tuning: state.tuning,
					metrics: state.metrics
				}, null, 2))) setCopied(true);
			};
			const panel = !state.enabled || !open ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("aside", {
				className: DebugPanel_module_css_default.panel,
				role: "complementary",
				"aria-label": t("debugPanelTitle"),
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("header", {
						className: DebugPanel_module_css_default.panelHeader,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: live ? `${DebugPanel_module_css_default.statusDot} ${DebugPanel_module_css_default.statusLive}` : DebugPanel_module_css_default.statusDot,
								"aria-hidden": true
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: DebugPanel_module_css_default.title,
								children: t("debugPanelTitle")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: DebugPanel_module_css_default.state,
								children: t(live ? "debugLive" : "debugIdle")
							}),
							state.dirty ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: DebugPanel_module_css_default.unsaved,
								children: t("debugUnsaved")
							}) : null,
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								className: DebugPanel_module_css_default.iconButton,
								type: "button",
								title: t("debugCopy"),
								"aria-label": t("debugCopy"),
								onClick: () => {
									copyDiagnostics();
								},
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconCopyOutlineRegular, {})
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								className: DebugPanel_module_css_default.iconButton,
								type: "button",
								title: t("debugPanelClose"),
								"aria-label": t("debugPanelClose"),
								disabled: !state.writable,
								onClick: () => {
									setOpen(false);
									props.edit({ debugEnabled: false });
									props.save();
								},
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconCloseOutlineRegular, {})
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: DebugPanel_module_css_default.visuallyHidden,
								"aria-live": "polite",
								children: copied ? t("debugCopied") : ""
							})
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: DebugPanel_module_css_default.scrollArea,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: DebugPanel_module_css_default.guide,
								children: t("debugGuide")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
								className: DebugPanel_module_css_default.section,
								"aria-labelledby": "smooth-stream-live-heading",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", {
									id: "smooth-stream-live-heading",
									children: t("debugSectionLive")
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("dl", {
									className: DebugPanel_module_css_default.metrics,
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Metric, {
											label: t("debugFps"),
											value: fixed(metrics.fps, 0),
											tone: (metrics.fps ?? 60) < 45 ? "warn" : "good"
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Metric, {
											label: t("debugFrameTime"),
											value: `${fixed(metrics.frameMs)} ms`
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Metric, {
											label: t("debugBacklog"),
											value: String(metrics.streamBacklog),
											tone: metrics.streamBacklog > 32 ? "warn" : void 0
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Metric, {
											label: t("debugRevealSpeed"),
											value: `${fixed(metrics.streamSpeedCps, 0)} cps`
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Metric, {
											label: t("debugProgress"),
											value: progress
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Metric, {
											label: t("debugFollowState"),
											value: t(metrics.followFollowing ? "debugFollowing" : "debugReleased")
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Metric, {
											label: t("debugLag"),
											value: `${fixed(metrics.followLagPx)} px`,
											tone: metrics.followConstrained ? "warn" : void 0
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Metric, {
											label: t("debugVelocity"),
											value: `${fixed(metrics.followVelocityPxPerSec, 0)} px/s`
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Metric, {
											label: t("debugReserve"),
											value: `${fixed(metrics.followReservePx)} px`
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Metric, {
											label: t("debugCapacity"),
											value: `${fixed(metrics.followCapacityPx)} px`
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Metric, {
											label: t("debugAppliedScale"),
											value: `${fixed(metrics.followRevealScale, 2)}x`
										})
									]
								})]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
								className: DebugPanel_module_css_default.section,
								"aria-labelledby": "smooth-stream-reveal-heading",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", {
									id: "smooth-stream-reveal-heading",
									children: t("debugSectionReveal")
								}), REVEAL_CONTROLS.map((control) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(TuningField, {
									control,
									state,
									edit: props.edit,
									label: t(control.label),
									t
								}, control.key))]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
								className: DebugPanel_module_css_default.section,
								"aria-labelledby": "smooth-stream-follow-heading",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", {
									id: "smooth-stream-follow-heading",
									children: t("debugSectionFollow")
								}), FOLLOW_CONTROLS.map((control) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(TuningField, {
									control,
									state,
									edit: props.edit,
									label: t(control.label),
									t
								}, control.key))]
							})
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("footer", {
						className: DebugPanel_module_css_default.footer,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
								className: DebugPanel_module_css_default.secondaryButton,
								type: "button",
								disabled: !state.writable,
								onClick: props.reset,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconRefreshOutlineRegular, {}), t("debugReset")]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: DebugPanel_module_css_default.footerSpacer }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								className: DebugPanel_module_css_default.secondaryButton,
								type: "button",
								disabled: !state.writable || !state.dirty,
								onClick: props.discard,
								children: t("debugDiscard")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								className: DebugPanel_module_css_default.primaryButton,
								type: "button",
								disabled: !state.writable || !state.dirty,
								onClick: props.save,
								children: t("debugSave")
							})
						]
					})
				]
			});
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
				type: "button",
				className: state.enabled && open ? `${DebugPanel_module_css_default.trigger} ${DebugPanel_module_css_default.triggerActive}` : DebugPanel_module_css_default.trigger,
				"aria-expanded": state.enabled && open,
				"aria-label": t("debugPanelToggle"),
				title: t("debugPanelToggle"),
				onClick: () => {
					setOpen((current) => !current);
				},
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconCodeOutlineRegular, {})
			}), typeof document === "undefined" || panel === null ? null : (0, react_dom.createPortal)(panel, document.body)] });
		}
		//#endregion
		//#region src/config.ts
		/** Defaults shared by the Host schema and the client-side fallback. */
		const DEFAULT_STREAM_CONFIG = {
			mode: "typewriter",
			preset: "balanced",
			revealCharsPerSec: 80,
			scrollSpeedPxPerSec: 48,
			maxScrollSpeedPxPerSec: 1e3
		};
		/**
		* Window global the Host writes into the served index HTML. The browser boot
		* graph carries no per-entry config, so this inline script is the only
		* Host-to-client configuration channel for a composed web plugin.
		*/
		const STREAM_BOOT_GLOBAL = "__DSH_SMOOTH_STREAM_CONFIG__";
		//#endregion
		//#region src/client/index.ts
		/**
		* Cordis services required by the browser half. Only `slots` is load-bearing
		* for the stream itself; locale and Connection power the configuration card
		* and are wired through `ctx.inject` below so a deployment without them still
		* streams with defaults.
		*/
		const inject = ["slots"];
		const STREAM_MODES = ["typewriter", "teleprompter"];
		const STREAM_PRESETS = [
			"realtime",
			"balanced",
			"silky"
		];
		/**
		* The assistant renderer owns its own character queue and conversation
		* follower, so wrapping it again would create two scroll owners. Human input
		* stays immediate; every Agent-owned output renderer goes through the same
		* generic follow boundary. This is deliberately keyed by the owner that
		* provides the renderer, not by individual tool names, so new Context,
		* Command, and Tool rows are covered automatically.
		*/
		const SKIP_WRAP = /* @__PURE__ */ new Set([
			"user",
			"steering",
			"command-input",
			"turn-process",
			"turn-tail"
		]);
		/** React function/class or an exotic component such as memo/forwardRef/lazy. */
		function isWrappableComponent(value) {
			return typeof value === "function" || value !== null && typeof value === "object" && "$$typeof" in value;
		}
		/**
		* Read the Host-bridged boot config. The inline script is produced by this
		* plugin's Host half from a schema-validated value, so only the structural
		* guarantees that could break between the two halves are re-checked: the
		* global is absent when the client runs without its Host entry (defaults
		* apply), and any present-but-malformed value fails loudly instead of
		* rendering a half-configured view.
		* @returns The resolved configuration for the assistant node view.
		*/
		function readBootConfig() {
			const raw = globalThis[STREAM_BOOT_GLOBAL];
			if (raw === void 0) {
				console.info("[dsh-smooth-stream] no host config bridge; using defaults");
				return DEFAULT_STREAM_CONFIG;
			}
			if (typeof raw !== "object" || raw === null || !STREAM_MODES.includes(raw.mode) || !STREAM_PRESETS.includes(raw.preset) || typeof raw.revealCharsPerSec !== "number" || typeof raw.scrollSpeedPxPerSec !== "number" || typeof raw.maxScrollSpeedPxPerSec !== "number") throw new Error(`[dsh-smooth-stream] malformed ${STREAM_BOOT_GLOBAL} boot global: ${JSON.stringify(raw)}`);
			return raw;
		}
		/**
		* A live settings cell shared by the renderer lifecycle and React views. It
		* starts on the shared defaults and follows the plugin-owned controller once
		* the optional settings services arrive.
		*/
		var SettingsCell = class {
			listeners = /* @__PURE__ */ new Set();
			card;
			value = (() => {
				const val = { ...DEFAULT_STREAM_SETTINGS };
				try {
					const saved = typeof localStorage !== "undefined" ? localStorage.getItem("dsh-smooth-stream:settings") : null;
					if (saved) Object.assign(val, JSON.parse(saved));
				} catch {}
				return val;
			})();
			pending = false;
			/** Re-point the cell at the plugin-owned settings controller. */
			attach(card) {
				this.card = card;
				this.refresh();
				const unsubscribe = card.subscribe(() => {
					this.refresh();
				});
				return () => {
					unsubscribe();
					if (this.card !== card) return;
					this.card = void 0;
					this.refresh();
				};
			}
			read() {
				const snapshot = this.card?.getSnapshot();
				if (snapshot === void 0 || snapshot.status !== "ready") return this.value;
				return this.card?.values() ?? this.value;
			}
			refresh() {
				const next = this.read();
				const pending = this.card?.getSnapshot().status === "loading";
				if (pending === this.pending && next.enabled === this.value.enabled && next.controlScroll === this.value.controlScroll && next.motionPreference === this.value.motionPreference && next.backgroundRecovery === this.value.backgroundRecovery && next.foregroundRecoveryDelayMs === this.value.foregroundRecoveryDelayMs && next.thinkAutoExpand === this.value.thinkAutoExpand && next.logarithmicFade === this.value.logarithmicFade && next.fastFold === this.value.fastFold && next.fastPipeline === this.value.fastPipeline && next.keepStreamOnToolCall === this.value.keepStreamOnToolCall && next.debugEnabled === this.value.debugEnabled && next.debugTuningEnabled === this.value.debugTuningEnabled && next.debugTuning === this.value.debugTuning) return;
				this.pending = pending;
				this.value = next;
				for (const listener of this.listeners) listener();
			}
			/** Always respect the user's enabled preference immediately. */
			takeoverEnabled() {
				return !this.pending && this.value.enabled;
			}
			getSnapshot = () => this.value;
			subscribe = (listener) => {
				this.listeners.add(listener);
				return () => {
					this.listeners.delete(listener);
				};
			};
		};
		const FAST_FOLD_STYLE_ID = "smooth-stream-fast-fold-style";
		function ensureFastFoldStyles() {
			if (typeof document === "undefined") return;
			if (document.getElementById(FAST_FOLD_STYLE_ID) !== null) return;
			const style = document.createElement("style");
			style.id = FAST_FOLD_STYLE_ID;
			style.textContent = `
    /* Only committed hidden process rows detach; never interrupt the Host fold clock. */
    html[data-smooth-stream-fast-fold="true"] [data-chat-flow] [data-turn-process-hidden][hidden] {
      display: none !important;
    }
    /* Preserve popovers and wide Markdown: paint containment would clip them. */
    html[data-smooth-stream-fast-fold="true"] [data-smooth-stream-settled="true"] {
      contain: layout style;
    }
  `;
			document.head.appendChild(style);
		}
		function syncFastFold(enabled) {
			if (typeof document === "undefined") return;
			ensureFastFoldStyles();
			if (enabled) document.documentElement.setAttribute("data-smooth-stream-fast-fold", "true");
			else document.documentElement.removeAttribute("data-smooth-stream-fast-fold");
		}
		/** Install only the feature-detected, instance-local publishing optimization. */
		function healDshConversationPipeline(ctx, settings) {
			ctx.inject(["uiConversation"], (scopedCtx) => installConversationPipeline(scopedCtx.uiConversation, () => settings.getSnapshot().enabled && settings.getSnapshot().fastPipeline));
		}
		/**
		* Register the typewriter renderer after the conversation package declares the
		* keyed Chat node seat. A lower priority shadows the built-in assistant row;
		* every other keyed renderer is wrapped in place so Context, commands, Tool
		* cards, retries, and workflow runs share one extensible follow boundary. The
		* Host-bridged configuration
		* selects the render direction, smoothing preset, and glide speed; the
		* plugin-owned settings RPC supplies the live auto-expand preference when the
		* settings surface is composed.
		* @param ctx - Browser context carrying the shared slot registry.
		*/
		function apply(ctx) {
			const config = readBootConfig();
			const settings = new SettingsCell();
			const syncStyles = () => {
				syncFastFold(settings.getSnapshot().enabled && settings.getSnapshot().fastFold);
			};
			const syncRecoveryDelay = () => {
				setForegroundRecoveryDelay(settings.getSnapshot().foregroundRecoveryDelayMs);
			};
			syncStyles();
			syncRecoveryDelay();
			const offStyles = settings.subscribe(syncStyles);
			const offRecoveryDelay = settings.subscribe(syncRecoveryDelay);
			ctx.effect(() => () => {
				offStyles();
				offRecoveryDelay();
				setForegroundRecoveryDelay(0);
				document.documentElement.removeAttribute("data-smooth-stream-fast-fold");
				document.getElementById(FAST_FOLD_STYLE_ID)?.remove();
			});
			healDshConversationPipeline(ctx, settings);
			ctx.inject(["uiConversation"], (scopedCtx) => scopedCtx.uiConversation.events.register(streamOrderDefinition()));
			ctx.inject(["sessions", "connection"], (scopedCtx) => bindRecoverySynchronization(scopedCtx.sessions, scopedCtx.get("connection")));
			const useControlScroll = () => (0, react.useSyncExternalStore)(settings.subscribe, () => settings.getSnapshot().controlScroll, () => settings.getSnapshot().controlScroll);
			const useBackgroundRecovery = () => (0, react.useSyncExternalStore)(settings.subscribe, () => settings.getSnapshot().backgroundRecovery, () => settings.getSnapshot().backgroundRecovery);
			ctx.inject([
				"slots",
				"locale",
				"connection"
			], (settingsCtx) => {
				const card = new SmoothStreamCardController(createSmoothStreamSettingsApi(settingsCtx.get("connection")));
				const detachSettings = settings.attach(card);
				const syncDebug = () => {
					const snapshot = card.getSnapshot();
					debugRuntime.syncSettings({
						available: snapshot.debugAvailable,
						enabled: snapshot.debugEnabled,
						tuningEnabled: snapshot.debugTuningEnabled,
						writable: snapshot.writable && !snapshot.saving,
						dirty: snapshot.dirty,
						status: snapshot.status,
						tuning: snapshot.debugTuning
					});
				};
				const detachBinding = debugRuntime.bindSettings({
					edit: (patch) => {
						card.inject().edit(patch);
					},
					save: () => {
						card.inject().save();
					},
					discard: () => {
						card.inject().discard();
					}
				});
				const detachDebug = card.subscribe(syncDebug);
				syncDebug();
				card.start();
				settingsCtx.effect(() => settingsCtx.locale.register(NS, {
					zh,
					en
				}), "dsh-smooth-stream: settings dictionaries");
				const SmoothStreamSectionView = (props) => (0, react.createElement)("div", { style: {
					width: "100%",
					maxWidth: "760px",
					minHeight: "240px",
					display: "flex",
					flexDirection: "column",
					gap: "16px",
					padding: "4px 0 24px 0"
				} }, (0, react.createElement)("h2", { style: {
					margin: 0,
					fontSize: "18px",
					fontWeight: 600
				} }, "平滑流式输出"), (0, react.createElement)("p", { style: {
					color: "var(--dsw-alias-label-tertiary)",
					margin: 0,
					fontSize: "13px"
				} }, "流畅打字机渲染、丝滑平稳滚动与思考过程折叠配置。"), (0, react.createElement)("ul", { style: {
					listStyle: "none",
					padding: 0,
					margin: 0,
					display: "flex",
					flexDirection: "column"
				} }, (0, react.createElement)(SmoothStreamCard, {
					...props,
					cardController: card,
					defaultOpen: true
				})));
				settingsCtx.slots.inject("settings.section", () => settingsCtx.slots.register({
					name: "settings.section",
					id: "smooth-stream",
					order: 25,
					label: () => "平滑流式",
					locale: NS,
					inject: () => card.inject()
				}, SmoothStreamSectionView));
				settingsCtx.slots.inject("settings.plugins.tab", () => settingsCtx.slots.register({
					name: "settings.plugins.tab",
					id: "smooth-stream-tab",
					order: 15,
					label: () => "平滑流式",
					locale: NS,
					inject: () => card.inject()
				}, SmoothStreamSectionView));
				settingsCtx.slots.inject("conversation.session.header.utilities", () => settingsCtx.slots.register({
					name: "conversation.session.header.utilities",
					id: "smooth-stream-debug",
					order: 40,
					locale: NS,
					inject: () => debugRuntime.panelFace()
				}, DebugPanel));
				return () => {
					card.stop();
					detachDebug();
					detachSettings();
					detachBinding();
				};
			});
			ctx.slots.inject("conversation.chat.flow", () => installFlowPresentationAdapter(ctx, settings, (key, component) => isWrappableComponent(component) && !SKIP_WRAP.has(key)));
			ctx.slots.inject("conversation.chat.node", () => {
				return installRendererAdapter(ctx, (key, original) => {
					if (!isWrappableComponent(original) || SKIP_WRAP.has(key)) return original;
					const Inner = original;
					const Follow = key === "assistant-step" ? void 0 : wrapFollowNodeView(Inner, useControlScroll, useBackgroundRecovery);
					return function SmoothStreamRendererAdapter(props) {
						const preferences = (0, react.useSyncExternalStore)(settings.subscribe, settings.getSnapshot, settings.getSnapshot);
						if (!preferences.enabled) return (0, react.createElement)(Inner, props);
						if (key === "assistant-step") return (0, react.createElement)(NativeAssistantNodeView, {
							Inner,
							owner: props,
							preferences: {
								controlScroll: preferences.controlScroll,
								motionPreference: preferences.motionPreference,
								backgroundRecovery: preferences.backgroundRecovery,
								logarithmicFade: preferences.logarithmicFade,
								thinkAutoExpand: preferences.thinkAutoExpand,
								keepStreamOnToolCall: preferences.keepStreamOnToolCall,
								preset: config.preset
							}
						});
						return (0, react.createElement)(Follow ?? Inner, props);
					};
				});
			});
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map