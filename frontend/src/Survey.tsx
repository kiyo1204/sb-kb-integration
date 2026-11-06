import { useEffect, useState } from "react";
import { apiFetch } from "./auth-client";
export type SurveyQuestion = {
  id?: string;
  kind: "TEXT" | "CHOICE" | "RATING";
  prompt: string;
  required: boolean;
  config: {
    options?: string[];
    min?: number;
    max?: number;
    minLabel?: string;
    maxLabel?: string;
  };
};
const newQuestion = (): SurveyQuestion => ({
  kind: "TEXT",
  prompt: "",
  required: true,
  config: {},
});
export function SurveyEditor({
  questions,
  onChange,
  disabled = false,
}: {
  questions: SurveyQuestion[];
  onChange: (q: SurveyQuestion[]) => void;
  disabled?: boolean;
}) {
  const update = (index: number, patch: Partial<SurveyQuestion>) =>
    onChange(questions.map((q, i) => (i === index ? { ...q, ...patch } : q)));
  return (
    <section className="stage1-form" aria-label="アンケートの設定">
      <h2>アンケート</h2>
      <p>開始後は設問・順序・回答形式を変更できません。</p>
      {questions.map((q, i) => (
        <fieldset key={i} disabled={disabled}>
          <legend>設問 {i + 1}</legend>
          <label>
            問題文
            <textarea
              required
              maxLength={10000}
              value={q.prompt}
              onChange={(e) => update(i, { prompt: e.target.value })}
            />
          </label>
          <label>
            回答形式
            <select
              value={q.kind}
              onChange={(e) => {
                const kind = e.target.value as SurveyQuestion["kind"];
                update(i, {
                  kind,
                  config:
                    kind === "TEXT"
                      ? {}
                      : kind === "CHOICE"
                        ? { options: ["", ""] }
                        : {
                            min: 1,
                            max: 5,
                            minLabel: "低い",
                            maxLabel: "高い",
                          },
                });
              }}
            >
              <option value="TEXT">自由記述</option>
              <option value="CHOICE">選択式（1つ選択）</option>
              <option value="RATING">段階評価</option>
            </select>
          </label>
          <label>
            <input
              type="checkbox"
              checked={q.required}
              onChange={(e) => update(i, { required: e.target.checked })}
            />
            回答必須
          </label>
          {q.kind === "CHOICE" && (
            <label>
              選択肢（1行に1項目）
              <textarea
                required
                value={q.config.options?.join("\n") ?? ""}
                onChange={(e) =>
                  update(i, { config: { options: e.target.value.split("\n") } })
                }
              />
            </label>
          )}
          {q.kind === "RATING" && (
            <>
              <label>
                最小値
                <input
                  required
                  type="number"
                  min={-100}
                  max={999}
                  value={q.config.min}
                  onChange={(e) =>
                    update(i, {
                      config: { ...q.config, min: Number(e.target.value) },
                    })
                  }
                />
              </label>
              <label>
                最大値
                <input
                  required
                  type="number"
                  min={-99}
                  max={1000}
                  value={q.config.max}
                  onChange={(e) =>
                    update(i, {
                      config: { ...q.config, max: Number(e.target.value) },
                    })
                  }
                />
              </label>
              <label>
                最小値のラベル
                <input
                  required
                  value={q.config.minLabel}
                  onChange={(e) =>
                    update(i, {
                      config: { ...q.config, minLabel: e.target.value },
                    })
                  }
                />
              </label>
              <label>
                最大値のラベル
                <input
                  required
                  value={q.config.maxLabel}
                  onChange={(e) =>
                    update(i, {
                      config: { ...q.config, maxLabel: e.target.value },
                    })
                  }
                />
              </label>
            </>
          )}
          <div>
            <button
              type="button"
              disabled={disabled || i === 0}
              onClick={() => {
                const a = [...questions];
                [a[i - 1], a[i]] = [a[i], a[i - 1]];
                onChange(a);
              }}
            >
              上へ
            </button>
            <button
              type="button"
              disabled={disabled || i === questions.length - 1}
              onClick={() => {
                const a = [...questions];
                [a[i + 1], a[i]] = [a[i], a[i + 1]];
                onChange(a);
              }}
            >
              下へ
            </button>
            <button
              type="button"
              onClick={() =>
                onChange(questions.filter((_, index) => index !== i))
              }
            >
              設問を削除
            </button>
          </div>
        </fieldset>
      ))}
      <button
        type="button"
        disabled={disabled}
        onClick={() => onChange([...questions, newQuestion()])}
      >
        設問を追加
      </button>
    </section>
  );
}
export function Survey({
  stageId,
  onSubmitted,
}: {
  sessionId: string;
  stageId: string;
  onSubmitted: () => Promise<void>;
}) {
  const [questions, setQuestions] = useState<SurveyQuestion[]>([]),
    [answers, setAnswers] = useState<Record<string, string | number>>({}),
    [error, setError] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let active = true;
    void apiFetch(`/api/session-stages/${stageId}/survey`)
      .then(async (r) => {
        if (!r.ok) throw Error();
        const data = await r.json();
        if (active) {
          setQuestions(data.questions);
          setAnswers(
            Object.fromEntries(
              data.answers.map(
                (a: { questionId: string; answer: string | number }) => [
                  a.questionId,
                  a.answer,
                ],
              ),
            ),
          );
          setLoaded(true);
        }
      })
      .catch(() => {
        if (active)
          setError("アンケートを取得できません。再読み込みしてください。");
      });
    return () => {
      active = false;
    };
  }, [stageId]);
  async function save(submit: boolean) {
    if (busy) return;
    setError(null);
    const missing = questions.filter(
      (q) =>
        q.required &&
        (answers[q.id!] === undefined ||
          (typeof answers[q.id!] === "string" &&
            !String(answers[q.id!]).trim())),
    );
    if (submit && missing.length) {
      setError(
        `設問 ${questions.indexOf(missing[0]) + 1} に回答してください。`,
      );
      document.getElementById("survey-" + missing[0].id)?.focus();
      return;
    }
    setBusy(true);
    try {
      const response = await apiFetch(
        `/api/session-stages/${stageId}/survey/${submit ? "submit" : "save"}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            answers: Object.entries(answers)
              .filter(([, v]) => typeof v !== "string" || v.trim())
              .map(([questionId, value]) => ({ questionId, value })),
          }),
        },
      );
      const data = await response.json();
      if (!response.ok) {
        if (data.missingQuestionIds?.[0])
          document
            .getElementById("survey-" + data.missingQuestionIds[0])
            ?.focus();
        throw Error(
          data.message ?? "回答を保存できません。入力内容は保持しています。",
        );
      }
      if (submit) await onSubmitted();
      else setError("回答を保存しました。");
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "回答を保存できません。入力内容を保持して再度お試しください。",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="stage1-form" aria-label="アンケート">
      <p>
        各設問に回答し、最後に提出してください。任意の設問は空欄でも提出できます。
      </p>
      {questions.map((q, i) => (
        <label key={q.id} htmlFor={"survey-" + q.id}>
          {i + 1}. {q.prompt}（{q.required ? "必須" : "任意"}）
          {q.kind === "TEXT" ? (
            <textarea
              id={"survey-" + q.id}
              maxLength={100000}
              disabled={busy}
              value={answers[q.id!] ?? ""}
              onChange={(e) =>
                setAnswers((a) => ({ ...a, [q.id!]: e.target.value }))
              }
            />
          ) : (
            <select
              id={"survey-" + q.id}
              disabled={busy}
              value={answers[q.id!] ?? ""}
              onChange={(e) =>
                setAnswers((a) => {
                  const n = { ...a };
                  if (e.target.value === "") delete n[q.id!];
                  else
                    n[q.id!] =
                      q.kind === "RATING"
                        ? Number(e.target.value)
                        : e.target.value;
                  return n;
                })
              }
            >
              <option value="">選択してください</option>
              {q.kind === "CHOICE"
                ? q.config.options?.map((o) => (
                    <option key={o} value={o}>
                      {o}
                    </option>
                  ))
                : Array.from(
                    { length: q.config.max! - q.config.min! + 1 },
                    (_, i) => q.config.min! + i,
                  ).map((n) => (
                    <option key={n} value={n}>
                      {n}
                      {n === q.config.min
                        ? `：${q.config.minLabel}`
                        : n === q.config.max
                          ? `：${q.config.maxLabel}`
                          : ""}
                    </option>
                  ))}
            </select>
          )}
        </label>
      ))}
      {error && <p role="status">{error}</p>}
      <div>
        <button disabled={busy || !loaded} onClick={() => void save(false)}>
          回答を保存
        </button>
        <button
          className="session-primary-button"
          disabled={busy || !loaded}
          onClick={() => void save(true)}
        >
          回答を提出
        </button>
      </div>
      <small>
        回答本文を操作記録の送信待ちキューへ保存しません。接続中に保存してください。
      </small>
    </section>
  );
}
export function ResearchSurvey({
  sessionId,
  editable,
}: {
  sessionId: string;
  editable: boolean;
}) {
  const [questions, setQuestions] = useState<SurveyQuestion[]>([]),
    [status, setStatus] = useState("");
  useEffect(() => {
    let active = true;
    void apiFetch(`/api/research/stage1/sessions/${sessionId}/survey`)
      .then(async (r) => {
        if (!r.ok) throw Error();
        return r.json();
      })
      .then((d) => {
        if (active) setQuestions(d.questions);
      })
      .catch(() => {
        if (active) setStatus("アンケートを取得できませんでした。");
      });
    return () => {
      active = false;
    };
  }, [sessionId]);
  return (
    <section>
      {editable ? (
        <>
          <SurveyEditor questions={questions} onChange={setQuestions} />
          <button
            onClick={() =>
              void apiFetch(
                `/api/research/stage1/sessions/${sessionId}/survey/questions`,
                {
                  method: "PUT",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ questions }),
                },
              )
                .then(async (r) => {
                  const d = await r.json();
                  setStatus(
                    r.ok
                      ? "保存しました。"
                      : (d.message ?? "保存できませんでした。"),
                  );
                })
                .catch(() => setStatus("保存できませんでした。"))
            }
          >
            アンケート設定を保存
          </button>
        </>
      ) : (
        <p>開始済みのアンケート設定は固定されています。</p>
      )}
      <p role="status">{status}</p>
      <a href={`/research/stage1/${sessionId}/analysis`}>記録・分析</a>
      <p>回答・回答履歴は研究者用のアンケートJSON／CSV出力で確認できます。</p>
      <SurveyDownload sessionId={sessionId} />
    </section>
  );
}
function SurveyDownload({ sessionId }: { sessionId: string }) {
  const [error, setError] = useState("");
  return (
    <>
      <button
        onClick={() =>
          void (async () => {
            try {
              const r = await apiFetch(
                `/api/research/stage1/sessions/${sessionId}/survey-answers.csv`,
              );
              if (!r.ok) throw Error();
              const url = URL.createObjectURL(await r.blob()),
                a = document.createElement("a");
              a.href = url;
              a.download = "survey-answers.csv";
              a.click();
              setTimeout(() => URL.revokeObjectURL(url), 1000);
            } catch {
              setError("出力できませんでした。");
            }
          })()
        }
      >
        アンケート回答CSVを出力
      </button>
      {error && <p role="alert">{error}</p>}
    </>
  );
}
