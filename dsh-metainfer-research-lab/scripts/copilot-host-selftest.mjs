/**
 * The original 17 lifecycle scenarios, updated only for the chosen architecture:
 * existing roots retain their IDs/history; new chats are private children;
 * workspace attachment/lookup is now forbidden and operations queue, not coalesce.
 * The shared fixture imports the actual service; no DSH activation/network/model runs.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inject } from '../index.js';
import { fixture, deferred, PROJECT_ID, LEGACY_ID, MODEL } from './copilot-private-selftest.mjs';

function originalHistory(f) { return structuredClone(f.sessions.get(LEGACY_ID).events); }

function assertPreserved(f, history) {
  assert.deepEqual(f.store.getProject(PROJECT_ID), f.initialProject);
  assert.deepEqual(f.sessions.get(LEGACY_ID).events, history);
  assert.equal(f.sessions.size, 1);
  assert.equal(f.calls.create.length, 0);
  assert.equal(f.calls.save.length, 0);
}

function assertLegacy(f, result, history) {
  assert.equal(result.projectId, PROJECT_ID);
  assert.equal(result.sessionId, LEGACY_ID);
  assert.equal(result.activeSessionId, LEGACY_ID);
  assert.equal(result.private, false);
  assert.equal(result.parentSessionId, null);
  assert.equal(result.mode, null);
  assert.equal(result.warning, undefined);
  assert.deepEqual(result.sessions.map((entry) => [entry.id, entry.private]), [[LEGACY_ID, false]]);
  assert.deepEqual(f.sessions.get(LEGACY_ID).events, history);
  assert.equal(f.calls.create.length, 0);
  const saved = f.store.getProject(PROJECT_ID);
  assert.equal(saved.copilotSessionId, LEGACY_ID);
  assert.equal(saved.activeCopilotSessionId, LEGACY_ID);
  assert.deepEqual(saved.chatLog, f.initialProject.chatLog);
}

test('plugin still injects authoritative public services without activation', () => {
  for (const name of ['agents', 'agentPresets', 'sessionQuery', 'sessions']) assert.ok(inject.includes(name));
});

test('resume failure rejects with original cause and never replaces project/session/history', async () => {
  const original = new Error('EACCES: persisted Copilot transcript is temporarily unreadable');
  const f = fixture({ legacy: true, behavior: { resume() { throw original; } } });
  const history = originalHistory(f);
  await assert.rejects(f.lab.openCopilot(PROJECT_ID), (error) => {
    assert.equal(error.code, 'copilot_resume_failed'); assert.equal(error.cause, original);
    assert.ok(error.message.includes(LEGACY_ID)); assert.ok(error.message.includes(original.message));
    assert.match(error.message, /retry/i); assert.match(error.message, /preserv/i);
    return true;
  });
  assert.equal(f.calls.resume.length, 1); assert.equal(f.calls.resume[0].resumeSessionId, LEGACY_ID);
  assertPreserved(f, history);
});

test('concurrent failed opens are queued individually and release the queue for a same-ID retry', async () => {
  const gate = deferred(); const started = deferred(); const original = new Error('temporary resume failure');
  let failing = true;
  const f = fixture({ legacy: true, behavior: { async resume() { if (failing) { started.resolve(); await gate.promise; } } } });
  const history = originalHistory(f); const first = f.lab.openCopilot(PROJECT_ID); const second = f.lab.openCopilot(PROJECT_ID);
  await started.promise; assert.equal(f.calls.resume.length, 1); gate.reject(original);
  const settled = await Promise.allSettled([first, second]);
  assert.deepEqual(settled.map((result) => result.status), ['rejected', 'rejected']);
  for (const result of settled) assert.equal(result.reason.cause, original);
  assert.equal(f.calls.resume.length, 2); assertPreserved(f, history);
  failing = false; const result = await f.lab.openCopilot(PROJECT_ID);
  assert.equal(result.reused, true); assertLegacy(f, result, history);
  assert.deepEqual(f.calls.resume.map((spec) => spec.resumeSessionId), [LEGACY_ID, LEGACY_ID, LEGACY_ID]);
});

test('live existing root keeps ID/history/composition, only normalizing project selection', async () => {
  const f = fixture({ legacy: true, live: true }); const history = originalHistory(f);
  const result = await f.lab.openCopilot(PROJECT_ID); assert.equal(result.reused, true); assertLegacy(f, result, history);
  assert.equal(f.calls.resume.length, 0); assert.equal(f.calls.tools.length, 0); assert.equal(f.calls.mount.length, 0);
  assert.equal(f.calls.save.length, 1);
});

test('successful legacy resume keeps ID/history/model/setup and caches handle without workspace mutations', async () => {
  const f = fixture({ legacy: true }); const history = originalHistory(f);
  const result = await f.lab.openCopilot(PROJECT_ID); assert.equal(result.reused, true); assertLegacy(f, result, history);
  assert.deepEqual(f.calls.resume[0].agentOptions, { ...MODEL, source: 'project-role' });
  assert.deepEqual(f.calls.mount, ['lab-chat']); assert.equal(f.calls.tools.length, 1);
  assert.equal(f.calls.tools[0].tool.name, 'lab_project_context'); assert.deepEqual(f.calls.tools[0].tool.parameters.required, ['action']);
  const again = await f.lab.openCopilot(PROJECT_ID); assert.equal(again.reused, true); assertLegacy(f, again, history);
  assert.equal(f.calls.resume.length, 1); assert.equal(f.calls.save.length, 1);
});

test('fresh default opens serialize to one private child, reserve identity and await disposal', async () => {
  const disposing = deferred(); const started = deferred();
  const f = fixture({ behavior: { async dispose(id) { assert.equal(f.store.getProject(PROJECT_ID).copilotSessionId, id); started.resolve(); await disposing.promise; } } });
  let completed = false;
  const first = f.lab.openCopilot(PROJECT_ID).then((result) => { completed = true; return result; });
  const second = f.lab.openCopilot(PROJECT_ID); await started.promise;
  assert.equal(completed, false); assert.equal(f.calls.create.length, 1); assert.equal(f.store.getProject(PROJECT_ID).copilotSessions[0].status, 'pending');
  disposing.resolve(); const [result, concurrent] = await Promise.all([first, second]);
  assert.equal(result.reused, false); assert.equal(concurrent.reused, true); assert.equal(concurrent.sessionId, result.sessionId);
  assert.equal(result.private, true); assert.equal(result.parentSessionId, f.initialProject.controllerSessionId);
  assert.equal(f.calls.create.length, 1); assert.equal(f.calls.resume.length, 0);
  assert.deepEqual(f.store.getProject(PROJECT_ID).chatLog, f.initialProject.chatLog);
});

for (const registry of ['absent', 'missing']) {
  for (const mode of ['live', 'resumed', 'fresh']) {
    test(mode + ' Copilot is independent of ' + registry + ' workspace registry/match', async () => {
      const f = fixture({ legacy: mode !== 'fresh', live: mode === 'live' });
      if (registry === 'absent') delete f.ctx.workspaceRegistry;
      else f.ctx.workspaceRegistry.resolveByPath = () => assert.fail('Workspace lookup is forbidden, even if no matching workspace exists');
      const history = mode === 'fresh' ? null : originalHistory(f); const result = await f.lab.openCopilot(PROJECT_ID);
      assert.equal(result.projectId, PROJECT_ID); assert.equal(result.sessionId, f.store.getProject(PROJECT_ID).copilotSessionId);
      assert.equal(result.warning, undefined);
      if (mode !== 'fresh') assertLegacy(f, result, history);
      else { assert.equal(result.private, true); assert.equal(f.calls.create.length, 1); }
    });
  }
}

for (const mode of ['live', 'resumed', 'fresh']) {
  test(mode + ' never consults failing workspace attachment and reopens same ID without a new agent', async () => {
    const f = fixture({ legacy: mode !== 'fresh', live: mode === 'live' });
    let calls = 0;
    f.ctx.workspaceRegistry.resolveByPath = () => { calls++; throw new Error('workspace metadata is temporarily read-only'); };
    f.ctx.workspaceRegistry.attachSession = () => { calls++; throw new Error('attachment forbidden'); };
    const result = await f.lab.openCopilot(PROJECT_ID); const again = await f.lab.openCopilot(PROJECT_ID);
    assert.equal(again.sessionId, result.sessionId); assert.equal(again.reused, true); assert.equal(calls, 0);
    assert.equal(f.calls.create.length, mode === 'fresh' ? 1 : 0); assert.equal(f.calls.resume.length, mode === 'resumed' ? 1 : 0);
  });
}

test('workspace lookup cannot fail or replace a live legacy root because it is never called', async () => {
  const f = fixture({ legacy: true, live: true }); const history = originalHistory(f); let lookups = 0;
  f.ctx.workspaceRegistry.resolveByPath = () => { lookups++; throw new Error('cannot read workspace registry'); };
  const result = await f.lab.openCopilot(PROJECT_ID); assertLegacy(f, result, history); assert.equal(lookups, 0);
});

test('fresh factory failure retains reserved identity and retries same child/model rather than a clean new ID', async () => {
  const original = new Error('fake create failed'); let failing = true;
  const f = fixture({ behavior: { create() { if (failing) throw original; } } });
  await assert.rejects(f.lab.openCopilot(PROJECT_ID), (error) => error === original);
  const reserved = f.store.getProject(PROJECT_ID).copilotSessions[0]; assert.equal(reserved.status, 'pending'); assert.equal(f.calls.save.length, 1);
  assert.deepEqual(f.store.getProject(PROJECT_ID).chatLog, f.initialProject.chatLog);
  failing = false; const result = await f.lab.openCopilot(PROJECT_ID);
  assert.equal(result.sessionId, reserved.id); assert.equal(result.reused, true);
  assert.deepEqual(f.calls.create.map((spec) => spec.sessionId), [reserved.id, reserved.id]);
  assert.equal(f.calls.defaults, 1); assert.equal(f.calls.save.length, 2);
});
