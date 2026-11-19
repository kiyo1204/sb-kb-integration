# Integration saved-link reconnection (new learner flow)

## Scope and prerequisites
- Based on `feat/kb-saved-link-reconnection` commit `040248da9033198e28d43d671cfbcf61293bfab8` (PR #64, draft at packaging time).
- Enables saved-link double-click reconnection only for learner `INTEGRATION` maps with `SBKB_INTEGRATION_V1` and `DRAFT` status; SB/KB stay enabled and legacy flows remain excluded.
- Preserve saved link identity, direction, label, label position, Kit association, and provenance. Do not persist partial links.
- No migrations, backend mutations, research data handling, or changes to logging schema.

## Isolation from Integration operations
- Reconnection draft blocks the sibling Concept Merge and Kit assignment UI without an asynchronous parent-state race.
- Merge in flight already sets `mergingConcepts` and locks the map editor (`readOnly`). A stale saved connection from another tab or Merge is checked by GET preflight, followed by conditional `expectedConnection` PATCH.
- Disable Undo/Redo and final submit during draft using existing MapEditorShell controls. This is a UI guard, not a substitute for server authorization/locking.
- Extend observation revision binding to Integration so late responses from invalidated login/client contexts are ignored.
- Use the existing SB drawer-under-canvas layout strategy for Integration to prevent first click moving the link away from the second click.
- When integration stage times out, MapPage navigates away and destroys the draft; server stage enforcement remains authoritative.

## Files
- `frontend/src/MapPage.tsx`: allow Integration, scope change handling, and synchronous draft-aware supplemental controls.
- `frontend/src/experiment-learner.css`: stable double-click layout for Integration.
- `frontend/scripts/verify-link-reconnection-browser.ts`: extend synthetic browser tests to Integration: draft, blocked Merge/Kit/Undo/Redo/submit, cancel/reload, failed/successful PATCH, stale source and ended session, legacy exclusion.

## Validation checklist (not yet executed for this ZIP)
1. `npm run lint --prefix frontend`
2. `npm run build --prefix frontend`
3. `npm run test:link-reconnection-browser --prefix frontend` (Playwright / local Edge; synthetic API only)
4. `git diff --check`
5. In disposable isolated API/DB environment only: Merge then reconnect, reconnect then Undo/Redo, activity timeout with in-flight PATCH, backend readback and event replay/provenance; never reuse a research database.
6. Manually test Integration double-click, single-click drawer and switching to another action at 1366/1440 widths.

## Deployment boundaries
- This patch must be applied to a **new separate branch**, never directly to a merged or published branch.
- Commit, push, PR creation, merge, deployment, database mutations each require separate approval.
- PR #64 is independent and should be reviewed/merged separately; do not implicitly change it.
