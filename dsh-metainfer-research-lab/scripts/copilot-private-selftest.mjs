/** Isolated actual-service tests. All Agents, Sessions and storage are mocked; no DSH/model/network writes. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createLabService } from '../host/lab-service.js';
import { registerHttpRoutes } from '../host/http.js';

export const PROJECT_ID = 'prj-private-test';
export const LEGACY_ID = 'session-existing-root';
export const MODEL = { provider: 'fake-provider', model: 'fake-controller', reasoningEffort: 'high' };
export const REPO_PATH = 'D:/projects/private-research';
export function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

export function fixture({ legacy = false, live = false, behavior = {}, initialProjects } = {}) {
  const project = {
    id: PROJECT_ID, repo: { path: REPO_PATH }, controllerSessionId: 'session-controller-private',
    config: { models: { roles: { controller: MODEL } } }, createdAt: 100, updatedAt: 123, revision: 7,
    chatLog: [{ role: 'user', text: 'Keep this project history', at: 100 }],
    ...(legacy ? { copilotSessionId: LEGACY_ID } : {}),
  };
  const projects = new Map((initialProjects ?? [project]).map((item) => [item.id, structuredClone(item)]));
  const sessions = new Map();
  const agents = new Map();
  const listeners = new Map();
  const disposers = [];
  const calls = { create: [], resume: [], save: [], reads: [], mount: [], tools: [], dispose: [], ensure: [], order: [], defaults: 0 };
  const locks = new Map();
  const store = {
    getProject: (id) => structuredClone(projects.get(id)),
    listProjects: () => [...projects.values()].map((item) => structuredClone(item)),
    saveProject: async (value) => {
      calls.save.push(structuredClone(value));
      calls.order.push('save:' + (value.copilotSessions?.at(-1)?.status ?? 'legacy'));
      await behavior.save?.(value, calls.save.length);
      projects.set(value.id, structuredClone(value));
    },
    withProjectLock(id, task) {
      const run = (locks.get(id) ?? Promise.resolve()).then(task);
      locks.set(id, run.catch(() => {}));
      return run;
    },
    getNode: (projectId, nodeId) => ({ id: nodeId, projectId, marker: projectId }),
  };
  function makeSession(id, header, events = []) {
    const session = {
      header: { id, createdAt: 200, ...header }, events: structuredClone(events),
      ownEvents() { return this.events; },
      append(type, data) {
        behavior.append?.(id, type, data);
        calls.order.push(type);
        const event = { type, data: structuredClone(data), seq: this.events.length, timestamp: 200 };
        this.events.push(event);
        return event;
      },
    };
    sessions.set(id, session);
    return session;
  }
  if (legacy) makeSession(LEGACY_ID, { cwd: REPO_PATH }, [{ type: 'user/message', data: { text: 'previous native turn' } }, { type: 'tool/result', data: { text: 'previous tool result' } }]);
  function freshAgent(id, session) {
    const tools = [];
    const agentCtx = { tools: { register(tool) {
      assert.equal(tools.some((entry) => entry.name === tool.name), false, 'Scoped tool registers only once');
      tools.push(tool); calls.tools.push({ id, tool });
      return () => { const index = tools.indexOf(tool); if (index >= 0) tools.splice(index, 1); };
    } } };
    return { id, session, ctx: agentCtx, registeredTools: tools, run() { assert.fail('Opening Copilot must not run a model turn'); } };
  }
  if (live && legacy) agents.set(LEGACY_ID, freshAgent(LEGACY_ID, sessions.get(LEGACY_ID)));
  async function announce(agent) {
    for (const listener of listeners.get('agent/created') ?? []) await listener({ agent, source: 'mock' });
  }
  const forbidden = () => assert.fail('No workspace, archive, transcript-copy, global-tool or model operation is allowed');
  const ctx = {
    effect(setup) { const off = setup(); if (off) disposers.push(off); },
    on(name, listener) {
      const entries = listeners.get(name) ?? [];
      entries.push(listener); listeners.set(name, entries);
      return () => listeners.set(name, (listeners.get(name) ?? []).filter((item) => item !== listener));
    },
    agents: {
      get: (id) => agents.get(id),
      async create(spec) {
        calls.create.push(spec); calls.order.push('create');
        await behavior.create?.(spec);
        const session = makeSession(spec.sessionId, spec.meta);
        const agent = freshAgent(spec.sessionId, session);
        agents.set(agent.id, agent);
        await spec.setup(agent.ctx, agent);
        await announce(agent);
        await behavior.afterCreate?.(spec, agent);
        return {
          agent,
          async dispose() {
            calls.dispose.push(agent.id); calls.order.push('dispose');
            await behavior.dispose?.(agent.id);
            agents.delete(agent.id);
          },
        };
      },
      async resume(spec) {
        calls.resume.push(spec); calls.order.push('resume');
        await behavior.resume?.(spec);
        const session = sessions.get(spec.resumeSessionId);
        if (!session) throw new Error('mock persisted root missing');
        const agent = freshAgent(spec.resumeSessionId, session);
        await spec.setup(agent.ctx, agent);
        await announce(agent);
        agents.set(agent.id, agent);
        return { agent, async dispose() { calls.dispose.push(agent.id); agents.delete(agent.id); } };
      },
    },
    agentPresets: { async mount(agentCtx, preset) { calls.mount.push(preset); await behavior.mount?.(agentCtx, preset); } },
    agentDefaultModel: { currentSelection() { calls.defaults++; return { provider: 'fallback', model: 'fallback' }; } },
    sessionQuery: {
      async readSession(id) {
        calls.reads.push(id);
        await behavior.read?.(id);
        const session = sessions.get(id);
        if (!session) { const error = new Error('not found: ' + id); error.code = 'SESSION_QUERY_SESSION_NOT_FOUND'; throw error; }
        return { session: structuredClone(session.header), events: structuredClone(session.events), inheritedEventCount: 0 };
      },
      readSurface: forbidden,
    },
    sessions: { get: (id) => sessions.get(id), archive: forbidden, unarchive: forbidden, copy: forbidden },
    workspaceRegistry: { resolveByPath: forbidden, create: forbidden, attachSession: forbidden, detachSession: forbidden },
    subagents: { delegate: forbidden }, tools: { register: forbidden }, llm: { call: forbidden },
  };
  const orchestrator = {
    async ensureController(value) {
      calls.ensure.push(value.id);
      await behavior.ensure?.(value);
      let session = sessions.get(value.controllerSessionId);
      if (!session) session = makeSession(value.controllerSessionId, { cwd: value.repo.path, origin: 'subagent', agentPreset: 'lab-controller' });
      let agent = agents.get(value.controllerSessionId);
      if (!agent) { agent = freshAgent(value.controllerSessionId, session); agents.set(agent.id, agent); await announce(agent); }
      return agent;
    },
  };
  let lab;
  function startService() { lab = createLabService({ ctx, store, orchestrator }); return lab; }
  startService();
  return {
    get lab() { return lab; }, ctx, store, calls, projects, sessions, agents, listeners, behavior, initialProject: project,
    freshAgent, makeSession, announce,
    async reload() { for (const off of disposers.splice(0)) await off(); return startService(); },
    async close() { for (const off of disposers.splice(0)) await off(); },
  };
}

function tests() {
  test('new chat reserves its identity/model before factory and becomes an exact private continuable child', async () => {
    const f = fixture();
    const result = await f.lab.openCopilot(PROJECT_ID, { create: true, requestId: 'create-1', title: '  Plan  ' });
    assert.equal(result.private, true); assert.equal(result.mode, 'continuable');
    assert.equal(result.parentSessionId, f.initialProject.controllerSessionId);
    assert.equal(result.activeSessionId, result.sessionId); assert.equal(result.reused, false);
    assert.deepEqual(result.sessions.map((entry) => entry.title), ['Plan']);
    const spec = f.calls.create[0];
    assert.deepEqual(spec.meta, { cwd: REPO_PATH, origin: 'subagent', parentSession: result.parentSessionId, delegationDepth: 1, agentPreset: 'lab-chat' });
    assert.deepEqual(spec.agentOptions, { ...MODEL, source: 'project-role' });
    assert.equal(f.calls.save[0].copilotSessions[0].id, result.sessionId);
    assert.equal(f.calls.save[0].copilotSessions[0].requestId, 'create-1');
    assert.deepEqual(f.calls.save[0].copilotSessions[0].pendingModel, spec.agentOptions);
    assert.ok(f.calls.order.indexOf('save:pending') < f.calls.order.indexOf('create'));
    const session = f.sessions.get(result.sessionId);
    assert.deepEqual(session.events.map((event) => event.type), ['agent-preset/selected', 'subagent/descriptor']);
    assert.deepEqual(session.events[1].data, { version: 3, mode: 'continuable', provider: 'spawn', label: 'mirl-copilot/' + PROJECT_ID, agentProvider: MODEL.provider, agentModel: MODEL.model, agentReasoningEffort: MODEL.reasoningEffort });
    const parent = f.sessions.get(result.parentSessionId);
    assert.deepEqual(parent.events[0].data, { version: 0, childId: result.sessionId, childCreatedAt: session.header.createdAt, mode: 'continuable', label: 'mirl-copilot/' + PROJECT_ID });
    assert.ok(f.calls.order.indexOf('dispose') < f.calls.order.indexOf('subagent/catalog'));
    assert.ok(f.calls.order.indexOf('subagent/catalog') < f.calls.order.indexOf('save:ready'));
    assert.equal(f.agents.has(result.sessionId), false); assert.equal(f.agents.has(result.parentSessionId), true);
    assert.equal(f.calls.resume.length, 0); assert.equal(f.calls.tools.filter((call) => call.id === result.sessionId).length, 1);
    const saved = f.store.getProject(PROJECT_ID);
    assert.equal(saved.copilotSessionId, result.sessionId); assert.equal(saved.activeCopilotSessionId, result.sessionId);
    assert.equal(saved.copilotSessions[0].status, 'ready'); assert.equal(saved.copilotSessions[0].pendingModel, undefined);
    assert.deepEqual(saved.chatLog, f.initialProject.chatLog);
  });

  test('legacy root stays in project list under same ID, is not archived, and remains sendable', async () => {
    const f = fixture({ legacy: true });
    const before = structuredClone(f.sessions.get(LEGACY_ID).events);
    const legacy = await f.lab.openCopilot(PROJECT_ID);
    assert.equal(legacy.private, false); assert.equal(legacy.parentSessionId, null); assert.equal(legacy.mode, null);
    assert.equal(legacy.sessionId, LEGACY_ID); assert.deepEqual(f.sessions.get(LEGACY_ID).events, before);
    const child = await f.lab.openCopilot(PROJECT_ID, { create: true, requestId: 'child' });
    assert.deepEqual(child.sessions.map((entry) => [entry.id, entry.private]), [[LEGACY_ID, false], [child.sessionId, true]]);
    const selected = await f.lab.openCopilot(PROJECT_ID, { sessionId: LEGACY_ID });
    assert.equal(selected.sessionId, LEGACY_ID); assert.equal(selected.reused, true);
    f.agents.get(LEGACY_ID).session.append('user/message', { text: 'Continue this original conversation' });
    assert.deepEqual(f.sessions.get(LEGACY_ID).events.slice(0, 2), before);
    assert.equal(f.sessions.get(LEGACY_ID).events.at(-1).data.text, 'Continue this original conversation');
    assert.equal(f.calls.resume.length, 1); assert.equal(f.calls.create.length, 1);
  });

  test('create/switch/default/reopen have one authoritative selection and preserve descriptor model', async () => {
    const f = fixture();
    const one = await f.lab.openCopilot(PROJECT_ID);
    const two = await f.lab.openCopilot(PROJECT_ID, { create: true, requestId: 'two' });
    assert.deepEqual(two.sessions.map((entry) => entry.title), ['Copilot 1', 'Copilot 2']);
    assert.equal((await f.lab.getCopilot(PROJECT_ID)).activeSessionId, two.sessionId);
    const edited = f.store.getProject(PROJECT_ID); edited.config.models.roles.controller = { provider: 'different', model: 'different' }; f.projects.set(PROJECT_ID, edited);
    const defaults = f.calls.defaults;
    await f.lab.openCopilot(PROJECT_ID, { sessionId: one.sessionId });
    assert.equal((await f.lab.openCopilot(PROJECT_ID)).sessionId, one.sessionId);
    assert.equal((await f.lab.getCopilot(PROJECT_ID)).sessionId, one.sessionId);
    assert.equal(f.calls.defaults, defaults); assert.equal(f.calls.create.length, 2); assert.equal(f.calls.resume.length, 0);
    assert.equal(f.sessions.get(one.sessionId).events[1].data.agentModel, MODEL.model);
    assert.equal(f.store.getProject(PROJECT_ID).copilotSessionId, one.sessionId);
  });

  test('stable create request replay is idempotent, including concurrent calls and reload', async () => {
    const f = fixture();
    const input = { create: true, requestId: 'same-request', title: 'Same' };
    const [a, b] = await Promise.all([f.lab.openCopilot(PROJECT_ID, input), f.lab.openCopilot(PROJECT_ID, input)]);
    assert.equal(a.sessionId, b.sessionId); assert.equal(a.reused, false); assert.equal(b.reused, true);
    await f.reload();
    const replay = await f.lab.openCopilot(PROJECT_ID, input);
    assert.equal(replay.sessionId, a.sessionId); assert.equal(replay.reused, true);
    assert.equal(f.calls.create.length, 1); assert.equal(f.calls.defaults, 1);
    await assert.rejects(f.lab.openCopilot(PROJECT_ID, { ...input, title: 'Not same' }), { code: 'copilot_request_conflict' });
  });

  test('different concurrent create requests are queued, never coalesced into the wrong chat', async () => {
    const gate = deferred(); const started = deferred();
    const f = fixture({ behavior: { async create() { if (f.calls.create.length === 1) { started.resolve(); await gate.promise; } } } });
    const a = f.lab.openCopilot(PROJECT_ID, { create: true, requestId: 'a', title: 'A' });
    await started.promise;
    const b = f.lab.openCopilot(PROJECT_ID, { create: true, requestId: 'b', title: 'B' });
    assert.equal(f.calls.create.length, 1); gate.resolve();
    const [one, two] = await Promise.all([a, b]);
    assert.notEqual(one.sessionId, two.sessionId); assert.equal(one.sessions.at(-1).title, 'A'); assert.equal(two.sessions.at(-1).title, 'B');
    assert.equal(f.calls.create.length, 2); assert.equal((await f.lab.getCopilot(PROJECT_ID)).sessionId, two.sessionId);
  });

  test('explicit switch queued behind create selects exactly the requested legacy ID', async () => {
    const f = fixture({ legacy: true });
    const [created, selected] = await Promise.all([
      f.lab.openCopilot(PROJECT_ID, { create: true, requestId: 'new' }), f.lab.openCopilot(PROJECT_ID, { sessionId: LEGACY_ID }),
    ]);
    assert.notEqual(created.sessionId, selected.sessionId); assert.equal(selected.sessionId, LEGACY_ID);
    assert.equal((await f.lab.getCopilot(PROJECT_ID)).activeSessionId, LEGACY_ID);
  });

  test('unknown or foreign-project IDs error without factory, fallback or mutation', async () => {
    const f = fixture();
    for (const sessionId of ['session-unknown', LEGACY_ID]) await assert.rejects(f.lab.openCopilot(PROJECT_ID, { sessionId }), { code: 'copilot_session_not_found' });
    assert.equal(f.calls.create.length, 0); assert.equal(f.calls.save.length, 0); assert.equal(f.calls.defaults, 0);
    assert.deepEqual(f.store.getProject(PROJECT_ID), f.initialProject);
  });

  test('projects create independently with same requestId and never leak context/selection', async () => {
    const first = fixture().initialProject;
    const other = { ...structuredClone(first), id: 'prj-other', controllerSessionId: 'session-controller-other', repo: { path: 'D:/projects/other-research' } };
    const gate = deferred(); const started = deferred();
    const f = fixture({ initialProjects: [first, other], behavior: { async create(spec) { if (spec.meta.cwd === REPO_PATH) { started.resolve(); await gate.promise; } } } });
    const pending = f.lab.openCopilot(PROJECT_ID, { create: true, requestId: 'same' }); await started.promise;
    const second = await f.lab.openCopilot(other.id, { create: true, requestId: 'same' });
    assert.equal(second.parentSessionId, other.controllerSessionId); gate.resolve(); const one = await pending;
    assert.notEqual(one.sessionId, second.sessionId);
    await assert.rejects(f.lab.openCopilot(PROJECT_ID, { sessionId: second.sessionId }), { code: 'copilot_session_not_found' });
    assert.equal(f.store.getProject(PROJECT_ID).activeCopilotSessionId, one.sessionId);
    assert.equal(f.store.getProject(other.id).activeCopilotSessionId, second.sessionId);
    for (const [id, projectId] of [[one.sessionId, PROJECT_ID], [second.sessionId, other.id]]) {
      const tool = f.calls.tools.find((call) => call.id === id).tool;
      const data = JSON.parse((await tool.execute({ action: 'node', nodeId: 'node-x', projectId: 'attacker' })).result);
      assert.equal(data.node.projectId, projectId); assert.equal(tool.parameters.additionalProperties, false);
      assert.equal(tool.parameters.properties.projectId, undefined);
    }
  });

  for (const input of [null, [], true, 'string', { create: false }, { create: 'true' }, { sessionId: 2 }, { sessionId: '' }, { sessionId: 'x'.repeat(201) }, { requestId: 'x' }, { title: 'x' }, { create: true, requestId: 3 }, { create: true, requestId: ' ' }, { create: true, title: 'x'.repeat(121) }, { create: true, sessionId: LEGACY_ID }, { unexpected: true }]) {
    test('bounded typed options reject ' + JSON.stringify(input), async () => {
      const f = fixture(); await assert.rejects(f.lab.openCopilot(PROJECT_ID, input), { code: 'bad_request' });
      assert.equal(f.calls.create.length, 0); assert.equal(f.calls.save.length, 0); assert.equal(f.calls.defaults, 0);
    });
  }

  for (const broken of ['read', 'not-found', 'parent', 'origin', 'cwd', 'preset', 'descriptor', 'inherited-descriptor', 'catalog']) {
    test('ready child ' + broken + ' failure preserves identity/history and never creates a replacement', async () => {
      const f = fixture(); const created = await f.lab.openCopilot(PROJECT_ID);
      const before = f.store.getProject(PROJECT_ID); const session = f.sessions.get(created.sessionId);
      const original = new Error('EACCES existing transcript');
      if (broken === 'read') f.behavior.read = () => { throw original; };
      if (broken === 'not-found') f.sessions.delete(created.sessionId);
      if (broken === 'parent') session.header.parentSession = 'session-foreign-parent';
      if (broken === 'origin') session.header.origin = 'user';
      if (broken === 'cwd') session.header.cwd = 'D:/foreign';
      if (broken === 'preset') session.header.agentPreset = 'foreign';
      if (broken === 'descriptor') session.events[1].data.label = 'mirl-copilot/foreign';
      if (broken === 'inherited-descriptor') session.events.splice(1, 1);
      if (broken === 'catalog') f.sessions.get(created.parentSessionId).events.length = 0;
      await assert.rejects(f.lab.openCopilot(PROJECT_ID), (error) => broken === 'read' ? error === original : true);
      assert.equal(f.calls.create.length, 1); assert.equal(f.calls.resume.length, 0);
      assert.deepEqual(f.store.getProject(PROJECT_ID), before);
    });
  }

  test('reserve storage failure cannot call factory; later retry has only one created Session', async () => {
    let fail = true; const original = new Error('project store unavailable');
    const f = fixture({ behavior: { save() { if (fail) throw original; } } });
    await assert.rejects(f.lab.openCopilot(PROJECT_ID, { create: true, requestId: 'store' }), (error) => error === original);
    assert.equal(f.calls.create.length, 0); assert.deepEqual(f.store.getProject(PROJECT_ID), f.initialProject);
    fail = false; const result = await f.lab.openCopilot(PROJECT_ID, { create: true, requestId: 'store' });
    assert.equal(result.private, true); assert.equal(f.calls.create.length, 1);
  });

  test('factory failure keeps reserved ID/model/request and retries that exact identity after configuration changes', async () => {
    let fail = true; const original = new Error('factory unavailable');
    const f = fixture({ behavior: { create() { if (fail) throw original; } } });
    const input = { create: true, requestId: 'factory', title: 'Preserved' };
    await assert.rejects(f.lab.openCopilot(PROJECT_ID, input), (error) => error === original);
    const saved = f.store.getProject(PROJECT_ID); const reserved = saved.copilotSessions[0];
    assert.equal(reserved.status, 'pending'); assert.equal(reserved.requestId, input.requestId);
    saved.config.models.roles.controller = { provider: 'changed', model: 'changed' }; f.projects.set(PROJECT_ID, saved);
    fail = false; const result = await f.lab.openCopilot(PROJECT_ID, input);
    assert.equal(result.sessionId, reserved.id); assert.equal(result.reused, true);
    assert.deepEqual(f.calls.create.map((spec) => spec.sessionId), [reserved.id, reserved.id]);
    assert.deepEqual(f.calls.create[1].agentOptions, reserved.pendingModel); assert.equal(f.calls.defaults, 1);
  });

  test('pending existing transcript read errors cannot be treated as missing and create fresh', async () => {
    let fail = true; const f = fixture({ behavior: { create() { if (fail) throw new Error('factory unavailable'); } } });
    await assert.rejects(f.lab.openCopilot(PROJECT_ID, { create: true, requestId: 'read' }));
    const reserved = f.store.getProject(PROJECT_ID).copilotSessions[0]; const before = f.store.getProject(PROJECT_ID);
    const original = new Error('read failure'); f.behavior.read = () => { throw original; }; fail = false;
    await assert.rejects(f.lab.openCopilot(PROJECT_ID, { create: true, requestId: 'read' }), (error) => error === original);
    assert.equal(f.calls.create.length, 1); assert.equal(f.store.getProject(PROJECT_ID).copilotSessionId, reserved.id);
    assert.deepEqual(f.store.getProject(PROJECT_ID), before);
  });

  test('dispose failure keeps pending handle/identity and must succeed before catalog/readiness', async () => {
    let fail = true; const original = new Error('dispose persistence flush failed');
    const f = fixture({ behavior: { dispose() { if (fail) throw original; } } });
    const input = { create: true, requestId: 'dispose' };
    await assert.rejects(f.lab.openCopilot(PROJECT_ID, input), (error) => error === original);
    const reserved = f.store.getProject(PROJECT_ID).copilotSessions[0];
    assert.equal(reserved.status, 'pending'); assert.equal(f.agents.has(reserved.id), true);
    assert.equal(f.sessions.get(reserved.parentSessionId).events.length, 0);
    fail = false; const result = await f.lab.openCopilot(PROJECT_ID, input);
    assert.equal(result.sessionId, reserved.id); assert.equal(f.calls.create.length, 1);
    assert.deepEqual(f.calls.dispose, [reserved.id, reserved.id]); assert.equal(f.agents.has(reserved.id), false);
  });

  test('ready-save failure reopens same disposed child and catalog without duplicate create/model/catalog', async () => {
    let fail = true; const original = new Error('ready write unavailable');
    const f = fixture({ behavior: { save(value) { if (fail && value.copilotSessions?.at(-1)?.status === 'ready') throw original; } } });
    const input = { create: true, requestId: 'ready-save' };
    await assert.rejects(f.lab.openCopilot(PROJECT_ID, input), (error) => error === original);
    const reserved = f.store.getProject(PROJECT_ID).copilotSessions[0]; assert.equal(reserved.status, 'pending');
    assert.equal(f.agents.has(reserved.id), false); fail = false;
    const result = await f.lab.openCopilot(PROJECT_ID, input);
    assert.equal(result.sessionId, reserved.id); assert.equal(f.calls.create.length, 1); assert.equal(f.calls.defaults, 1);
    assert.equal(f.sessions.get(result.parentSessionId).events.length, 1);
  });

  test('crash recovery with existing header+descriptor finalizes same reserved identity', async () => {
    let fail = true;
    const f = fixture({ behavior: { afterCreate(_spec, agent) { if (fail) { f.agents.delete(agent.id); throw new Error('crash after durable descriptor'); } } } });
    const input = { create: true, requestId: 'crash' };
    await assert.rejects(f.lab.openCopilot(PROJECT_ID, input));
    const id = f.store.getProject(PROJECT_ID).copilotSessionId;
    fail = false; await f.reload(); const result = await f.lab.openCopilot(PROJECT_ID, input);
    assert.equal(result.sessionId, id); assert.equal(f.calls.create.length, 1); assert.equal(f.calls.defaults, 1);
  });

  test('partial existing child with invalid descriptor never gets overwritten during crash recovery', async () => {
    const f = fixture({ behavior: { afterCreate(_spec, agent) { f.agents.delete(agent.id); agent.session.events.length = 1; throw new Error('partial descriptor'); } } });
    const input = { create: true, requestId: 'bad-partial' }; await assert.rejects(f.lab.openCopilot(PROJECT_ID, input));
    const before = f.store.getProject(PROJECT_ID);
    await f.reload(); await assert.rejects(f.lab.openCopilot(PROJECT_ID, input), { code: 'copilot_session_invalid' });
    assert.deepEqual(f.store.getProject(PROJECT_ID), before); assert.equal(f.calls.create.length, 1);
  });

  test('selection/finalization merges fresh project fields rather than overwriting concurrent unrelated updates', async () => {
    const gate = deferred(); const started = deferred();
    const f = fixture({ behavior: { async dispose() { started.resolve(); await gate.promise; } } });
    const pending = f.lab.openCopilot(PROJECT_ID); await started.promise;
    await f.store.withProjectLock(PROJECT_ID, async () => {
      const current = f.store.getProject(PROJECT_ID); current.name = 'Concurrent rename'; current.revision += 10; current.config.maxNodes = 99; await f.store.saveProject(current);
    });
    gate.resolve(); const result = await pending; const saved = f.store.getProject(PROJECT_ID);
    assert.equal(saved.name, 'Concurrent rename'); assert.equal(saved.config.maxNodes, 99); assert.equal(saved.activeCopilotSessionId, result.sessionId);
    assert.ok(saved.revision >= f.initialProject.revision + 12);
  });

  test('cold fresh Agent gets awaited project-scoped tool once, keeping original model descriptor', async () => {
    const f = fixture(); const result = await f.lab.openCopilot(PROJECT_ID);
    const session = f.sessions.get(result.sessionId); const descriptor = structuredClone(session.events[1].data);
    assert.equal(f.calls.tools.filter((call) => call.id === result.sessionId).length, 1);
    await f.reload();
    const project = f.store.getProject(PROJECT_ID); project.config.models.roles.controller = { provider: 'new', model: 'new' }; f.projects.set(PROJECT_ID, project);
    const defaults = f.calls.defaults; const mounts = f.calls.mount.length;
    const fresh = f.freshAgent(result.sessionId, session); assert.equal(fresh.registeredTools.length, 0);
    await f.announce(fresh); await f.announce(fresh);
    assert.equal(fresh.registeredTools.length, 1); assert.equal(fresh.registeredTools[0].name, 'lab_project_context');
    const data = JSON.parse((await fresh.registeredTools[0].execute({ action: 'node', nodeId: 'cold' })).result);
    assert.equal(data.node.projectId, PROJECT_ID); assert.deepEqual(session.events[1].data, descriptor);
    assert.equal(f.calls.defaults, defaults); assert.equal(f.calls.mount.length, mounts);
    await f.close(); assert.equal(fresh.registeredTools.length, 0, 'Plugin teardown unregisters its exact tool from a still-live cold Agent');
    const afterClose = f.freshAgent(result.sessionId, session); await f.announce(afterClose);
    assert.equal(afterClose.registeredTools.length, 0);
  });

  test('warm native Agent regains its scoped tool on reopen after plugin reload', async () => {
    const f = fixture(); const result = await f.lab.openCopilot(PROJECT_ID);
    const warm = f.freshAgent(result.sessionId, f.sessions.get(result.sessionId));
    f.agents.set(warm.id, warm); await f.announce(warm);
    assert.equal(warm.registeredTools.length, 1);
    await f.reload(); assert.equal(warm.registeredTools.length, 0);
    const creates = f.calls.create.length; const resumes = f.calls.resume.length;
    await f.lab.openCopilot(PROJECT_ID, { sessionId: result.sessionId });
    await f.lab.openCopilot(PROJECT_ID, { sessionId: result.sessionId });
    assert.equal(warm.registeredTools.length, 1, 'Reopen must restore exactly one scoped tool on a surviving native Agent');
    assert.equal(f.calls.create.length, creates); assert.equal(f.calls.resume.length, resumes);
    const data = JSON.parse((await warm.registeredTools[0].execute({ action: 'node', nodeId: 'warm' })).result);
    assert.equal(data.node.projectId, PROJECT_ID);
    await f.close(); assert.equal(warm.registeredTools.length, 0);
  });

  test('warm live identity mismatch cannot borrow the valid durable child tool scope', async () => {
    const f = fixture(); const result = await f.lab.openCopilot(PROJECT_ID);
    const durable = f.sessions.get(result.sessionId);
    const impostor = f.freshAgent(result.sessionId, {
      header: { ...durable.header, parentSession: 'foreign-controller' },
      ownEvents: () => durable.ownEvents(),
    });
    f.agents.set(impostor.id, impostor);
    await assert.rejects(f.lab.openCopilot(PROJECT_ID, { sessionId: result.sessionId }), { code: 'copilot_session_invalid' });
    assert.equal(impostor.registeredTools.length, 0);
    assert.equal(f.calls.create.length, 1); assert.equal(f.calls.resume.length, 0);
  });

  for (const broken of ['parent', 'origin', 'cwd', 'descriptor']) {
    test('cold hook denies ' + broken + ' ownership mismatch without leaking a tool', async () => {
      const f = fixture(); const result = await f.lab.openCopilot(PROJECT_ID); const session = f.sessions.get(result.sessionId);
      if (broken === 'parent') session.header.parentSession = 'foreign-controller';
      if (broken === 'origin') session.header.origin = 'root';
      if (broken === 'cwd') session.header.cwd = 'D:/foreign-project';
      if (broken === 'descriptor') session.events[1].data.label = 'mirl-copilot/prj-foreign';
      const fresh = f.freshAgent(result.sessionId, session);
      await assert.rejects(f.announce(fresh), { code: 'copilot_session_invalid' }); assert.equal(fresh.registeredTools.length, 0);
    });
  }

  test('cold hook rejects cross-project duplicate ownership and skips unrelated label-only Agents', async () => {
    const f = fixture(); const result = await f.lab.openCopilot(PROJECT_ID);
    const other = f.store.getProject(PROJECT_ID); other.id = 'prj-foreign'; f.projects.set(other.id, other);
    const cold = f.freshAgent(result.sessionId, f.sessions.get(result.sessionId));
    await assert.rejects(f.announce(cold), { code: 'copilot_session_invalid' }); assert.equal(cold.registeredTools.length, 0);
    const unrelated = f.freshAgent('session-unrelated', f.makeSession('session-unrelated', { cwd: REPO_PATH, origin: 'subagent', parentSession: result.parentSessionId }, f.sessions.get(result.sessionId).events));
    await f.announce(unrelated); assert.equal(unrelated.registeredTools.length, 0);
  });

  test('unrelated Agent is not blocked by malformed entries in another project catalog', async () => {
    const f = fixture(); const project = f.store.getProject(PROJECT_ID); project.copilotSessions = [null]; f.projects.set(PROJECT_ID, project);
    const agent = f.freshAgent('session-unrelated', f.makeSession('session-unrelated', { cwd: 'D:/unrelated' }));
    await f.announce(agent); assert.equal(agent.registeredTools.length, 0);
    assert.equal(f.calls.create.length, 0); assert.equal(f.calls.save.length, 0);
  });

  test('legacy live roots stay unchanged by cold hook', async () => {
    const f = fixture({ legacy: true, live: true }); const agent = f.agents.get(LEGACY_ID);
    await f.announce(agent); assert.equal(agent.registeredTools.length, 0); assert.equal(f.calls.mount.length, 0);
  });


  for (const broken of ['identity', 'origin', 'cwd']) {
    test('invalid ensured controller ' + broken + ' fails before child factory', async () => {
      const f = fixture({ behavior: { ensure(project) {
        f.makeSession(project.controllerSessionId, { cwd: broken === 'cwd' ? 'D:/foreign-controller' : REPO_PATH, origin: broken === 'origin' ? 'root' : 'subagent', ...(broken === 'identity' ? { id: 'session-foreign-controller' } : {}) });
      } } });
      await assert.rejects(f.lab.openCopilot(PROJECT_ID), { code: 'copilot_session_invalid' });
      assert.equal(f.calls.create.length, 0); assert.equal(f.calls.dispose.length, 0);
      assert.equal(f.store.getProject(PROJECT_ID).copilotSessions[0].status, 'pending');
    });
  }

  test('pending recovery rejects wrong parent-catalog version without claiming readiness', async () => {
    let fail = true;
    const f = fixture({ behavior: { save(value) { if (fail && value.copilotSessions?.at(-1)?.status === 'ready') throw new Error('ready save failed'); } } });
    const input = { create: true, requestId: 'bad-catalog' }; await assert.rejects(f.lab.openCopilot(PROJECT_ID, input));
    const before = f.store.getProject(PROJECT_ID); f.sessions.get(before.controllerSessionId).events[0].data.version = 99;
    fail = false; await assert.rejects(f.lab.openCopilot(PROJECT_ID, input), { code: 'copilot_session_invalid' });
    assert.deepEqual(f.store.getProject(PROJECT_ID), before); assert.equal(f.calls.create.length, 1);
  });

  test('pending recovery rejects durable descriptor that contradicts its reserved model', async () => {
    const f = fixture({ behavior: { afterCreate(_spec, agent) { f.agents.delete(agent.id); throw new Error('crash after descriptor'); } } });
    const input = { create: true, requestId: 'bad-model' }; await assert.rejects(f.lab.openCopilot(PROJECT_ID, input));
    const before = f.store.getProject(PROJECT_ID); const session = f.sessions.get(before.copilotSessionId); session.events[1].data.agentModel = 'unreserved-model';
    await f.reload(); await assert.rejects(f.lab.openCopilot(PROJECT_ID, input), { code: 'copilot_session_invalid' });
    assert.deepEqual(f.store.getProject(PROJECT_ID), before); assert.equal(f.calls.create.length, 1);
    assert.equal(f.sessions.get(before.controllerSessionId).events.length, 0);
  });

  for (const alias of [42, true, {}, '   ']) {
    test('malformed sole legacy alias ' + JSON.stringify(alias) + ' cannot cause an empty replacement', async () => {
      const f = fixture(); const project = f.store.getProject(PROJECT_ID); project.copilotSessionId = alias; f.projects.set(PROJECT_ID, project);
      await assert.rejects(f.lab.openCopilot(PROJECT_ID), { code: 'copilot_session_invalid' });
      assert.deepEqual(f.store.getProject(PROJECT_ID), project); assert.equal(f.calls.create.length, 0); assert.equal(f.calls.save.length, 0);
    });
  }

  test('HTTP command forwards frozen create/switch inputs rather than losing them', async () => {
    const routes = []; const calls = [];
    const ctx = { connection: { fetch: { register(route) { routes.push(route); return () => {}; } } } };
    const service = { async openCopilot(projectId, input) { calls.push([projectId, input]); return { projectId }; } };
    registerHttpRoutes(ctx, service);
    const handler = routes.find((route) => route.path.endsWith('/commands'))?.fetch; assert.equal(typeof handler, 'function');
    for (const body of [{ type: 'project.copilot', projectId: PROJECT_ID, create: true, requestId: 'http-id', title: 'HTTP' }, { type: 'project.copilot', projectId: PROJECT_ID, sessionId: LEGACY_ID }]) {
      const response = await handler(new Request('http://localhost/api/metainfer-research-lab/commands', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
      assert.equal((await response.json()).ok, true);
    }
    assert.deepEqual(calls, [[PROJECT_ID, { create: true, requestId: 'http-id', title: 'HTTP' }], [PROJECT_ID, { sessionId: LEGACY_ID }]]);
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) tests();
