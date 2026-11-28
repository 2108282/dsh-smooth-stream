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
		//#region src/client/streamPresets.ts
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
			thinkAutoExpand: true,
			fastFold: true,
			fastPipeline: true,
			keepStreamOnToolCall: true,
			debugEnabled: false,
			debugTuningEnabled: false,
			debugTuning: DEFAULT_STREAM_DEBUG_TUNING
		};
		//#endregion
		//#region src/client/sessionPlayback.ts
		const EMPTY_DISPLAY = Object.freeze({
			text: "",
			entered: false,
			pending: false
		});
		const LEDGER_LIMIT$1 = 2048;
		const DEFAULT_CHARS_PER_SECOND = 60;
		const DEFAULT_MAX_LAG_CHARS = 256;
		function compareOrder(left, right) {
			const shared = Math.min(left.length, right.length);
			for (let index = 0; index < shared; index++) {
				const a = left[index];
				const b = right[index];
				if (a < b) return -1;
				if (a > b) return 1;
			}
			return left.length - right.length;
		}
		function startsWith(value, prefix) {
			if (prefix.length > value.length) return false;
			for (let index = 0; index < prefix.length; index++) if (value[index] !== prefix[index]) return false;
			return true;
		}
		/** A single-clock playback queue shared by every owner in one session. */
		var SessionPlayback = class {
			requestFrame;
			cancelFrame;
			now;
			charsPerSecond = DEFAULT_CHARS_PER_SECOND;
			maxLagChars = DEFAULT_MAX_LAG_CHARS;
			tuning = { ...DEFAULT_STREAM_DEBUG_TUNING };
			owners = /* @__PURE__ */ new Map();
			states = /* @__PURE__ */ new Map();
			active = /* @__PURE__ */ new Map();
			ordered = [];
			dirtyDisplays = /* @__PURE__ */ new Set();
			displays = /* @__PURE__ */ new Map();
			listeners = /* @__PURE__ */ new Set();
			enabled = true;
			disposed = false;
			frame;
			lastFrameTime;
			wholeChars = 0;
			revision = 0;
			pumpQueued = false;
			publishQueued = false;
			touchSequence = 0;
			constructor(options = {}) {
				this.requestFrame = options.requestFrame ?? ((callback) => globalThis.requestAnimationFrame(callback));
				this.cancelFrame = options.cancelFrame ?? ((handle) => globalThis.cancelAnimationFrame(handle));
				this.now = options.now ?? (() => globalThis.performance.now());
				this.applyConfiguration(options);
			}
			/** Arrow fields keep these methods safe to pass directly to useSyncExternalStore. */
			subscribe = (listener) => {
				if (this.disposed) return () => {};
				this.listeners.add(listener);
				return () => {
					this.listeners.delete(listener);
				};
			};
			getRevision = () => this.revision;
			read = (id) => this.displays.get(id) ?? EMPTY_DISPLAY;
			upsert(owner, segments, animate) {
				if (this.disposed) return;
				const next = /* @__PURE__ */ new Map();
				const reopened = /* @__PURE__ */ new Set();
				for (const source of segments) {
					const previous = this.states.get(source.id);
					const wasActive = this.active.has(source.id);
					const wasComplete = previous !== void 0 && this.isComplete(previous);
					const segment = {
						id: source.id,
						order: [...source.order],
						text: source.text,
						sealed: source.sealed,
						hidden: source.hidden === true,
						awaitPresentation: source.awaitPresentation === true,
						...source.generation === void 0 ? {} : { generation: source.generation },
						...source.baselineChars === void 0 ? {} : { baselineChars: source.baselineChars }
					};
					next.set(segment.id, segment);
					this.updateState(segment, animate);
					const updated = this.states.get(segment.id);
					if ((!wasActive || wasComplete) && !this.isComplete(updated)) reopened.add(segment.id);
				}
				this.owners.set(owner, next);
				this.rebuildActive();
				this.rehideSuccessors(reopened);
				if (!this.enabled) this.adoptAll();
				else this.queuePump();
				this.trimLedger();
			}
			/** Only an entered source in the same generation can release its presentation barrier. */
			acknowledgePresentation(id, generation) {
				if (this.disposed || !this.active.has(id)) return;
				const state = this.states.get(id);
				if (!state?.entered || !state.presentationPending || state.generation !== generation) return;
				this.clearPresentation(id, state);
				this.queuePump();
			}
			remove(owner) {
				if (this.disposed || !this.owners.delete(owner)) return;
				this.rebuildActive();
				this.queuePump();
				this.trimLedger();
			}
			/** Runtime configuration preserves each source's current reveal position. */
			configure(configuration) {
				if (this.disposed || !this.applyConfiguration(configuration)) return;
				this.cancelPendingFrame();
				this.resetClock();
				this.queuePump();
			}
			setEnabled(enabled) {
				if (this.disposed || this.enabled === enabled) return;
				this.enabled = enabled;
				if (!enabled) {
					for (const [id, state] of this.states) this.clearPresentation(id, state);
					this.queuePublish();
				}
				if (enabled) this.queuePump();
				else this.adoptAll();
			}
			/** Disabled rendering exposes every native row, including successors of an open source. */
			adoptAll() {
				this.cancelPendingFrame();
				this.resetClock();
				for (const segment of this.ordered) {
					const state = this.states.get(segment.id);
					this.clearPresentation(segment.id, state);
					this.enterState(segment.id, state);
					this.consumeTo(segment.id, state, state.points.length);
					state.fraction = 0;
				}
				this.queuePublish();
			}
			/** Catch up in order, but never cross an unsealed protocol boundary. */
			fastForward() {
				if (this.disposed) return;
				this.cancelPendingFrame();
				this.resetClock();
				for (const segment of this.ordered) {
					const state = this.states.get(segment.id);
					this.clearPresentation(segment.id, state);
					this.enterState(segment.id, state);
					this.consumeTo(segment.id, state, state.points.length);
					state.fraction = 0;
					if (!state.sealed) break;
				}
				this.queuePublish();
				if (this.enabled) this.queuePump();
			}
			dispose() {
				if (this.disposed) return;
				this.disposed = true;
				this.cancelPendingFrame();
				this.resetClock();
				this.owners.clear();
				this.active.clear();
				this.ordered = [];
				this.dirtyDisplays.clear();
				this.states.clear();
				this.displays.clear();
				this.listeners.clear();
			}
			applyConfiguration(configuration) {
				let changed = false;
				if (Number.isFinite(configuration.charsPerSecond) && configuration.charsPerSecond > 0 && this.charsPerSecond !== configuration.charsPerSecond) {
					this.charsPerSecond = configuration.charsPerSecond;
					changed = true;
				}
				if (Number.isFinite(configuration.maxLagChars)) {
					const maxLagChars = Math.max(DEFAULT_MAX_LAG_CHARS, Math.ceil(configuration.maxLagChars));
					if (this.maxLagChars !== maxLagChars) {
						this.maxLagChars = maxLagChars;
						changed = true;
					}
				}
				if (configuration.tuning) for (const key of Object.keys(DEFAULT_STREAM_DEBUG_TUNING)) {
					const value = configuration.tuning[key];
					const permitsZero = key === "queuePressure" || key === "runwayPx" || key === "reserveResponseMs";
					if (value !== void 0 && Number.isFinite(value) && (permitsZero ? value >= 0 : value > 0) && this.tuning[key] !== value) {
						this.tuning[key] = value;
						changed = true;
					}
				}
				return changed;
			}
			updateState(segment, animate) {
				let state = this.states.get(segment.id);
				const wasHidden = state?.hidden ?? false;
				const nextPoints = Array.from(segment.text);
				const presentationPending = this.enabled && animate && !segment.hidden && segment.awaitPresentation === true;
				if (state === void 0) {
					state = {
						generation: segment.generation,
						animate,
						text: segment.text,
						points: nextPoints,
						displayText: "",
						consumed: 0,
						sealed: segment.sealed,
						hidden: segment.hidden === true,
						entered: false,
						entryBaseline: segment.baselineChars !== void 0,
						presentationPending,
						fraction: 0,
						touched: ++this.touchSequence
					};
					this.states.set(segment.id, state);
				} else {
					const previousPoints = state.points;
					if (state.generation !== segment.generation || state.sealed && !segment.sealed) {
						this.cancelPendingFrame();
						this.resetClock();
						state.consumed = 0;
						state.displayText = "";
						state.entered = false;
						state.presentationPending = presentationPending;
						state.fraction = 0;
					} else if (state.text !== segment.text) {
						if (startsWith(nextPoints, previousPoints)) state.consumed = Math.min(state.consumed, previousPoints.length);
						else if (state.sealed && state.consumed >= previousPoints.length) {
							state.consumed = nextPoints.length;
							state.displayText = state.entered ? segment.text : "";
						} else {
							state.consumed = 0;
							state.displayText = "";
							state.fraction = 0;
						}
					}
					state.generation = segment.generation;
					state.animate = animate;
					state.text = segment.text;
					state.points = nextPoints;
					state.sealed = segment.sealed;
					state.hidden = segment.hidden === true;
					state.entryBaseline = segment.baselineChars !== void 0;
					state.touched = ++this.touchSequence;
				}
				if (!presentationPending) this.clearPresentation(segment.id, state);
				this.applyImmediateState(segment.id, state);
				if (!state.hidden && wasHidden && !state.entered) {
					state.consumed = 0;
					state.displayText = "";
					state.fraction = 0;
				}
				if (segment.baselineChars !== void 0 && Number.isFinite(segment.baselineChars)) {
					const baseline = Math.max(0, Math.min(nextPoints.length, Math.floor(segment.baselineChars)));
					const completeBaseline = baseline === nextPoints.length;
					if (baseline > 0 || completeBaseline) {
						state.consumed = Math.max(state.consumed, baseline);
						state.entered = true;
						state.displayText = nextPoints.slice(0, state.consumed).join("");
						if (completeBaseline) this.clearPresentation(segment.id, state);
					}
				}
				this.dirtyDisplays.add(segment.id);
			}
			applyImmediateState(id, state) {
				if (!state.animate) {
					state.entered = true;
					state.consumed = state.points.length;
					state.displayText = state.text;
					state.fraction = 0;
					this.dirtyDisplays.add(id);
				} else if (state.hidden) {
					state.consumed = state.points.length;
					if (state.entered) state.displayText = state.text;
					state.fraction = 0;
					this.dirtyDisplays.add(id);
				}
			}
			rehideSuccessors(reopened) {
				if (reopened.size === 0) return;
				const index = this.ordered.findIndex((segment) => {
					if (!reopened.has(segment.id)) return false;
					const state = this.states.get(segment.id);
					return state !== void 0 && !this.isComplete(state);
				});
				if (index === -1) return;
				for (const segment of this.ordered.slice(index + 1)) {
					const state = this.states.get(segment.id);
					const summaryBase = [...reopened].find((id) => id.endsWith(":summary"))?.slice(0, -8);
					if (summaryBase !== void 0 && segment.id === summaryBase) continue;
					if (!state.entered || state.entryBaseline || !state.animate || !this.isComplete(state)) continue;
					state.entered = false;
					state.displayText = "";
					this.dirtyDisplays.add(segment.id);
				}
			}
			rebuildActive() {
				const previousIds = new Set(this.active.keys());
				this.active.clear();
				for (const owner of this.owners.values()) for (const [id, segment] of owner) this.active.set(id, segment);
				for (const id of previousIds) if (!this.active.has(id)) this.dirtyDisplays.add(id);
				for (const id of this.active.keys()) if (!previousIds.has(id)) this.dirtyDisplays.add(id);
				this.ordered = [...this.active.values()].sort((left, right) => compareOrder(left.order, right.order) || left.id.localeCompare(right.id));
			}
			isComplete(state) {
				return state.entered && state.consumed >= state.points.length && state.sealed && !state.presentationPending;
			}
			clearPresentation(id, state) {
				if (!state.presentationPending) return;
				state.presentationPending = false;
				this.dirtyDisplays.add(id);
			}
			enterState(id, state) {
				if (state.entered) return;
				state.entered = true;
				state.displayText = state.points.slice(0, state.consumed).join("");
				this.dirtyDisplays.add(id);
			}
			consumeTo(id, state, consumed) {
				if (consumed <= state.consumed) return;
				const previous = state.consumed;
				state.consumed = consumed;
				if (state.entered) state.displayText += state.points.slice(previous, consumed).join("");
				this.dirtyDisplays.add(id);
			}
			queuePump() {
				if (this.pumpQueued || this.disposed) return;
				this.pumpQueued = true;
				queueMicrotask(() => {
					this.pumpQueued = false;
					if (this.disposed) return;
					this.pump();
				});
			}
			pump() {
				for (const segment of this.ordered) {
					const state = this.states.get(segment.id);
					if (this.isComplete(state)) continue;
					if (state.hidden) {
						this.enterState(segment.id, state);
						this.consumeTo(segment.id, state, state.points.length);
						if (state.sealed) continue;
						break;
					}
					if (state.points.length === 0) {
						this.enterState(segment.id, state);
						if (this.isComplete(state)) continue;
					}
					break;
				}
				this.queuePublish();
				this.ensureFrame();
			}
			ensureFrame() {
				const head = this.firstIncomplete();
				const state = head ? this.states.get(head.id) : void 0;
				if (!(this.enabled && state !== void 0 && !state.hidden && state.consumed < state.points.length)) {
					if (this.frame !== void 0) this.cancelPendingFrame();
					this.resetClock();
					return;
				}
				if (this.frame !== void 0) return;
				if (this.lastFrameTime === void 0) this.lastFrameTime = this.now();
				this.frame = this.requestFrame(() => this.onFrame());
			}
			onFrame() {
				this.frame = void 0;
				if (this.disposed || !this.enabled) return;
				const timestamp = this.now();
				const previous = this.lastFrameTime ?? timestamp;
				const elapsed = Math.max(0, timestamp - previous);
				this.lastFrameTime = timestamp;
				const head = this.firstIncomplete();
				const headState = head ? this.states.get(head.id) : void 0;
				const backlog = headState ? headState.points.length - headState.consumed : 0;
				const pressure = 1 + Math.min(1, backlog / this.maxLagChars) * this.tuning.queuePressure;
				const cps = Math.min(this.tuning.maxRevealCps, this.charsPerSecond * this.tuning.revealScale * pressure);
				const accumulated = Math.min(this.maxLagChars, this.wholeChars + Math.min(elapsed, 120) * cps / 1e3);
				let budget = Math.min(Math.max(1, Math.floor(this.tuning.cadenceClamp)), Math.floor(accumulated));
				this.wholeChars = accumulated % 1;
				const ordered = this.ordered;
				let index = 0;
				while (index < ordered.length) {
					const segment = ordered[index];
					const state = this.states.get(segment.id);
					if (this.isComplete(state)) {
						index++;
						continue;
					}
					if (state.hidden) {
						this.enterState(segment.id, state);
						this.consumeTo(segment.id, state, state.points.length);
						if (state.sealed) {
							index++;
							continue;
						}
						break;
					}
					this.enterState(segment.id, state);
					if (state.points.length === 0) {
						if (this.isComplete(state)) {
							index++;
							continue;
						}
						break;
					}
					if (budget <= 0) break;
					const amount = Math.min(budget, state.points.length - state.consumed);
					this.consumeTo(segment.id, state, state.consumed + amount);
					budget -= amount;
					if (this.isComplete(state)) {
						index++;
						continue;
					}
					break;
				}
				this.pump();
			}
			firstIncomplete() {
				for (const segment of this.ordered) {
					const state = this.states.get(segment.id);
					if (!this.isComplete(state)) return segment;
				}
			}
			cancelPendingFrame() {
				if (this.frame === void 0) return;
				this.cancelFrame(this.frame);
				this.frame = void 0;
			}
			resetClock() {
				this.lastFrameTime = void 0;
				this.wholeChars = 0;
			}
			queuePublish() {
				if (this.publishQueued || this.disposed || this.dirtyDisplays.size === 0) return;
				this.publishQueued = true;
				queueMicrotask(() => {
					this.publishQueued = false;
					if (this.disposed) return;
					const dirty = [...this.dirtyDisplays];
					this.dirtyDisplays.clear();
					let changed = false;
					for (const id of dirty) {
						const segment = this.active.get(id);
						const state = this.states.get(id);
						const next = segment && state ? {
							text: state.entered ? state.displayText : "",
							entered: state.entered,
							pending: !this.isComplete(state)
						} : EMPTY_DISPLAY;
						const previous = this.displays.get(id) ?? EMPTY_DISPLAY;
						if (previous.text === next.text && previous.entered === next.entered && previous.pending === next.pending) {
							if (!segment || !state) this.displays.delete(id);
							continue;
						}
						if (segment && state) this.displays.set(id, next);
						else this.displays.delete(id);
						changed = true;
					}
					if (!changed) return;
					this.revision++;
					for (const listener of [...this.listeners]) listener();
				});
			}
			trimLedger() {
				if (this.states.size <= LEDGER_LIMIT$1) return;
				const active = new Set(this.active.keys());
				const candidates = [...this.states.entries()].filter(([id]) => !active.has(id)).sort((left, right) => left[1].touched - right[1].touched);
				for (const [id] of candidates) {
					if (this.states.size <= LEDGER_LIMIT$1) break;
					this.states.delete(id);
				}
			}
		};
		//#endregion
		//#region src/client/entryBaseline.ts
		let sessions;
		let nextEpoch = 0;
		const observers = /* @__PURE__ */ new Set();
		/** Install once from the Client context, and return its context-owned disposer. */
		function installEntryBaselineSource(source) {
			const previous = sessions;
			sessions = source;
			for (const observer of observers) observer.refresh();
			return () => {
				if (sessions !== source) return;
				sessions = previous;
				for (const observer of observers) observer.refresh();
			};
		}
		/** Create at session entry, before delayed Conversation/React publications, and dispose at departure. */
		function createEntryBaseline(sessionId) {
			const baseline = new Baseline(sessionId);
			baseline.refresh();
			return baseline;
		}
		function blockKey(turn, step, attemptId, index) {
			return JSON.stringify([
				turn,
				step,
				attemptId,
				index
			]);
		}
		function safePrefix(text, length) {
			let end = Math.min(length, text.length);
			const before = text.charCodeAt(end - 1);
			const after = text.charCodeAt(end);
			if (before >= 55296 && before <= 56319 && after >= 56320 && after <= 57343) end--;
			return text.slice(0, end);
		}
		/** Length/provenance metadata only. Official Conversation remains the content assembler. */
		var Baseline = class {
			sessionId;
			binding;
			epoch = ++nextEpoch;
			revision = 0;
			sourceRevision;
			ready = false;
			disposed = false;
			blocks = /* @__PURE__ */ new Map();
			liveSeqs = /* @__PURE__ */ new Set();
			liveMessages = /* @__PURE__ */ new Set();
			settlements = /* @__PURE__ */ new Map();
			listeners = /* @__PURE__ */ new Set();
			unsubscribe = [];
			constructor(sessionId) {
				this.sessionId = sessionId;
			}
			subscribe = (listener) => {
				if (this.disposed) return () => {};
				this.listeners.add(listener);
				observers.add(this);
				this.refresh();
				return () => {
					this.listeners.delete(listener);
					if (this.listeners.size !== 0) return;
					for (const unsubscribe of this.unsubscribe.splice(0)) unsubscribe();
					observers.delete(this);
				};
			};
			getSnapshot = () => this.revision;
			refresh() {
				if (this.disposed) return;
				const binding = sessions?.binding(this.sessionId);
				if (binding !== this.binding) {
					for (const unsubscribe of this.unsubscribe.splice(0)) unsubscribe();
					this.binding = binding;
					this.reset();
					this.capture();
					this.publish();
				} else this.capture();
				if (binding !== void 0 && this.listeners.size !== 0 && this.unsubscribe.length === 0) {
					this.unsubscribe.push(binding.eventSource.subscribe(() => this.capture()));
					this.unsubscribe.push(binding.session.subscribe(() => this.capture()));
					this.capture();
				}
			}
			reset() {
				this.epoch = ++nextEpoch;
				this.sourceRevision = void 0;
				this.ready = false;
				this.blocks.clear();
				this.liveSeqs.clear();
				this.liveMessages.clear();
				this.settlements.clear();
			}
			capture() {
				const binding = this.binding;
				if (binding === void 0 || this.disposed) return;
				const window = binding.eventSource.getSnapshot();
				const open = binding.session.getSnapshot().openState === "open";
				if (this.sourceRevision === window.revision) {
					if (!this.ready && open) {
						this.ready = true;
						this.publish();
					}
					return;
				}
				const initial = this.sourceRevision === void 0;
				const contiguous = initial || window.revision === this.sourceRevision + 1;
				this.sourceRevision = window.revision;
				if (initial || !contiguous || window.change.kind === "replace") {
					this.epoch = ++nextEpoch;
					this.blocks.clear();
					this.liveSeqs.clear();
					this.liveMessages.clear();
					this.settlements.clear();
					this.consume(window.entries, false);
					this.ready = open || !initial && window.change.kind === "replace";
				} else if (window.change.kind === "prepend") this.consume(window.change.entries ?? [], false, true);
				else if (window.change.kind === "append") this.consume(window.change.entries ?? [], this.ready);
				else if (window.change.kind === "settle-assistant") this.settle(window.change.attemptId, window.change.entry);
				if (open) this.ready = true;
				this.publish();
			}
			consume(entries, live, preserve = false) {
				for (const entry of entries) {
					const event = entry.event;
					if (live) {
						this.liveSeqs.add(Number(event.seq));
						if (event.type === "assistant/message" && event.surfaceOp === "append") this.liveMessages.add(Number(event.seq));
					}
					if (event.type !== "assistant/live-chunk") continue;
					const data = event.data;
					if (data === null || typeof data !== "object" || typeof data.attemptId !== "string" || typeof data.turn !== "number" || typeof data.step !== "number") continue;
					const chunk = data.chunk;
					if (chunk === void 0 || typeof chunk.index !== "number") continue;
					const key = blockKey(data.turn, data.step, data.attemptId, chunk.index);
					const previous = this.blocks.get(key);
					if (preserve && previous !== void 0) continue;
					const type = chunk.type;
					if (type !== "block-start" && type !== "text-delta" && type !== "reasoning-delta" && type !== "block-end") continue;
					const kind = type === "block-start" ? chunk.blockType : type === "block-end" ? chunk.block?.type : type === "text-delta" ? "text" : "reasoning";
					if (typeof kind !== "string") continue;
					const block = type === "block-start" || previous === void 0 || previous.kind !== kind ? {
						seq: Number(event.seq),
						kind,
						length: 0,
						baseline: 0,
						live
					} : previous;
					if (type === "text-delta" || type === "reasoning-delta") {
						if (typeof chunk.text !== "string") continue;
						block.length += chunk.text.length;
						if (!live) block.baseline = block.length;
					} else if (type === "block-end" && typeof chunk.block?.text === "string") {
						const length = chunk.block.text.length;
						if (!live || length !== block.length) block.baseline = length;
						block.length = length;
					}
					block.live ||= live;
					this.blocks.set(key, block);
				}
			}
			settle(attemptId, entry) {
				if (attemptId === void 0 || entry?.event.type !== "assistant/message") return;
				const data = entry.event.data;
				if (data === null || typeof data !== "object" || typeof data.turn !== "number" || typeof data.step !== "number" || !Array.isArray(data.message?.content)) return;
				const { turn, step } = data;
				const blocks = [...this.blocks].flatMap(([key, block]) => {
					const [blockTurn, blockStep, attempt, index] = JSON.parse(key);
					return blockTurn === turn && blockStep === step && attempt === attemptId ? [{
						index,
						block
					}] : [];
				}).sort((left, right) => left.index - right.index);
				if (blocks.length !== data.message.content.length || data.message.content.some((block, index) => block.type !== blocks[index].block.kind)) return;
				this.settlements.set(JSON.stringify([
					turn,
					step,
					entry.event.seq
				]), blocks.map(({ index, block }) => ({
					turn,
					step,
					attemptId,
					blockIndex: index,
					blockSeq: block.seq
				})));
			}
			settledBlock(turn, step, seq, index, kind) {
				this.refresh();
				const source = this.settlements.get(JSON.stringify([
					turn,
					step,
					seq
				]))?.[index];
				if (source?.attemptId === void 0 || source.blockIndex === void 0) return void 0;
				const block = this.blocks.get(blockKey(turn, step, source.attemptId, source.blockIndex));
				return block?.kind === kind && block.seq === source.blockSeq ? source : void 0;
			}
			readBlock(source, text) {
				this.refresh();
				const key = source.attemptId === void 0 || source.blockIndex === void 0 ? void 0 : blockKey(source.turn, source.step, source.attemptId, source.blockIndex);
				const block = key === void 0 ? void 0 : this.blocks.get(key);
				const known = block !== void 0 && source.blockSeq === block.seq;
				const durable = source.blockSeq !== void 0 && this.liveMessages.has(source.blockSeq);
				const animate = known && block.live || durable;
				return {
					initialText: known && animate ? safePrefix(text, block.baseline) : durable ? "" : text,
					animate,
					generation: JSON.stringify([
						this.epoch,
						key,
						source.blockSeq
					])
				};
			}
			isLiveSeq(seq) {
				this.refresh();
				return this.liveSeqs.has(seq);
			}
			publish() {
				this.revision++;
				for (const listener of [...this.listeners]) listener();
			}
			dispose() {
				if (this.disposed) return;
				this.disposed = true;
				for (const unsubscribe of this.unsubscribe.splice(0)) unsubscribe();
				this.listeners.clear();
				this.blocks.clear();
				this.liveSeqs.clear();
				this.liveMessages.clear();
				this.settlements.clear();
				observers.delete(this);
			}
		};
		//#endregion
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
			(0, react.useLayoutEffect)(() => {
				if (!controlScroll) return;
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
				const revealPhase = new FollowRevealPhaseTracker();
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
					if (port !== null && hostInputFoldActive(port)) {
						yieldToInputFold(port);
						return;
					}
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
					const elapsedMs = Math.min(32, Math.max(.001, now - last));
					const dt = elapsedMs;
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
					let settleLast = performance.now();
					const settleFrame = (now) => {
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
				controlScroll
			]);
			(0, react.useLayoutEffect)(() => {
				const host = rootRef.current?.closest("[data-conversation-scroll]") ?? null;
				if (host === null) return;
				if (!controlScroll) {
					releaseFollowSpace(host);
					return;
				}
				const reconcile = () => {
					reconcileFollowBudget(host);
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
		//#region \0dsh-css:/root/workspaces/DSH项目维护/dsh-smooth-stream-unified/src/client/FollowHost.module.css.mjs
		const css$2 = ".g6gOsW_follow{contain:layout style;min-width:0}";
		const tagId$2 = "dsh-smooth-stream/FollowHost.module.css";
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
		var FollowHost_module_css_default = { "follow": "g6gOsW_follow" };
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
				className: className === void 0 ? FollowHost_module_css_default.follow : `${FollowHost_module_css_default.follow} ${className}`,
				"data-entrance": entranceActive === void 0 ? void 0 : entranceActive ? "active" : "idle",
				children
			});
		}
		//#endregion
		//#region src/client/usePlaybackDomText.ts
		const ledgers = /* @__PURE__ */ new WeakMap();
		const LEDGER_LIMIT = 512;
		const EXCLUDED = "[aria-hidden=\"true\"],[aria-live],[contenteditable]:not([contenteditable=\"false\"]),script,style,textarea,input,select,svg,math,canvas";
		const CONTROLS = "button,[role=\"button\"],summary";
		const OBSERVED_ATTRIBUTES = [
			"hidden",
			"style",
			"class",
			"open",
			"data-open",
			"aria-hidden",
			"aria-live",
			"contenteditable",
			"aria-expanded"
		];
		function getLedger(playback, owner) {
			let owners = ledgers.get(playback);
			if (owners === void 0) {
				owners = /* @__PURE__ */ new Map();
				ledgers.set(playback, owners);
			}
			let ledger = owners.get(owner);
			if (ledger === void 0) {
				ledger = {
					paths: /* @__PURE__ */ new Map(),
					hiddenPaths: /* @__PURE__ */ new Set(),
					nextId: 0
				};
				owners.set(owner, ledger);
				if (owners.size > LEDGER_LIMIT) owners.delete(owners.keys().next().value);
			}
			return ledger;
		}
		function baselineLength(source) {
			if (source.baseline === void 0) return void 0;
			const previous = [...source.baseline];
			const current = [...source.full];
			let length = 0;
			while (length < previous.length && previous[length] === current[length]) length++;
			return length;
		}
		function hidden(element) {
			if (element.hasAttribute("hidden")) return true;
			const style = element.ownerDocument.defaultView?.getComputedStyle(element);
			return style?.display === "none" || style?.visibility === "hidden" || style?.visibility === "collapse" || style?.contentVisibility === "hidden";
		}
		function hiddenOutside(root) {
			for (let element = root.parentElement; element !== null; element = element.parentElement) {
				if (hidden(element) || element.matches(EXCLUDED)) return true;
				if (element.localName === "details" && !element.hasAttribute("open")) {
					const summary = element.querySelector(":scope > summary");
					if (summary === null || !summary.contains(root)) return true;
				}
			}
			return false;
		}
		/** DisclosureRow mounts its detail body on expansion rather than hiding it. */
		function openedBody(node) {
			if (!(node instanceof Element) || node.closest("[data-tool]") === null) return false;
			if (node.matches("[data-tool-body],[data-disclosure-body],[class*=\"_bodyWrap\"]")) return true;
			return node.id !== "" && [...node.parentElement?.querySelectorAll("[aria-controls][aria-expanded=\"true\"]") ?? []].some((control) => control.getAttribute("aria-controls")?.split(/\s+/).includes(node.id));
		}
		function createBridge(root, playback, owner, options) {
			const ledger = getLedger(playback, owner);
			const bindings = /* @__PURE__ */ new Map();
			const internalWrites = /* @__PURE__ */ new WeakMap();
			const snapshots = /* @__PURE__ */ new Set();
			let ordered = [];
			let stopped = false;
			let initial = true;
			let ready = false;
			let pending;
			let observer;
			const write = (node, binding, value) => {
				const changed = node.data !== value;
				if (changed) {
					if (observer !== void 0) {
						let writes = internalWrites.get(node);
						if (writes === void 0) internalWrites.set(node, writes = []);
						writes.push({
							before: node.data,
							after: value
						});
					}
					node.data = value;
				}
				binding.written = value;
				return changed;
			};
			const consume = (mutations) => {
				let changed = false;
				const nextValues = /* @__PURE__ */ new Map();
				const changes = [];
				for (let index = mutations.length - 1; index >= 0; index--) {
					const mutation = mutations[index];
					if (mutation.type !== "characterData") continue;
					const node = mutation.target;
					changes.push({
						node,
						before: mutation.oldValue ?? "",
						after: nextValues.get(node) ?? node.data
					});
					nextValues.set(node, mutation.oldValue ?? "");
				}
				for (const change of changes.reverse()) {
					const writes = internalWrites.get(change.node);
					const expected = writes?.[0];
					if (expected?.before === change.before && expected.after === change.after) {
						writes.shift();
						if (writes.length === 0) internalWrites.delete(change.node);
					} else {
						const binding = bindings.get(change.node);
						if (binding !== void 0) binding.source.full = change.after;
						changed = true;
					}
				}
				for (const node of nextValues.keys()) {
					const binding = bindings.get(node);
					if (binding !== void 0) binding.written = node.data;
				}
				for (const mutation of mutations) {
					if (mutation.type === "characterData") continue;
					changed = true;
					if (mutation.type === "childList") {
						for (const added of mutation.addedNodes) if (openedBody(added)) snapshots.add(added);
					} else if (mutation.attributeName === "open" && mutation.target.hasAttribute("open")) snapshots.add(mutation.target);
					else if (mutation.attributeName === "data-open" && mutation.target.hasAttribute("data-open")) {
						const disclosure = mutation.target;
						const header = disclosure.querySelector(":scope > [data-disclosure-header]");
						if (header !== null) {
							for (const child of disclosure.childNodes) if (child !== header) snapshots.add(child);
						}
					} else if (mutation.attributeName === "aria-expanded" && mutation.target.getAttribute("aria-expanded") === "true") {
						const ids = mutation.target.getAttribute("aria-controls")?.split(/\s+/) ?? [];
						for (const id of ids) {
							const body = root.ownerDocument.getElementById(id);
							if (body !== null && root.contains(body)) snapshots.add(body);
						}
					}
				}
				return changed;
			};
			const drain = () => consume(observer?.takeRecords() ?? []);
			const present = (adopted) => {
				let committed = false;
				let nextPending = false;
				for (const node of ordered) {
					const binding = bindings.get(node);
					if (!binding.visible) continue;
					const display = playback.read(binding.source.id);
					if (!(baselineLength(binding.source) === [...binding.source.full].length) && (display.pending || display.text !== binding.source.full)) nextPending = true;
					if (adopted?.has(node)) continue;
					if (node.data !== binding.written) continue;
					if (write(node, binding, display.text)) committed = true;
				}
				if (committed) options().onCommit?.();
				nextPending &&= options().animate;
				if (nextPending !== pending) {
					pending = nextPending;
					options().onPendingChange?.(nextPending);
				}
			};
			const scan = () => {
				if (stopped) return;
				drain();
				const current = options();
				const nextHidden = /* @__PURE__ */ new Set();
				const nextOrdered = [];
				const adopted = /* @__PURE__ */ new Set();
				const claimed = /* @__PURE__ */ new Set();
				const segments = [];
				for (const [node, binding] of bindings) {
					binding.visible = false;
					if (root.contains(node)) claimed.add(binding.source.id);
				}
				const visit = (element, path, snapshot, control) => {
					if (element.matches(EXCLUDED) || hidden(element)) {
						nextHidden.add(path);
						return;
					}
					snapshot ||= ledger.hiddenPaths.has(path) || snapshots.has(element);
					control ||= element.matches(CONTROLS);
					let index = 0;
					const summary = element.localName === "details" && !element.hasAttribute("open") ? element.querySelector(":scope > summary") : void 0;
					for (const child of element.childNodes) {
						if (child.nodeType !== Node.ELEMENT_NODE && child.nodeType !== Node.TEXT_NODE) continue;
						const childPath = `${path}/${index++}:${child.nodeType === Node.TEXT_NODE ? "text" : child.localName}`;
						if (summary !== void 0 && child !== summary) {
							nextHidden.add(childPath);
							continue;
						}
						if (child.nodeType === Node.ELEMENT_NODE) {
							visit(child, childPath, snapshot, control);
							continue;
						}
						const node = child;
						let binding = bindings.get(node);
						if (binding === void 0) {
							if (node.data.trim() === "") continue;
							let source = ledger.paths.get(childPath);
							if (source === void 0 || claimed.has(source.id)) {
								const structuralId = `${owner}:text:${childPath}`;
								source = {
									id: claimed.has(structuralId) ? `${structuralId}:${++ledger.nextId}` : structuralId,
									full: node.data
								};
							} else source.full = node.data;
							claimed.add(source.id);
							binding = {
								source,
								written: node.data,
								visible: true
							};
							bindings.set(node, binding);
						} else if (node.data !== binding.written) {
							binding.source.full = node.data;
							binding.written = node.data;
						}
						ledger.paths.set(childPath, binding.source);
						binding.visible = true;
						if (snapshot || snapshots.has(node) || ledger.hiddenPaths.has(childPath) || control || !current.animate || binding.source.full.trim() === "") {
							binding.source.baseline = binding.source.full;
							adopted.add(node);
							write(node, binding, binding.source.full);
						}
						const baseline = baselineLength(binding.source);
						segments.push({
							id: binding.source.id,
							order: [...current.order, nextOrdered.length],
							text: binding.source.full,
							sealed: true,
							...baseline === void 0 ? {} : { baselineChars: baseline }
						});
						nextOrdered.push(node);
					}
				};
				if (hiddenOutside(root)) nextHidden.add("root");
				else visit(root, "root", initial && current.revealInitial === false || ledger.hiddenPaths.has("root"), false);
				for (const [node, binding] of bindings) {
					if (binding.visible) continue;
					if (node.data !== binding.written) binding.source.full = node.data;
					if (root.contains(node)) binding.source.baseline = binding.source.full;
					write(node, binding, binding.source.full);
					if (!root.contains(node)) bindings.delete(node);
				}
				ordered = nextOrdered;
				ledger.hiddenPaths = nextHidden;
				snapshots.clear();
				initial = false;
				playback.upsert(owner, segments, current.animate);
				present(adopted);
				if (!ready) {
					ready = true;
					current.onReady?.();
				}
			};
			observer = typeof MutationObserver === "undefined" ? void 0 : new MutationObserver((mutations) => {
				if (!stopped && consume(mutations)) scan();
			});
			observer?.observe(root, {
				subtree: true,
				childList: true,
				characterData: true,
				characterDataOldValue: true,
				attributes: true,
				attributeOldValue: true,
				attributeFilter: OBSERVED_ATTRIBUTES
			});
			const ancestorObserver = typeof MutationObserver === "undefined" ? void 0 : new MutationObserver(() => {
				scan();
			});
			for (let ancestor = root.parentElement; ancestor !== null; ancestor = ancestor.parentElement) ancestorObserver?.observe(ancestor, {
				attributes: true,
				attributeFilter: OBSERVED_ATTRIBUTES
			});
			const unsubscribe = playback.subscribe(() => {
				if (stopped) return;
				if (drain()) scan();
				else present();
			});
			return {
				root,
				playback,
				owner,
				scan,
				dispose: () => {
					if (stopped) return;
					drain();
					stopped = true;
					unsubscribe();
					observer?.disconnect();
					ancestorObserver?.disconnect();
					for (const [node, binding] of bindings) if (node.data === binding.written) node.data = binding.source.full;
					bindings.clear();
					ordered = [];
					if (pending) options().onPendingChange?.(false);
					playback.remove(owner);
				}
			};
		}
		/** Adapt opaque native renderer Text nodes to the session's one shared queue. */
		function usePlaybackDomText(rootRef, options) {
			const latest = (0, react.useRef)(options);
			latest.current = options;
			const bridge = (0, react.useRef)(null);
			(0, react.useLayoutEffect)(() => {
				const root = rootRef.current;
				const { playback, owner, enabled } = latest.current;
				if (bridge.current !== null && (!enabled || !latest.current.animate || root !== bridge.current.root || playback !== bridge.current.playback || owner !== bridge.current.owner)) {
					bridge.current.dispose();
					bridge.current = null;
				}
				if (root === null || !enabled || !latest.current.animate) {
					latest.current.onPendingChange?.(false);
					latest.current.onReady?.();
					return;
				}
				bridge.current ??= createBridge(root, playback, owner, () => latest.current);
				bridge.current.scan();
			});
			(0, react.useLayoutEffect)(() => () => {
				bridge.current?.dispose();
				bridge.current = null;
			}, []);
		}
		//#endregion
		//#region src/client/reasoningPlayback.ts
		function visibleReasoningText(raw) {
			const opening = "<signature>";
			if (raw !== "" && opening.startsWith(raw)) return "";
			if (!raw.startsWith(opening)) return raw;
			const end = raw.indexOf("</signature>", 11);
			return end === -1 ? "" : raw.slice(end + 12).replace(/^(?:\r?\n)+/, "");
		}
		function reasoningSummary(raw, running) {
			const text = visibleReasoningText(raw);
			if (!running) {
				const newline = text.indexOf("\n");
				return {
					text: (newline === -1 ? text : text.slice(0, newline)).replaceAll("**", ""),
					paragraph: 0
				};
			}
			let result = {
				text: "",
				paragraph: 0
			};
			let start = 0;
			const separator = /\r?\n(?:[\t ]*\r?\n)+/g;
			while (true) {
				const next = separator.exec(text);
				const end = next === null ? text.length : next.index + next[0].indexOf("\n");
				const newline = text.indexOf("\n", start);
				if (newline !== -1 && newline <= end) {
					const first = text.slice(start, newline).trim();
					if (first !== "") result = {
						text: first.replaceAll("**", ""),
						paragraph: start
					};
				}
				if (next === null) return result;
				start = next.index + next[0].length;
			}
		}
		/**
		* ReasoningRow owns the native header and disclosure. Its running preview waits
		* for a newline, so feed only the paced summary plus that terminator while the
		* body is collapsed. The full raw text remains available through the Body Slot.
		* A source character without a newline keeps an empty-preview row mounted.
		*/
		function reasoningPreviewProjection(summary, raw) {
			return summary !== "" ? `${summary}\n` : visibleReasoningText(raw).trim().slice(0, 1) || "";
		}
		//#endregion
		//#region src/client/streamOrder.ts
		const STREAM_ORDER_DATA_KEY = "dsh-smooth-stream/order";
		/**
		* Read with node.location.step.data.get(STREAM_ORDER_DATA_KEY), then align against
		* the complete node.data.blocks before selecting reasoning/response group parts.
		* A settled/interrupted official node is durable boundary evidence even if this
		* Definition was registered late; an unknown running block remains unsealed.
		*/
		function alignStreamOrder(data, blocks, status = "running") {
			const aligned = data?.blockIndices.length === blocks.length;
			const settled = status !== "running" || data?.settled === true;
			const blockIndices = blocks.map((_, index) => aligned ? data?.blockIndices[index] : void 0);
			return {
				blockIndices,
				blockSeqs: blockIndices.map((index) => index === void 0 ? data?.settledSeq : data?.blockSeqs.get(index) ?? data?.settledSeq),
				sealedBlocks: blockIndices.map((index) => settled || index !== void 0 && data?.sealedBlocks.has(index) === true),
				attemptId: data?.attemptId,
				revision: data?.revision
			};
		}
		function coordinates(match) {
			const location = match.location;
			if (location.kind !== "step") return void 0;
			return {
				turn: location.step.turn,
				step: location.step.step
			};
		}
		function retryCoordinates(event) {
			if (event.type !== "llm/retry") return void 0;
			const data = event.data;
			return typeof data.turn === "number" && typeof data.step === "number" ? {
				turn: data.turn,
				step: data.step
			} : void 0;
		}
		function initialData(match, reason) {
			return {
				blockSeqs: /* @__PURE__ */ new Map(),
				sealedBlocks: /* @__PURE__ */ new Set(),
				blockIndices: [],
				attemptId: void 0,
				revision: {
					reason,
					seq: Number(match.event.seq)
				},
				settled: false,
				settledSeq: void 0
			};
		}
		function resetState(state, match, reason) {
			return {
				...state,
				data: initialData(match, reason),
				blockKinds: /* @__PURE__ */ new Map()
			};
		}
		function matchesStep(match, state) {
			const value = coordinates(match);
			return value?.turn === state.turn && value.step === state.step;
		}
		function assistantKind(type) {
			return type === "text" || type === "reasoning" || type === "tool-call" || type === "image" ? type : "other";
		}
		function settleMessage(state, match) {
			if (match.event.type !== "assistant/message") return state;
			const content = match.event.data.message.content;
			const indices = state.data.blockIndices;
			const sameShape = indices.length === content.length && content.every((block, index) => {
				const raw = indices[index];
				return raw !== void 0 && state.blockKinds.get(raw) === assistantKind(block.type);
			});
			return {
				...state,
				data: {
					...state.data,
					blockIndices: sameShape ? indices : content.map(() => void 0),
					settled: true,
					settledSeq: Number(match.event.seq)
				}
			};
		}
		function updateState(previous, match) {
			if (!matchesStep(match, previous)) return previous;
			const event = match.event;
			if (retryCoordinates(event) !== void 0) return resetState(previous, match, "retry");
			if (event.type === "assistant/attempt") return resetState(previous, match, "settlement");
			if (event.type === "assistant/message") return settleMessage(previous, match);
			if (event.type !== "assistant/live-chunk") return previous;
			let state = previous;
			const attemptId = String(event.data.attemptId);
			if (state.data.attemptId !== attemptId) {
				state = resetState(state, match, "attempt");
				state = {
					...state,
					data: {
						...state.data,
						attemptId
					}
				};
			}
			const chunk = event.data.chunk;
			if (chunk.type !== "block-start" && chunk.type !== "text-delta" && chunk.type !== "reasoning-delta" && chunk.type !== "tool-call-delta" && chunk.type !== "block-end") return state;
			const index = chunk.index;
			const kind = chunk.type === "block-start" ? chunk.blockType === "image" ? "other" : assistantKind(chunk.blockType) : chunk.type === "block-end" ? assistantKind(chunk.block.type) : chunk.type === "text-delta" ? "text" : chunk.type === "reasoning-delta" ? "reasoning" : "tool-call";
			const known = state.data.blockSeqs.has(index);
			const sealed = state.data.sealedBlocks.has(index);
			const ends = chunk.type === "block-end";
			const restarts = known && (chunk.type === "block-start" || !ends && sealed || state.blockKinds.get(index) !== kind);
			if (known && !restarts && sealed === ends) return state;
			let blockSeqs = state.data.blockSeqs;
			if (!known || chunk.type === "block-start") {
				const next = new Map(blockSeqs);
				next.set(index, Number(event.seq));
				blockSeqs = next;
			}
			let sealedBlocks = state.data.sealedBlocks;
			if (sealed !== ends) {
				const next = new Set(sealedBlocks);
				if (ends) next.add(index);
				else next.delete(index);
				sealedBlocks = next;
			}
			let blockKinds = state.blockKinds;
			if (blockKinds.get(index) !== kind) {
				const next = new Map(blockKinds);
				next.set(index, kind);
				blockKinds = next;
			}
			const blockIndices = known ? state.data.blockIndices : [...blockSeqs.keys()].sort((left, right) => left - right);
			return {
				...state,
				blockKinds,
				data: {
					...state.data,
					blockSeqs,
					sealedBlocks,
					blockIndices,
					revision: restarts ? {
						reason: "block-reset",
						seq: Number(event.seq)
					} : state.data.revision
				}
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
					const retry = retryCoordinates(event);
					if (retry !== void 0) return {
						id: `${retry.turn}:${retry.step}`,
						role: "update"
					};
					if (event.type === "assistant/live-chunk" || event.type === "assistant/attempt" || event.type === "assistant/message" && event.surfaceOp === "append") return {
						id: `${event.data.turn}:${event.data.step}`,
						role: "update"
					};
					return null;
				},
				start: (_context, match) => {
					const value = coordinates(match);
					if (value === void 0) throw new Error("stream order start outside a step");
					return updateState({
						...value,
						data: initialData(match, "start"),
						blockKinds: /* @__PURE__ */ new Map()
					}, match);
				},
				update: (context, match) => updateState(context.state, match),
				buildLocationData: (context, scope, previous) => {
					if (scope !== "step" || context.state === void 0) return null;
					if (previous?.key === "dsh-smooth-stream/order" && previous.value === context.state.data) return previous;
					return {
						kind: "step",
						turn: context.state.turn,
						step: context.state.step,
						key: STREAM_ORDER_DATA_KEY,
						value: context.state.data
					};
				}
			};
		}
		//#endregion
		//#region src/client/sessionPlaybackReact.tsx
		function identity(key, part) {
			return JSON.stringify([key, part ?? ""]);
		}
		function sourceIdentity(owner, node) {
			return typeof node?.key === "string" ? node.key : owner;
		}
		function segmentId(sourceKey, index) {
			return JSON.stringify([sourceKey, index]);
		}
		function summaryId(block) {
			return `${block}:summary`;
		}
		function blockIds(scope, node) {
			return scope.blocks(node).map((block) => segmentId(node.key, block.key));
		}
		/** One playback clock belongs to the injected Flow, never to a node renderer. */
		var PlaybackScope = class {
			baseline;
			playback = new SessionPlayback();
			preferences = DEFAULT_STREAM_SETTINGS;
			active = true;
			speedCps = 110;
			baselineRevision = 0;
			animatedOwners = /* @__PURE__ */ new Set();
			animations = /* @__PURE__ */ new Map();
			animatedSegments = /* @__PURE__ */ new Map();
			tools = /* @__PURE__ */ new Map();
			orders = /* @__PURE__ */ new Map();
			revision = 0;
			listeners = /* @__PURE__ */ new Set();
			flags = /* @__PURE__ */ new Map();
			registrations = /* @__PURE__ */ new Map();
			admittedBlocks = /* @__PURE__ */ new Set();
			blockIdentities = /* @__PURE__ */ new Map();
			constructor(baseline) {
				this.baseline = baseline;
			}
			isAnimated(id) {
				return this.animatedSegments.has(id);
			}
			hasAdmitted(id) {
				return this.admittedBlocks.has(id);
			}
			admit(id) {
				this.admittedBlocks.add(id);
				if (this.admittedBlocks.size > 2048) this.admittedBlocks.delete(this.admittedBlocks.values().next().value);
			}
			cardOrder(owner) {
				return this.orders.get(owner) ?? [];
			}
			hasDisclosureState(id) {
				return this.flag(`disclosure-known:${id}`);
			}
			reasoningCollapsed(id) {
				return this.hasDisclosureState(id) ? !this.flag(`expanded:${id}`) : false;
			}
			setAnimations(owner, ids) {
				for (const id of this.animations.get(owner) ?? []) {
					const count = this.animatedSegments.get(id) - 1;
					if (count === 0) this.animatedSegments.delete(id);
					else this.animatedSegments.set(id, count);
				}
				this.animations.set(owner, ids);
				for (const id of ids) this.animatedSegments.set(id, (this.animatedSegments.get(id) ?? 0) + 1);
			}
			blocks(node) {
				if (node.kind !== "assistant-step") return [];
				const previous = this.blockIdentities.get(node.key);
				if (previous?.node === node) return previous.blocks;
				const metadata = node.location.kind === "step" ? node.location.step.data.get(STREAM_ORDER_DATA_KEY) : void 0;
				const aligned = alignStreamOrder(metadata, node.data.blocks, node.data.status);
				const used = /* @__PURE__ */ new Set();
				const previousBlocks = previous?.node.kind === "assistant-step" ? previous.node.data.blocks : [];
				const blocks = node.data.blocks.map((block, index) => {
					const settled = aligned.attemptId === void 0 ? this.baseline.settledBlock(node.data.turn, node.data.step, aligned.blockSeqs[index] ?? node.anchorSeq, index, block.kind) : void 0;
					if (settled !== void 0) return {
						key: `wire:${settled.blockIndex}`,
						seq: settled.blockSeq,
						generation: JSON.stringify([
							settled.attemptId,
							settled.blockIndex,
							settled.blockSeq
						]),
						attemptId: settled.attemptId,
						wireIndex: settled.blockIndex
					};
					if (node.data.status !== "running" && aligned.attemptId === void 0 && previous !== void 0) {
						const matches = (candidate) => candidate.kind === block.kind && (block.kind === "text" || block.kind === "reasoning" ? (candidate.kind === "text" || candidate.kind === "reasoning") && block.text.startsWith(candidate.text) : candidate === block);
						let prior = !used.has(index) && previousBlocks[index] !== void 0 && matches(previousBlocks[index]) ? index : -1;
						if (prior === -1) prior = previousBlocks.findIndex((candidate, candidateIndex) => !used.has(candidateIndex) && matches(candidate));
						const retained = previous.blocks[prior];
						if (retained !== void 0) {
							used.add(prior);
							return retained;
						}
					}
					const wire = aligned.blockIndices[index];
					return {
						key: wire === void 0 ? `dense:${index}` : `wire:${wire}`,
						seq: aligned.blockSeqs[index] ?? node.anchorSeq,
						generation: JSON.stringify([
							aligned.attemptId,
							wire,
							metadata?.blockSeqs.get(wire ?? -1)
						]),
						attemptId: aligned.attemptId,
						wireIndex: wire
					};
				});
				this.blockIdentities.set(node.key, {
					node,
					blocks
				});
				if (this.blockIdentities.size > 2048) this.blockIdentities.delete(this.blockIdentities.keys().next().value);
				return blocks;
			}
			toolBoundary(node) {
				const location = node.location;
				if (location.kind !== "step") return Number.POSITIVE_INFINITY;
				let boundary = Number.POSITIVE_INFINITY;
				for (const tool of this.tools.values()) if (tool.location.kind === "step" && tool.location.step.turn === location.step.turn && tool.location.step.step === location.step.step) boundary = Math.min(boundary, tool.anchorSeq);
				return boundary;
			}
			register(owner, segments, node) {
				const sourceKey = sourceIdentity(owner, node);
				if (node?.kind !== "assistant-step" && segments[0] !== void 0) this.orders.set(owner, segments[0].order);
				const previousTool = this.tools.get(owner);
				if (node?.kind === "tool-call") this.tools.set(owner, node);
				else this.tools.delete(owner);
				if ((previousTool?.anchorSeq ?? Infinity) !== (this.tools.get(owner)?.anchorSeq ?? Infinity)) this.publish();
				const location = node?.location;
				const reason = location?.kind === "turn" || location?.kind === "step" ? location.turn.end?.data.reason.kind : void 0;
				const interrupted = node?.kind === "assistant-step" && node.data.status === "interrupted" || reason === "error" || reason === "aborted" || reason === "interrupted";
				const animated = new Set(segments.filter((segment) => segment.live && !interrupted).map((segment) => segment.id));
				this.setAnimations(owner, animated);
				if (animated.size > 0) this.animatedOwners.add(sourceKey);
				else this.animatedOwners.delete(sourceKey);
				this.playback.upsert(owner, segments, animated.size > 0);
			}
			subscribe = (listener) => {
				this.listeners.add(listener);
				return () => {
					this.listeners.delete(listener);
				};
			};
			snapshot = () => this.revision;
			flag(key) {
				return [...this.flags.get(key)?.values() ?? []].some(Boolean);
			}
			setFlag(key, token, value) {
				const values = this.flags.get(key) ?? /* @__PURE__ */ new Map();
				const previous = this.flag(key);
				values.set(token, value);
				this.flags.set(key, values);
				if (previous !== this.flag(key)) this.publish();
				return () => {
					const before = this.flag(key);
					values.delete(token);
					if (values.size === 0) this.flags.delete(key);
					if (before !== this.flag(key)) this.publish();
				};
			}
			publish() {
				this.revision++;
				for (const listener of [...this.listeners]) listener();
			}
			retain(owner) {
				const token = Symbol(owner);
				this.registrations.set(owner, token);
				return () => {
					queueMicrotask(() => {
						if (this.registrations.get(owner) !== token) return;
						this.registrations.delete(owner);
						this.setAnimations(owner, /* @__PURE__ */ new Set());
						this.animations.delete(owner);
						this.orders.delete(owner);
						if (this.tools.delete(owner)) this.publish();
						this.playback.remove(owner);
					});
				};
			}
		};
		const PlaybackContext = (0, react.createContext)(null);
		function useSessionPlayback() {
			return (0, react.useContext)(PlaybackContext)?.scope ?? null;
		}
		/** Determine closure only from the plugin projection or a durable assistant settlement. */
		function sealedBlocks(node) {
			if (node.kind !== "assistant-step") return [];
			if (node.data.status !== "running") return node.data.blocks.map(() => true);
			const location = node.location;
			const reason = location.kind === "step" || location.kind === "turn" ? location.turn.end?.data.reason.kind : void 0;
			if (reason === "error" || reason === "aborted" || reason === "interrupted") return node.data.blocks.map(() => true);
			return alignStreamOrder(location.kind === "step" ? location.step.data.get(STREAM_ORDER_DATA_KEY) : void 0, node.data.blocks, node.data.status).sealedBlocks;
		}
		function PlaybackNodeSource({ flow, scope, nodeKey, groupPart, order, groupKey, managedKinds }) {
			const node = flow.useChatNode(nodeKey, (value) => value);
			const controlRevision = (0, react.useSyncExternalStore)(scope.subscribe, scope.snapshot, scope.snapshot);
			const owner = identity(nodeKey, groupPart);
			const hidden = scope.flag(`hidden:${owner}`) || groupKey !== void 0 && scope.flag(`group:${groupKey}`);
			const shape = order.join(",");
			const segments = (0, react.useMemo)(() => {
				if (node === void 0 || !managedKinds.has(node.kind)) return [];
				if (node.kind !== "assistant-step") {
					const live = scope.baseline.isLiveSeq(node.anchorSeq);
					return [{
						id: segmentId(nodeKey, -1),
						order: [
							node.anchorSeq,
							...order,
							0
						],
						text: "",
						sealed: true,
						hidden,
						live,
						...live ? {} : { baselineChars: 0 },
						awaitPresentation: live
					}];
				}
				const sealed = sealedBlocks(node);
				const identities = scope.blocks(node);
				const ids = blockIds(scope, node);
				const toolBoundary = Math.min(scope.toolBoundary(node), ...node.data.blocks.flatMap((block, index) => block.kind === "tool-call" ? [identities[index].seq] : []));
				return node.data.blocks.flatMap((block, index) => {
					if (groupPart === "reasoning" && block.kind !== "reasoning") return [];
					if (groupPart === "response" && block.kind === "reasoning") return [];
					if (block.kind === "tool-call") return [];
					const blockIdentity = identities[index];
					const text = block.kind === "text" || block.kind === "reasoning" ? block.text : "";
					const baseline = scope.baseline.readBlock({
						turn: node.data.turn,
						step: node.data.step,
						attemptId: blockIdentity.attemptId,
						blockIndex: blockIdentity.wireIndex,
						blockSeq: blockIdentity.seq
					}, text);
					const id = ids[index];
					const generation = JSON.stringify([blockIdentity.generation, baseline.generation]);
					const suppressed = hidden || !scope.preferences.keepStreamOnToolCall && blockIdentity.seq <= toolBoundary && toolBoundary !== Infinity;
					const reasoning = block.kind === "reasoning";
					const reasoningRunning = reasoning && node.data.status === "running" && index === node.data.blocks.length - 1;
					const collapsed = reasoning && scope.reasoningCollapsed(id);
					const body = {
						id,
						order: [
							blockIdentity.seq,
							...order,
							index,
							1
						],
						generation,
						live: baseline.animate,
						...!baseline.animate || baseline.initialText !== "" ? { baselineChars: Array.from(baseline.initialText).length } : {},
						text,
						sealed: sealed[index] === true,
						hidden: suppressed || reasoning && (collapsed || scope.flag(`reasoning-hidden:${owner}`))
					};
					if (!reasoning) return [body];
					const summary = reasoningSummary(text, reasoningRunning);
					const initial = reasoningSummary(baseline.initialText, reasoningRunning);
					const baselineChars = !baseline.animate ? Array.from(summary.text).length : initial.paragraph === summary.paragraph ? Array.from(initial.text).length : 0;
					return [{
						id: summaryId(id),
						order: [
							blockIdentity.seq,
							...order,
							index,
							0
						],
						generation: JSON.stringify([generation, summary.paragraph]),
						live: baseline.animate,
						...baselineChars > 0 || !baseline.animate ? { baselineChars } : {},
						text: summary.text,
						sealed: true,
						hidden: suppressed || reasoning && (scope.hasDisclosureState(id) && !collapsed || scope.flag(`reasoning-hidden:${owner}`))
					}, body];
				});
			}, [
				node,
				owner,
				shape,
				controlRevision,
				hidden,
				groupPart,
				managedKinds,
				scope,
				scope.preferences.thinkAutoExpand,
				scope.preferences.keepStreamOnToolCall,
				scope.baselineRevision
			]);
			(0, react.useLayoutEffect)(() => scope.retain(owner), [scope, owner]);
			(0, react.useLayoutEffect)(() => groupKey === void 0 ? void 0 : scope.setFlag(`unmanaged:${groupKey}`, owner, node !== void 0 && !managedKinds.has(node.kind)), [
				scope,
				groupKey,
				owner,
				node?.kind,
				managedKinds
			]);
			(0, react.useEffect)(() => {
				scope.register(owner, segments, node);
			}, [
				scope,
				owner,
				segments,
				node
			]);
			return null;
		}
		function PlaybackGroupSource({ flow, scope, groupKey, order, managedKinds }) {
			const group = flow.useChatGroup(groupKey, (value) => value);
			return (0, react.createElement)(react.Fragment, null, ...group?.members.map((member, index) => (0, react.createElement)(PlaybackNodeSource, {
				key: identity(member.key, member.groupPart),
				flow,
				scope,
				nodeKey: member.key,
				groupPart: member.groupPart,
				order: [...order, index],
				groupKey: String(groupKey),
				managedKinds
			})) ?? []);
		}
		/** Original Hooks own disclosures and search/focus; observe only the refs they hand us. */
		function useVisibilityHook(original, scope) {
			return (0, react.useMemo)(() => function usePlaybackVisibility(hidden, reveal) {
				const ref = original(hidden, reveal);
				const token = (0, react.useId)();
				(0, react.useLayoutEffect)(() => {
					const element = ref.current;
					if (element === null) return;
					const group = element.hasAttribute("data-chat-group-key") ? element : element.hasAttribute("data-step-process-body") ? element.closest("[data-chat-group-key]") : null;
					if (group !== null) return scope.setFlag(`group:${group.dataset.chatGroupKey}`, token, hidden);
					const seat = element.closest("[data-chat-node-key]");
					if (seat?.dataset.chatNodeKey !== void 0) {
						const owner = identity(seat.dataset.chatNodeKey, seat.dataset.chatGroupPart);
						return scope.setFlag(`${element === seat ? "hidden" : "reasoning-hidden"}:${owner}`, token, hidden);
					}
				}, [
					hidden,
					ref,
					token
				]);
				return ref;
			}, [original, scope]);
		}
		function SessionPlaybackFlow({ Inner, props, settings, managedNodeKinds, preset = "balanced" }) {
			const builder = props.useChat((snapshot) => snapshot.nodes);
			return (0, react.createElement)(SessionPlaybackFlowScope, {
				key: String(props.sessionId),
				Inner,
				props,
				settings,
				managedNodeKinds,
				builder,
				preset
			});
		}
		function SessionPlaybackFlowScope({ Inner, props, settings, managedNodeKinds, builder, preset }) {
			const preferences = (0, react.useSyncExternalStore)(settings.subscribe, settings.getSnapshot, settings.getSnapshot);
			const runtimeTuning = (0, react.useSyncExternalStore)(debugRuntime.subscribe, debugRuntime.activeTuning, debugRuntime.activeTuning);
			const tuning = debugRuntime.getSnapshot().available ? runtimeTuning : preferences.debugTuningEnabled ? preferences.debugTuning : DEFAULT_STREAM_DEBUG_TUNING;
			const baseline = (0, react.useMemo)(() => createEntryBaseline(String(props.sessionId)), []);
			const scope = (0, react.useMemo)(() => new PlaybackScope(baseline), [baseline]);
			scope.baselineRevision = (0, react.useSyncExternalStore)(baseline.subscribe, baseline.getSnapshot, baseline.getSnapshot);
			scope.preferences = preferences;
			const lifetime = (0, react.useRef)(0);
			const [reduced, setReduced] = (0, react.useState)(() => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches);
			(0, react.useEffect)(() => {
				if (typeof matchMedia !== "function") return;
				const query = matchMedia("(prefers-reduced-motion: reduce)");
				const update = () => setReduced(query.matches);
				query.addEventListener("change", update);
				return () => query.removeEventListener("change", update);
			}, []);
			const takeover = (0, react.useCallback)(() => settings.takeoverEnabled?.() ?? true, [settings]);
			const active = (0, react.useSyncExternalStore)(settings.subscribe, takeover, takeover) && preferences.enabled && preferences.motionPreference !== "force-reduced" && !(preferences.motionPreference === "auto" && reduced);
			scope.active = active;
			(0, react.useLayoutEffect)(() => {
				scope.speedCps = PRESET_CONFIG[preset].defaultCps * tuning.revealScale;
				scope.playback.configure({
					charsPerSecond: PRESET_CONFIG[preset].defaultCps,
					tuning
				});
				scope.playback.setEnabled(active);
			}, [
				scope,
				active,
				preset,
				tuning
			]);
			(0, react.useEffect)(() => {
				const generation = ++lifetime.current;
				return () => {
					queueMicrotask(() => {
						if (lifetime.current === generation) {
							scope.playback.dispose();
							baseline.dispose();
						}
					});
				};
			}, [scope, baseline]);
			const useGroupAction = useVisibilityHook(props.useGroupAction, scope);
			const useChatGroup = (0, react.useMemo)(() => function usePlaybackGroup(key, selector) {
				const group = props.useChatGroup(key, (value) => value);
				(0, react.useSyncExternalStore)(scope.subscribe, scope.snapshot, scope.snapshot);
				const read = (0, react.useCallback)(() => group?.members.length === 0 || scope.flag(`unmanaged:${key}`) || (group?.members.some((member) => {
					const node = builder === void 0 ? void 0 : builder.get(member.key);
					if (node === void 0) return false;
					if (!managedNodeKinds.has(node.kind)) return true;
					const ids = blockIds(scope, node);
					return node.kind === "assistant-step" ? node.data.blocks.some((block, index) => (member.groupPart === "reasoning" ? block.kind === "reasoning" : member.groupPart === "response" ? block.kind !== "reasoning" : true) && (scope.playback.read(ids[index]).entered || block.kind === "reasoning" && scope.playback.read(summaryId(ids[index])).entered)) : scope.playback.read(segmentId(member.key, -1)).entered;
				}) ?? false), [
					scope,
					group,
					builder,
					managedNodeKinds,
					key
				]);
				const entered = (0, react.useSyncExternalStore)(scope.playback.subscribe, read, read);
				const admitted = (0, react.useRef)({
					key,
					entered: false
				});
				if (admitted.current.key !== key) admitted.current = {
					key,
					entered: false
				};
				admitted.current.entered ||= entered;
				const visible = !active || admitted.current.entered ? group : void 0;
				return selector ? selector(visible) : visible;
			}, [
				props.useChatGroup,
				scope,
				active,
				builder,
				managedNodeKinds
			]);
			const sources = props.entries.map((entry, index) => entry.kind === "node" ? (0, react.createElement)(PlaybackNodeSource, {
				key: identity(entry.key, entry.groupPart),
				flow: props,
				scope,
				nodeKey: entry.key,
				groupPart: entry.groupPart,
				order: [index, 0],
				managedKinds: managedNodeKinds
			}) : (0, react.createElement)(PlaybackGroupSource, {
				key: `group:${entry.key}`,
				flow: props,
				scope,
				groupKey: entry.key,
				order: [index],
				managedKinds: managedNodeKinds
			}));
			return (0, react.createElement)(PlaybackContext.Provider, { value: {
				scope,
				active
			} }, ...sources, (0, react.createElement)(Inner, {
				...props,
				key: "official-flow",
				useGroupAction,
				useChatGroup
			}));
		}
		/** Wrap the shipped renderer, changing only its displayed data. No second Chat UI. */
		function SessionPlaybackNode({ Inner, owner }) {
			const { scope, active } = (0, react.useContext)(PlaybackContext);
			const node = owner.node;
			const sourceKey = String(node?.key);
			const ownerKey = identity(sourceKey, owner.groupPart);
			const ids = (0, react.useMemo)(() => {
				if (node?.kind !== "assistant-step") return [segmentId(sourceKey, -1)];
				const all = blockIds(scope, node);
				return node.data.blocks.flatMap((block, index) => {
					if (owner.groupPart === "reasoning" && block.kind !== "reasoning") return [];
					if (owner.groupPart === "response" && block.kind === "reasoning") return [];
					return block.kind === "tool-call" ? [] : block.kind === "reasoning" ? [summaryId(all[index]), all[index]] : [all[index]];
				});
			}, [
				node,
				owner.groupPart,
				sourceKey,
				scope
			]);
			const previous = (0, react.useRef)([]);
			const read = (0, react.useCallback)(() => {
				const next = ids.map((id) => scope.playback.read(id));
				if (next.length !== previous.current.length || next.some((value, index) => value !== previous.current[index])) previous.current = next;
				return previous.current;
			}, [scope, ids]);
			(0, react.useSyncExternalStore)(scope.playback.subscribe, read, read);
			(0, react.useSyncExternalStore)(scope.subscribe, scope.snapshot, scope.snapshot);
			if (!active) return (0, react.createElement)(Inner, owner);
			if (node?.kind !== "assistant-step") return scope.playback.read(segmentId(sourceKey, -1)).entered ? (0, react.createElement)(SessionPlaybackAtomic, {
				Inner,
				owner,
				scope,
				sourceKey
			}) : null;
			return (0, react.createElement)(SessionPlaybackAssistant, {
				Inner,
				owner,
				scope,
				ownerKey
			});
		}
		/** Native cards retain their elements; visible text shares the session clock. */
		function SessionPlaybackAtomic({ Inner, owner, scope, sourceKey }) {
			const root = (0, react.useRef)(null);
			const speed = (0, react.useRef)(scope.speedCps);
			speed.current = scope.speedCps;
			const extent = (0, react.useRef)(null);
			const id = segmentId(sourceKey, -1);
			const [entering, setEntering] = (0, react.useState)(() => scope.preferences.controlScroll && scope.animatedOwners.has(sourceKey) && scope.playback.read(id).pending);
			const revealInitial = (0, react.useRef)(scope.playback.read(id).pending);
			const [captured, setCaptured] = (0, react.useState)(false);
			const [textPending, setTextPending] = (0, react.useState)(false);
			const ready = (0, react.useCallback)(() => {
				setCaptured(true);
			}, []);
			const commit = (0, react.useCallback)(() => {
				notifyFollowCommit(root.current);
			}, []);
			const ownerKey = identity(sourceKey, owner.groupPart);
			const sourceOrder = scope.cardOrder(ownerKey);
			const orderKey = sourceOrder.join(",");
			const textOrder = (0, react.useMemo)(() => [...sourceOrder.slice(0, -1), 1], [orderKey]);
			usePlaybackDomText(root, {
				playback: scope.playback,
				owner: `${ownerKey}:visible`,
				order: textOrder,
				animate: scope.isAnimated(id),
				enabled: scope.active,
				revealInitial: revealInitial.current,
				onReady: ready,
				onPendingChange: setTextPending,
				onCommit: commit
			});
			const finish = (0, react.useCallback)(() => {
				extent.current = null;
				setEntering(false);
				scope.playback.acknowledgePresentation(id);
			}, [scope, id]);
			const awaiting = scope.playback.read(id).pending;
			(0, react.useLayoutEffect)(() => {
				if (!captured) return;
				if (!awaiting) {
					extent.current = null;
					setEntering(false);
					return;
				}
				const element = root.current;
				const port = element?.closest("[data-conversation-scroll]");
				if (!entering || !scope.preferences.controlScroll || !port?.isConnected || port.clientHeight <= 0 || !element || element.getBoundingClientRect().height <= 0) finish();
			}, [
				scope,
				entering,
				awaiting,
				captured,
				scope.preferences.controlScroll,
				finish
			]);
			const growth = (0, react.useCallback)((delta) => {
				if (!scope.preferences.controlScroll || !scope.playback.read(id).pending) return;
				extent.current = (extent.current ?? 0) + delta;
				setEntering(true);
				notifyFollowCommit(root.current);
			}, [scope, id]);
			return (0, react.createElement)(FollowHost, {
				active: textPending,
				entrance: entering && scope.playback.read(id).pending,
				onEntranceSettled: finish,
				onGrowth: scope.preferences.controlScroll ? growth : void 0,
				entranceExtentRef: extent,
				speedCpsRef: speed,
				hostRef: root,
				predictive: false,
				controlScroll: scope.preferences.controlScroll,
				children: (0, react.createElement)(Inner, owner)
			});
		}
		function ReasoningBodyRegistration({ scope, keys, children }) {
			const token = (0, react.useId)();
			(0, react.useLayoutEffect)(() => {
				const off = JSON.parse(keys).map((key) => scope.setFlag(`expanded:${key}`, token, true));
				return () => {
					for (const release of off) release();
				};
			}, [
				scope,
				keys,
				token
			]);
			return (0, react.createElement)(react.Fragment, null, children);
		}
		function SessionPlaybackAssistant({ Inner, owner, scope, ownerKey }) {
			const { node } = owner;
			const root = (0, react.useRef)(null);
			const speed = (0, react.useRef)(scope.speedCps);
			speed.current = scope.speedCps;
			const revealed = (0, react.useRef)(0);
			const ids = blockIds(scope, node);
			const disclosed = (0, react.useRef)(/* @__PURE__ */ new Map());
			const mountedReasoning = (0, react.useRef)([]);
			const officialDisclosure = owner.useDisclosure;
			const reasoningPending = node.data.blocks.some((block, index) => block.kind === "reasoning" && scope.isAnimated(ids[index]) && scope.playback.read(ids[index]).pending);
			const useDisclosure = (0, react.useMemo)(() => function usePlaybackDisclosure() {
				const disclosure = officialDisclosure();
				const token = (0, react.useId)();
				const manual = (0, react.useRef)(false);
				const autoOpened = (0, react.useRef)(false);
				const autoExpand = !manual.current && scope.preferences.thinkAutoExpand && reasoningPending;
				(0, react.useLayoutEffect)(() => {
					if (manual.current) return;
					if (autoExpand && !disclosure.expanded) {
						autoOpened.current = true;
						disclosure.setExpanded(true);
					} else if (!autoExpand && autoOpened.current) {
						autoOpened.current = false;
						disclosure.setExpanded(false);
					}
				}, [
					disclosure.setExpanded,
					disclosure.expanded,
					autoExpand
				]);
				(0, react.useLayoutEffect)(() => {
					const assigned = new Set(disclosed.current.values());
					const id = mountedReasoning.current.find((key) => !assigned.has(key));
					if (id === void 0) return;
					disclosed.current.set(token, id);
					const release = scope.setFlag(`disclosure-known:${id}`, token, !autoExpand || disclosure.expanded);
					const releaseExpanded = scope.setFlag(`expanded:${id}`, token, disclosure.expanded);
					return () => {
						disclosed.current.delete(token);
						release();
						releaseExpanded();
					};
				}, [
					scope,
					token,
					disclosure.expanded,
					autoExpand
				]);
				return {
					...disclosure,
					setExpanded: (value) => {
						manual.current = true;
						autoOpened.current = false;
						disclosure.setExpanded(value);
					},
					toggle: () => {
						manual.current = true;
						autoOpened.current = false;
						disclosure.toggle();
					}
				};
			}, [
				officialDisclosure,
				ownerKey,
				scope,
				reasoningPending
			]);
			const projected = [];
			let pending = false;
			let entered = false;
			for (const [index, block] of node.data.blocks.entries()) {
				if (!(owner.groupPart === "reasoning" ? block.kind === "reasoning" : owner.groupPart === "response" ? block.kind !== "reasoning" : true) || block.kind === "tool-call") {
					projected.push(block);
					continue;
				}
				const id = ids[index];
				const display = scope.playback.read(id);
				const summary = block.kind === "reasoning" ? scope.playback.read(summaryId(id)) : void 0;
				if (display.entered || summary?.entered === true) scope.admit(id);
				const admitted = scope.hasAdmitted(id) || display.entered || summary?.entered === true;
				pending ||= scope.isAnimated(id) && display.pending;
				pending ||= summary !== void 0 && scope.isAnimated(summaryId(id)) && summary.pending;
				entered ||= admitted;
				const collapsed = block.kind === "reasoning" && (!scope.hasDisclosureState(id) || scope.reasoningCollapsed(id));
				const summaryText = block.kind === "reasoning" ? reasoningPreviewProjection(summary?.text ?? "", block.text) : "";
				const text = block.kind !== "reasoning" ? display.text : collapsed ? summaryText : display.text !== "" ? display.text : admitted ? `<signature>${id}</signature>\u200B` : "";
				projected.push(!admitted ? {
					kind: "text",
					text: ""
				} : block.kind === "text" || block.kind === "reasoning" ? {
					...block,
					text
				} : block);
			}
			mountedReasoning.current = projected.flatMap((block, index) => block.kind === "reasoning" && block.text.trim() !== "" && (owner.groupPart === void 0 || owner.groupPart === "reasoning") ? [ids[index]] : []);
			const displayedLength = projected.reduce((sum, block) => sum + (block.kind === "text" || block.kind === "reasoning" ? block.text.length : 0), 0);
			(0, react.useLayoutEffect)(() => {
				revealed.current = displayedLength;
				if (pending) notifyFollowCommit(root.current);
			}, [displayedLength, pending]);
			const renderSlot = (0, react.useMemo)(() => {
				if (owner.renderSlot === void 0) return void 0;
				const render = owner.renderSlot;
				const raw = /* @__PURE__ */ new Map();
				for (const [index, block] of projected.entries()) {
					const original = node.data.blocks[index];
					if (block.kind !== "reasoning" || original?.kind !== "reasoning") continue;
					const bodyText = scope.playback.read(ids[index]).text;
					const previous = raw.get(block.text);
					if (!raw.has(block.text)) raw.set(block.text, {
						original: original.text,
						indices: [index],
						bodyText
					});
					else if (previous === void 0 || previous.original !== original.text || previous.bodyText !== bodyText) raw.set(block.text, void 0);
					else raw.set(block.text, {
						...previous,
						indices: [...previous.indices, index]
					});
				}
				return ((name, props, ...args) => {
					if (name === "conversation.chat.reasoning.body" && typeof props.rawText === "string") {
						const source = raw.get(props.rawText);
						if (source !== void 0) {
							const children = render(name, {
								...props,
								rawText: source.original,
								text: visibleReasoningText(source.bodyText)
							}, ...args);
							return source.indices.length === 1 ? (0, react.createElement)(ReasoningBodyRegistration, {
								scope,
								keys: JSON.stringify([ids[source.indices[0]]]),
								children
							}) : children;
						}
					}
					return render(name, props, ...args);
				});
			}, [
				owner.renderSlot,
				node.data.blocks,
				projected,
				ownerKey,
				scope
			]);
			if (!entered) return null;
			return (0, react.createElement)(FollowHost, {
				active: pending,
				speedCpsRef: speed,
				revealedCharsRef: revealed,
				hostRef: root,
				controlScroll: scope.preferences.controlScroll,
				predictive: false,
				children: (0, react.createElement)(Inner, {
					...owner,
					useDisclosure,
					...renderSlot === void 0 ? {} : { renderSlot },
					node: {
						...node,
						data: {
							...node.data,
							blocks: projected,
							status: pending ? "running" : node.data.status
						}
					}
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
		//#region src/client/flowPresentationAdapter.tsx
		const CHAT_FLOW_SLOT = "conversation.chat.flow";
		const CHAT_NODE_SLOT = "conversation.chat.node";
		/** Keep the official Flow entry, options, and owned child slots intact. */
		function installFlowPresentationAdapter(ctx, settings, canManageRenderer, preset = "balanced") {
			const originals = /* @__PURE__ */ new Map();
			const listeners = /* @__PURE__ */ new Set();
			let revision = 0;
			let disposed = false;
			let lastFlowVersion = ctx.slots.getVersion(CHAT_FLOW_SLOT);
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
					lastFlowVersion = ctx.slots.getVersion(CHAT_FLOW_SLOT);
					lastNodeVersion = ctx.slots.getVersion(CHAT_NODE_SLOT);
				}
				return `${lastFlowVersion}:${lastNodeVersion}:${revision}:${disposed}`;
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
						const managedNodeKinds = (0, react.useMemo)(() => new Set(disposed ? [] : ctx.slots.entries(CHAT_NODE_SLOT).filter((nodeEntry) => nodeEntry.options.key !== void 0 && canManageRenderer(nodeEntry.options.key, nodeEntry.component)).map((nodeEntry) => String(nodeEntry.options.key))), [version]);
						return disposed ? (0, react.createElement)(Inner, props) : (0, react.createElement)(SessionPlaybackFlow, {
							Inner,
							props,
							settings,
							managedNodeKinds,
							preset
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
		//#region src/client/locales.ts
		/** Locale bundles for the smooth-stream plugin configuration card. */
		/** Dictionary namespace owned by this plugin's settings card. */
		const NS = "settings.smoothStream";
		/** English copy. */
		const en = {
			title: "Smooth stream",
			description: "How visible text in replies, native cards, and thinking summaries and bodies is paced while streaming.",
			enabled: "Enable smooth streaming",
			enabledHint: "Pace visible text in assistant replies and native cards, plus collapsed thinking summaries and expanded thinking bodies, and follow the stream. Turn off to use the built-in Harness renderer.",
			controlScroll: "Take over scrolling",
			controlScrollHint: "On by default; smooth-stream writes the conversation scroll position. Turn off to leave bottom-follow to Harness.",
			motionPreference: "Motion",
			motionPreferenceHint: "How streaming responds to the system reduce-motion setting.",
			motionAuto: "Follow system",
			motionAutoHint: "Reduced-motion systems get raw text (accessibility first).",
			motionForceSmooth: "Always smooth",
			motionForceSmoothHint: "Keep the smoothing engine even when the system asks for reduced motion.",
			motionForceReduced: "Always raw",
			motionForceReducedHint: "Render raw text even when the system allows motion.",
			thinkAutoExpand: "Auto-expand thinking",
			fastFold: "Fast fold acceleration",
			fastFoldHint: "Detach collapsed tool steps from the layout tree using display: none, eliminating reflow stutter during streaming in long conversations.",
			fastPipeline: "Fast dispatch pipeline (Heal DSH 3-frame throttle)",
			fastPipelineHint: "Bypass DSH 3-frame nested requestAnimationFrame throttle (~50ms delay per chunk) into instant native single-frame rendering, making streaming output completely responsive.",
			keepStreamOnToolCall: "Keep streaming before tool calls",
			keepStreamOnToolCallHint: "Do not end text streaming early when followed by a tool call; preserve fluid typewriter reveal.",
			thinkAutoExpandHint: "Open thinking while it streams. Turn off to keep it collapsed; you can still open it manually.",
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
			debugCaptureStart: "Start diagnostics capture",
			debugCaptureStopCopy: "Stop and copy diagnostics capture",
			debugCaptureCopied: "Diagnostics capture copied",
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
			description: "控制助手回复、原生卡片可见文字，以及思考摘要与正文的流式播放方式。",
			enabled: "启用丝滑流式渲染",
			enabledHint: "逐字播放助手回复、原生卡片可见文字及折叠思考摘要/展开正文，并跟随流式进度；关闭后使用 Harness 内置渲染。",
			controlScroll: "接管滚动",
			controlScrollHint: "默认开启，由丝滑流式写入会话滚动位置；关闭后贴底滚动交给 Harness。",
			motionPreference: "动效偏好",
			motionPreferenceHint: "流式渲染如何响应系统的「减少动态效果」设置。",
			motionAuto: "跟随系统",
			motionAutoHint: "系统开启减少动态效果时直接呈现原始文本（优先无障碍）。",
			motionForceSmooth: "始终平滑",
			motionForceSmoothHint: "即使系统要求减少动态效果，仍保持平滑流式渲染。",
			motionForceReduced: "始终原始",
			motionForceReducedHint: "即使系统允许动效，也直接呈现原始文本。",
			thinkAutoExpand: "自动展开思考",
			fastFold: "折叠彻底跳过排版（长对话极速出字）",
			fastFoldHint: "收起已完成的工具步骤时使用 display: none 彻底脱离排版树，根除长对话下出字与滚动的严重卡顿（仅失去针对收缩内容的 Ctrl+F 页面搜索）。",
			fastPipeline: "解除 DSH 官方 3 帧限制（极速吐字自愈）",
			fastPipelineHint: "DSH 官方核心写死了 3 重嵌套 requestAnimationFrame（每 50ms 仅刷新一次，长对话严重顿挫）。插件在内存中将其自愈为原生单帧极速派发，出字顺滑跟手。",
			keepStreamOnToolCall: "工具引导语保持流式",
			keepStreamOnToolCallHint: "文字后紧接工具调用时不提前宣告结束，让短引导语保持平滑打字。",
			thinkAutoExpandHint: "流式时自动展开思考；关闭后保持收起，仍可手动点开。",
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
			debugCaptureStart: "开始捕获渲染诊断",
			debugCaptureStopCopy: "停止并复制渲染诊断",
			debugCaptureCopied: "渲染诊断已复制",
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
		//#region \0dsh-css:/root/workspaces/DSH项目维护/dsh-smooth-stream-unified/src/client/SmoothStreamCard.module.css.mjs
		const css$1 = ".ZrUzTG_card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px;flex-direction:column;list-style:none;transition:border-color .16s,background .16s;display:flex}.ZrUzTG_card:hover{border-color:var(--dsw-alias-label-dimmed)}.ZrUzTG_cardOpen{border-color:var(--dsw-alias-label-dimmed);background:var(--dsw-alias-bg-layer-2)}.ZrUzTG_header{appearance:none;cursor:pointer;text-align:left;width:100%;font:inherit;color:inherit;background:0 0;border:0;border-radius:12px;align-items:center;gap:12px;padding:14px 16px;display:flex}.ZrUzTG_header:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}.ZrUzTG_headText{flex-direction:column;flex:1;gap:4px;min-width:0;display:flex}.ZrUzTG_name{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4}.ZrUzTG_description{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5}.ZrUzTG_version{text-overflow:ellipsis;white-space:nowrap;max-width:16rem;color:var(--dsw-alias-label-tertiary);flex:none;font-size:12px;line-height:1.5;overflow:hidden}.ZrUzTG_pending{background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);white-space:nowrap;border-radius:999px;flex:none;padding:1px 8px;font-size:11px;font-weight:500;line-height:17px}.ZrUzTG_chevron{color:var(--dsw-alias-label-tertiary);flex:none;transition:transform .16s}.ZrUzTG_chevronOpen{transform:rotate(180deg)}.ZrUzTG_body{border-top:1px solid var(--dsw-alias-border-l2);flex-direction:column;margin:0 16px;padding-bottom:8px;display:flex}.ZrUzTG_readOnly{color:var(--dsw-alias-label-tertiary);margin:12px 0 0;font-size:12px;line-height:1.5}.ZrUzTG_field{flex-direction:column;gap:6px;padding:12px 0;display:flex}.ZrUzTG_field+.ZrUzTG_field{border-top:1px solid var(--dsw-alias-border-l2)}.ZrUzTG_fieldDisabled{opacity:.5}.ZrUzTG_fieldHead{justify-content:space-between;align-items:center;gap:8px;display:flex}.ZrUzTG_label{min-width:0;color:var(--dsw-alias-label-primary);flex:1;font-size:13px;font-weight:500;line-height:1.5}.ZrUzTG_toggle{width:16px;height:16px;accent-color:var(--dsw-alias-brand-primary);cursor:pointer}.ZrUzTG_toggle:disabled{cursor:default}.ZrUzTG_toggle:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}.ZrUzTG_choiceRow{flex-wrap:wrap;gap:6px 14px;margin:2px 0 0;padding:0;display:flex}.ZrUzTG_choice{color:var(--dsw-alias-label-secondary);cursor:pointer;align-items:center;gap:5px;font-size:12px;line-height:1.5;display:flex}.ZrUzTG_choiceInput{width:14px;height:14px;accent-color:var(--dsw-alias-brand-primary);cursor:pointer}.ZrUzTG_choice:has(.ZrUzTG_choiceInput:disabled){cursor:default;opacity:.55}.ZrUzTG_choiceInput:disabled{cursor:default}.ZrUzTG_hint{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:1.5}.ZrUzTG_failure{justify-content:space-between;align-items:center;gap:12px;padding:12px 0;display:flex}.ZrUzTG_updateRow{border-top:1px solid var(--dsw-alias-border-l2);justify-content:space-between;align-items:center;gap:12px;padding:12px 0;display:flex}.ZrUzTG_updateCopy{flex-direction:column;gap:4px;min-width:0;display:flex}.ZrUzTG_footer{border-top:1px solid var(--dsw-alias-border-l2);justify-content:flex-end;align-items:center;gap:8px;padding:12px 0 4px;display:flex}.ZrUzTG_failed{min-width:0;color:var(--dsw-alias-label-error);flex:1;margin:0;font-size:12px;line-height:1.5}.ZrUzTG_save,.ZrUzTG_discard,.ZrUzTG_update{appearance:none;font:inherit;cursor:pointer;border:1px solid #0000;border-radius:8px;padding:5px 14px;font-size:13px;line-height:1.5}.ZrUzTG_save{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3)}.ZrUzTG_discard{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);background:0 0}.ZrUzTG_discard:hover:not(:disabled),.ZrUzTG_update:hover:not(:disabled){border-color:var(--dsw-alias-label-dimmed);color:var(--dsw-alias-label-primary)}.ZrUzTG_update{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);background:0 0;flex:none;align-items:center;gap:6px;display:inline-flex}.ZrUzTG_discard:disabled,.ZrUzTG_save:disabled,.ZrUzTG_update:disabled{opacity:.4;cursor:default}.ZrUzTG_discard:focus-visible,.ZrUzTG_save:focus-visible,.ZrUzTG_update:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}";
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
			"hint": "ZrUzTG_hint",
			"footer": "ZrUzTG_footer",
			"failure": "ZrUzTG_failure",
			"choice": "ZrUzTG_choice",
			"chevron": "ZrUzTG_chevron",
			"headText": "ZrUzTG_headText",
			"save": "ZrUzTG_save",
			"update": "ZrUzTG_update",
			"name": "ZrUzTG_name",
			"header": "ZrUzTG_header",
			"card": "ZrUzTG_card",
			"choiceRow": "ZrUzTG_choiceRow",
			"updateCopy": "ZrUzTG_updateCopy",
			"choiceInput": "ZrUzTG_choiceInput",
			"version": "ZrUzTG_version",
			"readOnly": "ZrUzTG_readOnly",
			"updateRow": "ZrUzTG_updateRow",
			"cardOpen": "ZrUzTG_cardOpen",
			"fieldDisabled": "ZrUzTG_fieldDisabled",
			"body": "ZrUzTG_body",
			"fieldHead": "ZrUzTG_fieldHead",
			"failed": "ZrUzTG_failed",
			"discard": "ZrUzTG_discard",
			"pending": "ZrUzTG_pending",
			"field": "ZrUzTG_field",
			"toggle": "ZrUzTG_toggle",
			"label": "ZrUzTG_label",
			"description": "ZrUzTG_description",
			"chevronOpen": "ZrUzTG_chevronOpen"
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
				thinkAutoExpand: false,
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
					version: state.version ?? "0.11.0-rebuild.2",
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
						if (patch.enabled !== void 0 || patch.controlScroll !== void 0 || patch.motionPreference !== void 0 || patch.thinkAutoExpand !== void 0 || patch.fastFold !== void 0 || patch.fastPipeline !== void 0 || patch.keepStreamOnToolCall !== void 0) this.stagedBase = {
							...this.baseValues(),
							...patch.enabled === void 0 ? {} : { enabled: patch.enabled },
							...patch.controlScroll === void 0 ? {} : { controlScroll: patch.controlScroll },
							...patch.motionPreference === void 0 ? {} : { motionPreference: patch.motionPreference },
							...patch.thinkAutoExpand === void 0 ? {} : { thinkAutoExpand: patch.thinkAutoExpand },
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
					thinkAutoExpand: this.loaded?.thinkAutoExpand ?? DEFAULT_STREAM_SETTINGS.thinkAutoExpand,
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
						thinkAutoExpand: DEFAULT_STREAM_SETTINGS.thinkAutoExpand,
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
						version: "0.11.0-rebuild.2",
						installation: "development",
						writable: true,
						enabled: fallback.enabled,
						controlScroll: fallback.controlScroll,
						motionPreference: fallback.motionPreference,
						thinkAutoExpand: fallback.thinkAutoExpand,
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
			].includes(data.motionPreference) || typeof data.thinkAutoExpand !== "boolean" || data.keepStreamOnToolCall !== void 0 && typeof data.keepStreamOnToolCall !== "boolean" || typeof data.canUpgrade !== "boolean") throw new Error("dsh-smooth-stream: malformed settings response");
			return {
				version: data.version,
				installation: data.installation,
				writable: data.writable,
				enabled: data.enabled,
				controlScroll: data.controlScroll,
				motionPreference: data.motionPreference,
				thinkAutoExpand: data.thinkAutoExpand,
				canUpgrade: data.canUpgrade,
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
						thinkAutoExpand: settings.thinkAutoExpand,
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
		//#region \0dsh-css:/root/workspaces/DSH项目维护/dsh-smooth-stream-unified/src/client/DebugPanel.module.css.mjs
		const css = ".YuFy5q_trigger,.YuFy5q_iconButton{appearance:none;width:32px;height:32px;color:var(--dsw-alias-label-tertiary);cursor:pointer;background:0 0;border:1px solid #0000;border-radius:6px;justify-content:center;align-items:center;padding:0;display:inline-flex}.YuFy5q_trigger:hover,.YuFy5q_iconButton:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}.YuFy5q_iconButton:disabled{opacity:.45;cursor:not-allowed}.YuFy5q_triggerActive{border-color:var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-state-business-primary)}.YuFy5q_trigger:focus-visible,.YuFy5q_iconButton:focus-visible,.YuFy5q_secondaryButton:focus-visible,.YuFy5q_primaryButton:focus-visible,.YuFy5q_number:focus-visible,.YuFy5q_range:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}.YuFy5q_panel{z-index:30;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);width:min(328px,100vw - 32px);min-height:280px;box-shadow:0 12px 32px color-mix(in srgb, var(--dsw-alias-label-primary) 14%, transparent);color:var(--dsw-alias-label-primary);border-radius:8px;flex-direction:column;display:flex;position:fixed;top:88px;bottom:16px;right:16px;overflow:hidden}.YuFy5q_panelHeader{border-bottom:1px solid var(--dsw-alias-border-l2);flex:none;align-items:center;gap:8px;min-height:48px;padding:0 8px 0 14px;display:flex}.YuFy5q_statusDot{background:var(--dsw-alias-label-caption);border-radius:50%;flex:none;width:7px;height:7px}.YuFy5q_statusLive{background:var(--dsw-alias-state-success-primary);box-shadow:0 0 0 3px color-mix(in srgb, var(--dsw-alias-state-success-primary) 15%, transparent)}.YuFy5q_title{text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0;font-size:14px;font-weight:600;line-height:20px;overflow:hidden}.YuFy5q_state,.YuFy5q_unsaved{color:var(--dsw-alias-label-tertiary);white-space:nowrap;flex:none;font-size:10px;line-height:16px}.YuFy5q_unsaved{color:var(--dsw-alias-state-warn-primary)}.YuFy5q_scrollArea{overscroll-behavior:contain;min-height:0;overflow-y:auto}.YuFy5q_section{padding:14px}.YuFy5q_guide{border-bottom:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-tertiary);margin:0;padding:12px 14px;font-size:11px;line-height:1.55}.YuFy5q_section+.YuFy5q_section{border-top:1px solid var(--dsw-alias-border-l2)}.YuFy5q_section h2{color:var(--dsw-alias-label-secondary);margin:0 0 10px;font-size:12px;font-weight:600;line-height:18px}.YuFy5q_metrics{grid-template-columns:repeat(2,minmax(0,1fr));gap:0 16px;margin:0;display:grid}.YuFy5q_metric{border-bottom:1px solid color-mix(in srgb, var(--dsw-alias-border-l2) 65%, transparent);justify-content:space-between;align-items:baseline;gap:8px;min-width:0;padding:5px 0;display:flex}.YuFy5q_metric dt{min-width:0;color:var(--dsw-alias-label-tertiary);text-overflow:ellipsis;white-space:nowrap;font-size:11px;line-height:16px;overflow:hidden}.YuFy5q_metric dd{min-width:0;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums;text-overflow:ellipsis;white-space:nowrap;margin:0;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;line-height:16px;overflow:hidden}.YuFy5q_metric dd[data-tone=good]{color:var(--dsw-alias-state-success-primary)}.YuFy5q_metric dd[data-tone=warn]{color:var(--dsw-alias-state-warn-primary)}.YuFy5q_control{flex-direction:column;gap:5px;padding:6px 0;display:flex}.YuFy5q_controlHead{color:var(--dsw-alias-label-secondary);justify-content:space-between;align-items:center;gap:10px;font-size:11px;line-height:18px;display:flex}.YuFy5q_controlLabel{align-items:center;gap:4px;min-width:0;display:inline-flex}.YuFy5q_infoButton{appearance:none;width:20px;height:20px;color:var(--dsw-alias-label-tertiary);cursor:help;background:0 0;border:0;border-radius:50%;justify-content:center;align-items:center;padding:0;display:inline-flex}.YuFy5q_infoButton:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}.YuFy5q_infoButton:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}.YuFy5q_numberWrap{flex:none;align-items:center;gap:4px;display:inline-flex}.YuFy5q_number{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);width:68px;height:26px;color:var(--dsw-alias-label-primary);font:inherit;font-variant-numeric:tabular-nums;text-align:right;border-radius:5px;padding:2px 6px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}.YuFy5q_unit{width:30px;color:var(--dsw-alias-label-tertiary);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:10px}.YuFy5q_range{width:100%;height:18px;accent-color:var(--dsw-alias-state-business-primary);cursor:pointer;margin:0}.YuFy5q_range:disabled,.YuFy5q_number:disabled{opacity:.5;cursor:default}.YuFy5q_footer{border-top:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);flex:none;align-items:center;gap:6px;min-height:50px;padding:8px 10px;display:flex}.YuFy5q_footerSpacer{flex:1}.YuFy5q_secondaryButton,.YuFy5q_primaryButton{appearance:none;border:1px solid var(--dsw-alias-border-l2);min-height:30px;color:var(--dsw-alias-label-secondary);font:inherit;cursor:pointer;background:0 0;border-radius:6px;justify-content:center;align-items:center;gap:5px;padding:4px 9px;font-size:11px;line-height:18px;display:inline-flex}.YuFy5q_primaryButton{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3);border-color:#0000}.YuFy5q_secondaryButton:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed)}.YuFy5q_secondaryButton:disabled,.YuFy5q_primaryButton:disabled{opacity:.4;cursor:default}.YuFy5q_visuallyHidden{clip:rect(0 0 0 0);clip-path:inset(50%);white-space:nowrap;border:0;width:1px;height:1px;margin:-1px;padding:0;position:absolute;overflow:hidden}@media (width<=900px){.YuFy5q_trigger,.YuFy5q_iconButton{width:44px;height:44px}.YuFy5q_panel{top:auto;right:12px;bottom:max(12px, env(safe-area-inset-bottom));width:auto;max-height:min(70dvh,640px);left:12px}.YuFy5q_secondaryButton,.YuFy5q_primaryButton{min-height:44px}}@media (prefers-reduced-motion:reduce){.YuFy5q_statusLive{box-shadow:none}}";
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
			"visuallyHidden": "YuFy5q_visuallyHidden",
			"infoButton": "YuFy5q_infoButton",
			"controlHead": "YuFy5q_controlHead",
			"number": "YuFy5q_number",
			"iconButton": "YuFy5q_iconButton",
			"triggerActive": "YuFy5q_triggerActive",
			"statusDot": "YuFy5q_statusDot",
			"unsaved": "YuFy5q_unsaved",
			"title": "YuFy5q_title",
			"state": "YuFy5q_state",
			"section": "YuFy5q_section",
			"metric": "YuFy5q_metric",
			"controlLabel": "YuFy5q_controlLabel",
			"numberWrap": "YuFy5q_numberWrap",
			"secondaryButton": "YuFy5q_secondaryButton",
			"primaryButton": "YuFy5q_primaryButton",
			"panel": "YuFy5q_panel",
			"panelHeader": "YuFy5q_panelHeader",
			"scrollArea": "YuFy5q_scrollArea",
			"control": "YuFy5q_control",
			"footerSpacer": "YuFy5q_footerSpacer",
			"range": "YuFy5q_range",
			"statusLive": "YuFy5q_statusLive",
			"guide": "YuFy5q_guide",
			"metrics": "YuFy5q_metrics",
			"footer": "YuFy5q_footer",
			"trigger": "YuFy5q_trigger",
			"unit": "YuFy5q_unit"
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
		const SKIP_WRAP = /* @__PURE__ */ new Set([
			"user",
			"steering",
			"command-input",
			"turn-process",
			"turn-tail"
		]);
		const MANAGED_NODE_KINDS = /* @__PURE__ */ new Set([
			"assistant-step",
			"tool-call",
			"context",
			"command",
			"system-prompt"
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
					if (saved) {
						const cached = JSON.parse(saved);
						if (cached !== null && typeof cached === "object" && typeof cached.enabled === "boolean" && typeof cached.controlScroll === "boolean" && [
							"auto",
							"force-reduced",
							"force-smooth"
						].includes(cached.motionPreference)) Object.assign(val, Object.fromEntries(Object.entries(cached).filter(([key]) => key in DEFAULT_STREAM_SETTINGS)));
					}
				} catch {}
				return val;
			})();
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
				if (next.enabled === this.value.enabled && next.controlScroll === this.value.controlScroll && next.motionPreference === this.value.motionPreference && next.thinkAutoExpand === this.value.thinkAutoExpand && next.fastFold === this.value.fastFold && next.fastPipeline === this.value.fastPipeline && next.keepStreamOnToolCall === this.value.keepStreamOnToolCall && next.debugEnabled === this.value.debugEnabled && next.debugTuningEnabled === this.value.debugTuningEnabled && next.debugTuning === this.value.debugTuning) return;
				this.value = next;
				for (const listener of this.listeners) listener();
			}
			/** Retain the last known preference while the optional settings RPC loads. */
			takeoverEnabled() {
				return this.value.enabled;
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
			syncStyles();
			const offStyles = settings.subscribe(syncStyles);
			ctx.effect(() => () => {
				offStyles();
				document.documentElement.removeAttribute("data-smooth-stream-fast-fold");
				document.getElementById(FAST_FOLD_STYLE_ID)?.remove();
			});
			healDshConversationPipeline(ctx, settings);
			ctx.inject(["sessions"], (scopedCtx) => installEntryBaselineSource(scopedCtx.sessions));
			ctx.inject(["uiConversation"], (scopedCtx) => scopedCtx.uiConversation.events.register(streamOrderDefinition()));
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
				const t = settingsCtx.locale.bind(NS);
				const SmoothStreamSectionView = (props) => {
					const translate = typeof props.t === "function" ? props.t : t;
					return (0, react.createElement)("div", { style: {
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
					} }, translate("title")), (0, react.createElement)("p", { style: {
						color: "var(--dsw-alias-label-tertiary)",
						margin: 0,
						fontSize: "13px"
					} }, translate("description")), (0, react.createElement)("ul", { style: {
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
				};
				settingsCtx.slots.inject("settings.section", () => settingsCtx.slots.register({
					name: "settings.section",
					id: "smooth-stream",
					order: 25,
					label: () => t("title"),
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
			ctx.slots.inject("conversation.chat.flow", () => installFlowPresentationAdapter(ctx, settings, (key, component) => MANAGED_NODE_KINDS.has(key) && !SKIP_WRAP.has(key) && isWrappableComponent(component), config.preset));
			ctx.slots.inject("conversation.chat.node", () => installRendererAdapter(ctx, (key, original) => {
				if (!MANAGED_NODE_KINDS.has(key) || SKIP_WRAP.has(key) || !isWrappableComponent(original)) return original;
				const Inner = original;
				return function SmoothStreamRendererAdapter(props) {
					const preferences = (0, react.useSyncExternalStore)(settings.subscribe, settings.getSnapshot, settings.getSnapshot);
					const ready = (0, react.useSyncExternalStore)(settings.subscribe, () => settings.takeoverEnabled(), () => settings.takeoverEnabled());
					const playback = useSessionPlayback();
					if (!ready || !preferences.enabled || playback === null) return (0, react.createElement)(Inner, props);
					return (0, react.createElement)(SessionPlaybackNode, {
						Inner,
						owner: props
					});
				};
			}));
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map