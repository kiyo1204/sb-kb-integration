import { useCallback, useEffect, useState, type FormEvent } from "react";
import { apiFetch, downloadApiFile } from "./auth-client";
import { ReadOnlyMapSnapshot, type HistoricalMapSnapshot } from "./MapPage";

type Operation = {
  id: string; mapId: string; mapType: string; researchRole: string | null;
  operationType: string; targetId: string; targetType: string; sequenceNumber: string;
  relatedOperationLogId: string | null;
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
type Rating = { id: string; mapId: string; linkId: string; category: "U"|"I"|"P"|"V"; rationale: string; createdAt: string; evaluatorCode: string };
type Reflection = { id: string; noteText: string; reportedByCode: string; operationLogId: string | null };
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
    if(!response.ok)throw new Error("完了したStage 1 Sessionの分析データを取得できませんでした。");
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
      .then(async(r)=>{if(!r.ok)throw new Error("分析データを取得できませんでした。Sessionが完了しているか確認してください。");return (await r.json()) as Analysis;})
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
        if(!response.ok)throw new Error("選択したMapの履歴状態を取得できませんでした。");
        return await response.json() as HistoryReplay;
      })
      .then(value=>{if(active)setHistoryReplay(value);})
      .catch(reason=>{if(active)setHistoryReplay({status:"UNAVAILABLE",reason:String(reason instanceof Error?reason.message:reason),mapId:selectedMapId,mapType:"",sequenceNumber:historySequence,operation:null,beforeState:null,afterState:null});})
      .finally(()=>{if(active)setHistoryLoading(false);});
    return()=>{active=false;};
  },[sessionId,selectedMapId,historySequence]);

  const operation=data?.operations.find(o=>o.id===selectedOperationId);
  const map=data?.maps.find(m=>m.id===selectedMapId);
  const link=map?.links.find(l=>l.id===selectedLinkId);
  const labels=new Map(map?.concepts.map(c=>[c.id,c.label])??[]);
  const historicalOperations=(data?.operations??[]).filter(op=>
    op.mapId===selectedMapId && op.targetType==="LINK" &&
    (ratingSide==="BEFORE" ? op.before!==null : op.after!==null));
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
        ? {operationLogId:ratedOperation.id} : {}),
    });
  }
  function saveReflection(e:FormEvent){
    e.preventDefault();
    void post(`/api/research/stage1/sessions/${sessionId}/reflections`,{
      mapId:operation?.mapId??null,operationLogId:operation?.id??null,
      linkId:operation?.targetType==="LINK"?operation.targetId:link?.id??null,
      reportedByCode:evaluatorCode,noteText:memo,
    });
  }
  function selectReplaySequence(sequence:number){
    setHistoryLoading(true);
    setHistorySequence(sequence);
    const next=replayOperations[sequence-1];
    setSelectedOperationId(next?.id??"");
  }
  return (
    <main className="page stage1-analysis-page">
      <section className="session-card">
        <p className="eyebrow">STEP 5 / 研究者用・開発プロトタイプ</p>
        <h1>再構成行動の分析</h1>
        <p>Session：{sessionId} 参加者コード：{data?.session.participantCode??"—"}</p>
        <p><button type="button" onClick={() => void downloadApiFile(`/api/research/sessions/${sessionId}/export`).catch(() => setError("JSONを取得できませんでした。"))}>生データJSON</button>
          {" · "}<button type="button" onClick={() => void downloadApiFile(`/api/research/stage1/sessions/${sessionId}/operations.csv`).catch(() => setError("CSVを取得できませんでした。"))}>操作イベントCSV</button>
          {" · "}<button type="button" onClick={() => void downloadApiFile(`/api/research/stage1/sessions/${sessionId}/evaluations.csv`).catch(() => setError("CSVを取得できませんでした。"))}>命題評価CSV</button>
          {" · "}<button type="button" onClick={() => void downloadApiFile(`/api/research/stage1/sessions/${sessionId}/reflections.csv`).catch(() => setError("CSVを取得できませんでした。"))}>振り返りCSV</button>
          {" · "}<a href={`/sessions/${sessionId}`}>Sessionへ戻る</a></p>
        {error&&<p className="session-error" role="alert">{error}</p>}
        {status&&<p role="status">{status}</p>}
      </section>
      {!data?<p role="status">分析データを読み込んでいます…</p>:(
        <>
          <section className="session-card">
            <h2>保存されたマップ</h2>
            <p>既存のMap Editorを提出後read-onlyとして再利用します。完成形と操作履歴は別の情報です。</p>
            <div className="stage1-analysis-stats">
              {data.maps.map(m=>(
                <div className="stage1-analysis-stat" key={m.id}>
                  <strong>{m.researchRole??m.type}</strong>
                  <span>概念：{m.concepts.length} / 命題：{m.links.length}</span>
                  <a href={`/maps/${m.id}`}>完成マップを表示</a>
                </div>
              ))}
            </div>
          </section>
          <section className="session-card map-history-section">
            <h2>マップ履歴再生</h2>
            <p>初期状態と操作イベントを順に適用した読み取り専用表示です。MOVE_CONCEPTは位置変更として表示します。</p>
            <label>対象Map
              <select value={selectedMapId} onChange={e=>{
                setHistoryLoading(true);setSelectedMapId(e.target.value);setHistorySequence(0);setSelectedOperationId("");
              }}>
                {replayMaps.map(m=><option key={m.id} value={m.id}>{m.researchRole??m.type} / {m.id}</option>)}
              </select>
            </label>
            {map?.historyReplayStatus!=="AVAILABLE"&&(
              <p role="status">このMapには初期状態が保存されていません。全体履歴は再生できません。</p>
            )}
            {historyReplay&&historyReplay.status!=="REPLAYABLE"&&(
              <p role="status">再生状態：{historyReplay.status} — {historyReplay.reason}</p>
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
                      #{op.sequenceNumber} / {op.operationType} / {op.targetType} {op.targetId}
                      {op.relatedOperationLogId&&<> / 対象操作 {op.relatedOperationLogId}</>}
                      {" · "}{new Date(op.serverTimestamp).toLocaleString()}
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
            {historyReplay?.operation&&(
              <div className="map-history-operation">
                <h3>選択中の操作：#{historyReplay.operation.sequenceNumber} / {historyReplay.operation.operationType}</h3>
                <p>時刻：{new Date(historyReplay.operation.serverTimestamp).toLocaleString()} / 対象：{historyReplay.operation.targetType} {historyReplay.operation.targetId}</p>
                {historyReplay.operation.relatedOperationLogId&&(
                  <p>対象となった元操作ID：{historyReplay.operation.relatedOperationLogId}
                    {" / "}{data.operations.find(op=>op.id===historyReplay.operation?.relatedOperationLogId)?.operationType??"操作種別不明"}
                  </p>
                )}
                <div className="stage1-analysis-compare">
                  <div><h4>変更前の記録</h4><pre>{JSON.stringify(historyReplay.operation.before,null,2)}</pre></div>
                  <div><h4>変更後の記録</h4><pre>{JSON.stringify(historyReplay.operation.after,null,2)}</pre></div>
                </div>
              </div>
            )}
            {historyReplay?.status==="REPLAYABLE"&&historyReplay.beforeState&&historyReplay.afterState&&(
              <div className="map-history-compare">
                <ReadOnlyMapSnapshot snapshot={historyReplay.beforeState} title="選択操作の直前"/>
                <ReadOnlyMapSnapshot snapshot={historyReplay.afterState} title="選択操作の直後"/>
              </div>
            )}
          </section>
          <section className="session-card">
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
          </section>
          <section className="session-card">
            <h2>操作データ</h2>
            <p>操作件数は学習の質を意味しません。</p>
            <div className="stage1-analysis-stats">
              {Object.entries(data.operationCounts).sort(([a],[b])=>a.localeCompare(b)).map(([name,n])=>(
                <div className="stage1-analysis-stat" key={name}><strong>{name}</strong><span>{n}</span></div>
              ))}
            </div>
            <h3>操作時系列</h3>
            <div className="stage1-analysis-log">
              {data.operations.filter(op=>replayMaps.some(m=>m.id===op.mapId)).map(op=>(
                <button className={op.id===selectedOperationId?"is-selected":""}
                  type="button" key={op.id}
                  onClick={()=>{
                    setHistoryLoading(true);setSelectedOperationId(op.id);
                    setSelectedMapId(op.mapId);setHistorySequence(Number(op.sequenceNumber));
                  }}>
                  {op.mapType} / #{op.sequenceNumber} / {op.operationType}
                  {op.relatedOperationLogId&&<> / 対象操作 {op.relatedOperationLogId}</>}
                  {" · "}{new Date(op.serverTimestamp).toLocaleString()}
                </button>
              ))}
              {data.operations.length===0&&<p>操作記録はありません。</p>}
            </div>
            {operation&&(
              <div>
                <h3>操作前後の記録：{operation.operationType}</h3>
                <p>対象ID：{operation.targetId} / 作業開始から：
                  {operation.elapsedMs==null?"不明":Math.round(operation.elapsedMs/1000)+"秒"}</p>
                {operation.relatedOperationLogId&&(
                  <p>対象となった元操作ID：{operation.relatedOperationLogId}
                    {" / "}{data.operations.find(op=>op.id===operation.relatedOperationLogId)?.operationType??"操作種別不明"}
                  </p>
                )}
                <div className="stage1-analysis-compare">
                  <div><h4>変更前</h4><pre>{JSON.stringify(operation.before,null,2)}</pre></div>
                  <div><h4>変更後</h4><pre>{JSON.stringify(operation.after,null,2)}</pre></div>
                </div>
              </div>
            )}
          </section>
          <section className="session-card">
            <h2>命題の手動評価</h2>
            <p>U/I/P/Vは0〜3点の順序尺度ではありません。Goal Mapにない命題でもVにできます。</p>
            <p>ここでは現在残る命題の評価を登録します。過去の命題は操作履歴で確認できます。</p>
            <form className="stage1-form" onSubmit={saveEvaluation}>
              <label>評価対象マップ
                <select value={selectedMapId} onChange={e=>{setSelectedMapId(e.target.value);setSelectedLinkId("");}} required>
                  <option value="">選択してください</option>
                  {replayMaps.map(m=><option key={m.id} value={m.id}>{m.researchRole??m.type}</option>)}
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
                      #{o.sequenceNumber} / {o.operationType} / {o.targetId}
                    </option>)}
                  </select>
                  {ratedOperation && (
                    <pre className="stage1-evaluation-snapshot">
                      {JSON.stringify(ratingSide==="BEFORE"?ratedOperation.before:ratedOperation.after,null,2)}
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
              <li key={v.id}>{v.category} / {v.evaluatorCode} / {v.linkId}：{v.rationale}</li>)}</ul>
          </section>
          <section className="session-card">
            <h2>振り返りメモ</h2>
            <p>操作を選択しておくとその操作IDに紐付きます。操作未選択ならSession全体へのメモです。</p>
            <form className="stage1-form" onSubmit={saveReflection}>
              <label>記録者・報告者コード<input value={evaluatorCode} required maxLength={64} onChange={e=>setEvaluatorCode(e.target.value)}/></label>
              <label>振り返りの記録<textarea value={memo} required onChange={e=>setMemo(e.target.value)}/></label>
              <button disabled={busy} className="session-primary-button">メモを保存</button>
            </form>
            <ul>{data.reflectionNotes.map(n=><li key={n.id}>{n.reportedByCode} / {n.operationLogId??"操作未指定"}：{n.noteText}</li>)}</ul>
          </section>
          <section className="session-card"><h2>解釈上の注意</h2>
            <ul>{data.limitations.map(x=><li key={x}>{x}</li>)}</ul>
          </section>
        </>
      )}
    </main>
  );
}
