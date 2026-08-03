import * as vscode from 'vscode';
import { TyneCodebaseContextPack, TynePmTool } from './taskTypes';
import {
  buildDecompositionResult,
  DecomposableStory,
  detectStoryCharacteristics,
  determineSplitStrategy,
  generateHeuristicTasks,
  parseDecomposedTasks,
  StoryCharacteristics,
  StoryCodebaseHints,
  subtaskLimitForTier,
  TaskDecompositionResult,
} from './storyDecompositionHarness';

const DEFAULT_SUPABASE_URL = 'https://mvzcfqjtleasuawvvmtg.supabase.co';
const STORY_DECOMPOSE_PATH = '/functions/v1/tyne-story-decompose';

export interface DecomposeStoryInput {
  source: TynePmTool;
  issueIdentifier: string;
  story: DecomposableStory;
  answers: Record<string, string>;
  tier: string;
  codebaseContext?: TyneCodebaseContextPack;
}

export class StoryDecompositionService {
  constructor(private readonly context: vscode.ExtensionContext) {}

  /**
   * Generate the technical task breakdown. Tries the Haiku-backed edge
   * function first; falls back to the deterministic harness so the flow
   * still works offline or when the backend is unavailable.
   */
  async decompose(input: DecomposeStoryInput): Promise<TaskDecompositionResult> {
    const limit = subtaskLimitForTier(input.tier);
    if (limit <= 0) {
      throw new Error('Creating tasks from a Story or Epic is available in Pro and Max.');
    }
    const characteristics = detectStoryCharacteristics(input.story);
    const strategy = determineSplitStrategy(input.answers);
    const hints = toCodebaseHints(input.codebaseContext);

    try {
      const remote = await this._callEdgeFunction(input, characteristics, limit);
      if (remote && remote.tasks.length) {
        return remote;
      }
    } catch (err) {
      if (err instanceof StoryDecompositionLimitError) { throw err; }
      console.warn('Tyne story decomposition backend failed; using heuristic fallback:', err);
    }

    const tasks = generateHeuristicTasks(input.story, characteristics, strategy, limit, hints);
    return buildDecompositionResult(tasks, 'heuristic');
  }

  private async _callEdgeFunction(
    input: DecomposeStoryInput,
    characteristics: StoryCharacteristics,
    limit: number,
  ): Promise<TaskDecompositionResult | null> {
    const githubToken = await this.context.secrets.get('tyne_github_token');
    if (!githubToken) {
      // No hosted auth — the heuristic fallback still produces a usable split.
      return null;
    }
    const supabaseUrl = vscode.workspace.getConfiguration('tyne')
      .get<string>('supabaseUrl', DEFAULT_SUPABASE_URL)
      .replace(/\/+$/, '');
    const response = await fetch(`${supabaseUrl}${STORY_DECOMPOSE_PATH}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${githubToken}`,
        'X-Machine-ID': vscode.env.machineId,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({
        source: input.source,
        issueIdentifier: input.issueIdentifier,
        tier: input.tier,
        story: {
          title: input.story.title,
          description: input.story.description.slice(0, 8000),
          acceptanceCriteria: input.story.acceptanceCriteria.slice(0, 10),
          issueType: input.story.issueType,
          storyPoints: input.story.storyPoints,
        },
        characteristics,
        answers: input.answers,
        maxTasks: limit,
        codebaseContext: input.codebaseContext,
      }),
    });
    const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
    if (!response.ok || !payload) {
      const errorText = typeof payload?.error === 'string' ? payload.error : `Story decomposition failed (${response.status})`;
      // Usage limits must surface to the user rather than silently degrading
      // to the heuristic fallback (which would bypass the Pro monthly cap).
      if (response.status === 402) {
        throw new StoryDecompositionLimitError(errorText);
      }
      throw new Error(errorText);
    }
    const tasks = parseDecomposedTasks(payload.tasks, limit);
    if (!tasks.length) { return null; }
    return buildDecompositionResult(
      tasks,
      'llm',
      typeof payload.modelProvider === 'string' ? payload.modelProvider : undefined,
      typeof payload.modelName === 'string' ? payload.modelName : undefined,
    );
  }
}

export class StoryDecompositionLimitError extends Error {}

export function toCodebaseHints(pack?: TyneCodebaseContextPack): StoryCodebaseHints | undefined {
  if (!pack) { return undefined; }
  const hints = pack.projectHints || {};
  return {
    architecture: [hints.framework, hints.language].filter(Boolean).join(', ') || undefined,
    frontendStack: hints.framework,
    backendStack: hints.language,
    testingStrategy: hints.testFramework,
  };
}

export function getStoryDecompositionService(context: vscode.ExtensionContext): StoryDecompositionService {
  return new StoryDecompositionService(context);
}
