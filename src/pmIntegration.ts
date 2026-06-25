export interface PMTask {
  id: string;
  title: string;
  source?: string;
  url?: string;
}

export interface PMCloseResult {
  skipped: boolean;
  reason: string;
}

export async function closePMTicket(): Promise<PMCloseResult> {
  return {
    skipped: true,
    reason: 'PM integration is not connected yet.',
  };
}

export async function fetchPMTasksForStandup(): Promise<PMTask[]> {
  return [];
}
