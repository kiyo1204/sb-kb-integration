import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import {
  ConceptCanvas,
  KitBuildFeedbackCheckButton,
  KitBuildFeedbackResultDisplay,
} from "./MapPage";
import IntegrationPractice from "./IntegrationPractice";
import { clearPracticeCompleted, markPracticeCompleted } from "./practice-completion";
import { newClientId } from "./client-identity";
import {
  createInitialIntegrationPracticeProgress,
  createInitialKitPracticeProgress,
  createInitialSbPracticeProgress,
  isPracticeStepComplete,
  isValidIntegrationPracticeProgress,
  isValidKitPracticeProgress,
  isValidPracticeNavigation,
  isValidSbPracticeProgress,
  getPracticeOwnerDigest,
  kitPracticeMapSignature,
  readPracticeRecord,
  removePracticeRecord,
  usePracticeProgress,
  writePracticeRecord,
  photosynthesisKitConcepts,
  photosynthesisKitLinks,
  type KitConceptPlacement,
  type KitLinkPlacement,
  type KitPracticeProgress,
  type KitPracticeResult,
  type PracticeStep,
} from "./practice-progress";

const mapId = "practice";
const id = () => `practice-${newClientId()}`;
const practiceSteps: { mode: PracticeStep; label: string }[] = [
  { mode: "PRIOR", label: "Scratch-Buildの練習" },
  { mode: "KB", label: "Kit-Buildの練習" },
  { mode: "INTEGRATION", label: "統合マップの練習" },
];
type SbPracticeTask = { key: "concept.add" | "concept.move" | "link.add"; label: string };
type KitPracticeTask = { key: "kit.place" | "kit.judge" | "kit.correct" | "kit.rejudge"; label: string };
const sbPracticeTasks: SbPracticeTask[] = [
  { key: "concept.add", label: "概念を追加する" },
  { key: "concept.move", label: "概念を移動する" },
  { key: "link.add", label: "リンクを接続する" },
];

// The browser receives palette labels and opaque item IDs only. The fixed goal
// graph and its correct endpoints remain in backend/src/tutorial-kit-practice.ts.
const photosynthesisPracticeTasks: KitPracticeTask[] = [
  { key: "kit.place", label: "部品を配置する" },
  { key: "kit.judge", label: "配置後に一致状況を確認する" },
  { key: "kit.correct", label: "不一致を修正する" },
  { key: "kit.rejudge", label: "再判定で一致する" },
];

type TutorialPageProps = {
  returnHref: string;
  practiceSessionId?: string;
  onExit?: () => void;
  onCancel?: () => void;
  onProgressReset?: () => void;
};

export default function TutorialPage({
  returnHref,
  practiceSessionId,
  onExit,
  onCancel,
  onProgressReset,
}: TutorialPageProps) {
  const [ownerDigest] = useState(getPracticeOwnerDigest);
  const [initialProgress] = useState(() => ({
    sb: readPracticeRecord(practiceSessionId, "PRIOR", createInitialSbPracticeProgress, isValidSbPracticeProgress, ownerDigest),
    kb: readPracticeRecord(practiceSessionId, "KB", createInitialKitPracticeProgress, isValidKitPracticeProgress, ownerDigest),
    integration: readPracticeRecord(practiceSessionId, "INTEGRATION", createInitialIntegrationPracticeProgress, isValidIntegrationPracticeProgress, ownerDigest),
    navigation: readPracticeRecord(practiceSessionId, "navigation", () => ({ mode: "PRIOR" as PracticeStep }), isValidPracticeNavigation, ownerDigest),
  }));
  const initialCompleted = practiceSteps
    .filter((step) => isPracticeStepComplete(step.mode, initialProgress[step.mode === "PRIOR" ? "sb" : step.mode === "KB" ? "kb" : "integration"].value))
    .map((step) => step.mode);
  const firstIncomplete = practiceSteps.find((step) => !initialCompleted.includes(step.mode))?.mode ?? "INTEGRATION";
  const initialMode = initialProgress.navigation.status === "ready" &&
    practiceSteps.findIndex((step) => step.mode === initialProgress.navigation.value.mode) <=
      practiceSteps.findIndex((step) => step.mode === firstIncomplete)
    ? initialProgress.navigation.value.mode
    : firstIncomplete;
  const [mode, setMode] = useState<PracticeStep>(initialMode);
  const [visitedSteps, setVisitedSteps] = useState<PracticeStep[]>(() => {
    const currentIndex = practiceSteps.findIndex((step) => step.mode === initialMode);
    return practiceSteps.slice(0, currentIndex + 1).map((step) => step.mode);
  });
  const [completedSteps, setCompletedSteps] = useState<PracticeStep[]>(initialCompleted);
  const [resetVersions, setResetVersions] = useState<Record<PracticeStep, number>>({ PRIOR: 0, KB: 0, INTEGRATION: 0 });
  const [storageNotice, setStorageNotice] = useState<string | null>(() => {
    if (practiceSessionId && !ownerDigest) return "本人確認を確認できないため、練習の保存・復元を利用できません。画面を再確認してください。";
    const statuses = Object.values(initialProgress).map((record) => record.status);
    if (statuses.includes("corrupt")) return "保存された練習データを読み取れません。正しく復元できないため、対象の練習をやり直してください。";
    if (statuses.includes("unavailable")) return "練習データを保存領域から読み取れません。保存領域を確認して再試行してください。";
    return null;
  });
  const [finishError, setFinishError] = useState<string | null>(null);
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
    if (practiceSessionId) {
      if (getPracticeOwnerDigest() !== ownerDigest ||
        !writePracticeRecord(practiceSessionId, "navigation", { mode: step }, ownerDigest)) {
        setStorageNotice("練習の再開位置を保存できませんでした。現在の進捗はこの画面を閉じると復元できない場合があります。");
      } else {
        setStorageNotice(null);
      }
    }
    setVisitedSteps((current) => current.includes(step) ? current : [...current, step]);
    setMode(step);
  }

  function finishPractice() {
    if (!allCompleted) return;
    if (practiceSessionId && getPracticeOwnerDigest() !== ownerDigest) {
      setFinishError("認証状態が変わったため、練習を終了できません。利用状態を再確認してください。");
      return;
    }
    const match = /^\/sessions\/([a-f0-9-]{36})$/.exec(returnHref);
    const completionSessionId = practiceSessionId ?? match?.[1];
    if (completionSessionId && !markPracticeCompleted(completionSessionId)) {
      setFinishError("練習完了を保存できませんでした。保存領域を確認してから再度お試しください。");
      return;
    }
    setFinishError(null);
    if (onExit) onExit();
    else window.location.assign(returnHref);
  }

  function resetCurrentPractice() {
    if (!window.confirm("この練習のMapと達成状況を初期化しますか？他の練習は保持されます。")) return;
    if (practiceSessionId && getPracticeOwnerDigest() !== ownerDigest) {
      setStorageNotice("認証状態が変わったため、練習を初期化できません。利用状態を再確認してください。");
      return;
    }
    const completionSessionId = practiceSessionId ?? /^\/sessions\/([a-f0-9-]{36})$/.exec(returnHref)?.[1];
    if (completionSessionId && !clearPracticeCompleted(completionSessionId)) {
      setStorageNotice("練習の開始条件を初期化できませんでした。保存領域を確認してください。");
      return;
    }
    if (!removePracticeRecord(practiceSessionId, mode, ownerDigest)) {
      setStorageNotice("この練習を初期化できませんでした。保存領域を確認してください。");
      return;
    }
    setCompletedSteps((current) => current.filter((step) => step !== mode));
    setResetVersions((current) => ({ ...current, [mode]: current[mode] + 1 }));
    setStorageNotice(null);
    setFinishError(null);
    onProgressReset?.();
  }

  return (
    <main className="page tutorial-page">
      <section className="session-card tutorial-card">
        <header className="tutorial-heading">
          <p className="home-card-kicker">通常の学習Sessionとは別の練習</p>
          <h1>操作の練習</h1>
          <p className="tutorial-practice-note">
            Scratch-Build → Kit-Build → 統合マップの順で、各段階のすべての操作を完了すると次へ進めます。完了した段階へはいつでも戻り、練習内容を続けて確認できます。
          </p>
          {practiceSessionId && <p className="tutorial-practice-description" role="note">練習のMapと達成状況は、このタブ内で本人の利用中Sessionごとに保存します。別の参加者・タブ・端末へは引き継ぎません。</p>}
          {storageNotice && <p role="alert">{storageNotice}</p>}
          {finishError && <p role="alert">{finishError}</p>}
        </header>

        <nav
          className="assessment-actions tutorial-controls"
          aria-label="練習モードと操作"
        >
          {practiceSteps.map((step, index) => (
            <button
              key={`${practiceSessionId ?? "standalone"}:${ownerDigest ?? "unverified"}:${step.mode}`}
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
          <button type="button" className="session-secondary-button" onClick={resetCurrentPractice}>
            この練習をやり直す
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
                <IntegrationPractice key={`${practiceSessionId ?? "standalone"}:${ownerDigest ?? "unverified"}:INTEGRATION:${resetVersions.INTEGRATION}`} sessionId={practiceSessionId} onComplete={completeStep} />
              ) : step.mode === "PRIOR" ? (
                <SbPracticeCanvas key={`${practiceSessionId ?? "standalone"}:${ownerDigest ?? "unverified"}:PRIOR:${resetVersions.PRIOR}`} sessionId={practiceSessionId} onComplete={completeStep} />
              ) : (
                <KitPracticeCanvas
                  key={`${practiceSessionId ?? "standalone"}:${ownerDigest ?? "unverified"}:KB:${resetVersions.KB}`}
                  active={mode === "KB"}
                  sessionId={practiceSessionId}
                  onComplete={completeStep}
                />
              )}
            </div>
          ))}
        </section>
      </section>
    </main>
  );
}

type SbPracticeDrawer =
  | { kind: "closed" }
  | { kind: "add-concept" }
  | { kind: "add-link" }
  | { kind: "edit-concept"; conceptId: string }
  | { kind: "edit-link"; linkId: string };

function SbPracticeCanvas({
  sessionId,
  onComplete,
}: {
  sessionId?: string;
  onComplete: (step: PracticeStep) => void;
}) {
  const { value: progress, update, status, storageBlocked, retry } = usePracticeProgress(
    sessionId,
    "PRIOR",
    createInitialSbPracticeProgress,
    isValidSbPracticeProgress,
  );
  const { concepts, links, linkCreation, completedTasks } = progress;
  const [drawer, setDrawer] = useState<SbPracticeDrawer>({ kind: "closed" });
  const [conceptLabel, setConceptLabel] = useState("");
  const [linkLabel, setLinkLabel] = useState("");
  const [editLabel, setEditLabel] = useState("");
  const tasks = sbPracticeTasks;
  const allTasksComplete = tasks.every((task) => completedTasks.includes(task.key));
  useEffect(() => {
    if (allTasksComplete && (status === "ready" || status === "disabled")) onComplete("PRIOR");
  }, [allTasksComplete, onComplete, status]);

  const activeConcept = drawer.kind === "edit-concept"
    ? concepts.find((concept) => concept.id === drawer.conceptId)
    : undefined;
  const activeLink = drawer.kind === "edit-link"
    ? links.find((link) => link.id === drawer.linkId)
    : undefined;

  const storageMessage = status === "corrupt"
    ? "この練習の保存データが破損しているため、編集を止めています。『この練習をやり直す』で初期化してください。"
    : status === "unavailable"
      ? "練習の保存領域を確認できません。再試行するか、この練習だけを初期化してください。"
      : status === "write-error"
        ? "練習の変更を保存できませんでした。表示と達成状況は保存前のままです。保存領域を確認してもう一度操作してください。"
        : null;

  function addConcept(event: FormEvent) {
    event.preventDefault();
    const label = conceptLabel.trim();
    if (!label) return;
    const saved = update((current) => ({
      ...current,
      concepts: [...current.concepts, {
        id: id(),
        label,
        positionX: 80 + (current.concepts.length % 4) * 200,
        positionY: 80 + Math.floor(current.concepts.length / 4) * 130,
        createdAt: "",
        updatedAt: "",
      }],
      completedTasks: current.completedTasks.includes("concept.add")
        ? current.completedTasks
        : [...current.completedTasks, "concept.add"],
    }));
    if (!saved) return;
    setConceptLabel("");
    setDrawer({ kind: "closed" });
  }

  function startLinkCreation(event: FormEvent) {
    event.preventDefault();
    const label = linkLabel.trim();
    if (!label || linkCreation) return;
    if (!update((current) => ({ ...current, linkCreation: { id: id(), label } }))) return;
    setLinkLabel("");
    setDrawer({ kind: "closed" });
  }

  function createConnectedLink(sourceConceptId: string, targetConceptId: string, label: string) {
    const linkId = linkCreation?.id ?? id();
    const saved = update((current) => ({
      ...current,
      links: [...current.links, { id: linkId, mapId, sourceConceptId, targetConceptId, label }],
      linkCreation: null,
      completedTasks: current.completedTasks.includes("link.add")
        ? current.completedTasks
        : [...current.completedTasks, "link.add"],
    }));
    if (!saved) return "";
    return linkId;
  }

  function saveSelection(event: FormEvent) {
    event.preventDefault();
    const label = editLabel.trim();
    if (!label) return;
    if (!update((current) => ({
      ...current,
      concepts: activeConcept ? current.concepts.map((concept) => concept.id === activeConcept.id ? { ...concept, label } : concept) : current.concepts,
      links: activeLink ? current.links.map((link) => link.id === activeLink.id ? { ...link, label } : link) : current.links,
    }))) return;
    setDrawer({ kind: "closed" });
  }

  function deleteSelection() {
    if (activeConcept) {
      const conceptId = activeConcept.id;
      update((current) => ({
        ...current,
        concepts: current.concepts.filter((concept) => concept.id !== conceptId),
        links: current.links.filter((link) => link.sourceConceptId !== conceptId && link.targetConceptId !== conceptId),
      }));
    } else if (activeLink) {
      update((current) => ({ ...current, links: current.links.filter((link) => link.id !== activeLink.id) }));
    }
    setDrawer({ kind: "closed" });
  }

  return (
    <>
      <h2 id="tutorial-practice-heading">Scratch-Buildの練習</h2>
      <p className="tutorial-practice-description">
        概念を追加してドラッグで移動し、リンクの両端を概念へ接続します。矢印の先が関係先です。
      </p>
      {storageMessage && <p role="alert">{storageMessage}{status === "unavailable" && <button type="button" onClick={retry}>保存を再確認</button>}</p>}
      <section className="tutorial-task-progress" aria-label="操作練習の課題">
        <h3>練習する操作</h3>
        <p role="status">
          {tasks.filter((task) => completedTasks.includes(task.key)).length} / {tasks.length} 件達成
        </p>
        <ol>
          {tasks.map((task) => (
            <li key={task.key}>
              <span aria-hidden="true">{completedTasks.includes(task.key) ? "✓" : "○"}</span>{" "}
              {task.label}
              <span className="tutorial-task-result">
                {completedTasks.includes(task.key) ? "完了" : "未完了"}
              </span>
            </li>
          ))}
        </ol>
        <p>課題は練習画面内で実際に操作を完了したときだけ達成扱いです。学習成績ではありません。</p>
      </section>

      <div className="map-editor-page is-experiment is-prior is-learner tutorial-map-editor">
        <div className="map-editor-header-actions">
          <div className="map-editor-tools" aria-label="マップ操作">
            <span>追加</span>
            <button
              type="button"
              disabled={storageBlocked}
              onClick={() => {
                setConceptLabel("");
                setDrawer({ kind: "add-concept" });
              }}
            >
              ＋ 概念
            </button>
            <button
              type="button"
              disabled={!!linkCreation || storageBlocked}
              onClick={() => {
                setLinkLabel("");
                setDrawer({ kind: "add-link" });
              }}
            >
              ＋ リンク
            </button>
          </div>
        </div>

        {linkCreation && (
          <div className="map-editor-link-creation-status" role="status">
            <span>
              「{linkCreation.label}」の中央をドラッグして配置し、両端を概念へ接続してください。
            </span>
            <button type="button" onClick={() => update((current) => ({ ...current, linkCreation: null }))}>
              キャンセル
            </button>
          </div>
        )}

        <div
          className={`map-editor-workspace${drawer.kind !== "closed" ? " has-drawer" : ""}${drawer.kind === "edit-link" ? " is-sb-link-selection" : ""}`}
        >
          <div className="map-editor-canvas-column">
            <ConceptCanvas
              mapId={mapId}
              mapType="PRIOR"
              showZoomControls
              concepts={concepts}
              links={links}
              kitDefinitionName={null}
              kitPaletteCopy="kits"
              kitConcepts={[]}
              kitLinks={[]}
              readOnly={storageBlocked}
              canEditConceptStructure
              canEditLinkLabel
              positionSaving={false}
              positionFeedback={null}
              onLabelSave={async (conceptId, label) => {
                update((current) => ({ ...current, concepts: current.concepts.map((concept) => concept.id === conceptId ? { ...concept, label } : concept) }));
              }}
              onConceptDelete={async (conceptId) => {
                update((current) => ({ ...current,
                  concepts: current.concepts.filter((concept) => concept.id !== conceptId),
                  links: current.links.filter((link) => link.sourceConceptId !== conceptId && link.targetConceptId !== conceptId),
                }));
              }}
              onLinkLabelSave={async (link, label) => {
                update((current) => ({ ...current, links: current.links.map((candidate) => candidate.id === link.id ? { ...candidate, label } : candidate) }));
              }}
              onLinkReconnect={async (link, sourceConceptId, targetConceptId) => {
                update((current) => ({ ...current, links: current.links.map((candidate) => candidate.id === link.id ? { ...candidate, sourceConceptId, targetConceptId } : candidate) }));
              }}
              onLinkDelete={async (linkId) => {
                update((current) => ({ ...current, links: current.links.filter((link) => link.id !== linkId) }));
              }}
              onKitConceptDrop={async () => undefined}
              onKitLinkCreate={async () => undefined}
              onDragStart={() => undefined}
              onPositionSave={async (conceptId, position, originalPosition) => {
                if (
                  position.positionX !== originalPosition.positionX ||
                  position.positionY !== originalPosition.positionY
                ) {
                  const saved = update((current) => ({
                    ...current,
                    concepts: current.concepts.map((concept) => concept.id === conceptId ? { ...concept, ...position } : concept),
                    completedTasks: current.completedTasks.includes("concept.move") ? current.completedTasks : [...current.completedTasks, "concept.move"],
                  }));
                  return saved ? position : originalPosition;
                }
                const saved = update((current) => ({ ...current, concepts: current.concepts.map((concept) => concept.id === conceptId ? { ...concept, ...position } : concept) }));
                return saved ? position : originalPosition;
              }}
              linkCreation={linkCreation}
              onMapLinkCreate={async (source, target, label) =>
                createConnectedLink(source, target, label)
              }
              onMapLinkCreationCancel={() => update((current) => ({ ...current, linkCreation: null }))}
              onMapConceptSelect={(concept) => {
                if (linkCreation) return;
                setEditLabel(concept.label);
                setDrawer({ kind: "edit-concept", conceptId: concept.id });
              }}
              onMapLinkSelect={(link) => {
                if (linkCreation) return;
                setEditLabel(link.label);
                setDrawer({ kind: "edit-link", linkId: link.id });
              }}
            />
          </div>

          {drawer.kind !== "closed" && (
            <aside className="map-editor-drawer" aria-label="マップ編集">
              <div className="map-editor-drawer-heading">
                <h2>
                  {drawer.kind === "add-concept"
                    ? "概念を追加"
                    : drawer.kind === "add-link"
                      ? "リンクを追加"
                      : drawer.kind === "edit-concept"
                        ? "概念を編集"
                        : "リンクを編集"}
                </h2>
                <button
                  type="button"
                  aria-label="編集を閉じる"
                  onClick={() => setDrawer({ kind: "closed" })}
                >
                  ×
                </button>
              </div>

              {drawer.kind === "add-concept" && (
                <form className="map-editor-drawer-form" onSubmit={addConcept}>
                  <label htmlFor="tutorial-sb-concept-name">概念名</label>
                  <input
                    id="tutorial-sb-concept-name"
                    type="text"
                    autoComplete="off"
                    autoFocus
                    value={conceptLabel}
                    onChange={(event) => setConceptLabel(event.target.value)}
                    required
                  />
                  <div className="map-editor-drawer-actions">
                    <button type="button" className="is-secondary" onClick={() => setDrawer({ kind: "closed" })}>
                      キャンセル
                    </button>
                    <button type="submit" disabled={!conceptLabel.trim()}>
                      概念を追加
                    </button>
                  </div>
                </form>
              )}

              {drawer.kind === "add-link" && (
                <form className="map-editor-drawer-form" onSubmit={startLinkCreation}>
                  <label htmlFor="tutorial-sb-link-label">リンクラベル</label>
                  <input
                    id="tutorial-sb-link-label"
                    type="text"
                    autoComplete="off"
                    autoFocus
                    value={linkLabel}
                    onChange={(event) => setLinkLabel(event.target.value)}
                    required
                  />
                  <p className="map-editor-drawer-hint">
                    接続を開始した後、リンクの両端を概念へドラッグします。
                  </p>
                  <div className="map-editor-drawer-actions">
                    <button type="button" className="is-secondary" onClick={() => setDrawer({ kind: "closed" })}>
                      キャンセル
                    </button>
                    <button type="submit" disabled={!linkLabel.trim()}>
                      接続を開始
                    </button>
                  </div>
                </form>
              )}

              {(drawer.kind === "edit-concept" || drawer.kind === "edit-link") && (
                <form className="map-editor-drawer-form" onSubmit={saveSelection}>
                  {drawer.kind === "edit-concept" && activeConcept ? (
                    <>
                      <p className="map-editor-drawer-hint">
                        選択中の概念：<strong>{activeConcept.label}</strong>。削除すると、この概念に接続するリンク
                        {links.filter((link) => link.sourceConceptId === activeConcept.id || link.targetConceptId === activeConcept.id).length}件も削除されます。
                      </p>
                      <label htmlFor="tutorial-sb-concept-edit-label">概念名</label>
                      <input
                        id="tutorial-sb-concept-edit-label"
                        type="text"
                        autoComplete="off"
                        value={editLabel}
                        onChange={(event) => setEditLabel(event.target.value)}
                        required
                      />
                    </>
                  ) : activeLink ? (
                    <>
                      <p className="map-editor-drawer-hint">
                        選択中のリンク：<strong>{activeLink.label}</strong>
                      </p>
                      <label htmlFor="tutorial-sb-link-edit-label">リンクラベル</label>
                      <input
                        id="tutorial-sb-link-edit-label"
                        type="text"
                        autoComplete="off"
                        value={editLabel}
                        onChange={(event) => setEditLabel(event.target.value)}
                        required
                      />
                      <p className="map-editor-drawer-hint">
                        接続元・接続先はCanvas上のLink handleをドラッグして変更できます。
                      </p>
                    </>
                  ) : null}
                  <div className="map-editor-drawer-actions">
                    <button type="button" className="is-danger" onClick={deleteSelection}>
                      {drawer.kind === "edit-concept" ? "削除" : "Linkを削除"}
                    </button>
                    <button type="submit" disabled={!editLabel.trim()}>
                      保存
                    </button>
                  </div>
                </form>
              )}
            </aside>
          )}
        </div>
      </div>
    </>
  );
}

function readKitPracticeResult(value: unknown): KitPracticeResult | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const result = value as Record<string, unknown>;
  if (
    Object.keys(result).length !== 3 ||
    !Object.hasOwn(result, "matched") ||
    !Object.hasOwn(result, "concepts") ||
    !Object.hasOwn(result, "relations") ||
    typeof result.matched !== "boolean"
  ) return null;
  const readCount = (candidate: unknown, total: number) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
    const count = candidate as Record<string, unknown>;
    if (
      Object.keys(count).length !== 2 ||
      !Object.hasOwn(count, "matched") ||
      !Object.hasOwn(count, "total") ||
      count.total !== total ||
      !Number.isInteger(count.matched) ||
      (count.matched as number) < 0 ||
      (count.matched as number) > total
    ) return null;
    return { matched: count.matched as number, total };
  };
  const concepts = readCount(result.concepts, 3);
  const relations = readCount(result.relations, 2);
  if (!concepts || !relations) return null;
  if (result.matched && (concepts.matched !== 3 || relations.matched !== 2)) return null;
  return { matched: result.matched, concepts, relations };
}

function KitPracticeCanvas({
  active,
  sessionId,
  onComplete,
}: {
  active: boolean;
  sessionId?: string;
  onComplete: (step: PracticeStep) => void;
}) {
  const { value: progress, valueRef, update, status, storageBlocked, retry } = usePracticeProgress(
    sessionId,
    "KB",
    createInitialKitPracticeProgress,
    isValidKitPracticeProgress,
  );
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const requestId = useRef(0);
  const { placedConcepts, placedLinks, completedTasks, hasFullPlacementMismatch, correctedAfterMismatch } = progress;
  const concepts = placedConcepts.map(({ concept }) => concept);
  const links = placedLinks.map(({ link }) => link);
  const allPartsPlaced = placedConcepts.length === 3 && placedLinks.length === 2;
  const mapSignature = kitPracticeMapSignature(progress);
  const result = !checking && progress.lastResult?.mapSignature === mapSignature
    ? progress.lastResult.result
    : null;
  const completedCount = photosynthesisPracticeTasks.filter((task) =>
    completedTasks.includes(task.key),
  ).length;
  useEffect(() => {
    if (isPracticeStepComplete("KB", progress) && (status === "ready" || status === "disabled")) onComplete("KB");
  }, [onComplete, progress, status]);

  useEffect(() => {
    return () => {
      requestId.current += 1;
    };
  }, [active]);

  const storageMessage = status === "corrupt"
    ? "この練習の保存データが破損しているため、編集を止めています。『この練習をやり直す』で初期化してください。"
    : status === "unavailable"
      ? "練習の保存領域を確認できません。再試行するか、この練習だけを初期化してください。"
      : status === "write-error"
        ? "練習の変更を保存できませんでした。表示と達成状況は保存前のままです。保存領域を確認してもう一度操作してください。"
        : null;

  async function checkKit() {
    if (!active || checking) return;
    const currentRequest = ++requestId.current;
    const judgedMapSignature = mapSignature;
    setChecking(true);
    setError(null);
    const body = {
      concepts: placedConcepts.map(({ kitConceptItemId, concept }) => ({
        kitConceptItemId,
        id: concept.id,
      })),
      links: placedLinks.map(({ kitLinkItemId, link }) => ({
        kitLinkItemId,
        id: link.id,
        sourceConceptId: link.sourceConceptId,
        targetConceptId: link.targetConceptId,
      })),
    };
    try {
      const response = await fetch("/api/tutorial/kit-practice/check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload: unknown = await response.json();
      if (!response.ok) throw new Error("判定を完了できませんでした。もう一度お試しください。");
      const next = readKitPracticeResult(payload);
      if (!next) throw new Error("判定結果を読み取れませんでした。もう一度お試しください。");
      if (requestId.current !== currentRequest || !active || kitPracticeMapSignature(valueRef.current) !== judgedMapSignature) return;
      let isCompleted = false;
      const saved = update((current) => {
        const isFullMismatch = allPartsPlaced && !next.matched &&
          next.concepts.matched === 3 && next.relations.matched === 1;
        const successfulRejudge = next.matched && current.hasFullPlacementMismatch && current.correctedAfterMismatch;
        const completed = new Set(current.completedTasks);
        if (isFullMismatch) completed.add("kit.judge");
        if (successfulRejudge) completed.add("kit.rejudge");
        const nextProgress: KitPracticeProgress = {
          ...current,
          hasFullPlacementMismatch: current.hasFullPlacementMismatch || isFullMismatch,
          successfulRejudge: current.successfulRejudge || successfulRejudge,
          completedTasks: [...completed] as KitPracticeProgress["completedTasks"],
          lastResult: { result: next, mapSignature: judgedMapSignature },
        };
        isCompleted = isPracticeStepComplete("KB", nextProgress);
        return nextProgress;
      });
      if (!saved) return;
      if (isCompleted) onComplete("KB");
    } catch (requestError) {
      if (requestId.current !== currentRequest || !active) return;
      setError(
        requestError instanceof Error
          ? requestError.message
          : "判定を完了できませんでした。もう一度お試しください。",
      );
    } finally {
      if (requestId.current === currentRequest) {
        setChecking(false);
      }
    }
  }

  function invalidateResult() {
    setError(null);
  }

  const resultMessage = result?.matched
    ? hasFullPlacementMismatch && correctedAfterMismatch
      ? "練習用Kitと一致しました。"
      : "一致しています。配置後の不一致を確認し、接続を見直してから再判定してください。"
    : "配置やリンクの向きを見直して、再度確認できます。";

  return (
    <>
      <h2 id="tutorial-practice-heading">Kit-Buildの練習</h2>
      <p className="tutorial-practice-description">
        光合成Kitの部品を配置し、一致状況を確認します。不一致の結果を見てリンクの向きを修正し、もう一度判定してください。配置位置は判定に含まれません。
      </p>
      {storageMessage && <p role="alert">{storageMessage}{status === "unavailable" && <button type="button" onClick={retry}>保存を再確認</button>}</p>}
      <section className="tutorial-task-progress" aria-label="操作練習の課題">
        <h3>練習する操作</h3>
        <p role="status">{completedCount} / {photosynthesisPracticeTasks.length} 件達成</p>
        <ol>
          {photosynthesisPracticeTasks.map((task) => (
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
        <p>課題は練習画面内の操作で達成します。学習成績ではありません。</p>
      </section>

      <section className="kit-feedback-actions" aria-label="Kitの一致確認">
        <p>配置した部品の一致状況を確認できます。判定はこの練習用Kitに対して行います。</p>
        <KitBuildFeedbackCheckButton
          disabled={checking || storageBlocked}
          loading={checking}
          label="一致状況を確認"
          onClick={() => void checkKit()}
        />
        {checking && <p role="status">練習用Kitを確認しています…</p>}
        {error && <p role="alert">{error}</p>}
        {result && (
          <div className="kit-feedback-dialog-content" role="status" aria-live="polite" aria-atomic="true">
            <KitBuildFeedbackResultDisplay
              result={{
                ...result,
                message: resultMessage,
              }}
            />
          </div>
        )}
      </section>

      <ConceptCanvas
        mapId="tutorial-photosynthesis-kb"
        mapType="KB"
        showZoomControls
        concepts={concepts}
        links={links}
        kitDefinitionName="Development Kit：光合成"
        kitPaletteCopy="kits"
        kitConcepts={photosynthesisKitConcepts.map((item) => ({
          ...item,
          imported: placedConcepts.some(
            (placement) => placement.kitConceptItemId === item.kitConceptItemId,
          ),
        }))}
        kitLinks={photosynthesisKitLinks.map((item) => ({
          ...item,
          used: placedLinks.some(
            (placement) => placement.kitLinkItemId === item.kitLinkItemId,
          ),
        }))}
        readOnly={storageBlocked}
        canEditConceptStructure={false}
        canEditLinkLabel={false}
        positionSaving={false}
        positionFeedback={null}
        onLabelSave={async () => undefined}
        onConceptDelete={async (conceptId) => {
          invalidateResult();
          update((current) => ({
            ...current,
            placedConcepts: current.placedConcepts.filter(({ concept }) => concept.id !== conceptId),
            placedLinks: current.placedLinks.filter(({ link }) => link.sourceConceptId !== conceptId && link.targetConceptId !== conceptId),
          }));
        }}
        onLinkLabelSave={async (link, label) => {
          update((current) => ({
            ...current,
            placedLinks: current.placedLinks.map((placement) => placement.link.id === link.id
              ? { ...placement, link: { ...placement.link, label } }
              : placement),
          }));
          invalidateResult();
        }}
        onLinkReconnect={async (link, sourceConceptId, targetConceptId) => {
          if (
            link.sourceConceptId !== sourceConceptId ||
            link.targetConceptId !== targetConceptId
          ) {
            update((current) => {
              const completed = new Set(current.completedTasks);
              if (current.hasFullPlacementMismatch) completed.add("kit.correct");
              return {
                ...current,
                correctedAfterMismatch: current.correctedAfterMismatch || current.hasFullPlacementMismatch,
                completedTasks: [...completed] as KitPracticeProgress["completedTasks"],
                placedLinks: current.placedLinks.map((placement) => placement.link.id === link.id
                  ? { ...placement, link: { ...placement.link, sourceConceptId, targetConceptId } }
                  : placement),
              };
            });
            invalidateResult();
          }
        }}
        onLinkDelete={async (linkId) => {
          update((current) => ({ ...current, placedLinks: current.placedLinks.filter(({ link }) => link.id !== linkId) }));
          invalidateResult();
        }}
        onKitConceptDrop={async (itemId, position) => {
          const item = photosynthesisKitConcepts.find(
            (candidate) => candidate.kitConceptItemId === itemId,
          );
          if (
            !item ||
            placedConcepts.some(
              (placement) => placement.kitConceptItemId === itemId,
            )
          ) return;
          const saved = update((current) => {
            const nextConcepts: KitConceptPlacement[] = [...current.placedConcepts, {
              kitConceptItemId: itemId,
              concept: {
                id: id(),
                label: item.label,
                positionX: position.positionX,
                positionY: position.positionY,
                createdAt: "",
                updatedAt: "",
              },
            }];
            const completed = new Set(current.completedTasks);
            if (nextConcepts.length === 3 && current.placedLinks.length === 2) completed.add("kit.place");
            return { ...current, placedConcepts: nextConcepts, completedTasks: [...completed] as KitPracticeProgress["completedTasks"] };
          });
          if (!saved) return;
          invalidateResult();
        }}
        onKitLinkCreate={async (_targetMapId, itemId, source, target) => {
          const item = photosynthesisKitLinks.find(
            (candidate) => candidate.kitLinkItemId === itemId,
          );
          if (
            !item ||
            placedLinks.some(
              (placement) => placement.kitLinkItemId === itemId,
            )
          ) return;
          const linkId = id();
          const saved = update((current) => {
            const nextLinks: KitLinkPlacement[] = [...current.placedLinks, {
              kitLinkItemId: itemId,
              link: {
                id: linkId,
                mapId: "tutorial-photosynthesis-kb",
                sourceConceptId: source,
                targetConceptId: target,
                label: item.label,
              },
            }];
            const completed = new Set(current.completedTasks);
            if (current.placedConcepts.length === 3 && nextLinks.length === 2) completed.add("kit.place");
            return { ...current, placedLinks: nextLinks, completedTasks: [...completed] as KitPracticeProgress["completedTasks"] };
          });
          if (!saved) return;
          invalidateResult();
          return linkId;
        }}
        onDragStart={() => undefined}
        onPositionSave={async (conceptId, position) => {
          const original = valueRef.current.placedConcepts.find(({ concept }) => concept.id === conceptId)?.concept;
          const saved = update((current) => ({
            ...current,
            placedConcepts: current.placedConcepts.map((placement) => placement.concept.id === conceptId
              ? { ...placement, concept: { ...placement.concept, ...position } }
              : placement),
          }));
          if (saved) return position;
          return original ? { positionX: original.positionX, positionY: original.positionY } : position;
        }}
        onLinkPositionSave={async () => true}
        onMapLinkCreate={async () => undefined}
        onMapLinkSelect={() => undefined}
        onMapConceptSelect={() => undefined}
      />
    </>
  );
}
