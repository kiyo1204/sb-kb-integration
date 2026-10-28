import { useState, type FormEvent } from "react";
import { ConceptCanvas } from "./MapPage";

type Concept = { id: string; label: string; positionX: number; positionY: number; createdAt: string; updatedAt: string };
type Link = { id: string; mapId: string; sourceConceptId: string; targetConceptId: string; label: string };
const mapId = "practice";
const kitConcepts = [{ kitConceptItemId: "a", label: "丸", imported: false }, { kitConceptItemId: "b", label: "四角", imported: false }, { kitConceptItemId: "c", label: "色", imported: false }];
const kitLinks = [{ kitLinkItemId: "r", label: "関係", used: false }, { kitLinkItemId: "s", label: "つながり", used: false }];
let sequence = 0;
const id = () => `practice-${++sequence}`;

export default function TutorialPage({ returnHref }: { returnHref: string }) {
  const [mode, setMode] = useState<"PRIOR" | "KB">("PRIOR");
  const [reset, setReset] = useState(0);
  return <main className="page tutorial-page">
    <section className="session-card">
      <h1>操作の練習</h1>
      <p>練習内容はこの画面を離れると消え、セッションの記録には保存されません。</p>
      <div className="assessment-actions">
        <button type="button" className={mode === "PRIOR" ? "session-primary-button" : "session-secondary-button"} onClick={() => setMode("PRIOR")}>マップ作成の練習</button>
        <button type="button" className={mode === "KB" ? "session-primary-button" : "session-secondary-button"} onClick={() => setMode("KB")}>Kit-Buildの練習</button>
        <button type="button" className="session-secondary-button" onClick={() => setReset(n => n + 1)}>最初からやり直す</button>
        <a className="session-secondary-button" href={returnHref}>練習を終了</a>
      </div>
      <PracticeCanvas key={`${mode}-${reset}`} mode={mode} />
    </section>
  </main>;
}

function PracticeCanvas({ mode }: { mode: "PRIOR" | "KB" }) {
  const [concepts, setConcepts] = useState<Concept[]>([]);
  const [links, setLinks] = useState<Link[]>([]);
  const [usedConcepts, setUsedConcepts] = useState<string[]>([]);
  const [usedLinks, setUsedLinks] = useState<string[]>([]);
  const [conceptLabel, setConceptLabel] = useState("");
  const [linkLabel, setLinkLabel] = useState("");
  const [linkCreation, setLinkCreation] = useState<{ id: string; label: string } | null>(null);
  const [selectedConcept, setSelectedConcept] = useState<string | null>(null);
  const [selectedLink, setSelectedLink] = useState<string | null>(null);
  const [editLabel, setEditLabel] = useState("");
  function addConcept(label: string, positionX: number, positionY: number) {
    setConcepts(list => [...list, { id: id(), label, positionX, positionY, createdAt: "", updatedAt: "" }]);
  }
  function createLink(sourceConceptId: string, targetConceptId: string, label: string) {
    const linkId = id();
    setLinks(list => [...list, { id: linkId, mapId, sourceConceptId, targetConceptId, label }]);
    return linkId;
  }
  function addManualConcept(event: FormEvent) {
    event.preventDefault();
    if (!conceptLabel.trim()) return;
    addConcept(conceptLabel.trim(), 80 + (concepts.length % 4) * 200, 80 + Math.floor(concepts.length / 4) * 130);
    setConceptLabel("");
  }
  return <>
    <h2>{mode === "PRIOR" ? "マップ作成の練習" : "Kit-Buildの練習"}</h2>
    <p>{mode === "PRIOR" ? "概念とリンクを追加し、リンクの両端を概念へドラッグして接続します。" : "部品をマップへドラッグし、リンクの両端を概念へ接続します。"} 矢印の先が関係先です。</p>
    {mode === "PRIOR" && <div className="tutorial-tools">
      <form onSubmit={addManualConcept}><label>概念の名前 <input value={conceptLabel} onChange={e => setConceptLabel(e.target.value)} /></label> <button className="session-secondary-button" type="submit">概念を追加</button></form>
      <form onSubmit={e => { e.preventDefault(); if (linkLabel.trim()) { setLinkCreation({ id: id(), label: linkLabel.trim() }); setLinkLabel(""); } }}><label>リンクの名前 <input value={linkLabel} onChange={e => setLinkLabel(e.target.value)} /></label> <button className="session-secondary-button" disabled={!!linkCreation} type="submit">リンクを追加</button></form>
    </div>}
    {linkCreation && <p role="status">「{linkCreation.label}」の始点と矢印の先を、それぞれ概念へドラッグしてください。 <button type="button" onClick={() => setLinkCreation(null)}>キャンセル</button></p>}
    {(selectedConcept || selectedLink) && <form className="tutorial-edit" onSubmit={e => {
      e.preventDefault(); if (!editLabel.trim()) return;
      if (selectedConcept) setConcepts(list => list.map(c => c.id === selectedConcept ? { ...c, label: editLabel.trim() } : c));
      if (selectedLink) setLinks(list => list.map(l => l.id === selectedLink ? { ...l, label: editLabel.trim() } : l));
      setSelectedConcept(null); setSelectedLink(null);
    }}><label>選択した名前を編集 <input value={editLabel} onChange={e => setEditLabel(e.target.value)} /></label> <button className="session-secondary-button" type="submit">変更</button> <button type="button" onClick={() => { setSelectedConcept(null); setSelectedLink(null); }}>閉じる</button></form>}
    <p>概念はドラッグで移動できます。{mode === "PRIOR" && "名前をクリックすると編集できます。"}</p>
    <ConceptCanvas mapId={mapId} mapType={mode} concepts={concepts} links={links} kitDefinitionName={mode === "KB" ? "練習用の部品" : null}
      kitConcepts={kitConcepts.map(c => ({ ...c, imported: usedConcepts.includes(c.kitConceptItemId) }))} kitLinks={kitLinks.map(l => ({ ...l, used: usedLinks.includes(l.kitLinkItemId) }))}
      readOnly={false} canEditConceptStructure={mode === "PRIOR"} canEditLinkLabel={mode === "PRIOR"} positionSaving={false} positionFeedback={null}
      onLabelSave={async (conceptId, label) => setConcepts(list => list.map(c => c.id === conceptId ? { ...c, label } : c))}
      onConceptDelete={async conceptId => { setConcepts(list => list.filter(c => c.id !== conceptId)); setLinks(list => list.filter(l => l.sourceConceptId !== conceptId && l.targetConceptId !== conceptId)); }}
      onLinkLabelSave={async (link, label) => setLinks(list => list.map(l => l.id === link.id ? { ...l, label } : l))}
      onLinkReconnect={async (link, sourceConceptId, targetConceptId) => setLinks(list => list.map(l => l.id === link.id ? { ...l, sourceConceptId, targetConceptId } : l))}
      onLinkDelete={async linkId => setLinks(list => list.filter(l => l.id !== linkId))}
      onKitConceptDrop={async (itemId, position) => { const item = kitConcepts.find(c => c.kitConceptItemId === itemId); if (item && !usedConcepts.includes(itemId)) { addConcept(item.label, position.positionX, position.positionY); setUsedConcepts(list => [...list, itemId]); } }}
      onKitLinkCreate={async (_mapId, itemId, source, target) => { const item = kitLinks.find(l => l.kitLinkItemId === itemId); if (!item) return; setUsedLinks(list => [...list, itemId]); return createLink(source, target, item.label); }}
      onDragStart={() => undefined} onPositionSave={async (conceptId, position) => { setConcepts(list => list.map(c => c.id === conceptId ? { ...c, ...position } : c)); return position; }}
      linkCreation={linkCreation} onMapLinkCreate={async (source, target, label) => { const linkId = createLink(source, target, label); setLinkCreation(null); return linkId; }} onMapLinkCreationCancel={() => setLinkCreation(null)}
      onMapConceptSelect={concept => { setSelectedConcept(concept.id); setSelectedLink(null); setEditLabel(concept.label); }}
      onMapLinkSelect={mode === "PRIOR" ? link => { setSelectedLink(link.id); setSelectedConcept(null); setEditLabel(link.label); } : undefined} />
  </>;
}
