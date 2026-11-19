# KB saved-link reconnection (new learner flow)

## Objective and scope
- Enable the existing double-click / drawer entry for saved links on new-flow learner KB maps.
- Keep the existing SB behavior and leave integration maps and legacy protocols disabled.
- This patch is frontend-only: no API, database, migration, log schema, or integration algorithm changes.

## Data integrity invariants
- An unsaved, partially connected link lives only in UI state; never persist null endpoints.
- Complete both endpoints before PATCH `/api/links/:id/reconnect`, with `expectedConnection` equal to the original saved pair.
- Reuse the existing saved link ID and preserve label, position, Kit link item association, and provenance.
- The Kit palette stays `used` while a saved link is temporarily detached; never duplicate its part.
- Cancel, reload, expiry, authorization/context changes, and conflicts must not re-create or silently save a link.
- While editing, disable KB temporary verification/submission and Undo/Redo; mark prior Kit feedback as unverified. Following a saved structural change, require a new Kit feedback check before final submission.

## Files
- `frontend/src/MapPage.tsx`: extend new-flow scope and guard KB verification UI.
- `frontend/scripts/verify-link-reconnection-browser.ts`: synthetic KB success, cancellation, reload, failed PATCH, and Kit part identity regression; keep SB and excluded-map cases.

## Verification
1. `npm run lint --prefix frontend`
2. `npm run build --prefix frontend`
3. `npm run test:link-reconnection-browser --prefix frontend` (Playwright on local Edge; mocked APIs, no database)
4. In an isolated synthetic test environment, verify the original Kit association and persisted map after reconnect and reload.
5. Do not use a research-data DB or run migrations to test this patch.

## Review and outstanding work
- Integration map reconnection is a separate task. It requires merge/undo/redo/deadline review.
- Automated browser checks are included but have **not been executed** by the patch builder. Review output and rerun before any merge.
- Git commit, push, pull request creation, and merge each require separate approval.
