# Project-local Copilot conversations

## Scope and compatibility

The Copilot dialog has its own left conversation rail. New, select and reopen use the current project catalog. Exactly one native Conversation/Trajectory is retained and rendered at a time. Titles are project metadata, not model-generated summaries. There is no history polling, delete, rename, or independent chat renderer in this change.

New conversations are continuable private children of the hidden project controller. Both controller and children have durable `origin: 'subagent'` headers. The DSH workspace selector excludes this origin before registered/ungrouped and archived filters. Detaching an ordinary root is not privacy: it would move to Ungrouped.

**Explicit legacy exception:** the user chose to keep existing root IDs and keep sending. Existing roots remain usable and may still appear in DSH. They stay selectable in the project rail with a legacy marker. This change does not archive, detach, unarchive, clone, rewrite headers, or replace their history. Same-ID root-to-private conversion is not a public DSH operation; archiving a root would also block its model turns.

## Authority and persistence

- The project record owns `copilotSessions` and `activeCopilotSessionId`; `copilotSessionId` remains a compatibility alias.
- DSH Session persistence remains the sole authority for headers, descriptors, messages, attachments and model state. No transcript body is duplicated in the catalog.
- The old sole-ID shape is normalized without dropping its entry. Unreadable/foreign selected history returns an explicit error, never an empty replacement.
- Stable create request IDs and pending identity/model reservation allow retry/recovery without minting duplicate empty conversations.
- Different operations on a project are serialized, not coalesced into an unrelated operation result. Project A cannot select an ID owned only by B.

These are boundaries for future independent application work, not a claim that an independent transcript backend exists. Native DSH rendering and persistence are still used.

## Private continuation

The durable child records the exact controller parent and a continuable descriptor with provider/model/effort. Lab-chat preset selection precedes the own descriptor. The parent catalogs the child. The temporary factory child handle is disposed before the native Manager cold-resumes it; the Lab does not keep a competing regular child Agent.

The Host returns authoritative parent/mode with the selected ID. Both embedded retention and native navigation use the exact address:

```js
{ parentSessionId, childSessionId, mode: 'continuable' }
```

Do not depend on summary-discovery timing or route a known private child as a root string. Existing node address inference and visible failures remain intact.

Native cold resume restores the persisted preset/model, not the original plugin setup closure. An awaited agent-created hook reattaches the read-only project-context tool after validating catalog ownership and durable child identity. Initial setup must not register twice; unrelated/wrong-parent agents must not receive another project context. Explicit reopen also validates/rebinds a surviving native Agent after plugin reload.

## UI and performance boundaries

The sidebar stays inside the dialog. Legacy/private entries both remain, selected by successful Host identity rather than row index. New/select use a synchronous pending guard; abort/generation guards and owned-reference cleanup handle late replies and readiness failures. Explicit-switch retry keeps its ID; ambiguous-create retry keeps its action identity.

The rectangular outer clip, native scroll/composer, covered polling pause, event/revision cursors and 15-second notification checks are preserved. Rows do not mount separate sessions and no history timer is added. Fixtures do not prove physical FPS, input latency or live cold-reopen success.

## Verification and activation

Run focused Host/sidebar/client tests plus the existing CSS, covered-background and isolated original selftests. Optional shipped-selector integration uses actual native visibility/grouping functions, with fixture ordering/current-selection helpers:

```sh
DSH_WORKSPACE_CLIENT_PATH=/path/to/shipped/workspace/client.js node --test scripts/copilot-visibility-selftest.mjs
```

Without that native source path the optional integration explicitly skips. It checks origin/archive/group visibility, not a full browser or model turn.

Before activating a Host update, check running nodes, role runs and Copilot turns. Plugin reload reconciles in-flight runs and disposes owned handles; it must not interrupt experiments for UI validation. Back up the actual linked installation and preserve unrelated Git setup changes/dependencies. Obtain any needed maintenance/refresh permission. Local files/tests alone do not prove that the running Host/client loaded the new code. GitHub writes need separate consent.
