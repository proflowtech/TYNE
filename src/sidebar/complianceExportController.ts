import * as vscode from 'vscode';
import type { SidebarHost } from './sidebarHost';
import { getValidateReviewService } from '../validateReviewService';

export class ComplianceExportController {
  constructor(
    private readonly host: Pick<SidebarHost, 'context' | 'userProfile' | 'postMessage' | 'getRepositoryPath'>,
  ) {}

  async exportValidateReviewPdf(report?: Record<string, unknown>): Promise<void> {
    try {
      if (!report || typeof report !== 'object') {
        vscode.window.showWarningMessage('No Validate & Review report selected to export.');
        return;
      }
      const { buildValidateReviewPdfHtml, buildValidateReviewPdfFileName } = await import('../validateReviewPdfExport');
      const { isValidateReviewResult } = await import('../validateReviewTypes');
      if (!isValidateReviewResult(report)) {
        vscode.window.showWarningMessage('Selected report is incomplete and cannot be exported.');
        return;
      }
      const html = buildValidateReviewPdfHtml(report, {
        generatedBy: this.host.userProfile.githubUsername
          ? `@${this.host.userProfile.githubUsername}`
          : (this.host.userProfile.email || 'Tyne user'),
        generatedByEmail: this.host.userProfile.email || undefined,
        generatedAt: new Date().toISOString(),
        workspacePath: this.host.getRepositoryPath() || undefined,
      });
      const fs = await import('fs/promises');
      const path = await import('path');
      const os = await import('os');
      const downloads = path.join(os.homedir(), 'Downloads');
      await fs.mkdir(downloads, { recursive: true });
      const filePath = path.join(downloads, buildValidateReviewPdfFileName());
      await fs.writeFile(filePath, html, 'utf8');
      const open = await vscode.window.showInformationMessage(
        `Validate & Review report saved to ${filePath}`,
        'Open & Print PDF',
        'Reveal',
      );
      if (open === 'Open & Print PDF') {
        await vscode.env.openExternal(vscode.Uri.file(filePath));
      } else if (open === 'Reveal') {
        vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(filePath));
      }
      this.host.postMessage({ type: 'validateReviewPdfExported', filePath });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`Validate & Review PDF export failed: ${msg}`);
    }
  }

  async exportComplianceEvidence(format: string, report?: Record<string, unknown>): Promise<void> {
    try {
      const { buildComplianceExport, buildComplianceExportFileName } = await import('../complianceEvidenceExport');
      const fmt = format === 'json' || format === 'pdf' ? format : 'markdown';
      const input = {
        reportId: String(report?.id || ''),
        commitHash: String(report?.commitSha || report?.headSha || ''),
        timestamp: String(report?.createdAt || new Date().toISOString()),
        repositoryName: String(report?.repositoryName || ''),
        branchName: String(report?.branchName || ''),
        complianceStatus: String(report?.complianceStatus || ''),
        assessments: Array.isArray(report?.complianceAssessments) ? report?.complianceAssessments as any[] : [],
        findings: Array.isArray(report?.findings) ? report?.findings as any[] : [],
        complianceFindings: Array.isArray(report?.complianceFindings) ? report?.complianceFindings as any[] : [],
        regressions: Array.isArray(report?.complianceRegressions) ? report?.complianceRegressions as any[] : [],
        disclaimer: typeof report?.complianceDisclaimer === 'string' ? report.complianceDisclaimer : undefined,
      };
      const built = buildComplianceExport(input, fmt);
      const fs = await import('fs/promises');
      const path = await import('path');
      const os = await import('os');
      const downloads = path.join(os.homedir(), 'Downloads');
      await fs.mkdir(downloads, { recursive: true });
      const filePath = path.join(downloads, buildComplianceExportFileName(fmt));
      await fs.writeFile(filePath, built.content, 'utf8');
      vscode.window.showInformationMessage(
        fmt === 'pdf'
          ? `Compliance evidence HTML saved to ${filePath} — open and Print → Save as PDF.`
          : `Compliance evidence exported to ${filePath}`,
      );
      this.host.postMessage({ type: 'complianceEvidenceExported', format: fmt, filePath });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`Compliance export failed: ${msg}`);
    }
  }

  async handleFindingWorkflow(msg: Record<string, unknown>): Promise<void> {
    try {
      const service = getValidateReviewService(this.host.context);
      await service.saveFindingWorkflow({
        reportId: String(msg.reportId || ''),
        findingId: String(msg.findingId || ''),
        findingTitle: String(msg.findingTitle || ''),
        framework: typeof msg.framework === 'string' ? msg.framework : undefined,
        status: String(msg.status || 'open'),
        owner: typeof msg.owner === 'string' ? msg.owner : undefined,
        comments: typeof msg.comments === 'string' ? msg.comments : undefined,
        resolution: typeof msg.resolution === 'string' ? msg.resolution : undefined,
      });
      this.host.postMessage({ type: 'complianceFindingWorkflowSaved', findingId: msg.findingId, status: msg.status });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.host.postMessage({ type: 'complianceFindingWorkflowError', message });
    }
  }

  async listCustomPolicies(): Promise<void> {
    try {
      const service = getValidateReviewService(this.host.context);
      const policies = await service.listCustomPolicies();
      this.host.postMessage({ type: 'customCompliancePoliciesLoaded', policies });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.host.postMessage({ type: 'customCompliancePoliciesError', message });
    }
  }

  async createCustomPolicy(policy: Record<string, unknown>): Promise<void> {
    try {
      const service = getValidateReviewService(this.host.context);
      const created = await service.createCustomPolicy(policy || {});
      this.host.postMessage({ type: 'customCompliancePolicyCreated', policy: created });
      await this.listCustomPolicies();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(message);
      this.host.postMessage({ type: 'customCompliancePoliciesError', message });
    }
  }

  async deleteCustomPolicy(id: string): Promise<void> {
    try {
      const service = getValidateReviewService(this.host.context);
      await service.deleteCustomPolicy(String(id || ''));
      this.host.postMessage({ type: 'customCompliancePolicyDeleted', id });
      await this.listCustomPolicies();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.host.postMessage({ type: 'customCompliancePoliciesError', message });
    }
  }
}
