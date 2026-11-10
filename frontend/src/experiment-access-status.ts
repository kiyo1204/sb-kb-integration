// Only known HTTP/code pairs may describe a waiting or conflicting client.
// Unknown replies and network failures never imply that registration succeeded.
export type ExperimentAccessIssue =
  "waiting" | "unpublished" | "conflict" | "unavailable";
export function experimentAccessIssue(
  status: number,
  payload: unknown,
): ExperimentAccessIssue {
  const code =
    payload && typeof payload === "object" && "error" in payload
      ? payload.error
      : null;
  if (status === 409) {
    if (code === "experiment_not_running") return "waiting";
    if (code === "experiment_learner_flow_unavailable") return "unpublished";
    if (
      code === "experiment_client_in_use" ||
      code === "experiment_client_stale"
    )
      return "conflict";
  }
  return "unavailable";
}
export const experimentAccessCopy = {
  waiting: {
    title: "実施の開始を待っています",
    message:
      "研究者が実施を開始するまで、活動の進行・マップ編集・提出は利用できません。研究者の指示を待ち、開始後に「接続状態を更新」を押してください。",
  },
  unpublished: {
    title: "参加者向けの公開を停止しています",
    message:
      "実施の開始待ちとは別の利用制限です。学習操作は利用できません。実参加者へのコード配布・本番実施は行わないでください。",
  },
  conflict: {
    title: "この画面では利用できません",
    message:
      "別の画面が登録されているか、利用画面が切り替わっています。画面識別子を研究者に伝えて切替を依頼してください。実施の開始を待つだけでは、この画面は利用可能になりません。",
  },
  unavailable: {
    title: "接続状態を確認できません",
    message:
      "コード・端末登録・実施の状態を確認できません。通信を確認して接続状態を更新してください。解決しない場合は研究者に確認してください。",
  },
} satisfies Record<ExperimentAccessIssue, { title: string; message: string }>;
