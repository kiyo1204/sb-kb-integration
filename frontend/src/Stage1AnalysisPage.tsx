import {ResearchDeliveryStatus} from "./DeliveryStatus";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { apiFetch, downloadApiFile, uiText } from "./auth-client";
import { ReadOnlyMapSnapshot, type HistoricalMapSnapshot } from "./MapPage";

type Operation = {
  id: string; mapId: string; mapType: string; researchRole: string | null;
  operationType: string; targetId: string; targetType: string; sequenceNumber: string;
  relatedOperationLogId: string | null;
  historySource?: "LEGACY" | "EVENT"; eventId?: string;
  serverTimestamp: string; elapsedMs: number | null;
  before: unknown; after: unknown;
};
type Link = {
  id: string; sourceConceptId: string; targetConceptId: string; label: string;
};
type MapData = { id: string; type: string; status: string; researchRole: string | null;
  concepts: { id: string; label: string }[]; links: Link[];
  historyReplayStatus: "AVAILABLE" | "UNAVAILABLE" | "EXCLUDED" };
type HistoryReplay = {
  status: "REPLAYABLE" | "PARTIAL" | "UNAVAILABLE";
  reason: string | null;
  mapId: string;
  mapType: string;
  sequenceNumber: number;
  operation: Operation | null;
  beforeState: HistoricalMapSnapshot | null;
  afterState: HistoricalMapSnapshot | null;
};
type Rating = { id: string; mapId: string; linkId: string; category: "U"|"I"|"P"|"V"; rationale: string; createdAt: string; evaluatorCode: string; operationLogId?:string|null;eventId?:string|null };
type Reflection = { id: string; noteText: string; reportedByCode: string; operationLogId: string | null; eventId?: string | null };
type Analysis = {
  session: { id: string; participantCode: string | null; protocolKey: string };
  maps: MapData[];
  operations: Operation[];
  operationCounts: Record<string,number>;
  features: Record<string,string|number|null>;
  propositionEvaluations: Rating[];
  reflectionNotes: Reflection[];
  limitations: string[];
};
const CATEGORIES = [
  { value:"U", label:"U — Undefined：主張が特定できない" },
  { value:"I", label:"I — Invalid：関係が誤っている" },
  { value:"P", label:"P — Partially valid：部分的に妥当" },
  { value:"V", label:"V — Valid：明確で妥当" },
] as const;

const operationNames: Record<string, string> = { ADD_CONCEPT: "概念を追加", EDIT_CONCEPT: "概念を変更", MOVE_LINK: "関係の位置を移動", MOVE_CONCEPT: "概念を移動", DELETE_CONCEPT: "概念を削除", ADD_LINK: "関係を追加", EDIT_LINK: "関係を変更", RECONNECT_LINK: "関係の接続を変更", DELETE_LINK: "関係を削除", IMPORT_KIT_CONCEPT: "キットの概念を追加", IMPORT_KIT_LINK: "キットの関係を追加", MERGE_CONCEPT: "概念を統合", UNDO: "操作を元に戻す", REDO: "操作をやり直す" };
const operationName = (type: string) => operationNames[type] ?? `その他の操作（${type}）`;
const mapName = (type: string) => ({ PRIOR: "Scratch-Build", KB: "Kit-Build", INTEGRATION: "統合マップ" } as Record<string,string>)[type] ?? type;
const elapsed = (ms: number | null) => ms === null ? "不明" : `${Math.floor(ms / 60000)}分${Math.floor(ms / 1000) % 60}秒`;
const limitationText: Record<string, string> = {
  "Counts indicate operations, not learning quality.": "操作件数は学習の質を示すものではありません。",
  "Kit usage in other non-import events requires provenance-specific analysis.": "インポート以外の操作におけるキットの使用には、由来に基づく分析が必要です。",
  "Prior/lesson origin reflects observed map stages, not genuine pre-lesson knowledge.": "由来の区分は観察されたマップの活動に基づき、授業前の知識そのものを表すものではありません。",
  "Maps without a supported initial snapshot cannot be replayed; sequence gaps or incomplete events produce partial replay.": "対応する初期状態のないマップは再生できません。操作の欠落や不完全な記録がある場合は一部だけ再生されます。",
};

function targetLabel(op: Operation, map: MapData | undefined, replay: HistoryReplay | null) {
  const value = (op.after ?? op.before) as Record<string, unknown> | null;
  const stateItem = op.historySource === "EVENT" ?
    op.targetType === "CONCEPT" ?
      [...(replay?.afterState?.concepts ?? []), ...(replay?.beforeState?.concepts ?? [])].find(item=>item.id===op.targetId) :
      [...(replay?.afterState?.links ?? []), ...(replay?.beforeState?.links ?? [])].find(item=>item.id===op.targetId)
    : null;
  const label = typeof stateItem?.label === "string" ? stateItem.label : typeof value?.label === "string" ? value.label : undefined;
  if (op.targetType === "CONCEPT") return `概念：${label ?? map?.concepts.find(item => item.id === op.targetId)?.label ?? op.targetId}`;
  if (op.targetType === "LINK") {
    const link = stateItem && "sourceConceptId" in stateItem ? stateItem : value && typeof value.sourceConceptId === "string" && typeof value.targetConceptId === "string" ? value : map?.links.find(item => item.id === op.targetId);
    if (link && typeof link.sourceConceptId === "string" && typeof link.targetConceptId === "string") {
      const concepts = [...(replay?.beforeState?.concepts ?? []), ...(replay?.afterState?.concepts ?? []), ...(map?.concepts ?? [])];
      const name = (id: string) => concepts.find(item => item.id === id)?.label ?? id;
      return `関係：${name(link.sourceConceptId)} → ${label ?? link.label ?? ""} → ${name(link.targetConceptId)}`;
    }
    return `関係：${label ?? op.targetId}`;
  }
  return `${op.targetType}：${op.targetId}`;
}

function compareSnapshots(before: HistoricalMapSnapshot, after: HistoricalMapSnapshot) {
  const difference = <T extends { id: string }>(oldItems: T[], newItems: T[], signature: (item: T) => unknown) => {
    const oldMap = new Map(oldItems.map(item => [item.id, JSON.stringify(signature(item))]));
    const newMap = new Map(newItems.map(item => [item.id, JSON.stringify(signature(item))]));
    const ids = new Set([...oldMap.keys(), ...newMap.keys()].filter(id => oldMap.get(id) !== newMap.get(id)));
    return { ids, added: [...ids].filter(id => !oldMap.has(id)).length, removed: [...ids].filter(id => !newMap.has(id)).length, changed: [...ids].filter(id => oldMap.has(id) && newMap.has(id)).length };
  };
  return {
    concepts: difference(before.concepts, after.concepts, item => [item.label, item.positionX, item.positionY, item.mergedIntoConceptId]),
    links: difference(before.links, after.links, item => [item.label, item.sourceConceptId, item.targetConceptId, item.labelPositionX??null, item.labelPositionY??null]),
  };
}

function historicalLink(op:Operation,side:"BEFORE"|"AFTER") {
  const value=side==="BEFORE"?op.before:op.after;
  if(op.historySource!=="EVENT") return value;
  if(!value||typeof value!=="object"||!("links" in value)||!Array.isArray(value.links)) return null;
  return value.links.find((item:unknown)=>item!==null&&typeof item==="object"&&"id" in item&&item.id===op.targetId)??null;
}

export default function Stage1AnalysisPage({sessionId}:{sessionId:string}) {
  const [data,setData]=useState<Analysis|null>(null);
  const [selectedOperationId,setSelectedOperationId]=useState("");
  const [selectedMapId,setSelectedMapId]=useState("");
  const [historySequence,setHistorySequence]=useState(0);
  const [historyReplay,setHistoryReplay]=useState<HistoryReplay|null>(null);
  const [historyLoading,setHistoryLoading]=useState(false);
  const [selectedLinkId,setSelectedLinkId]=useState("");
  const [ratingSide,setRatingSide]=useState<"CURRENT"|"BEFORE"|"AFTER">("CURRENT");
  const [ratingOperationId,setRatingOperationId]=useState("");
  const [evaluatorCode,setEvaluatorCode]=useState("");
  const [category,setCategory]=useState<"U"|"I"|"P"|"V">("U");
  const [reason,setReason]=useState("");
  const [memo,setMemo]=useState("");
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState<string|null>(null);
  const [status,setStatus]=useState("");
  const reload=useCallback(async()=>{
    const response=await apiFetch(`/api/research/stage1/sessions/${sessionId}/analysis`);
    if(!response.ok)throw new Error("完了した活動 1 セッションの分析データを取得できませんでした。");
    const next=(await response.json()) as Analysis;
    setData(next);
    if(!selectedMapId) {
      const first=next.maps.find(m=>m.type==="PRIOR"||m.type==="KB"||m.type==="INTEGRATION");
      if(first)setSelectedMapId(first.id);
    }
  },[sessionId,selectedMapId]);
  useEffect(()=>{
    let mounted=true;
    apiFetch(`/api/research/stage1/sessions/${sessionId}/analysis`)
      .then(async(r)=>{if(!r.ok)throw new Error("分析データを取得できませんでした。セッションが完了しているか確認してください。");return (await r.json()) as Analysis;})
      .then(d=>{if(mounted){setData(d);const first=d.maps.find(m=>m.type==="PRIOR"||m.type==="KB"||m.type==="INTEGRATION");if(first)setSelectedMapId(current=>current||first.id);}})
      .catch(e=>{if(mounted)setError(String(e instanceof Error?e.message:e));});
    return()=>{mounted=false;};
  },[sessionId]);

  const replayMaps=(data?.maps??[]).filter(m=>m.type==="PRIOR"||m.type==="KB"||m.type==="INTEGRATION");
  const replayOperations=(data?.operations??[]).filter(op=>op.mapId===selectedMapId)
    .sort((a,b)=>Number(a.sequenceNumber)-Number(b.sequenceNumber));
  useEffect(()=>{
    if(!selectedMapId)return;
    let active=true;
    apiFetch(`/api/research/stage1/sessions/${sessionId}/maps/${selectedMapId}/history?sequenceNumber=${historySequence}`)
      .then(async response=>{
        if(!response.ok)throw new Error("選択したマップの履歴状態を取得できませんでした。");
        return await response.json() as HistoryReplay;
      })
      .then(value=>{if(active)setHistoryReplay(value);})
      .catch(reason=>{if(active)setHistoryReplay({status:"UNAVAILABLE",reason:String(reason instanceof Error?reason.message:reason),mapId:selectedMapId,mapType:"",sequenceNumber:historySequence,operation:null,beforeState:null,afterState:null});})
      .finally(()=>{if(active)setHistoryLoading(false);});
    return()=>{active=false;};
  },[sessionId,selectedMapId,historySequence]);

  const operation=data?.operations.find(o=>o.id===selectedOperationId);
  const map=data?.maps.find(m=>m.id===selectedMapId);
  const displayedReplay = historyReplay?.mapId === selectedMapId && historyReplay.sequenceNumber === historySequence ? historyReplay : null;
  const changes = displayedReplay?.beforeState && displayedReplay.afterState ? compareSnapshots(displayedReplay.beforeState, displayedReplay.afterState) : null;
  const link=map?.links.find(l=>l.id===selectedLinkId);
  const labels=new Map(map?.concepts.map(c=>[c.id,c.label])??[]);
  const historicalOperations=(data?.operations??[]).filter(op=>
    op.mapId===selectedMapId && op.targetType==="LINK" &&
    historicalLink(op,ratingSide==="BEFORE"?"BEFORE":"AFTER")!==null);
  const ratedOperation=historicalOperations.find(op=>op.id===ratingOperationId);
  const ratingLinkId=ratingSide==="CURRENT"?link?.id:ratedOperation?.targetId;

  async function post(path:string,body:unknown){
    setBusy(true);setError(null);setStatus("");
    try{
      const response=await apiFetch(path,{
        method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify(body),
      });
      if(!response.ok)throw new Error("保存に失敗しました。対象IDと入力内容を確認してください。");
      await reload();
      setStatus("保存しました。");
    }catch(e){setError(e instanceof Error?e.message:String(e));}
    finally{setBusy(false);}
  }
  function saveEvaluation(e:FormEvent){
    e.preventDefault();
    if(!map||!ratingLinkId)return;
    void post(`/api/research/stage1/sessions/${sessionId}/evaluations`,{
      mapId:map.id,linkId:ratingLinkId,evaluatorCode,category,
      rationale:reason,snapshotSide:ratingSide,
      ...(ratingSide!=="CURRENT" && ratedOperation
        ? ratedOperation.historySource==="EVENT" ? {eventId:ratedOperation.id} : {operationLogId:ratedOperation.id} : {}),
    });
  }
  function saveReflection(e:FormEvent){
    e.preventDefault();
    void post(`/api/research/stage1/sessions/${sessionId}/reflections`,{
      mapId:operation?.mapId??null,
      ...(operation?.historySource==="EVENT" ? {eventId:operation.id} : {operationLogId:operation?.id??null}),
      linkId:operation?.targetType==="LINK"?operation.targetId:link?.id??null,
      reportedByCode:evaluatorCode,noteText:memo,
    });
  }
  function selectReplaySequence(sequence:number){
    if (sequence === historySequence) return;
    setHistoryLoading(true);
    setHistorySequence(sequence);
    const next=replayOperations[sequence-1];
    setSelectedOperationId(next?.id??"");
  }
  return (
    <main className="page stage1-analysis-page">
      <section className="session-card stage1-analysis-header">
        <div className="stage1-analysis-heading">
          <p className="eyebrow">研究者用</p>
          <h1>再構成行動の分析</h1>
          <p>セッション：{sessionId} 参加者コード：{data?.session.participantCode??"—"}</p>
        </div>
        <div className="stage1-analysis-exports" role="group" aria-label="データ出力">
          <button type="button" onClick={() => void downloadApiFile(`/api/research/sessions/${sessionId}/export`).catch(() => setError("JSONを取得できませんでした。"))}>生データJSON</button>
          <button type="button" onClick={() => void downloadApiFile(`/api/research/stage1/sessions/${sessionId}/operations.csv`).catch(() => setError("CSVを取得できませんでした。"))}>操作イベントCSV</button>
          {data?.session.protocolKey === "STAGE1_4" && <><button type="button" onClick={() => void downloadApiFile(`/api/research/stage1/sessions/${sessionId}/evaluations.csv`).catch(() => setError("CSVを取得できませんでした。"))}>命題評価CSV</button>
          <button type="button" onClick={() => void downloadApiFile(`/api/research/stage1/sessions/${sessionId}/reflections.csv`).catch(() => setError("CSVを取得できませんでした。"))}>振り返りCSV</button></>}
          <a href={`/research/event-exports?sessionId=${sessionId}`}>研究イベントの絞り込み出力</a>
          <a href={`/sessions/${sessionId}`}>セッションへ戻る</a>
        </div>
        {error&&<p className="session-error" role="alert">{error}</p>}
        {status&&<p role="status">{status}</p>}
      </section>
      <ResearchDeliveryStatus sessionId={sessionId}/>
      {!data?<p role="status">分析データを読み込んでいます…</p>:(
        <>
          <section className="session-card">
            <h2>保存されたマップ</h2>
            <p>既存のマップ Editorを提出後read-onlyとして再利用します。完成形と操作履歴は別の情報です。</p>
            <div className="stage1-analysis-stats">
              {data.maps.map(m=>(
                <div className="stage1-analysis-stat" key={m.id}>
                  <strong>{mapName(m.type)}</strong>
                  <span>概念：{m.concepts.length} / 命題：{m.links.length}</span>
                  <a href={`/maps/${m.id}`}>完成マップを表示</a>
                </div>
              ))}
            </div>
          </section>
          <section className="session-card map-history-section">
            <h2>マップ履歴再生</h2>
            <p>操作を選ぶと、その直前と直後のマップを読み取り専用で比較できます。</p>
            <label>対象マップ
              <select value={selectedMapId} onChange={e=>{
                setHistoryLoading(true);setSelectedMapId(e.target.value);setHistorySequence(0);setSelectedOperationId("");
              }}>
                {replayMaps.map(m=><option key={m.id} value={m.id}>{mapName(m.type)} / {m.id}</option>)}
              </select>
            </label>
            {map && map.historyReplayStatus!=="AVAILABLE"&&(
              <p role="status">このマップには初期状態が保存されていません。全体履歴は再生できません。</p>
            )}
            {displayedReplay&&displayedReplay.status!=="REPLAYABLE"&&(
              <p role="status">履歴を再生できません：{uiText(displayedReplay.reason ?? "理由を確認できません。")}</p>
            )}
            {historyLoading&&<p role="status">履歴状態を復元しています…</p>}
            {replayOperations.length>0&&(
              <>
                <h3>操作時系列</h3>
                <div className="stage1-analysis-log">
                  {replayOperations.map(op=>(
                    <button className={op.sequenceNumber===String(historySequence)?"is-selected":""}
                      type="button" key={op.id}
                      onClick={()=>selectReplaySequence(Number(op.sequenceNumber))}>
                      <strong>#{op.sequenceNumber} {operationName(op.operationType)}</strong><span>{mapName(op.mapType)} · {targetLabel(op, map, op.id === selectedOperationId ? displayedReplay : null)}</span><span>{new Date(op.serverTimestamp).toLocaleString()} · 作業開始から {elapsed(op.elapsedMs)}</span>
                    </button>
                  ))}
                </div>
              </>
            )}
            <div className="map-history-controls">
              <button type="button" disabled={historySequence===0||historyLoading}
                onClick={()=>selectReplaySequence(historySequence-1)}>前へ</button>
              <label>操作番号
                <input type="range" min={0} max={replayOperations.length} step={1}
                  value={Math.min(historySequence,replayOperations.length)} disabled={historyLoading||map?.historyReplayStatus!=="AVAILABLE"}
                  onChange={e=>selectReplaySequence(Number(e.target.value))}/>
                <span>{historySequence} / {replayOperations.length}</span>
              </label>
              <button type="button" disabled={historySequence>=replayOperations.length||historyLoading}
                onClick={()=>selectReplaySequence(historySequence+1)}>次へ</button>
            </div>
            {operation&&(
              <div className="map-history-operation">
                <h3>選択中の操作：#{operation.sequenceNumber} {operationName(operation.operationType)}</h3>
                <p>{mapName(operation.mapType)} / {targetLabel(operation, map, displayedReplay)}<br/>時刻：{new Date(operation.serverTimestamp).toLocaleString()} / 作業開始から：{elapsed(operation.elapsedMs)}</p>
                {operation.relatedOperationLogId&&(
                  <p>対象となった元操作ID：{operation.relatedOperationLogId}
                    {" / "}{operationName(data.operations.find(op=>op.id===operation.relatedOperationLogId)?.operationType??"不明")}
                  </p>
                )}
                <details><summary>変更前後の記録（JSON）</summary><div className="stage1-analysis-compare">
                  <div><h4>変更前の記録</h4><pre>{JSON.stringify(operation.before,null,2)}</pre></div>
                  <div><h4>変更後の記録</h4><pre>{JSON.stringify(operation.after,null,2)}</pre></div>
                </div></details>
              </div>
            )}
            {displayedReplay?.status==="REPLAYABLE"&&displayedReplay.beforeState&&displayedReplay.afterState&&changes&&(
              <><p>色枠で変化を表示。概念：追加 {changes.concepts.added}・削除 {changes.concepts.removed}・変更 {changes.concepts.changed}、関係：追加 {changes.links.added}・削除 {changes.links.removed}・変更 {changes.links.changed}</p><div className="map-history-compare">
                <ReadOnlyMapSnapshot snapshot={displayedReplay.beforeState} title="選択操作の直前" highlightedConceptIds={changes.concepts.ids} highlightedLinkIds={changes.links.ids}/>
                <ReadOnlyMapSnapshot snapshot={displayedReplay.afterState} title="選択操作の直後" highlightedConceptIds={changes.concepts.ids} highlightedLinkIds={changes.links.ids}/>
              </div></>
            )}
          </section>
          {data.session.protocolKey === "STAGE1_4" && <section className="session-card">
            <h2>記述的特徴量（v2）</h2>
            <p>「引き継ぎ」はSTEP 2に外化された知識であり、授業前の既有知識を意味しません。
              出現時点に基づいた操作的分類です。操作数を学習の質とみなしません。</p>
            <p><button type="button" onClick={() => void downloadApiFile(`/api/research/stage1/sessions/${sessionId}/features.csv`).catch(() => setError("CSVを取得できませんでした。"))}>
              特徴量CSVを出力</button></p>
            <div className="stage1-analysis-stats">
              {Object.entries(data.features).map(([key,value])=>(
                <div className="stage1-analysis-stat" key={key}>
                  <strong>{key}</strong><span>{value===null?"未計測":String(value)}</span>
                </div>
              ))}
            </div>
          </section>}
          <section className="session-card">
            <h2>操作データ</h2>
            <p>操作件数は学習の質を意味しません。</p>
            <div className="stage1-analysis-stats">
              {Object.entries(data.operationCounts).sort(([a],[b])=>a.localeCompare(b)).map(([name,n])=>(
                <div className="stage1-analysis-stat" key={name}><strong>{operationName(name)}</strong><span>{n}</span></div>
              ))}
            </div>
          </section>
          {data.session.protocolKey === "STAGE1_4" && <>
          <section className="session-card">
            <h2>命題の手動評価</h2>
            <p>U/I/P/Vは0〜3点の順序尺度ではありません。ゴールマップにない命題でもVにできます。</p>
            <p>ここでは現在残る命題の評価を登録します。過去の命題は操作履歴で確認できます。</p>
            <form className="stage1-form" onSubmit={saveEvaluation}>
              <label>評価対象マップ
                <select value={selectedMapId} onChange={e=>{setSelectedMapId(e.target.value);setSelectedLinkId("");setSelectedOperationId("");setHistorySequence(0);}} required>
                  <option value="">選択してください</option>
                  {replayMaps.map(m=><option key={m.id} value={m.id}>{mapName(m.type)}</option>)}
                </select>
              </label>
              <label>評価対象の時点
                <select value={ratingSide} onChange={e=>{
                  setRatingSide(e.target.value as "CURRENT"|"BEFORE"|"AFTER");
                  setRatingOperationId("");
                }}>
                  <option value="CURRENT">提出後の命題（現状態）</option>
                  <option value="BEFORE">リンク操作の変更前</option>
                  <option value="AFTER">リンク操作の変更後</option>
                </select>
              </label>
              {ratingSide==="CURRENT" ? (
                <label>命題
                  <select value={selectedLinkId} onChange={e=>setSelectedLinkId(e.target.value)} required>
                    <option value="">選択してください</option>
                    {(map?.links??[]).map(l=><option key={l.id} value={l.id}>
                      {labels.get(l.sourceConceptId)??l.sourceConceptId} → {l.label} → {labels.get(l.targetConceptId)??l.targetConceptId}
                    </option>)}
                  </select>
                </label>
              ) : (
                <label>操作履歴の命題スナップショット
                  <select value={ratingOperationId} onChange={e=>setRatingOperationId(e.target.value)} required>
                    <option value="">操作を選択してください</option>
                    {historicalOperations.map(o=><option key={o.id} value={o.id}>
                      #{o.sequenceNumber} / {operationName(o.operationType)} / {o.targetId}
                    </option>)}
                  </select>
                  {ratedOperation && (
                    <pre className="stage1-evaluation-snapshot">
                      {JSON.stringify(historicalLink(ratedOperation,ratingSide==="BEFORE"?"BEFORE":"AFTER"),null,2)}
                    </pre>
                  )}
                </label>
              )}
              <label>評価者コード<input value={evaluatorCode} required maxLength={64} onChange={e=>setEvaluatorCode(e.target.value)}/></label>
              <label>評価分類
                <select value={category} onChange={e=>setCategory(e.target.value as "U"|"I"|"P"|"V")}>
                  {CATEGORIES.map(c=><option key={c.value} value={c.value}>{c.label}</option>)}
                </select>
              </label>
              <label>評価理由<textarea value={reason} required onChange={e=>setReason(e.target.value)}/></label>
              <button disabled={!ratingLinkId||busy} className="session-primary-button">評価を保存</button>
            </form>
            <h3>保存済み評価：{data.propositionEvaluations.length}件</h3>
            <ul>{data.propositionEvaluations.map(v=>
              <li key={v.id}>{v.category} / {v.evaluatorCode} / {v.linkId} / {v.eventId?`新イベント：${v.eventId}`:v.operationLogId?`旧操作：${v.operationLogId}`:"現在のマップ"}：{v.rationale}</li>)}</ul>
          </section>
          <section className="session-card">
            <h2>振り返りメモ</h2>
            <p>操作を選択しておくとその操作IDに紐付きます。操作未選択ならセッション全体へのメモです。</p>
            <form className="stage1-form" onSubmit={saveReflection}>
              <label>記録者・報告者コード<input value={evaluatorCode} required maxLength={64} onChange={e=>setEvaluatorCode(e.target.value)}/></label>
              <label>振り返りの記録<textarea value={memo} required onChange={e=>setMemo(e.target.value)}/></label>
              <button disabled={busy} className="session-primary-button">メモを保存</button>
            </form>
            <ul>{data.reflectionNotes.map(n=><li key={n.id}>{n.reportedByCode} / {n.eventId?`新イベント：${n.eventId}`:n.operationLogId?`旧操作：${n.operationLogId}`:"操作未指定"}：{n.noteText}</li>)}</ul>
          </section>
          </>}
          <section className="session-card"><h2>解釈上の注意</h2>
            <ul>{data.limitations.map(x=><li key={x}>{limitationText[x] ?? x}</li>)}</ul>
          </section>
        </>
      )}
    </main>
  );
}
