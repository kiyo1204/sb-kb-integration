# Kit-Build interaction references

## Research method

The academic basis for the Kit-Build Concept Map method must be cited from the
research literature. A software repository is not used as evidence for the
method itself.

- Hirashima, T., Yamasaki, K., Fukuda, H., & Funaoi, H. (2015). Framework of
  Kit-Build concept map for automatic diagnosis and its preliminary use.
  _Research and Practice in Technology Enhanced Learning, 10_, 17.
  <https://doi.org/10.1186/s41039-015-0018-9>

## Software and interaction references

The following repositories were inspected to understand existing learner
reconstruction interactions. The implementation in this repository was
written independently for its existing React, SVG, provenance, API, and
operation log model.

### aryoxp/kbfira

- Repository: <https://github.com/aryoxp/kbfira>
- Inspected revision: `cc2661ff7961e0a7b74b9e2adec0712f55fedb5a`
- Inspected areas: `kitbuild/`, `kitbuild/asset/recompose.js`,
  `.asset/vendor/kitbuild/`, and `kbui.canvas.tool.js`
- License handling: no explicit repository root OSS license was found during
  inspection. No source code was copied or derived from this repository. It
  was used only to understand the visual distinction between concepts and
  linking words, component placement, handles, and learner reconstruction.

### elianiva/kitbuild-cf

- Repository: <https://github.com/elianiva/kitbuild-cf>
- Inspected revision: `42218960e9c8ea62a93273c341bd9abc72ab7057`
- License: MIT, Copyright (c) 2026 elianiva
- Inspected files:
  - `src/features/kit/components/concept-map-canvas.tsx`
  - `src/features/learner-map/components/learner-map-editor.tsx`
  - `src/features/kit/components/text-node.tsx`
  - `src/features/kit/components/connector-node.tsx`
  - `src/features/kit/components/floating-edge.tsx`
  - `src/features/kit/components/floating-connection-line.tsx`
- License handling: behavior and component architecture were referenced. No
  source code or substantial portion was copied, so an MIT notice is not
  bundled into the application.

## Representation used here

The backend and research data retain one directed Link record with
`sourceConceptId`, `targetConceptId`, and a server-authoritative `label`. The
frontend renders that record as a linking-word connector between two Concept
nodes. Temporary connectors with zero or one endpoint exist only in React
state and are never written to the database.

Connector position for a saved Link is derived from its endpoints. It is not
stored as research data. Goal Map positions and Goal Link endpoints are not
sent to the interaction as hints, and dropping a Concept does not merge or
connect it automatically.
