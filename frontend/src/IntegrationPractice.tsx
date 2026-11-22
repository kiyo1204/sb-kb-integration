import { useEffect, useRef, useState, type FormEvent } from "react";
import { ConceptCanvas, IntegrationConceptMergeForm } from "./MapPage";

// These labels and IDs are neutral teaching fixtures, never the experiment kit.
const practiceMapId = "practice-integration";
const kitConcepts = [
  { kitConceptItemId: "practice-kit-shape", label: "形" },
  { kitConceptItemId: "practice-kit-color", label: "色" },
  { kitConceptItemId: "practice-kit-position", label: "位置" },
];
const kitLinks = [
  { kitLinkItemId: "practice-kit-relation", label: "関係" },
  { kitLinkItemId: "practice-kit-connection", label: "つながり" },
];

type PracticeConcept = {
  id: string;
  label: string;
  positionX: number;
  positionY: number;
  createdAt: string;
  updatedAt: string;
  isMergeResult?: boolean;
};
type PracticeLink = {
  id: string;
  mapId: string;
  sourceConceptId: string;
  targetConceptId: string;
  label: string;
};
type MergeRecord = {
  sources: [PracticeConcept, PracticeConcept];
  incidentLinks: PracticeLink[];
};
type PracticeGraph = {
  concepts: PracticeConcept[];
  links: PracticeLink[];
  importedKitConceptIds: string[];
  importedKitLinkIds: string[];
  merges: Record<string, MergeRecord>;
};
type Timeline = {
  graph: PracticeGraph;
  past: PracticeGraph[];
  future: PracticeGraph[];
};

type Operation = {
  key: string;
  label: string;
};
const tasks: Operation[] = [
  { key: "kit.concept", label: "Kitの概念を取り込む" },
  { key: "kit.link", label: "Kitのリンクを接続する" },
  { key: "concept.merge", label: "2つの概念をMergeする" },
  { key: "concept.unmerge", label: "Merge結果の削除で1段階解除する" },
  { key: "link.reconnect", label: "リンクの接続先を変更する" },
  { key: "operation.undo", label: "元に戻す（Undo）を試す" },
  { key: "operation.redo", label: "やり直す（Redo）を試す" },
];

function startGraph(): PracticeGraph {
  return {
    // In the actual experiment, the submitted SB map is cloned automatically.
    concepts: [
      { id: "practice-sb-a", label: "点A", positionX: 100, positionY: 100, createdAt: "", updatedAt: "" },
      { id: "practice-sb-b", label: "点B", positionX: 440, positionY: 170, createdAt: "", updatedAt: "" },
    ],
    links: [
      { id: "practice-sb-link", mapId: practiceMapId, sourceConceptId: "practice-sb-a", targetConceptId: "practice-sb-b", label: "つながり" },
    ],
    importedKitConceptIds: [],
    importedKitLinkIds: [],
    merges: {},
  };
}

export default function IntegrationPractice({
  onComplete,
}: {
  onComplete: (step: "INTEGRATION") => void;
}) {
  const [timeline, setTimeline] = useState<Timeline>(() => ({ graph: startGraph(), past: [], future: [] }));
  const timelineRef = useRef(timeline);
  const [completed, setCompleted] = useState<string[]>([]);
  const [conceptLabel, setConceptLabel] = useState("");
  const [linkLabel, setLinkLabel] = useState("");
  const [linkCreation, setLinkCreation] = useState<{ id: string; label: string } | null>(null);
  const [selectedConcept, setSelectedConcept] = useState<string | null>(null);
  const [selectedLink, setSelectedLink] = useState<string | null>(null);
  const [editLabel, setEditLabel] = useState("");
  const ids = useRef(0);
  const newId = () => `practice-integration-${++ids.current}`;

  function markDone(key: string) {
    setCompleted((current) => current.includes(key) ? current : [...current, key]);
  }

  // Every local mutation is a single snapshot operation. Neither graph nor
  // undo/redo stacks are persisted or emitted as observation events.
  function commit(update: (previous: PracticeGraph) => PracticeGraph, taskKey?: string) {
    const previous = timelineRef.current;
    const graph = update(previous.graph);
    if (graph === previous.graph) return false;
    const next = { graph, past: [...previous.past, previous.graph], future: [] };
    timelineRef.current = next;
    setTimeline(next);
    if (taskKey) markDone(taskKey);
    return true;
  }

  function undo() {
    const previous = timelineRef.current;
    if (previous.past.length === 0) return;
    const graph = previous.past[previous.past.length - 1];
    const next = {
      graph,
      past: previous.past.slice(0, -1),
      future: [previous.graph, ...previous.future],
    };
    timelineRef.current = next;
    setTimeline(next);
    markDone("operation.undo");
  }

  function redo() {
    const previous = timelineRef.current;
    if (previous.future.length === 0) return;
    const [graph, ...future] = previous.future;
    const next = {
      graph,
      past: [...previous.past, previous.graph],
      future,
    };
    timelineRef.current = next;
    setTimeline(next);
    markDone("operation.redo");
  }

  function releaseMerge(graph: PracticeGraph, resultId: string): PracticeGraph {
    const merge = graph.merges[resultId];
    if (!merge) return graph;
    const merges = { ...graph.merges };
    delete merges[resultId];
    const unaffectedLinks = graph.links.filter(
      (link) => link.sourceConceptId !== resultId && link.targetConceptId !== resultId,
    );
    const activeLinkIds = new Set(unaffectedLinks.map((link) => link.id));
    return {
      ...graph,
      concepts: [...graph.concepts.filter((concept) => concept.id !== resultId), ...merge.sources],
      // Later-created links incident to the Merge result are removed. Direct
      // pre-Merge connections are restored; unrelated later edits survive.
      links: [
        ...unaffectedLinks,
        ...merge.incidentLinks.filter((link) => !activeLinkIds.has(link.id)),
      ],
      merges,
    };
  }

  function performMerge(conceptIds: [string, string], label: string) {
    return commit((graph) => {
      const [a, b] = conceptIds.map((conceptId) => graph.concepts.find((concept) => concept.id === conceptId));
      if (!a || !b || a.id === b.id || !label.trim()) return graph;
      const id = newId();
      const idsToMerge = new Set([a.id, b.id]);
      const incidentLinks = graph.links.filter(
        (link) => idsToMerge.has(link.sourceConceptId) || idsToMerge.has(link.targetConceptId),
      );
      const concept: PracticeConcept = {
        id,
        label: label.trim(),
        positionX: Math.round((a.positionX + b.positionX) / 2),
        positionY: Math.round((a.positionY + b.positionY) / 2),
        createdAt: "",
        updatedAt: "",
        isMergeResult: true,
      };
      return {
        ...graph,
        concepts: [...graph.concepts.filter((entry) => !idsToMerge.has(entry.id)), concept],
        links: graph.links
          // An edge entirely inside the new Merge has no visible external end.
          .filter((link) => !(idsToMerge.has(link.sourceConceptId) && idsToMerge.has(link.targetConceptId)))
          .map((link) => ({
            ...link,
            sourceConceptId: idsToMerge.has(link.sourceConceptId) ? id : link.sourceConceptId,
            targetConceptId: idsToMerge.has(link.targetConceptId) ? id : link.targetConceptId,
          })),
        merges: { ...graph.merges, [id]: { sources: [a, b], incidentLinks } },
      };
    }, "concept.merge");
  }

  function addConcept(label: string, positionX: number, positionY: number) {
    const newConceptId = newId();
    commit((graph) => ({
      ...graph,
      concepts: [...graph.concepts, { id: newConceptId, label, positionX, positionY, createdAt: "", updatedAt: "" }],
    }));
    return newConceptId;
  }

  function addLink(sourceConceptId: string, targetConceptId: string, label: string, kitLinkId?: string) {
    const newLinkId = newId();
    const success = commit((graph) => {
      if (!graph.concepts.some((concept) => concept.id === sourceConceptId) ||
          !graph.concepts.some((concept) => concept.id === targetConceptId)) return graph;
      if (kitLinkId && graph.importedKitLinkIds.includes(kitLinkId)) return graph;
      return {
        ...graph,
        links: [...graph.links, { id: newLinkId, mapId: practiceMapId, sourceConceptId, targetConceptId, label }],
        importedKitLinkIds: kitLinkId ? [...graph.importedKitLinkIds, kitLinkId] : graph.importedKitLinkIds,
      };
    }, kitLinkId ? "kit.link" : undefined);
    return success ? newLinkId : undefined;
  }

  const graph = timeline.graph;
  const currentTasks = tasks.filter((task) => completed.includes(task.key)).length;
  useEffect(() => {
    if (currentTasks === tasks.length) onComplete("INTEGRATION");
  }, [currentTasks, onComplete]);

  function submitNewConcept(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!conceptLabel.trim()) return;
    addConcept(conceptLabel.trim(), 100 + (graph.concepts.length % 3) * 210, 360);
    setConceptLabel("");
  }

  return (
    <>
      <h2 id="tutorial-practice-heading">統合マップの練習</h2>
      <section className="tutorial-task-progress" aria-label="操作練習の課題">
        <h3>練習する操作</h3>
        <p role="status">{currentTasks} / {tasks.length} 件達成</p>
        <ol>
          {tasks.map((task) => (
            <li key={task.key}>
              <span aria-hidden="true">{completed.includes(task.key) ? "✓" : "○"}</span>{" "}
              {task.label}
              <span className="tutorial-task-result">{completed.includes(task.key) ? "完了" : "未完了"}</span>
            </li>
          ))}
        </ol>
        <p>達成状況はこの練習画面だけの表示で、学習成績・研究記録にはなりません。</p>
      </section>
      <div className="tutorial-integration-actions">
        <button type="button" disabled={timeline.past.length === 0} onClick={undo}>元に戻す（Undo）</button>
        <button type="button" disabled={timeline.future.length === 0} onClick={redo}>やり直す（Redo）</button>
        <span role="status">現在：{graph.concepts.length} 概念・{graph.links.length} リンク</span>
      </div>
      <p className="tutorial-practice-footnote">
        練習のUndo/Redoはこの画面内の操作履歴だけを戻します。Merge結果の概念をクリックし、編集パネルの「Merge結果を削除して1段階解除」を選ぶと直近1段階を解除し、内側のMergeは維持します。
      </p>
      <div className="tutorial-integration-tools">
        <form onSubmit={submitNewConcept}>
          <label>練習用概念の名前
            <input value={conceptLabel} onChange={(event) => setConceptLabel(event.target.value)} />
          </label>
          <button type="submit">概念を追加</button>
        </form>
        <form onSubmit={(event) => {
          event.preventDefault();
          if (!linkLabel.trim()) return;
          setLinkCreation({ id: newId(), label: linkLabel.trim() });
          setLinkLabel("");
        }}>
          <label>練習用リンクの名前
            <input value={linkLabel} onChange={(event) => setLinkLabel(event.target.value)} />
          </label>
          <button type="submit" disabled={linkCreation !== null}>リンクを追加</button>
        </form>
      </div>
      <IntegrationConceptMergeForm
        concepts={graph.concepts}
        disabled={false}
        localPractice
        onCancel={async () => undefined}
        onMerge={async (ids, label) => {
          if (!performMerge(ids, label)) throw new Error("Merge対象を確認してください。");
        }}
      />
      {(selectedConcept || selectedLink) && (
        <form className="tutorial-edit" onSubmit={(event) => {
          event.preventDefault();
          const label = editLabel.trim();
          if (!label) return;
          if (selectedConcept) commit((graph) => graph.concepts.some((c) => c.id === selectedConcept) ? {
            ...graph, concepts: graph.concepts.map((c) => c.id === selectedConcept ? { ...c, label } : c),
          } : graph);
          if (selectedLink) commit((graph) => graph.links.some((l) => l.id === selectedLink) ? {
            ...graph, links: graph.links.map((l) => l.id === selectedLink ? { ...l, label } : l),
          } : graph);
          setSelectedConcept(null);
          setSelectedLink(null);
        }}>
          <label>選択した名前を編集<input value={editLabel} onChange={(event) => setEditLabel(event.target.value)} /></label>
          <button type="submit">変更</button>
          {selectedConcept && graph.concepts.some((concept) =>
            concept.id === selectedConcept && concept.isMergeResult
          ) && (
            <button
              type="button"
              onClick={() => {
                const result = timelineRef.current.graph.concepts.find((concept) =>
                  concept.id === selectedConcept && concept.isMergeResult
                );
                if (!result || !window.confirm(
                  `「${result.label}」を削除し、直近のMergeを1段階だけ解除しますか？`
                )) return;
                const released = commit(
                  (current) => releaseMerge(current, result.id),
                  "concept.unmerge",
                );
                if (released) {
                  setSelectedConcept(null);
                  setSelectedLink(null);
                }
              }}
            >
              Merge結果を削除して1段階解除
            </button>
          )}
          <button type="button" onClick={() => { setSelectedConcept(null); setSelectedLink(null); }}>閉じる</button>
        </form>
      )}
      <ConceptCanvas
        mapId={practiceMapId}
        mapType="INTEGRATION"
        allowMergeRelease
        concepts={graph.concepts}
        links={graph.links}
        kitDefinitionName="練習用のキット"
        kitPaletteCopy="kits"
        kitConcepts={kitConcepts.map((part) => ({ ...part, imported: graph.importedKitConceptIds.includes(part.kitConceptItemId) }))}
        kitLinks={kitLinks.map((part) => ({ ...part, used: graph.importedKitLinkIds.includes(part.kitLinkItemId) }))}
        readOnly={false}
        canEditConceptStructure
        canEditLinkLabel
        positionSaving={false}
        positionFeedback={null}
        onLabelSave={async (conceptId, label) => {
          commit((graph) => graph.concepts.some((c) => c.id === conceptId && c.label !== label)
            ? { ...graph, concepts: graph.concepts.map((c) => c.id === conceptId ? { ...c, label } : c) }
            : graph);
        }}
        onConceptDelete={async (conceptId) => {
          const existing = timelineRef.current.graph.concepts.find((c) => c.id === conceptId);
          if (!existing) return;
          if (existing.isMergeResult) {
            commit((graph) => releaseMerge(graph, conceptId), "concept.unmerge");
          } else {
            commit((graph) => ({
              ...graph,
              concepts: graph.concepts.filter((concept) => concept.id !== conceptId),
              links: graph.links.filter((link) => link.sourceConceptId !== conceptId && link.targetConceptId !== conceptId),
            }));
          }
        }}
        onLinkLabelSave={async (link, label) => {
          commit((graph) => graph.links.some((candidate) => candidate.id === link.id && candidate.label !== label)
            ? { ...graph, links: graph.links.map((candidate) => candidate.id === link.id ? { ...candidate, label } : candidate) }
            : graph);
        }}
        onLinkReconnect={async (link, sourceConceptId, targetConceptId) => {
          commit((graph) => {
            if (!graph.links.some((candidate) => candidate.id === link.id) ||
                !graph.concepts.some((concept) => concept.id === sourceConceptId) ||
                !graph.concepts.some((concept) => concept.id === targetConceptId) ||
                (link.sourceConceptId === sourceConceptId && link.targetConceptId === targetConceptId)) return graph;
            return {
              ...graph,
              links: graph.links.map((candidate) => candidate.id === link.id
                ? { ...candidate, sourceConceptId, targetConceptId } : candidate),
            };
          }, "link.reconnect");
        }}
        onLinkDelete={async (linkId) => {
          commit((graph) => graph.links.some((link) => link.id === linkId)
            ? { ...graph, links: graph.links.filter((link) => link.id !== linkId) }
            : graph);
        }}
        onKitConceptDrop={async (itemId, position) => {
          const part = kitConcepts.find((item) => item.kitConceptItemId === itemId);
          if (!part) return;
          const conceptId = newId();
          commit((graph) => graph.importedKitConceptIds.includes(itemId) ? graph : {
            ...graph,
            concepts: [...graph.concepts, { id: conceptId, label: part.label, ...position, createdAt: "", updatedAt: "" }],
            importedKitConceptIds: [...graph.importedKitConceptIds, itemId],
          }, "kit.concept");
        }}
        onKitLinkCreate={async (_mapId, itemId, source, target) => {
          const part = kitLinks.find((item) => item.kitLinkItemId === itemId);
          return part ? addLink(source, target, part.label, itemId) : undefined;
        }}
        onDragStart={() => undefined}
        onPositionSave={async (conceptId, position, original) => {
          commit((graph) => graph.concepts.some((concept) => concept.id === conceptId) &&
            (position.positionX !== original.positionX || position.positionY !== original.positionY)
            ? { ...graph, concepts: graph.concepts.map((concept) => concept.id === conceptId ? { ...concept, ...position } : concept) }
            : graph);
          return position;
        }}
        linkCreation={linkCreation}
        onMapLinkCreate={async (source, target, label) => {
          const linkId = addLink(source, target, label);
          if (linkId) setLinkCreation(null);
          return linkId;
        }}
        onMapLinkCreationCancel={() => setLinkCreation(null)}
        onMapConceptSelect={(concept) => { setSelectedConcept(concept.id); setSelectedLink(null); setEditLabel(concept.label); }}
        onMapLinkSelect={(link) => { setSelectedLink(link.id); setSelectedConcept(null); setEditLabel(link.label); }}
      />
    </>
  );
}
