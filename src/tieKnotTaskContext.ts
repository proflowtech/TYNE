export interface TieKnotTaskSnapshot {
  taskId: string;
  taskTitle?: string;
  taskSource: string;
  taskUrl?: string;
}

/** The live thread snapshot is authoritative; branch metadata is recovery-only. */
export function selectTieKnotTaskSnapshot(
  taskSnapshot: TieKnotTaskSnapshot | undefined,
  branchRecord: TieKnotTaskSnapshot | undefined,
): TieKnotTaskSnapshot | undefined {
  return taskSnapshot || branchRecord;
}
