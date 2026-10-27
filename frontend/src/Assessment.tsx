import { useEffect, useRef, useState } from "react";
import { apiFetch, downloadApiFile, uiText } from "./auth-client";

type Category = "DESCRIPTION" | "RETENTION" | "TRANSFER";
type Question = { id?: string; category: Category; prompt: string };
type LearnerQuestion = { id: string; prompt: string; displayOrder: number; answer: string };
type ResearchData = {
  session: { status: string };
  questions: Array<Question & { id: string; displayOrder: number }>;
  stages: Array<{ stageId: string; stageType: string; status: string; submittedAt: string | null }>;
  answers: Array<{ stageId: string; questionId: string; answer: string }>;
};
const categoryLabels: Record<Category, string> = { DESCRIPTION: "記述", RETENTION: "保持", TRANSFER: "転移" };

async function json<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const response = await apiFetch(path, { method, headers: body === undefined ? {} : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data && typeof data === "object" && "message" in data && typeof data.message === "string" ? uiText(data.message) : "評価を処理できませんでした。");
  return data as T;
}

export function ResearchAssessment({ sessionId }: { sessionId: string }) {
  const [data, setData] = useState<ResearchData | null>(null);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const path = `/api/research/stage1/sessions/${sessionId}/assessment`;
  async function load() {
    const result = await json<ResearchData>(path);
    setData(result);
    setQuestions(result.questions.map(({ id, category, prompt }) => ({ id, category, prompt })));
  }
  useEffect(() => { let active = true; json<ResearchData>(path).then(result => {
    if (active) { setData(result); setQuestions(result.questions.map(({ id, category, prompt }) => ({ id, category, prompt }))); }
  }).catch(err => { if (active) setMessage(err instanceof Error ? err.message : "評価を取得できませんでした。"); }); return () => { active = false; }; }, [path]);
  async function save() {
    setBusy(true); setMessage("");
    try { await json(`${path}/questions`, "PUT", { questions }); await load(); setMessage("問題を保存しました。"); }
    catch (err) { setMessage(err instanceof Error ? err.message : "保存できませんでした。"); }
    finally { setBusy(false); }
  }
  function update(index: number, change: Partial<Question>) { setQuestions(list => list.map((q, i) => i === index ? { ...q, ...change } : q)); }
  function move(index: number, delta: number) { setQuestions(list => { const next = [...list]; const target = index + delta; if (target < 0 || target >= next.length) return list; [next[index], next[target]] = [next[target]!, next[index]!]; return next; }); }
  async function download(pathname: string) { try { await downloadApiFile(pathname); } catch { setMessage("ファイルを取得できませんでした。"); } }
  if (!data) return <section><h2>評価問題・回答</h2><p role="status">{message || "読み込み中…"}</p></section>;
  const editable = data.session.status === "NOT_STARTED";
  return <section className="session-stage-list research-assessment">
    <h2>評価問題・回答</h2>
    <p>{editable ? "開始前に記述問題を2問以上登録してください。事前・事後に同じ問題をこの順序で表示します。" : "セッション開始後の問題セットは固定されています。"}</p>
    {questions.map((q, index) => <div className="assessment-question" key={q.id ?? `new-${index}`}>
      <p className="assessment-question-number">問題 {index + 1}</p>
      <label className="assessment-field">分類 <select disabled={!editable || busy} value={q.category} onChange={e => update(index, { category: e.target.value as Category })}>{Object.entries(categoryLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
      <label className="assessment-field">問題文 <textarea disabled={!editable || busy} value={q.prompt} onChange={e => update(index, { prompt: e.target.value })} /></label>
      {editable && <div className="assessment-actions"><button className="session-secondary-button" type="button" disabled={busy || index === 0} onClick={() => move(index, -1)}>上へ</button> <button className="session-secondary-button" type="button" disabled={busy || index === questions.length - 1} onClick={() => move(index, 1)}>下へ</button> <button className="session-secondary-button" type="button" disabled={busy} onClick={() => setQuestions(list => list.filter((_, i) => i !== index))}>削除</button></div>}
    </div>)}
    {editable && <div className="assessment-actions"><button className="session-secondary-button" type="button" disabled={busy} onClick={() => setQuestions(list => [...list, { category: "DESCRIPTION", prompt: "" }])}>問題を追加</button> <button className="session-primary-button" type="button" disabled={busy} onClick={() => void save()}>問題を保存</button></div>}
    {!editable && <div className="assessment-answers"><h3>回答</h3>{data.stages.map(stage => <div key={stage.stageId}>
      <h4>{stage.stageType === "PRE_ASSESSMENT" ? "事前評価" : "事後評価"}：{stage.status === "COMPLETED" ? "提出済み" : stage.status === "IN_PROGRESS" ? "回答中" : "未開始"}</h4>
      {stage.submittedAt && <p>提出日時: {new Date(stage.submittedAt).toLocaleString()}</p>}
      {data.questions.map((q, index) => <div key={q.id}><p>{index + 1}. {q.prompt}</p><p>回答: {data.answers.find(a => a.stageId === stage.stageId && a.questionId === q.id)?.answer || "（空欄）"}</p></div>)}
    </div>)}</div>}
    <div className="assessment-actions"><button className="session-secondary-button" type="button" onClick={() => void download(`/api/research/stage1/sessions/${sessionId}/assessment-answers.csv`)}>評価回答CSVを出力</button>{data.session.status === "COMPLETED" && <> <button className="session-secondary-button" type="button" onClick={() => void download(`/api/research/sessions/${sessionId}/export`)}>生データJSONを出力</button></>}</div>
    {message && <p className="assessment-status" role="status">{message}</p>}
  </section>;
}

export function LearnerAssessment({ stageId, onSubmitted }: { stageId: string; onSubmitted: () => Promise<void> }) {
  const [questions, setQuestions] = useState<LearnerQuestion[] | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const latest = useRef<LearnerQuestion[]>([]);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const timer = useRef<number | null>(null);
  const cacheKey = `stage1-assessment-draft-${stageId}`;
  const path = `/api/session-stages/${stageId}/assessment`;
  function payload(list: LearnerQuestion[]) { return list.map(q => ({ questionId: q.id, answer: q.answer })); }
  function persist(list: LearnerQuestion[]) {
    const answers = payload(list);
    const serialized = JSON.stringify(answers);
    queue.current = queue.current.catch(() => undefined).then(async () => {
      await json(`${path}/save`, "POST", { answers });
      if (localStorage.getItem(cacheKey) === serialized) localStorage.removeItem(cacheKey);
      setMessage("回答を保存しました。");
    }).catch(() => { setMessage("サーバーに保存できませんでした。入力内容はこのブラウザーに保持されています。"); });
  }
  useEffect(() => {
    let active = true;
    json<{ questions: LearnerQuestion[] }>(path).then(data => {
      if (!active) return;
      let restored = data.questions;
      let recovered = false;
      try {
        const draft = JSON.parse(localStorage.getItem(cacheKey) ?? "null") as Array<{questionId: string; answer: string}> | null;
        if (Array.isArray(draft)) {
          restored = data.questions.map(q => ({ ...q, answer: draft.find(a => a.questionId === q.id && typeof a.answer === "string")?.answer ?? q.answer }));
          recovered = true;
        }
      } catch { /* Ignore malformed local drafts. */ }
      latest.current = restored; setQuestions(restored);
      if (recovered) persist(restored);
    }).catch(err => { if (active) setMessage(err instanceof Error ? err.message : "評価を取得できませんでした。"); });
    return () => { active = false; if (timer.current !== null) window.clearTimeout(timer.current); };
  }, [path, cacheKey]);
  function change(id: string, answer: string) {
    const next = latest.current.map(q => q.id === id ? { ...q, answer } : q);
    latest.current = next; setQuestions(next);
    try { localStorage.setItem(cacheKey, JSON.stringify(payload(next))); } catch { setMessage("ブラウザーに一時保存できません。保存状態を確認してください。"); }
    if (timer.current !== null) window.clearTimeout(timer.current);
    setMessage("保存中…");
    timer.current = window.setTimeout(() => persist(next), 700);
  }
  async function submit() {
    const answers = payload(latest.current);
    const empty = answers.filter(a => !a.answer.trim()).length;
    if (!window.confirm(`未回答は${empty}問です。空欄のまま提出できます。提出しますか？`)) return;
    setBusy(true); setMessage("");
    if (timer.current !== null) window.clearTimeout(timer.current);
    try { await queue.current; await json(`${path}/submit`, "POST", { answers }); try { localStorage.removeItem(cacheKey); } catch { /* The submission is already saved on the server. */ } await onSubmitted(); }
    catch (err) { setMessage(err instanceof Error ? err.message : "提出できませんでした。"); }
    finally { setBusy(false); }
  }
  if (!questions) return <p role="status">{message || "評価を読み込んでいます…"}</p>;
  return <div className="learner-assessment"><p>自由に記述してください。空欄のまま提出することもできます。</p>
    {questions.map((q, index) => <div className="assessment-question" key={q.id}><label className="assessment-field" htmlFor={`answer-${q.id}`}>問題 {index + 1}：{q.prompt}</label><textarea id={`answer-${q.id}`} rows={4} value={q.answer} disabled={busy} onChange={e => change(q.id, e.target.value)} /></div>)}
    <div className="assessment-actions"><p>未回答: {questions.filter(q => !q.answer.trim()).length}問</p>
    <button className="session-primary-button" type="button" disabled={busy} onClick={() => void submit()}>回答を確認して提出</button></div>
    {message && <p className="assessment-status" role="status">{message}</p>}
  </div>;
}
