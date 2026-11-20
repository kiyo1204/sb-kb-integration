import { useCallback, useEffect, useState, type FormEvent } from "react";
import { ConceptCanvas } from "./MapPage";
import IntegrationPractice from "./IntegrationPractice";
import { markPracticeCompleted } from "./practice-completion";

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

type PracticeMode = "PRIOR" | "KB";
type PracticeStep = PracticeMode | "INTEGRATION";
const practiceSteps: { mode: PracticeStep; label: string }[] = [
  { mode: "PRIOR", label: "Scratch-Buildの練習" },
  { mode: "KB", label: "Kit-Buildの練習" },
  { mode: "INTEGRATION", label: "統合マップの練習" },
];
type PracticeTask = { key: string; label: string };
// Guidance only: no research events, network calls, persistence, or grading.
const practiceTasks: Record<PracticeMode, PracticeTask[]> = {
  PRIOR: [
    { key: "concept.add", label: "概念を追加する" },
    { key: "concept.rename", label: "概念の名前を変更する" },
    { key: "concept.move", label: "概念をドラッグで移動する" },
    { key: "link.add", label: "リンクの両端をつないで作成する" },
    { key: "link.reconnect", label: "リンクの接続先を変更する" },
    { key: "element.delete", label: "概念またはリンクを削除する" },
  ],
  KB: [
    { key: "kit.concept", label: "Kitの概念を配置する" },
    { key: "kit.link", label: "Kitのリンクを配置して両端を接続する" },
    { key: "link.reconnect", label: "リンクの接続先を変更する" },
  ],
};

export default function TutorialPage({ returnHref, onExit, onCancel }: { returnHref: string; onExit?: () => void; onCancel?: () => void }) {
  const [mode, setMode] = useState<PracticeStep>("PRIOR");
  const [visitedSteps, setVisitedSteps] = useState<PracticeStep[]>(["PRIOR"]);
  const [completedSteps, setCompletedSteps] = useState<PracticeStep[]>([]);
  const completeStep = useCallback((step: PracticeStep) => {
    setCompletedSteps((current) =>
      current.includes(step) ? current : [...current, step],
    );
  }, []);
  const currentIndex = practiceSteps.findIndex((step) => step.mode === mode);
  const nextStep = practiceSteps[currentIndex + 1];
  const currentCompleted = completedSteps.includes(mode);
  const allCompleted = practiceSteps.every((step) => completedSteps.includes(step.mode));
  const canOpen = (index: number) =>
    practiceSteps.slice(0, index).every((step) => completedSteps.includes(step.mode));

  function advanceTo(step: PracticeStep) {
    const index = practiceSteps.findIndex((candidate) => candidate.mode === step);
    if (index < 0 || !canOpen(index)) return;
    setVisitedSteps((current) => current.includes(step) ? current : [...current, step]);
    setMode(step);
  }

  function finishPractice() {
    if (!allCompleted) return;
    const match = /^\/sessions\/([a-f0-9-]{36})$/.exec(returnHref);
    if (match) markPracticeCompleted(match[1]);
    if (onExit) onExit();
    else window.location.assign(returnHref);
  }

  return (
    <main className="page tutorial-page">
      <section className="session-card tutorial-card">
        <header className="tutorial-heading">
          <p className="home-card-kicker">通常の学習Sessionとは別の練習</p>
          <h1>操作の練習</h1>
          <p className="tutorial-practice-note">
            練習用のMapと達成状況はこの画面内だけで扱い、サーバーや学習Sessionの記録には保存しません。Scratch-Build → Kit-Build → 統合マップの順で、各段階のすべての操作を完了すると次へ進めます。完了した段階へはいつでも戻り、練習内容を続けて確認できます。すべての段階を達成すると「練習を終了」からセッションの案内へ戻れます。
          </p>
        </header>

        <nav
          className="assessment-actions tutorial-controls"
          aria-label="練習モードと操作"
        >
          {practiceSteps.map((step, index) => (
            <button
              key={step.mode}
              type="button"
              className={
                mode === step.mode
                  ? "session-primary-button"
                  : "session-secondary-button"
              }
              aria-label={step.label}
              aria-pressed={mode === step.mode}
              aria-current={mode === step.mode ? "step" : undefined}
              disabled={!canOpen(index)}
              onClick={() => advanceTo(step.mode)}
            >
              {step.label}
              {completedSteps.includes(step.mode) && (
                <span className="tutorial-step-done" aria-hidden="true"> ✓</span>
              )}
            </button>
          ))}
          {onCancel && !allCompleted && (
            <button
              type="button"
              className="session-secondary-button"
              onClick={onCancel}
            >
              案内へ戻る（練習未完了）
            </button>
          )}
          <button
            type="button"
            className="session-secondary-button"
            disabled={!allCompleted}
            onClick={finishPractice}
          >
            練習を終了
          </button>
        </nav>

        <div className="tutorial-stage-progress" aria-label="練習の進行">
          <p role="status">
            ステップ {currentIndex + 1} / {practiceSteps.length}：
            {currentCompleted
              ? "このマップの操作タスクをすべて達成しました。"
              : "すべての操作タスクを達成すると次へ進めます。"}
          </p>
          {nextStep ? (
            <button
              type="button"
              className="session-primary-button"
              disabled={!currentCompleted}
              onClick={() => advanceTo(nextStep.mode)}
            >
              次へ：{nextStep.label}
            </button>
          ) : currentCompleted ? (
            <p className="tutorial-all-complete" role="status">
              すべてのマップの操作練習が完了しました。
            </p>
          ) : null}
        </div>

        <section
          className="tutorial-practice-area"
          aria-labelledby="tutorial-practice-heading"
        >
          {practiceSteps.filter((step) => visitedSteps.includes(step.mode)).map((step) => (
            <div
              key={step.mode}
              className="tutorial-practice-panel"
              hidden={mode !== step.mode}
              inert={mode !== step.mode}
            >
              {step.mode === "INTEGRATION" ? (
                <IntegrationPractice onComplete={completeStep} />
              ) : (
                <PracticeCanvas mode={step.mode} onComplete={completeStep} />
              )}
            </div>
          ))}
        </section>
      </section>
    </main>
  );
}

function PracticeCanvas({
  mode,
  onComplete,
}: {
  mode: PracticeMode;
  onComplete: (step: PracticeStep) => void;
}) {
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
  const [completedTasks, setCompletedTasks] = useState<string[]>([]);
  const tasks = practiceTasks[mode];
  const allTasksComplete = tasks.every((task) => completedTasks.includes(task.key));
  useEffect(() => {
    if (allTasksComplete) onComplete(mode);
  }, [allTasksComplete, mode, onComplete]);
  const complete = (key: string) =>
    setCompletedTasks((current) =>
      current.includes(key) ? current : [...current, key],
    );

  function addConcept(label: string, positionX: number, positionY: number) {
    setConcepts((list) => [
      ...list,
      { id: id(), label, positionX, positionY, createdAt: "", updatedAt: "" },
    ]);
    if (mode === "PRIOR") complete("concept.add");
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
    complete(mode === "PRIOR" ? "link.add" : "kit.link");
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
        {mode === "PRIOR" ? "Scratch-Buildの練習" : "Kit-Buildの練習"}
      </h2>
      <p className="tutorial-practice-description">
        {instructions} 矢印の先が関係先です。
      </p>
      <section className="tutorial-task-progress" aria-label="操作練習の課題">
        <h3>練習する操作</h3>
        <p role="status">
          {tasks.filter((task) => completedTasks.includes(task.key)).length} / {tasks.length} 件達成
        </p>
        <ol>
          {tasks.map((task) => (
            <li key={task.key}>
              <span aria-hidden="true">
                {completedTasks.includes(task.key) ? "✓" : "○"}
              </span>{" "}
              {task.label}
              <span className="tutorial-task-result">
                {completedTasks.includes(task.key) ? "完了" : "未完了"}
              </span>
            </li>
          ))}
        </ol>
        <p>課題は練習画面内で実際に操作を完了したときだけ達成扱いです。学習成績ではありません。</p>
      </section>

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
              const previous = concepts.find((c) => c.id === selectedConcept);
              if (previous && previous.label !== editLabel.trim())
                complete("concept.rename");
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
          {mode === "PRIOR" && (
            <button
              type="button"
              className="session-secondary-button"
              onClick={() => {
                if (selectedConcept && concepts.some((c) => c.id === selectedConcept)) {
                  setConcepts((list) => list.filter((c) => c.id !== selectedConcept));
                  setLinks((list) => list.filter((link) =>
                    link.sourceConceptId !== selectedConcept &&
                    link.targetConceptId !== selectedConcept,
                  ));
                  complete("element.delete");
                } else if (selectedLink && links.some((link) => link.id === selectedLink)) {
                  setLinks((list) => list.filter((link) => link.id !== selectedLink));
                  complete("element.delete");
                }
                setSelectedConcept(null);
                setSelectedLink(null);
              }}
            >
              選択した要素を削除
            </button>
          )}
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
        onLabelSave={async (conceptId, label) => {
          const previous = concepts.find((concept) => concept.id === conceptId);
          if (mode === "PRIOR" && previous && previous.label !== label)
            complete("concept.rename");
          setConcepts((list) =>
            list.map((concept) =>
              concept.id === conceptId ? { ...concept, label } : concept,
            ),
          );
        }}
        onConceptDelete={async (conceptId) => {
          if (mode === "PRIOR" && concepts.some((c) => c.id === conceptId))
            complete("element.delete");
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
        onLinkReconnect={async (link, sourceConceptId, targetConceptId) => {
          if (
            links.some((candidate) => candidate.id === link.id) &&
            (link.sourceConceptId !== sourceConceptId ||
              link.targetConceptId !== targetConceptId)
          ) {
            complete("link.reconnect");
          }
          setLinks((list) =>
            list.map((candidate) =>
              candidate.id === link.id
                ? { ...candidate, sourceConceptId, targetConceptId }
                : candidate,
            ),
          );
        }}
        onLinkDelete={async (linkId) => {
          if (mode === "PRIOR" && links.some((link) => link.id === linkId))
            complete("element.delete");
          setLinks((list) => list.filter((link) => link.id !== linkId));
        }}
        onKitConceptDrop={async (itemId, position) => {
          const item = kitConcepts.find(
            (concept) => concept.kitConceptItemId === itemId,
          );
          if (item && !usedConcepts.includes(itemId)) {
            addConcept(item.label, position.positionX, position.positionY);
            setUsedConcepts((list) => [...list, itemId]);
            complete("kit.concept");
          }
        }}
        onKitLinkCreate={async (_mapId, itemId, source, target) => {
          const item = kitLinks.find((link) => link.kitLinkItemId === itemId);
          if (!item) return;
          setUsedLinks((list) => [...list, itemId]);
          return createLink(source, target, item.label);
        }}
        onDragStart={() => undefined}
        onPositionSave={async (conceptId, position, originalPosition) => {
          if (
            mode === "PRIOR" &&
            (position.positionX !== originalPosition.positionX ||
              position.positionY !== originalPosition.positionY)
          ) complete("concept.move");
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
