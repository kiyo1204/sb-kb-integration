import { useState, type FormEvent } from "react";
import { ConceptCanvas } from "./MapPage";

type Concept = {
  id: string;
  label: string;
  positionX: number;
  positionY: number;
  createdAt: string;
  updatedAt: string;
};
type Link = {
  id: string;
  mapId: string;
  sourceConceptId: string;
  targetConceptId: string;
  label: string;
};

const mapId = "practice";
const kitConcepts = [
  { kitConceptItemId: "a", label: "丸", imported: false },
  { kitConceptItemId: "b", label: "四角", imported: false },
  { kitConceptItemId: "c", label: "色", imported: false },
];
const kitLinks = [
  { kitLinkItemId: "r", label: "関係", used: false },
  { kitLinkItemId: "s", label: "つながり", used: false },
];
let sequence = 0;
const id = () => `practice-${++sequence}`;

export default function TutorialPage({ returnHref }: { returnHref: string }) {
  const [mode, setMode] = useState<"PRIOR" | "KB">("PRIOR");
  const [reset, setReset] = useState(0);

  return (
    <main className="page tutorial-page">
      <section className="session-card tutorial-card">
        <header className="tutorial-heading">
          <p className="home-card-kicker">通常の学習Sessionとは別の練習</p>
          <h1>操作の練習</h1>
          <p className="tutorial-practice-note">
            練習用のMapはこの画面内だけで扱い、サーバーや学習Sessionの記録には保存しません。画面を離れる、練習モードを切り替える、または最初からやり直すと内容は初期化されます。
          </p>
        </header>

        <nav
          className="assessment-actions tutorial-controls"
          aria-label="練習モードと操作"
        >
          <button
            type="button"
            className={
              mode === "PRIOR"
                ? "session-primary-button"
                : "session-secondary-button"
            }
            aria-pressed={mode === "PRIOR"}
            onClick={() => setMode("PRIOR")}
          >
            マップ作成の練習
          </button>
          <button
            type="button"
            className={
              mode === "KB"
                ? "session-primary-button"
                : "session-secondary-button"
            }
            aria-pressed={mode === "KB"}
            onClick={() => setMode("KB")}
          >
            Kit-Buildの練習
          </button>
          <button
            type="button"
            className="session-secondary-button"
            onClick={() => setReset((current) => current + 1)}
          >
            最初からやり直す
          </button>
          <a className="session-secondary-button" href={returnHref}>
            練習を終了
          </a>
        </nav>

        <section
          className="tutorial-practice-area"
          aria-labelledby="tutorial-practice-heading"
        >
          <PracticeCanvas key={`${mode}-${reset}`} mode={mode} />
        </section>
      </section>
    </main>
  );
}

function PracticeCanvas({ mode }: { mode: "PRIOR" | "KB" }) {
  const [concepts, setConcepts] = useState<Concept[]>([]);
  const [links, setLinks] = useState<Link[]>([]);
  const [usedConcepts, setUsedConcepts] = useState<string[]>([]);
  const [usedLinks, setUsedLinks] = useState<string[]>([]);
  const [conceptLabel, setConceptLabel] = useState("");
  const [linkLabel, setLinkLabel] = useState("");
  const [linkCreation, setLinkCreation] = useState<{
    id: string;
    label: string;
  } | null>(null);
  const [selectedConcept, setSelectedConcept] = useState<string | null>(null);
  const [selectedLink, setSelectedLink] = useState<string | null>(null);
  const [editLabel, setEditLabel] = useState("");

  function addConcept(label: string, positionX: number, positionY: number) {
    setConcepts((list) => [
      ...list,
      { id: id(), label, positionX, positionY, createdAt: "", updatedAt: "" },
    ]);
  }

  function createLink(
    sourceConceptId: string,
    targetConceptId: string,
    label: string,
  ) {
    const linkId = id();
    setLinks((list) => [
      ...list,
      { id: linkId, mapId, sourceConceptId, targetConceptId, label },
    ]);
    return linkId;
  }

  function addManualConcept(event: FormEvent) {
    event.preventDefault();
    if (!conceptLabel.trim()) return;
    addConcept(
      conceptLabel.trim(),
      80 + (concepts.length % 4) * 200,
      80 + Math.floor(concepts.length / 4) * 130,
    );
    setConceptLabel("");
  }

  const instructions =
    mode === "PRIOR"
      ? "概念名とリンク名を入力して追加します。概念はドラッグで移動でき、作成中のリンクは両端を概念へ接続します。"
      : "部品パレットから概念とリンクをマップへ追加し、作成中のリンクの両端を概念へ接続します。";

  return (
    <>
      <h2 id="tutorial-practice-heading">
        {mode === "PRIOR" ? "マップ作成の練習" : "Kit-Buildの練習"}
      </h2>
      <p className="tutorial-practice-description">
        {instructions} 矢印の先が関係先です。
      </p>

      {mode === "PRIOR" && (
        <div className="tutorial-tools" aria-label="概念とリンクの追加">
          <form onSubmit={addManualConcept}>
            <label>
              概念の名前
              <input
                value={conceptLabel}
                onChange={(event) => setConceptLabel(event.target.value)}
              />
            </label>
            <button className="session-secondary-button" type="submit">
              概念を追加
            </button>
          </form>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (linkLabel.trim()) {
                setLinkCreation({ id: id(), label: linkLabel.trim() });
                setLinkLabel("");
              }
            }}
          >
            <label>
              リンクの名前
              <input
                value={linkLabel}
                onChange={(event) => setLinkLabel(event.target.value)}
              />
            </label>
            <button
              className="session-secondary-button"
              disabled={!!linkCreation}
              type="submit"
            >
              リンクを追加
            </button>
          </form>
        </div>
      )}

      {linkCreation && (
        <p className="tutorial-link-status" role="status">
          「{linkCreation.label}
          」の始点と矢印の先を、それぞれ概念へドラッグしてください。{" "}
          <button type="button" onClick={() => setLinkCreation(null)}>
            キャンセル
          </button>
        </p>
      )}

      {(selectedConcept || selectedLink) && (
        <form
          className="tutorial-edit"
          onSubmit={(event) => {
            event.preventDefault();
            if (!editLabel.trim()) return;
            if (selectedConcept) {
              setConcepts((list) =>
                list.map((concept) =>
                  concept.id === selectedConcept
                    ? { ...concept, label: editLabel.trim() }
                    : concept,
                ),
              );
            }
            if (selectedLink) {
              setLinks((list) =>
                list.map((link) =>
                  link.id === selectedLink
                    ? { ...link, label: editLabel.trim() }
                    : link,
                ),
              );
            }
            setSelectedConcept(null);
            setSelectedLink(null);
          }}
        >
          <label>
            選択した名前を編集
            <input
              value={editLabel}
              onChange={(event) => setEditLabel(event.target.value)}
            />
          </label>
          <button className="session-secondary-button" type="submit">
            変更
          </button>
          <button
            type="button"
            onClick={() => {
              setSelectedConcept(null);
              setSelectedLink(null);
            }}
          >
            閉じる
          </button>
        </form>
      )}

      {mode === "PRIOR" && (
        <p className="tutorial-practice-footnote">
          概念はドラッグで移動できます。概念やリンクを選ぶと名前を編集できます。
        </p>
      )}

      <ConceptCanvas
        mapId={mapId}
        mapType={mode}
        concepts={concepts}
        links={links}
        kitDefinitionName={mode === "KB" ? "練習用の部品" : null}
        kitConcepts={kitConcepts.map((concept) => ({
          ...concept,
          imported: usedConcepts.includes(concept.kitConceptItemId),
        }))}
        kitLinks={kitLinks.map((link) => ({
          ...link,
          used: usedLinks.includes(link.kitLinkItemId),
        }))}
        readOnly={false}
        canEditConceptStructure={mode === "PRIOR"}
        canEditLinkLabel={mode === "PRIOR"}
        positionSaving={false}
        positionFeedback={null}
        onLabelSave={async (conceptId, label) =>
          setConcepts((list) =>
            list.map((concept) =>
              concept.id === conceptId ? { ...concept, label } : concept,
            ),
          )
        }
        onConceptDelete={async (conceptId) => {
          setConcepts((list) =>
            list.filter((concept) => concept.id !== conceptId),
          );
          setLinks((list) =>
            list.filter(
              (link) =>
                link.sourceConceptId !== conceptId &&
                link.targetConceptId !== conceptId,
            ),
          );
        }}
        onLinkLabelSave={async (link, label) =>
          setLinks((list) =>
            list.map((candidate) =>
              candidate.id === link.id ? { ...candidate, label } : candidate,
            ),
          )
        }
        onLinkReconnect={async (link, sourceConceptId, targetConceptId) =>
          setLinks((list) =>
            list.map((candidate) =>
              candidate.id === link.id
                ? { ...candidate, sourceConceptId, targetConceptId }
                : candidate,
            ),
          )
        }
        onLinkDelete={async (linkId) =>
          setLinks((list) => list.filter((link) => link.id !== linkId))
        }
        onKitConceptDrop={async (itemId, position) => {
          const item = kitConcepts.find(
            (concept) => concept.kitConceptItemId === itemId,
          );
          if (item && !usedConcepts.includes(itemId)) {
            addConcept(item.label, position.positionX, position.positionY);
            setUsedConcepts((list) => [...list, itemId]);
          }
        }}
        onKitLinkCreate={async (_mapId, itemId, source, target) => {
          const item = kitLinks.find((link) => link.kitLinkItemId === itemId);
          if (!item) return;
          setUsedLinks((list) => [...list, itemId]);
          return createLink(source, target, item.label);
        }}
        onDragStart={() => undefined}
        onPositionSave={async (conceptId, position) => {
          setConcepts((list) =>
            list.map((concept) =>
              concept.id === conceptId ? { ...concept, ...position } : concept,
            ),
          );
          return position;
        }}
        linkCreation={linkCreation}
        onMapLinkCreate={async (source, target, label) => {
          const linkId = createLink(source, target, label);
          setLinkCreation(null);
          return linkId;
        }}
        onMapLinkCreationCancel={() => setLinkCreation(null)}
        onMapConceptSelect={(concept) => {
          setSelectedConcept(concept.id);
          setSelectedLink(null);
          setEditLabel(concept.label);
        }}
        onMapLinkSelect={
          mode === "PRIOR"
            ? (link) => {
                setSelectedLink(link.id);
                setSelectedConcept(null);
                setEditLabel(link.label);
              }
            : undefined
        }
      />
    </>
  );
}
