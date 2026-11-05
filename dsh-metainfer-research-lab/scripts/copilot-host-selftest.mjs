/**
 * Isolated Copilot lifecycle regressions: in-memory store/agents/workspaces.
 * No DSH activation, network, git operations, or model runs.
 * Run from the plugin directory: `node scripts/copilot-host-selftest.mjs`.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLabService } from '../host/lab-service.js';
import { inject } from '../index.js';

const PROJECT_ID = 'prj-copilot-test';
const SESSION_ID = 'session-existing-copilot';
const REPO_PATH = 'D:/projects/existing-research';
const MODEL = { provider: 'fake-provider', model: 'fake-controller', reasoningEffort: 'high' };

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture({ existingId = SESSION_ID, live = false, registry = 'present', behavior = {} } = {}) {
  const initialProject = {
    id: PROJECT_ID,
    repo: { path: REPO_PATH },
    config: { models: { roles: { controller: MODEL } } },
    revision: 7,
    updatedAt: 123,
    chatLog: [{ role: 'user', text: 'Keep this project history', at: 100 }],
    ...(existingId ? { copilotSessionId: existingId } : {}),
  };
  const projects = new Map([[PROJECT_ID, structuredClone(initialProject)]]);
  const history = new Map([[SESSION_ID, ['previous native turn', 'previous tool result']]]);
  const calls = { get: [], resume: [], create: [], save: [], resolve: [], attach: [], mount: [], tools: [] };
  const handles = new Map();
  if (live) handles.set(existingId, { id: existingId });
  const store = {
    getProject: (id) => structuredClone(projects.get(id)),
    saveProject: async (project) => {
      calls.save.push(structuredClone(project));
      projects.set(project.id, structuredClone(project));
    },
    withProjectLock: async (_id, task) => task(),
  };
  async function setup(spec) {
    assert.equal(typeof spec.setup, 'function');
    await spec.setup({ tools: { register: (tool) => calls.tools.push(tool) } });
  }
  const workspace = {
    id: 'workspace-existing-project',
    async attachSession(id) {
      calls.attach.push(id);
      await behavior.attach?.(id);
    },
  };
  const ctx = {
    agents: {
      get(id) { calls.get.push(id); return handles.get(id); },
      async resume(spec) {
        calls.resume.push(spec);
        await behavior.resume?.(spec);
        await setup(spec);
        // No agents.get entry: subsequent opens must exercise the service cache.
        return { id: spec.resumeSessionId };
      },
      async create(spec) {
        calls.create.push(spec);
        await behavior.create?.(spec);
        await setup(spec);
        history.set(spec.sessionId, []);
        return { id: spec.sessionId };
      },
    },
    agentPresets: { async mount(_agentCtx, preset) { calls.mount.push(preset); } },
    ...(registry === 'absent' ? {} : {
      workspaceRegistry: {
        async resolveByPath(repoPath) {
          calls.resolve.push(repoPath);
          await behavior.resolve?.(repoPath);
          return registry === 'missing' ? undefined : workspace;
        },
        create() { assert.fail('Copilot must not create a workspace'); },
      },
    }),
  };
  const lab = createLabService({ ctx, store });
  return { lab, ctx, store, calls, history, initialProject, workspace };
}

function assertPreserved(f) {
  assert.deepEqual(f.store.getProject(PROJECT_ID), f.initialProject);
  assert.deepEqual(f.history.get(SESSION_ID), ['previous native turn', 'previous tool result']);
  assert.equal(f.history.size, 1);
  assert.equal(f.calls.create.length, 0);
  assert.equal(f.calls.save.length, 0);
}

function assertSetup(f, spec) {
  assert.deepEqual(spec.agentOptions, { ...MODEL, source: 'project-role' });
  assert.deepEqual(f.calls.mount, ['lab-chat']);
  assert.equal(f.calls.tools.length, 1);
  assert.equal(f.calls.tools[0].name, 'lab_project_context');
  assert.deepEqual(f.calls.tools[0].parameters.required, ['action']);
}

function assertAssociated(f, result, sessionId = SESSION_ID) {
  assert.equal(result.projectId, PROJECT_ID);
  assert.equal(result.sessionId, sessionId);
  assert.equal(result.workspaceId, f.workspace.id);
  assert.equal(result.warning, undefined);
  assert.deepEqual(f.calls.resolve, [REPO_PATH]);
  assert.deepEqual(f.calls.attach, [sessionId]);
}

test('plugin injects the public authoritative workspace registry', () => {
  assert.ok(inject.includes('workspaceRegistry'));
});

test('resume failure rejects with original cause and never replaces project/session/history', async () => {
  const original = new Error('EACCES: persisted Copilot transcript is temporarily unreadable');
  const f = fixture({ behavior: { resume() { throw original; } } });
  await assert.rejects(f.lab.openCopilot(PROJECT_ID), (error) => {
    assert.equal(error.code, 'copilot_resume_failed');
    assert.equal(error.cause, original);
    assert.ok(error.message.includes(SESSION_ID));
    assert.ok(error.message.includes(original.message));
    assert.match(error.message, /retry/i);
    assert.match(error.message, /preserv/i);
    return true;
  });
  assert.equal(f.calls.resume.length, 1);
  assert.equal(f.calls.resume[0].resumeSessionId, SESSION_ID);
  assertPreserved(f);
});

test('concurrent failed opens share one resume and release the lock for a same-ID retry', async () => {
  const gate = deferred();
  const original = new Error('temporary resume failure');
  let failing = true;
  const f = fixture({ behavior: { async resume() { if (failing) await gate.promise; } } });
  const first = f.lab.openCopilot(PROJECT_ID);
  const second = f.lab.openCopilot(PROJECT_ID);
  assert.equal(f.calls.resume.length, 1);
  gate.reject(original);
  const settled = await Promise.allSettled([first, second]);
  assert.deepEqual(settled.map((result) => result.status), ['rejected', 'rejected']);
  for (const result of settled) assert.equal(result.reason.cause, original);
  assertPreserved(f);
  failing = false;
  const result = await f.lab.openCopilot(PROJECT_ID);
  assert.equal(result.reused, true);
  assertAssociated(f, result);
  assert.deepEqual(f.calls.resume.map((spec) => spec.resumeSessionId), [SESSION_ID, SESSION_ID]);
  assertPreserved(f);
});

test('live existing handle is associated without resume/create or project mutation', async () => {
  const f = fixture({ live: true });
  const result = await f.lab.openCopilot(PROJECT_ID);
  assert.equal(result.reused, true);
  assertAssociated(f, result);
  assert.equal(f.calls.resume.length, 0);
  assert.equal(f.calls.tools.length, 0);
  assertPreserved(f);
});

test('successful resume keeps ID/history/model/setup and cached handle is associated again', async () => {
  const f = fixture();
  const result = await f.lab.openCopilot(PROJECT_ID);
  assert.equal(result.reused, true);
  assertAssociated(f, result);
  assertSetup(f, f.calls.resume[0]);
  const again = await f.lab.openCopilot(PROJECT_ID);
  assert.equal(again.sessionId, SESSION_ID);
  assert.equal(again.reused, true);
  assert.equal(f.calls.resume.length, 1);
  assert.deepEqual(f.calls.attach, [SESSION_ID, SESSION_ID]);
  assertPreserved(f);
});

test('fresh creation remains single-flight, saves identity, and awaits workspace attachment', async () => {
  const creating = deferred();
  const attaching = deferred();
  const attachStarted = deferred();
  const f = fixture({
    existingId: '',
    behavior: {
      async create() { await creating.promise; },
      async attach(id) {
        assert.equal(f.store.getProject(PROJECT_ID).copilotSessionId, id);
        attachStarted.resolve();
        await attaching.promise;
      },
    },
  });
  let completed = false;
  const first = f.lab.openCopilot(PROJECT_ID).then((result) => { completed = true; return result; });
  const second = f.lab.openCopilot(PROJECT_ID);
  assert.equal(f.calls.create.length, 1);
  creating.resolve();
  await Promise.race([
    attachStarted.promise,
    first.then(() => { throw new Error('Copilot opened without awaiting workspace attachment'); }),
  ]);
  assert.equal(completed, false);
  attaching.resolve();
  const [result, concurrent] = await Promise.all([first, second]);
  assert.deepEqual(concurrent, result);
  assert.equal(result.reused, false);
  assert.match(result.sessionId, /^session-/);
  assertAssociated(f, result, result.sessionId);
  assertSetup(f, f.calls.create[0]);
  assert.deepEqual(f.calls.create[0].meta, { cwd: REPO_PATH, agentPreset: 'lab-chat' });
  const saved = f.store.getProject(PROJECT_ID);
  assert.equal(saved.id, PROJECT_ID);
  assert.equal(saved.copilotSessionId, result.sessionId);
  assert.equal(saved.revision, f.initialProject.revision + 1);
  assert.deepEqual(saved.chatLog, f.initialProject.chatLog);
  assert.equal(f.calls.save.length, 1);
  assert.equal(f.calls.resume.length, 0);
  const again = await f.lab.openCopilot(PROJECT_ID);
  assert.equal(again.sessionId, result.sessionId);
  assert.equal(again.reused, true);
  assert.equal(f.calls.create.length, 1);
});

for (const registry of ['absent', 'missing']) {
  for (const mode of ['live', 'resumed', 'fresh']) {
    test(`${mode} Copilot stays embeddable and reports ${registry} workspace registry/match`, async () => {
      const f = fixture({ registry, live: mode === 'live', existingId: mode === 'fresh' ? '' : SESSION_ID });
      const result = await f.lab.openCopilot(PROJECT_ID);
      assert.equal(result.workspaceId, null);
      assert.equal(typeof result.warning, 'string');
      assert.match(result.warning, registry === 'absent' ? /registry.*unavailable/i : /no registered workspace/i);
      assert.equal(result.projectId, PROJECT_ID);
      assert.equal(result.sessionId, f.store.getProject(PROJECT_ID).copilotSessionId);
      assert.equal(f.calls.attach.length, 0);
      assert.deepEqual(f.calls.resolve, registry === 'absent' ? [] : [REPO_PATH]);
      if (mode !== 'fresh') assertPreserved(f);
      else assert.equal(f.calls.create.length, 1);
    });
  }
}

for (const mode of ['live', 'resumed', 'fresh']) {
  test(`${mode} attach failure surfaces original cause, retains ID, and retries without new agent`, async () => {
    const original = new Error('workspace metadata is temporarily read-only');
    let failing = true;
    const f = fixture({
      live: mode === 'live',
      existingId: mode === 'fresh' ? '' : SESSION_ID,
      behavior: { attach() { if (failing) throw original; } },
    });
    await assert.rejects(f.lab.openCopilot(PROJECT_ID), (error) => {
      assert.equal(error.code, 'copilot_workspace_attach_failed');
      assert.equal(error.cause, original);
      assert.ok(error.message.includes(f.workspace.id));
      assert.ok(error.message.includes(f.store.getProject(PROJECT_ID).copilotSessionId));
      assert.ok(error.message.includes(original.message));
      assert.match(error.message, /retry/i);
      return true;
    });
    const preservedId = f.store.getProject(PROJECT_ID).copilotSessionId;
    if (mode !== 'fresh') assertPreserved(f);
    else assert.equal(f.calls.create.length, 1);
    failing = false;
    const result = await f.lab.openCopilot(PROJECT_ID);
    assert.equal(result.sessionId, preservedId);
    assert.equal(result.reused, true);
    assert.deepEqual(f.calls.attach, [preservedId, preservedId]);
    assert.equal(f.calls.create.length, mode === 'fresh' ? 1 : 0);
    assert.equal(f.calls.resume.length, mode === 'resumed' ? 1 : 0);
  });
}

test('workspace lookup failure is not mistaken for absence or replacement reason', async () => {
  const original = new Error('cannot read workspace registry');
  const f = fixture({ live: true, behavior: { resolve() { throw original; } } });
  await assert.rejects(f.lab.openCopilot(PROJECT_ID), (error) => error === original || error.cause === original);
  assertPreserved(f);
  assert.equal(f.calls.attach.length, 0);
});

test('fresh creation failure leaves no ID and releases lock for a clean retry', async () => {
  const original = new Error('fake create failed');
  let failing = true;
  const f = fixture({ existingId: '', behavior: { create() { if (failing) throw original; } } });
  await assert.rejects(f.lab.openCopilot(PROJECT_ID), (error) => error === original);
  assert.deepEqual(f.store.getProject(PROJECT_ID), f.initialProject);
  assert.equal(f.calls.save.length, 0);
  failing = false;
  const result = await f.lab.openCopilot(PROJECT_ID);
  assert.equal(result.reused, false);
  assert.equal(f.calls.create.length, 2);
  assert.equal(f.calls.save.length, 1);
});
