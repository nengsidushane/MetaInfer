/** Project-sidebar behavior against the real client factory, hooks, opener, retainer and CSS.
 * Run: node --test scripts/copilot-sidebar-selftest.mjs
 * All I/O is deterministic and mocked. No browser layout, native runtime, model,
 * network, performance/FPS or durable Host integration is exercised here.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../client.js', import.meta.url), 'utf8');
const copy = (value) => JSON.parse(JSON.stringify(value));
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const sameDeps = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));

/** A mounted hook root; cleanup precedes changed effects, as in React. */
function hooks() {
  const slots = [];
  let cursor = 0;
  let count;
  let root;
  let output;
  let mounted = false;
  let dirty = false;
  let effects = [];
  let writes = 0;
  let renders = 0;
  const slot = (kind, create) => {
    const index = cursor++;
    if (!slots[index]) slots[index] = { kind, ...create() };
    assert.equal(slots[index].kind, kind, `hook order at ${index}`);
    return slots[index];
  };
  const react = {
    useState(initial) {
      const entry = slot('state', () => ({ value: typeof initial === 'function' ? initial() : initial }));
      if (!entry.set) entry.set = (next) => {
        writes += 1;
        if (!mounted) return;
        const value = typeof next === 'function' ? next(entry.value) : next;
        if (!Object.is(value, entry.value)) { entry.value = value; dirty = true; }
      };
      return [entry.value, entry.set];
    },
    useRef: (current) => slot('ref', () => ({ value: { current } })).value,
    useEffect(create, deps) {
      const entry = slot('effect', () => ({ initialized: false }));
      if (!entry.initialized || !sameDeps(entry.deps, deps)) effects.push({ entry, create, deps });
    },
  };
  const render = () => {
    assert.ok(mounted);
    let iterations = 0;
    do {
      assert.ok(++iterations < 100, 'hook root failed to settle');
      cursor = 0;
      effects = [];
      dirty = false;
      renders += 1;
      output = root();
      if (count !== undefined) assert.equal(cursor, count, 'hook count changed');
      count = cursor;
      for (const { entry } of effects) if (typeof entry.cleanup === 'function') entry.cleanup();
      for (const { entry, create, deps } of effects) {
        entry.initialized = true;
        entry.deps = deps;
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
    get renders() { return renders; },
  };
}

const legacy = (id = 'legacy-a', title = 'Original root title') => ({ id, title, private: false, parentSessionId: null, mode: null, createdAt: 10, updatedAt: 20 });
const child = (id = 'private-a', title = 'Private project title', parentSessionId = 'controller-a') => ({ id, title, private: true, parentSessionId, mode: 'continuable', createdAt: 30, updatedAt: 40 });
const listA = () => [legacy(), child()];
function response(projectId = 'project-a', sessionId = 'legacy-a', sessions = listA(), extra = {}) {
  const row = sessions.find((entry) => entry.id === sessionId);
  assert.ok(row, `missing fixture row ${sessionId}`);
  return { projectId, sessionId, reused: true, private: row.private, parentSessionId: row.parentSessionId, mode: row.mode, activeSessionId: sessionId, sessions, ...extra };
}

function client(t) {
  let definition;
  let active;
  let language = 'en';
  let dictionary;
  let main;
  let uuid = 0;
  const commands = [];
  const commandPlans = [];
  const readyPlans = [];
  const openPlans = [];
  const references = [];
  const nativeTargets = [];
  const inference = [];
  const factoryCalls = [];
  const catalog = {};
  const defaults = new Map();
  const mounts = [];
  const react = {
    Component: class {},
    memo(component, compare) { if (component.name === 'CopilotDrawer') env.compare = compare; return component; },
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState: (...args) => active.react.useState(...args),
    useRef: (...args) => active.react.useRef(...args),
    useEffect: (...args) => active.react.useEffect(...args),
  };
  const context = {
    window: { __ModuleLoader__: { load(value) { definition = value; } } },
    __test: {}, console, Error, AbortController, AbortSignal,
    localStorage: { getItem() { return null; }, setItem() { assert.fail('selection must remain Host-owned'); } },
    crypto: { randomUUID: () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, '0')}` },
    fetch() { assert.fail('network forbidden'); },
    setTimeout() { assert.fail('sidebar must not poll'); },
    setInterval() { assert.fail('sidebar must not poll'); },
  };
  const instrumented = source
    .replace('function CopilotDrawer(', '__test.drawer = CopilotDrawer; __test.api = api; function CopilotDrawer(')
    .replace('function buildNativeOpener(', '__test.opener = buildNativeOpener; function buildNativeOpener(')
    .replace('function LabStyle() {', '__test.style = LabStyle; function LabStyle() {');
  assert.notEqual(instrumented, source);
  vm.runInNewContext(instrumented, context, { filename: 'client.js' });
  const translate = (key) => dictionary[language][key] ?? key;
  const sessions = {
    list: { getSnapshot: () => ({ byId: catalog }) },
    subagentAddress(id) { inference.push(id); return env.inferred?.(id); },
    retain(target, options) {
      const plan = readyPlans.shift();
      if (plan === null) return null;
      const ready = plan ? plan() : Promise.resolve();
      const ref = { target, options, ready, releases: 0, release() { this.releases += 1; } };
      references.push(ref);
      return ref;
    },
  };
  const env = {
    context, sessions, commands, references, nativeTargets, inference, factoryCalls,
    SessionProvider() {},
    inferred: undefined,
    language(value) { language = value; },
    get dictionary() { return dictionary; },
    reply(value) { commandPlans.push(() => value); },
    fail(message) { commandPlans.push(() => { throw message instanceof Error ? message : new Error(message); }); },
    deferCommand() { const d = deferred(); commandPlans.push(() => d.promise); return d; },
    deferReady() { const d = deferred(); readyPlans.push(() => d.promise); return d; },
    refuseRetain() { readyPlans.push(null); },
    throwRetain(message) { readyPlans.push(() => { throw new Error(message); }); },
    rejectOpen(message) { openPlans.push(() => Promise.reject(new Error(message))); },
    deferOpen() { const d = deferred(); openPlans.push(() => d.promise); return d; },
    default(value) {
      defaults.set(value.projectId, value);
      for (const row of value.sessions) if (!row.private) catalog[row.id] = { id: row.id };
    },
    mount(patch = {}) {
      const runtime = hooks();
      const props = {
        ...main, projectId: 'project-a', SessionProvider: env.SessionProvider, t: translate,
        renderFactorySlot(name, options) {
          factoryCalls.push({ runtime, render: runtime.renders, name, options });
          return { type: 'native-content-sentinel', props: { 'data-conversation-content': true }, children: [] };
        },
        onClose() { runtime.unmount(); },
        ...patch,
      };
      const f = {
        runtime, props,
        get tree() { return runtime.output; },
        async settle() { for (let n = 0; n < 20; n += 1) { await Promise.resolve(); runtime.flush(); } },
        async render(next = {}) { Object.assign(props, next); runtime.render(); await f.settle(); },
        async click(label) { button(f.tree, label).props.onClick(); await f.settle(); },
        async select(id) { row(f.tree, id).props.onClick(); await f.settle(); },
        close() { runtime.unmount(); },
      };
      mounts.push(f);
      runtime.mount(() => { active = runtime; return context.__test.drawer(props); });
      return f;
    },
  };
  const plugin = definition.factory((name) => { assert.equal(name, 'react'); return react; });
  plugin.apply({
    effect(setup) { setup(); },
    locale: { register(ns, value) { dictionary = value; }, bind: () => translate },
    slots: { inject(name, setup) { setup(); }, register(config) { if (config.name === 'main') main = config.inject(); } },
    sessions,
    uiWorkspace: { openSession(target) { nativeTargets.push(target); return openPlans.shift()?.(); } },
    layout: {},
  });
  context.__test.api.command = (body, signal) => {
    assert.ok(signal instanceof AbortSignal, 'each command must carry its own AbortSignal');
    const call = { body: copy(body), signal };
    commands.push(call);
    const plan = commandPlans.shift();
    const value = plan ? plan(call) : defaults.get(body.projectId);
    assert.ok(value !== undefined, `unplanned project command ${JSON.stringify(body)}`);
    return Promise.resolve(value);
  };
  t.after(() => {
    for (const f of mounts) f.close();
    for (const ref of references) assert.equal(ref.releases, 1, 'each retained reference must release exactly once');
    for (const call of commands) assert.equal(call.signal.aborted, true, 'command controller must abort on replacement/close');
    const perRender = new Map();
    for (const call of factoryCalls) {
      assert.equal(call.name, 'conversation.content');
      assert.deepEqual(copy(call.options), { variant: 'embedded', phase: 'active', hero: false });
      const key = `${mounts.findIndex((f) => f.runtime === call.runtime)}:${call.render}`;
      perRender.set(key, (perRender.get(key) ?? 0) + 1);
    }
    for (const count of perRender.values()) assert.equal(count, 1, 'never build native content per history row');
  });
  return env;
}

function nodes(value) {
  if (value === null || typeof value !== 'object') return [];
  return Array.isArray(value) ? value.flatMap(nodes) : [value, ...nodes(value.children)];
}
function button(tree, label) {
  const value = nodes(tree).find((entry) => entry.props.label === label);
  assert.ok(value, `missing button ${label}`);
  return value;
}
const rows = (tree) => nodes(tree).filter((entry) => entry.props.className === 'rl-copilot-sidebar-row');
function row(tree, id) {
  const value = rows(tree).find((entry) => entry.props['data-session-id'] === id);
  assert.ok(value, `missing conversation ${id}`);
  return value;
}
const selected = (tree) => rows(tree).find((entry) => entry.props['aria-current'] === 'true')?.props['data-session-id'];
const alertText = (tree) => nodes(tree).filter((entry) => entry.props.role === 'alert').map((entry) => JSON.stringify(entry.children)).join('\n');
function native(env, f, target) {
  const providers = nodes(f.tree).filter((entry) => entry.type === env.SessionProvider);
  assert.equal(providers.length, 1, 'exactly one native SessionProvider');
  assert.deepEqual(copy(providers[0].props.session.target), target);
  assert.equal(nodes(f.tree).filter((entry) => entry.type === 'native-content-sentinel').length, 1);
}
const address = (id = 'private-a', parentSessionId = 'controller-a') => ({ parentSessionId, childSessionId: id, mode: 'continuable' });
async function loaded(t, value = response()) {
  const env = client(t);
  env.default(value);
  const f = env.mount({ projectId: value.projectId });
  await f.settle();
  return { env, f };
}

// Behavior, identity, Host ownership, and one embedded native conversation.
test('left project rail retains every legacy/private entry, Host order/title and the original root ID', async (t) => {
  const history = [legacy(), ...Array.from({ length: 40 }, (_, n) => child(`child-${n}`, `Host title ${n}`)), child()];
  const before = copy(history);
  const { env, f } = await loaded(t, response('project-a', 'legacy-a', history));
  const workspace = nodes(f.tree).find((entry) => entry.props.className === 'rl-copilot-native-workspace');
  assert.equal(workspace.children[0].type, 'aside', 'rail belongs inside the drawer and to the left of native content');
  assert.deepEqual(rows(f.tree).map((entry) => entry.props['data-session-id']), history.map((entry) => entry.id));
  assert.match(JSON.stringify(row(f.tree, 'legacy-a').children), /Original root title.*Legacy · DSH visible/);
  assert.match(JSON.stringify(row(f.tree, 'private-a').children), /Private project title.*Private child/);
  assert.equal(selected(f.tree), 'legacy-a');
  native(env, f, 'legacy-a');
  assert.deepEqual(copy(env.references[0].options), { source: 'controllerOperation' });
  assert.deepEqual(env.commands[0].body, { type: 'project.copilot', projectId: 'project-a' });
  assert.deepEqual(history, before, 'display must never mutate Host records');
  assert.equal(nodes(f.tree).filter((entry) => entry.type?.name === 'LabSelect').length, 0);
  for (const label of ['Open in DSH native window', 'Open native trajectory in DSH']) await button(f.tree, label).props.onClick();
  assert.deepEqual(env.nativeTargets, ['legacy-a', 'legacy-a']);
});

test('private retain and both native views use the exact explicit continuable child address', async (t) => {
  const { env, f } = await loaded(t, response('project-a', 'private-a', listA(), { warning: 'Workspace association warning' }));
  env.inferred = () => ({ parentSessionId: 'wrong', childSessionId: 'wrong', mode: 'spawn' });
  native(env, f, address());
  assert.deepEqual(env.inference, [], 'explicit private retain must not rely on catalog inference');
  for (const label of ['Open in DSH native window', 'Open native trajectory in DSH']) await button(f.tree, label).props.onClick();
  assert.deepEqual(env.nativeTargets.map(copy), [address(), address()]);
  assert.deepEqual(env.inference, []);
  const status = nodes(f.tree).find((entry) => entry.props.role === 'status');
  assert.ok(JSON.stringify(status.children).includes('Workspace association warning'));
  assert.equal(env.references.length, 1);
});

test('switch uses explicit identity, disables actions, adopts Host success and releases exactly one old reference', async (t) => {
  const { env, f } = await loaded(t);
  const pending = env.deferCommand();
  const oldRow = row(f.tree, 'private-a');
  const newButton = button(f.tree, 'New conversation');
  oldRow.props.onClick();
  oldRow.props.onClick();
  newButton.props.onClick();
  await f.settle();
  assert.equal(env.commands.length, 2, 'rapid stale handlers must coalesce synchronously');
  assert.deepEqual(env.commands[1].body, { type: 'project.copilot', projectId: 'project-a', sessionId: 'private-a' });
  assert.equal(selected(f.tree), 'legacy-a', 'do not optimistically mark the clicked row selected');
  assert.ok(rows(f.tree).every((entry) => entry.props.disabled));
  assert.equal(button(f.tree, 'New conversation').props.disabled, true);
  assert.equal(env.references[0].releases, 1);
  assert.equal(env.commands[0].signal.aborted, true);
  assert.equal(nodes(f.tree).filter((entry) => entry.type === env.SessionProvider).length, 0);
  pending.resolve(response('project-a', 'private-a', [child('private-a', 'Host-selected title'), legacy()]));
  await f.settle();
  assert.equal(selected(f.tree), 'private-a');
  assert.equal(rows(f.tree)[0].props['data-session-id'], 'private-a', 'Host MRU/order wins');
  assert.match(JSON.stringify(rows(f.tree)[0].children), /Host-selected title/);
  native(env, f, address());
  env.reply(response());
  await f.select('legacy-a');
  native(env, f, 'legacy-a');
  assert.equal(env.references[1].releases, 1);
  assert.equal(env.commands[2].body.sessionId, 'legacy-a');
});

test('New uses one bounded random action token for rapid clicks and a new token only after acknowledgement', async (t) => {
  const { env, f } = await loaded(t);
  const pending = env.deferCommand();
  const trigger = button(f.tree, 'New conversation').props.onClick;
  trigger(); trigger(); row(f.tree, 'private-a').props.onClick();
  await f.settle();
  assert.equal(env.commands.length, 2);
  const action = env.commands[1].body;
  assert.equal(action.create, true);
  assert.equal(action.sessionId, undefined);
  assert.match(action.requestId, /^copilot-[a-f0-9-]{36}$/);
  assert.ok(action.requestId.length <= 96);
  const created = child('created-a', 'Host new title');
  pending.resolve(response('project-a', 'created-a', [created, ...listA()], { reused: false }));
  await f.settle();
  native(env, f, address('created-a'));
  assert.equal(selected(f.tree), 'created-a');
  env.reply(response('project-a', 'created-b', [child('created-b'), created, ...listA()], { reused: false }));
  await f.click('New conversation');
  assert.notEqual(env.commands[2].body.requestId, action.requestId);
  native(env, f, address('created-b'));
});

test('failed explicit selection remains operable and retry targets that same ID without create/default fallback', async (t) => {
  const { env, f } = await loaded(t);
  env.fail('copilot_history_unavailable: exact private-a');
  await f.select('private-a');
  assert.equal(selected(f.tree), 'legacy-a');
  assert.match(alertText(f.tree), /copilot_history_unavailable: exact private-a/);
  assert.equal(button(f.tree, 'New conversation').props.disabled, false);
  assert.ok(rows(f.tree).every((entry) => entry.props.disabled === false));
  const failed = env.commands.at(-1).body;
  env.reply(response('project-a', 'private-a'));
  await f.click('Retry');
  assert.deepEqual(env.commands.at(-1).body, failed);
  assert.equal(env.commands.at(-1).body.create, undefined);
  native(env, f, address());
});

for (const kind of ['timeout', 'AbortError']) test(`ambiguous create ${kind} retries the same persistent action token`, async (t) => {
  const { env, f } = await loaded(t);
  const error = new Error(kind === 'timeout' ? 'transport timed out after server creation' : 'transport aborted after server creation');
  if (kind === 'AbortError') error.name = kind;
  env.fail(error);
  await f.click('New conversation');
  const failed = copy(env.commands.at(-1).body);
  assert.match(alertText(f.tree), /transport/);
  assert.equal(button(f.tree, 'New conversation').props.disabled, false);
  env.reply(response('project-a', 'recovered-a', [child('recovered-a'), ...listA()]));
  await f.click('Retry');
  assert.deepEqual(env.commands.at(-1).body, failed);
  native(env, f, address('recovered-a'));
});

test('New after a failed create and an intervening selection reconciles the unresolved action, not a duplicate', async (t) => {
  const { env, f } = await loaded(t);
  env.fail('ambiguous create');
  await f.click('New conversation');
  const token = env.commands.at(-1).body.requestId;
  env.reply(response());
  await f.select('legacy-a');
  env.reply(response('project-a', 'recovered-a', [child('recovered-a'), ...listA()]));
  await f.click('New conversation');
  assert.equal(env.commands.at(-1).body.requestId, token);
  native(env, f, address('recovered-a'));
});

test('reopen defaults to Host-persisted selection; different projects never share lists or selection IDs', async (t) => {
  const { env, f } = await loaded(t);
  env.reply(response('project-a', 'private-a'));
  await f.select('private-a');
  f.close();
  env.default(response('project-b', 'legacy-b', [legacy('legacy-b', 'Only B'), child('private-b', 'B child', 'controller-b')]));
  const b = env.mount({ projectId: 'project-b' });
  await b.settle();
  assert.deepEqual(rows(b.tree).map((entry) => entry.props['data-session-id']), ['legacy-b', 'private-b']);
  native(env, b, 'legacy-b');
  b.close();
  env.default(response('project-a', 'private-a'));
  const reopened = env.mount();
  await reopened.settle();
  assert.deepEqual(env.commands.at(-1).body, { type: 'project.copilot', projectId: 'project-a' });
  assert.equal(selected(reopened.tree), 'private-a');
  assert.ok(row(reopened.tree, 'legacy-a'), 'legacy must remain visible when reopening a private selection');
  native(env, reopened, address());
});

test('aborted create can finish server-side; reopen reads persisted selection and New reuses its unresolved token', async (t) => {
  const { env, f } = await loaded(t);
  const late = env.deferCommand();
  await f.click('New conversation');
  const token = env.commands.at(-1).body.requestId;
  f.close();
  const writes = f.runtime.writes;
  const persisted = response('project-a', 'created-a', [child('created-a'), ...listA()]);
  late.resolve(persisted);
  await f.settle();
  assert.equal(f.runtime.writes, writes);
  env.default(persisted);
  const reopened = env.mount();
  await reopened.settle();
  assert.equal(env.commands.at(-1).body.create, undefined);
  native(env, reopened, address('created-a'));
  env.reply(persisted);
  await reopened.click('New conversation');
  assert.equal(env.commands.at(-1).body.requestId, token, 'reconcile the already-created child before minting another action');
  native(env, reopened, address('created-a'));
});

for (const outcome of ['resolve', 'reject']) {
  test(`project replacement rejects a late command ${outcome} and its stale list`, async (t) => {
    const env = client(t);
    const old = env.deferCommand();
    const f = env.mount();
    env.default(response('project-b', 'private-b', [child('private-b', 'B only', 'controller-b')]));
    await f.render({ projectId: 'project-b' });
    assert.equal(env.commands[0].signal.aborted, true);
    native(env, f, address('private-b', 'controller-b'));
    const writes = f.runtime.writes;
    if (outcome === 'resolve') old.resolve(response()); else old.reject(new Error('stale old-project failure'));
    await f.settle();
    assert.equal(f.runtime.writes, writes);
    assert.deepEqual(rows(f.tree).map((entry) => entry.props['data-session-id']), ['private-b']);
    assert.equal(env.references.length, 1);
  });
  test(`close rejects a late command ${outcome} without retain or state writes`, async (t) => {
    const env = client(t);
    const late = env.deferCommand();
    const f = env.mount();
    f.close();
    const writes = f.runtime.writes;
    if (outcome === 'resolve') late.resolve(response()); else late.reject(new Error('closed command failure'));
    await f.settle();
    assert.equal(f.runtime.writes, writes);
    assert.equal(env.references.length, 0);
  });
  test(`close releases a pending ready reference once and ignores its late ${outcome}`, async (t) => {
    const env = client(t);
    env.default(response('project-a', 'private-a'));
    const ready = env.deferReady();
    const f = env.mount();
    await f.settle();
    assert.equal(env.references.length, 1);
    f.close();
    assert.equal(env.references[0].releases, 1);
    const writes = f.runtime.writes;
    if (outcome === 'resolve') ready.resolve(); else ready.reject(new Error('closed ready failure'));
    await f.settle();
    assert.equal(f.runtime.writes, writes);
    assert.equal(env.references[0].releases, 1);
  });
  test(`old ready ${outcome} cannot release or replace a new project's retained reference`, async (t) => {
    const env = client(t);
    env.default(response('project-a', 'private-a'));
    const ready = env.deferReady();
    const f = env.mount();
    await f.settle();
    env.default(response('project-b', 'private-b', [child('private-b', 'B only', 'controller-b')]));
    await f.render({ projectId: 'project-b' });
    assert.equal(env.references[0].releases, 1);
    const writes = f.runtime.writes;
    if (outcome === 'resolve') ready.resolve(); else ready.reject(new Error('old ready failure'));
    await f.settle();
    assert.equal(f.runtime.writes, writes);
    assert.equal(env.references[1].releases, 0);
    native(env, f, address('private-b', 'controller-b'));
  });
}

test('ready failure releases immediately, leaves rail usable and retries the acknowledged child ID, not create', async (t) => {
  const { env, f } = await loaded(t);
  const ready = env.deferReady();
  env.reply(response('project-a', 'new-a', [child('new-a'), ...listA()], { reused: false }));
  await f.click('New conversation');
  ready.reject(new Error('native ready rejected'));
  await f.settle();
  assert.equal(env.references.at(-1).releases, 1);
  assert.match(alertText(f.tree), /native ready rejected/);
  assert.equal(button(f.tree, 'New conversation').props.disabled, false);
  env.reply(response('project-a', 'new-a', [child('new-a'), ...listA()]));
  await f.click('Retry');
  assert.deepEqual(env.commands.at(-1).body, { type: 'project.copilot', projectId: 'project-a', sessionId: 'new-a' });
  native(env, f, address('new-a'));
});

for (const kind of ['refused', 'throw']) test(`native retain ${kind} keeps list/New available and retries the same selected ID`, async (t) => {
  const env = client(t);
  env.default(response('project-a', 'private-a'));
  if (kind === 'refused') env.refuseRetain(); else env.throwRetain('retain threw');
  const f = env.mount();
  await f.settle();
  assert.ok(alertText(f.tree));
  assert.equal(selected(f.tree), 'private-a');
  assert.equal(button(f.tree, 'New conversation').props.disabled, false);
  env.reply(response('project-a', 'private-a'));
  await f.click('Retry');
  assert.equal(env.commands.at(-1).body.sessionId, 'private-a');
  assert.equal(env.commands.at(-1).body.create, undefined);
  native(env, f, address());
});

test('incomplete private addresses fail closed without retaining/opening a blank root', async (t) => {
  const env = client(t);
  env.default(response('project-a', 'private-a', listA(), { parentSessionId: null, mode: null }));
  const f = env.mount();
  await f.settle();
  assert.match(alertText(f.tree), /private-session address is incomplete/);
  assert.equal(env.references.length, 0);
  assert.equal(button(f.tree, 'Open in DSH native window').props.disabled, true);
  assert.equal(button(f.tree, 'New conversation').props.disabled, false);
  assert.deepEqual(env.nativeTargets, []);
});

test('explicit selection never adopts a mismatched ID or wrong-project reply as an empty/default fallback', async (t) => {
  const { env, f } = await loaded(t);
  for (const invalid of [response(), response('project-b', 'private-a'), { sessionId: '', sessions: [] }]) {
    env.reply(invalid);
    await f.select('private-a');
    assert.equal(selected(f.tree), 'legacy-a');
    assert.ok(alertText(f.tree));
    assert.equal(env.commands.at(-1).body.sessionId, 'private-a');
    assert.equal(env.references.length, 1);
  }
  env.reply(response('project-a', 'private-a'));
  await f.click('Retry');
  native(env, f, address());
});

test('locale redraw uses real English/Chinese labels without refetching or re-retaining the conversation', async (t) => {
  const { env, f } = await loaded(t);
  const reference = env.references[0];
  const props = { ...f.props };
  env.language('zh');
  const nextT = (key) => env.dictionary.zh[key] ?? key;
  assert.equal(env.compare(props, { ...props }), true);
  assert.equal(env.compare(props, { ...props, t: nextT }), false, 'locale changes should not be swallowed by memo');
  await f.render({ t: nextT });
  button(f.tree, '新建对话');
  assert.match(JSON.stringify(row(f.tree, 'legacy-a').children), /旧会话 · DSH 可见/);
  assert.match(JSON.stringify(row(f.tree, 'private-a').children), /私有子会话/);
  for (const locale of ['en', 'zh']) for (const key of ['conversations', 'newSession', 'noSessions', 'privateSession', 'privateSessionHint', 'legacySession', 'legacySessionHint', 'invalidAddress']) {
    assert.equal(typeof env.dictionary[locale][`ws.copilot.${key}`], 'string', `${locale}: ${key}`);
  }
  assert.equal(env.commands.length, 1);
  assert.equal(env.references.length, 1);
  assert.equal(env.references[0], reference);
  native(env, f, 'legacy-a');
});

test('real native opener awaits async navigation rejection and drawer preserves its current private history', async (t) => {
  const { env, f } = await loaded(t, response('project-a', 'private-a'));
  env.rejectOpen('workspace async rejected');
  await button(f.tree, 'Open in DSH native window').props.onClick();
  await f.settle();
  assert.match(alertText(f.tree), /workspace async rejected/);
  native(env, f, address());
  await button(f.tree, 'Open native trajectory in DSH').props.onClick();
  await f.settle();
  assert.equal(alertText(f.tree), '');
  assert.equal(env.references.length, 1);
});

test('late native opening failure after switching cannot overwrite the new selection error state', async (t) => {
  const { env, f } = await loaded(t);
  const late = env.deferOpen();
  const open = button(f.tree, 'Open in DSH native window').props.onClick();
  env.reply(response('project-a', 'private-a'));
  await f.select('private-a');
  const writes = f.runtime.writes;
  late.reject(new Error('old native error'));
  await open;
  await f.settle();
  assert.equal(f.runtime.writes, writes);
  assert.equal(alertText(f.tree), '');
  native(env, f, address());
});

test('explicit private opener bypasses root catalog gates but preserves inferred node addresses and root refresh errors', async (t) => {
  const env = client(t);
  const targets = [];
  const inferred = { parentSessionId: 'node-parent', childSessionId: 'node-child', mode: 'spawn' };
  const open = env.context.__test.opener({
    sessions: {
      subagentAddress: (id) => id === 'node-child' ? inferred : undefined,
      list: { getSnapshot: () => ({ byId: {} }) },
      refresh: async () => { throw new Error('root catalog refresh failed'); },
    },
    uiWorkspace: { openSession: (value) => targets.push(value) },
  });
  assert.equal((await open('private-a', 'chat', { parentSessionId: 'controller-a', mode: 'continuable' })).ok, true);
  assert.deepEqual(copy(targets[0]), address());
  assert.equal((await open('node-child', 'trajectory', {})).ok, true);
  assert.equal(targets[1], inferred);
  const root = await open('root-missing', 'chat', {});
  assert.equal(root.ok, false);
  assert.equal(root.error, 'root catalog refresh failed');
  assert.equal((await open('private-a', 'chat', { parentSessionId: 'controller-a', mode: 'spawn' })).ok, false);
  assert.equal(targets.length, 2, 'no invalid-mode, missing-root, or generic blank fallback navigation');
});

// Emitted CSS, not source-text replicas or browser/performance claims.
test('actual sidebar CSS contains desktop/narrow rails and min-zero overflow containment', (t) => {
  const env = client(t);
  const css = env.context.__test.style().children[0];
  const rule = (selector) => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return [...css.matchAll(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, 'g'))].map((entry) => entry[1]);
  };
  const sidebar = rule('.rl-copilot-sidebar');
  assert.match(sidebar[0], /flex:\s*0 0 220px/);
  assert.match(sidebar[0], /width:\s*220px/);
  assert.match(sidebar.at(-1), /flex-basis:\s*130px/);
  assert.match(sidebar.at(-1), /width:\s*130px/);
  for (const selector of ['.rl-copilot-native-workspace', '.rl-copilot-sidebar', '.rl-copilot-native-body', '.rl-copilot-native-view']) {
    assert.match(rule(selector)[0], /min-width:\s*0/);
    assert.match(rule(selector)[0], /min-height:\s*0/);
    assert.match(rule(selector)[0], /overflow:\s*hidden/);
  }
  const list = rule('.rl-copilot-sidebar-list')[0];
  assert.match(list, /min-height:\s*0/);
  assert.match(list, /overflow-y:\s*auto/);
  assert.match(list, /overflow-x:\s*hidden/);
  assert.match(rule('.rl-copilot-sidebar-head')[0], /flex:\s*none/);
  assert.match(rule('.rl-copilot-sidebar-row-title')[0], /text-overflow:\s*ellipsis/);
  assert.match(rule('.rl-copilot-sidebar-row:disabled')[0], /cursor:\s*wait/);
  assert.match(rule('.rl-copilot-sidebar-row:focus-visible')[0], /outline:/);
  assert.match(rule('.rl-copilot-native-head .rl-chip')[0], /max-width:\s*100%/);
  for (const surface of rule('.rl-copilot-native')) assert.match(surface, /border-radius:\s*0(?:px)?\s*;/);
  assert.match(rule('.rl-copilot-sidebar-row')[0], /border-radius:\s*0/);
  assert.match(rule('.rl-copilot-native-view [data-conversation-scroll]')[0], /overflow-y:\s*auto !important/);
  assert.match(rule('.rl-copilot-native-view [data-composer-seat]')[0], /position:\s*sticky !important/);
  assert.match(rule('.rl-workspace-main[data-copilot-open="true"] .rl-workspace-grid')[0], /content-visibility:\s*hidden/);
});
