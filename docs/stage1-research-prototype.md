# Stage 1 research prototype: audited reuse and provenance

## Code bases and exact revisions
- Existing base: [kiyo1204/kbcm-learning-system](https://github.com/kiyo1204/kbcm-learning-system), base commit `a5f46dc034ae4c311ef1a05e217050dcb3cb2035`.
- Kit-Build reference: [elianiva/kitbuild-cf](https://github.com/elianiva/kitbuild-cf), pinned commit `42218960e9c8ea62a93273c341bd9abc72ab7057`, MIT license, Copyright (c) 2026 elianiva. See [the unchanged license text](third_party_licenses/kitbuild-cf-MIT.txt).
- Original Kit-Build research should be cited separately, e.g. Hirashima et al. (2015), [Framework of Kit-Build Concept Map for Automatic Diagnosis](https://doi.org/10.1186/s41039-015-0018-9).

## Reuse decision
Keep the existing Express, PostgreSQL, React and Docker setup. Reuse `MapPage.tsx` with built-in custom SVG/pointer drag, Concept/Link editor, kit imports, Goal/Kit relations, provenance, transactional operation logging and raw export. The upstream code uses React Flow, TanStack Start and LibSQL/Drizzle and does not drop into the existing backend. Studied `concept-map-canvas.tsx`, `connector-node.tsx`, `text-node.tsx`, `kit-service.ts`, and learner-map mutation services. **No source code from kitbuild-cf is copied in this Stage 1 change**; visual and interaction behavior only is referenced. The original MIT license is included for full attribution, not to suggest a whole-repository integration.

## Stage 1 activities
- Step 1: LESSON (configured video URL per Session)
- Step 2: PRIOR_MAP internal map type **used as a post-lesson Scratch-Build learner_map**. Never infer pre-lesson knowledge from this label. Initialize only the anchor concept `注意`.
- Step 3: KB_MAP; reconstruct using kit parts without showing Goal Map.
- Step 4: INTEGRATION_MAP; clone Step 2 map and import from the same KitDefinition, not from the submitted learner reconstruction.
- Step 5: researcher analysis and export **outside learner SessionStage**. No prompting for reasons during integration.

Only the Stage 1 flow is available in the application. It has four learner SessionStages; researcher analysis is the fifth step in the study flow and is outside the learner Session. Legacy flow routes and development sample content have been retired. Existing historical database rows and applied migrations are retained, but the application does not expose those learning flows.

## Access control

Set `RESEARCHER_API_TOKEN` to an independently generated secret of at least 32 characters before starting the API. Startup fails without it. All `/api` routes except `/api/health` require a Bearer token. The single researcher credential can manage all Sessions, Goal Maps, Kits and research exports. Keep it outside Git and restrict who receives it. Serve the app over HTTPS when used beyond localhost.

Researchers create Stage 1 Sessions. The creation response shows a random learner token once; the browser shows it for secure handoff. The token is stored only as a SHA-256 digest in `sessions.learner_access_token_hash`. The learner uses it in the access-code screen; the browser keeps it in tab-scoped `sessionStorage` and sends it in the Authorization header. A participant code and Session ID are never credentials. `POST /api/research/stage1/sessions/:sessionId/learner-token` lets a researcher rotate a lost or compromised learner token; the previous token stops working. Sessions created before this migration need rotation before a learner can sign in.

Learners may access only their Stage 1 Session, its stages, maps, concepts and links, and the assigned Kit's independent parts. Goal Maps, other Sessions, research analysis, ratings and exports are denied by the API. An unauthenticated request gets 401; a credentialed learner requesting another resource gets 404, and a learner requesting a researcher-only API gets 403. A role-aware UI is a convenience, not an authorization boundary.
`GET /api/me` validates a token and returns the learner's own Session ID so the access-code screen can open the right flow without treating a URL as a credential.

## Data integrity and known gaps
- New PRIOR, KB and INTEGRATION maps save a versioned initial state before learner editing. The snapshot contains map metadata, Concept and Link IDs and fields, merge state, and current Provenance. Integration snapshots are captured after cloning the submitted Scratch map; KB snapshots begin empty. These system initialization steps do not create learner operation logs.
- The researcher history endpoint applies existing MapOperationLog events to the saved initial state without writing to the Map or creating logs. It supports `ADD_CONCEPT`, `EDIT_CONCEPT`, `DELETE_CONCEPT`, `MOVE_CONCEPT`, `ADD_LINK`, `EDIT_LINK`, `DELETE_LINK`, `RECONNECT_LINK`, `IMPORT_KIT_CONCEPT`, `IMPORT_KIT_LINK`, and `MERGE_CONCEPT`. Import, cascade-delete and Merge events now carry the additional Provenance and related-element data needed for replay. `MOVE_CONCEPT` changes position only.
- Maps created before initial snapshots were deployed have no recoverable edit-start state. They are reported as unavailable; the system does not infer one from the current Map. A missing event snapshot, sequence gap or inconsistent before-state makes the selected replay point partial. Replay is therefore not guaranteed for old Maps and is not a general Event Sourcing implementation.
- Replayable snapshots and operations have stable Map and operation IDs, per-Map sequence numbers, server timestamps, and before/after event records. No learner cognitive state is inferred from those records.
- A participant code and Session ID can be joined to Map operation logs through Map -> SessionStage -> Session; do not redundantly rewrite historical logs.
- Source/lesson classification must be temporal and operational (post-lesson learner map versus integration additions), not a claim about cognition or genuine pre-lesson origin.
- Keep AI diagnosis, correctness feedback, and forced Goal matching disabled in learner-facing Stage 1 UI.
- Manual U/I/P/V ratings, rationale and evaluator codes, linked reflection notes, operation snapshots, descriptive features, CSV exports, and researcher-only read-only Map history playback are implemented. Learner Undo/Redo is recorded as append-only `UNDO` and `REDO` MapOperationLog events with a reference to the target operation and exact before/after Concept and Link snapshots. Each request locks the Map, checks the expected sequence and applies the Map delta and event in one transaction. An idempotency key prevents repeated requests from applying twice; normal edits clear the Redo branch. Submitted Maps cannot be changed. Undo/Redo availability is derived from the persisted operation stream after reload.
- The reducer supports Undo/Redo for every existing learner edit operation type: Concept and Link add/edit/delete, Concept move, Link reconnect, Kit Concept/Link import, and Merge. Cascaded Link deletion, Merge rewiring, and Provenance IDs are restored from event snapshots. Maps without a complete initial snapshot or with a replay mismatch have Undo/Redo disabled; state is never inferred. Operation counts and Undo/Redo counts are reported separately in `stage1-descriptive-v2`; counts are descriptive and do not measure learning quality.
- This branch is a staged prototype; automated verification must be run in Docker before merging.

## Local run and test
1. Switch to `feature/stage1-research-prototype`, run the existing Docker Compose bootstrap and apply both additive migrations.
2. Run `docker compose exec api npm run db:migrate -- up` and `docker compose exec api npm run db:seed:dev`.
3. Open `http://localhost:5173/research/stage1/new`, enter a **pseudonymous** code, select a Kit, and set an externally hosted video URL or a served `.mp4` path. The video checkbox is a self-report rather than reliable viewing-time measurement.
4. Proceed through Lesson, Scratch-Build (starts with `注意`), Kit-Build and Integration; the application submits the four Map/Stage results separately and finishes the Session after Integration.
5. While editing a Stage 1 Map, use `元に戻す` and `やり直す`; the buttons are disabled when the operation stream is incomplete, the Map is submitted, or there is no corresponding operation.
6. After Session completion, navigate to `/research/stage1/<session-id>/analysis` for three read-only Maps, an event timeline, manual proposition ratings and linked memos. `UNDO`/`REDO` entries show their target operation ID.

API integrations use:
- `POST /api/research/stage1/sessions` with `participantCode`, `videoUrl`, `kitDefinitionId`
- `GET /api/research/stage1/sessions/<session-id>/analysis`
- `GET /api/research/stage1/sessions/<session-id>/maps/<map-id>/history?sequenceNumber=<n>` (read-only before/after Map state; researcher credential required)
- `GET /api/maps/<map-id>/undo-redo` and `POST /api/maps/<map-id>/undo-redo` (learner-scoped availability and transactional, idempotent Undo/Redo; POST body includes `action`, `expectedSequenceNumber`, `idempotencyKey`, and optional `clientTimestamp`)
- `GET /api/research/sessions/<session-id>/export` (raw JSON)
- `GET /api/research/stage1/sessions/<session-id>/operations.csv`
- `GET /api/research/stage1/sessions/<session-id>/evaluations.csv`
- `GET /api/research/stage1/sessions/<session-id>/reflections.csv`
- `GET /api/research/stage1/sessions/<session-id>/features.csv`
- `POST /api/research/stage1/sessions/<session-id>/evaluations`
- `POST /api/research/stage1/sessions/<session-id>/reflections`

CI `.github/workflows/stage1-prototype.yml` checks frontend/backend build, lint and TypeScript, migrates and seeds a clean PostgreSQL 17, then runs Stage 1 integration and Undo/Redo reducer tests.

### Gate before research deployment
- Before public research deployment, replace the single shared researcher credential with individually managed researcher accounts and scoped Session grants; add credential recovery, rate limiting and audit of researcher access. Review the UI for XSS before storing browser tokens, and provision TLS and secure secret rotation.
- Integrate a controlled lesson video asset, freeze the Goal/Kit version and validate that no teacher Goal structure/diagnosis is exposed in participant views.
- Test UI pointer drag/drop and reconnect in a real browser; API CI does **not** prove full user-interaction usability.
- Review and freeze analysis feature definitions before collecting research data; current event counts are **descriptive**, not competence or improvement scores.
- The current `stage1-descriptive-v2` feature set is exploratory. `retainedScratchPropositions` counts current integration links whose cloned Scratch link has the same label and endpoints traced to cloned Scratch concepts. `inheritedToAddedPropositions` counts current links joining an exclusively cloned Scratch concept and an exclusively added concept; mixed-origin merge endpoints are counted separately. Current Kit usage rates divide distinct imported source item IDs still present in the integration map by the assigned Kit's part counts. Import event counts use operation logs and may differ from current usage. `ordinaryEditEvents`, `undoEvents`, and `redoEvents` are separate descriptive counts. These formulas and their denominators must be frozen before analysis across participants.
