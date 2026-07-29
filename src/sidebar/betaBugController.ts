import type { SidebarHost } from './sidebarHost';
import { submitBetaBugReport, BetaBugError, type BetaBugKind } from '../betaBugService';

export class BetaBugController {
  constructor(private readonly host: Pick<SidebarHost, 'context' | 'state' | 'userProfile' | 'postMessage'>) {}

  async submit(msg: Record<string, unknown>): Promise<void> {
    try {
      const kindRaw = String(msg.kind || 'bug');
      const kind = (['bug', 'confusing', 'idea'].includes(kindRaw) ? kindRaw : 'bug') as BetaBugKind;
      const result = await submitBetaBugReport(this.host.context, {
        kind,
        message: String(msg.message || ''),
        email: typeof msg.email === 'string' ? msg.email : (this.host.userProfile.email || undefined),
        githubUsername: typeof msg.githubUsername === 'string'
          ? msg.githubUsername
          : (this.host.userProfile.githubUsername || undefined),
        githubId: typeof msg.githubId === 'string'
          ? msg.githubId
          : (this.host.userProfile.githubId || undefined),
        page: typeof msg.page === 'string' ? msg.page : undefined,
        taskId: typeof msg.taskId === 'string' ? msg.taskId : (this.host.state.taskId || undefined),
        taskTitle: typeof msg.taskTitle === 'string'
          ? msg.taskTitle
          : (this.host.state.taskTitle || this.host.state.goal || undefined),
      });
      this.host.postMessage({ type: 'betaBugSubmitted', id: result.id });
    } catch (err: unknown) {
      const message = err instanceof BetaBugError
        ? err.message
        : (err instanceof Error ? err.message : 'Could not send bug report.');
      this.host.postMessage({ type: 'betaBugError', message });
    }
  }
}
