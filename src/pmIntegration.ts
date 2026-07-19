export interface PMTask {
  id: string;
  title: string;
  source?: string;
  url?: string;
}

export async function fetchPMTasksForStandup(): Promise<PMTask[]> {
  return [];
}
