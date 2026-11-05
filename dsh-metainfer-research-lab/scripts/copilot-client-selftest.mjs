/** Behavioral tests of the real client factory, with hooks/element trees stubbed.
 * This is not a browser layout or native-main-scope integration test.
 * Run: node --test scripts/copilot-client-selftest.mjs
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../client.js', import.meta.url), 'utf8');
function fixture(opener) {
  const reference = { sessionId: 'session-existing', ready: Promise.resolve(), release() { throw new Error('history reference released'); } };
  const state = ['ready', reference.sessionId, true, reference, '', 0, [], ''];
  const writes = [];
  let cursor = 0;
  let closed = 0;
  const react = {
    Component: class {},
    memo: (component) => component,
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState(initial) {
      const index = cursor++;
      if (!(index in state)) state[index] = typeof initial === 'function' ? initial() : initial;
      return [state[index], (value) => {
        state[index] = typeof value === 'function' ? value(state[index]) : value;
        writes.push([index, state[index]]);
      }];
    },
    useRef: (current) => ({ current }),
    useEffect() {},
  };
  let definition;
  const context = {
    window: { __ModuleLoader__: { load(value) { definition = value; } } },
    // Expose the actual closure functions only in this isolated test copy.
    __test: {}, console, Error,
    localStorage: { getItem() { return null; }, setItem() {} },
  };
  const instrumented = source
    .replace('function CopilotDrawer(', '__test.drawer = CopilotDrawer; function CopilotDrawer(')
    .replace('function buildNativeOpener(', '__test.opener = buildNativeOpener; function buildNativeOpener(');
  vm.runInNewContext(instrumented, context, { filename: 'client.js' });
  definition.factory((name) => {
    assert.equal(name, 'react');
    return react;
  });
  const props = {
    projectId: 'project-existing', onClose() { closed += 1; },
    openNativeSession: opener, retainCopilotSession() { return reference; },
    SessionProvider() {}, renderFactorySlot() { return { type: 'history-sentinel', props: {}, children: [] }; },
    t: (key) => key,
  };
  return {
    reference, writes, state, context,
    render() { cursor = 0; return context.__test.drawer(props); },
    assertPreserved(tree) {
      assert.equal(closed, 0);
      assert.equal(state[0], 'ready');
      assert.equal(state[1], reference.sessionId);
      assert.equal(state[3], reference);
      assert.ok(nodes(tree).some((entry) => entry.props.session === reference));
    },
  };
}
function nodes(value) {
  if (value === null || typeof value !== 'object') return [];
  if (Array.isArray(value)) return value.flatMap(nodes);
  return [value, ...nodes(value.children)];
}
function button(tree, label = 'ws.copilot.openNative') {
  const value = nodes(tree).find((entry) => entry.props?.label === label);
  assert.ok(value, `missing button ${label}`);
  return value;
}
for (const [name, opener, detail] of [
  ['refusal', () => ({ ok: false, error: 'retain-refused' }), 'retain-refused'],
  ['missing opener', undefined, 'ws.native.openFailed'],
  ['synchronous exception', () => { throw new Error('open-threw'); }, 'open-threw'],
  ['invalid result', () => undefined, 'ws.native.openFailed'],
  ['asynchronous rejection', () => Promise.reject(new Error('open-rejected')), 'open-rejected'],
]) {
  test(`drawer surfaces ${name} without replacing embedded history`, async () => {
    const f = fixture(opener);
    await button(f.render()).props.onClick();
    const tree = f.render();
    const alert = nodes(tree).find((entry) => entry.props.role === 'alert');
    assert.ok(alert, 'native opening failure must produce a visible alert');
    assert.ok(JSON.stringify(alert.children).includes(detail));
    f.assertPreserved(tree);
  });
}
test('drawer opens chat and trajectory with the exact existing project/session', async () => {
  const calls = [];
  const f = fixture((...args) => { calls.push(args); return { ok: true }; });
  for (const [label, view] of [['ws.copilot.openNative', 'chat'], ['ws.copilot.openTrajectory', 'trajectory']]) {
    await button(f.render(), label).props.onClick();
    const [id, actualView, scope] = calls.at(-1);
    assert.equal(id, f.reference.sessionId);
    assert.equal(actualView, view);
    assert.equal(scope.projectId, 'project-existing');
    assert.equal(scope.nodeId, '');
    f.assertPreserved(f.render());
  }
  assert.equal(calls.length, 2);
});
test('native opener passes one existing root/child target, never a blank-workspace action', async () => {
  const f = fixture();
  const address = { parentSessionId: 'parent', childSessionId: 'child', mode: 'spawn' };
  const targets = [];
  const open = f.context.__test.opener({
    sessions: { subagentAddress: (id) => id === 'child' ? address : undefined },
    uiWorkspace: { openSession: (...args) => targets.push(args) },
  });
  assert.equal((await open('', 'chat', {})).ok, false);
  assert.equal(targets.length, 0);
  assert.equal((await open('session-existing', 'chat', { projectId: 'project-existing' })).ok, true);
  assert.equal((await open('child', 'trajectory', { projectId: 'project-existing' })).ok, true);
  assert.equal(targets[0].length, 1);
  assert.equal(targets[0][0], 'session-existing');
  assert.equal(targets[1].length, 1);
  assert.equal(targets[1][0], address);
});

test('native opener waits for root catalog publication, preserving the exact ID', async () => {
  const f = fixture();
  const rows = {};
  const calls = [];
  let finish;
  const refresh = new Promise((resolve) => { finish = resolve; });
  const open = f.context.__test.opener({
    sessions: { list: { getSnapshot: () => ({ byId: rows }) }, refresh: () => refresh },
    uiWorkspace: { openSession: (...args) => calls.push(args) },
  });
  const pending = open('session-existing', 'chat', { projectId: 'project-existing' });
  assert.equal(calls.length, 0, 'do not switch to native main before its root catalog row exists');
  rows['session-existing'] = { id: 'session-existing' };
  finish();
  assert.equal((await pending).ok, true);
  assert.equal(calls.length, 1);
  assert.deepEqual(Array.from(calls[0]), ['session-existing']);
});
test('handled catalog refresh failure never opens blank native main', async () => {
  const f = fixture();
  const calls = [];
  const open = f.context.__test.opener({
    sessions: { list: { getSnapshot: () => ({ byId: {} }) }, refresh: async () => {} },
    uiWorkspace: { openSession: (...args) => calls.push(args) },
  });
  const result = await open('session-existing', 'chat', { projectId: 'project-existing' });
  assert.equal(result.ok, false);
  assert.match(result.error, /catalog/);
  assert.equal(calls.length, 0);
});

test('native opener avoids unnecessary refresh when the exact catalog row already exists', async () => {
  const f = fixture();
  let opened;
  const open = f.context.__test.opener({
    sessions: { list: { getSnapshot: () => ({ byId: { 'session-existing': { id: 'session-existing' } } }) }, refresh: () => assert.fail('unexpected refresh') },
    uiWorkspace: { openSession: (target) => { opened = target; } },
  });
  assert.equal((await open('session-existing', 'chat', {})).ok, true);
  assert.equal(opened, 'session-existing');
});
test('successful same-ID retry clears the previous native opening alert', async () => {
  let succeeds = false;
  const f = fixture(() => succeeds ? { ok: true } : { ok: false, error: 'temporary-open-error' });
  await button(f.render()).props.onClick();
  assert.ok(nodes(f.render()).some((entry) => entry.props.role === 'alert'));
  succeeds = true;
  await button(f.render()).props.onClick();
  const tree = f.render();
  assert.ok(!nodes(tree).some((entry) => entry.props.role === 'alert'));
  f.assertPreserved(tree);
});
test('workspace association warning stays visible without discarding ready embedded history', () => {
  const f = fixture();
  f.state[4] = 'No registered workspace matches the existing path';
  const tree = f.render();
  const status = nodes(tree).find((entry) => entry.props.role === 'status');
  assert.ok(status);
  assert.ok(JSON.stringify(status.children).includes(f.state[4]));
  f.assertPreserved(tree);
});
