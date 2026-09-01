import * as vscode from 'vscode';
import type { SidebarHost } from './sidebarHost';

const KEY_COMPLETE = 'tyne.onboardingComplete';
const KEY_STEP = 'tyne.onboardingStep';

export type OnboardingStep = 'path' | 'thread' | 'review' | 'done';

type OnboardingHost = Pick<
  SidebarHost,
  'context' | 'state' | 'postMessage' | 'isAuthenticated' | 'debouncedSave'
>;

/**
 * One-time guided first-run (all tiers). Persisted in globalState so a new
 * machine still sees the tour once; Skip tour is allowed only after sign-in.
 */
export class OnboardingController {
  constructor(private readonly host: OnboardingHost) {}

  isComplete(): boolean {
    return this.host.context.globalState.get<boolean>(KEY_COMPLETE, false) === true;
  }

  currentStep(): OnboardingStep {
    if (this.isComplete()) { return 'done'; }
    const raw = this.host.context.globalState.get<string>(KEY_STEP, 'path');
    if (raw === 'thread' || raw === 'review' || raw === 'done' || raw === 'path') { return raw; }
    return 'path';
  }

  /** Push current onboarding state to the webview. */
  postStatus(): void {
    this.host.postMessage({
      type: 'onboardingStatus',
      complete: this.isComplete(),
      step: this.currentStep(),
      authenticated: this.host.isAuthenticated,
      hasThread: Boolean(this.host.state.taskId || this.host.state.goal),
      hasReview: Boolean(this.host.state.validateReviewResult || this.host.state.latestValidateReviewReportId),
    });
  }

  async setStep(step: OnboardingStep): Promise<void> {
    if (this.isComplete()) { return; }
    await this.host.context.globalState.update(KEY_STEP, step);
    this.postStatus();
  }

  async complete(): Promise<void> {
    await this.host.context.globalState.update(KEY_COMPLETE, true);
    await this.host.context.globalState.update(KEY_STEP, 'done');
    this.postStatus();
  }

  /** Escape hatch after auth only — not anonymous Skip. Hosted Core, not BYOK. */
  async skipTour(): Promise<void> {
    if (!this.host.isAuthenticated) { return; }
    await this.host.context.workspaceState.update('tyne.aiAccessMode', 'max');
    await this.complete();
  }

  /** Prefill Solo brief with a sample goal for first-run. */
  async prepareSoloPath(): Promise<void> {
    if (!this.host.state.goal) {
      this.host.state.goal = 'Ship a small, reviewable change that matches this goal.';
      this.host.state.taskTitle = this.host.state.taskTitle || 'First Tyne thread';
      this.host.state.taskSource = this.host.state.taskSource || 'Solo Mode';
      this.host.debouncedSave();
    }
    await this.setStep('thread');
  }

  async markPmPathChosen(): Promise<void> {
    await this.setStep('thread');
  }

  async markThreadStarted(): Promise<void> {
    await this.setStep('review');
  }

  async markFirstReviewDone(): Promise<void> {
    await this.complete();
  }
}
