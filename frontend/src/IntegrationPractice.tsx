import { useEffect } from "react";
import { buildDuplicateConceptDisplayLabels } from "./concept-display-labels";
import {
  ConceptCanvas,
  IntegrationConceptMergeForm,
} from "./MapPage";
import { newClientId } from "./client-identity";
import {
  createInitialIntegrationPracticeProgress,
  isPracticeStepComplete,
  isValidIntegrationPracticeProgress,
  usePracticeProgress,
  type IntegrationPracticeConcept,
} from "./practice-progress";

const practiceMapId = "practice-integration";
const sbPhotosynthesisId = "practice-sb-photosynthesis";
const kbPhotosynthesisId = "practice-kb-photosynthesis";

type PracticeTask = { key: "identify" | "merge" | "submit"; label: string };

const tasks: PracticeTask[] = [
  { key: "identify", label: "同名概念を見分ける" },
  { key: "merge", label: "マージする" },
  { key: "submit", label: "練習内で提出する" },
];

export default function IntegrationPractice({
  sessionId,
  onComplete,
}: {
  sessionId?: string;
  onComplete: (step: "INTEGRATION") => void;
}) {
  const { value: progress, valueRef, update, status, storageBlocked, retry } = usePracticeProgress(
    sessionId,
    "INTEGRATION",
    createInitialIntegrationPracticeProgress,
    isValidIntegrationPracticeProgress,
  );
  const { concepts, completed, submitted } = progress;
  const merged = completed.includes("merge");
  const storageMessage = status === "corrupt"
    ? "この練習の保存データが破損しているため、編集を止めています。『この練習をやり直す』で初期化してください。"
    : status === "unavailable"
      ? "練習の保存領域を確認できません。再試行するか、この練習だけを初期化してください。"
      : status === "write-error"
        ? "練習の変更を保存できませんでした。表示と達成状況は保存前のままです。保存領域を確認してもう一度操作してください。"
        : null;
  const displayLabelsByConceptId = buildDuplicateConceptDisplayLabels(concepts);
  const completedCount = tasks.filter((task) => completed.includes(task.key)).length;
  useEffect(() => {
    if (isPracticeStepComplete("INTEGRATION", progress) && (status === "ready" || status === "disabled")) onComplete("INTEGRATION");
  }, [onComplete, progress, status]);

  function markDone(task: PracticeTask["key"]) {
    update((current) => current.completed.includes(task)
      ? current
      : { ...current, completed: [...current.completed, task] });
  }

  function isExpectedPair(ids: [string, string]) {
    return ids[0] !== ids[1] &&
      ids.includes(sbPhotosynthesisId) &&
      ids.includes(kbPhotosynthesisId);
  }

  function handleMergeSelection(ids: [string, string]) {
    if (isExpectedPair(ids)) markDone("identify");
  }

  async function mergeSelectedConcepts(ids: [string, string], label: string) {
    const currentConcepts = valueRef.current.concepts;
    const currentIds = new Set(currentConcepts.map((concept) => concept.id));
    if (
      !valueRef.current.completed.includes("identify") ||
      !isExpectedPair(ids) ||
      !ids.every((id) => currentIds.has(id)) ||
      !label.trim()
    ) {
      throw new Error("SB由来とKB由来の同名概念を選択してください。");
    }

    const now = new Date().toISOString();
    const mergedConcept: IntegrationPracticeConcept = {
      id: `practice-integration-merged-${newClientId()}`,
      label: label.trim(),
      positionX: Math.round(
        (currentConcepts.find((concept) => concept.id === ids[0])!.positionX +
          currentConcepts.find((concept) => concept.id === ids[1])!.positionX) /
          2,
      ),
      positionY: Math.round(
        (currentConcepts.find((concept) => concept.id === ids[0])!.positionY +
          currentConcepts.find((concept) => concept.id === ids[1])!.positionY) /
          2,
      ),
      createdAt: now,
      updatedAt: now,
      isMergeResult: true,
      practiceOrigin: "MERGED",
      mergedSourceIds: ids,
    };
    const completedTasks = new Set(valueRef.current.completed);
    completedTasks.add("merge");
    completedTasks.add("identify");
    if (!update((current) => ({
      ...current,
      concepts: [...current.concepts.filter((concept) => !ids.includes(concept.id)), mergedConcept],
      completed: [...completedTasks],
    }))) throw new Error("練習状態を保存できませんでした。もう一度お試しください。");
  }

  function submitPractice() {
    if (!merged || submitted || storageBlocked) return;
    if (!update((current) => ({
      ...current,
      submitted: true,
      completed: current.completed.includes("submit") ? current.completed : [...current.completed, "submit"],
    }))) return;
  }

  const sbDisplayName = displayLabelsByConceptId.get(sbPhotosynthesisId);
  const kbDisplayName = displayLabelsByConceptId.get(kbPhotosynthesisId);

  return (
    <>
      <h2 id="tutorial-practice-heading">統合マップの練習</h2>
      <p className="tutorial-practice-description">
        SB由来とKB由来の同名概念を番号で見分け、選択欄の番号を確かめてマージします。番号は表示専用で、概念名には含まれません。
      </p>
      {storageMessage && <p role="alert">{storageMessage}{status === "unavailable" && <button type="button" onClick={retry}>保存を再確認</button>}</p>}
      {sbDisplayName && kbDisplayName ? (
        <p className="tutorial-practice-description" role="note">
          SB由来：{sbDisplayName}{" / "}KB由来：{kbDisplayName}
        </p>
      ) : (
        <p className="tutorial-practice-description" role="status">
          マージ後の概念「光合成」はこの練習画面内に保持されています。
        </p>
      )}
      <section className="tutorial-task-progress" aria-label="操作練習の課題">
        <h3>練習する操作</h3>
        <p role="status">{completedCount} / {tasks.length} 件達成</p>
        <ol>
          {tasks.map((task) => (
            <li key={task.key}>
              <span aria-hidden="true">
                {completed.includes(task.key) ? "✓" : "○"}
              </span>{" "}
              {task.label}
              <span className="tutorial-task-result">
                {completed.includes(task.key) ? "完了" : "未完了"}
              </span>
            </li>
          ))}
        </ol>
      </section>

      <IntegrationConceptMergeForm
        concepts={concepts}
        displayLabelsByConceptId={displayLabelsByConceptId}
        disabled={merged || submitted || storageBlocked}
        localPractice
        onCancel={async () => undefined}
        onSelectionChange={handleMergeSelection}
        onMerge={mergeSelectedConcepts}
      />
      <section className="tutorial-practice-submit" aria-label="練習の提出">
        <button
          type="button"
          className="session-primary-button"
          disabled={!merged || submitted || storageBlocked}
          onClick={submitPractice}
        >
          {submitted ? "練習内で提出済み" : "練習内で提出"}
        </button>
        {submitted && (
          <p role="status">練習内で提出しました。実験Sessionの提出・研究記録には反映されません。</p>
        )}
      </section>

      <ConceptCanvas
        mapId={practiceMapId}
        mapType="INTEGRATION"
        showZoomControls
        concepts={concepts}
        displayLabelsByConceptId={displayLabelsByConceptId}
        links={[]}
        kitDefinitionName={null}
        kitPaletteCopy="kits"
        kitConcepts={[]}
        kitLinks={[]}
        readOnly={storageBlocked}
        canEditConceptStructure={false}
        canEditLinkLabel={false}
        positionSaving={false}
        positionFeedback={null}
        onLabelSave={async () => undefined}
        onConceptDelete={async () => undefined}
        onLinkLabelSave={async () => undefined}
        onLinkReconnect={async () => undefined}
        onLinkDelete={async () => undefined}
        onKitConceptDrop={async () => undefined}
        onKitLinkCreate={async () => undefined}
        onDragStart={() => undefined}
        onPositionSave={async (conceptId, position) => {
          const original = valueRef.current.concepts.find((concept) => concept.id === conceptId);
          const saved = update((current) => ({ ...current, concepts: current.concepts.map((concept) =>
            concept.id === conceptId ? { ...concept, ...position } : concept,
          ) }));
          return saved ? position : original ? { positionX: original.positionX, positionY: original.positionY } : position;
        }}
      />
    </>
  );
}
