/** Scheduling regressions against the real client factory, never a copied hook.
 * Run: node --test scripts/copilot-background-selftest.mjs
 * Optional: CLIENT_SOURCE_PATH=/path/to/installed/client.js node --test ...
 *
 * React's hook lifecycle, document visibility and time are deterministic fakes.
 * Deferred API replies deliberately ignore AbortSignal: an aborted transport may
 * still resolve/reject, and the client must reject stale work itself. No network,
 * DOM layout, CSS/performance, native session or model integration is exercised.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(process.env.CLIENT_SOURCE_PATH || new URL('../client.js', import.meta.url), 'utf8');
const STATE_MS = 1500;
const EVENTS_MS = 2000;
const RUNS_MS = 2000;
const HIDDEN_MS = 15000;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function sameDeps(left, right) {
  return Array.isArray(left) && Array.isArray(right) && left.length === right.length &&
    left.every((value, index) => Object.is(value, right[index]));
}

/** One mounted root; nested real hooks share stable slots in invocation order. */
function hookRuntime() {
  const slots = [];
  let cursor = 0;
  let hookCount = null;
  let root;
  let output;
  let mounted = false;
  let dirty = false;
  let writes = 0;
  let effects = [];
  const slot = (kind, create) => {
    const index = cursor++;
    if (!slots[index]) slots[index] = { kind, ...create(index) };
    assert.equal(slots[index].kind, kind, `hook order changed at slot ${index}`);
    return slots[index];
  };
  const useMemo = (create, deps) => {
    const entry = slot('memo', () => ({ initialized: false }));
    if (!entry.initialized || !sameDeps(entry.deps, deps)) {
      entry.value = create();
      entry.deps = deps;
      entry.initialized = true;
    }
    return entry.value;
  };
  const useEffect = (create, deps) => {
    const entry = slot('effect', () => ({ initialized: false, cleanup: undefined }));
    if (!entry.initialized || !sameDeps(entry.deps, deps)) effects.push({ entry, create, deps });
  };
  const react = {
    Component: class {},
    Fragment: Symbol('Fragment'),
    memo: (component) => component,
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState(initial) {
      const entry = slot('state', () => ({ value: typeof initial === 'function' ? initial() : initial }));
      if (!entry.set) entry.set = (next) => {
        writes += 1; // Count attempted writes after cleanup, even though React ignores them.
        if (!mounted) return;
        const value = typeof next === 'function' ? next(entry.value) : next;
        if (!Object.is(value, entry.value)) { entry.value = value; dirty = true; }
      };
      return [entry.value, entry.set];
    },
    useRef: (current) => slot('ref', () => ({ value: { current } })).value,
    useMemo,
    useCallback: (callback, deps) => useMemo(() => callback, deps),
    useEffect,
    useLayoutEffect: useEffect,
  };
  const render = () => {
    assert.ok(mounted, 'cannot render an unmounted hook root');
    let renders = 0;
    do {
      assert.ok(++renders < 100, 'hook root did not settle');
      dirty = false;
      cursor = 0;
      effects = [];
      output = root();
      if (hookCount !== null) assert.equal(cursor, hookCount, 'hook count changed across renders');
      hookCount = cursor;
      // React cleans changed effects before setting up their replacements.
      for (const { entry } of effects) if (typeof entry.cleanup === 'function') entry.cleanup();
      for (const { entry, create, deps } of effects) {
        entry.deps = deps;
        entry.initialized = true;
        entry.cleanup = create();
      }
    } while (dirty);
    return output;
  };
  return {
    react,
    mount(callback) { root = callback; mounted = true; return render(); },
    render,
    flush() { if (mounted && dirty) render(); },
    unmount() {
      if (!mounted) return;
      mounted = false;
      for (const entry of slots) if (entry.kind === 'effect' && typeof entry.cleanup === 'function') entry.cleanup();
    },
    get output() { return output; },
    get writes() { return writes; },
  };
}

function fakeClock() {
  let now = 1700000000000;
  let sequence = 0;
  const timers = new Map();
  const setTimeout = (callback, delay = 0, ...args) => {
    const id = ++sequence;
    timers.set(id, { id, at: now + Math.max(0, Number(delay) || 0), callback, args });
    return id;
  };
  return {
    Date: class extends Date {
      constructor(...args) { super(...(args.length ? args : [now])); }
      static now() { return now; }
    },
    setTimeout,
    clearTimeout: (id) => timers.delete(id),
    get now() { return now; },
    get size() { return timers.size; },
    get created() { return sequence; },
    delays: () => Array.from(timers.values(), (entry) => entry.at - now).sort((a, b) => a - b),
    async advance(milliseconds, settle) {
      const until = now + milliseconds;
      let ticks = 0;
      for (;;) {
        const next = Array.from(timers.values()).filter((entry) => entry.at <= until)
          .sort((left, right) => left.at - right.at || left.id - right.id)[0];
        if (!next) break;
        assert.ok(++ticks < 10000, 'fake clock timer loop');
        now = next.at;
        timers.delete(next.id);
        next.callback(...next.args);
        await settle();
      }
      now = until;
      await settle();
    },
  };
}

class FakeDocument extends EventTarget {
  visibilityState = 'visible';
  title = 'Fixture';
  registrations = [];
  listeners = new Map();
  addEventListener(type, listener, options) {
    this.registrations.push(['add', type, listener]);
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
    super.addEventListener(type, listener, options);
  }
  removeEventListener(type, listener, options) {
    this.registrations.push(['remove', type, listener]);
    this.listeners.get(type)?.delete(listener);
    super.removeEventListener(type, listener, options);
  }
  get hidden() { return this.visibilityState !== 'visible'; }
  visibility(value) { this.visibilityState = value; this.dispatchEvent(new Event('visibilitychange')); }
}

function stateData(projectId, revision = 7, nodes = []) {
  return { project: { id: projectId, name: 'Fixture' }, revision, nodes, edges: [], auto: { status: 'stopped' } };
}

function apiMock(api, clock, options) {
  const calls = [];
  const queues = new Map();
  const defaults = {
    fetchState: (call) => typeof call.revision === 'number'
      ? { unchanged: true, revision: call.revision }
      : stateData(call.projectId, 7, options.running ? [{ id: 'node-fixture', status: 'running' }] : []),
    fetchEvents: (call) => ({ events: [], next: call.after }),
    fetchRuns: () => ({ runs: [{ id: 'run-fixture', role: 'advisor', status: 'running' }], cycles: [{ id: 'cycle-fixture' }] }),
    fetchModels: () => ({ options: [], providers: [] }),
  };
  for (const method of Object.keys(api)) {
    api[method] = (...args) => {
      assert.ok(method in defaults, `unexpected API method ${method}; real HTTP is forbidden`);
      const hasCursor = method === 'fetchState' || method === 'fetchEvents';
      const call = { method, projectId: args[0], signal: args[hasCursor ? 2 : 1], at: clock.now };
      if (method === 'fetchState') call.revision = args[1];
      if (method === 'fetchEvents') call.after = args[1];
      assert.ok(call.signal instanceof AbortSignal, `${method} must receive an AbortSignal`);
      calls.push(call);
      const response = queues.get(method)?.shift();
      return Promise.resolve(response ? response(call) : defaults[method](call));
    };
  }
  const enqueue = (method, response) => {
    if (!queues.has(method)) queues.set(method, []);
    queues.get(method).push(response);
  };
  return {
    calls,
    list: (method) => calls.filter((call) => call.method === method),
    count: (method) => calls.filter((call) => call.method === method).length,
    last: (method) => calls.filter((call) => call.method === method).at(-1),
    respond: (method, value) => enqueue(method, () => value),
    defer(method) { const value = deferred(); enqueue(method, () => value.promise); return value; },
  };
}

async function fixture(t, kind = 'workspace', options = {}) {
  const runtime = hookRuntime();
  const clock = fakeClock();
  const document = new FakeDocument();
  document.visibilityState = options.visibility ?? 'visible';
  const storage = new Map(Object.entries(options.storage ?? {}));
  const localStorage = {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
  };
  let definition;
  const context = {
    window: { __ModuleLoader__: { load(value) { definition = value; } } },
    __test: {}, console, Error, AbortController, AbortSignal, Event, EventTarget,
    document, localStorage, navigator: {}, Date: clock.Date,
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    fetch() { assert.fail('network is forbidden in the background selftest'); },
  };
  // Expose closures only in this VM copy; production code has no debug exports.
  const anchor = 'function useProjectWorkspace(';
  assert.equal(source.split(anchor).length, 2, 'test instrumentation needs one real workspace hook');
  const instrumented = source.replace(anchor,
    '__test.api = api; __test.workspace = useProjectWorkspace; __test.runs = useRuns; ' +
    '__test.now = useNow; __test.screen = WorkspaceScreen; ' + anchor);
  vm.runInNewContext(instrumented, context, { filename: 'client.js' });
  assert.ok(definition && typeof definition.factory === 'function', 'client factory was not loaded');
  definition.factory((name) => { assert.equal(name, 'react'); return runtime.react; });
  for (const name of ['workspace', 'runs', 'now', 'screen']) assert.equal(typeof context.__test[name], 'function');
  // The real factory also owns an attention visibility listener independently
  // of mounted hooks. Only hook-owned additions must disappear on unmount.
  const factoryVisibilityListeners = Array.from(document.listeners.get('visibilitychange') ?? []);
  const mock = apiMock(context.__test.api, clock, options);
  options.setup?.(mock);
  const props = {
    projectId: 'project-fixture', t: (key) => key,
    attentionPrefsRef: { current: { enabled: options.attention === true, sound: false } },
    covered: options.covered ?? false, active: options.active ?? true,
    onBack() {}, openNativeSession() {}, retainCopilotSession() {}, SessionProvider() {}, renderFactorySlot() {},
  };
  const settle = async () => {
    // All mocked I/O is immediate or explicitly deferred. Drain promise jobs and
    // the resulting batched renders, without advancing a single timer.
    for (let turn = 0; turn < 20; turn += 1) { await Promise.resolve(); runtime.flush(); }
  };
  const f = {
    runtime, clock, document, mock, props, settle,
    get result() { return runtime.output; },
    async render(patch = {}) { Object.assign(props, patch); runtime.render(); await settle(); },
    async attention(enabled) { props.attentionPrefsRef.current = { enabled, sound: false }; await f.render(); },
    async visibility(value) { document.visibility(value); await settle(); },
    advance: (milliseconds) => clock.advance(milliseconds, settle),
  };
  t.after(() => {
    runtime.unmount();
    assert.equal(clock.size, 0, 'unmount must leave no scheduled timers');
    assert.deepEqual(Array.from(document.listeners.get('visibilitychange') ?? []), factoryVisibilityListeners,
      'unmount must remove hook-owned visibility listeners');
  });
  runtime.mount(() => {
    if (kind === 'workspace') return context.__test.workspace(props.projectId, props.t, props.attentionPrefsRef, props.covered);
    if (kind === 'runs') return context.__test.runs(props.projectId, props.t, props.active);
    if (kind === 'now') return context.__test.now(props.active);
    assert.equal(kind, 'screen');
    return context.__test.screen(props);
  });
  await settle();
  return f;
}

function nodes(value) {
  if (value === null || typeof value !== 'object') return [];
  if (Array.isArray(value)) return value.flatMap(nodes);
  return [value, ...nodes(value.children)];
}
function component(f, name) {
  const entry = nodes(f.result).find((node) => typeof node.type === 'function' && node.type.name === name);
  assert.ok(entry, `missing real ${name} element`);
  return entry;
}
function seqs(events) { return Array.from(events, (event) => event.seq); }
function ids(rows) { return Array.from(rows, (row) => row.id); }
function pollCounts(f) { return ['fetchState', 'fetchEvents', 'fetchRuns'].map((method) => f.mock.count(method)); }

// Green controls: failures below must be behavior regressions, not broken fakes.
test('hook harness preserves state/ref/callback slots and dependency cleanup', () => {
  const runtime = hookRuntime();
  let initializations = 0;
  let dependency = 1;
  const lifecycle = [];
  const render = () => {
    const [value, set] = runtime.react.useState(() => { initializations += 1; return 0; });
    const ref = runtime.react.useRef({});
    const callback = runtime.react.useCallback(() => ref.current, []);
    runtime.react.useEffect(() => { const key = dependency; lifecycle.push(`start:${key}`); return () => lifecycle.push(`stop:${key}`); }, [dependency]);
    return { value, set, ref, callback };
  };
  const first = runtime.mount(render);
  first.set((value) => value + 1);
  runtime.flush();
  assert.equal(runtime.output.value, 1);
  assert.equal(runtime.output.ref, first.ref);
  assert.equal(runtime.output.callback, first.callback);
  assert.equal(initializations, 1);
  assert.deepEqual(lifecycle, ['start:1']);
  dependency = 2;
  runtime.render();
  runtime.unmount();
  assert.deepEqual(lifecycle, ['start:1', 'stop:1', 'start:2', 'stop:2']);
});

test('uncovered workspace polls actual state/events at their normal cadences', async (t) => {
  const f = await fixture(t);
  assert.equal(f.result.snapshot.phase, 'ready');
  assert.deepEqual(pollCounts(f), [1, 1, 0]);
  assert.deepEqual(f.clock.delays(), [STATE_MS, EVENTS_MS]);
  await f.advance(STATE_MS);
  assert.deepEqual(pollCounts(f), [2, 1, 0]);
  assert.equal(f.mock.last('fetchState').revision, 7);
  await f.advance(EVENTS_MS - STATE_MS);
  assert.deepEqual(pollCounts(f), [2, 2, 0]);
});

test('existing document-hidden attention policy is state-only at 15 seconds', async (t) => {
  const f = await fixture(t, 'workspace', { visibility: 'hidden', attention: true });
  assert.deepEqual(pollCounts(f), [1, 0, 0]);
  assert.deepEqual(f.clock.delays(), [HIDDEN_MS]);
  await f.advance(HIDDEN_MS - 1);
  assert.equal(f.mock.count('fetchState'), 1);
  await f.advance(1);
  assert.deepEqual(pollCounts(f), [2, 0, 0]);
});

test('covered mount allows one state bootstrap, but never starts events or recurring polling', async (t) => {
  const f = await fixture(t, 'workspace', { covered: true });
  assert.equal(f.result.snapshot.phase, 'ready', 'covered mount still needs initialized project data');
  assert.equal(f.result.snapshot.project.id, 'project-fixture');
  assert.equal(f.mock.count('fetchState'), 1);
  assert.equal(f.mock.count('fetchEvents'), 0, 'Copilot-covered bootstrap must not fetch events');
  assert.equal(f.clock.size, 0, 'alerts-off covered bootstrap must not schedule polling');
  await f.advance(HIDDEN_MS * 4);
  assert.deepEqual(pollCounts(f), [1, 0, 0]);
});

test('covering an initialized workspace stops both polling channels without clearing data', async (t) => {
  const f = await fixture(t);
  const snapshot = f.result.snapshot;
  const events = f.result.events;
  await f.render({ covered: true });
  assert.equal(f.result.snapshot, snapshot);
  assert.equal(f.result.events, events);
  const before = pollCounts(f);
  await f.advance(HIDDEN_MS * 2);
  assert.deepEqual(pollCounts(f), before, 'covered workspace with alerts off must issue no recurring requests');
  assert.equal(f.clock.size, 0);
});

for (const action of ['refresh', 'retry', 'reload']) {
  test(`covered ${action} cannot bypass the alerts-off pause`, async (t) => {
    const f = await fixture(t);
    await f.render({ covered: true });
    const before = pollCounts(f);
    f.result[action]();
    await f.settle();
    assert.deepEqual(pollCounts(f), before, `${action} must not start state/events while Copilot covers the workspace`);
    await f.advance(HIDDEN_MS * 2);
    assert.deepEqual(pollCounts(f), before);
  });
}

test('document visibility changes cannot restart an alerts-off covered workspace', async (t) => {
  const f = await fixture(t);
  await f.render({ covered: true });
  const before = pollCounts(f);
  await f.visibility('hidden');
  await f.visibility('visible');
  assert.deepEqual(pollCounts(f), before, 'document-visible is not workspace-visible while Copilot covers it');
  assert.equal(f.clock.size, 0);
});

test('uncover resumes immediately with revision, cursor, deduplication and effect lifetime intact', async (t) => {
  const f = await fixture(t, 'workspace', { setup(mock) {
    mock.respond('fetchState', stateData('project-fixture', 41));
    mock.respond('fetchEvents', { events: [{ seq: 6 }, { seq: 7 }], next: 8 });
  } });
  const snapshot = f.result.snapshot;
  const events = f.result.events;
  const registrations = f.document.registrations.length;
  await f.render({ covered: true });
  assert.equal(f.result.snapshot, snapshot, 'covered changes must not reset the state snapshot');
  assert.equal(f.result.events, events, 'covered changes must not reset accumulated events');
  assert.equal(f.document.registrations.length, registrations, 'covered must not restart the main [projectId,t] effect');
  const before = pollCounts(f);
  f.mock.respond('fetchEvents', { events: [{ seq: 7 }, { seq: 8 }], next: 9 });
  await f.render({ covered: false });
  assert.deepEqual(pollCounts(f), [before[0] + 1, before[1] + 1, 0], 'closing Copilot must refetch immediately');
  assert.equal(f.mock.last('fetchState').revision, 41, 'resume must keep revision short-circuit');
  assert.equal(f.mock.last('fetchEvents').after, 8, 'resume must keep the first-unseen events cursor');
  assert.deepEqual(seqs(f.result.events), [6, 7, 8], 'overlapping Host events must not duplicate after resume');
  assert.equal(f.document.registrations.length, registrations);
});

test('covered alerts retain only the existing slow attention state channel', async (t) => {
  const f = await fixture(t, 'workspace', { covered: true, attention: true });
  assert.equal(f.mock.count('fetchEvents'), 0, 'attention never permits covered events polling');
  assert.deepEqual(f.clock.delays(), [HIDDEN_MS]);
  const count = f.mock.count('fetchState');
  await f.advance(HIDDEN_MS - 1);
  assert.equal(f.mock.count('fetchState'), count);
  await f.advance(1);
  assert.equal(f.mock.count('fetchState'), count + 1);
  assert.equal(f.mock.count('fetchEvents'), 0);
});

test('covering with alerts reconciles an already scheduled visible-state timer to 15 seconds', async (t) => {
  const f = await fixture(t, 'workspace', { attention: true });
  const eventCount = f.mock.count('fetchEvents');
  await f.render({ covered: true });
  assert.deepEqual(f.clock.delays(), [HIDDEN_MS], 'a pre-cover 1.5s timer must not survive in attention mode');
  const stateCount = f.mock.count('fetchState');
  await f.advance(HIDDEN_MS - 1);
  assert.equal(f.mock.count('fetchState'), stateCount);
  assert.equal(f.mock.count('fetchEvents'), eventCount);
  await f.advance(1);
  assert.equal(f.mock.count('fetchState'), stateCount + 1);
});

test('attention preference toggles while covered start/stop slow state polling without a visibility event', async (t) => {
  const f = await fixture(t, 'workspace', { covered: true });
  const eventsBefore = f.mock.count('fetchEvents');
  await f.attention(true);
  assert.deepEqual(f.clock.delays(), [HIDDEN_MS], 'enabling attention must reconcile the covered timer');
  const enabledCount = f.mock.count('fetchState');
  await f.advance(HIDDEN_MS - 1);
  assert.equal(f.mock.count('fetchState'), enabledCount);
  await f.advance(1);
  assert.equal(f.mock.count('fetchState'), enabledCount + 1);
  assert.equal(f.mock.count('fetchEvents'), eventsBefore);
  await f.attention(false);
  assert.equal(f.clock.size, 0, 'disabling attention must clear the covered state timer immediately');
  const disabledCount = f.mock.count('fetchState');
  await f.advance(HIDDEN_MS * 2);
  assert.equal(f.mock.count('fetchState'), disabledCount);
});

test('disabling covered attention aborts an outstanding slow state request', async (t) => {
  const f = await fixture(t, 'workspace', { covered: true, attention: true });
  const late = f.mock.defer('fetchState');
  await f.advance(HIDDEN_MS);
  const flight = f.mock.last('fetchState');
  await f.attention(false);
  assert.equal(flight.signal.aborted, true, 'turning covered alerts off must abort a slow state flight');
  const writes = f.runtime.writes;
  late.reject(new Error('late attention failure'));
  await f.settle();
  assert.equal(f.runtime.writes, writes);
  assert.equal(f.result.offline, null);
  assert.equal(f.clock.size, 0);
});

// Superseded requests intentionally settle AFTER their successful replacements.
for (const method of ['fetchState', 'fetchEvents']) {
  for (const outcome of ['resolve', 'reject']) {
    test(`workspace ${method} ignores a superseded late ${outcome}`, async (t) => {
      let late;
      const f = await fixture(t, 'workspace', { setup(mock) { late = mock.defer(method); } });
      const old = f.mock.last(method);
      f.result.refresh();
      await f.settle();
      assert.equal(old.signal.aborted, true, 'refresh must cancel the preceding request');
      const snapshot = f.result.snapshot;
      const events = f.result.events;
      const writes = f.runtime.writes;
      const timersCreated = f.clock.created;
      if (outcome === 'resolve') late.resolve(method === 'fetchState'
        ? stateData('project-fixture', 999) : { events: [{ seq: 999 }], next: 1000 });
      else late.reject(new Error('superseded request failed late'));
      await f.settle();
      assert.equal(f.runtime.writes, writes, 'superseded work must not call state setters');
      assert.equal(f.result.snapshot, snapshot);
      assert.equal(f.result.events, events);
      assert.equal(f.result.offline, null);
      assert.equal(f.clock.created, timersCreated, 'superseded work must not replace current timers');
      f.result.refresh();
      await f.settle();
      assert.equal(f.mock.last('fetchState').revision, 7, 'stale state must not overwrite revisionRef');
      assert.equal(f.mock.last('fetchEvents').after, 0, 'stale events must not overwrite the cursor');
    });
  }

  test(`workspace stale ${method} completion cannot detach a still-pending replacement controller`, async (t) => {
    let old;
    const f = await fixture(t, 'workspace', { setup(mock) { old = mock.defer(method); } });
    const replacement = f.mock.defer(method);
    f.result.refresh();
    await f.settle();
    const flight = f.mock.last(method);
    old.resolve(method === 'fetchState' ? stateData('project-fixture', 999) : { events: [], next: 999 });
    await f.settle();
    f.result.refresh();
    await f.settle();
    assert.equal(flight.signal.aborted, true, 'stale completion must not clear the newer channel controller');
    replacement.resolve(method === 'fetchState' ? stateData('project-fixture', 888) : { events: [], next: 888 });
    await f.settle();
  });

  for (const pause of ['covered', 'hidden']) {
    for (const outcome of ['resolve', 'reject']) {
      test(`workspace ${method} ignores ${pause}-aborted late ${outcome}`, async (t) => {
        let late;
        const f = await fixture(t, 'workspace', { setup(mock) { late = mock.defer(method); } });
        const old = f.mock.last(method);
        if (pause === 'covered') await f.render({ covered: true });
        else await f.visibility('hidden');
        assert.equal(old.signal.aborted, true, `${pause} with alerts off must abort ${method}`);
        const snapshot = f.result.snapshot;
        const events = f.result.events;
        const writes = f.runtime.writes;
        const timersCreated = f.clock.created;
        if (outcome === 'resolve') late.resolve(method === 'fetchState'
          ? stateData('project-fixture', 999) : { events: [{ seq: 999 }], next: 1000 });
        else late.reject(new Error('aborted request failed late'));
        await f.settle();
        assert.equal(f.runtime.writes, writes, 'paused-aborted work must not call state setters');
        assert.equal(f.result.snapshot, snapshot);
        assert.equal(f.result.events, events);
        assert.equal(f.result.offline, null);
        assert.equal(f.clock.created, timersCreated);
        assert.equal(f.clock.size, 0);
        if (pause === 'covered') await f.render({ covered: false });
        else await f.visibility('visible');
        assert.equal(f.mock.last('fetchState').revision, method === 'fetchState' ? null : 7);
        assert.equal(f.mock.last('fetchEvents').after, 0);
      });
    }
  }
}

test('workspace project replacement rejects late old-project success/errors and resets its own cursor', async (t) => {
  let oldState;
  let oldEvents;
  const f = await fixture(t, 'workspace', { setup(mock) {
    oldState = mock.defer('fetchState'); oldEvents = mock.defer('fetchEvents');
  } });
  const flights = f.mock.calls.slice();
  await f.render({ projectId: 'project-next' });
  assert.ok(flights.every((call) => call.signal.aborted));
  assert.equal(f.result.snapshot.project.id, 'project-next');
  assert.equal(f.mock.last('fetchEvents').after, 0);
  const writes = f.runtime.writes;
  const created = f.clock.created;
  oldState.resolve(stateData('project-fixture', 999));
  oldEvents.reject(new Error('old project failed late'));
  await f.settle();
  assert.equal(f.runtime.writes, writes);
  assert.equal(f.clock.created, created);
  assert.equal(f.result.snapshot.project.id, 'project-next');
});

test('active runs poll at two seconds by default', async (t) => {
  const f = await fixture(t, 'runs');
  assert.equal(f.result.state.phase, 'ready');
  assert.deepEqual(ids(f.result.state.runs), ['run-fixture']);
  assert.deepEqual(f.clock.delays(), [RUNS_MS]);
  await f.advance(RUNS_MS);
  assert.equal(f.mock.count('fetchRuns'), 2);
});

test('runs mounted inactive never fetch or schedule; inactive project change only resets cache', async (t) => {
  const f = await fixture(t, 'runs', { active: false });
  assert.equal(f.mock.count('fetchRuns'), 0, 'inactive runs must not bootstrap an HTTP request');
  assert.equal(f.clock.size, 0);
  await f.render({ projectId: 'project-next' });
  assert.equal(f.mock.count('fetchRuns'), 0);
  assert.deepEqual(ids(f.result.state.runs), []);
  assert.deepEqual(ids(f.result.state.cycles), []);
});

test('runs keep cached data while inactive and resume immediately without an empty loading frame', async (t) => {
  const f = await fixture(t, 'runs');
  const runs = f.result.state.runs;
  const cycles = f.result.state.cycles;
  await f.render({ active: false });
  assert.equal(f.result.state.runs, runs);
  assert.equal(f.result.state.cycles, cycles);
  const before = f.mock.count('fetchRuns');
  const resumed = f.mock.defer('fetchRuns');
  await f.render({ active: true });
  assert.equal(f.mock.count('fetchRuns'), before + 1, 'activation must fetch immediately, not await the old cadence');
  assert.equal(f.result.state.runs, runs, 'resume must keep cached runs while the refetch is pending');
  assert.equal(f.result.state.cycles, cycles);
  resumed.resolve({ runs: [{ id: 'run-new' }], cycles: [] });
  await f.settle();
  assert.deepEqual(ids(f.result.state.runs), ['run-new']);
});

test('inactive runs reject refresh/retry and document visibility escape hatches', async (t) => {
  const f = await fixture(t, 'runs');
  await f.render({ active: false });
  const before = f.mock.count('fetchRuns');
  f.result.refresh();
  f.result.retry();
  await f.settle();
  await f.visibility('hidden');
  await f.visibility('visible');
  assert.equal(f.mock.count('fetchRuns'), before, 'inactive runs controls and visibility must stay paused');
  await f.advance(HIDDEN_MS * 2);
  assert.equal(f.mock.count('fetchRuns'), before);
  assert.equal(f.clock.size, 0);
});

test('project change while runs are inactive clears old cached rows without fetching', async (t) => {
  const f = await fixture(t, 'runs');
  await f.render({ active: false });
  const before = f.mock.count('fetchRuns');
  f.mock.defer('fetchRuns'); // If a broken implementation fetches, keep its reset observable.
  await f.render({ projectId: 'project-next' });
  assert.deepEqual(ids(f.result.state.runs), []);
  assert.deepEqual(ids(f.result.state.cycles), []);
  assert.equal(f.mock.count('fetchRuns'), before, 'inactive project changes must reset only, without a fetch');
  assert.equal(f.clock.size, 0);
});

for (const outcome of ['resolve', 'reject']) {
  test(`deactivating runs aborts its flight and ignores a late ${outcome}`, async (t) => {
    const f = await fixture(t, 'runs');
    const late = f.mock.defer('fetchRuns');
    await f.advance(RUNS_MS);
    const old = f.mock.last('fetchRuns');
    await f.render({ active: false });
    assert.equal(old.signal.aborted, true, 'deactivating runs must abort an in-flight request');
    const cached = f.result.state;
    const writes = f.runtime.writes;
    const created = f.clock.created;
    if (outcome === 'resolve') late.resolve({ runs: [{ id: 'run-stale' }], cycles: [] });
    else late.reject(new Error('inactive runs failed late'));
    await f.settle();
    assert.equal(f.runtime.writes, writes);
    assert.equal(f.result.state, cached);
    assert.equal(f.clock.created, created);
    assert.equal(f.clock.size, 0);
  });

  test(`runs ignore a superseded late ${outcome}`, async (t) => {
    let late;
    const f = await fixture(t, 'runs', { setup(mock) { late = mock.defer('fetchRuns'); } });
    const old = f.mock.last('fetchRuns');
    f.result.refresh();
    await f.settle();
    assert.equal(old.signal.aborted, true);
    const state = f.result.state;
    const writes = f.runtime.writes;
    const created = f.clock.created;
    if (outcome === 'resolve') late.resolve({ runs: [{ id: 'run-stale' }], cycles: [] });
    else late.reject(new Error('superseded runs failed late'));
    await f.settle();
    assert.equal(f.runtime.writes, writes);
    assert.equal(f.result.state, state);
    assert.equal(f.clock.created, created, 'stale runs must not replace a valid poll/backoff timer');
  });
}

test('runs project replacement and unmount cancel flights and reject their late work', async (t) => {
  let late;
  const f = await fixture(t, 'runs', { setup(mock) { late = mock.defer('fetchRuns'); } });
  const old = f.mock.last('fetchRuns');
  await f.render({ projectId: 'project-next' });
  assert.equal(old.signal.aborted, true);
  const state = f.result.state;
  const writes = f.runtime.writes;
  late.resolve({ runs: [{ id: 'run-stale' }], cycles: [] });
  await f.settle();
  assert.equal(f.result.state, state);
  assert.equal(f.runtime.writes, writes);
  const afterUnmount = f.mock.defer('fetchRuns');
  f.result.refresh();
  await f.settle();
  const pending = f.mock.last('fetchRuns');
  f.runtime.unmount();
  assert.equal(pending.signal.aborted, true);
  const finalWrites = f.runtime.writes;
  afterUnmount.reject(new Error('unmounted runs failed late'));
  await f.settle();
  assert.equal(f.runtime.writes, finalWrites);
  assert.equal(f.clock.size, 0);
});

test('useNow stops/cleans its one-second ticker, retains time, and resumes immediately', async (t) => {
  const f = await fixture(t, 'now');
  assert.equal(f.result, f.clock.now);
  assert.deepEqual(f.clock.delays(), [1000]);
  await f.advance(1000);
  assert.equal(f.result, f.clock.now);
  await f.render({ active: false });
  const stopped = f.result;
  const writes = f.runtime.writes;
  assert.equal(f.clock.size, 0);
  await f.advance(HIDDEN_MS);
  assert.equal(f.result, stopped);
  assert.equal(f.runtime.writes, writes);
  await f.render({ active: true });
  assert.equal(f.result, f.clock.now);
  assert.deepEqual(f.clock.delays(), [1000]);
});

// Real WorkspaceScreen call-site wiring. Child elements are inspected, not
// rendered: this exercises scheduling/props, not canvas or browser performance.
test('workspace keeps the expert runs feed live even when the Runs dialog is closed', async (t) => {
  const f = await fixture(t, 'screen');
  assert.ok(!nodes(f.result).some((node) => node.type?.name === 'RunsPanel'));
  assert.deepEqual(ids(component(f, 'WorkspaceTopBar').props.runs), ['run-fixture']);
  const before = f.mock.count('fetchRuns');
  await f.advance(RUNS_MS);
  assert.equal(f.mock.count('fetchRuns'), before + 1, 'expert chip also consumes runs; runsOpen must not gate this feed');
  component(f, 'WorkspaceTopBar').props.onOpenRuns();
  await f.settle();
  component(f, 'RunsPanel').props.onClose();
  await f.settle();
  const afterClose = f.mock.count('fetchRuns');
  await f.advance(RUNS_MS);
  assert.equal(f.mock.count('fetchRuns'), afterClose + 1);
});

for (const method of ['fetchState', 'fetchEvents', 'fetchRuns']) {
  test(`WorkspaceScreen passes the Copilot coverage gate to ${method}`, async (t) => {
    const f = await fixture(t, 'screen');
    component(f, 'WorkspaceTopBar').props.onToggleCopilot();
    await f.settle();
    assert.equal(component(f, 'WorkspaceTopBar').props.copilotOpen, true);
    const before = f.mock.count(method);
    await f.advance(HIDDEN_MS * 2);
    assert.equal(f.mock.count(method), before, `${method} must pause while Copilot covers the workspace`);
    component(f, 'CopilotDrawer').props.onClose();
    await f.settle();
    assert.equal(f.mock.count(method), before + 1, `${method} must resume immediately after Copilot closes`);
  });
}

for (const running of ['node', 'auto']) {
  test(`WorkspaceScreen gates its ${running}-running clock with !copilotOpen`, async (t) => {
    const f = await fixture(t, 'screen', { setup(mock) {
      const state = stateData('project-fixture', 7, running === 'node' ? [{ id: 'node-fixture', status: 'running' }] : []);
      if (running === 'auto') state.auto = { status: 'running' };
      mock.respond('fetchState', state);
    } });
    await f.advance(1000);
    assert.equal(component(f, 'DagCanvas').props.now, f.clock.now);
    component(f, 'WorkspaceTopBar').props.onToggleCopilot();
    await f.settle();
    const stopped = component(f, 'DagCanvas').props.now;
    await f.advance(3000);
    assert.equal(component(f, 'DagCanvas').props.now, stopped, 'covered countdown must not keep ticking');
    component(f, 'CopilotDrawer').props.onClose();
    await f.settle();
    assert.equal(component(f, 'DagCanvas').props.now, f.clock.now, 'uncovered active countdown resumes immediately');
  });
}

test('persisted-open Copilot mounts with one state bootstrap and no events/runs/clock timers', async (t) => {
  const f = await fixture(t, 'screen', {
    running: true, storage: { 'dsh.metainfer.copilot.project-fixture': '1' },
  });
  assert.equal(component(f, 'WorkspaceTopBar').props.copilotOpen, true);
  assert.equal(component(f, 'DagCanvas').props.nodes.length, 1, 'covered bootstrap should initialize the workspace');
  assert.deepEqual(pollCounts(f), [1, 0, 0]);
  assert.equal(f.clock.size, 0, 'persisted-open Copilot must not start background polling or countdowns');
  await f.advance(HIDDEN_MS * 2);
  assert.deepEqual(pollCounts(f), [1, 0, 0]);
});
