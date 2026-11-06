/** Project Copilot identities live in project metadata; transcripts live only in DSH Sessions. */
import path from 'node:path';
import { LabError } from './git-engine.js';
import { resolveModelSelection } from './models.js';
import { newSessionId } from './store.js';

const PRESET = 'lab-chat';
const labelOf = (project) => `mirl-copilot/${project.id}`;
const failure = (message) => new LabError('copilot_session_invalid', message, 409);

function optionsOf(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new LabError('bad_request', 'Copilot options must be an object', 400);
  for (const key of Object.keys(input)) {
    if (!['sessionId', 'create', 'requestId', 'title'].includes(key)) throw new LabError('bad_request', `unknown Copilot option: ${key}`, 400);
  }
  const out = {};
  for (const [key, max] of [['sessionId', 200], ['requestId', 200], ['title', 120]]) {
    if (input[key] === undefined) continue;
    if (typeof input[key] !== 'string' || !input[key].trim() || input[key].trim().length > max) {
      throw new LabError('bad_request', `${key} must be a nonempty string of at most ${max} characters`, 400);
    }
    out[key] = input[key].trim();
  }
  if (input.create !== undefined && input.create !== true) throw new LabError('bad_request', 'create must be true when supplied', 400);
  if (input.create === true) out.create = true;
  if (out.sessionId && out.create) throw new LabError('bad_request', 'sessionId and create are mutually exclusive', 400);
  if (!out.create && (out.requestId || out.title)) throw new LabError('bad_request', 'requestId and title require create', 400);
  return out;
}

function catalogOf(project) {
  if (project.copilotSessions !== undefined && !Array.isArray(project.copilotSessions)) throw failure('Copilot catalog is unreadable; existing sessions are preserved.');
  if (project.copilotSessions === undefined && project.copilotSessionId != null && project.copilotSessionId !== ''
    && (typeof project.copilotSessionId !== 'string' || !project.copilotSessionId.trim())) throw failure('The existing legacy Copilot identity is invalid; it is preserved.');
  const entries = structuredClone(project.copilotSessions ?? []);
  const seen = new Set();
  for (const [index, entry] of entries.entries()) {
    if (!entry || typeof entry.id !== 'string' || !entry.id || seen.has(entry.id)) throw failure('Copilot catalog contains an invalid or duplicate identity.');
    seen.add(entry.id);
    if (entry.private !== undefined && typeof entry.private !== 'boolean') throw failure(`Invalid privacy metadata for Copilot session "${entry.id}".`);
    entry.private ??= false;
    entry.title = typeof entry.title === 'string' && entry.title.trim() ? entry.title : `Copilot ${index + 1}`;
    entry.createdAt ??= project.createdAt ?? 0;
    entry.updatedAt ??= entry.createdAt;
  }
  // The old sole alias remains an accessible legacy root, never a cloned child.
  if (project.copilotSessions === undefined && typeof project.copilotSessionId === 'string' && project.copilotSessionId) {
    entries.push({ id: project.copilotSessionId, title: `Copilot ${entries.length + 1}`, createdAt: project.createdAt ?? 0, updatedAt: project.updatedAt ?? 0, private: false });
  }
  const active = project.activeCopilotSessionId ?? (entries.some((entry) => entry.id === project.copilotSessionId) ? project.copilotSessionId : entries.at(-1)?.id) ?? null;
  if (active !== null && !entries.some((entry) => entry.id === active)) throw failure(`Active Copilot session "${active}" is not in the project catalog.`);
  return { entries, active };
}

function publicEntry(entry) {
  return {
    id: entry.id, title: entry.title, createdAt: entry.createdAt, updatedAt: entry.updatedAt, private: entry.private,
    ...(entry.private ? { parentSessionId: entry.parentSessionId, mode: 'continuable' } : {}),
  };
}

function summary(project) {
  const { entries, active } = catalogOf(project);
  const entry = entries.find((item) => item.id === active);
  return {
    projectId: project.id, sessionId: active, activeSessionId: active,
    private: entry?.private ?? false, parentSessionId: entry?.private ? entry.parentSessionId : null,
    mode: entry?.private ? 'continuable' : null, sessions: entries.map(publicEntry),
  };
}

function descriptorOf(project, model) {
  return {
    version: 3, mode: 'continuable', provider: 'spawn', label: labelOf(project),
    ...(model.provider ? { agentProvider: model.provider } : {}),
    ...(model.model ? { agentModel: model.model } : {}),
    ...(model.reasoningEffort ? { agentReasoningEffort: model.reasoningEffort } : {}),
  };
}

function samePath(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const normalize = (value) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  return normalize(a) === normalize(b);
}

function validatePrivate(project, entry, snapshot) {
  const header = snapshot?.session;
  if (!header || header.id !== entry.id || header.origin !== 'subagent'
    || !project.controllerSessionId || entry.parentSessionId !== project.controllerSessionId
    || header.parentSession !== project.controllerSessionId || !samePath(header.cwd, project.repo.path)
    || header.agentPreset !== PRESET) throw failure(`Copilot session "${entry.id}" has an unexpected header, parent or project path; it is preserved.`);
  if (!Array.isArray(snapshot.events) || !Number.isSafeInteger(snapshot.inheritedEventCount ?? 0)
    || (snapshot.inheritedEventCount ?? 0) < 0 || (snapshot.inheritedEventCount ?? 0) > snapshot.events.length) throw failure(`Copilot session "${entry.id}" has an unreadable event log.`);
  const events = snapshot.events.slice(snapshot.inheritedEventCount ?? 0);
  const index = events.findIndex((event) => event.type === 'subagent/descriptor');
  const descriptor = events[index]?.data;
  const preset = events.slice(0, index).filter((event) => event.type === 'agent-preset/selected').at(-1)?.data?.agentPreset;
  if (index < 0 || descriptor?.version !== 3 || descriptor.mode !== 'continuable' || descriptor.provider !== 'spawn'
    || descriptor.label !== labelOf(project) || preset !== PRESET
    || events.filter((event) => event.type === 'subagent/descriptor').length !== 1
    || ['agentProvider', 'agentModel', 'agentReasoningEffort'].some((key) => descriptor[key] !== undefined && (typeof descriptor[key] !== 'string' || !descriptor[key]))) {
    throw failure(`Copilot session "${entry.id}" has an invalid own continuable descriptor; it is preserved.`);
  }
  if (entry.status === 'pending') {
    if (!entry.pendingModel || typeof entry.pendingModel !== 'object') throw failure(`Pending Copilot session "${entry.id}" has no reserved model.`);
    const reserved = descriptorOf(project, entry.pendingModel);
    if (['agentProvider', 'agentModel', 'agentReasoningEffort'].some((key) => descriptor[key] !== reserved[key])) {
      throw failure(`Pending Copilot session "${entry.id}" contradicts its reserved model; it is preserved.`);
    }
  }
  return { header, descriptor };
}

export function createCopilotService({ ctx, store, orchestrator, requireProject, toolDefinition }) {
  const queues = new Map();
  const legacyHandles = new Map();
  const pendingHandles = new Map();
  const scopedAgents = new WeakSet();

  function queued(projectId, task) {
    const run = (queues.get(projectId) ?? Promise.resolve()).then(task);
    const tail = run.then(() => undefined, () => undefined);
    queues.set(projectId, tail);
    return run.finally(() => { if (queues.get(projectId) === tail) queues.delete(projectId); });
  }

  async function mutate(projectId, update) {
    return store.withProjectLock(projectId, async () => {
      const current = structuredClone(requireProject(projectId));
      const catalog = catalogOf(current);
      update(catalog, current);
      current.copilotSessions = catalog.entries;
      current.activeCopilotSessionId = catalog.active;
      current.copilotSessionId = catalog.active;
      current.revision = (current.revision ?? 0) + 1;
      current.updatedAt = Date.now();
      await store.saveProject(current);
      return current;
    });
  }

  function registerTool(projectId, agentCtx, agent) {
    if (agent && scopedAgents.has(agent)) return;
    const setup = () => agentCtx.tools.register(toolDefinition(projectId));
    if (typeof ctx.effect === 'function') ctx.effect(setup, 'metainfer-research-lab: scoped copilot tool');
    else setup();
    if (agent) scopedAgents.add(agent);
  }

  // Native cold resume restores composition/model, not our original setup closure.
  // The registry awaits this listener before the fresh Agent can accept a turn.
  async function onAgentCreated({ agent }) {
    if (!agent || scopedAgents.has(agent)) return;
    const owners = store.listProjects().filter((project) => (
      Array.isArray(project.copilotSessions) && project.copilotSessions.some((entry) => entry?.id === agent.id && entry.private === true)
    ));
    if (!owners.length) return; // Includes old live roots: do not change their composition.
    if (owners.length !== 1) throw failure(`Copilot session "${agent.id}" belongs to more than one project.`);
    const project = owners[0];
    const entry = catalogOf(project).entries.find((item) => item.id === agent.id);
    validatePrivate(project, entry, { session: agent.session?.header, events: agent.session?.ownEvents(), inheritedEventCount: 0 });
    if (!agent.ctx?.tools) throw failure(`Copilot session "${agent.id}" has no scoped tool context.`);
    registerTool(project.id, agent.ctx, agent);
  }

  function bind() {
    const off = typeof ctx.on === 'function' ? ctx.on('agent/created', onAgentCreated) : undefined;
    return async () => {
      off?.();
      for (const handle of [...legacyHandles.values(), ...pendingHandles.values()]) {
        try { await handle.dispose?.(); } catch { /* Best-effort plugin teardown, not an open/create acknowledgement. */ }
      }
      legacyHandles.clear();
      pendingHandles.clear();
    };
  }
  if (typeof ctx.effect === 'function') ctx.effect(bind, 'metainfer-research-lab: copilot sessions and cold tools');

  async function openLegacy(project, entry) {
    if (legacyHandles.has(entry.id) || ctx.agents.get(entry.id)) return;
    try {
      const handle = await ctx.agents.resume({
        resumeSessionId: entry.id,
        agentOptions: resolveModelSelection(ctx, project, null, 'controller'),
        async setup(agentCtx, agent) {
          await ctx.agentPresets.mount(agentCtx, PRESET);
          registerTool(project.id, agentCtx, agent);
        },
      });
      legacyHandles.set(entry.id, handle);
    } catch (error) {
      const wrapped = new LabError('copilot_resume_failed', `Could not resume Copilot session "${entry.id}" for project "${project.id}": ${error instanceof Error ? error.message : String(error)}. The existing session is preserved; resolve the resume error and retry.`, 503);
      wrapped.cause = error;
      throw wrapped;
    }
  }

  async function readPrivate(project, entry, allowMissing = false) {
    try {
      const snapshot = await ctx.sessionQuery.readSession(entry.id);
      return validatePrivate(project, entry, snapshot);
    } catch (error) {
      if (allowMissing && error?.code === 'SESSION_QUERY_SESSION_NOT_FOUND') return null;
      throw error;
    }
  }

  function controllerOf(project, entry) {
    const parent = ctx.sessions.get(entry.parentSessionId);
    if (!parent || parent.header.id !== project.controllerSessionId || parent.header.origin !== 'subagent'
      || !samePath(parent.header.cwd, project.repo.path)) throw failure(`Copilot controller "${entry.parentSessionId}" is unavailable or invalid.`);
    return parent;
  }

  async function readyPrivate(project, entry) {
    let durable = await readPrivate(project, entry, entry.status === 'pending');
    await orchestrator.ensureController(project);
    controllerOf(project, entry); // Validate the hidden parent before any child factory.
    if (entry.status !== 'pending') {
      // Native Manager, not a competing regular Agent, resumes ready children.
      const parent = controllerOf(project, entry);
      const catalog = parent.ownEvents().filter((event) => event.type === 'subagent/catalog' && event.data?.childId === entry.id);
      if (!catalog.length || catalog.some((event) => event.data.version !== 0 || event.data.mode !== 'continuable'
        || event.data.label !== labelOf(project) || event.data.childCreatedAt !== durable.header.createdAt)) {
        throw failure(`Copilot parent catalog for "${entry.id}" is missing or invalid.`);
      }
      // A native Agent can survive plugin reload after the old tool disposer ran.
      const live = ctx.agents.get(entry.id);
      if (live) await onAgentCreated({ agent: live });
      return;
    }
    if (!durable) {
      if (!entry.pendingModel || typeof entry.pendingModel !== 'object') throw failure(`Pending Copilot session "${entry.id}" has no reserved model.`);
      const handle = await ctx.agents.create({
        sessionId: entry.id,
        meta: { cwd: project.repo.path, origin: 'subagent', parentSession: entry.parentSessionId, delegationDepth: 1, agentPreset: PRESET },
        agentOptions: entry.pendingModel,
        async setup(agentCtx, agent) {
          await ctx.agentPresets.mount(agentCtx, PRESET);
          agent.session.append('agent-preset/selected', { agentPreset: PRESET });
          agent.session.append('subagent/descriptor', descriptorOf(project, entry.pendingModel));
          validatePrivate(project, entry, { session: agent.session.header, events: agent.session.ownEvents(), inheritedEventCount: 0 });
          registerTool(project.id, agentCtx, agent);
        },
      });
      pendingHandles.set(entry.id, handle);
      durable = await readPrivate(project, entry);
    }
    // Keep the creating handle until disposal really succeeds so retries never
    // announce readiness while the initial regular Agent still competes with Manager.
    const handle = pendingHandles.get(entry.id);
    if (handle) {
      await handle.dispose();
      pendingHandles.delete(entry.id);
    } else if (ctx.agents.get(entry.id)) {
      throw failure(`Pending Copilot session "${entry.id}" is still live; retry after its creation has disposed.`);
    }
    const parent = controllerOf(project, entry);
    const catalog = parent.ownEvents().filter((event) => event.type === 'subagent/catalog' && event.data?.childId === entry.id);
    if (catalog.some((event) => event.data.version !== 0 || event.data.mode !== 'continuable' || event.data.label !== labelOf(project)
      || event.data.childCreatedAt !== durable.header.createdAt)) throw failure(`Copilot parent catalog for "${entry.id}" is invalid.`);
    if (!catalog.length) parent.append('subagent/catalog', { version: 0, childId: entry.id, childCreatedAt: durable.header.createdAt, mode: 'continuable', label: labelOf(project) });
    await mutate(project.id, ({ entries }) => {
      const saved = entries.find((item) => item.id === entry.id);
      saved.status = 'ready';
      delete saved.pendingModel;
    });
  }

  async function openCopilot(projectId, input = {}) {
    const options = optionsOf(input);
    return queued(projectId, async () => {
      let project = requireProject(projectId);
      let { entries, active } = catalogOf(project);
      let entry;
      let created = false;
      if (options.sessionId) {
        entry = entries.find((item) => item.id === options.sessionId);
        if (!entry) throw new LabError('copilot_session_not_found', `Unknown Copilot session "${options.sessionId}" for project "${projectId}".`, 404);
      } else if (options.create) {
        entry = options.requestId
          ? entries.find((item) => item.requestId === options.requestId)
          : entries.find((item) => item.status === 'pending' && !item.requestId && item.requestTitle === options.title);
        if (entry && entry.requestTitle !== options.title) throw new LabError('copilot_request_conflict', 'This Copilot requestId already belongs to a different title.', 409);
      } else {
        entry = entries.find((item) => item.id === active);
      }
      if (!entry) {
        if (!project.controllerSessionId) throw failure('The project has no Copilot controller identity.');
        entry = {
          id: newSessionId(), title: options.title ?? `Copilot ${entries.length + 1}`,
          createdAt: Date.now(), updatedAt: Date.now(), private: true,
          parentSessionId: project.controllerSessionId, mode: 'continuable', status: 'pending',
          ...(options.requestId ? { requestId: options.requestId } : {}),
          ...(options.title ? { requestTitle: options.title } : {}),
          pendingModel: resolveModelSelection(ctx, project, null, 'controller'),
        };
        project = await mutate(projectId, (catalog) => { catalog.entries.push(entry); catalog.active = entry.id; });
        created = true;
      }
      if (entry.private) await readyPrivate(project, entry);
      else await openLegacy(project, entry);
      // Re-read under the store lock: selection cannot clobber an unrelated edit
      // that happened while Session creation/disposal or root resume was awaited.
      const current = requireProject(projectId);
      const normalized = catalogOf(current);
      if (normalized.active !== entry.id || current.activeCopilotSessionId !== entry.id
        || current.copilotSessionId !== entry.id || !current.copilotSessions) {
        await mutate(projectId, (catalog) => { catalog.active = entry.id; });
      }
      return { ...summary(requireProject(projectId)), reused: !created };
    });
  }

  async function getCopilot(projectId) {
    return summary(requireProject(projectId));
  }

  return { openCopilot, getCopilot };
}
